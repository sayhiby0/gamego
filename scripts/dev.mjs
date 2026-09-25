import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { once } from 'node:events';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

export function createLocalD1() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(resolve(root, 'backend/migrations/001_initial.sql'), 'utf8'));
  const prepare = (query, args = []) => ({
    bind(...values) { return prepare(query, values); },
    async first(column) { const row = sql.prepare(query).get(...args); return column ? row?.[column] ?? null : row ?? null; },
    async all() { return { results: sql.prepare(query).all(...args), success: true }; },
    async run() { return this.execute(); },
    execute() {
      const statement = sql.prepare(query);
      if (statement.columns().length) {
        const results = statement.all(...args);
        return { results, success: true, meta: { changes: sql.prepare('SELECT changes() AS n').get().n } };
      }
      const result = statement.run(...args);
      return { results: [], success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    },
  });
  return {
    prepare,
    async batch(statements) {
      sql.exec('BEGIN');
      try { const results = statements.map((statement) => statement.execute()); sql.exec('COMMIT'); return results; }
      catch (error) { sql.exec('ROLLBACK'); throw error; }
    },
    close() { sql.close(); },
  };
}

export async function createDevelopmentServer({ port = 8000, env: supplied = {}, worker, siteRoot = resolve(root, 'site') } = {}) {
  if (!supplied.DB && supplied.CONTENT_ENABLED === 'true') {
    throw new Error('默认内存账本不能启用计费模型；重启会丢失公共预算。请先配置持久化账本。');
  }
  const db = supplied.DB ?? createLocalD1();
  const site = await realpath(siteRoot);
  let origin;
  const pending = new Set();
  const server = createServer(async (incoming, outgoing) => {
    const controller = new AbortController();
    outgoing.on('close', () => controller.abort());
    incoming.on('aborted', () => controller.abort());
    try {
      if (incoming.headers.host !== new URL(origin).host) { outgoing.writeHead(403); outgoing.end('Host not allowed'); return; }
      const url = new URL(incoming.url, origin);
      const env = { ...supplied, DB: db, SITE_ORIGIN: origin };
      let response;
      if (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/api/') || url.pathname.startsWith('/internal/') || url.pathname === '/health') {
        if (!env.PUBLIC_DATA_URL) {
          try { env.PUBLIC_DATA = JSON.parse(await readFile(resolve(site, 'data/latest.json'), 'utf8')); }
          catch { env.PUBLIC_DATA = null; }
        }
        const implementation = worker ?? (await import('../backend/src/worker.mjs')).default;
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
        headers.set('CF-Connecting-IP', incoming.socket.remoteAddress);
        const init = { method: incoming.method, headers, signal: controller.signal };
        if (!['GET', 'HEAD'].includes(incoming.method)) { init.body = Readable.toWeb(incoming); init.duplex = 'half'; }
        const request = new Request(url, init);
        const context = { waitUntil(promise) { const task = Promise.resolve(promise).catch(() => {}).finally(() => pending.delete(task)); pending.add(task); } };
        response = await implementation.fetch(request, env, context);
      } else {
        if (!['GET', 'HEAD'].includes(incoming.method)) { outgoing.writeHead(405, { Allow: 'GET, HEAD' }); outgoing.end(); return; }
        if (url.pathname === '/config.json') {
          response = Response.json({ apiBase: origin });
        } else {
          const pathname = decodeURIComponent(url.pathname);
          if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some((part) => part.startsWith('.'))) throw new Error('Not found');
          const file = await realpath(resolve(site, `.${pathname === '/' ? '/index.html' : pathname}`));
          if (!file.startsWith(site + sep) || !types[extname(file)] || !(await stat(file)).isFile()) throw new Error('Not found');
          response = new Response(incoming.method === 'HEAD' ? null : await readFile(file), { headers: { 'Content-Type': types[extname(file)] } });
        }
      }
      const headers = Object.fromEntries(response.headers);
      headers['cache-control'] = 'no-store';
      headers['x-content-type-options'] = 'nosniff';
      headers['referrer-policy'] = 'no-referrer';
      outgoing.writeHead(response.status, headers);
      if (incoming.method === 'HEAD' || !response.body) { outgoing.end(); return; }
      const reader = response.body.getReader();
      const cancel = () => { void reader.cancel().catch(() => {}); };
      controller.signal.addEventListener('abort', cancel, { once: true });
      try {
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!outgoing.write(value)) await once(outgoing, 'drain', { signal: controller.signal });
        }
        outgoing.end();
      } finally {
        controller.signal.removeEventListener('abort', cancel);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } catch {
      if (!outgoing.headersSent) {
        outgoing.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        outgoing.end('请求资源不可用；本地服务不会暴露项目文件或内部错误。');
      } else outgoing.end();
    }
  });
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveListen); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, server, db, async close() { server.closeAllConnections(); await new Promise((resolveClose) => server.close(resolveClose)); await Promise.allSettled([...pending]); if (!supplied.DB) db.close(); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createDevelopmentServer({ port: Number(process.env.PORT || 8000), env: process.env });
  console.log(`GameGo 本地开发：${app.origin}（仅本机，数据库为内存；未创建云资源）`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
}
