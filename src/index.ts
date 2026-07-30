#!/usr/bin/env node
/**
 * zzapi —— 中资（cneptp）寻源询价 OpenAPI 命令行客户端。
 *
 * 命令树完全由 registry/*.yaml 派生。这个文件里不应出现任何具体接口的名字。
 */

import { Command, Option } from 'commander';
import { getToken } from './auth.js';
import type { Env } from './config.js';
import { EXIT, ZzError, localError } from './errors.js';
import { execute } from './execute.js';
import { aggregateExitCode, splitMulti } from './expand.js';
import { refStatus, refSync, type SyncItem } from './ref.js';
import { loadRegistry, flagName, type Endpoint } from './registry.js';
import { buildEnvelope, renderJson, renderTable, type RenderOptions } from './render.js';
import { Transport } from './transport.js';

const VERSION = '0.1.0';

interface GlobalOpts {
  json: boolean;
  full: boolean;
  fields?: string;
  quiet: boolean;
  env: Env;
  timeout: string;
  debug: boolean;
  color: boolean;
  interactive: boolean;
}

/** 非 TTY 时自动开启 --json --quiet --no-interactive */
function resolveOutputMode(opts: GlobalOpts) {
  const tty = process.stdout.isTTY === true;
  return {
    json: opts.json || !tty,
    quiet: opts.quiet || !tty,
    interactive: opts.interactive && tty,
    color: opts.color && tty,
  };
}

function emitError(e: ZzError, json: boolean): never {
  const payload = { error: e.toShape() };
  if (json) {
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stderr.write(`✗ ${e.code}: ${e.message}\n`);
    if (e.hint) process.stderr.write(`  → ${e.hint}\n`);
  }
  process.exit(e.exitCode);
}

function defaultViewName(ep: Endpoint): string | null {
  const views = ep.result.views;
  if (!views) return null;
  const entry = Object.entries(views).find(([, v]) => !v.flag);
  return entry ? entry[0] : null;
}

function buildEndpointCommand(ep: Endpoint): Command {
  const positionals = Object.entries(ep.params).filter(([, p]) => p.positional);
  // 位置参数保留 API 原名（<goodsCode>）；去 Code/Id 的机械规则只作用于 flag
  const argSig = positionals.map(([name, p]) => (p.required ? `<${name}>` : `[${name}]`)).join(' ');

  const cmd = new Command(ep.verb);
  if (argSig) cmd.arguments(argSig);
  if (ep.summary) cmd.description(ep.summary);

  for (const [name, p] of Object.entries(ep.params)) {
    if (p.positional) continue;
    const flag = flagName(name, p);
    const bits: string[] = [];
    if (p.desc) bits.push(p.desc);
    if (p.resolver) bits.push(`接受码或名称`);
    if (p.multi) bits.push('可逗号分隔多值');
    if (p.max !== undefined) bits.push(`上限 ${p.max}`);
    if (p.default !== undefined) bits.push(`默认 ${p.default}`);
    cmd.addOption(new Option(`--${flag} <值>`, bits.join('，')));
  }

  for (const v of ep.variants) {
    cmd.addOption(new Option(`--${v.flag}`, v.desc ?? `启用 ${v.flag} 变体`));
  }

  for (const [viewName, view] of Object.entries(ep.result.views ?? {})) {
    if (!view.flag) continue;
    cmd.addOption(new Option(`--${view.flag}`, view.desc ?? `输出 ${viewName} 视图`));
  }

  cmd.action(async (...args: unknown[]) => {
    // commander 回调签名：(...positionals, options, command)
    const command = args[args.length - 1] as Command;
    const options = args[args.length - 2] as Record<string, unknown>;
    const positionalValues = args.slice(0, args.length - 2);
    const g = command.optsWithGlobals() as unknown as GlobalOpts;
    const mode = resolveOutputMode(g);

    try {
      const inputs: Record<string, unknown> = {};
      positionals.forEach(([name], i) => {
        const v = positionalValues[i];
        if (v !== undefined) inputs[name] = v;
      });
      for (const [name, p] of Object.entries(ep.params)) {
        if (p.positional) continue;
        const key = camelize(flagName(name, p));
        const v = options[key];
        if (v !== undefined) inputs[name] = v;
      }

      const variantFlags = new Set<string>(
        ep.variants.filter((v) => options[camelize(v.flag)] === true).map((v) => v.flag),
      );

      let view = defaultViewName(ep);
      for (const [viewName, spec] of Object.entries(ep.result.views ?? {})) {
        if (spec.flag && options[camelize(spec.flag)] === true) view = viewName;
      }

      const timeoutMs = Number(g.timeout);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw localError('VALIDATION', 'INVALID_TIMEOUT', `--timeout 需要正整数毫秒，收到 "${g.timeout}"`);
      }

      const transport = new Transport({ env: g.env, timeoutMs, debug: g.debug });
      const result = await execute({ endpoint: ep, transport, inputs, variantFlags, view });

      // 单次调用失败 = 普通错误（不是批量），走标准错误出口
      if (result.outcomes.length === 1 && !result.outcomes[0].ok) {
        emitError(result.outcomes[0].error!, mode.json);
      }

      const renderOpts: RenderOptions = {
        full: g.full,
        fields: g.fields ? splitMulti(g.fields) : null,
        json: mode.json,
        color: mode.color,
      };
      const env = buildEnvelope(ep, result.outcomes, result.metas, result.view, renderOpts);
      const text = mode.json ? renderJson(env) : renderTable(ep, env);
      process.stdout.write(`${text}\n`);
      process.exit(aggregateExitCode(result.outcomes));
    } catch (e) {
      if (e instanceof ZzError) emitError(e, mode.json);
      throw e;
    }
  });

  return cmd;
}

