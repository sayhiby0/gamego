import {
  HttpError, randomToken, sha256, challengeFor, identityHash, readJson,
  siteOrigin, requireOrigin, responseJson, rateLimit, fetchJsonBounded, publicError,
} from './security.mjs';

const STATE_MS = 5 * 60_000;
const EXCHANGE_MS = 60_000;
const SESSION_MS = 2 * 60 * 60_000;
const EMAIL_PAGES = 5;
const PAGE_SIZE = 100;
const HEX_TOKEN = /^[a-f0-9]{64}$/;
const ALLOWED_IDENTITY = `EXISTS (
  SELECT 1 FROM allowlist
  WHERE enabled = 1 AND email_hash IN (SELECT value FROM json_each(?))
)`;

function requireDB(env) {
  if (!env?.DB || typeof env.DB.prepare !== 'function') throw new HttpError(503, '身份服务未配置');
  return env.DB;
}

function oauthConfig(env) {
  const origin = siteOrigin(env);
  requireDB(env);
  if (typeof env.GITHUB_CLIENT_ID !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(env.GITHUB_CLIENT_ID)
      || typeof env.GITHUB_CLIENT_SECRET !== 'string' || !/^[\x21-\x7e]{16,512}$/.test(env.GITHUB_CLIENT_SECRET)
      || typeof env.IDENTITY_PEPPER !== 'string' || env.IDENTITY_PEPPER.length < 32 || env.IDENTITY_PEPPER.length > 4096) throw new HttpError(503, '身份服务未配置');
  try {
    const redirect = new URL(env.OAUTH_REDIRECT_URI);
    siteOrigin({SITE_ORIGIN:redirect.origin});
    if (typeof env.OAUTH_REDIRECT_URI !== 'string' || redirect.href !== env.OAUTH_REDIRECT_URI
        || redirect.pathname !== '/auth/callback' || redirect.search || redirect.hash || redirect.username || redirect.password) throw new Error();
    return {origin, redirect};
  } catch { throw new HttpError(503, '身份回调未配置'); }
}

function exactFields(body, fields) {
  if (Object.keys(body).length !== fields.length || fields.some(field => !Object.hasOwn(body, field))) throw new HttpError(400, '请求字段无效');
}
function validChallenge(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  // SHA-256 base64url has two zero padding bits; reject non-canonical aliases.
  return /^[AEIMQUYcgkosw048]$/.test(value.at(-1));
}
function validEmail(value) {
  return typeof value === 'string' && value.length <= 254 && /^[^\s@\u0000-\u001f\u007f]+@[^\s@\u0000-\u001f\u007f]+\.[^\s@\u0000-\u001f\u007f]+$/u.test(value);
}
function storedHashes(value) {
  let hashes;
  try { hashes = JSON.parse(value); } catch { throw new HttpError(401, '身份已失效'); }
  if (!Array.isArray(hashes) || !hashes.length || hashes.length > EMAIL_PAGES * PAGE_SIZE || hashes.some(hash => typeof hash !== 'string' || !HEX_TOKEN.test(hash))) throw new HttpError(401, '身份已失效');
  return hashes;
}
function validSubject(value) {
  return typeof value === 'string' && /^github:[1-9]\d{0,15}$/.test(value);
}

async function authRate(request, env, action, limit) {
  // Only the edge-owned address header is used, not X-Forwarded-For. Never store IPs.
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const key = await sha256(`${env.IDENTITY_PEPPER}:${ip.slice(0, 64)}`);
  await rateLimit(env.DB, `auth:${action}:global`, limit * 30);
  await rateLimit(env.DB, `auth:${action}:${key}`, limit);
}

export function bearerToken(request) {
  const header = request.headers.get('authorization');
  if (typeof header !== 'string' || header.length !== 71 || !/^Bearer [a-f0-9]{64}$/i.test(header)) throw new HttpError(401, '请先验证身份');
  // Tokens are case-sensitive; accepting uppercase hex would create aliases.
  const token = header.slice(7);
  if (!HEX_TOKEN.test(token)) throw new HttpError(401, '请先验证身份');
  return token;
}

