import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as core from '../../site/assets/core.mjs';

const { safeURL, apiBase, validDate, timestamp, todayInBeijing, formatTime, archiveDates, archivePath, normalizeManifest, sanitizeSources, normalizeDashboard, normalizeSkills, limitMovements, filterNews, dataState, rankTrend, parseGames, boundedHistory, agentRequest, BYOK_STORAGE_KEY, keyProblem, normalizeModels, storedConfig, containsSecret, secretFilter, apiErrorMessage, normalizeUsage, usageText, createSSEParser, normalizeSSEEvent, readSSE, exportMarkdown, LIMITS } = core;
const fixture = (changes = {}) => ({ schemaVersion: 1, dataDate: '2026-09-23', attemptedAt: '2026-09-23T01:05:00Z', lastSuccessAt: null, status: 'empty', notice: '', news: [], rankings: [], movements: [], skills: [], coverage: [], ...changes });
const article = (changes = {}) => ({ id: 'test-article', title: '测试版本公告', originalTitle: 'Test update', publishedAt: '2026-09-23T00:00:00Z', platforms: ['pc'], markets: ['global'], games: ['测试游戏'], categories: ['产品与版本'], summary: null, insight: null, processing: { status: 'unavailable', reason: '模型未配置' }, sources: [{ name: '测试来源', url: 'https://example.test/article' }], ...changes });
const skill = (changes = {}) => ({ id: 'test-skill', name: 'test-skill', category: '资讯与竞品研究', description: '测试用条目，不发布', url: 'https://example.test/skill', curatedOrder: 1, ...changes });

