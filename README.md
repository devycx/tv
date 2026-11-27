# 夜幕影视

夜幕影视是一个跑在 Cloudflare Workers 上的影视聚合站，把几十个采集站的搜索结果合并成卡片并用 ArtPlayer 播放，直播单独成页。

```mermaid
flowchart LR
  U[浏览器 · Next.js 页面 + ArtPlayer] --> GA[Cloudflare Access 门禁]
  GA --> MW[middleware 登录校验]
  MW --> CE[cf-entry 边缘缓存]
  CE --> API["/api 路由<br/>search / detail / cover / live 等 13 个"]
  API --> SRC[公开采集站 / 直播源]
  BUILD[构建期 bootstrap.generated.json] --> U
  U -->|视频与直播流直连| SRC
```
