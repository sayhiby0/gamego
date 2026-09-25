import test, {beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {cleanup} from '../../backend/src/ledger.mjs';
import {
  HttpError, requestFingerprint, constantTimeEqual, safeUrl, publicJson,
  PUBLIC_HOSTS, readJson, readLimited, rateLimit, requireOrigin, siteOrigin,
  errorResponse, publicError, modelHttpError, secureResponse, responseJson,
} from '../../backend/src/security.mjs';

beforeEach(t => {
  const blocked = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Real network is disabled in security tests'); });
  t.after(() => assert.equal(blocked.mock.callCount(), 0, 'all fetches must use explicit mocks'));
});

// Test-local D1 adapter. All statements/constraints/transactions run in SQLite.
function database(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../../backend/migrations/001_initial.sql', import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  const db = {sqlite, prepare(sql) {
    const statement = sqlite.prepare(sql);
    const wrap = args => ({
      bind:(...values) => wrap(values),
      first:async () => statement.get(...args) ?? null,
      all:async () => ({results:statement.all(...args)}),
      _run:() => ({meta:{changes:Number(statement.run(...args).changes)}}),
      run:async () => wrap(args)._run(),
    });
    return wrap([]);
  }, async batch(statements) {
    sqlite.exec('BEGIN IMMEDIATE');
    try { const results = statements.map(statement => statement._run()); sqlite.exec('COMMIT'); return results; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  }};
  return db;
}
const status = expected => error => error instanceof HttpError && error.status === expected;
const jsonRequest = body => new Request('https://api.example.test/api/test', {method:'POST', headers:{'Content-Type':'application/json'}, body});
const PUBLIC_URL = 'https://store.steampowered.com/appreviews/570?json=1';

test('request fingerprints are domain-separated HMAC-SHA256 over exact case-sensitive bytes', async () => {
  const secret = 'a'.repeat(32), key = 'sk-AbCdEfGh0123456789_test';
  const fingerprint = await requestFingerprint(key, secret, 'key');
  assert.equal(fingerprint, createHmac('sha256', secret).update(`key\0${key}`).digest('hex'));
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(await requestFingerprint(key, secret, 'key'), fingerprint);
  for (const value of [key.toLowerCase(), ` ${key}`, `${key} `]) assert.notEqual(await requestFingerprint(value, secret, 'key'), fingerprint);
  assert.notEqual(await requestFingerprint(key, secret, 'ip'), fingerprint);
  assert.notEqual(await requestFingerprint(key, 'b'.repeat(32), 'key'), fingerprint);
  const ip = '203.0.113.1';
  assert.equal(await requestFingerprint(ip, secret, 'ip'), createHmac('sha256', secret).update(`ip\0${ip}`).digest('hex'));
  assert.notEqual(await requestFingerprint(ip, secret, 'ip'), await requestFingerprint(ip, secret, 'key'));
});

test('fingerprinting fails closed for absent, short, non-string and oversized secrets', async () => {
  for (const secret of [undefined, null, '', 'a'.repeat(31), 1234, {}, 'a'.repeat(4097)]) {
    await assert.rejects(requestFingerprint('203.0.113.1', secret, 'ip'), status(503));
  }
  for (const size of [32, 4096]) assert.match(await requestFingerprint('sk-0123456789abcdef', 'a'.repeat(size), 'key'), /^[a-f0-9]{64}$/);
});

