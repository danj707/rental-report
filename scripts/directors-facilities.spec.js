// Spec for the Director's Report's Outdoor Spaces & Fields sections.
//
// WHY THIS EXISTS. These two sections slice the SAME facility feed (card 17294)
// that the Facilities hub's Outdoor Events and Fields tabs read, so the two
// surfaces report the same quarter's hours to the same reader — a director
// looking at the quarterly PDF and a manager looking at the tab. If the hour
// rules drift apart, one of them is wrong and nothing says which.
//
// So this pins the server's rules to the client's, by lifting BOTH and requiring
// they agree on the same fixture:
//
//   1. A multi-day booking has NO per-day hours. Card 17294 prints Begin on a
//      booking's first day and End on its last, so a multi-day row carries at
//      most one of them. Those rows are excluded from every hour figure rather
//      than divided into a guess — the tempting "repair" (defaulting a missing
//      End to end-of-day) invents a ten-hour booking out of a day boundary.
//   2. A booking is counted once, on its ARRIVAL row, or a week of a recurring
//      rental counts as five bookings.
//   3. The peak hour counts hours COVERED, not hours started. An 11am-4pm
//      shelter rental fills five hours; start-times-only reports the hour the
//      paperwork begins, which is a different question with a different answer.
//   4. Field lights come from add-on NAMES, not the lighting integration
//      (reservation_lighting_schedule has 5 field rows platform-wide).
//
// Run: node scripts/directors-facilities.spec.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const pageSrc = fs.readFileSync(path.join(ROOT, "public", "facilities.html"), "utf8");
const drSrc = fs.readFileSync(path.join(ROOT, "public", "directors-report.html"), "utf8");

// ── Lift the server's aggregators ──────────────────────────────────────────
const S_START = "const DIR_OUTDOOR_TYPES =";
const S_END = "function dirCourt(rows, days) {";
const a = serverSrc.indexOf(S_START), b = serverSrc.indexOf(S_END);
assert.ok(a > 0, "server.js should declare DIR_OUTDOOR_TYPES");
assert.ok(b > a, "the site-slice helpers should sit above dirCourt()");
const srv = { console };
vm.createContext(srv);
vm.runInContext(serverSrc.slice(a, b) +
  "\n;this.dirOutdoor = dirOutdoor; this.dirFields = dirFields; this.dirRowHours = dirRowHours;" +
  "this.dirIsArrival = dirIsArrival; this.dirIsMulti = dirIsMulti; this.dirClockMin = dirClockMin;" +
  "this.dirAddOnNames = dirAddOnNames; this.DIR_OUTDOOR_TYPES = DIR_OUTDOOR_TYPES;", srv);

// ── Lift the CLIENT's hour helpers, the ones the tabs actually use ─────────
const C_START = "const OUTDOOR_TYPES =";
const C_END = "const OE_LEGEND";
const c0 = pageSrc.indexOf(C_START);
let c1 = pageSrc.indexOf(C_END, c0);
if (c1 < 0) c1 = pageSrc.indexOf("function OutdoorEventsView", c0);
assert.ok(c0 > 0 && c1 > c0, "facilities.html should declare the outdoor hour helpers at module scope");
const cli = { console };
vm.createContext(cli);
// The slice now runs past VERT_CONFIG, which reads the org's injected aquatics
// settings. Those are declared ABOVE this slice, so they are supplied here — the
// same shape as the `alertEnabled` reference that once made email-slack-notify
// throw before asserting anything. This spec is about the HOUR helpers; the
// aquatics scope has its own (aquatics-scope.spec.js).
vm.runInContext("var AQ_SCOPE = [];\n" + pageSrc.slice(c0, c1) +
  "\n;this.oeRowHours = oeRowHours; this.oeIsArrival = oeIsArrival; this.oeIsMulti = oeIsMulti;" +
  "this.oeClockMin = oeClockMin; this.OUTDOOR_TYPES = OUTDOOR_TYPES;", cli);

let n = 0;
const is = (x, y, what) => { n++; assert.strictEqual(x, y, what); };
const ok = (cond, what) => { n++; assert.ok(cond, what); };

// ── Fixture: one park, three outdoor spaces and two fields ────────────────
// Hours are deliberately hand-checkable.
const row = (o) => Object.assign({
  "Site Type": "field", "Facility": "Field 1", "Location": "Community Park",
  "Date": "2026-07-06", "Begin": "05:00pm", "End": "08:00pm",
  "Multi-Day Day#": 1, "Multi-Day Days": 1,
  "Booking Type": "managed", "Total": 100, "Add-On Fees": 0, "Add Ons": "",
  "Status": "Confirmed",
}, o);

