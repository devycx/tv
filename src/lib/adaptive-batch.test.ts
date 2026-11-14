import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAdaptiveBatchForTests,
  getAdaptiveBatchLimit,
  getAdaptiveBatchScale,
  isWorkerResourceLimit,
  onAdaptiveBatchDownscale,
  reportWorkerResourceLimit,
} from './adaptive-batch';

beforeEach(() => {
  __resetAdaptiveBatchForTests();
});

describe('adaptive batch limit', () => {
  it('每次 1102 减半，最低 1/8，且批大小至少 1', () => {
    expect(getAdaptiveBatchScale()).toBe(1);
    expect(getAdaptiveBatchLimit(8)).toBe(8);

    reportWorkerResourceLimit();
    expect(getAdaptiveBatchLimit(8)).toBe(4);

    reportWorkerResourceLimit();
    expect(getAdaptiveBatchLimit(8)).toBe(2);

    reportWorkerResourceLimit();
    expect(getAdaptiveBatchLimit(8)).toBe(1);

    // 已到最低档，继续 1102 不再变化
    reportWorkerResourceLimit();
    expect(getAdaptiveBatchScale()).toBe(1 / 8);
    expect(getAdaptiveBatchLimit(8)).toBe(1);
  });

  it('小基准也不会降到 0', () => {
    reportWorkerResourceLimit();
    reportWorkerResourceLimit();
    reportWorkerResourceLimit();
    expect(getAdaptiveBatchLimit(2)).toBe(1);
    expect(getAdaptiveBatchLimit(1)).toBe(1);
  });

  it('降批时通知订阅者，退订后不再通知', () => {
    const listener = vi.fn();
    const off = onAdaptiveBatchDownscale(listener);
    reportWorkerResourceLimit();
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    reportWorkerResourceLimit();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('isWorkerResourceLimit', () => {
  it('识别 500 错误页的 1102 文案', () => {
    expect(isWorkerResourceLimit(500, '<span>Error 1102</span> Worker exceeded resource limits')).toBe(true);
    expect(isWorkerResourceLimit(500, 'Worker exceeded resource limits')).toBe(true);
    expect(isWorkerResourceLimit(503, 'exceeded resource limits')).toBe(true);
  });

  it('识别 cf-error-code 头', () => {
    expect(isWorkerResourceLimit(500, '', new Headers({ 'cf-error-code': '1102' }))).toBe(true);
  });

  it('普通业务错误不算 1102', () => {
    expect(isWorkerResourceLimit(500, '{"error":"上游超时"}')).toBe(false);
    expect(isWorkerResourceLimit(400, '1102')).toBe(false);
    expect(isWorkerResourceLimit(200, '1102')).toBe(false);
  });
});
