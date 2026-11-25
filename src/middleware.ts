import { NextResponse, type NextRequest } from 'next/server';
import { createSessionVerifier, type SessionVerifier } from '@/lib/session-webcrypto';
import { safeNextPath } from '@/lib/safe-next';

/**
 * 服务端访问门禁：未认证时任何页面都不下发。
 *
 * 之前的密码校验只发生在客户端（AuthProvider 的 LoginModal），页面 HTML 照常返回，
 * 直接打开 /、/live、/watch 仍能看到并操作 UI。middleware 在 Next 渲染之前拦一道：
 *
 * - 已认证：放行（/login 则回跳 next 或首页）；
 * - 未认证的 `/api/*`：401 JSON（与 src/lib/api-guard.ts 一致，不用 302，避免 fetch 跟到 HTML）；
 * - 未认证的页面 GET/HEAD（含 RSC 导航）：302 到 `/login?next=<原始路径+query>`。
 *
 * 会话算法与 `src/lib/auth.ts` 完全一致，但这里只能用 WebCrypto（Edge Runtime 没有 node:crypto）。
 * OpenNext 在请求进入 middleware 之前已把 Worker 的 vars / secrets 写进 `process.env`
 * （见 @opennextjs/cloudflare 的 cloudflare/init.js），所以这里能读到 PASSWORD。
 */

const SESSION_COOKIE = 'ltv_session';

/** 匿名可访问：登录页、登录/登出接口、站点状态（页面首屏已改用内联 bootstrap，仅外部脚本仍用 /api/status） */
const PUBLIC_PATHS = ['/login', '/api/auth', '/api/status'];

/**
 * 静态资源：Cloudflare Workers Assets 对真实存在的文件会在 Worker 之前直接出，
 * 正常到不了这里；matcher 也把它们排除了。这里再兜一层，避免 next dev 或意外路径
 * 被 302 成 HTML 导致页面白屏。
 */
const STATIC_PREFIXES = ['/_next/', '/icons/'];
const STATIC_EXACT = new Set(['/favicon.ico', '/manifest.webmanifest', '/robots.txt']);
const STATIC_EXTENSION =
  /\.(?:svg|png|jpe?g|gif|webp|avif|ico|css|js|mjs|map|txt|xml|woff2?|ttf|otf|eot|mp4|webm|m3u8)$/i;

/** 前缀匹配要带边界：`/login` 不应命中 `/login-something` */
function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((prefix) => matchesPrefix(pathname, prefix));
}

function isStaticPath(pathname: string): boolean {
  // /api/* 一律走鉴权：代理/直播流的路由路径里可能带 .js、.m3u8 之类的后缀，
  // 不能因为「看起来像静态文件」就放行（路由自身还有 guard，这里是第一道）
  if (matchesPrefix(pathname, '/api')) return false;
  if (STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;
  if (STATIC_EXACT.has(pathname)) return true;
  return STATIC_EXTENSION.test(pathname);
}

/** 与 auth.ts 的 sessionFromCookieHeader 相同的解析规则（含 decodeURIComponent 兜底） */
function readSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const raw = part.slice(eq + 1).trim();
    if (!raw) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

/** 按 isolate 缓存校验器：密钥派生与 importKey 每个 isolate 只做一次 */
let verifierCache: { key: string; verifier: SessionVerifier } | null = null;

/**
 * 未配置 PASSWORD 时返回 null：此时没有任何凭证可以被校验（登录接口会 503），
 * 沿用改造前的行为——页面放行、由 AuthProvider 提示管理员配置、/api/* 守卫返回 503。
 * 这样误删 secret 也不会把站点锁成完全不可用的重定向循环。
 */
function getSessionVerifier(): SessionVerifier | null {
  const password = process.env.PASSWORD ?? '';
  if (!password) return null;
  const proxySecret = process.env.PROXY_SECRET ?? '';
  const cacheKey = `${password}\u0000${proxySecret}`;
  if (verifierCache?.key !== cacheKey) {
    verifierCache = { key: cacheKey, verifier: createSessionVerifier({ password, proxySecret }) };
  }
  return verifierCache.verifier;
}

/** 未认证的页面请求：302 到 /login，next 保留原始 path + query（编码后放进参数） */
function loginRedirect(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const target = request.nextUrl.clone();
  target.pathname = '/login';
  target.search = '';
  target.hash = '';
  target.searchParams.set('next', `${pathname}${search}`);
  // 302（而非 307）：登录后是 GET，不需要保留原方法
  return NextResponse.redirect(target, 302);
}

/** 已认证访问 /login：回跳 next（仅站内相对路径）或首页 */
function loggedInRedirect(request: NextRequest): NextResponse {
  const target = safeNextPath(request.nextUrl.searchParams.get('next'));
  return NextResponse.redirect(new URL(target, request.nextUrl.origin), 302);
}

function unauthorizedJson(): NextResponse {
  return NextResponse.json({ error: '未登录' }, { status: 401, headers: { 'cache-control': 'no-store' } });
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  if (isStaticPath(pathname)) return NextResponse.next();

  // PUBLIC_MODE=1（2026-11-25 临时公开）：完全旁路密码门禁，公网直进。
  // 与 api-guard 的同名开关配套；恢复门禁 = 删掉 wrangler vars 里的 PUBLIC_MODE 重新部署。
  if (process.env.PUBLIC_MODE === '1') return NextResponse.next();

  const verifier = getSessionVerifier();
  const verified = verifier ? await verifier.verify(readSessionCookie(request.headers.get('cookie'))) : false;

  if (matchesPrefix(pathname, '/login')) {
    return verified ? loggedInRedirect(request) : NextResponse.next();
  }
  if (isPublicPath(pathname)) return NextResponse.next();
  if (!verifier) return NextResponse.next();
  if (verified) return NextResponse.next();

  // 未登录：API 给 401 JSON，页面给 302
  if (matchesPrefix(pathname, '/api')) return unauthorizedJson();
  // 页面的非 GET/HEAD（如 Server Action POST）也一律拒绝，不能只看导航
  if (request.method !== 'GET' && request.method !== 'HEAD') return unauthorizedJson();
  return loginRedirect(request);
}

export const config = {
  /*
   * 第一条把 /api/* 全部纳入（不看后缀，代理/直播流路径里可能带 .js / .m3u8）；
   * 第二条覆盖所有页面，并排除静态资源（否则会把 JS/CSS 也 302 成 /login，页面直接白屏）。
   * 两条 matcher 是并集。
   */
  matcher: [
    '/api/:path*',
    '/((?!_next/static|_next/image|favicon\\.ico|icons/|manifest\\.webmanifest|robots\\.txt|.*\\.(?:svg|png|jpe?g|gif|webp|avif|ico|css|js|mjs|map|txt|xml|woff2?|ttf|otf|eot|mp4|webm|m3u8)$).*)',
  ],
};
