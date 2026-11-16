import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { cmsRequestHeaders, filterAdultResults, filterRelevantResults, parseSearchList } from '@/lib/cms-parser';
import { compareSearchResults } from '@/lib/relevance';
import { fetchUpstream, getCache, setCache } from '@/lib/fetch-utils';
import { checkUpstreamAllowed } from '@/lib/ssrf';
import { normalizeSourceTimeoutMs, resolveSourceTimeoutMs } from '@/lib/search-timeout';
import type { SearchResponse, SearchStreamEvent, SourceConfig, SourceSearchOutcome } from '@/lib/types';

export const runtime = 'nodejs';

interface SearchBody {
  wd: string;
  sources: SourceConfig[];
  filterAdult?: boolean;
  /** 用户设置的单源等待上限（毫秒），缺省用部署默认值 */
  timeoutMs?: number;
}

/** 搜索结果短缓存：同一关键词 + 同一组源在 TTL 内直接返回（播放页返回搜索页等场景） */
const SEARCH_CACHE_TTL = 60 * 1000;

/** 缓存键：wd + 成人过滤 + 单源死线 + 排序后的源地址集合（死线不同结果集也不同，不能共用） */
function searchCacheKey(
  wd: string,
  sources: SourceConfig[],
  filterAdult: boolean,
  timeoutMs: number
): string {
  const urls = sources.map((s) => s.url.replace(/\/+$/, '')).sort().join('|');
  return `search:${wd}\n${filterAdult ? 1 : 0}\n${timeoutMs}\n${urls}`;
}

/**
 * 每个源最多抓取的页数。
 * 第一页响应会带回 pagecount（源站真实总页数），实际抓取页数 = min(pagecount, 该值)。
 * 默认 5；页与页之间并行请求，单页失败只丢弃该页。
 */
const SEARCH_MAX_PAGES = (() => {
  const n = parseInt(process.env.SEARCH_MAX_PAGES || '5', 10);
  if (!Number.isFinite(n)) return 5;
  return Math.min(50, Math.max(1, n));
})();

/**
 * 单源总死线由 lib/search-timeout.ts 提供（路由文件不允许导出额外符号，见该文件注释）。
 * 默认取部署配置，请求体里的 timeoutMs（用户设置）优先。
 */
const SEARCH_SOURCE_TIMEOUT_MS = resolveSourceTimeoutMs(process.env.SEARCH_SOURCE_TIMEOUT_MS);

