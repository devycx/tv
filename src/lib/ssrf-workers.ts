/**
 * Cloudflare Workers 版 SSRF 校验层。
 *
 * 由 next.config.ts 在 BUILD_TARGET=workers 时通过 NormalModuleReplacementPlugin
 * 替换掉 ./ssrf（Node 版依赖 undici Agent + node:dns，Workers 里没有这些能力）。
 *
 * 保留的防护：
 * - 协议白名单（仅 http/https）
 * - 字面量私网 / 回环 / 链路本地 / 保留地址拦截（含 IPv4-mapped IPv6）
 * - 每一跳重定向都重新校验（fetch-utils 的 fetchWithSafeRedirects 逻辑未变）
 *
 * 去掉的部分：连接级 DNS 校验（DNS Rebinding 防护）。
 * 原因：Workers 没有 node:dns，也没有通往内网 / 云元数据的网络路径，
 * 解析到 127.0.0.1、169.254.169.254 的请求在边缘侧本身不可达，因此不存在可被
 * 利用的内网横向通道；DNS 预解析只会在每次代理时多一次外部查询与延迟。
 */

/** 去掉 URL.hostname 对 IPv6 附加的方括号（"[::1]" → "::1"） */
function stripBrackets(host: string): string {
  return host.trim().replace(/^\[+|\]+$/g, '');
}

/**
 * IPv4-mapped / IPv4-compatible IPv6 还原为点分十进制，命中不到时返回 null。
 */
function toIPv4(ip: string): string | null {
  const v = ip.replace(/^0:0:0:0:0:/i, '::');
  const dotted = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(v);
  if (dotted) return dotted[1];
  const hex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(v);
  if (!hex) return null;
  const n = (((parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16)) >>> 0);
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** 判断 IP 是否为私有/回环/链路本地/保留地址（SSRF 防护） */
export function isPrivateIP(ip: string): boolean {
  let v = stripBrackets(ip.trim());
  v = toIPv4(v) ?? v;
  if (/^(127\.|0\.0\.0\.0$|::1$|::$|fe80:|fc|fd)/i.test(v)) return true;
  if (v.startsWith('10.')) return true;
  if (v.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(v)) return true;
  if (v.startsWith('169.254.')) return true;
  if (v.startsWith('100.64.')) return true;
  if (v.startsWith('192.0.0.')) return true;
  return false;
}

const BLOCKED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

/** URL 字面量校验：协议白名单 + 主机名/字面量 IP 黑名单 */
export function isValidProxyUrl(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = stripBrackets(parsed.hostname);
    if (BLOCKED_HOSTNAMES.has(host)) return false;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
      if (isPrivateIP(host)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Workers 侧不做 DNS 解析（见文件头注释），只拦字面量私网 IP */
export async function isBlockedByDNS(urlString: string): Promise<boolean> {
  try {
    const hostname = stripBrackets(new URL(urlString).hostname);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')) {
      return isPrivateIP(hostname);
    }
    return false;
  } catch {
    return false;
  }
}

export type UpstreamVerdict = { ok: true } | { ok: false; reason: string };

export async function checkUpstreamAllowed(urlString: string): Promise<UpstreamVerdict> {
  if (!isValidProxyUrl(urlString)) {
    return { ok: false, reason: '目标地址不在允许范围内（仅支持公网 http/https）' };
  }
  if (await isBlockedByDNS(urlString)) {
    return { ok: false, reason: '目标地址解析到私有/保留网络' };
  }
  return { ok: true };
}

/** 直播场景是否放行内网地址（自建 IPTV）；由部署者显式开启 */
export function allowLivePrivate(): boolean {
  return process.env.LIVE_ALLOW_PRIVATE === '1';
}

export async function checkLiveUrlAllowed(urlString: string): Promise<UpstreamVerdict> {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, reason: '直播地址仅支持 http/https 协议' };
    }
  } catch {
    return { ok: false, reason: '无效的直播地址' };
  }
  if (allowLivePrivate()) return { ok: true };
  return checkUpstreamAllowed(urlString);
}

export interface SSRFProtectionContext {
  active: boolean;
  allowPrivate?: boolean;
}

export interface AgentLike {
  close: () => Promise<void>;
  destroy: () => Promise<void>;
}

/** Workers 上没有 undici Agent，连接层防护不可用 */
export function createSSRFAgent(): AgentLike {
  throw new Error('Cloudflare Workers 运行时不支持连接级 SSRF Agent');
}

/** Workers 无需包装全局 fetch：所有出网请求都走边缘网络，不存在内网目标 */
export async function installFetchSSRFProtection(): Promise<void> {}

export const installConnectionSSRFProtection = installFetchSSRFProtection;

/** 与 Node 版签名一致；Workers 侧直接执行 */
export async function runWithSSRFProtection<T>(
  options: { allowPrivate?: boolean } = {},
  fn: () => Promise<T>
): Promise<T> {
  void options;
  return fn();
}
