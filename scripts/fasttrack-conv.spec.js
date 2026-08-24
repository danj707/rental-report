// Spec for the Fast Track conversion metric.
//
// WHY THIS EXISTS. Dan, 2026-08-24, looking at Smyrna's 154th Birthday Concert
// Premier Table three hours after its early-access window opened. Straight from
// the live card:
//
//   FT holds 140 · FT converted 25 · FT pending 115
//   capacity 25  · direct enrolled 0 · total enrolled 25 · fill 100%
//   waitlist 0   · $325 a seat
//
// The section sold out to Fast Track families, with zero organic registrations.
// The report showed "17.9%" in a 🌤️ WARMING band, because conversion was
// converted / holds = 25 / 140.
//
// But 17.9% WAS THE CEILING. With 140 holds chasing 25 seats, conversion could
// never exceed 25/140 however well it went, so the old denominator graded a
// sellout against a target that did not exist. Dan: "If there are only 25 spots,
// and 25 FT conversions, that's 100% FT conversions. That's the number I'd like
// to see."
//
// All four concert tables are capacity-bound the same way, and nothing on screen
// said so: their old ceilings were 17.9%, 31.3%, 75% and 75.8%.
//
// Run: node scripts/fasttrack-conv.spec.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PAGE = path.join(__dirname, "..", "public", "fasttrack.html");
const src = fs.readFileSync(PAGE, "utf8");

// Lift ftConvPct + convExplain + heatBand. The page mounts React at module
// scope, so only this block can be evaluated.
const api = (function () {
  const a = src.indexOf("/* What the conversion figure is measuring");
  const b = src.indexOf("function adminSectionUrl");
  assert.ok(a > 0 && b > a, "could not slice the conversion helpers");
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(src.slice(a, b) + `
    this.ftConvPct = ftConvPct;
    this.convExplain = convExplain;
    this.heatBand = heatBand;
  `, ctx);
  return ctx;
})();
const { ftConvPct, convExplain, heatBand } = api;

let passed = 0;
function test(name, fn) { fn(); console.log(`  ✓ ${name}`); passed++; }

// holds, converted, capacity, direct
const conv = (h, c, cap, d) => ftConvPct(h, c, cap, d);

// ── the reported case ───────────────────────────────────────────────────────

test("a section that sold out to Fast Track reads 100%, not 17.9%", () => {
  assert.strictEqual(conv(140, 25, 25, 0), 100,
    "25 of the 25 seats open to FT went to FT");
  // The old math, for the record — this is the number Dan was shown.
  assert.strictEqual(Math.round(1000 * 25 / 140) / 10, 17.9);
});

test("and it reads HOT, because selling out is not 'warming'", () => {
  assert.strictEqual(heatBand(conv(140, 25, 25, 0)).label, "HOT");
  assert.strictEqual(heatBand(17.9).label, "COOL",
    "the old figure landed a sellout two bands down");
});

test("the other three tables of the same concert are graded on their own ceilings", () => {
  // Live figures, same fetch: all three are pre-launch, so 0 converted — but
  // the DENOMINATOR is what changes, and it is what would mislead the moment
  // they open.
  assert.strictEqual(conv(96, 0, 30, 0), 0);
  assert.strictEqual(conv(96, 30, 30, 0), 100, "Preferred: 30 seats, sold out = 100%");
  assert.strictEqual(conv(60, 45, 45, 0), 100, "Select: 45 seats");
  assert.strictEqual(conv(66, 50, 50, 0), 100, "General: 50 seats");
  // Under the old math these sellouts would have read 31.3%, 75% and 75.8%.
  assert.strictEqual(Math.round(1000 * 30 / 96) / 10, 31.3);
});

// ── the denominator ─────────────────────────────────────────────────────────

