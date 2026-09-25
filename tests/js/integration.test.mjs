import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import worker from '../../backend/src/worker.mjs';
import { createDevelopmentServer, createLocalD1 } from '../../scripts/dev.mjs';
import { assertPublic, validateSnapshot } from '../../scripts/check-public.mjs';
import { agentRequest, readSSE } from '../../site/assets/core.mjs';

const snapshot = () => ({ schemaVersion: 1, dataDate: '2026-09-23', attemptedAt: '2026-09-23T01:00:00Z', lastSuccessAt: null, status: 'unavailable', news: [], rankings: [], movements: [], skills: [], coverage: [] });

test('public boundary rejects private fields, credentials, emails and machine paths', () => {
  assert.doesNotThrow(() => assertPublic({ notice: '助手使用访客自带密钥' }));
  assert.throws(() => assertPublic({ notice: 'private-contact@example.com' }));
  for (const value of [
    { allowlist: [] }, { nested: { token_hash: 'hashed' } }, { history: [] },
    { title: `sk-${'x'.repeat(30)}` }, { title: 'person@example.org' }, { title: 'C:\\Users\\someone\\secret' },
    { sources: [{ url: 'file:///etc/passwd' }] },
  ]) assert.throws(() => assertPublic(value));
});

test('snapshot boundary rejects silently dropped records and misleading ranking metadata', () => {
  assert.equal(validateSnapshot(snapshot()).status, 'unavailable');
  assert.throws(() => validateSnapshot({ ...snapshot(), news: [{ id: 'bad', title: 'No evidence' }] }));
  assert.throws(() => validateSnapshot({ ...snapshot(), rankings: [{ platform: 'pc', metric: 'popularity', items: [{ name: 'Game', rank: 1 }] }] }));
});

test('local D1 supports RETURNING, metadata, and atomic rollback', async () => {
  const db = createLocalD1();
  try {
    const row = await db.prepare('INSERT INTO rate_limits(id,count,expires_at) VALUES(?,?,?) RETURNING count').bind('a', 1, Date.now()).first();
    assert.equal(row.count, 1);
    await assert.rejects(db.batch([
      db.prepare('UPDATE rate_limits SET count=2 WHERE id=?').bind('a'),
      db.prepare('INSERT INTO missing_table(id) VALUES(?)').bind('bad'),
    ]));
    assert.equal(await db.prepare('SELECT count FROM rate_limits WHERE id=?').bind('a').first('count'), 1);
    const result = await db.prepare('DELETE FROM rate_limits WHERE id=? RETURNING id').bind('a').run();
    assert.equal(result.meta.changes, 1);
    assert.equal(result.results[0].id, 'a');
  } finally { db.close(); }
});

test('ephemeral development storage blocks paid public content but supports visitor limits', async () => {
  await assert.rejects(createDevelopmentServer({ port: 0, env: { CONTENT_ENABLED: 'true' } }), /内存账本不能启用计费模型/);
  const app = await createDevelopmentServer({ port: 0, env: { AGENT_ENABLED: 'true' } });
  try { assert.deepEqual(await (await fetch(`${app.origin}/api/models`)).json(), {models:[]}); }
  finally { await app.close(); }
});

