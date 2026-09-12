// ── The durable store: Postgres behind the seams that already exist ─────────
//
// WHY THIS EXISTS. Railway attaches a volume to a SINGLE instance, so a service
// with `numReplicas: 1` and a volume at /data cannot run two containers at
// once — every deploy is stop-then-start by construction and no health check
// can hide the gap. The volume is the whole blocker; the health check
// (`/healthz`), the disk cache surviving a restart, and the paced prewarm are
// all already fine. So: get the state off the volume, then raise replicas.
//
// THE DESIGN IS "SAME SIGNATURES, DIFFERENT BACKEND". Three seams already
// existed in server.js and every one of them is preserved exactly:
//
//   readJSON(file, def) / writeJSON(file, data)   46 reads, 35 writes — SYNC
//   readEvents(daysBack)                          18 readers          — SYNC
//   getDiskCached / setCache / hydrate            the feed cache      — async
//
// The two sync ones are the constraint that shapes everything here. Postgres is
// async, so reads are served from an in-memory mirror that is loaded once at
// boot and kept current; writes update that mirror synchronously and enqueue
// the upsert. Making the 81 config call sites async instead would have touched
// every route on the platform to move a few kilobytes of JSON.
//
// MODES, and the reason there are three. The flip is a sequence of env changes,
// each one reversible without a code change:
//
//   disk  no DATABASE_URL. Byte-identical to the behaviour before this module
//         existed. This is what ships first, and what a PR preview runs.
//   dual  write BOTH, read DISK. Postgres is being filled and proven while the
//         volume is still the authority — so a bug here cannot lose data.
//   db    read POSTGRES, still write disk. The volume becomes the safety net
//         rather than the source, and rolling back is one env var.
//
// There is deliberately no fourth "postgres only" mode. Dropping the disk write
// buys nothing while the volume is still mounted, and the moment it is detached
// the writes fail harmlessly into the container's own ephemeral filesystem.
//
// POSTGRES ONLY — NO REDIS, and this reverses what I first recommended. I
// argued for Redis for the feed cache on TTL support and vacuum churn. Costed
// properly the churn is ~84 prewarmed keys rewritten six times a day, which is
// nothing for autovacuum, and TTL is one timestamp column the readers already
// compute. One service means one URL, one failure mode and one thing to check
// at 8am. If the cache ever outgrows it, every cache read and write in this
// file is behind cacheGet/cacheSet/cacheHydrate and Redis drops in there.

"use strict";

const fs   = require("fs");
const path = require("path");

let pg = null;
try { pg = require("pg"); } catch { /* disk mode needs no driver */ }

// ── Configuration ──────────────────────────────────────────────────────────

const S = {
  mode: "disk",              // disk | dual | db
  dataDir: null,
  pool: null,
  ready: false,              // the schema exists and the mirror is loaded
  // The config mirror. Keyed by the path RELATIVE to DATA_DIR, so a caller
  // keeps passing the absolute path it already has and nothing at the call
  // site changes — including the nested ones (goals/<slug>.json, qbr/<id>.json).
  kv: new Map(),             // relKey -> parsed value
  kvRev: 0,                  // highest `rev` seen; the cross-replica cursor
  pending: new Map(),        // relKey -> latest value awaiting its upsert
  flushing: false,
  events: [],                // the shared in-memory event log
  eventsMaxId: 0,
  eventsLoaded: false,
  // Whether `events` is still in ascending ts order. readEvents() in server.js
  // binary-searches the window when it is and falls back to a linear filter
  // when it is not — which matters: that log is ~82k records and the linear
  // path made readEvents(1) cost the same as readEvents(null).
  eventsSorted: true,
  eventsLastTs: "",
  errors: 0,
  lastError: "",
  pollTimer: null,
  // Subscribers notified when a poll brings in a key another replica changed.
  // Some config is not just READ on demand — server.js folds orgs.json into a
  // module-level ORGS object at boot — so without this an org added on one
  // replica is "Unknown org" on the others until they restart. Found by
  // scripts/store-live.spec.js, not by review.
  watchers: []
};

