import test, {beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from '../../backend/src/worker.mjs';
import {requestFingerprint} from '../../backend/src/security.mjs';

const API = 'https://api.example.test';
const KEY = 'sk-AbCdEfGh0123456789_byok';
const CONTENT_KEY = 'sk-Content0123456789_local';
const SELECTION = {region:'cn-beijing', model:'qwen-plus'};
const MODEL = {...SELECTION, label:'通义千问 Plus', verifiedAt:'2026-01-01T00:00:00Z', inputMicrosPerMillion:1000000, outputMicrosPerMillion:2000000, priceVersion:'v1'};
const AGENT_BODY = {...SELECTION, skill:'game-daily', message:'查看近期游戏资讯', games:[], history:[]};
const MODEL_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const USAGE = {prompt_tokens:100, completion_tokens:10, total_tokens:110};
const TABLES = ['usage', 'usage_monthly', 'content_cache', 'content_leases', 'auth_states', 'exchanges', 'sessions', 'allowlist'];

beforeEach(t => {
  const blocked = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Real network is disabled in BYOK worker tests'); });
  t.after(() => assert.equal(blocked.mock.callCount(), 0, 'all fetches must use explicit mocks'));
});

// Real schema, constraints, RETURNING and transactions, with test-local D1 glue.
function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../../backend/migrations/001_initial.sql', import.meta.url), 'utf8'));
  const statements = [], tasks = [], calls = [];
  const db = {sqlite, prepare(sql) {
    const statement = sqlite.prepare(sql);
    const record = args => statements.push({sql, args});
    const wrap = args => ({
      bind:(...values) => wrap(values),
      first:async () => { record(args); return statement.get(...args) ?? null; },
      all:async () => { record(args); return {results:statement.all(...args)}; },
      _run:() => { record(args); return {meta:{changes:Number(statement.run(...args).changes)}}; },
      run:async () => wrap(args)._run(),
    });
    return wrap([]);
  }, async batch(items) {
    sqlite.exec('BEGIN IMMEDIATE');
    try { const result = items.map(item => item._run()); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  }};
  const env = {DB:db, SITE_ORIGIN:'https://site.example.test', AGENT_ENABLED:'true', AGENT_MODELS_JSON:JSON.stringify([MODEL]),
    RATE_LIMIT_SECRET:'local-only-rate-limit-secret-0123456789', CONTENT_SERVICE_TOKEN:'c'.repeat(64),
    AGENT_API_KEY:'sk-Environment0123456789_unused', CONTENT_API_KEY:'sk-EnvironmentContent0123456789_unused'};
  const f = {sqlite, db, env, statements, calls, tasks};
  f.ctx = {waitUntil:promise => tasks.push(promise), fetcher:async (url, init) => {
    calls.push({url:String(url), init});
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    if (f.upstream) return f.upstream(String(url), init);
    assert.fail(`Unexpected mock fetch: ${new URL(url).origin}`);
  }};
  t.after(async () => { await Promise.allSettled(tasks); sqlite.close(); });
  return f;
}
function request(f, path, body, options = {}) {
  const headers = new Headers(options.headers);
  if (options.origin !== null) headers.set('Origin', options.origin ?? f.env.SITE_ORIGIN);
  if (options.ip !== null) headers.set('CF-Connecting-IP', options.ip ?? '203.0.113.1');
  if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
  if (body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return new Request(API + path, {method:options.method ?? (body === undefined ? 'GET' : 'POST'), headers,
    ...(body === undefined ? {} : {body:options.raw ? body : JSON.stringify(body)}), signal:options.signal});
}
const call = (f, path, body, options = {}) => worker.fetch(request(f, path, body, options), options.env ?? f.env, f.ctx);
const count = (f, table) => f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const probeReply = (extra = {}) => Response.json({choices:[{message:{content:'{"ok":true}'}, finish_reason:'stop'}], usage:USAGE, ...extra});
const parseEvents = text => text.trim().split('\n\n').filter(Boolean).map(block => ({event:/^event: (.+)$/m.exec(block)?.[1], data:JSON.parse(/^data: (.+)$/m.exec(block)[1])}));
const snapshot = () => ({schemaVersion:1, lastSuccessAt:new Date().toISOString(), rankings:[], movements:[], news:[{
  title:'测试游戏更新', summary:'发布新的版本玩法。', publishedAt:new Date().toISOString(), games:[],
  sources:[{name:'测试来源', url:'https://www.gcores.com/articles/123'}],
}]});
function streamReply() {
  const line = JSON.stringify({kind:'fact', gameId:null, text:'测试游戏发布了新玩法。', citations:['s1']}) + '\n';
  return new Response([
    {choices:[{index:0, delta:{content:line}, finish_reason:null}]},
    {choices:[{index:0, delta:{}, finish_reason:'stop'}]}, {choices:[], usage:USAGE},
  ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n', {headers:{'Content-Type':'text/event-stream'}});
}
function assertTransientOnly(f) {
  for (const table of TABLES) assert.equal(count(f, table), 0, table);
  for (const {sql} of f.statements) assert.match(sql, /\b(rate_limits|job_leases)\b/, sql);
  const persisted = JSON.stringify({statements:f.statements, rates:f.sqlite.prepare('SELECT * FROM rate_limits').all(), jobs:f.sqlite.prepare('SELECT * FROM job_leases').all()});
  for (const raw of [KEY, CONTENT_KEY, f.env.RATE_LIMIT_SECRET, f.env.AGENT_API_KEY, '203.0.113.1', AGENT_BODY.message]) assert.ok(!persisted.includes(raw), 'raw credential or request persisted');
}
async function failure(response, status, code, message) {
  assert.equal(response.status, status, await response.clone().text());
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['error', 'message']); assert.equal(body.error, code);
  if (message) assert.equal(body.message, message); else assert.match(body.message, /[\u3400-\u9fff]/);
  assert.doesNotMatch(JSON.stringify(body), /sk-|stack|private|203\.0\.113/);
  return body;
}
function configureContent(f) {
  Object.assign(f.env, {CONTENT_ENABLED:'true', CONTENT_MODEL:'qwen-plus', CONTENT_BASE_URL:'https://dashscope.aliyuncs.com/compatible-mode/v1',
    CONTENT_PRICE_MODEL:'qwen-plus', CONTENT_PRICE_VERSION:'v1', CONTENT_INPUT_MICROS_PER_MILLION:'1000000', CONTENT_OUTPUT_MICROS_PER_MILLION:'2000000'});
}
const contentInput = () => ({items:[{id:'news-1', title:'游戏版本更新', publishedAt:new Date().toISOString(), evidence:'游戏更新加入了新玩法。', sources:[{name:'测试来源', url:'https://www.gcores.com/articles/123'}]}]});
const contentReply = () => Response.json({choices:[{message:{content:JSON.stringify({title:'游戏版本更新', summary:'游戏更新加入新玩法。', insight:'AI 推论：版本活动可能促进回流，效果尚待确认。', categories:['产品与版本'], platforms:['pc'], markets:['global'], games:[], citations:{summary:['s1'], insight:['s1']}})}, finish_reason:'stop'}], usage:USAGE});
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; }

test('every former auth route is 404 for all methods, without OAuth, cookies or DB writes', async t => {
  const f = fixture(t);
  for (const path of ['/auth/start', '/auth/callback?state=old&code=old', '/auth/exchange', '/auth/me', '/auth/logout', '/auth/unknown']) {
    for (const method of ['GET', 'POST', 'PUT', 'OPTIONS']) {
      const response = await call(f, path, undefined, {method, token:KEY, origin:null});
      await failure(response, 404, 'not_found', '接口不存在');
      assert.equal(response.headers.get('Set-Cookie'), null); assert.equal(response.headers.get('Location'), null);
    }
  }
  assert.equal(f.calls.length, 0); assert.equal(f.statements.length, 0);
});

test('models are public metadata only, explicit enabled allowlist, with RMB-per-million prices', async t => {
  const f = fixture(t);
  for (const origin of [undefined, null]) {
    const response = await call(f, '/api/models', undefined, {origin, env:{...f.env, DB:undefined, RATE_LIMIT_SECRET:undefined}});
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {models:[{...SELECTION, label:MODEL.label, verifiedAt:MODEL.verifiedAt, inputPrice:1, outputPrice:2}]});
  }
  for (const patch of [{AGENT_ENABLED:'false'}, {AGENT_ENABLED:undefined}, {AGENT_MODELS_JSON:undefined}, {AGENT_MODELS_JSON:'[]'}]) {
    const response = await call(f, '/api/models', undefined, {env:{...f.env, ...patch}});
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), {models:[]});
  }
  assert.equal(f.calls.length, 0); assert.equal(f.statements.length, 0);
});

