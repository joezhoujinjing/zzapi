/**
 * 输出层：default_fields 裁剪、--fields、--full、坐标注入、JSON / 表格。
 *
 * 两条硬约束：
 *   1. 坐标字段不可被 --fields 裁掉——多值展开后不带坐标的数组无法解读
 *   2. --full 必须**无损**：原样吐全部原始字段，不做任何中间态加工
 *      （砍掉 raw 逃生舱后，这是唯一的保真出口）
 */

import { getPath } from './execute.js';
import type { Outcome } from './expand.js';
import type { Endpoint, ResultSpec, ViewSpec } from './registry.js';

export interface RenderOptions {
  full: boolean;
  fields: string[] | null;
  json: boolean;
  color: boolean;
}

export interface Envelope {
  items: Record<string, unknown>[];
  count: number;
  meta?: unknown;
}

/** 值映射变换（如 priceInfo[].type: "5" → "近一周"）。只作用于裁剪视图，--full 不碰。 */
function applyTransforms(record: any, spec: ResultSpec): any {
  if (!spec.transforms.length) return record;
  const out = structuredClone(record);
  for (const t of spec.transforms) {
    const [prefix, rest] = t.path.split('[].');
    if (rest === undefined) {
      const cur = getPath(out, t.path);
      if (cur == null) continue;
      const mapped = t.map[String(cur)];
      if (mapped === undefined) continue;
      setPath(out, t.as ? siblingPath(t.path, t.as) : t.path, mapped);
      continue;
    }
    const arr = getPath(out, prefix);
    if (!Array.isArray(arr)) continue;
    for (const el of arr) {
      if (el == null) continue;
      const cur = (el as any)[rest];
      const mapped = t.map[String(cur)];
      if (mapped === undefined) continue;
      (el as any)[t.as ?? rest] = mapped;
    }
  }
  return out;
}

function siblingPath(path: string, as: string): string {
  const i = path.lastIndexOf('.');
  return i < 0 ? as : `${path.slice(0, i)}.${as}`;
}

function setPath(obj: any, path: string, value: unknown): void {
  const segs = path.split('.');
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    if (cur[segs[i]] == null) cur[segs[i]] = {};
    cur = cur[segs[i]];
  }
  cur[segs[segs.length - 1]] = value;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 序列摘要：min/max/avg/首末变化。数值一律保留两位小数。 */
function summarize(points: any[], summary: { value: string; label: string }) {
  const pairs = points
    .map((p) => ({ label: p?.[summary.label], value: num(p?.[summary.value]) }))
    .filter((p) => p.value !== null) as { label: unknown; value: number }[];
  if (!pairs.length) return null;
  const values = pairs.map((p) => p.value);
  const min = pairs.reduce((a, b) => (b.value < a.value ? b : a));
  const max = pairs.reduce((a, b) => (b.value > a.value ? b : a));
  const first = pairs[0];
  const last = pairs[pairs.length - 1];
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    points: pairs.length,
    first: { [summary.label]: first.label, [summary.value]: round(first.value) },
    last: { [summary.label]: last.label, [summary.value]: round(last.value) },
    min: { [summary.label]: min.label, [summary.value]: round(min.value) },
    max: { [summary.label]: max.label, [summary.value]: round(max.value) },
    avg: round(values.reduce((a, b) => a + b, 0) / values.length),
    change: round(last.value - first.value),
    changePct: first.value === 0 ? null : round(((last.value - first.value) / first.value) * 100),
  };
}

function project(
  record: any,
  spec: ResultSpec,
  view: ViewSpec | null,
  opts: RenderOptions,
): Record<string, unknown> {
  if (opts.full) return record && typeof record === 'object' ? { ...record } : { value: record };

  const transformed = applyTransforms(record, spec);

  if (view) {
    const raw = getPath(transformed, view.series);
    const arr = Array.isArray(raw) ? raw : [];
    const points = arr.map((p: any) => {
      const o: Record<string, unknown> = {};
      for (const f of view.fields) o[f] = p?.[f];
      return o;
    });
    const out: Record<string, unknown> = {};
    // 序列视图之外的标量字段（如 goodsName/unit）沿用 default_fields
    for (const f of spec.default_fields) {
      if (f in transformed) out[f] = transformed[f];
    }
    if (view.summary) out.summary = summarize(arr, view.summary);
    out.points = points;
    return out;
  }

  const fields = opts.fields ?? spec.default_fields;
  if (!fields.length) return { ...transformed };
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (transformed && typeof transformed === 'object' && f in transformed) out[f] = transformed[f];
  }
  return out;
}

