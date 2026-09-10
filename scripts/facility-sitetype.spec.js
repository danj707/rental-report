// Spec for the Site Type column and its multi-select on the rental schedule.
//
// Dan, 2026-09-10: "in order to support filtering of the facility rental
// schedule to what they want (and for other partners), we need a site 'type'
// filter on the facility rental schedule ... needs likely a new column, and a
// new filter with all the baking into the saved filter view, pdf, etc."
//
// NO CARD CHANGE WAS NEEDED. Card 17294 has emitted "Site Type" since it
// shipped and `normalizeRow` has mapped it since; no surface read it. Fifth
// instance of the mapped-and-rendered-nowhere pattern in this repo.
//
// Two things here are silent when wrong, and both are what this spec is for:
//
//   1. THE UNTYPED ROWS. `court.type` is NULL on 40,718 reservations across 59
//      orgs in the last year — the fourth largest bucket, ahead of pool — and
//      the mapper turns that into ''. Give those rows no option of their own
//      and the funnel drops every one of them the moment anybody narrows the
//      filter, with nothing on screen saying so. That is the LOC_NONE lesson
//      from the Programs location filter, one report over.
//
//   2. THE PDF. The print page is this page under ?_print=1 rendered by
//      Puppeteer with an EMPTY localStorage, so a column preference kept only
//      in storage has no channel to it, and a list parameter whose empty value
//      is meaningful cannot ride generatePdf's truthy forward loop. Both are
//      the `pii` bug, and this spec LIFTS AND RUNS the real query builder
//      rather than grepping it, because that bug was invisible to review twice.
//
// Run: node scripts/facility-sitetype.spec.js
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const PAGE = path.join(__dirname, "..", "public", "facility.html");
const SERVER = path.join(__dirname, "..", "server.js");
const CARD = path.join(__dirname, "..", "sql", "report-cards",
  "17294-facility-rental-report.sql");
const src = fs.readFileSync(PAGE, "utf8");
const srv = fs.readFileSync(SERVER, "utf8");
const card = fs.readFileSync(CARD, "utf8");

let n = 0;
function ok(cond, msg) { n++; assert.ok(cond, msg); }
function eq(a, b, msg) { n++; assert.strictEqual(a, b, msg); }

// ── Lift and RUN the two helpers ────────────────────────────────────────────
// A regex over `siteTypeKey` passes on an inverted comparison and on a version
// that returns '' for an untyped row, which is the bug.
function liftFn(name) {
  const at = src.indexOf("function " + name + "(");
  assert.ok(at > 0, "facility.html should declare " + name + " at module scope");
  // Skip the parameter list before counting braces: the first `{` in a
  // destructured signature is the parameter, not the body. (This bit the GL
  // filter spec, so it is done deliberately here even though neither of these
  // two destructures.)
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
  liftFn("siteTypeLabel") + "\n" +
  "const SITE_TYPE_NONE = '(no type)';\n" +
  "return { siteTypeKey, siteTypeLabel, SITE_TYPE_NONE };")();
const { siteTypeKey, siteTypeLabel, SITE_TYPE_NONE } = lifted;

// The sentinel the page declares and the one this spec asserts against have to
// be the same string, or every assertion below is about a value nothing uses.
const declared = /const SITE_TYPE_NONE = '([^']+)';/.exec(src);
ok(declared, "facility.html should declare SITE_TYPE_NONE");
eq(declared[1], SITE_TYPE_NONE, "the page's SITE_TYPE_NONE is the key tested here");

// ── 1. Untyped rows get a key, and it is never falsy ────────────────────────
// Every shape the mapper can produce for a site with no type. `normalizeRow`
// ends its chain in `|| ''`, so '' is the one that actually arrives; the others
// are what a card change or a hand-built row could send.
[null, undefined, "", "   "].forEach(v => {
  eq(siteTypeKey({ siteType: v }), SITE_TYPE_NONE,
    "an untyped site must resolve to the SITE_TYPE_NONE key, not to '' — a "
    + "falsy key has no tickable option and the funnel silently drops the row. "
    + "court.type is NULL on 40,718 live reservations across 59 orgs. Got "
    + JSON.stringify(siteTypeKey({ siteType: v })) + " for " + JSON.stringify(v));
});
eq(siteTypeKey({}), SITE_TYPE_NONE, "a row with no siteType key at all is untyped");
eq(siteTypeKey(null), SITE_TYPE_NONE, "and siteTypeKey must not throw on a null row");

