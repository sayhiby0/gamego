import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { ModelError, validateApiKey, modelConfig, listAgentModels, agentModelConfig, configurationHash, requestBounds, costMicros, invokeModel, checkedText } from '../../backend/src/model.mjs';
import { reserve, billingMonth } from '../../backend/src/ledger.mjs';

// Synthetic credentials and injected fetchers only; SQLite is in-memory.
const CONTENT_KEY = 'sk-MockContent_0123456789';
const AGENT_KEY = 'sk-MockAgent_0123456789';
const OTHER_KEY = 'sk-OtherMock_0123456789';
const noDb = new Proxy({}, { get() { assert.fail('BYOK must not read or write the ledger'); } });
const failsWith = code => error => error instanceof ModelError && error.code === code;
function database(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../../backend/migrations/001_initial.sql', import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  return { sqlite, prepare(sql) { const statement = sqlite.prepare(sql); return { bind(...args) { return {
    async run() { return { meta: { changes: Number(statement.run(...args).changes) } }; },
    async first() { return statement.get(...args) ?? null; },
  }; } }; } };
}
function environment(extra = {}) {
  return {
    CONTENT_ENABLED: 'true', CONTENT_MODEL: 'qwen-plus', CONTENT_API_KEY: OTHER_KEY,
    CONTENT_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    CONTENT_INPUT_MICROS_PER_MILLION: '2000000', CONTENT_OUTPUT_MICROS_PER_MILLION: '8000000',
    CONTENT_PRICE_MODEL: 'qwen-plus', CONTENT_PRICE_VERSION: 'test-1', ...extra,
  };
}
function accepted(extra = {}) {
  return { region: 'cn-beijing', model: 'qwen-plus', label: 'Qwen Plus 北京', verifiedAt: '2025-01-02T03:04:05+08:00', ...extra };
}
function agentEnvironment(items = [accepted()], extra = {}) {
  return { AGENT_ENABLED: 'true', AGENT_MODELS_JSON: JSON.stringify(items), ...extra };
}
function agentConfig(extra = {}, key = AGENT_KEY) {
  const item = accepted(extra);
  return agentModelConfig(agentEnvironment([item]), { region: item.region, model: item.model }, key);
}
const prices = { inputMicrosPerMillion: 2_000_000, outputMicrosPerMillion: 8_000_000, priceVersion: 'test-1' };
const messages = [{ role: 'system', content: '测试协议' }, { role: 'user', content: '只读取短原文。' }];
const usage = { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 };
const reply = (extra = {}) => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"summary":"测试"}' }, finish_reason: 'stop' }], usage, ...extra }), { headers: { 'Content-Type': 'application/json' } });
const frame = data => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
function streaming({ missingUsage = false, missingDone = false, text = '你好\n', reportedUsage = usage } = {}) {
  return new Response(frame({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })
    + frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    + (missingUsage ? '' : frame({ choices: [], usage: reportedUsage })) + (missingDone ? '' : frame('[DONE]')),
  { headers: { 'Content-Type': 'text/event-stream' } });
}

test('API keys have exact ASCII boundaries, are never normalized, and distinguish Coding Plan', () => {
  for (const key of [CONTENT_KEY, 'sk-' + 'a'.repeat(16), 'sk-' + 'Z_9-'.repeat(63) + 'x', 'sk-SP-' + 'a'.repeat(32)]) assert.equal(validateApiKey(key), key);
  for (const key of [undefined, null, 1, {}, '', 'sk-' + 'x'.repeat(15), 'sk-' + 'x'.repeat(254), 'SK-' + 'x'.repeat(16), 'SK-SP-' + 'a'.repeat(32), ` ${AGENT_KEY}`, `${AGENT_KEY} `, `${AGENT_KEY}\n`, `${AGENT_KEY}\r`, `${AGENT_KEY}\0`, `${AGENT_KEY}中`, `${AGENT_KEY}é`, `${AGENT_KEY}！`]) {
    assert.throws(() => validateApiKey(key), failsWith('key_invalid'));
  }
  for (const key of ['sk-sp-coding', 'sk-sp-' + 'a'.repeat(32)]) assert.throws(() => validateApiKey(key), failsWith('key_type'));
});

