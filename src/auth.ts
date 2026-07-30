/**
 * token 获取与 **跨进程共享缓存**。
 *
 * 易踩：平台限制同时最多 2 个有效 token。若做成进程内缓存，
 * 并行跑多个 zzapi 会互相顶掉，表现为随机的 1601007，极难排查。
 * 因此缓存必须是 ~/.cache/zzapi/token-*.json + proper-lockfile 文件锁，
 * 所有进程共用一个 token 并共同续期。
 *
 * 锁内二次检查（double-check）是正确性的关键：拿到锁后重读缓存，
 * 若别的进程已经续过期了就直接用，不再多换一个 token。
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { baseUrl, cacheDir, loadCredentials, type Credentials, type Env } from './config.js';
import { localError, ZzError } from './errors.js';

/** 剩余寿命低于此值即视为过期，提前续期避免请求途中失效。 */
const EXPIRY_SKEW_SEC = 120;

export interface CachedToken {
  accessToken: string;
  /** 过期时刻，epoch 秒 */
  exp: number;
  /** 获取时刻，epoch 秒 */
  issuedAt: number;
}

export interface TokenStatus extends CachedToken {
  remainingSec: number;
  cacheFile: string;
  fromCache: boolean;
  credentialSource: string;
}

function fingerprint(appKey: string): string {
  return createHash('sha256').update(appKey).digest('hex').slice(0, 12);
}

function tokenFile(env: Env, appKey: string): string {
  return join(cacheDir(), `token-${env}-${fingerprint(appKey)}.json`);
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** 本地解码 JWT payload 拿 exp，失败返回 null（不校验签名，只读过期时间）。 */
function decodeJwtExp(token: string): number | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

function isFresh(t: CachedToken | null): t is CachedToken {
  return !!t && t.exp - nowSec() > EXPIRY_SKEW_SEC;
}

function readCache(file: string): CachedToken | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof raw?.accessToken === 'string' && typeof raw?.exp === 'number') return raw;
  } catch {
    /* 缺失或损坏都按无缓存处理 */
  }
  return null;
}

function writeCache(file: string, token: CachedToken): void {
  // 原子写：tmp + rename，避免别的进程读到半个文件
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(token), { mode: 0o600 });
  renameSync(tmp, file);
}

/** 向平台换取新 token。文档没给这个接口，是探测出来的。 */
async function fetchToken(env: Env, cred: Credentials, timeoutMs: number): Promise<CachedToken> {
  const url = `${baseUrl(env)}/openapi/token`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appKey: cred.appKey, appSecret: cred.appSecret }),
      signal: ac.signal,
    });
  } catch (e) {
    const aborted = (e as Error)?.name === 'AbortError';
    throw localError(
      'NETWORK',
      aborted ? 'TIMEOUT' : 'NETWORK_ERROR',
      aborted ? `换取 token 超时（${timeoutMs}ms）` : `换取 token 失败：${(e as Error).message}`,
      '检查网络连通性与 base URL；稍后重试',
      true,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw localError(
      'NETWORK',
      'BAD_RESPONSE',
      `token 接口返回非 JSON（HTTP ${res.status}）`,
      '平台可能在维护；稍后重试',
      true,
    );
  }

  if (body?.code !== 200 || !body?.data?.accessToken) {
    throw new ZzError({
      code: 'AUTH_FAILED',
      message: body?.msg || '换取 token 失败',
      exitCode: 7,
      retryable: false,
      hint: 'appKey / appSecret 可能不正确或已被停用；检查 ZZAPI_APP_KEY 与 ZZAPI_APP_SECRET',
      platformCode: body?.code != null ? String(body.code) : undefined,
    });
  }

  const accessToken: string = body.data.accessToken;
  const issuedAt = nowSec();
  const expire = Number(body.data.expire);
  const exp =
    decodeJwtExp(accessToken) ?? issuedAt + (Number.isFinite(expire) ? expire : 7200);
  return { accessToken, exp, issuedAt };
}

export interface GetTokenOptions {
  env: Env;
  timeoutMs: number;
  /** 传入已失效的 token：只有当缓存仍是这一个时才强制续期（别的进程可能已经换过了）。 */
  invalidate?: string;
}

/**
 * 取一个有效 token。跨进程共享：
 *   1. 无锁快路径 —— 缓存新鲜就直接用（绝大多数调用走这里，零开销）
 *   2. 需要续期才加文件锁，锁内重读缓存二次确认，确认无效才向平台换
 */
export async function getToken(opts: GetTokenOptions): Promise<TokenStatus> {
  const cred = loadCredentials(opts.env);
  const dir = cacheDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = tokenFile(opts.env, cred.appKey);

  const cached = readCache(file);
  const staleMatch = opts.invalidate && cached?.accessToken === opts.invalidate;
  if (isFresh(cached) && !staleMatch) {
    return {
      ...cached,
      remainingSec: cached.exp - nowSec(),
      cacheFile: file,
      fromCache: true,
      credentialSource: cred.source,
    };
  }

  // proper-lockfile 需要目标存在才能锁；用 realpath:false 允许锁不存在的路径
  if (!existsSync(file)) {
    try {
      writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
    } catch {
      /* 竞态下别的进程刚建好，忽略 */
    }
  }

  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(file, {
      realpath: false,
      stale: 15_000, // 持锁进程崩了，15s 后锁自动作废
      retries: { retries: 20, factor: 1.4, minTimeout: 50, maxTimeout: 1_000 },
    });
  } catch (e) {
    throw localError(
      'GENERIC',
      'TOKEN_LOCK_FAILED',
      `无法获取 token 缓存锁：${(e as Error).message}`,
      `若确认没有其他 zzapi 进程在跑，删除 ${file}.lock 后重试`,
      true,
    );
  }

  try {
    // 二次检查：等锁期间别的进程可能已经续好了
    const again = readCache(file);
    const stillStale = opts.invalidate && again?.accessToken === opts.invalidate;
    if (isFresh(again) && !stillStale) {
      return {
        ...again,
        remainingSec: again.exp - nowSec(),
        cacheFile: file,
        fromCache: true,
        credentialSource: cred.source,
      };
    }
    const fresh = await fetchToken(opts.env, cred, opts.timeoutMs);
    writeCache(file, fresh);
    return {
      ...fresh,
      remainingSec: fresh.exp - nowSec(),
      cacheFile: file,
      fromCache: false,
      credentialSource: cred.source,
    };
  } finally {
    await release().catch(() => {});
  }
}

/**
 * 本次调用会不会真的去平台换 token（即缓存里没有可用 token）。
 * 无副作用，只读缓存——用来决定要不要顺带刷一次码表。
 */
export function willMintToken(env: Env): boolean {
  try {
    const cred = loadCredentials(env);
    return !isFresh(readCache(tokenFile(env, cred.appKey)));
  } catch {
    // 连凭证都没有，轮不到刷码表
    return false;
  }
}
