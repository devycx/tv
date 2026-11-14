import { describe, expect, it } from 'vitest';
import { compareSearchResults, matchTitle, parseYear } from './relevance';

describe('matchTitle', () => {
  it('归一化后完全相等得满分，并按原始写法分三级', () => {
    expect(matchTitle('色戒', '色戒')).toEqual({ score: 100, exactKind: 0 });
    // 只差大小写：英文片名常见
    expect(matchTitle('Interstellar', 'interstellar')).toEqual({ score: 100, exactKind: 1 });
    // 只差标点/空白：中文片名常见
    expect(matchTitle('色，戒', '色戒')).toEqual({ score: 100, exactKind: 2 });
    expect(matchTitle('色 戒', '色戒')).toEqual({ score: 100, exactKind: 2 });
  });

  it('前缀命中高于包含命中，且标题越短分越高', () => {
    const prefixShort = matchTitle('色戒', '色').score;
    const prefixLong = matchTitle('色戒未删减版', '色').score;
    const contains = matchTitle('大开色戒', '色戒').score;
    expect(prefixShort).toBeGreaterThan(prefixLong);
    expect(prefixLong).toBeGreaterThanOrEqual(90);
    expect(prefixLong).toBeLessThan(100);
    expect(contains).toBeGreaterThanOrEqual(80);
    expect(contains).toBeLessThan(85);
  });

  it('多词查询要求每个词都命中，且整串包含时更靠前', () => {
    const allTokens = matchTitle('钢铁侠 Iron Man 2008', '钢铁侠 2008');
    expect(allTokens.score).toBeGreaterThanOrEqual(85);
    // 只看命中方式：真实排序里「钢铁侠 2008」整串包含会更高
    expect(allTokens.score).toBeLessThan(matchTitle('钢铁侠 2008', '钢铁侠 2008').score);
  });

  it('错别字级别的近似命中落在「包含」与「不相关」之间', () => {
    const typo = matchTitle('流浪地珠', '流浪地球');
    expect(typo.score).toBeGreaterThanOrEqual(60);
    expect(typo.score).toBeLessThan(80);
  });

  it('短关键词不做近似：「戒色」不能算「色戒」的命中', () => {
    expect(matchTitle('戒色', '色戒').score).toBe(0);
    expect(matchTitle('色戒2', '色戒').score).toBeGreaterThan(0);
  });

  it('空输入得 0 分', () => {
    expect(matchTitle(undefined, '色戒').score).toBe(0);
    expect(matchTitle('色戒', '  ').score).toBe(0);
  });
});

describe('parseYear', () => {
  it('四位年份有效，缺失/非法返回 0', () => {
    expect(parseYear('2007')).toBe(2007);
    expect(parseYear('2007-08-30')).toBe(2007);
    expect(parseYear(undefined)).toBe(0);
    expect(parseYear('')).toBe(0);
    expect(parseYear('未知')).toBe(0);
  });
});

describe('compareSearchResults', () => {
  const sort = (items: Array<{ name?: string; year?: string; sourceName?: string }>, wd: string) =>
    [...items].sort((a, b) => compareSearchResults(a, b, wd)).map((i) => `${i.name}${i.year ? `(${i.year})` : ''}`);

  it('相关性优先于年份：年份新的不相关条目不能挤掉老片', () => {
    const out = sort(
      [
        { name: '色戒未删减', year: '2024' },
        { name: '色戒', year: '2007' },
        { name: '戒色', year: '2019' },
        { name: '色戒', year: '2007', sourceName: 'B' },
        { name: '色戒', year: '2007', sourceName: 'A' },
      ],
      '色戒'
    );
    expect(out[0]).toBe('色戒(2007)');
    expect(out[1]).toBe('色戒(2007)');
    expect(out[2]).toBe('色戒(2007)');
    expect(out[3]).toBe('色戒未删减(2024)');
  });

  it('同档内年份由近及远，缺年份排最后', () => {
    const out = sort(
      [
        { name: '色戒前传' },
        { name: '色戒前传', year: '2001' },
        { name: '色戒前传', year: '2015' },
      ],
      '色戒'
    );
    expect(out).toEqual(['色戒前传(2015)', '色戒前传(2001)', '色戒前传']);
  });

  it('同分同名时顺序完全确定：按源名兜底，不随输入顺序抖动', () => {
    const a = { name: '色戒', year: '2007', sourceName: '乙源' };
    const b = { name: '色戒', year: '2007', sourceName: '甲源' };
    expect(compareSearchResults(a, b, '色戒')).toBeGreaterThan(0);
    expect(compareSearchResults(b, a, '色戒')).toBeLessThan(0);
  });
});
