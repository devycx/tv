import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEnvImageMode } from './env-image-mode';

const KEY = 'DEFAULT_IMAGE_MODE';
const original = process.env[KEY];

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
  vi.restoreAllMocks();
});

describe('getEnvImageMode', () => {
  it('未配置时返回 undefined', () => {
    delete process.env[KEY];
    expect(getEnvImageMode()).toBeUndefined();
  });

  it('空值与纯空白视为未配置', () => {
    for (const v of ['', '   ']) {
      process.env[KEY] = v;
      expect(getEnvImageMode()).toBeUndefined();
    }
  });

  it('direct 正常返回；已废弃的 proxy 归一为 direct 并告警', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env[KEY] = 'DIRECT';
    expect(getEnvImageMode()).toBe('direct');

    for (const v of ['PROXY', ' proxy ']) {
      warn.mockClear();
      process.env[KEY] = v;
      expect(getEnvImageMode()).toBe('direct');
      expect(warn).toHaveBeenCalled();
    }
  });

  it('非法取值返回 undefined 而非抛错', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env[KEY] = 'custom';
    expect(getEnvImageMode()).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
