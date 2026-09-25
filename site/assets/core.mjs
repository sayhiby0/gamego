// Pure, dependency-free boundaries shared by the browser and Node tests.
export const CATEGORIES = ['产品与版本', '运营活动', '营销与联动', '发行与渠道', '行业与公司', '玩家口碑'];
export const SKILL_CATEGORIES = ['资讯与竞品研究', '运营与营销内容'];
export const LIMITS = Object.freeze({ news: 30, ranking: 20, pc: 2, mobile: 4, movements: 6, message: 2000, history: 8, historyEntry: 1000, historyChars: 8000, output: 100000 });
export const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export const text = (value, max = 4000) => typeof value === 'string' ? value.slice(0, max) : '';
export const list = (value, max = 100) => Array.isArray(value) ? value.slice(0, max) : [];
const strings = (value) => list(value, 30).filter((v) => typeof v === 'string').map((v) => text(v, 200));
const number = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const integer = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function safeURL(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/u.test(value) || !value.startsWith('https://')) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return null;
    return url.href;
  } catch { return null; }
}

export function apiBase(value) {
  if (typeof value !== 'string' || !value || /[\s\\\u0000-\u001f\u007f]/u.test(value)) return '';
  try {
    const url = new URL(value);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) return '';
    return url.href.replace(/\/+$/, '');
  } catch { return ''; }
}

export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function todayInBeijing(now = new Date()) {
  return new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
}
export function timestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) && validDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value)) ? value : null;
}
export function formatTime(value) {
  if (!timestamp(value)) return '暂无记录';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}
