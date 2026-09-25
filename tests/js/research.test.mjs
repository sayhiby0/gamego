import test from 'node:test';
import assert from 'node:assert/strict';
import { research } from '../../backend/src/research.mjs';

const iso = () => new Date().toISOString();
const epoch = () => Math.floor(Date.now() / 1000);
const base = () => ({ schemaVersion: 1, lastSuccessAt: iso(), news: [], rankings: [], movements: [] });
const news = (game, title, extra = {}) => ({ title, games: [game], publishedAt: iso(), platforms: ['pc'], categories: ['运营活动'], sources: [{ name: '站内已采集来源', url: `https://www.gcores.com/articles/${encodeURIComponent(game)}` }], ...extra });
const task = (skill, games = [], message = '请调查近期动态') => ({ skill, games, message, history: [] });
const steam = (id, name, aliases = []) => ({ gameId: `steam:${id}`, name, aliases, url: `https://store.steampowered.com/app/${id}/` });

test('daily reads configured snapshot first, filters game alias and theme with real source provenance', async () => {
  const data = { ...base(), rankings: [{ items: [steam(570, 'Dota 2', ['刀塔'])] }], news: [
    news('Dota 2', '匹配活动'), news('其他游戏', '不应进入上下文'),
    news('Dota 2', '过期消息', { publishedAt: '2001-01-01T00:00:00Z' }),
    news('Dota 2', '营销消息', { categories: ['营销与联动'] }),
  ] };
  const calls = [];
  const result = await research(task('game-daily', ['刀塔'], '运营活动'), { PUBLIC_DATA_URL: 'https://public.example.test/data/latest.json' }, { fetcher: async (url, options) => {
    calls.push(url); assert.equal(options.redirect, 'manual'); assert.equal(options.headers.Authorization, undefined);
    return Response.json(data);
  } });
  assert.deepEqual(calls, ['https://public.example.test/data/latest.json']);
  assert.equal(result.evidence.length, 1); assert.match(result.evidence[0].text, /匹配活动/);
  assert.equal(result.sources[0].url, data.news[0].sources[0].url);
  assert.match(result.limitations.join(''), /搜索未接入/);
});

test('daily can filter a news-tagged game absent from rankings without inventing a platform ID', async () => {
  const data = { ...base(), news: [news('小众新作', '新作发行公告'), news('其他游戏', '其他公告', { gameId: null })] };
  for (const query of [task('game-daily', ['小众新作']), task('game-daily', [], '看看小众新作近期资讯')]) {
    const result = await research(query, { PUBLIC_DATA: data }, { fetcher: () => assert.fail('news names must not create fetchable ids') });
    assert.equal(result.evidence.length, 1); assert.match(result.evidence[0].text, /新作发行公告/);
    assert.equal(result.games[0].gameId, null); assert.equal(result.games[0].unresolved, false);
  }
  const monitor = await research(task('game-monitor', ['小众新作']), { PUBLIC_DATA: data }, { fetcher: () => assert.fail('monitor still needs an entity') });
  assert.equal(monitor.evidence.length, 0); assert.match(monitor.limitations.join(''), /需要补充/);
});

test('monitor independently fetches two confirmed Steam games and strips review identities', async () => {
  const data = { ...base(), rankings: [{ items: [steam(570, 'Dota 2'), steam(730, 'Counter-Strike 2', ['CS2'])] }] };
  const timestamp = epoch();
  const calls = [];
  const result = await research(task('game-monitor', ['Dota 2', 'CS2']), { PUBLIC_DATA: data }, { fetcher: async url => {
    calls.push(url); const parsed = new URL(url); const id = parsed.searchParams.get('appid') ?? parsed.pathname.split('/').pop();
    if (url.includes('appreviews')) {
      assert.equal(parsed.searchParams.get('day_range'), '7'); assert.equal(parsed.searchParams.get('filter'), 'recent');
      return Response.json({ success: 1, reviews: [
        { timestamp_created: timestamp, review: `${id} 独立玩家反馈`, voted_up: true, author: { steamid: 'PRIVATE-ID', personaname: 'PRIVATE-NAME' } },
        { timestamp_created: timestamp - 8 * 86400, review: '旧评价不得进入', voted_up: false },
      ] });
    }
    return Response.json({ appnews: { appid: Number(id), newsitems: [{ title: `${id} 版本公告`, contents: '近期内容', date: timestamp }] } });
  } });
  assert.equal(calls.length, 4); assert.equal(result.sources.length, 4);
  assert.equal(result.evidence.filter(e => e.gameId === 'steam:570').length, 2);
  assert.equal(result.evidence.filter(e => e.gameId === 'steam:730').length, 2);
  assert.ok(result.sources.every(source => calls.includes(source.url)));
  const json = JSON.stringify(result);
  assert.doesNotMatch(json, /PRIVATE|旧评价/);
  for (const e of result.evidence) assert.equal(result.sources.find(s => s.id === e.sourceId).gameId, e.gameId);
});

