/**
 * 失败响应的统一判定。
 *
 * 关键点：本站「未配置 PASSWORD」的 503 一定是 JSON（api-guard / /api/auth 都是 NextResponse.json），
 * 而 Cloudflare 的 503 错误页是 HTML——Worker CPU/内存超限（Error 1102）返回的就是 503，
 * 如果按状态码一律当「未配置密码」，用户会看到莫名其妙的配置弹窗。
 *
 * 所以 503 必须同时看 content-type；client-api 与 live-playlist 共用这一处判断。
 */
export function isPasswordSetupResponse(res: Response): boolean {
  if (res.status !== 503) return false;
  return (res.headers.get('content-type') || '').includes('application/json');
}