const rows = [
  // Fields: 3h + 2h evening blocks, one with a light fee, one instant-booked.
  row({ "Facility": "Field 1", "Begin": "05:00pm", "End": "08:00pm", "Add Ons": "Field Light Fee ($25.00)", "Add-On Fees": 25 }),
  row({ "Facility": "Field 1", "Begin": "06:00pm", "End": "08:00pm", "Add Ons": "Field Lights ($30.00), Attendant ($40.00)", "Add-On Fees": 70 }),
  row({ "Facility": "Field 2", "Begin": "09:00am", "End": "11:00am", "Booking Type": "instant", "Total": 60 }),
  // A three-day tournament on Field 2: only the arrival row is a booking, and
  // NONE of the three days may contribute hours. Card 17294 repeats the
  // booking's Total on EVERY day of the run — which is why the arrival guard
  // exists at all, and why the rows below carry it three times over.
  row({ "Facility": "Field 2", "Date": "2026-07-10", "Begin": "08:00am", "End": null, "Multi-Day Day#": 1, "Multi-Day Days": 3, "Total": 900, "Add Ons": "Field Light Fee ($25.00)" }),
  row({ "Facility": "Field 2", "Date": "2026-07-11", "Begin": null, "End": null, "Multi-Day Day#": 2, "Multi-Day Days": 3, "Total": 900, "Add Ons": "Field Light Fee ($25.00)" }),
  row({ "Facility": "Field 2", "Date": "2026-07-12", "Begin": null, "End": "06:00pm", "Multi-Day Day#": 3, "Multi-Day Days": 3, "Total": 900, "Add Ons": "Field Light Fee ($25.00)" }),
  // Outdoor: an 11am-4pm shelter rental (5h) and two that only touch 11am
  // briefly, so COVERAGE peaks at 11am while start times peak at 10am.
  row({ "Site Type": "outdoor-event-space", "Facility": "Oak Pavilion", "Begin": "11:00am", "End": "04:00pm", "Total": 150, "Add Ons": "Alcohol Permit ($25.00)", "Add-On Fees": 25 }),
  row({ "Site Type": "outdoor-event-space", "Facility": "Oak Pavilion", "Date": "2026-07-07", "Begin": "10:00am", "End": "12:00pm", "Total": 80 }),
  row({ "Site Type": "picnic-table", "Facility": "Picnic Area A", "Date": "2026-07-07", "Begin": "10:00am", "End": "12:00pm", "Total": 40 }),
  row({ "Site Type": "bounce-house", "Facility": "Bounce 1", "Date": "2026-07-08", "Begin": "12:00pm", "End": "03:00pm", "Total": 200 }),
  // A campsite, which belongs to neither slice and must not leak into either.
  row({ "Site Type": "campsite", "Facility": "Site 12", "Begin": "01:00pm", "End": null, "Multi-Day Days": 2, "Total": 90 }),
];

// ── 1. The server's per-row hours ARE the client's ────────────────────────
for (const r of rows) {
  const s = srv.dirRowHours(r), c = cli.oeRowHours(r);
  is(s, c, `dirRowHours must agree with oeRowHours on ${r["Facility"]} ${r["Date"]} (${r["Begin"]}-${r["End"]})`);
}
is(srv.dirRowHours(rows[0]), 3, "5pm-8pm is three hours");
is(srv.dirRowHours(rows[3]), null, "a multi-day arrival has no per-day hours");
is(srv.dirRowHours(rows[5]), null, "...and neither does its final day, which carries only an End");
is(srv.dirIsArrival(rows[4]), false, "day 2 of a run is not an arrival");
is(srv.dirIsMulti(rows[3]), true, "3 total days is multi-day");
is(srv.DIR_OUTDOOR_TYPES.join(","), cli.OUTDOOR_TYPES.join(","),
   "the server and the tab must scope outdoor spaces to the same three site types");