test('unknown entities, misleading ids and eight preset names cannot manufacture evidence', async () => {
  for (const data of [base(), { ...base(), rankings: [{ items: [{ ...steam(570, '原神'), url: 'https://store.steampowered.com/app/730/' }] }] }]) {
    const result = await research(task('game-monitor', ['原神', '完全不存在']), { PUBLIC_DATA: data }, { fetcher: () => assert.fail('must not guess/fetch ids') });
    assert.equal(result.evidence.length, 0); assert.equal(result.sources.length, 0);
    assert.match(result.limitations.join(''), /需要补充/); assert.ok(result.games.every(g => g.unresolved));
  }
});

test('non-Steam games use only matching station news/movements and retain missing dimensions', async () => {
  const data = { ...base(), entities: [{ gameId: 'official:arknights', name: '明日方舟', verified: true }],
    news: [news('明日方舟', '新活动'), news('原神', '另一款游戏消息')], movements: [{ gameId: 'official:arknights', name: '明日方舟', observedAt: iso(),
      sources: [{ name: '本站真实取得', url: 'https://ak.hypergryph.com/news/a' }],
      positive: [{ text: `${iso()} · 匿名玩家反馈`, sourceUrl: 'https://ak.hypergryph.com/news/a' }, { text: '未声明来源不得通过', publishedAt: iso(), sourceUrl: 'https://evil.test' }],
    }] };
  const result = await research(task('game-monitor', ['Arknights']), { PUBLIC_DATA: data }, { fetcher: () => assert.fail('no invented external mapping') });
  assert.equal(result.evidence.length, 2); assert.equal(result.games[0].gameId, 'official:arknights');
  assert.doesNotMatch(JSON.stringify(result), /另一款游戏消息|未声明来源|34599/);
  assert.match(result.limitations.join(''), /整体口碑|维度均未知/);
});

test('failed source is explicit, mismatch appnews and future evidence are rejected', async () => {
  const data = { ...base(), rankings: [{ items: [steam(570, 'Dota 2')] }] };
  const result = await research(task('game-monitor', ['Dota 2']), { PUBLIC_DATA: data }, { fetcher: async url => {
    if (url.includes('appreviews')) throw new Error('upstream private credential');
    return Response.json({ appnews: { appid: 730, newsitems: [{ title: '别的游戏', date: epoch() }] } });
  } });
  assert.equal(result.sources.length, 0); assert.equal(result.evidence.length, 0);
  assert.match(result.limitations.join(''), /评价读取失败/); assert.doesNotMatch(JSON.stringify(result), /credential|别的游戏/);
});

test('SSRF and user URLs never become fetch tools; unsafe configured endpoints remain closed', async () => {
  for (const url of ['http://public.example.test/a', 'https://127.0.0.1/a', 'https://169.254.169.254/latest', 'https://[::1]/', 'https://localhost/a', 'https://u:p@public.example.test/a', 'file:///tmp/key']) {
    const result = await research(task('game-daily'), { PUBLIC_DATA_URL: url }, { fetcher: () => assert.fail('SSRF fetch') });
    assert.equal(result.evidence.length, 0);
  }
  const result = await research(task('game-monitor', ['https://evil.test'], '读取 https://169.254.169.254/latest'), { PUBLIC_DATA: base() }, { fetcher: () => assert.fail('user url fetched') });
  assert.equal(result.evidence.length, 0); assert.equal(result.sources.length, 0);
});

