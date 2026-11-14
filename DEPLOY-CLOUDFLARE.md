# 部署到 Cloudflare Workers（tv.ycxdev.com）

本项目（LibreTV Next.js 版）已改造成用 **OpenNext Cloudflare** 部署到 Cloudflare Workers。
线上地址：<https://tv.ycxdev.com>（同一份服务也在 `https://tv.ycxdev.workers.dev`）。

- Cloudflare 账号：`24c59299b11a61eed6fc8902524e0515`
- Worker 名：`tv`
- 自定义域：`tv.ycxdev.com`（`wrangler.jsonc` 的 `routes[].custom_domain`，部署时自动建 DNS 记录与证书）
- 访问密码：存为 Worker Secret `PASSWORD`（**不在仓库、不在 `wrangler.jsonc`**）

## 访问控制（服务端门禁）

密码不再只是首页的客户端弹窗，而是由 [src/middleware.ts](src/middleware.ts) 在请求进入 Next 之前拦截：

- 未认证访问任何页面（`/`、`/live`、`/watch`、`/about`，含 RSC 导航与深链 query）→ **302 到 `/login?next=<原路径>`**，HTML 不下发；
- 未认证访问 `/api/*` → **401 JSON**（`/api/auth`、`/api/status` 除外）；
- `/login` 是独立登录页（`src/app/login/page.tsx`），登录成功后 `location.replace(next)`；
- 已登录访问 `/login` → 302 回 `next`（只接受站内相对路径，防开放重定向）；
- 会话校验用 WebCrypto 复刻 `src/lib/auth.ts` 的 HMAC-SHA256，旧 cookie 继续有效；
- 静态资源（`/_next/`、`/icons/`、favicon、manifest）匿名可访问，否则登录页会白屏；
- 未配置 `PASSWORD` 时门禁 fail-open（页面放行，由前端提示管理员配置），避免误删 secret 把站点锁死。

## 客户端直连（合规）

