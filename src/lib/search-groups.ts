/**
 * 搜索结果聚合（纯函数，便于单测）：把扁平的多源结果聚成「一张封面 = 一张卡片」。
 *
 * 旧版只按「片名 + 年份」分桶。搜「色戒」时，若多个采集站都把不同影片标成
 * 「色戒 / 2007」，它们会被并成一张「6 源」的卡：封面只显示其中一部，点开却可能
 * 播到另一部；反过来，同一部片被源站写成不同片名/年份时又会拆成好几张重复卡。
 *
 * 现在以**封面视觉指纹**为第一身份（指纹由浏览器对封面图做 dHash 得到）：
 * - 指纹相同/汉明距离很近（同一张图换域名、换文件名、换分辨率/压缩率）→ 同一组，
 *   片名/年份不再参与拆分；
 * - 指纹明显不同 → 不同组，即使片名和年份完全一样（不同影片/不同海报不硬并）；
 * - 封面还没算出来/取图失败/没有封面 → 退回 URL 指纹，再退回「片名 + 年份」，
 *   且不跨组猜测。
 *
 * 「电影解说 / 影视解说」这类二创单独成组：它们常直接复用影片海报，若按封面合并，
 * 正片的来源列表里会混进解说的源，封面直达播放也可能播到解说视频。
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

/**
 * 按「封面视觉指纹优先、URL/片名为辅」聚合搜索结果。
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

  const buckets = new Map<string, SearchResultItem[]>();
  for (const item of list) {
    const name = (item.name || '').trim();
    if (!name) continue;
    const key = groupKeyOf(item, coverHashes, clusters);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }

  return [...buckets].map(([key, items]) => buildGroup(key, items));
}
