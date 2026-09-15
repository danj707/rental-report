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

// ── 8. BOTH card families, not just the one on the Summary tab ─────────
// .sum-card is Summary; .summary-card is Revenue, Participants, Retention and
// Fill Rate. Restyling only the first left Dan looking at a Recess masthead
// over the old bordered, colour-coded boxes ("the metrics section still looks
// the same", 2026-09-15). Asserted as a PAIR, so neither can move alone.
const fam = {
  "sum-cards":     prog.match(/\n    \.sum-cards \{([\s\S]*?)\}/),
  "summary-cards": prog.match(/\n    \.summary-cards \{([\s\S]*?)\}/),
};
Object.entries(fam).forEach(([sel, m]) => {
  ok(!!m, "." + sel + " is gone — one of the two KPI strips has no container rule");
  const css = (m && m[1]) || "";
  ok(/gap:\s*1px/.test(css),
     "." + sel + " is back to a gap between bordered cards. The hairline divider " +
     "IS the separation, and it is the one form that survives wrapping — a per-cell " +
     "left border strands a rule at the start of the second row");
  ok(/background:\s*var\(--rec-border-secondary\)/.test(css),
     "." + sel + " does not draw its dividers from --rec-border-secondary");
  ok(/border-radius:\s*var\(--rec-radius-lg\)/.test(css),
     "." + sel + " hardcodes a radius again — 19 of them across public/ is what " +
     "the token layer exists to collapse");
});
const cardRule = prog.match(/\n    \.summary-card \{([\s\S]*?)\}/);
ok(cardRule && /background:\s*var\(--rec-bg-primary\)/.test(cardRule[1]),
   ".summary-card is not on --rec-bg-primary. The cards come forward off the sand " +
   "ground on their own; a tinted card on a tinted page is what read as flat");
// The basis is NOT shared, and that is deliberate: it is a function of how
// many cards the strip carries (nine on Summary, seven on Revenue), and one
// number cannot make both wrap evenly. What must be shared is everything else.
const sumCard = prog.match(/\n    \.sum-card \{([\s\S]*?)\}/);
[["sum-card", sumCard], ["summary-card", cardRule]].forEach(([sel, m]) => {
  ok(m && /flex:\s*1 1 \d+px/.test(m[1]),
     "." + sel + " has no flex basis. Without one the cards size to their content " +
     "and a long label makes its own card twice the width of its neighbour");
  ok(m && /padding:\s*15px 18px/.test(m[1]),
     "." + sel + "'s padding drifted from the other strip's. The two sit on one " +
     "report, so a card has to be the same object on every tab");
});

// ── 9. a figure is a figure, on BOTH families ──────────────────────────
const cvRule = prog.match(/\.summary-card \.card-value\.green,[\s\S]*?\{([^}]*)\}/);
ok(!!cvRule, "the .card-value colour overrides are gone entirely — every call site " +
             "still passes green/red/blue, so they must resolve to something");
ok(cvRule && /var\(--rec-text-primary\)/.test(cvRule[1]),
   ".card-value.green/.red/.blue colour the Revenue tab's figures again. Colour " +
   "marks a delta or a status; $4,475 is neither good nor bad");
ok(!/borderLeft:\s*'\d+px solid #/.test(prog),
   "a card carries an inline coloured left accent again. It is a fifth colour " +
   "scheme on a page that now has one, and being inline no stylesheet can take it back");

// A STATUS may still be coloured — that is the rule, not an exception to it —
// but through the semantic tokens, never a raw hex, or the page grows a second
// vocabulary for good/warning/bad.
ok(/pct>=30\?'var\(--rec-success-ink\)'/.test(prog),
   "Org-Wide Retention reads a raw hex for its good/warning/bad thresholds. That " +
   "figure IS a status and keeps its colour — it just has to come from the tokens");

// ── 10. no third family, styled and rendered nowhere ───────────────────
ok(!/\.kpi-val\s*\{/.test(prog),
   "the dead .kpi-* block is back. Nothing on this page renders it, and a card " +
   "treatment with no call site is what sends the next person looking for the " +
   "panel it belonged to — and makes this look like three families to keep in sync");

if (failures.length) {
  console.error("\n" + failures.length + " FAILED:");
  failures.forEach(f => console.error("  ✗ " + f));
  console.log("\n" + passed + " assertions passed.");
  process.exit(1);
}
console.log(passed + " assertions passed.");