/** AbortSignal.timeout / 源级死线中断均以 TimeoutError 语义呈现（直接抛出或挂在 cause 上） */
function isTimeoutError(err: unknown): boolean {
  const candidates: unknown[] = [err, err instanceof Error ? err.cause : undefined];
  return candidates.some((e) => e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError'));
}

/**
 * 服务端聚合搜索：并行请求所有选中源，任一源失败不影响整体。
 * 每个源先取第一页并读取 pagecount，再并行抓取后续页（上限 SEARCH_MAX_PAGES），
 * 整源受 SEARCH_SOURCE_TIMEOUT_MS 总死线约束。
 * 旧版在浏览器里打满 N 个请求（暴露用户 IP、无法缓存、超时失控），现全部上移。
 */
async function searchSource(source: SourceConfig, wd: string, timeoutMs: number): Promise<SourceSearchOutcome> {
  const start = Date.now();
  const finish = (outcome: Omit<SourceSearchOutcome, 'ms'>): SourceSearchOutcome => ({
    ...outcome,
    ms: Date.now() - start,
  });

  if (!/^https?:\/\//.test(source.url || '')) {
    return finish({ sourceKey: source.key, ok: false, list: [], error: '无效的源地址' });
  }
  // 用户可控地址发起服务端请求，必须先过 SSRF 校验（协议白名单 + 内网/保留地址）
  const verdict = await checkUpstreamAllowed(source.url);
  if (!verdict.ok) {
    return finish({ sourceKey: source.key, ok: false, list: [], error: verdict.reason });
  }

  // 死线到点中断该源所有在途分页请求，避免后台继续空耗
  const controller = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<SourceSearchOutcome>((resolve) => {
    deadlineTimer = setTimeout(() => {
      controller.abort(new DOMException('源搜索超时', 'TimeoutError'));
      resolve(
        finish({
          sourceKey: source.key,
          ok: false,
          list: [],
          error: `请求超时（>${Math.round(timeoutMs / 1000)}s）`,
          timedOut: true,
        })
      );
    }, timeoutMs);
  });

  const base = source.url.replace(/\/+$/, '');
  const fetchPage = async (page: number) => {
    const api = `${base}?ac=videolist&wd=${encodeURIComponent(wd)}&pg=${page}`;
    const res = await fetchUpstream(api, {
      timeoutMs: 8000,
      headers: cmsRequestHeaders(),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };

  const run = async (): Promise<SourceSearchOutcome> => {
    const first = await fetchPage(1);
    const list = parseSearchList(first, source);
    // 源站真实总页数与配置上限取较小者；pagecount 缺失或非法时视为 1 页
    const rawPageCount = parseInt(String((first as { pagecount?: unknown }).pagecount ?? '1'), 10);
    const pageCount = Math.min(Number.isFinite(rawPageCount) ? Math.max(1, rawPageCount) : 1, SEARCH_MAX_PAGES);
    if (pageCount > 1) {
      const extraPages = await Promise.all(
        Array.from({ length: pageCount - 1 }, (_, i) => i + 2).map(async (page) => {
          try {
            return parseSearchList(await fetchPage(page), source);
          } catch {
            return [];
          }
        })
      );
      list.push(...extraPages.flat());
    }
    return { sourceKey: source.key, ok: true, list };
  };

  try {
    // 死线先到时 run 仍会在后台被 abort 并 reject，必须先挂 catch 防未处理 rejection
    const runPromise = run()
      .then(finish)
      .catch((err: unknown): SourceSearchOutcome =>
        finish({
          sourceKey: source.key,
          ok: false,
          list: [],
          error: err instanceof Error ? err.message : '请求失败',
          timedOut: isTimeoutError(err),
        })
      );
    return await Promise.race([runPromise, deadline]);
  } catch (err) {
    return finish({
      sourceKey: source.key,
      ok: false,
      list: [],
      error: err instanceof Error ? err.message : '请求失败',
      timedOut: isTimeoutError(err),
    });
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}

/** 合并 + 去重 + 过滤 + 排序，stream 与非 stream 两种模式共用 */
function aggregateOutcomes(outcomes: SourceSearchOutcome[], wd: string, filterAdult: boolean): SearchResponse {
  const seen = new Set<string>();
  let list = outcomes.flatMap((o) => o.list).filter((item) => {
    const key = `${item.sourceKey}_${item.vodId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  list = filterAdultResults(list, filterAdult);
  // 部分源站做分词/OR 模糊搜索（搜「摔跤吧！爸爸」返回一堆「爸爸XXX」），按关键词过滤
  list = filterRelevantResults(list, wd);

  // 相关性分档（精确 > 前缀 > 全词 > 包含 > 近似）→ 原始写法 → 年份由近及远 → 名称 → 源名。
  // 旧的「精确优先 + 拼音序」会把「戒色」排到「色戒」前面，见 lib/relevance.ts
  list.sort((a, b) => compareSearchResults(a, b, wd));

  const failures = outcomes
    .filter((o) => !o.ok)
    .map((o) => ({ sourceKey: o.sourceKey, error: o.error || '请求失败', timedOut: o.timedOut }));

  return { list, failures };
}

/**
 * 服务端聚合搜索：
 * - 默认返回完整 JSON（换源流程使用）；
 * - `?stream=1` 以 NDJSON 逐源推送（完成一个推一条，健康源的结果不再等坏源超时），
 *   最终推送聚合后的 done 事件并写入短缓存。
 */
export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  let body: SearchBody;
  try {
    body = (await req.json()) as SearchBody;
  } catch {
    return NextResponse.json({ error: '请求格式错误' }, { status: 400 });
  }

  const wd = (body.wd || '').trim();
  if (!wd || wd.length > 100) {
    return NextResponse.json({ error: '搜索关键词无效' }, { status: 400 });
  }
  if (!Array.isArray(body.sources) || body.sources.length === 0) {
    return NextResponse.json({ error: '请至少选择一个点播源' }, { status: 400 });
  }
  const sources = body.sources.slice(0, 50);
  const filterAdult = body.filterAdult !== false;
  // 用户设置优先，其次是部署配置；两者都收敛在 1s–60s
  const timeoutMs = normalizeSourceTimeoutMs(body.timeoutMs) ?? SEARCH_SOURCE_TIMEOUT_MS;

  const cacheKey = searchCacheKey(wd, sources, filterAdult, timeoutMs);
  const cached = getCache<SearchResponse>(cacheKey);
  if (cached) {
    // 流式模式下缓存命中也要走 done 事件，客户端解析逻辑保持单一
    if (new URL(req.url).searchParams.get('stream') === '1') {
      const event: SearchStreamEvent = { type: 'done', list: cached.list, failures: cached.failures };
      return new Response(JSON.stringify(event) + '\n', {
        headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    return NextResponse.json(cached);
  }

  const isStream = new URL(req.url).searchParams.get('stream') === '1';
  if (!isStream) {
    const outcomes = await Promise.all(sources.map((source) => searchSource(source, wd, timeoutMs)));
    const payload = aggregateOutcomes(outcomes, wd, filterAdult);
    setCache(cacheKey, payload, SEARCH_CACHE_TTL);
    return NextResponse.json(payload);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: SearchStreamEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
        } catch {
          closed = true; // 客户端已断开
        }
      };

      // 逐源结算即推送；outcomes 按下标回填保证聚合顺序稳定
      const outcomes: SourceSearchOutcome[] = new Array(sources.length);
      await Promise.all(
        sources.map(async (source, i) => {
          const outcome = await searchSource(source, wd, timeoutMs);
          outcomes[i] = outcome;
          // 中间结果与最终结果共用去重和过滤规则，避免无关/成人条目短暂出现在页面上。
          const { list } = aggregateOutcomes([outcome], wd, filterAdult);
          send({ type: 'source', ...outcome, list });
        })
      );

      const payload = aggregateOutcomes(outcomes, wd, filterAdult);
      setCache(cacheKey, payload, SEARCH_CACHE_TTL);
      send({ type: 'done', list: payload.list, failures: payload.failures });
      closed = true;
      try {
        controller.close();
      } catch { /* 已断开 */ }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}
