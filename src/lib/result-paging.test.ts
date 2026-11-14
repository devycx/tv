import { describe, expect, it } from 'vitest';
import { applyFrozenOrder, orderDiffers } from './result-paging';

const g = (key: string, n = 1) => ({ key, n });

describe('applyFrozenOrder', () => {
  it('按冻结顺序重排，组内容取最新', () => {
    const groups = [g('c', 3), g('a', 2), g('b', 1)];
    const out = applyFrozenOrder(groups, ['a', 'b', 'c']);
    expect(out.map((x) => x.key)).toEqual(['a', 'b', 'c']);
    // 内容用新列表里的对象，不是冻结时的旧对象
    expect(out[0].n).toBe(2);
  });

  it('新条目追加到尾部，不打乱已冻结的前缀', () => {
    const groups = [g('x'), g('a'), g('y'), g('b')];
    const out = applyFrozenOrder(groups, ['a', 'b']);
    expect(out.map((x) => x.key)).toEqual(['a', 'b', 'x', 'y']);
  });

  it('冻结列表里已消失的 key 被丢弃，不产生空洞', () => {
    const out = applyFrozenOrder([g('a')], ['a', 'gone', 'b']);
    expect(out.map((x) => x.key)).toEqual(['a']);
  });

  it('冻结列表为空时等价于原顺序', () => {
    const groups = [g('b'), g('a')];
    expect(applyFrozenOrder(groups, []).map((x) => x.key)).toEqual(['b', 'a']);
  });

  it('重复 key 只保留第一次出现', () => {
    const out = applyFrozenOrder([g('a')], ['a', 'a']);
    expect(out).toHaveLength(1);
  });
});

describe('orderDiffers', () => {
  it('长度不同即视为不同', () => {
    expect(orderDiffers([g('a')], [g('a'), g('b')])).toBe(true);
  });

  it('同长度但顺序不同也算不同', () => {
    expect(orderDiffers([g('a'), g('b')], [g('b'), g('a')])).toBe(true);
  });

  it('顺序一致时为 false', () => {
    expect(orderDiffers([g('a'), g('b')], [g('a'), g('b')])).toBe(false);
  });
});
