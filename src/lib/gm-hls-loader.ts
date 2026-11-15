import {
  BaseLoader,
  type LoaderContext,
  type LoaderResponse,
  type RetryConfig,
} from 'hls.js';
import { getGmFetch } from './gm-fetch';

/**
 * hls.js loader：把 manifest / 分片请求交给油猴「跨域助手」暴露的 `window.GM_fetch`。
 *
 * 只在直播播放器里使用（点播保留原生 FetchLoader：它的预取/缓存/下载都走原生 fetch，
 * 播放单独改走扩展会造成「能播不能下、无缓存」的分裂，见 git 历史里的收益/风险对比）。
 *
 * 为什么需要：
 * - 直播源的 m3u8、分片在第三方源站上，大量源不发 `Access-Control-Allow-Origin`；
 *   浏览器直连会在读取响应体时被 CORS 拦下，页面只能提示「该源不允许跨域直连」。
 * - 油猴「跨域助手」只是把 `GM_fetch`（基于 `GM.xmlHttpRequest`，不受 CORS/混合内容限制）
 *   挂到 window 上；站点不主动调用它，装了也等于没装。
 *
 * 行为对齐 hls.js 自带 `FetchLoader`：
 * - 非 2xx 作为 HTTP 错误上报（带状态码），4xx 不重试；
 * - 超时与重试沿用 `config.loadPolicy`（manifestLoadingMaxRetry / fragLoadingMaxRetry 等）；
 * - `abort()` 之后迟到的响应丢弃，不再回调；
 * - `response.url` 用扩展返回的 finalUrl，302 之后的相对分片地址才能解析正确。
 *
 * 已知取舍：gm-fetch 的 responseType 是 blob（整包下载完才返回），所以没有下载进度，
 * 也无法真正取消已经发出的扩展请求；HLS 分片是有界的几秒数据，对播放没有影响。
 */

class HttpError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
  }
}

