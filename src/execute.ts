/**
 * 执行引擎：把一段 registry 声明 + 一组用户输入变成若干次 API 调用与聚合结果。
 *
 * 这里不认识任何具体接口。所有接口相关的知识都在 registry YAML 里。
 */

import {
  assertWithinLimit,
  cartesian,
  mapConcurrent,
  splitMulti,
  type Axis,
  type Outcome,
} from './expand.js';
import { localError, ZzError } from './errors.js';
import { getResolver } from './resolvers/index.js';
import type { Endpoint, ParamSpec, VariantSpec } from './registry.js';
import { flagName } from './registry.js';
import type { Transport } from './transport.js';

/** 并发度：受平台 2-token 限制的是 token 不是请求；4 路足够快又不激进 */
const CONCURRENCY = 4;

export interface Binding {
  /** 传给 API 的值 */
  value: unknown;
  /** 该值贡献的坐标标签（resolver 产出，如 areaName） */
  labels: Record<string, string | null>;
}

export interface ExecResult {
  /** 每次调用一个 outcome；成功的 value 是该次调用产出的原始记录数组 */
  outcomes: Outcome<unknown[]>[];
  /** 每次调用的元信息（result.meta 声明的字段），与 outcomes 同序 */
  metas: (Record<string, unknown> | null)[];
  /** 生效的视图名（序列型结果用），无则 null */
  view: string | null;
}

export function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let cur: any = obj;
  for (const seg of path.split('.')) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** flag 参数传进来时已经带好 `--x` 或 `<x>` 前缀，这里不再拼 */
function toInt(name: string, raw: unknown, spec: ParamSpec, flag: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw localError('VALIDATION', 'INVALID_NUMBER', `${flag} 需要整数，收到 "${raw}"`);
  }
  if (spec.min !== undefined && n < spec.min) {
    throw localError('VALIDATION', 'OUT_OF_RANGE', `${flag} 不能小于 ${spec.min}（收到 ${n}）`);
  }
  if (spec.max !== undefined && n > spec.max) {
    throw localError(
      'VALIDATION',
      'OUT_OF_RANGE',
      `${flag} 上限为 ${spec.max}，收到 ${n}`,
      `把 ${flag} 调到 ${spec.max} 及以下；需要更多数据请翻页（--page）`,
    );
  }
  return n;
}

/** 单个输入值 → Binding（做类型转换与 resolver 翻译） */
function bind(name: string, spec: ParamSpec, raw: unknown, flag: string): Binding {
  if (spec.resolver) {
    const r = getResolver(spec.resolver).resolve(String(raw));
    return { value: r.value, labels: r.labels };
  }
  if (spec.type === 'int') {
    return { value: toInt(name, raw, spec, flag), labels: {} };
  }
  if (spec.type === 'bool') {
    // CLI 是布尔开关，平台要的是 1/0
    const on = raw === true || raw === 'true' || raw === 1 || raw === '1';
    return { value: on ? 1 : 0, labels: {} };
  }
  const s = String(raw);
  if (!s.trim() && spec.required) {
    throw localError('VALIDATION', 'EMPTY_VALUE', `${flag} 不能为空`);
  }
  return { value: s, labels: {} };
}

/** 用户输入（字符串/数组）→ 该参数的取值轴 */
function axisFor(name: string, spec: ParamSpec, input: unknown, flag: string): Binding[] {
  const rawValues: unknown[] =
    spec.multi && typeof input === 'string' ? splitMulti(input) : [input];
  if (rawValues.length === 0) {
    throw localError('VALIDATION', 'EMPTY_VALUE', `${flag} 不能为空`);
  }
  return rawValues.map((v) => bind(name, spec, v, flag));
}

function coordinateOf(ep: Endpoint, bindings: Record<string, Binding>): Record<string, unknown> {
  const coord: Record<string, unknown> = {};
  for (const field of (ep.result?.coordinate ?? [])) {
    if (bindings[field]) {
      coord[field] = bindings[field].value;
      continue;
    }
    // 不是参数名，就是某个 resolver 贡献的标签
    for (const b of Object.values(bindings)) {
      if (field in b.labels) {
        coord[field] = b.labels[field];
        break;
      }
    }
    // 本次请求没用到这个维度（如没传 --category）就不输出该坐标键，
    // 而不是塞一堆 null——坐标要完整，但只对真实存在的维度完整
  }
  return coord;
}

