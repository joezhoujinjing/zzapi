/**
 * registry：一个接口 = 一段声明，不是一个函数。
 *
 * 命令树、--help、参数校验、类型转换、resolver、默认字段全部由此派生。
 *
 * 验收标准（硬）：将来接 35 个企业风险接口，应当只需新增 YAML 文件，
 * TS 代码一行不改。这个文件负责让那条成立——任何 `if (verb === 'quote')`
 * 之类的特判都是对它的违背。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { getResolver, knownResolvers } from './resolvers/index.js';

const ParamSpec = z
  .object({
    required: z.boolean().default(false),
    positional: z.boolean().default(false),
    /** 接受逗号分隔多值，参与笛卡尔展开 */
    multi: z.boolean().default(false),
    type: z.enum(['string', 'int']).default('string'),
    default: z.union([z.string(), z.number()]).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    /** 引用 resolvers/ 下的 resolver 名，收码也收人话 */
    resolver: z.string().optional(),
    /** 覆盖机械命名规则（pageNum → page、pageSize → limit） */
    flag: z.string().optional(),
    desc: z.string().optional(),
  })
  .strict();

const TransformSpec = z
  .object({
    /** 相对单条记录的路径，`[]` 表示逐元素，如 priceInfo[].type */
    path: z.string(),
    /** 值映射表 */
    map: z.record(z.string()),
    /** 映射结果写到哪个字段（同级）；缺省覆盖原字段 */
    as: z.string().optional(),
  })
  .strict();

const ViewSpec = z
  .object({
    /** 触发该视图的 flag；缺省视图不写 */
    flag: z.string().optional(),
    desc: z.string().optional(),
    /** 相对单条记录的数组路径 */
    series: z.string(),
    fields: z.array(z.string()),
    /** 数值摘要：对 value 字段算 min/max/avg/首末变化，label 字段用于标注极值位置 */
    summary: z.object({ value: z.string(), label: z.string() }).optional(),
  })
  .strict();

const ResultSpec = z
  .object({
    /** 结果数组路径（一次调用 → 多条），与 item 二选一 */
    list: z.string().optional(),
    /** 结果单对象路径（一次调用 → 一条），与 list 二选一 */
    item: z.string().optional(),
    /**
     * 坐标字段：每一项输出必须自带的完整坐标。
     * 取自本次请求的参数值与 resolver 标签，不可被 --fields 裁掉。
     */
    coordinate: z.array(z.string()).default([]),
    /** 默认输出字段（人工标注——抓取器不知道哪几个字段是人要看的） */
    default_fields: z.array(z.string()).default([]),
    /** 从结果容器上带出的元信息字段，如 total */
    meta: z.array(z.string()).default([]),
    transforms: z.array(TransformSpec).default([]),
    /** 序列型结果的视图（如历史价格的月/周两套序列） */
    views: z.record(ViewSpec).optional(),
    /** TTY 表格渲染时把哪个数组字段展开成子表 */
    table_focus: z.string().optional(),
  })
  .strict()
  .refine((r) => (r.list ? 1 : 0) + (r.item ? 1 : 0) === 1, {
    message: 'result 必须且只能声明 list 或 item 之一',
  });

