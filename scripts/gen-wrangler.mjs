import fs from 'node:fs';

/**
 * 生成 wrangler.jsonc（一次性脚本，运行：node scripts/gen-wrangler.mjs）
 *
 * 把点播源 / 直播源写进 Worker 的 vars：
 * - DEFAULT_SOURCES：部署者预置点播源，登录后自动勾选，开箱即搜
 * - DEFAULT_LIVE_SOURCES：部署者预置直播源，/live 页直接可看
 *
 * 修改源列表后重跑本脚本 + `npx wrangler deploy` 即可。
 */

const sources = [
  { name: '暴风资源', url: 'https://bfzyapi.com/api.php/provide/vod' },
  { name: '无尽资源', url: 'https://api.wujinapi.me/api.php/provide/vod' },
  { name: '优酷资源', url: 'https://api.ukuapi88.com/api.php/provide/vod' },
  { name: '极速资源', url: 'https://jszyapi.com/api.php/provide/vod' },
  { name: '新狼资源', url: 'https://api.xinlangapi.com/xinlangapi.php/provide/vod' },
  { name: '豪华资源', url: 'https://hhzyapi.com/api.php/provide/vod' },
  { name: '魔都资源', url: 'https://www.mdzyapi.com/api.php/provide/vod' },
  { name: '百度资源', url: 'https://api.apibdzy.com/api.php/provide/vod' },
  { name: '艾旦影视', url: 'https://lovedan.net/api.php/provide/vod' },
  { name: '爱坤资源', url: 'https://ikunzyapi.com/api.php/provide/vod' },
  { name: '速播资源', url: 'https://subocj.com/api.php/provide/vod' },
  { name: '速博资源', url: 'https://subocaiji.com/api.php/provide/vod' },
  { name: '茅台资源', url: 'https://caiji.maotaizy.cc/api.php/provide/vod' },
];

const liveSources = [
  { name: 'iptv-org 中国大陆', url: 'https://iptv-org.github.io/iptv/countries/cn.m3u' },
  { name: 'zbds IPTV4', url: 'https://live.zbds.top/tv/iptv4.m3u' },
  { name: 'aptv 综合', url: 'https://raw.githubusercontent.com/Kimentanm/aptv/master/m3u/iptv.m3u' },
  {
    name: '4K 专区',
    url: 'https://gist.githubusercontent.com/yifanwang-yet/c2c9263066c0c5d20f50ce9b31d40e7e/raw/libretv-4k.m3u',
  },
];

const config = {
  $schema: 'node_modules/wrangler/config-schema.json',
  name: 'tv',
  main: '.open-next/worker.js',
  compatibility_date: '2026-11-01',
  compatibility_flags: ['nodejs_compat'],
  assets: { directory: '.open-next/assets', binding: 'ASSETS' },
  observability: { enabled: true },
  workers_dev: true,
  preview_urls: false,
  routes: [{ pattern: 'tv.ycxdev.com', custom_domain: true }],
  vars: {
    DEFAULT_SOURCES: JSON.stringify(sources),
    DEFAULT_LIVE_SOURCES: JSON.stringify(liveSources),
  },
};

fs.writeFileSync('wrangler.jsonc', `${JSON.stringify(config, null, 2)}\n`, 'utf8');
console.log(`wrangler.jsonc written: ${sources.length} VOD sources, ${liveSources.length} live sources`);
