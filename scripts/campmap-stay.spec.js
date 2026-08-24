// Spec for the campsite map's stay reducer in public/campmap.html.
//
// This pins down decisions that were expensive to establish and are invisible in
// the code itself — every one of them was measured against rec.us and the
// reservation ledger on 2026-08-23, and every one is the kind of thing a later
// "tidy-up" would quietly reverse:
//
// 1. A STAY OCCUPIES arrive .. depart-1. The checkout morning is not occupied
//    (Topaz checks out at 11:00, in at 13:00), so counting it would reject a
//    stay because of a booking that starts as the camper drives away.
//
// 2. ARRIVALS ARE CAPPED AT 30 NIGHTS, CHECKOUTS ARE NOT. rec.us enumerates 30
//    days of arrivals and takes no range parameter — verified three ways, incl.
//    the staff-scoped tool — but its `latestCheckout` reaches beyond them and is
//    conflict-aware out there: it truncates exactly at the next real booking,
//    including bookings in October. Measured: 37 boundary-crossing arrivals, 37
//    ledger-clear, 0 clashes. Capping the checkout at the window instead would
//    make the LAST arrival night unbookable for all 39 otherwise-bookable sites
//    and decay the longest stay 14 → 8 → 5 → 2 → 1 → 0 across the final week,
//    while fixing nothing. So: never bound the checkout by the strip's length.
//
// 3. ONE MIS-SET SITE MUST NOT MOVE THE PARK. 40 of 41 Topaz sites allow 14
//    nights; Site 04 briefly said 180 (a slip — "nights per stay" sits directly
//    above "days in advance" in that panel). Taking the longest window any single
//    site offers let that one row offer a 180-night stay for the whole
//    campground.
//
// 5. A DATE PAST A SITE'S BOOKING WINDOW IS NOT A REFUSAL. Since 2026-08-24 the
//    page reads rec.us's 210-day nightly-availability feed instead of the 30-day
//    MCP tool, so for the first time it sees dates a site has not opened yet.
//    They come back `available:false, reason:"outside-window"` — the SAME shape
//    as a staff hold awaiting payment, which genuinely blocks the site. Position
//    is the only thing that tells them apart: the window's end is the run of them
//    that reaches the END of the feed. Collapsing the two paints ~30 open nights
//    red at Topaz and sends campers elsewhere for dates the site will take.
//
// 6. THE HORIZON IS PER SITE (Dan: "availability should scope to the actual site
//    availability"). At Topaz 39 of 41 sites take arrivals 180 days out, one
//    takes 90 and one takes all 210, so any park-wide number is wrong for some
//    site in one direction or the other.
//
// 4. "NOT AVAILABLE" AND "WRONG STAY LENGTH" ARE DIFFERENT ANSWERS. A staff hold
//    awaiting payment blocks the site and comes back as
//    `reason:"outside-window"`, NOT `conflict`. Binning every non-conflict reason
//    as "booking restriction" told a camper to retry with a shorter stay on a
//    site that is simply taken. Only a genuine min/max-stay rejection may say
//    that.
//
// Run: node scripts/campmap-stay.spec.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "public", "campmap.html"), "utf8");

// Pull the real functions out of the page rather than restating them. campmap.html
// builds a Leaflet map at module scope, so the whole block cannot be evaluated —
// slice the pure reducer instead, between two stable anchors.
function slice(from, to) {
  const i = html.indexOf(from);
  const j = html.indexOf(to, i);
  assert.ok(i > 0 && j > i, `could not slice ${from} .. ${to} — did campmap.html move?`);
  return html.slice(i, j);
}

const src = [
  slice("function iso(d){", "var MON="),
  slice("var CANON_KINDS = {", "function kindInfo(k){"),
  slice("function nightStateFrom(v){", "/* ── map setup ── */"),
  slice("function latestCheckoutFrom(dateStr){", "// setStay is the only way"),
].join("\n");

