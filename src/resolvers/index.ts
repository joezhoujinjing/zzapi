/**
 * resolver：把「人话」翻译成平台要的码。
 *
 * 读的码表优先用 `zzapi ref sync` 刷到用户本地的副本，没有则回落到随包快照。
 * registry 里 `resolver: area` 这样引用；新增接口复用已有 resolver 时无需改代码。
 */

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

/**
 * 码表文件路径：ref sync 刷到用户本地的副本优先，回落到随包快照。
 * 查找顺序集中在 refdata.ts，这里只转发。
 */
export { resolveDataFile } from '../refdata.js';

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
