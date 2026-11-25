import crypto from 'node:crypto';
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE, checkGateEmail, getGateEmails, checkPassword, checkRateLimit, clearRateLimit, sessionFromCookieHeader, signSession, verifySession } from './auth';

/**
 * 会话鉴权单测：HMAC 签名/校验、过期、防篡改、密码恒定时间比较、登录限流。
 * 纯函数 + 内存状态，不需要网络与 IndexedDB。
 */

const TEST_PASSWORD = 'test-password-123';

beforeAll(() => {
  process.env.PASSWORD = TEST_PASSWORD;
});

afterAll(() => {
  delete process.env.PASSWORD;
});

describe('signSession / verifySession', () => {
  it(' freshly 签发的会话 token 校验通过', () => {
    const { token, expiresAt } = signSession();
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(verifySession(token)).toBe(true);
  });

  it('过期会话被拒绝', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { token } = signSession();
    // 快进 91 天（TTL 90 天）
    vi.setSystemTime(new Date('2026-04-02T00:00:00Z'));
    expect(verifySession(token)).toBe(false);
    vi.useRealTimers();
  });

  it('篡改 payload（替换过期时间但沿用旧签名）被拒绝', () => {
    const { token } = signSession();
    const sig = token.slice(token.lastIndexOf('.') + 1);
    // 用与真实 TTL（90 天）不同的偏移构造新 payload，保证签名与 payload 不匹配
    const forged = `${String(Date.now() + 95 * 24 * 3600 * 1000)}.${sig}`;
    expect(verifySession(forged)).toBe(false);
  });

  it('用自算 HMAC 伪造签名也无法通过（密钥派生含盐）', () => {
    // 攻击者知道 PASSWORD 时最常见的伪造路径：按可猜想的派生方式构造签名
    const payload = String(Date.now() + 60_000);
    const naiveSecret = crypto.createHash('sha256').update(TEST_PASSWORD).digest('hex');
    const naive = crypto.createHmac('sha256', naiveSecret).update(payload).digest('hex');
    expect(verifySession(`${payload}.${naive}`)).toBe(false);
  });

  it('格式非法的 token 一律拒绝', () => {
    expect(verifySession(undefined)).toBe(false);
    expect(verifySession('')).toBe(false);
    expect(verifySession('no-dot-token')).toBe(false);
    expect(verifySession('.sig')).toBe(false);
    expect(verifySession('abc.not-hex-sig')).toBe(false);
  });
});

describe('checkPassword', () => {
  it('正确密码通过', () => {
    expect(checkPassword(TEST_PASSWORD)).toBe(true);
  });

  it('错误密码拒绝', () => {
    expect(checkPassword('wrong')).toBe(false);
    expect(checkPassword('')).toBe(false);
  });

  it('未配置 PASSWORD 时一律拒绝', () => {
    const saved = process.env.PASSWORD;
    delete process.env.PASSWORD;
    try {
      expect(checkPassword(TEST_PASSWORD)).toBe(false);
    } finally {
      process.env.PASSWORD = saved;
    }
  });
});

describe('sessionFromCookieHeader', () => {
  it('含有效会话的 Cookie 头通过', () => {
    const { token } = signSession();
    expect(sessionFromCookieHeader(`${SESSION_COOKIE}=${token}`)).toBe(true);
    expect(sessionFromCookieHeader(`other=1; ${SESSION_COOKIE}=${token}; x=2`)).toBe(true);
  });

  it('缺失 / 篡改 / 无关 Cookie 头拒绝', () => {
    const { token } = signSession();
    expect(sessionFromCookieHeader(null)).toBe(false);
    expect(sessionFromCookieHeader('')).toBe(false);
    expect(sessionFromCookieHeader(`other=1`)).toBe(false);
    expect(sessionFromCookieHeader(`${SESSION_COOKIE}=${token}x`)).toBe(false);
  });
});

describe('checkGateEmail（邮箱白名单通道）', () => {
  const saved = process.env.GATE_EMAILS;
  beforeAll(() => {
    process.env.GATE_EMAILS = 'Test@Ycxdev.com; friend@example.org ,other@x.io';
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.GATE_EMAILS;
    else process.env.GATE_EMAILS = saved;
  });

  it('命中白名单（大小写 / 首尾空白不敏感）', () => {
    expect(checkGateEmail('test@ycxdev.com')).toBe(true);
    expect(checkGateEmail('Test@Ycxdev.com')).toBe(true);
    expect(checkGateEmail('  TEST@YCXDEV.COM  ')).toBe(true);
    expect(checkGateEmail('friend@example.org')).toBe(true);
  });

  it('不在名单 / 空 / 伪造域拒绝', () => {
    expect(checkGateEmail('nope@ycxdev.com')).toBe(false);
    expect(checkGateEmail('test@ycxdev.com.evil.io')).toBe(false);
    expect(checkGateEmail('')).toBe(false);
    expect(checkGateEmail('   ')).toBe(false);
  });

  it('getGateEmails 归一化：拆分 + 小写 + 去空项', () => {
    expect(getGateEmails()).toEqual(['test@ycxdev.com', 'friend@example.org', 'other@x.io']);
  });

  it('未配置 GATE_EMAILS 时名单为空、一律拒绝', () => {
    const cur = process.env.GATE_EMAILS;
    delete process.env.GATE_EMAILS;
    try {
      expect(getGateEmails()).toEqual([]);
      expect(checkGateEmail('test@ycxdev.com')).toBe(false);
    } finally {
      process.env.GATE_EMAILS = cur;
    }
  });
});

describe('checkRateLimit', () => {
  afterEach(() => {
    clearRateLimit('1.2.3.4');
    clearRateLimit('5.6.7.8');
  });

  it('窗口内允许 MAX_ATTEMPTS 次后拒绝', () => {
    clearRateLimit('1.2.3.4');
    for (let i = 0; i < 10; i++) {
      expect(checkRateLimit('1.2.3.4')).toBe(true);
    }
    expect(checkRateLimit('1.2.3.4')).toBe(false);
  });

  it('不同 IP 互不影响', () => {
    expect(checkRateLimit('5.6.7.8')).toBe(true);
    // 耗尽 1.2.3.4 不影响 5.6.7.8
    for (let i = 0; i < 11; i++) checkRateLimit('1.2.3.4');
    expect(checkRateLimit('5.6.7.8')).toBe(true);
  });

  it('clearRateLimit 解除限制', () => {
    clearRateLimit('1.2.3.4');
    for (let i = 0; i < 11; i++) checkRateLimit('1.2.3.4');
    expect(checkRateLimit('1.2.3.4')).toBe(false);
    clearRateLimit('1.2.3.4');
    expect(checkRateLimit('1.2.3.4')).toBe(true);
  });
});