test('invalid model-list configuration fails closed without probing an upstream', async t => {
  const f = fixture(t);
  for (const list of ['{', '{}', JSON.stringify([{...MODEL, region:'evil'}]), JSON.stringify([{...MODEL, verifiedAt:'yesterday'}]),
    JSON.stringify([{...MODEL, verifiedAt:'2099-01-01T00:00:00Z'}]), JSON.stringify([{...MODEL, inputMicrosPerMillion:-1}]),
    JSON.stringify([{...MODEL, url:'https://evil.test'}]), JSON.stringify([MODEL, MODEL])]) {
    await failure(await call(f, '/api/models', undefined, {env:{...f.env, AGENT_MODELS_JSON:list}}), 503, 'configuration');
  }
  assert.equal(f.calls.length, 0); assert.equal(f.statements.length, 0);
});

test('test route uses the exact caller key, tiny fixed probe and only transient HMAC state', async t => {
  const f = fixture(t); let payload;
  f.upstream = async (url, init) => {
    assert.equal(url, MODEL_URL); assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
    payload = JSON.parse(init.body); assert.equal(count(f, 'job_leases'), 1);
    const job = f.sqlite.prepare('SELECT * FROM job_leases').get();
    assert.equal(job.owner, await requestFingerprint(KEY, f.env.RATE_LIMIT_SECRET, 'key'));
    assert.ok(job.expires_at > Date.now() && job.expires_at <= Date.now() + 120000);
    return probeReply();
  };
  const response = await call(f, '/api/test', SELECTION, {token:KEY, origin:null});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {ok:true, ...SELECTION, usage:{input:100, output:10, cost:120}});
  assert.equal(payload.max_tokens, 32); assert.equal(payload.stream, false); assert.equal(payload.tools, undefined);
  assert.equal(payload.enable_search, false); assert.equal(payload.enable_thinking, false);
  assert.equal(payload.messages.length, 1); assert.doesNotMatch(JSON.stringify(payload), /sk-|近期游戏/);
  assert.equal(f.calls.length, 1); assert.equal(count(f, 'job_leases'), 0); assertTransientOnly(f);
  const ids = f.sqlite.prepare('SELECT id FROM rate_limits').all().map(row => row.id);
  assert.ok(ids.includes(`ip:${await requestFingerprint('203.0.113.1', f.env.RATE_LIMIT_SECRET, 'ip')}`));
  assert.ok(ids.includes(`key:${await requestFingerprint(KEY, f.env.RATE_LIMIT_SECRET, 'key')}`));
});