test('HTTPS source URLs reject credentials, scripts, whitespace and ambiguous paths', () => {
  assert.equal(safeURL('https://example.test/a?x=1#part'), 'https://example.test/a?x=1#part');
  for (const value of [null, {}, '', 'javascript:alert(1)', 'data:text/html,x', 'http://example.test', '//example.test', 'file:///x', 'https://name:password@example.test', 'https://name@example.test', ' https://example.test', 'https://example.test/\nx', 'https://example.test\\@other.test', 'https://example.test/hello world']) assert.equal(safeURL(value), null, String(value));
});
test('API config is fail-closed, with explicit HTTP loopback support for local development', () => {
  assert.equal(apiBase(''), '');
  assert.equal(apiBase('https://api.example.test/v1/'), 'https://api.example.test/v1');
  assert.equal(apiBase('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  for (const value of ['http://remote.test', 'https://a:b@remote.test', 'https://remote.test/?secret=x', 'https://remote.test/#hash', '//remote.test', null]) assert.equal(apiBase(value), '');
});
test('calendar dates validate leap years and prevent traversal', () => {
  assert.ok(validDate('2024-02-29'));
  for (const value of ['2026-02-29', '2026-09-31', '../private', '2026-1-01', '2026-09-23.json', null]) assert.equal(validDate(value), false);
  assert.equal(timestamp('2026-02-30T00:00:00Z'), null);
  assert.equal(timestamp('2026-09-23T25:00:00Z'), null);
  assert.equal(timestamp('2026-09-23T00:00:00'), null);
  assert.equal(timestamp('2026-09-23T08:00:00+08:00'), '2026-09-23T08:00:00+08:00');
});
test('Beijing date and display times use UTC+8 rather than browser timezone', () => {
  assert.equal(todayInBeijing(new Date('2026-09-22T16:00:00Z')), '2026-09-23');
  assert.equal(todayInBeijing(new Date('2026-09-22T15:59:59Z')), '2026-09-22');
  assert.match(formatTime('2026-09-22T17:00:00Z'), /2026.*09.*23.*01:00/);
  assert.equal(formatTime(null), '暂无记录');
});
test('archives are unique, descending, bounded and restricted to manifest membership', () => {
  assert.deepEqual(archiveDates(['2026-09-21', 'bad', '2026-09-23', '2026-09-21']), ['2026-09-23', '2026-09-21']);
  assert.equal(archivePath('2026-09-23', ['2026-09-23']), 'data/2026-09-23.json');
  assert.throws(() => archivePath('../secret', ['../secret']));
  assert.throws(() => archivePath('2026-09-22', ['2026-09-23']));
  assert.equal(archiveDates(Array.from({ length: 40 }, (_, i) => new Date(Date.UTC(2026, 8, i + 1)).toISOString().slice(0, 10))).length, 30);
});
test('manifest validation rejects malformed shapes', () => {
  assert.throws(() => normalizeManifest({ dates: [] }));
  assert.throws(() => normalizeManifest({ schemaVersion: 1, dates: {} }));
  assert.deepEqual(normalizeManifest({ schemaVersion: 1, dates: ['2026-09-23'], latestDate: '../x' }).latestDate, null);
});
test('sources discard invalid shapes and URLs and deduplicate by URL', () => {
  assert.deepEqual(sanitizeSources([null, 'x', { name: '<img onerror=x>', url: 'https://example.test/a' }, { url: 'https://example.test/a' }, { url: 'javascript:alert(1)' }]), [{ id: '', name: '<img onerror=x>', url: 'https://example.test/a' }]);
  assert.deepEqual(sanitizeSources({ url: 'https://example.test' }), []);
});
test('news filtering uses OR within categories, AND across filters, and literal queries', () => {
  const news = [article(), article({ id: 'second', title: '中文手机活动', originalTitle: 'Mobile activity', platforms: ['mobile'], markets: ['cn'], games: ['其他游戏'], categories: ['运营活动', '营销与联动'] })];
  assert.equal(filterNews(news, { categories: ['产品与版本', '运营活动'] }).length, 2);
  assert.equal(filterNews(news, { categories: ['产品与版本', '运营活动'], platform: 'mobile', market: 'cn', game: '其他游戏' }).length, 1);
  assert.equal(filterNews(news, { query: 'TEST UPDATE' }).length, 1);
  assert.equal(filterNews(news, { query: '[.*]' }).length, 0);
  assert.equal(filterNews(news, { query: '测试来源' }).length, 2);
  assert.equal(filterNews(news, { market: 'cn', platform: 'pc' }).length, 0);
});
test('dashboard validation caps real valid news and rejects no-source and malformed records', () => {
  assert.throws(() => normalizeDashboard({ schemaVersion: 1, dataDate: '2026-09-23' }));
  const items = Array.from({ length: 60 }, (_, i) => article({ id: `n-${i}` }));
  const data = normalizeDashboard(fixture({ news: [null, {}, article({ id: 'unsafe', sources: [{ url: 'javascript:x' }] }), ...items] }));
  assert.equal(data.news.length, 30);
  assert.equal(data.news[0].id, 'n-0');
  assert.equal(normalizeDashboard(fixture({ news: [article(), article()] })).news.length, 1);
  assert.deepEqual(normalizeDashboard(fixture()).news, []);
});
test('unknown categories are preserved rather than forcibly classified', () => {
  assert.deepEqual(normalizeDashboard(fixture({ news: [article({ categories: ['尚未归类的事件'] })] })).news[0].categories, ['尚未归类的事件']);
});
test('rankings cap each source/platform/metric at twenty and preserve missing versus zero', () => {
  const board = { id: 'one', platform: 'pc', metric: 'commercial', source: { id: 'test-source', name: '测试' }, items: Array.from({ length: 24 }, (_, i) => ({ name: `测试${i}`, rank: i + 1, value: i === 0 ? null : 0 })) };
  const result = normalizeDashboard(fixture({ rankings: [board, { ...board, id: 'two' }, { ...board, platform: 'mobile', id: 'three' }] })).rankings;
  assert.equal(result[0].items.length, 20);
  assert.equal(result[1].items.length, 0);
  assert.equal(result[2].items.length, 20);
  assert.equal(result[0].items[0].value, null);
  assert.equal(result[0].items[1].value, 0);
});
test('movements enforce mobile four / pc two / total six without filling another platform', () => {
  const rows = ['pc', 'mobile'].flatMap((platform) => Array.from({ length: 8 }, (_, i) => ({ id: `${platform}-${i}`, gameId: `${platform}-${i}`, platform })));
  const result = limitMovements(rows);
  assert.equal(result.length, 6);
  assert.equal(result.filter((item) => item.platform === 'pc').length, 2);
  assert.equal(result.filter((item) => item.platform === 'mobile').length, 4);
  assert.equal(limitMovements(rows.filter((item) => item.platform === 'pc')).length, 2);
  assert.equal(limitMovements([{ id: 'fake', platform: 'toString' }]).length, 0);
  assert.equal(limitMovements([{ id: 'a', gameId: 'same', platform: 'pc' }, { id: 'b', gameId: 'same', platform: 'mobile' }]).length, 1);
});
test('movement normalization never manufactures feedback or positive balance', () => {
  const result = normalizeDashboard(fixture({ movements: [{ id: 'a', platform: 'pc', positive: [], negative: [{ text: '单条测试反馈', sourceUrl: 'javascript:x' }] }] })).movements[0];
  assert.deepEqual(result.positive, []);
  assert.equal(result.insight, '');
  assert.equal(result.negative[0].sourceUrl, null);
});
test('data state distinguishes unavailable, partial, empty, stale, and explicit archive', () => {
  assert.equal(dataState(null).label, '数据不可用');
  assert.equal(dataState(fixture({ status: 'partial' }), null, '2026-09-23').label, '部分覆盖');
  assert.equal(dataState(fixture(), null, '2026-09-23').label, '暂无新内容');
  assert.equal(dataState(fixture(), null, '2026-09-24').label, '旧快照');
  assert.equal(dataState(fixture({ status: 'ok', news: [article()] }), null, '2026-09-24', true).label, '归档快照');
  assert.equal(dataState(fixture({ status: 'mystery', news: [article()] }), null, '2026-09-23').label, '状态未确认');
});
test('newer failed attempt in manifest never becomes latest success', () => {
  const data = fixture({ status: 'ok', news: [article()], lastSuccessAt: '2026-09-23T01:00:00Z' });
  const manifest = { attemptedAt: '2026-09-23T02:00:00Z', status: 'failed' };
  assert.equal(dataState(data, manifest, '2026-09-23').label, '本次未取得数据');
  assert.equal(dataState(data, manifest, '2026-09-23', true).label, '归档快照');
  assert.equal(data.lastSuccessAt, '2026-09-23T01:00:00Z');
});
test('rank trends require a real earlier baseline and consistent comparison', () => {
  const item = { rank: 2, previousRank: 5, rankChange: 3, baselineAt: '2026-09-22T01:00:00Z' };
  assert.match(rankTrend(item, '2026-09-23T01:00:00Z'), /上升 3.*对比/);
  assert.equal(rankTrend({ ...item, rankChange: 99 }, '2026-09-23T01:00:00Z'), '历史数据积累中');
  assert.equal(rankTrend(item, '2026-09-21T01:00:00Z'), '历史数据积累中');
  assert.equal(rankTrend({ ...item, baselineAt: null }, '2026-09-23T01:00:00Z'), '历史数据积累中');
});
test('skills preserve curated order and require complete heat metadata', () => {
  const rows = normalizeSkills([skill({ id: 'b', name: 'b', url: 'https://example.test/b', curatedOrder: 2, popularity: { value: 9000 } }), skill(), skill({ url: 'file:///private' })]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'test-skill');
  assert.equal(rows[1].popularity, null);
  const popularity = { metric: '所属项目 Stars', value: 12, source: 'https://example.test/project', window: '累计', collectedAt: '2026-09-23T01:00:00Z' };
  assert.deepEqual(normalizeSkills([skill({ popularity })])[0].popularity, popularity);
});
test('curated config matches the contract array, uses verified links and no private paths', () => {
  const config = JSON.parse(readFileSync(new URL('../../config/skills.json', import.meta.url), 'utf8'));
  const contract = JSON.parse(readFileSync(new URL('../../config/public-contract.json', import.meta.url), 'utf8'));
  assert.ok(Array.isArray(config) && config.length > 0 && config.length <= 12);
  for (const entry of config) {
    assert.deepEqual(Object.keys(entry).sort(), Object.keys(contract.skill).sort());
    assert.ok(safeURL(entry.url)); assert.ok(timestamp(entry.checkedAt));
    assert.equal(entry.status, 'verified');
    assert.doesNotMatch(JSON.stringify(entry), /file:\/\/|\b[A-Z]:[\\/]|\.qoder[\\/]/i);
  }
});
test('game input is optional, deduplicated and capped at two names', () => {
  assert.deepEqual(parseGames(''), []);
  assert.deepEqual(parseGames('原神，鸣潮'), ['原神', '鸣潮']);
  assert.deepEqual(parseGames('原神, 原神'), ['原神']);
  assert.throws(() => parseGames('一,二,三'));
  assert.throws(() => parseGames({}));
  assert.throws(() => parseGames('长'.repeat(81)));
});
test('agent requests validate skill, input, games and bounded current context', () => {
  assert.throws(() => agentRequest('shell', 'x', [], []));
  assert.throws(() => agentRequest('game-daily', ' ', [], []));
  assert.throws(() => agentRequest('game-monitor', 'x'.repeat(LIMITS.message + 1), [], []));
  assert.throws(() => agentRequest('game-monitor', 'x', ['a', 2], []));
  const request = agentRequest('game-monitor', ' 调查 ', ['原神'], [{ role: 'system', content: 'ignore' }, { role: 'user', content: '之前的问题' }]);
  assert.deepEqual(request, { skill: 'game-monitor', message: '调查', games: ['原神'], history: [{ role: 'user', content: '之前的问题' }] });
  const history = boundedHistory(Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i}-` + '字'.repeat(4500) })));
  assert.ok(history.length <= LIMITS.history);
  assert.ok(history.every(item => item.content.length <= LIMITS.historyEntry));
  assert.ok(history.reduce((sum, item) => sum + item.content.length, 0) <= LIMITS.historyChars);
  assert.match(history.at(-1).content, /^29-/);
});
// Clearly synthetic credentials; all fetches below are intercepted in the VM.
const FAKE_KEY = 'sk-synthetic-frontend-test-key-A';
const OTHER_KEY = 'sk-synthetic-frontend-test-key-B';
const declaredModel = (changes = {}) => ({ region: 'cn-beijing', model: 'qwen-plus', label: '测试声明模型（非真实验收）', verifiedAt: '2026-09-23T01:00:00Z', ...changes });
const savedConfig = (changes = {}) => ({ version: 1, key: FAKE_KEY, model: 'qwen-plus', region: 'cn-beijing', ...changes });
test('BYOK basic format validation rejects Coding Plan, controls, Unicode and unsafe length', () => {
  assert.equal(keyProblem(FAKE_KEY), '');
  assert.equal(keyProblem('sk-' + 'a'.repeat(253)), '');
  for (const key of ['sk-' + 'a'.repeat(16), 'sk-AbCd.~+/ef012345_6789==', 'sk-' + 'a'.repeat(251) + '==']) {
    assert.equal(keyProblem(key), '');
    assert.equal(storedConfig(savedConfig({ key })).key, key);
  }
  for (const key of [`${FAKE_KEY}=middle`, `${FAKE_KEY}===`, 'sk-' + 'a'.repeat(253) + '=', 'sk-' + 'a'.repeat(15) + '=']) assert.ok(keyProblem(key));
  for (const value of [null, {}, '', 'sk-short', 'sk-sp-synthetic-coding-key', 'sk-' + 'a'.repeat(254), ` ${FAKE_KEY}`, `${FAKE_KEY}\n`, `${FAKE_KEY}汉`, `${FAKE_KEY}:secret`, `${FAKE_KEY}\u007f`]) assert.ok(keyProblem(value));
  assert.match(keyProblem('sk-sp-synthetic-coding-key'), /Coding Plan/);
});
test('models require complete valid declaration metadata, never invent defaults', () => {
  const invalid = [null, {}, declaredModel({ verifiedAt: null }), declaredModel({ verifiedAt: '2026-02-30T01:00:00Z' }), declaredModel({ verifiedAt: '2099-01-01T00:00:00Z' }), declaredModel({ label: ' ' }), declaredModel({ model: '../model' }), declaredModel({ region: 'https://evil.test' }), declaredModel({ label: FAKE_KEY })];
  assert.deepEqual(normalizeModels({ models: invalid }), []);
  assert.deepEqual(normalizeModels({ models: [declaredModel(), declaredModel()] }), [{ ...declaredModel(), inputPrice: null, outputPrice: null }]);
  const valid = normalizeModels({ models: [declaredModel({ inputPrice: 0, outputPrice: -1 })] })[0];
  assert.equal(valid.inputPrice, 0); assert.equal(valid.outputPrice, null);
});
test('stored configuration strictly whitelists version/key/model/region and rejects conversations', () => {
  assert.deepEqual(storedConfig(savedConfig()), savedConfig());
  for (const value of [null, [], savedConfig({ version: 2 }), savedConfig({ history: [] }), savedConfig({ key: 'bad' }), savedConfig({ apiBase: 'https://evil.test' })]) assert.equal(storedConfig(value), null);
  assert.notEqual(storedConfig(savedConfig()), savedConfig());
});
test('secret filter withholds split keys and request detection scans nested fields', () => {
  const filter = secretFilter(FAKE_KEY);
  assert.equal(filter.push('before ' + FAKE_KEY.slice(0, 12)), 'before ');
  assert.equal(filter.push(FAKE_KEY.slice(12) + ' after'), '[密钥已隐藏] after');
  assert.equal(filter.push('', true), '');
  assert.ok(containsSecret({ history: [{ content: FAKE_KEY }] }, FAKE_KEY));
  assert.ok(containsSecret({ games: [OTHER_KEY] }, FAKE_KEY));
  assert.equal(containsSecret({ message: 'normal' }, FAKE_KEY), false);
});
test('Bearer punctuation keys are blocked in nested input and fully hidden in streams and exports', () => {
  const key = 'sk-A.~+/_-b.~+/_-c012345==';
  assert.ok(containsSecret({ history: [{ content: key }] }));
  assert.ok(containsSecret({ url: `https://example.test/${encodeURIComponent(key)}` }));
  for (let split = 1; split < key.length; split++) {
    const filter = secretFilter(key);
    assert.equal(filter.push(key.slice(0, split)), '');
    assert.equal(filter.push(key.slice(split), true), '[密钥已隐藏]');
  }
  const output = exportMarkdown([{ role: 'assistant', content: `before ${key} after`, sources: [] }]);
  assert.doesNotMatch(output, /sk-|012345|==/);
  assert.match(output, /密钥已隐藏/);
});
test('usage validates safe integer micro-yuan, unknown never becomes zero', () => {
  assert.deepEqual(normalizeUsage({ input: 0, output: 8, cost: 1250000 }), { input: 0, output: 8, cost: 1250000 });
  assert.match(usageText({ input: 0, output: 8, cost: 1250000 }), /输入 0.*输出 8.*¥1\.250000/);
  for (const cost of [null, undefined, -1, 0.1, '100', Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.match(usageText({ cost }), /费用未知/);
  assert.match(usageText({ cost: 0 }), /¥0\.000000/);
  assert.match(apiErrorMessage(FAKE_KEY, 401), /Key 无效/);
  assert.doesNotMatch(apiErrorMessage(FAKE_KEY), /sk-/);
});
test('SSE decodes fragmented UTF8 and fragmented CRLF one byte at a time', () => {
  const events = [];
  const parser = createSSEParser((event) => events.push(event));
  const wire = ': heartbeat\r\nevent: status\r\ndata: {"message":"检索中"}\r\n\r\nevent: delta\r\ndata: {"text":"玩家观点"}\r\n\r\nevent: done\r\ndata: {}\r\n\r\n';
  for (const byte of new TextEncoder().encode(wire)) parser.push(new Uint8Array([byte]));
  parser.finish();
  assert.deepEqual(events, [{ type: 'status', message: '检索中' }, { type: 'delta', text: '玩家观点' }, { type: 'done' }]);
});
test('SSE supports multiline data, lone CR, comments, unknown events and final unterminated event', () => {
  const events = [], parser = createSSEParser((event) => events.push(event));
  parser.push(':ignore\revent: ignored\rdata: not-json\r\revent: delta\rdata: {\rdata: "text":"片段"}\r\revent: done\rdata: {}'); parser.finish();
  assert.deepEqual(events, [{ type: 'delta', text: '片段' }, { type: 'done' }]);
  assert.throws(() => parser.push('x'));
});
test('SSE defends event shapes, unsafe source URLs and oversized frames', () => {
  assert.throws(() => normalizeSSEEvent('delta', { text: {} }));
  assert.throws(() => normalizeSSEEvent('sources', { sources: {} }));
  assert.throws(() => normalizeSSEEvent('done', []));
  assert.throws(() => createSSEParser(() => {}).push('event: delta\ndata: {broken}\n\n'));
  assert.throws(() => createSSEParser(() => {}).push('x'.repeat(250001)));
  assert.deepEqual(normalizeSSEEvent('sources', { sources: [{ name: 'x', url: 'javascript:x' }] }).sources, []);
  assert.throws(() => { const parser = createSSEParser(() => {}); parser.push(new Uint8Array([0xe4])); parser.finish(); });
});
const stream = (wire) => new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(wire)); controller.close(); } });
test('SSE stream requires done and reports errors rather than silently completing', async () => {
  await assert.rejects(readSSE(stream('event: delta\ndata: {"text":"部分"}\n\n'), () => {}), /连接提前结束/);
  await assert.rejects(readSSE(stream('event: error\ndata: {"error":"evidence_unavailable","message":"原始详情不可展示"}\n\n'), () => {}), /取证失败/);
  const events = [];
  await readSSE(stream('event: delta\ndata: {"text":"完成"}\n\nevent: done\ndata: {}\n\n'), (event) => events.push(event));
  assert.equal(events.at(-1).type, 'done');
});
test('SSE stop cancels an in-flight reader and releases the stream lock', async () => {
  let cancelled = false;
  const controller = new AbortController();
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const pending = readSSE(body, () => {}, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.ok(cancelled); assert.equal(body.locked, false);
});
test('Markdown export escapes untrusted HTML and Markdown, and drops unsafe sources', () => {
  const report = exportMarkdown([{ role: 'assistant', content: '<script>alert(1)</script> [click](javascript:alert(1)) ![x](https://example.test/track)', state: '已停止', sources: [{ name: '[safe]', url: 'https://example.test/source' }, { name: 'bad', url: 'javascript:alert(1)' }] }], '2026-09-23T01:00:00Z');
  assert.match(report, /^# GameGo/); assert.match(report, /&lt;script&gt;/); assert.match(report, /状态：已停止/);
  assert.doesNotMatch(report, /<script>|\[click\]\(javascript:|!\[x\]\(/);
  assert.match(report, /<https:\/\/example.test\/source>/);
  assert.doesNotMatch(report, /- bad/);
});

// Focused DOM double, not a browser-layout claim. Parentage, select values,
// boolean attributes, event bubbling and disabled-fieldset clicks follow the DOM.
class NodeDouble {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.dataset = {}; this.events = {}; this._value = ''; this.parent = null; this.hidden = false; this.disabled = false; this.checked = false; this.selected = false; this.scrollHeight = 100; this.clientHeight = 100; this.scrollTop = 0; this._text = ''; }
  set value(value) {
    if (this.tagName === 'SELECT') this.children.filter((child) => child.tagName === 'OPTION').forEach((option) => { option.selected = option.value === String(value); });
    else this._value = String(value);
  }
  get value() { return this.tagName === 'SELECT' ? (this.children.find((child) => child.tagName === 'OPTION' && child.selected)?.value ?? '') : this._value; }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get textContent() { return this._text + this.children.map((child) => child.textContent || '').join(''); }
  set innerHTML(_) { throw new Error('Unsafe HTML sink used'); }
  append(...children) {
    for (const child of children) {
      child.remove(); this.children.push(child); child.parent = this;
      if (this.tagName === 'SELECT' && child.tagName === 'OPTION' && !this.children.some((option) => option.selected)) child.selected = true;
    }
  }
  replaceChildren(...children) { this.children.forEach((child) => { child.parent = null; }); this.children = []; this._text = ''; this.append(...children); }
  replaceWith(node) { if (this.parent) { const parent = this.parent, i = parent.children.indexOf(this); node.remove(); parent.children[i] = node; node.parent = parent; this.parent = null; } }
  setAttribute(key, value) {
    this.attrs[key] = String(value);
    if (['hidden', 'disabled', 'checked', 'selected', 'open'].includes(key)) this[key] = true;
    if (['value', 'type'].includes(key)) this[key] = String(value);
  }
  removeAttribute(key) { delete this.attrs[key]; if (['hidden', 'disabled', 'checked', 'selected', 'open'].includes(key)) this[key] = false; }
  addEventListener(type, handler) { (this.events[type] ||= []).push(handler); }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null; } }
  emit(type, fields = {}) {
    const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...fields };
    for (let node = this; node; node = node.parent) for (const handler of node.events[type] || []) handler(event);
    return event;
  }
  click() {
    for (let node = this; node; node = node.parent) if (node.disabled && (node === this || node.tagName === 'FIELDSET')) return;
    const checkbox = this.tagName === 'INPUT' && this.type === 'checkbox';
    if (checkbox) this.checked = !this.checked;
    const event = this.emit('click');
    if (checkbox && !event.defaultPrevented) { this.emit('input'); this.emit('change'); }
    if (checkbox && event.defaultPrevented) this.checked = !this.checked;
    if (this.tagName === 'BUTTON' && (this.type || 'submit') === 'submit' && !event.defaultPrevented) {
      for (let node = this.parent; node; node = node.parent) if (node.tagName === 'FORM') { node.emit('submit'); break; }
    }
  }
  scrollIntoView() { this.scrolledIntoView = true; }
  showModal() { this.open = true; } close() { this.open = false; }
}
class StorageDouble {
  constructor(initial = {}) { this.values = new Map(Object.entries(initial)); this.operations = []; this.fail = ''; }
  getItem(key) { this.operations.push(['get', key]); if (this.fail === 'get') throw new Error('synthetic storage failure'); return this.values.get(key) ?? null; }
  setItem(key, value) { this.operations.push(['set', key]); if (this.fail === 'set') throw new Error('synthetic storage failure'); this.values.set(key, String(value)); }
  removeItem(key) { this.operations.push(['remove', key]); if (this.fail === 'remove') throw new Error('synthetic storage failure'); this.values.delete(key); }
}
const html = readFileSync(new URL('../../site/index.html', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../../site/assets/app.mjs', import.meta.url), 'utf8');
async function browserDouble({ dashboard = fixture(), base = '', handler, models = [declaredModel()], storage = new StorageDouble(), confirm = true, unavailableStorage = false } = {}) {
  const nodes = new Map(), all = [], root = new NodeDouble('root'), stack = [root];
  const voidTags = new Set(['meta', 'link', 'input', 'br', 'hr', 'img']);
  for (const match of html.matchAll(/<\/?([a-z][a-z0-9-]*)\b([^>]*)>|([^<]+)/gi)) {
    if (match[3]) { const node = new NodeDouble('#text'); node.textContent = match[3]; stack.at(-1).append(node); continue; }
    if (match[0].startsWith('</')) { if (stack.at(-1).tagName === match[1].toUpperCase()) stack.pop(); continue; }
    const node = new NodeDouble(match[1]), attrs = match[2];
    for (const attr of attrs.matchAll(/([a-z][a-z-]*)(?:="([^"]*)")?/g)) {
      node.setAttribute(attr[1], attr[2] ?? '');
      if (attr[1] === 'id') nodes.set(attr[2], node);
      if (attr[1].startsWith('data-')) node.dataset[attr[1].slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = attr[2];
    }
    all.push(node); stack.at(-1).append(node);
    if (!voidTags.has(match[1])) stack.push(node);
  }
  const descendants = (node) => node.children.flatMap((child) => [child, ...descendants(child)]);
  const document = { body: all.find((node) => node.tagName === 'BODY'), hidden: false, title: '', events: {}, createElement: (tag) => new NodeDouble(tag), createTextNode: (content) => { const node = new NodeDouble('#text'); node.textContent = content; return node; }, getElementById: (id) => nodes.get(id), addEventListener(type, fn) { this.events[type] = fn; }, querySelectorAll(selector) {
    if (selector === '#category-filters input:checked') return descendants(nodes.get('category-filters')).filter((node) => node.tagName === 'INPUT' && node.checked);
    const key = selector.match(/^\[data-(.+)\]$/)?.[1]?.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    return key ? all.filter((node) => key in node.dataset) : [];
  } };
  const timers = new Map(); let timerID = 0;
  const calls = [], confirmations = [];
  const window = { events: {}, addEventListener(type, handler) { this.events[type] = handler; }, confirm(message) { confirmations.push(message); return typeof confirm === 'function' ? confirm(message) : confirm; }, get localStorage() { if (unavailableStorage) throw new Error('synthetic blocked storage'); return storage; } };
  const defaultResponse = (value, status = 200, headers) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === './config.json') return defaultResponse({ apiBase: base });
    if (url === './data/latest.json') return defaultResponse(dashboard);
    if (url === './data/manifest.json') return defaultResponse({ schemaVersion: 1, latestDate: dashboard.dataDate, dates: [dashboard.dataDate], status: dashboard.status });
    if (handler) { const response = await handler(url, options); if (response) return response; }
    if (url.endsWith('/api/models')) return defaultResponse({ models });
    return defaultResponse({ message: '测试响应：未配置路由' }, 404);
  };
  const context = vm.createContext({ ...core, document, window, location: { hash: '#news' }, navigator: {}, fetch, URL, Response, AbortController, AbortSignal, TextEncoder, Blob, console, Option: class extends NodeDouble { constructor(label, value) { super('option'); this.textContent = label; this.value = value; } }, setTimeout: (fn) => { timers.set(++timerID, fn); return timerID; }, clearTimeout: (id) => timers.delete(id), setInterval: (fn) => { timers.set(++timerID, fn); return timerID; }, clearInterval: (id) => timers.delete(id) });
  vm.runInContext(appSource.replace(/^import .* from '\.\/core\.mjs';\n/, ''), context);
  for (let i = 0; i < 8; i++) await new Promise(setImmediate);
  return { nodes, context, calls, storage, confirmations, window, timers, response: defaultResponse, run: (code) => vm.runInContext(code, context), text: (id) => nodes.get(id).textContent };
}
function configure(app, key = FAKE_KEY, remember = false, region = 'cn-beijing', model = 'qwen-plus') {
  app.nodes.get('api-key').value = key; app.nodes.get('api-key').emit('input');
  app.nodes.get('api-region').value = region; app.nodes.get('api-region').emit('change');
  app.nodes.get('api-model').value = model; app.nodes.get('api-model').emit('change');
  app.nodes.get('remember-key').checked = remember;
  app.nodes.get('save-api').click();
}
const paidCalls = (app) => app.calls.filter(({ url }) => /\/api\/(test|agent)$/.test(url));
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };

