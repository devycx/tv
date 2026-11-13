# 部署到 Cloudflare Workers（tv.ycxdev.com）

本项目（LibreTV Next.js 版）已改造成用 **OpenNext Cloudflare** 部署到 Cloudflare Workers。
线上地址：<https://tv.ycxdev.com>（同一份服务也在 `https://tv.ycxdev.workers.dev`）。

- Cloudflare 账号：`24c59299b11a61eed6fc8902524e0515`
- Worker 名：`tv`
- 自定义域：`tv.ycxdev.com`（`wrangler.jsonc` 的 `routes[].custom_domain`，部署时自动建 DNS 记录与证书）
- 访问密码：存为 Worker Secret `PASSWORD`（**不在仓库、不在 `wrangler.jsonc`**）

## 预置数据源

`wrangler.jsonc` 的 `vars` 里预置了两类源，登录后自动勾选 / 启用，开箱即用：

| 变量 | 内容 |
| --- | --- |
| `DEFAULT_SOURCES` | 13 个点播源（苹果CMS 采集站） |
| `DEFAULT_LIVE_SOURCES` | 4 个直播源（iptv-org 中国大陆 / zbds IPTV4 / aptv 综合 / 4K 专区） |

- 点播源：暴风、无尽、优酷、极速、新狼、豪华、魔都、百度、艾旦、爱坤、速播、速博、茅台。
  选源标准：**从 Cloudflare 边缘实测可连通**（本地能通但边缘 TLS 握手失败、返回 525 的源已剔除），
  且 `ac=videolist&wd=流浪地球` 能返回可播放的 m3u8 详情。
- 直播源：`/live` 页实测加载 600+ 频道；4K 专区是第三方维护的小列表。
- 修改源：编辑 `scripts/gen-wrangler.mjs` 里的数组 → `node scripts/gen-wrangler.mjs` →
  `npx wrangler deploy`（只改变量，不用重新 build）。
- 这些是**第三方公开接口**，可用性、内容与合规责任都不在本仓库；失效的源会被站内健康度机制自动停用，
  也可以在「设置 → 源管理」里手动取消勾选。

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
- 所有 `/api/*` 是 Worker 里的 Route Handler（Node 兼容运行时，`nodejs_compat`）；
- 首页推荐 / 搜索 / 代理等出网请求走 Cloudflare 边缘网络。

## 为 Workers 改了什么

| 文件 | 改动 |
| --- | --- |
| `next.config.ts` | `BUILD_TARGET=workers` 时用 `NormalModuleReplacementPlugin` 把 `./ssrf` / `@/lib/ssrf` 换成 `ssrf-workers.ts` |
| `src/lib/ssrf-workers.ts` | 新增。Workers 版 SSRF 校验：协议白名单 + 字面量私网 IP 拦截；**不做 DNS 解析**（Workers 没有 `node:dns`，也没有通往内网/云元数据的网络路径） |
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
  13 源聚合搜索约 2.1s（其中 CPU 很小），均未被 CPU 限制掐断。
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
