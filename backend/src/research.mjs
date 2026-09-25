import { HttpError, publicJson, publicText, safeUrl, fetchJsonBounded } from './security.mjs';
import { abortable } from './model.mjs';

const DAY = 86_400_000;
const MAX_EVIDENCE = 32;
const list = (value, max = 100) => Array.isArray(value) ? value.slice(0, max) : [];
const normalized = value => publicText(value, 160).toLocaleLowerCase().replace(/[\s：:·・™®]/g, '');
const ALIASES = [
  ['原神', 'Genshin Impact'], ['崩坏：星穹铁道', '星穹铁道', 'Honkai Star Rail'],
  ['绝区零', 'Zenless Zone Zero'], ['王者荣耀', 'Honor of Kings'], ['和平精英', 'Game for Peace'],
  ['英雄联盟', 'League of Legends'], ['明日方舟', 'Arknights'], ['鸣潮', 'Wuthering Waves'],
];
// These names assist matching ONLY an entity already present in the snapshot.
// They are not IDs, evidence, a public-topic allowlist, or permission to fetch.
function namesFor(row) {
  const names = [row.name, ...list(row.aliases, 12)].filter(x => typeof x === 'string');
  for (const group of ALIASES) if (group.some(name => names.some(n => normalized(n) === normalized(name)))) names.push(...group);
  return [...new Set(names.map(normalized).filter(Boolean))];
}
function recent(value, now) {
  const time = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(time) && time >= now - 7 * DAY && time <= now;
}
function evidenceDate(entry) {
  // observedAt dates the snapshot, not the evidence. Public movement text
  // carries its original ISO timestamp when no explicit date is available.
  return entry.publishedAt ?? /^\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))(?=\s|$)/i.exec(entry.text)?.[1];
}
function safeSource(source) {
  if (!source || typeof source.url !== 'string' || !safeUrl(source.url)) return null;
  return { name: publicText(source.name || '公开来源', 120), url: new URL(source.url).href };
}
async function snapshot(env, signal, fetcher) {
  let data;
  if (env.PUBLIC_DATA !== undefined) {
    if (!env.PUBLIC_DATA || typeof env.PUBLIC_DATA !== 'object' || JSON.stringify(env.PUBLIC_DATA).length > 500_000) throw new HttpError(503, '站内快照无效');
    data = env.PUBLIC_DATA;
  } else {
    const url = safeUrl(env.PUBLIC_DATA_URL);
    if (!url || url.hash) throw new HttpError(503, '站内公开数据源未配置');
    // Sole administrator-configured endpoint. Never obtained from message/games.
    // Use the bounded trusted-URL reader; public tools cannot extend PUBLIC_HOSTS.
    data = await abortable(fetchJsonBounded(url.href, { signal, headers: { Accept: 'application/json' } }, fetcher), signal);
  }
  if (data?.schemaVersion !== 1 || !Array.isArray(data.news) || !Array.isArray(data.rankings)
      || !Array.isArray(data.movements)) throw new HttpError(503, '站内快照格式不匹配');
  return data;
}
function entities(data) {
  const rows = [
    ...list(data.rankings, 30).flatMap(board => list(board.items, 100)),
    ...list(data.movements, 20),
    ...list(data.entities, 200).filter(row => row?.verified === true),
  ];
  const byId = new Map();
  for (const row of rows) {
    if (!row || typeof row.name !== 'string' || !row.name.trim() || typeof row.gameId !== 'string'
        || !/^[a-z][a-z0-9_-]*:[a-zA-Z0-9_-]{1,80}$/.test(row.gameId)) continue;
    const steam = /^steam:([1-9]\d{0,9})$/.exec(row.gameId);
    const url = safeUrl(row.url);
    // A Steam id/name association must include the corresponding store URL.
    if (row.gameId.startsWith('steam:') && (!steam || !url || url.hostname !== 'store.steampowered.com'
        || !new RegExp(`^/app/${steam[1]}(?:/|$)`).test(url.pathname))) continue;
    const previous = byId.get(row.gameId);
    if (previous) previous.names = [...new Set([...previous.names, ...namesFor(row)])];
    else byId.set(row.gameId, { gameId: row.gameId, name: publicText(row.name, 160), names: namesFor(row), steamId: steam?.[1] ?? null });
  }
  return [...byId.values()];
}
function mentions(text, name) {
  // Preserve Latin word boundaries while accepting spaces in names/aliases.
  if (/^[a-z0-9]+$/.test(name)) return new RegExp(`(?:^|[^a-z0-9])${[...name].join('[\\s:：·・™®]*')}(?:$|[^a-z0-9])`, 'i').test(text);
  return normalized(text).includes(name);
}
function selectGames(task, candidates) {
  if (task.games.length) return task.games.map(name => {
    const matches = candidates.filter(game => game.names.includes(normalized(name)));
    return matches.length === 1 ? { ...matches[0], requested: name } : { requested: name, unresolved: true };
  }).filter((game, i, all) => game.unresolved || all.findIndex(g => game.gameId ? g.gameId === game.gameId : g.name === game.name) === i);
  const text = publicText(task.message, 2000);
  const found = candidates.filter(game => game.names.some(name => mentions(text, name)));
  return found.length <= 2 ? found : [{ requested: '多个同名或匹配游戏', unresolved: true }];
}
function themeFilters(message) {
  return [
    ['运营活动', /运营|活动|版本|更新|补丁/i], ['营销与联动', /营销|联动|推广|广告/i],
    ['发行与渠道', /发行|渠道|市场|销量|营收|商业/i], ['产品与版本', /玩法|产品|版本|更新|补丁/i],
  ].filter(([, pattern]) => pattern.test(message)).map(([name]) => name);
}

