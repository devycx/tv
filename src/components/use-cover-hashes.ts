'use client';

/**
 * 搜索页封面视觉指纹的前端流水线。
 *
 * 浏览器直连图床时 canvas 会被跨域污染，读不到像素；这里通过同源的
 * `/api/cover?url=` 取图（登录后才能用、SSRF 校验在服务端），画到 9×8 canvas 上
 * 算 dHash，再由 aggregateResults 按指纹聚类。
 *
 * 性能与降级：
 * - 每个 URL 只算一次；结果存 localStorage（600 条上限），刷新/重复搜索不再取图；
 * - 单次搜索最多算 48 张（按结果顺序取前面的），其余走 URL 指纹兜底；
 * - 并发 5；连续 4 张失败后熔断 60 秒，避免图床/代理不可用时几十个请求排队；
 * - 等待中的封面不会先按片名分组再跳变：调用方用 isPending 把条目暂缓渲染。
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { dHashFromRgba } from '@/lib/cover-visual-hash';

export type CoverHashState = { status: 'pending' } | { status: 'done'; hash: string } | { status: 'failed' };

const CACHE_KEY = 'cover-visual-hashes-v1';
const MAX_CACHED = 600;
const MAX_PER_SEARCH = 48;
const MAX_ACTIVE = 5;
const REQUEST_TIMEOUT_MS = 6000;
const BREAKER_FAILURES = 4;
const BREAKER_COOLDOWN_MS = 60_000;
const HASH_HEX = /^[0-9a-f]{16}$/;

const states = new Map<string, CoverHashState>();
const cache = loadCache();
const queue: string[] = [];
const listeners = new Set<() => void>();
/** 图床 CORS 直连结论：避免同一 host 的每个封面都先失败一次再走代理 */
const hostModes = new Map<string, 'cors' | 'proxy'>();
let active = 0;
let version = 0;
let consecutiveFailures = 0;
let breakerUntil = 0;
let persistTimer: ReturnType<typeof setTimeout> | undefined;

function loadCache(): Map<string, string> {
  const map = new Map<string, string>();
  if (typeof window === 'undefined') return map;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return map;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [url, hash] of Object.entries(parsed)) {
      if (typeof hash === 'string' && HASH_HEX.test(hash)) map.set(url, hash);
    }
  } catch {
    // 隐私模式 / 配额满：当作没有缓存
  }
  return map;
}

function schedulePersist(): void {
  if (typeof window === 'undefined' || persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    try {
      while (cache.size > MAX_CACHED) {
        const oldest = cache.keys().next().value;
        if (typeof oldest !== 'string') break;
        cache.delete(oldest);
      }
      window.localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(cache)));
    } catch {
      // 写不进去就只保留内存缓存
    }
  }, 800);
}

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getVersion(): number {
  return version;
}

function cachedHash(url: string): string | undefined {
  const hash = cache.get(url);
  return hash && HASH_HEX.test(hash) ? hash : undefined;
}