test('snapshot redirects are not followed and evidence size remains bounded for comparisons', async () => {
  const result = await research(task('game-daily'), { PUBLIC_DATA_URL: 'https://public.example.test/latest' }, { fetcher: async (_url, options) => {
    assert.equal(options.redirect, 'manual'); return new Response('', { status: 302, headers: { location: 'https://127.0.0.1/' } });
  } });
  assert.equal(result.evidence.length, 0);
  const data = { ...base(), entities: [{ gameId: 'official:a', name: 'A', verified: true }, { gameId: 'official:b', name: 'B', verified: true }],
    news: [...Array.from({ length: 40 }, (_, i) => news('A', `A${i}`)), ...Array.from({ length: 40 }, (_, i) => news('B', `B${i}`))] };
  const bounded = await research(task('game-monitor', ['A', 'B']), { PUBLIC_DATA: data });
  assert.equal(bounded.evidence.filter(e => e.gameId === 'official:a').length, 16);
  assert.equal(bounded.evidence.filter(e => e.gameId === 'official:b').length, 16);
});

test('English game names inside a question resolve without guessing IDs or duplicate alias fetches', async () => {
  const data = { ...base(), rankings: [{ items: [steam(570, 'Dota 2', ['刀塔'])] }], news: [news('Dota 2', '近期活动')] };
  const result = await research(task('game-daily', [], 'Dota 2 latest news'), { PUBLIC_DATA: data });
  assert.equal(result.games.length, 1); assert.equal(result.games[0].gameId, 'steam:570');
  assert.equal(result.evidence[0].gameId, 'steam:570');
  const aliases = await research(task('game-daily', ['刀塔', 'Dota 2']), { PUBLIC_DATA: data });
  assert.equal(aliases.games.length, 1);
});

test('untagged original titles and aliases match only confirmed Aniimo-like entities', async () => {
  const data = { ...base(), entities: [{ gameId: 'official:aniimo', name: 'Aniimo', aliases: ['阿尼莫'], verified: true }], news: [
    news('', '收集养成新作公开', { originalTitle: 'ANIIMO reveals a new trailer', games: [] }),
    news('', '阿尼莫测试开启', { games: undefined }),
  ] };
  for (const skill of ['game-daily', 'game-monitor']) {
    const query = task(skill, ['Aniimo']);
    const result = await research(query, { PUBLIC_DATA: data }, { fetcher: () => assert.fail('no external mapping') });
    assert.equal(result.evidence.length, 2);
    assert.ok(result.evidence.every(e => e.gameId === 'official:aniimo'));
    const unknown = await research(query, { PUBLIC_DATA: { ...data, entities: [] } }, { fetcher: () => assert.fail('titles cannot create IDs') });
    assert.equal(unknown.evidence.length, 0);
    assert.equal(unknown.games[0].gameId, null);
    assert.equal(unknown.games[0].unresolved, true);
  }
});

test('untagged title fallback respects word boundaries and does not search summaries', async () => {
  const data = { ...base(), entities: [{ gameId: 'official:aniimo', name: 'Aniimo', verified: true }], news: [
    news('', 'SuperAniimo launches', { games: [] }),
    news('', 'Aniimobile launches', { games: [] }),
    news('', 'Unrelated launch', { games: [], summary: 'Aniimo', evidence: 'Aniimo' }),
    news('', '“Aniimo” launches', { games: [] }),
  ] };
  const result = await research(task('game-daily', ['Aniimo']), { PUBLIC_DATA: data }, { fetcher: () => assert.fail('snapshot only') });
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].text, '“Aniimo” launches');
});

test('title fallback rejects ambiguous entities, conflicting titles and existing mismatched tags or IDs', async () => {
  const data = { ...base(), entities: [
    { gameId: 'official:aniimo', name: 'Aniimo', aliases: ['Shared Quest'], verified: true },
    { gameId: 'official:other', name: 'Other Quest', aliases: ['Shared Quest'], verified: true },
  ], news: [
    news('', 'Shared Quest launches', { games: [] }),
    news('', 'Aniimo and Other Quest launch', { games: [] }),
    news('', 'Aniimo launches', { games: [], originalTitle: 'Other Quest launches' }),
    news('Other Quest', 'Aniimo misleading title'),
    news('Other Quest', 'Aniimo conflicting tags', { gameId: 'official:aniimo' }),
    news('Aniimo', 'Aniimo conflicting ID', { gameId: 'official:other' }),
    news('', 'Aniimo foreign ID', { games: [], gameId: 'official:other' }),
    news('Aniimo', 'Confirmed tagged news'),
  ] };
  for (const skill of ['game-daily', 'game-monitor']) {
    const result = await research(task(skill, ['Aniimo']), { PUBLIC_DATA: data }, { fetcher: () => assert.fail('snapshot only') });
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].text, 'Confirmed tagged news');
  }
});