/** 跑 variant 的前置调用，产出回填给主参数的取值列表 */
async function runPrelude(
  variant: VariantSpec,
  ep: Endpoint,
  transport: Transport,
  base: Record<string, Binding>,
): Promise<Binding[]> {
  const p = variant.prelude;
  const body: Record<string, unknown> = {};
  for (const [target, source] of Object.entries(p.params)) {
    const b = base[source];
    if (b === undefined) {
      throw localError(
        'VALIDATION',
        'PRELUDE_MISSING_PARAM',
        `--${variant.flag} 需要参数 ${source}，但它没有取值`,
      );
    }
    body[target] = b.value;
  }
  const data = await transport.call(p.path, body);
  const rows = getPath(data, p.list);
  if (!Array.isArray(rows)) {
    throw localError(
      'GENERIC',
      'PRELUDE_BAD_SHAPE',
      `--${variant.flag} 的前置调用没有返回数组（路径 ${p.list}）`,
      '平台返回结构可能变了，带 --debug 重跑查看原始响应',
    );
  }
  const filtered = rows.filter((row: any) => {
    if (!p.filter) return true;
    return Object.entries(p.filter).every(([field, allowed]) =>
      allowed.map(String).includes(String(row?.[field])),
    );
  });

  const targetSpec = ep.params[p.feed.param];
  const resolver = targetSpec.resolver ? getResolver(targetSpec.resolver) : null;
  return filtered.map((row: any) => {
    const value = String(row[p.feed.value]);
    return { value, labels: resolver ? resolver.label(value) : {} };
  });
}

export interface ExecuteInput {
  endpoint: Endpoint;
  transport: Transport;
  /** 参数名 → 用户原始输入（未提供的参数不出现） */
  inputs: Record<string, unknown>;
  /** 被打开的 variant flag 集合 */
  variantFlags: Set<string>;
  /** 被选中的视图名 */
  view: string | null;
}