Cloudflare 明确限制「站外托管的视频/大文件经其 CDN 分发给访客」
（[Delivering Videos with Cloudflare](https://developers.cloudflare.com/fundamentals/reference/policies-compliances/delivering-videos-with-cloudflare/)）。
因此本站 Worker **只提供页面、静态资源、JSON API**，所有视频与封面都由浏览器直连源站：

- 点播/直播播放器只走直连；直连失败直接提示换源，不再回退 `/api/proxy` / `/api/live/stream`；
- 「下载本集」也只走浏览器直连，CORS 失败提示换源；
- `/api/proxy` 与 `/api/live/stream` 路由已删除（访问返回 404）；
- 封面：豆瓣图优先走 `img.doubanio.cmliussss.net/.com` 公共镜像，再回退原站；
  `referrerPolicy="no-referrer"` 规避部分图床的 Referer 校验；
- 因此**不能改第三方 CORS**：源站不允许跨域（无 `Access-Control-Allow-Origin`）、
  防盗链、或 `http://` 混合内容时，只能换源/换频道。这是合规改造的代价。

## 预置数据源

`wrangler.jsonc` 的 `vars` 里预置了两类源，登录后自动勾选 / 启用，开箱即用：

| 变量 | 内容 |
| --- | --- |
| `DEFAULT_SOURCES` | 35 个点播源（苹果CMS 采集站），全部经线上 search + detail 复验通过；其中 2 个可测出画质 |
| `DEFAULT_LIVE_SOURCES` | 12 个直播源，约 2060 个频道（现有 4 + 新增 8） |

- 画质实测通过（`height` 有数值）：电影天堂 1080、飘零资源 720。
- 其余源只验证到「搜索 + 详情有播放地址」；能否播放取决于源站 CORS / 防盗链 / 协议（见上一节），失败请换源。
- 直播源：`/api/live/playlist` 实测 12 个列表共 **2059 个频道**（`/live` 页按 URL 去重后约 1489）；
  但直连模式下只有 **https + 带 `ACAO`** 的频道能播，估算约 30%（≈619 条），
  http 流会被浏览器混合内容拦截、无 CORS 的会被拦——**这是「很多频道看不了」的主因**，换频道即可。
- 修改源：编辑 `scripts/gen-wrangler.mjs` 里的数组 → `npm run cf:build`（会同时重写 `wrangler.jsonc` 与
  `src/lib/bootstrap.generated.json`）→ `npx wrangler deploy`。**不再支持「只改变量不重建」**：
  首屏预置源是构建期静态注入的，改完必须重新构建。
- 这些是**第三方公开接口**，可用性、内容与合规责任都不在本仓库。

### 18🈲 成人内容标识与开关

- 9 个成人向源（废柴 / 155 / 大地 / 森林 / 滴滴 / jkun / 辣椒 / 魔法 / 玉兔）在 `DEFAULT_SOURCES` 里标了
  `isAdult: true`；搜索结果的 `isAdult` 还会按分类名/标题关键词（伦理、情色、三级、女优、换脸、无码、有码、
  AV、自拍、偷拍…）兜底识别，源没标也能命中。
- 过滤开关统一放在「**设置 → 偏好设置 → 首页与内容过滤 → 成人内容过滤**」（2026-11-14 起首页搜索框下方不再有行内 `18🈲` 开关，避免同一状态两处入口）：
  - 开：服务端直接丢弃 18+ 结果，并自动取消勾选成人源；
  - 关：自动重新勾选成人源，结果显示并在卡片/详情打 `18🈲` 徽章。
- 切换开关会让搜索立即重跑（React Query key 包含该状态）。

### 源调研与合并结论（2026-11-14）

| 轮次 | 输入 | 结果 |
| --- | --- | --- |
| qist/tvbox | 257 个配置 / 1779 条 sites → 39 个去重 CMS | 2 个可测画质（电影天堂、飘零）；其余多卡在 m3u8 CDN 的 525/530 |
| gao / box / 2hacc / xianyuyimu 等 5 仓库 | 276 个配置 → 35 个新候选 | 0 个可测画质 |
| 全量合并（放宽标准） | 101 条素材 → 83 组去重 → 68 组复验 | **35 个源 search+detail 通过**；35 源聚合搜索 513 条结果 / 1 个源超时 |
| 直播源扩容 | 37 个候选 m3u（全量频道逐个测 200/206 + ACAO） | **8 个入选**，新增 1398 频道；12 源合计 2059，估算约 619 条可直连 |

失败原因以 525/530（源站 TLS）为主，另有 403/404/超时/非 JSON。直连模式下 Worker 不再参与媒体请求，
所以原来的边缘 525 问题改由浏览器网络决定；但浏览器多出两道门槛：**CORS** 与 **HTTPS 页面的混合内容**。
直播尤其明显：现有 4 源只有约 26.8% 的频道可直连，扩容后约 30%（≈619 条）；分片级复核约 430 条能真正起播。


## 自动部署（标准流程，2026-11-14 起）

**日常发布只走 GitHub**：push 到 `main` → [ci](.github/workflows/ci.yml)（typecheck/lint/test）通过 →
[deploy-cloudflare](.github/workflows/deploy-cloudflare.yml) 自动执行 `npm run cf:build` + `npx wrangler deploy`，
线上 tv.ycxdev.com 随每次 main 提交自动更新。**不要再从本地手动部署**（本地命令只保留给预览、热修复、回滚）。

一次性配置（`CLOUDFLARE_ACCOUNT_ID` 已写入仓库 Secrets，还差 API Token）：

1. Cloudflare Dashboard → My Profile → API Tokens → Create Token，用 **Edit Cloudflare Workers** 模板
   （或自定义权限：`Account·Workers Scripts:Edit`、`Account·Account Settings:Read`、
   `Zone·Workers Routes:Edit`、`Zone·Zone:Read`；Account 资源选本账号，Zone 资源选 `ycxdev.com`）；
2. 把 Token 存到仓库 Secret（不要写进仓库/聊天记录）：

```powershell
gh secret set CLOUDFLARE_API_TOKEN -R devycx/tv   # 按提示粘贴 token
```

3. 验证：`gh workflow run deploy-cloudflare.yml -R devycx/tv`，或随便 push 一次 `main`。

说明：

- 未配置 `CLOUDFLARE_API_TOKEN` 时，deploy 工作流只输出 warning 并跳过部署，不会让 CI 变红；配置后立即生效；
- Worker Secret `PASSWORD` 与这个 API Token 无关，自动部署不会覆盖它；
- 部署失败排查：`gh run list -R devycx/tv --workflow deploy-cloudflare.yml`、`gh run view --log-failed`；
  线上回滚仍用 `npx wrangler rollback`（GitHub 侧不会自动回滚）。

## 日常命令（本地预览 / 热修复）

> 常规发布请用上面的自动部署，本地 `wrangler deploy` 只用于热修复/回滚。
> Node 版本要求 **≥ 22.12**（wrangler 4.162）。本机已把便携版 Node 24
> （`C:\Users\ycx\tools\node-v24.22.3`）设为**新 PowerShell / Git Bash 的默认 node**：
> 用户环境变量 `NODE24_HOME` + PowerShell profile + `~/.bash_profile`。
> 系统安装的 Node 20（`C:\Program Files\nodejs`）保持不动，需要时仍可直接调用。
> 如果某个会话里还是 20，临时前置：`$env:Path = 'C:\Users\ycx\tools\node-v24.22.3;' + $env:Path`。

```powershell
# 1) 构建（会跑 next build + OpenNext 打包，产物在 .open-next/）
npm run cf:build

# 2) 部署（只上传已构建产物；不会重新跑 next build）
npx wrangler deploy

# 或者一步：npm run cf:build; npm run cf:deploy
```

本地预览（workerd，读 `.dev.vars` 里的 PASSWORD）：

```powershell
npm run cf:preview        # 默认 http://127.0.0.1:8787
```

## 改密码

```powershell
'新密码' | npx wrangler secret put PASSWORD
```

改完立即生效（Cloudflare 会生成新版本）。同时把 `.dev.vars` 里的 `PASSWORD` 改掉，
否则本地预览还用旧密码。`PASSWORD` 是登录密码，也是会话 cookie 的 HMAC 派生密钥
（除非另设 `PROXY_SECRET`）；**换密码会让已登录会话全部失效**，这是预期行为。

## 部署结构

Next.js 15（App Router）+ OpenNext → 单个 Worker：

- 页面（`/`、`/live`、`/watch`、`/about`）是**静态预渲染**，HTML 由 Worker 直接返回
  （HTML 不在 Assets 里，因为要过 middleware 门禁；`/_next/static`、图标才由 Assets 免费直出）；
- 所有 `/api/*` 是 Worker 里的 Route Handler（Node 兼容运行时，`nodejs_compat`），只出 JSON / 少量图片元数据；
- 首页推荐 / 搜索 / 详情 / 直播列表等**文本请求**走 Cloudflare 边缘网络；
- **媒体流量（m3u8 / ts / mp4 / flv）与封面图都不经过 Worker**，由浏览器直连源站。

### 省 Worker 请求的优化（2026-11-14）

- **直播列表客户端直连**：12 个 M3U 上游实测都返回 `Access-Control-Allow-Origin: *`，`/live` 页改为浏览器
  直接拉取 + 本地解析（`src/lib/live-playlist.ts`，与服务端共用 `buildLivePlaylist`）。只有失败（CORS/超时/
  非 M3U/0 频道）才回退一次 `/api/live/playlist`。**/live 页的 13 次 Worker API 请求降到 0 次**。
- **首屏配置内联**：预置源/直播源/版本等由 `gen-wrangler.mjs` 在构建期写入
  `src/lib/bootstrap.generated.json`，静态 HTML 内联，页面加载**不再请求 `/api/status`**（每页少 1 次）。
  `/api/status` 路由保留给外部脚本，页面代码已无调用。
- 典型会话（登录 + 首页 + 3 次搜索 + 5 个详情）约 **15 次 Worker 请求**，10 万/天约 6000+ 次会话。
- 注意：改源必须重新构建（bootstrap 是构建期产物），不能只改 vars。

### CPU 优化：入口缓存层（2026-11-14）

Workers 免费套餐是 **10ms CPU / 请求**，而 Next.js/OpenNext 每次请求的固定开销就有 7–60ms。
Cloudflare 对「偶发超限」有内置容忍，但连续超限会返回 Error 1102，所以必须把常态 CPU 压下来。

改动：`wrangler.jsonc` 的 `main` 从 `.open-next/worker.js` 换成 **`src/cf-entry.ts`**（Worker 入口包壳），
在进入 Next 运行时之前先用 Cloudflare Cache API 挡一层：

| 缓存对象 | key | TTL | 命中后 |
| --- | --- | --- | --- |
| 页面整页 HTML（`/`、`/live`、`/about`、`/watch`） | pathname + 版本 | 6h | 直接返回，不进 Next |
| 可缓存 GET API（`/api/status`、`/api/douban`、`/api/bangumi/calendar`、`/api/hot-list`、`/api/detail`、`/api/source-list`、`/api/live/epg`、`/api/live/playlist`） | pathname + query + 版本 | 1–60min | 直接返回，不进 Next |
| 聚合搜索 `POST /api/search`（仅非 stream 的完整 JSON，且 `failures` 为空数组） | `wd` + 成人过滤 + 排序后的源地址集合（与 route.ts 同口径）的 SHA-256 + URL query + 版本 | 60s | 直接返回，不进 Next |

- **安全**：缓存读取前先做一次会话 HMAC 校验；未登录/未配置密码一律直通 OpenNext，由 `src/middleware.ts` 照旧 302/401。
  缓存内容是「所有登录用户共享的公共内容」（页面为构建期预渲染，API 为公共数据），不包含任何用户态。
- **失效**：缓存 key 前缀是 `CF_VERSION_METADATA.id`（每次 `wrangler deploy` 都会变），新版本上线后旧缓存自然不命中；
  另加 `max-age` 兜底。RSC 导航载荷（`_rsc` / `RSC: 1`）依赖 router state，**不缓存**。
- **不缓存**：登录/登出、`/api/quality`、`/api/live/probe` 等流式探测、`force=1` 强制刷新、`?stream=1` 的 NDJSON 搜索流
  （只能消费一次且断连会打断上游），以及含失败源（`failures.length > 0`）的搜索结果——失败源 60s 内可能恢复，缓存会让用户看不到。

实测（`wrangler tail` 逐请求 cpuTime，2026-11-14 部署前后对比）：

| 请求 | 优化前 CPU | 优化后 CPU（缓存命中） |
| --- | --- | --- |
| `/`、`/live`、`/about` 整页 | 28–59ms | **1ms** |
| `/api/status`、`/api/douban` 等 GET | 7–23ms | **0–1ms** |
| `POST /api/search`（35 源） | 48–281ms | **~1–2ms**（60s 内重复同词） |

缓存 MISS（每个版本/路径/机房首次访问）仍是 28–152ms，冷启动首批 230–300ms，属正常；这些请求在免费套餐容忍范围内。
`X-TV-Cache: HIT` 响应头可用于确认是否命中。

## 为 Workers 改了什么

| 文件 | 改动 |
| --- | --- |
| `next.config.ts` | `BUILD_TARGET=workers` 时用 `NormalModuleReplacementPlugin` 把 `./ssrf` / `@/lib/ssrf` 换成 `ssrf-workers.ts` |
| `src/lib/ssrf-workers.ts` | 新增。Workers 版 SSRF 校验：协议白名单 + 字面量私网 IP 拦截；**不做 DNS 解析**（Workers 没有 `node:dns`，也没有通往内网/云元数据的网络路径） |
| `src/middleware.ts` | 新增。服务端访问门禁：未认证页面 302 `/login`、API 401 |
| `src/app/login/page.tsx` | 新增。独立登录页（不依赖首页弹窗） |
| `src/lib/session-webcrypto.ts` / `src/lib/safe-next.ts` | 新增。WebCrypto 会话校验（与 `auth.ts` 同算法）与回跳路径校验 |
| `open-next.config.ts` | 新增。OpenNext Cloudflare 默认配置 |
| `wrangler.jsonc` | 新增。Worker 入口、Assets 绑定、`nodejs_compat`、自定义域、预置源 vars；2026-11-14 起 `main` 指向 `src/cf-entry.ts`，并加 `version_metadata` 绑定 |
| `src/cf-entry.ts` | 新增。Worker 入口包壳：已登录用户的页面 / GET API / 搜索 POST 走 Cloudflare Cache API，命中不进 Next 运行时（CPU 优化核心） |
| `scripts/gen-wrangler.mjs` | 新增。生成 `wrangler.jsonc` + `src/lib/bootstrap.generated.json`（源列表的唯一维护点） |
| `package.json` | 升级 `next` 到 15.5.29（OpenNext 1.20 的 peer 要求）；加 `cf:build` / `cf:preview` / `cf:deploy`；devDependencies 加 OpenNext、wrangler、cross-env |
| `.gitignore` | 忽略 `.open-next/`、`.wrangler/`、`.dev.vars`、`.tmp/` |

Node 版（Docker / `npm start`）继续用原来的 `src/lib/ssrf.ts`：undici Agent + `node:dns`
连接级防护，单测 `src/lib/ssrf.test.ts` 仍然全绿。

## 已知限制 / 注意

- **Workers 没有连接级 SSRF 防护**：字面量私网 IP、非 http(s) 协议、每一跳重定向都会被拦，
  但不会把域名解析一遍再校验。Cloudflare 边缘本身到不了内网，所以内网横向不可达。
- **限流是单 isolate 内存实现**（登录 10 次 / 10 分钟）：多 isolate 时只是近似限流。
  Workers 部署由 `wrangler.jsonc` 的 `TRUST_CF_IP: "1"`（`gen-wrangler.mjs` 生成）让限流按 Cloudflare 边缘覆写的
  `cf-connecting-ip` 计数；漏配会让所有请求共用一个 `'unknown'` 计数桶，10 次失败即锁死全站登录 10 分钟。
  Node / Docker + 可信反代部署**不要**设 `TRUST_CF_IP`，否则客户端可伪造该头绕过限流（那里应改用反代覆写的 `x-real-ip` / `x-forwarded-for`）。
- **内存缓存**（搜索短缓存、豆瓣推荐、直播列表）只活在单个 isolate 内，命中率看流量分布，属正常。
- **客户端存储（播放器片段缓存）**：Cache Storage `libretv-video-v1` + IndexedDB `segmentMeta`，
  默认桌面 2GB 总量 / 800MB 每集 / 300s 预取；手机、省流模式、2G/3G 自动收紧到
  400MB / 160MB / 120s，且暂停时不再「无限铺满整集」、不预热下一集（2026-11-14 调整）。
  手机浏览器会把 Cache Storage 一起显示成「Cookie 及站点数据」，设置页「播放与过滤」底部
  现在直接展示浏览器视角的「本站数据 / 配额」并可一键清理。下载断点缓存 `libretv-dl-v1`
  在任务完成/删除时清理；刷新页面后遗留的「下载中」任务会自动标成「已暂停」而不是卡死。
- **实测 CPU**（2026-11-14）：Cloudflare GraphQL 近 7 天 1869 次调用、总 CPU 68.4s，
  P50 **7.5ms**、P75 **20.4ms**、P99 **407ms**、均值 36.6ms（含冷启动尖峰 200–600ms）；仪表盘 24h 中位数显示 8ms。
  加了入口缓存层后，命中请求降到 **0–2ms**；MISS 仍 28–152ms、冷启动 230–300ms。
  免费套餐 10ms/请求是硬上限，但平台对偶发超限有容忍 —— 「没有 Error 1102」不等于没超，要看 cpuTime 分布。
  35 源聚合搜索 warm ~48ms CPU（首次冷启动 281ms），60s 内重复搜索走缓存约 1–2ms。
- **直连播放依赖源站 CORS**：没有 `Access-Control-Allow-Origin`、防盗链、或 `http://` 混合内容
  的源只能换源；直播对这个最敏感（现有 12 个直播源约 30% 频道可直连，http 运营商流基本不可用）。
- **封面依赖 cmliussss 公共镜像**：镜像不可用时豆瓣原站会返回 418/403，此时显示占位图。
- `workers_dev: true` 保留了 `tv.ycxdev.workers.dev` 入口；不想要就把它设为 `false` 重新部署。
- 站点源已预置；用户仍可在「设置 → 源管理」里自行增删、订阅或测活。

## 品牌与图标（2026-11-14）

站点从上游 LibreTV 品牌换成了自有的 **夜幕TV**（slogan：夜色启幕，好戏随时开场）。

- Logo：YouTube 风格蓝色圆角播放徽标，主题色沿用站点霓虹蓝 **#00b8e6**，深色底 **#0b101a**。
  矢量源放在 `public/icons/`：`icon-source.svg`（深色底 app icon）与 `brand-mark.svg`（透明徽标，
  顶栏/登录页/favicon 使用）；`npm run icons` 由这两个 SVG 导出 48/96/144/192/512/1024 与
  180px apple-touch-icon，`public/favicon.ico` 内嵌 16/32/48 三张透明底 PNG。
- 顶栏与登录页的「夜幕TV」字标改为纯色（跟随 `text-content`），与 YouTube 的单色字标一致；
  首页 hero 大标题仍保留原有蓝→粉渐变。
- 文案落点：`src/app/layout.tsx`（title/description）、`src/app/manifest.ts`（PWA 名称）、
  `src/components/header.tsx`（顶栏 logo + 站名）、`src/components/site-footer.tsx`（页脚，已去掉上游
  GitHub 链接与版本检测请求）、`src/app/login/page.tsx`、`src/app/page.tsx`（首页 hero）、
  `src/app/about/page.tsx`。
- 内部标识（localStorage key、IndexedDB 库名、订阅配置格式 `LibreTV-SourceList`/`LibreTV-Settings`、
  session 派生盐）**保持不变**，避免已有用户的主题/配置/登录态失效。

## 排错

```powershell
npx wrangler tail tv --format json     # 看线上日志（含 cpuTime / 异常）
npx wrangler deployments list          # 版本历史
npx wrangler rollback                  # 回滚到上一个版本
```

`/api/status` 会返回 `version`（来自 `package.json`）、`passwordRequired` 与预置源列表，
可用来核对部署是否生效。
