<p align="center">
  <img src="public/icons/brand-mark.svg" width="120" alt="夜幕影视">
</p>

<h1 align="center">夜幕影视</h1>

<p align="center">
  <a href="https://tv.ycxdev.com">tv.ycxdev.com</a>
</p>

自己用的影视聚合站。输入片名，几十个公开采集站一起搜，同一部片并成一张卡；直播单独一页。线上跑在 Cloudflare Workers 上。

技术栈还是上游那套：Next.js 15 App Router + TypeScript + Tailwind，播放内核 ArtPlayer + hls.js。

上游是 [LibreTV](https://github.com/LibreSpark/LibreTV) 的 Next.js 版，AGPL-3.0-or-later（见 [LICENSE](LICENSE)）。上游自带的功能这里不复述，要查去翻[上游文档](https://libretv.is-an.org/wiki/)；下面是我改的部分。

## ☁️ 部署：Docker 换成 Cloudflare Workers

- OpenNext 打包成 Worker（`tv`），自定义域 `tv.ycxdev.com`
- push `main` → CI（typecheck / lint / test）→ 自动 `cf:build` + `wrangler deploy`；本地 deploy 只留给预览、热修、回滚
- 登录检查挪到 middleware：未登录的页面 302 到 `/login`，`/api/*` 直接 401，HTML 不下发
- 视频和直播流全部浏览器直连源站，Worker 只出页面和 JSON。Cloudflare 不让拿 Workers 分发站外视频，`/api/proxy`、`/api/live/stream` 删掉了
- 首屏预置 20 个点播源（10 综合 + 10 个 18+）、10 个直播源（1.7 万条频道条目，跨源同名合并后仍上千个），构建期写进 `wrangler.jsonc` 和内联 bootstrap，登录即用
- Worker 入口加了一层缓存（页面 6h、搜索 60s），免费版 CPU 吃紧时不至于每次重新渲染

部署细节、预置源清单、排错和回滚：[DEPLOY-CLOUDFLARE.md](DEPLOY-CLOUDFLARE.md)

## 🔍 搜索

- 不再只按名称排：完全相等 > 前缀 > 每个词都中 > 包含 > 近似，同档再比年份
- 源超过 8 个时，搜索对半拆成两个请求，绕开 Worker 单次 6 连接的排队：同条件 8.1s → 2.0s
- 卡片进视口就整组探画质，展开后来源按画质 → 集数排，点封面直接用最好的源播
- 类型 / 年份 / 分级三行标签，同类多选 OR、跨类 AND，计数跟着其它条件实时变
- 一页 24 条，翻页后顺序冻结，想重排有按钮

## 🖼️ 封面

- 同一张海报只出一张卡：封面画到 9×8 算 dHash（先裁中心 4:5，再两段缩放），汉明距离 ≤10 归一部片。换域名、换分辨率、两个扫描件都能合上
- 阈值没放宽，同名同年的不同海报（剧版和影版）各算各的，不硬并
- 取不到封面就不显示：没 `pic`、算指纹失败、浏览器加载不出来，整张卡隐藏，不留占位图；多源组先换组里下一张
- 取图先试浏览器 CORS 直连，失败转同源 `/api/cover`（只用来算指纹）；图床 525 降级 http 重试，直连拿到防盗链 HTML 也会换代理

## 📺 直播

- 同一频道跨源合并：`CCTV-1 综合` / `CCTV1高清` / `央视一套` 是一行，右边标「N 源」；`CCTV-5` 和 `CCTV-5+` 不合并
- 点开才探测：单源直接播（0 请求）；多源先读 6 小时缓存，没有就发一次 `/api/live/probe`（≤8 个 URL 一次 invocation 并行）挑第一个能播的。再点正在播的频道 = 换下一个源
- 以前进页面就全量测活：1477 个频道 ≈ 185 次 invocation，免费版 Worker 的 CPU 直接打爆
- 那次还带出个 503 误判——Cloudflare 的错误页被客户端当成「没配密码」弹窗，也一起修了。现在只在点频道时才探测
- 手机端频道列表常驻在播放器下方，选中不收起；入口是顶栏的电视图标，不再藏在汉堡菜单里
- 装了「跨域助手」（GM_fetch）时，直播 HLS 改走扩展后台，http 流也能播
- 红点、LIVE 角标、测活工具栏全删了。正在播的那行不标状态——探测有假阴性，给能播的源标红就是误报

## ▶️ 播放页

- 顶部换成全站顶栏；标题挪到播放器上方，下载进控制条，自动连播进播放器齿轮菜单，切换资源放在视频下方
- `.player-stage` 加 `isolation: isolate`，修掉控制条压住设置 / 跳过标记抽屉的层级问题
- 详情页简介按纯文本渲染，长的折叠展开，不再漏 HTML 标签

## 🏠 首页

- 推荐区默认收起，点标签才加载、再点收起；空闲时预取热榜、豆瓣标签、Bangumi 日历，只拉 JSON 不拉图
- 顶栏去掉重复的 logo，留居中大标题

## 🎨 界面

- 主题两态：浅色 ⇄ 深色。去掉「跟随系统」，旧值 `system` 归到深色，首屏不闪
- 品牌和整套图标重画，清掉 LibreTV 残留
- 设置面板不写说明文字；缓存只显示已占用多少 MB + 清理

## 🛠️ 本地开发

```bash
npm install
PASSWORD=dev-password npm run dev   # http://localhost:8080
npm test                            # vitest，750+ 例
npm run typecheck
```

- 截图 / DOM 断言用 `npm run shot`：开本机 Chrome 的移动视口读真实数值，不碰日常标签页。参数和 UI 不变量见 [docs/ui-verification.md](docs/ui-verification.md)
- 封面聚合的设计、阈值和取图踩过的坑：[docs/search-cover-aggregation.md](docs/search-cover-aggregation.md)

## 📌 待办

- 油猴脚本直连模式：搜索从访客浏览器经 `GM_xmlhttpRequest` 打到采集站，Worker 只留页面和登录。为什么非油猴不可、失败了怎么回退，写在 [docs/userscript-plan.md](docs/userscript-plan.md)

## 🙏 上游与免责

- 基于 [LibreSpark/LibreTV](https://github.com/LibreSpark/LibreTV) 二次开发，沿用 AGPL-3.0-or-later
- 采集站、直播源、节目单都是第三方公开资源。本站不存储、不转码、不制作视频，能不能播取决于源站，内容的合法性也由源站负责
