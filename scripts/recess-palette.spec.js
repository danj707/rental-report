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
const skin = fs.readFileSync(path.join(ROOT, "public/recess-report.css"), "utf8");
const openpdf = fs.readFileSync(path.join(ROOT, "public/open-pdf.js"), "utf8");

/* Every page on the layer. Listed rather than globbed, because the set is a
   DECISION: the three public customer pages, the retired reports and the QBR
   are deliberately off it, and a glob would quietly sweep them in. */
const LAYER = ["cost-recovery", "court-utilization", "custom-report", "directors-report", "facilities",
  "facility", "fasttrack", "gl", "historic", "instructor-payout", "lessons",
  "memberships", "opportunities", "products", "programs-schedule", "programs",
  "qoq", "roster", "users", "waitlist"];
const pageSrc = Object.fromEntries(LAYER.map(n =>
  [n, fs.readFileSync(path.join(ROOT, `public/${n}.html`), "utf8")]));

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

/* The JS copy lives in open-pdf.js, which every report page already loads.
   It was in programs.html while one page was on the layer; leaving it there
   while sweeping the rest would have made it the SIXTH copy of this list. */
const jsm = openpdf.match(/window\.RECESS_CAT = \[([^\]]+)\]/s);
ok(!!jsm, "open-pdf.js no longer declares window.RECESS_CAT — every page that " +
          "reads it now charts with `undefined` and every series goes blank");