// ── 2. A real type passes through unchanged ─────────────────────────────────
// These are the twelve live values, measured 2026-09-10 over 365 days of
// reservations. The KEY is the raw slug so the URL carries what the card emits.
const LIVE_TYPES = ["court", "room", "field", "pool", "gym", "outdoor-event-space",
  "picnic-table", "other", "rink", "bounce-house", "golf", "campsite"];
LIVE_TYPES.forEach(t => {
  eq(siteTypeKey({ siteType: t }), t, "a real type is its own key: " + t);
});
eq(siteTypeKey({ siteType: "  court  " }), "court",
  "a type is trimmed, or one padded value becomes a second option for one fact");

// ── 3. 'other' is a REAL type and is not the same fact as no type ───────────
// 7,862 reservations across 38 orgs carry it. Folding the two together would
// report an unconfigured site as a deliberately-categorised one.
ok(siteTypeKey({ siteType: "other" }) !== siteTypeKey({ siteType: "" }),
  "'other' is a real type with 7,862 live reservations and must not collapse "
  + "into the untyped bucket");

// ── 4. The label is what a person reads ─────────────────────────────────────
eq(siteTypeLabel("outdoor-event-space"), "Outdoor Event Space",
  "a slug must render as words — the filter's options, the table cell and the "
  + "spreadsheet all read this one definition");
eq(siteTypeLabel("picnic-table"), "Picnic Table", "hyphens become spaces");
eq(siteTypeLabel("court"), "Court", "a single word is title-cased");
eq(siteTypeLabel(SITE_TYPE_NONE), "No type on file",
  "the untyped bucket says what it is, rather than printing its own sentinel");
eq(siteTypeLabel(""), "No type on file",
  "and an empty label falls to the same words, so the cell can never be blank");
// Every one of the twelve live types title-cases correctly, which is why there
// is no lookup table: a map would agree with the fallback on every input it has
// and go stale the day a thirteenth type ships.
LIVE_TYPES.forEach(t => {
  const lbl = siteTypeLabel(t);
  ok(lbl && lbl[0] === lbl[0].toUpperCase() && !/[-_]/.test(lbl),
    "every live type must produce a readable label: " + t + " -> " + lbl);
});

// ── 5. ONE definition, read by every surface ────────────────────────────────
// Three surfaces show a site type — the filter's options, the table cell and
// the spreadsheet — and a second copy is how a checkbox stops matching the word
// beside it (the Past/Ran lesson).
// Scoped to the page WITHOUT siteTypeKey's own body, or the assertion is about
// how many times that one function mentions its argument.
const outsideKey = src.replace(liftFn("siteTypeKey"), "");
const rawReads = outsideKey.match(/\.siteType\b/g) || [];
eq(rawReads.length, 0,
  "the raw `.siteType` field should be read ONLY inside siteTypeKey. Every "
  + "other surface must go through the key function, or an untyped row is "
  + "handled two ways and one of them drops it. Found " + rawReads.length
  + " reads outside");
ok(/selectedSiteTypes\.has\(siteTypeKey\(r\)\)/.test(src),
  "the funnel must key rows through siteTypeKey");
ok(/normalized\.map\(siteTypeKey\)/.test(src),
  "the options must be built through siteTypeKey too — options and funnel "
  + "keyed differently is a checkbox that filters nothing");
ok(!/\.map\(r => r\.siteType\)/.test(src),
  "no surface may build its own list from the raw column");

// ── 6. One type is not a filter ─────────────────────────────────────────────
// 26 of the 126 orgs with facility traffic in the last year run a single site
// type. A control that can only return everything or nothing is a dead end.
ok(/if \(!allTypes \|\| allTypes\.length < 2\) return null;/.test(src),
  "SiteTypeFilter must render nothing when the org runs a single site type");

// ── 7. The column is OPT-IN, and the URL is its only channel to the PDF ─────
ok(/localStorage\.getItem\('col_sitetype'\) === 'true'/.test(src),
  "the Site Type column defaults OFF — it is new to a report every org already "
  + "prints, and defaulting it on would widen all of their PDFs unasked");
ok(/get\('sitetype'\)[\s\S]{0,120}return fromUrl === '1'/.test(src),
  "showSiteType must read the URL BEFORE localStorage. The print page has an "
  + "empty localStorage, so a column kept only in storage cannot reach the PDF "
  + "at all: the reader ticks it, hits PDF, and the column is silently absent");
