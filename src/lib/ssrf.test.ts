import { describe, expect, it } from 'vitest';
import http from 'node:http';
import dns from 'node:dns/promises';
import * as ipaddr from 'ipaddr.js';
import { isPrivateIP, isValidProxyUrl, runWithSSRFProtection } from './ssrf';

describe('isPrivateIP', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['192.168.1.1', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['169.254.169.254', true],
    ['100.64.0.1', true],
    ['::1', true],
    ['fe80::1', true],
    ['fd00::1', true],
    ['8.8.8.8', false],
    ['1.2.3.4', false],
    // URL.hostname 对 IPv6 会带方括号
    ['[::1]', true],
    ['[fe80::1]', true],
    ['[fd00::1]', true],
    ['[fc00::1]', true],
    // IPv4-mapped IPv6：十六进制形式与点分形式
    ['[::ffff:c0a8:164]', true], // ::ffff:192.168.1.100
    ['::ffff:192.168.1.100', true],
    ['[::ffff:7f00:1]', true], // ::ffff:127.0.0.1
    ['::ffff:127.0.0.1', true],
    ['[::ffff:a9fe:a9fe]', true], // ::ffff:169.254.169.254
    ['[::ffff:a00:1]', true], // ::ffff:10.0.0.1
    ['[::ffff:808:808]', false], // ::ffff:8.8.8.8 公网
    ['::ffff:8.8.8.8', false],
    ['[::ffff:c0a8:164', true], // 单边括号（异常输入）仍要拦
    ['[2606:4700::1111]', false], // 公网 IPv6 不应被误杀
  ])('%s → %s', (ip, expected) => {
    expect(isPrivateIP(ip)).toBe(expected);
  });

  // 手写前缀/正则时代的绕过回归用例（ipaddr.js 重构后必须全部继续拦截）
  it.each([
    ['0.1.2.3', true],
    ['100.65.0.1', true],
    ['100.127.255.254', true],
    ['198.18.0.1', true],
    ['192.0.2.1', true], // TEST-NET-1
    ['198.51.100.1', true], // TEST-NET-2
    ['203.0.113.1', true], // TEST-NET-3
    ['224.0.0.1', true],
    ['0000:0000:0000:0000:0000:0000:0000:0001', true],
    ['fe80:0:0:0::1', true],
    ['[fe80::1%eth0]', true],
    ['2002:7f00:0001::', true], // 6to4 -> 127.0.0.1
    ['64:ff9b::127.0.0.1', true], // NAT64 -> 127.0.0.1
    ['64:ff9b:1::1', true], // Local-Use NAT64
    ['::ffff:0:127.0.0.1', true], // IPv4-translated
    ['2001:db8::1', true], // Documentation
    ['100::1', true], // Discard-Only
    ['0177.0.0.1', true],
    ['2130706433', true],
  ])('扩展私有/保留/隧道地址拦截: %s → %s', (ip, expected) => {
    expect(isPrivateIP(ip)).toBe(expected);
  });
});

describe('isValidProxyUrl', () => {
  it('放行公网 http(s)', () => {
    expect(isValidProxyUrl('https://cdn.example.com/a.m3u8')).toBe(true);
    expect(isValidProxyUrl('http://1.2.3.4/x.ts')).toBe(true);
  });

  it('拦截内网与保留地址', () => {
    expect(isValidProxyUrl('http://localhost/x')).toBe(false);
    expect(isValidProxyUrl('http://127.0.0.1/x')).toBe(false);
    expect(isValidProxyUrl('http://192.168.1.1/x')).toBe(false);
    expect(isValidProxyUrl('http://169.254.169.254/latest/meta-data')).toBe(false);
  });

  it('拦截带方括号的 IPv6 与 IPv4-mapped 写法', () => {
    expect(isValidProxyUrl('http://[::1]:8080/x')).toBe(false);
    expect(isValidProxyUrl('http://[::ffff:192.168.1.100]:8080/list.m3u')).toBe(false);
    expect(isValidProxyUrl('http://[::ffff:127.0.0.1]/x')).toBe(false);
    expect(isValidProxyUrl('http://[fe80::1]/x')).toBe(false);
    expect(isValidProxyUrl('http://[fd00::1]/x')).toBe(false);
  });

  it('不误杀公网 IPv6', () => {
    expect(isValidProxyUrl('http://[2606:4700::1111]/x')).toBe(true);
  });

  it('拦截非 http 协议', () => {
    expect(isValidProxyUrl('file:///etc/passwd')).toBe(false);
    expect(isValidProxyUrl('ftp://x.com/a')).toBe(false);
    expect(isValidProxyUrl('not a url')).toBe(false);
  });

  it('拦截 FQDN 末尾点、前导点、空 host 与非标准 IPv4 绕过', () => {
    expect(isValidProxyUrl('http://localhost./x')).toBe(false);
    expect(isValidProxyUrl('http://LOCALHOST./x')).toBe(false);
    expect(isValidProxyUrl('http://.localhost/x')).toBe(false);
    // WHATWG URL 对特殊协议会跳过额外斜杠：'http:///x' 会被归一化成 host "x"，
    // 不存在可拦截的“空 host”；空 host 只能体现为无法解析的 URL（如 'http://'）。
    expect(isValidProxyUrl('http://')).toBe(false);
    expect(isValidProxyUrl('http://./x')).toBe(false);
    expect(isValidProxyUrl('http://0177.0.0.1/x')).toBe(false);
    expect(isValidProxyUrl('http://2130706433/x')).toBe(false);
    expect(isValidProxyUrl('http://[2002:7f00:0001::]/x')).toBe(false);
    expect(isValidProxyUrl('http://[64:ff9b::169.254.169.254]/x')).toBe(false);
  });
});