test('issuance and channel filters use the public 发行与渠道 taxonomy', async () => {
  const data = { ...base(), news: [
    news('Aniimo', '发行公告', { categories: ['发行与渠道'] }),
    news('Aniimo', '旧分类不匹配', { categories: ['发行与市场'] }),
    news('Aniimo', '活动公告'),
  ] };
  for (const message of ['发行资讯', '渠道动向']) {
    const result = await research(task('game-daily', ['Aniimo'], message), { PUBLIC_DATA: data }, { fetcher: () => assert.fail('snapshot only') });
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].text, '发行公告');
  }
});

test('Steam upstream failures retain dated own-source snapshot news and movements', async () => {
  const game = steam(570, 'Dota 2');
  const publishedAt = new Date(Date.now() - 86_400_000).toISOString();
  const source = { name: '已采集公开来源', url: 'https://www.dota2.com/news/updates' };
  const data = { ...base(), rankings: [{ items: [game] }], news: [news('Dota 2', '站内近期公告', { publishedAt })], movements: [{
    ...game, observedAt: '2001-01-01T00:00:00Z', sources: [source],
    positive: [{ text: `${publishedAt} · 已采集匿名好评`, sourceUrl: source.url }],
    negative: [{ text: '已采集匿名不满', publishedAt, sourceUrl: source.url }],
    events: [{ text: `${publishedAt.replace('Z', '+00:00')} · 已采集官方活动`, sourceUrl: source.url }],
  }] };
  const calls = [];
  const result = await research(task('game-monitor', ['Dota 2']), { PUBLIC_DATA: data }, { fetcher: async url => {
    calls.push(url); throw new Error('private upstream credential');
  } });
  assert.equal(calls.length, 2);
  assert.equal(result.evidence.length, 4);
  assert.ok(result.evidence.every(e => e.gameId === game.gameId && e.publishedAt === publishedAt));
  assert.deepEqual(result.evidence.map(e => e.kind), ['fact', 'opinion', 'opinion', 'fact']);
  assert.ok(result.sources.some(s => s.url === source.url));
  assert.ok(result.sources.every(s => s.gameId === game.gameId && !calls.includes(s.url)));
  assert.match(result.limitations.join(''), /评价读取失败/);
  assert.match(result.limitations.join(''), /新闻读取失败/);
  assert.doesNotMatch(result.limitations.join(''), /缺少近七天/);
  assert.doesNotMatch(JSON.stringify(result), /credential/);
});