export async function research(task, env, { signal, fetcher = fetch } = {}) {
  const now = Date.now();
  const result = { sources: [], evidence: [], games: [], limitations: ['受控搜索未接入；本报告不代表全网监控。'], retrievedAt: new Date(now).toISOString() };
  let data;
  try { data = await snapshot(env, signal, fetcher); }
  catch {
    if (signal?.aborted) throw new HttpError(499, '任务已停止');
    result.limitations.push('站内最新快照未配置、不可用或格式无效；无法确认游戏实体与近期资讯。');
    return result;
  }
  if (!recent(data.lastSuccessAt ?? data.attemptedAt, now)) result.limitations.push('站内快照时间缺失或超过七天；仅使用有有效近期日期的条目。');
  const candidates = entities(data);
  if (task.skill === 'game-daily') {
    // Daily filtering needs only a name actually tagged in sourced recent news,
    // not a platform ID. These records never authorize Steam/monitor tools.
    for (const item of list(data.news, 300)) {
      if (!item || !recent(item.publishedAt, now) || !list(item.sources, 6).some(safeSource)) continue;
      for (const name of list(item.games, 12)) {
        if (typeof name !== 'string' || !name.trim()) continue;
        const names = namesFor({ name });
        if (!candidates.some(game => game.names.some(n => names.includes(n)))) candidates.push({ gameId: null, name: publicText(name, 160), names });
      }
    }
  }
  const selected = selectGames(task, candidates);
  result.games = selected.map(game => ({ gameId: game.gameId ?? null, name: game.name ?? game.requested, unresolved: Boolean(game.unresolved) }));
  const add = (gameId, kind, text, source, publishedAt) => {
    const safe = safeSource(source); const clean = publicText(text, 800);
    if (!safe || !clean || result.evidence.length >= MAX_EVIDENCE || !recent(publishedAt, now)) return;
    // Reserve equal capacity for each monitored game before adding any sources.
    if (task.skill !== 'game-daily' && result.evidence.filter(e => e.gameId === gameId).length >= 16) return;
    let existing = result.sources.find(s => s.url === safe.url && s.gameId === gameId);
    if (!existing) { existing = { id: `s${result.sources.length + 1}`, ...safe, gameId }; result.sources.push(existing); }
    if (!result.evidence.some(e => e.sourceId === existing.id && e.text === clean)) result.evidence.push({ gameId, kind, text: clean, sourceId: existing.id, publishedAt: new Date(typeof publishedAt === 'number' ? publishedAt : Date.parse(publishedAt)).toISOString() });
  };
  const newsFor = (game, themes = []) => {
    for (const item of list(data.news, 300)) {
      if (!item || !recent(item.publishedAt, now)) continue;
      const names = list(item.games, 12).filter(n => typeof n === 'string').map(normalized).filter(Boolean);
      if (game) {
        if (item.gameId && item.gameId !== game.gameId) continue;
        if (names.length) {
          // Existing tags are authoritative; a title cannot override a mismatch.
          if (!names.some(name => game.names.includes(name))) continue;
        } else if (!game.gameId || item.gameId !== game.gameId) {
          const titles = [publicText(item.originalTitle, 300), publicText(item.title, 300)];
          const matches = candidates.filter(candidate => candidate.names.some(name => titles.some(title => mentions(title, name))));
          // Text can match a known entity, never create an ID or disambiguate one.
          if (matches.length !== 1 || matches[0].gameId !== game.gameId || matches[0].name !== game.name) continue;
        }
      }
      if (themes.length && !list(item.categories, 12).some(c => themes.includes(c))) continue;
      const platform = /(?:手机|手游|mobile)/i.test(task.message) ? 'mobile' : /\bpc\b|电脑|端游/i.test(task.message) ? 'pc' : null;
      if (platform && !list(item.platforms, 5).includes(platform)) continue;
      const text = [publicText(item.title, 300), publicText(item.evidence || item.summary, 450)].filter(Boolean).join('。站内公开摘要：');
      // Source links came from the fetched public snapshot, not user input.
      for (const source of list(item.sources, 2)) add(game?.gameId ?? null, 'fact', text, source, item.publishedAt);
    }
  };
  if (task.skill === 'game-daily') {
    const themes = themeFilters(task.message);
    if (task.games.length || selected.length) {
      for (const game of selected) {
        if (game.unresolved) result.limitations.push(`需要补充游戏名称或站内实体：${publicText(game.requested, 160)}。`);
        else newsFor(game, themes);
      }
    } else newsFor(null, themes);
    if (!result.evidence.length) result.limitations.push('站内近七天没有匹配游戏、平台或主题的可引用新闻。');
    return result;
  }
  if (!selected.length) result.limitations.push('需要补充一至两款可在站内榜单或已核验实体中确认的游戏名称。');
  for (const game of selected) {
    signal?.throwIfAborted();
    if (game.unresolved) { result.limitations.push(`需要补充游戏名称或站内实体：${publicText(game.requested, 160)}；不猜测平台 ID。`); continue; }
    // Reuse dated station evidence for every entity before live enrichment.
    newsFor(game);
    for (const movement of list(data.movements, 20).filter(m => m?.gameId === game.gameId)) {
      for (const [field, kind] of [['positive', 'opinion'], ['negative', 'opinion'], ['events', 'fact']]) {
        for (const entry of list(movement[field], 4)) {
          if (!entry || (entry.gameId && entry.gameId !== game.gameId)) continue;
          // A movement's evidence must reference its own declared public sources.
          const source = list(movement.sources, 20).find(s => s?.url === entry.sourceUrl);
          if (source) add(game.gameId, kind, entry.text, source, evidenceDate(entry));
        }
      }
    }
    // Fetch at most two live Steam endpoints per confirmed game.
    if (game.steamId) {
      const reviewsUrl = `https://store.steampowered.com/appreviews/${game.steamId}?json=1&filter=recent&language=all&day_range=7&num_per_page=20&purchase_type=all`;
      try {
        const response = await abortable(publicJson(reviewsUrl, signal, fetcher), signal);
        if (response.success !== 1 || !Array.isArray(response.reviews)) throw new Error('invalid reviews');
        for (const review of response.reviews.slice(0, 8)) {
          if (!Number.isSafeInteger(review.timestamp_created) || typeof review.voted_up !== 'boolean') continue;
          // Intentionally omit author/steamid/profile, playtime and recommendationid.
          add(game.gameId, 'opinion', `${review.voted_up ? '匿名好评' : '匿名不满'}：${publicText(review.review, 600)}`, { name: `${game.name} Steam 近七天评价（有限样本）`, url: reviewsUrl }, review.timestamp_created * 1000);
        }
      } catch {
        if (signal?.aborted) throw new HttpError(499, '任务已停止');
        result.limitations.push(`${game.name}：Steam 近期评价读取失败，未用其他游戏替代。`);
      }
      const newsUrl = `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${game.steamId}&count=8&maxlength=600&format=json`;
      try {
        const response = await abortable(publicJson(newsUrl, signal, fetcher), signal);
        if (String(response.appnews?.appid) !== game.steamId || !Array.isArray(response.appnews?.newsitems)) throw new Error('mismatched appid');
        for (const item of response.appnews.newsitems.slice(0, 6)) {
          if (!Number.isSafeInteger(item.date)) continue;
          add(game.gameId, 'fact', `${publicText(item.title, 200)}：${publicText(item.contents, 600)}`, { name: `${game.name} Steam 新闻接口摘要`, url: newsUrl }, item.date * 1000);
        }
      } catch {
        if (signal?.aborted) throw new HttpError(499, '任务已停止');
        result.limitations.push(`${game.name}：Steam 新闻读取失败。`);
      }
    }
    const own = result.evidence.filter(e => e.gameId === game.gameId);
    if (!own.some(e => e.kind === 'opinion')) result.limitations.push(`${game.name}：缺少近七天可核验的玩家观点。`);
    if (!own.some(e => e.kind === 'fact')) result.limitations.push(`${game.name}：缺少近七天可核验的新闻或运营活动。`);
    result.limitations.push(`${game.name}：有限来源不代表整体口碑；营销、玩法及争议等未被证据覆盖的维度均未知。`);
  }
  result.sources = result.sources.filter(s => result.evidence.some(e => e.sourceId === s.id));
  return result;
}