test('public errors use fixed codes and Chinese messages rather than exception details', async () => {
  const privateText = 'sk-AbCdEfGh0123456789_test user@example.test private-stack';
  for (const [httpStatus, code, message] of [
    [400, 'input', '请求格式无效'], [401, 'key_invalid', 'API Key 缺失或无效，请检查专用配置'],
    [403, 'permission', '来源或模型权限不允许'], [404, 'not_found', '接口不存在'],
    [429, 'rate_limit', '请求过于频繁，请稍后再试'], [500, 'service', '服务暂不可用'],
    [503, 'configuration', '服务未配置或暂不可用'],
  ]) {
    const error = new HttpError(httpStatus, privateText, privateText);
    assert.deepEqual(publicError(error), {status:httpStatus, code, message});
    const response = errorResponse(error);
    assert.equal(response.status, httpStatus);
    assert.deepEqual(await response.json(), {error:code, message});
    if (httpStatus === 401) assert.equal(response.headers.get('WWW-Authenticate'), 'Bearer');
    if (httpStatus === 429) assert.equal(response.headers.get('Retry-After'), '60');
  }
  for (const error of [new Error(privateText), {status:401, code:'key_invalid', message:privateText}, new HttpError(418, privateText)]) {
    assert.deepEqual(await errorResponse(error).json(), {error:'service', message:'服务暂不可用'});
  }
  for (const code of ['key_type', 'permission', 'balance', 'rate_limit', 'timeout', 'output', 'usage']) {
    const trusted = modelHttpError(code); trusted.message = privateText;
    const output = await errorResponse(trusted).json();
    assert.equal(output.error, code); assert.match(output.message, /[\u3400-\u9fff]/);
    assert.doesNotMatch(JSON.stringify(output), /sk-|user@example|private-stack/);
  }
  assert.equal(publicError(new HttpError(400, privateText, 'balance')).code, 'input');
});

test('constant-time comparison has correct equality for same and different lengths', async () => {
  assert.equal(await constantTimeEqual('a'.repeat(64), 'a'.repeat(64)), true);
  assert.equal(await constantTimeEqual('a'.repeat(64), 'a'.repeat(63) + 'b'), false);
  assert.equal(await constantTimeEqual('a'.repeat(64), 'a'.repeat(65)), false);
});

test('publicJson rejects SSRF, credentials, non-HTTPS, alternate ports and host suffix tricks before fetching', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; throw new Error('should not fetch'); };
  const blocked = [
    'http://store.steampowered.com/appreviews/570', 'file:///etc/passwd', 'ftp://store.steampowered.com/data',
    'https://127.0.0.1/', 'https://2130706433/', 'https://0x7f000001/', 'https://127.1/',
    'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://169.254.169.254/latest/meta-data/',
    'https://metadata.google.internal/', 'https://localhost/', 'https://foo.local/',
    'https://store.steampowered.com.evil.test/', 'https://evil.test/?url=https://store.steampowered.com',
    'https://store.steampowered.com@evil.test/', 'https://user:pass@store.steampowered.com/',
    'https://store.steampowered.com:8443/', 'https://store.steampowered.com./',
    'https://store.steampowered.com/#https://evil.test/', 'https://store.steampowered.com\\@evil.test/',
    '\nhttps://store.steampowered.com/', 'https://evil.test/', null, {},
  ];
  for (const url of blocked) await assert.rejects(publicJson(url, undefined, fetcher), status(400), String(url));
  assert.equal(calls, 0);
});

test('public host list is frozen; the fourth argument may narrow but never expand it', async () => {
  assert.equal(Object.isFrozen(PUBLIC_HOSTS), true);
  assert.throws(() => PUBLIC_HOSTS.push('evil.test'), TypeError);
  let calls = 0;
  const fetcher = async () => { calls++; return Response.json({ok:true}); };
  await assert.rejects(publicJson('https://evil.test/', undefined, fetcher, ['evil.test']), status(400));
  await assert.rejects(publicJson(PUBLIC_URL, undefined, fetcher, ['api.steampowered.com']), status(400));
  assert.deepEqual(await publicJson(PUBLIC_URL, undefined, fetcher, ['store.steampowered.com']), {ok:true});
  assert.equal(calls, 1);
});

test('public JSON fetch uses no credentials and no redirects, and cannot follow redirect responses', async () => {
  let calls = 0;
  await assert.rejects(publicJson(PUBLIC_URL, undefined, async (url, options) => {
    calls++; assert.equal(url, PUBLIC_URL); assert.equal(options.redirect, 'manual');
    assert.equal(options.credentials, 'omit'); assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers.Authorization, undefined);
    return new Response(null, {status:302, headers:{Location:'https://169.254.169.254/'}});
  }), status(502));
  const redirected = Response.json({secret:'not accepted'});
  Object.defineProperty(redirected, 'redirected', {value:true});
  await assert.rejects(publicJson(PUBLIC_URL, undefined, async () => redirected), status(502));
  const wrongURL = Response.json({secret:'not accepted'});
  Object.defineProperty(wrongURL, 'url', {value:'https://evil.test/'});
  await assert.rejects(publicJson(PUBLIC_URL, undefined, async () => wrongURL), status(502));
  assert.equal(calls, 1);
});