function mode() { return S.mode; }
function usingDb() { return S.mode !== "disk"; }
function readsDb() { return S.mode === "db" && S.ready; }
function status() {
  return {
    mode: S.mode, ready: S.ready, keys: S.kv.size, rev: S.kvRev,
    events: S.events.length, eventsMaxId: S.eventsMaxId,
    pending: S.pending.size, errors: S.errors, lastError: S.lastError
  };
}

function note(where, err) {
  S.errors++;
  S.lastError = where + ": " + (err && err.message ? err.message : String(err));
  console.warn("[store] " + S.lastError);
}

// ── Schema ─────────────────────────────────────────────────────────────────
//
// Three tables, and the columns that are not obvious:
//
//   kv_store.rev   a bigint from ONE sequence shared by every row. A replica
//                  polls `max(rev)` and pulls only rows past its cursor, which
//                  is how a flag flipped on replica A reaches replica B. A
//                  per-row updated_at cannot do that job: two clocks.
//   events.id      the same trick for the event log, replacing the byte offset
//                  the file version tailed on.
//   feed_cache.expires_at  written, and NOT trusted on read. The readers apply
//                  their own TTL (it varies by report, by org, and by whether
//                  the entry is historical), so this column exists for the
//                  sweeper alone. Enforcing it here would quietly break the
//                  stale-cache fallback, which deliberately reads entries past
//                  their TTL when Metabase is down.

const SCHEMA = `
CREATE SEQUENCE IF NOT EXISTS store_rev_seq;

CREATE TABLE IF NOT EXISTS kv_store (
  k          text PRIMARY KEY,
  v          jsonb NOT NULL,
  rev        bigint NOT NULL DEFAULT nextval('store_rev_seq'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kv_store_rev_index ON kv_store (rev);

CREATE TABLE IF NOT EXISTS events (
  id  bigserial PRIMARY KEY,
  ts  timestamptz NOT NULL,
  rec jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS events_ts_index ON events (ts);

CREATE TABLE IF NOT EXISTS feed_cache (
  k          text PRIMARY KEY,
  v          jsonb NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feed_cache_expires_index ON feed_cache (expires_at);
`;

async function configure(opts) {
  S.dataDir = opts.dataDir;
  const url = opts.databaseUrl || "";
  // No URL is not a misconfiguration — it is the default, and it is what every
  // PR preview and every local run gets. Disk mode is the behaviour this
  // module replaced, unchanged.
  if (!url || !pg) { S.mode = "disk"; return status(); }
  S.mode = opts.mode === "db" ? "db" : "dual";
  S.pool = new pg.Pool({
    connectionString: url,
    max: Number(opts.max || 6),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    // Railway's internal Postgres presents a certificate the default verifier
    // rejects. This is a private-network hop to a database we provisioned, not
    // an outbound call, and `ssl: false` would be refused by the server — so
    // the connection is encrypted with verification relaxed, which is what the
    // Railway-provided URL expects.
    ssl: /\bsslmode=disable\b/.test(url) ? false : { rejectUnauthorized: false }
  });
  S.pool.on("error", e => note("pool", e));
  try {
    await S.pool.query(SCHEMA);
    await loadKv();
    // The whole log, deliberately. readEvents(null) has four callers (the audit
    // log, the QBR counters, the feedback list), so a windowed load would
    // silently truncate their answers. It is ~82k records and already sits in
    // memory today.
    await loadEvents(opts.eventDays || null);
    S.ready = true;
    startPolling(Number(opts.pollMs || 4000));
  } catch (e) {
    note("configure", e);
    // A database that will not answer must never take the reports down. Fall
    // back to the volume, which is still mounted and still authoritative in
    // every mode. The flip is then a no-op rather than an outage.
    S.mode = "disk";
    S.ready = false;
  }
  return status();
}

async function close() {
  if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; }
  await flush().catch(() => {});
  if (S.pool) { await S.pool.end().catch(() => {}); S.pool = null; }
  S.ready = false;
}