// The globals the sliced code reads. Everything else it needs is in the slice.
const harness = `
  var SEED = [], AVAIL = {}, AVAIL_WINDOW = {}, SELECTED = null, DEPART = null;
  var HORIZON = {}, DAYS_SHOWN = 30;
  // maxArrival falls back to TODAY + DAYS_SHOWN - 1 when no site in view knows
  // its own horizon. The spec pins that fallback's SHAPE, so TODAY is fixed here
  // rather than read from the clock.
  var TODAY = new Date('2026-09-01T00:00:00');
  var MAX_META_NIGHTS = 14, META_BY_ID = {};
  // Per-site maxNights when the test sets one, else the org default — siteMeta in
  // the page resolves area overrides the same way.
  function siteMeta(s){ return META_BY_ID[s && s.id] || { maxNights: MAX_META_NIGHTS }; }
  function pad(n){ return String(n).padStart(2,'0'); }
  // sKind reads the live /api/sites overlay in the page; the type it resolves to
  // is all typeKey needs, so the seed value stands in for it here.
  function sKind(s){ return s.kind; }
  ${src}
  return {
    nightsOf: nightsOf, stayNights: stayNights, statusOn: statusOn,
    nightStateFrom: nightStateFrom, typeKey: typeKey, inView: inView, VIEW: VIEW,
    rangeStatus: rangeStatus, rangeWhy: rangeWhy, latestCheckoutFrom: latestCheckoutFrom,
    bookingHorizon: bookingHorizon, siteNightStates: siteNightStates, maxArrival: maxArrival,
    set: function(o){ if(o.SEED) SEED = o.SEED; if(o.AVAIL) AVAIL = o.AVAIL;
                      if(o.AVAIL_WINDOW) AVAIL_WINDOW = o.AVAIL_WINDOW;
                      if(o.SELECTED) SELECTED = o.SELECTED; if(o.DEPART) DEPART = o.DEPART;
                      if(o.maxNights != null) MAX_META_NIGHTS = o.maxNights;
                      if(o.meta) META_BY_ID = o.meta;
                      if(o.type !== undefined) TYPE_FILTER = o.type;
                      if(o.HORIZON) HORIZON = o.HORIZON; },
  };
`;
const M = new Function(harness)();

let passed = 0;
function test(name, fn) { fn(); console.log(`  ✓ ${name}`); passed++; }

// A site whose nights we control directly.
const SITE = { id: "s1", n: 1 };
function stay(arrive, depart, nights, win) {
  M.set({
    type: "all",
    SEED: [SITE],
    AVAIL: { s1: nights },
    AVAIL_WINDOW: { s1: win || {} },
    SELECTED: arrive, DEPART: depart,
  });
  return M.rangeStatus(SITE);
}

// ── 1. the checkout night is not part of the stay ───────────────────────────
test("a stay covers arrive .. depart-1, not the checkout night", () => {
  assert.deepStrictEqual(M.nightsOf("2026-09-01", "2026-09-04"),
    ["2026-09-01", "2026-09-02", "2026-09-03"]);
  assert.deepStrictEqual(M.nightsOf("2026-09-01", "2026-09-02"), ["2026-09-01"]);
});

test("a booking starting on the checkout morning does not block the stay", () => {
  const r = stay("2026-09-01", "2026-09-03",
    { "2026-09-01": "avail", "2026-09-02": "avail", "2026-09-03": "booked" });
  assert.strictEqual(r.state, "avail", "the 3rd is checkout day — somebody else may arrive then");
  assert.strictEqual(r.total, 2);
});

// ── 2. the three flavours of "no" ───────────────────────────────────────────
test("a real conflict reads as not available, never as a stay-length problem", () => {
  const r = stay("2026-09-01", "2026-09-03",
    { "2026-09-01": "booked", "2026-09-02": "booked" });
  assert.strictEqual(r.state, "booked");
  assert.match(M.rangeWhy(r), /Not available/);
  assert.doesNotMatch(M.rangeWhy(r), /stay this long|restriction/i);
});

test("rec.us reasons map to the state that tells the camper the right thing", () => {
  // The mapping itself, not just its downstream effect. An earlier version of
  // this spec tested only rangeStatus and a mutation reverting this mapping
  // passed silently.
  const f = M.nightStateFrom;
  assert.strictEqual(f({ available: true, earliestCheckout: "x", latestCheckout: "y" }), "avail");
  assert.strictEqual(f({ available: false, reason: "conflict" }), "booked");
  // A staff hold awaiting payment arrives as outside-window and BLOCKS the site.
  assert.strictEqual(f({ available: false, reason: "outside-window" }), "closed",
    "must NOT be 'blocked' — that tells the camper to try a shorter stay on a taken site");
  assert.strictEqual(f({ available: false, reason: "blackout" }), "closed");
  assert.strictEqual(f({ available: false, reason: "closed" }), "closed");
  // Only a genuine stay-length rejection may offer a different length.
  assert.strictEqual(f({ available: false, reason: "minimum-stay" }), "blocked");
  assert.strictEqual(f({ available: false, reason: "maximum-nights" }), "blocked");
  assert.strictEqual(f(undefined), "blocked");
});