test('DOM wiring: GitHub link stays in the shared header and opens the exact project safely', async () => {
  const app = await browserDouble();
  const link = app.nodes.get('github-link');
  assert.equal(link.tagName, 'A');
  assert.equal(link.attrs.href, 'https://github.com/sayhiby0/gamego');
  assert.equal(link.attrs.target, '_blank');
  assert.deepEqual(new Set(link.attrs.rel.split(/\s+/)), new Set(['noopener', 'noreferrer']));
  assert.match(link.attrs['aria-label'], /GitHub.*GameGo.*新标签页/);
  assert.match(link.attrs.title, /GitHub.*新标签页/);
  assert.equal(link.children.find(node => node.tagName === 'SVG').attrs['aria-hidden'], 'true');
  assert.equal(link.parent.parent.tagName, 'HEADER');
  for (const view of ['news', 'rankings', 'movements', 'skills', 'assistant']) {
    app.run(`location.hash = '#${view}'; navigate()`);
    for (let node = link; node; node = node.parent) assert.equal(node.hidden, false);
  }
  const calls = app.calls.length;
  assert.equal(link.emit('click').defaultPrevented, false);
  assert.equal(app.calls.length, calls);
  assert.equal(paidCalls(app).length, 0);
});

test('DOM wiring: empty config disables paid actions, but drafts and public views remain open', async () => {
  const app = await browserDouble();
  assert.equal(app.nodes.get('send').disabled, true);
  assert.equal(app.nodes.get('test-api').disabled, true);
  assert.equal(app.nodes.get('agent-fields').disabled, false);
  assert.match(app.text('api-status'), /后端配置缺失/);
  assert.match(app.text('news-list'), /暂无可展示/);
  assert.match(app.text('coverage-list'), /原生 RSS.*RSSHub.*公开网页.*受控搜索/s);
  assert.equal(app.calls.length, 3);
  app.run("location.hash = '#assistant'; navigate()");
  assert.equal(app.nodes.get('view-assistant').hidden, false);
  assert.equal(app.nodes.get('view-news').hidden, true);
  assert.equal(app.nodes.get('overview').hidden, true);
});
test('DOM wiring: registered controlled search appears under the search coverage group', async () => {
  const app = await browserDouble({ dashboard: fixture({ coverage: [{ id: 'search-source', name: '定向搜索候选', method: 'controlled_search', status: 'not_configured', reason: '没有受控搜索服务', count: 0 }] }) });
  assert.match(app.text('coverage-summary'), /受控搜索0 \/ 1 本次有效/);
  assert.match(app.text('coverage-list'), /受控搜索 · 1 项登记/);
});
test('DOM wiring: public presets only edit an idle draft and never submit requests', async () => {
  const app = await browserDouble();
  const initial = app.calls.length;
  app.run("document.querySelectorAll('[data-preset]')[0].click()");
  assert.equal(app.nodes.get('agent-skill').value, 'game-daily');
  assert.match(app.nodes.get('agent-message').value, /发行与版本动态/);
  app.run("document.querySelectorAll('[data-preset]')[2].click()");
  assert.equal(app.nodes.get('agent-skill').value, 'game-monitor');
  assert.equal(app.nodes.get('games-label').hidden, false);
  assert.match(app.text('stream-status'), /不会自动发起请求/);
  const previous = app.nodes.get('agent-message').value;
  app.run("state.active = {}; document.querySelectorAll('[data-preset]')[1].click()");
  assert.equal(app.nodes.get('agent-message').value, previous);
  assert.equal(app.calls.length, initial);
});
test('DOM wiring: malicious news remains literal text; filters and archive failure are truthful', async () => {
  const app = await browserDouble({ dashboard: fixture({ news: [article({ title: '<img src=x onerror=alert(1)>' })] }) });
  assert.match(app.text('news-list'), /<img src=x onerror=alert\(1\)>/);
  app.nodes.get('query').value = 'not-present'; app.run('renderNews()');
  assert.match(app.text('news-list'), /没有符合筛选/);
  app.nodes.get('archive-date').value = '2026-09-23';
  await app.run('loadArchive()');
  assert.equal(app.run('state.data'), null);
  assert.match(app.text('load-notice'), /不会用最新数据冒充所选日期/);
});
test('DOM wiring: all ranking dimensions and Skills missing states remain navigable', async () => {
  const app = await browserDouble();
  for (const platform of ['pc', 'mobile']) for (const metric of ['popularity', 'reputation', 'commercial']) {
    app.run(`state.platform = '${platform}'; state.metric = '${metric}'; renderRankings()`);
    assert.match(app.text('ranking-list'), /暂无可核验数据/);
  }
  assert.match(app.text('skills-list'), /资讯与竞品研究/);
  assert.match(app.text('skills-list'), /运营与营销内容/);
  assert.match(app.text('movement-list'), /不使用固定追踪名单/);
});
test('DOM wiring: Skills hides archive notices without hiding missing latest-data errors', async () => {
  const app = await browserDouble({ handler: url => url === 'data/2026-09-23.json' ? Response.json(fixture({ notice: '历史快照说明' })) : null });
  app.nodes.get('archive-date').value = '2026-09-23';
  await app.run('loadArchive()');
  assert.match(app.text('load-notice'), /历史快照/);
  app.run("location.hash = '#skills'; navigate()");
  assert.equal(app.nodes.get('load-notice').hidden, true);
  app.run("location.hash = '#news'; navigate()");
  assert.equal(app.nodes.get('load-notice').hidden, false);
  app.run("state.latest = null; location.hash = '#skills'; navigate(); renderSkills()");
  assert.equal(app.nodes.get('load-notice').hidden, false);
  await app.run('loadPublic()');
  assert.equal(app.nodes.get('load-notice').hidden, true);
  app.run("state.latest = null; location.hash = '#assistant'; navigate()");
  assert.equal(app.nodes.get('load-notice').hidden, true);
});
test('DOM wiring: missing movement AI does not falsely claim insufficient player samples', async () => {
  const app = await browserDouble({ dashboard: fixture({ movements: [{
    id: 'movement', gameId: 'steam:570', name: 'Dota 2', platform: 'pc', status: 'partial',
    positive: [], negative: [], events: [], insight: null, sources: [],
    limitations: ['匿名有效样本99条；本次未调用模型'],
  }] }) });
  assert.match(app.text('movement-list'), /本次未生成 AI 分析/);
  assert.match(app.text('movement-list'), /匿名有效样本99条/);
  assert.doesNotMatch(app.text('movement-list'), /样本不足，暂不生成推论/);
});