// ── The config mirror ──────────────────────────────────────────────────────

function relKey(file) {
  if (!S.dataDir) return String(file);
  const rel = path.relative(S.dataDir, String(file));
  // A path outside DATA_DIR is a bug at the call site, not something to
  // silently store under a `..` key that no other replica could resolve.
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

async function loadKv() {
  const r = await S.pool.query("SELECT k, v, rev FROM kv_store");
  S.kv.clear();
  S.kvRev = 0;
  for (const row of r.rows) {
    S.kv.set(row.k, row.v);
    if (Number(row.rev) > S.kvRev) S.kvRev = Number(row.rev);
  }
}

// Pull only what changed since this replica's cursor. Cheap enough to run
// every few seconds against an indexed bigint, and it is the entire
// cross-replica coherence story for config.
async function pollKv() {
  const r = await S.pool.query("SELECT k, v, rev FROM kv_store WHERE rev > $1", [S.kvRev]);
  const changed = [];
  for (const row of r.rows) {
    // A key still awaiting its own upsert is NEWER here than in the database.
    // Overwriting it with the row we are about to replace would undo a write
    // that has already been handed back to a caller as done.
    if (!S.pending.has(row.k)) { S.kv.set(row.k, row.v); changed.push(row.k); }
    if (Number(row.rev) > S.kvRev) S.kvRev = Number(row.rev);
  }
  if (changed.length) {
    for (const w of S.watchers) {
      try { w(changed); } catch (e) { note("watcher", e); }
    }
  }
  return r.rows.length;
}

// Subscribe to keys another replica changed. Fires only for a POLLED change:
// a local write already updated whatever the caller holds, and re-notifying it
// would have every settings save rebuild state it just set.
function onKeyChange(fn) { S.watchers.push(fn); }

function startPolling(ms) {
  if (S.pollTimer) clearInterval(S.pollTimer);
  S.pollTimer = setInterval(() => {
    pollKv().catch(e => note("pollKv", e));
    pollEvents().catch(e => note("pollEvents", e));
  }, ms);
  if (S.pollTimer.unref) S.pollTimer.unref();
}

// Serialised write-behind. One flush at a time and always the LATEST value per
// key, so a burst of writes to the same file costs one upsert and cannot land
// out of order — which a naive per-write promise would allow.
// `await flush()` has to MEAN flushed. The first version returned immediately
// when a flush was already running — which is the normal case, since writeJSON
// kicks one without awaiting it — so a caller that awaited this got a promise
// that resolved before its own write had left the queue. Callers now join the
// run in progress instead.
function flush() {
  if (!S.pool) return Promise.resolve();
  if (S.flushRun) return S.flushRun;
  if (!S.pending.size) return Promise.resolve();
  S.flushRun = drain().finally(() => { S.flushRun = null; });
  return S.flushRun;
}

async function drain() {
  S.flushing = true;
  try {
    while (S.pending.size) {
      // Snapshot, but do NOT clear: a key stays in `pending` until its own
      // upsert lands, because pollKv skips pending keys. Clearing first opens
      // a window where a poll overwrites the mirror with the very row this
      // flush is replacing — and our own RETURNING rev then advances the
      // cursor past it, so the stale value would never be corrected.
      const batch = Array.from(S.pending.entries());
      for (const [k, v] of batch) {
        try {
          const r = await S.pool.query(
            `INSERT INTO kv_store (k, v, rev, updated_at)
             VALUES ($1, $2::jsonb, nextval('store_rev_seq'), now())
             ON CONFLICT (k) DO UPDATE
               SET v = EXCLUDED.v, rev = nextval('store_rev_seq'), updated_at = now()
             RETURNING rev`,
            [k, JSON.stringify(v)]
          );
          const rev = Number(r.rows[0].rev);
          if (rev > S.kvRev) S.kvRev = rev;
        } catch (e) { note("flush " + k, e); }
        // Only retire the entry if nothing newer arrived while it was in
        // flight; otherwise leave the newer value for the next pass.
        if (S.pending.get(k) === v) S.pending.delete(k);
      }
    }
  } finally { S.flushing = false; }
}

function readJSON(file, def) {
  const key = relKey(file);
  if (readsDb() && key !== null && S.kv.has(key)) return S.kv.get(key);
  // In db mode a key the mirror has never seen falls through to disk rather
  // than to the default. "Postgres has no row" and "this org has no settings"
  // are different facts, and defaulting would silently reset every store the
  // import missed. Same rule as the presence gates on the report pages.
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return def; }
}

