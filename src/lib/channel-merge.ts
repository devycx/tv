import type { LiveChannel } from './types';

/**
 * 跨源频道合并（按「频道名 / tvg-id」归一化）。
 *
 * 目标：12 个直播源里同一个 CCTV-1 会出现十几次、名字还带各种后缀
 * （CCTV-1 综合 / CCTV1高清 / 央视一套），合并成一行「CCTV-1 · N 个源」，
 * 点开时再按需探测候选源，替代原先「进页面全量测活 1477 个频道」的做法。
 */

export interface LiveChannelItem extends LiveChannel {
  /** 来源订阅的 EPG 地址（用于节目单查询） */
  epg?: string;
  /** 所属直播源地址（M3U 订阅 URL），写入最近观看以便订阅删除时清理 */
  sourceUrl?: string;
}

export interface MergedChannel extends LiveChannelItem {
  /** 合并键（归一化频道名），同 key 的行唯一 */
  key: string;
  /** 同频道在各源里的候选条目，按来源顺序；第一个作为默认播放地址 */
  candidates: LiveChannelItem[];
}

/** 画质/编码等修饰词：合并时忽略（CCTV1高清 → cctv1） */
const QUALITY_TOKENS = /(高清|超清|蓝光|标清|流畅|原画|4k|8k|uhd|fhd|h265|hevc|hd|sd)/g;
/** 括号内容：备用、线路、数字等（含全角括号） */
const BRACKET_RE = /[（(\[【][^)）\]】]*[)）\]】]/g;
/** 台名里的分隔符 */
const SEPARATOR_RE = /[\s\-_./·|,:：;；]+/g;

/** 央视各套的常见别名 → 统一成 cctvN，避免「央视一套」和「CCTV-1」被拆成两个频道 */
const CCTV_ALIASES: Record<string, string> = {
  央视一套: 'cctv1',
  央视1套: 'cctv1',
  中央一台: 'cctv1',
  中央1台: 'cctv1',
  央视综合: 'cctv1',
  央视二套: 'cctv2',
  央视2套: 'cctv2',
  央视财经: 'cctv2',
  央视三套: 'cctv3',
  央视3套: 'cctv3',
  央视综艺: 'cctv3',
  央视四套: 'cctv4',
  央视4套: 'cctv4',
  央视中文国际: 'cctv4',
  央视五套: 'cctv5',
  央视5套: 'cctv5',
  央视体育: 'cctv5',
  央视五套plus: 'cctv5+',
  央视六套: 'cctv6',
  央视6套: 'cctv6',
  央视电影: 'cctv6',
  央视七套: 'cctv7',
  央视7套: 'cctv7',
  央视军事: 'cctv7',
  央视八套: 'cctv8',
  央视8套: 'cctv8',
  央视电视剧: 'cctv8',
  央视九套: 'cctv9',
  央视9套: 'cctv9',
  央视纪录: 'cctv9',
  央视十套: 'cctv10',
  央视10套: 'cctv10',
  央视科教: 'cctv10',
  央视十一套: 'cctv11',
  央视11套: 'cctv11',
  央视戏曲: 'cctv11',
  央视十二套: 'cctv12',
  央视12套: 'cctv12',
  央视社会与法: 'cctv12',
  央视十三套: 'cctv13',
  央视13套: 'cctv13',
  央视新闻: 'cctv13',
  央视十四套: 'cctv14',
  央视14套: 'cctv14',
  央视少儿: 'cctv14',
  央视十五套: 'cctv15',
  央视15套: 'cctv15',
  央视音乐: 'cctv15',
  央视十六套: 'cctv16',
  央视16套: 'cctv16',
  央视奥林匹克: 'cctv16',
  央视十七套: 'cctv17',
  央视17套: 'cctv17',
  央视农业农村: 'cctv17',
};

/**
 * 归一化频道名：大小写/全半角/分隔符/画质后缀/央视频道别名。
 * - 「CCTV-1 综合」「cctv1高清」「央视一套」→ cctv1
 * - 「CCTV-5+ 体育赛事」→ cctv5+（加号保留，不能和 CCTV-5 合并）
 * - 「湖南卫视 HD」→ 湖南卫视
 */
export function normalizeChannelName(name: string): string {
  let s = (name || '').normalize('NFKC').toLowerCase();
  s = s.replace(BRACKET_RE, ' ');
  s = s.replace(QUALITY_TOKENS, '');
  s = s.replace(SEPARATOR_RE, '');
  // CCTV 系列只留频道号：CCTV1综合 → cctv1、CCTV5+体育 → cctv5+
  const cctv = /^cctv(\d+\+?|\d+[a-z]?)/.exec(s);
  if (cctv) return `cctv${cctv[1]}`;
  const alias = CCTV_ALIASES[s];
  if (alias) return alias;
  return s;
}

/** tvg-id 归一化：CCTV-1 / cctv1 / CCTV1.cn 这类写法拉齐（空值不参与合并） */
export function normalizeTvgId(tvgId?: string): string {
  return (tvgId || '').toLowerCase().replace(/[^a-z0-9+]/g, '');
}

