'use client';

import type { SearchResponse, SearchStreamEvent, SourceSearchOutcome, VideoDetail, DoubanResponse, BangumiCalendarResponse, SourceConfig, SearchResultItem, LivePlaylistResponse, LiveEpgResponse, SourceListPayload, QualityProbeItem, QualityProbeResult } from './types';
import { fetchLivePlaylistDirect, livePlaylistApiUrl } from './live-playlist';
import { UNAUTHORIZED_EVENT } from './unauthorized-event';
import { isPasswordSetupResponse } from './api-failure';
import { compareSearchResults } from './relevance';
import { useAppStore, type SourceHealthEntry } from './store';

/** 401/503 全局事件名；对外导出保持兼容（事件常量已抽到 unauthorized-event，避免循环依赖） */
export { UNAUTHORIZED_EVENT };

/**
 * 客户端 API 封装。401 时触发全局事件打开登录框，
 * 替代旧版在每个函数里手工检查 isPasswordVerified 的散弹式写法。
 */

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** 单条测活结果（/api/live/probe，JSON 与 NDJSON 流共用同一结构） */
export interface LiveProbeResult {
  url: string;
  ok: boolean;
  status?: number;
  /** 分片级探测：仅统计分片往返耗时 */
  ms?: number;
  /** segment=分片级（最可信）/ manifest=仅列表可达 / head=直链单级 */
  level?: 'segment' | 'manifest' | 'head';
  error?: string;
  /** master playlist 的 CODECS，用于前端提示 H.265 等不可解码情况 */
  codec?: string;
  /** 因超时失败：源可能只是慢，前端以琥珀色区分于真正的不可达 */
  timedOut?: boolean;
  /** 分片吞吐估算（kbps）：低于阈值的源前端标记为「源限速」 */
  kbps?: number;
}

export function onUnauthorized(handler: (event: CustomEvent) => void): () => void {
  const wrapped = (e: Event) => handler(e as CustomEvent);
  window.addEventListener(UNAUTHORIZED_EVENT, wrapped);
  return () => window.removeEventListener(UNAUTHORIZED_EVENT, wrapped);
}

/** 401/503 统一处理：分发全局事件打开登录框并抛 ApiError（普通与流式请求共用） */
function throwForAuthStatus(res: Response): void {
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    throw new ApiError('需要登录', 401);
  }
  // 只有本站 JSON 503 才是「未配置密码」；Cloudflare 的 1102 等错误页是 HTML 503，
  // 误判会让用户看到莫名其妙的「需要配置密码」弹窗。
  if (isPasswordSetupResponse(res)) {
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT, { detail: 'setup' }));
    throw new ApiError('服务器未配置密码', 503);
  }
}

/** NDJSON 流读取：按行解析 JSON 并回调，坏行跳过不影响其余结果 */
async function consumeNdjson<T>(res: Response, onEvent: (event: T) => void): Promise<void> {
  if (!res.body) throw new ApiError(`请求失败 (${res.status})`, res.status);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const consume = (line: string) => {
    const text = line.trim();
    if (!text) return;
    try {
      onEvent(JSON.parse(text) as T);
    } catch {
      // 坏行跳过，不影响其余结果
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      consume(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
    }
  }
  buffer += decoder.decode();
  consume(buffer);
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError('网络请求失败，请检查网络连接', 0);
  }
  throwForAuthStatus(res);
  if (!res.ok) {
    let msg = `请求失败 (${res.status})`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data?.error) msg = data.error;
    } catch { /* 忽略解析失败 */ }
    throw new ApiError(msg, res.status);
  }
  return (await res.json()) as T;
}