function writeJSON(file, data) {
  const key = relKey(file);
  if (usingDb() && key !== null) {
    S.kv.set(key, data);
    S.pending.set(key, data);
    flush().catch(e => note("flush", e));
  }
  // The disk write stays in every mode while the volume is mounted, so a
  // rollback to `disk` finds the file already current.
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) { if (!usingDb()) throw e; else note("writeJSON " + file, e); }
}

// Deleting has to remove the row as well as the file, or the next poll on
// another replica restores what was just deleted.
function deleteJSON(file) {
  const key = relKey(file);
  if (usingDb() && key !== null) {
    S.kv.delete(key);
    S.pending.delete(key);
    if (S.pool) {
      S.pool.query("DELETE FROM kv_store WHERE k = $1", [key]).catch(e => note("deleteJSON", e));
    }
  }
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}

// Directory listings (goals/, qbr/, deleted-orgs/) have to answer from the
// mirror in db mode or a replica that never wrote the file reports it missing.
function listJSON(dir) {
  const prefix = relKey(dir);
  const out = new Set();
  if (readsDb() && prefix !== null) {
    for (const k of S.kv.keys()) {
      if (k.startsWith(prefix + "/")) out.add(k.slice(prefix.length + 1));
    }
  }
  try { for (const f of fs.readdirSync(dir)) out.add(f); } catch { /* no dir yet */ }
  return Array.from(out);
}

// ── The event log ──────────────────────────────────────────────────────────

async function loadEvents(days) {
  const args = [];
  let where = "";
  if (days) { where = "WHERE ts >= now() - ($1 || ' days')::interval"; args.push(String(days)); }
  const r = await S.pool.query(
    `SELECT id, rec FROM events ${where} ORDER BY id`, args);
  S.events = [];
  S.eventsSorted = true;
  S.eventsLastTs = "";
  for (const row of r.rows) noteEvent(row.rec);
  S.eventsMaxId = r.rows.length ? Number(r.rows[r.rows.length - 1].id) : 0;
  S.eventsLoaded = true;
}

// Ordering is a property of the DATA, not of the transport: an event with no ts
// or one that arrives behind its predecessor (two replicas, two clocks) breaks
// the binary search whichever backend delivered it.
function noteEvent(rec) {
  S.events.push(rec);
  if (!rec || !rec.ts) { S.eventsSorted = false; return; }
  if (rec.ts < S.eventsLastTs) S.eventsSorted = false;
  else S.eventsLastTs = rec.ts;
}

async function pollEvents() {
  if (!S.eventsLoaded) return 0;
  const r = await S.pool.query(
    "SELECT id, rec FROM events WHERE id > $1 ORDER BY id", [S.eventsMaxId]);
  for (const row of r.rows) {
    noteEvent(row.rec);
    S.eventsMaxId = Number(row.id);
  }
  return r.rows.length;
}