test('only allowlisted region/model pairs route to the three fixed model hosts', async t => {
  const f = fixture(t);
  f.upstream = async () => probeReply();
  for (const [region, host] of [['cn-beijing', 'dashscope.aliyuncs.com'], ['intl-singapore', 'dashscope-intl.aliyuncs.com'], ['us-virginia', 'dashscope-us.aliyuncs.com']]) {
    f.env.AGENT_MODELS_JSON = JSON.stringify([{...MODEL, region}]);
    const response = await call(f, '/api/test', {...SELECTION, region}, {token:KEY});
    assert.equal(response.status, 200); assert.equal(new URL(f.calls.at(-1).url).hostname, host);
    for (const selected of [{region, model:'qwen-max'}, {...SELECTION, region:'cn-shanghai'}]) await failure(await call(f, '/api/test', selected, {token:KEY}), 503, 'configuration');
  }
  assert.equal(f.calls.length, 3); assertTransientOnly(f);
});

test('missing, forged and malformed credentials never fall back to environment keys', async t => {
  const f = fixture(t);
  for (const token of [undefined, 'short', 'a'.repeat(64), 'sk-' + 'a'.repeat(15), 'sk-' + 'a'.repeat(254), 'sk-é0123456789abcdef',
    `${KEY},other`, `${KEY} extra`, `SK-${'a'.repeat(16)}`, 'SK-SP-' + 'a'.repeat(20)]) {
    for (const path of ['/api/test', '/api/agent']) await failure(await call(f, path, path === '/api/test' ? SELECTION : AGENT_BODY, {token, origin:null}), 401, 'key_invalid');
  }
  await failure(await call(f, '/api/test', SELECTION, {token:'sk-sp-' + 'a'.repeat(20)}), 400, 'key_type');
  for (const headers of [{Cookie:`apiKey=${KEY}`}, {'X-API-Key':KEY}, {'X-User-Email':'forged@example.test'}]) {
    await failure(await call(f, '/api/test', SELECTION, {headers}), 401, 'key_invalid');
  }
  await failure(await call(f, `/api/test?key=${KEY}`, SELECTION, {token:KEY}), 400, 'input');
  assert.equal(f.calls.length, 0); assert.equal(f.statements.length, 0);
});

