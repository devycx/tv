/**
 * OpenNext 构建产物类型声明（供 `tsc --noEmit` / `next build` 使用）。
 *
 * `wrangler.jsonc` 的 main 是 `src/cf-entry.ts`，它必须静态 import `.open-next/worker.js`；
 * 但 `.open-next/` 是构建产物（已被 .gitignore 忽略），在干净检出上跑类型检查时并不存在。
 * 直接用 `// @ts-expect-error` 又会在构建产物生成后变成「未使用的指令」而报错，因此这里用
 * ambient module 声明兜底：有产物时 TypeScript 按真实 JS 推断类型，没有产物时按下面声明。
 *
 * 注意：ambient module 的名字不能是相对路径（TS2436），所以用「星号 + 斜杠」的通配符
 * 去匹配 `../.open-next/worker.js` 这个唯一的导入。
 */

/**
 * 仓库没有运行 `wrangler types` 生成 worker-configuration.d.ts。
 * `@opennextjs/cloudflare` 只会在（其类型被引入的）程序里声明全局 CloudflareEnv；
 * 干净检出（无 .open-next/）时该全局不存在，这里声明一个兜底接口。
 * interface 会合并：包内声明存在时补上它的绑定字段，不存在时也能让 `WorkerEnv extends CloudflareEnv` 成立。
 */
interface CloudflareEnv {
  readonly [key: string]: unknown;
}

/** Cloudflare Worker 的 ExecutionContext 最小声明（仓库未安装 @cloudflare/workers-types） */
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

declare module '*/.open-next/worker.js' {
  const worker: {
    fetch(request: Request, env: CloudflareEnv, ctx: ExecutionContext): Promise<Response>;
  };
  export default worker;
  export const DOQueueHandler: unknown;
  export const DOShardedTagCache: unknown;
  export const BucketCachePurge: unknown;
}
