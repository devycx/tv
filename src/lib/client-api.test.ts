import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, UNAUTHORIZED_EVENT, api } from './client-api';
import { __resetAdaptiveBatchForTests, getAdaptiveBatchLimit } from './adaptive-batch';

/**
 * 客户端 API 层最容易伤到用户的两条判定，必须钉住：
 * - Cloudflare 1102（Worker 资源超限）要识别、降批、给资源超限文案；
 * - 503 只有本站 JSON 才是「未配置密码」。Cloudflare 的错误页是 HTML，
 *   误判会弹出登录框（用户以为是自己密码问题，实际是 Worker 被打爆）。
 */

const fetchMock = vi.fn<typeof fetch>();
const dispatch = vi.fn();

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const htmlResponse = (body: string, status: number) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=UTF-8' } });

/** Cloudflare 1102 的两条识别途径：cf-error-code 头 / 错误页文案 */
const cfLimitByHeader = () =>
  new Response('{}', { status: 500, headers: { 'content-type': 'application/json', 'cf-error-code': '1102' } });
const cfLimitByBody = () =>
  htmlResponse('<html><body><span>Error 1102</span> Worker exceeded resource limits</body></html>', 500);

beforeEach(() => {
  fetchMock.mockReset();
  dispatch.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('window', { dispatchEvent: dispatch });
  __resetAdaptiveBatchForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('request：1102 识别与降批', () => {
  it('cf-error-code: 1102 → resourceLimit + 资源超限文案 + 全局降批', async () => {
    fetchMock.mockResolvedValueOnce(cfLimitByHeader());

    const err = await api.hotList('movie').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 500, resourceLimit: true });
    expect((err as Error).message).toContain('1102');
    expect(getAdaptiveBatchLimit(8)).toBe(4);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('错误页文案（无 cf-error-code 头）也能识别', async () => {
    fetchMock.mockResolvedValueOnce(cfLimitByBody());

    await expect(api.hotList('movie')).rejects.toThrow(/1102/);
    expect(getAdaptiveBatchLimit(8)).toBe(4);
  });

  it('普通业务 500 不算 1102：保留服务端文案，不降批', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: '上游超时' }, 500));

    await expect(api.hotList('movie')).rejects.toThrow('上游超时');
    expect(getAdaptiveBatchLimit(8)).toBe(8);
  });

  it('连续两次 1102 会连续降档（8 → 4 → 2）', async () => {
    fetchMock.mockResolvedValueOnce(cfLimitByBody());
    fetchMock.mockResolvedValueOnce(cfLimitByBody());

    await expect(api.hotList('movie')).rejects.toMatchObject({ resourceLimit: true });
    expect(getAdaptiveBatchLimit(8)).toBe(4);
    await expect(api.hotList('movie')).rejects.toMatchObject({ resourceLimit: true });
    expect(getAdaptiveBatchLimit(8)).toBe(2);
  });
});

describe('request：503 的两种语义', () => {
  it('503 JSON（本站未配置 PASSWORD）→ 弹登录框并抛 503', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: '服务器未设置 PASSWORD 环境变量' }, 503));

    await expect(api.hotList('movie')).rejects.toMatchObject({ status: 503 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const event = dispatch.mock.calls[0][0] as CustomEvent;
    expect(event.type).toBe(UNAUTHORIZED_EVENT);
    expect(event.detail).toBe('setup');
  });

  it('503 HTML + 1102 → 不弹登录框，按资源超限处理', async () => {
    fetchMock.mockResolvedValueOnce(
      htmlResponse('<html>Error 1102 Worker exceeded resource limits</html>', 503)
    );

    await expect(api.hotList('movie')).rejects.toMatchObject({ status: 503, resourceLimit: true });
    expect(dispatch).not.toHaveBeenCalled();
    expect(getAdaptiveBatchLimit(8)).toBe(4);
  });

  it('503 HTML 但不是 1102 → 不弹登录框，保留状态码文案', async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse('<html>maintenance</html>', 503));

    await expect(api.hotList('movie')).rejects.toThrow('请求失败 (503)');
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('流式入口同样识别 1102', () => {
  it('liveProbeStream', async () => {
    fetchMock.mockResolvedValueOnce(cfLimitByBody());

    await expect(api.liveProbeStream(['https://a.example.com/x.m3u8'], () => {})).rejects.toMatchObject({
      resourceLimit: true,
    });
    expect(getAdaptiveBatchLimit(8)).toBe(4);
  });

  it('qualityProbeStream', async () => {
    fetchMock.mockResolvedValueOnce(cfLimitByBody());

    await expect(
      api.qualityProbeStream(
        [{ source: { key: 's1', name: 's1', url: 'https://s1.example.com/api.php/provide/vod' }, id: 'vod-1' }],
        () => {}
      )
    ).rejects.toMatchObject({ resourceLimit: true });
    expect(getAdaptiveBatchLimit(8)).toBe(4);
  });

  it('searchStream（带 onSource 的聚合搜索）', async () => {
    fetchMock.mockResolvedValueOnce(cfLimitByBody());

    await expect(api.search('测试', [], false, { onSource: () => {} })).rejects.toMatchObject({
      resourceLimit: true,
    });
    expect(getAdaptiveBatchLimit(8)).toBe(4);
  });
});
