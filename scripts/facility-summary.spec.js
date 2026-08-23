// Spec for aggregate() in public/facilities.html — the Summary KPI cards.
//
// The bug this pins down (Douglas County, campsite + Topaz Lake, Aug 2026):
// the Summary read 254 bookings / 46 sites / $2,960 charged while the Camping
// tab read 198 / 41 / $2,520 off the same feed. Decomposed against prod:
//
//   254 bookings = 198 live reservations + 8 canceled + 48 invoice_v2 fee lines
//   46 sites     = 41 campsite courts    + 5 distinct FEE NAMES
//   $2,960       = $2,520 live + $60 canceled-night charges + $380 invoiced
//
// Card 19570 unions invoice_v2 manual lines into the reservation feed, and they
// are shaped like reservations without being any: "Reservation ID" is an
// order_item id, "Facility" is the fee's NAME, "Status" is hard-coded Confirmed,
// and "Site Type" is inherited from a representative court of the rental — so
// the site-type and status chips cannot exclude them. Anything that counts feed
// ROWS counts fees as bookings, and anything that counts Facility strings counts
// fee names as sites.
//
// The rule these tests hold: an invoice row contributes MONEY ONLY. It is never
// a booking and never a site. Amounts still include it, because surfacing that
// money is the whole reason v2 exists.
//
// Run: node scripts/facility-summary.spec.js
// Needs @babel/standalone (CI installs it for the JSX check).
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

let Babel;
try { Babel = require("@babel/standalone"); }
catch { console.log("skipped — @babel/standalone not installed"); process.exit(0); }

const ROOT = path.join(__dirname, "..");

