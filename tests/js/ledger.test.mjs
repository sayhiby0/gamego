import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { reserve, finish, billingMonth, cleanup } from '../../backend/src/ledger.mjs';

const migration = readFileSync(new URL('../../backend/migrations/001_initial.sql', import.meta.url), 'utf8');
const NOW = Date.parse('2026-01-31T04:00:00Z');
const DAY_MS = 86_400_000;
const CAP = 20_000_000;

// The production module uses only D1's prepared statements and atomic batch API.
// Real SQLite constraints, locking, SQL parsing and rollback are exercised here.
class D1 {
  constructor(path = ':memory:') {
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec('PRAGMA busy_timeout = 10000');
    this.writes = [];
  }

  prepare(sql) {
    const statement = this.sqlite.prepare(sql);
    const wrap = (args) => ({
      bind: (...values) => wrap(values),
      _run: () => {
        this.writes.push(sql);
        const result = statement.run(...args);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
      run: async () => wrap(args)._run(),
      first: async (column) => {
        const row = statement.get(...args);
        return column === undefined ? row ?? null : row?.[column] ?? null;
      },
      all: async () => ({ success: true, results: statement.all(...args) }),
    });
    return wrap([]);
  }

  async batch(statements) {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement) => statement._run());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }

  close() { this.sqlite.close(); }
}

function database(t) {
  const db = new D1();
  db.sqlite.exec(migration);
  t.after(() => db.close());
  return db;
}

function request(id, overrides = {}) {
  return {
    id, channel: 'content', month: billingMonth(NOW), model: 'model-a',
    priceVersion: '2026-01-a', upperMicros: 1_000_000, now: NOW, owner: 'job-a',
    ...overrides,
  };
}

function row(db, id) {
  const value = db.sqlite.prepare('SELECT * FROM usage WHERE id = ?').get(id);
  return value ? { ...value } : null;
}

function total(db, channel = 'content', month = billingMonth(NOW)) {
  return db.sqlite.prepare(`
    SELECT COALESCE(SUM(charged_micros), 0) AS amount FROM (
      SELECT charged_micros FROM usage WHERE channel = ? AND month = ?
      UNION ALL
      SELECT charged_micros FROM usage_monthly WHERE channel = ? AND month = ?
    )
  `).get(channel, month, channel, month).amount;
}

async function contenders(path, sharedId = false) {
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const workers = Array.from({ length: 8 }, (_, index) => new Worker(new URL(import.meta.url), {
    workerData: { path, gate: gate.buffer, index, sharedId },
  }));
  const readiness = [];
  const completions = [];
  for (const worker of workers) {
    let readyResolve;
    let readyReject;
    let doneResolve;
    let doneReject;
    readiness.push(new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; }));
    completions.push(new Promise((resolve, reject) => { doneResolve = resolve; doneReject = reject; }));
    worker.on('message', (message) => {
      if (message === 'ready') readyResolve();
      else if (message.type === 'done') doneResolve(message.results);
    });
    worker.on('error', (error) => { readyReject(error); doneReject(error); });
    worker.on('exit', (code) => {
      if (code !== 0) {
        const error = new Error(`SQLite contender exited with code ${code}`);
        readyReject(error);
        doneReject(error);
      }
    });
  }
  // Attach completion handlers before waiting for readiness to avoid stray rejections.
  const done = Promise.all(completions);
  const ready = Promise.all(readiness).then(() => {
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0, workers.length);
  });
  try {
    const [, results] = await Promise.all([ready, done]);
    return results.flat();
  } finally {
    // Close every connection before the caller removes its temporary database.
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}

