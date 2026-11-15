import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { GET } from './route';
import { SESSION_COOKIE, signSession } from '@/lib/auth';

/**
 * 封面取图代理：只测路由层的鉴权/取图/大小与类型校验。
 * DNS 统一 mock 成公网地址，避免 Clash fake-IP 把 .example 解析到保留网段。
 */
vi.mock('node:dns/promises', () => ({
  default: {
    lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
  },
}));

beforeAll(() => {
  process.env.PASSWORD = 'test-password-123';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeRequest(target: string, authed = true): Request {
  const headers: Record<string, string> = {};
  if (authed) {
    const { token } = signSession();
    headers.cookie = `${SESSION_COOKIE}=${token}`;
  }
  return new Request(`https://local.test/api/cover?url=${encodeURIComponent(target)}`, { headers });
}

function stubImageFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('img.example.com/ok.jpg')) {
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        });
      }
      if (url.includes('img.example.com/text')) {
        return new Response('not an image', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      if (url.includes('img.example.com/svg.svg')) {
        return new Response('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', {
          status: 200,
          headers: { 'content-type': 'image/svg+xml' },
        });
      }
      if (url.includes('img.example.com/big.jpg')) {
        return new Response(new Uint8Array([1]), {
          status: 200,
          headers: { 'content-type': 'image/jpeg', 'content-length': String(4 * 1024 * 1024) },
        });
      }
      if (url.includes('img.example.com/tls.jpg') && url.startsWith('https:')) {
        return new Response('ssl handshake failed', { status: 525 });
      }
      if (url.includes('img.example.com/tls.jpg') && url.startsWith('http:')) {
        return new Response(new Uint8Array([9, 8, 7]), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        });
      }
      return new Response('not found', { status: 404 });
    })
  );
}

describe('GET /api/cover', () => {
  it('未登录返回 401', async () => {
    const res = await GET(makeRequest('https://img.example.com/ok.jpg', false));
    expect(res.status).toBe(401);
  });

  it('非 http(s) 地址返回 400', async () => {
    const res = await GET(makeRequest('file:///etc/passwd'));
    expect(res.status).toBe(400);
  });

  it('成功取图：透传图片并允许浏览器私有缓存', async () => {
    stubImageFetch();
    const res = await GET(makeRequest('https://img.example.com/ok.jpg'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toContain('private');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('目标不是图片返回 415', async () => {
    stubImageFetch();
    const res = await GET(makeRequest('https://img.example.com/text'));
    expect(res.status).toBe(415);
  });

  it('拒绝可执行脚本的 SVG（只做指纹，不需要透传矢量图）', async () => {
    stubImageFetch();
    const res = await GET(makeRequest('https://img.example.com/svg.svg'));
    expect(res.status).toBe(415);
  });

  it('超过 3MB 返回 413', async () => {
    stubImageFetch();
    const res = await GET(makeRequest('https://img.example.com/big.jpg'));
    expect(res.status).toBe(413);
  });

  it('HTTPS 返回 525（源站 TLS 失败）时降级 HTTP 重试', async () => {
    stubImageFetch();
    const res = await GET(makeRequest('https://img.example.com/tls.jpg'));
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));
  });

  it('内网地址被 SSRF 防护拒绝', async () => {
    stubImageFetch();
    const res = await GET(makeRequest('http://127.0.0.1/a.jpg'));
    expect(res.status).toBe(403);
  });
});