// Sync, like the appendFileSync it replaces: a caller that awaited this would
// make every logged view wait on a round trip. Returns whether the store took
// the record, so server.js can append to the volume when it did not.
//
// ONLY IN `db` MODE — and getting this wrong shipped a real flaw. It used to
// take the record in `dual` too, so events went to Postgres and NOT to
// events.jsonl, while readEvents in dual still read the VOLUME. Every event
// logged in dual was therefore written where nothing read it and left off the
// log that was still the authority. Worse, it broke the import's resume: that
// counts existing rows against file lines, so stray rows make it skip the
// file's OLDEST lines.
//
// In dual the volume is the authority for events, exactly as it is for config.
// Postgres gets the whole log once, at import time.
//
// IT DOES NOT PUSH THE RECORD LOCALLY either. Pushing it and advancing the
// cursor is only safe if this row is the very next id — with two replicas it
// usually is not, so the next poll hands the same record back and the log
// double-counts. Every event arrives by exactly one path (the poll), and the
// insert kicks that poll so this replica sees its own event in milliseconds.
function appendEvent(rec) {
  if (!readsDb() || !S.pool) return false;
  S.pool.query("INSERT INTO events (ts, rec) VALUES ($1, $2::jsonb)",
    [rec.ts || new Date().toISOString(), JSON.stringify(rec)])
    .then(kickEventPoll)
    .catch(e => note("appendEvent", e));
  return true;
}

// Debounced, because a registration rush is hundreds of events a minute and
// each one would otherwise be its own query.
function kickEventPoll() {
  if (S._eventKick) return;
  S._eventKick = setTimeout(() => {
    S._eventKick = null;
    pollEvents().catch(e => note("pollEvents", e));
  }, 150);
  if (S._eventKick.unref) S._eventKick.unref();
}

// The shared array itself, never a copy — readEvents() in server.js already
// slices before handing anything to a caller, and copying 82k records on every
// read is what the byte-offset cache existed to avoid.
function allEvents() { return S.events; }
function eventsReady() { return readsDb() && S.eventsLoaded; }
function eventsSorted() { return S.eventsSorted; }

// ── The feed cache ─────────────────────────────────────────────────────────

async function cacheGet(key) {
  if (!readsDb() || !S.pool) return null;
  try {
    const r = await S.pool.query("SELECT v FROM feed_cache WHERE k = $1", [key]);
    return r.rows.length ? r.rows[0].v : null;
  } catch (e) { note("cacheGet", e); return null; }
}

function cacheSet(key, entry, ttlMs) {
  if (!usingDb() || !S.pool) return;
  const exp = ttlMs ? new Date(Date.now() + ttlMs) : null;
  S.pool.query(
    `INSERT INTO feed_cache (k, v, expires_at, updated_at)
     VALUES ($1, $2::jsonb, $3, now())
     ON CONFLICT (k) DO UPDATE
       SET v = EXCLUDED.v, expires_at = EXCLUDED.expires_at, updated_at = now()`,
    [key, JSON.stringify(entry), exp]
  ).catch(e => note("cacheSet", e));
}

// Deleting an org has to remove its cached payloads from the SHARED store, not
// only from this container's disk and memory — otherwise the org is gone from
// every surface and its rows are still sitting there for the next replica to
// hydrate. The disk sweep matches on each file's own `key`; this matches the
// same key server-side.
function cacheDelPrefix(prefix) {
  if (!usingDb() || !S.pool) return Promise.resolve(0);
  return S.pool.query("DELETE FROM feed_cache WHERE k LIKE $1", [prefix.replace(/([%_\\])/g, "\\$1") + "%"])
    .then(r => r.rowCount || 0)
    .catch(e => { note("cacheDelPrefix", e); return 0; });
}

function cacheDel(key) {
  if (!usingDb() || !S.pool) return;
  S.pool.query("DELETE FROM feed_cache WHERE k = $1", [key]).catch(e => note("cacheDel", e));
}