test('content requires an explicit key, model-bound prices and safe ordinary endpoints; old agent entry is closed', async () => {
  const env = environment({ AGENT_API_KEY: AGENT_KEY });
  const content = modelConfig(env, 'content', CONTENT_KEY);
  assert.equal(content.key, CONTENT_KEY);
  for (const key of [undefined, null, '']) assert.throws(() => modelConfig(env, 'content', key), failsWith('key_invalid'));
  assert.throws(() => modelConfig(env, 'content', 'sk-sp-coding'), failsWith('key_type'));
  assert.throws(() => modelConfig(env, 'agent', AGENT_KEY), failsWith('configuration'));
  assert.throws(() => modelConfig(env, 'other', CONTENT_KEY), failsWith('configuration'));
  for (const extra of [
    { CONTENT_ENABLED: 'false' }, { CONTENT_ENABLED: true },
    { CONTENT_BASE_URL: 'https://coding.dashscope.aliyuncs.com/v1' },
    { CONTENT_BASE_URL: 'https://127.0.0.1/compatible-mode/v1' },
    { CONTENT_BASE_URL: 'https://dashscope.aliyuncs.com.evil.test/compatible-mode/v1' },
    { CONTENT_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1?key=oops' },
    { CONTENT_BASE_URL: 'https://u:p@dashscope.aliyuncs.com/compatible-mode/v1' },
    { CONTENT_KEY_TYPE: 'coding-plan' }, { CONTENT_PROTOCOL: 'anthropic' }, { CONTENT_PROVIDER: 'other' },
    { CONTENT_MODEL: 'qwen-plus-thinking' }, { CONTENT_MODEL: 'qwq-plus' }, { CONTENT_MODEL: 'qwen-plus\n' },
    { CONTENT_MODEL: 'qwen-max' }, { CONTENT_INPUT_MICROS_PER_MILLION: undefined },
    { CONTENT_OUTPUT_MICROS_PER_MILLION: '-1' }, { CONTENT_OUTPUT_MICROS_PER_MILLION: '0.3' },
    { CONTENT_PRICE_VERSION: '' }, { CONTENT_ENABLE_SEARCH: 'true' }, { CONTENT_ENABLE_THINKING: 'true' },
    { CONTENT_MAX_OUTPUT_TOKENS: '99999999' },
  ]) assert.throws(() => modelConfig({ ...env, ...extra }, 'content', CONTENT_KEY), ModelError);
  const hash = await configurationHash(content);
  assert.equal(await configurationHash({ ...content, key: OTHER_KEY }), hash);
  assert.notEqual(await configurationHash({ ...content, outputPrice: 1 }), hash);
  assert.notEqual(await configurationHash({ ...content, model: 'qwen-max' }), hash);
});

test('neither configuration path reads legacy environment credentials', () => {
  const env = { ...environment(), ...agentEnvironment() };
  for (const name of ['CONTENT_API_KEY', 'AGENT_API_KEY']) Object.defineProperty(env, name, { get() { assert.fail('legacy credential accessed'); } });
  assert.equal(modelConfig(env, 'content', CONTENT_KEY).key, CONTENT_KEY);
  assert.equal(agentModelConfig(env, { region: 'cn-beijing', model: 'qwen-plus' }, AGENT_KEY).key, AGENT_KEY);
  assert.throws(() => modelConfig(env, 'content'), failsWith('key_invalid'));
  assert.throws(() => agentModelConfig(env, { region: 'cn-beijing', model: 'qwen-plus' }), failsWith('key_invalid'));
});

test('Agent defaults to no accepted models; safe list preserves attestations and converts only published prices', () => {
  assert.deepEqual(listAgentModels({}), []);
  assert.deepEqual(listAgentModels({ AGENT_ENABLED: 'true' }), []);
  for (const enabled of [undefined, false, true, 'false', 'TRUE']) assert.deepEqual(listAgentModels({ AGENT_ENABLED: enabled, AGENT_MODELS_JSON: '{bad' }), []);
  const items = [accepted(), accepted({ region: 'intl-singapore', ...prices }), accepted({ region: 'us-virginia', model: 'qwen-max', verifiedAt: '2024-02-29T23:59:59.123Z', ...prices })];
  assert.deepEqual(listAgentModels(agentEnvironment(items)), [items[0],
    { region: items[1].region, model: items[1].model, label: items[1].label, verifiedAt: items[1].verifiedAt, inputPrice: 2, outputPrice: 8 },
    { region: items[2].region, model: items[2].model, label: items[2].label, verifiedAt: items[2].verifiedAt, inputPrice: 2, outputPrice: 8 }]);
  const twelve = ['cn-beijing', 'intl-singapore', 'us-virginia'].flatMap(region => ['turbo', 'plus', 'max', 'flash'].map(family => accepted({ region, model: `qwen-${family}` })));
  assert.equal(listAgentModels(agentEnvironment(twelve)).length, 12);
  assert.throws(() => listAgentModels(agentEnvironment([...twelve, accepted({ model: 'qwen-plus-latest' })])), failsWith('configuration'));
});

test('Agent rejects malformed, duplicate, future, secret-bearing or unapproved list entries as a whole', () => {
  for (const raw of ['', 'null', '{}', '{', 'true', '1', '[null]', '[[]]', '[1]', ' '.repeat(32_001)]) assert.throws(() => listAgentModels({ AGENT_ENABLED: 'true', AGENT_MODELS_JSON: raw }), failsWith('configuration'));
  const changes = [
    { region: 'evil.test' }, { region: { toString: 1 } }, { region: '__proto__' }, { region: undefined },
    { model: 'qwq-plus' }, { model: 'qwen-plus-thinking' }, { model: 'qwen-vl-max' }, { model: 'qwen-plus\n' },
    { label: '' }, { label: 'x'.repeat(81) }, { label: ` ${AGENT_KEY}` }, { label: AGENT_KEY },
    { label: 'Bearer abcdefghi' }, { label: 'https://example.org' }, { label: 'example.org' }, { label: '<b>Plus</b>' }, { label: '测试\n' }, { label: '测试\u202e' },
    { verifiedAt: undefined }, { verifiedAt: '2024-01-01' }, { verifiedAt: '2024-01-01T00:00:00' },
    { verifiedAt: '2025-02-29T00:00:00Z' }, { verifiedAt: '2024-02-30T00:00:00Z' }, { verifiedAt: '2024-01-01T24:00:00Z' },
    { verifiedAt: '2024-01-01T00:00:00+24:00' }, { verifiedAt: '2024-01-01T00:00:00Z\n' },
    { verifiedAt: new Date(Date.now() + 60_000).toISOString() },
    { url: 'https://evil.test' }, { key: AGENT_KEY }, { inputMicrosPerMillion: 0 }, { priceVersion: 'v1' },
    { ...prices, outputMicrosPerMillion: undefined }, { ...prices, inputMicrosPerMillion: '2000000' },
    { ...prices, inputMicrosPerMillion: -1 }, { ...prices, outputMicrosPerMillion: 0.1 },
    { ...prices, outputMicrosPerMillion: 1_000_000_000_001 }, { ...prices, inputMicrosPerMillion: null },
    { ...prices, priceVersion: '' }, { ...prices, priceVersion: 'secret\n' },
  ];
  for (const extra of changes) assert.throws(() => listAgentModels(agentEnvironment([accepted({ region: 'us-virginia' }), accepted(extra)])), failsWith('configuration'), JSON.stringify(extra));
  assert.throws(() => listAgentModels(agentEnvironment([accepted(), accepted({ label: '重复' })])), failsWith('configuration'));
});

test('Agent configuration uses only approved region/model pairs and fixed hosts, with optional bound prices', async () => {
  const hosts = { 'cn-beijing': 'dashscope.aliyuncs.com', 'intl-singapore': 'dashscope-intl.aliyuncs.com', 'us-virginia': 'dashscope-us.aliyuncs.com' };
  for (const [region, host] of Object.entries(hosts)) {
    const config = agentConfig({ region });
    assert.equal(config.url, `https://${host}/compatible-mode/v1/chat/completions`);
    assert.equal(config.channel, 'agent'); assert.equal(config.maxOutput, 2400);
    assert.equal(config.inputPrice, null); assert.equal(config.outputPrice, null); assert.equal(config.priceVersion, null);
  }
  const config = agentConfig(prices);
  assert.equal(config.inputPrice, 2_000_000); assert.equal(config.outputPrice, 8_000_000); assert.equal(config.priceVersion, 'test-1');
  assert.equal(await configurationHash(config), await configurationHash({ ...config, key: OTHER_KEY }));
  const env = agentEnvironment([accepted()], { AGENT_BASE_URL: 'https://evil.test', AGENT_MODEL: 'unapproved', AGENT_API_KEY: OTHER_KEY });
  assert.equal(agentModelConfig(env, { region: 'cn-beijing', model: 'qwen-plus' }, AGENT_KEY).url, agentConfig().url);
  for (const selection of [null, [], {}, { region: 'cn-beijing' }, { region: 'cn-beijing', model: 'qwen-max' }, { region: 'us-virginia', model: 'qwen-plus' }, { region: 'cn-beijing', model: 'qwen-plus', url: 'https://evil.test' }, { region: 'cn-beijing', model: 'qwen-plus', keyType: 'coding-plan' }]) {
    assert.throws(() => agentModelConfig(env, selection, AGENT_KEY), failsWith('configuration'));
  }
  assert.throws(() => agentModelConfig(env, { region: 'cn-beijing', model: 'qwen-plus' }, 'sk-sp-coding'), failsWith('key_type'));
  assert.throws(() => agentModelConfig({ ...env, AGENT_ENABLED: 'false' }, { region: 'cn-beijing', model: 'qwen-plus' }, AGENT_KEY), failsWith('configuration'));
});

test('UTF-8 input ceilings include framing; integer micros round each dimension; no tools or hidden key fields', () => {
  const config = modelConfig(environment(), 'content', CONTENT_KEY);
  const bound = requestBounds(config, messages);
  assert.ok(bound.inputTokens > new TextEncoder().encode(JSON.stringify(messages)).length + 1024);
  assert.equal(costMicros(1, 1, { inputPrice: 1, outputPrice: 1 }), 2);
  assert.throws(() => costMicros(1, 1, { inputPrice: null, outputPrice: 1 }), failsWith('price'));
  assert.equal(bound.upperMicros, costMicros(bound.inputTokens, config.maxOutput, config));
  const body = JSON.parse(bound.body);
  assert.equal(body.enable_search, false); assert.equal(body.enable_thinking, false);
  assert.equal(body.max_tokens, 1200); assert.equal(body.tools, undefined); assert.equal(bound.body.includes(CONTENT_KEY), false);
  assert.throws(() => requestBounds(config, [{ role: 'user', content: '中'.repeat(24_000) }]), failsWith('input'));
  assert.throws(() => requestBounds(agentConfig(), [{ role: 'user', content: '中'.repeat(60_000) }]), failsWith('input'));
});

test('keys in messages and tampered endpoints fail before any ledger or paid request', async () => {
  for (const config of [modelConfig(environment(), 'content', CONTENT_KEY), agentConfig()]) {
    for (const input of [[{ role: 'user', content: `Key: ${config.key}` }], [{ role: 'user', content: 'hello', metadata: config.key }], [null], [], [{ role: 'tool', content: 'x' }], [{ role: 'user', content: 'x', tool_calls: [] }]]) {
      await assert.rejects(invokeModel(config, { db: noDb, messages: input, fetcher() { assert.fail('must not fetch'); } }), failsWith('input'));
    }
    for (const url of ['https://evil.test/compatible-mode/v1/chat/completions', 'https://coding.dashscope.aliyuncs.com/v1/chat/completions', `${config.url}?key=${config.key}`]) {
      await assert.rejects(invokeModel({ ...config, url }, { db: noDb, messages, fetcher() { assert.fail('must not fetch'); } }), failsWith('configuration'));
    }
  }
});

test('real SQL: exact remaining content budget reserves BEFORE fetch and settles known usage', async t => {
  const db = database(t); const config = modelConfig(environment(), 'content', CONTENT_KEY);
  const upperMicros = requestBounds(config, messages).upperMicros; const now = Date.now();
  await reserve(db, { id: 'prior', owner: 'test', model: 'qwen-plus', priceVersion: 'p', channel: 'content', month: billingMonth(now), now, upperMicros: 20_000_000 - upperMicros });
  let calls = 0;
  const result = await invokeModel(config, { db, owner: 'test', messages, fetcher: async (url, options) => {
    calls++; assert.equal(db.sqlite.prepare('SELECT SUM(charged_micros) AS n FROM usage').get().n, 20_000_000);
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit'); assert.equal(options.headers.Authorization, `Bearer ${CONTENT_KEY}`);
    assert.equal(url, config.url); assert.equal(options.body.includes(CONTENT_KEY), false); return reply();
  } });
  assert.equal(calls, 1); assert.deepEqual(result.usage, { input: 50, output: 20, cost: 260 });
  const row = db.sqlite.prepare("SELECT * FROM usage WHERE id != 'prior'").get();
  assert.equal(row.status, 'settled'); assert.equal(row.charged_micros, 260); assert.equal(row.upper_micros, upperMicros);
  assert.equal(JSON.stringify(row).includes(CONTENT_KEY), false);
});

test('real SQL: one micro beyond cap fails before fetch; BYOK never enters either budget ledger', async t => {
  const db = database(t); const config = modelConfig(environment(), 'content', CONTENT_KEY); const now = Date.now();
  await reserve(db, { id: 'prior', owner: 'test', model: 'qwen-plus', priceVersion: 'p', channel: 'content', month: billingMonth(now), now,
    upperMicros: 20_000_000 - requestBounds(config, messages).upperMicros + 1 });
  await assert.rejects(invokeModel(config, { db, owner: 'test', messages, fetcher: () => assert.fail('must not call provider') }), failsWith('budget'));
  await invokeModel(agentConfig(), { db, owner: 'test', messages, fetcher: async () => reply() });
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM usage WHERE channel='agent'").get().n, 0);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM usage').get().n, 1);
});

test('uncertain public failures and missing/malformed usage retain separate conservative ceilings', async t => {
  const db = database(t); const config = modelConfig(environment(), 'content', CONTENT_KEY);
  for (const fetcher of [
    async () => { throw new Error(`Bearer ${CONTENT_KEY} private stack`); },
    async () => new Response('private upstream body', { status: 429 }),
    async () => reply({ usage: undefined }), async () => reply({ usage: { ...usage, total_tokens: 1 } }),
    async () => reply({ usage: { ...usage, completion_tokens_details: { reasoning_tokens: 10 } } }),
    async () => reply({ usage: { ...usage, search_cost: 0 } }),
    async () => reply({ usage: { ...usage, completion_tokens: 99999, total_tokens: 100049 } }),
  ]) await assert.rejects(invokeModel(config, { db, owner: 'test', messages, fetcher }), error => error instanceof ModelError && !/MockContent|private/.test(error.message));
  const rows = db.sqlite.prepare('SELECT * FROM usage').all();
  assert.equal(rows.length, 7); assert.equal(new Set(rows.map(r => r.id)).size, 7);
  assert.ok(rows.every(row => row.charged_micros === row.upper_micros && row.status === 'unknown'));
});

test('parallel BYOK requests isolate keys, hashes, bodies and usage without needing db; maxOutput override works', async () => {
  const results = await Promise.all([AGENT_KEY, OTHER_KEY].map(async key => {
    const config = { ...agentConfig(prices, key), maxOutput: 32 };
    return invokeModel(config, { db: noDb, messages, fetcher: async (url, options) => {
      assert.equal(url, config.url); assert.equal(options.headers.Authorization, `Bearer ${key}`);
      assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
      assert.equal(options.body.includes(AGENT_KEY), false); assert.equal(options.body.includes(OTHER_KEY), false);
      assert.equal(JSON.parse(options.body).max_tokens, 32); return reply();
    } });
  }));
  assert.notEqual(results[0].requestId, results[1].requestId);
  for (const result of results) {
    assert.deepEqual(result.usage, { input: 50, output: 20, cost: 260 });
    assert.equal(result.text, '{"summary":"测试"}'); assert.equal(JSON.stringify(result).includes(AGENT_KEY), false);
  }
  await invokeModel(agentConfig(), { messages, fetcher: async () => reply() });
});

test('BYOK missing or malformed usage retains valid reports and independently trustworthy counts, never fake zero cost', async () => {
  const config = agentConfig(prices);
  const cases = [
    [undefined, null, null], [null, null, null], [[], null, null], ['oops', null, null], [{}, null, null],
    [{ prompt_tokens: 50 }, 50, null], [{ completion_tokens: 20 }, null, 20],
    [{ ...usage, prompt_tokens: '50' }, null, 20], [{ ...usage, completion_tokens: -1 }, 50, null],
    [{ ...usage, completion_tokens: 0.5 }, 50, null], [{ ...usage, prompt_tokens: 100_000 }, null, 20],
    [{ ...usage, completion_tokens: 2401 }, 50, null], [{ ...usage, total_tokens: 1 }, 50, 20],
    [{ ...usage, total_tokens: undefined }, 50, 20], [{ ...usage, search_cost: 0 }, 50, 20],
    [{ ...usage, prompt_tokens_details: [] }, 50, 20], [{ ...usage, prompt_tokens_details: { cached_tokens: 51 } }, 50, 20],
    [{ ...usage, completion_tokens_details: { reasoning_tokens: 1 } }, 50, 20],
    [{ ...usage, completion_tokens_details: { unknown_paid_tokens: 0 } }, 50, 20],
  ];
  for (const [reportedUsage, input, output] of cases) {
    const result = await invokeModel(config, { db: noDb, messages, fetcher: async () => reply({ usage: reportedUsage }) });
    assert.equal(result.text, '{"summary":"测试"}'); assert.deepEqual(result.usage, { input, output, cost: null });
  }
});

test('BYOK absent prices mean unknown cost; zero prices and supported accounting details remain trustworthy', async () => {
  const result = await invokeModel(agentConfig(), { db: noDb, messages, fetcher: async () => reply() });
  assert.deepEqual(result.usage, { input: 50, output: 20, cost: null });
  const zero = await invokeModel(agentConfig({ ...prices, inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 }), { db: noDb, messages, fetcher: async () => reply() });
  assert.deepEqual(zero.usage, { input: 50, output: 20, cost: 0 });
  const cached = await invokeModel(agentConfig(prices), { db: noDb, messages, fetcher: async () => reply({ usage: { ...usage, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 0 } } }) });
  assert.deepEqual(cached.usage, { input: 50, output: 20, cost: 260 });
});

