// ── The resident-cache BYTE budget ──────────────────────────────────────────
//
// Railway bills memory on actual usage, and rental-report was averaging 3.7 GB
// against a 0.49 GB fresh boot, peaking at 10.45 GB — 69% of the bill. The cap
// was 300 ENTRIES, and a cached feed spans a few KB to 16.8 MB
// (norman/memberships), so the entry count could not say what the resident set
// cost. Boot made it worse: hydrateCacheEntries was the one writer that loaded
// every stored payload and never called enforceMemoryCap at all.
//
// IT LIFTS AND RUNS the real functions out of server.js. A regex over a
// governor passes on an inverted comparison, and every defect here is
// arithmetic about sizes rather than a shape a pattern can see.
//
// Run: node scripts/cache-memory-budget.spec.js
"use strict";

const fs = require("fs");
const path = require("path");

const SRC   = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const STORE = fs.readFileSync(path.join(__dirname, "..", "lib", "store.js"), "utf8");

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error("  ✗ " + msg); } }
function eq(a, b, msg) { ok(a === b, msg + "  (got " + JSON.stringify(a) + ", wanted " + JSON.stringify(b) + ")"); }

// ── lift ────────────────────────────────────────────────────────────────────
// Brace-counted from the function's own body. The parameter list is skipped
// FIRST: counting braces from the first "{" after the name lands on a
// destructured parameter and lifts half a function, which has bitten this repo
// more than once.
function liftFn(text, name) {
  const start = text.indexOf("function " + name + "(");
  if (start < 0) throw new Error(name + " is not at module scope — a spec cannot run what it cannot reach");
  let p = text.indexOf("(", start), pd = 0, j = p;
  for (; j < text.length; j++) {
    if (text[j] === "(") pd++;
    else if (text[j] === ")") { pd--; if (pd === 0) break; }
  }
  let depth = 0, i = text.indexOf("{", j);
  for (; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (depth === 0) break; }
  }
  return text.slice(start, i + 1);
}

const NAMES = ["entryBytes", "residentBytes", "enforceMemoryCap", "selectHydrateKeys", "hydrateCacheEntries"];
let bodies;
try { bodies = NAMES.map(n => liftFn(SRC, n)).join("\n\n"); }
catch (e) {
  console.error("  ✗ could not lift the governor: " + e.message);
  console.error("\n1 assertion(s) FAILED."); process.exit(1);
}

