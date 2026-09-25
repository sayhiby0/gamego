import { billingMonth, reserve, finish } from './ledger.mjs';
import { safeUrl, sha256 } from './security.mjs';

const REGIONS = Object.freeze({
  'cn-beijing': 'dashscope.aliyuncs.com',
  'intl-singapore': 'dashscope-intl.aliyuncs.com',
  'us-virginia': 'dashscope-us.aliyuncs.com',
});
const HOSTS = Object.values(REGIONS);
const MODEL = /^qwen-(?:turbo|plus|max|flash)(?:-latest|-\d{4}-\d{2}-\d{2})?$/;
const PRICE_VERSION = /^[a-zA-Z0-9_.:-]{1,128}$/;
const encoder = new TextEncoder();
const REASONS = {
  disabled: '模型未配置或未显式启用', configuration: '模型接口或产品类型不受支持，通道保持关闭',
  price: '模型单价或价格归属未确认，付费通道保持关闭', budget: '公共内容本月预算不足，已跳过 AI 加工',
  key_invalid: 'API Key 缺失、格式无效或认证失败', key_type: '不支持 Coding Plan 密钥，请使用普通按量 API Key',
  permission: '该密钥无权访问所选模型或地域', balance: '模型账户余额不足', rate_limit: '模型服务请求过于频繁，请稍后再试',
  input: '模型输入无效、包含密钥或超过限制', provider: '模型服务失败，已受理调用仍可能收费',
  usage: '模型用量不完整或超出已确认上界，费用未知',
  output: '模型输出未通过结构或引用验证', aborted: '任务已停止，已受理调用仍可能收费',
  timeout: '模型服务请求超时，已受理调用仍可能收费',
};
export class ModelError extends Error {
  constructor(code) { super(REASONS[code] ?? REASONS.provider); this.code = code; }
}
function integer(value, min, max) {
  if (!/^(0|[1-9]\d*)$/.test(String(value ?? ''))) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}

export function validateApiKey(key) {
  if (typeof key === 'string' && /^sk-sp-/.test(key)) throw new ModelError('key_type');
  if (typeof key !== 'string' || key.length > 256 || /[^A-Za-z0-9_-]/.test(key)
      || !/^sk-(?!sp-)[A-Za-z0-9_-]{16,253}$/.test(key)) throw new ModelError('key_invalid');
  return key;
}
function supportedModel(model) {
  return typeof model === 'string' && !/\s/.test(model) && MODEL.test(model);
}
function validPriceVersion(value) {
  return typeof value === 'string' && !/\s/.test(value) && PRICE_VERSION.test(value);
}

