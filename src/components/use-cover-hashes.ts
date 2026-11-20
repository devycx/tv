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
 * - **先等 IndexedDB hydrate 完再规划预算**（2026-11-19）：首帧内存缓存是空的，
 *   如果立刻按「未缓存」排队，会把 120 张预算全花在已缓存的旧封面上，
 *   新封面排在 120 个请求之后——表现就是「刷新后第一次搜索一直灰屏，再搜一次才正常」；
 * - 单次搜索最多算 120 张，且只把预算花在没缓存的封面上；
 * - 并发 8；同 host 只放一个 CORS 直连探测，其余直接走代理（一个坏图床不能
 *   让 8 个并发一起等 6s）；同 host 连续失败 3 次后暂停 30s；
 * - 通知按 120ms 合并（队列清空时立即 flush）：不能让「每算完一张」都触发页面
 *   全量重算分组/筛选，滚动时那是主要掉帧源；
 * - 解码时让浏览器降采样到指纹够用的尺寸（保宽高比），避免全尺寸解码抢主线程；
 * - 单张封面有 15s 总预算：fetch 有 6s 超时，但 createImageBitmap / img.decode
 *   在少数坏图上可能永远不返回，没有总超时会让 8 个槽位全挂住、队列停摆；
 * - 等待中的封面不会先按片名分组再跳变：调用方用 isPending 把条目暂缓渲染，
 *   但 page.tsx 有 2.5s 兜底，不会让坏图床无限期扣住整页结果；
 * - 取图/解码失败（isFailed）的条目没有指纹，但**照常展示**（URL/片名兜底）：
 *   代理取不到图不代表浏览器显示不出来（很多图床直连正常、Worker 出网 525）。
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { coverCropRect, dHashFromRgba } from '@/lib/cover-visual-hash';
import { trimHashCache } from '@/lib/cover-hash-cache';
import { loadCoverHashesDb, saveCoverHashesDb } from '@/lib/db';

export type CoverHashState = { status: 'pending' } | { status: 'done'; hash: string } | { status: 'failed' };

/** 旧版 localStorage 缓存键：只用于一次性迁移，迁移后删除 */
const LEGACY_CACHE_KEY = 'cover-visual-hashes-v3';
const MAX_PER_SEARCH = 120;
/**
 * 并发上限保持 8：解码已经在 decodeCoverBitmap 里交给浏览器降采样
 * （1~3MB 原图不再全尺寸解到主线程），单张成本比原来低，8 个并发不会
 * 和渲染帧抢时间；再往下压只会让 120 张的队列多等一倍时间。
 */
const MAX_ACTIVE = 8;
/**
 * 合并通知窗口：单张封面完成/失败不再立刻 notify（那会让页面每算完一张就全量
 * 重算 aggregateResults + buildFacets + filterGroups），120ms 内合并成一次；
 * 队列清空时立即 flush，避免最后一张要等一个窗口才上屏。
 */
const NOTIFY_BATCH_MS = 120;
/**
 * 单张封面的取图超时。
 *
 * 2026-11-20 从 6s 收到 3s：指纹现在是首页首屏的闸门（等齐再画），冷搜实测
 * 每张 /api/cover 的 p50 ≈ 1.2s、p90 ≈ 2s，只有坏图床/黑洞请求才会拖到 6s；
 * 这类请求白占并发槽位，把首屏拖过 3s 上限。3s 还没拿到就当失败——失败也是
 * 结论，条目照常展示（按 URL/片名兜底），下次搜索会重新尝试。
 */
const REQUEST_TIMEOUT_MS = 3000;
/**
 * 单张封面的总预算（取图 + 解码 + 算 dHash）。
 * fetch 自身有 6s 超时，但 createImageBitmap / img.decode 在少数坏图上可能永远
 * 不返回；没有这层兜底时，8 个 active 槽位一旦全被挂住，整个队列就停摆
 * （pending 永远 > 0，页面停在骨架屏）。
 */
const HASH_TIMEOUT_MS = 15_000;/** 同一个图床连续失败几次后暂时跳过（只影响指纹取图，不影响卡片封面直连） */
const HOST_FAILURE_LIMIT = 3;
const HOST_DEAD_MS = 30_000;
const HASH_HEX = /^[0-9a-f]{16}$/;

const states = new Map<string, CoverHashState>();
const cache = new Map<string, string>();
/** 尚未落盘的指纹（成功算完 / 从旧缓存迁移），800ms 合并成一次 IndexedDB 批量写 */
const dirtyUpserts = new Map<string, string>();
const queue: string[] = [];
const listeners = new Set<() => void>();
/** 图床 CORS 直连结论：避免同一 host 的每个封面都先失败一次再走代理 */
const hostModes = new Map<string, 'cors' | 'proxy' | 'probing'>();
const hostFailures = new Map<string, number>();
const hostDeadUntil = new Map<string, number>();
let active = 0;
let version = 0;
let persistTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * IndexedDB 缓存的一次性 hydrate。放在 Promise 里而不是同步布尔：
 * 调用方要等它完成后再规划指纹预算，否则会把已缓存的封面当新封面重新排队。
 */
