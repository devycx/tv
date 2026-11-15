# 播放页 / 移动端 UI 验证手册

适用场景：改 `/watch`、`/live`、设置抽屉、跳过标记面板等界面后，需要确认**窄屏布局、换行、层级、控件位置**没有回归。

原则：截图看观感，DOM 数值看事实。截图会被缩放，小字/1px 线/精确颜色不可靠；尺寸、换行、层叠顺序一律用 `getBoundingClientRect()` / `getComputedStyle()` / `elementFromPoint()` 断言。

## 工具

`scripts/shot.mjs`：用本机 Chrome 起一个隔离的无头实例，通过 CDP 设置移动视口、登录、执行 JS、截图。不依赖浏览器扩展，也不影响日常 Chrome 的标签页。

要求：Node ≥ 22（用到全局 `WebSocket`）、本机 Chrome。

```bash
# 只截图
npm run shot -- --url "http://localhost:8080/" --out .tmp/shots/home.png

# 播放页：等播放器挂载，再打开设置抽屉
npm run shot -- --url "http://localhost:8080/watch?..." \
  --selector ".art-video-player" --out .tmp/shots/watch-settings.png --open-settings

# 只跑断言、不截图
npm run shot -- --url "https://tv.ycxdev.com/..." \
  --log "({ iso: getComputedStyle(document.querySelector('.player-stage')).isolation })"
```

完整参数见 `npm run shot -- --help` 或 `scripts/shot.mjs` 顶部注释。要点：

- `--url` 的 origin 同时用于登录（`POST /api/auth`）；密码来自 `SHOT_PASSWORD` 或仓库根 `.dev.vars` 的 `PASSWORD=`（不打印）。
- `--selector` 适合等 `.art-video-player` / `[role=dialog]` 这类稳定节点；`--wait` 只负责固定延时。
- `--js` 是函数体（可 `await`、可 `return`），`--log` 是单个表达式（结果 JSON 打印）。
- 视口默认 390×844 @3x（`--width` / `--height` / `--dsf`）；宽度 < 640 时自动开启触摸模拟。
- `--profile` 默认 `.tmp/chrome-shot-profile`，已被 gitignore；同一次调试里登录态和 localStorage 会保留。
- 结束前会尝试 `Browser.close` 再兜底 kill，给 Chrome 留出写 localStorage 的时间（直接 kill 会丢最后一次设置写入）。

## 本地准备

```bash
npm install
PASSWORD=dev-password npm run dev   # http://localhost:8080
```

本机（Windows）的 Node / TEMP 等细节见仓库根 `AGENTS.md`。注意两点：

1. **本地采集站请求通常不可用**：Clash fake-IP 会把源站域名解析到 `198.18.0.0/15`，Node 侧 SSRF 防护会拦。不要用「本地搜索真实源」来验证播放器，改用公开测试 HLS + 直连 `url` 参数：

   ```text
   https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8
   ```

   ```bash
   npm run shot -- \
     --url "http://localhost:8080/watch?source=env_4&url=https%3A%2F%2Ftest-streams.mux.dev%2Fx36xhzz%2Fx36xhzz.m3u8&title=%E6%B5%8B%E8%AF%95" \
     --selector ".art-video-player" --out .tmp/shots/watch.png
   ```

2. **线上验证**用同一个工具，把 `--url` 换成 `https://tv.ycxdev.com/...`；密码必须与部署的 `PASSWORD` 一致。真实播放页建议走线上搜索（本地搜索会被上一条限制拦住）。

## 播放页 UI 不变量（2026-11-14 改版后）

- 顶栏复用 `<Header>`：`leading={<BackButton />}`，其余与首页一致；**不要**再把标题、下载、切源塞回顶栏。
- 视频标题单独成块，位于主内容顶部、播放器上方：`main h1` = 视频名，下面一行是 `来源名` 和 `· 第 N/M 集`。
- 下载入口在播放器控制条内：`.art-control-download`（右侧组，`index: 25`，位于设置左侧）。
- 视频下方操作栏：`上一集 / 下一集 / 跳过标记 / 切换资源`，容器 `flex flex-wrap`，窄屏自动折行。
- 自动连播在播放器齿轮菜单里：artplayer setting item `[data-name="autoplay-next"]`（原生 `switch`），写回 store 的 `autoplayNext`；设置抽屉「偏好设置 → 播放与过滤」是另一个入口，两边通过 effect 双向同步。
- 播放器右下角不再有「自动连播已开启」角标。

快速断言：

