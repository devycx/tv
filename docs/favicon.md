# 标签页图标（favicon）：为什么是内联 data URI

改 logo / 改图标口径之前先读这页。**结论：标签页图标只有一条来源——`layout.tsx` 里内联
的 48px 透明 PNG（data URI）；不要重新挂 `/favicon.ico` 或 `favicon-*.png` 的 `<link>`。**

## 1. 两个已经踩过的坑

| 时间 | 现象 | 原因 | 修法 |
|---|---|---|---|
| 2026-11-14（`93105c3`） | 桌面 Chrome 标签页/书签是一个**黑底方块 + 蓝色播放键** | `layout.tsx` 把深色底（`#0B101A`）的 `icon-96/192.png` 声明成页面 icon | 页面 icon 换成透明徽标 `favicon.ico` + `favicon-32/96/192.png` |
| 2026-11-16 | **手机浏览器首次访问是黑底，刷新一下变透明**（稳定复现） | 首次访问时 favicon 要走一次网络请求；请求回来之前标签页没有可画的图标，浏览器先画深色占位方块。刷新时图标已在浏览器缓存/数据库里，所以立刻是透明徽标 | 48px 透明徽标内联成 data URI（`src/lib/favicon.generated.json`），图标随 HTML 一起到达 |

判定「是不是首访时机问题」的快速办法：**同一个 URL 刷新一次就正常** = 图标本身没问题，
是首次绘制时还没有图标；反之一直黑 = 图标文件本身就是深色底。

## 2. 现在的实现

```
public/icons/brand-mark.svg          # 唯一矢量源：透明徽标（24:17）
        │  npm run icons
        ├─ public/icons/favicon-{16,32,48,96,192}.png   # 真透明（保留 alpha）
        ├─ public/favicon.ico                            # 16/32/48 内嵌 PNG，隐式兜底
        └─ src/lib/favicon.generated.json                # 48px 的 data URI，layout.tsx 引用
```

- `public/icons/icon-source.svg`（深色底 + 徽标）只给 **PWA / apple-touch-icon**：安装到
  桌面、手机主屏需要不透明底板，iOS 还会把透明处压成黑色。
- `layout.tsx` 的 `metadata.icons.icon` **只有这一条** data URI。故意不再声明
  `/favicon.ico`、`favicon-32/96/192.png`：一旦同时挂网络图标，浏览器会按尺寸挑更大的
  那张去下载，首访的深色占位方块就又回来了。
- 不认 data URI 的老浏览器会隐式请求根目录 `/favicon.ico`（同一份透明徽标）兜底。
- 改完 logo 必须重跑 `npm run icons`，否则内联的 data URI 会和 PNG/ICO 不一致
  （`src/lib/favicon.test.ts` 会报红）。

## 3. 验证

```powershell
cd tv
npm run icons          # 重新生成 PNG / ICO / favicon.generated.json
npm test -- favicon    # 断言：RGBA、四角透明、无不透明近黑像素、data URI 与 favicon-48.png 一致
```

线上核对（不需要真机也能查一部分）：

- `Invoke-WebRequest https://tv.ycxdev.com/login` 的 `<head>` 里应该只有一条
  `rel="icon"`，且 `href` 以 `data:image/png;base64,` 开头；
- Chrome 的图标库在 `%LOCALAPPDATA%\Google\Chrome\User Data\Default\Favicons`
  （SQLite：`icon_mapping` → `favicons.url` → `favicon_bitmaps.image_data`），
  可以看到某个页面最后用的是哪张图标、位图是不是带 alpha 的 PNG。查之前先关掉 Chrome
  或复制一份再读。

## 4. 真机复现/回归

- 手机浏览器开一个**无痕/新标签页**首次访问 `https://tv.ycxdev.com/`：标签页图标应当一
  开始就是透明徽标，不再先出现深色方块。
- 想确认「不再发图标请求」：Chrome 桌面打开一个声明 data URI 图标的页面，DevTools
  Network 里不应出现 `/favicon.ico`（2026-11-16 用本地 probe 实测：只有 HTML + manifest
  + manifest 里的 `icon-192.png`）。
