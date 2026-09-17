// Spec for "every filter on the rental schedule reaches the PDF".
//
// Dan, 2026-09-17, with the screen filtered to ONE site of fifty and a PDF
// carrying every site at that location: "fix the pdf generation on the facility
// rental report. site isn't making it into the pdf generation ... all filters
// should translate directly to the PDF."
//
// TWO THINGS WERE WRONG AND ONLY ONE OF THEM IS THE CAUSE.
//
//   1. THE CAUSE. The "seed all locations/sites" effect fires 3s after mount
//      and MERGES every location and site from its own 37-day window into the
//      SELECTED sets. On the print page those sets are the reader's filter,
//      seeded from the URL and carrying nothing else — so it widened the
//      selection back to everything. The timing made it certain rather than
//      occasional: generatePdf waits for #report-ready, then
//      waitForNetworkIdle(15s), then a hard 3s buffer, so the widening always
//      landed before the capture. It is gated on !print now; on the print page
//      there is no dropdown for it to fill, because renderToolbar returns null.
//
//   2. WHY ONLY SITES WERE REPORTED. `grouped` carried a "belt-and-suspenders"
//      re-filter for `locations` ALONE, so locations held in that same PDF and
//      sites, site types and add-ons did not. A guard that names one spelling
//      of a thing is not a guard against the thing — the Nth instance in this
//      repo. It is `printScopeRows` now and it covers all four.
//
// So this spec has to pin both halves independently, because either alone
// leaves the bug reachable: with the seed gated but the guard still naming
// locations, the next async widener reintroduces it; with the guard general but
// the seed ungated, the report is correct only because the guard keeps
// repairing it.
//
// It LIFTS AND RUNS printScopeRows rather than grepping it. Every defect here
// is a comparison — truthiness where presence was meant, an intersection read
// the wrong way round — and a regex passes on an inverted one.
//
// Run: node scripts/facility-pdf-filters.spec.js
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const PAGE = path.join(__dirname, "..", "public", "facility.html");
const SERVER = path.join(__dirname, "..", "server.js");
const src = fs.readFileSync(PAGE, "utf8");
const srv = fs.readFileSync(SERVER, "utf8");

let n = 0;
const fails = [];
function ok(cond, msg) { n++; try { assert.ok(cond, msg); } catch (e) { fails.push(e.message); } }
function eq(a, b, msg) { n++; try { assert.strictEqual(a, b, msg); } catch (e) { fails.push(e.message); } }

// ── Lift ────────────────────────────────────────────────────────────────────
function liftFn(name) {
  const at = src.indexOf("function " + name + "(");
  assert.ok(at > 0, "facility.html should declare " + name + " at module scope");
  // Skip the parameter list before counting braces — the first `{` in a
  // destructured signature is the parameter, not the body.
  const bodyAt = src.indexOf("{", src.indexOf(")", at));
  let depth = 0, i = bodyAt;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(at, i);
}

const lifted = new Function(
  liftFn("siteTypeKey") + "\n" +
  liftFn("parseAddOnItems") + "\n" +
  liftFn("stripAddonPrice") + "\n" +
  liftFn("printScopeRows") + "\n" +
  "const SITE_TYPE_NONE = '(no type)';\n" +
  "return { printScopeRows, siteTypeKey };")();
const { printScopeRows } = lifted;

// ── The fixture is Dan's own screen ─────────────────────────────────────────
// Rotary Park with three sites, which is what makes it discriminating: a page
// that honours the LOCATION filter and ignores the SITE one renders every
// Rotary Park row and looks entirely plausible, which is exactly what shipped.
// Every filter below therefore has to move a DIFFERENT number of rows.
const ROWS = [
  { location: "Rotary Park", site: "Rotary Park - Rotary House",           siteType: "room",  addons: "" },
  { location: "Rotary Park", site: "Rotary Park - Rotary House",           siteType: "room",  addons: "Alcohol Permit ($25.00)" },
  { location: "Rotary Park", site: "Rotary Park - Ballfield (With Lights)", siteType: "field", addons: "Field Light Fee ($15.50)" },
  { location: "Rotary Park", site: "Rotary Park - Ballfield (No Lights)",   siteType: "field", addons: "" },
  { location: "Griffin Park", site: "Griffin Park - Soccer 1",             siteType: "field", addons: "" },
];
const P = extra => Object.assign({ _print: "1" }, extra);
const sitesOf = rows => rows.map(r => r.site);