export async function authStart(request, env) {
  const {redirect} = oauthConfig(env);
  requireOrigin(request, env);
  if (new URL(request.url).origin !== redirect.origin) throw new HttpError(400, '回调来源不匹配');
  await authRate(request, env, 'start', 10);
  const body = await readJson(request, 1024);
  exactFields(body, ['challenge']);
  if (!validChallenge(body.challenge)) throw new HttpError(400, '验证摘要无效');
  const state = randomToken();
  await env.DB.prepare('INSERT INTO auth_states (state_hash, challenge, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256(state), body.challenge, Date.now() + STATE_MS).run();
  const url = new URL('https://github.com/login/oauth/authorize');
  url.search = new URLSearchParams({
    client_id:env.GITHUB_CLIENT_ID, redirect_uri:redirect.href, scope:'user:email', state,
  }).toString();
  return responseJson({url:url.href});
}

async function githubIdentity(code, env, ctx, signal) {
  const fetcher = ctx?.fetcher ?? globalThis.fetch;
  const tokenData = await fetchJsonBounded('https://github.com/login/oauth/access_token', {
    method:'POST', signal,
    headers:{Accept:'application/json', 'Content-Type':'application/x-www-form-urlencoded', 'User-Agent':'GameGo'},
    body:new URLSearchParams({client_id:env.GITHUB_CLIENT_ID, client_secret:env.GITHUB_CLIENT_SECRET, code, redirect_uri:env.OAUTH_REDIRECT_URI}).toString(),
  }, fetcher, {limit:16_000, timeoutMs:8000});
  if (!tokenData || typeof tokenData !== 'object' || Array.isArray(tokenData) || tokenData.error
      || typeof tokenData.access_token !== 'string' || !/^[A-Za-z0-9_\-.]{1,512}$/.test(tokenData.access_token)
      || typeof tokenData.token_type !== 'string' || tokenData.token_type.toLowerCase() !== 'bearer') throw new HttpError(502, '身份来源无效');
  const headers = {Accept:'application/vnd.github+json', Authorization:`Bearer ${tokenData.access_token}`, 'User-Agent':'GameGo', 'X-GitHub-Api-Version':'2022-11-28'};
  const user = await fetchJsonBounded('https://api.github.com/user', {headers, signal}, fetcher, {limit:32_000, timeoutMs:8000});
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) throw new HttpError(502, '身份来源无效');
  const hashes = new Set();
  for (let page = 1; page <= EMAIL_PAGES; page++) {
    // Never follow the upstream Link header: construct every URL on the fixed host.
    const emails = await fetchJsonBounded(`https://api.github.com/user/emails?per_page=${PAGE_SIZE}&page=${page}`, {headers, signal}, fetcher, {limit:100_000, timeoutMs:8000});
    if (!Array.isArray(emails) || emails.length > PAGE_SIZE) throw new HttpError(502, '身份来源无效');
    for (const email of emails) {
      // Public profile email, primary and truthy strings are NOT verification.
      if (email?.verified === true && validEmail(email.email)) hashes.add(await identityHash(email.email, env.IDENTITY_PEPPER));
    }
    if (emails.length < PAGE_SIZE) break;
    // At the bound, only identities actually verified in these pages can match.
  }
  return {subject:`github:${user.id}`, identityHashes:[...hashes]};
}