// The KEYS another replica has already warmed, and deliberately not their
// payloads. Prewarm's own "already warm?" test reads this container's memory,
// which is correct for one instance and wrong for two: with the volume gone
// there are two of them, each warming every key independently, so the load on
// the read replica DOUBLED the moment replicas went to 2.
//
// Payloads are the reason this returns keys alone. Polling whole rows would be
// the obvious shape — it is what pollKv does for config — but a feed payload is
// not a config blob: norman/memberships alone is 16.8 MB, and speculatively
// pulling every changed row every few seconds to answer a question prewarm asks
// four times an hour is a great deal of traffic for nothing. The payload is
// still fetched lazily on a real miss, through cacheGet.
//
// `expires_at` is the sweeper's column and is NOT the readers' TTL (see the
// schema note) — but it is exactly the right test here, because prewarm's job
// is to refresh a key BEFORE it expires, and it is what setCache wrote from
// ttlForKey. An entry with no recorded expiry is reported as not-fresh: the
// harmless direction, since the cost is one warm we did not need rather than a
// key that is never refreshed again.
async function cacheFreshKeys() {
  if (!readsDb() || !S.pool) return null;
  try {
    const r = await S.pool.query("SELECT k FROM feed_cache WHERE expires_at > now()");
    return new Set(r.rows.map(row => row.k));
  } catch (e) {
    note("cacheFreshKeys", e);
    // NULL, never an empty Set. "The store could not tell us" and "no other
    // replica has warmed anything" are different facts, and an empty Set reads
    // as the second — which would silently turn this optimisation off with no
    // way to notice. The caller falls back to its own memory.
    return null;
  }
}

// SIZES, NOT PAYLOADS — the same argument cacheFreshKeys makes above, for the
// boot hydrate rather than for prewarm. `SELECT k, v FROM feed_cache` shipped
// every payload the platform holds on every boot of every replica, which is a
// memory bill and an egress bill for data most of which is never read before it
// expires. `pg_column_size` answers "what would this cost me" without moving a
// byte of it, and the caller decides what fits.
//
// Ordered by the caller, not here: the budget rule belongs with the budget.
async function cacheIndex() {
  if (!readsDb() || !S.pool) return [];
  try {
    const r = await S.pool.query(
      "SELECT k, pg_column_size(v) AS bytes, EXTRACT(EPOCH FROM updated_at) * 1000 AS updated_at FROM feed_cache"
    );
    return r.rows.map(row => ({ k: row.k, bytes: Number(row.bytes) || 0, updatedAt: Number(row.updated_at) || 0 }));
  } catch (e) { note("cacheIndex", e); return []; }
}

// The payloads for a chosen set of keys, in ONE round trip. Fetching them one
// at a time through cacheGet would be a query per entry — hundreds of round
// trips on a boot that is racing a healthcheck.
async function cacheMany(keys) {
  if (!readsDb() || !S.pool || !keys || !keys.length) return [];
  try {
    const r = await S.pool.query("SELECT v FROM feed_cache WHERE k = ANY($1)", [keys]);
    return r.rows.map(row => row.v);
  } catch (e) { note("cacheMany", e); return []; }
}

// Every entry, unbounded. Kept for callers that genuinely want the lot (the
// export/backup path); the boot hydrate deliberately does NOT use it.
async function cacheAll() {
  if (!readsDb() || !S.pool) return [];
  try {
    const r = await S.pool.query("SELECT k, v FROM feed_cache");
    return r.rows.map(row => row.v);
  } catch (e) { note("cacheAll", e); return []; }
}

// Sweep entries a long way past their TTL. Deliberately generous: the
// stale-cache fallback reads expired entries when Metabase is down, so
// deleting at the TTL itself would remove the safety net exactly when it is
// needed. A week is well past any report's usefulness.
async function cacheSweep(graceMs) {
  if (!usingDb() || !S.pool) return 0;
  // `graceMs || DEFAULT` would turn a deliberate grace of ZERO — sweep
  // everything already expired — back into seven days, silently. Caught by the
  // spec, not by review.
  const grace = graceMs == null ? 7 * 86400000 : Number(graceMs);
  try {
    const r = await S.pool.query(
      "DELETE FROM feed_cache WHERE expires_at IS NOT NULL AND expires_at < now() - ($1 || ' ms')::interval",
      [String(grace)]);
    return r.rowCount || 0;
  } catch (e) { note("cacheSweep", e); return 0; }
}

