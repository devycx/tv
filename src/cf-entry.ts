/* eslint-disable */
// @ts-nocheck
/**
 * Cloudflare Worker 入口包壳（wrangler.jsonc 的 main 指向这里）。
 *
 * 目的：在请求进入 OpenNext 的 Next.js 运行时之前，先用 Cloudflare Cache API 挡一层
 * 「已登录用户重复访问」的请求，把这类请求的 CPU 从 20–60ms 压到几 ms。
 *
 * 为什么需要：Workers 免费套餐单次 invocation 的 CPU 上限是 10ms，而
 * `next build` 出来的页面（HTML 由 server function 动态返回）与大部分 /api 路由
 * 实测 CPU 在 7–60ms，P75/P99 明显超限；Cloudflare 只是对偶发超限有容忍，流量上来
 * 就会被 Error 1102 掐断。缓存命中后不再进入 Next 运行时，是性价比最高的一刀。
 *
 * 安全：缓存只能由「已通过会话校验」的请求读取；未登录请求原样交给 OpenNext
 * （由 src/middleware.ts 负责 302/401 门禁）。缓存内容本身与用户无关（页面是
 * 构建期预渲染的同一份 HTML，API 响应也是公共数据），因此按 URL 共享缓存是安全的。
 *
 * 失效：缓存 key 里带 `CF_VERSION_METADATA.id`（每次 wrangler deploy 都会变），
 * 新版本上线后旧缓存自然不再命中；entry 另有 max-age 兜底。
 */

import openNextWorker from '../.open-next/worker.js';
import { createSessionVerifier, type SessionVerifier } from './lib/session-webcrypto';

export { DOQueueHandler } from '../.open-next/worker.js';
export { DOShardedTagCache } from '../.open-next/worker.js';
export { BucketCachePurge } from '../.open-next/worker.js';

const SESSION_COOKIE = 'ltv_session';

/** Cache API 命名空间：用站点自己的 host 生成 key，避免跨 zone 误用 */
const CACHE_ORIGIN = 'https://tv.ycxdev.com';

/** 页面缓存 TTL（秒）：内容随构建版本变化，版本号已进 key，可放心放长 */
const PAGE_TTL = 6 * 60 * 60;

/** 可按 URL 缓存的 GET API 及其 TTL（秒） */
const API_TTL: Record<string, number> = {
  '/api/status': 60 * 60,
  '/api/bangumi/calendar': 60 * 60,
  '/api/douban': 5 * 60,
  '/api/hot-list': 10 * 60,
  '/api/detail': 10 * 60,
  '/api/source-list': 10 * 60,
  '/api/live/epg': 30 * 60,
  '/api/live/playlist': 5 * 60,
};

/** 页面路由：只缓存整页文档请求（RSC 导航请求带 Next-Router-State-Tree，不能按 URL 共用） */
const PAGE_PATHS = new Set(['/', '/live', '/about', '/watch']);

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

let verifierCache: { key: string; verifier: SessionVerifier } | null = null;

/** 与 middleware.ts 相同的按 isolate 缓存策略：密钥派生只做一次 */
function getSessionVerifier(env: any): SessionVerifier | null {
  const password = (env && env.PASSWORD) || '';
  if (!password) return null;
  const proxySecret = (env && env.PROXY_SECRET) || '';
  const cacheKey = `${password}\u0000${proxySecret}`;
  if (verifierCache?.key !== cacheKey) {
    verifierCache = { key: cacheKey, verifier: createSessionVerifier({ password, proxySecret }) };
  }
  return verifierCache.verifier;
}

function buildCacheKey(version: string, pathname: string, search: string, withSearch: boolean): Request {
  const path = `/${version}${pathname}${withSearch ? search : ''}`;
  return new Request(`${CACHE_ORIGIN}/__tv-cache__${path}`, { method: 'GET' });
}

/** 判断当前 GET 请求是否可走缓存；返回 TTL（秒）或 0 表示不缓存 */
function cacheTtlFor(request: Request, url: URL): number {
  if (request.method !== 'GET') return 0;
  // RSC 导航载荷依赖 Next-Router-State-Tree 请求头，按 URL 缓存会串页
  if (request.headers.get('rsc') === '1' || url.searchParams.has('_rsc')) return 0;

  if (PAGE_PATHS.has(url.pathname)) {
    // 只缓存浏览器整页导航（Accept 里带 text/html），避免误缓存图片/JSON fetch
    const accept = request.headers.get('accept') || '';
    if (!accept.includes('text/html')) return 0;
    return PAGE_TTL;
  }

  const ttl = API_TTL[url.pathname];
  if (!ttl) return 0;
  // 直播列表 force=1 是「强制刷新」，必须穿透缓存
  if (url.searchParams.get('force') === '1') return 0;
  return ttl;
}