test('ordinary keys at minimum and maximum length preserve case and punctuation', async t => {
  const f = fixture(t); f.upstream = async () => probeReply();
  for (const token of ['sk-' + 'a'.repeat(16), 'sk-' + 'Z'.repeat(253), 'sk-AbCdEf012345_-6789']) {
    assert.equal((await call(f, '/api/test', SELECTION, {token})).status, 200);
    assert.equal(f.calls.at(-1).init.headers.Authorization, `Bearer ${token}`);
  }
  assertTransientOnly(f);
});

test('DB, strong rate secret, fixed origin and server IP are required even without Origin', async t => {
  const f = fixture(t);
  for (const patch of [{DB:undefined}, {RATE_LIMIT_SECRET:undefined}, {RATE_LIMIT_SECRET:'a'.repeat(31)}, {SITE_ORIGIN:undefined},
    {SITE_ORIGIN:'https://site.example.test/path'}, {SITE_ORIGIN:'http://not-loopback.test'}]) {
    await failure(await call(f, '/api/test', SELECTION, {token:KEY, origin:null, env:{...f.env, ...patch}}), 503, 'configuration');
  }
  for (const ip of [null, 'unknown', '203.0.113.1, 203.0.113.2']) {
    await failure(await call(f, '/api/test', SELECTION, {token:KEY, ip, headers:{'X-Forwarded-For':'203.0.113.2'}, origin:null}), 503, 'configuration');
  }
  await failure(await call(f, '/api/test', SELECTION, {token:KEY, headers:{'X-Content-API-Key':CONTENT_KEY}}), 503, 'configuration');
  assert.equal(f.calls.length, 0); assert.equal(f.statements.length, 0);
});

test('origin and CORS stay fixed; HTTP loopback remains available for local development', async t => {
  const f = fixture(t);
  for (const origin of ['https://evil.test', 'null', `${f.env.SITE_ORIGIN}.evil.test`]) {
    for (const [path, body] of [['/api/models', undefined], ['/api/test', SELECTION], ['/api/agent', AGENT_BODY]]) {
      const response = await call(f, path, body, {token:KEY, origin});
      await failure(response, 403, 'permission'); assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    }
  }
  const preflight = await call(f, '/api/agent', undefined, {method:'OPTIONS', headers:{'Access-Control-Request-Method':'POST', 'Access-Control-Request-Headers':'Authorization, Content-Type, Accept'}});
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), f.env.SITE_ORIGIN);
  assert.equal(preflight.headers.get('Access-Control-Allow-Credentials'), null);
  assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'POST');
  for (const [headers, status, code] of [[{'Access-Control-Request-Method':'DELETE'}, 405, 'method'],
    [{'Access-Control-Request-Method':'POST', 'Access-Control-Request-Headers':'X-Admin'}, 403, 'permission']]) {
    await failure(await call(f, '/api/agent', undefined, {method:'OPTIONS', headers}), status, code);
  }
  f.env.SITE_ORIGIN = 'http://127.0.0.1:8000'; f.upstream = async () => probeReply();
  assert.equal((await call(f, '/api/test', SELECTION, {token:KEY})).status, 200);
  assert.equal(f.calls.length, 1);
});