const jsCat = jsm ? jsm[1].split(",").map(x => x.trim().replace(/'/g, "").toLowerCase()) : [];
ok(JSON.stringify(jsCat) === JSON.stringify(cssCat),
   "window.RECESS_CAT in open-pdf.js has DRIFTED from --rec-cat-1..8 in " +
   "recess-tokens.css — js " + JSON.stringify(jsCat) + " vs css " + JSON.stringify(cssCat));
ok((openpdf.match(/window\.RECESS_CAT\s*=\s*\[/g) || []).length === 1,
   "open-pdf.js declares window.RECESS_CAT more than once");

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

// ── 11. THE LAYER: every report page is on it, and the link order is the
//        whole mechanism ─────────────────────────────────────────────────
// The skin only wins because it is linked AFTER the page's own <style>. Move
// that link above, and on equal specificity every page silently reverts to
// its old card treatment while still LOOKING linked — which is the most
// expensive way for this to break, because nothing errors.
LAYER.forEach(n => {
  const src = pageSrc[n];
  ok(/<link[^>]+href="\/recess-tokens\.css"/.test(src),
     n + ".html does not link /recess-tokens.css — every var() on it silently " +
     "falls back and the page renders unstyled rather than broken");
  const skinAt  = src.indexOf('href="/recess-report.css"');
  const styleAt = src.indexOf("</style>");
  ok(skinAt > -1, n + ".html is not on the Recess layer — it links no recess-report.css");
  ok(skinAt > styleAt,
     n + ".html links recess-report.css BEFORE its own </style>. The skin then " +
     "loses every tie to the page's own copy of the card treatment and the whole " +
     "sweep reverts on that page, with nothing on screen or in a log to say so");
});

// ── 12. NO SIXTH FAMILY ───────────────────────────────────────────────────
// The first Programs pass restyled `.sum-card`, shipped, and Dan opened the
// Revenue tab to `.summary-card` still wearing the old treatment. So the
// strips are ENUMERATED rather than listed by hand: a KPI card is a rule that
// paints a background and pads itself AND has both a label-ish and a value-ish
// child, which is what separates it from the buttons, chips and tooltips that
// are card-shaped but are not cards. Anything found that the skin does not
// name has to be added here with a reason, so a new family fails this spec
// instead of shipping half-restyled.
const NOT_A_STRIP = {
  ".cal-hover-card": "facility — a hover card over the calendar, not a KPI strip",
  ".res-bar-tip":    "facility — a tooltip on the residency bar",
  ".flow-node":      "fasttrack — a node on the flow board; it is a diagram, not a strip",
  ".contacts-sub-row": "roster — a table sub-row",
  ".tot": "opportunities — its six family hues ARE the classification, each one " +
          "the same hue its own findings wear, and opportunities.spec.js asserts " +
          "the families stay tellable apart. Restyling them would delete a guarded " +
          "design, not a decoration.",
};
const VALUEISH = /(^|-)(val|value|num|v)$/;
const LABELISH = /(^|-)(lab|label|lbl|cat|k|l)$/;
LAYER.forEach(n => {
  const head = pageSrc[n].slice(0, pageSrc[n].indexOf("</style>"));
  const seen = new Set();
  const rule = /^[ \t]*(\.[a-z0-9-]+)[ \t]*\{([^{}]*)\}/gm;
  let m;
  while ((m = rule.exec(head))) {
    const sel = m[1], body = m[2];
    if (!/\bbackground/.test(body) || !/\bpadding/.test(body)) continue;
    const kid = new RegExp(sel.replace(".", "\\.") + "\\s+\\.([a-z0-9-]+)", "g");
    const kids = [];
    let k; while ((k = kid.exec(head))) kids.push(k[1]);
    if (!kids.some(x => VALUEISH.test(x)) || !kids.some(x => LABELISH.test(x))) continue;
    if (seen.has(sel)) continue;
    seen.add(sel);
    ok(skin.includes(sel) || NOT_A_STRIP[sel],
       n + ".html has a KPI card `" + sel + "` the skin does not style and that is " +
       "not recorded as deliberate. That is the Revenue-tab miss: one page wearing " +
       "two treatments, which reads as a half-finished restyle");
  }
});

// ── 13. the accent bars cannot come back ──────────────────────────────────
// Fifty-four of these were removed. Each spent a RESERVED colour on
// decoration, and being on a compound selector each out-specified the skin,
// so a single one reappearing is visible on screen and invisible in review.
LAYER.forEach(n => {
  const head = pageSrc[n].slice(0, pageSrc[n].indexOf("</style>"));
  const bars = head.match(/\.[a-z-]*(?:card|kpi|hl)[a-z-]*\.[a-z-]+[^{]*\{[^}]*border-(?:left|top)-color\s*:\s*#/g) || [];
  ok(bars.length === 0,
     n + ".html has a coloured accent bar on a card again (" + bars.length + "): " +
     (bars[0] || "").slice(0, 70) + " — a card is not a status, and on a compound " +
     "selector it beats the skin");
});

// ── 14. one categorical list, read by every chart that needs one ──────────
// facility carried eighteen colours, memberships and users twelve each, and
// FOUR of users' twelve were the reserved four EXACTLY. A page declaring its
// own is how this platform got to fourteen palettes.
[["facility", "DEFAULT_PALETTE"], ["memberships", "RET_COLORS"],
 ["users", "FILL_COLORS"], ["programs", "RECESS_CAT"]].forEach(([n, name]) => {
  ok(new RegExp(name + "\\s*=\\s*window\\.RECESS_CAT\\b").test(pageSrc[n]),
     n + ".html's " + name + " no longer reads window.RECESS_CAT — it has grown " +
     "its own palette back");
});
// A scale that is ORDERED is neither categorical nor semantic, so Recess's
// separation does not govern it: a heat ramp runs low-to-high and a medal runs
// first-to-third, and recolouring either to purple/sky/lime would delete the
// meaning rather than unify it. Named one by one, so the exemption cannot
// quietly widen into "any list I did not want to change".
const NOT_A_SERIES = {
  "facilities:HM_COLORS":  "sequential — the hour-coverage heat map",
  "facilities:CAMP_RAMP":  "sequential — campsite occupancy",
  "facilities:RAMP6":      "sequential — six-step occupancy",
  "facilities:RAMP":       "sequential — the court heat map",
  "facilities:OE_RAMP":    "sequential — outdoor-event hour coverage",
  "memberships:rankColors": "ordinal — gold/silver/bronze for rank 1-3 on Top Members. " +
                            "A medal is a convention a reader already knows; it is not " +
                            "an identity palette and not a status.",
  // The hidden banner minigames. Their colours are ART, not a series: nothing
  // on screen reads them as meaning anything, and painting a balloon --rec-cat-1
  // would be applying a data rule to a toy. The banner BUNTING is the opposite
  // case and was swapped, because it sits over the chart it decorates.
  "facilities:c":    "decor — the balloon art in the banner scene",
  "facilities:cols": "decor — the banner minigame's own sprites",
  "facilities:BCOL": "decor — the Bounce House minigame's balloons",
};
LAYER.forEach(n => {
  const lists = [...pageSrc[n].matchAll(
    /(?:var|const|let)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\[\s*'#[0-9a-f]{3,6}'\s*,\s*'#[0-9a-f]{3,6}'\s*,\s*'#[0-9a-f]{3,6}'/gi)];
  lists.forEach(m => {
    ok(!!NOT_A_SERIES[n + ":" + m[1]],
       n + ".html declares its own colour list `" + m[1] + "`. Identity colours come " +
       "from window.RECESS_CAT — this platform reached FOURTEEN palettes by each page " +
       "keeping its own. If it is an ordered scale rather than a categorical one, say " +
       "so in NOT_A_SERIES with the reason — an ordered scale, or art");
  });
});

// ── 15. the skin spends no reserved colour on decoration ──────────────────
// The skin may name a reserved colour ONLY through a semantic token — an
// insight's risk border, a delta's direction. A raw reserved hex in it would
// put the thing this whole change removes into the shared layer, where it
// would reach every page at once.
Object.entries(RESERVED).forEach(([hex, meaning]) => {
  ok(!skin.toLowerCase().includes(hex),
     "recess-report.css hardcodes " + hex + ", the reserved " + meaning + " colour. " +
     "A status in the shared skin reads --rec-" + (meaning === "info" ? "info" : meaning) +
     "; a raw hex there is the accent bar back, on every page at once");
});
ok(/var\(--rec-success\)/.test(skin) && /var\(--rec-danger\)/.test(skin),
   "recess-report.css no longer colours any status. A delta and an insight's " +
   "risk border are genuine states and must keep their colour — the rule is that " +
   "colour marks a status, not that colour is gone");

// ── 15. A PAGE KEEPS ITS OWN COLUMN COUNT ────────────────────────────────────
// The skin sizes a card with `flex: 1 1 <basis>`, and a WIDER basis fits FEWER
// cards per row. Every page's strip already had a minimum of its own — a grid
// minmax() or the card's min-width — and most of them are narrower than the
// skin's default, so adopting the default silently re-wrapped ELEVEN pages:
// facilities' Camping tab went 7-across to 6 + 1, leaving Weekend Nights
// stretched alone on a second row. Dan found one of the eleven by eye.
// So: a page whose own minimum is narrower than the default must hand that
// minimum back through the basis variable. Nothing about this is visible in a
// screenshot of the page that happens to have few enough cards to still fit.
const FAMILY_BASIS = {
  "summary-cards": ["summary-card", "--rec-summary-basis", 180],
  "sum-cards":     ["sum-card",     "--rec-sum-basis",     180],
  "cards":         ["card",         "--rec-cards-basis",   180],
  "kpi-row":       ["kpi",          "--rec-kpi-basis",     180],
  "kpis":          ["kpi",          "--rec-kpi-basis",     180],
  "delta-cards":   ["delta-card",   "--rec-delta-basis",   200],
};
LAYER.forEach(name => {
  const src = fs.readFileSync(path.join(ROOT, "public", name + ".html"), "utf8");
  Object.entries(FAMILY_BASIS).forEach(([cont, [item, cssVar, dflt]]) => {
    const mm = new RegExp("\\." + cont + "\\s*\\{[^}]*minmax\\(\\s*(\\d+)px").exec(src);
    const mw = new RegExp("\\." + item + "\\s*\\{[^}]*min-width:\\s*(\\d+)px").exec(src);
    if (!mm && !mw) return;
    const orig = parseInt((mm || mw)[1], 10);
    if (orig >= dflt) return;
    const decl = new RegExp(cssVar + "\\s*:\\s*(\\d+)px").exec(src);
    ok(decl && parseInt(decl[1], 10) <= orig,
       name + ".html declares ." + cont + " with a " + orig + "px minimum of its own, but "
       + (decl ? "sets " + cssVar + " to " + decl[1] + "px" : "does not set " + cssVar)
       + " — so the skin sizes those cards at " + dflt + "px and the strip wraps EARLIER "
       + "than it did before the sweep, stranding a lone stretched card on a second row");
  });
});

// ── 16. AN INLINE COLOUR IS BEYOND THE SKIN'S REACH ──────────────────────────
// An inline style beats any stylesheet, so a card that paints its own accent
// bar or value colour from JS cannot be restyled by the layer at all — it keeps
// the old treatment while every other report moves, and no CSS assertion can
// see it. That is how Fast Track's four headline cards stayed on coloured top
// borders (three of them in RESERVED semantic colours spent on identity) after
// all nineteen pages were swept, and it is the same trap as
// court-utilization's inline-styled summary-row.
LAYER.forEach(name => {
  const src = fs.readFileSync(path.join(ROOT, "public", name + ".html"), "utf8");
  // SCOPED TO A CARD IN A SWEPT STRIP, and that scoping is the whole guard.
  // A bare "inline border" test fires on correct code: Fast Track's Cold
  // Sections row is `urgent ? amber : blue`, which is a genuine STATUS and
  // keeps its colour by the same rule. What is forbidden is a CARD painting its
  // own accent, because that is the one the skin was supposed to take over.
  // The interpolation sits after the CLOSING quote — '3px solid ' + colour — so
  // the pattern has to consume that quote; a first draft did not and the
  // mutation putting the bug back SURVIVED it.
  const CARD_CLASS = "(?:summary-card|sum-card|delta-card|kpi|card)";
  const INLINE_BAR = "border(?:Top|Left)\\s*:\\s*['\"`][^'\"`]*['\"`]\\s*\\+";
  const bar =
    new RegExp("className:\\s*['\"`]" + CARD_CLASS + "['\"`][^}]*" + INLINE_BAR).exec(src) ||
    new RegExp(INLINE_BAR + "[^}]*className:\\s*['\"`]" + CARD_CLASS + "['\"`]").exec(src);
  ok(!bar, name + ".html paints a STRIP CARD's accent bar with an INLINE style (" +
     (bar ? bar[0].replace(/\s+/g, " ").slice(0, 70) : "") + "). Inline beats the " +
     "stylesheet, so the skin cannot take it back and that page silently keeps the " +
     "old treatment while every other report moves");
});

if (failures.length) {
  console.error("\n" + failures.length + " FAILED:");
  failures.forEach(f => console.error("  ✗ " + f));
  console.log("\n" + passed + " assertions passed.");
  process.exit(1);
}
console.log(passed + " assertions passed.");
