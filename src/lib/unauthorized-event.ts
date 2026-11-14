/**
 * 全局未授权事件名。
 *
 * client-api.ts 会 import live-playlist.ts（直连直播列表），若 live-playlist 反向从
 * client-api 取常量就会形成循环依赖；因此把这个零依赖常量单独放一个模块，两边共用。
 */
export const UNAUTHORIZED_EVENT = 'libretv:unauthorized';
