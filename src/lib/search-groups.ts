/**
 * 搜索结果的零网络聚合：封面 URL 指纹优先，片名 + 年份兜底。
 *
 * 不再取图、解码或计算 dHash。两个身份层仍通过并查集连通，因此同封面可跨片名/
 * 年份合并，同名同年也可跨不同海报合并；电影解说等变体沿用现有产品口径。
 */

import { normalizeTitle } from './cms-parser';
import { coverFingerprint } from './cover-fingerprint';
import { inferGroupRemarks } from './remarks';
import { isCommentaryName } from './search-variants';
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

const QUALITY_LABEL = '(?:hd|4k|2160p|1080p|720p|蓝光|国语|中字|tc|ts)';
const BRACKETED_QUALITY_SUFFIX = new RegExp(
  `[\\[【(（]\\s*${QUALITY_LABEL}(?:[\\s_\\-/|]+${QUALITY_LABEL})*\\s*[\\]】)）]\\s*$`,
  'iu'
);
const PLAIN_QUALITY_SUFFIX = new RegExp(`(?:\\s+|[._\\-—–|/\\\\]+)${QUALITY_LABEL}\\s*$`, 'iu');

/**
 * 聚合专用片名归一：只剥离末尾清晰度/音轨标签，不改变搜索相关性使用的 normalizeTitle。
 * 季数、年番、特别篇、剧场版、导演剪辑版等作品区分词一律保留。
 */
export function normalizeGroupTitle(raw: string): string {
  let title = raw.trim();
  // 多个标签常连写（如「片名[4K][国语]」），每次只剥最末一个，设置上限防御异常输入。
  for (let i = 0; i < 6; i += 1) {
    const next = title.replace(BRACKETED_QUALITY_SUFFIX, '').replace(PLAIN_QUALITY_SUFFIX, '').trim();
    if (next === title) break;
    title = next;
  }
  return normalizeTitle(title);
}

/** 出现次数最多的值；并列时取列表里先出现的（列表已按相关性排序）。 */
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

/** 组标题优先「不带年份/括号附注、更短」的写法，其次看出处数量。 */
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

function titleKeyOf(item: SearchResultItem): string | undefined {
  const name = (item.name || '').trim();
  if (!name) return undefined;
  const variant = isCommentaryName(name) ? 'c' : 'f';
  return `${variant}:title:${normalizeGroupTitle(name)}|${(item.year ?? '').trim()}`;
}

function coverKeyOf(item: SearchResultItem): string | undefined {
  const cover = coverFingerprint(item.pic);
  return cover ? `cover:${cover}` : undefined;
}

/** URL 指纹优先；没有封面时退回片名 + 年份。 */
function groupKeyOf(item: SearchResultItem): string {
  return coverKeyOf(item) ?? titleKeyOf(item) ?? '';
}

/**
 * 封面取输入顺序中第一个正片来源：首轮结果先于扩搜结果，因此高优 Tier 1 的图
 * 不会被后到的 Tier 2 抢走；没有正片时才使用变体封面。
 */
function groupCover(items: SearchResultItem[]): string | undefined {
  const withPic = items.filter((item) => item.pic?.trim());
  const main = withPic.find((item) => !isCommentaryName(item.name));
  return (main ?? withPic[0])?.pic;
}

function buildGroup(key: string, items: SearchResultItem[]): AggregatedGroup {
  return {
    key,
    name: groupName(items),
    year: mostCommon(items.map((item) => item.year)),
    typeName: mostCommon(items.map((item) => item.typeName)),
    pic: groupCover(items),
    remarks: inferGroupRemarks(items.map((item) => item.remarks)),
    items,
  };
}

