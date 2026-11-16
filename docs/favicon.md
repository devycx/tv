# 标签页图标（favicon）：网络图标 + `?v=` 换 URL 才是主路径

改 logo / 改图标口径之前先读这页。**结论：标签页图标的主路径是三条网络图标 link
（`/favicon.ico`、`/icons/favicon-32.png`、`/icons/favicon-96.png`），URL 必须带
`?v=<图标内容哈希>`；内联 data URI 只是兜底。不要只声明 data URI。**

## 1. 三次已经踩过的坑

| 时间 | 现象 | 原因 | 修法 |
|---|---|---|---|
| 2026-11-14（`93105c3`） | 桌面 Chrome 标签页/书签是一个**黑底方块 + 蓝色播放键** | `layout.tsx` 把深色底（`#0B101A`）的 `icon-96/192.png` 声明成页面 icon | 页面 icon 换成透明徽标 `favicon.ico` + `favicon-32/96/192.png` |
| 2026-11-16 上午（`0c90fe5`） | 手机浏览器「首次访问黑底、刷新后透明」 | 图标走网络请求，首访要等一次请求；当时判断成纯时机问题 | 48px 透明徽标内联成 data URI，**并且删掉了所有网络图标 link** |
| 2026-11-16 中午（本次） | 手机标签页**一直是黑底，刷新也不变**（比上一版更糟） | 只留 data URI：手机端 Chromium 变种里有的不认 data URI，于是没有任何可拉取的图标，浏览器只能用它图标库里缓存的旧深色图；而 URL 没变，刷新也不会重拉 | **网络图标全部加回**，URL 带 `?v=<hash>`：换 logo 必换 URL，旧条目一定失效 |

判定口径：

- **刷新一次就正常** → 先怀疑「首访那次请求/缓存没拿到新图」；
- **刷新也不变** → 图标库里那张旧的没被换掉（URL 没变 / 页面没声明可拉取的图标），换 URL 才治本。

## 2. 现在的实现

```
public/icons/brand-mark.svg          # 唯一矢量源：透明徽标（24:17）
        │  npm run icons
        ├─ public/icons/favicon-{16,32,48,96,192}.png   # 真透明（保留 alpha）
        ├─ public/favicon.ico                            # 16/32/48 内嵌 PNG
        └─ src/lib/favicon.generated.json                # data URI + version(sha256 前 8 位)
```

`layout.tsx` 的 `metadata.icons.icon` 是四条，顺序即重要性：

1. `/favicon.ico?v=<version>`，`sizes="16x16 32x32 48x48"`（Chromium 实测会优先选这条）
2. `/icons/favicon-32.png?v=<version>`
3. `/icons/favicon-96.png?v=<version>`
4. 48px data URI（兜底；Chromium 只要有网络图标就不会选它）

- `public/icons/icon-source.svg`（深色底 + 徽标）只给 **PWA / apple-touch-icon**：安装到桌面、
  手机主屏需要不透明底板，iOS 还会把透明处压成黑色。
- `?v=` 用「全部 favicon PNG + ICO 字节」的 sha256 前 8 位，`npm run icons` 生成；
  `src/lib/favicon.test.ts` 会重算比对，改了 logo 忘了重跑脚本会直接红。
- 改完 logo 必须重跑 `npm run icons`（PNG / ICO / data URI / 版本号四者要同步）。

## 3. 验证

```powershell
cd tv
npm run icons          # 重新生成 PNG / ICO / favicon.generated.json（含 version）
npm test -- favicon    # 15 例：RGBA、四角透明、无不透明近黑像素、ICO 与 PNG 一致、version 与字节哈希一致
```

线上核对：

- `Invoke-WebRequest https://tv.ycxdev.com/login` 的 `<head>` 里应有 4 条 `rel="icon"`，
  其中 3 条带同一个 `?v=xxxxxxxx`，第 4 条是 `data:image/png;base64,`；
- `https://tv.ycxdev.com/favicon.ico?v=xxxxxxxx` 与 `?v=` 无参数时字节一致（query 不影响静态资源）；
- Chrome 图标库 `%LOCALAPPDATA%\Google\Chrome\User Data\Default\Favicons`
  （SQLite：`icon_mapping` → `favicons.url` → `favicon_bitmaps.image_data`）可以直接看
  某页面最后用的是哪张图、位图带不带 alpha。查之前先关 Chrome 或复制一份再读。

## 4. 探针结论（2026-11-16，本机 Chrome 157 实测）

用本地页面测了四种声明组合，看 Chrome 最终落在哪张图标（看图标库 mapping + 服务端请求日志）：

| 声明 | Chrome 的选择 |
|---|---|
| 只有 48px data URI | 用 data URI，不发图标请求（图标库有 16/32 位图，透明） |
| data URI + 32/96 PNG | **32px PNG**（发请求），data URI 被忽略 |
| data URI + 32/96 PNG + `sizes` 多值的 ICO | **ICO**（发请求） |
| data URI 写成 `sizes="any"` + PNG | 仍然是 PNG；`sizes="any"` 压不过网络图标 |

⇒ 只要声明了网络图标，Chromium 就会用网络图标。所以「内联 data URI 免请求」和
「不认 data URI 的浏览器也能拿到图标」不可兼得；按上面的顺序两个都声明，让能选的实现各自最优。

## 5. 真机回归

- 手机上用**新标签页**打开 `https://tv.ycxdev.com/`（同一站点已缓存旧图标时，换成
  `?v=` 后的 URL 会自动重拉；实在顽固就清一次该站点的站点数据）。
- 标签页图标应当一开始就是透明徽标，且刷新/重开后保持一致。