function camelize(flag: string): string {
  return flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function buildAuthCommand(): Command {
  const auth = new Command('auth').description('凭证与 token');
  auth
    .command('status')
    .description('检查凭证是否可用、当前 token 剩余时间')
    .action(async (_opts: unknown, command: Command) => {
      const g = command.optsWithGlobals() as unknown as GlobalOpts;
      const mode = resolveOutputMode(g);
      try {
        const timeoutMs = Number(g.timeout);
        const t = await getToken({ env: g.env, timeoutMs });
        const payload = {
          ok: true,
          env: g.env,
          credentialSource: t.credentialSource,
          tokenCache: t.cacheFile,
          fromCache: t.fromCache,
          issuedAt: new Date(t.issuedAt * 1000).toISOString(),
          expiresAt: new Date(t.exp * 1000).toISOString(),
          remainingSec: t.remainingSec,
        };
        if (mode.json) {
          process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        } else {
          process.stdout.write(
            `✓ token 有效，剩余 ${Math.floor(t.remainingSec / 60)} 分 ${t.remainingSec % 60} 秒\n` +
              `  环境      ${g.env}\n` +
              `  凭证来源  ${t.credentialSource}\n` +
              `  缓存文件  ${t.cacheFile}${t.fromCache ? '（命中共享缓存）' : '（本次新换取）'}\n` +
              `  过期时刻  ${new Date(t.exp * 1000).toLocaleString()}\n`,
          );
        }
        process.exit(EXIT.OK);
      } catch (e) {
        if (e instanceof ZzError) emitError(e, mode.json);
        throw e;
      }
    });
  return auth;
}

/**
 * `ref` 命令组：码表的刷新与状态。手写而非 registry——
 * 它做的是版本比对 + 下载 + 落盘，不是「调接口拿一组记录」，
 * 塞进 registry 只会把 schema 撑成通用编程语言。
 */
function buildRefCommand(): Command {
  const ref = new Command('ref').description('地区 / 分类码表');

  ref
    .command('sync')
    .description('从平台刷新码表到本地（version 未变则不下载）')
    .option('--check', '只比对版本，不下载', false)
    .action(async (opts: { check: boolean }, command: Command) => {
      const g = command.optsWithGlobals() as unknown as GlobalOpts;
      const mode = resolveOutputMode(g);
      try {
        const timeoutMs = Number(g.timeout);
        const transport = new Transport({ env: g.env, timeoutMs, debug: g.debug });
        const items = await refSync({ transport, timeoutMs, check: opts.check });
        emitRefItems(items, mode.json, opts.check);
      } catch (e) {
        if (e instanceof ZzError) emitError(e, mode.json);
        throw e;
      }
    });

  ref
    .command('status')
    .description('看两张码表当前从哪来、什么版本')
    .action(async (_o: unknown, command: Command) => {
      const g = command.optsWithGlobals() as unknown as GlobalOpts;
      emitRefItems(refStatus(), resolveOutputMode(g).json, false);
    });

  return ref;
}

function emitRefItems(items: SyncItem[], json: boolean, check: boolean): never {
  if (json) {
    process.stdout.write(`${JSON.stringify({ items, count: items.length }, null, 2)}\n`);
  } else {
    for (const i of items) {
      if (!i.ok) {
        const e = i.error as any;
        process.stdout.write(`✗ ${i.table}: ${e?.code} ${e?.message}\n`);
        if (e?.hint) process.stdout.write(`    → ${e.hint}\n`);
        continue;
      }
      if (i.status === 'current') {
        process.stdout.write(
          `  ${i.table}: ${i.to ? `version ${i.to} ` : ''}[${i.origin}]\n    ${i.path}\n`,
        );
      } else if (i.status === 'unchanged') {
        process.stdout.write(
          `✓ ${i.table}: already up to date, no changes` +
            `${i.to ? ` (version ${i.to})` : ''}${i.origin ? ` [${i.origin}]` : ''}\n`,
        );
      } else if (i.status === 'available') {
        process.stdout.write(`↑ ${i.table}: 有新版本可用 ${i.from ?? '—'} → ${i.to ?? '—'}（--check 未下载）\n`);
      } else {
        process.stdout.write(
          `↓ ${i.table}: 已更新 ${i.from ?? '—'} → ${i.to ?? '—'}` +
            `${i.rows ? `，${i.rows} 条` : ''}\n    ${i.path}\n`,
        );
      }
    }
  }
  const failed = items.filter((i) => !i.ok);
  process.exit(
    failed.length === 0 ? EXIT.OK : failed.length < items.length ? EXIT.PARTIAL : EXIT.GENERIC,
  );
}

function main(): void {
  const program = new Command('zzapi')
    .version(VERSION)
    .description('中资（cneptp）寻源询价 OpenAPI 命令行客户端')
    .option('--json', '强制 JSON 输出（非 TTY 时自动开启）', false)
    .option('--full', '无损输出：原样吐出接口全部原始字段', false)
    .option('--fields <字段>', '逗号分隔的字段白名单（坐标字段始终保留）')
    .option('--quiet', '只输出数据（非 TTY 时自动开启）', false)
    .addOption(
      new Option('--env <环境>', '目标环境').choices(['prod', 'dev']).default('prod'),
    )
    .option('--timeout <毫秒>', '单次请求超时', '20000')
    .option('--debug', '把请求与原始响应打到 stderr', false)
    .option('--no-color', '禁用颜色')
    .option('--no-interactive', '禁用交互（v1 本就无交互，非 TTY 时自动开启）')
    .showHelpAfterError();

  let endpoints: Endpoint[];
  try {
    endpoints = loadRegistry();
  } catch (e) {
    process.stderr.write(`✗ REGISTRY_INVALID: ${(e as Error).message}\n`);
    process.exit(EXIT.GENERIC);
  }

  const nouns = new Map<string, Command>();
  for (const ep of endpoints) {
    let group = nouns.get(ep.noun);
    if (!group) {
      group = new Command(ep.noun).description(`${ep.noun} 相关命令`);
      nouns.set(ep.noun, group);
      program.addCommand(group);
    }
    group.addCommand(buildEndpointCommand(ep));
  }

  // 手写命令组：若 registry 里已有同名 noun，就把子命令挂进那个组，不另起一个
  for (const built of [buildRefCommand(), buildAuthCommand()]) {
    const existing = nouns.get(built.name());
    if (existing) {
      for (const sub of built.commands) existing.addCommand(sub);
    } else {
      program.addCommand(built);
    }
  }

  program.parseAsync(process.argv).catch((e) => {
    if (e instanceof ZzError) {
      emitError(e, !process.stdout.isTTY);
    }
    process.stderr.write(`✗ INTERNAL_ERROR: ${(e as Error)?.stack ?? String(e)}\n`);
    process.exit(EXIT.GENERIC);
  });
}

main();