/** 纯函数聚合，返回顺序沿用输入中各组第一次出现的位置。 */
export function aggregateResults(list: SearchResultItem[]): AggregatedGroup[] {
  const named = list.filter((item) => (item.name || '').trim());
  if (named.length === 0) return [];

  const parent = new Map<string, string>();
  const seenAt = new Map<string, number>();
  let seq = 0;

  const add = (key: string): void => {
    if (!parent.has(key)) {
      parent.set(key, key);
      seenAt.set(key, seq++);
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
  const union = (a: string, b: string): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return;
    const [keep, drop] = (seenAt.get(rootA) ?? 0) <= (seenAt.get(rootB) ?? 0) ? [rootA, rootB] : [rootB, rootA];
    parent.set(drop, keep);
  };

  for (const item of named) {
    const primary = groupKeyOf(item);
    add(primary);
    const titleKey = titleKeyOf(item);
    if (!titleKey) continue;
    add(titleKey);
    union(primary, titleKey);
  }

  const buckets = new Map<string, SearchResultItem[]>();
  for (const item of named) {
    const key = find(groupKeyOf(item));
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }
  return [...buckets].map(([key, items]) => buildGroup(key, items));
}

function itemId(item: SearchResultItem): string {
  return `${item.sourceKey}_${item.vodId}`;
}

/**
 * 把按需扩搜结果并入首轮分组，且绝不桥接、删除或重排首轮卡片。
 *
 * 直接对两批结果重新跑并查集会让一个 Tier 2 条目把两个 Tier 1 组连成一组，
 * 导致前排卡片突然塌陷。这里改为分组级合并：封面匹配优先，其次片名年份；
 * 命中多个旧组时只选第一个，不改旧组身份。纯新增组按扩搜顺序追加到末尾。
 */
export function mergeExpandedGroups(
  baseGroups: readonly AggregatedGroup[],
  expandedItems: readonly SearchResultItem[]
): AggregatedGroup[] {
  const groups = baseGroups.map((group) => ({ ...group, items: [...group.items] }));
  const coverOwner = new Map<string, number>();
  const titleOwner = new Map<string, number>();
  const usedItems = new Set<string>();
  const usedGroupKeys = new Set<string>();

  const register = (index: number, items: readonly SearchResultItem[]): void => {
    for (const item of items) {
      usedItems.add(itemId(item));
      const cover = coverKeyOf(item);
      const title = titleKeyOf(item);
      if (cover && !coverOwner.has(cover)) coverOwner.set(cover, index);
      if (title && !titleOwner.has(title)) titleOwner.set(title, index);
    }
  };
  groups.forEach((group, index) => {
    usedGroupKeys.add(group.key);
    register(index, group.items);
  });

  const uniqueExpanded: SearchResultItem[] = [];
  for (const item of expandedItems) {
    const id = itemId(item);
    if (usedItems.has(id)) continue;
    usedItems.add(id);
    uniqueExpanded.push(item);
  }

  for (const expanded of aggregateResults(uniqueExpanded)) {
    let target: number | undefined;
    for (const item of expanded.items) {
      const cover = coverKeyOf(item);
      const owner = cover ? coverOwner.get(cover) : undefined;
      if (owner !== undefined) {
        target = owner;
        break;
      }
    }
    if (target === undefined) {
      for (const item of expanded.items) {
        const title = titleKeyOf(item);
        const owner = title ? titleOwner.get(title) : undefined;
        if (owner !== undefined) {
          target = owner;
          break;
        }
      }
    }

    if (target !== undefined) {
      const current = groups[target];
      const merged = buildGroup(current.key, [...current.items, ...expanded.items]);
      groups[target] = {
        ...merged,
        // 已上屏卡片只增加来源数；标题与展示元数据不被长尾源改写。
        name: current.name,
        year: current.year,
        typeName: current.typeName,
        pic: current.pic,
        remarks: current.remarks,
      };
      register(target, expanded.items);
      continue;
    }

    let key = expanded.key;
    while (usedGroupKeys.has(key)) key = `expanded:${key}`;
    usedGroupKeys.add(key);
    groups.push({ ...expanded, key });
    register(groups.length - 1, expanded.items);
  }

  return groups;
}
