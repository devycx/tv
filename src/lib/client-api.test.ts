import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, UNAUTHORIZED_EVENT, api } from './client-api';
import { isPasswordSetupResponse } from './api-failure';

/**
 * 503 的两种语义必须分清：
 * - 本站 JSON 503 = 未配置 PASSWORD（弹配置提示）；
 * - Cloudflare 的 503 错误页是 HTML（Worker CPU/内存超限 1102 就返回 503），
 *   不能弹「需要配置密码」——这正是线上手机端误弹配置窗的根因，必须钉住。
 */

const fetchMock = vi.fn<typeof fetch>();
const dispatch = vi.fn();

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const html = (body: string, status: number) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=UTF-8' } });

beforeEach(() => {
  fetchMock.mockReset();
  dispatch.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('window', { dispatchEvent: dispatch });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('isPasswordSetupResponse', () => {
  it('只认 503 + JSON', () => {
    expect(isPasswordSetupResponse(json({ error: 'x' }, 503))).toBe(true);
    expect(isPasswordSetupResponse(html('<html>Error 1102</html>', 503))).toBe(false);
    expect(isPasswordSetupResponse(json({ error: 'x' }, 500))).toBe(false);
    expect(isPasswordSetupResponse(html('<html>Error 1102</html>', 500))).toBe(false);
  });
});

describe('request 的 503 处理', () => {
  it('503 JSON（未配置 PASSWORD）→ 弹配置提示', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: '服务器未设置 PASSWORD 环境变量' }, 503));

    await expect(api.hotList('movie')).rejects.toBeInstanceOf(ApiError);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const event = dispatch.mock.calls[0][0] as CustomEvent;
    expect(event.type).toBe(UNAUTHORIZED_EVENT);
    expect(event.detail).toBe('setup');
  });

  it('503 HTML（Cloudflare 1102 错误页）→ 不弹配置提示', async () => {
    fetchMock.mockResolvedValueOnce(
      html('<html><span>Error 1102</span> Worker exceeded resource limits</html>', 503)
    );

    await expect(api.hotList('movie')).rejects.toThrow('请求失败 (503)');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('401 仍然弹登录框（不受 503 判定影响）', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: '未登录' }, 401));

    await expect(api.hotList('movie')).rejects.toMatchObject({ status: 401 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    // 401 的事件不带 detail（CustomEvent 未传 detail 时为 null，这里统一按「非 setup」断言）
    expect((dispatch.mock.calls[0][0] as CustomEvent).detail).not.toBe('setup');
  });
});
