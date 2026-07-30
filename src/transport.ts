/**
 * HTTP 传输层：fetch 封装、ver 注入、accessToken 头、token 过期自动重试、
 * 业务码 → 结构化错误。
 *
 * 平台特性：HTTP 状态码恒为 200，成败藏在 body 的 code 里。
 * 这一层的存在就是为了把这件事变成脚本可判的退出码。
 */

import { getToken } from './auth.js';
import { baseUrl, type Env } from './config.js';
import { fromPlatformCode, isTokenExpired, localError, ZzError } from './errors.js';

/**
 * ver 由传输层注入，不暴露给用户。写 "1.0"/"v1" 会报 1601008。
 * 绝大多数接口是 1；个别接口（如行政处罚 v2）要 2，由 registry 声明后覆盖。
 */
const DEFAULT_API_VER = 1;

export interface TransportOptions {
  env: Env;
  timeoutMs: number;
  debug: boolean;
}

export class Transport {
  constructor(private readonly opts: TransportOptions) {}

  /**
   * 调一个业务接口，返回**完整响应体**（含 code/msg/data）。失败一律抛 ZzError。
   * 返回整个 body 而非 body.data，是为了让 registry 里的路径就是 `data.goodsList`
   * 这样的字面路径——声明看得见全貌，不依赖传输层偷偷剥了一层。
   */
  async call(path: string, params: Record<string, unknown>, ver?: number): Promise<unknown> {
    const token = await getToken({ env: this.opts.env, timeoutMs: this.opts.timeoutMs });
    const body = { ...params, ver: ver ?? DEFAULT_API_VER };

    let res = await this.post(path, body, token.accessToken);
    if (res.code != null && isTokenExpired(res.code)) {
      // 自动换 token 重试一次；invalidate 保证只顶掉这个失效 token，
      // 若别的进程已经换过新的就直接复用它的
      const refreshed = await getToken({
        env: this.opts.env,
        timeoutMs: this.opts.timeoutMs,
        invalidate: token.accessToken,
      });
      res = await this.post(path, body, refreshed.accessToken);
    }

    if (res.code !== 200) {
      throw fromPlatformCode(res.code, res.msg ?? '');
    }
    return res;
  }

  private async post(
    path: string,
    body: Record<string, unknown>,
    accessToken: string,
  ): Promise<{ code: number; msg?: string; data?: unknown }> {
    const url = `${baseUrl(this.opts.env)}${path}`;
    if (this.opts.debug) {
      process.stderr.write(`[zzapi] POST ${url} ${JSON.stringify(body)}\n`);
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.opts.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', accessToken },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } catch (e) {
      const aborted = (e as Error)?.name === 'AbortError';
      throw localError(
        'NETWORK',
        aborted ? 'TIMEOUT' : 'NETWORK_ERROR',
        aborted
          ? `请求超时（${this.opts.timeoutMs}ms）：${path}`
          : `网络错误：${(e as Error).message}`,
        '检查网络连通性；用 --timeout 调大超时后重试',
        true,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    if (this.opts.debug) {
      process.stderr.write(`[zzapi] HTTP ${res.status} ${text.slice(0, 2000)}\n`);
    }

    if (res.status >= 500) {
      throw localError(
        'NETWORK',
        'SERVER_ERROR',
        `平台返回 HTTP ${res.status}`,
        '平台侧故障，稍后重试',
        true,
      );
    }
    if (res.status === 429) {
      throw localError('RATE_LIMIT', 'RATE_LIMITED', '触发平台限流', '降低并发或稍后重试', true);
    }

    try {
      const parsed = JSON.parse(text);
      if (typeof parsed?.code !== 'number') {
        throw new Error('missing code');
      }
      return parsed;
    } catch {
      if (res.status !== 200) {
        throw localError(
          'NETWORK',
          'HTTP_ERROR',
          `平台返回 HTTP ${res.status}`,
          '检查接口路径与网络代理设置',
          false,
        );
      }
      throw localError(
        'NETWORK',
        'BAD_RESPONSE',
        '平台返回了无法解析的响应体',
        '带 --debug 重跑可看到原始响应',
        true,
      );
    }
  }
}

export { ZzError };