test('wrong methods and URL parameters fail closed; health exposes no configuration', async t => {
  const f = fixture(t);
  for (const path of ['/health', '/api/models', '/api/test', '/api/agent', '/internal/content']) {
    const response = await call(f, path, undefined, {method:'PUT'});
    await failure(response, 405, 'method'); assert.match(response.headers.get('Allow'), /OPTIONS/);
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  }
  const health = await call(f, '/health', undefined, {env:{}, origin:null});
  assert.deepEqual(await health.json(), {ok:true});
  await failure(await call(f, '/unknown'), 404, 'not_found');
  await failure(await call(f, '/api/models?model=qwen-plus'), 400, 'input');
  assert.equal(f.calls.length, 0); assert.equal(f.statements.length, 0);
});

test('malformed and oversized bodies are rejected before acquiring jobs or invoking models', async t => {
  const f = fixture(t);
  for (const [path, size] of [['/api/test', 2049], ['/api/agent', 64001]]) {
    for (const [body, options, status] of [[null, {}, 400], [[], {}, 400], ['{', {raw:true}, 400],
      [{data:'x'.repeat(size)}, {}, 413], [{}, {headers:{'Content-Type':'text/plain'}}, 415], [{}, {headers:{'Content-Encoding':'gzip'}}, 415]]) {
      await failure(await call(f, path, body, {token:KEY, ...options}), status, 'input');
    }
  }
  assert.equal(f.calls.length, 0); assert.equal(count(f, 'job_leases'), 0); assertTransientOnly(f);
});

test('probe accepts only region/model; Agent rejects unknown or secret-bearing body fields before research', async t => {
  const f = fixture(t); f.env.PUBLIC_DATA_URL = 'https://public.example.test/snapshot';
  for (const field of ['message', 'history', 'apiKey', 'baseURL', 'tools']) {
    await failure(await call(f, '/api/test', {...SELECTION, [field]:'extra'}, {token:KEY}), 400, 'input');
  }
  for (const body of [{...AGENT_BODY, identity:{subject:'github:123'}}, {...AGENT_BODY, message:`问题 ${KEY}`},
    {...AGENT_BODY, history:[{role:'user', content:`历史 sk-Other0123456789secret`}]}, {...AGENT_BODY, games:[KEY]}]) {
    await failure(await call(f, '/api/agent', body, {token:KEY}), 400, 'input');
  }
  assert.equal(f.calls.length, 0); assert.equal(count(f, 'job_leases'), 0); assertTransientOnly(f);
});

test('Key limit is 20 per minute across changing IPs, and resets exactly at expiry', async t => {
  t.mock.timers.enable({apis:['Date'], now:Date.parse('2026-09-24T00:00:00Z')});
  const f = fixture(t); f.upstream = async () => probeReply();
  for (let i = 0; i < 20; i++) assert.equal((await call(f, '/api/test', SELECTION, {token:KEY, ip:`203.0.113.${i + 1}`, origin:null})).status, 200);
  const blocked = await call(f, '/api/test', SELECTION, {token:KEY, ip:'203.0.113.99', origin:null});
  await failure(blocked, 429, 'rate_limit'); assert.equal(blocked.headers.get('Retry-After'), '60');
  assert.equal(f.calls.length, 20);
  t.mock.timers.tick(60000);
  assert.equal((await call(f, '/api/test', SELECTION, {token:KEY, origin:null})).status, 200);
  assertTransientOnly(f);
});

test('IP limit is 30 per minute across different Keys; Origin omission does not bypass it', async t => {
  const f = fixture(t); f.upstream = async () => probeReply();
  for (let i = 0; i < 30; i++) assert.equal((await call(f, '/api/test', SELECTION, {token:`sk-${String(i).padStart(16, '0')}`, origin:null})).status, 200);
  await failure(await call(f, '/api/test', SELECTION, {token:KEY, origin:null}), 429, 'rate_limit');
  assert.equal(f.calls.length, 30); assertTransientOnly(f);
});

