/**
 * 逗号多值 → 笛卡尔展开 → 上限校验 → 部分失败聚合。
 *
 * 全局范式：registry 里标了 `multi: true` 的参数都接受逗号分隔多值。
 * 字面逗号用 `\,` 转义。未标 multi 的参数（如 --limit）不拆分。
 *
 * 硬约束：上限（50）管的是**展开后的总请求数**，不是逗号里的值个数。
 */

import { EXIT, localError, ZzError, type ErrorShape } from './errors.js';

/** 展开后允许的最大请求数 */
export const MAX_REQUESTS = 50;

/** 按未转义的逗号切分；`\,` 还原为字面逗号。 */
export function splitMulti(raw: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\' && raw[i + 1] === ',') {
      cur += ',';
      i++;
      continue;
    }
    if (c === '\\' && raw[i + 1] === '\\') {
      cur += '\\';
      i++;
      continue;
    }
    if (c === ',') {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

export interface Axis {
  param: string;
  values: unknown[];
}

/** 笛卡尔积展开；轴的顺序决定输出顺序（第一个轴变化最慢）。 */
export function cartesian(axes: Axis[]): Record<string, unknown>[] {
  let combos: Record<string, unknown>[] = [{}];
  for (const axis of axes) {
    const next: Record<string, unknown>[] = [];
    for (const base of combos) {
      for (const v of axis.values) {
        next.push({ ...base, [axis.param]: v });
      }
    }
    combos = next;
  }
  return combos;
}

/** 展开后总请求数上限校验；超限 exit 2，hint 报出实际会产生多少次调用。 */
export function assertWithinLimit(count: number, axes: Axis[]): void {
  if (count <= MAX_REQUESTS) return;
  const breakdown = axes
    .filter((a) => a.values.length > 1)
    .map((a) => `${a.param}×${a.values.length}`)
    .join(' × ');
  throw localError(
    'VALIDATION',
    'TOO_MANY_REQUESTS',
    `这组参数会展开成 ${count} 次 API 调用，超过上限 ${MAX_REQUESTS}`,
    `${breakdown ? `展开来源：${breakdown}。` : ''}减少多值参数的取值个数，或分批执行`,
  );
}

export interface Outcome<T> {
  ok: boolean;
  coordinate: Record<string, unknown>;
  value?: T;
  error?: ZzError;
}

/**
 * 部分失败的退出码语义：
 *   全成功 → 0；部分失败 → 6；全失败 → 按首个错误的类别。
 */
export function aggregateExitCode(outcomes: Outcome<unknown>[]): number {
  const failed = outcomes.filter((o) => !o.ok);
  if (failed.length === 0) return EXIT.OK;
  if (failed.length < outcomes.length) return EXIT.PARTIAL;
  return failed[0].error?.exitCode ?? EXIT.GENERIC;
}

export function errorShape(e: ZzError): ErrorShape {
  return e.toShape();
}

/** 有限并发执行，保持输入顺序。 */
export async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
