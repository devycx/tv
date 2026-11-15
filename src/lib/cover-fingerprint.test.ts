import { describe, expect, it } from 'vitest';
import { coverFingerprint } from './cover-fingerprint';

describe('coverFingerprint', () => {
  it('同一张内容哈希封面在不同域名/目录/协议下得到同一个 key', () => {
    const a = coverFingerprint('https://hhmage.com/cover/78288c7898fdad99aee06e3b42213c7b.jpg');
    const b = coverFingerprint('http://hongniuzyimage.com/upload/2024/78288c7898fdad99aee06e3b42213c7b.webp');
    const c = coverFingerprint('//img.jisuimage.com/cover/78288C7898FDAD99AEE06E3B42213C7B.jpg');
    expect(a).toBe('hash:78288c7898fdad99aee06e3b42213c7b');
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('去掉查询串与缩略图后缀，不改变封面身份', () => {
    const plain = coverFingerprint('https://p.lztutu.com/upload/vod/20220323-1/d2926fc0cae8994bc1468f828caaacca.jpg');
    const withQuery = coverFingerprint(
      'https://p.lztutu.com/upload/vod/20220323-1/d2926fc0cae8994bc1468f828caaacca.jpg?x-oss-process=image/resize,w_300'
    );
    const thumb = coverFingerprint(
      'https://p.lztutu.com/upload/vod/20220323-1/d2926fc0cae8994bc1468f828caaacca_300x400.jpg'
    );
    expect(withQuery).toBe(plain);
    expect(thumb).toBe(plain);
  });

  it('数字 id 不做跨站合并：不同站点上的 1828115.jpg 可能是不同影片', () => {
    const a = coverFingerprint('https://a.com/upload/1828115.webp');
    const b = coverFingerprint('https://b.com/upload/1828115.webp');
    expect(a).toBe('url:a.com/upload/1828115.webp');
    expect(b).not.toBe(a);
  });

  it('同 host + 同路径的非哈希封面视为同一张（协议、www、大小写归一）', () => {
    const a = coverFingerprint('http://www.mdzypic.com/upload/vod/1828115.webp');
    const b = coverFingerprint('https://mdzypic.com/upload/vod/1828115.WEBP');
    expect(a).toBe(b);
    expect(a).toBe('url:mdzypic.com/upload/vod/1828115.webp');
  });

  it('UUID 形态的文件名去掉分隔符后按内容哈希处理', () => {
    expect(coverFingerprint('https://a.com/p/550e8400-e29b-41d4-a716-446655440000.jpg')).toBe(
      'hash:550e8400e29b41d4a716446655440000'
    );
  });

  it('空值、data URL、非法地址返回 undefined', () => {
    expect(coverFingerprint()).toBeUndefined();
    expect(coverFingerprint('   ')).toBeUndefined();
    expect(coverFingerprint('data:image/png;base64,AAAA')).toBeUndefined();
    expect(coverFingerprint('http://[::1')).toBeUndefined();
  });

  it('相对路径按 path 归一，不与绝对地址混用', () => {
    expect(coverFingerprint('/upload/vod/1/poster.jpg')).toBe('path:/upload/vod/1/poster.jpg');
  });
});
