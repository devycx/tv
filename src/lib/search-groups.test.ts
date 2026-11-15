import { describe, expect, it } from 'vitest';
import { aggregateResults } from './search-groups';
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

describe('aggregateResults（按封面聚合）', () => {
  it('同名同年但封面不同：拆成不同卡片，不再混成一个「N 源」', () => {
    const groups = aggregateResults([
      item({ name: '色戒', year: '2007', pic: COVER_A, typeName: '剧情片' }),
      item({ name: '色戒', year: '2007', pic: COVER_B, typeName: '伦理片' }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.items)).toHaveLength(2);
    expect(groups[0].items).toHaveLength(1);
    expect(groups[1].items).toHaveLength(1);
  });

  it('同一张封面跨片名、跨年份合并；标题取更短的写法，年份取多数', () => {
    const groups = aggregateResults([
      item({ name: '色戒', year: '2002', pic: COVER_A }),
      item({ name: '色戒Samsara', year: '2001', pic: COVER_A_MIRROR }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('色戒');
    // 年份并列时取列表里先出现的（列表已按相关性排序）
    expect(groups[0].year).toBe('2002');
    expect(groups[0].items).toHaveLength(2);
  });

  it('同封面镜像源（不同域名、同一内容哈希）合并为一张卡', () => {
    const groups = aggregateResults([
      item({ name: '色戒2007', year: '2007', pic: COVER_A, sourceName: 'A' }),
      item({ name: '色戒2007', year: '2007', pic: COVER_A_MIRROR, sourceName: 'B' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(2);
    expect(groups[0].pic).toBe(COVER_A);
  });

  it('电影解说与正片共用海报时不合并', () => {
    const groups = aggregateResults([
      item({ name: '色，戒', pic: COVER_A }),
      item({ name: '色，戒[电影解说]', pic: COVER_A }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.items[0].name).sort()).toEqual(['色，戒', '色，戒[电影解说]'].sort());
  });

  it('没有封面时退回「片名 + 年份」：同年合并，跨年拆分', () => {
    const sameYear = aggregateResults([
      item({ name: '色戒', year: '2007' }),
      item({ name: '色 戒', year: '2007' }),
    ]);
    expect(sameYear).toHaveLength(1);
    expect(sameYear[0].items).toHaveLength(2);

    const crossYear = aggregateResults([
      item({ name: '色戒', year: '2007' }),
      item({ name: '色戒', year: '2002' }),
    ]);
    expect(crossYear).toHaveLength(2);
  });

  it('有封面与无封面的同名同年条目不强行合并（封面身份未知）', () => {
    const groups = aggregateResults([
      item({ name: '色戒', year: '2007', pic: COVER_A }),
      item({ name: '色戒', year: '2007' }),
    ]);

    expect(groups).toHaveLength(2);
  });

  it('封面视觉指纹相近：不同 URL/片名的同一张海报合并', () => {
    const hashA = 'b25eb2aa76e2b132';
    const hashNear = 'b636b2aa76e2e13a'; // 同海报不同分辨率，汉明距离 7
    const hashFar = '7cf4e1d3d5d496e8'; // 另一部片的海报
    const coverHashes = new Map([
      ['https://a.com/samsara-270.jpg', hashA],
      ['https://b.com/samsara-350.jpg', hashNear],
      ['https://c.com/lust-caution.jpg', hashFar],
    ]);

    const groups = aggregateResults(
      [
        item({ name: '色戒', year: '2002', pic: 'https://a.com/samsara-270.jpg' }),
        item({ name: '色戒2001', year: '2001', pic: 'https://b.com/samsara-350.jpg' }),
        item({ name: '色戒', year: '2007', pic: 'https://c.com/lust-caution.jpg' }),
      ],
      { coverHashes }
    );

    expect(groups).toHaveLength(2);
    const samsara = groups.find((g) => g.items.length === 2);
    expect(samsara?.items.map((i) => i.year).sort()).toEqual(['2001', '2002']);
    expect(groups.find((g) => g.items.length === 1)?.items[0].year).toBe('2007');
  });

  it('视觉指纹明显不同：同名同年也拆开（指纹优先于片名）', () => {
    const coverHashes = new Map([
      ['https://a.com/lust-a.jpg', '0000000000000000'],
      ['https://b.com/lust-b.jpg', 'ffffffffffffffff'],
    ]);

    const groups = aggregateResults(
      [
        item({ name: '色戒', year: '2007', pic: 'https://a.com/lust-a.jpg' }),
        item({ name: '色戒', year: '2007', pic: 'https://b.com/lust-b.jpg' }),
      ],
      { coverHashes }
    );

    expect(groups).toHaveLength(2);
  });

  it('没有视觉指纹时退回 URL 指纹，不跨站乱并', () => {
    const groups = aggregateResults(
      [
        item({ name: '色戒', year: '2007', pic: COVER_A }),
        item({ name: '色戒', year: '2007', pic: COVER_B }),
      ],
      { coverHashes: new Map([[COVER_A, '0000000000000000']]) }
    );

    // A 走视觉指纹，B 走 URL 指纹，两者不可能同组
    expect(groups).toHaveLength(2);
  });

  it('组内备注推到统一结论', () => {
    const groups = aggregateResults([
      item({ name: '庆余年', year: '2019', pic: COVER_A, remarks: '全36集' }),
      item({ name: '庆余年', year: '2019', pic: COVER_A_MIRROR, remarks: '更新至36集' }),
    ]);

    expect(groups[0].remarks).toBe('全36集');
  });

  it('组标题取更干净的写法，组顺序按首次出现的位置', () => {
    const groups = aggregateResults([
      item({ name: '色戒2007', year: '2007', pic: COVER_A }),
      item({ name: '色戒', year: '2007', pic: COVER_A_MIRROR }),
      item({ name: '色戒2007', year: '2007', pic: 'https://c.com/x/78288c7898fdad99aee06e3b42213c7b.jpg' }),
      item({ name: '大开色戒', year: '1999', pic: COVER_B }),
    ]);

    expect(groups).toHaveLength(2);
    // 出处多数是「色戒2007」，但标题应去掉年份后缀，取「色戒」
    expect(groups[0].name).toBe('色戒');
    expect(groups[0].items).toHaveLength(3);
    expect(groups[1].name).toBe('大开色戒');
  });

  it('组内没有干净写法时保留原标题', () => {
    const groups = aggregateResults([
      item({ name: '色·戒.Lust, Caution.2007.TW.BluRay.x264', pic: COVER_A }),
      item({ name: '色·戒.Lust, Caution.2007.TW.BluRay.x265', pic: COVER_A_MIRROR }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].name).toContain('色·戒');
  });

  it('空片名条目直接丢弃', () => {
    expect(aggregateResults([item({ name: '   ' })])).toEqual([]);
  });
});
