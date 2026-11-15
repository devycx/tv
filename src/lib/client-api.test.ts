import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, UNAUTHORIZED_EVENT, api } from './client-api';
import { isPasswordSetupResponse } from './api-failure';
import type { SearchResultItem, SourceConfig } from './types';

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

/* —— 搜索拆批：Cloudflare 每 invocation 只有 6 个等待响应头的连接槽 —— */

const makeSource = (i: number): SourceConfig => ({
  key: `s${i}`,
  name: `源${i}`,
  url: `https://s${i}.example.com/api.php/provide/vod`,
});

const makeItem = (sourceKey: string, name: string, vodId = `v-${sourceKey}`): SearchResultItem => ({
  sourceKey,
  sourceName: sourceKey,
  vodId,
  name,
});

/** 构造一个 NDJSON 流响应（source 事件 + done 事件） */
function ndjsonResponse(events: unknown[]): Response {
  return new Response(events.map((event) => JSON.stringify(event)).join('\n') + '\n', {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
  });
}

/** 每个 chunk 都返回自己那批源的 source/done 事件，done 里带上各自的列表 */
function streamForChunks(failures: Record<string, string> = {}) {
  return async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { wd: string; sources: SourceConfig[] };
    const { wd, sources } = body;
    const fail = failures[wd];
    if (fail) return json({ error: fail }, 500);
    const events: unknown[] = [];
    for (const source of sources) {
      events.push({
        type: 'source',
        sourceKey: source.key,
        ok: true,
        list: [makeItem(source.key, `${wd} ${source.key}`)],
      });
    }
    events.push({
      type: 'done',
      list: sources.map((source) => makeItem(source.key, `${wd} ${source.key}`)),
      failures: [],
    });
    return ndjsonResponse(events);
  };
}

describe('搜索拆批', () => {
  it('源数 ≤ 8 时不拆：只发一次请求', async () => {
    const sources = Array.from({ length: 8 }, (_, i) => makeSource(i));
    fetchMock.mockImplementation(streamForChunks());

    const onSource = vi.fn();
    const res = await api.search('测试', sources, false, { onSource });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onSource).toHaveBeenCalledTimes(8);
    expect(res.list).toHaveLength(8);
  });

  it('源数 > 8 时拆两个请求：逐源回调、结果合并去重', async () => {
    const sources = Array.from({ length: 10 }, (_, i) => makeSource(i));
    fetchMock.mockImplementation(streamForChunks());

    const onSource = vi.fn();
    const res = await api.search('测试', sources, false, { onSource });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onSource).toHaveBeenCalledTimes(10);
    expect(res.list).toHaveLength(10);
    expect(new Set(res.list.map((item) => item.vodId)).size).toBe(10);
  });

  it('跨两批的结果按全局相关性重排（精确同名优先于前缀命中）', async () => {
    const sources = Array.from({ length: 10 }, (_, i) => makeSource(i));
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { sources: SourceConfig[] };
      // 第一批给「庆余年 第二季」，第二批给「庆余年」：直接拼接会把精确命中排到后面
      const isFirst = body.sources[0].key === 's0';
      const hit = isFirst
        ? makeItem('s0', '庆余年 第二季', 'v-prefix')
        : makeItem('s5', '庆余年', 'v-exact');
      return ndjsonResponse([{ type: 'done', list: [hit], failures: [] }]);
    });

    const res = await api.search('庆余年', sources, false, { onSource: () => {} });

    expect(res.list.map((item) => item.name)).toEqual(['庆余年', '庆余年 第二季']);
  });

  it('无 onSource 时同样拆成两个 JSON 请求并合并 failures', async () => {
    const sources = Array.from({ length: 10 }, (_, i) => makeSource(i));
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { sources: SourceConfig[] };
      const first = body.sources[0].key === 's0';
      return json({
        list: body.sources.map((source) => makeItem(source.key, `片 ${source.key}`)),
        failures: first ? [] : [{ sourceKey: 's9', error: '超时', timedOut: true }],
      });
    });

    const res = await api.search('测试', sources, false);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.list).toHaveLength(10);
    expect(res.failures).toEqual([{ sourceKey: 's9', error: '超时', timedOut: true }]);
  });

  it('任意一批失败时整次搜索报错（与单请求语义一致）', async () => {
    const sources = Array.from({ length: 10 }, (_, i) => makeSource(i));
    let calls = 0;
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        const body = JSON.parse(String(init?.body)) as { sources: SourceConfig[] };
        return ndjsonResponse([
          { type: 'done', list: body.sources.map((s) => makeItem(s.key, '片')), failures: [] },
        ]);
      }
      return json({ error: '搜索失败' }, 500);
    });

    await expect(api.search('测试', sources, false, { onSource: () => {} })).rejects.toMatchObject({
      status: 500,
    });
  });
});
