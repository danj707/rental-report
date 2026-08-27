// Spec for the Launching Soon heat scale.
//
// Heat used to be the clock alone: `days <= 1 ? red : days <= 3 ? orange : …`.
// So a program with 3 wishlists for 400 spots opening in 29 days got the same
// flame treatment as one 76% fast-tracked opening tomorrow, and the panel had no
// way to say which of those was a problem.
//
// The balance, per Dan (2026-08-24): "it's a balance of total fast tracked,
// soonest opening, but the majority share is % of capacity already fast
// tracked." So the score is weighted 60 / 20 / 20 — capacity share, volume,
// urgency — and the property that matters is that capacity share KEEPS the
// majority. Volume is the one most likely to break that: a very large headcount
// against a very large capacity is not a hot launch, and a log scale plus a
// 20-point ceiling is what stops it from reading as one.
//
// The two real cases this was built from:
//   Concert Series    76% of capacity, 114 fast-tracked, opens tomorrow  -> inferno
//   Girls Night Out    1% of capacity,   3 fast-tracked, opens in 29 days -> banked
//
// Run: node scripts/fasttrack-heat.spec.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PAGE = path.join(__dirname, "..", "public", "fasttrack.html");
const src = fs.readFileSync(PAGE, "utf8");

// Lift the real scale out of the page — the page mounts React at module scope,
// so only this block can be evaluated.
const api = (function () {
  const a = src.indexOf("var HEAT_WEIGHTS");
  const b = src.indexOf('/* ── "Launching Soon" pipeline card');
  assert.ok(a > 0 && b > a, "could not slice the heat block out of fasttrack.html");
  const ctx = { Math, Object, console };
  vm.createContext(ctx);
  vm.runInContext(src.slice(a, b) +
    "\nthis.launchHeat = launchHeat; this.launchScore = launchScore;" +
    "\nthis.HEAT_WEIGHTS = HEAT_WEIGHTS; this.HEAT_TIERS = HEAT_TIERS;", ctx);
  return ctx;
})();
const { launchHeat, launchScore, HEAT_WEIGHTS, HEAT_TIERS } = api;

let passed = 0;
function test(name, fn) { fn(); console.log(`  ✓ ${name}`); passed++; }

// ── the two cases it was built from ─────────────────────────────────────────

test("Concert Series — 76% of capacity, 114 waiting, opens tomorrow — is inferno", () => {
  const h = launchHeat(76, 1, 114);
  assert.strictEqual(h.name, "inferno");
  assert.ok(h.blaze && h.pulse, "the top tier should move");
  assert.ok(h.flames.length > 0, "and carry flames");
});

test("Girls Night Out — 1% of capacity, 3 waiting, 29 days out — is banked and silent", () => {
  const h = launchHeat(1, 29, 3);
  assert.strictEqual(h.name, "banked");
  assert.strictEqual(h.flames, "", "the quiet end carries no flame at all");
  assert.strictEqual(h.blaze, false, "and does not move");
  assert.strictEqual(h.pulse, false);
  assert.strictEqual(h.tint, "00", "and gets no ground tint");
  assert.strictEqual(h.shadow, "none");
  assert.ok(h.rail <= 2, "hairline rail, not a slab");
});

// ── capacity share must keep the majority ───────────────────────────────────

test("the weights are 60/20/20 and sum to 100", () => {
  assert.strictEqual(HEAT_WEIGHTS.capacity, 60);
  assert.strictEqual(HEAT_WEIGHTS.volume, 20);
  assert.strictEqual(HEAT_WEIGHTS.urgency, 20);
  assert.strictEqual(HEAT_WEIGHTS.capacity + HEAT_WEIGHTS.volume + HEAT_WEIGHTS.urgency, 100);
  assert.ok(HEAT_WEIGHTS.capacity > HEAT_WEIGHTS.volume + HEAT_WEIGHTS.urgency,
    "capacity share must outweigh the other two COMBINED, or it is not the majority");
});

test("a huge headcount against a huge capacity is not an inferno", () => {
  // 500 people waiting, but only 5% of the spots are taken. Volume is the term
  // most likely to hijack the scale; it must not.
  const h = launchHeat(5, 6, 500);
  assert.notStrictEqual(h.name, "inferno");
  assert.notStrictEqual(h.name, "blazing");
  assert.ok(launchScore(5, 6, 500) < launchScore(76, 1, 114),
    "500 people with room to spare is cooler than 114 people nearly filling up");
});

