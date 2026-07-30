/**
 * 分类 resolver：`--category 螺纹钢` / `--category 3402` 都收。
 *
 * 码表是随包分发的分类 CSV（15,726 节点）。同名取 level 最小者；
 * 若最小 level 上仍然重名（实测 43 例，如「无缝钢管」），不猜——报错并列出候选 id。
 * CSV 684KB，只在真的用到 --category 时才解析。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { localError } from '../errors.js';
import { CATEGORY_FILE, resolveDataFile } from '../refdata.js';
import { type Resolved, type Resolver } from './index.js';

interface CategoryRow {
  id: string;
  name: string;
  parentId: string;
  level: number;
  hasData: boolean;
}

interface Index {
  byId: Map<string, CategoryRow>;
  byName: Map<string, CategoryRow[]>;
}

let index: Index | null = null;

function csvFile(): string {
  const exact = resolveDataFile(CATEGORY_FILE);
  if (existsSync(exact)) return exact;
  // 兼容带版本号的旧文件名（ref sync 从 downloadPath 拉下来的原名就是这种）
  const dir = dirname(exact);
  const legacy = readdirSync(dir).find((f) => /^goods_category_v\d+\.csv$/.test(f));
  if (legacy) return join(dir, legacy);
  throw localError(
    'GENERIC',
    'CATEGORY_TABLE_MISSING',
    `${dir} 下找不到 ${CATEGORY_FILE}`,
    '跑 zzapi ref sync 重新拉取，或重新安装 zzapi',
  );
}

function load(): Index {
  if (index) return index;
  const text = readFileSync(csvFile(), 'utf8');
  const lines = text.split(/\r?\n/);
  const header = (lines[0] ?? '').split(',').map((h) => h.trim());
  const col = (n: string) => header.indexOf(n);
  const iId = col('id');
  const iName = col('name');
  const iParent = col('parentId');
  const iLevel = col('level');
  const iHasData = col('hasData');

  const byId = new Map<string, CategoryRow>();
  const byName = new Map<string, CategoryRow[]>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const f = line.split(',');
    if (f.length < header.length) continue;
    const row: CategoryRow = {
      id: f[iId].trim(),
      name: f[iName].trim(),
      parentId: f[iParent]?.trim() ?? '',
      level: Number(f[iLevel]) || 0,
      hasData: (f[iHasData] ?? '').trim() === 'true',
    };
    if (!row.id) continue;
    byId.set(row.id, row);
    const bucket = byName.get(row.name) ?? [];
    bucket.push(row);
    byName.set(row.name, bucket);
  }
  index = { byId, byName };
  return index;
}

export const categoryResolver: Resolver = {
  name: 'category',
  labelFields: ['categoryName'],

  resolve(input: string): Resolved {
    const raw = input.trim();
    if (!raw) {
      throw localError(
        'VALIDATION',
        'CATEGORY_EMPTY',
        '--category 的值为空',
        '例：--category 螺纹钢 或 --category 3402',
      );
    }
    const { byId, byName } = load();

    const byIdHit = byId.get(raw);
    if (byIdHit) {
      return { value: byIdHit.id, labels: { categoryName: byIdHit.name } };
    }

    const named = byName.get(raw);
    if (named && named.length) {
      const minLevel = Math.min(...named.map((r) => r.level));
      let candidates = named.filter((r) => r.level === minLevel);
      if (candidates.length > 1) {
        // 有数据的优先，能消歧就消歧
        const withData = candidates.filter((r) => r.hasData);
        if (withData.length === 1) candidates = withData;
      }
      if (candidates.length > 1) {
        throw localError(
          'VALIDATION',
          'CATEGORY_AMBIGUOUS',
          `分类名「${raw}」对应 ${candidates.length} 个不同分类`,
          `用 id 精确指定：${candidates
            .slice(0, 6)
            .map((c) => `${c.id}(level ${c.level}, 父 ${c.parentId})`)
            .join('、')}`,
        );
      }
      return { value: candidates[0].id, labels: { categoryName: candidates[0].name } };
    }

    if (/^\d+$/.test(raw)) {
      // CSV 是静态快照，平台新增的分类不该被本地表卡住
      return { value: raw, labels: { categoryName: null } };
    }

    const guesses = [...byName.keys()].filter((k) => k.includes(raw)).slice(0, 5);
    throw localError(
      'VALIDATION',
      'CATEGORY_NOT_FOUND',
      `无法识别的分类：${raw}`,
      guesses.length
        ? `是否想找：${guesses.join('、')}？也可直接传分类 id`
        : '直接传分类 id（如 3402），或用「螺纹钢」这样的分类名',
    );
  },

  label(id: string) {
    const hit = load().byId.get(String(id));
    return { categoryName: hit ? hit.name : null };
  },
};
