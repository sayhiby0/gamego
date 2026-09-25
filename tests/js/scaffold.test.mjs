import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(join(root, path), 'utf8');

test('基础目录存在，公开文件与后端分离', () => {
  for (const path of [
    'site/assets', 'site/data', 'scripts', 'backend/src',
    'backend/migrations', 'config', 'tests/js', 'tests/python',
    '.github/workflows',
  ]) {
    assert.ok(statSync(join(root, path)).isDirectory(), path);
  }
});

test('中文情报工作台提供五个视图与本地模块，无外部依赖资源', () => {
  const html = read('site/index.html');
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /Gaming Industry Intelligence/);
  for (const view of ['news', 'rankings', 'movements', 'skills', 'assistant']) {
    assert.ok(html.includes(`id="view-${view}"`));
    assert.ok(html.includes(`href="#${view}"`));
  }
  assert.match(html, /href="\.\/assets\/style\.css"/);
  assert.match(html, /type="module" src="\.\/assets\/app\.mjs"/);
  assert.ok(read('site/assets/style.css').length > 0);
  assert.ok(read('site/assets/app.mjs').length > 0);
  assert.doesNotMatch(html, /<iframe\b|<(?:script|link|img)\b[^>]*(?:src|href)="https?:\/\//i);
  assert.match(html, /记住在此浏览器/);
  assert.match(html, /百炼/);
  assert.doesNotMatch(html, /申请授权请发送|id="login"|id="auth-gate"/);
  const api = new URL(JSON.parse(read('site/config.json')).apiBase);
  assert.equal(api.protocol, 'https:');
  assert.equal(api.href, `${api.origin}/`);
  assert.equal(api.username + api.password, '');
});

test('预览只暴露 site 目录并绑定本机，不安装第三方依赖', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.private, true);
  assert.match(pkg.scripts.start, /--bind 127\.0\.0\.1 --directory site$/);
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0);
  assert.equal(Object.keys(pkg.devDependencies ?? {}).length, 0);
});

test('Worker 部署绑定独立数据库、保留取消信号且不公开密钥或记录请求', () => {
  const config = JSON.parse(read('wrangler.json'));
  assert.equal(config.main, 'backend/src/worker.mjs');
  assert.ok(config.compatibility_flags.includes('enable_request_signal'));
  assert.equal(config.observability.enabled, false);
  assert.equal(config.preview_urls, false);
  assert.equal(new URL(config.vars.SITE_ORIGIN).origin, config.vars.SITE_ORIGIN);
  assert.ok(Object.keys(config.vars).every(name => ['CONTENT_KEY_TYPE', 'CONTENT_MAX_OUTPUT_TOKENS'].includes(name) || !/KEY|TOKEN|SECRET/.test(name)));
  assert.doesNotMatch(JSON.stringify(config), /sk-[A-Za-z0-9_-]{16,}/);
  assert.equal(config.d1_databases.length, 1);
  const db = config.d1_databases[0];
  assert.equal(db.binding, 'DB');
  assert.equal(db.migrations_dir, 'backend/migrations');
  assert.match(db.database_id, /^[a-f0-9-]{36}$/);
  assert.equal(config.triggers.crons.length, 1);
});

test('真实验收只允许主仓库主分支显式手动授权且不保存密钥产物', () => {
  const workflow = read('.github/workflows/verify-live.yml');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /github\.repository == 'sayhiby0\/gamego'/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /inputs\.confirm_paid == true/);
  assert.match(workflow, /default: false/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /pull_request|schedule:|upload-artifact|contents: write/);
  const script = read('scripts/verify-live.mjs');
  assert.match(script, /process\.env\.ACCEPTANCE_API_KEY/);
  assert.doesNotMatch(script, /process\.env\.CONTENT_API_KEY|writeFile|appendFile/);
  assert.match(script, /redirect: 'error'/);
});

test('真实验收缺少配置时在网络请求前失败且只报告固定错误码', () => {
  for (const [env, stage, code, keyIssue] of [
    [{}, 'api-key', 'key_invalid', 'missing'],
    [{ ACCEPTANCE_API_KEY: `sk-sp-${'x'.repeat(20)}` }, 'api-key', 'key_type', 'coding_plan'],
    [{ ACCEPTANCE_API_KEY: `sk-${'x'.repeat(20)}\n` }, 'api-key', 'key_invalid', 'surrounding_whitespace'],
    [{ ACCEPTANCE_API_KEY: 'not-a-provider-prefix' }, 'api-key', 'key_invalid', 'unsupported_prefix'],
    [{ ACCEPTANCE_API_KEY: `"sk-${'x'.repeat(20)}"` }, 'api-key', 'key_invalid', 'quoted_value'],
    [{ ACCEPTANCE_API_KEY: `sk-${'x'.repeat(20)}` }, 'service-token', 'check_failed', undefined],
  ]) {
    const result = spawnSync(process.execPath, [join(root, 'scripts/verify-live.mjs'), 'content'], { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(result.stderr), { ok: false, phase: 'content', stage, code, ...(keyIssue ? { keyIssue } : {}) });
  }
});