test("direct registrations take seats out of what FT could have won", () => {
  // 40 holds, 20 seats, 12 of them already taken by people who registered
  // directly. FT could only ever win 8, and it won all 8.
  assert.strictEqual(conv(40, 8, 20, 12), 100);
  assert.strictEqual(conv(40, 4, 20, 12), 50, "half of the 8 it could win");
});

test("when holds are the binding constraint, holds are the denominator", () => {
  // 10 holds against 100 seats: nothing is capping FT but its own interest.
  assert.strictEqual(conv(10, 5, 100, 0), 50);
  assert.strictEqual(conv(10, 10, 100, 0), 100);
});

test("an uncapped section falls back to holds", () => {
  assert.strictEqual(conv(50, 10, 0, 0), 20, "capacity 0 = no ceiling to measure");
  assert.strictEqual(conv(50, 10, null, 0), 20);
});

test("a section that gave FT no seat at all has no conversion rate", () => {
  // Every seat went to direct registration. 0% would read as an FT failure
  // rather than what it is — a setup that left FT nothing to win.
  assert.strictEqual(conv(40, 0, 20, 20), null);
  assert.strictEqual(conv(40, 0, 20, 25), null, "over-enrolled, same story");
});

test("no holds means no conversion rate, as before", () => {
  assert.strictEqual(conv(0, 0, 30, 0), null);
  assert.strictEqual(conv(null, null, 30, 0), null);
});

test("more conversions than seats we believe existed is clamped, not >100%", () => {
  // A capacity lowered after the fact, or a waitlist promotion.
  assert.strictEqual(conv(40, 30, 25, 0), 100);
});

test("it is monotonic in conversions — more registrations never scores lower", () => {
  let prev = -1;
  for (let c = 0; c <= 25; c++) {
    const v = conv(140, c, 25, 0);
    assert.ok(v >= prev, `conversions ${c} scored ${v} after ${prev}`);
    prev = v;
  }
});

// ── what the page says about it ─────────────────────────────────────────────

test("the tooltip names the denominator, and says demand is not a miss", () => {
  const t = convExplain({ ftSignups: 140, ftConverted: 25, capacity: 25, directEnrolled: 0,
                          convPct: 100, convPctOfHolds: 17.9 });
  assert.ok(/25 of 25 spots/.test(t), t);
  assert.ok(/140 families held for 25 spots/.test(t), t);
  assert.ok(/Demand/.test(t), "over-capacity demand belongs to the Demand figure: " + t);
});

test("when holds bind, the tooltip does not invent a capacity story", () => {
  const t = convExplain({ ftSignups: 10, ftConverted: 5, capacity: 100, directEnrolled: 0,
                          convPct: 50, convPctOfHolds: 50 });
  assert.ok(/5 of 10 spots/.test(t), t);
  assert.ok(!/families held for/.test(t), "nothing was capped, so say nothing about it: " + t);
});

test("a section with no seats for FT explains itself", () => {
  const t = convExplain({ ftSignups: 40, ftConverted: 0, capacity: 20, directEnrolled: 20,
                          convPct: null, convPctOfHolds: 0 });
  assert.ok(/No spots were available to Fast Track/.test(t), t);
});

// ── and the page must be using it ──────────────────────────────────────────

test("every conversion figure on the page comes from the helper", () => {
  assert.ok(/convPct:\s+ftConvPct\(/.test(src), "the section mapper");
  assert.ok(/g\.convPct\s+=\s+ftConvPct\(/.test(src), "the program rollup");
  // The card's own holds-based column is kept, but only as the tooltip's aside.
  assert.ok(/convPctOfHolds/.test(src), "the raw figure is kept for context");
  const rawUse = src.match(/convPct:\s+raw\['Conversion %'\]/);
  assert.strictEqual(rawUse, null, "the card's holds-based figure must not be convPct any more");
});

test("the export column says which denominator it used", () => {
  assert.ok(/Conversion % \(of FT-available spots\)/.test(src),
    "a bare 'Conversion %' in a spreadsheet reads as a share of all holds");
});

console.log(`\n${passed}/${passed} passing`);
