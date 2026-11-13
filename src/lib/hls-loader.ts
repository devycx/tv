import { FetchLoader } from 'hls.js';
import type HlsType from 'hls.js';
import { stripAdGroups } from './m3u8';
import { buildSegmentCacheKey, readCachedSegment, touchMeta } from './video-cache';

/**
 * hls.js loader 工厂：在同一个 loader 里组合「广告过滤」与「片段缓存命中」。
 *
 * - manifest / level：走基类网络加载；blockAd 开启时在 onSuccess 里剔除
 *   片头插入的广告段（整段移除，保留 DISCONTINUITY 时间轴标记）；
 * - fragment：cache-first——本地缓存命中直接合成响应（不回源），未命中走基类。
 *   BYTERANGE 分片（原文件切片）不缓存、直接回源。
 *
 * 关键细节：缓存命中时用预取阶段记录的**真实耗时**（costMs）合成 hls.js 的
 * loader stats——如果让加载时长为 0，ABR 会把它当成无限带宽，错误地拉高码率。
 *
 * hls.js 对每次请求都会 new 一个 loader 实例，因此实例上的 destroyed 标记
 * 生命周期安全（abort/destroy 后不再回调，防孤儿 onSuccess）。
 *
 * 直连优化：基类用 hls.js 的 FetchLoader（而不是默认的 XhrLoader），并在
 * fetchSetup 里显式设置 `credentials: 'omit'` 与 `referrerPolicy: 'no-referrer'`。
 * XHR 无法按请求控制 Referrer-Policy，而直连站外源时携带页面 Referer 正是
 * 防盗链最常见的拦截依据；浏览器禁止伪造 Referer，这里只能如实置空。
 */
interface LoaderOptions {
  blockAd?: boolean;
  /** 缓存命中探针（设置面板展示命中率用），可缺省 */
  onProbe?: (hit: boolean) => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HlsLoaderCtor = new (config: any) => any;

/** 直连源站的 fetch 初始化：不向源站暴露来源页，也不带 cookie */
function directFetchSetup(context: { url: string }, initParams: RequestInit): Request {
  return new Request(context.url, {
    ...initParams,
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
}

export function createHlsLoader(
  HlsCtor: typeof HlsType,
  options: LoaderOptions = {}
): HlsLoaderCtor {
  const { blockAd = false, onProbe } = options;
  // fetch 不可用的老浏览器退回默认 loader（fetchSetup 会被忽略，只损失直连优化，
  // 播放本身不受影响）
  const BaseLoader = (
    typeof fetch === 'function' ? FetchLoader : HlsCtor.DefaultConfig.loader
  ) as HlsLoaderCtor;

  return class CacheFirstHlsLoader extends BaseLoader {
    private destroyed = false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(config: any) {
      super({ ...config, fetchSetup: directFetchSetup });
      const load = this.load.bind(this);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.load = (context: any, config: any, callbacks: any) => {
        const isPlaylist = context.type === 'manifest' || context.type === 'level';

        // —— 播放列表：网络加载 + 可选广告过滤 ——
        if (isPlaylist) {
           
          if (blockAd) {
             
            const onSuccess = callbacks.onSuccess;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            callbacks.onSuccess = function (response: any, stats: any, ctx: any, networkDetails: any) {
              if (response.data && typeof response.data === 'string') {
                response.data = stripAdGroups(response.data);
              }
              onSuccess(response, stats, ctx, networkDetails);
            };
          }
          load(context, config, callbacks);
          return;
        }

        // —— BYTERANGE 分片：整文件切片，无法独立缓存，直接回源 ——
        if (context.rangeStart || context.rangeEnd) {
          load(context, config, callbacks);
          return;
        }

        // —— 片段：cache-first ——
        const key = buildSegmentCacheKey(context.url);
        readCachedSegment(key).then((hit) => {
          if (this.destroyed) return;
          if (hit) {
            void touchMeta(key);
            onProbe?.(true);
            const now = performance.now();
            Object.assign(this.stats, {
              loading: { start: now - hit.costMs, first: now - hit.costMs + 1, end: now },
              total: hit.data.byteLength,
              loaded: hit.data.byteLength,
            });
            callbacks.onSuccess({ url: context.url, data: hit.data }, this.stats, context, undefined);
            return;
          }
          onProbe?.(false);
           
          const onSuccess = callbacks.onSuccess;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          callbacks.onSuccess = (response: any, stats: any, ctx: any, networkDetails: any) => {
            if (!this.destroyed) onSuccess(response, stats, ctx, networkDetails);
          };
          load(context, config, callbacks);
        });
      };
    }

    abort(): void {
      this.destroyed = true;
      super.abort();
    }

    destroy(): void {
      this.destroyed = true;
      super.destroy?.();
    }
  };
}