test('Key fingerprints distinguish original case and the rate quota is shared by test and Agent', async t => {
  const f = fixture(t); f.env.PUBLIC_DATA = snapshot(); f.upstream = async (_url, init) => JSON.parse(init.body).stream ? streamReply() : probeReply();
  for (let i = 0; i < 20; i++) assert.equal((await call(f, '/api/test', SELECTION, {token:KEY, ip:`203.0.113.${i + 1}`})).status, 200);
  await failure(await call(f, '/api/agent', AGENT_BODY, {token:KEY, ip:'203.0.113.99'}), 429, 'rate_limit');
  assert.equal((await call(f, '/api/test', SELECTION, {token:KEY.toLowerCase(), ip:'203.0.113.99'})).status, 200);
  assert.equal(f.calls.length, 21); assertTransientOnly(f);
});

test('test calls occupy real jobs: one per Key and three shared globally, released on completion', {timeout:5000}, async t => {
  const f = fixture(t); const started = deferred(), gate = deferred(); let pending;
  f.upstream = async () => { if (f.calls.length === 3) started.resolve(); await gate.promise; return probeReply(); };
  const keys = [KEY, 'sk-Second0123456789_key', 'sk-Third0123456789_key'];
  try {
    pending = Promise.all(keys.map(token => call(f, '/api/test', SELECTION, {token})));
    await started.promise; assert.equal(count(f, 'job_leases'), 3);
    for (const path of ['/api/test', '/api/agent']) {
      await failure(await call(f, path, path === '/api/test' ? SELECTION : AGENT_BODY, {token:KEY}), 429, 'rate_limit');
      await failure(await call(f, path, path === '/api/test' ? SELECTION : AGENT_BODY, {token:'sk-Fourth0123456789_key'}), 429, 'rate_limit');
    }
    assert.equal(f.calls.length, 3);
  } finally { gate.resolve(); if (pending) assert.ok((await pending).every(response => response.status === 200)); }
  assert.equal(count(f, 'job_leases'), 0); assertTransientOnly(f);
});

test('provider failures, invalid probe output and cancellation release jobs with fixed sanitized errors', async t => {
  const f = fixture(t);
  for (const [upstream, status, code] of [
    [async () => { throw new Error(`${KEY} private stack`); }, 502, 'provider'],
    [async () => Response.json({error:{message:`${KEY} private`}}, {status:401}), 401, 'key_invalid'],
    [async () => Response.json({error:{message:`${KEY} private`}}, {status:429}), 429, 'rate_limit'],
    [async () => probeReply({choices:[{message:{content:'{"ok":true,"extra":"private"}'}, finish_reason:'stop'}]}), 502, 'output'],
  ]) {
    f.upstream = upstream; await failure(await call(f, '/api/test', SELECTION, {token:KEY}), status, code);
    assert.equal(count(f, 'job_leases'), 0);
  }
  const started = deferred(), controller = new AbortController(); let signal;
  f.upstream = async (_url, init) => { signal = init.signal; started.resolve(); return new Promise(() => {}); };
  const pending = call(f, '/api/test', SELECTION, {token:KEY, signal:controller.signal});
  await started.promise; controller.abort();
  await failure(await pending, 408, 'aborted'); assert.equal(signal.aborted, true);
  assert.equal(count(f, 'job_leases'), 0); assertTransientOnly(f);
});

test('unknown usage or price stays null rather than causing a probe failure or a ledger write', async t => {
  const f = fixture(t); f.upstream = async () => probeReply({usage:undefined});
  let response = await call(f, '/api/test', SELECTION, {token:KEY});
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).usage, {input:null, output:null, cost:null});
  const {inputMicrosPerMillion, outputMicrosPerMillion, priceVersion, ...unpriced} = MODEL;
  f.env.AGENT_MODELS_JSON = JSON.stringify([unpriced]); f.upstream = async () => probeReply();
  response = await call(f, '/api/test', SELECTION, {token:KEY});
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).usage, {input:100, output:10, cost:null});
  assertTransientOnly(f);
});

