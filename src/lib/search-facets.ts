/**
 * 搜索结果筛选标签（纯函数，便于单测）。
 *
 * 结果卡上原本就带着「类型 / 年份 / 18禁」三种标签，但只能看不能点。
 * 这里从已聚合的结果里把这些标签收集成筛选项（带影片数），并支持多选过滤：
 * 同一类目内 OR（剧情片或爱情片），不同类目之间 AND（剧情片 + 2007）。
 *
 * 计数与过滤都以**聚合组**为单位，和卡片上显示的标签一致：一个组里就算有 5 个
 * 「剧情片」来源，也只算 1 部；卡片标签显示「剧情片」时，点「伦理片」不会把它筛出来。
 * 组内混合标签（同片不同源分类不一致）由聚合阶段的多数值决定，保证所见即所得。
 */

import { parseYear } from './relevance';
import type { AggregatedGroup } from './search-groups';

export interface FacetOption {
  value: string;
  /** 含该标签的聚合组数量 */
  count: number;
}

export interface SearchFacets {
  types: FacetOption[];
  years: FacetOption[];
  adult: {
    /** 含成人来源的组数 */
    adult: number;
    /** 不含成人来源的组数 */
    normal: number;
  };
}

export interface SearchFilters {
  types: string[];
  years: string[];
  adultOnly: boolean;
}

export const EMPTY_FILTERS: SearchFilters = { types: [], years: [], adultOnly: false };

export function hasActiveFilters(filters: SearchFilters): boolean {
  return filters.types.length > 0 || filters.years.length > 0 || filters.adultOnly;
}

function matchesFilters(group: AggregatedGroup, filters: SearchFilters): boolean {
  const types = new Set(filters.types);
  const years = new Set(filters.years);

  if (types.size > 0 && !types.has((group.typeName ?? '').trim())) return false;
  if (years.size > 0) {
    const year = parseYear(group.year);
    if (year === 0 || !years.has(String(year))) return false;
  }
  if (filters.adultOnly && !group.items.some((item) => item.isAdult)) return false;
  return true;
}

export function filterGroups(groups: AggregatedGroup[], filters: SearchFilters): AggregatedGroup[] {
  if (!hasActiveFilters(filters)) return groups;
  return groups.filter((group) => matchesFilters(group, filters));
}

/**
 * 收集筛选项并计数。
 *
 * 计数会跟随**其他类目**的当前选择（标准分面搜索）：选了「伦理片」后，年份标签
 * 只统计伦理片结果里出现过的年份，不会出现「点进去是 0 部」的年份。当前类目自己的
 * 选择不参与计数，否则选中一个类型后其他类型的数量会全部变 0，无法改选。
 *
 * `filters` 里已选但本次结果中不存在的值会以 0 计数保留，避免「筛选还在生效，
 * 但对应的标签已消失、用户找不到地方取消」。
 */
export function buildFacets(groups: AggregatedGroup[], filters: SearchFilters = EMPTY_FILTERS): SearchFacets {
  // 类型计数：应用年份/18禁，忽略已选类型
  const typeBase = filterGroups(groups, { ...filters, types: [] });
  // 年份计数：应用类型/18禁，忽略已选年份
  const yearBase = filterGroups(groups, { ...filters, years: [] });
  // 18禁计数：应用类型/年份，忽略成人筛选本身
  const adultBase = filterGroups(groups, { ...filters, adultOnly: false });

  const typeCounts = new Map<string, number>();
  for (const group of typeBase) {
    const type = (group.typeName ?? '').trim();
    if (type) typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
  }

  const yearCounts = new Map<string, number>();
  for (const group of yearBase) {
    const year = parseYear(group.year);
    if (year > 0) {
      const key = String(year);
      yearCounts.set(key, (yearCounts.get(key) ?? 0) + 1);
    }
  }

  let adult = 0;
  let normal = 0;
  for (const group of adultBase) {
    if (group.items.some((item) => item.isAdult)) adult += 1;
    else normal += 1;
  }

  for (const type of filters.types) {
    if (!typeCounts.has(type)) typeCounts.set(type, 0);
  }
  for (const year of filters.years) {
    if (!yearCounts.has(year)) yearCounts.set(year, 0);
  }

  return {
    types: [...typeCounts]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'zh-Hans-CN')),
    years: [...yearCounts]
      .map(([value, count]) => ({ value, count }))
      // 先按影片数：手机窄屏一行只露 4–5 个，把「2007」这种主年份排在前面；
      // 同数量再按年份倒序。
      .sort((a, b) => b.count - a.count || Number(b.value) - Number(a.value)),
    adult: { adult, normal },
  };
}
