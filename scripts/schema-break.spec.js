// Spec for the breaking-drift watchdog — diffCatalogAgainstDependencies().
//
// Why this check exists, and why it is shaped this way:
//
// The older drift check diffs the COLUMNS OF A REPORT'S RESULT SET against a
// stored baseline. It fires on added columns (noise nobody reads) and it is
// structurally blind to a dropped TABLE — when the product dropped the `class`
// model in August 2026, Apex's ice-calendar card returned HTTP 400 on every
// request, so there were no rows, so the column extractor returned null and the
// checker returned early. The break sat unnoticed for days.
//
// This check reads the database catalog and asks the opposite question: is
// everything the reports DEPEND ON still there? Additions cannot trigger it,
// because it only ever asks about names already in REPORT_DEPENDENCIES.
//
// Run: node scripts/schema-break.spec.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const SERVER = path.join(__dirname, "..", "server.js");
const src = fs.readFileSync(SERVER, "utf8");

// Lift the real functions and the real dependency map out of server.js, so this
// tests what ships rather than a copy of it.
function slice(start, end) {
  const a = src.indexOf(start);
  assert.ok(a > 0, `server.js should contain: ${start}`);
  const b = src.indexOf(end, a);
  assert.ok(b > a, `could not find the end of: ${start}`);
  return src.slice(a, b);
}
const lifted = new Function(
  slice("const REPORT_DEPENDENCIES", "// Helper: all unique tables") + "\n" +
  slice("function diffCatalogAgainstDependencies", "// A stable identity for") + "\n" +
  slice("function catalogDriftFingerprint", "async function checkCatalogDrift") + "\n" +
  "return { REPORT_DEPENDENCIES, diffCatalogAgainstDependencies, catalogDriftFingerprint };"
)();
const { REPORT_DEPENDENCIES: DEPS, diffCatalogAgainstDependencies: diff, catalogDriftFingerprint: fp } = lifted;

let passed = 0;
function test(name, fn) { fn(); console.log(`  ✓ ${name}`); passed++; }

// A catalog built FROM the map is by definition complete — the baseline case.
function catalogFromDeps(deps) {
  const cat = {};
  for (const r of Object.values(deps)) {
    for (const t of r.tables) cat[t] = cat[t] || new Set();
    for (const [t, cols] of Object.entries(r.columns || {})) {
      cat[t] = cat[t] || new Set();
      cols.forEach(c => cat[t].add(c));
    }
  }
  return cat;
}

test("a catalog containing everything the reports need is clean", () => {
  const d = diff(catalogFromDeps(DEPS), DEPS);
  assert.deepStrictEqual(d.missingTables, []);
  assert.deepStrictEqual(d.missingColumns, []);
});

test("extra tables and columns are invisible — additions can never alert", () => {
  const cat = catalogFromDeps(DEPS);
  cat.brand_new_table = new Set(["id", "whatever"]);
  cat.booking.add("some_new_column_nobody_asked_for");
  const d = diff(cat, DEPS);
  assert.deepStrictEqual(d.missingTables, []);
  assert.deepStrictEqual(d.missingColumns, []);
});

test("a dropped table is reported once, naming every report it breaks", () => {
  const cat = catalogFromDeps(DEPS);
  delete cat.booking;                       // depended on by many reports
  const d = diff(cat, DEPS);
  const hit = d.missingTables.find(t => t.table === "booking");
  assert.ok(hit, "booking should be reported missing");
  assert.strictEqual(d.missingTables.filter(t => t.table === "booking").length, 1, "once, not per report");
  assert.ok(hit.reports.length > 1, `should name the affected reports, got ${hit.reports}`);
  assert.ok(hit.reports.includes("programs"));
});

test("a dropped table does not also emit forty missing columns", () => {
  const cat = catalogFromDeps(DEPS);
  delete cat.booking;
  const d = diff(cat, DEPS);
  assert.strictEqual(d.missingColumns.filter(c => c.table === "booking").length, 0,
    "one dropped table is one finding, not a flood");
});