ok(/if \(params\.sitetype != null\) return;/.test(src),
  "the persist must be gated on the URL not carrying `sitetype` — opening a "
  + "shared link must not rewrite this reader's own default. Same rule as pii");

// ── 8. An EMPTY site_types is a real answer ─────────────────────────────────
ok(/if \(params\.site_types != null\)/.test(src),
  "site_types must be read on PRESENCE. Truthiness reads an empty value — the "
  + "reader ticked None — as 'no opinion', and the PDF then prints every site "
  + "type while the screen showed no rows");
ok(/if \(params\.site_types === ''\) return new Set\(\);/.test(src),
  "an explicitly empty site_types selects nothing");
ok(/if \(shared\.length > 0\) return new Set\(shared\);/.test(src),
  "but a parameter naming only types this window does not have is a STALE "
  + "link, not an empty selection, and must fall back to all rather than "
  + "blanking the report");

// ── 9. Both params are in getParams' whitelist ──────────────────────────────
// The first of the four gates. Miss it and the value reads `undefined` and the
// deep link silently does nothing, which is invisible in source review.
ok(/site_types: +p\.get\('site_types'\)/.test(src),
  "site_types must be in getParams' explicit whitelist");
ok(/sitetype: +p\.get\('sitetype'\)/.test(src),
  "sitetype must be in getParams' explicit whitelist");

// ── 10. The share link and the PDF must agree ───────────────────────────────
const shareAt = src.indexOf("window.recShareLink = () => {");
ok(shareAt > 0, "facility.html should register window.recShareLink");
const shareBlock = src.slice(shareAt, src.indexOf("return () => { try { delete window.recShareLink", shareAt));
const pdfAt = src.indexOf("function downloadPdf() {");
ok(pdfAt > 0, "facility.html should declare downloadPdf");
const pdfBlock = src.slice(pdfAt, src.indexOf("openReportPdf(", pdfAt));
[["the share link", shareBlock], ["downloadPdf", pdfBlock]].forEach(([what, block]) => {
  ok(/qs\.set\('sitetype', showSiteType \? '1' : '0'\)/.test(block),
    what + " must ALWAYS send `sitetype`. '0' is a real answer: omitted, the "
    + "print page falls back to its own default and the two disagree");
  ok(/selectedSiteTypes\.size < allSiteTypes\.length/.test(block),
    what + " must send site_types whenever the reader has narrowed — including "
    + "to nothing, which is why the test is on size and not on emptiness");
});

// EVERY NAME IN THE SHARE-LINK EFFECT'S DEP ARRAY MUST BE DECLARED ABOVE IT.
// These pages compile JSX in the browser, so Babel turns `const` into `var`:
// a name read before its declaration evaluates to `undefined` in the deps array
// instead of throwing, the array is then `[..., undefined]` on every render,
// the effect only ever runs on mount, and Copy Link is one change behind the
// screen — silently. Already recorded in CLAUDE.md; this is the general guard.
const depsAt = src.indexOf("}, [loadedStart, loadedEnd, startDate, endDate, selectedLocations");
ok(depsAt > shareAt, "the share-link effect should close with its dep array");
const deps = src.slice(depsAt, src.indexOf("]);", depsAt))
  .replace("}, [", "").split(",").map(s => s.trim()).filter(Boolean);
ok(deps.indexOf("showSiteType") !== -1 && deps.indexOf("selectedSiteTypes") !== -1
  && deps.indexOf("allSiteTypes") !== -1,
  "the share link reads showSiteType, selectedSiteTypes and allSiteTypes, so "
  + "all three must be in its dep array. Got: " + deps.join(", "));
// Collect every name declared ABOVE the effect. Most of this page's state is
// array-destructured out of useState, so a bare `const NAME` pattern finds
// almost nothing and the guard passes vacuously.
const above = src.slice(0, depsAt);
const declared_ = new Set();
let m;
const declRe = /\b(?:const|let|var)\s+(\[[^\]]*\]|[A-Za-z_$][\w$]*)|\bfunction\s+([A-Za-z_$][\w$]*)/g;
while ((m = declRe.exec(above))) {
  const names = (m[1] || m[2] || "");
  names.replace(/[A-Za-z_$][\w$]*/g, x => { declared_.add(x); return x; });
}
ok(declared_.has("selectedSiteTypes") && declared_.has("loadedStart"),
  "the declaration scan should find this page's destructured state — without "
  + "that, the dep-array guard below passes on anything");
