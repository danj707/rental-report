// Spec for the Outdoor Events tab's hour math.
//
// The tab covers pavilions, shelters, picnic areas and bounce houses, which are
// rented BY THE HOUR (or by the day) — never nightly like campsites. Every
// number on it is therefore built on two derivations, both of which are silent
// when wrong:
//
//   1. oeRowHours — card 17294 prints "Begin" on a booking's FIRST day and
//      "End" on its LAST. A same-day booking carries both; a MULTI-DAY booking
//      carries neither on any single day. Treating a multi-day row's Begin as
//      "start" and End as "end" would invent hours out of a day boundary, and
//      the page would look completely normal while doing it.
//
//   2. oeHeatGrid — the day-part grid counts a booking in every hour it COVERS,
//      not the hour it starts. Start-times-only produces a grid that still
//      renders, still has a peak, and answers a different question: 8am, when
//      the paperwork begins, instead of late morning, when the shelters are
//      actually full.
//
// Both live at module scope in public/facilities.html precisely so this file can
// lift them without mounting the tab.
//
// Run: node scripts/outdoor-hours.spec.js
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PAGE = path.join(__dirname, "..", "public", "facilities.html");
const src = fs.readFileSync(PAGE, "utf8");

// Slice the module-scope block that holds the whole outdoor-events hour module,
// from the type list down to the end of oeHeatGrid, and evaluate just that. The
// page builds a React tree at module scope, so the file as a whole cannot run.
const start = src.indexOf("const OUTDOOR_TYPES = [");
assert.ok(start > 0, "public/facilities.html should declare OUTDOOR_TYPES");
const endMarker = "\n    const HIGH_CANCEL";
const end = src.indexOf(endMarker, start);
assert.ok(end > start, "could not find the end of the outdoor hour module");

const ctx = { console };
vm.createContext(ctx);
vm.runInContext(src.slice(start, end) + `
  this.OUTDOOR_TYPES = OUTDOOR_TYPES;
  this.oeClockMin = oeClockMin;
  this.oeRowHours = oeRowHours;
  this.oeHeatGrid = oeHeatGrid;
  this.oeShade = oeShade;
  this.oeFmtHrs = oeFmtHrs;
  this.oeHour12 = oeHour12;
  this.OE_RAMP = OE_RAMP;
  this.OE_MULTI = OE_MULTI;
`, ctx);
const { OUTDOOR_TYPES, oeClockMin, oeRowHours, oeHeatGrid, oeShade, oeFmtHrs, oeHour12, OE_RAMP, OE_MULTI } = ctx;

let passed = 0;
function test(name, fn) { fn(); console.log(`  ✓ ${name}`); passed++; }

// A row as card 17294 emits it. `days`/`num` are the multi-day pair.
const row = (begin, end, num, days, date) => ({
  Begin: begin, End: end, Date: date || "2026-08-15",
  "Multi-Day Day#": num == null ? 1 : num, "Multi-Day Days": days == null ? 1 : days,
});

// ── scope ───────────────────────────────────────────────────────────────────

test("the tab covers Rec's three outdoor types and NOT fields", () => {
  // Compared as a string: the array comes out of a vm context, so it has that
  // realm's Array prototype and deepStrictEqual rejects it on identity alone.
  assert.strictEqual(OUTDOOR_TYPES.slice().sort().join(","),
    "bounce-house,outdoor-event-space,picnic-table");
  assert.ok(OUTDOOR_TYPES.indexOf("field") < 0,
    "fields are a separate segment and a separate tab — folding them in swamps every average");
});

// ── clock parsing ───────────────────────────────────────────────────────────

test("the card's clock format parses to minutes", () => {
  assert.strictEqual(oeClockMin("12:00am"), 0);
  assert.strictEqual(oeClockMin("08:30am"), 510);
  assert.strictEqual(oeClockMin("12:00pm"), 720, "noon is 12pm, not midnight + 12");
  assert.strictEqual(oeClockMin("01:00pm"), 780);
  assert.strictEqual(oeClockMin("11:59pm"), 1439);
});