// Only public content uses environment-bound pricing. Credentials are explicit;
// neither legacy CONTENT_API_KEY nor AGENT_API_KEY is ever read here.
export function modelConfig(env, channel, key) {
  if (channel !== 'content') throw new ModelError('configuration');
  validateApiKey(key);
  const get = (name) => env[`CONTENT_${name}`];
  if (get('ENABLED') !== 'true' || !get('MODEL')) throw new ModelError('disabled');
  const model = get('MODEL');
  const base = safeUrl(get('BASE_URL'), HOSTS);
  if (!supportedModel(model)
      || !base || base.pathname.replace(/\/$/, '') !== '/compatible-mode/v1' || base.search || base.hash
      || ![undefined, 'bailian'].includes(get('PROVIDER'))
      || ![undefined, 'openai'].includes(get('PROTOCOL'))
      || ![undefined, 'standard'].includes(get('KEY_TYPE'))
      || ![undefined, 'false'].includes(get('ENABLE_SEARCH'))
      || ![undefined, 'false'].includes(get('ENABLE_THINKING'))) throw new ModelError('configuration');
  const inputPrice = integer(get('INPUT_MICROS_PER_MILLION'), 0, 1_000_000_000_000);
  const outputPrice = integer(get('OUTPUT_MICROS_PER_MILLION'), 0, 1_000_000_000_000);
  const priceVersion = get('PRICE_VERSION');
  if (inputPrice === null || outputPrice === null || get('PRICE_MODEL') !== model
      || !validPriceVersion(priceVersion)) throw new ModelError('price');
  const maxOutput = integer(get('MAX_OUTPUT_TOKENS') ?? 1200, 1, 2048);
  if (maxOutput === null) throw new ModelError('configuration');
  return { channel, model, key, url: `${base.origin}/compatible-mode/v1/chat/completions`, inputPrice, outputPrice, priceVersion, maxOutput };
}
function verifiedTime(value, now) {
  if (typeof value !== 'string' || value.length > 40 || /\s/.test(value)) return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!parts) return false;
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  const zoneHour = Number(parts[8] ?? 0); const zoneMinute = Number(parts[9] ?? 0);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const timestamp = Date.parse(value);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
    && hour <= 23 && minute <= 59 && second <= 59 && zoneHour <= 23 && zoneMinute <= 59
    && Number.isFinite(timestamp) && timestamp <= now;
}
function agentModels(env) {
  if (env.AGENT_ENABLED !== 'true') return [];
  const raw = env.AGENT_MODELS_JSON;
  if (raw === undefined) return [];
  if (typeof raw !== 'string' || raw.length > 32_000) throw new ModelError('configuration');
  let items;
  try { items = JSON.parse(raw); } catch { throw new ModelError('configuration'); }
  if (!Array.isArray(items) || items.length > 12) throw new ModelError('configuration');
  const fields = new Set(['region', 'model', 'label', 'verifiedAt', 'inputMicrosPerMillion', 'outputMicrosPerMillion', 'priceVersion']);
  const seen = new Set(); const now = Date.now();
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !fields.has(key))
        || typeof item.region !== 'string' || !Object.hasOwn(REGIONS, item.region) || !supportedModel(item.model) || !verifiedTime(item.verifiedAt, now)
        || typeof item.label !== 'string' || item.label !== item.label.trim()
        || !/^[\p{L}\p{N} ._()（）·、，:+-]{1,80}$/u.test(item.label)
        || /sk-|bearer|secret|https?|www\.|\b[a-z0-9-]+\.[a-z]{2,}\b/i.test(item.label)) throw new ModelError('configuration');
    const id = `${item.region}/${item.model}`;
    if (seen.has(id)) throw new ModelError('configuration');
    seen.add(id);
    const hasPrice = ['inputMicrosPerMillion', 'outputMicrosPerMillion', 'priceVersion'].some(key => Object.hasOwn(item, key));
    if (hasPrice && (!['inputMicrosPerMillion', 'outputMicrosPerMillion'].every(key =>
      Number.isSafeInteger(item[key]) && item[key] >= 0 && item[key] <= 1_000_000_000_000)
      || !validPriceVersion(item.priceVersion))) throw new ModelError('configuration');
  }
  return items;
}
export function listAgentModels(env) {
  return agentModels(env).map(({ region, model, label, verifiedAt, inputMicrosPerMillion, outputMicrosPerMillion }) => ({
    region, model, label, verifiedAt,
    ...(inputMicrosPerMillion === undefined ? {} : { inputPrice: inputMicrosPerMillion / 1_000_000, outputPrice: outputMicrosPerMillion / 1_000_000 }),
  }));
}
export function agentModelConfig(env, selection, key) {
  validateApiKey(key);
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)
      || Object.keys(selection).length !== 2 || Object.keys(selection).some(name => !['region', 'model'].includes(name))) throw new ModelError('configuration');
  const item = agentModels(env).find(item => item.region === selection.region && item.model === selection.model);
  if (!item) throw new ModelError('configuration');
  return {
    channel: 'agent', key, region: item.region, model: item.model, verifiedAt: item.verifiedAt,
    url: `https://${REGIONS[item.region]}/compatible-mode/v1/chat/completions`, maxOutput: 2400,
    inputPrice: item.inputMicrosPerMillion ?? null, outputPrice: item.outputMicrosPerMillion ?? null, priceVersion: item.priceVersion ?? null,
  };
}
export async function configurationHash(config) {
  const { key, ...publicConfig } = config;
  return sha256(JSON.stringify({ adapter: 'bounded-chat-v1', ...publicConfig }));
}
export function costMicros(inputTokens, outputTokens, config) {
  if (![inputTokens, outputTokens, config.inputPrice, config.outputPrice].every(n => Number.isSafeInteger(n) && n >= 0)
      || config.inputPrice > 1_000_000_000_000 || config.outputPrice > 1_000_000_000_000) throw new ModelError('price');
  const unit = 1_000_000n;
  const round = (tokens, price) => (BigInt(tokens) * BigInt(price) + unit - 1n) / unit;
  const value = round(inputTokens, config.inputPrice) + round(outputTokens, config.outputPrice);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ModelError('price');
  return Number(value);
}
export function requestBounds(config, messages, stream = false) {
  if (!config || !['content', 'agent'].includes(config.channel)) throw new ModelError('configuration');
  validateApiKey(config.key);
  const url = safeUrl(config.url, HOSTS);
  if (!supportedModel(config.model) || !url || url.href !== `${url.origin}/compatible-mode/v1/chat/completions`
      || !Number.isSafeInteger(config.maxOutput) || config.maxOutput < 1 || config.maxOutput > (config.channel === 'content' ? 2048 : 2400)
      || (config.channel === 'agent' && (!Object.hasOwn(REGIONS, config.region)
        || config.url !== `https://${REGIONS[config.region]}/compatible-mode/v1/chat/completions`))) throw new ModelError('configuration');
  if (!Array.isArray(messages) || !messages.length || messages.length > 12 || messages.some(m => !m || typeof m !== 'object'
      || Object.keys(m).some(key => !['role', 'content'].includes(key))
      || !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || m.content.includes(config.key))) throw new ModelError('input');
  const payload = {
    model: config.model, messages: messages.map(({ role, content }) => ({ role, content })), max_tokens: config.maxOutput, temperature: 0.2,
    enable_search: false, enable_thinking: false, stream,
    ...(stream ? { stream_options: { include_usage: true } } : { response_format: { type: 'json_object' } }),
  };
  const body = JSON.stringify(payload);
  if (body.includes(config.key)) throw new ModelError('input');
  // A UTF-8 byte is a conservative token ceiling, plus chat/protocol framing.
  const inputTokens = encoder.encode(body).byteLength + 1024 + 64 * messages.length;
  if (inputTokens > (config.channel === 'content' ? 24_000 : 60_000)) throw new ModelError('input');
  return { body, inputTokens, upperMicros: config.channel === 'content' ? costMicros(inputTokens, config.maxOutput, config) : null };
}

