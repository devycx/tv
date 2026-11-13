import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { signSession } from './auth';
import { createSessionVerifier } from './session-webcrypto';

/**
 * 交叉验证：middleware 用的 WebCrypto 校验器必须与 auth.ts 的 Node 实现完全兼容，
 * 否则已登录用户升级后会被踢下线，或伪造 token 被放行。
 */

const PASSWORD = 'webcrypto-test-password-123';
const ORIGINAL = { PASSWORD: process.env.PASSWORD, PROXY_SECRET: process.env.PROXY_SECRET };

afterEach(() => {
  if (ORIGINAL.PASSWORD === undefined) delete process.env.PASSWORD;
  else process.env.PASSWORD = ORIGINAL.PASSWORD;
  if (ORIGINAL.PROXY_SECRET === undefined) delete process.env.PROXY_SECRET;
  else process.env.PROXY_SECRET = ORIGINAL.PROXY_SECRET;
});

function useEnv(env: { PASSWORD?: string; PROXY_SECRET?: string }) {
  delete process.env.PASSWORD;
  delete process.env.PROXY_SECRET;
  if (env.PASSWORD !== undefined) process.env.PASSWORD = env.PASSWORD;
  if (env.PROXY_SECRET !== undefined) process.env.PROXY_SECRET = env.PROXY_SECRET;
}

describe('createSessionVerifier（与 auth.ts 的签名兼容）', () => {
  it('接受 auth.ts 用 PASSWORD 派生密钥签发的会话', async () => {
    useEnv({ PASSWORD });
    const { token, expiresAt } = signSession();
    expect(expiresAt).toBeGreaterThan(Date.now());
    const verifier = createSessionVerifier({ password: PASSWORD });
    expect(await verifier.verify(token)).toBe(true);
  });

  it('接受 auth.ts 用 PROXY_SECRET 签发的会话', async () => {
    useEnv({ PASSWORD, PROXY_SECRET: 'proxy-secret-abc' });
    const { token } = signSession();
    const verifier = createSessionVerifier({ password: PASSWORD, proxySecret: 'proxy-secret-abc' });
    expect(await verifier.verify(token)).toBe(true);
  });

  it('拒绝换密码签发的会话（密钥派生含 PASSWORD）', async () => {
    useEnv({ PASSWORD });
    const { token } = signSession();
    const other = createSessionVerifier({ password: 'another-password' });
    expect(await other.verify(token)).toBe(false);
  });

  it('拒绝篡改签名 / 大写签名（Node 实现同样拒绝）', async () => {
    useEnv({ PASSWORD });
    const { token } = signSession();
    const verifier = createSessionVerifier({ password: PASSWORD });

    const dot = token.lastIndexOf('.');
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const flipped = `${sig.slice(0, -1)}${sig.endsWith('0') ? '1' : '0'}`;
    expect(await verifier.verify(`${payload}.${flipped}`)).toBe(false);
    expect(await verifier.verify(`${payload}.${sig.toUpperCase()}`)).toBe(false);
  });

  it('拒绝过期会话', async () => {
    useEnv({ PASSWORD });
    const secret = crypto.createHash('sha256').update(`${PASSWORD}:libretv::session-salt`).digest('hex');
    const expiredPayload = String(Date.now() - 1000);
    const sig = crypto.createHmac('sha256', secret).update(expiredPayload).digest('hex');
    const verifier = createSessionVerifier({ password: PASSWORD });
    expect(await verifier.verify(`${expiredPayload}.${sig}`)).toBe(false);
  });

  it('格式非法 / 缺失的 token 一律拒绝', async () => {
    const verifier = createSessionVerifier({ password: PASSWORD });
    expect(await verifier.verify(null)).toBe(false);
    expect(await verifier.verify(undefined)).toBe(false);
    expect(await verifier.verify('')).toBe(false);
    expect(await verifier.verify('no-dot-token')).toBe(false);
    expect(await verifier.verify('.sig')).toBe(false);
    expect(await verifier.verify('123.abc')).toBe(false);
  });
});
