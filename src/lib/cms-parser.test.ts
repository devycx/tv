import { describe, expect, it } from 'vitest';
import {
  extractEpisodesFromPlayUrl,
  extractM3u8FromText,
  filterAdultResults,
  filterRelevantResults,
  isAdultContent,
  isRelevant,
  normalizeTitle,
  parseDetail,
  parseDetailPageHtml,
  parseSearchList,
} from './cms-parser';

const source = { key: 'test', name: '测试源', url: 'https://api.example.com/provide/vod' };

describe('parseSearchList', () => {
  it('解析标准搜索响应并补齐源信息', () => {
    const data = {
      list: [
        { vod_id: 123, vod_name: '流浪地球', vod_pic: 'https://img/a.jpg', type_name: '科幻', vod_year: '2019', vod_remarks: 'HD' },
        { vod_id: 'abc-1', vod_name: '探<script>' },
      ],
    };
    const items = parseSearchList(data, source);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      sourceKey: 'test', sourceName: '测试源', vodId: '123', name: '流浪地球',
      typeName: '科幻', year: '2019', remarks: 'HD', sourceUrl: source.url,
    });
    expect(items[1].vodId).toBe('abc-1');
  });

  it('对缺失字段健壮', () => {
    const items = parseSearchList({ list: [{}] }, source);
    expect(items[0].vodId).toBe('');
    expect(items[0].name).toBe('');
  });

  it('按分类名给成人内容打 isAdult 标记（源未标 isAdult 时也生效）', () => {
    const items = parseSearchList(
      {
        list: [
          { vod_id: 1, vod_name: '某伦理片', type_name: '伦理片' },
          { vod_id: 2, vod_name: '流浪地球', type_name: '科幻片' },
        ],
      },
      source
    );
    expect(items[0].isAdult).toBe(true);
    expect(items[1].isAdult).toBe(false);
    // 源级标记优先
    const adultSourceItems = parseSearchList(
      { list: [{ vod_id: 3, vod_name: '普通片', type_name: '剧情片' }] },
      { ...source, isAdult: true }
    );
    expect(adultSourceItems[0].isAdult).toBe(true);
  });

  it('拒绝无效响应；list 缺失或 null 视为空结果', () => {
    expect(() => parseSearchList(null, source)).toThrow();
    expect(() => parseSearchList({ list: 'nope' }, source)).toThrow();
    // 部分源站无结果时返回 list: null（或缺失），按空结果兼容
    expect(parseSearchList({ list: null }, source)).toEqual([]);
    expect(parseSearchList({}, source)).toEqual([]);
  });
});

describe('extractEpisodesFromPlayUrl', () => {
  it('解析 源$$$源 与 集$URL#集$URL 结构', () => {
    const play = '第01集$https://cdn/a1.m3u8#第02集$https://cdn/a2.m3u8$$$备用$https://x/b.m3u8';
    expect(extractEpisodesFromPlayUrl(play)).toEqual([
      'https://cdn/a1.m3u8',
      'https://cdn/a2.m3u8',
    ]);
  });

  it('过滤无 URL 或非 http 的集', () => {
    const play = '第01集$#第02集$ftp://x#第03集$https://cdn/a3.m3u8';
    expect(extractEpisodesFromPlayUrl(play)).toEqual(['https://cdn/a3.m3u8']);
  });

  it('第一条线路为中转页时优先取 m3u8 线路（量子/非凡类源）', () => {
    const play =
      'HD中字$https://vip.lzcdn2.com/share/abc$$$HD中字$https://vip.lzcdn2.com/20220329/1012_e9be6a92/index.m3u8';
    expect(extractEpisodesFromPlayUrl(play)).toEqual([
      'https://vip.lzcdn2.com/20220329/1012_e9be6a92/index.m3u8',
    ]);
  });

  it('第一条线路为空时取后续有效线路', () => {
    const play = '第1集$$$第1集$https://cdn/b.m3u8';
    expect(extractEpisodesFromPlayUrl(play)).toEqual(['https://cdn/b.m3u8']);
  });

  it('两条线路均无 m3u8 时回退第一条', () => {
    const play = '第1集$https://cdn/a.mp4$$$第1集$https://cdn2/a.mp4';
    expect(extractEpisodesFromPlayUrl(play)).toEqual(['https://cdn/a.mp4']);
  });

  it('空输入返回空数组', () => {
    expect(extractEpisodesFromPlayUrl('')).toEqual([]);
  });
});