test("volume cannot beat capacity share at matched urgency", () => {
  // Same day, same everything except the trade: near-full-and-small vs
  // empty-and-enormous. Capacity share has to win.
  assert.ok(launchScore(95, 5, 19) > launchScore(4, 5, 5000),
    "95% full must outrank a 4%-full launch no matter how many people are in it");
});

test("at equal volume and urgency, more capacity share is always hotter", () => {
  let prev = -1;
  for (const pct of [0, 5, 10, 25, 40, 60, 75, 90, 99]) {
    const sc = launchScore(pct, 5, 30);
    assert.ok(sc > prev, `score must rise with capacity share (${pct}%)`);
    prev = sc;
  }
});

// ── monotonic in the other two, so the scale can't invert ───────────────────

test("sooner is hotter, all else equal", () => {
  let prev = Infinity;
  for (const d of [0, 1, 3, 7, 14, 21, 30, 45]) {
    const sc = launchScore(50, d, 40);
    assert.ok(sc <= prev, `score must not rise as the opening gets further away (d=${d})`);
    prev = sc;
  }
});

test("volume keeps discriminating at the scale we actually see", () => {
  // The ceiling stops volume outranking capacity share; it must not do that by
  // saturating so early that every real launch looks identical. A 114-person
  // launch and a 400-person one are not the same launch.
  assert.ok(launchScore(50, 5, 400) > launchScore(50, 5, 114),
    "400 waiting must score above 114 waiting");
  assert.ok(launchScore(50, 5, 114) > launchScore(50, 5, 30),
    "and 114 above 30");
});

test("more people is hotter, all else equal", () => {
  let prev = -1;
  for (const ft of [0, 1, 5, 20, 60, 150, 400]) {
    const sc = launchScore(50, 5, ft);
    assert.ok(sc >= prev, `score must not fall as headcount rises (ft=${ft})`);
    prev = sc;
  }
});

test("beyond the horizon urgency stops contributing, it does not go negative", () => {
  assert.strictEqual(launchScore(0, 30, 0), launchScore(0, 365, 0),
    "a launch 30 days out and one a year out are equally un-urgent, not differently so");
  assert.ok(launchScore(0, 999, 0) >= 0, "score must never go negative");
});

// ── the override ────────────────────────────────────────────────────────────

test("oversubscribed before it opens is always the top tier", () => {
  // Even a long way out: every spot is gone and registration has not opened.
  assert.strictEqual(launchHeat(100, 25, 10).name, "inferno");
  assert.strictEqual(launchHeat(340, 60, 34).name, "inferno");
  assert.strictEqual(launchHeat(100, 0, 1).name, "inferno");
});

// ── shape of the scale ──────────────────────────────────────────────────────

test("five tiers, ascending, each louder than the last", () => {
  assert.strictEqual(HEAT_TIERS.length, 5);
  for (let i = 1; i < HEAT_TIERS.length; i++) {
    const lo = HEAT_TIERS[i - 1], hi = HEAT_TIERS[i];
    assert.ok(hi.min > lo.min, "thresholds ascend");
    assert.ok(hi.rail >= lo.rail, "rail gets no thinner");
    assert.ok(hi.numSize >= lo.numSize, "the number gets no smaller");
    assert.ok(hi.flames.length >= lo.flames.length, "flames never decrease");
  }
});

test("only the top of the scale moves", () => {
  const moving = HEAT_TIERS.filter(t => t.blaze);
  assert.strictEqual(moving.length, 1, "exactly one tier blazes, or the top has no top");
  assert.strictEqual(moving[0].name, "inferno");
  assert.ok(HEAT_TIERS.filter(t => t.pulse).length <= 2, "at most the two hottest pulse");
});

test("missing inputs degrade to cold rather than throwing", () => {
  [[null, null, null], [undefined, undefined, undefined], [0, 0, 0]].forEach(args => {
    const h = launchHeat.apply(null, args);
    assert.ok(h && typeof h.name === "string", "must always return a tier");
  });
  assert.strictEqual(launchHeat(null, null, null).name, "banked",
    "no data is not a reason to set the card on fire");
});

