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
  errors: 0,
  lastError: "",
  pollTimer: null
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
  for (const row of r.rows) {
    // A key still awaiting its own upsert is NEWER here than in the database.
    // Overwriting it with the row we are about to replace would undo a write
    // that has already been handed back to a caller as done.
    if (!S.pending.has(row.k)) S.kv.set(row.k, row.v);
    if (Number(row.rev) > S.kvRev) S.kvRev = Number(row.rev);
  }
  return r.rows.length;
}

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
  S.events = r.rows.map(row => row.rec);
  S.eventsMaxId = r.rows.length ? Number(r.rows[r.rows.length - 1].id) : 0;
  S.eventsLoaded = true;
}

async function pollEvents() {
  if (!S.eventsLoaded) return 0;
  const r = await S.pool.query(
    "SELECT id, rec FROM events WHERE id > $1 ORDER BY id", [S.eventsMaxId]);
  for (const row of r.rows) {
    S.events.push(row.rec);
    S.eventsMaxId = Number(row.id);
  }
  return r.rows.length;
}

// Sync, like the appendFileSync it replaces: a caller that awaited this would
// make every logged view wait on a round trip.
//
// IT DOES NOT PUSH THE RECORD LOCALLY, and that is the subtle part. Pushing it
// here and then advancing the cursor is only safe if this row is the very next
// id — and with two replicas inserting it usually is not, so the next poll
// hands the same record back and the log double-counts. Every event therefore
// arrives by exactly one path (the poll), and the insert simply kicks that poll
// so this replica sees its own event in milliseconds rather than seconds.
function appendEvent(rec) {
  if (!usingDb() || !S.pool) return false;
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

function cacheDel(key) {
  if (!usingDb() || !S.pool) return;
  S.pool.query("DELETE FROM feed_cache WHERE k = $1", [key]).catch(e => note("cacheDel", e));
}

// Every entry, for the boot hydrate. The disk version read the whole directory
// too, and the readers apply their own TTL afterwards.
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

  if (o.events !== false) out.events = await importEvents();
  if (o.cache !== false)  out.cache  = await importCache();
  await loadKv();
  return out;
}

// The event log is append-only and the import must be resumable, so it copies
// only what is not already there — counted by rows, since the file has no ids.
async function importEvents() {
  const file = path.join(S.dataDir, "events.jsonl");
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return 0; }
  const have = await S.pool.query("SELECT count(*)::int AS n FROM events");
  const already = have.rows[0].n;
  const lines = raw.split("\n").filter(Boolean);
  if (already >= lines.length) return 0;
  let n = 0;
  const client = await S.pool.connect();
  try {
    await client.query("BEGIN");
    for (let i = already; i < lines.length; i++) {
      let rec;
      try { rec = JSON.parse(lines[i]); } catch { continue; }
      if (!rec) continue;
      await client.query("INSERT INTO events (ts, rec) VALUES ($1, $2::jsonb)",
        [rec.ts || new Date().toISOString(), JSON.stringify(rec)]);
      n++;
    }
    await client.query("COMMIT");
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    note("importEvents", e);
  } finally { client.release(); }
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

module.exports = {
  configure, close, status, mode, usingDb, readsDb, flush,
  readJSON, writeJSON, deleteJSON, listJSON, relKey,
  appendEvent, allEvents, eventsReady, loadEvents,
  cacheGet, cacheSet, cacheDel, cacheAll, cacheSweep,
  withLeaderLock, importFromDisk,
  // Exported for scripts/store.spec.js alone. The flush/poll race is a two-way
  // interleaving that a wall-clock test repairs by accident on its next poll,
  // so the spec drives the poll by hand at the one instant that matters.
  _pollKv: () => pollKv(),
  _internals: S
};