const VariantSpec = z
  .object({
    /** 触发该变体的 flag，如 by-area */
    flag: z.string(),
    desc: z.string().optional(),
    /** 前置调用：先调一个接口拿到一组值，再回填给主调用的某个参数 */
    prelude: z
      .object({
        path: z.string(),
        /** 前置调用的参数 → 取自主命令的哪个参数 */
        params: z.record(z.string()).default({}),
        /** 前置结果的数组路径 */
        list: z.string(),
        /** 结果过滤：字段 → 允许的取值集合 */
        filter: z.record(z.array(z.union([z.string(), z.number()]))).optional(),
        feed: z
          .object({
            /** 回填到主调用的哪个参数 */
            param: z.string(),
            /** 从数组元素的哪个字段取值 */
            value: z.string(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

const EndpointSpec = z
  .object({
    noun: z.string(),
    verb: z.string(),
    path: z.string(),
    summary: z.string().optional(),
    params: z.record(ParamSpec).default({}),
    result: ResultSpec,
    variants: z.array(VariantSpec).default([]),
  })
  .strict();

const ModuleSpec = z
  .object({
    module: z.string(),
    endpoints: z.array(EndpointSpec),
  })
  .strict();

export type ParamSpec = z.infer<typeof ParamSpec>;
export type ViewSpec = z.infer<typeof ViewSpec>;
export type TransformSpec = z.infer<typeof TransformSpec>;
export type ResultSpec = z.infer<typeof ResultSpec>;
export type VariantSpec = z.infer<typeof VariantSpec>;
export type EndpointSpec = z.infer<typeof EndpointSpec>;

export interface Endpoint extends EndpointSpec {
  module: string;
}

function registryDir(): string {
  return join(dirname(dirname(fileURLToPath(import.meta.url))), 'registry');
}

/** 机械命名规则：凡是「码」，CLI 去掉 Code/Id 后缀；camelCase → kebab-case。 */
export function flagName(param: string, spec: ParamSpec): string {
  if (spec.flag) return spec.flag;
  const stripped = param.replace(/(Code|Id)$/, '');
  return stripped.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`).replace(/^-/, '');
}

function validateEndpoint(ep: Endpoint): void {
  const where = `${ep.module}: ${ep.noun} ${ep.verb}`;
  const resolvers = knownResolvers();
  const contributed = new Set<string>(Object.keys(ep.params));

  for (const [name, p] of Object.entries(ep.params)) {
    if (p.resolver && !resolvers.includes(p.resolver)) {
      throw new Error(`${where}: 参数 ${name} 引用了未知 resolver "${p.resolver}"`);
    }
    if (p.positional && p.default !== undefined) {
      throw new Error(`${where}: 位置参数 ${name} 不应有 default`);
    }
  }
  // resolver 贡献的坐标字段（如 areaName）也算合法坐标
  for (const p of Object.values(ep.params)) {
    if (!p.resolver) continue;
    for (const f of getResolver(p.resolver).labelFields) contributed.add(f);
  }
  for (const c of ep.result.coordinate) {
    if (!contributed.has(c)) {
      throw new Error(
        `${where}: coordinate 声明了 "${c}"，但它既不是参数名也不是任何 resolver 贡献的标签`,
      );
    }
  }
  for (const v of ep.variants) {
    if (!ep.params[v.prelude.feed.param]) {
      throw new Error(`${where}: variant --${v.flag} 回填到不存在的参数 ${v.prelude.feed.param}`);
    }
    for (const src of Object.values(v.prelude.params)) {
      if (!ep.params[src]) {
        throw new Error(`${where}: variant --${v.flag} 的 prelude 引用了不存在的参数 ${src}`);
      }
    }
  }
}

let cache: Endpoint[] | null = null;

/** 加载 registry/ 下全部 YAML 并做 zod 校验。 */
export function loadRegistry(): Endpoint[] {
  if (cache) return cache;
  const dir = registryDir();
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  const out: Endpoint[] = [];
  for (const f of files) {
    const raw = parseYaml(readFileSync(join(dir, f), 'utf8'));
    const parsed = ModuleSpec.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('\n');
      throw new Error(`registry/${f} 校验失败：\n${issues}`);
    }
    for (const ep of parsed.data.endpoints) {
      const full: Endpoint = { ...ep, module: parsed.data.module };
      validateEndpoint(full);
      out.push(full);
    }
  }
  const seen = new Set<string>();
  for (const ep of out) {
    const key = `${ep.noun} ${ep.verb}`;
    if (seen.has(key)) throw new Error(`registry 里出现重复命令：${key}`);
    seen.add(key);
  }
  cache = out;
  return out;
}
