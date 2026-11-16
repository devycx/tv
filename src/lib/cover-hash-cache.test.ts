import { describe, expect, it } from 'vitest';
import {
  HASH_CACHE_MAX_BYTES,
  HASH_CACHE_MAX_ENTRIES,
  estimateHashCacheBytes,
  trimHashCache,
} from './cover-hash-cache';

const url = (i: number, pad = 0) =>
  `https://pic.example.com${'x'.repeat(pad)}/upload/vod/${String(i).padStart(6, '0')}.jpg`;
const hash = (i: number) => i.toString(16).padStart(16, '0');

function makeEntries(count: number, pad = 0): Array<[string, string]> {
  return Array.from({ length: count }, (_, i) => [url(i, pad), hash(i)] as [string, string]);
}

describe('estimateHashCacheBytes', () => {
  it('空缓存的 JSON 是 {}', () => {
    expect(estimateHashCacheBytes([])).toBe(2);
  });

  it('随条数线性增长，且和实际序列化长度接近（±10%）', () => {
    const entries = makeEntries(50);
    const estimated = estimateHashCacheBytes(entries);
    const actual = JSON.stringify(Object.fromEntries(entries)).length;
    expect(Math.abs(estimated - actual) / actual).toBeLessThan(0.1);
  });
});

describe('trimHashCache（条数 + 字节双预算的 LRU 淘汰）', () => {
  it('没超预算时原样保留、不改顺序', () => {
    const entries = makeEntries(10);
    expect(trimHashCache(entries)).toEqual(entries);
  });

  it('超过条数上限：保留最新的 HASH_CACHE_MAX_ENTRIES 条（最旧在前）', () => {
    const entries = makeEntries(HASH_CACHE_MAX_ENTRIES + 25);
    const kept = trimHashCache(entries);
    expect(kept).toHaveLength(HASH_CACHE_MAX_ENTRIES);
    expect(kept[0][0]).toBe(url(25));
    expect(kept.at(-1)?.[0]).toBe(url(HASH_CACHE_MAX_ENTRIES + 24));
  });

  it('超过字节预算：按最旧优先淘汰，结果不超预算', () => {
    // 长 URL 撑爆字节预算，但条数远未到上限
    const entries = makeEntries(400, 4000);
    expect(entries.length).toBeLessThan(HASH_CACHE_MAX_ENTRIES);
    expect(estimateHashCacheBytes(entries)).toBeGreaterThan(HASH_CACHE_MAX_BYTES);

    const kept = trimHashCache(entries);
    expect(estimateHashCacheBytes(kept)).toBeLessThanOrEqual(HASH_CACHE_MAX_BYTES);
    expect(kept.length).toBeLessThan(entries.length);
    // 保留下来的必须是原来靠后的（最新的）连续一段
    expect(kept.at(-1)).toEqual(entries.at(-1));
    expect(kept[0][0]).toBe(entries[entries.length - kept.length][0]);
  });

  it('至少保留 1 条（哪怕单条就超预算）', () => {
    const entries = [[`https://a.example.com/${'y'.repeat(HASH_CACHE_MAX_BYTES)}.jpg`, hash(1)]] as Array<
      [string, string]
    >;
    expect(trimHashCache(entries)).toHaveLength(1);
  });

  it('空输入返回空数组', () => {
    expect(trimHashCache([])).toEqual([]);
  });
});