deps.forEach(d => {
  if (!/^[A-Za-z_$][\w$]*$/.test(d)) return;   // params.x and the like
  ok(declared_.has(d),
    "`" + d + "` is in the share-link effect's dep array but is not declared "
    + "ABOVE it — Babel compiles const to var, so it evaluates to undefined "
    + "there rather than throwing, the array is [..., undefined] on every "
    + "render, and the effect then only runs on mount");
});

// ── 11. generatePdf's forward list — LIFTED AND RUN ─────────────────────────
const gp = srv.slice(srv.indexOf("async function generatePdf("));
const qsBlock = gp.slice(gp.indexOf("const qsObj = {"),
                         gp.indexOf("const qs = new URLSearchParams(qsObj);")
                           + "const qs = new URLSearchParams(qsObj);".length);
ok(qsBlock.includes("forEach"), "the generatePdf query block should be liftable");
const buildQs = new Function("startDate", "endDate", "orgTok", "filters",
  qsBlock + "\nreturn qs.toString();");

// The case that matters: the reader ticked None, which the page sends as EMPTY.
const noneQs = buildQs("2026-09-10", "2026-09-16", "tok", { site_types: "", sitetype: "1" });
ok(/(^|&)site_types=(&|$)/.test(noneQs),
  "generatePdf MUST forward an EMPTY site_types — that is how the page says "
  + "'the reader ticked None'. Dropped, the print page falls back to every "
  + "type and the PDF carries rows that are not on the reader's screen. Got: "
  + noneQs);
const someQs = buildQs("2026-09-10", "2026-09-16", "tok", { site_types: "pool,court" });
ok(/site_types=pool%2Ccourt/.test(someQs),
  "and a populated site_types must be forwarded too. Got: " + someQs);
const absentQs = buildQs("2026-09-10", "2026-09-16", "tok", {});
ok(!/site_types=/.test(absentQs) && !/sitetype=/.test(absentQs),
  "an ABSENT parameter must not be invented — absent means 'the caller is not "
  + "speaking about this'. Got: " + absentQs);

// `sitetype` survives the truthy loop today only because it is spelled '0'
// rather than '', which is a parameter that works by accident of its encoding.
const offQs = buildQs("2026-09-10", "2026-09-16", "tok", { sitetype: "0" });
ok(/(^|&)sitetype=0(&|$)/.test(offQs),
  "generatePdf must forward sitetype=0, or a reader who left the column off "
  + "gets whatever the print page's default happens to be. Got: " + offQs);
const onQs = buildQs("2026-09-10", "2026-09-16", "tok", { sitetype: "1" });
ok(/(^|&)sitetype=1(&|$)/.test(onQs), "and sitetype=1. Got: " + onQs);

// Presence, not the truthy loop. Fold either into that loop and every populated
// assertion above still passes — only the empty case breaks, which is the bug
// exactly as `pii` and `gl_codes` shipped.
ok(/if \(filters\.site_types !== undefined\) qsObj\.site_types = filters\.site_types;/.test(srv),
  "site_types must be forwarded on presence (!== undefined)");
ok(/if \(filters\.sitetype !== undefined\) qsObj\.sitetype = filters\.sitetype;/.test(srv),
  "sitetype must be forwarded on presence (!== undefined)");
ok(!/"site_types"/.test(qsBlock) && !/"sitetype"/.test(qsBlock),
  "neither may sit in generatePdf's truthy forward list — the loop tests "
  + "`if (filters[k])`, which drops the empty value that means 'none'");

// ── 12. The card already emits the column ───────────────────────────────────
// The whole change is client-side, and that claim is worth pinning: if the
// column ever leaves card 17294, the filter reads one option ("no type on
// file") for every row on the platform and looks broken rather than empty.
ok(/AS "Site Type"/.test(card),
  "card 17294 must keep emitting \"Site Type\" — the page maps it and every "
  + "surface here reads it, and no page change can recover it");
ok(/raw\['Type'\] +\|\| raw\['Site Type'\]/.test(src),
  "normalizeRow must keep mapping the card's Site Type column");

console.log(`✓ facility-sitetype.spec.js — ${n} assertions passed`);
