/**
 * 凭证与环境配置。
 *
 * 硬约束：凭证只从环境变量或 ~/.config/zzapi/config.toml 读取，
 * 绝不接受命令行 flag（会进 shell history 和 ps）。
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { localError } from './errors.js';

export type Env = 'prod' | 'dev';

const BASE_URLS: Record<Env, string> = {
  prod: 'https://zapi.cneptp.com',
  dev: 'https://dev-zapi.cneptp.com',
};

export interface Credentials {
  appKey: string;
  appSecret: string;
  source: string;
}

export function baseUrl(env: Env): string {
  return BASE_URLS[env];
}

export function configPath(): string {
  return join(homedir(), '.config', 'zzapi', 'config.toml');
}

export function cacheDir(): string {
  return join(homedir(), '.cache', 'zzapi');
}

/**
 * 极简 TOML 子集解析器：`[section]`、`key = "value"`、`#` 注释。
 * 配置文件只有几个键，不值得为此引入第五个依赖。
 */
function parseToml(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = { '': {} };
  let section = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) {
      section = sec[1].trim();
      out[section] ??= {};
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    // 去掉行尾注释（仅当值不是引号包裹时）
    if (!/^["']/.test(value)) value = value.split('#')[0].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[section][kv[1]] = value;
  }
  return out;
}

/**
 * 凭证解析优先级：
 *   1. 环境变量 ZZAPI_APP_KEY / ZZAPI_APP_SECRET
 *   2. ~/.config/zzapi/config.toml 的 [<env>] 段
 *   3. ~/.config/zzapi/config.toml 的顶层
 */
export function loadCredentials(env: Env): Credentials {
  const envKey = process.env.ZZAPI_APP_KEY?.trim();
  const envSecret = process.env.ZZAPI_APP_SECRET?.trim();
  if (envKey && envSecret) {
    return { appKey: envKey, appSecret: envSecret, source: 'env' };
  }

  const path = configPath();
  if (existsSync(path)) {
    const toml = parseToml(readFileSync(path, 'utf8'));
    const scoped = toml[env] ?? {};
    const top = toml[''] ?? {};
    const appKey = scoped.app_key ?? scoped.appKey ?? top.app_key ?? top.appKey;
    const appSecret = scoped.app_secret ?? scoped.appSecret ?? top.app_secret ?? top.appSecret;
    if (appKey && appSecret) {
      return { appKey, appSecret, source: `${path}${toml[env] ? ` [${env}]` : ''}` };
    }
  }

  throw localError(
    'AUTH',
    'CREDENTIALS_MISSING',
    '未找到 appKey / appSecret',
    `设置环境变量 ZZAPI_APP_KEY 与 ZZAPI_APP_SECRET，或写入 ${path}：\n` +
      '  app_key = "..."\n  app_secret = "..."\n' +
      '（凭证不接受命令行参数，避免进入 shell history 和 ps）',
  );
}