// The lift's own boundary. A slice that reaches past its inputs dies with a
// bare ReferenceError instead of failing by name, so the inputs are named here
// and the harness supplies every one of them.
ok(!/\bfunction (setCache|getDiskCached)\(/.test(bodies),
   "the lift stops at the governor and does not swallow its callers");

// ── harness ─────────────────────────────────────────────────────────────────
// Real defaults, so the spec is about server.js's own numbers.
function build(over) {
  const cfg = Object.assign({
    CACHE_ADAPTIVE: true,
    MAX_MEMORY_ENTRIES: 300,
    MAX_MEMORY_BYTES: 256 * 1024 * 1024,
    HEAVY_ENTRY_BYTES: 1500000,
  }, over || {});
  const dataCache  = new Map();
  const usersCache = new Map();
  const hot        = new Set();          // "slug:rt" the harness calls learned-hot
  const ALWAYS_WARM_REPORTS = new Set(["calendar", "gl", "facility"]);
  const HEAVY_REPORTS       = new Set(["users", "ice-calendar"]);
  const isReportHot   = (o, r) => hot.has(o + ":" + r);
  const isWarmTarget  = (o, r) => !cfg.CACHE_ADAPTIVE || ALWAYS_WARM_REPORTS.has(r)
                                  || (HEAVY_REPORTS.has(r) ? isReportHot(o, r) : true);
  const isPinnedKey   = (k) => { const p = String(k).split(":"); return ALWAYS_WARM_REPORTS.has(p[1]) || isReportHot(p[0], p[1]); };
  const logs = [];
  const fn = new Function(
    "dataCache", "usersCache", "CACHE_ADAPTIVE", "MAX_MEMORY_ENTRIES", "MAX_MEMORY_BYTES",
    "HEAVY_ENTRY_BYTES", "isPinnedKey", "isWarmTarget", "ttlForKey", "console",
    bodies + "\n return { entryBytes, residentBytes, enforceMemoryCap, selectHydrateKeys, hydrateCacheEntries };"
  )(dataCache, usersCache, cfg.CACHE_ADAPTIVE, cfg.MAX_MEMORY_ENTRIES, cfg.MAX_MEMORY_BYTES,
    cfg.HEAVY_ENTRY_BYTES, isPinnedKey, isWarmTarget,
    () => 60 * 60 * 1000,                                  // one hour, for every key
    { log: (m) => logs.push(String(m)) });
  return Object.assign(fn, { dataCache, usersCache, hot, logs, cfg });
}

const MB = 1024 * 1024;
const put = (h, key, bytes, lastRead) =>
  h.dataCache.set(key, { data: null, ts: Date.now(), rt: key.split(":")[1], bytes, lastRead: lastRead || Date.now() });

console.log("resident cache byte budget\n");

// ── entryBytes ──────────────────────────────────────────────────────────────
{
  const h = build();
  eq(h.entryBytes({ bytes: 1234 }), 1234, "a recorded size is used as it stands");
  eq(h.entryBytes(null), 0, "a missing entry costs nothing rather than throwing");

  // Measured ONCE and memoised. The cap runs on every write, and re-measuring a
  // 16 MB payload per write is not a governor, it is a second cost.
  const e = { data: { rows: [[1, 2, 3]] } };
  const first = h.entryBytes(e);
  ok(first > 0, "an unsized entry is measured rather than counted as free");
  eq(e.bytes, first, "...and the measurement is written back onto the entry");
  e.data = { rows: new Array(5000).fill([1, 2, 3]) };     // grows underneath it
  eq(h.entryBytes(e), first, "...and never re-measured once it is known");

  // Nothing about an unmeasurable payload should take the process down.
  const cyc = {}; cyc.self = cyc;
  eq(h.entryBytes({ data: cyc }), 0, "an unserializable payload measures 0, it does not throw");
}

// ── the budget is BYTES, not entries ────────────────────────────────────────
{
  const h = build();
  // Ten entries — a fortieth of the entry cap — and 400 MB of RAM.
  for (let i = 0; i < 10; i++) put(h, "apex:users:w" + i, 40 * MB, 1000 + i);
  ok(h.residentBytes() > h.cfg.MAX_MEMORY_BYTES, "ten large feeds are over budget while far under the entry cap");
  h.enforceMemoryCap();
  ok(h.residentBytes() <= h.cfg.MAX_MEMORY_BYTES,
     "the cap evicts on BYTES -- 10 entries of 40 MB is over budget even though 10 < 300");
  ok(h.dataCache.size > 0, "...and it stops at the budget rather than emptying the cache");
  ok(h.dataCache.has("apex:users:w9") && !h.dataCache.has("apex:users:w0"),
     "...oldest-touched first, newest survivors kept");
}

// ── the entry cap still applies ─────────────────────────────────────────────
{
  const h = build();
  for (let i = 0; i < 400; i++) put(h, "apex:products:k" + i, 10, 1000 + i);  // 4 KB in total
  h.enforceMemoryCap();
  eq(h.dataCache.size, 300, "a very large number of tiny entries is still capped by COUNT");
}

// ── under both caps, nothing is touched ─────────────────────────────────────
{
  const h = build();
  for (let i = 0; i < 20; i++) put(h, "apex:products:k" + i, MB, 1000 + i);
  h.enforceMemoryCap();
  eq(h.dataCache.size, 20, "a set inside both caps is left alone");
}

// ── A PIN IS A PREFERENCE, NOT A LICENCE TO GROW ────────────────────────────
//
// The load-bearing case. ALWAYS_WARM_REPORTS is three reports across every
// configured org, plus everything learned hot, so the pinned set is not small —
// and while eviction could only ever touch unpinned entries, a budget could be
// exceeded by an arbitrary amount with nothing able to bring it back. That is
// the shape of the bug this whole change exists to fix.
{
  const h = build();
  for (let i = 0; i < 20; i++) put(h, "org" + i + ":gl:w", 40 * MB, 1000 + i);   // every one pinned
  ok(h.residentBytes() > h.cfg.MAX_MEMORY_BYTES, "20 pinned GL feeds are 800 MB");
  h.enforceMemoryCap();
  ok(h.residentBytes() <= h.cfg.MAX_MEMORY_BYTES,
     "PINNED entries are evicted too once the budget cannot be met without them");
  ok(h.dataCache.has("org19:gl:w"),
     "...oldest-touched first, so the most recently read pin survives");
}

// ── ...but only after everything unpinned has gone ──────────────────────────
{
  const h = build();
  put(h, "apex:gl:w",       40 * MB, 1);     // pinned, and the oldest of the two
  put(h, "apex:products:w", 40 * MB, 2);     // unpinned, newer
  const h2 = build({ MAX_MEMORY_BYTES: 50 * MB });
  h2.dataCache.set("apex:gl:w",       h.dataCache.get("apex:gl:w"));
  h2.dataCache.set("apex:products:w", h.dataCache.get("apex:products:w"));
  h2.enforceMemoryCap();
  ok(h2.dataCache.has("apex:gl:w") && !h2.dataCache.has("apex:products:w"),
     "an unpinned entry goes before a pinned one EVEN WHEN it was touched more recently");
}

// ── CACHE_ADAPTIVE=0 is still the escape hatch ──────────────────────────────
{
  const h = build({ CACHE_ADAPTIVE: false });
  for (let i = 0; i < 20; i++) put(h, "apex:users:w" + i, 40 * MB, 1000 + i);
  h.enforceMemoryCap();
  eq(h.dataCache.size, 20, "CACHE_ADAPTIVE=0 keeps everything resident, as it always has");
}

// ── selectHydrateKeys: ask what it costs before carrying it ─────────────────
{
  const h = build({ MAX_MEMORY_BYTES: 100 * MB });
  const index = [];
  for (let i = 0; i < 10; i++) index.push({ k: "apex:gl:k" + i, bytes: 30 * MB, updatedAt: 1000 + i });
  const pick = h.selectHydrateKeys(index);
  ok(pick.bytes <= 100 * MB, "boot fetches only what fits the budget (" + Math.round(pick.bytes / MB) + " MB)");
  ok(pick.skipped > 0, "...and says how many it left on L2");
  ok(pick.keys.indexOf("apex:gl:k9") === 0,
     "the most recently written entry is the one worth carrying");

  // continue, not break: a small entry after a large one still fits, and the
  // budget is better spent on ten small reports than on one export.
  const mixed = h.selectHydrateKeys([
    { k: "a:gl:x", bytes: 90 * MB, updatedAt: 3 },
    { k: "b:gl:x", bytes: 90 * MB, updatedAt: 2 },
    { k: "c:gl:x", bytes: 1024,    updatedAt: 1 },
  ]);
  ok(mixed.keys.indexOf("c:gl:x") >= 0,
     "a small entry BEHIND an oversized one is still taken -- the scan continues, it does not stop");
}
{
  // The entry cap bounds the fetch too, or a million tiny rows is still a
  // million round-tripped payloads.
  const h = build();
  const index = [];
  for (let i = 0; i < 1000; i++) index.push({ k: "apex:gl:k" + i, bytes: 10, updatedAt: i });
  eq(h.selectHydrateKeys(index).keys.length, 300, "boot never fetches more entries than it may hold");
}
{
  const h = build();
  eq(h.selectHydrateKeys(null).keys.length, 0, "an unreadable index fetches nothing rather than throwing");
  eq(h.selectHydrateKeys([{ bytes: 5 }]).keys.length, 0, "a row with no key is dropped");
}

// ── hydrateCacheEntries: the boot path, which had no cap at all ─────────────
const entryOf = (key, bytes, over) => Object.assign({ key, data: { rows: [] }, ts: Date.now(), rt: key.split(":")[1], bytes }, over || {});
{
  const h = build({ MAX_MEMORY_BYTES: 100 * MB });
  const entries = [];
  for (let i = 0; i < 20; i++) entries.push(entryOf("org" + i + ":gl:w", 30 * MB));
  h.hydrateCacheEntries(entries, "the store");
  ok(h.residentBytes() <= 100 * MB,
     "THE BOOT HYDRATE IS CAPPED -- it was the one writer that loaded everything and never asked the cost");
}
{
  // ...and capped WHILE it loads. The peak is what the container is charged
  // for, so a sweep afterwards is not a fix: the assertion is that the resident
  // set never exceeded the budget at any point during the loop, not merely that
  // it ends under it.
  const h = build({ MAX_MEMORY_BYTES: 100 * MB });
  let peak = 0;
  const entries = [];
  for (let i = 0; i < 20; i++) entries.push(entryOf("org" + i + ":gl:w", 30 * MB));
  const realSet = h.dataCache.set.bind(h.dataCache);
  h.dataCache.set = (k, v) => { const r = realSet(k, v); peak = Math.max(peak, h.residentBytes()); return r; };
  h.hydrateCacheEntries(entries, "the store");
  h.dataCache.set = realSet;
  ok(peak <= 100 * MB + 30 * MB,
     "the cap runs INSIDE the loop -- the peak never builds the whole set first (" + Math.round(peak / MB) + " MB)");
}
{
  // The same residency rule setCache applies, which boot did not: a heavy
  // payload for a report nobody opens belongs on L2 and is served from there.
  const h = build();
  h.hydrateCacheEntries([entryOf("apex:users:w", 30 * MB)], "the store");
  ok(!h.dataCache.has("apex:users:w"),
     "a heavy payload for a cold report is left on L2 at boot, exactly as setCache leaves it");

  const hot = build();
  hot.hot.add("apex:users");
  hot.hydrateCacheEntries([entryOf("apex:users:w", 30 * MB)], "the store");
  ok(hot.dataCache.has("apex:users:w"), "...and a LEARNED-HOT one is still carried");
}
{
  // Safe direction on an unknown size: keep it. An entry whose cost we cannot
  // read is far more likely to be small than to be an export.
  const h = build();
  h.hydrateCacheEntries([entryOf("apex:users:w", undefined)], "the store");
  ok(h.dataCache.has("apex:users:w"), "an entry with no recorded size is kept, not shed");
}
{
  // Everything the old hydrate did, unchanged.
  const h = build();
  const stale = entryOf("apex:gl:w", 10);
  stale.ts = Date.now() - 20 * 60 * 60 * 1000;             // 20h against a 1h TTL => > 12x
  h.hydrateCacheEntries([entryOf("apex:gl:a", 10), entryOf("users:apex", 10), stale], "the store");
  ok(h.dataCache.has("apex:gl:a"), "a live report entry still hydrates");
  ok(h.usersCache.has("apex"), "a users: entry still lands in the users cache");
  ok(!h.dataCache.has("apex:gl:w"), "an entry far past its TTL is still dropped");
  ok(/Hydrated from the store/.test(h.logs.join("\n")),
     "...and the boot log still says so (store-live.spec.js reads that line)");
  ok(/MB resident/.test(h.logs.join("\n")), "...and now says what it cost");
}

// ── the wiring, which the lift cannot see ───────────────────────────────────
{
  ok(/const MAX_MEMORY_BYTES\s*=\s*Number\(process\.env\.CACHE_MAX_MEMORY_BYTES/.test(SRC),
     "the budget is an env var, so it can be moved without a deploy [source]");

  // setCache already has the serialized string. Measuring it again would be a
  // second full stringify of every payload on the write path.
  const setBody = liftFn(SRC, "setCache");
  // The GUARD is asserted as well as the assignment: a mutation that disables
  // the line leaves the text in place, and an assertion satisfied by dead code
  // is not guarding the thing it names.
  ok(/if \(serialized\) entry\.bytes = serialized\.length/.test(setBody),
     "setCache records the size it already computed [source]");

  // ── THE DISK HYDRATE LOADED ZERO ENTRIES, and said so in a healthy-looking
  // boot line. ttlForKey -> reportTtlMs -> reportSettingsEnabled reads
  // REPORT_SETTINGS_SCHEMA, a `const` ~8,000 lines below the old call site, so
  // every entry threw into the per-file catch and every restart in disk mode
  // started cold. The assertion is the general form: the call may not sit above
  // anything it transitively reads.
  const callAt   = SRC.indexOf("\nbootWarmCaches();");
  const schemaAt = SRC.indexOf("const REPORT_SETTINGS_SCHEMA");
  ok(callAt > 0 && schemaAt > 0 && callAt > schemaAt,
     "the boot hydrate runs BELOW every const it reaches -- REPORT_SETTINGS_SCHEMA is one [source]");
  const warmBody = liftFn(SRC, "bootWarmCaches");
  ok(warmBody.indexOf("loadAccessStats()") < warmBody.indexOf("hydrateCacheFromDisk()"),
     "...and access stats load FIRST, or the boot evicts the org's hottest reports [source]");
  ok(warmBody.indexOf("hydrateCacheFromDisk()") < warmBody.indexOf("invalidateFacilitiesCacheOnUuidChange()"),
     "...and the facilities invalidation still walks a populated set [source]");

  const diskBody = liftFn(SRC, "hydrateCacheFromDisk");
  ok(/entry\.bytes = raw\.length/.test(diskBody),
     "the disk hydrate records the size of the file it just read [source]");

  const storeBody = liftFn(SRC, "hydrateCacheFromStore");
  ok(/stateStore\.cacheIndex\(\)/.test(storeBody) && /stateStore\.cacheMany\(/.test(storeBody),
     "the boot hydrate asks the store for SIZES, then for the payloads that fit [source]");
  ok(!/stateStore\.cacheAll\(/.test(storeBody),
     "...and no longer pulls every payload the platform holds on every boot [source]");
  ok(!/stateStore\.cacheAll\(/.test(SRC),
     "nothing on a boot path calls cacheAll [source]");

  // pg_column_size answers "what would this cost me" without moving a byte of
  // it -- the same argument cacheFreshKeys already makes for prewarm.
  // The whole point is that the PAYLOAD never moves, so the assertion is about
  // the select list rather than about the presence of pg_column_size: a query
  // carrying both would satisfy a "mentions pg_column_size" test and ship every
  // byte anyway.
  const idx = liftFn(STORE, "cacheIndex");
  const idxList = (idx.match(/SELECT([\s\S]*?)FROM feed_cache/) || ["", ""])[1]
                    .replace(/pg_column_size\(\s*v\s*\)/g, "");
  ok(/pg_column_size\(\s*v\s*\)/.test(idx), "cacheIndex asks Postgres what each entry costs [store]");
  ok(idxList && !/\bv\b/.test(idxList),
     "...and its select list carries NO payload column -- the bytes never move [store]");
  const many = liftFn(STORE, "cacheMany");
  ok(/k = ANY\(\$1\)/.test(many),
     "cacheMany fetches the chosen keys in ONE round trip, not one query per entry [store]");
  ok(/cacheIndex/.test(STORE.slice(STORE.indexOf("module.exports"))) &&
     /cacheMany/.test(STORE.slice(STORE.indexOf("module.exports"))),
     "both are exported [store]");
}

if (fail) { console.error("\n" + fail + " assertion(s) FAILED."); process.exit(1); }
console.log(pass + " assertions passed.");