let hydration: Promise<void> | undefined;

/**
 * 首次使用时把持久化指纹灌进内存 Map：
 * 1. 旧版 localStorage 同步读取（首屏立即可用）并立刻删除旧键，释放 localStorage 空间；
 * 2. IndexedDB 异步读取（不阻塞首屏，但会决定本轮预算怎么排）。
 *
 * 返回的 Promise 在两层都读完（或失败）后 resolve；重复调用复用同一个 Promise。
 */
function hydrateCacheOnce(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (hydration) return hydration;

  hydration = (async () => {
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

    if (migrated) schedulePersist();

    try {
      const rows = await loadCoverHashesDb();
      let added = false;
      for (const [url, hash] of rows) {
        if (HASH_HEX.test(hash) && !cache.has(url)) {
          cache.set(url, hash);
          added = true;
        }
      }
      if (added || migrated) notify();
    } catch {
      if (migrated) notify();
    }
  })();

  return hydration;
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

let notifyTimer: ReturnType<typeof setTimeout> | undefined;

function notify(): void {
  if (notifyTimer) {
    clearTimeout(notifyTimer);
    notifyTimer = undefined;
  }
  version += 1;
  for (const listener of listeners) listener();
}

/**
 * 合并通知：一次搜索要算 60~120 张封面，每张都 notify 会让页面把
 * aggregateResults / buildFacets / filterGroups 全量跑几十遍（滚动时就是掉帧源）。
 * 进行中每 NOTIFY_BATCH_MS 合并一次；队列清空时传 immediate 立刻 flush。
 */
function scheduleNotify(immediate: boolean): void {
  if (immediate) {
    notify();
    return;
  }
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = undefined;
    notify();
  }, NOTIFY_BATCH_MS);
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

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function isHostDead(host: string): boolean {
  const until = hostDeadUntil.get(host);
  if (!until) return false;
  if (until > Date.now()) return true;
  hostDeadUntil.delete(host);
  return false;
}

function recordHostFailure(host: string): void {
  const failures = (hostFailures.get(host) ?? 0) + 1;
  hostFailures.set(host, failures);
  if (failures >= HOST_FAILURE_LIMIT) hostDeadUntil.set(host, Date.now() + HOST_DEAD_MS);
}

function recordHostSuccess(host: string): void {
  hostFailures.delete(host);
  hostDeadUntil.delete(host);
}

/** 两段缩放的中间图倍数：先缩到 9×5 × 8×5，再缩到 9×8 */
const HASH_MID_SCALE = 5;

/**
 * 解码封面并让浏览器直接降采样：**聚类用的 dHash 完全基于这张降采样后的 bitmap**。
 *
 * 不按 doc 里写的 resize 成 9×8：这张 bitmap 之后还要按 4:5 中心裁切
 * （见 hashCoverBlob），9×8 已经把画幅压变形，裁切会失去意义。只指定 resizeWidth、
 * 让浏览器保持原始宽高比，裁切口径不变，后续仍是「裁切 → 45×40 → 9×8」两段缩放。
 *
 * 95px 宽是实测选的：与全尺寸解码的结果比，同一张封面 dHash 只差 0–3 位
 * （2026-11-20 线上 4 张真实海报：2/0/3/1 位；48px 会到 2–6 位），
 * 远小于聚类阈值 10，所以降采样不会改变「同一张封面并卡」的结论，
 * 也不会让 IndexedDB 里的旧指纹和新指纹被拆开。
 *
 * Safari / 旧浏览器不支持 resize 选项时会直接抛错，退回整图解码。
 */
async function decodeCoverBitmap(blob: Blob): Promise<ImageBitmap> {
  const options: ImageBitmapOptions = { resizeWidth: 95, resizeQuality: 'low' };
  try {
    return await createImageBitmap(blob, options);
  } catch {
    return await createImageBitmap(blob);
  }
}

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
      const bitmap = await decodeCoverBitmap(blob);
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

/**
 * CORS 直连探测的超时：比正式取图短得多。
 *
 * 探测只回答「这个 host 能不能浏览器直连」，失败就走同源代理，代价只是多一次代理。
 * 坏图床/被墙 host 的 CORS 握手会一直挂到超时，而探测占着并发槽位——冷搜首屏
 * 现在要等指纹齐全，探测挂 3s 会让 8 个槽位排出好几轮。1.5s 足够快 host 成功，
 * 慢 host 直接判给代理。
 */
const PROBE_TIMEOUT_MS = 1500;