export const api = {
  /**
   * 登录：单个输入框兼容两种凭证——
   * 含 @ 的输入走邮箱白名单通道（GATE_EMAILS，免密码免验证码），
   * 其余按访问密码走。判定在前端做，后端按 body 字段分发。
   */
  login: (value: string) =>
    request<{ success: boolean }>('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value.includes('@') ? { email: value.trim() } : { password: value }),
    }),

  logout: () => request<{ success: boolean }>('/api/auth', { method: 'DELETE' }),

  /**
   * 聚合搜索。传入 onSource 时走 /api/search?stream=1 的 NDJSON 流：
   * 每个源结算立即回调（健康源结果不再等坏源超时），最终以聚合结果 resolve。
   * 未传 onSource 或流不可用时回退为一次性 JSON 请求。
   */
  search: async (
    wd: string,
    sources: SourceConfig[],
    filterAdult: boolean,
    opts?: { signal?: AbortSignal; onSource?: (outcome: SourceSearchOutcome) => void; timeoutMs?: number }
  ): Promise<SearchResponse> => {
    const signal = opts?.signal;
    const onSource = opts?.onSource;
    const timeoutMs = opts?.timeoutMs;
    // 只读一次快照，不订阅：源健康度变化不该让调用方重渲染
    const healthMap = typeof window !== 'undefined' ? useAppStore.getState().sourceHealth : {};
    const { fastChunks, slowChunks } = partitionSourcesByHealth(sources, healthMap);
    const allChunks = [...fastChunks, ...slowChunks];

    if (allChunks.length === 0) return { list: [], failures: [] };
    // 源少时保持单请求：拆批只会多一次 invocation，排队本来就不存在
    if (allChunks.length === 1) {
      return searchOnce(wd, allChunks[0], filterAdult, onSource, signal, timeoutMs);
    }

    // 每个独立 invocation 各自拥有「等待响应头」的连接槽，快源先发、慢源延后 250ms，
    // 避免历史超时的源在首屏争抢并发连接。
    const fastPromises = fastChunks.map((subset) =>
      searchOnce(wd, subset, filterAdult, onSource, signal, timeoutMs)
    );
    const slowPromises = slowChunks.map(async (subset) => {
      if (fastChunks.length > 0) {
        await delayWithSignal(SLOW_TIER_DELAY_MS, signal);
        if (signal?.aborted) return { list: [], failures: [] };
      }
      return searchOnce(wd, subset, filterAdult, onSource, signal, timeoutMs);
    });

    const parts = await Promise.all([...fastPromises, ...slowPromises]);
    return mergeSearchResponses(parts, wd);
  },

  detail: (id: string, source: SourceConfig, signal?: AbortSignal) => {
    const sp = new URLSearchParams({ id, source: JSON.stringify(source) });
    return request<VideoDetail>(`/api/detail?${sp.toString()}`, { signal });
  },

  /**
   * 批量画质探测（NDJSON 流式）：展开来源面板时逐条回调，先到的源先显示画质。
   * 结果里的 height 缺失代表「测不出」（单码率 m3u8 / 直链 / 防盗链），不是失败。
   *
   * 传输层失败（请求没发出去 / 流中途断开）不再原样冒泡：调用方原先只能静默成
   * 「未测到」，线上出问题时无法区分「网关拦了」「容器崩了」「探测本身失败」。
   * 服务端开流即写一行心跳，收到过首字节说明请求确实进了应用，据此给出不同文案。
   */
  qualityProbeStream: async (
    items: QualityProbeItem[],
    onResult: (result: QualityProbeResult) => void,
    signal?: AbortSignal
  ): Promise<void> => {
    let res: Response;
    try {
      res = await fetch('/api/quality?stream=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
        signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      throw new ApiError('探测请求没能送达服务器（网络或反向代理中断）', 0);
    }
    throwForAuthStatus(res);
    if (!res.ok || !res.body) throw new ApiError(`请求失败 (${res.status})`, res.status);

    let firstByte = false;
    try {
      await consumeNdjson<QualityProbeResult | { ping: true }>(res, (event) => {
        // 心跳行不是结果：收到它就证明请求确实进了 Next，后面的失败才归因于探测本身
        if ('ping' in event) {
          firstByte = true;
          return;
        }
        firstByte = true;
        onResult(event);
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      throw new ApiError(
        firstByte
          ? '探测连接中途被断开（已收到部分结果，多为网关超时）'
          : '探测请求被网关拦截（未收到任何响应）',
        0
      );
    }
  },

  douban: (type: 'movie' | 'tv', tag: string, pageStart: number, pageSize: number, signal?: AbortSignal) => {
    const sp = new URLSearchParams({ type, tag, pageStart: String(pageStart), pageSize: String(pageSize) });
    return request<DoubanResponse>(`/api/douban?${sp.toString()}`, { signal });
  },

  /** Bangumi 每日放送（免 key），首页推荐的另一数据源 */
  bangumiCalendar: (signal?: AbortSignal) => request<BangumiCalendarResponse>('/api/bangumi/calendar', { signal }),

  /** 影视热榜（60s API 免 key）：豆瓣周榜五个类目 + 百度热播剧 */
  hotList: (id: string, signal?: AbortSignal) => {
    const sp = new URLSearchParams({ id });
    return request<DoubanResponse>(`/api/hot-list?${sp.toString()}`, { signal });
  },

  /** 换源：按标题跨源搜索并取详情，附带接口耗时（测速）；支持 signal 以便关闭弹窗时中止在途请求 */
  detailSpeed: async (id: string, source: SourceConfig, signal?: AbortSignal) => {
    const start = performance.now();
    try {
      const detail = await api.detail(id, source, signal);
      return { ok: true, ms: Math.round(performance.now() - start), detail };
    } catch (err) {
      return { ok: false, ms: Math.round(performance.now() - start), detail: undefined as VideoDetail | undefined, error: err instanceof Error ? err.message : '失败' };
    }
  },

  /** 点播源探活：以搜索 "test" 的耗时与结果量衡量可用性 */
  testSource: (url: string) =>
    request<{ ok: boolean; ms: number; count?: number; error?: string }>('/api/source/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }),

  /** 拉取远程数据源订阅（自动识别 LibreTV-SourceList JSON 与 TVBOX 配置 JSON） */
  fetchSourceList: (url: string) => {
    const sp = new URLSearchParams({ url });
    return request<SourceListPayload>(`/api/source-list?${sp.toString()}`);
  },

  /** 把源列表发布到公开粘贴板换回订阅链接（走服务端代理：绕开 CORS，且目标域名固定不可控） */
  publishSourceList: (payload: {
    name?: string;
    sources: { name: string; url: string }[];
    liveSources: { name: string; url: string; epg?: string }[];
  }) =>
    request<{ url: string; provider: string; sources: number; liveSources: number }>('/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),

  /** —— 直播 / IPTV —— */

  /**
   * 直播列表（页面主路径）：浏览器直连上游 M3U，网络/CORS/解析失败时自动回退
   * `/api/live/playlist`。10 个预置源都允许跨域，直连可省掉每个列表一次 Worker 请求。
   */
  livePlaylistAuto: (url: string, signal?: AbortSignal) => fetchLivePlaylistDirect(url, signal),

  /** 拉取并解析 M3U 订阅（走服务端代理；测活等需要服务端视角/强制刷新时用），force=1 跳过服务端缓存 */
  livePlaylist: (url: string, force = false, signal?: AbortSignal) =>
    request<LivePlaylistResponse>(livePlaylistApiUrl(url, force), { signal }),

  /** 查询某频道的节目单（服务端缓存 6h） */
  liveEpg: (epgUrl: string, tvgId: string, force = false, signal?: AbortSignal) => {
    const sp = new URLSearchParams({ url: epgUrl, channel: tvgId });
    if (force) sp.set('force', '1');
    return request<LiveEpgResponse>(`/api/live/epg?${sp.toString()}`, { signal });
  },

  /** 直播订阅探活：以拉取解析耗时与频道数衡量可用性 */
  liveTest: async (url: string) => {
    const start = performance.now();
    try {
      const playlist = await api.livePlaylist(url, true);
      return { ok: true, ms: Math.round(performance.now() - start), count: playlist.channels.length, error: undefined as string | undefined };
    } catch (err) {
      return { ok: false, ms: Math.round(performance.now() - start), count: 0, error: err instanceof Error ? err.message : '失败' };
    }
  },

  /** 订阅导出（.m3u）下载地址 */
  liveExportUrl: (url: string) => {
    const sp = new URLSearchParams({ url, format: 'm3u' });
    return `/api/live/playlist?${sp.toString()}`;
  },

  /**
   * 按需测活：点选频道时只探它自己的候选源（服务端单请求最多 8 个 URL，批内并发 16，
   * 一次 invocation 内并行探完）。没有全量测活入口，不要再加回来。
   */
  liveProbe: (urls: string[], signal?: AbortSignal) =>
    request<{ results: LiveProbeResult[] }>(
      '/api/live/probe',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls }),
        signal,
      }
    ),
};

export interface SearchFailure {
  sourceKey: string;
  error: string;
  timedOut?: boolean;
}

/**
 * 单批搜索源上限：每批最多 8 个源。
 * 配合服务端 SEARCH_MAX_PAGES=5，单次 Worker 调用最多产生 8×5=40 个上游子请求，
 * 严格低于 Cloudflare Workers 免费版 50 subrequests 硬上限。
 */
const SEARCH_CHUNK_SIZE = 8;
/** 第二梯队（历史超时/连续失败慢源）相对第一梯队的延后启动毫秒数 */
const SLOW_TIER_DELAY_MS = 250;

/**
 * 基于历史 `sourceHealth` 将源划分为两级并按响应速度升序排列：
 * - fastTier：近期未超时且 failStreak === 0 的快源（未测过的新源按默认 1200ms 排在极快源之后）；
 * - slowTier：近期超时（timedOut）或 failStreak > 0 的慢源，避免在首屏争抢并发连接。
 */
export function partitionSourcesByHealth(
  sources: SourceConfig[],
  healthMap: Record<string, SourceHealthEntry> = {}
): { fastChunks: SourceConfig[][]; slowChunks: SourceConfig[][] } {
  const fast: SourceConfig[] = [];
  const slow: SourceConfig[] = [];

  for (const s of sources) {
    const h = healthMap[s.key];
    if (h && (!h.ok || h.timedOut || h.failStreak > 0)) {
      slow.push(s);
    } else {
      fast.push(s);
    }
  }

  fast.sort((a, b) => {
    const msA = healthMap[a.key]?.ms ?? 1200;
    const msB = healthMap[b.key]?.ms ?? 1200;
    return msA - msB;
  });

  slow.sort((a, b) => {
    const hA = healthMap[a.key];
    const hB = healthMap[b.key];
    const streakDiff = (hA?.failStreak ?? 0) - (hB?.failStreak ?? 0);
    if (streakDiff !== 0) return streakDiff;
    return (hA?.ms ?? 99_999) - (hB?.ms ?? 99_999);
  });

  const chunk = (arr: SourceConfig[]): SourceConfig[][] => {
    const out: SourceConfig[][] = [];
    for (let i = 0; i < arr.length; i += SEARCH_CHUNK_SIZE) {
      out.push(arr.slice(i, i + SEARCH_CHUNK_SIZE));
    }
    return out;
  };

  return {
    fastChunks: chunk(fast),
    slowChunks: chunk(slow),
  };
}

/** 慢源延后启动：可被搜索中止信号打断，不留下悬空定时器 */
function delayWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 单组源的搜索：有 onSource 走 NDJSON 流（逐源回调），否则一次性 JSON */
function searchOnce(
  wd: string,
  sources: SourceConfig[],
  filterAdult: boolean,
  onSource?: (outcome: SourceSearchOutcome) => void,
  signal?: AbortSignal,
  timeoutMs?: number
): Promise<SearchResponse> {
  if (onSource) return searchStream(wd, sources, filterAdult, onSource, signal, timeoutMs);
  return request<SearchResponse>('/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wd, sources, filterAdult, timeoutMs }),
    signal,
  });
}

