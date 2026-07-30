/**
 * 地区 resolver：`--area 上海` / `--area 310000` 都收。
 *
 * 歧义策略（硬）：地区表里 `110000 北京市 ← 全国` 与 `110100 北京市 ← 110000`
 * 同名不同码（直辖市与省会普遍如此）。**同名取 level 最小者（省级优先）**，
 * 并在输出坐标里回显实际生效的 areaCode + areaName。要精确指定就直接传码。
 */

import { readFileSync } from 'node:fs';
import { localError } from '../errors.js';
import { AREA_FILE, resolveDataFile } from '../refdata.js';
import { type Resolved, type Resolver } from './index.js';

interface AreaRow {
  areaCode: string;
  areaName: string;
  parentCode: string | null;
  level: number;
}

/** 逐层剥掉行政区划后缀，让「广西壮族自治区」也能用「广西」命中 */
const SUFFIXES = [
  '特别行政区',
  '自治区',
  '自治州',
  '自治县',
  '维吾尔',
  '壮族',
  '回族',
  '省',
  '市',
  '地区',
  '盟',
];

function aliases(name: string): string[] {
  const out = new Set<string>([name]);
  let cur = name;
  for (let i = 0; i < 4; i++) {
    const hit = SUFFIXES.find((s) => cur.length > s.length && cur.endsWith(s));
    if (!hit) break;
    cur = cur.slice(0, -hit.length);
    out.add(cur);
  }
  return [...out];
}

interface Index {
  byCode: Map<string, AreaRow>;
  byName: Map<string, AreaRow[]>;
}

let index: Index | null = null;

function load(): Index {
  if (index) return index;
  const file = resolveDataFile(AREA_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw localError(
      'GENERIC',
      'AREA_TABLE_MISSING',
      `无法读取地区码表 ${file}：${(e as Error).message}`,
      '跑 zzapi ref sync 重新拉取，或重新安装 zzapi',
    );
  }
  const rows: any[] = Array.isArray(parsed) ? parsed : ((parsed as any)?.data ?? []);

  const byCode = new Map<string, AreaRow>();
  const byName = new Map<string, AreaRow[]>();
  for (const r of rows) {
    const areaCode = String(r.areaCode);
    const parentCode = r.parentCode == null ? null : String(r.parentCode);
    // 表里只有 parentCode，level 由父链推出：无父=全国(0)，父为全国=省(1)，其余=市(2)
    const level = parentCode == null ? 0 : parentCode === '0' ? 1 : 2;
    const row: AreaRow = { areaCode, areaName: String(r.areaName), parentCode, level };
    byCode.set(areaCode, row);
    for (const alias of aliases(row.areaName)) {
      const bucket = byName.get(alias) ?? [];
      bucket.push(row);
      byName.set(alias, bucket);
    }
  }
  index = { byCode, byName };
  return index;
}

export const areaResolver: Resolver = {
  name: 'area',
  labelFields: ['areaName'],

  resolve(input: string): Resolved {
    const raw = input.trim();
    if (!raw) {
      throw localError('VALIDATION', 'AREA_EMPTY', '--area 的值为空', '例：--area 上海 或 --area 310000');
    }
    const { byCode, byName } = load();

    const byCodeHit = byCode.get(raw);
    if (byCodeHit) {
      return { value: byCodeHit.areaCode, labels: { areaName: byCodeHit.areaName } };
    }

    const named = byName.get(raw);
    if (named && named.length) {
      // 同名取 level 最小者：省级优先
      const minLevel = Math.min(...named.map((r) => r.level));
      const picked = named.filter((r) => r.level === minLevel)[0];
      return { value: picked.areaCode, labels: { areaName: picked.areaName } };
    }

    if (/^\d+$/.test(raw)) {
      // 码表是静态快照，平台新增的码不该被本地表卡住：放行，但坐标里没有名字
      return { value: raw, labels: { areaName: null } };
    }

    const guesses = [...byName.keys()].filter((k) => k.includes(raw) || raw.includes(k)).slice(0, 5);
    throw localError(
      'VALIDATION',
      'AREA_NOT_FOUND',
      `无法识别的地区：${raw}`,
      guesses.length
        ? `是否想找：${guesses.join('、')}？也可直接传 6 位地区码`
        : '直接传 6 位地区码（如 310000），或用「上海」这样的地区名',
    );
  },

  label(code: string) {
    const hit = load().byCode.get(String(code));
    return { areaName: hit ? hit.areaName : null };
  },
};