/** 浏览器 CORS 直连取图并算指纹；拿不到图片像素时返回 undefined（交给代理） */
async function tryDirectHash(url: string): Promise<string | undefined> {
  const direct = await fetch(url, {
    mode: 'cors',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (!direct.ok) return undefined;
  const blob = await direct.blob();
  // 直连可能拿到防盗链 HTML/占位图（200 但不是图片）：交给代理重试
  if (!blob.type.startsWith('image/')) return undefined;
  return hashCoverBlob(blob);
}

async function hashCoverUrl(url: string): Promise<string> {
  const host = hostOf(url);
  if (host && isHostDead(host)) throw new Error('封面图床暂时不可用');

  // 不少图床允许浏览器 CORS 直连，但 Cloudflare Worker 出网会 525（源站 TLS 握手失败）。
  // 先试浏览器直连，按 host 记住结论；CORS 失败/非 2xx 再退回同源代理。
  //
  // 同一 host 只放一个直连探测在飞：8 个并发同时等 CORS 超时，一个坏图床就能
  // 把首屏灰屏时间拉到十几秒。探测期间其余 URL 直接走代理，代理通常更快且能成功。
  const mode = host ? hostModes.get(host) : undefined;
  if (host && /^https:/i.test(url) && mode !== 'proxy' && mode !== 'probing') {
    hostModes.set(host, 'probing');
    try {
      const hash = await tryDirectHash(url);
      if (hash) {
        hostModes.set(host, 'cors');
        return hash;
      }
      hostModes.set(host, 'proxy');
    } catch {
      // CORS / 网络失败 / 坏图：走代理
      hostModes.set(host, 'proxy');
    }
  }

  const res = await fetch(`/api/cover?url=${encodeURIComponent(url)}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    credentials: 'same-origin',
  });
  if (!res.ok) throw new Error(`封面取图失败 (${res.status})`);
  const hash = await hashCoverBlob(await res.blob());
  // 探针仍在飞时走了代理并成功：后续同 host 继续走代理即可，不再重复等直连
  if (host && hostModes.get(host) === 'probing') hostModes.set(host, 'proxy');
  return hash;
}

/** 给单张封面加总超时：解码挂住时不能把并发槽位一起带走 */
function hashCoverWithDeadline(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('封面指纹超时')), HASH_TIMEOUT_MS);
    hashCoverUrl(url).then(
      (hash) => {
        clearTimeout(timer);
        resolve(hash);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function pump(): void {
  while (active < MAX_ACTIVE && queue.length > 0) {
    const url = queue.shift();
    if (!url) return;

    const cached = cachedHash(url);
    if (cached) {
      // IndexedDB 在首帧排完队之后才 hydrate 完：已缓存的封面不再重新取图。
      // 否则预算会先花在 120 个旧封面上，新封面要等它们全部跑完才轮到。
      states.set(url, { status: 'done', hash: cached });
      scheduleNotify(active === 0 && queue.length === 0);
      continue;
    }

    const host = hostOf(url);
    active += 1;
    // 这一张做完后是否就空闲了：是则立刻通知，否则走 120ms 合并窗口
    const lastOneInFlight = () => active === 1 && queue.length === 0;
    hashCoverWithDeadline(url)
      .then((hash) => {
        states.set(url, { status: 'done', hash });
        cache.delete(url); // 重新插入到末尾，LRU 淘汰时先丢最久没用的
        cache.set(url, hash);
        dirtyUpserts.set(url, hash);
        if (host) recordHostSuccess(host);
        schedulePersist();
        scheduleNotify(lastOneInFlight());
      })
      .catch(() => {
        states.set(url, { status: 'failed' });
        if (host) recordHostFailure(host);
        scheduleNotify(lastOneInFlight());
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
  const [ready, setReady] = useState(false);

  // 必须先读完 IndexedDB 再规划：首帧 cache 是空的，直接规划会把已缓存的
  // 封面全部当成新封面（刷新后第一次搜索灰屏、第二次才正常的根因）。
  useEffect(() => {
    let alive = true;
    void hydrateCacheOnce().then(() => {
      if (alive) setReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  // urls 每次搜索/流式追加都会是新数组：用内容做依赖，避免 effect 每帧重跑
  const key = urls.join('\n');
  const planned = useMemo(() => {
    if (!ready) return [];
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
  }, [key, ready]);
  const plannedSet = useMemo(() => new Set(planned), [planned]);

  useEffect(() => {
    if (!ready) return;
    for (const url of planned) ensure(url);
    // planned 由 key + ready 派生；key 不变时不需要重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready]);

  return useMemo(() => {
    const pending = ready
      ? planned.filter((url) => {
          const state = states.get(url);
          if (state?.status === 'done' || state?.status === 'failed') return false;
          return !cachedHash(url);
        }).length
      : urls.length > 0
        ? 1
        : 0;

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
        // hydrate 完成前一律按 pending 处理：这时候没法判断哪些封面已有缓存，
        // 先渲染再分组会整页跳变；IndexedDB 读取通常只有几十毫秒。
        if (!url) return false;
        if (!ready) return true;
        if (!plannedSet.has(url)) return false;
        const state = states.get(url);
        if (state?.status === 'done' || state?.status === 'failed') return false;
        return !cachedHash(url);
      },
      isFailed: (url?: string) => {
        if (!url) return false;
        return states.get(url)?.status === 'failed';
      },
    };
    // currentVersion 变化时重算；planned/key/ready 变化时也重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentVersion, key, planned, plannedSet, ready, urls.length]);
}
