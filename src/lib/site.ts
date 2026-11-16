/** 站点名称与浏览器标题的单一来源（layout / manifest / 播放页的窗口标题共用） */
export const SITE_NAME = '夜幕影视';

/** 根布局的默认标题：所有没有自己 metadata 的页面都是它 */
export const DEFAULT_DOCUMENT_TITLE = `${SITE_NAME} - 私人影视聚合`;

/** Next 的 title.template 用：「关于」→「关于 - 夜幕影视」 */
export const TITLE_TEMPLATE = `%s - ${SITE_NAME}`;

/** 播放页/直播页自己拼窗口标题用 */
export function brandTitle(title: string): string {
  return `${title} - ${SITE_NAME}`;
}
