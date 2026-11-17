/**
 * 搜索结果聚合（纯函数，便于单测）：把扁平的多源结果聚成「一张封面 = 一张卡片」。
 *
 * 身份判定分两层（2026-11-16 用户改口径）：
 * 1. **封面视觉指纹**（浏览器算的 dHash）：同一张图换域名/文件名/分辨率/压缩率 →
 *    同一组，片名/年份不参与拆分；例外是**跨年护栏**：两个条目都带明确四位年份且
 *    不同时，即使共享封面也不并组（防单个采集站挂错年度海报把 1983/2017 版焊死，
 *    见 aggregateResults 里的 rootYear）；
 * 2. **片名 + 年份**再兜一层：同名同年即使封面不同（剧版/影版海报、不同扫描件、
 *    源站配错图）也并进同一组——用户明确要求「同一部片就并到一起，剧版和电影版
 *    并到一张卡也不影响」。
 *
 * 为什么不再「指纹不同就一律拆开」：实测 21 张真实海报两两 dHash 距离中位数 **32**、
 * 最小 24（见 docs/search-cover-aggregation.md §9），「同一部片的两张不同海报」
 * 和「两部不相干的片」完全落在同一区间——把全局阈值从 10 提到 28+ 会随机并掉不相干
 * 的影片，提不到 28 又并不到剧/影。所以阈值留在 10（同图 0–4 vs 不同图 24+，余量最大），
 * 「同片不同海报」交给片名 + 年份这一层。
 *
 * 「电影解说 / 影视解说」这类二创仍然单独成组：它们常直接复用影片海报，若并进正片，
 * 正片的来源列表会混进解说源，封面直达播放也可能播到解说视频。判定放在变体前缀
 * （`f:` 正片 / `c:` 解释）上，两层身份都带这个前缀。
 */

import { normalizeTitle } from './cms-parser';
import { coverFingerprint } from './cover-fingerprint';
import { clusterCoverHashes } from './cover-visual-hash';
import { inferGroupRemarks } from './remarks';
import type { SearchResultItem } from './types';

export interface AggregatedGroup {
  key: string;
  name: string;
  year?: string;
  typeName?: string;
  pic?: string;
  remarks?: string;
  items: SearchResultItem[];
}

export interface AggregateOptions {
  /** 封面 URL → 视觉指纹（dHash）；由页面在浏览器里异步算好后传入 */
  coverHashes?: ReadonlyMap<string, string>;
  /** 两个指纹允许的最大汉明距离，默认见 cover-visual-hash */
  maxHashDistance?: number;
}

/** 二创/解说类内容：与正片分开聚合，避免共用海报时被并进正片的来源列表 */
const COMMENTARY_NAME = /解说|讲解|影评|拉片|速看/;

/** 出现次数最多的值；并列时取列表里先出现的（列表已按相关性排序） */
function mostCommon(values: Array<string | undefined>): string | undefined {
  const counts = new Map<string, { count: number; first: number }>();
  values.forEach((raw, index) => {
    const value = raw?.trim();
    if (!value) return;
    const entry = counts.get(value);
    if (entry) entry.count += 1;
    else counts.set(value, { count: 1, first: index });
  });

  let best: { value: string; count: number; first: number } | undefined;
  for (const [value, entry] of counts) {
    if (!best || entry.count > best.count || (entry.count === best.count && entry.first < best.first)) {
      best = { value, count: entry.count, first: entry.first };
    }
  }
  return best?.value;
}

/**
 * 组标题：优先选「更干净」的写法（不带年份后缀、不带括号附注、更短），
 * 其次看出处数量。源站常给片名追加「2007」「Samsara」「[电影解说]」之类后缀，
 * 同一张封面下按出处数量取多数会选中「色戒2007」这种不适合当标题的写法。
 */