test("a staff hold (outside-window → closed) blocks, and does not offer a shorter stay", () => {
  // This is the Site 22 case: rec.us returns available:false reason:outside-window
  // for nights a staff hold covers. It must read as taken, not as a rule to work
  // around, or the camper retries a shorter trip that also fails.
  const r = stay("2026-09-01", "2026-09-03",
    { "2026-09-01": "closed", "2026-09-02": "closed" });
  assert.strictEqual(r.state, "booked", "closed rides with booked for the verdict");
  assert.doesNotMatch(M.rangeWhy(r), /stay this long/i);
});

test("a min/max-stay rejection DOES offer a different length, with real numbers", () => {
  const r = stay("2026-09-01", "2026-09-06",
    { "2026-09-01": "blocked", "2026-09-02": "blocked", "2026-09-03": "blocked",
      "2026-09-04": "blocked", "2026-09-05": "blocked" },
    { "2026-09-01": { earliest: "2026-09-02", latest: "2026-09-04" } });
  assert.strictEqual(r.state, "blocked");
  const why = M.rangeWhy(r);
  assert.match(why, /Not for 5 nights/);
  assert.match(why, /1–3/, "quotes rec.us's own checkout window as nights");
});

test("nights with no data are unknown — never guessed in either direction", () => {
  const r = stay("2026-09-01", "2026-09-03", {});
  assert.strictEqual(r.state, "unknown");
  assert.match(M.rangeWhy(r), /see rec\.us/);
});

// ── 3. partial is a first-class answer ──────────────────────────────────────
test("some-nights-free is its own state, and names the night in the way", () => {
  const r = stay("2026-09-01", "2026-09-05",
    { "2026-09-01": "avail", "2026-09-02": "booked",
      "2026-09-03": "avail", "2026-09-04": "avail" });
  assert.strictEqual(r.state, "partial");
  assert.strictEqual(r.openCount, 3);
  const why = M.rangeWhy(r);
  assert.match(why, /Open 3 of 4 nights/);
  assert.match(why, /Wed 2/, "says which night, so the camper can shift a day");
});

// ── 4. the checkout bound comes from rec.us, capped by configured max stay ──
test("the checkout may legitimately run past the 30-night arrival window", () => {
  // The measured case: a 22 Sep arrival could check out 6 Oct. Bounding this by
  // the strip's length would refuse a stay rec.us accepts, and would make the
  // final arrival night unbookable outright.
  M.set({ SEED: [SITE], AVAIL: {}, maxNights: 14,
          AVAIL_WINDOW: { s1: { "2026-09-22": { earliest: "2026-09-23", latest: "2026-10-06" } } } });
  assert.strictEqual(M.latestCheckoutFrom("2026-09-22"), "2026-10-06");
});

test("one mis-set site cannot stretch the whole park's picker", () => {
  // Site 04 briefly carried a 180-night max. Taking the longest window any site
  // offers would have let it offer a 180-night stay campground-wide.
  const good = { id: "good", n: 1 }, bad = { id: "bad", n: 2 };
  M.set({ SEED: [good, bad], AVAIL: {}, maxNights: 14, AVAIL_WINDOW: {
    good: { "2026-09-01": { earliest: "2026-09-02", latest: "2026-09-08" } },
    bad:  { "2026-09-01": { earliest: "2026-09-02", latest: "2027-02-28" } },
  }});
  const cap = M.latestCheckoutFrom("2026-09-01");
  assert.strictEqual(cap, "2026-09-15", "capped at the configured 14 nights, not the outlier's 180");
});

test("with no window in the feed, it falls back to the configured max stay", () => {
  M.set({ SEED: [SITE], AVAIL: {}, AVAIL_WINDOW: { s1: {} }, maxNights: 14 });
  assert.strictEqual(M.latestCheckoutFrom("2026-09-01"), "2026-09-15",
    "14 nights — not one night, which would refuse stays the org allows");
  M.set({ maxNights: 5 });   // Pleasant Hill
  assert.strictEqual(M.latestCheckoutFrom("2026-09-01"), "2026-09-06");
});

// ── 5. the campsite-type filter ─────────────────────────────────────────────
test("rec.us's four campsite types are matched exactly, not by substring", () => {
  // 'rv' contains no 'tent', but 'tent-and-rv' contains 'rv' — the substring
  // rules this replaced answered "Tent & RV" for an RV-only site, which is the
  // one answer a tent camper must never be given.
  const k = s => M.typeKey({ id: "x", kind: s });
  assert.strictEqual(k("rv"), "rv");
  assert.strictEqual(k("tent-and-rv"), "tent-and-rv");
  assert.strictEqual(k("tent"), "tent");
  assert.strictEqual(k("lodging"), "lodging");
  // Ours, not Rec's: Pleasant Hill's campsites carry sub_type NULL, so these are
  // derived from the description and must survive.
  assert.strictEqual(k("electric"), "electric");
  assert.strictEqual(k("primitive"), "primitive");
});