export async function execute(input: ExecuteInput): Promise<ExecResult> {
  const { endpoint: ep, transport } = input;

  // 1. 必填校验 + 默认值
  const effective: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(ep.params)) {
    const flag = spec.positional ? `<${name}>` : `--${flagName(name, spec)}`;
    const given = input.inputs[name];
    if (given !== undefined && given !== null && given !== '') {
      effective[name] = given;
    } else if (spec.default !== undefined) {
      effective[name] = spec.default;
    } else if (spec.required) {
      throw localError('VALIDATION', 'MISSING_PARAM', `缺少必填参数 ${flag}`);
    }
  }

  // 2. variant：前置调用的目标参数先从常规轴里摘出来
  const activeVariants = ep.variants.filter((v) => input.variantFlags.has(v.flag));
  if (activeVariants.length > 1) {
    throw localError(
      'VALIDATION',
      'VARIANT_CONFLICT',
      `${activeVariants.map((v) => `--${v.flag}`).join(' 与 ')} 不能同时使用`,
    );
  }
  const variant = activeVariants[0];
  const fedParam = variant?.prelude.feed.param;
  if (variant && input.inputs[fedParam!] !== undefined) {
    const spec = ep.params[fedParam!];
    throw localError(
      'VALIDATION',
      'VARIANT_CONFLICT',
      `--${variant.flag} 会自动填充 --${flagName(fedParam!, spec)}，两者不能同时使用`,
      `去掉 --${flagName(fedParam!, spec)}，或去掉 --${variant.flag} 手动指定`,
    );
  }

  // 3. 建轴（保持 registry 里的参数顺序，输出顺序可预期）
  const axes: Axis[] = [];
  const axisBindings: Record<string, Binding[]> = {};
  for (const [name, spec] of Object.entries(ep.params)) {
    if (variant && name === fedParam) continue;
    if (effective[name] === undefined) continue;
    const flag = spec.positional ? `<${name}>` : `--${flagName(name, spec)}`;
    const bindings = axisFor(name, spec, effective[name], flag);
    axisBindings[name] = bindings;
    axes.push({ param: name, values: bindings });
  }

  // 4. 展开
  let combos: Record<string, Binding>[];
  if (!variant) {
    combos = cartesian(axes) as Record<string, Binding>[];
    assertWithinLimit(combos.length, axes);
  } else {
    const baseCombos = cartesian(axes) as Record<string, Binding>[];
    assertWithinLimit(baseCombos.length, axes);
    combos = [];
    for (const base of baseCombos) {
      const fed = await runPrelude(variant, ep, transport, base);
      for (const b of fed) combos.push({ ...base, [fedParam!]: b });
    }
    // 前置调用回填后再查一次上限：--by-area 展开出多少地区是运行时才知道的
    assertWithinLimit(combos.length, [
      ...axes,
      {
        param: `${fedParam}(由 --${variant.flag} 填充)`,
        values: new Array(Math.round(combos.length / Math.max(baseCombos.length, 1))),
      },
    ]);
  }

  if (combos.length === 0) {
    return { outcomes: [], metas: [], view: input.view };
  }

  // 5. 执行
  const spec = ep.result!;
  const listPath = spec.list;
  const itemPath = spec.item;
  const metas: (Record<string, unknown> | null)[] = new Array(combos.length).fill(null);

  const outcomes = await mapConcurrent(
    combos,
    CONCURRENCY,
    async (combo, i): Promise<Outcome<unknown[]>> => {
      const coordinate = coordinateOf(ep, combo);
      const body: Record<string, unknown> = {};
      for (const [name, b] of Object.entries(combo)) {
        body[ep.params[name]?.send_as ?? name] = b.value;
      }
      try {
        const data = await transport.call(ep.path!, body, ep.ver);
        let records: unknown[];
        let container: unknown = data;
        if (listPath !== undefined) {
          const arr = getPath(data, listPath);
          records = Array.isArray(arr) ? arr : [];
          container = listPath.includes('.')
            ? getPath(data, listPath.slice(0, listPath.lastIndexOf('.')))
            : data;
        } else {
          const one = getPath(data, itemPath!);
          records = one == null ? [] : [one];
          container = one;
        }
        if (spec.meta.length && container && typeof container === 'object') {
          const m: Record<string, unknown> = {};
          for (const f of spec.meta) m[f] = (container as any)[f];
          metas[i] = m;
        }
        return { ok: true, coordinate, value: records };
      } catch (e) {
        if (e instanceof ZzError) return { ok: false, coordinate, error: e };
        throw e;
      }
    },
  );

  return { outcomes, metas, view: input.view };
}

// ——————————————————————————————————————————————————————————————
// 扇出：一个命令并发打 N 个接口
// ——————————————————————————————————————————————————————————————

export interface FanoutHit {
  ok: boolean;
  category: string;
  label: string;
  /** 该项返回的记录数；0 = 无风险记录 */
  n: number;
  records: unknown[];
  /** 该 target 声明的默认字段，供裁剪 */
  fields: string[];
  error?: ZzError;
}

export interface FanoutResult {
  /** resolve 归一化出来的坐标（信用代码 + 企业名等） */
  coordinate: Record<string, unknown>;
  items: FanoutHit[];
}

/**
 * 归一化：把用户给的一个值（代码或企业名）换成一组命名绑定。
 * try_params 按顺序试——先当代码试，不成再当名字试。
 */