describe('extractM3u8FromText', () => {
  it('从简介中提取 m3u8 链接', () => {
    const text = '正片$https://cdn.com/x/index.m3u8 更多';
    expect(extractM3u8FromText(text)).toEqual(['https://cdn.com/x/index.m3u8']);
  });
});

describe('parseDetail', () => {
  it('解析详情并提取分集', () => {
    const data = {
      list: [{
        vod_id: 1, vod_name: '三体', vod_content: '科幻剧',
        vod_play_url: '第1集$https://cdn/1.m3u8#第2集$https://cdn/2.m3u8',
      }],
    };
    const detail = parseDetail(data, source);
    expect(detail.episodes).toHaveLength(2);
    expect(detail.videoInfo.title).toBe('三体');
    expect(detail.videoInfo.sourceName).toBe('测试源');
  });

  it('play_url 为空时从简介兜底', () => {
    const data = { list: [{ vod_name: 'X', vod_content: '$https://cdn/fall.m3u8' }] };
    const detail = parseDetail(data, source);
    expect(detail.episodes).toEqual(['https://cdn/fall.m3u8']);
  });

  it('富文本简介洗成纯文本（线上 无尽资源 的真实结构）', () => {
    const data = {
      list: [{
        vod_name: '色戒【影视解说】',
        vod_content:
          '<p><span style="color: rgb(17, 17, 17); font-family: Helvetica, Arial, sans-serif; font-size: 13px;">' +
          '本是岭南大学学生的王佳芝（汤唯 饰）。</span><br/>' +
          '<span style="color: rgb(17, 17, 17);">此后王佳芝一直生活在上海。</span></p>',
        vod_play_url: '正片$https://cdn/1.m3u8',
      }],
    };
    const desc = parseDetail(data, source).videoInfo.desc;
    expect(desc).toBe('本是岭南大学学生的王佳芝（汤唯 饰）。\n\n此后王佳芝一直生活在上海。');
    expect(desc).not.toContain('<');
  });

  it('简介里的 m3u8 直链不显示给用户，但分集兜底仍从原始 HTML 提取', () => {
    const data = {
      list: [{ vod_name: 'X', vod_content: '<p>简介</p><span>$https://cdn/fall.m3u8</span>' }],
    };
    const detail = parseDetail(data, source);
    expect(detail.episodes).toEqual(['https://cdn/fall.m3u8']);
    expect(detail.videoInfo.desc).toBe('简介');
  });

  it('简介只有播放直链时 desc 为空（这种源的 content 就只是链接）', () => {
    const data = { list: [{ vod_name: 'X', vod_content: '$https://cdn/1.m3u8' }] };
    const detail = parseDetail(data, source);
    expect(detail.episodes).toEqual(['https://cdn/1.m3u8']);
    expect(detail.videoInfo.desc).toBeUndefined();
  });

  it('简介只有图片时 desc 为空（UI 不渲染空段落）', () => {
    const data = { list: [{ vod_name: 'X', vod_content: '<p><img src="https://img/a.jpg"></p>' }] };
    expect(parseDetail(data, source).videoInfo.desc).toBeUndefined();
  });

  it('空列表抛错', () => {
    expect(() => parseDetail({ list: [] }, source)).toThrow();
  });
});

describe('parseDetailPageHtml', () => {
  it('从 HTML 中提取去重后的 m3u8', () => {
    const html = `<h1>庆余年</h1>
      <div class="sketch">简介<b>内容</b></div>
      <script>player_aa={"url":"$https://cdn/ep1.m3u8"}</script>
      <script>player_bb={"url":"$https://cdn/ep2.m3u8"}</script>
      <script>player_cc={"url":"$https://cdn/ep1.m3u8"}</script>`;
    const detail = parseDetailPageHtml(html, source);
    expect(detail.episodes).toEqual(['https://cdn/ep1.m3u8', 'https://cdn/ep2.m3u8']);
    expect(detail.videoInfo.title).toBe('庆余年');
    // 行内标签不插空格：中文被标签切词时插空格反而读不通（原实现是 replace(/<[^>]+>/g, ' ')）
    expect(detail.videoInfo.desc).toBe('简介内容');
  });

  it('非凡影视特征路径兜底', () => {
    const html = '$https://vip.ffzy.com/20231101/12345_abcdef/index.m3u8';
    const detail = parseDetailPageHtml(html, source);
    expect(detail.episodes).toContain('https://vip.ffzy.com/20231101/12345_abcdef/index.m3u8');
  });
});

