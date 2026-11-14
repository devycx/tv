import * as ipaddr from 'ipaddr.js';

/**
 * 公共 SSRF 纯函数校验层（基于成熟库 ipaddr.js，无 Node 内置模块依赖，Node 与 Workers 共用）。
 *
 * 手写正则/位移解析 IPv4/IPv6 与 CIDR 网段极易漏拦：IPv4-mapped / IPv4-compatible /
 * IPv4-translated、6to4、NAT64、八进制/整数 IPv4、FQDN 末尾点等都是常见绕过面。
 * 这里统一交给 ipaddr.js 处理，ssrf.ts（Node 连接级防护）与 ssrf-workers.ts（边缘）只做接入。
 */

/** 去掉 IPv6 方括号、Zone ID（%eth0），并规范化域名（转小写 + 去除首尾点） */
export function normalizeHost(host: string): string {
  return host
    .trim()
    .replace(/^\[+|\]+$/g, '')
    .split('%')[0]
    .replace(/^\.+|\.+$/g, '')
    .toLowerCase();
}

/**
 * 额外需要拦截的特殊 CIDR（仅补充 ipaddr.range() 未覆盖或需显式兜底的过渡/文档/保留网段；
 * 常见私网、回环、链路本地、CGNAT、ULA、组播、Teredo 等已由 ipaddr.range() 自动拦截，切勿在此重复维护）。
 */
const EXTRA_BLOCKED_V4_CIDRS: Array<[ipaddr.IPv4, number]> = [
  ipaddr.parseCIDR('192.0.0.0/24') as [ipaddr.IPv4, number], // IETF 协议分配
  ipaddr.parseCIDR('192.0.2.0/24') as [ipaddr.IPv4, number], // TEST-NET-1
  ipaddr.parseCIDR('198.51.100.0/24') as [ipaddr.IPv4, number], // TEST-NET-2
  ipaddr.parseCIDR('203.0.113.0/24') as [ipaddr.IPv4, number], // TEST-NET-3
];

const EXTRA_BLOCKED_V6_CIDRS: Array<[ipaddr.IPv6, number]> = [
  ipaddr.parseCIDR('100::/64') as [ipaddr.IPv6, number], // Discard-Only
  ipaddr.parseCIDR('2001:db8::/32') as [ipaddr.IPv6, number], // Documentation
  ipaddr.parseCIDR('64:ff9b:1::/48') as [ipaddr.IPv6, number], // Local-Use NAT64
  ipaddr.parseCIDR('fec0::/10') as [ipaddr.IPv6, number], // Deprecated Site-Local
];

function isBlockedV4(v4: ipaddr.IPv4): boolean {
  const range = v4.range();
  if (range !== 'unicast') return true;
  return EXTRA_BLOCKED_V4_CIDRS.some((cidr) => v4.match(cidr));
}

function isBlockedV6(v6: ipaddr.IPv6): boolean {
  // 1. 先检查 IPv4-mapped (::ffff:0:0/96)
  if (v6.isIPv4MappedAddress()) {
    return isBlockedV4(v6.toIPv4Address());
  }

  // 2. IPv4-compatible (::/96) 与 IPv4-translated (::ffff:0:0:0/96)：提取低 32 位按 IPv4 校验
  const p = v6.parts;
  const isV4Compat = p[0] === 0 && p[1] === 0 && p[2] === 0 && p[3] === 0 && p[4] === 0 && p[5] === 0;
  const isV4Translated = p[0] === 0 && p[1] === 0 && p[2] === 0 && p[3] === 0 && p[4] === 0xffff && p[5] === 0;
  if (isV4Compat || isV4Translated) {
    const embedded = new ipaddr.IPv4([
      (p[6] >> 8) & 0xff,
      p[6] & 0xff,
      (p[7] >> 8) & 0xff,
      p[7] & 0xff,
    ]);
    return isBlockedV4(embedded);
  }

  // 3. 6to4 (2002::/16)：parts[1..2] 内嵌 IPv4；NAT64 (64:ff9b::/96)：parts[6..7] 内嵌 IPv4
  if (p[0] === 0x2002) {
    const embedded = new ipaddr.IPv4([
      (p[1] >> 8) & 0xff,
      p[1] & 0xff,
      (p[2] >> 8) & 0xff,
      p[2] & 0xff,
    ]);
    return isBlockedV4(embedded);
  }
  if (p[0] === 0x0064 && p[1] === 0xff9b && p[2] === 0 && p[3] === 0 && p[4] === 0 && p[5] === 0) {
    const embedded = new ipaddr.IPv4([
      (p[6] >> 8) & 0xff,
      p[6] & 0xff,
      (p[7] >> 8) & 0xff,
      p[7] & 0xff,
    ]);
    return isBlockedV4(embedded);
  }

  // 4. 标准 IPv6 range 分类（含 loopback、uniqueLocal、linkLocal、multicast、reserved、teredo 等）
  const range = v6.range();
  if (range !== 'unicast') return true;
  return EXTRA_BLOCKED_V6_CIDRS.some((cidr) => v6.match(cidr));
}

/** 判断主机名是否属于非标准数字形式 IPv4（如 2130706433 / 0177.0.0.1 / 0x7f.1） */
function isNonStandardNumericHost(host: string): boolean {
  return (
    /^(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+))*$/i.test(host) &&
    !ipaddr.IPv4.isValidFourPartDecimal(host)
  );
}

export function isPrivateIP(ip: string): boolean {
  const v = normalizeHost(ip);
  if (!v) return true;

  // 非标准数字型 IPv4（如八进制 0177.0.0.1、单整数 2130706433）先经 WHATWG URL 归一化，无法识别则保守拒绝
  if (!v.includes(':') && isNonStandardNumericHost(v)) {
    try {
      const normalized = new URL(`http://${v}`).hostname;
      if (ipaddr.IPv4.isValidFourPartDecimal(normalized)) {
        return isBlockedV4(ipaddr.IPv4.parse(normalized));
      }
    } catch {
      /* 忽略 */
    }
    return true;
  }

  if (ipaddr.IPv4.isValidFourPartDecimal(v)) {
    return isBlockedV4(ipaddr.IPv4.parse(v));
  }

  if (ipaddr.IPv6.isValid(v)) {
    return isBlockedV6(ipaddr.IPv6.parse(v));
  }

  return false;
}

export const BLOCKED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

export function isValidProxyUrl(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const rawHost = parsed.hostname.trim().replace(/^\[+|\]+$/g, '').toLowerCase();
    // 拦截空 host、前导点（.localhost）以及末尾点规范化后命中的保留域名
    if (!rawHost || rawHost.startsWith('.')) return false;
    const host = normalizeHost(rawHost);
    if (!host || BLOCKED_HOSTNAMES.has(host)) return false;
    if (isNonStandardNumericHost(host)) return false;
    if (ipaddr.IPv4.isValidFourPartDecimal(host) || host.includes(':')) {
      if (isPrivateIP(host)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