test('actual Agent route receives the worker-parsed task and streams sources, report, usage and done', async t => {
  const f = fixture(t); f.env.PUBLIC_DATA = snapshot();
  f.upstream = async (url, init) => {
    assert.equal(url, MODEL_URL); assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
    const payload = JSON.parse(init.body); assert.equal(payload.stream, true);
    assert.equal(JSON.parse(payload.messages[1].content).task.message, AGENT_BODY.message);
    assert.equal(count(f, 'job_leases'), 1); assert.equal(count(f, 'usage'), 0);
    return streamReply();
  };
  const response = await call(f, '/api/agent', AGENT_BODY, {token:KEY, origin:null});
  assert.equal(response.status, 200, await response.clone().text());
  assert.match(response.headers.get('Content-Type'), /text\/event-stream/);
  const output = parseEvents(await response.text());
  assert.ok(output.some(event => event.event === 'sources'));
  assert.ok(output.some(event => event.event === 'delta'));
  assert.deepEqual(output.find(event => event.event === 'usage').data, {input:100, output:10, cost:120});
  assert.equal(output.some(event => event.event === 'error'), false);
  assert.deepEqual(output.at(-1), {event:'done', data:{ok:true, cancelled:false}});
  assert.equal(f.calls.length, 1); assert.equal(count(f, 'job_leases'), 0); assertTransientOnly(f);
});

test('content requires both independent service Bearer and explicit ordinary model Key, never ENV fallback', async t => {
  const f = fixture(t); configureContent(f);
  for (const options of [{}, {token:KEY}, {token:f.env.CONTENT_SERVICE_TOKEN},
    {token:f.env.CONTENT_SERVICE_TOKEN, headers:{'X-Content-API-Key':'invalid'}},
    {token:'x'.repeat(64), headers:{'X-Content-API-Key':CONTENT_KEY}}]) {
    assert.equal((await call(f, '/internal/content', contentInput(), {origin:null, ...options})).status, 401);
  }
  await failure(await call(f, '/internal/content', contentInput(), {token:f.env.CONTENT_SERVICE_TOKEN, headers:{'X-Content-API-Key':'sk-sp-' + 'a'.repeat(20)}}), 400, 'key_type');
  f.upstream = async (url, init) => {
    assert.equal(url, MODEL_URL); assert.equal(init.headers.Authorization, `Bearer ${CONTENT_KEY}`);
    assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM usage WHERE channel='content' AND status='reserved'").get().n, 1);
    return contentReply();
  };
  const response = await call(f, '/internal/content', contentInput(), {origin:null, token:f.env.CONTENT_SERVICE_TOKEN, headers:{'X-Content-API-Key':CONTENT_KEY}});
  assert.equal(response.status, 200); assert.equal((await response.json()).items[0].processing.status, 'processed');
  assert.equal(f.calls.length, 1); assert.equal(count(f, 'job_leases'), 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM usage WHERE channel='agent'").get().n, 0);
  await failure(await call(f, '/api/test', SELECTION, {token:f.env.CONTENT_SERVICE_TOKEN}), 401, 'key_invalid');
});

test('scheduled cleanup removes expired transient BYOK state without networking', async t => {
  const f = fixture(t), now = Date.now();
  f.sqlite.prepare('INSERT INTO rate_limits VALUES (?, 1, ?)').run('ip:expired', now - 1);
  f.sqlite.prepare('INSERT INTO rate_limits VALUES (?, 1, ?)').run('ip:live', now + 60000);
  f.sqlite.prepare('INSERT INTO job_leases VALUES (?, ?, ?)').run('expired', 'a'.repeat(64), now - 1);
  f.sqlite.prepare('INSERT INTO job_leases VALUES (?, ?, ?)').run('live', 'b'.repeat(64), now + 120000);
  await worker.scheduled({}, f.env, f.ctx);
  assert.deepEqual(f.sqlite.prepare('SELECT id FROM rate_limits').all().map(row => row.id), ['ip:live']);
  assert.deepEqual(f.sqlite.prepare('SELECT id FROM job_leases').all().map(row => row.id), ['live']);
  assert.equal(f.calls.length, 0);
});