// ── 2. Fields ─────────────────────────────────────────────────────────────
const f = srv.dirFields(rows);
ok(f, "the fields slice should exist");
is(f.bookings, 4, "four field bookings: three same-day plus one tournament arrival");
is(f.hours, 7, "7 hours: 3 + 2 + 2, and NOTHING from the three-day tournament");
is(f.timed, 3, "three bookings carry usable hours");
is(f.multiDay, 3, "all three tournament rows are flagged multi-day");
is(f.avgBlock, 2.3, "average block is over the timed bookings only");
is(f.sites, 2, "two distinct fields");
is(f.revenue, 1160, "revenue counts arrival rows only (100+100+60+900)");
is(f.managedPct, 75, "three of four field bookings are staff-booked");
is(f.lights.bookings, 3, "three bookings carry a light fee, read from the add-on name — the tournament's counts ONCE, on its arrival row");
is(f.lights.pct, 75, "...three of the four");
is(f.prep.bookings, 1, "the attendant is staffing, not lighting");
is(f.eveningPct, 50, "two of four field bookings with a start time begin after 5pm");
is(f.topSites[0].name, "Field 1", "Field 1 has the most hours");
is(f.topSites[0].hours, 5, "3h + 2h");
// Field 2 has 2 timed hours but four days used; ranking by hours with days as
// the tiebreak keeps a tournament field from sinking below a field nobody used.
is(f.topSites[1].name, "Field 2", "Field 2 is second");
is(f.topSites[1].days, 4, "one same-day booking plus three tournament days");
is(f.topAddOns[0].n, 2, "the light fee is on two BOOKINGS — the tournament contributes one, not three");
ok(f.topAddOns.some(x => x.name === "Field Light Fee"), "the light fee keeps its own name");
ok(f.topAddOns.every(x => !/\$/.test(x.name)), "the listed price is stripped from the add-on name");

// ── 3. Outdoor spaces, and the coverage rule ──────────────────────────────
const o = srv.dirOutdoor(rows);
ok(o, "the outdoor slice should exist");
is(o.bookings, 4, "four outdoor bookings across the three types");
is(o.hours, 12, "5 + 2 + 2 + 3");
is(o.sites, 3, "three distinct spaces — Oak Pavilion is booked twice");
is(o.types.length, 3, "all three outdoor types are present");
// THE COVERAGE RULE. Starts: 11am×1, 10am×2, 12pm×1 → start-times-only peaks at
// 10am. Coverage: 11am is covered by the 11-4 rental AND both 10-12 rentals = 3,
// while 10am is covered by 2. So the peak is 11am, and this assertion is what
// fails if the server ever counts starts instead.
is(o.peakHour, "11am", "the busiest hour must come from hours COVERED, not hours started");
is(o.peakBookings, 3, "three bookings cover 11am");
is(o.revenue, 470, "150 + 80 + 40 + 200");
is(o.addOnFees, 25, "the alcohol permit");

// ── 4. Neither slice may leak the other, or camping ───────────────────────
ok(!f.topSites.some(s => /Pavilion|Picnic|Bounce|Site 12/.test(s.name)),
   "the fields slice must not contain outdoor spaces or campsites");
ok(!o.topSites.some(s => /^Field/.test(s.name) || s.name === "Site 12"),
   "the outdoor slice must not contain fields or campsites");
is(srv.dirFields(rows.filter(r => r["Site Type"] !== "field")), null,
   "no fields in the feed means no section rather than an empty one");
is(srv.dirOutdoor([]), null, "an empty feed yields no section");
is(srv.dirOutdoor(null), null, "and neither does a failed fetch");

// ── 5. Wiring ─────────────────────────────────────────────────────────────
ok(/outdoor: dirOutdoor\(facC\)/.test(serverSrc),
   "the quarter payload should slice the facility feed it already fetched");
ok(/fields: dirFields\(facC\)/.test(serverSrc), "same for fields");
ok(!/fetchMBDirect\(slug, "facilities"/.test(serverSrc),
   "these sections must not add a Metabase fetch — the rows are already in hand");
ok(/data-dr-outdoor/.test(drSrc) && /data-dr-fields/.test(drSrc),
   "the report page should render both panels");
ok(/d\.outdoor && /.test(drSrc) && /d\.fields && /.test(drSrc),
   "each panel must be conditional: most orgs book one and not the other, and a " +
   "snapshot taken before this shipped has neither key");
ok(/hours covered, not started/.test(drSrc),
   "the panel should say which peak-hour rule it used — the number is meaningless without it");
ok(/the norm for fields/.test(drSrc),
   "a low instant share on fields is the baseline and the panel has to say so");

console.log("✓ directors-facilities.spec.js — " + n + " assertions");