export function abortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(new ModelError('aborted'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function readBody(response, signal, limit, onChunk) {
  if (!response.body) throw new ModelError('provider');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new ModelError('output');
      await abortable(Promise.resolve().then(() => onChunk(decoder.decode(value, { stream: true }))), signal);
    }
    await abortable(Promise.resolve().then(() => onChunk(decoder.decode())), signal);
  } finally {
    // Do not wait for a provider to acknowledge cancellation before releasing jobs.
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function verifiedUsage(usage, bounds, config) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)
      || !Number.isSafeInteger(usage.prompt_tokens) || usage.prompt_tokens < (config.channel === 'content' ? 1 : 0)
      || usage.prompt_tokens > bounds.inputTokens || !Number.isSafeInteger(usage.completion_tokens)
      || usage.completion_tokens < 0 || usage.completion_tokens > config.maxOutput
      || usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens) throw new ModelError('usage');
  // Cached tokens are conservatively charged at full input price. No paid tools,
  // reasoning, audio or other unpriced accounting dimensions are supported.
  const allowed = new Set(['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_tokens_details', 'completion_tokens_details']);
  if (Object.keys(usage).some(k => !allowed.has(k))) throw new ModelError('usage');
  for (const [field, accepted] of [['prompt_tokens_details', 'cached_tokens'], ['completion_tokens_details', 'reasoning_tokens']]) {
    if (usage[field] == null) continue;
    if (typeof usage[field] !== 'object' || Array.isArray(usage[field])) throw new ModelError('usage');
    for (const [key, value] of Object.entries(usage[field])) {
      if (!Number.isSafeInteger(value) || value < 0 || key !== accepted
          || (field === 'completion_tokens_details' && value !== 0)
          || (field === 'prompt_tokens_details' && value > usage.prompt_tokens)) throw new ModelError('usage');
    }
  }
  return costMicros(usage.prompt_tokens, usage.completion_tokens, config);
}
function agentUsage(usage, bounds, config, uncertain) {
  const count = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;
  const result = { input: null, output: null, cost: null };
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return result;
  result.input = count(usage.prompt_tokens, bounds.inputTokens);
  result.output = count(usage.completion_tokens, config.maxOutput);
  if (!uncertain) {
    try { result.cost = verifiedUsage(usage, bounds, config); } catch { /* Unknown is not free; retain independently trustworthy token counts. */ }
  }
  return result;
}
function choiceSafe(choice) {
  const part = choice?.delta ?? choice?.message;
  if (!part || part.tool_calls || part.function_call || part.reasoning_content || part.refusal
      || (part.role && part.role !== 'assistant')) throw new ModelError('output');
  if (part.content != null && typeof part.content !== 'string') throw new ModelError('output');
  return part.content ?? '';
}
async function readSSE(response, signal, config, onText) {
  if (!response.headers.get('content-type')?.includes('text/event-stream')) throw new ModelError('provider');
  let buffer = ''; let data = []; let usage; let usageSeen = false; let uncertain = false;
  let ended = false; let stopped = false; let characters = 0;
  const dispatch = async () => {
    if (!data.length) return;
    const raw = data.join('\n'); data = [];
    if (ended) throw new ModelError('provider');
    if (raw === '[DONE]') { if (!stopped) throw new ModelError('provider'); ended = true; return; }
    let frame;
    try { frame = JSON.parse(raw); } catch { throw new ModelError('provider'); }
    if (!frame || frame.error || !Array.isArray(frame.choices) || frame.choices.length > 1) throw new ModelError('provider');
    if (frame.usage != null) {
      if (usageSeen || !stopped || frame.choices.length) {
        if (config.channel === 'content') throw new ModelError('usage');
        uncertain = true;
      }
      usage = usageSeen ? null : frame.usage;
      usageSeen = true;
    }
    for (const choice of frame.choices) {
      if (stopped || choice.index !== 0) throw new ModelError('provider');
      const text = choiceSafe(choice);
      characters += encoder.encode(text).byteLength;
      if (characters > config.maxOutput * 16) throw new ModelError('output');
      if (signal?.aborted) throw new ModelError('aborted');
      if (text) await abortable(Promise.resolve().then(() => onText(text)), signal);
      if (choice.finish_reason != null) {
        if (choice.finish_reason !== 'stop') throw new ModelError('output');
        stopped = true;
      }
    }
  };
  await readBody(response, signal, 1_000_000, async chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, ''); buffer = buffer.slice(newline + 1);
      if (!line) await dispatch();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      else if (!line.startsWith(':') && !/^(event|id|retry):/.test(line)) throw new ModelError('provider');
    }
    if (buffer.length > 100_000) throw new ModelError('output');
  });
  if (buffer.trim() || data.length || !ended) throw new ModelError('provider');
  return { usage, uncertain };
}