test('public SSE forwards actual deltas, requires terminal usage and DONE and keeps conservative failures', async t => {
  const db = database(t); const config = modelConfig(environment(), 'content', CONTENT_KEY); const deltas = [];
  const result = await invokeModel(config, { db, owner: 'test', messages, fetcher: async (_url, options) => {
    assert.equal(JSON.parse(options.body).stream_options.include_usage, true); return streaming();
  }, onText: text => deltas.push(text) });
  assert.deepEqual(deltas, ['你好\n']); assert.equal(result.text, '你好\n'); assert.equal(result.usage.cost, 260);
  for (const settings of [{ missingUsage: true }, { missingDone: true }]) {
    await assert.rejects(invokeModel(config, { db, owner: 'test', messages, fetcher: async () => streaming(settings), onText() {} }));
  }
  const rows = db.sqlite.prepare('SELECT * FROM usage').all();
  assert.equal(rows[0].status, 'settled'); assert.ok(rows.slice(1).every(r => r.charged_micros === r.upper_micros));
});

test('BYOK SSE tolerates unknown usage but still requires complete output and real incremental delivery', async () => {
  for (const settings of [{ missingUsage: true }, { reportedUsage: {} }, { reportedUsage: 'bad' }, { reportedUsage: { ...usage, search_cost: 1 } }]) {
    const result = await invokeModel(agentConfig(prices), { db: noDb, messages, fetcher: async () => streaming(settings), onText() {} });
    assert.equal(result.text, '你好\n'); assert.equal(result.usage.cost, null);
  }
  await assert.rejects(invokeModel(agentConfig(), { db: noDb, messages, fetcher: async () => streaming({ missingDone: true }), onText() {} }), failsWith('provider'));
  const encoder = new TextEncoder(); let controller; const deltas = [];
  const response = new Response(new ReadableStream({ start(value) { controller = value; controller.enqueue(encoder.encode(frame({ choices: [{ index: 0, delta: { content: '先到' }, finish_reason: null }] }))); } }), { headers: { 'Content-Type': 'text/event-stream' } });
  const result = await invokeModel(agentConfig(), { db: noDb, messages, fetcher: async () => response, onText(text) {
    deltas.push(text);
    // The terminal frame does not exist until the first delta reaches the caller.
    controller.enqueue(encoder.encode(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + frame('[DONE]'))); controller.close();
  } });
  assert.deepEqual(deltas, ['先到']); assert.equal(result.text, '先到'); assert.deepEqual(result.usage, { input: null, output: null, cost: null });
});

