# 油猴脚本：浏览器直连模式（未开发，方案已定）

从 README 的 TODO 拆出来的设计记录，免得正文太长。

## 动机

聚合搜索现在全部由 Worker 扇出。出于隐私 / 配额考虑，希望像「豆瓣多站找资源」那类脚本一样，让请求从各自浏览器直接打到采集站。

## 为什么不能只靠页面 JS

苹果 CMS 的 `?ac=videolist` 接口基本不返回 `Access-Control-Allow-Origin`（实测电影天堂 / 飘零 / 无尽 / 极速 4 个源全部缺失），https 页面里 `fetch()` 能拿到 200 但读不到 body；另有 `http://` 源的混合内容拦截。油猴的 `GM_xmlhttpRequest` 由扩展后台进程发起，不受 CORS 约束——这才是「无服务器」成立的真正原因。

## 计划形态

在 `tv.ycxdev.com` 注入脚本，hook `window.fetch`，拦截 `/api/search` 与 `/api/quality`：

1. 用 `GM_xmlhttpRequest` 并行请求各源（绕过 CORS 与混合内容限制），按现有 NDJSON 事件格式把 `source` / `done` 事件流回页面，UI 不用改；
2. 过滤与排序复用站点同一套纯函数（`filterRelevantResults`、`compareSearchResults`、画质解析），保证油猴模式和 Worker 模式结果一致；
3. 失败（脚本不可用 / 源站拒绝）时回退到站点原有 `/api/search`，两种模式共存；
4. 源配置仍由站点下发，脚本不存任何密钥。

## 待办

- 脚本壳 + 构建产物（`@grant GM_xmlhttpRequest`）
- 与服务端引擎的版本对齐检查
- Greasy Fork 发布
- 上线后 Worker 只保留静态页面与登录，搜索 / 探测的扇出完全由访客浏览器承担
