import { readFileSync } from 'node:fs';
import { ModelError, validateApiKey } from '../backend/src/model.mjs';
import { readSSE } from '../site/assets/core.mjs';

const read = path => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const phase = process.argv[2];
let stage = 'configuration';
function requireCheck(condition) {
  if (!condition) throw new Error('Acceptance check failed');
}
async function json(response) {
  requireCheck(response.ok && response.headers.get('content-type')?.includes('application/json'));
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      requireCheck(size <= 400_000);
      chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function usage(value) {
  requireCheck(value && ['input', 'output', 'cost'].every(name => Number.isSafeInteger(value[name]) && value[name] >= 0));
  return { input: value.input, output: value.output, cost: value.cost };
}
try {
  requireCheck(['content', 'agent', 'stop'].includes(phase));
  const vars = read('wrangler.json').vars;
  const base = new URL(read('site/config.json').apiBase);
  requireCheck(base.href === 'https://gamego-api.byl55007424.workers.dev/');
  stage = 'api-key';
  const key = validateApiKey(process.env.ACCEPTANCE_API_KEY);
  const selection = { region: 'cn-beijing', model: vars.CONTENT_MODEL };
  const origin = vars.SITE_ORIGIN;
  const request = (path, body, headers = {}, signal = AbortSignal.timeout(100_000)) => fetch(new URL(path, base), {
    method: 'POST', redirect: 'error', credentials: 'omit', signal,
    headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(body),
  });
  const report = { ok: true, phase, ...selection };
  if (phase === 'content') {
    stage = 'service-token';
    const token = process.env.CONTENT_SERVICE_TOKEN;
    requireCheck(typeof token === 'string' && /^[A-Za-z0-9]{32,512}$/.test(token));
    stage = 'public-evidence';
    const data = read('site/data/latest.json');
    const item = data.news.find(item => item.originalTitle && item.sources?.length && Date.parse(item.publishedAt) >= Date.now() - 7 * 86_400_000);
    requireCheck(item);
    stage = 'public-content';
    const body = await json(await request('/internal/content', { items: [{
      id: item.id, title: item.originalTitle, publishedAt: item.publishedAt,
      evidence: item.originalTitle, sources: item.sources.map(({ name, url }) => ({ name, url })),
    }] }, { Authorization: `Bearer ${token}`, 'X-Content-API-Key': key }));
    requireCheck(body.items?.length === 1);
    const result = body.items[0];
    requireCheck(result.processing?.status === 'processed' && result.summary && result.insight?.startsWith('AI 推论：'));
    const urls = new Set(item.sources.map(source => source.url));
    requireCheck(['summary', 'insight'].every(field => result.processing.citations?.[field]?.length
      && result.processing.citations[field].every(url => urls.has(url))));
    report.cached = result.processing.cached === true;
    report.citationsValidated = true;
  } else {
    stage = 'model-list';
    const models = await json(await fetch(new URL('/api/models', base), {
      headers: { Origin: origin }, redirect: 'error', signal: AbortSignal.timeout(20_000),
    }));
    requireCheck(models.models?.some(item => item.region === selection.region && item.model === selection.model));
    const headers = { Authorization: `Bearer ${key}` };
    const task = { ...selection, skill: 'game-daily', message: '依据近期资讯，用两段中文分别概括一项有来源的事实及条件性行业推论。', games: [], history: [] };
    if (phase === 'agent') {
      stage = 'connection-test';
      const connected = await json(await request('/api/test', selection, headers));
      requireCheck(connected.ok === true && connected.model === selection.model && connected.region === selection.region);
      report.connectionUsage = usage(connected.usage);
      stage = 'agent-stream';
      const response = await request('/api/agent', task, headers);
      requireCheck(response.ok && response.headers.get('content-type')?.includes('text/event-stream'));
      let paragraphs = 0; let sourceCount = 0; let done = false; let tokens;
      await readSSE(response.body, event => {
        if (event.type === 'sources') sourceCount += event.sources.length;
        if (event.type === 'delta') {
          requireCheck(!event.text.includes(key) && /\[s\d+\]/.test(event.text));
          paragraphs++;
        }
        if (event.type === 'usage') tokens = usage(event.usage);
        if (event.type === 'done') done = event.ok === true && !event.cancelled;
      });
      requireCheck(done && paragraphs > 0 && sourceCount > 0 && tokens);
      report.agentUsage = tokens;
      report.paragraphs = paragraphs;
      report.sources = sourceCount;
    } else {
      stage = 'agent-stop';
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(100_000)]);
      const response = await request('/api/agent', task, headers, signal);
      requireCheck(response.ok && response.headers.get('content-type')?.includes('text/event-stream'));
      let stopped = false;
      try {
        await readSSE(response.body, event => {
          if (event.type === 'delta') { stopped = true; controller.abort(); }
        }, signal);
      } catch { requireCheck(stopped && controller.signal.aborted); }
      requireCheck(stopped);
      report.clientAbortObserved = true;
    }
  }
  report.verifiedAt = new Date().toISOString();
  console.log(JSON.stringify(report));
} catch (error) {
  const code = error instanceof ModelError && ['key_invalid', 'key_type'].includes(error.code) ? error.code : 'check_failed';
  console.error(JSON.stringify({ ok: false, phase: ['content', 'agent', 'stop'].includes(phase) ? phase : 'invalid', stage, code }));
  process.exitCode = 1;
}