// ── the page must actually use it ───────────────────────────────────────────

test("every visual cue on the card reads from the tier, not from the clock", () => {
  // The old code branched on days inline in four places. If any of that comes
  // back, the scale stops being the single source of the card's intensity.
  assert.ok(/var heat = launchHeat\(pct, d, ft\)/.test(src), "the card computes a tier");
  assert.ok(/'data-heat': heat\.name/.test(src), "and exposes it for the render check");
  assert.ok(/heat\.rail \+ 'px solid ' \+ accent/.test(src), "rail weight from the tier");
  assert.ok(/heat\.blaze \? 'ft-blaze'/.test(src), "animation from the tier");
  assert.ok(/heat\.flameCount/.test(src), "flame COUNT from the tier");
  assert.ok(!/d != null && d <= 1\) \? '#dc2626'/.test(src),
    "the old clock-only accent ladder must be gone");
});

test("reduced motion is honoured", () => {
  assert.ok(/prefers-reduced-motion/.test(src) && /\.ft-blaze/.test(src),
    "a report someone prints or reads with motion off still needs to be readable");
  // The flames move too, so they have to stop as well — an emoji dancing under
  // prefers-reduced-motion is exactly what that setting exists to prevent.
  assert.ok(/\.ft-flame \{ animation: none/.test(src.replace(/\s+/g, " ")) ||
            /ft-ember, \.ft-flame \{ animation: none/.test(src),
    "the flicker must stop under prefers-reduced-motion");
});

// ── the flames actually burn ────────────────────────────────────────────────

test("each flame flickers on its own clock, anchored at its base", () => {
  // Same-phase flames read as one object flashing rather than as fire, so each
  // position gets its own duration and a NEGATIVE delay (which also means they
  // are mid-flicker on first paint instead of all starting together).
  assert.ok(/@keyframes ftFlicker/.test(src), "there should be a flicker keyframe");
  assert.ok(/transform-origin: 50% 92%/.test(src),
    "a flame pinned at its centre wobbles like a balloon — the origin is its base");
  const delays = src.match(/\.ft-flame:nth-child\(\d\) \{[^}]*animation-delay: (-[\d.]+)s/g) || [];
  assert.ok(delays.length >= 3, "at least three flame positions should be individually timed");
  const durs = (src.match(/\.ft-flame:nth-child\(\d\) \{[^}]*animation-duration: ([\d.]+)s/g) || [])
    .map(x => /animation-duration: ([\d.]+)s/.exec(x)[1]);
  // The BASE .ft-flame duration is flame #1's, so it belongs in the set too —
  // an nth-child that matches it collides with the first flame, not with a
  // sibling, and checking only the nth-child rules misses exactly that.
  const base = /animation: ftFlicker ([\d.]+)s/.exec(src);
  assert.ok(base, "the base .ft-flame rule should set a flicker duration");
  const all = [base[1]].concat(durs);
  assert.ok(all.length >= 4, "at least four flame positions should be individually timed");
  assert.strictEqual(new Set(all).size, all.length,
    "two flames sharing a duration drift back into sync — every one must differ, flame #1 included");
});

test("the flames are rendered as spans, not as one string", () => {
  assert.ok(/function FlameRow\(props\)/.test(src), "there should be a FlameRow renderer");
  assert.ok(/className: 'ft-flame'/.test(src), "each flame needs its own class to animate");
  assert.ok(/'aria-hidden': 'true'/.test(src),
    "a screen reader reading 'fire fire fire fire' is noise — the words beside it carry the meaning");
});

test("the heat haze is reserved for the top tier", () => {
  // If everything glows, the glow stops meaning oversubscribed.
  assert.ok(/blazing: heat\.tier >= 4/.test(src),
    "the countdown pill should only haze at the top tier");
  assert.ok(/\.ft-flames\.blazing::before/.test(src), "the haze should be a blazing-only pseudo-element");
});

test("the oversubscribed sentence carries live flames", () => {
  // This is the line Dan pointed at: it had a single static emoji on it.
  assert.ok(/FlameRow, \{ n: 3, blazing: true/.test(src),
    "the 'oversubscribed before it opens' line should carry a burning row");
});

console.log(`\n${passed}/${passed} passing`);
