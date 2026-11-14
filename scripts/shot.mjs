#!/usr/bin/env node
/**
 * shot.mjs — 真机视口截图 / DOM 断言工具（开发调试用，不参与构建）
 *
 * 用本机 Chrome 起一个隔离的无头实例，通过 CDP 设置移动视口、登录、执行 JS、
 * 截图。比 Chrome 扩展/Cursor 内置浏览器更可控：真 Chrome 内核、真实登录态、
 * 固定的设备参数，适合验证夜色影视的播放页/抽屉层级和窄屏布局。
 *
 * 依赖：Node >= 22（全局 WebSocket）、本机 Chrome。
 *
 * 用法：
 *   node scripts/shot.mjs --url <页面> --out <png> [options]
 *
 * 常用：
 *   --url            要打开的页面（origin 同时用于登录）
 *   --out            截图路径（相对当前目录；省略时只跑 --log）
 *   --selector       等这个 CSS 选择器出现再继续（默认只等 --wait）
 *   --js             "..." 截图前执行的 JS（函数体，可 await，可 return）
 *   --log            "..." 执行并打印的 JS 表达式（返回 JSON）
 *   --init-js        "..." 在每个新文档加载前注入的 JS（可 mock fetch / 预置状态）
 *   --open-settings  点第一个可见的 aria-label="设置" 按钮
 *   --wait           页面就绪后的固定等待（ms，默认 1200）
 *   --wait2          --js 执行后的等待（ms，默认 0）
 *   --width/--height/--dsf  视口（默认 390×844、DPR 3；<640 自动开移动端+触摸）
 *   --full           整页截图
 *   --no-login       跳过登录（公开页面）
 *   --theme          仅模拟 prefers-color-scheme（站点是 class 主题，不一定生效）
 *   --profile        自定义 Chrome 用户目录（默认 .tmp/chrome-shot-profile）
 *   --keep           结束后不关 Chrome（调试用；下次换 --profile 或先手动关）
 *   --help           显示帮助
 *
 * 密码来源：SHOT_PASSWORD 环境变量 > 仓库根 .dev.vars 的 PASSWORD=（不打印）。
 * Chrome 路径：CHROME_PATH 环境变量 > 各平台常见安装路径。
 *
 * 示例：
 *   node scripts/shot.mjs \
 *     --url "http://localhost:8080/watch?source=env_4&url=<test.m3u8>&title=测试" \
 *     --selector ".art-video-player" --out .tmp/shots/watch.png --wait 1200
 *
 *   node scripts/shot.mjs --url "https://tv.ycxdev.com/" --out .tmp/shots/home.png
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PROFILE = path.join(ROOT, '.tmp', 'chrome-shot-profile');

const HELP = `真机视口截图 / DOM 断言（CDP + 本机 Chrome）

用法:
  node scripts/shot.mjs --url <页面> [--out <png>] [选项]

必填:
  --url <url>            页面地址；登录 origin 从它推导

输出:
  --out <file>           截图路径（相对当前目录；可省略，只跑 --log）
  --full                 整页截图（默认仅视口）
  --log <expr>           执行并打印的 JS 表达式，结果 JSON 化
  --js <body>            截图前执行的 JS 函数体（可 await / return）
  --init-js <code>       每个新文档加载前注入的 JS（可 mock fetch / 预置状态）

等待 / 交互:
  --selector <css>       轮询等待元素出现（最长 30s）
  --wait <ms>            就绪后固定等待，默认 1200
  --wait2 <ms>           --js 执行后的等待，默认 0
  --open-settings        点第一个可见的 aria-label="设置" 按钮
  --no-login             跳过登录流程

设备:
  --width <px>           默认 390
  --height <px>          默认 844
  --dsf <n>              设备像素比，默认 3
  --theme dark|light     仅模拟 prefers-color-scheme

其它:
  --profile <dir>        Chrome 用户目录，默认 .tmp/chrome-shot-profile
  --keep                 不关闭 Chrome（调试用）
  --help                 显示本帮助

环境变量:
  CHROME_PATH            Chrome 可执行文件路径
  SHOT_PASSWORD          登录密码（否则读 .dev.vars 的 PASSWORD=）
  SHOT_CDP_PORT          固定 CDP 端口（默认随机空闲端口）

示例:
  node scripts/shot.mjs --url "http://localhost:8080/" --out .tmp/shots/home.png
  node scripts/shot.mjs --url "http://localhost:8080/watch?source=env_4&url=<m3u8>&title=测试" \\
    --selector ".art-video-player" --out .tmp/shots/watch.png --open-settings

注意:
  - 截图是缩放后的图片预览；尺寸/换行/层级请用 --log + getBoundingClientRect /
    getComputedStyle / elementFromPoint 交叉验证。
  - 本地 dev 的采集站请求会被 SSRF 防护/代理 fake-IP 拦截，播放器验证建议用
    公开测试 HLS（如 https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8）走直连 url。
  - 线上验证需要登录密码与部署的 PASSWORD 一致；不打印密码。
`;

function parseArgs(argv) {
  const out = {
    width: 390,
    height: 844,
    dsf: 3,
    wait: 1200,
    wait2: 0,
    theme: 'dark',
    profile: DEFAULT_PROFILE,
  };
  const flags = new Set(['open-settings', 'full', 'keep', 'no-login', 'help']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`未知参数: ${a}`);
    const key = a.slice(2);
    if (flags.has(key)) {
      out[key] = true;
      continue;
    }
    const val = argv[i + 1];
    if (val === undefined || val.startsWith('--')) throw new Error(`--${key} 需要值`);
    out[key] = val;
    i++;
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  if (process.env.CHROME_PATH) {
    if (!fs.existsSync(process.env.CHROME_PATH)) {
      throw new Error(`CHROME_PATH 不存在: ${process.env.CHROME_PATH}`);
    }
    return process.env.CHROME_PATH;
  }
  const localAppData = process.env.LOCALAPPDATA || '';
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    localAppData && path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('找不到 Chrome，请设置 CHROME_PATH');
  return found;
}

function readPassword() {
  if (process.env.SHOT_PASSWORD) return process.env.SHOT_PASSWORD;
  const file = path.join(ROOT, '.dev.vars');
  if (!fs.existsSync(file)) return '';
  const line = fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith('PASSWORD='));
  return line ? line.slice('PASSWORD='.length).trim() : '';
}

async function freePort() {
  if (process.env.SHOT_CDP_PORT) return Number(process.env.SHOT_CDP_PORT);
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      for (const fn of this.listeners) fn(msg);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  waitEvent(method, timeout = 90000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(fn);
        reject(new Error(`等待 ${method} 超时`));
      }, timeout);
      const fn = (msg) => {
        if (msg.method !== method) return;
        clearTimeout(timer);
        this.listeners.delete(fn);
        resolve(msg.params);
      };
      this.listeners.add(fn);
    });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!args.url) throw new Error('缺少 --url（--help 看用法）');
  if (!args.out && !args.log && !args.js) throw new Error('至少需要 --out / --log / --js 之一');

  const target = new URL(args.url);
  const origin = target.origin;
  const chromePath = findChrome();
  const port = await freePort();
  fs.mkdirSync(args.profile, { recursive: true });

  const chrome = spawn(
    chromePath,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${args.profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--hide-scrollbars',
      '--mute-audio',
      '--window-size=1000,1000',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let version;
  try {
    for (let i = 0; i < 60; i++) {
      try {
        version = await getJson(`http://127.0.0.1:${port}/json/version`);
        break;
      } catch {
        await sleep(200);
      }
    }
    if (!version) throw new Error('Chrome 启动失败（CDP 端口无响应）');

    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const cdp = new CDP(ws);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params) => cdp.send(method, params, sessionId);

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    // 在页面脚本之前注入（用于 mock fetch / 预置 localStorage；对后续导航同样生效）
    if (args['init-js']) {
      await send('Page.addScriptToEvaluateOnNewDocument', { source: String(args['init-js']) });
    }

    const isMobile = Number(args.width) < 640;
    await send('Emulation.setDeviceMetricsOverride', {
      width: Number(args.width),
      height: Number(args.height),
      deviceScaleFactor: Number(args.dsf),
      mobile: isMobile,
    });
    if (isMobile) {
      await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    }

    const chromeMajor = /Chrome\/(\d+)/.exec(version.Browser || '')?.[1] || '157';
    await send('Network.setUserAgentOverride', {
      userAgent: isMobile
        ? `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Mobile Safari/537.36`
        : `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`,
      platform: isMobile ? 'Linux armv8l' : 'Win32',
    });
    await send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-color-scheme', value: args.theme === 'dark' ? 'dark' : 'light' },
        { name: 'prefers-reduced-motion', value: 'reduce' },
      ],
    });

    const evalJs = async (body) => {
      const res = await send('Runtime.evaluate', {
        expression: `(async () => { ${body} })()`,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (res.exceptionDetails) {
        const desc =
          res.exceptionDetails.exception?.description || res.exceptionDetails.text || '未知异常';
        throw new Error(`页面 JS 异常：${desc}`);
      }
      return res.result?.value;
    };

    const navigate = async (url) => {
      const loaded = cdp.waitEvent('Page.loadEventFired', 90000);
      await send('Page.navigate', { url });
      await loaded;
    };

    const waitForSelector = async (selector, timeout = 30000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const found = await evalJs(`return !!document.querySelector(${JSON.stringify(selector)});`);
        if (found) return;
        await sleep(250);
      }
      throw new Error(`等待选择器超时：${selector}`);
    };

    // 登录：有密码就走 POST /api/auth，没有就跳过（公开页面）
    const password = readPassword();
    if (!args['no-login'] && password) {
      await navigate(`${origin}/login`);
      const status = await evalJs(`
        const r = await fetch('/api/auth', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password: ${JSON.stringify(password)} }),
        });
        return r.status;
      `);
      if (status !== 200) {
        throw new Error(`登录失败（HTTP ${status}）：检查 SHOT_PASSWORD / .dev.vars 与部署密码是否一致`);
      }
    }

    await navigate(args.url);

    if (args.selector) await waitForSelector(String(args.selector));
    await sleep(Number(args.wait));

    const pathname = await evalJs('return location.pathname;');
    if (pathname === '/login' && !args['no-login']) {
      throw new Error('被重定向到 /login：没有可用密码（设置 SHOT_PASSWORD 或 .dev.vars 的 PASSWORD=）');
    }

    if (args['open-settings']) {
      const clicked = await evalJs(`
        const btn = [...document.querySelectorAll('button[aria-label="设置"]')]
          .find((b) => b.offsetParent !== null);
        if (!btn) return false;
        btn.click();
        return true;
      `);
      if (!clicked) throw new Error('页面上没有可见的「设置」按钮');
      await sleep(900);
    }

    if (args.js) {
      const result = await evalJs(String(args.js));
      if (result !== undefined) console.log('js:', JSON.stringify(result, null, 2));
    }
    if (Number(args.wait2) > 0) await sleep(Number(args.wait2));

    if (args.log) {
      const value = await evalJs(`return (${args.log});`);
      console.log('log:', JSON.stringify(value, null, 2));
    }

    if (args.out) {
      const outPath = path.resolve(process.cwd(), String(args.out));
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      const shot = await send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: Boolean(args.full),
        fromSurface: true,
      });
      fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
      console.log('saved:', outPath);
    }

    ws.close();
    if (args.keep) {
      console.log(`Chrome 保持运行：profile=${args.profile} port=${port}`);
      return;
    }
    // 给 Chrome 一点时间把 localStorage 等写盘；Browser.close 的响应可能随连接消失
    await Promise.race([cdp.send('Browser.close').catch(() => {}), sleep(1500)]);
    chrome.kill();
    await sleep(200);
    process.exit(0);
  } catch (err) {
    chrome.kill();
    throw err;
  }
}

main().catch((err) => {
  console.error('FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
