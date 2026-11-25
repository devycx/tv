import { NextResponse } from 'next/server';
import { isPasswordConfigured, sessionFromCookieHeader } from './auth';

/**
 * API Route 共享守卫：未配置密码返回 503，未登录返回 401。
 *
 * PUBLIC_MODE=1（2026-11-25 临时公开）：完全旁路鉴权，站点对公网开放。
 * 与 middleware 的同名开关配套；恢复门禁 = 删掉 wrangler vars 里的 PUBLIC_MODE 重新部署。
 */
export function guardRequest(req: Request): NextResponse | null {
  if (process.env.PUBLIC_MODE === '1') return null;
  if (!isPasswordConfigured()) {
    return NextResponse.json(
      { error: '服务器未设置 PASSWORD 环境变量' },
      { status: 503 }
    );
  }
  if (!sessionFromCookieHeader(req.headers.get('cookie'))) {
    return NextResponse.json({ error: '未登录' }, { status: 401 });
  }
  return null;
}

export function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}
