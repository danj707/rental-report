// Logic spec for the adaptive cache governor in server.js.
// Mirrors the decision functions verbatim and asserts the intended behavior:
// heavy-cold reports are not held resident, hot reports are promoted/pinned,
// the LRU cap evicts oldest non-pinned first, and popularity respects the
// rolling window. Run: node scripts/adaptive-cache.spec.js
"use strict";

// ── config (matches server.js defaults) ──
const MAX_MEMORY_ENTRIES = 300;
const HEAVY_ENTRY_BYTES  = 1500000;
const HOT_WINDOW_MS      = 7 * 24 * 60 * 60 * 1000;
const HOT_MIN_HITS       = 3;
const ALWAYS_WARM_REPORTS = new Set(["calendar", "gl", "facility"]);
const HEAVY_REPORTS       = new Set(["users", "ice-calendar"]);
const CACHE_ADAPTIVE = true;

const dataCache = new Map();
const accessLog = new Map();
const cacheBaseKey = (o, r) => `${o}:${r}`;

function recordAccessAt(orgSlug, reportType, at) {
  const bk = cacheBaseKey(orgSlug, reportType);
  const arr = (accessLog.get(bk) || []).filter(ts => at - ts < HOT_WINDOW_MS);
  arr.push(at);
  accessLog.set(bk, arr);
}
function isReportHot(orgSlug, reportType, now = Date.now()) {
  const arr = accessLog.get(cacheBaseKey(orgSlug, reportType));
  if (!arr || !arr.length) return false;
  let n = 0;
  for (const ts of arr) if (now - ts < HOT_WINDOW_MS) n++;
  return n >= HOT_MIN_HITS;
}
function isWarmTarget(orgSlug, reportType) {
  if (!CACHE_ADAPTIVE) return true;
  if (ALWAYS_WARM_REPORTS.has(reportType)) return true;
  if (HEAVY_REPORTS.has(reportType)) return isReportHot(orgSlug, reportType);
  return true;
}
function isPinnedKey(key) { const p = key.split(":"); return ALWAYS_WARM_REPORTS.has(p[1]) || isReportHot(p[0], p[1]); }
function enforceMemoryCap() {
  if (dataCache.size <= MAX_MEMORY_ENTRIES) return;
  const evictable = [];
  for (const [k, v] of dataCache) { if (isPinnedKey(k)) continue; evictable.push([k, v.lastRead || v.ts]); }
  evictable.sort((a, b) => a[1] - b[1]);
  let i = 0;
  while (dataCache.size > MAX_MEMORY_ENTRIES && i < evictable.length) dataCache.delete(evictable[i++][0]);
}
function setCache(key, rt, bytes, lastRead) {
  const entry = { ts: Date.now(), rt, lastRead: lastRead || Date.now() };
  const heavy = bytes > HEAVY_ENTRY_BYTES;
  const keepResident = !heavy || isWarmTarget(key.split(":")[0], rt);
  if (keepResident) { dataCache.set(key, entry); enforceMemoryCap(); }
  else dataCache.delete(key);
  return keepResident;
}

// ── tiny assert ──
let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name); } }

console.log("adaptive cache governor spec\n");

// 1. Heavy + cold → NOT resident (served from disk instead)
dataCache.clear(); accessLog.clear();
ok("heavy cold users report is not held in memory", setCache("apex:users:", "users", 30_000_000) === false && !dataCache.has("apex:users:"));

// 2. Heavy + hot → resident (promoted)
dataCache.clear(); accessLog.clear();
const now = Date.now();
recordAccessAt("apex", "users", now); recordAccessAt("apex", "users", now); recordAccessAt("apex", "users", now);
ok("users becomes hot after 3 opens", isReportHot("apex", "users"));
ok("heavy hot users report IS held in memory", setCache("apex:users:", "users", 30_000_000) === true && dataCache.has("apex:users:"));

// 3. Two opens is not enough
dataCache.clear(); accessLog.clear();
recordAccessAt("norman", "users", now); recordAccessAt("norman", "users", now);
ok("two opens does not make a report hot", !isReportHot("norman", "users"));

// 4. Rolling window expiry — 3 opens 8 days ago don't count
dataCache.clear(); accessLog.clear();
const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;
recordAccessAt("smyrna", "users", eightDaysAgo); recordAccessAt("smyrna", "users", eightDaysAgo); recordAccessAt("smyrna", "users", eightDaysAgo);
ok("opens outside the 7-day window don't count as hot", !isReportHot("smyrna", "users", now));

// 5. Light reports always resident regardless of heat
dataCache.clear(); accessLog.clear();
ok("light cold report is held in memory", setCache("boerne:programs:", "programs", 40_000) === true);

// 6. always-warm reports are pinned even with zero opens
dataCache.clear(); accessLog.clear();
ok("calendar is a warm target with no opens", isWarmTarget("anyorg", "calendar"));

// 7. LRU cap: 305 light non-pinned entries → capped at 300, oldest evicted, newest kept
dataCache.clear(); accessLog.clear();
for (let i = 0; i < 305; i++) setCache(`org${i}:products:`, "products", 1000, now + i);
ok("dataCache is capped at MAX_MEMORY_ENTRIES", dataCache.size === MAX_MEMORY_ENTRIES);
ok("oldest-touched entry (org0) was evicted", !dataCache.has("org0:products:"));
ok("newest entry (org304) is retained", dataCache.has("org304:products:"));

// 8. LRU never evicts pinned (always-warm) entries
dataCache.clear(); accessLog.clear();
setCache("watertown:calendar:", "calendar", 1000, now - 999999); // oldest, but pinned
for (let i = 0; i < 320; i++) setCache(`org${i}:products:`, "products", 1000, now + i);
ok("pinned calendar entry survives eviction despite being oldest", dataCache.has("watertown:calendar:"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
