// ── The durable store ───────────────────────────────────────────────────────
//
// LIFTS AND RUNS lib/store.js against a REAL Postgres. A regex over this module
// proves nothing: every bug it has had so far — a poll overwriting a write in
// flight, an event counted twice, a follower committing a transaction it never
// opened — is a race between two code paths that both read correctly.
//
// It needs a database. With no STORE_TEST_URL it SKIPS with a message rather
// than passing, because a spec that reports success without having connected is
// worse than no spec: it is the warm-cache sign-off this repo already has a
// rule about.
//
//   STORE_TEST_URL=postgres://store@127.0.0.1:55432/storetest?sslmode=disable \
//     node scripts/store.spec.js

"use strict";

const fs   = require("fs");
const os   = require("os");
const path = require("path");
const assert = require("assert");

const URL = process.env.STORE_TEST_URL || "";
if (!URL) {
  console.log("SKIP store.spec.js — set STORE_TEST_URL to a scratch Postgres to run it.");
  process.exit(0);
}

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error("  ✗ " + msg); }
}
// Object keys are compared canonically because jsonb does not preserve their
// order — a round trip through the database legitimately comes back reordered,
// and a raw JSON.stringify comparison would fail on values that are equal.
// Array order is still significant.
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canon(v[k]);
    return o;
  }
  return v;
}
function eq(a, b, msg) {
  ok(JSON.stringify(canon(a)) === JSON.stringify(canon(b)),
     msg + " — got " + JSON.stringify(a) + ", want " + JSON.stringify(b));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function freshDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "store-spec-"));
  fs.mkdirSync(path.join(d, "cache"), { recursive: true });
  return d;
}

async function wipe() {
  const { Pool } = require("pg");
  const p = new Pool({ connectionString: URL, ssl: false });
  await p.query("DROP TABLE IF EXISTS kv_store, events, feed_cache");
  await p.query("DROP SEQUENCE IF EXISTS store_rev_seq");
  await p.end();
}

// A fresh module instance per replica — require() caches, so two "replicas" in
// one process have to be loaded from separate copies or they would share the
// mirror and every cross-replica assertion would pass for the wrong reason.
function loadStore() {
  const p = require.resolve("../lib/store.js");
  delete require.cache[p];
  const m = require(p);
  delete require.cache[p];
  return m;
}

