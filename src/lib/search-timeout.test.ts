import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SOURCE_TIMEOUT_MS,
  MAX_SOURCE_TIMEOUT_MS,
  MIN_SOURCE_TIMEOUT_MS,
  normalizeSourceTimeoutMs,
  resolveSourceTimeoutMs,
} from './search-timeout';

describe('搜索单源等待上限', () => {
  it('部署默认 3s，非法值回退默认，越界收敛到 1s–60s', () => {
    expect(DEFAULT_SOURCE_TIMEOUT_MS).toBe(3000);
    expect(resolveSourceTimeoutMs(undefined)).toBe(3000);
    expect(resolveSourceTimeoutMs('')).toBe(3000);
    expect(resolveSourceTimeoutMs('2500')).toBe(2500);
    expect(resolveSourceTimeoutMs('abc')).toBe(3000);
    expect(resolveSourceTimeoutMs('10')).toBe(1000);
    expect(resolveSourceTimeoutMs('999999')).toBe(60000);
  });

  it('设置里的值优先：按同一区间收敛，缺省/非法值交给部署默认兜底', () => {
    expect(normalizeSourceTimeoutMs(2000)).toBe(2000);
    expect(normalizeSourceTimeoutMs('5000')).toBe(5000);
    expect(normalizeSourceTimeoutMs(500)).toBe(MIN_SOURCE_TIMEOUT_MS);
    expect(normalizeSourceTimeoutMs(120000)).toBe(MAX_SOURCE_TIMEOUT_MS);
    expect(normalizeSourceTimeoutMs(undefined)).toBeUndefined();
    expect(normalizeSourceTimeoutMs(null)).toBeUndefined();
    expect(normalizeSourceTimeoutMs('')).toBeUndefined();
    expect(normalizeSourceTimeoutMs('abc')).toBeUndefined();
  });
});
