import { NextResponse } from 'next/server';
import { SESSION_COOKIE, checkRateLimit, checkGateEmail, sessionFromCookieHeader, signSession, checkPassword, clearRateLimit, isPasswordConfigured } from '@/lib/auth';

export const runtime = 'nodejs';

/**
 * 会话 Cookie 的 Secure 策略：COOKIE_SECURE 环境变量显式覆盖；否则按 x-forwarded-proto 推导。
 * 不能依赖 req.url——Next.js Route Handler 中它是内部转发地址，并非用户侧的原始协议。
 */
function isSecureRequest(req: Request): boolean {
  if (process.env.COOKIE_SECURE === 'true') return true;
  if (process.env.COOKIE_SECURE === 'false') return false;
  return (req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ?? 'http') === 'https';
}

/**
 * 登录限流的客户端标识（部署矩阵见 DEPLOY-CLOUDFLARE.md）：
 * - Cloudflare Workers（本项目默认）：`gen-wrangler.mjs` 在 wrangler vars 里写入 TRUST_CF_IP=1，
 *   此时取 `cf-connecting-ip`——该头由 Cloudflare 边缘覆写，客户端伪造无效。漏配时所有请求会
 *   共用 'unknown' 这一个桶，10 次失败即锁死全站登录 10 分钟。
 * - Node / Docker + 可信反代：不设 TRUST_CF_IP，不信任客户端可伪造的 `cf-connecting-ip`，
 *   改用反代覆写的 `x-real-ip` / `x-forwarded-for` 首段。
 * - 直连公网（无反代）：Web 标准 Request 没有 socket remoteAddress，只能退化为 'unknown'，
 *   建议前置可信反代或 Cloudflare。
 */
function getClientIp(req: Request): string {
  if (process.env.TRUST_CF_IP === '1') {
    const cfIp = req.headers.get('cf-connecting-ip')?.trim();
    if (cfIp) return cfIp;
  }
  return req.headers.get('x-real-ip')?.trim() || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

export async function POST(req: Request) {
  if (!isPasswordConfigured()) {
    return NextResponse.json(
      { success: false, error: '服务器未设置 PASSWORD 环境变量，请联系管理员配置' },
      { status: 503 }
    );
  }

  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) {
    return NextResponse.json(
      { success: false, error: '尝试次数过多，请 10 分钟后再试' },
      { status: 429 }
    );
  }

  let body: { password?: string; email?: string } = {};
  try {
    body = (await req.json()) as { password?: string; email?: string };
  } catch {
    return NextResponse.json({ success: false, error: '请求格式错误' }, { status: 400 });
  }

  // 邮箱白名单通道：命中 GATE_EMAILS 直接签发会话（无验证码、不校验密码）。
  // 会话与密码通道完全同一套（ltv_session / signSession），middleware 无感知。
  const email = String(body.email ?? '').trim();
  if (email) {
    if (!checkGateEmail(email)) {
      return NextResponse.json({ success: false, error: '该邮箱无权访问' }, { status: 401 });
    }
    clearRateLimit(ip);
    const { token, expiresAt } = signSession();
    const res = NextResponse.json({ success: true });
    res.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isSecureRequest(req),
      maxAge: Math.floor((expiresAt - Date.now()) / 1000),
      path: '/',
    });
    return res;
  }

  const password = String(body.password ?? '');

  if (!checkPassword(password)) {
    return NextResponse.json({ success: false, error: '密码错误' }, { status: 401 });
  }

  clearRateLimit(ip);
  const { token, expiresAt } = signSession();
  const res = NextResponse.json({ success: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(req),
    maxAge: Math.floor((expiresAt - Date.now()) / 1000),
    path: '/',
  });
  return res;
}

/** GET：查询当前会话状态 */
export async function GET(req: Request) {
  const verified = sessionFromCookieHeader(req.headers.get('cookie'));
  return NextResponse.json({ success: true, verified });
}

/** DELETE：登出（Cookie 属性必须与签发时一致，否则浏览器不会覆盖/清除原 cookie） */
export async function DELETE(req: Request) {
  const res = NextResponse.json({ success: true });
  res.cookies.set(SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(req),
    maxAge: 0,
    path: '/',
  });
  return res;
}
