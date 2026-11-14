import { isWorkerResourceLimit, reportWorkerResourceLimit } from './adaptive-batch';

/**
 * 失败响应的统一判定。
 *
 * 两个容易混淆的失败语义必须在一处判断，否则同一条错误在不同调用方会有不同表现：
 * - 本站「未配置 PASSWORD」的 503 一定是 JSON（api-guard / /api/auth 都是 NextResponse.json）；
 * - Cloudflare 的 503/500 错误页是 HTML，其中 1102（Worker exceeded resource limits）
 *   要降批并给出资源超限文案，而不是误弹登录框。
 *
 * client-api 与 live-playlist 都走这里：后者是直播页拉列表的主路径（浏览器直连失败后的
 * 服务端回退），曾经不区分 503 的内容类型，一条 Cloudflare 错误页就能弹出「未配置密码」。
 */

/** 1102 的对外文案：各调用方共用，避免同一件事出现三种说法 */
export const RESOURCE_LIMIT_MESSAGE = '服务器资源超限（Cloudflare 1102），已自动降低批次，请稍后重试';

/** 是否为「服务器未配置 PASSWORD」的 503（只认本站 JSON，Cloudflare 错误页是 HTML） */
export function isPasswordSetupResponse(res: Response): boolean {
  if (res.status !== 503) return false;
  return (res.headers.get('content-type') || '').includes('application/json');
}

/** 读失败响应正文（clone 一份，不影响后续 JSON 解析/流消费） */
export async function readErrorBody(res: Response): Promise<string> {
  try {
    return await res.clone().text();
  } catch {
    return '';
  }
}

/** 识别 Cloudflare 1102 并上报全局降批；返回是否资源超限 */
export function noteWorkerResourceLimit(res: Response, body: string): boolean {
  const limited = isWorkerResourceLimit(res.status, body, res.headers);
  if (limited) reportWorkerResourceLimit();
  return limited;
}
