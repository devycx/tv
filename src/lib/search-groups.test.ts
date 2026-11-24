import { describe, expect, it } from 'vitest';
import { aggregateResults, mergeExpandedGroups, normalizeGroupTitle } from './search-groups';
import type { SearchResultItem } from './types';

let seq = 0;
function item(overrides: Partial<SearchResultItem> & { name: string }): SearchResultItem {
  seq += 1;
  return {
    sourceKey: `src_${seq}`,
    sourceName: `源${seq}`,
    vodId: `v${seq}`,
    ...overrides,
  };
}

const COVER_A = 'https://a.com/cover/78288c7898fdad99aee06e3b42213c7b.jpg';
const COVER_A_MIRROR = 'https://b.com/upload/78288c7898fdad99aee06e3b42213c7b.webp';
const COVER_B = 'https://a.com/cover/bb36e395b063bec9205952807471e86a.jpg';
const COVER_C = 'https://a.com/cover/cc36e395b063bec9205952807471e86a.jpg';
const COVER_D = 'https://a.com/cover/dd36e395b063bec9205952807471e86a.jpg';

describe('normalizeGroupTitle', () => {
  it('只剥离末尾清晰度与音轨标签', () => {
    expect(normalizeGroupTitle('斗破苍穹[4K][国语]')).toBe('斗破苍穹');
    expect(normalizeGroupTitle('阿凡达 1080P 中字')).toBe('阿凡达');
    expect(normalizeGroupTitle('Lust, Caution HD')).toBe('lustcaution');
  });

  it('保留季数、年番、特别篇、剧场版等作品区分词', () => {
    expect(normalizeGroupTitle('斗破苍穹 第四季 4K')).toBe('斗破苍穹第四季');
    expect(normalizeGroupTitle('斗破苍穹年番')).toBe('斗破苍穹年番');
    expect(normalizeGroupTitle('名侦探柯南：特别篇')).toBe('名侦探柯南特别篇');
    expect(normalizeGroupTitle('新世纪福音战士剧场版')).toBe('新世纪福音战士剧场版');
  });
});