test('only evidence dates within the exact seven-day window survive, never snapshot dates or other games', async t => {
  const now = Date.parse('2026-06-10T12:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const date = offset => new Date(now + offset).toISOString();
  const week = 7 * 86_400_000;
  const game = steam(570, 'Dota 2');
  const source = { name: '本游戏来源', url: 'https://www.dota2.com/news/updates' };
  const otherSource = { name: '其他游戏来源', url: 'https://www.counter-strike.net/news/updates' };
  const entry = (text, extra = {}) => ({ text, sourceUrl: source.url, ...extra });
  const data = { ...base(), rankings: [{ items: [game] }], news: [
    news('Dota 2', '窗口内当前新闻', { publishedAt: date(0) }),
    news('Dota 2', '窗口内七天边界新闻', { publishedAt: date(-week) }),
    news('Dota 2', '过期新闻', { publishedAt: date(-week - 1) }),
    news('Dota 2', '未来新闻', { publishedAt: date(1) }),
    news('Dota 2', '无日期新闻', { publishedAt: undefined }),
    news('Counter-Strike 2', '其他游戏新闻'),
  ], movements: [{
    ...game, observedAt: date(0), sources: [source],
    positive: [
      entry(`${date(-week - 1)} · 过期前缀`), entry(`${date(1)} · 未来前缀`),
      entry('无日期旧反馈'), entry(`${date(0)} · 借用其他来源`, { sourceUrl: otherSource.url }),
    ],
    negative: [
      entry('过期显式日期', { publishedAt: date(-week - 1) }), entry('未来显式日期', { publishedAt: date(1) }),
      entry(`${date(0)} · 无效显式日期`, { publishedAt: 'invalid' }),
      entry('其他游戏条目', { publishedAt: date(0), gameId: 'steam:730' }),
    ],
    events: [
      entry(`${date(-week)} · 窗口内七天边界活动`), entry('窗口内当前活动', { publishedAt: date(0) }),
      entry(`${date(0)} · 过期显式日期优先`, { publishedAt: date(-week - 1) }), entry('无效前缀活动'),
    ],
  }, {
    ...steam(730, 'Counter-Strike 2'), observedAt: date(0), sources: [otherSource],
    positive: [{ text: `${date(0)} · 其他游戏反馈`, sourceUrl: otherSource.url }],
  }] };
  const result = await research(task('game-monitor', ['Dota 2']), { PUBLIC_DATA: data }, { fetcher: async url => {
    if (url.includes('appreviews')) return Response.json({ success: 1, reviews: [
      { timestamp_created: (now - week) / 1000 - 1, voted_up: true, review: '过期实时评价' },
      { timestamp_created: now / 1000 + 1, voted_up: false, review: '未来实时评价' },
    ] });
    return Response.json({ appnews: { appid: 570, newsitems: [
      { title: '过期实时新闻', date: (now - week) / 1000 - 1 }, { title: '未来实时新闻', date: now / 1000 + 1 },
    ] } });
  } });
  assert.equal(result.evidence.length, 4);
  assert.ok(result.evidence.every(e => e.gameId === game.gameId && e.text.includes('窗口内')));
  assert.deepEqual(result.evidence.map(e => e.publishedAt), [date(0), date(-week), date(-week), date(0)]);
  assert.ok(result.sources.every(s => s.gameId === game.gameId && s.url !== otherSource.url));
});

test('two Steam games keep station evidence before bounded live enrichment with 16 each and 32 total', async () => {
  const games = [steam(570, 'Dota 2'), steam(730, 'Counter-Strike 2')];
  const data = { ...base(), rankings: [{ items: games }],
    news: games.flatMap(game => Array.from({ length: 4 }, (_, i) => news(game.name, `${game.gameId} station news ${i}`))),
    movements: games.map(game => ({
      ...game, observedAt: iso(), sources: [{ name: `${game.name} snapshot`, url: game.url }],
      positive: Array.from({ length: 2 }, (_, i) => ({ text: `${iso()} · ${game.gameId} snapshot opinion ${i}`, sourceUrl: game.url })),
      events: [{ text: `${iso()} · ${game.gameId} snapshot event`, sourceUrl: game.url }],
    })),
  };
  const timestamp = epoch();
  const calls = [];
  const result = await research(task('game-monitor', games.map(game => game.name)), { PUBLIC_DATA: data }, { fetcher: async url => {
    calls.push(url);
    const parsed = new URL(url); const id = parsed.searchParams.get('appid') ?? parsed.pathname.split('/').pop();
    if (url.includes('appreviews')) return Response.json({ success: 1, reviews: Array.from({ length: 20 }, (_, i) => ({
      timestamp_created: timestamp, voted_up: true, review: `steam:${id} live opinion ${i}`,
    })) });
    return Response.json({ appnews: { appid: Number(id), newsitems: Array.from({ length: 8 }, (_, i) => ({
      title: `steam:${id} live news ${i}`, contents: 'recent', date: timestamp,
    })) } });
  } });
  assert.equal(calls.length, 4);
  assert.equal(result.evidence.length, 32);
  for (const game of games) {
    const own = result.evidence.filter(e => e.gameId === game.gameId);
    assert.equal(own.length, 16);
    assert.ok(own.every(e => e.text.includes(game.gameId)));
    assert.ok(own.slice(0, 7).every(e => /station news|snapshot/.test(e.text)));
    assert.equal(own.filter(e => e.text.includes('live opinion')).length, 8);
    assert.equal(own.filter(e => e.text.includes('live news')).length, 1);
  }
  for (const e of result.evidence) assert.equal(result.sources.find(s => s.id === e.sourceId).gameId, e.gameId);
  assert.ok(result.sources.every(s => result.evidence.some(e => e.sourceId === s.id)));
});