// Pull the real aggregate() out of the page rather than restating it here.
function loadAggregate() {
  const html = fs.readFileSync(path.join(ROOT, "public", "facilities.html"), "utf8");
  const block = /<script[^>]*type=["']text\/babel["'][^>]*>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(block, "facilities.html should contain a text/babel block");
  const { code } = Babel.transform(block[1], { presets: ["react"] });
  const stubs = {
    React: { createElement: () => null, useState: () => [null, () => {}], useEffect() {}, useMemo() {},
             useRef: () => ({ current: null }), useCallback: f => f, Fragment: "F" },
    ReactDOM: { createRoot: () => ({ render() {} }) },
    document: { getElementById: () => ({}), body: { classList: { add() {} } },
                addEventListener() {}, removeEventListener() {}, createElement: () => ({ style: {} }) },
    window: { location: { pathname: "/douglas-county-nv/facilities", search: "", origin: "http://x" },
              history: { replaceState() {} }, addEventListener() {}, matchMedia: () => ({ matches: false }) },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: () => Promise.resolve({ ok: false, json: () => ({}) }),
    URL_TOKEN: "", ORG_CONFIG: { slug: "douglas-county-nv" }, L: undefined,
  };
  const names = Object.keys(stubs);
  return new Function(...names, code + "\nreturn aggregate;")(...names.map(n => stubs[n]));
}

const aggregate = loadAggregate();

let passed = 0;
function test(name, fn) { fn(); console.log(`  ✓ ${name}`); passed++; }

// ── A feed shaped exactly like the one that produced the wrong dashboard ──
// 198 live campsite reservations across 41 sites at $2,520, 8 canceled ones
// carrying $60 (the 6 that fr.status called Confirmed are labelled Canceled here
// because the fixed card reads r.canceled_at), and 48 invoice lines worth $380
// under 5 fee names.
const LOC = "Topaz Lake Recreation Area";
function resRow(i, status, total) {
  const site = (i % 41) + 1;                      // 41 distinct sites
  return {
    "Reservation ID": "res-" + i, "Date": "2026-08-" + String((i % 28) + 1).padStart(2, "0"),
    "Location": LOC, "Site ID": "court-" + site, "Facility": "Site " + String(site).padStart(2, "0"),
    "Site Type": "campsite", "Booking Type": i % 8 === 0 ? "Instant" : "Managed",
    "Status": status, "Source": "Reservation",
    "Total": status === "Canceled" ? 0 : total, "Billed": total, "Collected": total, "Refunded": 0,
  };
}
const FEE_NAMES = ["Tournament fee", "Event space rental", "Deposit", "Janitorial fee", "Security fee"];
function invRow(i) {
  return {
    "Reservation ID": "oi-" + i, "Date": "2026-08-15",
    "Location": LOC, "Site ID": null, "Facility": FEE_NAMES[i % FEE_NAMES.length],
    "Site Type": "campsite",                       // inherited — this is why chips miss it
    "Booking Type": "Managed", "Status": "Confirmed", "Source": "Invoice",
    "Total": 380 / 48, "Billed": 380 / 48, "Collected": 380 / 48, "Refunded": 0,
  };
}
const ROWS = [];
for (let i = 0; i < 198; i++) ROWS.push(resRow(i, i % 2 ? "Confirmed" : "In-progress", 2520 / 198));
for (let i = 0; i < 8; i++)   ROWS.push(resRow(1000 + i, "Canceled", 60 / 8));
for (let i = 0; i < 48; i++)  ROWS.push(invRow(i));

const ALL_STATUS = ["confirmed", "in-progress", "canceled"];
const LIVE_STATUS = ["confirmed", "in-progress"];
const CAMPSITE = ["campsite"];
const near = (a, b, why) => assert.ok(Math.abs(a - b) < 0.01, `${why}: ${a} vs ${b}`);

test("invoice fee lines are not counted as bookings", () => {
  const a = aggregate(ROWS, ALL_STATUS, CAMPSITE);
  assert.strictEqual(a.bookings, 206, "198 live + 8 canceled, and none of the 48 fee lines");
});

test("with canceled deselected, bookings match the Camping tab exactly", () => {
  const a = aggregate(ROWS, LIVE_STATUS, CAMPSITE);
  assert.strictEqual(a.bookings, 198);
});

test("fee names are not counted as sites — 41, not 46", () => {
  assert.strictEqual(aggregate(ROWS, ALL_STATUS, CAMPSITE).sites, 41);
  assert.strictEqual(aggregate(ROWS, LIVE_STATUS, CAMPSITE).sites, 41);
});

test("sites survive two locations sharing a site name", () => {
  // Without a "Site ID" the legacy card keys on name+location; with one, identity
  // wins. Either way "Site 01" at two campgrounds is two sites, not one.
  const other = ROWS.filter(r => r["Source"] === "Reservation").slice(0, 5).map((r, i) => Object.assign({}, r, {
    "Reservation ID": "other-" + i, "Location": "Second Campground", "Site ID": "other-court-" + i,
  }));
  assert.strictEqual(aggregate(ROWS.concat(other), ALL_STATUS, CAMPSITE).sites, 46);
});

test("invoiced money is still in Charged — the point of the v2 card", () => {
  const a = aggregate(ROWS, ALL_STATUS, CAMPSITE);
  near(a.billed, 2520 + 380, "live rental plus the invoiced lines");
  near(a.invoicedRev, 380, "invoiced revenue is reported on its own");
  assert.strictEqual(a.invoicedN, 48, "and so is the line count");
});

test("a canceled night's charge is not Charged", () => {
  // This is what the card fix buys. billedOf() already zeroes a row whose Status
  // says Canceled — it just never saw one, because Status came from fr.status and
  // 6 of these 8 sat inside rentals that were still Confirmed or In-progress. So
  // $60 of canceled nights counted as revenue. Reading r.canceled_at labels them,
  // and the money drops out with no client change at all.
  const mislabeled = ROWS.map(r => r["Status"] === "Canceled"
    ? Object.assign({}, r, { "Status": "Confirmed", "Total": r["Billed"] })
    : r);
  near(aggregate(mislabeled, ALL_STATUS, CAMPSITE).billed, 2520 + 60 + 380, "the bug: $60 in Charged");
  near(aggregate(ROWS, ALL_STATUS, CAMPSITE).billed, 2520 + 380, "fixed: labelled Canceled, so excluded");
});

test("Charged excludes canceled nights, so it ties to the Camping tab", () => {
  // `revenue` is the canceled-aware number: a canceled row contributes 0.
  near(aggregate(ROWS, ALL_STATUS, CAMPSITE).revenue, 2520 + 380, "live rental + invoiced");
  near(aggregate(ROWS, LIVE_STATUS, CAMPSITE).revenue, 2520 + 380, "same with canceled deselected");
});

test("the cancellation rate is out of bookings, not out of fee lines", () => {
  const a = aggregate(ROWS, ALL_STATUS, CAMPSITE);
  assert.strictEqual(a.canceled, 8);
  // 8/206 = 3.9%. Against the old 8/254 denominator it read 3.1% — and before
  // the card learned to read r.canceled_at, 2/254 = 1%.
  assert.ok(Math.round(a.canceled / a.bookings * 100) === 4, "8 of 206");
});

test("Top sites by revenue contains sites, not fees", () => {
  const a = aggregate(ROWS, ALL_STATUS, CAMPSITE);
  a.topSites.forEach(s => assert.ok(!FEE_NAMES.includes(s.facility),
    `"${s.facility}" is a fee, not a site`));
  assert.ok(a.topSites.length > 0, "and it is not empty");
});

test("per-type rollups count bookings without fees but keep their money", () => {
  const a = aggregate(ROWS, ALL_STATUS, CAMPSITE);
  const t = a.byType[Object.keys(a.byType)[0]];
  assert.strictEqual(t.bookings, 206, "fee lines are not bookings here either");
  assert.strictEqual(t.sites.size, 41, "nor sites");
  near(t.revenue, 2520 + 380, "but their revenue still lands in the type total");
});

test("a scope with only fee lines reports no bookings and no sites", () => {
  const a = aggregate(ROWS.filter(r => r["Source"] === "Invoice"), ALL_STATUS, CAMPSITE);
  assert.strictEqual(a.bookings, 0);
  assert.strictEqual(a.sites, 0);
  near(a.billed, 380, "the money is still there");
});

console.log(`\n${passed}/${passed} passing`);