describe('aggregateResults（零网络聚合）', () => {
  it('同名同年即使封面不同也并组，同名不同年不并', () => {
    expect(aggregateResults([
      item({ name: '色戒', year: '2007', pic: COVER_A }),
      item({ name: '色 戒', year: '2007', pic: COVER_B }),
    ])).toHaveLength(1);
    expect(aggregateResults([
      item({ name: '色戒', year: '2002', pic: COVER_A }),
      item({ name: '色戒', year: '2007', pic: COVER_B }),
    ])).toHaveLength(2);
  });

  it('相同内容哈希封面跨站、跨片名、跨年份合并', () => {
    const groups = aggregateResults([
      item({ name: '色戒', year: '2002', pic: COVER_A }),
      item({ name: '色戒Samsara', year: '2001', pic: COVER_A_MIRROR }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('色戒');
    expect(groups[0].items).toHaveLength(2);
  });

  it('清晰度/音轨后缀不会拆卡，但季数不会误并', () => {
    const quality = aggregateResults([
      item({ name: '斗破苍穹', year: '2024', pic: COVER_A }),
      item({ name: '斗破苍穹 4K 国语', year: '2024', pic: COVER_B }),
    ]);
    expect(quality).toHaveLength(1);

    const seasons = aggregateResults([
      item({ name: '斗破苍穹 第三季', year: '2024', pic: COVER_A }),
      item({ name: '斗破苍穹 第四季', year: '2024', pic: COVER_B }),
    ]);
    expect(seasons).toHaveLength(2);
  });

  it('没有封面时按片名 + 年份合并', () => {
    const groups = aggregateResults([
      item({ name: '色戒', year: '2007' }),
      item({ name: '色 戒', year: '2007' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(2);
  });

  it('电影解说共用海报时并卡；无封面时不混进正片', () => {
    expect(aggregateResults([
      item({ name: '色，戒', pic: COVER_A }),
      item({ name: '色，戒[电影解说]', pic: COVER_A_MIRROR, typeName: '电影解说' }),
    ])).toHaveLength(1);
    expect(aggregateResults([
      item({ name: '色，戒', year: '2007' }),
      item({ name: '色，戒[电影解说]', year: '2007', typeName: '电影解说' }),
    ])).toHaveLength(2);
  });

  it('组封面优先正片来源，组标题取更干净写法', () => {
    const groups = aggregateResults([
      item({ name: '色戒2007[电影解说]', pic: COVER_A, typeName: '电影解说' }),
      item({ name: '色戒', pic: COVER_A_MIRROR }),
    ]);
    expect(groups[0].name).toBe('色戒');
    expect(groups[0].pic).toBe(COVER_A_MIRROR);
  });

  it('组内备注推到统一结论', () => {
    const groups = aggregateResults([
      item({ name: '庆余年', pic: COVER_A, remarks: '全36集' }),
      item({ name: '庆余年', pic: COVER_A_MIRROR, remarks: '更新至36集' }),
    ]);
    expect(groups[0].remarks).toBe('全36集');
  });

  it('不同片名不同封面不并，空片名丢弃', () => {
    expect(aggregateResults([
      item({ name: '色戒', pic: COVER_A }),
      item({ name: '大开色戒', pic: COVER_B }),
    ])).toHaveLength(2);
    expect(aggregateResults([item({ name: '   ' })])).toEqual([]);
  });
});

describe('mergeExpandedGroups（扩搜稳定合并）', () => {
  it('旧组顺序、key、标题与封面不变，匹配来源补进旧组，新作品追加', () => {
    const base = aggregateResults([
      item({ name: '甲', year: '2024', pic: COVER_A, typeName: '剧情片' }),
      item({ name: '乙', year: '2025', pic: COVER_B, typeName: '国产剧' }),
    ]);
    const result = mergeExpandedGroups(base, [
      item({ name: '甲 4K 国语', year: '2024', pic: COVER_C, sourceKey: 'tier2_a' }),
      item({ name: '丙', year: '2026', pic: COVER_D, sourceKey: 'tier2_b' }),
    ]);

    expect(result.map((group) => group.key)).toEqual([...base.map((group) => group.key), result[2].key]);
    expect(result.slice(0, 2).map((group) => group.name)).toEqual(['甲', '乙']);
    expect(result[0].pic).toBe(base[0].pic);
    expect(result[0].typeName).toBe(base[0].typeName);
    expect(result[0].items).toHaveLength(2);
    expect(result[1].items).toHaveLength(1);
    expect(result[2].name).toBe('丙');
  });

  it('一个扩搜条目同时撞两个旧组时只按封面归入一个，不桥接旧卡', () => {
    const base = aggregateResults([
      item({ name: '甲', year: '2024', pic: COVER_A }),
      item({ name: '乙', year: '2025', pic: COVER_B }),
    ]);
    const result = mergeExpandedGroups(base, [
      item({ name: '乙', year: '2025', pic: COVER_A_MIRROR, sourceKey: 'tier2_bridge' }),
    ]);

    expect(result).toHaveLength(2);
    expect(result.map((group) => group.key)).toEqual(base.map((group) => group.key));
    expect(result[0].items).toHaveLength(2);
    expect(result[1].items).toHaveLength(1);
    expect(result.map((group) => group.name)).toEqual(['甲', '乙']);
  });

  it('重复 sourceKey + vodId 不会重复补来源', () => {
    const existing = item({ name: '甲', pic: COVER_A, sourceKey: 'same', vodId: '1' });
    const base = aggregateResults([existing]);
    const result = mergeExpandedGroups(base, [{ ...existing }, { ...existing }]);
    expect(result).toHaveLength(1);
    expect(result[0].items).toHaveLength(1);
  });

  it('空扩搜返回等价旧组且不修改输入', () => {
    const base = aggregateResults([item({ name: '甲', pic: COVER_A })]);
    const before = JSON.stringify(base);
    const result = mergeExpandedGroups(base, []);
    expect(result).toEqual(base);
    expect(JSON.stringify(base)).toBe(before);
    expect(result[0]).not.toBe(base[0]);
  });

  it('首屏逐源增量并入：旧卡身份/顺序冻结，慢源不桥接也不顶走已上屏卡片', () => {
    // 快源先到：甲、乙两组
    let groups = mergeExpandedGroups([], [
      item({ name: '甲', year: '2024', pic: COVER_A, sourceKey: 's1' }),
      item({ name: '乙', year: '2025', pic: COVER_B, sourceKey: 's1' }),
    ]);
    const firstKeys = groups.map((g) => g.key);
    const firstNames = groups.map((g) => g.name);

    // 第二个源：甲的镜像封面 + 新作品丙
    groups = mergeExpandedGroups(groups, [
      item({ name: '甲 4K', year: '2024', pic: COVER_A_MIRROR, sourceKey: 's2' }),
      item({ name: '丙', year: '2026', pic: COVER_D, sourceKey: 's2' }),
    ]);
    // 慢源：一条同时撞「乙」封面和「甲」片名——只能按封面归入一个旧组，不能桥接
    groups = mergeExpandedGroups(groups, [
      item({ name: '甲', year: '2024', pic: COVER_B, sourceKey: 's3' }),
    ]);

    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.key).slice(0, 2)).toEqual(firstKeys);
    expect(groups.map((g) => g.name).slice(0, 2)).toEqual(firstNames);
    expect(groups[0].items).toHaveLength(2);
    expect(groups[1].items).toHaveLength(2);
    expect(groups[2].name).toBe('丙');
  });
});