test("a missing or unparseable time is null, not NaN", () => {
  [null, undefined, "", "   ", "later", "25:00xx"].forEach(v => {
    assert.strictEqual(oeClockMin(v), null, JSON.stringify(v) + " should be null");
  });
});

// ── hours on a row ──────────────────────────────────────────────────────────

test("a same-day booking's hours are end minus begin", () => {
  assert.strictEqual(oeRowHours(row("10:00am", "02:00pm")), 4);
  assert.strictEqual(oeRowHours(row("11:00am", "01:30pm")), 2.5);
});

test("an evening block that ends after midnight is not negative", () => {
  assert.strictEqual(oeRowHours(row("10:00pm", "01:00am")), 3,
    "a 10pm–1am rental is three hours, not minus twenty-one");
});

test("an all-day booking comes out as a whole day, not a rounding artifact", () => {
  const h = oeRowHours(row("12:00am", "11:59pm"));
  assert.ok(h > 23.9 && h <= 24, "expected ~24h, got " + h);
});

test("a MULTI-DAY row yields no hours, even carrying both times", () => {
  // Card 17294 as it stands cannot put both times on one multi-day row (Begin
  // lands on the first day, End on the last), so this first case is defensive:
  // it pins the rule against a card edit that starts filling both. The two
  // reachable cases below are the ones today's data actually produces — and the
  // temptation there is to "repair" the missing half with a default, which is
  // how a day boundary turns into a ten-hour booking that never happened.
  assert.strictEqual(oeRowHours(row("08:00am", "06:00pm", 1, 2)), null);
  assert.strictEqual(oeRowHours(row("08:00am", null, 1, 2)), null);
  assert.strictEqual(oeRowHours(row(null, "06:00pm", 2, 2)), null);
});

test("a same-day row missing either end is null rather than half a booking", () => {
  assert.strictEqual(oeRowHours(row("08:00am", null)), null);
  assert.strictEqual(oeRowHours(row(null, "06:00pm")), null);
});

// ── the day-part grid ───────────────────────────────────────────────────────
//
// Four overlapping same-day bookings on the SAME weekday plus one multi-day
// pair. Coverage totals: 8am 1, 9am 2, 10am 3, 11am 4, noon 3, 1pm 3, 2–4pm 1.

const SAT = "2026-08-15";   // a Saturday
const GRID_ROWS = [
  row("10:00am", "02:00pm", 1, 1, SAT),
  row("08:00am", "12:00pm", 1, 1, SAT),
  row("09:00am", "05:00pm", 1, 1, SAT),
  row("11:00am", "01:00pm", 1, 1, SAT),
  row("08:00am", null,      1, 2, SAT),          // multi-day, must not land
];

test("a booking counts in every hour it covers", () => {
  const g = oeHeatGrid(GRID_ROWS);
  assert.strictEqual(g.hourTotals[8], 1, "8am");
  assert.strictEqual(g.hourTotals[9], 2, "9am");
  assert.strictEqual(g.hourTotals[10], 3, "10am");
  assert.strictEqual(g.hourTotals[11], 4, "11am — the fullest hour");
  assert.strictEqual(g.hourTotals[16], 1, "4pm, the tail of the 9–5 booking");
});

test("the peak hour is when the spaces are FULL, not when bookings start", () => {
  const g = oeHeatGrid(GRID_ROWS);
  assert.strictEqual(g.peak, 11, "coverage peaks at 11am");
  assert.strictEqual(g.peakBookings, 4);
  assert.strictEqual(oeHour12(g.peak), "11a");
  // Every one of these bookings starts at a different hour, so a start-times-only
  // grid ties at 1 and reports the earliest — 8am. That is the regression this
  // assertion exists to fail on.
  assert.notStrictEqual(g.peak, 8);
});

