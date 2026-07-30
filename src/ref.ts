/**
 * `zzapi ref sync` —— 把两张码表从平台刷新到用户本地目录。
 *
 * 这个命令是手写的，不走 registry。registry 描述的是「查询型接口」：
 * 一次调用 → 一组记录 → 裁剪输出。而 sync 要做的是版本比对、下载 CSV、
 * 落盘、原子替换——这些没法用一段声明表达，硬塞进 registry 只会把 schema
 * 撑成通用编程语言。和 `auth status` 一样，属于 registry 之外的少数手写命令。
 *
 * 契约要求：version 未变则输出 "already up to date, no changes" 且**不下载**。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { localError } from './errors.js';
import {
  AREA_FILE,
  CATEGORY_FILE,
  atomicWrite,
  currentCategoryVersion,
  fileOrigin,
  localDataDir,
  resolveDataFile,
  sha256,
  writeLocalSources,
} from './refdata.js';
import type { Transport } from './transport.js';

const CATEGORY_ENDPOINT = '/openapi/price-track/category-notification';
const AREA_ENDPOINT = '/openapi/price-track/bp/get-product-area-config';

export interface SyncItem {
  ok: boolean;
  table: 'category' | 'area';
  /** unchanged = 平台版本与本地一致，没有下载 */
  status: 'unchanged' | 'updated' | 'available' | 'current';
  from?: string | null;
  to?: string | null;
  rows?: number;
  origin?: 'local' | 'packaged';
  path?: string;
  error?: unknown;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 下载分类 CSV。静态 CDN，实测不需要鉴权。 */
