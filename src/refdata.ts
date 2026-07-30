/**
 * 码表的两处来源与查找顺序。
 *
 *   1. 用户本地刷新副本  ~/.cache/zzapi/data/   ← ref sync 写这里
 *   2. 随包分发的静态快照 <pkg>/data/           ← 兜底，只读
 *
 * 刷新出来的数据落在用户目录，不进 git、不污染安装包；本地副本被清掉
 * （比如系统清理 cache）也只是退回包内快照，不会坏。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cacheDir } from './config.js';

export const CATEGORY_FILE = 'goods-category.csv';
export const AREA_FILE = 'product_area_config.json';
export const SOURCES_FILE = 'sources.json';

/** 随包分发的只读快照目录：dist/*.js 与 src/*.ts 到包根都是一级 */
export function packagedDataDir(): string {
  return join(dirname(dirname(fileURLToPath(import.meta.url))), 'data');
}

/** ref sync 写入的用户本地目录 */
export function localDataDir(): string {
  return join(cacheDir(), 'data');
}

/** 本地副本优先，回落到包内快照 */
export function resolveDataFile(name: string): string {
  const local = join(localDataDir(), name);
  if (existsSync(local)) return local;
  return join(packagedDataDir(), name);
}

/** 某张表当前实际生效的来源 */
export function fileOrigin(name: string): 'local' | 'packaged' {
  return existsSync(join(localDataDir(), name)) ? 'local' : 'packaged';
}

export interface TableSource {
  file: string;
  version: string | null;
  endpoint?: string;
  downloadPath?: string;
  capturedAt?: string;
  rows?: number;
  note?: string;
}

export interface Sources {
  category?: TableSource;
  area?: TableSource;
  [k: string]: unknown;
}

function readJson(path: string): Sources | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** 本地 sources.json 优先；缺字段时回落到包内那份 */
export function readSources(): Sources {
  const packaged = readJson(join(packagedDataDir(), SOURCES_FILE)) ?? {};
  const local = readJson(join(localDataDir(), SOURCES_FILE));
  if (!local) return packaged;
  return { ...packaged, ...local };
}

/** 当前生效的 category 版本号（本地刷新过就是本地的） */
export function currentCategoryVersion(): string | null {
  const local = readJson(join(localDataDir(), SOURCES_FILE));
  if (fileOrigin(CATEGORY_FILE) === 'local' && local?.category?.version) {
    return local.category.version;
  }
  return readJson(join(packagedDataDir(), SOURCES_FILE))?.category?.version ?? null;
}

export function writeLocalSources(patch: Sources): void {
  const dir = localDataDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, SOURCES_FILE);
  const merged = { ...(readJson(path) ?? {}), ...patch };
  atomicWrite(path, `${JSON.stringify(merged, null, 2)}\n`);
}

/** 原子写：先落 tmp 再 rename，避免写到一半被别的进程读到 */
export function atomicWrite(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