/** 展示名打分：越「干净」越优先（无画质后缀、无括号），同分取更短 */
const QUALITY_HINT_RE = /(高清|超清|蓝光|标清|流畅|原画|4k|8k|uhd|fhd|h265|hevc|hd|sd)/;
const BRACKET_HINT_RE = /[（(\[【][^)）\]】]*[)）\]】]/;

function displayScore(name: string): number {
  const raw = name.trim();
  const noisy = QUALITY_HINT_RE.test(raw) || BRACKET_HINT_RE.test(raw) ? 10 : 0;
  return noisy + raw.length;
}

function pickDisplayName(candidates: LiveChannelItem[]): string {
  let best = candidates[0];
  let bestScore = displayScore(best.name);
  for (const c of candidates.slice(1)) {
    const score = displayScore(c.name);
    if (score < bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best.name.trim();
}

function pickGroup(candidates: LiveChannelItem[]): string | undefined {
  const counts = new Map<string, number>();
  for (const c of candidates) {
    if (!c.group) continue;
    counts.set(c.group, (counts.get(c.group) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [group, count] of counts) {
    if (count > bestCount) {
      best = group;
      bestCount = count;
    }
  }
  return best;
}

/**
 * 合并频道：按归一化名 / tvg-id 做并查集，同名或同 tvg-id 的条目归为一个频道。
 *
 * 用并查集而不是简单 Map：一条「央视一套」（tvg-id=cctv1）和一条「CCTV-1」（无 tvg-id）
 * 只有名字能对上，而「CCTV1」和「央视一套」（同名 tvg-id）只有 id 能对上，两者都要合并。
 */
export function mergeChannels(channels: LiveChannelItem[]): MergedChannel[] {
  if (channels.length === 0) return [];

  const parent = channels.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    // 路径压缩
    let cur = i;
    while (parent[cur] !== root) {
      const next = parent[cur];
      parent[cur] = root;
      cur = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  // 同一归一化键只认第一个出现的条目，后续条目并到它上面
  const byKey = new Map<string, number>();
  channels.forEach((channel, index) => {
    const keys: string[] = [];
    const nameKey = normalizeChannelName(channel.name);
    if (nameKey) keys.push(`name:${nameKey}`);
    const tvgKey = normalizeTvgId(channel.tvgId);
    if (tvgKey) keys.push(`tvg:${tvgKey}`);
    for (const key of keys) {
      const first = byKey.get(key);
      if (first === undefined) byKey.set(key, index);
      else union(first, index);
    }
  });

  // 按首次出现顺序收集每个根的候选
  const order: number[] = [];
  const groups = new Map<number, LiveChannelItem[]>();
  channels.forEach((channel, index) => {
    const root = find(index);
    const list = groups.get(root);
    if (list) list.push(channel);
    else {
      groups.set(root, [channel]);
      order.push(root);
    }
  });

  const merged: MergedChannel[] = [];
  for (const root of order) {
    // 同一 URL 可能同时出现在多个订阅里：候选按 URL 去重（保留首次出现的顺序）
    const seenUrls = new Set<string>();
    const candidates = groups.get(root)!.filter((c) => {
      if (seenUrls.has(c.url)) return false;
      seenUrls.add(c.url);
      return true;
    });
    const displayName = pickDisplayName(candidates);
    const primary = candidates[0];
    const withTvg = candidates.find((c) => c.tvgId);
    const withEpg = candidates.find((c) => c.epg);
    const withLogo = candidates.find((c) => c.logo);
    merged.push({
      ...primary,
      key: normalizeChannelName(displayName) || primary.url,
      name: displayName,
      url: primary.url,
      id: withTvg?.tvgId || primary.id,
      tvgId: withTvg?.tvgId ?? primary.tvgId,
      epg: withEpg?.epg ?? primary.epg,
      logo: withLogo?.logo ?? primary.logo,
      group: pickGroup(candidates),
      candidates,
    });
  }
  return merged;
}

/** 合并后某一行对外的「最佳测活结果」：优先分片级、其次任何通过、最后任一已有结果 */
export interface ProbeLike {
  ok: boolean;
  level?: 'segment' | 'manifest' | 'head';
  timedOut?: boolean;
  kbps?: number;
  ms?: number;
}

export function bestProbe(
  channel: MergedChannel,
  probeOf: (url: string) => ProbeLike | undefined
): ProbeLike | undefined {
  let bestOk: ProbeLike | undefined;
  let firstKnown: ProbeLike | undefined;
  for (const candidate of channel.candidates) {
    const probe = probeOf(candidate.url);
    if (!probe) continue;
    if (!firstKnown) firstKnown = probe;
    if (!probe.ok) continue;
    // 分片级是最可信的结论，直接胜出
    if (probe.level === 'segment') return probe;
    if (!bestOk) bestOk = probe;
  }
  return bestOk ?? firstKnown;
}