/** 9×8 canvas 上画图取像素；优先 createImageBitmap，Safari 旧版退回 <img> */
async function hashCoverBlob(blob: Blob): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = 9;
  canvas.height = 8;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('浏览器不支持 canvas 2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const draw = (source: CanvasImageSource): string => {
    ctx.clearRect(0, 0, 9, 8);
    ctx.drawImage(source, 0, 0, 9, 8);
    return dHashFromRgba(ctx.getImageData(0, 0, 9, 8).data);
  };

  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      try {
        return draw(bitmap);
      } finally {
        bitmap.close?.();
      }
    } catch {
      // 少数格式（如 SVG）createImageBitmap 会拒绝：退回 <img> 解码
    }
  }

  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = objectUrl;
    await img.decode();
    return draw(img);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function hashCoverUrl(url: string): Promise<string> {
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return undefined;
    }
  })();
  const mode = host ? hostModes.get(host) : undefined;

  // 不少图床允许浏览器 CORS 直连，但 Cloudflare Worker 出网会 525（源站 TLS 握手失败）。
  // 先试浏览器直连，按 host 记住结论；CORS 失败/非 2xx 再退回同源代理。
  if (host && mode !== 'proxy' && /^https:/i.test(url)) {
    try {
      const direct = await fetch(url, {
        mode: 'cors',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (direct.ok) {
        const blob = await direct.blob();
        // 直连可能拿到防盗链 HTML/占位图（200 但不是图片）：解码失败时仍走代理
        if (blob.type.startsWith('image/')) {
          try {
            const hash = await hashCoverBlob(blob);
            hostModes.set(host, 'cors');
            return hash;
          } catch {
            // 坏图/无法解码：退回代理
          }
        }
      }
    } catch {
      // CORS / 网络失败：走代理
    }
    hostModes.set(host, 'proxy');
  }

  const res = await fetch(`/api/cover?url=${encodeURIComponent(url)}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    credentials: 'same-origin',
  });
  if (!res.ok) throw new Error(`封面取图失败 (${res.status})`);
  return hashCoverBlob(await res.blob());
}

function drainQueue(): void {
  while (queue.length > 0) {
    const url = queue.shift();
    if (!url) break;
    states.set(url, { status: 'failed' });
  }
}

function pump(): void {
  while (active < MAX_ACTIVE && queue.length > 0) {
    if (Date.now() < breakerUntil) {
      drainQueue();
      notify();
      return;
    }
    const url = queue.shift();
    if (!url) return;
    active += 1;
    hashCoverUrl(url)
      .then((hash) => {
        states.set(url, { status: 'done', hash });
        cache.delete(url); // 重新插入到末尾，LRU 淘汰时先丢最久没用的
        cache.set(url, hash);
        consecutiveFailures = 0;
        schedulePersist();
        notify();
      })
      .catch(() => {
        states.set(url, { status: 'failed' });
        consecutiveFailures += 1;
        if (consecutiveFailures >= BREAKER_FAILURES) {
          breakerUntil = Date.now() + BREAKER_COOLDOWN_MS;
          drainQueue();
        }
        notify();
      })
      .finally(() => {
        active -= 1;
        pump();
      });
  }
}

function ensure(url: string): void {
  if (states.has(url)) return;
  const cached = cachedHash(url);
  if (cached) {
    states.set(url, { status: 'done', hash: cached });
    return;
  }
  states.set(url, { status: 'pending' });
  queue.push(url);
  pump();
}

export interface CoverHashes {
  /** 完成计数（完成/失败都会 +1），用于让页面重新计算分组 */
  version: number;
  /** 本次计划内还没结论的封面数 */
  pending: number;
  hashOf: (url?: string) => string | undefined;
  /** 该封面是否仍在等待指纹：调用方应暂缓渲染该条目，避免先按片名分组后再跳变 */
  isPending: (url?: string) => boolean;
}

/**
 * 为 urls 里的封面算视觉指纹（最多 MAX_PER_SEARCH 张）。
 * 返回值随指纹完成而更新；调用方把 isPending 的条目从聚合输入里剔除。
 */
export function useCoverHashes(urls: readonly string[]): CoverHashes {
  const currentVersion = useSyncExternalStore(subscribe, getVersion, () => 0);

  // urls 每次搜索/流式追加都会是新数组：用内容做依赖，避免 effect 每帧重跑
  const key = urls.join('\n');
  const planned = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const url of urls) {
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push(url);
      if (out.length >= MAX_PER_SEARCH) break;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const plannedSet = useMemo(() => new Set(planned), [planned]);

  useEffect(() => {
    for (const url of planned) ensure(url);
    // planned 由 key 派生；key 不变时不需要重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return useMemo(() => {
    const pending = planned.filter((url) => {
      const state = states.get(url);
      if (state?.status === 'done' || state?.status === 'failed') return false;
      return !cachedHash(url);
    }).length;

    return {
      version: currentVersion,
      pending,
      hashOf: (url?: string) => {
        if (!url) return undefined;
        const state = states.get(url);
        if (state?.status === 'done') return state.hash;
        return state?.status === 'failed' ? undefined : cachedHash(url);
      },
      isPending: (url?: string) => {
        if (!url || !plannedSet.has(url)) return false;
        const state = states.get(url);
        if (state?.status === 'done' || state?.status === 'failed') return false;
        return !cachedHash(url);
      },
    };
    // currentVersion 变化时重算；planned/key 变化时也重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentVersion, key, planned, plannedSet]);
}
