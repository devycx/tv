#!/usr/bin/env node
/**
 * 生成全部位图图标与 favicon.ico。
 *
 * 唯一矢量源（改 Logo 只需要改这两个 SVG，然后 `npm run icons`）：
 * - public/icons/icon-source.svg 深色底 + 蓝色徽标 → PWA / app icon（深色底板是刻意的：
 *   安装到桌面/移动端后深色底与站点主题一致，且 iOS 触摸图标要求不透明）
 * - public/icons/brand-mark.svg  透明徽标 → 浏览器标签页 favicon / 顶栏 / 登录页
 *
 * 浏览器标签页图标必须用「真透明」的徽标：之前把深色底的 icon-*.png 声明成页面 icon，
 * Chrome/手机浏览器标签页会显示成一个黑方块（YouTube 那种透明红徽标才是预期效果）。
 * 透明徽标按 contain 放进正方形画布，24:17 的徽标会水平铺满、上下留透明边。
 *
 * 标签页图标在 layout.tsx 里声明两条来源：
 * - 网络图标 `/favicon.ico?v=<版本>` + `favicon-32/96.png?v=<版本>`：**主路径**。部分手机端
 *   Chromium 变种不认 data URI，只认网络图标；而且浏览器图标库会长期缓存旧图，所以 URL
 *   带上内容哈希（`?v=`）——换 logo 后 URL 必变，旧的黑底条目才会被换掉。
 * - 内联 data URI：兜底，支持它的实现可以做到「解析 HTML 即可用」。实测 Chromium 在有
 *   网络图标时会优先选网络图标，别指望 data URI 能压过它。
 * 改完 logo 一定要重跑本脚本，否则 data URI / 版本号会和 PNG/ICO 不一致（有单测守着）。
 *
 * 依赖 sharp（Next 的传递依赖，已随 node_modules 安装）。
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iconDir = path.join(root, 'public', 'icons');

/** 需要导出的 app icon 尺寸（1024 直接作为源图保存） */
const APP_SIZES = [1024, 512, 192, 144, 96, 48];
const APPLE_SIZE = 180;
/** favicon.ico 内嵌的 PNG 尺寸 */
const FAVICON_SIZES = [16, 32, 48];
/** 透明 favicon PNG 尺寸（标签页用；96/192 给高分屏） */
const FAVICON_PNG_SIZES = [16, 32, 48, 96, 192];
/** 内联进 HTML 的 data URI 用哪一档（48 = 16px 标签页 @3x，base64 约 1KB） */
const INLINE_FAVICON_SIZE = 48;

/** 生成到 src/lib/favicon.generated.json，供 layout.tsx 内联 */
const GENERATED_MODULE = path.join(root, 'src', 'lib', 'favicon.generated.json');

const appSvg = await readFile(path.join(iconDir, 'icon-source.svg'));
const markSvg = await readFile(path.join(iconDir, 'brand-mark.svg'));

/** 用 1024 源图逐级缩放，保证所有尺寸来自同一份矢量渲染 */
const app1024 = await sharp(appSvg).resize(1024, 1024).png({ compressionLevel: 9 }).toBuffer();

for (const size of APP_SIZES) {
  const png =
    size === 1024
      ? app1024
      : await sharp(app1024)
          .resize(size, size, { kernel: 'lanczos3' })
          .removeAlpha()
          .png({ compressionLevel: 9 })
          .toBuffer();
  await writeFile(path.join(iconDir, `icon-${size}.png`), png);
}

await writeFile(
  path.join(iconDir, 'apple-touch-icon.png'),
  await sharp(app1024).resize(APPLE_SIZE, APPLE_SIZE, { kernel: 'lanczos3' }).removeAlpha().png({ compressionLevel: 9 }).toBuffer()
);

/**
 * 透明徽标 PNG / ICO（浏览器标签页用）：
 * - 保留 alpha 通道（不要 removeAlpha，否则又变成黑底方块）；
 * - contain 到正方形画布：徽标 24:17，水平方向铺满、上下留透明边（对齐 YouTube favicon 观感）；
 * - 同时输出 favicon-16/32/48/96/192.png，页面里按尺寸声明，16px 下也不糊。
 */
const faviconPngs = [];
/** @type {Map<number, Buffer>} */
const faviconPngBySize = new Map();
for (const size of FAVICON_PNG_SIZES) {
  const data = await sharp(markSvg)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(path.join(iconDir, `favicon-${size}.png`), data);
  faviconPngBySize.set(size, data);
  if (FAVICON_SIZES.includes(size)) faviconPngs.push({ size, data });
}

await writeFile(path.join(root, 'public', 'favicon.ico'), buildIco(faviconPngs));

/**
 * 图标版本号：对全部标签页图标字节取短哈希，写进 src/lib/favicon.generated.json。
 * layout.tsx 用它拼 `?v=`，换 logo 后图标 URL 跟着变——浏览器（尤其手机端）的图标库
 * 会长期缓存旧图，只有换 URL 才会重新拉取。2026-11-16 的「手机标签页一直是黑底」就是
 * 旧图标库条目没被换掉导致的。
 */
const icoBytes = await readFile(path.join(root, 'public', 'favicon.ico'));
const iconVersion = createHash('sha256')
  .update(Buffer.concat([...faviconPngBySize.values(), icoBytes]))
  .digest('hex')
  .slice(0, 8);

/**
 * 同时输出内联版 favicon（data URI）：支持它的实现可以做到「解析 HTML 即可用」。
 * 注意 Chromium 实测会**优先选网络图标**（哪怕 data URI 的尺寸更合适），所以 data URI
 * 只是兜底，不能当成主路径——只声明 data URI 时，不认它的浏览器会退回图标库里的旧图。
 */
const inlinePng = faviconPngBySize.get(INLINE_FAVICON_SIZE);
if (!inlinePng) throw new Error(`missing inline favicon ${INLINE_FAVICON_SIZE}px`);
await writeFile(
  GENERATED_MODULE,
  `${JSON.stringify(
    {
      version: iconVersion,
      size: INLINE_FAVICON_SIZE,
      type: 'image/png',
      bytes: inlinePng.length,
      dataUri: `data:image/png;base64,${inlinePng.toString('base64')}`,
    },
    null,
    2
  )}\n`
);

console.log(
  `icons: ${APP_SIZES.map((s) => `${s}px`).join(', ')}, apple ${APPLE_SIZE}px, ` +
    `favicon ${FAVICON_SIZES.join('/')} + transparent ${FAVICON_PNG_SIZES.join('/')}, ` +
    `inline ${INLINE_FAVICON_SIZE}px (${inlinePng.length}B)`
);

/**
 * 组装 ICO（16 字节目录项 + 直接内嵌 PNG，Vista 起浏览器均支持）。
 * @param {{ size: number, data: Buffer }[]} entries
 */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = 6 + directory.length;

  entries.forEach(({ size, data }, i) => {
    const at = i * 16;
    directory.writeUInt8(size >= 256 ? 0 : size, at); // width（0 表示 256）
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1); // height
    directory.writeUInt8(0, at + 2); // 调色板数量
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // planes
    directory.writeUInt16LE(32, at + 6); // bpp
    directory.writeUInt32LE(data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.data)]);
}
