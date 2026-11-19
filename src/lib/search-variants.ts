/**
 * 搜索结果里的「变体」识别：电影解说 / 影视解说 / 沉浸版 / 预告片 / 花絮 …
 *
 * 背景（2026-11-19 用户口径）：只要封面一致，解说、沉浸版等各个变体就应该和正片
 * 聚合到同一张卡，不能因为片名后缀不同拆成多张；区别放到来源行上，用一个小标签
 * 标明这个来源是「解说」还是「沉浸版」。
 *
 * 识别只认**片名末尾**的括号附注或明确的版本词，不直接对整名片名做关键字匹配：
 * 「默片解说员」「爱的沉浸式」「铁达尼邮轮沉浸记」都是片名本身，不能被当成变体。
 *
 * 二创解说（`commentary`）与普通版本（沉浸版/预告片/网络版…）分开标记：
 * - 聚合时拿不到封面、只能按片名兜底时，解说仍与正片分开，避免没有封面的解说源
 *   混进正片来源列表；
 * - 封面直达播放优先取正片，避免点封面先播到一段解说。
 */

import type { SearchResultItem } from './types';

export interface SearchVariant {
  /** 来源行上的短标签：解说 / 沉浸版 / 预告片 … */
  label: string;
  /** 识别到的完整写法（如「无障碍解说版」），放 title 里备查 */
  fullLabel: string;
  /** 二创解说：和正片不是同一内容，封面直达播放应优先正片 */
  commentary: boolean;
}

/** 二创/解说类关键词：只看已经识别出来的变体标签，不直接匹配整名片名 */
const COMMENTARY = /解说|讲解|影评|拉片|速看|精讲|混剪/;

/** 片名末尾括号附注：`[电影解说]` / `【影视解说】` / `（无障碍解说版）` */
const TRAILING_BRACKET = /[[【(（]\s*([^\]】)）]{1,20}?)\s*[\]】)）]\s*$/u;

/**
 * 片名末尾的版本词：`后会友期 沉浸版` / `从红月开始 解说版` / `香蜜沉沉烬如霜网络版`。
 * 只认明确的版本词；`沉浸式` 不算——「爱的沉浸式」是片名本身。
 */
const TRAILING_TOKEN =
  /((?:电影|影视|无障碍)?解说(?:版)?|解说版|沉浸版|预告片?|花絮|速看版?|精讲版?|拉片版?|影评版?|混剪版?|网络版|未删减版|加长版|导演剪辑版)\s*$/u;

/** 来源类型本身就是变体类型：有些源不在片名后缀上标，只在 typeName 里写 */
const VARIANT_TYPE = /^(?:电影解说|影视解说|解说|预告片|花絮|速看|精讲|拉片|影评|混剪)$/;

/** 把括号/后缀里识别到的文字收敛成已知变体；`[HD国语]` 这类附注返回 undefined */
function normalizeVariant(text: string): string | undefined {
  const value = text.trim();
  if (!value) return undefined;
  if (/^(?:电影|影视|无障碍)?解说(?:版)?$/u.test(value)) return value;
  if (
    /^(?:解说版|沉浸版|预告片?|花絮|速看版?|精讲版?|拉片版?|影评版?|混剪版?|网络版|未删减版|加长版|导演剪辑版)$/u.test(
      value
    )
  ) {
    return value;
  }
  return undefined;
}

/** 来源行标签保持短小（来源名还要占宽度），完整写法放 title */
function shortLabel(full: string): string {
  if (/沉浸/.test(full)) return '沉浸版';
  if (/预告/.test(full)) return '预告片';
  if (/花絮/.test(full)) return '花絮';
  if (/解说|讲解/.test(full)) return '解说';
  if (/速看/.test(full)) return '速看';
  if (/精讲/.test(full)) return '精讲';
  if (/拉片/.test(full)) return '拉片';
  if (/影评/.test(full)) return '影评';
  if (/混剪/.test(full)) return '混剪';
  if (/未删减/.test(full)) return '未删减';
  if (/加长/.test(full)) return '加长版';
  if (/导演剪辑/.test(full)) return '导剪版';
  if (/网络/.test(full)) return '网络版';
  return full.slice(0, 6);
}

/**
 * 识别条目的变体类型；正片/普通电影返回 undefined。
 *
 * 优先级：片名末尾括号附注 → 片名末尾版本词 → typeName。
 * 前两步都只认末尾，避免片名中间碰巧含「解说」「沉浸」被误判。
 */
export function variantOf(item: Pick<SearchResultItem, 'name' | 'typeName'>): SearchVariant | undefined {
  const name = (item.name ?? '').trim();
  let fullLabel: string | undefined;

  const bracketed = name.match(TRAILING_BRACKET);
  if (bracketed) fullLabel = normalizeVariant(bracketed[1]);

  if (!fullLabel) {
    const trailing = name.match(TRAILING_TOKEN);
    if (trailing) fullLabel = normalizeVariant(trailing[1]);
  }

  if (!fullLabel && item.typeName) {
    const type = item.typeName.trim();
    if (VARIANT_TYPE.test(type)) fullLabel = type;
  }

  if (!fullLabel) return undefined;
  return {
    label: shortLabel(fullLabel),
    fullLabel,
    commentary: COMMENTARY.test(fullLabel),
  };
}

/** 片名意义上的二创解说：按片名兜底聚合时不能和正片并组 */
export function isCommentaryName(name: string): boolean {
  return variantOf({ name })?.commentary ?? false;
}