test('development server exposes only site files and never leaks environment secrets', async () => {
  const app = await createDevelopmentServer({ port: 0, env: { CONTENT_API_KEY: 'private-example' } });
  try {
    const index = await fetch(app.origin);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /GameGo/);
    const script = await fetch(`${app.origin}/assets/app.mjs`);
    assert.match(script.headers.get('content-type'), /javascript/);
    assert.equal(script.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(await (await fetch(`${app.origin}/config.json`)).json(), { apiBase: app.origin });
    assert.deepEqual(await (await fetch(`${app.origin}/health`)).json(), { ok: true });
    for (const path of ['/api/agent', '/internal/content']) {
      const denied = await fetch(app.origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(denied.status, 401);
      assert.doesNotMatch(await denied.text(), /private-example/);
    }
    for (const path of ['/SPEC.md', '/package.json', '/.dev.vars', '/backend/src/worker.mjs', '/%2e%2e%2fpackage.json', '/assets/%2e%2e%2f%2e%2e%2fpackage.json', '/%00']) {
      const response = await fetch(app.origin + path);
      assert.equal(response.status, 404, path);
      assert.doesNotMatch(await response.text(), /private-example/);
    }
    assert.equal((await fetch(`${app.origin}/index.html`, { method: 'POST' })).status, 405);
    const status = await new Promise((resolve, reject) => {
      get(app.origin, { headers: { Host: 'untrusted.invalid' } }, (response) => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    });
    assert.equal(status, 403);
  } finally { await app.close(); }
});

test('development adapter bridges JSON, streaming and request cancellation to worker', async () => {
  let aborted;
  let detectAbort;
  const abortion = new Promise((resolve) => { detectAbort = resolve; });
  const worker = {
    async fetch(request, env) {
      assert.ok(env.DB);
      assert.ok(env.SITE_ORIGIN.startsWith('http://127.0.0.1:'));
      if (new URL(request.url).pathname === '/api/echo') return Response.json(await request.json());
      request.signal.addEventListener('abort', () => { aborted = true; detectAbort(); }, { once: true });
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('event: status\ndata: {"message":"testing"}\n\n')); }, cancel() {} }), { headers: { 'Content-Type': 'text/event-stream' } });
    },
  };
  const app = await createDevelopmentServer({ port: 0, worker });
  try {
    const response = await fetch(`${app.origin}/api/echo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'test' }) });
    assert.deepEqual(await response.json(), { message: 'test' });
    const controller = new AbortController();
    const stream = await fetch(`${app.origin}/api/stream`, { signal: controller.signal });
    const reader = stream.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /testing/);
    controller.abort();
    await reader.cancel().catch(() => {});
    await abortion;
    assert.equal(aborted, true);
  } finally { await app.close(); }
});

test('BYOK browser protocol crosses the HTTP adapter with isolated keys and no visitor ledger', async () => {
  const selection = {region:'cn-beijing', model:'qwen-plus'};
  const keys = ['sk-localVisitorAlpha0123456789', 'sk-localVisitorBeta01234567890'];
  const calls = [];
  const app = await createDevelopmentServer({port:0, env:{
    AGENT_ENABLED:'true', RATE_LIMIT_SECRET:'isolated-test-fingerprint-secret-0123456789',
    AGENT_MODELS_JSON:JSON.stringify([{...selection, label:'模拟模型', verifiedAt:'2026-01-01T00:00:00Z'}]),
  }, worker:{fetch(request, env, context) {
    assert.equal(request.headers.get('CF-Connecting-IP'), '127.0.0.1');
    return worker.fetch(request, {...env, PUBLIC_DATA:{schemaVersion:1, lastSuccessAt:new Date().toISOString(), rankings:[], movements:[],
      news:[{title:'游戏版本更新', summary:'新地图发布。', publishedAt:new Date().toISOString(), games:[], categories:['产品与版本'],
        sources:[{name:'模拟公开公告', url:'https://www.gcores.com/articles/1'}]}]}}, {...context, fetcher:async (url, init) => {
      assert.equal(url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
      const key = init.headers.Authorization.slice(7);
      assert.ok(keys.includes(key)); calls.push(key);
      const payload = JSON.parse(init.body);
      assert.ok(keys.every(value => !init.body.includes(value)));
      const usage = {prompt_tokens:100, completion_tokens:10, total_tokens:110};
      if (!payload.stream) return Response.json({choices:[{message:{content:'{"ok":true}'},finish_reason:'stop'}], usage});
      const text = JSON.stringify({kind:'fact', gameId:null, text:'公开公告介绍新地图。', citations:['s1']}) + '\n';
      const frames = [{choices:[{index:0,delta:{content:text},finish_reason:null}]},
        {choices:[{index:0,delta:{},finish_reason:'stop'}]}, {choices:[],usage}];
      return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n',
        {headers:{'Content-Type':'text/event-stream'}});
    }});
  }}});
  try {
    const models = await (await fetch(`${app.origin}/api/models`)).json();
    assert.equal(models.models.length, 1); assert.equal(calls.length, 0);
    const headers = key => ({'Content-Type':'application/json', Authorization:`Bearer ${key}`, 'CF-Connecting-IP':'198.51.100.99'});
    const probe = await fetch(`${app.origin}/api/test`, {method:'POST', headers:headers(keys[0]), body:JSON.stringify(selection)});
    assert.deepEqual((await probe.json()).usage, {input:100, output:10, cost:null});
    const reports = await Promise.all(keys.map(async key => {
      const response = await fetch(`${app.origin}/api/agent`, {method:'POST', headers:headers(key),
        body:JSON.stringify({...agentRequest('game-daily', '整理近期游戏版本', [], []), ...selection})});
      assert.equal(response.status, 200);
      const events = []; await readSSE(response.body, event => events.push(event));
      assert.equal(events.at(-1).ok, true);
      assert.equal(events.find(event => event.type === 'usage').usage.cost, null);
      assert.ok(events.some(event => event.type === 'delta' && event.text.includes('新地图')));
      assert.ok(keys.every(value => !JSON.stringify(events).includes(value)));
      return events;
    }));
    assert.equal(reports.length, 2); assert.equal(calls.length, 3);
    for (const table of ['usage','content_cache','job_leases','sessions']) {
      assert.equal(await app.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first('n'), 0);
    }
    const rates = JSON.stringify((await app.db.prepare('SELECT * FROM rate_limits').all()).results);
    assert.ok(keys.every(key => !rates.includes(key))); assert.ok(!rates.includes('127.0.0.1'));
  } finally { await app.close(); }
});

test('Python news and movement clients publish actual Worker output and reuse validated caches', async (t) => {
  let calls = 0;
  const DB = createLocalD1();
  t.after(() => DB.close());
  const env = {
    DB, CONTENT_SERVICE_TOKEN: 'integration-content-token-1234567890', CONTENT_ENABLED: 'true',
    CONTENT_MODEL: 'qwen-plus', CONTENT_PRICE_MODEL: 'qwen-plus', CONTENT_API_KEY: 'sk-integrationProvider4e3d2c1b8097',
    CONTENT_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', CONTENT_PRICE_VERSION: 'test-v1',
    CONTENT_INPUT_MICROS_PER_MILLION: '1000000', CONTENT_OUTPUT_MICROS_PER_MILLION: '2000000',
  };
  const app = await createDevelopmentServer({ port: 0, env, worker: {
    fetch(request, config, context) {
      return worker.fetch(request, config, { ...context, fetcher: async (_url, options) => {
        calls++;
        const material = JSON.parse(JSON.parse(options.body).messages.at(-1).content);
        const result = Array.isArray(material.evidence) ? {
          positive: material.evidence[0].kind === 'positive' ? [{ text: '该匿名样本认可新地图。', evidenceId: 'e1' }] : [], negative: [], events: [],
          insight: { text: 'AI 推论：可以关注地图体验，但单一样本不能代表整体玩家态度。', citations: ['e1'] },
        } : {
          title: '游戏发行与玩家反馈', summary: '游戏发布新版本，公告介绍发行安排。',
          insight: 'AI 推论：可以关注更新后的玩家反馈，实际效果仍未知。',
          categories: ['发行与渠道', '玩家口碑'], platforms: ['pc'], markets: ['global'], games: [],
          citations: { summary: ['s1'], insight: ['s1'] },
        };
        return Response.json({ choices: [{ message: { role: 'assistant', content: JSON.stringify(result) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 60, total_tokens: 160 } });
      } });
    },
  } });
  try {
    const source = `
import copy, http.client, json, os, sys
from unittest.mock import patch
sys.path.insert(0, 'scripts')
class LoopbackTransport(http.client.HTTPConnection):
    def __init__(self, host, port=None, timeout=70):
        assert host == 'content.unit.test'
        super().__init__('127.0.0.1', int(os.environ['TEST_BACKEND_PORT']), timeout=timeout)
patch('content_processing.http.client.HTTPSConnection', LoopbackTransport).start()
from content_processing import process_movements, process_news
from public_data import CONTRACT, UTC, BEIJING, stamp, validate_dashboard
from datetime import datetime, timedelta
now = datetime.now(UTC)
item = dict(id='integration-news', title='Steam game release', originalTitle='Steam game release',
    publishedAt=stamp(now), platforms=[], markets=[], games=[], categories=[], summary=None, insight=None,
    processing=dict(status='unavailable', reason=''),
    sources=[dict(id='source', name='Public source', url='https://www.gcores.com/articles/1')],
    _evidence='The game announced a new release.')
for attempt in range(2):
    row = copy.deepcopy(item)
    process_news([row], [])
    assert row['processing']['status'] == 'success', row['processing']
    assert row['categories'] == ['发行与渠道', '玩家口碑']
    assert set(row['processing']) == {'status', 'reason', 'contentHash'}
    data = copy.deepcopy(CONTRACT['dashboard'])
    data.update(dataDate=now.astimezone(BEIJING).date().isoformat(), attemptedAt=stamp(now),
        lastSuccessAt=stamp(now), status='partial', news=[{k:v for k,v in row.items() if not k.startswith('_')}])
    validate_dashboard(data)
movement = copy.deepcopy(CONTRACT['movement'])
movement.update(id='movement-570', gameId='steam:570', name='Dota 2', observedAt=stamp(now),
    sources=[dict(id='reviews', name='Steam limited samples', url='https://store.steampowered.com/appreviews/570?json=1')],
    positive=[dict(text=stamp(now-timedelta(days=1))+' · Anonymous sample: A great new map.',
        sourceUrl='https://store.steampowered.com/appreviews/570?json=1')])
for attempt in range(2):
    card = copy.deepcopy(movement)
    process_movements([card], now=now)
    assert card['insight'].startswith('AI 推论：'), card['limitations']
    assert card['negative'] == []
    assert 'AI 整理' in card['positive'][0]['text']
    data['movements'] = [card]
    validate_dashboard(data)
card = copy.deepcopy(movement)
card.update(positive=[], events=[dict(text=stamp(now-timedelta(hours=2))+' · Official announcement: New map.',
    sourceUrl=card['sources'][0]['url'])])
process_movements([card], now=now)
assert card['positive'] == []
assert '[e1]' in card['events'][0]['text'] and 'Official announcement' in card['events'][0]['text']
assert card['events'][0]['text'].startswith(stamp(now-timedelta(hours=2)))
assert 'AI 推论引用：[e1]' in card['limitations']
assert card['insight'].startswith('AI 推论：')
data['movements'] = [card]
validate_dashboard(data)
print(json.dumps(data, ensure_ascii=False))
`;
    const { stdout } = await promisify(execFile)('python', ['-c', source], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP,
        PYTHONIOENCODING: 'utf-8', CONTENT_PROCESS_URL: 'https://content.unit.test/internal/content',
        TEST_BACKEND_PORT: new URL(app.origin).port, CONTENT_SERVICE_TOKEN: env.CONTENT_SERVICE_TOKEN,
        CONTENT_API_KEY: env.CONTENT_API_KEY },
      timeout: 15000,
    });
    const data = JSON.parse(stdout);
    assertPublic(data);
    const snapshot = validateSnapshot(data);
    assert.equal(snapshot.news[0].processing.status, 'success');
    assert.match(snapshot.movements[0].insight, /^AI 推论：/);
    assert.match(snapshot.movements[0].events[0].text, /\[e1\]/);
    assert.ok(snapshot.movements[0].limitations.includes('AI 推论引用：[e1]'));
    assert.equal(calls, 3);
    const { results } = await app.db.prepare('SELECT status, channel FROM usage').all();
    assert.equal(results.length, 3);
    assert.ok(results.every(row => row.status === 'settled' && row.channel === 'content'));
  } finally { await app.close(); }
});