export function archiveDates(value) {
  return [...new Set(list(value, 1000).filter(validDate))].sort().reverse().slice(0, 30);
}
export function archivePath(date, dates) {
  if (!validDate(date) || !archiveDates(dates).includes(date)) throw new Error('归档日期不在有效清单中');
  return `data/${date}.json`;
}
export function normalizeManifest(value) {
  if (!record(value) || value.schemaVersion !== 1 || !Array.isArray(value.dates)) throw new Error('归档清单格式不正确');
  return { dates: archiveDates(value.dates), latestDate: validDate(value.latestDate) ? value.latestDate : null, attemptedAt: timestamp(value.attemptedAt), lastSuccessAt: timestamp(value.lastSuccessAt), status: text(value.status, 80) };
}
export function sanitizeSources(value) {
  const seen = new Set();
  return list(value, 50).filter(record).flatMap((source) => {
    const url = safeURL(source.url);
    if (!url || seen.has(url)) return [];
    seen.add(url);
    return [{ id: text(source.id, 200), name: text(source.name, 200) || new URL(url).hostname, url }];
  });
}
function evidence(value) {
  return list(value, 20).filter(record).map((item) => ({ text: text(item.text), sourceUrl: safeURL(item.sourceUrl) })).filter((item) => item.text);
}
export function normalizeSkills(value) {
  const seen = new Set();
  return list(value, 100).filter(record).flatMap((skill) => {
    const url = safeURL(skill.url);
    if (!url || !text(skill.name) || seen.has(url) || !SKILL_CATEGORIES.includes(skill.category)) return [];
    seen.add(url);
    const heat = record(skill.popularity) ? skill.popularity : null;
    // A number without its metric, source and window must not become a heat score.
    const popularity = heat && text(heat.metric) && text(heat.window) && safeURL(heat.source) && timestamp(heat.collectedAt) && (number(heat.value) !== null || text(heat.value))
      ? { metric: text(heat.metric, 100), value: typeof heat.value === 'number' ? heat.value : text(heat.value, 100), source: safeURL(heat.source), window: text(heat.window, 100), collectedAt: timestamp(heat.collectedAt) } : null;
    return [{ id: text(skill.id, 200), name: text(skill.name, 200), category: skill.category, description: text(skill.description), scenarios: text(skill.scenarios), author: text(skill.author, 200), tools: text(skill.tools), prerequisites: text(skill.prerequisites), url, checkedAt: timestamp(skill.checkedAt), status: text(skill.status, 80), curatedOrder: number(skill.curatedOrder) ?? 999, popularity }];
  }).sort((a, b) => a.curatedOrder - b.curatedOrder);
}
export function limitMovements(value) {
  const seen = new Set();
  const counts = { pc: 0, mobile: 0 };
  return list(value, 100).filter(record).filter((item) => {
    const key = text(item.gameId) || text(item.id);
    if (!key || seen.has(key) || !['pc', 'mobile'].includes(item.platform) || counts[item.platform] >= LIMITS[item.platform]) return false;
    seen.add(key);
    counts[item.platform]++;
    return true;
  }).slice(0, LIMITS.movements);
}
export function normalizeDashboard(value) {
  if (!record(value) || value.schemaVersion !== 1 || !validDate(value.dataDate) || !['news', 'rankings', 'movements', 'skills', 'coverage'].every((key) => Array.isArray(value[key]))) throw new Error('公开数据格式不符合契约，未展示未校验内容');
  const seenNews = new Set();
  const news = list(value.news, 300).filter(record).flatMap((item) => {
    const sources = sanitizeSources(item.sources);
    const id = text(item.id, 200);
    if (!id || !text(item.title) || !timestamp(item.publishedAt) || !sources.length || seenNews.has(id)) return [];
    seenNews.add(id);
    return [{ id, title: text(item.title, 500), originalTitle: text(item.originalTitle, 500), publishedAt: timestamp(item.publishedAt), platforms: strings(item.platforms), markets: strings(item.markets), games: strings(item.games), categories: strings(item.categories), summary: text(item.summary), insight: text(item.insight), processing: { status: text(item.processing?.status, 80), reason: text(item.processing?.reason) }, sources }];
  }).slice(0, LIMITS.news);
  const groupCounts = new Map();
  const rankings = list(value.rankings, 60).filter(record).filter((board) => ['pc', 'mobile'].includes(board.platform) && ['popularity', 'reputation', 'commercial'].includes(board.metric)).map((board) => {
    const group = `${text(board.source?.id) || text(board.source?.name)}:${board.platform}:${board.metric}`;
    const remaining = Math.max(0, LIMITS.ranking - (groupCounts.get(group) ?? 0));
    const items = list(board.items, 100).filter(record).filter((item) => text(item.name)).slice(0, remaining).map((item) => ({ gameId: text(item.gameId, 200), name: text(item.name, 200), rank: integer(item.rank), value: number(item.value), reviewCount: integer(item.reviewCount), url: safeURL(item.url), previousRank: integer(item.previousRank), rankChange: number(item.rankChange), baselineAt: timestamp(item.baselineAt) }));
    groupCounts.set(group, (groupCounts.get(group) ?? 0) + items.length);
    return { id: text(board.id, 200), title: text(board.title, 300), platform: board.platform, source: { name: text(board.source?.name, 200), url: safeURL(board.source?.url) }, metric: board.metric, definition: text(board.definition), scope: text(board.scope), unit: text(board.unit, 100), period: text(board.period, 300), methodologyVersion: text(board.methodologyVersion, 100), observedAt: timestamp(board.observedAt), status: text(board.status, 80), reason: text(board.reason), minimumSample: integer(board.minimumSample), items };
  });
  return { schemaVersion: 1, dataDate: value.dataDate, attemptedAt: timestamp(value.attemptedAt), lastSuccessAt: timestamp(value.lastSuccessAt), status: text(value.status, 80), notice: text(value.notice), news, rankings,
    movements: limitMovements(value.movements).map((item) => ({ id: text(item.id, 200), gameId: text(item.gameId, 200), name: text(item.name, 200), platform: item.platform, reason: text(item.reason), observedAt: timestamp(item.observedAt), positive: evidence(item.positive), negative: evidence(item.negative), events: evidence(item.events), insight: text(item.insight), status: text(item.status, 80), limitations: strings(item.limitations), sources: sanitizeSources(item.sources) })),
    skills: normalizeSkills(value.skills),
    coverage: list(value.coverage, 250).filter(record).map((item) => ({ id: text(item.id, 200), name: text(item.name, 200), method: text(item.method, 100), url: safeURL(item.url), status: text(item.status, 80), attemptedAt: timestamp(item.attemptedAt), lastSuccessAt: timestamp(item.lastSuccessAt), reason: text(item.reason), count: integer(item.count) })) };
}
export function filterNews(news, filters = {}) {
  const query = text(filters.query, 200).trim().toLocaleLowerCase();
  const categories = strings(filters.categories);
  return list(news, 30).filter((item) => {
    const haystack = [item.title, item.originalTitle, item.summary, ...strings(item.games), ...sanitizeSources(item.sources).map((source) => source.name)].join(' ').toLocaleLowerCase();
    return (!query || haystack.includes(query)) && (!filters.platform || strings(item.platforms).includes(filters.platform)) && (!filters.market || strings(item.markets).includes(filters.market)) && (!filters.game || strings(item.games).includes(filters.game)) && (!categories.length || categories.some((category) => strings(item.categories).includes(category)));
  });
}
export function dataState(data, manifest, today = todayInBeijing(), archive = false) {
  if (!data) return { label: '数据不可用', tone: 'muted', detail: '未取得有效公开数据；不展示示例资讯。' };
  const newerAttempt = !archive && timestamp(manifest?.attemptedAt) && (!data.attemptedAt || Date.parse(manifest.attemptedAt) > Date.parse(data.attemptedAt));
  const status = newerAttempt ? manifest.status : data.status;
  if (status === 'stale' || (!archive && data.dataDate < today)) return { label: '旧快照', tone: 'warning', detail: '当前展示上次有效快照，并非今日新数据。' };
  if (['unavailable', 'failed', 'error'].includes(status)) return { label: '本次未取得数据', tone: 'warning', detail: '采集未成功；已保留内容不代表本次更新成功。' };
  if (status === 'partial') return { label: '部分覆盖', tone: 'warning', detail: '部分来源或 AI 加工不可用，缺失原因请查看覆盖明细。' };
  if (status === 'empty' || (!data.news.length && !data.rankings.some((r) => r.items.length) && !data.movements.length)) return { label: '暂无新内容', tone: 'muted', detail: '本次没有可展示的新内容，不凑数、不补造记录。' };
  if (['ok', 'success', 'available', 'complete', 'fresh'].includes(status)) return { label: archive ? '归档快照' : '已更新', tone: 'good', detail: '仅代表已接入来源的本次结果，不代表全行业完整覆盖。' };
  return { label: '状态未确认', tone: 'muted', detail: '未提供可识别的更新状态，请核对来源记录。' };
}
export function rankTrend(item, observedAt) {
  if (!timestamp(item.baselineAt) || !timestamp(observedAt) || Date.parse(item.baselineAt) >= Date.parse(observedAt) || !Number.isSafeInteger(item.previousRank) || item.previousRank < 1 || !Number.isSafeInteger(item.rank) || item.rank < 1 || item.rankChange !== item.previousRank - item.rank) return '历史数据积累中';
  const change = item.rankChange;
  return `${change > 0 ? `上升 ${change}` : change < 0 ? `下降 ${Math.abs(change)}` : '持平'} · 对比 ${formatTime(item.baselineAt)}`;
}
export function parseGames(value) {
  if (typeof value !== 'string' || value.length > 200) throw new Error('游戏名称输入过长');
  const games = [...new Set(value.split(/[,，、;；\n]/u).map((part) => part.trim()).filter(Boolean))];
  if (games.length > 2 || games.some((game) => game.length > 80)) throw new Error('最多填写两款游戏，每款不超过 80 字');
  return games;
}
export function boundedHistory(value) {
  const rows = list(value, 100).filter((item) => record(item) && ['user', 'assistant'].includes(item.role) && typeof item.content === 'string' && item.content.trim()).slice(-LIMITS.history);
  const result = [];
  let remaining = LIMITS.historyChars;
  for (const row of rows.reverse()) {
    if (remaining <= 0) break;
    const content = row.content.slice(0, Math.min(LIMITS.historyEntry, remaining));
    result.unshift({ role: row.role, content });
    remaining -= content.length;
  }
  return result;
}
export function agentRequest(skill, message, games, history) {
  if (!['game-daily', 'game-monitor'].includes(skill)) throw new Error('请选择受支持的 Skill');
  if (typeof message !== 'string' || !message.trim() || message.length > LIMITS.message) throw new Error(`请输入 1–${LIMITS.message} 字问题`);
  if (!Array.isArray(games) || games.length > 2 || games.some((game) => typeof game !== 'string' || !game.trim() || game.length > 80)) throw new Error('游戏名称格式不正确');
  return { skill, message: message.trim(), games: [...new Set(games.map((game) => game.trim()))], history: boundedHistory(history) };
}
// Dedicated storage contains only opt-in configuration, never conversation history.
export const BYOK_STORAGE_KEY = 'gamego.byok.v1';
export function keyProblem(key) {
  if (typeof key === 'string' && /^sk-sp-/i.test(key)) return 'Coding Plan 专用 Key 不能用于本站，请创建普通模型 API Key。';
  if (typeof key !== 'string' || key.length < 19 || key.length > 256 || !/^sk-[A-Za-z0-9_-]+$/.test(key)) return '请输入普通 sk- API Key（19–256 个 ASCII 字符，无空格）；这里只检查明显格式错误。';
  return '';
}
const modelID = (value) => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value) && !value.startsWith('sk-');
const regionID = (value) => typeof value === 'string' && /^[a-z][a-z0-9-]{1,39}$/.test(value) && !value.startsWith('sk-');
export function normalizeModels(value, now = Date.now()) {
  const seen = new Set();
  return list(value?.models, 100).filter(record).flatMap((item) => {
    if (!modelID(item.model) || !regionID(item.region) || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 200 || /[\u0000-\u001f\u007f]|sk-/i.test(item.label) || !timestamp(item.verifiedAt) || Date.parse(item.verifiedAt) > now) return [];
    const id = `${item.region}/${item.model}`;
    if (seen.has(id)) return [];
    seen.add(id);
    const price = (value) => number(value) !== null && value >= 0 ? value : null;
    return [{ region: item.region, model: item.model, label: item.label.trim(), verifiedAt: item.verifiedAt, inputPrice: price(item.inputPrice), outputPrice: price(item.outputPrice) }];
  });
}
export function storedConfig(value) {
  if (!record(value) || Object.keys(value).sort().join(',') !== 'key,model,region,version' || value.version !== 1 || keyProblem(value.key) || !modelID(value.model) || !regionID(value.region)) return null;
  return { version: 1, key: value.key, model: value.model, region: value.region };
}
export function containsSecret(value, key) {
  let source = typeof value === 'string' ? value : JSON.stringify(value);
  if (typeof source !== 'string') return false;
  for (let pass = 0; pass < 3; pass++) {
    if ((key && source.includes(key)) || /sk-[A-Za-z0-9_-]{13,}/.test(source)) return true;
    try {
      const decoded = decodeURIComponent(source);
      if (decoded === source) break;
      source = decoded;
    } catch { break; }
  }
  return false;
}
// Keep a key-prefix suffix private until the next chunk: a split credential must
// never briefly appear in the DOM, history or an export during streaming.
export function secretFilter(key) {
  let pending = '';
  return {
    push(chunk, final = false) {
      let value = (pending + chunk).split(key).join('[密钥已隐藏]');
      pending = '';
      if (!final) {
        for (let size = Math.min(key.length - 1, value.length); size > 0; size--) {
          if (value.endsWith(key.slice(0, size))) { pending = value.slice(-size); value = value.slice(0, -size); break; }
        }
      }
      return value;
    },
    clear() { pending = ''; key = ''; },
  };
}
const API_ERRORS = Object.freeze({
  key_invalid: 'API Key 无效或已撤销，请在百炼控制台检查并重新配置。',
  key_type: 'Coding Plan 专用 Key 不能用于本站，请创建普通模型 API Key。',
  permission: '来源或模型权限／地域不允许，请核对站点、业务空间、模型和地域设置。',
  balance: '百炼余额或适用额度不足，请到控制台核对。',
  rate_limit: '请求过于频繁，请稍后手动重试，不要通过更换 Key 绕过限流。',
  timeout: '请求超时，已受理的调用仍可能计费。',
  aborted: '任务已停止，已受理的调用仍可能计费。',
  configuration: '所选模型／地域尚未验收或未开放，请刷新列表并重新配置。',
  disabled: '模型服务尚未启用，不能发起付费调用。',
  price: '模型价格配置尚未确认，当前调用不可用。',
  input: '请求格式无效、超过限制或包含疑似密钥，请检查问题与配置。',
  output: '模型输出未通过结构或引用验证，报告不完整。',
  usage: '模型用量无法确认，费用未知；已受理的调用仍可能计费。',
  provider: '模型服务暂时不可用，已受理的调用仍可能计费。',
  service: '中转服务暂时不可用，请稍后手动重试。',
  not_found: '中转接口不存在，请联系站点维护者核对服务。',
  method: '中转接口不支持当前请求方式，请联系站点维护者。',
  conflict: '请求冲突，请稍后手动重试。',
  invalid_key: 'API Key 无效或已撤销，请在百炼控制台检查并重新配置。',
  invalid_api_key: 'API Key 无效或已撤销，请在百炼控制台检查并重新配置。',
  coding_plan_not_supported: 'Coding Plan 不能用于本站，请使用普通模型 API Key。',
  insufficient_balance: '百炼余额或适用额度不足，请到控制台核对。',
  insufficient_quota: '百炼余额或适用额度不足，请到控制台核对。',
  quota_exceeded: '百炼额度不足，请到控制台核对。',
  model_forbidden: '所选模型无调用权限，请核对业务空间与最小所需权限。',
  permission_denied: '所选模型无调用权限，请核对业务空间与最小所需权限。',
  region_mismatch: '地域不匹配，请核对 Key 所在地域并重新保存。',
  unsupported_model: '该模型或地域不在站主验收列表中，请重新配置。',
  unsupported_region: '该地域不受支持，请选择站主验收列表中的组合。',
  rate_limited: '请求过于频繁，请稍后手动重试，不要通过更换 Key 绕过限流。',
  busy: '中转服务忙，请稍后手动重试。',
  upstream_timeout: '模型响应超时，已受理的请求仍可能计费。',
  upstream_error: '模型服务暂时不可用，请稍后手动重试。',
  evidence_unavailable: '本次取证失败或资料不足，不能生成有依据的完整报告。',
});
export function apiErrorMessage(code, status = 0) {
  if (status === 401) return API_ERRORS.invalid_key;
  const key = typeof code === 'string' ? code.toLowerCase() : '';
  if (Object.hasOwn(API_ERRORS, key)) return API_ERRORS[key];
  if (status === 403) return API_ERRORS.permission_denied;
  if (status === 402) return API_ERRORS.insufficient_balance;
  if (status === 429) return API_ERRORS.rate_limited;
  return '服务请求未完成，无法确认具体原因。请检查配置或稍后手动重试；已受理的请求仍可能计费。';
}
export function normalizeUsage(value) {
  return { input: integer(value?.input), output: integer(value?.output), cost: integer(value?.cost) };
}
export function usageText(value) {
  const usage = normalizeUsage(value);
  return `输入 ${usage.input ?? '未知'} / 输出 ${usage.output ?? '未知'} Token · 估算费用${usage.cost === null ? '未知' : ` ¥${(usage.cost / 1000000).toFixed(6)}`}（以百炼账单为准）`;
}
export function normalizeSSEEvent(type, value) {
  if (!['status', 'delta', 'sources', 'usage', 'error', 'done'].includes(type)) return null;
  if (!record(value)) throw new Error('流式事件结构不正确');
  if (type === 'error') return { type, message: apiErrorMessage(value.error || value.code), code: text(value.error || value.code, 100) };
  if (type === 'usage') return { type, model: modelID(value.model) ? value.model : '', region: regionID(value.region) ? value.region : '', usage: normalizeUsage(value.usage ?? value) };
  if (type === 'status') {
    if (typeof value.message !== 'string') throw new Error('流式状态缺少文字');
    return { type, message: text(value.message) };
  }
  if (type === 'delta') {
    if (typeof value.text !== 'string' || value.text.length > LIMITS.output) throw new Error('流式文本格式或长度不正确');
    return { type, text: value.text };
  }
  if (type === 'sources') {
    if (!Array.isArray(value.sources)) throw new Error('流式来源格式不正确');
    return { type, sources: sanitizeSources(value.sources) };
  }
  return { type, ...(typeof value.ok === 'boolean' ? { ok: value.ok } : {}), ...(value.cancelled === true ? { cancelled: true } : {}) };
}
export function createSSEParser(onEvent) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', event = '', fields = [], eventSize = 0, closed = false;
  function dispatch() {
    if (fields.length && ['status', 'delta', 'sources', 'usage', 'error', 'done'].includes(event)) {
      let parsed;
      try { parsed = JSON.parse(fields.join('\n')); } catch { throw new Error('流式事件不是有效 JSON'); }
      const result = normalizeSSEEvent(event, parsed);
      if (result) onEvent(result);
    }
    event = ''; fields = []; eventSize = 0;
  }
  function line(value) {
    eventSize += value.length;
    if (eventSize > 250000) throw new Error('流式事件超出长度限制');
    if (!value) { dispatch(); return; }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':');
    const key = colon === -1 ? value : value.slice(0, colon);
    const content = colon === -1 ? '' : value.slice(colon + 1).replace(/^ /, '');
    if (key === 'event') event = content;
    if (key === 'data') fields.push(content);
  }
  function consume(final = false) {
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] !== '\r' && buffer[i] !== '\n') continue;
      if (buffer[i] === '\r' && i === buffer.length - 1 && !final) break;
      line(buffer.slice(start, i));
      if (buffer[i] === '\r' && buffer[i + 1] === '\n') i++;
      start = i + 1;
    }
    buffer = buffer.slice(start);
    if (buffer.length > 250000) throw new Error('流式事件超出长度限制');
    if (final) { if (buffer) line(buffer); buffer = ''; dispatch(); }
  }
  return {
    push(chunk) {
      if (closed) throw new Error('流式解析器已结束');
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      consume();
    },
    finish() { if (!closed) { buffer += decoder.decode(); consume(true); closed = true; } },
  };
}
export async function readSSE(stream, onEvent, signal) {
  if (!stream?.getReader) throw new Error('浏览器未取得可读的响应流');
  const reader = stream.getReader();
  let done = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  const parser = createSSEParser((event) => {
    if (done) return;
    onEvent(event);
    if (event.type === 'error') throw new Error(event.message || '分析服务返回错误');
    if (event.type === 'done') done = true;
  });
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (!done) {
      if (signal?.aborted) throw new DOMException('请求已停止', 'AbortError');
      const result = await reader.read();
      if (signal?.aborted) throw new DOMException('请求已停止', 'AbortError');
      if (result.done) { parser.finish(); break; }
      parser.push(result.value);
    }
    if (!done) throw new Error('连接提前结束，报告可能不完整；可重试');
  } finally {
    signal?.removeEventListener('abort', abort);
    try { await reader.cancel(); } catch { /* The network may already be closed. */ }
    reader.releaseLock();
  }
}
// Export untrusted text literally rather than activating HTML or Markdown links.
export function markdownLiteral(value) {
  return text(value, LIMITS.output).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}\[\]()#+.!|~-])/g, '\\$1');
}
export function exportMarkdown(messages, createdAt = new Date().toISOString()) {
  const sections = ['# GameGo · 当前会话报告', `导出时间：${formatTime(createdAt)}（北京时间）`, '仅导出当前页面内容。AI 输出需核实，停止或失败的报告可能不完整。'];
  const literal = (value) => markdownLiteral(text(value, LIMITS.output).replace(/sk-[A-Za-z0-9_-]{13,}/g, '[密钥已隐藏]'));
  for (const message of list(messages, 24)) {
    if (!record(message) || !['user', 'assistant'].includes(message.role)) continue;
    sections.push(`## ${message.role === 'user' ? '问题' : '分析'}`, literal(message.content));
    if (message.state) sections.push(`状态：${literal(message.state)}`);
    if (message.role === 'assistant') sections.push(`用量：${usageText(message.usage)}`);
    const sources = sanitizeSources(message.sources).filter((source) => !containsSecret(source));
    if (sources.length) sections.push('### 依据来源', ...sources.map((source) => `- ${literal(source.name)} — <${source.url.replace(/[<>]/g, (char) => encodeURIComponent(char))}>`));
  }
  return sections.join('\n\n') + '\n';
}
