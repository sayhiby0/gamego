const CONTENT_BUDGET_MICROS = 20_000_000;
const DAY_MS = 86_400_000;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

function micros(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function metadata(value, name, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new TypeError(`${name} must be a non-empty metadata string (max ${max})`);
  }
  return value;
}

function timestamp(value) {
  const ms = value instanceof Date ? value.getTime() : value;
  if (!Number.isSafeInteger(ms) || !Number.isFinite(new Date(ms).getTime())) {
    throw new RangeError('time must be a valid Date or Unix milliseconds');
  }
  return ms;
}

/** Beijing calendar month; accepts a Date, Unix milliseconds or an ISO date with zone. */
export function billingMonth(date) {
  if (typeof date === 'string') {
    // Refuse timezone-less strings: the host timezone must not change the budget month.
    if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(date)) {
      throw new RangeError('date strings must include an explicit timezone');
    }
    date = Date.parse(date);
  }
  const beijing = new Date(timestamp(date) + BEIJING_OFFSET_MS);
  const year = beijing.getUTCFullYear();
  if (!Number.isInteger(year) || year < 1 || year > 9999) {
    throw new RangeError('billing year must be between 0001 and 9999');
  }
  return beijing.toISOString().slice(0, 7);
}

/**
 * Reserve BEFORE calling a paid provider. db is GameGo's D1 binding, not another
 * project's database. now comes from the trusted server clock (Unix milliseconds).
 * The caller must validate the model's versioned price and a complete cost ceiling.
 * All owners/models/prices share the content cap; Agent has no monthly budget cap.
 * False means duplicate id or insufficient budget; database errors propagate.
 */
export async function reserve(db, {
  id, channel, month, model, priceVersion, upperMicros, now = Date.now(), owner,
}) {
  metadata(id, 'id');
  metadata(model, 'model', 128);
  metadata(priceVersion, 'priceVersion', 128);
  metadata(owner, 'owner');
  micros(upperMicros, 'upperMicros');
  now = timestamp(now);
  if (channel !== 'content' && channel !== 'agent') {
    throw new TypeError('channel must be content or agent');
  }
  if (month !== billingMonth(now)) {
    throw new RangeError('month must match the request time in Beijing');
  }

  // One write statement, not SELECT-then-INSERT. D1 serializes competing writes.
  // Use charged (not upper): completed work can release only its verified excess.
  // Archived charges count as well, including day 1 charges on a 31-day month.
  const result = await db.prepare(`
    INSERT INTO usage (
      id, channel, month, model, price_version, upper_micros,
      charged_micros, status, created_at, owner
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?
    WHERE ? = 'agent' OR (
      SELECT COALESCE(SUM(charged_micros), 0) FROM (
        SELECT charged_micros FROM usage WHERE channel = 'content' AND month = ?
        UNION ALL
        SELECT charged_micros FROM usage_monthly WHERE channel = 'content' AND month = ?
      )
    ) <= ?
    ON CONFLICT(id) DO NOTHING
  `).bind(
    id, channel, month, model, priceVersion, upperMicros, upperMicros, now, owner,
    channel, month, month, CONTENT_BUDGET_MICROS - upperMicros,
  ).run();
  return result.meta.changes === 1;
}

/**
 * One terminal transition per request; false means missing/already finished or
 * actual > upper. Missing usage and uncertain outcomes retain the full ceiling.
 * Negative, fractional, unsafe costs and invalid statuses throw without writing.
 * An archived request cannot be finished; authoritative later reconciliation is
 * deliberately not an implicit second finish. Retries require NEW request ids.
 */
export async function finish(db, id, { actualMicros, status } = {}) {
  metadata(id, 'id');
  if (actualMicros !== undefined && actualMicros !== null) {
    micros(actualMicros, 'actualMicros');
  }
  const actual = actualMicros ?? null;
  status ??= actual === null ? 'unknown' : 'settled';
  if (typeof status !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(status)
      || status === 'reserved') {
    throw new TypeError('status must be a terminal metadata code, not reserved');
  }
  const uncertain = new Set([
    'unknown', 'timeout', 'timed_out', 'interrupted', 'aborted', 'cancelled', 'canceled',
  ]).has(status);
  const result = await db.prepare(`
    UPDATE usage
    SET charged_micros = CASE WHEN ? IS NULL OR ? = 1 THEN upper_micros ELSE ? END,
        status = ?
    WHERE id = ? AND status = 'reserved' AND (? IS NULL OR ? <= upper_micros)
  `).bind(actual, uncertain ? 1 : 0, actual, status, id, actual, actual).run();
  return result.meta.changes === 1;
}

/**
 * Drop details older than 30 days, keeping aggregates for the current Beijing
 * month plus the preceding 11 months. Expiry timestamps are Unix milliseconds.
 * D1 batch is transactional: archive AND delete succeed together, or neither does.
 * Unresolved requests retain their details and ceiling until explicit reconciliation.
 * No owner identity is retained in monthly totals. Never touches other projects.
 */
export async function cleanup(db, now = Date.now()) {
  now = timestamp(now);
  billingMonth(now); // Validate the same calendar range used for reservations.
  const cutoff = now - 30 * DAY_MS;
  const oldest = new Date(now + BEIJING_OFFSET_MS);
  oldest.setUTCDate(1);
  oldest.setUTCMonth(oldest.getUTCMonth() - 11);
  const oldestMonth = oldest.toISOString().slice(0, 7);

  const statements = [
    db.prepare(`
      INSERT INTO usage_monthly (
        channel, month, model, price_version, charged_micros, request_count
      )
      SELECT channel, month, model, price_version, SUM(charged_micros), COUNT(*)
      FROM usage WHERE created_at < ? AND month >= ? AND status = 'settled'
      GROUP BY channel, month, model, price_version
      ON CONFLICT(channel, month, model, price_version) DO UPDATE SET
        charged_micros = usage_monthly.charged_micros + excluded.charged_micros,
        request_count = usage_monthly.request_count + excluded.request_count
    `).bind(cutoff, oldestMonth),
    db.prepare("DELETE FROM usage WHERE created_at < ? AND status = 'settled'").bind(cutoff),
    db.prepare('DELETE FROM usage_monthly WHERE month < ?').bind(oldestMonth),
  ];
  for (const table of [
    'auth_states', 'exchanges', 'sessions', 'job_leases', 'rate_limits', 'content_cache', 'content_leases',
  ]) {
    statements.push(db.prepare(`DELETE FROM ${table} WHERE expires_at <= ?`).bind(now));
  }
  return db.batch(statements);
}
