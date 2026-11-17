import { createHash } from 'node:crypto';
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

/** 单源搜索成功结果的边缘缓存 TTL（秒）：单源数据变化慢且与慢源解耦，可安全缓存 180 秒 */
const SOURCE_EDGE_CACHE_TTL_SEC = 180;

/**
 * Cloudflare Workers 免费版单次调用的外部 subrequests 硬上限为 50。
 * 预留 8 个子请求裕量（DNS 解析或底层重试），单次调用最多发起 42 个上游页面请求。
 */
const SAFE_SUBREQUEST_BUDGET = 42;

type WorkersCacheStorage = CacheStorage & { default?: Cache };

/** 取 Cloudflare Cache API 的默认命名空间；浏览器/Node 环境没有 `default` 时返回 null */
function getEdgeCache(): Cache | null {
  try {
    const storage = typeof caches !== 'undefined' ? (caches as WorkersCacheStorage) : undefined;
    return storage?.default ?? null;
  } catch {
    return null;
  }
}

/**
 * 单源边缘缓存键：站点自己的域名 + 内容摘要。
 * 缓存的是「某个源对某个关键词的原始条目列表」（未过滤/未排序），
 * 所以与流式/非流式、其他慢源是否超时都无关，命中即可先推给前端。
 */
function buildSourceEdgeCacheKey(baseUrl: string, wd: string): Request {
  const digest = createHash('sha256').update(`${baseUrl}\n${wd}`).digest('hex');
  return new Request(`https://tv.ycxdev.com/__tv-source-search__/v1/${digest}`, { method: 'GET' });
}

/** 先查进程内缓存，再查边缘缓存；命中后回填内存缓存，后续同 isolate 请求免边缘往返 */
async function readSourceEdgeCache(memKey: string, edgeKey: Request): Promise<SourceSearchOutcome | null> {
  const memHit = getCache<SourceSearchOutcome>(memKey);
  if (memHit) return { ...memHit, ms: 1 };

  const cache = getEdgeCache();
  if (!cache) return null;
  try {
    const hit = await cache.match(edgeKey);
    if (!hit || !hit.ok) return null;
    const data = (await hit.json()) as SourceSearchOutcome;
    if (!data || !data.ok || !Array.isArray(data.list)) return null;
    setCache(memKey, data, SEARCH_CACHE_TTL);
    return { ...data, ms: 1 };
  } catch {
    return null;
  }
}

/** 只缓存成功结果：失败多是一次抖动，缓存它会让用户 60s 内看不到本可恢复的条目 */
function writeSourceEdgeCache(memKey: string, edgeKey: Request, outcome: SourceSearchOutcome): void {
  if (!outcome.ok) return;
  setCache(memKey, outcome, SEARCH_CACHE_TTL);
  const cache = getEdgeCache();
  if (!cache) return;
  try {
    const res = new Response(JSON.stringify(outcome), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': `public, max-age=${SOURCE_EDGE_CACHE_TTL_SEC}`,
      },
    });
    void cache.put(edgeKey, res).catch(() => {});
  } catch {
    /* 忽略边缘缓存写入异常 */
  }
}

/** 缓存键：wd + 成人过滤 + 单源死线 + 排序后的源地址集合（死线不同结果集也不同，不能共用） */
function searchCacheKey(wd: string, sources: SourceConfig[], filterAdult: boolean, timeoutMs: number): string {
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
 * 根据本次请求的源数量动态收窄单源最大翻页数：
 * 保证 `sourceCount * maxPages <= SAFE_SUBREQUEST_BUDGET`（42），
 * 防止在 Cloudflare Workers 免费版下触发 `Too many subrequests` 硬截断。
 */
function resolveMaxPages(sourceCount: number): number {
  const safeCount = Math.max(1, sourceCount);
  const budgetPerSource = Math.max(1, Math.floor(SAFE_SUBREQUEST_BUDGET / safeCount));
  return Math.min(SEARCH_MAX_PAGES, budgetPerSource);
}

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
 * 每个源先取第一页并读取 pagecount，再并行抓取后续页（上限 maxPages），
 * 整源受 SEARCH_SOURCE_TIMEOUT_MS 总死线约束。
 * 单源结果按「源 + 关键词 + 页数预算」写入内存/边缘缓存，慢源超时不会拖累快源命中。
 */
async function searchSource(
  source: SourceConfig,
  wd: string,
  timeoutMs: number,
  maxPages: number
): Promise<SourceSearchOutcome> {
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

  const base = source.url.replace(/\/+$/, '');
  // 页数预算参与缓存键：预算变化会得到不同条目集，不能混用
  const memKey = `src-search:${base}\n${wd}\n${maxPages}`;
  const edgeKey = buildSourceEdgeCacheKey(`${base}\n${maxPages}`, wd);

  const cachedOutcome = await readSourceEdgeCache(memKey, edgeKey);
  if (cachedOutcome) {
    // 复用缓存时重绑当前请求的 sourceKey 与 source.name，防止同 URL 不同 key 配置串名
    return {
      ...cachedOutcome,
      sourceKey: source.key,
      list: cachedOutcome.list.map((item) => ({
        ...item,
        sourceKey: source.key,
        sourceName: source.name,
      })),
    };
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

  const fetchPage = async (page: number) => {
    const api = `${base}?ac=videolist&wd=${encodeURIComponent(wd)}&pg=${page}`;
    const res = await fetchUpstream(api, {
      // 单页不再另设更短的死线：整源由上面的 timeoutMs 统一兜住，否则 10s 设置会先在 8s 断
      timeoutMs,
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
    const pageCount = Math.min(Number.isFinite(rawPageCount) ? Math.max(1, rawPageCount) : 1, maxPages);
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
      .then((res) => {
        const done = finish(res);
        writeSourceEdgeCache(memKey, edgeKey, done);
        return done;
      })
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
  // 源越多，单源翻页预算越小，保证总上游请求数不超过 Workers 免费版子请求上限
  const maxPages = resolveMaxPages(sources.length);
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
    const outcomes = await Promise.all(sources.map((source) => searchSource(source, wd, timeoutMs, maxPages)));
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
          const outcome = await searchSource(source, wd, timeoutMs, maxPages);
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