test("multi-day bookings are excluded from the grid, not spread across it", () => {
  const g = oeHeatGrid(GRID_ROWS);
  assert.strictEqual(g.timed, 4, "5 bookings in, 4 with knowable hours");
  const total = g.hourTotals.reduce((a, b) => a + b, 0);
  assert.strictEqual(total, 4 + 4 + 8 + 2, "hours covered = 4 + 4 + 8 + 2");
});

test("the grid lands on the right weekday", () => {
  const g = oeHeatGrid(GRID_ROWS);
  assert.strictEqual(g.heat[6][11], 4, "15 Aug 2026 is a Saturday");
  assert.strictEqual(g.heat[3][11], 0, "and nothing on a Wednesday");
});

test("the displayed hour window is the booked part of the day", () => {
  const g = oeHeatGrid(GRID_ROWS);
  assert.strictEqual(g.hours[0], 8, "starts at the earliest booked hour");
  assert.strictEqual(g.hours[g.hours.length - 1], 16, "ends at the latest");
  assert.strictEqual(g.max, 4, "and scales to the fullest cell");
});

test("no timed bookings shows a plausible day rather than a 24-hour void", () => {
  const g = oeHeatGrid([row("08:00am", null, 1, 2, SAT)]);
  assert.strictEqual(g.timed, 0);
  assert.strictEqual(g.peak, -1, "no peak to claim");
  assert.strictEqual(g.hours[0], 8);
  assert.strictEqual(g.hours[g.hours.length - 1], 20);
});

test("an empty range does not throw", () => {
  const g = oeHeatGrid([]);
  assert.strictEqual(g.timed, 0);
  assert.strictEqual(g.max, 1, "the divisor must never be zero");
});

// ── calendar shading ────────────────────────────────────────────────────────

test("a day booked with unknown hours gets its own colour", () => {
  // Otherwise a multi-day booking — the biggest thing on the calendar — shades
  // like the lightest possible touch of use.
  assert.strictEqual(oeShade({ n: 1, hours: 0 }), OE_MULTI);
  assert.strictEqual(oeShade({ n: 1, hours: 2 }), OE_RAMP[1]);
  assert.strictEqual(oeShade({ n: 1, hours: 12 }), OE_RAMP[5]);
  assert.strictEqual(oeShade(null), OE_RAMP[0], "an open day is the base shade");
  assert.strictEqual(oeShade({ n: 0, hours: 0 }), OE_RAMP[0]);
});

test("a very long day cannot overflow the ramp", () => {
  assert.strictEqual(oeShade({ n: 2, hours: 40 }), OE_RAMP[5]);
});

// ── formatting ──────────────────────────────────────────────────────────────

test("hours read as hours", () => {
  assert.strictEqual(oeFmtHrs(2), "2h");
  assert.strictEqual(oeFmtHrs(2.5), "2.5h");
  assert.strictEqual(oeFmtHrs(11.4), "11h", "past ten, a decimal is noise");
});

// ── and the page must actually use them ─────────────────────────────────────

test("the tab is wired up end to end", () => {
  assert.ok(/OutdoorEventsView/.test(src), "the view exists");
  assert.ok(/tab === 'outdoor'\s*\n?\s*\?\s*e\(OutdoorEventsView/.test(src.replace(/\s+/g, " ").replace(/ /g, " ")) ||
            /e\(OutdoorEventsView, \{ start, end \}\)/.test(src), "and is reachable from the tab dispatch");
  assert.ok(/oeHeatGrid\(arrivals\)/.test(src), "the view builds its grid through the shared helper");
  assert.ok(/'data-oe-peak'/.test(src), "and exposes the peak for the render check");
  assert.ok(/event=outdoor/.test(src), "opening the tab pings the Slack activity feed");
  assert.ok(/game: 'bounce'/.test(src), "the banner carries its minigame");
});

console.log(`\n${passed}/${passed} passing`);