if (!isMainThread) {
  const db = new D1(workerData.path);
  try {
    const gate = new Int32Array(workerData.gate);
    parentPort.postMessage('ready');
    Atomics.wait(gate, 0, 0, 15_000);
    const results = [];
    for (let index = 0; index < 5; index += 1) {
      results.push(await reserve(db, request(
        workerData.sharedId ? 'same-request' : `worker-${workerData.index}-${index}`,
        { upperMicros: 1_250_000, owner: `worker-${workerData.index}` },
      )));
    }
    parentPort.postMessage({ type: 'done', results });
  } finally {
    db.close();
  }
} else {
  test('migration is repeatable and creates all metadata tables without chat columns', (t) => {
    const db = database(t);
    db.sqlite.exec("INSERT INTO allowlist VALUES ('existing-hash', 1)");
    db.sqlite.exec(migration);
    for (const name of [
      'auth_states', 'exchanges', 'sessions', 'allowlist', 'usage', 'usage_monthly',
      'job_leases', 'rate_limits', 'content_cache', 'content_leases',
    ]) {
      assert.ok(db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
      const columns = db.sqlite.prepare(`PRAGMA table_info(${name})`).all().map((column) => column.name);
      assert.ok(columns.every((column) => !/prompt|message|response|chat|email(?!_hash)/.test(column)));
    }
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM allowlist').get().n, 1);
    assert.deepEqual(
      db.sqlite.prepare('PRAGMA table_info(usage)').all().map((column) => column.name),
      ['id', 'channel', 'month', 'model', 'price_version', 'upper_micros', 'charged_micros', 'status', 'created_at', 'owner'],
    );
  });

  test('billingMonth uses Beijing month boundaries, leap day and year rollover', () => {
    for (const [input, expected] of [
      ['2026-01-31T15:59:59.999Z', '2026-01'],
      ['2026-01-31T16:00:00.000Z', '2026-02'],
      ['2026-12-31T15:59:59.999Z', '2026-12'],
      ['2026-12-31T16:00:00.000Z', '2027-01'],
      ['2024-02-29T15:59:59.999Z', '2024-02'],
      ['2024-02-29T16:00:00.000Z', '2024-03'],
      ['2026-02-01T00:00:00+08:00', '2026-02'],
    ]) {
      assert.equal(billingMonth(input), expected);
      assert.equal(billingMonth(new Date(input)), expected);
      assert.equal(billingMonth(Date.parse(input)), expected);
    }
    for (const input of [null, undefined, NaN, Infinity, new Date('invalid'), '2026-01-31T16:00:00', 'bad']) {
      assert.throws(() => billingMonth(input), RangeError);
    }
  });

  test('reserve makes one INSERT SELECT WHERE, accepts exact cap, blocks excess and duplicates', async (t) => {
    const db = database(t);
    assert.equal(await reserve(db, request('full', { upperMicros: CAP })), true);
    assert.equal(db.writes.length, 1);
    assert.match(db.writes[0], /INSERT INTO usage[\s\S]*SELECT[\s\S]*WHERE/);
    assert.match(db.writes[0], /SUM\(charged_micros\)/);
    assert.equal(row(db, 'full').charged_micros, CAP);
    assert.equal(row(db, 'full').status, 'reserved');
    assert.equal(await reserve(db, request('over', { upperMicros: 1 })), false);
    assert.equal(await reserve(db, request('full', { upperMicros: 0 })), false);
    assert.equal(await reserve(db, request('free', { upperMicros: 0 })), true);
    assert.equal(await reserve(db, request('too-large', { upperMicros: CAP + 1 })), false);
    assert.equal(total(db), CAP);
  });

  for (const archived of [false, true]) {
    test(`real concurrent SQLite connections cannot overspend${archived ? ' after archival' : ''}`, { timeout: 30_000 }, async (t) => {
      const directory = mkdtempSync(join(tmpdir(), 'gamego-ledger-'));
      const path = join(directory, 'ledger.sqlite');
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      const db = new D1(path);
      db.sqlite.exec('PRAGMA journal_mode = WAL');
      db.sqlite.exec(migration);
      if (archived) {
        await reserve(db, request('old', { upperMicros: 5_000_000, now: Date.parse('2025-12-31T16:00:00Z') }));
        await finish(db, 'old', { actualMicros: 5_000_000 });
        await cleanup(db, NOW);
        assert.equal(row(db, 'old'), null);
      }
      db.close();
      const results = await contenders(path);
      assert.equal(results.filter(Boolean).length, archived ? 12 : 16);
      const check = new D1(path);
      try { assert.equal(total(check), CAP); } finally { check.close(); }
    });
  }

  test('concurrent duplicate reservation ids can be charged only once', { timeout: 30_000 }, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'gamego-ledger-'));
    const path = join(directory, 'ledger.sqlite');
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const db = new D1(path);
    db.sqlite.exec('PRAGMA journal_mode = WAL');
    db.sqlite.exec(migration);
    db.close();
    const results = await contenders(path, true);
    assert.equal(results.filter(Boolean).length, 1);
  });

  test('known lower charge releases only its excess; double/concurrent finish cannot rewrite it', async (t) => {
    const db = database(t);
    await reserve(db, request('one', { upperMicros: CAP }));
    const settled = await Promise.all([
      finish(db, 'one', { actualMicros: 7_000_000, status: 'ok' }),
      finish(db, 'one', { actualMicros: 1, status: 'ok' }),
    ]);
    assert.deepEqual(settled, [true, false]);
    assert.equal(row(db, 'one').charged_micros, 7_000_000);
    assert.equal(await finish(db, 'one', { status: 'unknown' }), false);
    assert.equal(await reserve(db, request('remainder', { upperMicros: 13_000_000 })), true);
    assert.equal(await reserve(db, request('blocked', { upperMicros: 1 })), false);
    assert.equal(await finish(db, 'missing', { actualMicros: 0 }), false);
  });

  test('known exact/zero actual fees are valid; above-upper fees leave reservation unchanged', async (t) => {
    const db = database(t);
    await reserve(db, request('one'));
    assert.equal(await finish(db, 'one', { actualMicros: 1_000_001, status: 'ok' }), false);
    assert.equal(row(db, 'one').status, 'reserved');
    assert.equal(row(db, 'one').charged_micros, 1_000_000);
    assert.equal(await finish(db, 'one', { actualMicros: 1_000_000 }), true);
    await reserve(db, request('zero'));
    assert.equal(await finish(db, 'zero', { actualMicros: 0 }), true);
    assert.equal(row(db, 'zero').charged_micros, 0);
  });

  test('unknown usage, timeout, disconnection and cancellation keep the ceiling even with partial usage', async (t) => {
    const db = database(t);
    const outcomes = [
      {}, { actualMicros: null }, { status: 'ok' },
      ...['unknown', 'timeout', 'timed_out', 'interrupted', 'aborted', 'cancelled', 'canceled']
        .map((status) => ({ status, actualMicros: 0 })),
    ];
    for (const [index, outcome] of outcomes.entries()) {
      const id = `uncertain-${index}`;
      await reserve(db, request(id));
      assert.equal(await finish(db, id, outcome), true);
      assert.equal(row(db, id).charged_micros, 1_000_000);
      assert.notEqual(row(db, id).status, 'reserved');
      assert.equal(await finish(db, id, { actualMicros: 0 }), false);
    }
    assert.equal(total(db), outcomes.length * 1_000_000);
  });

  test('uncertain request and retry each consume their own reservation', async (t) => {
    const db = database(t);
    await reserve(db, request('first', { upperMicros: 12_000_000 }));
    await finish(db, 'first', { status: 'timeout' });
    assert.equal(await reserve(db, request('retry', { upperMicros: 12_000_000 })), false);
    assert.equal(await reserve(db, request('retry', { upperMicros: 8_000_000 })), true);
    assert.equal(total(db), CAP);
  });

  test('month rollover grants only the new month budget; finish never moves old charges', async (t) => {
    const db = database(t);
    const before = Date.parse('2026-01-31T15:59:59.999Z');
    const after = before + 1;
    await reserve(db, request('jan', { upperMicros: CAP, now: before }));
    await reserve(db, request('feb', { upperMicros: CAP, now: after, month: '2026-02' }));
    assert.equal(total(db, 'content', '2026-01'), CAP);
    assert.equal(total(db, 'content', '2026-02'), CAP);
    await finish(db, 'jan', { actualMicros: 5_000_000, status: 'ok' });
    assert.equal(row(db, 'jan').month, '2026-01');
    assert.equal(total(db, 'content', '2026-02'), CAP);
    await assert.rejects(reserve(db, request('wrong-month', { now: after })), /month/);
  });

  test('models and price versions retain their own immutable metadata, not separate content caps', async (t) => {
    const db = database(t);
    await reserve(db, request('old-price', { upperMicros: 8_000_000 }));
    await reserve(db, request('new-price', { upperMicros: 12_000_000, model: 'model-b', priceVersion: '2026-01-b', owner: 'job-b' }));
    assert.equal(await reserve(db, request('another-price', { upperMicros: 1, priceVersion: '2026-01-c' })), false);
    await finish(db, 'old-price', { actualMicros: 5_000_000 });
    assert.equal(row(db, 'old-price').model, 'model-a');
    assert.equal(row(db, 'old-price').price_version, '2026-01-a');
    assert.equal(row(db, 'new-price').model, 'model-b');
    assert.equal(row(db, 'new-price').price_version, '2026-01-b');
    assert.equal(total(db), 17_000_000);
  });

  test('Agent spending is uncapped and separate; no external-project tables are modified', async (t) => {
    const db = database(t);
    db.sqlite.exec('CREATE TABLE old_project_usage (charged_micros INTEGER); INSERT INTO old_project_usage VALUES (99000000)');
    await reserve(db, request('agent-first', { channel: 'agent', upperMicros: 100_000_000 }));
    assert.equal(await reserve(db, request('content-full', { upperMicros: CAP })), true);
    assert.equal(await reserve(db, request('agent-again', { channel: 'agent', upperMicros: 100_000_000 })), true);
    assert.equal(await reserve(db, request('content-over', { upperMicros: 1 })), false);
    assert.equal(total(db, 'agent'), 200_000_000);
    assert.equal(total(db), CAP);
    await cleanup(db, NOW);
    assert.equal(db.sqlite.prepare('SELECT charged_micros FROM old_project_usage').get().charged_micros, 99_000_000);
  });

  test('invalid costs, channel, metadata, clock, month and nonterminal status never write', async (t) => {
    const db = database(t);
    const invalid = [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', 1n, true];
    for (const upperMicros of [...invalid, undefined, null]) {
      await assert.rejects(reserve(db, request('invalid', { upperMicros })), RangeError);
    }
    for (const overrides of [
      { channel: 'other' }, { id: '' }, { owner: '' }, { model: '' }, { priceVersion: '' },
      { priceVersion: null }, { now: NaN }, { month: '2026-13' }, { month: '2026-02' },
    ]) {
      await assert.rejects(reserve(db, request('invalid', overrides)));
    }
    assert.equal(db.writes.length, 0);
    await reserve(db, request('valid'));
    for (const actualMicros of invalid) {
      await assert.rejects(finish(db, 'valid', { actualMicros }), RangeError);
    }
    for (const status of ['reserved', '', 'chat body text', 42]) {
      await assert.rejects(finish(db, 'valid', { actualMicros: 0, status }), TypeError);
    }
    assert.equal(db.writes.length, 1);
    assert.equal(row(db, 'valid').charged_micros, 1_000_000);
  });

  test('SQL constraints independently reject negative and fractional charges', async (t) => {
    const db = database(t);
    await reserve(db, request('one'));
    for (const value of [-1, 0.5, 1_000_001]) {
      assert.throws(() => db.sqlite.prepare('UPDATE usage SET charged_micros = ?').run(value), /CHECK constraint/);
    }
    assert.equal(row(db, 'one').charged_micros, 1_000_000);
  });

  test('cleanup preserves the full current-month charge on day 31; repeating it never double-counts', async (t) => {
    const db = database(t);
    const firstDay = Date.parse('2025-12-31T16:00:00Z');
    await reserve(db, request('old-pending', { now: firstDay, upperMicros: 8_000_000 }));
    await reserve(db, request('old-settled', { now: firstDay, upperMicros: 8_000_000 }));
    await finish(db, 'old-settled', { actualMicros: 5_000_000 });
    await reserve(db, request('new', { upperMicros: 7_000_000 }));
    await cleanup(db, NOW);
    assert.equal(row(db, 'old-pending').status, 'reserved');
    assert.equal(row(db, 'old-settled'), null);
    assert.ok(row(db, 'new'));
    const summary = { ...db.sqlite.prepare('SELECT * FROM usage_monthly').get() };
    assert.equal(summary.charged_micros, 5_000_000);
    assert.equal(summary.request_count, 1);
    assert.equal(summary.owner, undefined);
    assert.equal(total(db), CAP);
    assert.equal(await reserve(db, request('over', { upperMicros: 1 })), false);
    await cleanup(db, NOW);
    assert.deepEqual({ ...db.sqlite.prepare('SELECT * FROM usage_monthly').get() }, summary);
    assert.equal(total(db), CAP);
    await cleanup(db, Date.parse('2028-02-01T00:00:00Z'));
    assert.equal(row(db, 'old-pending').charged_micros, 8_000_000);
  });

  test('cleanup adds newly aged rows once and preserves model, price and channel separation', async (t) => {
    const db = database(t);
    const firstDay = Date.parse('2025-12-31T16:00:00Z');
    const cases = [
      { id: 'earlier', now: firstDay },
      { id: 'later', now: firstDay + 60 * 60 * 1000 },
      { id: 'new-model', now: firstDay, model: 'model-b', priceVersion: 'price-b' },
      { id: 'new-price', now: firstDay, priceVersion: 'price-b' },
      { id: 'agent', now: firstDay, channel: 'agent' },
    ];
    for (const value of cases) {
      await reserve(db, request(value.id, value));
      await finish(db, value.id, { actualMicros: 1_000_000 });
    }
    await cleanup(db, firstDay + 30 * DAY_MS + 1);
    assert.ok(row(db, 'later'));
    await cleanup(db, NOW);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM usage').get().n, 0);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM usage_monthly').get().n, 4);
    assert.equal(total(db), 4_000_000);
    assert.equal(total(db, 'agent'), 1_000_000);
    assert.equal(db.sqlite.prepare("SELECT request_count FROM usage_monthly WHERE channel = 'content' AND model = 'model-a' AND price_version = '2026-01-a'").get().request_count, 2);
  });

  test('cleanup keeps exactly 12 Beijing months of aggregate data across a year boundary', async (t) => {
    const db = database(t);
    for (const [id, date] of [
      ['expire-summary', '2025-12-31T16:00:00Z'],
      ['expire-detail', '2026-01-01T00:00:00Z'],
      ['retain-feb', '2026-01-31T16:00:00Z'],
      ['retain-dec', '2026-12-01T00:00:00Z'],
    ]) {
      const now = Date.parse(date);
      await reserve(db, request(id, { now, month: billingMonth(now) }));
      await finish(db, id, { actualMicros: 1_000_000 });
      if (id === 'expire-summary') await cleanup(db, NOW);
    }
    await cleanup(db, Date.parse('2027-01-31T04:00:00Z'));
    assert.equal(row(db, 'expire-detail'), null);
    assert.equal(total(db, 'content', '2026-01'), 0);
    assert.equal(total(db, 'content', '2026-02'), 1_000_000);
    assert.equal(total(db, 'content', '2026-12'), 1_000_000);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM usage_monthly').get().n, 2);
  });

  test('cleanup expires auth/security/cache rows at the boundary, retains live rows and allowlist', async (t) => {
    const db = database(t);
    for (const [id, expires] of [['expired', NOW - 1], ['boundary', NOW], ['live', NOW + 1]]) {
      db.sqlite.prepare('INSERT INTO auth_states VALUES (?, ?, ?)').run(id, 'challenge', expires);
      db.sqlite.prepare('INSERT INTO exchanges VALUES (?, ?, ?, ?, ?)').run(id, 'challenge', 'subject', '["email-hash"]', expires);
      db.sqlite.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(id, 'subject', '["email-hash"]', expires);
      db.sqlite.prepare('INSERT INTO job_leases VALUES (?, ?, ?)').run(id, 'owner', expires);
      db.sqlite.prepare('INSERT INTO rate_limits VALUES (?, ?, ?)').run(id, 1, expires);
      db.sqlite.prepare('INSERT INTO content_cache VALUES (?, ?, ?)').run(id, '{"public":true}', expires);
      db.sqlite.prepare('INSERT INTO content_leases VALUES (?, ?, ?)').run(id, 'owner', expires);
    }
    db.sqlite.exec("INSERT INTO allowlist VALUES ('permitted-hash', 1)");
    await reserve(db, request('exactly-30-days', { now: NOW - 30 * DAY_MS }));
    await cleanup(db, NOW);
    assert.ok(row(db, 'exactly-30-days'));
    for (const table of ['auth_states', 'exchanges', 'sessions', 'job_leases', 'rate_limits', 'content_cache', 'content_leases']) {
      const rows = db.sqlite.prepare(`SELECT * FROM ${table}`).all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].expires_at, NOW + 1);
    }
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM allowlist').get().n, 1);
  });

  test('a failed cleanup batch rolls back archive, detail deletion and expiry deletion together', async (t) => {
    const db = database(t);
    await reserve(db, request('old', { upperMicros: CAP, now: Date.parse('2025-12-31T16:00:00Z') }));
    await finish(db, 'old', { actualMicros: CAP });
    db.sqlite.prepare('INSERT INTO auth_states VALUES (?, ?, ?)').run('expired', 'challenge', NOW);
    db.sqlite.prepare('INSERT INTO content_cache VALUES (?, ?, ?)').run('expired', '{}', NOW);
    db.sqlite.exec(`
      CREATE TRIGGER fail_cleanup BEFORE DELETE ON content_cache
      BEGIN SELECT RAISE(ABORT, 'injected cleanup failure'); END;
    `);
    await assert.rejects(cleanup(db, NOW), /injected cleanup failure/);
    assert.ok(row(db, 'old'));
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM usage_monthly').get().n, 0);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM auth_states').get().n, 1);
    assert.equal(total(db), CAP);
    assert.equal(await reserve(db, request('blocked', { upperMicros: 1 })), false);
    db.sqlite.exec('DROP TRIGGER fail_cleanup');
    await cleanup(db, NOW);
    assert.equal(row(db, 'old'), null);
    assert.equal(total(db), CAP);
  });

  test('database failures propagate instead of granting an unrecorded reservation', async () => {
    const db = new D1();
    db.close();
    await assert.rejects(reserve(db, request('closed')));
  });
}
