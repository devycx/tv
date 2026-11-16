/**
 * 标签页图标透明性 + 「内联 favicon 与 PNG/ICO 一致」的回归测试。
 *
 * 背景（两次线上事故都出在这里）：
 * 1. 早先把深色底（#0B101A）的 icon-*.png 声明成页面 icon，标签页变成黑底方块；
 * 2. 改成透明 PNG 后，手机浏览器**首次访问**仍会先画深色占位方块——favicon 要走一次
 *    网络请求，图标回来之前标签页没有可画的图标。于是把 48px 透明徽标内联成 data URI
 *    （src/lib/favicon.generated.json），图标随 HTML 一起到达。
 *
 * 因此这里守住三条不变量：
 * - 内联的 data URI 是 48px RGBA，且像素与 public/icons/favicon-48.png 完全一致
 *   （改 logo 忘了跑 `npm run icons` 会在这里红）；
 * - favicon.ico 里每个条目都是 32bpp 的内嵌 PNG，且与对应尺寸的 favicon-*.png 一致；
 * - 所有标签页图标四角透明、没有不透明的近黑像素（黑底回归会在这里红）。
 *
 * sharp 是 Next 的传递依赖（`npm run icons` 也用它）：拿不到就只做结构断言（PNG 头 /
 * ICO 目录 / 与文件一致），像素级断言跳过，避免本地缺依赖时误报。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import generated from './favicon.generated.json';

const publicDir = new URL('../../public/', import.meta.url);
const iconsDir = new URL('icons/', publicDir);

function readPublic(path: string): Buffer {
  return readFileSync(fileURLToPath(path === 'favicon.ico' ? new URL(path, publicDir) : new URL(path, iconsDir)));
}

function isPng(buf: Buffer): boolean {
  return buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

/** PNG 头里的宽度/高度/位深/颜色类型；颜色类型 6 = RGBA（有 alpha 通道） */
function pngHeader(buf: Buffer) {
  expect(isPng(buf)).toBe(true);
  expect(buf.subarray(12, 16).toString('latin1')).toBe('IHDR');
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf.readUInt8(24),
    colorType: buf.readUInt8(25),
  };
}

const sharp = await import('sharp')
  .then((mod) => mod.default)
  .catch(() => null);

type Rgba = { width: number; height: number; data: Buffer };

async function decodePng(buf: Buffer): Promise<Rgba> {
  const { data, info } = await sharp!(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

/** 四个角 + 全部像素统计：不透明近黑像素必须为 0，角必须全透明 */
async function expectTransparentBackground(buf: Buffer) {
  const img = await decodePng(buf);
  const at = (x: number, y: number) => {
    const i = (y * img.width + x) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
  };
  for (const [x, y] of [
    [0, 0],
    [img.width - 1, 0],
    [0, img.height - 1],
    [img.width - 1, img.height - 1],
  ]) {
    expect(at(x, y)[3], `corner ${x},${y} alpha`).toBe(0);
  }

  let opaqueNearBlack = 0;
  let opaque = 0;
  for (let p = 0; p < img.width * img.height; p += 1) {
    const i = p * 4;
    const [r, g, b, a] = [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
    if (a === 255) opaque += 1;
    if (a > 200 && r < 20 && g < 20 && b < 20) opaqueNearBlack += 1;
  }
  expect(opaqueNearBlack, '不透明近黑像素（黑底会出现在这里）').toBe(0);
  expect(opaque, '徽标应该有实心像素').toBeGreaterThan(0);
}

/** 解析 ICO 目录，返回每个条目的 { size, bpp, payload } */
function parseIco(buf: Buffer) {
  expect(buf.readUInt16LE(0)).toBe(0); // reserved
  expect(buf.readUInt16LE(2)).toBe(1); // type: icon
  const count = buf.readUInt16LE(4);
  const entries = [] as { size: number; bpp: number; payload: Buffer }[];
  for (let i = 0; i < count; i += 1) {
    const at = 6 + i * 16;
    const size = buf.readUInt8(at) || 256;
    const bpp = buf.readUInt16LE(at + 6);
    const length = buf.readUInt32LE(at + 8);
    const offset = buf.readUInt32LE(at + 12);
    entries.push({ size, bpp, payload: buf.subarray(offset, offset + length) });
  }
  return entries;
}

const INLINE_SIZE = generated.size as number;

describe('内联 favicon（data URI）', () => {
  it('是 48px RGBA 的 PNG，与 public/icons/favicon-48.png 完全一致', () => {
    expect(generated.type).toBe('image/png');
    expect(generated.dataUri.startsWith('data:image/png;base64,')).toBe(true);

    const inline = Buffer.from(generated.dataUri.slice('data:image/png;base64,'.length), 'base64');
    expect(inline.length).toBe(generated.bytes);

    const header = pngHeader(inline);
    expect(header.width).toBe(INLINE_SIZE);
    expect(header.height).toBe(INLINE_SIZE);
    expect(header.bitDepth).toBe(8);
    expect(header.colorType).toBe(6); // RGBA：丢掉 alpha 就是又变回黑底方块

    expect(inline.equals(readPublic(`favicon-${INLINE_SIZE}.png`))).toBe(true);
  });

  it.skipIf(!sharp)('四角透明，且没有不透明近黑像素', async () => {
    await expectTransparentBackground(
      Buffer.from(generated.dataUri.slice('data:image/png;base64,'.length), 'base64')
    );
  });
});

describe.each([16, 32, 48, 96, 192])('透明 favicon PNG %ipx', (size) => {
  it('带 alpha 通道（不是深色底）', () => {
    const header = pngHeader(readPublic(`favicon-${size}.png`));
    expect(header.width).toBe(size);
    expect(header.height).toBe(size);
    expect(header.colorType).toBe(6);
  });

  it.skipIf(!sharp)('四角透明，且没有不透明近黑像素', async () => {
    await expectTransparentBackground(readPublic(`favicon-${size}.png`));
  });
});

describe('public/favicon.ico（隐式兜底）', () => {
  it('目录里是 16/32/48 的 32bpp 内嵌 PNG，与同名 PNG 一致', () => {
    const entries = parseIco(readPublic('favicon.ico'));
    expect(entries.map((e) => e.size)).toEqual([16, 32, 48]);
    for (const entry of entries) {
      expect(entry.bpp).toBe(32);
      expect(isPng(entry.payload)).toBe(true);
      expect(entry.payload.equals(readPublic(`favicon-${entry.size}.png`))).toBe(true);
    }
  });

  it.skipIf(!sharp)('每个条目四角透明', async () => {
    for (const entry of parseIco(readPublic('favicon.ico'))) {
      await expectTransparentBackground(entry.payload);
    }
  });
});
