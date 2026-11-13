/**
 * 登录后回跳路径（`?next=`）的校验，middleware 与 /login 页共用。
 *
 * 只接受站内相对路径，防开放重定向：
 * - 必须是 `/` 开头，但不能是 `//host`（协议相对）或 `/\host`（浏览器会把 `\` 当 `/`）；
 * - 带反斜杠 / 控制字符的一律拒绝（不同浏览器对 `\` 的归一化行为不一致）；
 * - 不能回跳到 `/login` 本身：已登录访问 `/login?next=/login` 会形成 302 循环；
 * - 不回跳 API：登录后落在 JSON 响应上没有意义。
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw) return '/';
  if (!raw.startsWith('/')) return '/';
  if (raw.startsWith('//')) return '/';
  if (/[\\\u0000-\u001f]/.test(raw)) return '/';
  // `/login`、`/login?x=1`、`/login#frag` 都会把已登录用户送回登录页
  if (raw === '/login' || raw.startsWith('/login?') || raw.startsWith('/login#')) return '/';
  // /api/* 不是给浏览器导航用的
  if (raw === '/api' || raw.startsWith('/api/') || raw.startsWith('/api?')) return '/';
  return raw;
}