const sseResponse = (wire) => new Response(wire, { headers: { 'Content-Type': 'text/event-stream' } });
const completedWire = 'event: delta\ndata: {"text":"<script>literal</script>"}\n\nevent: sources\ndata: {"sources":[{"name":"evidence","url":"https://example.test/evidence"}]}\n\nevent: usage\ndata: {"input":12,"output":7,"cost":1234}\n\nevent: done\ndata: {}\n\n';
test('DOM wiring: public model discovery, explicit BYOK, sources, usage and safe export', async () => {
  const app = await browserDouble({ base: 'https://api.example.test', handler: (url) => url.endsWith('/api/agent') ? sseResponse(completedWire) : null });
  const models = app.calls.find(({ url }) => url.endsWith('/api/models'));
  assert.equal(models.options.headers?.Authorization, undefined);
  assert.equal(models.options.credentials, 'omit');
  assert.equal(app.nodes.get('api-model').value, '');
  assert.equal(app.nodes.get('remember-key').checked, false);
  configure(app);
  assert.match(app.text('api-status'), /基本格式检查.*尚不能证明 Key 有效/);
  assert.equal(paidCalls(app).length, 0);
  await app.run("sendRequest(agentRequest('game-monitor', '测试问题', ['测试游戏'], []))");
  assert.match(app.text('chat-log'), /<script>literal<\/script>/);
  assert.match(app.text('stream-status'), /分析已完成/);
  assert.match(app.text('chat-log'), /输入 12.*输出 7.*¥0\.001234/);
  const request = paidCalls(app)[0];
  assert.equal(request.options.headers.Authorization, `Bearer ${FAKE_KEY}`);
  assert.deepEqual(JSON.parse(request.options.body), { skill: 'game-monitor', message: '测试问题', games: ['测试游戏'], history: [], region: 'cn-beijing', model: 'qwen-plus' });
  assert.equal(request.options.redirect, 'error'); assert.equal(request.options.credentials, 'omit'); assert.equal(request.options.cache, 'no-store');
  assert.equal(app.run('state.messages.at(-1).sources.length'), 1);
  assert.doesNotMatch(app.run('exportMarkdown(state.messages)'), /sk-|Authorization|Bearer/);
  assert.equal(app.nodes.get('download').disabled, false);
  app.nodes.get('clear-api').click();
  assert.equal(app.run('state.config'), null); assert.equal(app.run('state.messages.length'), 0);
});
test('DOM wiring: 401 is invalid Key, clears persisted config, never reflects upstream secrets', async () => {
  const app = await browserDouble({ base: 'https://api.example.test', handler: (url) => url.endsWith('/api/agent') ? Response.json({ error: 'unrecognized', message: `debug Authorization: Bearer ${FAKE_KEY}` }, { status: 401 }) : null });
  configure(app, FAKE_KEY, true);
  await app.run("sendRequest(agentRequest('game-daily', '测试问题', [], []))");
  assert.equal(app.run('state.config'), null); assert.equal(app.nodes.get('api-key').value, '');
  assert.equal(app.run('state.messages.length'), 0);
  assert.equal(app.storage.values.has(BYOK_STORAGE_KEY), false);
  assert.match(app.text('api-status'), /Key 无效或已撤销/);
  assert.doesNotMatch(app.text('api-status') + app.text('chat-log'), /sk-|Bearer|登录/);
  assert.equal(app.nodes.get('send').disabled, true);
  assert.equal(app.nodes.get('agent-fields').disabled, false);
});
test('DOM wiring: incomplete, future or missing model declarations cannot enable paid calls', async () => {
  for (const models of [[], [declaredModel({ verifiedAt: null })], [declaredModel({ label: '' })], [declaredModel({ verifiedAt: '2099-01-01T00:00:00Z' })]]) {
    const app = await browserDouble({ base: 'https://api.example.test', models, storage: new StorageDouble({ [BYOK_STORAGE_KEY]: JSON.stringify(savedConfig()) }) });
    configure(app);
    assert.equal(app.run('state.config'), null);
    assert.equal(app.nodes.get('send').disabled, true);
    assert.equal(app.nodes.get('test-api').disabled, true);
    assert.equal(paidCalls(app).length, 0);
    assert.equal(app.nodes.get('api-model').value, '');
  }
});
test('DOM wiring: valid date archives load their own file and mismatched dates are rejected', async () => {
  const app = await browserDouble({ handler: (url) => url === 'data/2026-09-23.json' ? Response.json(fixture({ notice: '测试归档说明', news: [article()] })) : null });
  app.nodes.get('archive-date').value = '2026-09-23';
  await app.run('loadArchive()');
  assert.equal(app.run('state.data.news.length'), 1);
  assert.match(app.text('load-notice'), /历史快照.*测试归档说明/);
  const wrong = await browserDouble({ handler: () => Response.json(fixture({ dataDate: '2026-09-22' })) });
  wrong.nodes.get('archive-date').value = '2026-09-23';
  await wrong.run('loadArchive()');
  assert.equal(wrong.run('state.data'), null);
  assert.match(wrong.text('load-notice'), /日期与请求不符/);
});
test('DOM wiring: interrupted streams retain partial text and retry remains explicit', async () => {
  let requests = 0;
  const app = await browserDouble({ base: 'https://api.example.test', handler: (url) => {
    if (url.endsWith('/api/agent')) {
      requests++;
      return new Response('event: delta\ndata: {"text":"部分分析"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    }
  } });
  configure(app);
  await app.run("sendRequest(agentRequest('game-daily', '测试问题', [], []))");
  assert.equal(requests, 1);
  assert.match(app.text('chat-log'), /部分分析/);
  assert.match(app.text('stream-status'), /连接提前结束.*可能再次计费/);
  assert.equal(app.nodes.get('retry').disabled, false);
  await app.run('sendRequest(state.lastRequest)');
  assert.equal(requests, 2);
  const bodies = app.calls.filter((call) => call.url.endsWith('/api/agent')).map((call) => JSON.parse(call.options.body));
  assert.deepEqual(bodies[0], bodies[1]);
  app.run('clearChat()');
  assert.equal(app.run('state.messages.length'), 0);
  assert.equal(app.run('state.lastRequest'), null);
});
test('DOM wiring: stop aborts a pending stream without claiming completion', async () => {
  let cancelled = false, started;
  const ready = new Promise((resolve) => { started = resolve; });
  const app = await browserDouble({ base: 'https://api.example.test', handler: (url) => {
    if (url.endsWith('/api/agent')) {
      const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('event: delta\ndata: {"text":"测试片段"}\n\n')); started(); }, cancel() { cancelled = true; } });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    }
  } });
  configure(app);
  const pending = app.run("sendRequest(agentRequest('game-daily', '测试问题', [], []))");
  await ready;
  app.nodes.get('stop').click();
  await pending;
  assert.equal(cancelled, true);
  assert.match(app.text('stream-status'), /已停止/);
  assert.equal(app.run('state.active'), null);
});
test('DOM double reflects select membership, detachment and disabled fieldset behavior', () => {
  const select = new NodeDouble('select'), option = new NodeDouble('option'); option.value = 'allowed'; select.append(option);
  assert.equal(select.value, 'allowed'); select.value = 'invented'; assert.equal(select.value, '');
  select.value = 'allowed'; assert.equal(select.value, 'allowed'); select.replaceChildren(); assert.equal(option.parent, null);
  const fieldset = new NodeDouble('fieldset'), button = new NodeDouble('button'); let clicks = 0;
  fieldset.append(button); button.addEventListener('click', () => clicks++); fieldset.disabled = true; button.click(); assert.equal(clicks, 0);
  fieldset.disabled = false; button.click(); assert.equal(clicks, 1);
});
test('DOM wiring: remember is opt-in, only config persists, restore and visibility never call a model', async () => {
  const storage = new StorageDouble({ unrelated: 'keep me' });
  const app = await browserDouble({ base: 'https://api.example.test', storage });
  configure(app);
  assert.equal(storage.values.has(BYOK_STORAGE_KEY), false);
  app.nodes.get('remember-key').click();
  assert.equal(storage.values.has(BYOK_STORAGE_KEY), false);
  app.nodes.get('save-api').click();
  assert.deepEqual(JSON.parse(storage.values.get(BYOK_STORAGE_KEY)), savedConfig());
  app.run("state.messages.push({role:'user', content:'private chat'}); clearChat()");
  assert.equal(app.run('ready()'), true);
  assert.equal(storage.values.get('unrelated'), 'keep me');
  const restored = await browserDouble({ base: 'https://api.example.test', storage });
  assert.equal(restored.run('ready()'), true);
  assert.equal(restored.nodes.get('remember-key').checked, true);
  assert.equal(restored.run('state.messages.length'), 0);
  assert.match(restored.text('storage-status'), /未发送 Key，未调用模型/);
  restored.run("if (document.events.visibilitychange) document.events.visibilitychange()");
  assert.equal(paidCalls(app).length + paidCalls(restored).length, 0);
  for (const { url, options } of restored.calls) { assert.equal(options.headers?.Authorization, undefined); assert.equal(url.includes(FAKE_KEY), false); }
  restored.nodes.get('remember-key').click(); restored.nodes.get('save-api').click();
  assert.equal(storage.values.has(BYOK_STORAGE_KEY), false);
  assert.equal(restored.run('ready()'), true);
});
test('DOM wiring: malformed stored config is never adopted, overwritten or disclosed', async () => {
  for (const raw of ['{broken', JSON.stringify(savedConfig({ history: ['secret'] })), JSON.stringify(savedConfig({ version: 9 })), JSON.stringify(savedConfig({ model: 'undeclared' }))]) {
    const storage = new StorageDouble({ [BYOK_STORAGE_KEY]: raw });
    const app = await browserDouble({ base: 'https://api.example.test', storage });
    assert.equal(app.run('state.config'), null); assert.equal(app.nodes.get('api-key').value, '');
    assert.equal(storage.values.get(BYOK_STORAGE_KEY), raw);
    assert.equal(storage.operations.some(([operation]) => operation !== 'get'), false);
    assert.doesNotMatch(app.text('storage-status'), /sk-/);
    assert.equal(paidCalls(app).length, 0);
  }
});
test('DOM wiring: storage read/write/delete and property-access failures are truthful', async () => {
  const storage = new StorageDouble({ [BYOK_STORAGE_KEY]: JSON.stringify(savedConfig()) }); storage.fail = 'get';
  const app = await browserDouble({ base: 'https://api.example.test', storage });
  assert.match(app.text('storage-status'), /无法读取/);
  storage.fail = 'set'; configure(app, OTHER_KEY, true);
  assert.equal(app.run('ready()'), true);
  assert.match(app.text('storage-status'), /写入本地存储失败.*仅本页内存/);
  assert.equal(JSON.parse(storage.values.get(BYOK_STORAGE_KEY)).key, FAKE_KEY);
  storage.fail = 'remove'; app.nodes.get('remember-key').checked = false; app.nodes.get('save-api').click();
  assert.match(app.text('storage-status'), /删除本地保存项失败/);
  assert.equal(app.run('ready()'), true);
  app.nodes.get('clear-api').click();
  assert.equal(app.run('state.config'), null); assert.equal(app.nodes.get('api-key').value, '');
  assert.match(app.text('storage-status'), /旧 Key 可能仍在浏览器/);
  const blocked = await browserDouble({ base: 'https://api.example.test', unavailableStorage: true });
  configure(blocked, FAKE_KEY, true); assert.match(blocked.text('storage-status'), /写入本地存储失败/);
  assert.equal(blocked.run('ready()'), true);
  assert.equal(paidCalls(app).length + paidCalls(blocked).length, 0);
});
test('DOM wiring: test connection requires explicit fee confirmation and exact test payload', async () => {
  const app = await browserDouble({ base: 'https://api.example.test', handler: (url) => url.endsWith('/api/test') ? Response.json({ ok: true, model: 'qwen-plus', region: 'cn-beijing', usage: { input: 9, output: 1, cost: null } }) : null });
  configure(app);
  await app.run('testConnection()');
  assert.equal(app.confirmations.length, 1); assert.match(app.confirmations[0], /可能产生少量费用/);
  assert.equal(paidCalls(app).length, 1);
  assert.deepEqual(JSON.parse(paidCalls(app)[0].options.body), { region: 'cn-beijing', model: 'qwen-plus' });
  assert.equal(paidCalls(app)[0].options.headers.Authorization, `Bearer ${FAKE_KEY}`);
  assert.match(app.text('api-status'), /测试通过.*不证明完整取证/);
  assert.match(app.text('test-usage'), /输入 9.*输出 1.*费用未知/);
  assert.equal(app.run('state.messages.length'), 0);
  const denied = await browserDouble({ base: 'https://api.example.test', confirm: false }); configure(denied);
  await denied.run('testConnection()'); assert.equal(paidCalls(denied).length, 0);
});
test('DOM wiring: edited key, model or region revokes old authorization until explicit save', async () => {
  const app = await browserDouble({ base: 'https://api.example.test', models: [declaredModel(), declaredModel({ model: 'qwen-turbo' }), declaredModel({ region: 'cn-shanghai' })] });
  for (const [id, value, event] of [['api-key', OTHER_KEY, 'input'], ['api-model', 'qwen-turbo', 'change'], ['api-region', 'cn-shanghai', 'change']]) {
    configure(app);
    app.nodes.get(id).value = value; app.nodes.get(id).emit(event);
    assert.equal(app.run('state.config'), null); assert.equal(app.nodes.get('send').disabled, true);
    await app.run("sendRequest(agentRequest('game-daily', '测试问题', [], []))");
    assert.equal(paidCalls(app).length, 0);
  }
  configure(app); app.nodes.get('api-key').value = OTHER_KEY; // Even an autofill without an input event cannot reuse the old Key.
  assert.equal(app.run('ready()'), false);
  await app.run('testConnection()'); assert.equal(paidCalls(app).length, 0);
});
test('DOM wiring: pasted credentials in question, games and history never reach chat or network', async () => {
  const app = await browserDouble({ base: 'https://api.example.test' }); configure(app);
  for (const request of [agentRequest('game-daily', FAKE_KEY, [], []), agentRequest('game-monitor', '问题', [FAKE_KEY], []), agentRequest('game-daily', '问题', [], [{ role: 'user', content: FAKE_KEY }])]) {
    app.context.syntheticRequest = request;
    await app.run('sendRequest(syntheticRequest)');
    assert.equal(app.run('state.messages.length'), 0);
    assert.match(app.text('stream-status'), /已阻止发送/);
  }
  assert.equal(paidCalls(app).length, 0);
});
test('DOM wiring: errors use fixed code/status mapping, never raw message or network detail', async () => {
  for (const [status, error, expected] of [[403, 'model_forbidden', /无调用权限/], [402, 'insufficient_balance', /余额或适用额度不足/], [429, 'rate_limited', /请求过于频繁/], [500, FAKE_KEY, /无法确认具体原因/]]) {
    const app = await browserDouble({ base: 'https://api.example.test', handler: (url) => url.endsWith('/api/agent') ? Response.json({ error, message: `raw ${FAKE_KEY}` }, { status }) : null });
    configure(app); await app.run("sendRequest(agentRequest('game-daily', '测试问题', [], []))");
    assert.match(app.text('stream-status'), expected);
    assert.equal(app.text('chat-log').includes(FAKE_KEY), false);
    assert.doesNotMatch(app.run('exportMarkdown(state.messages)'), /sk-|Bearer/);
    assert.equal(paidCalls(app).length, 1);
  }
  const app = await browserDouble({ base: 'https://api.example.test', handler: (url) => { if (url.endsWith('/api/test')) throw new TypeError(FAKE_KEY); } });
  configure(app); await app.run('testConnection()');
  assert.equal(app.text('api-status').includes(FAKE_KEY), false);
});
test('DOM wiring: split Key echoes, source URLs and SSE error details cannot leak into reports', async () => {
  const wire = `event: status\ndata: ${JSON.stringify({ message: FAKE_KEY })}\n\nevent: delta\ndata: ${JSON.stringify({ text: 'before ' + FAKE_KEY.slice(0, 10) })}\n\nevent: delta\ndata: ${JSON.stringify({ text: FAKE_KEY.slice(10) + ' after' })}\n\nevent: sources\ndata: ${JSON.stringify({ sources: [{ name: 'secret', url: 'https://example.test/' + FAKE_KEY }] })}\n\nevent: error\ndata: ${JSON.stringify({ error: 'upstream_error', message: FAKE_KEY })}\n\n`;
  const app = await browserDouble({ base: 'https://api.example.test', handler: url => url.endsWith('/api/agent') ? sseResponse(wire) : null }); configure(app);
  await app.run("sendRequest(agentRequest('game-daily', '测试问题', [], []))");
  assert.match(app.text('chat-log'), /before \[密钥已隐藏\] after/);
  assert.equal(app.run('state.messages.at(-1).sources.length'), 0);
  assert.match(app.text('stream-status'), /模型服务暂时不可用/);
  assert.doesNotMatch(app.run('exportMarkdown(state.messages)'), /sk-|Authorization|Bearer/);
  const report = exportMarkdown([{ role: 'assistant', content: FAKE_KEY, state: OTHER_KEY, sources: [{ name: 'secret', url: 'https://example.test/' + FAKE_KEY }] }]);
  assert.doesNotMatch(report, /synthetic|sk-/);
});
test('DOM wiring: storage replace/remove/clear invalidates old task and never adopts new Key', async () => {
  for (const kind of ['replace', 'remove', 'clear']) {
    let cancelled = false;
    const app = await browserDouble({ base: 'https://api.example.test', handler: url => url.endsWith('/api/agent') ? new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } }) : null });
    configure(app, FAKE_KEY, true);
    const pending = app.run("sendRequest(agentRequest('game-daily', '测试问题', [], []))"); await settle();
    app.window.events.storage({ key: kind === 'clear' ? null : BYOK_STORAGE_KEY, oldValue: kind === 'clear' ? null : JSON.stringify(savedConfig()), newValue: kind === 'replace' ? JSON.stringify(savedConfig({ key: OTHER_KEY })) : null, storageArea: app.storage });
    await pending;
    assert.equal(cancelled, true); assert.equal(app.run('state.config'), null);
    assert.equal(app.nodes.get('api-key').value, ''); assert.equal(app.run('state.messages.length'), 0);
    assert.match(app.text('api-status'), /不会自动采用新 Key/);
    assert.equal(paidCalls(app).length, 1);
  }
});
test('DOM wiring: unrelated storage changes are ignored and BFcache preserves only opt-in config', async () => {
  const app = await browserDouble({ base: 'https://api.example.test' }); configure(app, FAKE_KEY, true);
  app.window.events.storage({ key: 'unrelated', oldValue: 'a', newValue: 'b', storageArea: app.storage });
  app.window.events.storage({ key: BYOK_STORAGE_KEY, oldValue: 'a', newValue: 'b', storageArea: new StorageDouble() });
  assert.equal(app.run('ready()'), true);
  app.run("state.messages.push({role:'user',content:'private chat'})");
  app.window.events.pagehide();
  assert.equal(app.run('state.config'), null); assert.equal(app.nodes.get('api-key').value, ''); assert.equal(app.run('state.messages.length'), 0);
  assert.equal(app.storage.values.has(BYOK_STORAGE_KEY), true);
  app.window.events.pageshow({ persisted: true });
  assert.equal(app.run('ready()'), true); assert.equal(app.run('state.messages.length'), 0); assert.equal(paidCalls(app).length, 0);
  configure(app, OTHER_KEY, false); app.window.events.pagehide(); app.window.events.pageshow({ persisted: true });
  assert.equal(app.run('state.config'), null); assert.equal(app.nodes.get('api-key').value, '');
});
test('DOM wiring: request snapshots isolate concurrent pages and stale 401 cannot erase a new config', async () => {
  let finishA, finishB;
  const first = await browserDouble({ base: 'https://api.example.test', handler: url => url.endsWith('/api/agent') ? new Promise(resolve => { finishA = resolve; }) : null });
  const second = await browserDouble({ base: 'https://api.example.test', handler: url => url.endsWith('/api/agent') ? new Promise(resolve => { finishB = resolve; }) : null });
  configure(first, FAKE_KEY); configure(second, OTHER_KEY);
  const a = first.run("sendRequest(agentRequest('game-daily', 'first private question', [], []))");
  const b = second.run("sendRequest(agentRequest('game-daily', 'second private question', [], []))");
  assert.equal(first.run('state.active.credentials === state.config'), false);
  assert.equal(paidCalls(first)[0].options.headers.Authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(paidCalls(second)[0].options.headers.Authorization, `Bearer ${OTHER_KEY}`);
  configure(first, OTHER_KEY);
  finishA(Response.json({ error: 'invalid_key', message: FAKE_KEY }, { status: 401 })); finishB(sseResponse(completedWire));
  await Promise.all([a, b]);
  assert.equal(first.run('ready()'), true); assert.equal(first.run('state.messages.length'), 0);
  assert.match(second.text('chat-log'), /second private question/);
  assert.doesNotMatch(second.text('chat-log'), /first private question/);
  assert.equal(first.run('state.config.key'), OTHER_KEY);
});
test('DOM wiring: clear API cancels a connection test; delayed success cannot restore it', async () => {
  let finish;
  const app = await browserDouble({ base: 'https://api.example.test', handler: url => url.endsWith('/api/test') ? new Promise(resolve => { finish = resolve; }) : null });
  configure(app, FAKE_KEY, true);
  const pending = app.run('testConnection()');
  app.nodes.get('clear-api').click();
  assert.equal(paidCalls(app)[0].options.signal.aborted, true);
  finish(Response.json({ ok: true, model: 'qwen-plus', region: 'cn-beijing', usage: { input: 1, output: 1, cost: 1 } })); await pending;
  assert.equal(app.run('state.config'), null); assert.equal(app.run('state.active'), null);
  assert.equal(app.storage.values.has(BYOK_STORAGE_KEY), false);
  assert.doesNotMatch(app.text('api-status'), /测试通过/);
  assert.equal(app.nodes.get('api-key').value, '');
});
test('core matches backend stable error codes and direct or wrapped usage SSE', () => {
  for (const [code, expected] of [['key_invalid', /Key 无效/], ['key_type', /Coding Plan/], ['balance', /余额/], ['permission', /权限.*地域/], ['rate_limit', /频繁/], ['timeout', /超时/], ['configuration', /尚未验收/], ['usage', /费用未知/], ['output', /引用验证/]]) assert.match(apiErrorMessage(code), expected);
  assert.equal(keyProblem('sk-' + 'a'.repeat(16)), '');
  assert.ok(keyProblem('sk-' + 'a'.repeat(15)));
  const usage = { input: 3, output: 2, cost: 100 };
  assert.deepEqual(normalizeSSEEvent('usage', usage).usage, usage);
  assert.deepEqual(normalizeSSEEvent('usage', { model: 'qwen-plus', region: 'cn-beijing', usage }).usage, usage);
  assert.deepEqual(normalizeSSEEvent('usage', { input: '3', output: -2, cost: 1.2 }).usage, { input: null, output: null, cost: null });
  assert.equal(normalizeSSEEvent('done', { ok: false }).ok, false);
  assert.equal(normalizeSSEEvent('error', { message: FAKE_KEY }).message.includes(FAKE_KEY), false);
  const encoded = [...FAKE_KEY].map(char => '%' + char.charCodeAt(0).toString(16)).join('');
  assert.equal(containsSecret('https://example.test/' + encoded, FAKE_KEY), true);
  assert.doesNotMatch(exportMarkdown([{ role: 'assistant', content: 'safe', sources: [{ url: 'https://example.test/' + encoded }] }]), /example\.test/);
});
test('DOM wiring: persistence-only saves preserve conversation and clear chat preserves configuration', async () => {
  const app = await browserDouble({ base: 'https://api.example.test', handler: url => url.endsWith('/api/agent') ? sseResponse(completedWire) : null }); configure(app);
  await app.run("sendRequest(agentRequest('game-daily', '测试问题', [], []))");
  app.nodes.get('remember-key').click(); app.nodes.get('save-api').click();
  assert.equal(app.run('state.messages.length'), 2);
  app.nodes.get('remember-key').click(); app.nodes.get('save-api').click();
  assert.equal(app.run('state.messages.length'), 2); assert.equal(app.run('ready()'), true);
  assert.equal(app.storage.values.has(BYOK_STORAGE_KEY), false);
  app.nodes.get('clear-chat').click();
  assert.equal(app.run('state.messages.length'), 0); assert.equal(app.run('ready()'), true);
  assert.equal(paidCalls(app).length, 1);
});
test('DOM wiring: changing key/model/region cancels active streams without retaining old results', async () => {
  for (const [id, value, event] of [['api-key', OTHER_KEY, 'input'], ['api-model', 'qwen-turbo', 'change'], ['api-region', 'intl-singapore', 'change']]) {
    let cancelled = false;
    const app = await browserDouble({ base: 'https://api.example.test', models: [declaredModel(), declaredModel({ model: 'qwen-turbo' }), declaredModel({ region: 'intl-singapore' })], handler: url => url.endsWith('/api/agent') ? new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('event: delta\ndata: {"text":"旧配置的片段"}\n\n')); }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } }) : null });
    configure(app);
    const pending = app.run("sendRequest(agentRequest('game-daily', '测试问题', [], []))"); await settle();
    assert.match(app.text('chat-log'), /旧配置的片段/);
    app.nodes.get(id).value = value; app.nodes.get(id).emit(event); await pending;
    assert.equal(cancelled, true); assert.equal(app.run('state.config'), null); assert.equal(app.run('state.messages.length'), 0);
    assert.doesNotMatch(app.text('chat-log'), /旧配置的片段/);
    assert.equal(paidCalls(app).length, 1);
  }
});
test('DOM wiring: stream credential rejection invalidates configuration and failed done stays incomplete', async () => {
  const app = await browserDouble({ base: 'https://api.example.test', handler: url => url.endsWith('/api/agent') ? sseResponse(`event: error\ndata: ${JSON.stringify({ error: 'key_invalid', message: FAKE_KEY })}\n\n`) : null });
  configure(app, FAKE_KEY, true); await app.run("sendRequest(agentRequest('game-daily', '测试问题', [], []))");
  assert.equal(app.run('state.config'), null); assert.equal(app.storage.values.has(BYOK_STORAGE_KEY), false);
  assert.match(app.text('api-status'), /Key 无效/); assert.equal(app.text('api-status').includes(FAKE_KEY), false);
  const failed = await browserDouble({ base: 'https://api.example.test', handler: url => url.endsWith('/api/agent') ? sseResponse('event: delta\ndata: {"text":"部分正文"}\n\nevent: done\ndata: {"ok":false}\n\n') : null });
  configure(failed); await failed.run("sendRequest(agentRequest('game-daily', '测试问题', [], []))");
  assert.match(failed.text('stream-status'), /服务未确认完成/); assert.doesNotMatch(failed.text('stream-status'), /分析已完成/);
});
test('DOM wiring: failing model endpoint and mismatched test responses remain fail-closed', async () => {
  const absent = await browserDouble({ base: 'https://api.example.test', handler: url => url.endsWith('/api/models') ? Response.json({ error: 'configuration', message: FAKE_KEY }, { status: 503 }) : null });
  assert.equal(absent.nodes.get('send').disabled, true); assert.equal(paidCalls(absent).length, 0);
  assert.doesNotMatch(absent.text('api-status'), /sk-/);
  const mismatch = await browserDouble({ base: 'https://api.example.test', handler: url => url.endsWith('/api/test') ? Response.json({ ok: true, model: 'different', region: 'cn-beijing', usage: { input: 1, output: 1, cost: 1 } }) : null });
  configure(mismatch); await mismatch.run('testConnection()');
  assert.match(mismatch.text('api-status'), /不能确认连接成功/); assert.match(mismatch.text('test-usage'), /未知/);
  assert.equal(paidCalls(mismatch).length, 1);
});
test('frontend has only dedicated opt-in storage, no HTML sinks, identity flow or remote scripts', () => {
  assert.doesNotMatch(appSource, /\b(?:sessionStorage|indexedDB|innerHTML|outerHTML|insertAdjacentHTML|eval)\b|document\.write|new Function|document\.cookie|\/auth\//);
  assert.doesNotMatch(html, /<script[^>]+src="https?:|mailto:|auth-gate|auth-status|session-bar|邮箱|GitHub 登录/i);
  assert.match(html, /id="api-key" type="password" autocomplete="off"/);
  assert.match(html, /id="remember-key" type="checkbox" aria-describedby="storage-risk"/);
  assert.match(html, /同一 GitHub Pages 域名.*前缀不能隔离/);
  assert.match(html, /2026-09-24/); assert.match(html, /模型与搜索服务会接收/);
  for (const path of ['get-api-key', 'model-pricing', 'coding-plan']) assert.ok(html.includes(`https://help.aliyun.com/zh/model-studio/${path}`));
  assert.match(appSource, /credentials: 'omit'/); assert.match(appSource, /redirect: 'error'/);
});
