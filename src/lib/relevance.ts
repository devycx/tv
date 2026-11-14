/**
 * 搜索结果相关性排序（纯函数，便于单测）。
 *
 * 旧版只做「归一化后完全相等优先，其余按拼音」：搜「色戒」时
 * 「色戒未删减」「色·戒」「戒色」的相对顺序完全由名称排序决定，
 * 结果质量看起来像随机的。这里按「命中方式」分档打分，再在同分内用
 * 原始写法（大小写/标点）和年份做次级排序。
 *
 * 分档（分数区间刻意不重叠，便于解释也便于调参）：
 * - 100        归一化后完全相等
 * - 90–94      标题以关键词开头（越短的标题越像用户要的那部）
 * - 85–88      多词查询：每个词都命中
 * - 80–84.5    关键词出现在标题中间（越靠前、标题越短越相关）
 * - 60–79      近似命中（错别字/形近字）
 * - 0          不相关（过滤阶段通常已丢弃）
 */

import { normalizeTitle } from './cms-parser';
import { diceCoefficient, isCloseMatch, levenshtein } from './text-similarity';

/** 归一化后完全相等时的细分：0 逐字相同，1 仅大小写不同，2 标点/空白不同 */
export type ExactKind = 0 | 1 | 2;

export interface TitleMatch {
  score: number;
  exactKind?: ExactKind;
}

export interface RankableItem {
  name?: string;
  year?: string;
  sourceName?: string;
}

const SCORE_EXACT = 100;
const SCORE_PREFIX_BASE = 90;
const SCORE_ALL_TOKENS_BASE = 85;
const SCORE_CONTAINS_BASE = 80;
const SCORE_APPROX_BASE = 60;

/** 归一化后完全相等时，按「原始写法的接近程度」再分先后 */
function exactKindOf(name: string, keyword: string): ExactKind {
  const n = name.trim();
  const q = keyword.trim();
  if (n === q) return 0;
  if (n.toLowerCase() === q.toLowerCase()) return 1;
  return 2;
}

function tokensOf(keyword: string): string[] {
  return keyword
    .trim()
    .split(/\s+/)
    .map(normalizeTitle)
    .filter(Boolean);
}

/**
 * 计算单个标题对关键词的相关性。
 * 多词查询里「每个词都命中」优先于「整串包含」——用户输入空格本就表示并列条件。
 */
export function matchTitle(name: string | undefined, keyword: string): TitleMatch {
  const q = normalizeTitle(keyword);
  const n = normalizeTitle(name ?? '');
  if (!q || !n) return { score: 0 };

  if (n === q) return { score: SCORE_EXACT, exactKind: exactKindOf(name ?? '', keyword) };

  if (n.startsWith(q)) {
    // 前缀命中：标题越短，越可能就是要找的那部（「色戒」优于「色戒未删减」）
    return { score: SCORE_PREFIX_BASE + 4 * (q.length / n.length) };
  }

  const tokens = tokensOf(keyword);
  if (tokens.length > 1 && tokens.every((t) => n.includes(t))) {
    const matched = tokens.reduce((sum, t) => sum + t.length, 0);
    return { score: SCORE_ALL_TOKENS_BASE + 3 * Math.min(1, matched / n.length) };
  }

  const at = n.indexOf(q);
  if (at >= 0) {
    const lengthRatio = q.length / n.length;
    const positionBonus = 1 - at / n.length;
    const score = Math.min(84.5, SCORE_CONTAINS_BASE + 3 * lengthRatio + 2 * positionBonus);
    return { score };
  }

  if (isCloseMatch(n, q)) {
    const similarity = Math.max(diceCoefficient(n, q), 1 - levenshtein(n, q) / Math.max(n.length, q.length));
    return { score: SCORE_APPROX_BASE + Math.min(19, 20 * similarity) };
  }

  return { score: 0 };
}

/** 年份解析：0 表示缺失（缺年份的条目排在所有有年份的之后） */
export function parseYear(year?: string): number {
  // 有的源写「2007-08-30」，不能把整串数字拼起来当成年份，只取第一段四位数字
  const match = /[12]\d{3}/.exec(String(year ?? ''));
  if (!match) return 0;
  const n = parseInt(match[0], 10);
  return n > 1900 && n < 3000 ? n : 0;
}

/**
 * 搜索结果比较器：相关性 → 原始写法 → 年份由近及远 → 名称 → 源名。
 * 最后两级只为了保证「同样输入永远同样顺序」——流式搜索逐个源追加结果时，
 * 顺序不稳定会让用户刚要点的那张卡片跳走。
 */
export function compareSearchResults(a: RankableItem, b: RankableItem, keyword: string): number {
  const ma = matchTitle(a.name, keyword);
  const mb = matchTitle(b.name, keyword);
  if (ma.score !== mb.score) return mb.score - ma.score;

  const ka = ma.exactKind ?? 9;
  const kb = mb.exactKind ?? 9;
  if (ka !== kb) return ka - kb;

  const ya = parseYear(a.year);
  const yb = parseYear(b.year);
  if (ya !== yb) {
    if (ya === 0) return 1;
    if (yb === 0) return -1;
    return yb - ya;
  }

  const byName = (a.name ?? '').localeCompare(b.name ?? '', 'zh-Hans-CN');
  if (byName !== 0) return byName;
  return (a.sourceName ?? '').localeCompare(b.sourceName ?? '', 'zh-Hans-CN');
}