test("a selected type narrows the set every count and list reads from", () => {
  const tent = { id: "t", n: 1, kind: "tent" };
  const rv   = { id: "r", n: 2, kind: "rv" };
  M.set({ type: "all", SEED: [tent, rv], AVAIL: {}, AVAIL_WINDOW: {} });
  assert.strictEqual(M.VIEW().length, 2);
  M.set({ type: "rv" });
  assert.deepStrictEqual(M.VIEW().map(x => x.id), ["r"]);
  assert.strictEqual(M.inView(tent), false);
  assert.strictEqual(M.inView(rv), true);
});

test("the checkout bound comes from the sites in view, not the ones filtered out", () => {
  // Otherwise picking "tent only" still offers the 14-night checkout that only
  // the lodging units allow, and rec.us then refuses the stay the picker offered.
  const tent = { id: "t", n: 1, kind: "tent" };
  const lodge = { id: "l", n: 2, kind: "lodging" };
  M.set({ type: "all", SEED: [tent, lodge], AVAIL: {}, AVAIL_WINDOW: {},
          meta: { t: { maxNights: 3 }, l: { maxNights: 14 } } });
  M.set({ type: "lodging" });
  assert.strictEqual(M.latestCheckoutFrom("2026-09-01"), "2026-09-15");
  M.set({ type: "tent" });
  assert.strictEqual(M.latestCheckoutFrom("2026-09-01"), "2026-09-04",
    "3 nights — the tent sites' own limit, not the lodging units'");
});

// ── 6. a whole-stay verdict needs every night ───────────────────────────────
test("one unavailable night is enough to stop calling the stay open", () => {
  const nights = {};
  for (let i = 1; i <= 14; i++) nights["2026-09-" + String(i).padStart(2, "0")] = "avail";
  let r = stay("2026-09-01", "2026-09-15", nights);
  assert.strictEqual(r.state, "avail", "14 clean nights");
  nights["2026-09-09"] = "booked";
  r = stay("2026-09-01", "2026-09-15", nights);
  assert.strictEqual(r.state, "partial", "one night taken in the middle");
  assert.strictEqual(r.openCount, 13);
});

// ── 7. where a site's booking window ends ──────────────────────────────────
// Shaped like the real feed: rec.us answers 210 dates and marks everything past
// the site's window `outside-window`.
const OPEN  = { available: true, earliestCheckout: "x", latestCheckout: "y" };
const OUT   = { available: false, reason: "outside-window" };
const HELD  = { available: false, reason: "outside-window" };   // identical on the wire
const TAKEN = { available: false, reason: "conflict" };

test("the horizon is the last date before the trailing outside-window run", () => {
  assert.deepStrictEqual(M.bookingHorizon({
    "2026-09-01": OPEN, "2026-09-02": OPEN, "2026-09-03": OPEN,
    "2026-09-04": OUT, "2026-09-05": OUT,
  }), { known: true, last: "2026-09-03" });
});

test("a mid-feed staff hold is NOT a horizon — only the trailing run is", () => {
  // Same reason string, different meaning. Reading the FIRST outside-window as
  // the window's end would cut the map off at a hold and hide every open night
  // after it.
  assert.deepStrictEqual(M.bookingHorizon({
    "2026-09-01": OPEN, "2026-09-02": HELD, "2026-09-03": OPEN,
    "2026-09-04": OPEN, "2026-09-05": OUT,
  }), { known: true, last: "2026-09-04" });
});

test("no trailing run means unknown, never 'bookable to the end'", () => {
  // The 30-day MCP feed always lands here: it stops at day 30 because that is all
  // it was asked for, which says nothing about the site's window.
  assert.deepStrictEqual(
    M.bookingHorizon({ "2026-09-01": OPEN, "2026-09-02": TAKEN, "2026-09-03": OPEN }),
    { known: false });
  assert.deepStrictEqual(M.bookingHorizon({}), { known: false });
});

test("a site with no bookable arrival at all reports known-but-none", () => {
  assert.deepStrictEqual(
    M.bookingHorizon({ "2026-09-01": OUT, "2026-09-02": OUT }),
    { known: true, last: null });
});