function groupName(items: SearchResultItem[]): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    const name = (item.name || '').trim();
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  const quality = (name: string): number => {
    let score = 0;
    if (!/(?:19|20)\d{2}/.test(name)) score += 3;
    if (!/[[【(（]/.test(name)) score += 2;
    return score - name.length / 200;
  };

  let best: { name: string; count: number; quality: number } | undefined;
  for (const [name, count] of counts) {
    const q = quality(name);
    if (
      !best ||
      q > best.quality ||
      (q === best.quality && count > best.count) ||
      (q === best.quality &&
        count === best.count &&
        (name.length < best.name.length ||
          (name.length === best.name.length && name.localeCompare(best.name, 'zh-Hans-CN') < 0)))
    ) {
      best = { name, count, quality: q };
    }
  }
  return best?.name ?? '';
}

/** 条目的聚合键：视觉指纹优先；其次 URL 指纹；最后「片名 + 年份」 */
function groupKeyOf(
  item: SearchResultItem,
  coverHashes: ReadonlyMap<string, string> | undefined,
  clusters: ReadonlyMap<string, string>
): string {
  const name = (item.name || '').trim();
  const variant = COMMENTARY_NAME.test(name) ? 'c' : 'f';

  const pic = item.pic?.trim();
  const visual = pic ? coverHashes?.get(pic) : undefined;
  if (visual) {
    // 同图不同副本的 dHash 只差几位，用簇代表（字典序最小）作为稳定 key
    return `${variant}:visual:${clusters.get(visual) ?? visual}`;
  }

  const cover = coverFingerprint(pic);
  if (cover) return `${variant}:cover:${cover}`;
  return titleKeyOf(item) ?? '';
}

/**
 * 「片名 + 年份」键：视觉指纹之外的第二次并组。
 *
 * 同名同年一律并到一起（用户 2026-11-16 明确要求，剧版/影版并一张卡也接受）；
 * 跨年不并（《色戒》2002 与 2007 是两部片）。解说（`c:`）与正片（`f:`）不并。
 * 拿不到片名时返回 undefined，不参与并组。
 */
function titleKeyOf(item: SearchResultItem): string | undefined {
  const name = (item.name || '').trim();
  if (!name) return undefined;
  const variant = COMMENTARY_NAME.test(name) ? 'c' : 'f';
  return `${variant}:title:${normalizeTitle(name)}|${(item.year ?? '').trim()}`;
}

function buildGroup(key: string, items: SearchResultItem[]): AggregatedGroup {
  return {
    // key 只由封面/片名决定，不能带 items：流式搜索期间逐源追加结果时 key 必须稳定，
    // 否则 React 会整卡重挂载（展开的来源列表收起、画质探测状态清零）。
    key,
    name: groupName(items),
    year: mostCommon(items.map((item) => item.year)),
    typeName: mostCommon(items.map((item) => item.typeName)),
    pic: items.find((item) => item.pic)?.pic,
    // 同一部剧各源文案详略不同（「全34集」/「完结」/「更新至34集」），推到统一结论
    remarks: inferGroupRemarks(items.map((item) => item.remarks)),
    items,
  };
}

const EXPLICIT_YEAR_RE = /^(?:19|20)\d{2}$/;

/** 只认四位年份：'1983' / '2017'；'未知' / '2023-12' 之类不参与跨年护栏 */
function extractExplicitYear(raw?: string): string | undefined {
  const trimmed = (raw ?? '').trim();
  return EXPLICIT_YEAR_RE.test(trimmed) ? trimmed : undefined;
}

/**
 * 按「封面视觉指纹」+「片名 + 年份」两层身份聚合搜索结果。
 * 返回顺序沿用传入顺序（搜索结果已按相关性排序），组的位置取组内第一条出现的位置。
 */
export function aggregateResults(
  list: SearchResultItem[],
  options: AggregateOptions = {}
): AggregatedGroup[] {
  const { coverHashes, maxHashDistance } = options;
  const clusters =
    coverHashes && coverHashes.size > 0
      ? clusterCoverHashes(coverHashes.values(), maxHashDistance)
      : new Map<string, string>();

  const named = list.filter((item) => (item.name || '').trim());
  if (named.length === 0) return [];

  /**
   * 并查集：每个条目先有 primary 键（视觉/URL/片名指纹），再把 primary 和
   * 「片名 + 年份」键连起来——同名同年的不同封面因此进同一组。
   *
   * 根取**先出现**的键：流式搜索是按源追加结果的，取最早出现的键能保证已有分组
   * 的 key 不因后续条目而改变（key 变了 React 会整卡重挂载）。
   *
   * 跨年护栏（2026-11-18）：连通分量记录已确认的四位年份，两个根年份不同时
   * 拒绝合并。单个采集站把 2017 版的封面错挂成 1983 版海报时，共享封面节点
   * 不再把两个年代焊死在同一组（1983 版与 2017 版《射雕英雄传》必须分开）。
   */
  const parent = new Map<string, string>();
  const seenAt = new Map<string, number>();
  /**
   * 每个连通分量根节点的已确认四位年份：
   * 若两个根均已携带明确四位年份且不相等（如 '1983' !== '2017'），
   * 则严禁通过共享封面（visual/cover）合并，防止单个采集站错配海报导致跨年传递并组。
   */
  const rootYear = new Map<string, string>();
  let seq = 0;

  const add = (key: string, explicitYear?: string): void => {
    if (!parent.has(key)) {
      parent.set(key, key);
      seenAt.set(key, seq++);
      if (explicitYear) rootYear.set(key, explicitYear);
    } else if (explicitYear) {
      const root = find(key);
      if (!rootYear.has(root)) rootYear.set(root, explicitYear);
    }
  };

  const find = (key: string): string => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    let cur = key;
    while (cur !== root) {
      const next = parent.get(cur) as string;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };

  const union = (a: string, b: string): boolean => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return true;

    const yearA = rootYear.get(rootA);
    const yearB = rootYear.get(rootB);
    if (yearA && yearB && yearA !== yearB) {
      // 跨年冲突护栏：拒绝通过脏封面桥接两个不同年份的连通分量
      return false;
    }

    const [keep, drop] =
      (seenAt.get(rootA) ?? 0) <= (seenAt.get(rootB) ?? 0) ? [rootA, rootB] : [rootB, rootA];
    parent.set(drop, keep);
    const mergedYear = yearA ?? yearB;
    if (mergedYear) rootYear.set(keep, mergedYear);
    return true;
  };

  const primaryOf = (item: SearchResultItem): string => groupKeyOf(item, coverHashes, clusters);
  /** 记录每个条目最终绑定的归组键（当封面与已有年份冲突时退回 titleKey） */
  const itemBoundKey = new WeakMap<SearchResultItem, string>();

  for (const item of named) {
    const itemYear = extractExplicitYear(item.year);
    const primary = primaryOf(item);
    const titleKey = titleKeyOf(item);

    if (titleKey) {
      add(titleKey, itemYear);
    }

    // 检查 primary 所在连通分量是否已被其他年份占用
    if (parent.has(primary)) {
      const existingRootYear = rootYear.get(find(primary));
      if (existingRootYear && itemYear && existingRootYear !== itemYear && titleKey) {
        // 当前条目的封面与已有连通分量发生跨年冲突（脏图），仅绑定到自身的 titleKey
        itemBoundKey.set(item, titleKey);
        continue;
      }
    }

    add(primary, itemYear);
    if (titleKey) {
      const merged = union(primary, titleKey);
      itemBoundKey.set(item, merged ? primary : titleKey);
    } else {
      itemBoundKey.set(item, primary);
    }
  }

  const buckets = new Map<string, SearchResultItem[]>();
  for (const item of named) {
    const bound = itemBoundKey.get(item) ?? primaryOf(item);
    const key = find(bound);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }

  return [...buckets].map(([key, items]) => buildGroup(key, items));
}
