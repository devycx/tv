import { afterEach, describe, expect, it, vi } from 'vitest';
import { getGmFetch, hasGmFetch } from './gm-fetch';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('gm-fetch 桥接', () => {
  it('没有 window（SSR）时视为未安装', () => {
    expect(getGmFetch()).toBeNull();
    expect(hasGmFetch()).toBe(false);
  });

  it('油猴脚本把 GM_fetch 挂到 window 上时返回该函数', () => {
    const gmFetch = vi.fn();
    vi.stubGlobal('window', { GM_fetch: gmFetch });
    expect(getGmFetch()).toBe(gmFetch);
    expect(hasGmFetch()).toBe(true);
  });

  it('window.GM_fetch 不是函数时视为未安装（脚本被禁用/只注入了一半）', () => {
    vi.stubGlobal('window', { GM_fetch: 'not-a-function' });
    expect(getGmFetch()).toBeNull();
    expect(hasGmFetch()).toBe(false);
  });
});