async function providerError(response, signal) {
  const codes = { 401: 'key_invalid', 402: 'balance', 429: 'rate_limit', 408: 'timeout', 504: 'timeout' };
  if (codes[response.status]) {
    response.body?.cancel().catch(() => {});
    return new ModelError(codes[response.status]);
  }
  // DashScope's fixed Arrearage code is evidence; prose, quota errors and
  // substring guesses are not. Never return the body or upstream message.
  let balance = false;
  try {
    if (response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() === 'application/json') {
      let text = '';
      await readBody(response, signal, 4096, chunk => { text += chunk; });
      const body = JSON.parse(text);
      const code = body?.error?.code ?? body?.code;
      balance = code === 'Arrearage' && (body?.code === undefined || body.code === code);
    } else response.body?.cancel().catch(() => {});
  } catch {
    if (signal.aborted) throw new ModelError('aborted');
  }
  return new ModelError(balance ? 'balance' : response.status === 403 ? 'permission' : 'provider');
}

// Only public content reserves/settles the shared ledger. BYOK never touches db.
// No auto-retry, key/channel fallback, tools, provider-body logging or chat storage.
export async function invokeModel(config, { db, owner, messages, signal, fetcher = fetch, onText }) {
  const bounds = requestBounds(config, messages, Boolean(onText));
  if (signal?.aborted) throw new ModelError('aborted');
  const content = config.channel === 'content';
  const now = Date.now(); const id = crypto.randomUUID();
  if (content) {
    if (!db || typeof db.prepare !== 'function') throw new ModelError('configuration');
    try {
      if (!await reserve(db, { id, channel: 'content', month: billingMonth(now), model: config.model,
        priceVersion: config.priceVersion, upperMicros: bounds.upperMicros, now, owner })) throw new ModelError('budget');
    } catch (error) { throw error instanceof ModelError ? error : new ModelError('provider'); }
  }
  const controller = new AbortController();
  const combined = AbortSignal.any([signal ?? new AbortController().signal, controller.signal]);
  const timer = setTimeout(() => controller.abort(), 60_000);
  let actualMicros; let completed = false;
  try {
    combined.throwIfAborted();
    const pending = Promise.resolve().then(() => {
      if (combined.aborted) throw new ModelError('aborted');
      return fetcher(config.url, {
        method: 'POST', redirect: 'error', credentials: 'omit', signal: combined,
        headers: { 'Content-Type': 'application/json', Accept: onText ? 'text/event-stream' : 'application/json', Authorization: `Bearer ${config.key}` }, body: bounds.body,
      });
    });
    // Also cancel a response arriving after a disconnect, before a reader exists.
    pending.then(response => { if (combined.aborted) response.body?.cancel().catch(() => {}); }, () => {});
    const response = await abortable(pending, combined);
    if (response.redirected || (response.url && response.url !== config.url)) { response.body?.cancel().catch(() => {}); throw new ModelError('provider'); }
    if (!response.ok) throw await providerError(response, combined);
    let text = ''; let usage; let uncertain = false;
    if (onText) ({ usage, uncertain } = await readSSE(response, combined, config, chunk => { text += chunk; return onText(chunk); }));
    else {
      await readBody(response, combined, config.maxOutput * 32 + 8192, chunk => { text += chunk; });
      let result;
      try { result = JSON.parse(text); } catch { throw new ModelError('provider'); }
      if (!result || result.error || !Array.isArray(result.choices) || result.choices.length !== 1) throw new ModelError('provider');
      const choice = result.choices[0];
      if (choice?.finish_reason !== 'stop') throw new ModelError('output');
      text = choiceSafe(choice);
      if (encoder.encode(text).byteLength > config.maxOutput * 16) throw new ModelError('output');
      usage = result.usage;
    }
    let reportUsage;
    if (content) {
      actualMicros = verifiedUsage(usage, bounds, config);
      reportUsage = { input: usage.prompt_tokens, output: usage.completion_tokens, cost: actualMicros };
    } else reportUsage = agentUsage(usage, bounds, config, uncertain);
    combined.throwIfAborted();
    completed = true;
    return { text, requestId: id, usage: reportUsage };
  } catch (error) {
    if (combined.aborted) throw new ModelError(signal?.aborted ? 'aborted' : 'timeout');
    throw error instanceof ModelError ? error : new ModelError('provider');
  } finally {
    clearTimeout(timer); controller.abort();
    if (content) {
      try { await finish(db, id, completed ? { actualMicros, status: 'settled' } : { status: signal?.aborted ? 'aborted' : 'unknown' }); }
      catch { throw new ModelError('provider'); }
    }
  }
}

// Plain text is intentional: URLs/citations are rendered only from trusted source
// records, never from arbitrary Markdown produced by the model.
export function checkedText(value, max, secrets = []) {
  if (typeof value !== 'string' || !value.trim() || value.length > max
      || /[<>\u0000-\u001f\u007f]|(?:https?:|javascript:|data:|file:|www\.|\/\/)|\]\s*[(:\[]|\[[^\]]+\]:/i.test(value)
      || /\bsk-[a-z0-9_-]{8,}|\bBearer\s+\S{8,}|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|[a-z]:\\|\/(?:home|Users|etc)\//i.test(value)
      || secrets.some(secret => typeof secret === 'string' && secret.length >= 6 && value.includes(secret))) throw new ModelError('output');
  return value.trim();
}
export function secretValues(env, identity = {}) {
  return [...Object.entries(env).filter(([key, value]) => /KEY|TOKEN|SECRET|PEPPER/.test(key) && typeof value === 'string').map(([, value]) => value), identity.tokenHash, ...(identity.identityHashes ?? [])].filter(Boolean);
}
