import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoaderConfiguration, LoaderContext, RetryConfig } from 'hls.js';
import { GmFetchHlsLoader, createGmHlsLoader } from './gm-hls-loader';

/** 极简 Response 替身：GM_fetch 返回的也是这种 fetch 兼容对象 */
function fakeResponse(init: {
  status?: number;
  statusText?: string;
  url?: string;
  headers?: Record<string, string>;
  text?: string;
  bytes?: Uint8Array;
}): Response {
  const status = init.status ?? 200;
  const body = init.text ?? '';
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: init.statusText ?? '',
    url: init.url ?? '',
    headers: new Headers(init.headers),
    text: async () => body,
    json: async () => JSON.parse(body),
    arrayBuffer: async () => {
      const bytes = init.bytes ?? new Uint8Array(0);
      return bytes.slice().buffer;
    },
  } as unknown as Response;
}

function loaderConfig(errorRetry: RetryConfig | null = null): LoaderConfiguration {
  return {
    loadPolicy: {
      maxTimeToFirstByteMs: 20_000,
      maxLoadTimeMs: 30_000,
      timeoutRetry: null,
      errorRetry,
    },
    maxRetry: 0,
    timeout: 0,
    retryDelay: 0,
    maxRetryDelay: 0,
  };
}

function manifestContext(url = 'https://cdn.example.com/live/index.m3u8'): LoaderContext {
  return {
    url,
    responseType: 'text',
    type: 'manifest' as LoaderContext['type'],
  };
}

function callbacks() {
  return {
    onSuccess: vi.fn(),
    onError: vi.fn(),
    onTimeout: vi.fn(),
    onAbort: vi.fn(),
  };
}

