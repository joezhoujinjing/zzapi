/**
 * resolver：把「人话」翻译成平台要的码。
 *
 * 读的是随包分发的 data/ 静态码表，v1 不联网同步（同步能力随 ref 命令组延后）。
 * registry 里 `resolver: area` 这样引用；新增接口复用已有 resolver 时无需改代码。
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export interface Resolved {
  /** 传给 API 的值 */
  value: string;
  /** 贡献给输出坐标的附加字段，如 {areaName: "上海市"} */
  labels: Record<string, string | null>;
}

export interface Resolver {
  readonly name: string;
  /** 该 resolver 会贡献哪些坐标字段（用于 registry 校验 coordinate 声明） */
  readonly labelFields: readonly string[];
  /** 码或人话 → 码 + 标签；无法解析时抛 ZzError */
  resolve(input: string): Resolved;
  /** 已知是码时反查标签（prelude 回填用） */
  label(code: string): Record<string, string | null>;
}

/** data/ 目录：dist/resolvers/*.js 与 src/resolvers/*.ts 到包根都是两级 */
export function dataDir(): string {
  return join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'data');
}

import { areaResolver } from './area.js';
import { categoryResolver } from './category.js';

const RESOLVERS: Record<string, Resolver> = {
  area: areaResolver,
  category: categoryResolver,
};

export function getResolver(name: string): Resolver {
  const r = RESOLVERS[name];
  if (!r) {
    throw new Error(
      `registry 引用了未知 resolver "${name}"，可用：${Object.keys(RESOLVERS).join(', ')}`,
    );
  }
  return r;
}

export function knownResolvers(): string[] {
  return Object.keys(RESOLVERS);
}