test('SSE parser handles UTF-8 byte splits, but rejects wrong content-type and unsafe output', async () => {
  const config = agentConfig(); let output = ''; const raw = await streaming().text();
  await invokeModel(config, { db: noDb, messages, fetcher: async () => new Response(new ReadableStream({ start(controller) {
    for (const byte of new TextEncoder().encode(raw.replaceAll('\n', '\r\n'))) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } }), onText: text => { output += text; } });
  assert.equal(output, '你好\n');
  await assert.rejects(invokeModel(config, { db: noDb, messages, onText() {}, fetcher: async () => new Response(raw) }), failsWith('provider'));
  for (const delta of [{ tool_calls: [{}] }, { function_call: {} }, { reasoning_content: 'thinking' }, { refusal: 'no' }, { role: 'tool' }, { content: {} }]) {
    await assert.rejects(invokeModel(config, { db: noDb, messages, onText() {}, fetcher: async () => new Response(frame({ choices: [{ index: 0, delta, finish_reason: 'stop' }] }) + frame('[DONE]'), { headers: { 'Content-Type': 'text/event-stream' } }) }), failsWith('output'));
  }
});

test('client abort cancels a stalled upstream body; only content retains a ledger reservation', async t => {
  for (const config of [modelConfig(environment(), 'content', CONTENT_KEY), agentConfig()]) {
    const db = config.channel === 'content' ? database(t) : noDb; const controller = new AbortController();
    let ready; const opened = new Promise(resolve => { ready = resolve; }); let upstreamSignal; let cancelled = false;
    const run = invokeModel(config, { db, owner: 'test', messages, signal: controller.signal, onText() {}, fetcher: async (_url, options) => {
      upstreamSignal = options.signal; ready();
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } });
    } });
    await opened; controller.abort(new Error(`private ${config.key}`)); await assert.rejects(run, failsWith('aborted'));
    assert.equal(upstreamSignal.aborted, true); assert.equal(cancelled, true);
    if (config.channel === 'content') { const row = db.sqlite.prepare('SELECT * FROM usage').get(); assert.equal(row.charged_micros, row.upper_micros); assert.equal(row.status, 'aborted'); }
  }
});

