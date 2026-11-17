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
  it('同名同年、封面不同：并成一张卡（2026-11-16 用户改口径：同片不同海报也要并）', () => {
    const groups = aggregateResults([
      item({ name: '色戒', year: '2007', pic: COVER_A, typeName: '剧情片' }),
      item({ name: '色戒', year: '2007', pic: COVER_B, typeName: '伦理片' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(2);
  });

  it('同名不同年：不并（《色戒》2002 Samsara 与 2007 是两部片）', () => {
    const groups = aggregateResults([
      item({ name: '色戒', year: '2002', pic: COVER_A }),
      item({ name: '色戒', year: '2007', pic: COVER_B }),
    ]);

    expect(groups).toHaveLength(2);
  });

  it('不同片名、不同封面：不并（不靠 URL 指纹跨站乱并）', () => {
    const groups = aggregateResults([
      item({ name: '色戒', year: '2007', pic: COVER_A }),
      item({ name: '大开色戒', year: '2007', pic: COVER_B }),
    ]);

    expect(groups).toHaveLength(2);
  });

  it('剧版/影版同名同年、封面指纹距离 28：并组（用户接受剧影同卡）', () => {
    const coverHashes = new Map([
      ['https://a.com/tv.jpg', 'b68ecece8ea7cbc9'],
      ['https://b.com/movie.jpg', '234663494d1b1911'],
    ]);
    const groups = aggregateResults(
      [
        item({ name: '三生三世十里桃花', year: '2017', pic: 'https://a.com/tv.jpg', typeName: '国产剧' }),
        item({ name: '三生三世十里桃花', year: '2017', pic: 'https://b.com/movie.jpg', typeName: '爱情片' }),
      ],
      { coverHashes }
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(2);
  });

  it('同一张封面跨片名、跨年份合并；标题取更短的写法，年份取多数', () => {
    const groups = aggregateResults([
      item({ name: '色戒', year: '2002', pic: COVER_A }),
      item({ name: '色戒Samsara', year: '2001', pic: COVER_A_MIRROR }),
    ]);

    // 2026-11-18 用户确认恢复「同封面必并」：视觉指纹层不按年份拆分
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

  it('有封面与无封面的同名同年条目：并组（片名+年份 兜底）', () => {
    const groups = aggregateResults([
      item({ name: '色戒', year: '2007', pic: COVER_A }),
      item({ name: '色戒', year: '2007' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(2);
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

    // 同海报两条的年份不同：视觉指纹层仍然合并（跨年护栏已按用户要求回滚）
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

  it('同封面跨年（含采集站错挂海报）：按用户口径一律并组（已知代价）', () => {
    const groups = aggregateResults(
      [
        item({
          sourceKey: 's1',
          sourceName: '源1',
          vodId: '1',
          name: '射雕英雄传',
          year: '1983',
          pic: 'https://img.test/1983.jpg',
        }),
        // 源 2 把 2017 版的封面错配成 1983 版海报：2026-11-18 用户确认接受这个代价
        item({
          sourceKey: 's2',
          sourceName: '源2',
          vodId: '2',
          name: '射雕英雄传',
          year: '2017',
          pic: 'https://img.test/1983.jpg',
        }),
        item({
          sourceKey: 's3',
          sourceName: '源3',
          vodId: '3',
          name: '射雕英雄传',
          year: '2017',
          pic: 'https://img.test/2017.jpg',
        }),
      ],
      {
        coverHashes: new Map([
          ['https://img.test/1983.jpg', '1111111111111111'],
          ['https://img.test/2017.jpg', 'ffffffffffffffff'],
        ]),
      }
    );

    // 共享封面把三个条目连成一个连通分量；年份取多数 2017
    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(3);
    expect(groups[0].year).toBe('2017');
  });

  it('视觉指纹明显不同：同名同年仍并组（片名+年份 层兜底）', () => {
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

    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(2);
  });

  it('没有视觉指纹时按 URL 指纹分组，但同名同年仍并组', () => {
    const groups = aggregateResults(
      [
        item({ name: '色戒', year: '2007', pic: COVER_A }),
        item({ name: '色戒', year: '2007', pic: COVER_B }),
      ],
      { coverHashes: new Map([[COVER_A, '0000000000000000']]) }
    );

    // A 走视觉指纹、B 走 URL 指纹，靠「片名 + 年份」这一层并到一起
    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(2);
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