async function download(url: string, timeoutMs: number): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) {
      throw localError(
        'NETWORK',
        'DOWNLOAD_FAILED',
        `下载分类表失败：HTTP ${res.status}`,
        '稍后重试；若持续失败，平台的 downloadPath 可能已变更',
        true,
      );
    }
    return await res.text();
  } catch (e) {
    if ((e as any)?.code) throw e;
    const aborted = (e as Error)?.name === 'AbortError';
    throw localError(
      'NETWORK',
      aborted ? 'TIMEOUT' : 'DOWNLOAD_FAILED',
      aborted ? `下载分类表超时（${timeoutMs}ms）` : `下载分类表失败：${(e as Error).message}`,
      '用 --timeout 调大超时后重试',
      true,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** 下来的东西必须真是那张表，否则宁可不覆盖——写坏了本地就没有可用码表了 */
function assertLooksLikeCategoryCsv(text: string): number {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = (lines[0] ?? '').split(',').map((h) => h.trim());
  for (const need of ['id', 'name', 'parentId', 'level']) {
    if (!header.includes(need)) {
      throw localError(
        'GENERIC',
        'BAD_CATEGORY_TABLE',
        `下载到的内容不像分类表（表头缺少 ${need}）`,
        '已放弃写入，本地原有码表未被破坏。稍后重试或提 issue',
      );
    }
  }
  if (lines.length < 100) {
    throw localError(
      'GENERIC',
      'BAD_CATEGORY_TABLE',
      `下载到的分类表只有 ${lines.length - 1} 行，明显不完整`,
      '已放弃写入，本地原有码表未被破坏',
    );
  }
  return lines.length - 1;
}

async function syncCategory(
  transport: Transport,
  timeoutMs: number,
  check: boolean,
): Promise<SyncItem> {
  const body = (await transport.call(CATEGORY_ENDPOINT, {})) as any;
  const remoteVersion = String(body?.data?.version ?? '');
  const downloadPath = String(body?.data?.downloadPath ?? '');
  const localVersion = currentCategoryVersion();

  if (!remoteVersion || !downloadPath) {
    throw localError(
      'GENERIC',
      'BAD_RESPONSE',
      '分类配置接口没有返回 version / downloadPath',
      '平台返回结构可能变了，带 --debug 重跑查看原始响应',
    );
  }

  if (remoteVersion === localVersion) {
    return {
      ok: true,
      table: 'category',
      status: 'unchanged',
      from: localVersion,
      to: remoteVersion,
      origin: fileOrigin(CATEGORY_FILE),
    };
  }
  if (check) {
    return { ok: true, table: 'category', status: 'available', from: localVersion, to: remoteVersion };
  }

  const csv = await download(downloadPath, timeoutMs);
  const rows = assertLooksLikeCategoryCsv(csv);
  const path = join(localDataDir(), CATEGORY_FILE);
  atomicWrite(path, csv);
  writeLocalSources({
    category: {
      file: CATEGORY_FILE,
      version: remoteVersion,
      endpoint: CATEGORY_ENDPOINT,
      downloadPath,
      capturedAt: today(),
      rows,
    },
  });
  return { ok: true, table: 'category', status: 'updated', from: localVersion, to: remoteVersion, rows, origin: 'local', path };
}

async function syncArea(transport: Transport, check: boolean): Promise<SyncItem> {
  const body = (await transport.call(AREA_ENDPOINT, {})) as any;
  const rows = body?.data;
  if (!Array.isArray(rows) || rows.length < 10) {
    throw localError(
      'GENERIC',
      'BAD_AREA_TABLE',
      `地区配置接口返回的不是有效数组（拿到 ${Array.isArray(rows) ? rows.length + ' 条' : typeof rows}）`,
      '已放弃写入，本地原有码表未被破坏',
    );
  }

  // 该接口不返回版本号，只能整表比对：拿当前生效的表算指纹
  const serialized = `${JSON.stringify(rows, null, 2)}\n`;
  let currentHash: string | null = null;
  try {
    const cur = JSON.parse(readFileSync(resolveDataFile(AREA_FILE), 'utf8'));
    const curRows = Array.isArray(cur) ? cur : (cur?.data ?? []);
    currentHash = sha256(`${JSON.stringify(curRows, null, 2)}\n`);
  } catch {
    /* 读不到就当没有，走更新 */
  }
  const remoteHash = sha256(serialized);

  if (currentHash === remoteHash) {
    return {
      ok: true,
      table: 'area',
      status: 'unchanged',
      rows: rows.length,
      origin: fileOrigin(AREA_FILE),
    };
  }
  if (check) {
    return { ok: true, table: 'area', status: 'available', rows: rows.length };
  }

  const path = join(localDataDir(), AREA_FILE);
  atomicWrite(path, serialized);
  writeLocalSources({
    area: {
      file: AREA_FILE,
      version: null,
      endpoint: AREA_ENDPOINT,
      note: '该接口不返回版本号，按整表内容比对',
      capturedAt: today(),
      rows: rows.length,
    },
  });
  return { ok: true, table: 'area', status: 'updated', rows: rows.length, origin: 'local', path };
}

export async function refSync(opts: {
  transport: Transport;
  timeoutMs: number;
  check: boolean;
}): Promise<SyncItem[]> {
  const out: SyncItem[] = [];
  for (const task of [
    () => syncCategory(opts.transport, opts.timeoutMs, opts.check),
    () => syncArea(opts.transport, opts.check),
  ]) {
    try {
      out.push(await task());
    } catch (e) {
      const err = e as any;
      out.push({
        ok: false,
        table: out.length === 0 ? 'category' : 'area',
        status: 'unchanged',
        error: err?.toShape ? err.toShape() : { code: 'INTERNAL', message: String(err?.message ?? err) },
      });
    }
  }
  return out;
}

/** 两张表当前各自从哪来、什么版本 */
export function refStatus(): SyncItem[] {
  return [
    {
      ok: true,
      table: 'category',
      status: 'current',
      to: currentCategoryVersion(),
      origin: fileOrigin(CATEGORY_FILE),
      path: resolveDataFile(CATEGORY_FILE),
    },
    {
      ok: true,
      table: 'area',
      status: 'current',
      origin: fileOrigin(AREA_FILE),
      path: resolveDataFile(AREA_FILE),
    },
  ];
}