// ── Leader election ────────────────────────────────────────────────────────
//
// With two replicas every node-cron job fires twice — including prewarm, which
// fans out across ~28 orgs against production Metabase. That is the storm shape
// already recorded in this repo (it 502'd the facility Summary and got a card
// rolled back), so it must not be reintroduced by scaling out.
//
// A SESSION-scoped advisory lock is wrong here: pg.Pool hands out a different
// connection each time, so the lock would be taken on one connection and the
// unlock attempted on another. This takes a TRANSACTION-scoped lock instead —
// released by the COMMIT, whatever happens to the callback — and holds the
// client for the duration of the work.

async function withLeaderLock(name, fn) {
  // In disk mode there is exactly one instance, so it is always the leader.
  // Gating the crons on a database that is not configured would silently stop
  // every scheduled job on a single-instance deploy.
  if (!usingDb() || !S.pool) return fn();
  let client, done = false;
  try { client = await S.pool.connect(); }
  catch (e) { note("leader connect", e); return fn(); }  // fail OPEN — see the catch below
  try {
    await client.query("BEGIN");
    const r = await client.query("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS got", [name]);
    if (!r.rows[0].got) { done = true; await client.query("ROLLBACK"); return undefined; }
    return await fn();
  } catch (e) {
    note("leader " + name, e);
    // FAIL OPEN, and the asymmetry is deliberate — the same call this repo
    // already made for the Slack production gate. A duplicated prewarm is a
    // wasted cycle; a database blip that silently stops the health check, the
    // schema watchdog and the digest is a platform that has gone quiet without
    // anyone being told.
    return fn();
  } finally {
    // COMMIT is what releases a transaction-scoped lock. Skipped when the
    // lock was never acquired, so the log is not littered with "no transaction
    // in progress" on every follower.
    if (!done) { try { await client.query("COMMIT"); } catch { /* already ended */ } }
    client.release();
  }
}

// ── One-shot import ────────────────────────────────────────────────────────
//
// Runs against the volume, from the instance that has it mounted. Idempotent
// by construction: a key already in kv_store is left alone, so a second run
// cannot overwrite something written since the first.

async function importFromDisk(opts) {
  const o = opts || {};
  if (!usingDb() || !S.pool) return { skipped: "not using a database" };
  const out = { keys: 0, skipped: 0, events: 0, cache: 0, errors: [] };

  const walk = (dir, depth) => {
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    const files = [];
    for (const d of names) {
      const full = path.join(dir, d.name);
      // The feed cache is imported separately, and it is the one directory
      // big enough that walking it into kv_store would be a mistake.
      if (d.isDirectory()) {
        if (full === path.join(S.dataDir, "cache")) continue;
        if (d.name === "announce-images") continue;   // binary, stays on disk
        if (depth < 3) files.push(...walk(full, depth + 1));
      } else if (d.name.endsWith(".json")) {
        files.push(full);
      }
    }
    return files;
  };

  for (const file of walk(S.dataDir, 0)) {
    const key = relKey(file);
    if (key === null) continue;
    let value;
    try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (e) { out.errors.push(key + ": " + e.message); continue; }
    try {
      const r = await S.pool.query(
        `INSERT INTO kv_store (k, v) VALUES ($1, $2::jsonb)
         ON CONFLICT (k) DO NOTHING RETURNING k`,
        [key, JSON.stringify(value)]);
      if (r.rowCount) { out.keys++; S.kv.set(key, value); } else out.skipped++;
    } catch (e) { out.errors.push(key + ": " + e.message); }
  }

  // The count-based resume below assumes `events` holds only rows a previous
  // import of THIS file put there. Anything else — the stray rows the old dual
  // behaviour wrote, say — makes it skip that many of the file's oldest lines.
  // resetEvents is the explicit, opt-in way to start clean; it is never the
  // default, because truncating an event log by accident is unrecoverable.
  if (o.resetEvents && S.pool) {
    const before = await S.pool.query("SELECT count(*)::int AS n FROM events");
    await S.pool.query("TRUNCATE events RESTART IDENTITY");
    out.eventsCleared = before.rows[0].n;
    S.events = []; S.eventsMaxId = 0; S.eventsSorted = true; S.eventsLastTs = "";
  }
  if (o.events !== false) out.events = await importEvents();
  if (o.cache !== false)  out.cache  = await importCache();
  await loadKv();
  return out;
}

