import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchLivePlaylistDirect, livePlaylistApiUrl } from './live-playlist';
import type { LivePlaylistResponse } from './types';

/**
 * 直播列表客户端直连单测：覆盖「直连成功」与「各种失败回退服务端代理」两条路径。
 * 解析结构与 /api/live/playlist 共用 buildLivePlaylist，这里只验证传入的文本被正确使用。
 */

const M3U = `#EXTM3U
#PLAYLIST:测试订阅
#EXTINF:-1 tvg-id="cctv1" group-title="news",CCTV-1
https://stream.example.com/cctv1.m3u8
#EXTINF:-1 tvg-id="cctv5" group-title="sports",CCTV-5
https://stream.example.com/cctv5.m3u8`;

const SOURCE = 'https://upstream.example.com/list.m3u';

const serverPayload: LivePlaylistResponse = {
  name: '服务端缓存',
  channels: [{ id: 'cctv1', name: 'CCTV-1', url: 'https://stream.example.com/cctv1.m3u8' }],
  groups: ['news'],
};

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('livePlaylistApiUrl', () => {
  it('生成服务端代理地址，force 时追加 force=1', () => {
    expect(livePlaylistApiUrl(SOURCE)).toBe(`/api/live/playlist?${new URLSearchParams({ url: SOURCE })}`);
    expect(livePlaylistApiUrl(SOURCE, true)).toContain('force=1');
  });
});

describe('fetchLivePlaylistDirect', () => {
  it('直连成功：解析出与 /api/live/playlist 一致的 name/channels/groups', async () => {
    fetchMock.mockResolvedValueOnce(new Response(M3U, { status: 200 }));

    const result = await fetchLivePlaylistDirect(SOURCE);

    expect(result.name).toBe('测试订阅');
    expect(result.channels.map((c) => c.id)).toEqual(['cctv1', 'cctv5']);
    expect(result.channels[0]).toMatchObject({
      name: 'CCTV-1',
      url: 'https://stream.example.com/cctv1.m3u8',
      group: 'news',
      tvgId: 'cctv1',
    });
    expect(result.groups).toEqual(['news', 'sports']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 直连不能带 cookie、不能带 Referer
    expect(fetchMock).toHaveBeenCalledWith(
      SOURCE,
      expect.objectContaining({ cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' })
    );
  });

  it('直连网络/CORS 失败：回退服务端代理并 warn 一次', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(serverPayload), { status: 200 }));

    const result = await fetchLivePlaylistDirect(SOURCE);

    expect(result).toEqual(serverPayload);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(livePlaylistApiUrl(SOURCE));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('直连非 2xx：回退服务端代理', async () => {
    fetchMock.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(serverPayload), { status: 200 }));

    await expect(fetchLivePlaylistDirect(SOURCE)).resolves.toEqual(serverPayload);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('上游把错误页当 200 返回（HTML）：识别为非 M3U，回退服务端代理', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>not a playlist</html>', { status: 200 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(serverPayload), { status: 200 }));

    await expect(fetchLivePlaylistDirect(SOURCE)).resolves.toEqual(serverPayload);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('纯文本拒绝信息（非 URL）也回退服务端代理', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Access denied', { status: 200 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(serverPayload), { status: 200 }));

    await expect(fetchLivePlaylistDirect(SOURCE)).resolves.toEqual(serverPayload);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('无 #EXTM3U 头的裸 URL 列表仍可直连', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('https://stream.example.com/a.m3u8\nhttps://stream.example.com/b.m3u8', { status: 200 })
    );

    const result = await fetchLivePlaylistDirect(SOURCE);

    expect(result.channels).toHaveLength(2);
    expect(result.channels[0].url).toBe('https://stream.example.com/a.m3u8');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('请求被取消（AbortError）：不回退、不 warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    fetchMock.mockRejectedValueOnce(abortError);

    await expect(fetchLivePlaylistDirect(SOURCE)).rejects.toBe(abortError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('服务端回退也失败：抛出服务端错误文案', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: '订阅地址请求失败: 500' }), { status: 502 })
    );

    await expect(fetchLivePlaylistDirect(SOURCE)).rejects.toThrow('订阅地址请求失败: 500');
  });

  it('服务端回退 401：抛出需要登录（会话过期时交给全局未授权逻辑）', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: '未登录' }), { status: 401 }));

    await expect(fetchLivePlaylistDirect(SOURCE)).rejects.toThrow('需要登录');
  });
});