test('public JSON enforces announced and streamed response sizes and cancels streams', async () => {
  await assert.rejects(publicJson(PUBLIC_URL, undefined, async () => new Response('{}', {headers:{'content-length':'500001'}})), status(502));
  let cancelled = false;
  const stream = new ReadableStream({start(controller) { controller.enqueue(new Uint8Array(500_001)); }, cancel() { cancelled = true; }});
  await assert.rejects(publicJson(PUBLIC_URL, undefined, async () => new Response(stream)), status(502));
  assert.equal(cancelled, true);
});

test('public JSON rejects invalid JSON and never forwards raw network errors', async () => {
  await assert.rejects(publicJson(PUBLIC_URL, undefined, async () => new Response('<html>blocked</html>')), status(502));
  await assert.rejects(publicJson(PUBLIC_URL, undefined, async () => { throw new Error('provider-secret'); }), error => error.status === 502 && !error.message.includes('provider-secret'));
});

test('public JSON enforces its fixed timeout even if the injected fetch ignores abort', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const result = publicJson(PUBLIC_URL, undefined, () => new Promise(() => {}));
  const rejected = assert.rejects(result, status(504));
  await Promise.resolve();
  t.mock.timers.tick(12_000);
  await rejected;
});

test('public JSON deadline covers stalled response bodies and does not await cancellation', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let cancelled = false;
  const stream = new ReadableStream({cancel() { cancelled = true; return new Promise(() => {}); }});
  const result = publicJson(PUBLIC_URL, undefined, async () => new Response(stream));
  const rejected = assert.rejects(result, status(504));
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(12_000);
  await rejected;
  assert.equal(cancelled, true);
});

test('caller abort is honored before any upstream fetch', async () => {
  let calls = 0;
  await assert.rejects(publicJson(PUBLIC_URL, AbortSignal.abort(), async () => { calls++; return Response.json({}); }), status(504));
  assert.equal(calls, 0);
});

test('readJson rejects wrong media types, compression, non-object values and malformed UTF-8', async () => {
  for (const type of ['text/plain', 'application/jsonp', 'text/application/json']) {
    await assert.rejects(readJson(new Request('https://a.test/', {method:'POST', headers:{'Content-Type':type}, body:'{}'})), status(415));
  }
  await assert.rejects(readJson(new Request('https://a.test/', {method:'POST', headers:{'Content-Type':'application/json', 'Content-Encoding':'gzip'}, body:'{}'})), status(415));
  for (const body of ['[]', 'null', 'true', '1', '"hello"', '{']) await assert.rejects(readJson(jsonRequest(body)), status(400));
  await assert.rejects(readJson(new Request('https://a.test/', {method:'POST', headers:{'Content-Type':'application/json'}, body:new Uint8Array([0xff])})), status(400));
  assert.deepEqual(await readJson(jsonRequest('{"challenge":"x"}')), {challenge:'x'});
});

test('request size errors are 413 rather than upstream 502, including undeclared streaming bodies', async () => {
  await assert.rejects(readJson(jsonRequest('{"data":"' + 'x'.repeat(1000) + '"}'), 100), status(413));
  const request = new Request('https://a.test/', {method:'POST', headers:{'Content-Type':'application/json', 'Content-Length':'101'}, body:'{}'});
  await assert.rejects(readJson(request, 100), status(413));
  const stream = new ReadableStream({start(controller) { controller.enqueue(new Uint8Array(101)); controller.close(); }});
  await assert.rejects(readJson(new Request('https://a.test/', {method:'POST', headers:{'Content-Type':'application/json'}, body:stream, duplex:'half'}), 100), status(413));
  assert.equal(await readLimited(new Response('abc'), 3), 'abc');
});

