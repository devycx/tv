import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { fetchUpstream } from '@/lib/fetch-utils';

export const runtime = 'nodejs';

/**
 * 保留的登录取图代理。搜索页已改为零网络 URL 指纹，不再为 dHash 调用这里；
 * 路由继续兼容显式代理场景，并强制至少一天的浏览器私有缓存。
 *
 * 约束：
 * - 必须登录（不是开放代理）；每次请求只取一张图；
 * - 复用 fetchUpstream 的 SSRF 防护（逐跳校验重定向），挡内网/保留地址；
 * - 只接受图片内容（content-type 或图片扩展名），单张上限 3MB；
 * - 浏览器私有缓存 1 天：覆盖上游 no-cache/no-store，重复访问直接复用。
 */
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const IMAGE_EXT = /\.(?:jpe?g|png|webp|gif|avif|bmp|jxl)(?:$|[?#])/i;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const IMAGE_HEADERS = { 'User-Agent': UA, Accept: 'image/*,*/*;q=0.8' };

/**
 * 取图；部分图床从 Cloudflare 边缘走 HTTPS 会返回 525/526（源站 TLS 握手失败），
 * 但同一路径的 HTTP 能正常返回。降级只用于「算指纹」的公开图片，且同样过 SSRF 校验。
 * 不做 403/404 的降级：那通常是防盗链/路径不存在，换 HTTP 也不会变。
 */
async function fetchCoverImage(target: string): Promise<Response> {
  const res = await fetchUpstream(target, { timeoutMs: 8000, headers: IMAGE_HEADERS });
  if (res.ok || (res.status !== 525 && res.status !== 526) || !/^https:/i.test(target)) return res;

  const httpTarget = target.replace(/^https:/i, 'http:');
  return fetchUpstream(httpTarget, { timeoutMs: 8000, headers: IMAGE_HEADERS });
}

export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const target = new URL(req.url).searchParams.get('url')?.trim() ?? '';
  if (!/^https?:\/\//i.test(target)) {
    return new NextResponse('无效的图片地址', { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetchCoverImage(target);
  } catch (err) {
    const message = err instanceof Error ? err.message : '取图失败';
    return new NextResponse(message, { status: /拒绝|私有|保留/.test(message) ? 403 : 502 });
  }

  if (!upstream.ok) {
    return new NextResponse(`图片请求失败 (${upstream.status})`, { status: 502 });
  }

  const contentType = (upstream.headers.get('content-type') ?? '').toLowerCase();
  // SVG 可携带脚本：只用于算指纹，没有理由把同源可执行的 SVG 透传给浏览器。
  if (contentType.startsWith('image/svg')) {
    return new NextResponse('不支持 SVG 封面', { status: 415 });
  }
  if (!contentType.startsWith('image/') && !IMAGE_EXT.test(target)) {
    return new NextResponse('目标不是图片', { status: 415 });
  }

  const declaredLength = Number(upstream.headers.get('content-length') ?? '0');
  if (declaredLength > MAX_IMAGE_BYTES) {
    return new NextResponse('图片过大', { status: 413 });
  }

  const body = await upstream.arrayBuffer();
  if (body.byteLength > MAX_IMAGE_BYTES) {
    return new NextResponse('图片过大', { status: 413 });
  }

  return new NextResponse(body, {
    headers: {
      'Content-Type': contentType.startsWith('image/') ? contentType : 'application/octet-stream',
      'Content-Length': String(body.byteLength),
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      // 即便透传的图片类型有意外，也不允许它作为同源文档执行脚本
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
}