// ── 1. THE BUG, EXACTLY AS DAN HIT IT ───────────────────────────────────────
const oneSite = printScopeRows(ROWS, P({
  locations: "Rotary Park",
  sites: "Rotary Park - Rotary House",
}));
eq(oneSite.length, 2,
  "a PDF asked for ONE site must carry that site's rows only. This is the bug "
  + "as reported: the location filter held and the site filter did not, so the "
  + "PDF printed every site at that location. Got: "
  + JSON.stringify(sitesOf(oneSite)));
ok(oneSite.every(r => r.site === "Rotary Park - Rotary House"),
  "and nothing else. Got: " + JSON.stringify(sitesOf(oneSite)));

// The location filter must still work — it is the one that was already right,
// and a change that fixes sites by breaking locations is not a fix.
eq(printScopeRows(ROWS, P({ locations: "Rotary Park" })).length, 4,
  "the location filter must keep working");

// ── 2. Site types, on PRESENCE ──────────────────────────────────────────────
// The one filter whose EMPTY value is a real answer: the reader ticked None.
// Read as truthiness it means "no opinion", the print page falls back to every
// type, and the PDF carries rows while the screen showed none.
eq(printScopeRows(ROWS, P({ site_types: "" })).length, 0,
  "an EMPTY site_types means the reader ticked None and must yield NO rows. "
  + "Read as truthy it yields every row — a PDF that disagrees with a blank "
  + "screen");
eq(printScopeRows(ROWS, P({ site_types: "room" })).length, 2,
  "a populated site_types narrows to those types");
eq(printScopeRows(ROWS, P({})).length, ROWS.length,
  "an ABSENT site_types means the URL is not speaking about site types");

// ── 3. Add-ons ──────────────────────────────────────────────────────────────
const lit = printScopeRows(ROWS, P({ addons: "Field Light Fee" }));
eq(lit.length, 1, "the add-on filter narrows to rows carrying that add-on. Got: "
  + JSON.stringify(sitesOf(lit)));
eq(lit[0].site, "Rotary Park - Ballfield (With Lights)",
  "and it is matched on the STRIPPED name, not the priced string the card emits");

// ── 4. A STALE VALUE FALLS BACK — it does not blank the report ──────────────
// This mirrors setSelectedSites deliberately. A link naming a site this window
// does not contain is a stale link, and blanking the report over it is the
// confusing way to say so. Getting this wrong turns every shared PDF link into
// an empty page the first time the window moves off its sites.
eq(printScopeRows(ROWS, P({ sites: "Rotary Park - Tennis 4" })).length, ROWS.length,
  "a `sites` value naming nothing in this window is a STALE link and must fall "
  + "back to every row, exactly as the interactive seeding does");
eq(printScopeRows(ROWS, P({ site_types: "greenhouse" })).length, ROWS.length,
  "and a stale site_types likewise — which is a DIFFERENT case from the empty "
  + "one above, and the two must not be collapsed");
// Partially stale: keep the half that resolves.
eq(printScopeRows(ROWS, P({ sites: "Rotary Park - Rotary House,Rotary Park - Tennis 4" })).length, 2,
  "a partially stale list keeps the values that do resolve");

// ── 5. The filters COMPOSE ──────────────────────────────────────────────────
// Each is applied to the output of the last, not to the original rows. An
// implementation that reduces each over ROWS and unions the results renders
// more than the screen and still looks like filtering.
eq(printScopeRows(ROWS, P({ locations: "Rotary Park", site_types: "field" })).length, 2,
  "location AND site type compose");
eq(printScopeRows(ROWS, P({
  locations: "Rotary Park", sites: "Rotary Park - Rotary House", site_types: "room",
})).length, 2, "all three compose");
eq(printScopeRows(ROWS, P({ sites: "Rotary Park - Rotary House", site_types: "field" })).length, 0,
  "and a combination nothing satisfies yields nothing — these are ANDed, not ORed");

// EACH BRANCH MUST FILTER THE RUNNING RESULT, NOT THE ORIGINAL ROWS. A branch
// that reduces over `rows` re-admits what an earlier filter already excluded,
// and every assertion above still passes because they narrow in the same
// direction. Griffin Park is the discriminator: it shares no site, type or
// add-on with the Rotary Park rows, so a later branch reading `rows` can only
// ever ADD rows back. (This survived the first draft of this spec.)
eq(printScopeRows(ROWS, P({ locations: "Griffin Park" })).length, 1,
  "Griffin Park has exactly one row — the baseline the three cases below narrow");