describe('成人内容过滤', () => {
  it('识别敏感分类', () => {
    expect(isAdultContent('伦理片')).toBe(true);
    expect(isAdultContent('福利片')).toBe(true);
    expect(isAdultContent('科幻片')).toBe(false);
    expect(isAdultContent(undefined)).toBe(false);
  });

  it('filterAdultResults 按开关过滤', () => {
    const items = [{ typeName: '伦理片' }, { typeName: '剧情片' }];
    expect(filterAdultResults(items, true)).toEqual([{ typeName: '剧情片' }]);
    expect(filterAdultResults(items, false)).toHaveLength(2);
  });

  it('标题/源标记命中成人关键词时也参与过滤', () => {
    const items = [
      { typeName: 'AI换脸', name: '[换脸]某剧' },
      { typeName: '女优明星', name: '某作品' },
      { typeName: '剧情片', name: '普通剧', isAdult: true },
      { typeName: '剧情片', name: '普通剧' },
    ];
    expect(filterAdultResults(items, true)).toEqual([{ typeName: '剧情片', name: '普通剧' }]);
  });

  it('英文短词按词边界匹配，不误杀正常片名', () => {
    const items = [
      { typeName: '动作片', name: 'Avatar' },
      { typeName: '科幻片', name: 'Avengers: Endgame' },
      { typeName: '科幻片', name: 'Gravity' },
      { typeName: '动作片', name: 'Top Gun: Maverick' },
      { typeName: '剧情片', name: '成人礼' },
      { typeName: '剧情片', name: '福利院的孩子' },
    ];
    expect(filterAdultResults(items, true)).toEqual(items);
  });

  it('独立的 AV / R18 缩写仍然判为成人内容', () => {
    expect(filterAdultResults([{ name: 'AV女优精选' }], true)).toEqual([]);
    expect(filterAdultResults([{ name: 'R18 限定' }], true)).toEqual([]);
    // 词内包含不算命中
    expect(filterAdultResults([{ name: 'Braveheart' }], true)).toHaveLength(1);
  });

  it('片名强特征词仍然参与过滤', () => {
    expect(filterAdultResults([{ name: '某剧无码流出' }], true)).toEqual([]);
    expect(filterAdultResults([{ name: '91视频合集' }], true)).toEqual([]);
  });

  it('parseSearchList 也按片名强特征打 isAdult（不只按分类名）', () => {
    const items = parseSearchList(
      {
        list: [
          { vod_id: 1, vod_name: '某剧无码流出', type_name: '剧情片' },
          { vod_id: 2, vod_name: 'Avatar', type_name: '科幻片' },
        ],
      },
      source
    );
    expect(items[0].isAdult).toBe(true);
    expect(items[1].isAdult).toBe(false);
  });
});

describe('normalizeTitle', () => {
  it('去标点、空白并转小写', () => {
    expect(normalizeTitle('摔跤吧！爸爸')).toBe('摔跤吧爸爸');
    expect(normalizeTitle('摔跤吧!爸爸 【影视解说】')).toBe('摔跤吧爸爸影视解说');
    expect(normalizeTitle('Hello, World!')).toBe('helloworld');
  });
});