// ── 8. past the window reads as "not open yet", not "taken" ────────────────
test("dates past the window become 'beyond'; the ones before are untouched", () => {
  const got = M.siteNightStates({ checkInDates: {
    "2026-09-01": OPEN, "2026-09-02": TAKEN, "2026-09-03": HELD,
    "2026-09-04": OPEN, "2026-09-05": OUT, "2026-09-06": OUT,
  } }, "nightly");
  assert.strictEqual(got.states["2026-09-01"], "avail");
  assert.strictEqual(got.states["2026-09-02"], "booked");
  assert.strictEqual(got.states["2026-09-03"], "closed",
    "a hold inside the window still blocks the site — it is not 'not open yet'");
  assert.strictEqual(got.states["2026-09-04"], "avail");
  assert.strictEqual(got.states["2026-09-05"], "beyond");
  assert.strictEqual(got.states["2026-09-06"], "beyond");
  assert.deepStrictEqual(got.horizon, { known: true, last: "2026-09-04" });
});

test("the 30-day feed never produces 'beyond' — its tail is not a horizon", () => {
  const got = M.siteNightStates({ checkInDates: {
    "2026-09-01": OPEN, "2026-09-02": OUT, "2026-09-03": OUT,
  } }, "mcp");
  assert.strictEqual(got.states["2026-09-02"], "closed");
  assert.strictEqual(got.states["2026-09-03"], "closed");
  assert.deepStrictEqual(got.horizon, { known: false });
});

test("a stay entirely past the window says so instead of 'not available'", () => {
  const r = stay("2026-09-05", "2026-09-07",
    { "2026-09-05": "beyond", "2026-09-06": "beyond" });
  assert.strictEqual(r.state, "beyond");
  assert.match(M.rangeWhy(r), /not open for booking/i);
  assert.doesNotMatch(M.rangeWhy(r), /not available/i,
    "'Not available' sends a camper to another site for a date this one will take");
});

test("a stay that straddles the window is partial, and names both reasons", () => {
  const r = stay("2026-09-01", "2026-09-04",
    { "2026-09-01": "avail", "2026-09-02": "booked", "2026-09-03": "beyond" });
  assert.strictEqual(r.state, "partial");
  assert.deepStrictEqual(r.beyond, ["2026-09-03"]);
  assert.deepStrictEqual(r.booked, ["2026-09-02"]);
  const why = M.rangeWhy(r);
  assert.match(why, /unavailable/);
  assert.match(why, /not open yet/);
});

// ── 9. the arrival bound is per site, and scoped to what is on screen ──────
test("the Arrive bound is the furthest horizon among the sites in view", () => {
  const a = { id: "a", n: 1, kind: "tent" }, b = { id: "b", n: 2, kind: "tent" };
  M.set({ type: "all", SEED: [a, b], AVAIL: {}, AVAIL_WINDOW: {},
          HORIZON: { a: { known: true, last: "2027-02-20" },
                     b: { known: true, last: "2026-11-22" } } });
  assert.strictEqual(M.maxArrival(), "2027-02-20",
    "the 90-day site must not shorten the map for the 180-day ones");
});

test("the bound is scoped to the type filter, like the checkout bound", () => {
  const tent  = { id: "t", n: 1, kind: "tent" };
  const lodge = { id: "l", n: 2, kind: "lodging" };
  M.set({ type: "all", SEED: [tent, lodge], AVAIL: {}, AVAIL_WINDOW: {},
          HORIZON: { t: { known: true, last: "2026-10-01" },
                     l: { known: true, last: "2027-02-20" } } });
  M.set({ type: "tent" });
  assert.strictEqual(M.maxArrival(), "2026-10-01",
    "filtering to tents must not keep offering the lodging unit's dates");
});

test("one site with an unknown horizon does not shorten the sites that know theirs", () => {
  // The real mixed case: a park with both nightly and hourly campsites. The
  // hourly one answers on the 30-day feed and can say nothing about a window;
  // letting that pull the bound back to 30 days would throw away the 180 days
  // its nightly neighbours DID report.
  const nightly = { id: "n", n: 1, kind: "tent" };
  const hourly  = { id: "h", n: 2, kind: "tent" };
  M.set({ type: "all", SEED: [nightly, hourly], AVAIL: {}, AVAIL_WINDOW: {},
          HORIZON: { n: { known: true, last: "2027-02-20" }, h: { known: false } } });
  assert.strictEqual(M.maxArrival(), "2027-02-20");
});

test("no known horizon falls back to the 30-day feed, not to nothing", () => {
  M.set({ type: "all", SEED: [{ id: "a", n: 1, kind: "tent" }], AVAIL: {}, AVAIL_WINDOW: {},
          HORIZON: { a: { known: false } } });
  assert.strictEqual(M.maxArrival(), "2026-09-30", "TODAY + 29 — the old behaviour");
});

console.log(`\n${passed}/${passed} passing`);
