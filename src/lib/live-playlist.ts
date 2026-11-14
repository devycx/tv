import { buildLivePlaylist } from './m3u-parser';
import type { LivePlaylistResponse } from './types';

/**
 * 直播 M3U 列表的客户端直连层。
 *
 * 12 个预置直播源实测都返回 `Access-Control-Allow-Origin: *`，浏览器可以直接拉取，
 * 不必每个列表都绕一次 Worker（`/api/live/playlist`）——一次直播页加载少 12 个 Worker
 * 请求，也省掉 12 次 Worker 上的上游拉取与 M3U 解析。
 *
 * 直连不是唯一路径：以下情况都会自动回退到服务端代理，能力与改造前完全一致：
 * - 上游不允许跨域（CORS）或被浏览器按混合内容拦截（用户自建的 http:// 源）；
 * - 网络错误、超时、非 2xx；
 * - 上游把错误页/登录页当 200 返回（内容不是 M3U）或解析出 0 个频道；
 * - 需要服务端 User-Agent / 内网可达（LIVE_ALLOW_PRIVATE）的订阅。
 *
 * 解析结果由 `buildLivePlaylist`（与 /api/live/playlist 共用）产出，
 * 直连与回退两条路径的 name/channels/groups 结构不可能出现差异。
 */

/** 与 client-api.ts 的 UNAUTHORIZED_EVENT 一致（不在两个模块间互相 import，避免循环依赖） */
const UNAUTHORIZED_EVENT = 'libretv:unauthorized';

/** `/api/live/playlist` 的请求地址（服务端代理/回退与页面外链共用同一套参数） */
export function livePlaylistApiUrl(url: string, force = false): string {
  const sp = new URLSearchParams({ url });
  if (force) sp.set('force', '1');
  return `/api/live/playlist?${sp.toString()}`;
}

/** 跨浏览器/Node 的 AbortError 判断（不同 realm 的 DOMException 不能只靠 instanceof） */
function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

/**
 * 200 响应不一定是 M3U：上游/网关常把 HTML 错误页、纯文本拒绝信息当 200 返回，
 * 而 parseM3u 会把任意非注释行按相对地址解析（`<html>` 会变成一条假频道）。
 * 这里做一层轻量识别，识别不出就交给服务端回退（服务端行为不变）：
 * - 标准 M3U：含 `#EXTM3U` 头或 `#EXTINF` 指令；
 * - 裸列表：所有非注释行都是绝对的 http(s) 地址。
 */
function looksLikeM3u(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed) return false;
  if (/^</.test(trimmed)) return false;
  if (/#EXTM3U|#EXTINF/i.test(text)) return true;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  return lines.length > 0 && lines.every((line) => /^https?:\/\//i.test(line));
}

/**
 * 服务端回退：走 `/api/live/playlist`（服务端无 CORS 限制，并带 10 分钟缓存）。
 * 与其他客户端 API 一样，401/503 时触发全局未授权事件（打开登录框 / 提示配置密码）。
 */
async function fetchLivePlaylistViaServer(
  url: string,
  signal?: AbortSignal
): Promise<LivePlaylistResponse> {
  let res: Response;
  try {
    res = await fetch(livePlaylistApiUrl(url), {
      cache: 'no-store',
      credentials: 'same-origin',
      signal,
    });
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new Error('直播列表拉取失败：网络请求失败');
  }

  if (res.status === 401 || res.status === 503) {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent(UNAUTHORIZED_EVENT, { detail: res.status === 503 ? 'setup' : undefined })
      );
    }
    throw new Error(res.status === 401 ? '需要登录' : '服务器未配置密码');
  }

  if (!res.ok) {
    let message = `直播列表拉取失败 (${res.status})`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data?.error) message = data.error;
    } catch {
      // 非 JSON 响应（网关错误页等）：保留状态码文案
    }
    throw new Error(message);
  }

  return (await res.json()) as LivePlaylistResponse;
}

/**
 * 直连上游拉取并解析 M3U 列表；失败时回退服务端代理。
 *
 * 直连请求 `credentials: 'omit'`：不把本站 cookie 带给任意第三方订阅地址；
 * `referrerPolicy: 'no-referrer'`：部分 IPTV 提供方会按 Referer 拒绝跨站请求。
 */
export async function fetchLivePlaylistDirect(
  url: string,
  signal?: AbortSignal
): Promise<LivePlaylistResponse> {
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal,
    });
    if (!res.ok) throw new Error(`订阅地址请求失败: ${res.status}`);

    const text = await res.text();
    if (!looksLikeM3u(text)) throw new Error('响应不是 M3U 播放列表');
    const playlist = buildLivePlaylist(text, url);
    // 解析出 0 个频道（空订阅/全部是浏览器无法播放的协议）：交给服务端再试一次
    if (playlist.channels.length === 0) throw new Error('未解析到频道');
    return playlist;
  } catch (err) {
    // 组件卸载/换查询导致的取消不是失败，不能回退（也避免误报 warn）
    if (isAbortError(err) || signal?.aborted) throw err;
    console.warn(
      '[LibreTV] 直播列表直连失败，已回退服务端代理：',
      url,
      err instanceof Error ? err.message : err
    );
    return fetchLivePlaylistViaServer(url, signal);
  }
}