```js
(() => {
  const row = [...document.querySelectorAll('main .flex-wrap')][0];
  const stage = document.querySelector('.player-stage');
  return {
    h1: document.querySelector('main h1')?.textContent,
    header: document.querySelector('header')?.innerText,
    controls: ['art-control-download'].map((c) => !!document.querySelector(`.${c}`)),
    row: [...row.querySelectorAll('button')].map((b) => b.textContent.trim()),
    rowHeight: Math.round(row.getBoundingClientRect().height),
    stageIsolation: getComputedStyle(stage).isolation,
  };
})()
```

在 390px 宽、无剧集元数据的直连测试页上，预期 `row` 只有四个按钮且 `rowHeight` 为 36（一行）；在 320px 下允许折成两行。

## 层级：artplayer 压住抽屉的根因与修法

artplayer 内部有大量绝对定位层，z-index 从 40 到 120：

| 层 | z-index |
|---|---|
| `.art-video` | 10 |
| `.art-bottom`（进度条 + 控制条） | 60 |
| `.art-loading` | 70 |
| `.art-notice` | 80 |
| `.art-settings` | 90 |
| `.art-info` | 100 |
| `.art-contextmenus` | 120 |

`.art-video-player` 自身是 `position: relative`，但 **z-index: auto，不构成层叠上下文**。这些内部层级会直接参与根上下文的比较，于是一个 `z-index: 60` 的控制条就能压过 `z-50` 的设置/跳过标记抽屉（手机上的表现：抽屉正文上浮着一条播放器控制栏）。

修法：给播放器外壳 `.player-stage` 加 `isolation: isolate`（见 `globals.css`），把内部层级收进局部上下文。

**网页全屏不要加例外规则。** artplayer 的 `FULLSCREEN_WEB_IN_BODY = true`，进入网页全屏时会把 `.art-video-player` 直接 `append(document.body, ...)`，它会自然脱离 `.player-stage` 的隔离，继续以 `z-index: 9999` 盖住 `z-40` 顶栏和 `z-50` 抽屉。不要写 `.player-stage:has(.art-fullscreen-web)` 去“放开隔离”——全屏时节点已经不在 stage 里，这个选择器永远不匹配（这是实际踩过的坑）。

层级自测：

```js
(() => {
  const stage = document.querySelector('.player-stage');
  const dialog = document.querySelector('[role="dialog"]');
  const r = stage.getBoundingClientRect();
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return {
    isolation: getComputedStyle(stage).isolation,
    dialogOpen: !!dialog,
    // 抽屉打开时，播放器中心点应命中抽屉内的元素，而不是 .player-stage 里的控件
    playerOnTop: !!top && stage.contains(top),
  };
})()
```

浏览器网页全屏自测：点 `.art-control-fullscreenWeb` 后，`.art-video-player.parentElement` 应为 `BODY`，屏幕顶部 `elementFromPoint(innerWidth/2, 4)` 应落在播放器/`VIDEO` 上，而不是 `HEADER`。

## 截图与 DOM 的分工

- 截图用于确认观感：层级顺序、间距、按钮是否被裁切、抽屉有没有盖住该盖的内容。
- 数值用于确认事实：`getBoundingClientRect()` 的 `top/bottom/height`、`getComputedStyle().isolation/zIndex`、`elementFromPoint()` 命中的元素。
- 截图工具返回的只是缩放后的预览；需要精确到 1px 或颜色时，读源码/计算样式，不要靠图。
- 同一份 Chrome profile 会保留 localStorage；验证「刷新后设置是否还在」时，注意不要被上一次截图残留的状态误导（可换 `--profile`）。

## 线上验证

1. push `main` 后先看 CI：`gh run watch <ci-run-id> -R devycx/tv --exit-status`。
2. 再看部署：`gh run list -R devycx/tv --limit 4`，等 `deploy-cloudflare` 成功；`gh run view <deploy-run-id> -R devycx/tv --json headSha` 核对是本次提交。
3. 用同一套工具跑线上：首页/搜索、真实播放页、播放器菜单、设置抽屉各截一张；断言 `isolation`、`elementFromPoint`、按钮文案。
4. 线上真实播放页的拿法：打开 `https://tv.ycxdev.com/?s=庆余年`，等待 15–20s（35 个源并行），点第一个 `[role="button"][aria-label^="直接播放"]` 的封面，落到带 `source/id/url` 的 `/watch`。

## 搜索页：封面指纹与筛选（2026-11-15）

设计与线上坑见 [search-cover-aggregation.md](./search-cover-aggregation.md)。这里只记「怎么验」。

**本地注意**：`/api/cover` 在本地 dev 会因 Clash fake-IP + SSRF 被拦，封面指纹会全部走 URL/片名兜底；**不要据此判断聚合回归**。本地验证请用 mock 封面，或直接验线上。

**线上验证**（等待真实搜索 + 取图完成，约 20s）：

