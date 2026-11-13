import { describe, expect, it } from 'vitest';
import { safeNextPath } from './safe-next';

/** 登录回跳参数必须只能落到站内相对路径（防开放重定向、防 /login 自循环） */
describe('safeNextPath', () => {
  it('接受站内相对路径（带 query）', () => {
    expect(safeNextPath('/')).toBe('/');
    expect(safeNextPath('/live')).toBe('/live');
    expect(safeNextPath('/watch?id=123&title=x')).toBe('/watch?id=123&title=x');
    expect(safeNextPath('/?s=流浪地球')).toBe('/?s=流浪地球');
  });

  it('拒绝绝对 URL 与协议相对 URL', () => {
    expect(safeNextPath('https://evil.com')).toBe('/');
    expect(safeNextPath('http://evil.com/path')).toBe('/');
    expect(safeNextPath('//evil.com')).toBe('/');
    expect(safeNextPath('/\\evil.com')).toBe('/');
    expect(safeNextPath('/foo\\bar')).toBe('/');
    expect(safeNextPath('/foo\nbar')).toBe('/');
    expect(safeNextPath('javascript:alert(1)')).toBe('/');
    expect(safeNextPath('evil.com')).toBe('/');
    expect(safeNextPath(null)).toBe('/');
    expect(safeNextPath('')).toBe('/');
  });

  it('拒绝回跳到 /login 本身（避免 302 循环）与 API', () => {
    expect(safeNextPath('/login')).toBe('/');
    expect(safeNextPath('/login?next=%2Flive')).toBe('/');
    expect(safeNextPath('/login#x')).toBe('/');
    expect(safeNextPath('/api')).toBe('/');
    expect(safeNextPath('/api/status')).toBe('/');
    expect(safeNextPath('/api?url=x')).toBe('/');
  });
});
