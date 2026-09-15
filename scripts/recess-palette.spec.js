#!/usr/bin/env node
/* ── Guards for the Recess token layer ─────────────────────────────────
   public/recess-tokens.css carries the design tokens read out of the
   rec-web Storybook bundle. programs.html is the first page on it.

   WHAT THIS IS REALLY GUARDING, in one line each:

   1. THE TWO PALETTE COPIES CANNOT DRIFT. The categorical order lives in
      the CSS as --rec-cat-1..8 and in programs.html as RECESS_CAT, because
      those charts set fill from script. Two copies of a list is how one
      surface starts drawing a different colour from the one beside it —
      the defect this file exists to stop, recorded for siteLabel and for
      the date-intent resolver before it.

   2. THE RESERVED FOUR STAY RESERVED. info / success / warning / danger
      mean info, good, warning and bad. A categorical series painted one of
      them is what stops that colour being able to mean anything, and it is
      exactly what all four of the palettes replaced here used to do.

   3. THE ORDER IS MEASURED, NOT AESTHETIC. Through the colour-vision
      validator the worst ADJACENT pair of this ordering is deutan ΔE 8.8,
      which passes. Other orderings of the same eight colours do NOT:
      lime-700 beside pink-700 lands at 6.8, and pink-700 beside pink-500
      fails the normal-vision floor outright at 13.6. So the order is
      pinned as a literal here. Re-run the validator before changing it;
      do not reorder by eye.

   4. ONE HEADER. .report-header renders only under isPrint, because on
      screen the banner is the header. Both rendering is how the page came
      to say "<Org> · Programs" twice in the first 200px.

   Run: node scripts/recess-palette.spec.js
   ────────────────────────────────────────────────────────────────────── */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(ROOT, "public/recess-tokens.css"), "utf8");
const prog = fs.readFileSync(path.join(ROOT, "public/programs.html"), "utf8");

let passed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) passed++;
  else failures.push(msg);
}

/* The measured order. Changing this literal means re-running
   scripts/validate_palette.js (dataviz skill) and recording the new worst
   adjacent ΔE in the comment above — not just editing the array. */
const EXPECTED = ["#a855f7", "#0ea5e9", "#84cc16", "#ec4899",
                  "#7e22ce", "#4d7c0f", "#0369a1", "#be185d"];

/* Reserved semantic colours, from the same token file. A categorical slot
   holding one of these is the bug in guard 2. */
const RESERVED = { "#2563eb": "info", "#16a34a": "success",
                   "#ea580c": "warning", "#dc2626": "danger" };

// ── 1. the token file declares the palette, in order ───────────────────
const cssCat = [];
for (let i = 1; i <= 8; i++) {
  const m = css.match(new RegExp("--rec-cat-" + i + ":\\s*(#[0-9a-fA-F]{6})"));
  cssCat.push(m ? m[1].toLowerCase() : null);
}
ok(cssCat.every(Boolean), "recess-tokens.css is missing one of --rec-cat-1..8");
ok(JSON.stringify(cssCat) === JSON.stringify(EXPECTED),
   "--rec-cat-1..8 is not the measured order — got " + JSON.stringify(cssCat) +
   ", expected " + JSON.stringify(EXPECTED) + " (re-run the colour-vision validator)");

// the surface/ink tokens a page cannot be migrated without
["--rec-bg-primary", "--rec-text-primary", "--rec-text-secondary",
 "--rec-border-secondary", "--rec-brand-sand", "--rec-brand-pine",
 "--rec-brand-grass", "--rec-radius-lg", "--rec-shadow-surface-md"
].forEach(t => ok(css.includes(t + ":"), "recess-tokens.css does not declare " + t));

// ── 2. programs.html links it, and its JS copy cannot drift ────────────
ok(/<link[^>]+href="\/recess-tokens\.css"/.test(prog),
   "programs.html does not link /recess-tokens.css — the tokens resolve to nothing " +
   "and every var() silently falls back");

const jsm = prog.match(/var RECESS_CAT = \[([^\]]+)\];/);
ok(!!jsm, "programs.html has no RECESS_CAT array");
const jsCat = jsm ? jsm[1].split(",").map(x => x.trim().replace(/'/g, "").toLowerCase()) : [];
ok(JSON.stringify(jsCat) === JSON.stringify(cssCat),
   "RECESS_CAT in programs.html has DRIFTED from --rec-cat-1..8 in recess-tokens.css — " +
   "js " + JSON.stringify(jsCat) + " vs css " + JSON.stringify(cssCat));

// ── 3. the reserved four are not in the categorical order ──────────────
jsCat.forEach((hex, i) => {
  ok(!RESERVED[hex],
     "RECESS_CAT slot " + (i + 1) + " is " + hex + ", which is the reserved " +
     RESERVED[hex] + " colour — a series painted it stops it meaning " + RESERVED[hex]);
});

// ── 4. every chart on the page reads that one list ─────────────────────
[["COHORT_COLORS", "the retention cohort chart"],
 ["barColors", "Top Programs by Revenue"],
 ["donutColors", "Participant Distribution"],
 ["FILL_COLORS", "the Fill Rate chart"]
].forEach(([name, what]) => {
  const re = new RegExp("var " + name + "\\s*=\\s*([^;]+);");
  const m = prog.match(re);
  ok(!!m, "programs.html no longer declares " + name + " (" + what + ")");
  ok(m && /^RECESS_CAT\b/.test(m[1].trim()),
     what + " (" + name + ") does not read RECESS_CAT — it is back to its own " +
     "hand-picked palette, which is the drift this change removed");
});

// ── 5. the KPI values are not colour-coded any more ────────────────────
const scRule = prog.match(/\.sc-green[^{]*\{([^}]*)\}/);
ok(!!scRule, "the .sc-* value-colour rule is gone entirely — call sites still " +
             "reference those classes, so they must resolve to something");
ok(scRule && /var\(--rec-text-primary\)/.test(scRule[1]),
   "the .sc-* classes colour KPI values again. Colour on this row belongs on the " +
   "DELTA, which is the only figure with a direction; nine values in five colours " +
   "all shout equally");

// ── 6. one header ──────────────────────────────────────────────────────
const hdr = prog.indexOf('<div className="report-header">');
ok(hdr > -1, "the print header is gone — the PDF has no header at all");
ok(prog.slice(Math.max(0, hdr - 400), hdr).includes("{isPrint && ("),
   ".report-header is not gated on isPrint. On screen the banner is the header, " +
   "and rendering both prints the org name and the report title twice");
ok(prog.includes('<div className="pb-window">{dateRangeLabel}</div>'),
   "the banner does not carry the date window. It is the only header on screen now, " +
   "so dropping it leaves the reader unable to see which window they are looking at");
ok(prog.includes('className="pb-plate"'),
   "the banner has no logo plate. An org logo is an arbitrary full-colour PNG; " +
   "straight onto the dark band any seal with its own background looks broken");

// ── 7. the ground is the sand token, not near-white ────────────────────
const body = prog.match(/\n    body \{([\s\S]*?)\n    \}/);
ok(body && /background:\s*var\(--rec-brand-sand\)/.test(body[1]),
   "the page ground is not --rec-brand-sand. White cards on a near-white page is " +
   "what made the first pass read as flat");

if (failures.length) {
  console.error("\n" + failures.length + " FAILED:");
  failures.forEach(f => console.error("  ✗ " + f));
  console.log("\n" + passed + " assertions passed.");
  process.exit(1);
}
console.log(passed + " assertions passed.");
