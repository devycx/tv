'use client';

/**
 * 搜索页封面视觉指纹的前端流水线。
 *
 * 浏览器直连图床时 canvas 会被跨域污染，读不到像素；这里通过同源的
 * `/api/cover?url=` 取图（登录后才能用、SSRF 校验在服务端），先按统一画幅（4:5）
 * 中心裁切、**两段缩放**到 9×8 canvas 上算 dHash，再由 aggregateResults 按指纹聚类。
 * 裁切是必须的：整图拉伸会把同一主视觉的 2:3 海报和 9:16（带台标/赞助条）算成两张；
 * 两段缩放也是必须的：一步缩到 9×8 会随压缩噪声产生锯齿，同一张海报的扫描件差 15 位。
 *
 * 性能与降级（2026-11-16 按「庆余年」179 条结果 / 123 张封面的实测调整）：
 * - 每个 URL 只算一次；结果存 IndexedDB（LRU：3000 条 + 1.2MB 双预算，
 *   见 lib/cover-hash-cache.ts），刷新/重复搜索不再取图；
 * - 旧版 `localStorage` 的单键缓存（`cover-visual-hashes-v3`）在首次启动时一次性迁移进
 *   IndexedDB 并删掉旧键：3000 条的整表 JSON 序列化会阻塞主线程，流式搜索期间尤其明显；
 * - 单次搜索最多算 120 张，且**只把预算花在没缓存的封面**上：否则同一关键词反复
 *   搜索永远只算同一批前 48 张，尾部封面永远拿不到指纹（实测 60% 的结果因此被拆卡）；
 * - 并发 8；
 * - 连续 4 张失败后**暂停** 15 秒（不把队列判死），到点自动续跑：图床抖动/代理 5xx
 *   大多是暂时的，一次连败不该让剩下几十条结果没有指纹；
 * - 等待中的封面不会先按片名分组再跳变：调用方用 isPending 把条目暂缓渲染；
 * - 取图/解码失败（isFailed）的条目没有指纹，但**照常展示**（URL/片名兜底）：
 *   代理取不到图不代表浏览器显示不出来（很多图床直连正常、Worker 出网 525）。
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { coverCropRect, dHashFromRgba } from '@/lib/cover-visual-hash';
import { trimHashCache } from '@/lib/cover-hash-cache';
import { loadCoverHashesDb, saveCoverHashesDb } from '@/lib/db';

export type CoverHashState = { status: 'pending' } | { status: 'done'; hash: string } | { status: 'failed' };

/** 旧版 localStorage 缓存键：只用于一次性迁移，迁移后删除 */
const LEGACY_CACHE_KEY = 'cover-visual-hashes-v3';
const MAX_PER_SEARCH = 120;
const MAX_ACTIVE = 8;
const REQUEST_TIMEOUT_MS = 6000;
const BREAKER_FAILURES = 4;
const BREAKER_COOLDOWN_MS = 15_000;
const HASH_HEX = /^[0-9a-f]{16}$/;

const states = new Map<string, CoverHashState>();
const cache = new Map<string, string>();
/** 尚未落盘的指纹（成功算完 / 从旧缓存迁移），800ms 合并成一次 IndexedDB 批量写 */
const dirtyUpserts = new Map<string, string>();
const queue: string[] = [];
const listeners = new Set<() => void>();
/** 图床 CORS 直连结论：避免同一 host 的每个封面都先失败一次再走代理 */
const hostModes = new Map<string, 'cors' | 'proxy'>();
let active = 0;
let version = 0;
let consecutiveFailures = 0;
let breakerUntil = 0;
let persistTimer: ReturnType<typeof setTimeout> | undefined;
let resumeTimer: ReturnType<typeof setTimeout> | undefined;
let dbHydrated = false;

/**
 * 首次使用时把持久化指纹灌进内存 Map：
 * 1. 旧版 localStorage 同步读取（首屏立即可用）并立刻删除旧键，释放 localStorage 空间；
 * 2. IndexedDB 异步读取（不阻塞首屏）。
 */
function hydrateCacheOnce(): void {
  if (typeof window === 'undefined' || dbHydrated) return;
  dbHydrated = true;

  let migrated = false;
  try {
    const raw = window.localStorage.getItem(LEGACY_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [url, hash] of Object.entries(parsed)) {
        if (typeof hash === 'string' && HASH_HEX.test(hash)) {
          cache.set(url, hash);
          dirtyUpserts.set(url, hash);
          migrated = true;
        }
      }
      window.localStorage.removeItem(LEGACY_CACHE_KEY);
    }
  } catch {
    /* 忽略 localStorage 读取异常（隐私模式 / 配额满） */
  }

  if (migrated) {
    schedulePersist();
    // 迁移结果必须通知：调用方在首帧按「未缓存」把这些封面排进待算队列，
    // 不重算 pending 的话，它们会被 isPending 一直隐藏到下一次指纹完成。
    notify();
  }

  // 异步从 IndexedDB 加载持久化指纹
  void loadCoverHashesDb()
    .then((rows) => {
      let added = false;
      for (const [url, hash] of rows) {
        if (HASH_HEX.test(hash) && !cache.has(url)) {
          cache.set(url, hash);
          added = true;
        }
      }
      if (added) notify();
    })
    .catch(() => {});
}

/**
 * 800ms 合并落盘：先按 LRU 双预算淘汰，再把新增/淘汰条目异步批量写进 IndexedDB。
 * 不再同步 JSON.stringify 整张表，流式搜索期间不会卡主线程。
 */
