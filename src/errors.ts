/**
 * 平台业务码 → 稳定符号 + 退出码 + hint 的映射表。
 *
 * 硬约束：平台内码不外泄。调用方只看到 `code` 符号与 `hint`，
 * hint 必须能让调用方自己走下一步。新增映射只改这张表，不改逻辑。
 */

export const EXIT = {
  OK: 0,
  GENERIC: 1,
  VALIDATION: 2,
  NOT_FOUND: 4,
  PARTIAL: 6,
  AUTH: 7,
  RATE_LIMIT: 8,
  NETWORK: 9,
} as const;

export interface ErrorShape {
  code: string;
  message: string;
  retryable: boolean;
  hint?: string;
}

interface Mapping {
  code: string;
  exit: number;
  retryable: boolean;
  hint?: string;
}

/** 平台码 → 映射。纯数据，新增一行即可支持新错误。 */
const PLATFORM_CODES: Record<string, Mapping> = {
  // —— 鉴权类 (exit 7) ——
  '1601003': {
    code: 'AUTH_TOKEN_MISSING',
    exit: EXIT.AUTH,
    retryable: false,
    hint: '传输层未附带 accessToken 头，属内部错误，请提 issue',
  },
  '1601007': {
    // 正常情况下由传输层自动换 token 重试一次，不外露；连续两次才会到这里
    code: 'AUTH_TOKEN_EXPIRED',
    exit: EXIT.AUTH,
    retryable: true,
    hint: '换取新 token 后仍被拒；用 zzapi auth status 检查凭证，或删除 ~/.cache/zzapi/ 后重试',
  },
  '1601008': {
    code: 'AUTH_API_FORBIDDEN',
    exit: EXIT.AUTH,
    retryable: false,
    hint: '该 appKey 未开通此接口；联系平台开通，或确认接口路径正确',
  },
  '1601022': {
    code: 'AUTH_APPKEY_REJECTED',
    exit: EXIT.AUTH,
    retryable: false,
    hint: '业务接口不接受 appKey 直连，必须用 accessToken；属内部错误，请提 issue',
  },

  // —— 参数校验类 (exit 2) ——
  '1601004': {
    code: 'INVALID_VERSION',
    exit: EXIT.VALIDATION,
    retryable: false,
    hint: '缺少 ver 参数，属内部错误，请提 issue',
  },
  '1205001': {
    code: 'KEYWORD_REQUIRED',
    exit: EXIT.VALIDATION,
    retryable: false,
    hint: '关键词不能为空：zzapi goods search <关键词>',
  },
  '1205003': {
    code: 'GOODS_CODE_REQUIRED',
    exit: EXIT.VALIDATION,
    retryable: false,
    hint: '商品编码不能为空；用 zzapi goods search <关键词> 获取 goodsCode',
  },

  // —— 未找到 (exit 4) ——
  '1205004': {
    code: 'GOODS_NOT_FOUND',
    exit: EXIT.NOT_FOUND,
    retryable: false,
    hint: '用 zzapi goods search <关键词> 获取有效的 goodsCode',
  },
};

/** 本地（非平台）错误类别 → 退出码。 */
const LOCAL_CLASSES: Record<string, number> = {
  VALIDATION: EXIT.VALIDATION,
  NOT_FOUND: EXIT.NOT_FOUND,
  AUTH: EXIT.AUTH,
  RATE_LIMIT: EXIT.RATE_LIMIT,
  NETWORK: EXIT.NETWORK,
  GENERIC: EXIT.GENERIC,
};

export class ZzError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly retryable: boolean;
  readonly hint?: string;
  /** 原始平台码，仅用于 --debug，不进入正常输出 */
  readonly platformCode?: string;

  constructor(opts: {
    code: string;
    message: string;
    exitCode: number;
    retryable?: boolean;
    hint?: string;
    platformCode?: string;
  }) {
    super(opts.message);
    this.name = 'ZzError';
    this.code = opts.code;
    this.exitCode = opts.exitCode;
    this.retryable = opts.retryable ?? false;
    this.hint = opts.hint;
    this.platformCode = opts.platformCode;
  }

  toShape(): ErrorShape {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.hint ? { hint: this.hint } : {}),
    };
  }
}

/** 构造本地错误（参数校验、网络等，无平台码）。 */
export function localError(
  cls: keyof typeof LOCAL_CLASSES,
  code: string,
  message: string,
  hint?: string,
  retryable = false,
): ZzError {
  return new ZzError({ code, message, exitCode: LOCAL_CLASSES[cls], retryable, hint });
}

/** 平台业务码 → ZzError。未知码归入 GENERIC(1)，消息透传但不泄露内码。 */
export function fromPlatformCode(platformCode: number | string, msg: string): ZzError {
  const key = String(platformCode);
  const m = PLATFORM_CODES[key];
  if (m) {
    return new ZzError({
      code: m.code,
      message: msg,
      exitCode: m.exit,
      retryable: m.retryable,
      hint: m.hint,
      platformCode: key,
    });
  }
  return new ZzError({
    code: 'PLATFORM_ERROR',
    message: msg || '平台返回未知错误',
    exitCode: EXIT.GENERIC,
    retryable: false,
    hint: '该平台错误尚未收录进 errors.ts 映射表，请带上 --debug 输出提 issue',
    platformCode: key,
  });
}

/** 该平台码是否代表 token 过期（触发传输层自动换 token 重试一次）。 */
export function isTokenExpired(platformCode: number | string): boolean {
  return String(platformCode) === '1601007';
}
