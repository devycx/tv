/**
 * 直播频道列表的纯函数过滤/排序工具。
 * 从 live-channel-list 组件中抽出为可测试的纯逻辑：
 * - 搜索归一化：忽略分隔符差异（cctv1 可命中 CCTV-1 综合）；
 * - 可用性两档筛选：仅绿点（分片级验证）/ 含琥珀（弱验证或超时）；
 * - 排序：默认 / 名称 / 分组 / 可用性优先 / 最近观看；
 * - 成人内容过滤（与点播搜索共用 lib/cms-parser 的词表口径）。
 */

import { isAdultType, isAdultTitle } from './cms-parser';

/** 与 store 的 LiveProbeEntry 结构兼容的测活结果子集（避免 lib 依赖 client store 类型） */
export interface ProbeLike {
  ok: boolean;
  ms?: number;
  level?: 'segment' | 'manifest' | 'head';
  timedOut?: boolean;
  kbps?: number;
}

export type LiveSortMode = 'default' | 'name' | 'group' | 'probe' | 'recent';
/**
 * 可用性筛选：
 * - auto：进入直播页自动测活后的默认档，隐藏「已确认不可用」的频道；
 *   未测/测活中/超时（源可能只是慢）仍然保留，避免列表在测活完成前被清空。
 * - off：全部
 * - ok：任何验证级别通过
 * - green：仅分片级验证通过且吞吐达标
 */
export type AliveFilter = 'auto' | 'off' | 'ok' | 'green';

/**
 * 「源限速」阈值（kbps）：分片可达但吞吐低于该值的源无法流畅缓冲。
 * 低于 1Mbps 的直播流基本必然卡顿，标记为琥珀色（介于绿点与不可达之间）。
 */
export const SLOW_SOURCE_KBPS = 1000;

/** 分片可达但吞吐不足（测活绿点却播不了的主因） */
export function isSlowSource(probe: ProbeLike | undefined): boolean {
  return Boolean(
    probe?.ok &&
      probe.level === 'segment' &&
      probe.kbps != null &&
      probe.kbps < SLOW_SOURCE_KBPS
  );
}

/** 常见台名分隔符（空格、连字符、下划线、点、竖线、括号等），搜索时忽略 */
const SEPARATOR_RE = /[\s\-_./·|+()（）[\]【】]/g;

export function normalizeForSearch(input: string): string {
  return input.toLowerCase().replace(SEPARATOR_RE, '');
}

export interface KeywordMatchable {
  name: string;
  tvgId?: string;
  group?: string;
}

/** 关键字匹配台名 / tvg-id / 分组名（三者都做分隔符归一化）；空关键字恒匹配 */
export function matchesKeyword(channel: KeywordMatchable, normalizedKeyword: string): boolean {
  if (!normalizedKeyword) return true;
  if (normalizeForSearch(channel.name).includes(normalizedKeyword)) return true;
  if (channel.tvgId && normalizeForSearch(channel.tvgId).includes(normalizedKeyword)) return true;
  if (channel.group && normalizeForSearch(channel.group).includes(normalizedKeyword)) return true;
  return false;
}

/**
 * 可用性筛选：
 * - auto：隐藏所有已确认不可用的频道（含超时）；未测/测活中保留
 * - 'ok'：任何验证级别通过（绿点、限速源或琥珀中的弱验证）
 * - 'green'：仅「分片级验证通过且吞吐达标」（真实可流畅播放置信度最高）
 */
export function matchesAlive(probe: ProbeLike | undefined, mode: AliveFilter): boolean {
  if (mode === 'off') return true;
  if (mode === 'auto') {
    // 未测/测活中先保留；只要有失败结论（含超时）就不展示
    if (!probe) return true;
    return probe.ok;
  }
  if (!probe?.ok) return false;
  if (mode === 'green') return probe.level === 'segment' && !isSlowSource(probe);
  return true;
}

/** 探测状态排序权重：绿点 → 限速分片 → 弱验证 → 超时 → 失败 → 未测 */
export function probeRank(probe: ProbeLike | undefined): number {
  if (!probe) return 5;
  if (probe.ok) {
    if (probe.level !== 'segment') return 2;
    return isSlowSource(probe) ? 1 : 0;
  }
  return probe.timedOut ? 3 : 4;
}

/**
 * 频道是否属于成人内容（best-effort）：分组名走分类词表，台名只认强特征词。
 *
 * 直播源的 M3U 没有 18+ 标记，只能靠分组名（「成人」「福利」「伦理」…）
 * 和台名里的强特征词判断；用分类口径套台名会误伤「成人礼」这类正常节目名，
 * 所以台名用片名口径（见 lib/cms-parser 的 isAdultTitle）。
 */
export function isAdultChannel(channel: KeywordMatchable): boolean {
  return isAdultType(channel.group) || isAdultTitle(channel.name);
}

export interface SortContext {
  /** url → 最近观看序（liveRecent 下标，越小越近） */
  recentOrder?: Map<string, number>;
  probeOf?: (url: string) => ProbeLike | undefined;
}

export function sortChannels<T extends KeywordMatchable & { url: string }>(
  list: T[],
  mode: LiveSortMode,
  ctx: SortContext = {}
): T[] {
  const out = [...list];
  switch (mode) {
    case 'name':
      out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
      break;
    case 'group':
      out.sort(
        (a, b) =>
          (a.group ?? '').localeCompare(b.group ?? '', 'zh') ||
          a.name.localeCompare(b.name, 'zh')
      );
      break;
    case 'probe': {
      const probeOf = ctx.probeOf;
      out.sort((a, b) => {
        const pa = probeOf?.(a.url);
        const pb = probeOf?.(b.url);
        const rank = probeRank(pa) - probeRank(pb);
        if (rank !== 0) return rank;
        // 同级内：有吞吐数据的按带宽降序，否则按分片延迟升序
        if (pa?.kbps != null && pb?.kbps != null && pa.kbps !== pb.kbps) return pb.kbps - pa.kbps;
        return (pa?.ms ?? Number.POSITIVE_INFINITY) - (pb?.ms ?? Number.POSITIVE_INFINITY);
      });
      break;
    }
    case 'recent': {
      const recentOrder = ctx.recentOrder;
      out.sort(
        (a, b) =>
          (recentOrder?.get(a.url) ?? Number.POSITIVE_INFINITY) -
          (recentOrder?.get(b.url) ?? Number.POSITIVE_INFINITY)
      );
      break;
    }
    default:
      break;
  }
  return out;
}