describe('isRelevant', () => {
  it('命中完整关键词（忽略标点差异）', () => {
    expect(isRelevant('摔跤吧！爸爸', '摔跤吧！爸爸')).toBe(true);
    expect(isRelevant('摔跤吧!爸爸【影视解说】', '摔跤吧！爸爸')).toBe(true);
    expect(isRelevant('摔跤吧 爸爸', '摔跤吧！爸爸')).toBe(true);
  });

  it('标题不含关键词时不相关（模糊分词场景）', () => {
    expect(isRelevant('爸爸去哪儿第三季', '摔跤吧！爸爸')).toBe(false);
    expect(isRelevant('爸爸当家 第五季', '摔跤吧！爸爸')).toBe(false);
  });

  it('子串命中视为相关', () => {
    expect(isRelevant('爸爸去哪儿第三季', '爸爸去哪儿')).toBe(true);
  });

  it('多词查询放宽为每个词都命中', () => {
    expect(isRelevant('钢铁侠', '钢铁侠 2008')).toBe(false);
    expect(isRelevant('钢铁侠 Iron Man 2008', '钢铁侠 2008')).toBe(true);
  });

  it.each([
    ['赛博朋克：边缘行者第二季', '赛博朋克：边缘行者 2'],
    ['赛博朋克：边缘行者 2', '赛博朋克：边缘行者第二季'],
    ['赛博朋克：边缘行者第2季', '赛博朋克：边缘行者第二季'],
    ['示例剧 第十二季', '示例剧 12'],
    ['示例剧 第二十季', '示例剧 第20季'],
    ['赛博朋克：边缘行者第二季 花絮', '赛博朋克：边缘行者 2'],
    ['赛博朋克：边缘行者第二季【影视解说】', '赛博朋克：边缘行者 2'],
  ])('匹配明确的季数别名：%s / %s', (name, query) => {
    expect(isRelevant(name, query)).toBe(true);
  });

  it.each([
    ['赛博朋克：边缘行者第三季', '赛博朋克：边缘行者 2'],
    ['赛博朋克：边缘行者第十二季', '赛博朋克：边缘行者 2'],
    ['赛博朋克：边缘行者第20季', '赛博朋克：边缘行者 2'],
    ['赛博朋克：边缘行者第十二季 花絮', '赛博朋克：边缘行者 2'],
    ['赛博朋克：边缘行者第20季【影视解说】', '赛博朋克：边缘行者 2'],
    ['赛博朋克：边缘行者第二季', '赛博朋克：边缘行者第二季 花絮'],
    ['赛博朋克：边缘行者 20', '赛博朋克：边缘行者 2'],
    ['赛博朋克：边缘行者12', '赛博朋克：边缘行者 2'],
    ['电影2', '电影第二季'],
    ['钢铁侠 第二季', '钢铁侠 2008'],
    ['钢铁侠 12008', '钢铁侠 2008'],
    ['别的剧 第二季', '赛博朋克：边缘行者 2'],
    ['10月17日 足球联赛', '赛博朋克：边缘行者 2'],
  ])('拒绝无关标题、不同季数或数字的部分命中：%s / %s', (name, query) => {
    expect(isRelevant(name, query)).toBe(false);
  });

  it('查询侧的末尾数字可以没有空格：庆余年2 应命中第二季', () => {
    // 与「庆余年2」同构：用户很少在季数前敲空格，查询侧一律按季数理解。
    // 标题侧仍然要求空格（见上一条「电影2 / 电影第二季」），避免片名自带数字被误判。
    expect(isRelevant('庆余年第二季', '庆余年2')).toBe(true);
    expect(isRelevant('庆余年 第二季', '庆余年2')).toBe(true);
    expect(isRelevant('电影第二季', '电影2')).toBe(true);
  });

  it('空关键词不参与过滤，但空标题不能命中非空关键词', () => {
    expect(isRelevant('任意标题', '')).toBe(true);
    expect(isRelevant('', '任意')).toBe(false);
    expect(isRelevant(' ！ ', '任意')).toBe(false);
  });
});

describe('filterRelevantResults', () => {
  const wd = '摔跤吧！爸爸';
  const items = [
    { name: '摔跤吧！爸爸' },
    { name: '爸爸去哪儿第三季' },
    { name: '摔跤吧!爸爸【影视解说】' },
  ];

  it('丢弃与关键词无关的结果', () => {
    const out = filterRelevantResults(items, wd);
    expect(out).toHaveLength(2);
    expect(out.map((i) => i.name)).toEqual(['摔跤吧！爸爸', '摔跤吧!爸爸【影视解说】']);
  });

  it('全部不相关时返回空列表，不能把源站的默认目录当成搜索结果', () => {
    const junk = [{ name: '爸爸当家' }, { name: '爸爸别走' }];
    expect(filterRelevantResults(junk, wd)).toEqual([]);
  });

  it('过滤缺失标题，同时保留匹配的第二季而不保留无关体育目录', () => {
    const relevant = { name: '赛博朋克：边缘行者第二季' };
    expect(filterRelevantResults([
      { name: '10月17日 足球联赛' }, {}, { name: '' }, relevant,
    ], '赛博朋克：边缘行者 2')).toEqual([relevant]);
  });
});
