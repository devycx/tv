/**
 * 会话 token 的 WebCrypto 校验（middleware 专用）。
 *
 * Next.js middleware 运行在 Edge Runtime，**不能** `import 'node:crypto'`，
 * 因此这里用 `crypto.subtle` 重新实现 `src/lib/auth.ts` 的签名算法。
 * 两边必须逐字节一致，否则升级后所有已登录会话都会失效：
 *
 *   密钥  = PROXY_SECRET || sha256hex(PASSWORD + ':libretv::session-salt')
 *   token = `${expiresAtMs}.${hmac_sha256_hex(密钥, String(expiresAtMs))}`
 *
 * 兼容性由 `session-webcrypto.test.ts` 与 Node 实现（auth.ts 的 signSession）交叉验证。
 */

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/** 与 Node 的 `createHash('sha256').update(input).digest('hex')` 等价（UTF-8 输入、小写 hex） */
export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(input)));
}

/** 恒定时间比较两个字符串（此处的候选值都是定长 hex），避免逐字节比较泄漏时序 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export interface SessionVerifier {
  /** 校验 `<expiresAtMs>.<hmac>` 会话 token；null / 空 / 格式非法 / 过期一律返回 false */
  verify(token: string | null | undefined): Promise<boolean>;
}

/**
 * 按 auth.ts 的规则创建校验器：密钥只派生 / 导入一次，由调用方按 isolate 缓存实例。
 * 未配置 PASSWORD 时请勿创建（没有可校验的凭证）。
 */
export function createSessionVerifier(options: { password: string; proxySecret?: string }): SessionVerifier {
  const { password } = options;
  const proxySecret = options.proxySecret || '';
  let keyPromise: Promise<CryptoKey> | null = null;

  const getKey = (): Promise<CryptoKey> => {
    if (!keyPromise) {
      keyPromise = (async () => {
        // auth.ts: process.env.PROXY_SECRET 优先（空串视为未配置），否则 sha256(PASSWORD + 固定盐)
        const secret = proxySecret || (await sha256Hex(`${password}:libretv::session-salt`));
        return crypto.subtle.importKey(
          'raw',
          encoder.encode(secret),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign']
        );
      })();
    }
    return keyPromise;
  };

  return {
    async verify(token) {
      if (!token) return false;
      // auth.ts 用最后一个 '.' 切分（payload 里不会有 .，但保持一致）
      const dot = token.lastIndexOf('.');
      if (dot <= 0) return false;
      const payload = token.slice(0, dot);
      const signature = token.slice(dot + 1);
      // 签发的 payload 一定是纯数字毫秒时间戳；签名一定是 32 字节 = 64 位小写 hex
      if (!/^\d+$/.test(payload) || signature.length !== 64) return false;

      const key = await getKey();
      const expected = toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
      // 与 auth.ts 的 timingSafeEqual 语义一致：逐字节全等，不接受大小写变体
      if (!constantTimeEqual(signature, expected)) return false;

      const expiresAt = Number(payload);
      return Number.isFinite(expiresAt) && Date.now() < expiresAt;
    },
  };
}