/** 与 hls.js FetchLoader 的 getContentLength 一致：优先 Content-Range，其次 Content-Length */
function contentLength(headers: Headers): number {
  const contentRange = headers.get('Content-Range');
  if (contentRange) {
    const match = /(\d+)-(\d+)\/(\d+)/.exec(contentRange);
    if (match) return Number(match[2]) - Number(match[1]) + 1;
  }
  const raw = headers.get('Content-Length');
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 直连源站的请求头：不带 cookie / Referer，BYTERANGE 分片补 Range */
function buildRequestInit(context: LoaderContext, signal: AbortSignal): RequestInit {
  const headers = new Headers(context.headers ?? {});
  if (context.rangeEnd) {
    headers.set('Range', `bytes=${context.rangeStart ?? 0}-${context.rangeEnd - 1}`);
  }
  return {
    method: 'GET',
    mode: 'cors',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    signal,
    headers,
  };
}

/**
 * 与 hls.js 内部 shouldRetry 对齐：4xx 不重试；code 0（CORS/网络）只在本机离线时重试，
 * 因为在线情况下重试同一个被 CORS 拒绝的地址不会有不同结果。
 */
function shouldRetryError(
  retryConfig: RetryConfig | null,
  retryCount: number,
  code: number,
  context: LoaderContext
): boolean {
  if (!retryConfig || retryCount >= retryConfig.maxNumRetry) return false;
  const retryable =
    code === 0
      ? typeof navigator !== 'undefined' && navigator.onLine === false
      : code < 400 || code > 499;
  if (!retryable) return false;
  if (!retryConfig.shouldRetry) return true;
  return retryConfig.shouldRetry(retryConfig, retryCount, false, { url: context.url, code }, true);
}

export class GmFetchHlsLoader extends BaseLoader {
  /** 每次请求自增：abort/重试/销毁后，迟到的响应靠它丢弃 */
  private attempt = 0;
  private response: Response | null = null;
  private controller: AbortController | null = null;

  constructor() {
    super();
  }

  getCacheAge(): number | null {
    const age = this.getResponseHeader('age');
    if (!age) return null;
    const parsed = Number.parseFloat(age);
    return Number.isFinite(parsed) ? parsed : null;
  }

  getResponseHeader(name: string): string | null {
    return this.response?.headers.get(name) ?? null;
  }

  protected getNetworkDetails(): Response | null {
    return this.response;
  }

  protected resetInternalLoader(): void {
    this.response = null;
  }

  protected abortInternal(): void {
    this.attempt++;
    self.clearTimeout(this.requestTimeout);
    self.clearTimeout(this.retryTimeout);
    if (this.stats && !this.stats.loading.end) this.stats.aborted = true;
    try {
      this.controller?.abort();
    } catch {
      /* 已结束或不支持 AbortController 的环境：忽略 */
    }
  }

  /**
   * 不走 BaseLoader.retry：hls.js 1.7.3 的 retry 里有一条未声明的 `status` 引用，
   * 只在浏览器（window.status 兜底）下不报错。这里按同样的退避策略自己排重试。
   */
  private scheduleRetry(retryConfig: RetryConfig): void {
    const stats = this.stats;
    if (!stats) return;
    const backoffFactor = retryConfig.backoff === 'linear' ? 1 : Math.pow(2, stats.retry);
    const delay = Math.min(backoffFactor * retryConfig.retryDelayMs, retryConfig.maxRetryDelayMs);
    this.retryDelay = delay;
    stats.retry++;
    // 先作废在途请求（含迟到响应），再排下一次
    this.abortInternal();
    this.resetInternalLoader();
    this.retryTimeout = self.setTimeout(() => this.loadInternal(), delay);
  }

  /** 超时重试：与 hls.js 一致，只看 timeoutRetry 的次数上限 */
  protected loadtimeout(): void {
    const config = this.config;
    const stats = this.stats;
    if (!config || !stats) return;
    const retryConfig = config.loadPolicy.timeoutRetry;
    if (retryConfig && stats.retry < retryConfig.maxNumRetry) {
      const allow =
        !retryConfig.shouldRetry || retryConfig.shouldRetry(retryConfig, stats.retry, true, undefined, true);
      if (allow) {
        this.scheduleRetry(retryConfig);
        return;
      }
    }
    const callbacks = this.callbacks;
    if (callbacks) {
      this.abortInternal();
      callbacks.onTimeout(stats, this.context as LoaderContext, this.getNetworkDetails());
    }
  }

  protected loadInternal(): void {
    const config = this.config;
    const context = this.context;
    const stats = this.stats;
    if (!config || !context || !stats) return;

    const attempt = ++this.attempt;
    stats.loading.first = 0;
    stats.loaded = 0;
    stats.aborted = false;
    this.response = null;

    const controller = new AbortController();
    this.controller = controller;

    // GM_fetch 是「整包下载完才 resolve」，拿不到首字节时间：不能按 maxTimeToFirstByteMs
    // 计时（慢网下 3–8MB 的直播分片会被误判超时），统一用 maxLoadTimeMs 兜整个请求。
    config.timeout = config.loadPolicy.maxLoadTimeMs;
    self.clearTimeout(this.requestTimeout);
    this.requestTimeout = self.setTimeout(() => this.loadtimeout(), config.timeout);

    void this.request(attempt, context, controller.signal);
  }

  private isCurrent(attempt: number): boolean {
    return attempt === this.attempt && this.config !== null && this.stats !== null;
  }

  private async request(
    attempt: number,
    context: LoaderContext,
    signal: AbortSignal
  ): Promise<void> {
    const config = this.config;
    const stats = this.stats;
    if (!config || !stats) return;

    try {
      const gmFetch = getGmFetch();
      const init = buildRequestInit(context, signal);
      // 没有脚本时退回原生 fetch（行为与默认 loader 一致，CORS 限制也一致）
      const response = gmFetch ? await gmFetch(context.url, init) : await fetch(context.url, init);
      if (!this.isCurrent(attempt)) return;

      this.response = response;
      self.clearTimeout(this.requestTimeout);
      if (!response.ok) {
        throw new HttpError(response.status, response.statusText || `HTTP ${response.status}`);
      }

      // 整包下载：TTFB 记为请求起点，吞吐按「发出请求→拿到数据」全程计算。
      // 若把 first 记为完成时刻，hls.js 会算出接近 0 的加载耗时 → ABR 误判成无限带宽。
      stats.loading.first = stats.loading.start;
      stats.total = contentLength(response.headers) || stats.total;

      let data: string | ArrayBuffer | object;
      if (context.responseType === 'arraybuffer') {
        data = await response.arrayBuffer();
      } else if (context.responseType === 'json') {
        data = await response.json();
      } else {
        data = await response.text();
      }
      if (!this.isCurrent(attempt)) return;
      self.clearTimeout(this.requestTimeout);

      const end = Math.max(self.performance.now(), stats.loading.first);
      stats.loading.end = end;
      const size =
        typeof data === 'string' ? data.length : data instanceof ArrayBuffer ? data.byteLength : 0;
      if (size) stats.loaded = stats.total = size;

      const loaderResponse: LoaderResponse = {
        // 302 之后的真实地址：相对分片要按它解析
        url: response.url || context.url,
        data,
        code: response.status,
      };
      this.callbacks?.onSuccess(loaderResponse, stats, context, response);
    } catch (error) {
      if (!this.isCurrent(attempt)) return;
      self.clearTimeout(this.requestTimeout);
      if (stats.aborted) return;

      const code = error instanceof HttpError ? error.code : 0;
      const text = error instanceof Error ? error.message : 'network error';
      const retryConfig = config.loadPolicy.errorRetry;
      if (retryConfig && shouldRetryError(retryConfig, stats.retry, code, context)) {
        this.scheduleRetry(retryConfig);
        return;
      }
      this.callbacks?.onError({ code, text }, context, this.getNetworkDetails(), stats);
    }
  }
}