/** 聚合搜索 POST 缓存 TTL（秒）：与 route.ts 内的内存短缓存对齐 */
const SEARCH_TTL = 60;

/** 搜索 POST 的缓存 key：按请求体（关键词 + 源集合 + 过滤开关）做 SHA-256 */
async function buildSearchCacheKey(version: string, bodyText: string): Promise<Request> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bodyText));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  return buildCacheKey(version, `/__search__/${hex}`, '', false);
}

function isCacheableResponse(res: Response): boolean {
  if (!res || res.status !== 200) return false;
  if (res.headers.has('set-cookie')) return false;
  const ct = res.headers.get('content-type') || '';
  // 页面 HTML、JSON API 与 /api/search 的 NDJSON 流都按字节缓存
  return ct.includes('text/html') || ct.includes('json');
}

async function cacheApi(): Promise<Cache | null> {
  try {
    // caches.default 在自定义域 / workers.dev 上均可用；取不到就当没有缓存
    return typeof caches !== 'undefined' && caches.default ? caches.default : null;
  } catch {
    return null;
  }
}

/** 未登录 / 未配置密码时一律直通 OpenNext（由 middleware 负责门禁） */
async function authed(env: any, request: Request): Promise<boolean> {
  const verifier = getSessionVerifier(env);
  if (!verifier) return false;
  return verifier.verify(readSessionCookie(request.headers.get('cookie')));
}

function cacheHitResponse(hit: Response): Response {
  const res = new Response(hit.body, hit);
  res.headers.set('X-TV-Cache', 'HIT');
  // 页面/接口不落浏览器缓存：登录态与版本切换由边缘缓存保证一致性
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
}

function versionOf(env: any): string {
  return (env && env.CF_VERSION_METADATA && env.CF_VERSION_METADATA.id) || 'dev';
}

async function storeResponse(ctx: any, cache: Cache, key: Request, response: Response, ttl: number): Promise<void> {
  try {
    const stored = new Response(response.clone().body, response);
    stored.headers.set('Cache-Control', `public, max-age=${ttl}`);
    stored.headers.delete('set-cookie');
    // waitUntil：不阻塞响应返回，也不额外增加本次请求的 CPU 计费窗口
    ctx.waitUntil(cache.put(key, stored).catch(() => {}));
  } catch {
    /* 缓存写失败不阻断请求 */
  }
}

/** GET /api/search?stream=1 的 POST 版本：按请求体哈希缓存 60s（与 route 内存缓存一致） */
async function handleSearchPost(request: Request, env: any, ctx: any): Promise<Response> {
  if (!(await authed(env, request))) return openNextWorker.fetch(request, env, ctx);
  const cache = await cacheApi();
  let key: Request | null = null;
  if (cache) {
    try {
      key = await buildSearchCacheKey(versionOf(env), await request.clone().text());
      const hit = await cache.match(key);
      if (hit) return cacheHitResponse(hit);
    } catch {
      key = null;
    }
  }
  const response = await openNextWorker.fetch(request, env, ctx);
  if (cache && key && isCacheableResponse(response)) {
    await storeResponse(ctx, cache, key, response, SEARCH_TTL);
  }
  return response;
}

export default {
  async fetch(request: Request, env: any, ctx: any): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/api/search') {
      return handleSearchPost(request, env, ctx);
    }

    const ttl = cacheTtlFor(request, url);
    if (!ttl) return openNextWorker.fetch(request, env, ctx);

    // 只有通过会话校验的请求才允许读/写共享缓存；未登录请求交给 middleware 处理
    if (!(await authed(env, request))) return openNextWorker.fetch(request, env, ctx);

    const withSearch = !PAGE_PATHS.has(url.pathname);
    const key = buildCacheKey(versionOf(env), url.pathname, url.search, withSearch);
    const cache = await cacheApi();

    if (cache) {
      try {
        const hit = await cache.match(key);
        if (hit) return cacheHitResponse(hit);
      } catch {
        /* 缓存读失败不阻断请求 */
      }
    }

    const response = await openNextWorker.fetch(request, env, ctx);

    if (cache && isCacheableResponse(response)) {
      await storeResponse(ctx, cache, key, response, ttl);
    }
    return response;
  },
};
