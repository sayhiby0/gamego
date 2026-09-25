export class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
export const encoder = new TextEncoder();
export const nowSeconds = () => Math.floor(Date.now() / 1000);
export const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
export async function sha256(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}
export async function challengeFor(verifier) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export async function identityHash(email, pepper) {
  if (typeof pepper !== 'string' || pepper.length < 32 || pepper.length > 4096) throw new HttpError(503, '身份服务未配置');
  if (typeof email !== 'string' || email.length > 254) throw new HttpError(400, '身份数据无效');
  const key = await crypto.subtle.importKey('raw', encoder.encode(pepper), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(email.trim().toLowerCase()))), b => b.toString(16).padStart(2, '0')).join('');
}

export async function requestFingerprint(value, secret, kind) {
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 4096) throw new HttpError(503, '限流服务未配置');
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(`${kind}\0${value}`));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

// Compare fixed-size digests, never exit on the first differing secret byte.
export async function constantTimeEqual(left, right) {
  const [a, b] = await Promise.all([sha256(left), sha256(right)]);
  let difference = 0;
  for (let i = 0; i < 64; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

export function safeUrl(value, allowedHosts) {
  try {
    if (!(typeof value === 'string' || value instanceof URL)) return null;
    const raw = String(value);
    if (raw.length > 4096 || /[\s\\\u0000-\u001f\u007f]/u.test(raw)) return null;
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
    if (allowedHosts && !allowedHosts.includes(url.hostname)) return null;
    if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/.test(url.hostname) || /^\[|^[\d.]+$/.test(url.hostname)) return null;
    return url;
  } catch { return null; }
}

function abortable(promise, signal, onAbort = () => {}) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => {
      try { onAbort(); } catch { /* Cancellation must not disclose upstream errors. */ }
      reject(new HttpError(504, '读取超时或已取消'));
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, {once:true});
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function withDeadline(parent, milliseconds, work) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, {once:true});
  const timer = setTimeout(abort, milliseconds);
  try {
    if (controller.signal.aborted) throw new HttpError(504, '读取超时或已取消');
    return await work(controller.signal);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', abort);
  }
}

export async function readLimited(response, limit = 500_000, {signal, sizeStatus = 502} = {}) {
  if (Number(response.headers.get('content-length')) > limit) {
    void response.body?.cancel().catch(() => {});
    throw new HttpError(sizeStatus, sizeStatus === 413 ? '请求超过大小限制' : '响应超过大小限制');
  }
  if (!response.body) return '';
  const reader = response.body.getReader(); const chunks = []; let count = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  try {
    for (;;) {
      if (signal?.aborted) throw new HttpError(504, '读取超时或已取消');
      const {done, value} = await abortable(reader.read(), signal, cancel);
      if (done) break;
      count += value.byteLength;
      if (count > limit) throw new HttpError(sizeStatus, sizeStatus === 413 ? '请求超过大小限制' : '响应超过大小限制');
      chunks.push(value);
    }
  } catch (error) { cancel(); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(count); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder('utf-8', {fatal:true}).decode(bytes);
}

export async function readJson(request, limit = 32_000) {
  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw new HttpError(415, '需要 JSON 请求');
  if (request.headers.has('content-encoding') && request.headers.get('content-encoding') !== 'identity') throw new HttpError(415, '不支持压缩请求');
  try {
    const body = await withDeadline(request.signal, 5000, signal => readLimited(request, limit, {signal, sizeStatus:413}));
    const value = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'JSON 必须为对象');
    return value;
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.status === 504) throw new HttpError(408, '读取请求超时');
      throw error;
    }
    throw new HttpError(400, 'JSON 格式无效');
  }
}

export function siteOrigin(env) {
  try {
    const value = env?.SITE_ORIGIN;
    const url = new URL(value);
    const local = ['localhost', '[::1]'].includes(url.hostname) || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(url.hostname);
    if (typeof value !== 'string' || value !== url.origin || url.username || url.password || !(url.protocol === 'https:' || (url.protocol === 'http:' && local))) throw new Error();
    return url.origin;
  } catch { throw new HttpError(503, '固定站点来源未配置'); }
}

export function requireOrigin(request, env) {
  // Origin/CORS is supplementary: requests without it MUST still authenticate.
  const allowed = siteOrigin(env);
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== allowed) throw new HttpError(403, '来源不允许');
}

