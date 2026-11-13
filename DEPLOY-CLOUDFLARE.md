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
- 修改源：编辑 `scripts/gen-wrangler.mjs` 里的数组 → `node scripts/gen-wrangler.mjs` →
  `npx wrangler deploy`（只改变量，不用重新 build）。
- 这些是**第三方公开接口**，可用性、内容与合规责任都不在本仓库。

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


## 日常命令

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

- 页面（`/`、`/live`、`/watch`、`/about`）是静态预渲染，由 Workers Assets 直接出；
- 所有 `/api/*` 是 Worker 里的 Route Handler（Node 兼容运行时，`nodejs_compat`），只出 JSON / 少量图片元数据；
- 首页推荐 / 搜索 / 详情 / 直播列表等**文本请求**走 Cloudflare 边缘网络；
- **媒体流量（m3u8 / ts / mp4 / flv）与封面图都不经过 Worker**，由浏览器直连源站。

## 为 Workers 改了什么

| 文件 | 改动 |
| --- | --- |
| `next.config.ts` | `BUILD_TARGET=workers` 时用 `NormalModuleReplacementPlugin` 把 `./ssrf` / `@/lib/ssrf` 换成 `ssrf-workers.ts` |
| `src/lib/ssrf-workers.ts` | 新增。Workers 版 SSRF 校验：协议白名单 + 字面量私网 IP 拦截；**不做 DNS 解析**（Workers 没有 `node:dns`，也没有通往内网/云元数据的网络路径） |
| `src/middleware.ts` | 新增。服务端访问门禁：未认证页面 302 `/login`、API 401 |
| `src/app/login/page.tsx` | 新增。独立登录页（不依赖首页弹窗） |
| `src/lib/session-webcrypto.ts` / `src/lib/safe-next.ts` | 新增。WebCrypto 会话校验（与 `auth.ts` 同算法）与回跳路径校验 |
| `open-next.config.ts` | 新增。OpenNext Cloudflare 默认配置 |
| `wrangler.jsonc` | 新增。Worker 入口、Assets 绑定、`nodejs_compat`、自定义域、预置源 vars |
| `scripts/gen-wrangler.mjs` | 新增。生成 `wrangler.jsonc`（源列表的唯一维护点） |
| `package.json` | 升级 `next` 到 15.5.29（OpenNext 1.20 的 peer 要求）；加 `cf:build` / `cf:preview` / `cf:deploy`；devDependencies 加 OpenNext、wrangler、cross-env |
| `.gitignore` | 忽略 `.open-next/`、`.wrangler/`、`.dev.vars`、`.tmp/` |

Node 版（Docker / `npm start`）继续用原来的 `src/lib/ssrf.ts`：undici Agent + `node:dns`
连接级防护，单测 `src/lib/ssrf.test.ts` 仍然全绿。

## 已知限制 / 注意

- **Workers 没有连接级 SSRF 防护**：字面量私网 IP、非 http(s) 协议、每一跳重定向都会被拦，
  但不会把域名解析一遍再校验。Cloudflare 边缘本身到不了内网，所以内网横向不可达。
- **限流是单 isolate 内存实现**（登录 10 次 / 10 分钟）：多 isolate 时只是近似限流。
- **内存缓存**（搜索短缓存、豆瓣推荐、直播列表）只活在单个 isolate 内，命中率看流量分布，属正常。
- **实测 CPU**：`/` 约 17–26ms，`/api/status` 约 6–40ms，直播列表解析约 30ms，
  35 源聚合搜索约 2.7s（其中 CPU 很小），均未被 CPU 限制掐断。
- **直连播放依赖源站 CORS**：没有 `Access-Control-Allow-Origin`、防盗链、或 `http://` 混合内容
  的源只能换源；直播对这个最敏感（现有 12 个直播源约 30% 频道可直连，http 运营商流基本不可用）。
- **封面依赖 cmliussss 公共镜像**：镜像不可用时豆瓣原站会返回 418/403，此时显示占位图。
- `workers_dev: true` 保留了 `tv.ycxdev.workers.dev` 入口；不想要就把它设为 `false` 重新部署。
- 站点源已预置；用户仍可在「设置 → 源管理」里自行增删、订阅或测活。

## 排错

```powershell
npx wrangler tail tv --format json     # 看线上日志（含 cpuTime / 异常）
npx wrangler deployments list          # 版本历史
npx wrangler rollback                  # 回滚到上一个版本
```

`/api/status` 会返回 `version`（来自 `package.json`）、`passwordRequired` 与预置源列表，
可用来核对部署是否生效。
