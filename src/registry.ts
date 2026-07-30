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
    /** bool 走 CLI 布尔开关，发给平台时映射成 1/0 */
    type: z.enum(['string', 'int', 'bool']).default('string'),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    /** 引用 resolvers/ 下的 resolver 名，收码也收人话 */
    resolver: z.string().optional(),
    /** 覆盖机械命名规则（pageNum → page、pageSize → limit） */
    flag: z.string().optional(),
    /**
     * 发给平台时改用这个字段名。用于平台参数名与 CLI 语义不符的情况：
     * 企业搜索的入参叫 companyName，但它其实是关键词，而返回行里也有
     * companyName（匹配到的企业名），同名会让坐标和数据打架。
     */
    send_as: z.string().optional(),
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
    /**
     * 默认行过滤，--all 关闭。
     * 用于「接口返回的东西里，大部分对回答问题没用」的情况：企业搜索前排
     * 全是没有信用代码的注销企业，不过滤的话默认输出对下一步毫无用处。
     * 被过滤掉的条数会报在 meta.filtered 里，不静默丢弃。
     */
    filter: z
      .record(
        z.union([
          z.array(z.union([z.string(), z.number()])), // 取值白名单
          z.object({ present: z.boolean() }).strict(), // 字段必须非空
        ]),
      )
      .optional(),
  })
  .strict()
  .refine((r) => (r.list ? 1 : 0) + (r.item ? 1 : 0) === 1, {
    message: 'result 必须且只能声明 list 或 item 之一',
  });

/**
 * 扇出：一个命令并发打 N 个接口，结果按来源打标后汇总。
 *
 * 和 variants 的 prelude（链式：先 A 再 B）不同，这是并发的 N 路。
 * 用户问的是「这家企业有没有风险」，不是「查一下军队采购失信表」——
 * 让调用方自己扇出 17 次再拼结果，等于把活推回去。
 */
const FanoutTargetSpec = z
  .object({
    /** 分类，供 --only 过滤 */
    category: z.string(),
    /** 人类可读的项目名，进输出 */
    label: z.string(),
    path: z.string(),
    /** 该接口的 ver，缺省用 endpoint 级 ver */
    ver: z.number().optional(),
    /** 平台参数名 → 取自哪个已绑定的值 */
    params: z.record(z.string()).default({}),
    /** 结果数组路径 */
    list: z.string().default('data'),
    default_fields: z.array(z.string()).default([]),
    /**
     * 随该项命中一起输出的解读提示。
     * 用于「命中不等于这家企业有问题」的接口：股权出质/冻结类记录里，
     * 这家企业可能是债权人而非债务人，不看主体字段就会误报。
     */
    note: z.string().optional(),
  })
  .strict();

/**
 * 上下文调用：结果并入 summary 的 meta，而不是当成一个体检项。
 * 空壳指数这类「人人有分」的推断评分属于此类——它是这份体检的背景，
 * 不是事实记录，混进 items 会污染命中计数、也会让人分不清
 * 「官方登记的事实」和「平台算的分」。
 */
const FanoutContextSpec = z
  .object({
    path: z.string(),
    ver: z.number().optional(),
    params: z.record(z.string()).default({}),
    item: z.string().default('data'),
    /** 结果字段 → 并入 meta 时的键名 */
    as: z.record(z.string()),
  })
  .strict();

const FanoutSpec = z
  .object({
    /** 每条结果上标注来源的字段名 */
    tag_category: z.string().default('category'),
    tag_label: z.string().default('riskType'),
    /**
     * 一条命令最多体检几个实体。
     * 扇出不按「总请求数」限制——目标数是 registry 定的，不是用户能控制的维度，
     * 拿它去卡用户等于让人做除法（17 个目标 → 只能查 2 家）。按实体数限制才
     * 对得上用户心智：「我要查几家」。
     */
    max_entities: z.number().default(10),
    /** 并入 meta 的上下文调用；失败不影响主体结论 */
    context: z.array(FanoutContextSpec).default([]),
    targets: z.array(FanoutTargetSpec).min(1),
  })
  .strict();

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

/**
 * 归一化前置：把用户给的一个值换成一组命名绑定，供后续调用使用。
 *
 * 企业风险要用信用代码调 15 个接口、用企业名调 2 个，而用户手上通常只有其一。
 * 先打一次「企业基本信息」把两者都拿到，后面才谈得上扇出。
 */