async function runResolve(
  ep: Endpoint,
  transport: Transport,
  inputs: Record<string, Binding>,
): Promise<Record<string, unknown>> {
  const spec = ep.resolve!;
  let lastErr: ZzError | null = null;

  for (const attempt of spec.try_params) {
    const body: Record<string, unknown> = {};
    let usable = true;
    for (const [apiParam, source] of Object.entries(attempt)) {
      const b = inputs[source];
      if (b === undefined) { usable = false; break; }
      body[apiParam] = b.value;
    }
    if (!usable) continue;

    try {
      const data = await transport.call(spec.path, body, spec.ver);
      const raw = getPath(data, spec.list);
      const row = Array.isArray(raw) ? raw[0] : raw;
      if (!row || typeof row !== 'object') continue;
      const bound: Record<string, unknown> = {};
      for (const [field, bindName] of Object.entries(spec.bind)) {
        bound[bindName] = (row as any)[field];
      }
      // 绑定必须完整，缺一个后面扇出就会漏接口
      if (Object.values(bound).every((v) => v !== undefined && v !== null && v !== '')) {
        return bound;
      }
    } catch (e) {
      if (e instanceof ZzError) { lastErr = e; continue; }
      throw e;
    }
  }

  throw localError(
    'NOT_FOUND',
    'ENTERPRISE_NOT_FOUND',
    lastErr?.message || '无法定位到唯一企业',
    spec.hint ?? '换用精确的企业全名或统一社会信用代码',
  );
}

export interface FanoutInput {
  endpoint: Endpoint;
  transport: Transport;
  inputs: Record<string, unknown>;
  /** --only 指定的分类；空 = 全部 */
  only: string[];
}

export async function executeFanout(input: FanoutInput): Promise<FanoutResult[]> {
  const { endpoint: ep, transport } = input;
  const fan = ep.fanout!;

  // 主参数照常支持逗号多值：一次体检多家企业
  const axes: Axis[] = [];
  for (const [name, spec] of Object.entries(ep.params)) {
    const given = input.inputs[name] ?? spec.default;
    if (given === undefined || given === '') {
      if (spec.required) {
        throw localError('VALIDATION', 'MISSING_PARAM', `缺少必填参数 <${name}>`);
      }
      continue;
    }
    const flag = spec.positional ? `<${name}>` : `--${flagName(name, spec)}`;
    axes.push({ param: name, values: axisFor(name, spec, given, flag) });
  }
  const combos = cartesian(axes) as Record<string, Binding>[];

  const known = [...new Set(fan.targets.map((t) => t.category))];
  for (const c of input.only) {
    if (!known.includes(c)) {
      throw localError(
        'VALIDATION',
        'UNKNOWN_CATEGORY',
        `未知分类「${c}」`,
        `可用分类：${known.join('、')}`,
      );
    }
  }
  const targets = input.only.length
    ? fan.targets.filter((t) => input.only.includes(t.category))
    : fan.targets;

  // 上限管的是展开后的总请求数，扇出也不例外
  assertWithinLimit(combos.length * targets.length, [
    ...axes,
    { param: `扇出目标`, values: new Array(targets.length) },
  ]);

  const out: FanoutResult[] = [];
  for (const combo of combos) {
    const bound = ep.resolve ? await runResolve(ep, transport, combo) : {};
    // 主参数自身也可被 fanout 引用
    for (const [k, b] of Object.entries(combo)) bound[k] ??= b.value;

    // 坐标 ≠ 全部绑定值。resolve 产出的标识（信用代码/企业名）与会展开的
    // 主参数才是坐标；--history / --sanction-type 这类设置项只是入参，
    // 把它们塞进每一行输出是噪音。
    const coordinate: Record<string, unknown> = {};
    for (const k of Object.keys(ep.resolve?.bind ?? {}).map((f) => ep.resolve!.bind[f])) {
      coordinate[k] = bound[k];
    }
    for (const [name, spec] of Object.entries(ep.params)) {
      if (spec.positional || spec.multi) coordinate[name] = bound[name];
    }

    const items = await mapConcurrent(targets, CONCURRENCY, async (t): Promise<FanoutHit> => {
      const body: Record<string, unknown> = {};
      for (const [apiParam, source] of Object.entries(t.params)) {
        body[apiParam] = bound[source];
      }
      try {
        const data = await transport.call(t.path, body, t.ver ?? ep.ver);
        const arr = getPath(data, t.list);
        const records = Array.isArray(arr) ? arr : arr == null ? [] : [arr];
        return { ok: true, category: t.category, label: t.label, n: records.length, records, fields: t.default_fields };
      } catch (e) {
        if (e instanceof ZzError) {
          return { ok: false, category: t.category, label: t.label, n: 0, records: [], fields: t.default_fields, error: e };
        }
        throw e;
      }
    });

    out.push({ coordinate, items });
  }
  return out;
}