test('pre-abort is sanitized before reservation/fetch, and late responses are cancelled', async () => {
  const controller = new AbortController(); controller.abort(new Error(`private ${AGENT_KEY}`));
  await assert.rejects(invokeModel(agentConfig(), { db: noDb, messages, signal: controller.signal, fetcher() { assert.fail('must not fetch'); } }), failsWith('aborted'));
  let resolveFetch; let ready; const opened = new Promise(resolve => { ready = resolve; }); const active = new AbortController(); let cancelled = false;
  const run = invokeModel(agentConfig(), { db: noDb, messages, signal: active.signal, fetcher: () => { ready(); return new Promise(resolve => { resolveFetch = resolve; }); } });
  await opened; active.abort(); await assert.rejects(run, failsWith('aborted'));
  resolveFetch(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await Promise.resolve(); await Promise.resolve(); assert.equal(cancelled, true);
});

test('provider timeout aborts without retry or refund, even when fetch never resolves', async t => {
  const db = database(t); const config = modelConfig(environment(), 'content', CONTENT_KEY);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let ready; const opened = new Promise(resolve => { ready = resolve; }); let signal; let calls = 0;
  const run = invokeModel(config, { db, owner: 'test', messages, fetcher: async (_url, options) => {
    calls++; signal = options.signal; ready(); return new Promise(() => {});
  } });
  await opened; t.mock.timers.tick(60000); await assert.rejects(run, failsWith('timeout'));
  assert.equal(signal.aborted, true); assert.equal(calls, 1);
  const row = db.sqlite.prepare('SELECT * FROM usage').get(); assert.equal(row.charged_micros, row.upper_micros);
});

test('BYOK deadline also bounds stalled streaming callbacks and cancels upstream', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let ready; const started = new Promise(resolve => { ready = resolve; }); let cancelled = false;
  const run = invokeModel(agentConfig(), { db: noDb, messages, fetcher: async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(frame({ choices: [{ index: 0, delta: { content: '报告' }, finish_reason: null }] })));
  }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } }), onText() { ready(); return new Promise(() => {}); } });
  await started; t.mock.timers.tick(60000); await assert.rejects(run, failsWith('timeout')); assert.equal(cancelled, true);
});

