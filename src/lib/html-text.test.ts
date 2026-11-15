import { describe, expect, it } from 'vitest';
import { decodeHtmlEntities, stripHtmlToText } from './html-text';

/** 线上真实样本（无尽资源 70699 色戒【影视解说】），四个 span 各带一整套内联样式 */
const WUJIN_CONTENT =
  '<p><span style="color: rgb(17, 17, 17); font-family: Helvetica, Arial, sans-serif; font-size: 13px; text-wrap: wrap; background-color: rgb(255, 255, 255);">' +
  '本是岭南大学学生的王佳芝（汤唯 饰）因战争辗转到了香港读书，她在香港大学加入了爱国青年邝裕民组织的话剧组。</span><br/>' +
  '<span style="color: rgb(17, 17, 17); font-family: Helvetica, Arial, sans-serif; font-size: 13px;">' +
  '　　此后王佳芝一直生活在上海，没想到重遇了邝裕民。</span><br/>' +
  '<span style="color: rgb(17, 17, 17);">' +
  '　　重逢后的二人关系进一步发展，王佳芝做出了惊人的决定</span></p>';

describe('stripHtmlToText', () => {
  it('真实样本：内联样式不会漏到正文里，段落保留', () => {
    const text = stripHtmlToText(WUJIN_CONTENT);
    expect(text).not.toContain('<');
    expect(text).not.toContain('font-family');
    expect(text.startsWith('本是岭南大学学生的王佳芝')).toBe(true);
    expect(text).toContain('此后王佳芝一直生活在上海');
    // 段与段之间留一个空行：展开后还能看出分段
    expect(text.split('\n\n')).toHaveLength(3);
    // 全角空格缩进不该留到行首
    expect(text).not.toMatch(/^\u3000/);
  });

  it('简单 p 包裹（多数源）：去掉标签即可', () => {
    expect(stripHtmlToText('<p>故事描述貌美聪慧的农庄少女琶玛。</p>')).toBe('故事描述貌美聪慧的农庄少女琶玛。');
  });

  it('行内标签不插空格：中文不能被标签切出空格', () => {
    expect(stripHtmlToText('<p>简介<b>内容</b></p>')).toBe('简介内容');
    expect(stripHtmlToText('她<span style="color: red">很</span>美')).toBe('她很美');
  });

  it('br / 块级标签都按段落边界处理', () => {
    expect(stripHtmlToText('甲<br/>乙<br>丙')).toBe('甲\n\n乙\n\n丙');
    expect(stripHtmlToText('<p>第一段</p><p>第二段</p>')).toBe('第一段\n\n第二段');
    expect(stripHtmlToText('<div>第一段</div><div>第二段</div>')).toBe('第一段\n\n第二段');
  });

  it('解码实体（命名 + 十进制 + 十六进制）', () => {
    expect(stripHtmlToText('A&nbsp;&amp;&nbsp;B')).toBe('A & B');
    expect(stripHtmlToText('&quot;引号&quot; &#39;撇号&#39; &#x4e2d;&#x6587;')).toBe('"引号" \'撇号\' 中文');
    // 解一层即可：二次转义的内容显示成文本，不递归成标记
    expect(stripHtmlToText('&lt;p&gt;不是标签&lt;/p&gt;')).toBe('<p>不是标签</p>');
  });

  it('未命中的实体保持原样，不猜', () => {
    expect(stripHtmlToText('&foo; &bogus123;')).toBe('&foo; &bogus123;');
    expect(decodeHtmlEntities('&#x110000;')).toBe('&#x110000;');
  });

  it('script / style / 注释连同内容一起丢弃', () => {
    const html = '<p>正文</p><script>alert(1)</script><style>p{color:red}</style><!-- 备注 --><noscript>无脚本</noscript>';
    expect(stripHtmlToText(html)).toBe('正文');
  });

  it('空内容 / 纯标签 / 纯图片返回空串（调用方据此不渲染）', () => {
    expect(stripHtmlToText('')).toBe('');
    expect(stripHtmlToText(undefined)).toBe('');
    expect(stripHtmlToText(null)).toBe('');
    expect(stripHtmlToText('<div><span></span></div>')).toBe('');
    expect(stripHtmlToText('<p><img src="https://x/a.jpg"></p>')).toBe('');
    expect(stripHtmlToText('   \n\t  ')).toBe('');
  });

  it('压缩空白但保留段落', () => {
    expect(stripHtmlToText('<p>第一段</p><p></p><p>第二段</p>')).toBe('第一段\n\n第二段');
    expect(stripHtmlToText('多   个    空格')).toBe('多 个 空格');
  });

  it('超长内容截断并加省略号', () => {
    const long = '字'.repeat(3000);
    const text = stripHtmlToText(`<p>${long}</p>`);
    expect(text.length).toBe(2001);
    expect(text.endsWith('…')).toBe(true);

    // 自定义上限
    expect(stripHtmlToText('<p>一二三四五</p>', 3)).toBe('一二三…');
  });
});