const ResolveSpec = z
  .object({
    path: z.string(),
    ver: z.number().optional(),
    /** 平台参数名 → 主命令参数名；多个候选按顺序试，命中即止 */
    try_params: z.array(z.record(z.string())).min(1),
    /** 结果路径；指向数组时取第一条 */
    list: z.string().default('data'),
    /** 结果字段 → 绑定名，供 fanout 的 params 引用 */
    bind: z.record(z.string()),
    /** 解析失败时的提示 */
    hint: z.string().optional(),
  })
  .strict();

const EndpointSpec = z
  .object({
    noun: z.string(),
    verb: z.string(),
    /** 单接口命令用 path；扇出命令用 fanout，二选一 */
    path: z.string().optional(),
    /** 该接口的 ver，缺省 1。行政处罚 v2 之类需要覆盖 */
    ver: z.number().optional(),
    summary: z.string().optional(),
    params: z.record(ParamSpec).default({}),
    result: ResultSpec.optional(),
    /**
     * 请求体映射：平台参数名 → 绑定名（参数值或 resolve 产出）。
     * 声明后请求体只由它决定，用户参数不再直接下发——用于「用户给的是
     * 企业名，但接口要的是信用代码」这类需要中转的场景。
     */
    send: z.record(z.string()).optional(),
    variants: z.array(VariantSpec).default([]),
    resolve: ResolveSpec.optional(),
    fanout: FanoutSpec.optional(),
  })
  .strict()
  .refine((e) => (e.path ? 1 : 0) + (e.fanout ? 1 : 0) === 1, {
    message: 'endpoint 必须且只能声明 path 或 fanout 之一',
  })
  .refine((e) => !!e.fanout || !!e.result, {
    message: '单接口 endpoint 必须声明 result',
  });

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
export type FanoutSpec = z.infer<typeof FanoutSpec>;
export type FanoutTargetSpec = z.infer<typeof FanoutTargetSpec>;
export type FanoutContextSpec = z.infer<typeof FanoutContextSpec>;
export type ResolveSpec = z.infer<typeof ResolveSpec>;
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
  for (const b of Object.values(ep.resolve?.bind ?? {})) contributed.add(b);
  for (const c of ep.result?.coordinate ?? []) {
    if (!contributed.has(c)) {
      throw new Error(
        `${where}: coordinate 声明了 "${c}"，但它既不是参数名也不是任何 resolver 贡献的标签`,
      );
    }
  }
  if (ep.fanout) {
    const bound = new Set([...Object.keys(ep.params), ...Object.values(ep.resolve?.bind ?? {})]);
    const cats = new Set<string>();
    for (const t of ep.fanout.targets) {
      cats.add(t.category);
      for (const [apiParam, source] of Object.entries(t.params)) {
        if (!bound.has(source)) {
          throw new Error(
            `${where}: fanout 目标「${t.label}」的 ${apiParam} 取自 "${source}"，` +
              `但它既不是参数名也不是 resolve.bind 产出的绑定名`,
          );
        }
      }
    }
    if (!cats.size) throw new Error(`${where}: fanout 没有任何 category`);
    for (const c of ep.fanout.context) {
      for (const [apiParam, source] of Object.entries(c.params)) {
        if (!bound.has(source)) {
          throw new Error(`${where}: fanout.context 的 ${apiParam} 取自未知绑定 "${source}"`);
        }
      }
    }
  }
  if (ep.send) {
    const bound = new Set([...Object.keys(ep.params), ...Object.values(ep.resolve?.bind ?? {})]);
    for (const [apiParam, source] of Object.entries(ep.send)) {
      if (!bound.has(source)) {
        throw new Error(
          `${where}: send 的 ${apiParam} 取自 "${source}"，但它既不是参数名也不是 resolve.bind 产出的绑定名`,
        );
      }
    }
  }
  if (ep.resolve) {
    for (const attempt of ep.resolve.try_params) {
      for (const src of Object.values(attempt)) {
        if (!ep.params[src]) {
          throw new Error(`${where}: resolve 引用了不存在的参数 ${src}`);
        }
      }
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