test('upstream errors have stable sanitized codes, no retries, and balance never comes from prose or quota guesses', async () => {
  const body = code => JSON.stringify({ error: { code, message: `private ${AGENT_KEY}` } });
  for (const [status, text, expected] of [
    [401, body('Arrearage'), 'key_invalid'], [403, body('Denied'), 'permission'], [402, 'anything', 'balance'], [429, body('Arrearage'), 'rate_limit'],
    [408, 'private', 'timeout'], [504, 'private', 'timeout'], [400, body('Arrearage'), 'balance'], [403, body('Arrearage'), 'balance'],
    [500, body('insufficient_quota'), 'provider'], [400, body('arrearage'), 'provider'], [400, body('someArrearage'), 'provider'],
    [400, JSON.stringify({ message: 'balance insufficient Arrearage', private: AGENT_KEY }), 'provider'],
    [400, '{invalid private', 'provider'], [400, body('Arrearage') + ' '.repeat(4097), 'provider'],
    [403, JSON.stringify({ code: 'Denied', error: { code: 'Arrearage' } }), 'permission'],
  ]) {
    let calls = 0;
    await assert.rejects(invokeModel(agentConfig(), { db: noDb, messages, fetcher: async () => { calls++; return new Response(text, { status, headers: { 'Content-Type': 'application/json' } }); } }), error => {
      assert.equal(error.code, expected); assert.ok(error instanceof ModelError);
      assert.equal(/private|MockAgent|Arrearage|预占|预算/.test(error.message), false); return true;
    });
    assert.equal(calls, 1);
  }
  await assert.rejects(invokeModel(agentConfig(), { db: noDb, messages, fetcher: async () => { throw new Error(`private ${AGENT_KEY}`); } }), failsWith('provider'));
  await assert.rejects(invokeModel(agentConfig(), { db: noDb, messages, fetcher: async () => new Response(body('Arrearage'), { status: 400 }) }), failsWith('provider'));
});