test('slow request bodies time out as 408', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const request = new Request('https://a.test/', {method:'POST', headers:{'Content-Type':'application/json'}, body:new ReadableStream({}), duplex:'half'});
  const result = assert.rejects(readJson(request), status(408));
  t.mock.timers.tick(5000);
  await result;
});

test('fixed origins allow HTTPS and HTTP loopback only, not null, paths or suffix attacks', () => {
  for (const origin of ['https://site.example.test', 'http://localhost:8000', 'http://127.0.0.1:8000', 'http://[::1]:8000']) assert.equal(siteOrigin({SITE_ORIGIN:origin}), origin);
  for (const origin of [undefined, '', '*', 'null', 'https://site.example.test/', 'https://site.example.test/path', 'http://site.example.test', 'http://169.254.169.254', 'https://user:pw@site.example.test']) assert.throws(() => siteOrigin({SITE_ORIGIN:origin}), status(503));
  const env = {SITE_ORIGIN:'https://site.example.test'};
  requireOrigin(new Request('https://api.example.test'), env);
  requireOrigin(new Request('https://api.example.test', {headers:{Origin:env.SITE_ORIGIN}}), env);
  for (const origin of ['null', 'https://site.example.test.evil.test', 'https://evil.test']) assert.throws(() => requireOrigin(new Request('https://api.example.test', {headers:{Origin:origin}}), env), status(403));
});

test('security headers use exact CORS origin, no cookies and no leaked exception text', async () => {
  const env = {SITE_ORIGIN:'https://site.example.test'};
  const req = new Request('https://api.example.test', {headers:{Origin:env.SITE_ORIGIN}});
  const source = errorResponse(new HttpError(502, 'email@example.test secret stack'));
  source.headers.set('Access-Control-Allow-Origin', '*'); source.headers.set('Access-Control-Allow-Credentials', 'true'); source.headers.set('Set-Cookie', 'token=x');
  const response = secureResponse(source, req, env);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), env.SITE_ORIGIN);
  assert.equal(response.headers.get('Access-Control-Allow-Credentials'), null);
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
  assert.match(response.headers.get('Content-Security-Policy'), /default-src 'none'/);
  assert.doesNotMatch(await response.text(), /email|secret|stack/);
  const foreign = secureResponse(responseJson({}), new Request(req.url, {headers:{Origin:'https://evil.test'}}), env);
  assert.equal(foreign.headers.get('Access-Control-Allow-Origin'), null);
  const missing = secureResponse(errorResponse(new HttpError(401, 'private')), req, {});
  assert.equal(missing.status, 401); assert.equal(missing.headers.get('WWW-Authenticate'), 'Bearer');
});

test('rateLimit uses Unix milliseconds; ledger cleanup preserves live limits and removes expired ones', async t => {
  const db = database(t), now = Date.parse('2026-09-23T00:00:00Z');
  await rateLimit(db, 'test', 2, 60, now);
  assert.equal(db.sqlite.prepare('SELECT expires_at FROM rate_limits').get().expires_at, now + 60_000);
  await cleanup(db, now + 1000);
  assert.equal(db.sqlite.prepare('SELECT count FROM rate_limits').get().count, 1);
  await rateLimit(db, 'test', 2, 60, now + 1000);
  await assert.rejects(rateLimit(db, 'test', 2, 60, now + 2000), status(429));
  await rateLimit(db, 'test', 2, 60, now + 60_000);
  assert.equal(db.sqlite.prepare('SELECT count FROM rate_limits').get().count, 1);
  await cleanup(db, now + 120_000);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM rate_limits').get().n, 0);
});

test('concurrent rate-limit writes cannot exceed the quota', async t => {
  const db = database(t);
  const results = await Promise.allSettled(Array.from({length:20}, () => rateLimit(db, 'same-subject', 3)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 3);
  assert.equal(results.filter(result => result.reason?.status === 429).length, 17);
  assert.equal(db.sqlite.prepare('SELECT count FROM rate_limits').get().count, 4);
});

test('safeUrl keeps output-link validation separate from public-fetch authorization', () => {
  assert.ok(safeUrl('https://example.test/article'));
  assert.equal(safeUrl('https://127.0.0.1/'), null);
  assert.equal(safeUrl('https://www.gcores.com/', ['store.steampowered.com']), null);
});