export function responseJson(body, status = 200) {
  return new Response(JSON.stringify(body), {status, headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
}

const ERROR_MESSAGES = Object.freeze({
  400:['input', '请求格式无效'], 401:['key_invalid', 'API Key 缺失或无效，请检查专用配置'],
  402:['balance', '模型账户余额或额度不足，请在百炼控制台核对'],
  403:['permission', '来源或模型权限不允许'], 404:['not_found', '接口不存在'],
  405:['method', '请求方法不允许'], 408:['timeout', '读取请求超时'],
  409:['conflict', '请求冲突，请稍后重试'], 413:['input', '请求超过大小限制'],
  415:['input', '需要未压缩的 JSON 请求'], 429:['rate_limit', '请求过于频繁，请稍后再试'],
  500:['service', '服务暂不可用'], 502:['provider', '上游服务暂不可用，已受理调用仍可能收费'],
  503:['configuration', '服务未配置或暂不可用'], 504:['timeout', '上游请求超时，已受理调用仍可能收费'],
});
const MODEL_ERRORS = Object.freeze({
  key_invalid: [401, 'API Key 缺失或无效，请检查专用配置'],
  key_type: [400, '不支持 Coding Plan 专用 Key，请使用百炼普通模型 API Key'],
  permission: [403, '模型权限或地域不匹配，请在百炼控制台核对'],
  balance: [402, '模型账户余额或额度不足，请在百炼控制台核对'],
  rate_limit: [429, '请求过于频繁，请稍后再试'],
  timeout: [504, '调用超时，已受理调用仍可能收费'],
  aborted: [408, '调用已停止，已受理调用仍可能收费'],
  configuration: [503, '该地域与模型尚未完成验收或未开放'],
  disabled: [503, '模型服务尚未启用'], price: [503, '模型价格配置尚未确认'],
  budget: [429, '公共内容月度预算不足'], input: [400, '模型输入无效或包含密钥'],
  output: [502, '模型输出未通过结构或引用验证'],
  usage: [502, '模型用量无法确认，已受理调用仍可能收费'],
  provider: [502, '模型服务暂不可用，已受理调用仍可能收费'],
});
export function modelHttpError(code) {
  const known = Object.hasOwn(MODEL_ERRORS, code) ? code : 'provider';
  const [status, message] = MODEL_ERRORS[known];
  return new HttpError(status, message, known);
}
export function publicError(error) {
  const status = error instanceof HttpError && Object.hasOwn(ERROR_MESSAGES, error.status) ? error.status : 500;
  if (error instanceof HttpError && Object.hasOwn(MODEL_ERRORS, error.code) && MODEL_ERRORS[error.code][0] === status) {
    return { status, code: error.code, message: MODEL_ERRORS[error.code][1] };
  }
  const [code, message] = ERROR_MESSAGES[status];
  return {status, code, message};
}
export function errorResponse(error) {
  const {status, code, message} = publicError(error);
  const response = responseJson({error:code, message}, status);
  if (status === 401) response.headers.set('WWW-Authenticate', 'Bearer');
  if (status === 429) response.headers.set('Retry-After', '60');
  return response;
}

export function secureResponse(response, request, env) {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (!headers.has('Content-Security-Policy')) headers.set('Content-Security-Policy', "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  if (new URL(request.url).protocol === 'https:') headers.set('Strict-Transport-Security', 'max-age=31536000');
  headers.delete('Set-Cookie');
  headers.delete('Access-Control-Allow-Origin');
  headers.delete('Access-Control-Allow-Credentials');
  const vary = new Set((headers.get('Vary') || '').split(',').map(v => v.trim()).filter(Boolean));
  vary.add('Origin'); headers.set('Vary', [...vary].join(', '));
  try {
    const allowed = siteOrigin(env);
    if (request.headers.get('origin') === allowed) headers.set('Access-Control-Allow-Origin', allowed);
  } catch { /* Never mask an anonymous 401 with missing CORS configuration. */ }
  return new Response(response.body, {status:response.status, statusText:response.statusText, headers});
}

export const PUBLIC_HOSTS = Object.freeze(['store.steampowered.com','api.steampowered.com','www.gcores.com','www.chuapp.com','www.ign.com','feeds.ign.com','www.gamespot.com','www.polygon.com','www.eurogamer.net','www.rockpapershotgun.com','www.gematsu.com','blog.playstation.com','www.youxituoluo.com','ak.hypergryph.com','www.leagueoflegends.com']);

// Trusted code supplies the URL. Public/user-driven URLs must go through publicJson.
// The deadline covers BOTH fetch and streaming body, even for injected fetchers.
export async function fetchJsonBounded(url, init = {}, fetcher = globalThis.fetch, {timeoutMs = 12_000, limit = 500_000} = {}) {
  return withDeadline(init.signal, timeoutMs, async signal => {
    let response;
    try {
      const pending = Promise.resolve().then(() => fetcher(url, {...init, redirect:'manual', credentials:'omit', signal}));
      pending.then(value => { if (signal.aborted) void value.body?.cancel().catch(() => {}); }, () => {});
      response = await abortable(pending, signal);
      if (!response.ok || response.redirected || (response.url && new URL(response.url).href !== new URL(url).href)) throw new HttpError(502, '上游响应不可用');
      return JSON.parse(await readLimited(response, limit, {signal}));
    } catch (error) {
      void response?.body?.cancel().catch(() => {});
      if (signal.aborted) throw new HttpError(504, '上游请求超时或已取消');
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, '上游响应不可用');
    }
  });
}

export async function publicJson(url, signal, fetcher = globalThis.fetch, hosts = PUBLIC_HOSTS) {
  // A caller can narrow this list, NEVER extend it to attacker-selected hosts.
  const checked = safeUrl(url, PUBLIC_HOSTS);
  if (!checked || checked.hash || !Array.isArray(hosts) || !hosts.includes(checked.hostname)) throw new HttpError(400, '来源不在已许可的公开接口列表');
  return fetchJsonBounded(checked.href, {signal, headers:{Accept:'application/json'}}, fetcher);
}
export function publicText(value, max = 2000) {
  return String(value ?? '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}
export async function rateLimit(db, id, limit, seconds = 60, now = Date.now()) {
  if (typeof id !== 'string' || !id || id.length > 256 || !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(seconds) || seconds < 1 || !Number.isSafeInteger(now) || !Number.isSafeInteger(now + seconds * 1000)) throw new TypeError('Invalid rate limit');
  // All D1 expiry columns and ledger.cleanup use Unix MILLISECONDS.
  const expiresAt = now + seconds * 1000;
  const row = await db.prepare(`INSERT INTO rate_limits (id,count,expires_at) VALUES (?,1,?) ON CONFLICT(id) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE MIN(count+1,?) END, expires_at=CASE WHEN expires_at<=? THEN ? ELSE expires_at END RETURNING count`).bind(id, expiresAt, now, limit + 1, now, expiresAt).first();
  if (!row || row.count > limit) throw new HttpError(429, '请求过于频繁，请稍后再试');
}