beforeEach(() => {
  // hls.js 的 BaseLoader 用 self.performance / self.setTimeout；Node 里把 self 指到 globalThis
  vi.stubGlobal('self', globalThis);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('GmFetchHlsLoader · 经 GM_fetch 加载', () => {
  it('manifest 文本走 GM_fetch，回调拿到文本、finalUrl 与统计', async () => {
    const body = '#EXTM3U\n#EXTINF:1,\n';
    const gmFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () =>
        fakeResponse({
          url: 'https://cdn2.example.com/real/index.m3u8',
          headers: { 'Content-Length': String(body.length), Age: '12' },
          text: body,
        })
    );
    vi.stubGlobal('window', { GM_fetch: gmFetch });

    const loader = new GmFetchHlsLoader();
    const cb = callbacks();
    loader.load(manifestContext(), loaderConfig(), cb);

    await vi.waitFor(() => expect(cb.onSuccess).toHaveBeenCalledTimes(1));

    const [response, stats, context] = cb.onSuccess.mock.calls[0];
    expect(gmFetch).toHaveBeenCalledTimes(1);
    expect(gmFetch.mock.calls[0][0]).toBe('https://cdn.example.com/live/index.m3u8');
    // 302 之后的真实地址：相对分片按它解析
    expect(response.url).toBe('https://cdn2.example.com/real/index.m3u8');
    expect(response.data).toBe(body);
    expect(response.code).toBe(200);
    expect(context.url).toBe('https://cdn.example.com/live/index.m3u8');
    expect(stats.loaded).toBe(body.length);
    expect(stats.total).toBe(body.length);
    expect(stats.loading.start).toBeGreaterThan(0);
    expect(stats.loading.first).toBeGreaterThanOrEqual(stats.loading.start);
    expect(stats.loading.end).toBeGreaterThanOrEqual(stats.loading.first);
    expect(loader.getCacheAge()).toBe(12);
    expect(loader.getResponseHeader('content-length')).toBe(String(body.length));
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('分片按 arraybuffer 读取，并把 BYTERANGE 转成 Range 头', async () => {
    const gmFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () =>
        fakeResponse({
          headers: { 'Content-Length': '100' },
          bytes: new Uint8Array(100).fill(7),
        })
    );
    vi.stubGlobal('window', { GM_fetch: gmFetch });

    const loader = new GmFetchHlsLoader();
    const cb = callbacks();
    loader.load(
      {
        url: 'https://cdn.example.com/live/seg.ts',
        responseType: 'arraybuffer',
        type: 'media-fragment' as LoaderContext['type'],
        rangeStart: 100,
        rangeEnd: 200,
      },
      loaderConfig(),
      cb
    );

    await vi.waitFor(() => expect(cb.onSuccess).toHaveBeenCalledTimes(1));
    const [response, stats] = cb.onSuccess.mock.calls[0];
    const init = gmFetch.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('Range')).toBe('bytes=100-199');
    expect(init.credentials).toBe('omit');
    expect(init.referrerPolicy).toBe('no-referrer');
    expect(response.data).toBeInstanceOf(ArrayBuffer);
    expect((response.data as ArrayBuffer).byteLength).toBe(100);
    expect(stats.total).toBe(100);
  });

  it('HTTP 404 报 onError(code=404)，4xx 不重试', async () => {
    const gmFetch = vi.fn(async () => fakeResponse({ status: 404, statusText: 'Not Found' }));
    vi.stubGlobal('window', { GM_fetch: gmFetch });

    const loader = new GmFetchHlsLoader();
    const cb = callbacks();
    const errorRetry: RetryConfig = { maxNumRetry: 3, retryDelayMs: 0, maxRetryDelayMs: 0 };
    loader.load(manifestContext(), loaderConfig(errorRetry), cb);

    await vi.waitFor(() => expect(cb.onError).toHaveBeenCalledTimes(1));
    expect(gmFetch).toHaveBeenCalledTimes(1);
    expect(cb.onError.mock.calls[0][0]).toMatchObject({ code: 404, text: 'Not Found' });
  });

  it('CORS 类 TypeError → code 0，在线时不重试', async () => {
    const gmFetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch: https://cdn.example.com/live/index.m3u8');
    });
    vi.stubGlobal('window', { GM_fetch: gmFetch });

    const loader = new GmFetchHlsLoader();
    const cb = callbacks();
    const errorRetry: RetryConfig = { maxNumRetry: 3, retryDelayMs: 0, maxRetryDelayMs: 0 };
    loader.load(manifestContext(), loaderConfig(errorRetry), cb);

    await vi.waitFor(() => expect(cb.onError).toHaveBeenCalledTimes(1));
    expect(gmFetch).toHaveBeenCalledTimes(1);
    expect(cb.onError.mock.calls[0][0].code).toBe(0);
  });

  it('5xx 按 errorRetry 重试后成功', async () => {
    const gmFetch = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse({ status: 503, statusText: 'Service Unavailable' }))
      .mockResolvedValueOnce(fakeResponse({ text: '#EXTM3U\n' }));
    vi.stubGlobal('window', { GM_fetch: gmFetch });

    const loader = new GmFetchHlsLoader();
    const cb = callbacks();
    const errorRetry: RetryConfig = { maxNumRetry: 1, retryDelayMs: 0, maxRetryDelayMs: 0 };
    loader.load(manifestContext(), loaderConfig(errorRetry), cb);

    await vi.waitFor(() => expect(cb.onSuccess).toHaveBeenCalledTimes(1));
    expect(gmFetch).toHaveBeenCalledTimes(2);
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('abort() 之后迟到的响应不再回调 onSuccess', async () => {
    let resolveRequest: ((res: Response) => void) | null = null;
    const gmFetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveRequest = resolve;
        })
    );
    vi.stubGlobal('window', { GM_fetch: gmFetch });

    const loader = new GmFetchHlsLoader();
    const cb = callbacks();
    loader.load(manifestContext(), loaderConfig(), cb);
    loader.abort();
    resolveRequest!(fakeResponse({ text: '#EXTM3U\n' }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cb.onSuccess).not.toHaveBeenCalled();
    expect(cb.onAbort).toHaveBeenCalledTimes(1);
  });

  it('没有 GM_fetch 时回退原生 fetch（行为与默认 loader 一致）', async () => {
    vi.stubGlobal('window', {});
    const fetchMock = vi.fn(async () => fakeResponse({ text: '#EXTM3U\n' }));
    vi.stubGlobal('fetch', fetchMock);

    const loader = new GmFetchHlsLoader();
    const cb = callbacks();
    loader.load(manifestContext(), loaderConfig(), cb);

    await vi.waitFor(() => expect(cb.onSuccess).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('GmFetchHlsLoader · 播放列表去广告', () => {
  /** dytt 式片头插入段：首个 DISCONTINUITY 后 2 片广告，再接正片 */
  const AD_PLAYLIST = [
    '#EXTM3U',
    '#EXT-X-DISCONTINUITY',
    '#EXTINF:5,',
    'ad0.ts',
    '#EXTINF:5,',
    'ad1.ts',
    '#EXT-X-DISCONTINUITY',
    '#EXTINF:4,',
    'movie0.ts',
    '#EXT-X-DISCONTINUITY',
    '#EXTINF:4,',
    'movie1.ts',
    '#EXT-X-ENDLIST',
  ].join('\n');

  function stubGm(body: string): void {
    const gmFetch = vi.fn(async () => fakeResponse({ text: body }));
    vi.stubGlobal('window', { GM_fetch: gmFetch });
  }

  it('blockAd 开启：manifest 文本先过 stripAdGroups，广告段与紧邻 DISCONTINUITY 被剔除', async () => {
    stubGm(AD_PLAYLIST);
    const loader = new GmFetchHlsLoader(true);
    const cb = callbacks();
    loader.load(manifestContext(), loaderConfig(), cb);

    await vi.waitFor(() => expect(cb.onSuccess).toHaveBeenCalledTimes(1));
    const [response] = cb.onSuccess.mock.calls[0];
    expect(response.data).not.toContain('ad0.ts');
    expect(response.data).toContain('movie0.ts');
    expect(response.data).toContain('movie1.ts');
    // 正片段之间的分段边界保留，片头失去语义的 DISCONTINUITY 清掉
    expect((response.data as string).match(/#EXT-X-DISCONTINUITY/g)).toHaveLength(1);
  });

  it('blockAd 关闭：manifest 原样透传（直播 loader 行为不变）', async () => {
    stubGm(AD_PLAYLIST);
    const loader = new GmFetchHlsLoader();
    const cb = callbacks();
    loader.load(manifestContext(), loaderConfig(), cb);

    await vi.waitFor(() => expect(cb.onSuccess).toHaveBeenCalledTimes(1));
    expect(cb.onSuccess.mock.calls[0][0].data).toBe(AD_PLAYLIST);
  });

  it('createGmHlsLoader 把 blockAd 绑进 hls.js 需要的构造函数', async () => {
    stubGm(AD_PLAYLIST);
    const Ctor = createGmHlsLoader({ blockAd: true });
    // hls.js 内部执行 new Loader(config)；工厂类忽略该参数，config 由 BaseLoader.load 注入
    const loader = new Ctor(loaderConfig());
    const cb = callbacks();
    loader.load(manifestContext(), loaderConfig(), cb);

    await vi.waitFor(() => expect(cb.onSuccess).toHaveBeenCalledTimes(1));
    expect(cb.onSuccess.mock.calls[0][0].data).not.toContain('ad0.ts');
  });

  it('分片文本不做广告过滤（只过滤 manifest/level）', async () => {
    stubGm('#EXTM3U\n');
    const loader = new GmFetchHlsLoader(true);
    const cb = callbacks();
    loader.load(
      { url: 'https://cdn.example.com/seg.ts', responseType: 'text', type: 'media-fragment' as LoaderContext['type'] },
      loaderConfig(),
      cb
    );

    await vi.waitFor(() => expect(cb.onSuccess).toHaveBeenCalledTimes(1));
    expect(cb.onSuccess.mock.calls[0][0].data).toBe('#EXTM3U\n');
  });
});