eq(printScopeRows(ROWS, P({ locations: "Griffin Park", sites: "Rotary Park - Rotary House" })).length, 0,
  "the SITES branch must filter what the location branch left, not the original "
  + "rows — otherwise a PDF scoped to one location re-admits another's sites");
eq(printScopeRows(ROWS, P({ locations: "Griffin Park", site_types: "room" })).length, 0,
  "the SITE TYPES branch must filter the running result too");
eq(printScopeRows(ROWS, P({ locations: "Griffin Park", addons: "Field Light Fee" })).length, 0,
  "and the ADD-ONS branch, which runs last and is the easiest to write against "
  + "`rows` by habit");

// ── 6. It is INERT outside print mode ───────────────────────────────────────
// The interactive page has React state for all of this and a reader who unticks
// a box must not be overruled by the query string they arrived with.
eq(printScopeRows(ROWS, { locations: "Rotary Park", sites: "Rotary Park - Rotary House" }).length,
  ROWS.length,
  "printScopeRows must do NOTHING when _print is not '1' — on the interactive "
  + "page the URL is a seed, not the authority, and re-applying it would pin "
  + "the filters a reader is trying to change");
eq(printScopeRows(null, P({ sites: "x" })), null, "a null row set passes through");

// ── 7. THE SEED EFFECT IS GATED — the actual cause ──────────────────────────
// Source-asserted because it is a timing defect: the function is correct in
// both versions and what regressed is WHEN it runs and what it writes into.
const seedAt = src.indexOf("// ── Seed all locations/sites");
ok(seedAt > 0, "facility.html should still carry the seed-all effect");
const seedBlock = src.slice(seedAt, src.indexOf("}, []);", seedAt));
ok(/_print\s*===\s*'1'\s*\)\s*return;/.test(seedBlock),
  "the seed-all effect MUST return early in print mode. It merges its own "
  + "37-day window into selectedLocations/selectedSites, which on the print "
  + "page ARE the reader's filter — so it widens a one-site PDF back to fifty. "
  + "It fires at 3s and generatePdf waits far longer than that, so this is not "
  + "a race it sometimes loses; it always wins");
ok(seedBlock.indexOf("_print") < seedBlock.indexOf("setTimeout"),
  "the gate must come BEFORE the timer is armed, not inside the callback — a "
  + "timer that is scheduled and then no-ops still keeps the page busy");
ok(/setSelectedSites/.test(seedBlock) && /setSelectedLocations/.test(seedBlock),
  "this assertion is about the effect that writes the SELECTED sets — if it "
  + "stops doing that, re-point this spec rather than deleting it");

// ── 8. THE GUARD NAMES NO SINGLE FILTER ─────────────────────────────────────
// The shape of the original defect: `grouped` re-applied `params.locations` and
// nothing else, so three of four filters had no belt-and-braces at all.
const groupedAt = src.indexOf("const grouped = useMemo(");
ok(groupedAt > 0, "facility.html should declare `grouped`");
const groupedBlock = src.slice(groupedAt, src.indexOf("}, [filteredRows", groupedAt));
ok(/printScopeRows\(filteredRows,\s*params\)/.test(groupedBlock),
  "`grouped` must scope through printScopeRows in print mode");
ok(!/params\.locations\.split/.test(groupedBlock),
  "`grouped` must NOT re-apply one named filter by hand any more. That is the "
  + "guard that masked this bug for locations while sites went unprotected");

// Every filter the PDF can carry is handled by the one function.
const scopeBlock = liftFn("printScopeRows");
["params.locations", "params.sites", "params.site_types", "params.addons"].forEach(k => {
  ok(scopeBlock.includes(k),
    "printScopeRows must read " + k + " — a guard that covers three of four "
    + "list filters is how this shipped");
});

// ── 9. The two filters that need NO guard, and why ──────────────────────────
// `book_type` and `musco` are seeded SYNCHRONOUSLY in useState from the URL and
// nothing reconciles them from a feed, so no async answer can overwrite them.
// That is the whole reason they are absent from printScopeRows, and it is worth
// asserting: the day one of them grows a reconcile effect it needs the guard.
ok(/useState\(params\.musco === '1'\)/.test(src),
  "`musco` must stay seeded synchronously from the URL, or it needs a guard in "
  + "printScopeRows like the four list filters");