export function buildEnvelope(
  ep: Endpoint,
  outcomes: Outcome<unknown[]>[],
  metas: (Record<string, unknown> | null)[],
  viewName: string | null,
  opts: RenderOptions,
): Envelope {
  const view = viewName ? (ep.result.views?.[viewName] ?? null) : null;
  const items: Record<string, unknown>[] = [];

  outcomes.forEach((o) => {
    if (!o.ok) {
      items.push({ ok: false, ...o.coordinate, error: o.error!.toShape() });
      return;
    }
    for (const rec of o.value ?? []) {
      const projected = project(rec, ep.result, view, opts);
      // 坐标先写、原始字段后覆盖，保证 --full 无损（原始字段一个不改、一个不少）。
      // 坐标独有的字段（areaName / keyword / 供应商行上的 goodsCode）无论如何都留下。
      const item: Record<string, unknown> = { ok: true, ...o.coordinate, ...projected };
      // 万一将来某接口回显的值与请求值不一致，两个硬约束会打架：
      // 无损要求保留接口原值，坐标要求保留请求值。两个都留，谁也不丢。
      for (const [k, v] of Object.entries(o.coordinate)) {
        if (k in projected && JSON.stringify(projected[k]) !== JSON.stringify(v)) {
          item[`requested_${k}`] = v;
        }
      }
      items.push(item);
    }
  });

  const env: Envelope = { items, count: items.length };

  const metaFields = ep.result.meta;
  if (metaFields.length) {
    const present = metas.filter((m) => m !== null) as Record<string, unknown>[];
    if (present.length === 1 && outcomes.length === 1) {
      env.meta = present[0];
    } else if (present.length) {
      env.meta = outcomes
        .map((o, i) => (metas[i] ? { ...o.coordinate, ...metas[i] } : null))
        .filter(Boolean);
    }
  }
  return env;
}

// —— 表格渲染（仅 TTY）——

function width(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    // CJK / 全角按两列算，否则中文表格会错位
    w += (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6)
      ? 2
      : 1;
  }
  return w;
}

function pad(s: string, target: number): string {
  return s + ' '.repeat(Math.max(0, target - width(s)));
}

function cell(v: unknown): string {
  if (v == null) return '-';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function table(rows: Record<string, unknown>[], columns: string[]): string {
  if (!rows.length) return '';
  const widths = columns.map((c) =>
    Math.max(width(c), ...rows.map((r) => width(cell(r[c])))),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => pad(c, widths[i])).join('  ').trimEnd();
  const out = [line(columns), line(widths.map((w) => '─'.repeat(w)))];
  for (const r of rows) out.push(line(columns.map((c) => cell(r[c]))));
  return out.join('\n');
}

export function renderTable(ep: Endpoint, env: Envelope): string {
  if (!env.items.length) return '（无数据）';
  const focus = ep.result.table_focus;
  const chunks: string[] = [];

  const hasSubTable = env.items.some(
    (it) => Array.isArray(it.points) || (focus && Array.isArray(it[focus])),
  );

  if (hasSubTable) {
    for (const item of env.items) {
      const sub = (item.points ?? (focus ? item[focus] : null)) as unknown;
      const head = Object.entries(item)
        .filter(([k, v]) => k !== 'points' && k !== focus && k !== 'ok' && !Array.isArray(v))
        .map(([k, v]) => (typeof v === 'object' && v !== null ? `${k}=${JSON.stringify(v)}` : `${k}=${cell(v)}`))
        .join('  ');
      chunks.push(item.ok === false ? `✗ ${head}` : head);
      if (Array.isArray(sub) && sub.length) {
        const cols = [...new Set(sub.flatMap((r) => Object.keys(r ?? {})))];
        chunks.push(
          table(sub as Record<string, unknown>[], cols)
            .split('\n')
            .map((l) => `  ${l}`)
            .join('\n'),
        );
      }
      chunks.push('');
    }
    return chunks.join('\n').trimEnd();
  }

  const columns = [...new Set(env.items.flatMap((i) => Object.keys(i)))].filter(
    (c) => c !== 'ok' && c !== 'error',
  );
  const rows = env.items.map((i) => {
    const r: Record<string, unknown> = { ...i };
    if (i.ok === false) r[columns[0]] = `✗ ${cell(i[columns[0]])}`;
    if (i.error) r[columns[columns.length - 1]] = (i.error as any).message;
    return r;
  });
  let out = table(rows, columns);
  const failed = env.items.filter((i) => i.ok === false);
  if (failed.length) {
    out += `\n\n${failed.length} 项失败：`;
    for (const f of failed) {
      const err = f.error as any;
      out += `\n  ✗ ${err.code}: ${err.message}${err.hint ? `\n    → ${err.hint}` : ''}`;
    }
  }
  if (env.meta) out += `\n\nmeta: ${JSON.stringify(env.meta)}`;
  return out;
}

export function renderJson(env: Envelope): string {
  return JSON.stringify(env, null, 2);
}
