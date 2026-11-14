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
 * 依赖 sharp（Next 的传递依赖，已随 node_modules 安装）。
 */
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
for (const size of FAVICON_PNG_SIZES) {
  const data = await sharp(markSvg)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(path.join(iconDir, `favicon-${size}.png`), data);
  if (FAVICON_SIZES.includes(size)) faviconPngs.push({ size, data });
}

await writeFile(path.join(root, 'public', 'favicon.ico'), buildIco(faviconPngs));

console.log(
  `icons: ${APP_SIZES.map((s) => `${s}px`).join(', ')}, apple ${APPLE_SIZE}px, ` +
    `favicon ${FAVICON_SIZES.join('/')} + transparent ${FAVICON_PNG_SIZES.join('/')}`
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
