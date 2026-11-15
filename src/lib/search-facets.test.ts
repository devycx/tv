import { describe, expect, it } from 'vitest';
import { EMPTY_FILTERS, buildFacets, filterGroups, hasActiveFilters } from './search-facets';
import type { AggregatedGroup } from './search-groups';
import type { SearchResultItem } from './types';

function item(overrides: Partial<SearchResultItem>): SearchResultItem {
  return {
    sourceKey: 'src',
    sourceName: '源',
    vodId: 'v',
    name: '片名',
    ...overrides,
  };
}

function group(
  key: string,
  items: SearchResultItem[],
  overrides: Partial<AggregatedGroup> = {}
): AggregatedGroup {
  return { key, name: '片名', items, ...overrides };
}

describe('buildFacets', () => {
  it('按聚合组计数：一个组里多个同类来源只算 1 部，且只认卡片上显示的类型', () => {
    const facets = buildFacets([
      group('a', [item({ typeName: '剧情片' }), item({ typeName: '剧情片' }), item({ typeName: '伦理片' })], {
        typeName: '剧情片',
      }),
      group('b', [item({ typeName: '剧情片' })], { typeName: '剧情片' }),
    ]);

    expect(facets.types).toEqual([{ value: '剧情片', count: 2 }]);
  });

  it('年份归一成四位数字，并按「影片数 → 年份」排序', () => {
    const facets = buildFacets([
      group('a', [], { year: '2007-08-30' }),
      group('b', [], { year: '2002' }),
      group('c', [], { year: '2002' }),
      group('d', [], { year: '未知' }),
    ]);

    expect(facets.years).toEqual([
      { value: '2002', count: 2 },
      { value: '2007', count: 1 },
    ]);
  });

  it('18禁单独统计，并区分含成人来源与不含的组', () => {
    const facets = buildFacets([
      group('a', [item({ isAdult: true })]),
      group('b', [item({ isAdult: false })]),
      group('c', [item({ isAdult: true }), item({ isAdult: false })]),
    ]);

    expect(facets.adult).toEqual({ adult: 2, normal: 1 });
  });

  it('已选但本次结果不存在的值保留为 0，避免筛选无法取消', () => {
    const facets = buildFacets([group('a', [], { typeName: '剧情片' })], {
      types: ['理论片'],
      years: ['1999'],
      adultOnly: false,
    });

    expect(facets.types).toContainEqual({ value: '理论片', count: 0 });
    expect(facets.years).toContainEqual({ value: '1999', count: 0 });
  });

  it('计数跟随其他类目的选择：选了类型后，年份只统计该类型的结果', () => {
    const groups = [
      group('a', [item({ isAdult: false })], { typeName: '剧情片', year: '2007' }),
      group('b', [item({ isAdult: true })], { typeName: '伦理片', year: '2002' }),
      group('c', [item({ isAdult: false })], { typeName: '剧情片', year: '2002' }),
    ];
    const facets = buildFacets(groups, { types: ['剧情片'], years: [], adultOnly: false });

    // 类型计数忽略自己的选择，仍能看到伦理片并改选
    expect(facets.types).toContainEqual({ value: '伦理片', count: 1 });
    // 年份计数应用已选类型：只剩 a/c
    expect(facets.years).toEqual([
      { value: '2007', count: 1 },
      { value: '2002', count: 1 },
    ]);
    // 18禁计数也应用已选类型
    expect(facets.adult).toEqual({ adult: 0, normal: 2 });
  });
});

describe('filterGroups', () => {
  const groups = [
    group('a', [item({ isAdult: false })], { typeName: '剧情片', year: '2007' }),
    group('b', [item({ isAdult: true })], { typeName: '伦理片', year: '2002' }),
    // 组内混有伦理片来源，但卡片上显示的是多数类型「剧情片」：筛选以卡片标签为准
    group('c', [item({ isAdult: true, typeName: '伦理片' }), item({ isAdult: false, typeName: '剧情片' })], {
      typeName: '剧情片',
      year: '2001',
    }),
  ];

  it('无筛选时原样返回（保持引用稳定，避免无谓重排）', () => {
    expect(filterGroups(groups, EMPTY_FILTERS)).toBe(groups);
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
  });

  it('同类目内 OR，不同类目之间 AND', () => {
    expect(filterGroups(groups, { types: ['剧情片', '伦理片'], years: [], adultOnly: false })).toHaveLength(3);
    expect(filterGroups(groups, { types: ['剧情片'], years: [], adultOnly: false }).map((g) => g.key)).toEqual([
      'a',
      'c',
    ]);
    expect(filterGroups(groups, { types: ['剧情片'], years: ['2002'], adultOnly: false })).toEqual([]);
    expect(filterGroups(groups, { types: ['伦理片'], years: [], adultOnly: false }).map((g) => g.key)).toEqual(['b']);
  });

  it('18禁只看组内是否有成人来源', () => {
    expect(filterGroups(groups, { types: [], years: [], adultOnly: true }).map((g) => g.key)).toEqual(['b', 'c']);
  });

  it('没有年份的组不会被年份筛选命中', () => {
    const noYear = [group('x', [], { typeName: '剧情片' })];
    expect(filterGroups(noYear, { types: [], years: ['2007'], adultOnly: false })).toEqual([]);
  });
});