/**
 * 合并两组结果：按 sourceKey + vodId 去重，再用与单请求一致的全局相关性排序。
 * 服务端每组已经过滤/排序过，但两组之间仍需重新排序，否则第二组会整段排在第一组后面。
 */
function mergeSearchResponses(parts: SearchResponse[], wd: string): SearchResponse {
  const seen = new Set<string>();
  const list: SearchResultItem[] = [];
  for (const part of parts) {
    for (const item of part.list) {
      const key = `${item.sourceKey}_${item.vodId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(item);
    }
  }
  list.sort((a, b) => compareSearchResults(a, b, wd));
  // 分片各自统计，合并后求和；都为 0 时不下发（与服务端「>0 才带字段」一致）
  const filteredAdultCount = parts.reduce((sum, part) => sum + (part.filteredAdultCount ?? 0), 0);
  return filteredAdultCount > 0
    ? { list, failures: parts.flatMap((part) => part.failures), filteredAdultCount }
    : { list, failures: parts.flatMap((part) => part.failures) };
}

/** 聚合搜索流式消费：逐源回调 + 最终聚合结果（NDJSON 行协议） */
async function searchStream(
  wd: string,
  sources: SourceConfig[],
  filterAdult: boolean,
  onSource: (outcome: SourceSearchOutcome) => void,
  signal?: AbortSignal,
  timeoutMs?: number
): Promise<SearchResponse> {
  const res = await fetch('/api/search?stream=1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wd, sources, filterAdult, timeoutMs }),
    signal,
  });
    throwForAuthStatus(res);
    if (!res.ok || !res.body) throw new ApiError(`请求失败 (${res.status})`, res.status);

    // done 事件缺失（流被截断）时退化为空结果，不让整次搜索报错
    let final: SearchResponse = { list: [], failures: [] };
    await consumeNdjson<SearchStreamEvent>(res, (event) => {
      if (event.type === 'source') {
        onSource(event);
      } else if (event.type === 'done') {
        final = {
          list: event.list,
          failures: event.failures,
          filteredAdultCount: event.filteredAdultCount,
        };
      }
    });
    return final;
  }

export type { SearchResponse, SearchResultItem };
