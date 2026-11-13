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

/**
 * 点播源（2026-11-14 全量合并）：35 个源，其中 35 个 search+detail 通过
 * （本次线上复验 20 个 + 原有保留 15 个）、2 个画质可测（height）。
 *
 * 排序（可用性优先）：
 * 1. 画质实测有 height：电影天堂 1080、飘零资源 720；
 * 2. search+detail 通过：原有 13 个保留在前（沿用既有结论，本次未复测），
 *    本次线上复验的 20 个按 search+detail 耗时升序排在后面；
 * 3. 仅搜索可用（详情/画质不通）：本次无（详情不通的源已剔除）。
 *
 * 候选全集 = tested.json ∪ tested2.json ∪ near-miss.json ∪ recommended.json ∪ 原有 15 个，
 * 按规范化 URL 去重（忽略协议与主机大小写、去尾斜杠），同一源的多协议变体只保留复验通过的那个，
 * 名称取第一次出现。成人内容不再过滤：isAdult 一律 false，结果层过滤仍由站内「黄色过滤」设置控制。
 *
 * 线上复验（新纳入的源）：POST /api/search（庆余年，无结果再试 流浪地球，filterAdult=false）
 * + GET /api/detail，episodes 非空才算通过；仅成人目录的 森林 / jkun 用第三关键词 狂飙 复验通过。
 * 注：非同源的两个「非凡」（ffzy.tv / cj.ffzyapi.com）名称相同，按原始配置名保留，靠 URL 区分。
 * 验证时间：2026-11-14。
 */
const sources = [
  { name: '电影天堂', url: 'http://caiji.dyttzyapi.com/api.php/provide/vod', isAdult: false },
  { name: '飘零资源', url: 'https://p2100.net/api.php/provide/vod', isAdult: false },
  { name: '无尽资源', url: 'https://api.wujinapi.me/api.php/provide/vod', isAdult: false },
  { name: '极速资源', url: 'https://jszyapi.com/api.php/provide/vod', isAdult: false },
  { name: '爱坤资源', url: 'https://ikunzyapi.com/api.php/provide/vod', isAdult: false },
  { name: '暴风资源', url: 'https://bfzyapi.com/api.php/provide/vod', isAdult: false },
  { name: '优酷资源', url: 'https://api.ukuapi88.com/api.php/provide/vod', isAdult: false },
  { name: '新狼资源', url: 'https://api.xinlangapi.com/xinlangapi.php/provide/vod', isAdult: false },
  { name: '豪华资源', url: 'https://hhzyapi.com/api.php/provide/vod', isAdult: false },
  { name: '魔都资源', url: 'https://www.mdzyapi.com/api.php/provide/vod', isAdult: false },
  { name: '百度资源', url: 'https://api.apibdzy.com/api.php/provide/vod', isAdult: false },
  { name: '艾旦影视', url: 'https://lovedan.net/api.php/provide/vod', isAdult: false },
  { name: '速播资源', url: 'https://subocj.com/api.php/provide/vod', isAdult: false },
  { name: '速博资源', url: 'https://subocaiji.com/api.php/provide/vod', isAdult: false },
  { name: '茅台资源', url: 'https://caiji.maotaizy.cc/api.php/provide/vod', isAdult: false },
  { name: '废柴', url: 'http://fhapi9.com/api.php/provide/vod', isAdult: false },
  { name: '155', url: 'https://155api.com/api.php/provide/vod', isAdult: false },
  { name: '┃量子┃资源', url: 'https://lzizy1.com/api.php/provide/vod', isAdult: false },
  { name: '暴风影音', url: 'https://app.bfzyapi.com/api.php/provide/vod', isAdult: false },
  { name: '大地', url: 'https://dadiapi.com/api.php/provide/vod', isAdult: false },
  { name: '乐播', url: 'https://lbapi9.com/api.php/provide/vod', isAdult: false },
  { name: '尤酷', url: 'https://api.ukuapi.com/api.php/provide/vod', isAdult: false },
  { name: '┃非凡┃资源', url: 'http://ffzy1.tv/api.php/provide/vod', isAdult: false },
  { name: '非凡', url: 'http://ffzy.tv/api.php/provide/vod', isAdult: false },
  { name: '红牛资源', url: 'http://www.hongniuzy2.com/api.php/provide/vod', isAdult: false },
  { name: '量子', url: 'http://cj.lziapi.com/api.php/provide/vod', isAdult: false },
  { name: '非凡', url: 'http://cj.ffzyapi.com/api.php/provide/vod', isAdult: false },
  { name: '森林', url: 'https://slapibf.com/api.php/provide/vod', isAdult: false },
  { name: '滴滴', url: 'https://api.ddapi.cc/api.php/provide/vod', isAdult: false },
  { name: '精品下', url: 'http://www.jingpinx.com/api.php/provide/vod', isAdult: false },
  { name: '文才资源', url: 'http://api.zeqaht.com/api.php/provide/vod', isAdult: false },
  { name: 'jkun', url: 'https://jkunzyapi.com/api.php/provide/vod', isAdult: false },
  { name: '辣椒', url: 'http://api.11bat.com/api.php/provide/vod', isAdult: false },
  { name: '魔法', url: 'http://madouse.la/api.php/provide/vod', isAdult: false },
  { name: '玉兔资源', url: 'https://apiyutu.com/api.php/provide/vod', isAdult: false },
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
    // Workers 免费版单次 invocation 只有 50 个 subrequest：
    // 35 个源 × 多页 + 重试会超限（实测报 "Too many subrequests"）。
    // 每个源只抓第一页、关闭重试，把最坏情况压到「源数量 + 少量重定向」。
    SEARCH_MAX_PAGES: '1',
    MAX_RETRIES: '0',
  },
};

fs.writeFileSync('wrangler.jsonc', `${JSON.stringify(config, null, 2)}\n`, 'utf8');
console.log(`wrangler.jsonc written: ${sources.length} VOD sources, ${liveSources.length} live sources`);