ok(/useState\(params\.book_type \|\| 'all'\)/.test(src),
  "`book_type` must stay seeded synchronously from the URL, same reason");

// ── 10. The client SENDS every one of them ──────────────────────────────────
// Three gates on this report and passing two looks exactly like working.
const dl = src.slice(src.indexOf("function downloadPdf()"));
const dlBody = dl.slice(0, dl.indexOf("\n  }"));
[
  ["locations", /qs\.set\('locations'/],
  ["sites", /qs\.set\('sites'/],
  ["site_types", /qs\.set\('site_types'/],
  ["addons", /qs\.set\('addons'/],
  ["book_type", /qs\.set\('book_type'/],
  ["musco", /qs\.set\('musco'/],
  ["pii", /qs\.set\('pii'/],
  ["sitetype", /qs\.set\('sitetype'/],
].forEach(([k, re]) => {
  ok(re.test(dlBody), "downloadPdf must send `" + k + "` — the screen being "
    + "right says nothing about the server-rendered PDF");
});

// ── 11. The SERVER forwards every one of them — LIFTED AND RUN ─────────────
// A render case at ?_print=1&sites=… proves the PAGE reads the parameter and
// says nothing about whether the server SENDS it. That gap is exactly how
// gl_codes, refunds and pii each shipped broken.
const gp = srv.slice(srv.indexOf("async function generatePdf("));
const qsBlock = gp.slice(gp.indexOf("const qsObj = {"),
                         gp.indexOf("const qs = new URLSearchParams(qsObj);")
                           + "const qs = new URLSearchParams(qsObj);".length);
ok(qsBlock.includes("forEach"), "the generatePdf query block should be liftable");
const buildQs = new Function("startDate", "endDate", "orgTok", "filters",
  qsBlock + "\nreturn qs.toString();");

const full = buildQs("2026-09-16", "2026-09-22", "tok", {
  locations: "Rotary Park",
  sites: "Rotary Park - Rotary House",
  site_types: "room",
  addons: "Alcohol Permit",
  book_type: "instant",
  musco: "1",
  pii: "phone,email",
  sitetype: "1",
});
["locations", "sites", "site_types", "addons", "book_type", "musco", "pii", "sitetype"]
  .forEach(k => {
    ok(new RegExp("(^|&)" + k + "=").test(full),
      "generatePdf must forward `" + k + "` to the print page. Got: " + full);
  });
ok(/sites=Rotary\+Park\+-\+Rotary\+House/.test(full),
  "and `sites` must carry its VALUE, not merely appear. Got: " + full);

// The empty-value cases, which the truthy loop cannot express.
const none = buildQs("2026-09-16", "2026-09-22", "tok", { site_types: "", pii: "", sitetype: "0" });
ok(/(^|&)site_types=(&|$)/.test(none), "an EMPTY site_types must survive. Got: " + none);
ok(/(^|&)pii=(&|$)/.test(none), "an EMPTY pii must survive. Got: " + none);
ok(/(^|&)sitetype=0(&|$)/.test(none), "sitetype=0 must survive. Got: " + none);

const absent = buildQs("2026-09-16", "2026-09-22", "tok", {});
["locations", "sites", "site_types", "addons", "musco"].forEach(k => {
  ok(!new RegExp("(^|&)" + k + "=").test(absent),
    "an ABSENT `" + k + "` must not be invented. Got: " + absent);
});

// ── 12. The empty state is keyed on what DREW ───────────────────────────────
// printScopeRows can narrow to zero while filteredRows is non-empty (site_types
// = '' is the live case), and a page that renders no rows and no message is a
// blank PDF that says nothing about why.
ok(/filteredRows && sortedDates\.length === 0/.test(src),
  "the empty state must be keyed on sortedDates — the rows that actually drew — "
  + "not on filteredRows, or a print-scoped empty result renders a blank page "
  + "with no explanation");

// ─────────────────────────────────────────────────────────────────────────────
if (fails.length) {
  console.error("\n" + fails.length + " of " + n + " assertions FAILED:\n");
  fails.forEach(f => console.error("  ✗ " + f + "\n"));
  process.exit(1);
}
console.log(n + " assertions passed.");
