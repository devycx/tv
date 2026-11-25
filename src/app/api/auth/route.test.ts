import { beforeAll, describe, expect, it } from 'vitest';
import { POST } from './route';
import { SESSION_COOKIE, signSession, sessionFromCookieHeader } from '@/lib/auth';

/**
 * /api/auth 登录接口单测：邮箱白名单通道与密码通道的分发。
 * 邮箱命中 GATE_EMAILS 时免密码直接签发与密码通道同一套的 ltv_session。
 */

beforeAll(() => {
  process.env.PASSWORD = 'test-password';
  process.env.GATE_EMAILS = 'test@ycxdev.com';
  process.env.COOKIE_SECURE = 'false';
});

function post(body: unknown): Request {
  return new Request('https://local.test/api/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.7' },
    body: JSON.stringify(body),
  });
}

async function readJson(res: Response): Promise<{ success?: boolean; error?: string }> {
  return (await res.json()) as { success?: boolean; error?: string };
}

describe('POST /api/auth · 邮箱通道', () => {
  it('命中 GATE_EMAILS：免密码签发会话 cookie', async () => {
    const res = await POST(post({ email: 'Test@Ycxdev.com' }));
    expect(res.status).toBe(200);
    const data = await readJson(res);
    expect(data.success).toBe(true);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(SESSION_COOKIE);
    const token = setCookie.split(';')[0].split('=')[1];
    expect(sessionFromCookieHeader(`${SESSION_COOKIE}=${token}`)).toBe(true);
  });

  it('不在名单的邮箱 401，不下发会话', async () => {
    const res = await POST(post({ email: 'nope@ycxdev.com' }));
    expect(res.status).toBe(401);
    expect((await readJson(res)).error).toBe('该邮箱无权访问');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('email 为空字符串时回退密码通道（空密码 401）', async () => {
    const res = await POST(post({ email: '' }));
    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth · 密码通道', () => {
  it('正确密码签发会话；错误密码 401', async () => {
    const ok = await POST(post({ password: 'test-password' }));
    expect(ok.status).toBe(200);

    const bad = await POST(post({ password: 'wrong' }));
    expect(bad.status).toBe(401);
    // 密码错误文案保持原样
    expect((await readJson(bad)).error).toBe('密码错误');
  });

  it('邮箱通道签发的会话与密码通道互通（同一签名密钥）', async () => {
    const viaEmail = await POST(post({ email: 'test@ycxdev.com' }));
    const viaPassword = await POST(post({ password: 'test-password' }));
    const t1 = (viaEmail.headers.get('set-cookie') ?? '').split(';')[0].split('=').slice(1).join('=');
    const t2 = (viaPassword.headers.get('set-cookie') ?? '').split(';')[0].split('=').slice(1).join('=');
    // signSession 的有效期是毫秒级时间戳，两次签发几乎必然不同值，但都必须能被同一校验器接受
    expect(signSession()).toBeTruthy();
    expect(sessionFromCookieHeader(`${SESSION_COOKIE}=${t1}`)).toBe(true);
    expect(sessionFromCookieHeader(`${SESSION_COOKIE}=${t2}`)).toBe(true);
  });
});