function schedulePersist(): void {
  if (typeof window === 'undefined' || persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    try {
      const beforeKeys = new Set(cache.keys());
      const kept = trimHashCache(cache.entries());
      const keptSet = new Set<string>();
      cache.clear();
      for (const [url, hash] of kept) {
        cache.set(url, hash);
        keptSet.add(url);
      }
      const evicted: string[] = [];
      for (const k of beforeKeys) {
        if (!keptSet.has(k)) {
          evicted.push(k);
          dirtyUpserts.delete(k);
        }
      }
      const upserts = [...dirtyUpserts.entries()];
      dirtyUpserts.clear();
      if (upserts.length > 0 || evicted.length > 0) {
        void saveCoverHashesDb(upserts, evicted).catch(() => {});
      }
    } catch {
      /* 忽略持久化异常 */
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

/** 两段缩放的中间图倍数：先缩到 9×5 × 8×5，再缩到 9×8 */
const HASH_MID_SCALE = 5;

/**
 * 9×8 canvas 上画图取像素；优先 createImageBitmap，Safari 旧版退回 <img>。
 *
 * 必须两段缩放：把 540×770 的大图一步 drawImage 到 9×8 时，浏览器走的是快速滤波，
 * 会随压缩噪声产生锯齿；同一张海报的不同扫描件实测差 **15** 位，超过阈值 10 被拆成两张卡。
 * 先缩到 45×40 再缩到 9×8 后，同一对只差 **1** 位，而不同海报仍在 29–36。
 */
async function hashCoverBlob(blob: Blob): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = 9;
  canvas.height = 8;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('浏览器不支持 canvas 2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const mid = document.createElement('canvas');
  mid.width = 9 * HASH_MID_SCALE;
  mid.height = 8 * HASH_MID_SCALE;
  const midCtx = mid.getContext('2d', { willReadFrequently: true });
  if (!midCtx) throw new Error('浏览器不支持 canvas 2d');
  midCtx.imageSmoothingEnabled = true;
  midCtx.imageSmoothingQuality = 'high';

  const draw = (source: CanvasImageSource, width: number, height: number): string => {
    // 先按统一画幅（4:5）中心裁切：整图拉伸会把「2:3 海报 vs 9:16 同主视觉」算成两张图
    const { sx, sy, sw, sh } = coverCropRect(width, height);
    midCtx.clearRect(0, 0, mid.width, mid.height);
    midCtx.drawImage(source, sx, sy, sw, sh, 0, 0, mid.width, mid.height);
    ctx.clearRect(0, 0, 9, 8);
    ctx.drawImage(mid, 0, 0, mid.width, mid.height, 0, 0, 9, 8);
    return dHashFromRgba(ctx.getImageData(0, 0, 9, 8).data);
  };

  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      try {
        return draw(bitmap, bitmap.width, bitmap.height);
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
    return draw(img, img.naturalWidth, img.naturalHeight);
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

/**
 * 熔断到期后自动续跑队列。
 *
 * 不能像以前那样把队列里剩下的封面一次性标成 failed：那会让一次图床连败直接
 * 让几十张封面没有指纹（页面还会按失败隐藏条目）。这里只暂停、不判死。
 */
function scheduleResume(): void {
  if (typeof window === 'undefined' || resumeTimer) return;
  resumeTimer = setTimeout(() => {
    resumeTimer = undefined;
    if (Date.now() < breakerUntil) {
      scheduleResume();
      return;
    }
    pump();
  }, BREAKER_COOLDOWN_MS + 20);
}

function pump(): void {
  while (active < MAX_ACTIVE && queue.length > 0) {
    if (Date.now() < breakerUntil) {
      scheduleResume();
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
        dirtyUpserts.set(url, hash);
        consecutiveFailures = 0;
        schedulePersist();
        notify();
      })
      .catch(() => {
        states.set(url, { status: 'failed' });
        consecutiveFailures += 1;
        if (consecutiveFailures >= BREAKER_FAILURES) {
          breakerUntil = Date.now() + BREAKER_COOLDOWN_MS;
          scheduleResume();
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
  const state = states.get(url);
  if (state) {
    // 失败不在整个会话里钉死：图床抖动、代理 5xx 大多是暂时的，下一次搜索
    // （isPending 之外的新一轮 plan）会重新排队。
    if (state.status !== 'failed') return;
    states.delete(url);
  }
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
  /**
   * 取图/解码失败：拿不到指纹，但**条目仍应展示**，按 URL/片名兜底分组。
   * 代理取不到图 ≠ 浏览器显示不出来（很多图床直连正常、Worker 出网 525），
   * 是否真的显示不了由卡片自己的 onCoverBroken 判断。
   */
  isFailed: (url?: string) => boolean;
}

/**
 * 为 urls 里的封面算视觉指纹（最多 MAX_PER_SEARCH 张**未缓存**的）。
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
      // 已缓存的封面不占预算：否则预算永远花在同一批前 N 张上，尾部的封面
      // 每次搜索都被跳过、永远拿不到指纹（庆余年 60% 结果被拆卡就是这么来的）。
      if (cachedHash(url)) continue;
      out.push(url);
      if (out.length >= MAX_PER_SEARCH) break;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const plannedSet = useMemo(() => new Set(planned), [planned]);

  useEffect(() => {
    hydrateCacheOnce();
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
      isFailed: (url?: string) => {
        if (!url) return false;
        return states.get(url)?.status === 'failed';
      },
    };
    // currentVersion 变化时重算；planned/key 变化时也重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentVersion, key, planned, plannedSet]);
}