describe('ipaddr.js 语义锁定', () => {
  it('IPv4.isValidFourPartDecimal 拒绝八进制与前导零写法', () => {
    expect(ipaddr.IPv4.isValidFourPartDecimal('0177.0.0.1')).toBe(false);
    expect(ipaddr.IPv4.isValidFourPartDecimal('127.0.0.01')).toBe(false);
    expect(ipaddr.IPv4.isValidFourPartDecimal('127.0.0.1')).toBe(true);
  });
});


describe('DNS Rebinding & Connection SSRF Protection (#941)', () => {
  it(
    'a request to a public origin inside the protected scope must succeed',
    async (ctx) => {
      // 部分开发环境（Clash/Surge 的 fake-IP 等）会把 example.com 解析进 198.18.0.0/15 等保留网段，
      // 严格 SSRF 校验会（正确地）拦截，此时本机没有“公网解析”可测，按环境限制跳过；
      // 只有真实公网解析下被 ERR_SSRF_BLOCKED 拦掉才算回归（见下方 catch）。
      try {
        const addresses = await dns.lookup('example.com', { all: true });
        if (addresses.some((a) => isPrivateIP(a.address))) {
          ctx.skip();
          return;
        }
      } catch {
        ctx.skip();
        return;
      }
      let res: Response;
      try {
        res = await runWithSSRFProtection({ allowPrivate: false }, async () => {
          return await fetch('https://example.com', {
            signal: AbortSignal.timeout(10000),
          });
        });
      } catch (err) {
        // 只有「被 SSRF 拦下来」才算失败——那正是这条用例存在的意义（上一版把
        // dns.promises.lookup 按回调签名调用，受保护域内所有请求都挂到超时，
        // 而其余用例只断言 rejects.toThrow，全绿却抓不到）。
        const code = (err as { cause?: { code?: string } })?.cause?.code;
        if (code === 'ERR_SSRF_BLOCKED') throw err;
        // 其余（DNS 失败 / 无出口 / 代理不可用）跳过：docker-publish 会在镜像构建里
        // 跑 npm test，硬依赖外网会让发版在受限网络下随机变红。
        ctx.skip();
        return;
      }
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text.length).toBeGreaterThan(0);
    },
    30000
  );

  it('在受保护上下文中拦截解析到私网 IP 的域名（防 DNS Rebinding）', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('internal secret data');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address(); if (!addr || typeof addr === 'string') throw new Error('意外的地址'); const port = addr.port;

    try {
      await expect(
        runWithSSRFProtection({ allowPrivate: false }, async () => {
          await fetch(`http://localhost:${port}/secret`);
        })
      ).rejects.toThrow();
    } finally {
      server.close();
    }
  });

  it('在受保护上下文中拦截直接连接的字面量私网 IP', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('internal secret data');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address(); if (!addr || typeof addr === 'string') throw new Error('意外的地址'); const port = addr.port;

    try {
      await expect(
        runWithSSRFProtection({ allowPrivate: false }, async () => {
          await fetch(`http://127.0.0.1:${port}/secret`);
        })
      ).rejects.toThrow();
    } finally {
      server.close();
    }
  });

  it('显式 allowPrivate: true 时放行内网（用于自建 IPTV 场景）', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('iptv stream data');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address(); if (!addr || typeof addr === 'string') throw new Error('意外的地址'); const port = addr.port;

    try {
      const text = await runWithSSRFProtection({ allowPrivate: true }, async () => {
        const res = await fetch(`http://127.0.0.1:${port}/live.m3u8`);
        return await res.text();
      });
      expect(text).toBe('iptv stream data');
    } finally {
      server.close();
    }
  });

  it('同一域名多次请求不会因连接池复用绕过连接层校验', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('pool test data');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address(); if (!addr || typeof addr === 'string') throw new Error('意外的地址'); const port = addr.port;

    try {
      // 1. 先在 allowPrivate: true 作用域内请求该端口建立连接
      const text = await runWithSSRFProtection({ allowPrivate: true }, async () => {
        const res = await fetch(`http://127.0.0.1:${port}/first`);
        return await res.text();
      });
      expect(text).toBe('pool test data');

      // 2. 随后在 strict 作用域（allowPrivate: false）请求同一源，必须重新拦截，不得复用已有 socket
      await expect(
        runWithSSRFProtection({ allowPrivate: false }, async () => {
          await fetch(`http://127.0.0.1:${port}/second`);
        })
      ).rejects.toThrow();
    } finally {
      server.close();
    }
  });

  it('在非受保护上下文中不干扰正常本地网络通信', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('normal local communication');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address(); if (!addr || typeof addr === 'string') throw new Error('意外的地址'); const port = addr.port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/status`);
      expect(await res.text()).toBe('normal local communication');
    } finally {
      server.close();
    }
  });
});