```powershell
$init = "localStorage.setItem('libretv-theme','light');localStorage.setItem('libretv-settings',JSON.stringify({state:{yellowFilter:false},version:8}));localStorage.removeItem('cover-visual-hashes-v1')"
npm run shot -- --url "https://tv.ycxdev.com/?s=%E8%89%B2%E6%88%92" --init-js $init `
  --selector 'section[aria-label="搜索结果"] .card' --wait 20000 `
  --out .tmp/shots/prod-search-cover-facets.png
```

断言：

- 结果头：`N 部影片 · M 条来源结果，同封面已聚合`（`pending` 提示最终消失）；
- 筛选条存在类型/年份/18禁 chip；
- 点「伦理片」后：`筛选出 X 部影片 · Y 条来源结果 / 共 N 部 · M 条`，chip `aria-pressed=true`，出现「清除筛选」；
- 同一张封面（换域名/分辨率）应合成一张卡；同名不同海报允许分开。

2026-11-15 基线（`0fecf87`）：`?s=色戒` 24 部 / 71 条；点「伦理片」6 部 / 48 条；首屏有 14 源/16 源合并卡。

## 跨域助手（GM_fetch）路径怎么验

不装油猴也能验证「检测到 `GM_fetch` 后**直播播放器**改走扩展请求」的接线：用 `--init-js` 注入一个计数版
`GM_fetch`（内部仍用原生 fetch，测试流本身有 CORS 即可）。

```powershell
$init = "window.__gmCalls=[];const nf=window.fetch.bind(window);window.GM_fetch=function(input,init){var u=typeof input==='string'?input:(input&&input.url)||String(input);window.__gmCalls.push(u);return nf(input,init);};"
npm run shot -- --url "http://localhost:8080/live?url=https%3A%2F%2Ftest-streams.mux.dev%2Fx36xhzz%2Fx36xhzz.m3u8&name=GM%E6%B5%8B%E8%AF%95" `
  --init-js $init --selector ".art-video-player" --wait 6000 `
  --log "({ mux: window.__gmCalls.filter(u=>u.includes('mux.dev')), t: document.querySelector('video')?.currentTime })"
```

预期：`mux` 里出现 master / variant / `.ts` 分片，`t > 0`（播放中）。去掉 `--init-js` 后同一 URL 应同样能播，
说明没有脚本时的回退路径没回归。**这个 mock 只证明接线正确**；真正的 CORS 绕过必须装脚本在真实设备上验。

## 2026-11-14 改版记录

- 提交 `ffcbd5a`：顶栏复用、标题上移、下载进控制条、切源与跳过标记并列、自动连播进齿轮菜单、`.player-stage` 隔离。
- CI `43605020218`、部署 `43605085303` 成功；线上用《庆余年》魔都资源第 46 集实测通过。
- 关键回归点：手机设置抽屉打开时，播放器控制条不得再浮在抽屉正文上；网页全屏仍要能盖住顶栏。

## 详情弹窗简介：服务端洗成纯文本 + 展开（2026-11-15）

CMS 的 `vod_content` 多半是编辑器产出的富文本（公众号排版导出最极端：整段
`<p><span style="color: rgb(17, 17, 17); font-family: Helvetica, ...">`）。服务端
`parseDetail` / `parseDetailPageHtml` 统一用 `lib/html-text.ts` 洗成纯文本：去 `script/style/注释`、
块级标签与 `<br>` 转段落、行内标签不插空格（中文切词插空格会读不通）、解一层实体、压缩空白、
超 2000 字截断；分集兜底仍用原始 HTML 提取 m3u8，并把 content 里内嵌的直链从简介中摘掉。

- **不要在 UI 层改回 HTML 渲染**：源站内联样式（近黑色文字 + 白底、13px Helvetica）在暗色主题下会变成
  白底黑字一大块，还得引 sanitizer 防 `<img>/<script>`。
- 前端 `ExpandableText` 默认 clamp 3 行，只有真溢出（`scrollHeight > clientHeight`）才出现「展开 / 收起」，
  换片回到收起态。
- 断言（打开详情弹窗后）：

  ```js
  (() => {
    const dialog = document.querySelector('[role="dialog"]');
    const p = dialog.querySelector('p');
    const toggle = [...dialog.querySelectorAll('button')].find((b) => /^(展开|收起)/.test(b.textContent.trim()));
    return { hasTag: p.textContent.includes('<'), toggle: toggle?.textContent.trim(), h: p.clientHeight, sh: p.scrollHeight };
  })()
  ```

- 线上基线（`52204aa`，390×844）：`?s=色戒` 里「色戒【影视解说】」是多源卡，先点文字区展开、再点
  来源行才进详情。简介 3 段；`hasTag: false`，收起 68px / 展开 523px，按钮文案 `展开 ↔ 收起`。