function callbackPage(payload, origin, status) {
  const nonce = randomToken();
  const serialize = value => JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>GameGo 身份验证</title><body><p>验证已处理，请返回原窗口。若没有收到结果，请重新开始验证。</p><script nonce="${nonce}">const message=${serialize({type:'gamego-auth', ...payload})};if(window.opener){window.opener.postMessage(message,${serialize(origin)});window.close();}</script></body></html>`;
  return new Response(html, {status, headers:{
    'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store', 'Referrer-Policy':'no-referrer',
    'Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
  }});
}

export async function authCallback(request, env, ctx) {
  const origin = siteOrigin(env); // No safe targetOrigin means no postMessage at all.
  try {
    const {redirect} = oauthConfig(env);
    requireOrigin(request, env);
    const url = new URL(request.url);
    if (url.origin !== redirect.origin || url.pathname !== redirect.pathname) throw new HttpError(400, '回调地址无效');
    await authRate(request, env, 'callback', 20);
    const state = url.searchParams.get('state');
    if (url.search.length > 4096 || url.searchParams.getAll('state').length !== 1 || !HEX_TOKEN.test(state ?? '')) throw new HttpError(400, '验证状态无效');
    // One atomic write: concurrent callbacks/replays cannot reuse an OAuth state.
    const pending = await env.DB.prepare('DELETE FROM auth_states WHERE state_hash = ? AND expires_at > ? RETURNING challenge')
      .bind(await sha256(state), Date.now()).first();
    if (!pending || !validChallenge(pending.challenge)) throw new HttpError(400, '验证状态无效');
    if (url.searchParams.has('error')) throw new HttpError(403, '身份验证未完成');
    const code = url.searchParams.get('code');
    if (url.searchParams.getAll('code').length !== 1 || typeof code !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(code)) throw new HttpError(400, '验证码无效');
    const identity = await githubIdentity(code, env, ctx, request.signal);
    const exchange = randomToken();
    const result = await env.DB.prepare(`
      INSERT INTO exchanges (code_hash, challenge, subject, identity_hashes, expires_at)
      SELECT ?, ?, ?, ?, ? WHERE ${ALLOWED_IDENTITY}
    `).bind(await sha256(exchange), pending.challenge, identity.subject, JSON.stringify(identity.identityHashes), Date.now() + EXCHANGE_MS, JSON.stringify(identity.identityHashes)).run();
    if (result.meta.changes !== 1) throw new HttpError(403, '暂时未对您开放');
    return callbackPage({code:exchange}, origin, 200);
  } catch (error) {
    const {status, message} = publicError(error);
    return callbackPage({error:message}, origin, status);
  }
}

export async function authExchange(request, env) {
  oauthConfig(env);
  requireOrigin(request, env);
  await authRate(request, env, 'exchange', 30);
  const body = await readJson(request, 2048);
  exactFields(body, ['code', 'verifier']);
  if (typeof body.code !== 'string' || !HEX_TOKEN.test(body.code) || typeof body.verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(body.verifier)) throw new HttpError(400, '验证码无效');
  const exchange = await env.DB.prepare(`
    DELETE FROM exchanges WHERE code_hash = ? AND challenge = ? AND expires_at > ?
    RETURNING subject, identity_hashes
  `).bind(await sha256(body.code), await challengeFor(body.verifier), Date.now()).first();
  if (!exchange || !validSubject(exchange.subject)) throw new HttpError(401, '验证码已失效');
  const hashes = storedHashes(exchange.identity_hashes);
  const token = randomToken();
  const expiresAt = Date.now() + SESSION_MS;
  // Re-check allowlist in the INSERT itself, including revocation since callback.
  const result = await env.DB.prepare(`
    INSERT INTO sessions (token_hash, subject, identity_hashes, expires_at)
    SELECT ?, ?, ?, ? WHERE ${ALLOWED_IDENTITY}
  `).bind(await sha256(token), exchange.subject, JSON.stringify(hashes), expiresAt, JSON.stringify(hashes)).run();
  if (result.meta.changes !== 1) throw new HttpError(403, '暂时未对您开放');
  return responseJson({token, expiresAt:new Date(expiresAt).toISOString()});
}

export async function authenticate(request, env) {
  const token = bearerToken(request); // Anonymous always fails before config/DB/service.
  const db = requireDB(env);
  const tokenHash = await sha256(token);
  const row = await db.prepare('SELECT subject, identity_hashes, expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?')
    .bind(tokenHash, Date.now()).first();
  if (!row || !validSubject(row.subject)) throw new HttpError(401, '身份已失效');
  const identityHashes = storedHashes(row.identity_hashes);
  const allowed = await db.prepare(`SELECT 1 AS allowed WHERE ${ALLOWED_IDENTITY}`).bind(JSON.stringify(identityHashes)).first();
  if (!allowed) {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    throw new HttpError(403, '暂时未对您开放');
  }
  return {subject:row.subject, identityHashes, tokenHash, expiresAt:row.expires_at};
}

export async function authMe(request, env) {
  await authenticate(request, env);
  requireOrigin(request, env);
  return responseJson({authorized:true});
}

export async function authLogout(request, env) {
  // Reject cross-origin revocation before doing any authenticated mutation.
  bearerToken(request);
  requireOrigin(request, env);
  const identity = await authenticate(request, env);
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(identity.tokenHash).run();
  return responseJson({ok:true});
}