test('error-body reads are bounded and cancelled; redirects, oversized and non-JSON outputs fail closed', async () => {
  let cancelled = false;
  await assert.rejects(invokeModel(agentConfig(), { db: noDb, messages, fetcher: async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('x'.repeat(4097)));
  }, cancel() { cancelled = true; } }), { status: 400, headers: { 'Content-Type': 'application/json' } }) }), failsWith('provider'));
  assert.equal(cancelled, true);
  for (const fetcher of [
    async () => new Response('', { status: 302, headers: { Location: 'https://evil.test' } }),
    async () => { const response = reply(); Object.defineProperty(response, 'redirected', { value: true }); return response; },
    async () => { const response = reply(); Object.defineProperty(response, 'url', { value: 'https://evil.test' }); return response; },
    async () => new Response(`not JSON ${AGENT_KEY}`),
    async () => new Response('x'.repeat(100_000)),
    async () => reply({ choices: [{ message: { content: 'x'.repeat(2400 * 16 + 1) }, finish_reason: 'stop' }] }),
    async () => reply({ choices: [{ message: { content: 'truncated' }, finish_reason: 'length' }] }),
  ]) await assert.rejects(invokeModel(agentConfig(), { db: noDb, messages, fetcher }), error => error instanceof ModelError && !error.message.includes(AGENT_KEY));
});

test('model text rejects secret echoes, arbitrary links, active markup and control characters', () => {
  for (const value of ['https://evil.test/x', '[x](javascript:alert(1))', '<script>x</script>', 'key=secret-123456', 'x\ny', '//evil.test/x', 'www.evil.test', '[x]: ftp://evil.test']) assert.throws(() => checkedText(value, 1000, ['secret-123456']));
  assert.equal(checkedText('事实与推论分开。', 100), '事实与推论分开。');
  for (const value of ['person@example.org', 'sk-abcdef0123456789', 'C:\\Users\\name\\secret']) assert.throws(() => checkedText(value, 1000));
});