// The event log is append-only and the import must be resumable, so it copies
// only what is not already there — counted by rows, since the file has no ids.
//
// BATCHED, and that is not an optimisation. One INSERT per line took over five
// minutes for a real 82k-line log, which is how the first attempt at this flip
// took production down: the import was awaited before app.listen, so the
// healthcheck never went green. It runs after listen now AND inserts in chunks,
// because either alone leaves the other as the next surprise.
const IMPORT_EVENT_CHUNK = 500;

async function importEvents() {
  const file = path.join(S.dataDir, "events.jsonl");
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return 0; }
  const have = await S.pool.query("SELECT count(*)::int AS n FROM events");
  const already = have.rows[0].n;
  const lines = raw.split("\n").filter(Boolean);
  if (already >= lines.length) return 0;

  const rows = [];
  for (let i = already; i < lines.length; i++) {
    let rec;
    try { rec = JSON.parse(lines[i]); } catch { continue; }
    if (rec) rows.push(rec);
  }

  let n = 0;
  for (let i = 0; i < rows.length; i += IMPORT_EVENT_CHUNK) {
    const chunk = rows.slice(i, i + IMPORT_EVENT_CHUNK);
    const values = [];
    const params = [];
    chunk.forEach((rec, j) => {
      values.push("($" + (j * 2 + 1) + ", $" + (j * 2 + 2) + "::jsonb)");
      params.push(rec.ts || new Date().toISOString(), JSON.stringify(rec));
    });
    try {
      await S.pool.query("INSERT INTO events (ts, rec) VALUES " + values.join(","), params);
      n += chunk.length;
    } catch (e) { note("importEvents", e); break; }
  }
  return n;
}

// The cache is imported so the flip does not start cold — the whole point of
// this exercise is a deploy nobody notices, and an empty cache on a Sunday
// morning is ~28 orgs of cold card queries against production Metabase.
async function importCache() {
  const dir = path.join(S.dataDir, "cache");
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith(".json")); } catch { return 0; }
  let n = 0;
  for (const f of files) {
    let entry;
    try { entry = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
    if (!entry || !entry.key || !entry.data) continue;
    try {
      await S.pool.query(
        `INSERT INTO feed_cache (k, v, updated_at) VALUES ($1, $2::jsonb, now())
         ON CONFLICT (k) DO NOTHING`,
        [entry.key, JSON.stringify(entry)]);
      n++;
    } catch (e) { note("importCache " + f, e); }
  }
  return n;
}

// Every config key the store holds, for the daily gist backup. In db mode the
// container's own disk is no longer the whole picture — it holds only what THIS
// replica happened to write — so a backup that walked the directory would quietly
// start capturing a fraction of the platform's state.
function exportAll() {
  const out = {};
  for (const [k, v] of S.kv.entries()) out[k] = JSON.stringify(v, null, 2);
  return out;
}

module.exports = {
  configure, close, status, mode, usingDb, readsDb, flush, exportAll,
  readJSON, writeJSON, deleteJSON, listJSON, relKey,
  appendEvent, allEvents, eventsReady, eventsSorted, loadEvents, onKeyChange,
  cacheGet, cacheSet, cacheDel, cacheDelPrefix, cacheAll, cacheIndex, cacheMany, cacheFreshKeys, cacheSweep,
  withLeaderLock, importFromDisk,
  // Exported for scripts/store.spec.js alone. The flush/poll race is a two-way
  // interleaving that a wall-clock test repairs by accident on its next poll,
  // so the spec drives the poll by hand at the one instant that matters.
  _pollKv: () => pollKv(),
  // Test seam. The spec needs to provoke a real query failure against a LIVE
  // pool (it drops a table out from under the store) — the fallback-to-null
  // behaviour is otherwise unreachable, and a mutation that returns an empty
  // Set there survived until this existed.
  _query: (sql, args) => S.pool.query(sql, args),
  _internals: S
};