(async function main() {

  // ── disk mode is the behaviour this module replaced ────────────────────────
  {
    const dir = freshDir();
    const s = loadStore();
    await s.configure({ dataDir: dir });                 // no URL
    eq(s.mode(), "disk", "no DATABASE_URL means disk mode");
    ok(!s.usingDb(), "disk mode does not use the database");

    const f = path.join(dir, "feature-flags.json");
    s.writeJSON(f, { reportSettings: true });
    eq(s.readJSON(f, null), { reportSettings: true }, "disk mode round-trips a value");
    ok(fs.existsSync(f), "disk mode writes the real file");
    eq(JSON.parse(fs.readFileSync(f, "utf8")), { reportSettings: true }, "the file on disk holds the value");
    eq(s.readJSON(path.join(dir, "nope.json"), "DEF"), "DEF", "a missing file yields the default");

    // The crons must still run on a single instance with no database at all.
    let ran = 0;
    await s.withLeaderLock("prewarm", () => { ran++; });
    eq(ran, 1, "withLeaderLock runs the job in disk mode");

    eq(s.appendEvent({ ts: new Date().toISOString(), event: "view" }), false,
       "disk mode does not claim to have stored an event");
    await s.close();
  }

  // ── the key is the path RELATIVE to DATA_DIR ──────────────────────────────
  {
    await wipe();
    const dir = freshDir();
    const s = loadStore();
    await s.configure({ dataDir: dir, databaseUrl: URL, mode: "db" });
    eq(s.mode(), "db", "a URL plus mode:db gives db mode");

    eq(s.relKey(path.join(dir, "feature-flags.json")), "feature-flags.json", "a top-level file keys on its name");
    eq(s.relKey(path.join(dir, "goals", "apex.json")), "goals/apex.json", "a nested file keeps its directory");
    // Outside DATA_DIR is a call-site bug. Storing it under a `..` key would
    // put a row in the shared table that no other replica could resolve.
    eq(s.relKey("/etc/passwd"), null, "a path outside DATA_DIR has no key");
    await s.close();
  }

  // ── db mode: a write is visible to a SECOND replica ───────────────────────
  {
    await wipe();
    const dirA = freshDir(), dirB = freshDir();
    const A = loadStore(), B = loadStore();
    await A.configure({ dataDir: dirA, databaseUrl: URL, mode: "db", pollMs: 120 });
    await B.configure({ dataDir: dirB, databaseUrl: URL, mode: "db", pollMs: 120 });

    A.writeJSON(path.join(dirA, "feature-flags.json"), { reportSettings: true });
    eq(A.readJSON(path.join(dirA, "feature-flags.json"), null), { reportSettings: true },
       "the writing replica sees its own write immediately");
    // B has never had this file on its own disk, which is the whole point.
    ok(!fs.existsSync(path.join(dirB, "feature-flags.json")), "the second replica has no such file locally");

    await A.flush();
    await sleep(400);
    eq(B.readJSON(path.join(dirB, "feature-flags.json"), "MISSING"), { reportSettings: true },
       "the second replica picks the write up by polling");

    // ...and back the other way, which is what a two-replica admin panel does.
    B.writeJSON(path.join(dirB, "feature-flags.json"), { reportSettings: false });
    await B.flush();
    await sleep(400);
    eq(A.readJSON(path.join(dirA, "feature-flags.json"), null), { reportSettings: false },
       "a write on the second replica reaches the first");

    await A.close(); await B.close();
  }

  // ── the poll must not clobber a write still in flight ─────────────────────
  {
    await wipe();
    const dirA = freshDir(), dirB = freshDir();
    const A = loadStore(), B = loadStore();
    // A very long poll interval, so the ONLY poll in this test is the hand-driven
    // one below. A background poll firing after the fact repairs the divergence
    // and the bug passes.
    await A.configure({ dataDir: dirA, databaseUrl: URL, mode: "db", pollMs: 600000 });
    await B.configure({ dataDir: dirB, databaseUrl: URL, mode: "db", pollMs: 600000 });
    const fA = path.join(dirA, "votes.json"), fB = path.join(dirB, "votes.json");

    // ONE replica writing in a burst does NOT discriminate, and the first draft
    // of this test made that mistake twice over. A replica's own upsert returns
    // the rev it just wrote, so its poll never fetches its own row back — and
    // once two replicas are both writing, the next poll repairs any transient
    // divergence by accident, so a settle-then-compare passes on the bug.
    //
    // The failure is a specific interleaving: a poll that runs BETWEEN "take
    // the queue snapshot" and "the upsert lands" writes the other replica's row
    // into the mirror, and the local upsert then pushes the cursor past it — so
    // nothing ever fetches the row that would put it right. Driving the poll by
    // hand is the only way to land on that instant every run.
    B.writeJSON(fB, { who: "B", n: 1 });
    await B.flush();                       // a row at a rev A has not seen

    // `await flush()` has to MEAN flushed, and this assertion is what stops the
    // rest of this test being vacuous: if B's row is not committed yet, A's poll
    // returns nothing, there is no stale row to clobber, and the race passes on
    // a build that has the bug.
    {
      const { Pool } = require("pg");
      const p = new Pool({ connectionString: URL, ssl: false });
      const pre = await p.query("SELECT v FROM kv_store WHERE k = 'votes.json'");
      await p.end();
      eq(pre.rows.length, 1, "awaiting flush() means the write has actually landed");
    }

    // ORDER MATTERS, and getting it backwards is why the first two drafts of
    // this test passed on the bug. The poll's SELECT has to be ISSUED FIRST and
    // still be in flight when the write queues, or A's own upsert resolves
    // before the poll returns and the poll simply reads back A's own row.
    const inFlightPoll = A._pollKv();      // SELECT issued, not yet returned
    A.writeJSON(fA, { who: "A", n: 2 });   // queues, flushes, upsert issued
    await inFlightPoll;                    // ...and lands on the stale row here
    await A.flush();
    await sleep(200);

    const { Pool } = require("pg");
    const p = new Pool({ connectionString: URL, ssl: false });
    const r = await p.query("SELECT v FROM kv_store WHERE k = 'votes.json'");
    await p.end();

    eq(r.rows[0].v, { who: "A", n: 2 }, "the later write is what the database holds");
    eq(A.readJSON(fA, null), r.rows[0].v,
       "a poll running mid-flush does not overwrite the mirror with the row being replaced");

    await A.close(); await B.close();
  }

  // ── shutdown drains the queue ─────────────────────────────────────────────
  {
    await wipe();
    const dir = freshDir();
    const s = loadStore();
    await s.configure({ dataDir: dir, databaseUrl: URL, mode: "db" });

    // THREE keys, because the drain handles them one at a time. A close() that
    // does not await the run in progress ends the pool after the first upsert
    // and the rest throw into the void — a deploy would then lose whatever was
    // queued at the moment the container was told to stop, which is exactly the
    // window this whole project exists to make survivable.
    s.writeJSON(path.join(dir, "votes.json"), { a: 1 });
    s.writeJSON(path.join(dir, "showcase.json"), { b: 2 });
    s.writeJSON(path.join(dir, "public-mode.json"), { c: 3 });
    await s.close();

    const { Pool } = require("pg");
    const p = new Pool({ connectionString: URL, ssl: false });
    const r = await p.query("SELECT count(*)::int AS n FROM kv_store");
    await p.end();
    eq(r.rows[0].n, 3, "closing the store drains every queued write, not just the first");
  }

  // ── db mode falls THROUGH to disk for a key it has never seen ─────────────
  {
    await wipe();
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, "orgs.json"), JSON.stringify({ apex: { token: "x" } }));
    const s = loadStore();
    await s.configure({ dataDir: dir, databaseUrl: URL, mode: "db" });
    // "Postgres has no row" and "this org has no config" are different facts.
    // Defaulting here would silently reset every store the import missed.
    eq(s.readJSON(path.join(dir, "orgs.json"), "DEFAULTED"), { apex: { token: "x" } },
       "an un-imported key reads from disk rather than defaulting");
    await s.close();
  }

  // ── dual mode writes both and reads DISK ──────────────────────────────────
  {
    await wipe();
    const dir = freshDir();
    const s = loadStore();
    await s.configure({ dataDir: dir, databaseUrl: URL, mode: "dual" });
    eq(s.mode(), "dual", "mode:dual is honoured");
    const f = path.join(dir, "public-mode.json");
    s.writeJSON(f, { on: true });
    await s.flush();
    ok(fs.existsSync(f), "dual mode still writes the file");

    // The authority is the volume: edit the file behind the store's back and
    // the read must follow the FILE, or dual mode is not a safe staging step.
    fs.writeFileSync(f, JSON.stringify({ on: "from-disk" }));
    eq(s.readJSON(f, null), { on: "from-disk" }, "dual mode reads the volume, not the database");

    const { Pool } = require("pg");
    const p = new Pool({ connectionString: URL, ssl: false });
    const r = await p.query("SELECT v FROM kv_store WHERE k = 'public-mode.json'");
    await p.end();
    eq(r.rows[0].v, { on: true }, "...while still having written the row");
    await s.close();
  }

  // ── the event log is not double-counted ───────────────────────────────────
  {
    await wipe();
    const dirA = freshDir(), dirB = freshDir();
    const A = loadStore(), B = loadStore();
    await A.configure({ dataDir: dirA, databaseUrl: URL, mode: "db", pollMs: 100 });
    await B.configure({ dataDir: dirB, databaseUrl: URL, mode: "db", pollMs: 100 });

    // Interleave the writers. This is the shape that broke the first draft:
    // pushing locally and claiming the id only works while every insert is the
    // very next one, which two replicas guarantee it is not.
    for (let i = 0; i < 10; i++) {
      (i % 2 ? B : A).appendEvent({ ts: new Date().toISOString(), org: "apex", event: "view", n: i });
    }
    await sleep(700);
    eq(A.allEvents().length, 10, "the first replica holds each event exactly once");
    eq(B.allEvents().length, 10, "the second replica holds each event exactly once");
    const ns = A.allEvents().map(e => e.n).sort((a, b) => a - b);
    eq(ns, [0,1,2,3,4,5,6,7,8,9], "and every event arrived");
    await A.close(); await B.close();
  }

  // ── exactly one replica runs a leader-locked job ──────────────────────────
  {
    await wipe();
    const dirA = freshDir(), dirB = freshDir();
    const A = loadStore(), B = loadStore();
    await A.configure({ dataDir: dirA, databaseUrl: URL, mode: "db" });
    await B.configure({ dataDir: dirB, databaseUrl: URL, mode: "db" });

    let ran = 0;
    // Both start the job at once. Without the lock this is prewarm fanning out
    // across ~28 orgs against production Metabase, twice — the storm shape that
    // already 502'd the facility Summary once.
    const hold = async () => { ran++; await sleep(300); };
    const [a, b] = await Promise.all([
      A.withLeaderLock("prewarm", hold),
      B.withLeaderLock("prewarm", hold)
    ]);
    eq(ran, 1, "only one replica runs the job while the other holds the lock");
    ok(a === undefined || b === undefined, "the follower returns undefined rather than a result");

    // The lock must be RELEASED by the commit, or the next cycle never runs.
    let again = 0;
    await A.withLeaderLock("prewarm", () => { again++; });
    eq(again, 1, "the lock is released when the job finishes");

    // ...and released for real, not merely unreachable. A client handed back to
    // the pool with its transaction still open keeps the advisory lock, and the
    // next call simply picks a different connection — so counting successful
    // runs cannot tell a released lock from a leaked one. Ask Postgres.
    {
      const { Pool } = require("pg");
      const p = new Pool({ connectionString: URL, ssl: false });
      const held = await p.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'");
      await p.end();
      eq(held.rows[0].n, 0, "no advisory lock is left held once the jobs are done");
    }
    await A.close(); await B.close();
  }

  // ── the feed cache ────────────────────────────────────────────────────────
  {
    await wipe();
    const dir = freshDir();
    const s = loadStore();
    await s.configure({ dataDir: dir, databaseUrl: URL, mode: "db" });
    s.cacheSet("apex:programs:v1:abc", { key: "apex:programs:v1:abc", data: [{ a: 1 }], ts: Date.now() }, 60000);
    await sleep(250);
    const got = await s.cacheGet("apex:programs:v1:abc");
    eq(got.data, [{ a: 1 }], "a cache entry round-trips");
    eq(await s.cacheGet("nope"), null, "a missing cache key is null, not a throw");

    // An entry PAST its TTL must still be readable: getStaleCached deliberately
    // serves expired data when Metabase is down, and enforcing expiry in the
    // store would delete that safety net.
    s.cacheSet("apex:gl:v1:old", { key: "apex:gl:v1:old", data: [1], ts: 0 }, -1000);
    await sleep(250);
    ok((await s.cacheGet("apex:gl:v1:old")) !== null, "an expired entry is still readable for the stale fallback");
    eq(await s.cacheSweep(7 * 86400000), 0, "the sweeper leaves a recently-expired entry alone");
    eq(await s.cacheSweep(0), 1, "...and removes it once past the grace period");

    // cacheFreshKeys — what prewarm asks so replica B does not re-fetch from
    // Metabase what replica A already warmed. KEYS ONLY: a payload is up to
    // 16.8 MB and prewarm only ever needs the yes/no.
    s.cacheSet("apex:fresh:v1:", { key: "apex:fresh:v1:", data: [1], ts: Date.now() }, 60000);
    s.cacheSet("apex:stale:v1:", { key: "apex:stale:v1:", data: [1], ts: 0 }, -1000);
    await sleep(300);
    const fresh = await s.cacheFreshKeys();
    ok(fresh instanceof Set, "cacheFreshKeys returns a Set");
    ok(fresh.has("apex:fresh:v1:"), "an unexpired key is reported warm");
    ok(!fresh.has("apex:stale:v1:"), "an EXPIRED key is not — prewarm's whole job is to refresh it");
    // The distinction the whole optimisation rests on: this must never carry
    // payloads, or a poll of the platform's cache moves tens of megabytes to
    // answer a question asked four times an hour.
    for (const k of fresh) ok(typeof k === "string", "every entry is a bare key, never a row");
    await s.close();
  }

  // ── cacheFreshKeys must fail to NULL, never to an empty Set ───────────────
  {
    await wipe();
    const dir = freshDir();
    const s = loadStore();
    // Disk mode: there is no store to ask.
    await s.configure({ dataDir: dir });
    eq(await s.cacheFreshKeys(), null,
       "disk mode returns null — 'we cannot tell', not 'nothing is warm'");
    await s.close();
  }

  // ── ...and a FAILING query is the same fact, not "nothing is warm" ────────
  // The distinction only bites on this path, which is why it needs its own
  // case: an empty Set says "no other replica has warmed anything", so prewarm
  // would re-fetch the platform's whole warm set from Metabase on every cycle
  // — silently, because the fallback is exactly the old behaviour and nothing
  // looks broken. Provoked by removing the table under a live pool.
  {
    await wipe();
    const dir = freshDir();
    const s = loadStore();
    await s.configure({ dataDir: dir, databaseUrl: URL, mode: "db" });
    s.cacheSet("apex:x:v1:", { key: "apex:x:v1:", data: [1], ts: Date.now() }, 60000);
    await sleep(250);
    ok((await s.cacheFreshKeys()).size > 0, "warm before the table goes");
    await s._query("DROP TABLE feed_cache");
    eq(await s.cacheFreshKeys(), null, "a failing query returns null, never an empty Set");
    await s.close();
  }

  // ── the import is one-shot and idempotent ─────────────────────────────────
  {
    await wipe();
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, "feature-flags.json"), JSON.stringify({ reportSettings: true }));
    fs.mkdirSync(path.join(dir, "goals"), { recursive: true });
    fs.writeFileSync(path.join(dir, "goals", "apex.json"), JSON.stringify({ target: 10 }));
    fs.writeFileSync(path.join(dir, "events.jsonl"),
      JSON.stringify({ ts: "2026-09-01T00:00:00Z", event: "view" }) + "\n" +
      JSON.stringify({ ts: "2026-09-02T00:00:00Z", event: "pdf" }) + "\n");
    fs.writeFileSync(path.join(dir, "cache", "abc.json"),
      JSON.stringify({ key: "apex:gl:v1:x", data: [1, 2], ts: Date.now(), rt: "gl" }));
    // Binary announce images must NOT be walked into a jsonb column.
    fs.mkdirSync(path.join(dir, "announce-images"), { recursive: true });
    fs.writeFileSync(path.join(dir, "announce-images", "a.json"), "not really json {");

    const s = loadStore();
    await s.configure({ dataDir: dir, databaseUrl: URL, mode: "db" });
    const r1 = await s.importFromDisk();
    eq(r1.keys, 2, "the import copies the config blobs");
    eq(r1.events, 2, "the import copies the event log");
    eq(r1.cache, 1, "the import copies the warm cache so the flip does not start cold");
    eq(r1.errors, [], "and nothing failed to parse — announce-images is skipped, not read");

    eq(s.readJSON(path.join(dir, "goals", "apex.json"), null), { target: 10 }, "a nested key imported under its path");

    // Re-running must not duplicate anything: the flip may be retried.
    const r2 = await s.importFromDisk();
    eq(r2.keys, 0, "a second import adds no keys");
    eq(r2.skipped, 2, "...it reports them as already present");
    eq(r2.events, 0, "a second import adds no events");

    await s.loadEvents(null);
    eq(s.allEvents().length, 2, "the event log holds each imported row once");
    await s.close();
  }

  // ── a database that will not answer must not take the reports down ────────
  {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, "orgs.json"), JSON.stringify({ apex: 1 }));
    const s = loadStore();
    const st = await s.configure({
      dataDir: dir,
      databaseUrl: "postgres://nobody@127.0.0.1:1/nothing?sslmode=disable",
      mode: "db"
    });
    eq(st.mode, "disk", "an unreachable database falls back to the volume");
    eq(s.readJSON(path.join(dir, "orgs.json"), null), { apex: 1 }, "and the reports keep reading");
    let ran = 0;
    await s.withLeaderLock("healthcheck", () => { ran++; });
    eq(ran, 1, "the crons still run when the database is unreachable");
    await s.close();
  }

  await wipe();

  if (failed) { console.error("\n" + failed + " assertion(s) FAILED."); process.exit(1); }
  console.log(passed + " assertions passed.");
})().catch(e => { console.error(e); process.exit(1); });