test("a dropped column is reported with the reports that use it", () => {
  const cat = catalogFromDeps(DEPS);
  cat.section.delete("program_id");
  const d = diff(cat, DEPS);
  const hit = d.missingColumns.find(c => c.table === "section" && c.column === "program_id");
  assert.ok(hit, "section.program_id should be flagged");
  assert.ok(hit.reports.length >= 1);
  assert.deepStrictEqual(d.missingTables, [], "the table itself is fine");
});

test("the same dropped column is not reported twice when several reports want it", () => {
  const cat = catalogFromDeps(DEPS);
  cat.booking.delete("organization_id");    // declared by many reports
  const d = diff(cat, DEPS);
  const hits = d.missingColumns.filter(c => c.table === "booking" && c.column === "organization_id");
  assert.strictEqual(hits.length, 1, "one column, one finding");
  assert.ok(hits[0].reports.length > 1, "but every affected report is named");
});

// ── The `class` regression, reconstructed ────────────────────────────
test("the August 2026 break WOULD be caught now that ice-calendar is mapped", () => {
  assert.ok(DEPS["ice-calendar"], "ice-calendar must be in the dependency map");
  const cat = catalogFromDeps(DEPS);
  // The product dropped `class` and `class_activity`, and the card's join chain
  // moved to program -> program_activity -> activity. Simulate losing the new
  // chain and confirm ice-calendar is named.
  delete cat.program_activity;
  const d = diff(cat, DEPS);
  const hit = d.missingTables.find(t => t.table === "program_activity");
  assert.ok(hit, "program_activity should be flagged");
  assert.ok(hit.reports.includes("ice-calendar"), `ice-calendar should be named, got ${hit.reports}`);
});

// ── Fingerprints, so a still-broken schema does not alert every morning ──
test("the same breakage fingerprints identically regardless of order", () => {
  const a = { missingTables: [{ table: "b" }, { table: "a" }], missingColumns: [{ table: "x", column: "y" }] };
  const b = { missingTables: [{ table: "a" }, { table: "b" }], missingColumns: [{ table: "x", column: "y" }] };
  assert.strictEqual(fp(a), fp(b));
});

test("a different breakage fingerprints differently, so new damage still alerts", () => {
  const one = { missingTables: [{ table: "a" }], missingColumns: [] };
  const two = { missingTables: [{ table: "a" }], missingColumns: [{ table: "x", column: "y" }] };
  assert.notStrictEqual(fp(one), fp(two));
});

test("a clean schema fingerprints empty", () => {
  assert.strictEqual(fp({ missingTables: [], missingColumns: [] }), "");
});

// ── Map hygiene ──────────────────────────────────────────────────────
// The check can only warn about what the map declares, so the map's own shape
// matters. It cannot verify the map against the live database from CI — that is
// what POST /api/admin/schema-break/check is for.
test("every report entry has tables, and every column table is declared", () => {
  for (const [report, r] of Object.entries(DEPS)) {
    assert.ok(Array.isArray(r.tables) && r.tables.length, `${report} needs tables`);
    for (const t of Object.keys(r.columns || {})) {
      assert.ok(r.tables.includes(t), `${report} declares columns for "${t}" but does not list it in tables`);
    }
  }
});

test("no table is declared twice within one report", () => {
  for (const [report, r] of Object.entries(DEPS)) {
    assert.strictEqual(new Set(r.tables).size, r.tables.length, `${report} lists a table twice`);
  }
});

test("court.name and order_item_transaction.type stay out of the map", () => {
  // Both were declared but do not exist: the cards key on court.court_number,
  // and the GL card derives payment vs refund from which id is set. The catalog
  // check found them on its first live run; this keeps them from creeping back.
  for (const [report, r] of Object.entries(DEPS)) {
    assert.ok(!(r.columns?.court || []).includes("name"), `${report} re-declares court.name`);
    assert.ok(!(r.columns?.order_item_transaction || []).includes("type"),
      `${report} re-declares order_item_transaction.type`);
  }
});

console.log(`\n${passed}/${passed} passing`);
