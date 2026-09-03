#!/usr/bin/env node
/* ============================================================================
 * programs-summary.spec.js — Laurel's asks on the Programs report, and the
 * two bugs Dan found in the same afternoon (2026-09-03).
 *
 * WHERE THIS CAME FROM. Laurel Rossiter at Shrewsbury, on a call:
 *
 *   "registration day opens and I can literally watch people register for
 *    stuff... This one, I'm like, oh, let me run this report. But then it's
 *    bringing up stuff that we canceled like last summer or we never ran...
 *    I feel like I'm not doing it right."
 *   "Challenge Island, we canceled before it even ran. Like, why is it on this
 *    report? And that's from, like, last year."
 *   "this enhanced reports when it's not working, we don't have the seasons
 *    tab."
 *
 * Measured against production on her exact window before any of this was
 * built: 31.4s to load, 195 sections, 21 of them Canceled, 26 rows outside the
 * season she was looking at, and four season options that DID exist — the
 * picker was hidden by the load, not missing.
 *
 * WHAT IS GUARDED HERE, and why each one can be wrong while the page still
 * renders something plausible:
 *
 *   1. CANCELLED SECTIONS ARE OUT BY DEFAULT, with a filter to bring them
 *      back. One predicate, read by the funnel and by the control's own count
 *      — two copies drift and then the checkbox offers a number that does not
 *      match what ticking it does.
 *   2. THE FUNNEL RUNS WITH NO FILTER PICKED. The exclusion is the default, so
 *      the early return that used to hand `rows` straight back has to be gated
 *      on it too, or cancelled sections come back the moment nobody has ticked
 *      a location.
 *   3. THE SEASON OPTIONS EXIST BEFORE THE ROWS DO. They are the UNION of the
 *      org's remembered seasons and whatever the current rows carry, so the
 *      control an admin needs in order to NARROW a slow load is on screen
 *      during it.
 *   4. THE TOP-PROGRAMS BARS ARE SCALED TO THE LARGEST. They read the first
 *      row instead, so anything bigger clipped at 100% — four bars pegged full
 *      width across a 5x range in Dan's screenshot, which is what "doesn't
 *      react to the filters" looked like.
 *   6. THE STICKY TOOLBAR CLEARS THE EARLY-ACCESS BANNER, which is a shared
 *      bug: both are `position: sticky; top: 0` and the banner wins on
 *      z-index, so every report's toolbar parked underneath it.
 *   5. THE THREE NOISY PANELS ARE GONE, and the self-service FETCH went with
 *      them rather than being left running for nobody.
 *
 * It LIFTS AND RUNS the predicates and reducers rather than regexing them: a
 * regex passes on an inverted comparison. (The nightStateFrom lesson.)
 * ==========================================================================*/
"use strict";

const fs = require("fs");
const path = require("path");

const PAGE   = path.join(__dirname, "..", "public", "programs.html");
const SERVER = path.join(__dirname, "..", "server.js");

const src = fs.readFileSync(PAGE, "utf8");
const srv = fs.readFileSync(SERVER, "utf8");

/* THE COMMENT STRIPPER RUNS LINE COMMENTS FIRST, and that order is not
   cosmetic: server.js carries `/*` inside a `//` comment, and stripping block
   comments first pairs that opener with a real close 1,500 lines later and
   swallows the region. Nine specs in this repo had the wrong order and were
   blind over it. The page's own comments quote the removed panels' names and
   the broken forms on purpose, which is why the source assertions need a
   stripped copy at all. */
const strip = t => t.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const code = strip(src);

let pass = 0;
const failures = [];
const ok = (c, m) => { c ? pass++ : failures.push(m); };
const eq = (g, w, m) => ok(g === w, m + " — got " + JSON.stringify(g) + ", want " + JSON.stringify(w));

// ── lift and RUN ────────────────────────────────────────────────────────────
function liftFn(text, name) {
  const start = text.indexOf("function " + name + "(");
  if (start < 0) throw new Error(name + " not found at module scope — a spec cannot run what it cannot reach");
  // Skip the parameter list before counting braces: for a destructured
  // parameter the first `{` is the pattern and counting from it cuts the
  // function in half. That trap has now cost three specs in this repo.
  let i = text.indexOf(")", start);
  let depth = 0;
  i = text.indexOf("{", i);
  for (; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (depth === 0) break; }
  }
  return text.slice(start, i + 1);
}

const progIsCanceledSection = new Function(
  liftFn(src, "progIsCanceledSection") + "; return progIsCanceledSection;")();

/* ── 1. THE CANCELLED PREDICATE, run over every spelling the feed uses ──────
   Card 17295 emits `Section Status`, the mapper normalises it to `status`, and
   BOTH American and British spellings are in the data — the section table has
   tested `=== 'Canceled' || === 'Cancelled'` since it shipped. A predicate
   that knows only one of them silently keeps half the cancellations, which is
   the complaint. */
{
  ok(progIsCanceledSection({ status: "Canceled" }),  "Canceled is cancelled");
  ok(progIsCanceledSection({ status: "Cancelled" }), "...and so is Cancelled — both spellings are in the feed");
  ok(progIsCanceledSection({ sectionStatus: "Canceled" }),
     "the raw sectionStatus key is read too, so an unmapped row is not silently kept");
  ok(!progIsCanceledSection({ status: "Upcoming" }),    "Upcoming is not cancelled");
  ok(!progIsCanceledSection({ status: "In Progress" }), "In Progress is not cancelled");
  ok(!progIsCanceledSection({ status: "Past" }),        "Past is not cancelled — a programme that RAN is not a cancellation");
  ok(!progIsCanceledSection({ status: "" }), "an empty status is not cancelled: absence is not evidence");
  ok(!progIsCanceledSection({}),   "a row with no status at all is not cancelled");
  ok(!progIsCanceledSection(null), "and the predicate survives a null row rather than throwing inside a filter");
}

/* ── 2. ONE PREDICATE, TWO READERS ──────────────────────────────────────────
   The funnel excludes and the checkbox counts. A second inline test is how the
   control comes to read "Show 21 cancelled" and ticking it changes 19 rows. */
{
  const uses = (code.match(/progIsCanceledSection/g) || []).length;
  ok(uses >= 3, "progIsCanceledSection is read by the funnel AND by the count, not re-derived — found " + uses + " references");
  ok(/out\s*=\s*out\.filter\(r\s*=>\s*!progIsCanceledSection\(r\)\)/.test(code),
     "the funnel excludes through the shared predicate");
  ok(/progCanceledCount[\s\S]{0,200}?\.filter\(progIsCanceledSection\)/.test(code),
     "and the control's own count comes from the same predicate");
  ok(!/status === 'Canceled' \|\| r\.status === 'Cancelled'/.test(
        code.slice(code.indexOf("const scopedRows"), code.indexOf("const scopedRows") + 1400)),
     "the funnel does not carry its own inline copy of the test");
}

/* ── 3. THE FUNNEL RUNS WITH NOTHING TICKED ─────────────────────────────────
   `scopedRows` used to hand `rows` straight back when no filter was picked —
   correct while every filter was opt-in, and wrong the moment one became the
   DEFAULT. The early return must be gated on the cancellation state as well,
   or the exclusion silently does nothing until somebody picks a location. */
{
  const i = code.indexOf("const scopedRows");
  const slice = code.slice(i, i + 1600);
  ok(/const dropCanceled = !showCanceledSections/.test(slice),
     "the funnel knows whether cancellations are being dropped");
  ok(/if \(!dropCanceled && !locFilter && !seasonSel\.length && !instrSel\.length\) return rows/.test(slice),
     "and the early return requires dropCanceled to be FALSE — this is the assertion that fails if the exclusion is bypassed by default");
  ok(/\}, \[rows, progSections, sectionGrain, locFilter, seasonSel, instrSel, showCanceledSections\]\)/.test(code),
     "showCanceledSections is in the memo's deps, or ticking the box changes nothing until another filter moves");
}

/* ── 4. IT IS NOT PERSISTED, and the control hides when there is nothing ────
   Whether to look at cancellations is a question about THIS window, not a
   layout preference — an admin returning to a silently widened report reads a
   superset as the whole truth. And a checkbox reading "Show 0 cancelled" is
   the dead end this repo keeps writing down. */
{
  ok(/useState\(false\)[^\n]*\n?/.test(code.slice(code.indexOf("showCanceledSections") - 80, code.indexOf("showCanceledSections") + 120)) ||
     /const \[showCanceledSections, setShowCanceledSections\] = useState\(false\)/.test(code),
     "cancellations are hidden on arrival");
  ok(!/localStorage[^\n]*(cancel|Cancel)/.test(code),
     "and the choice is not persisted — this is a search intent, not a saved view");
  ok(/progCanceledCount > 0 &&/.test(code),
     "the control is ABSENT where there is nothing to show, not a checkbox over a zero");
}

/* ── 5. THE SEASON OPTIONS ARE A UNION, and exist before the feed lands ─────
   This is the ask verbatim: "Lets fix the seasons filter to show regardless of
   the data loaded... pull the seasons filter list from the org." Options built
   from the rows alone do not exist during the load that makes the filter worth
   having. */
{
  const i = code.indexOf("const seasonOptions");
  const slice = code.slice(i, i + 1200);
  ok(/knownSeasons/.test(slice),
     "the options are seeded from the org's remembered seasons");
  ok(/counts\.set\(name, 0\)/.test(slice),
     "...seeded at ZERO, so a season with nothing in this window is still tickable and its count tells the truth");
  ok(/ORG_CONFIG/.test(slice),
     "and they come from the injected config rather than a second fetch the page would have to wait on");
}

/* ── 6. THE SERVER REMEMBERS THEM, folding empty to the card's own literal ──*/
{
  const i = srv.indexOf("function rememberOrgSeasons");
  const slice = srv.slice(i, i + 900);
  ok(i > 0, "rememberOrgSeasons exists");
  ok(/"program_season"\]\s*\?\?\s*r\["Season"\]/.test(slice),
     "it reads the card's column and its alias, so a renamed feed does not silently produce no seasons");
  ok(/"No Season"/.test(slice),
     "an empty season folds to the card's own literal 'No Season' — a pre-v6 feed and the alias both produce empty, and that is one fact, not two options");
  ok(/if \(!slug \|\| !Array\.isArray\(rows\) \|\| !rows\.length\) return/.test(slice),
     "and an empty answer never overwrites what we already knew: a feed that did not answer is not an org with no seasons");
  ok(/if \(reportType === "programs"\) rememberOrgSeasons\(orgSlug, data\)/.test(srv),
     "the data route feeds it");
  /* AND SO DOES PREWARM. `_orgSeasonList` is in memory, so it is empty after
     every deploy — and the whole point of the picker existing before the feed
     answers is that the FIRST person to open the report after a restart gets
     it. Learning only from a live request means that person is exactly the one
     who does not, which is the case the fix was for. */
  ok(/if \(rt === "programs"\) rememberOrgSeasons\(slug, data\)/.test(srv),
     "...and so does prewarm, or the first open after every deploy is the one without a season picker");
  ok((srv.match(/rememberOrgSeasons\(/g) || []).length >= 3,
     "both call sites plus the definition");
  ok(/knownSeasons: \(_orgSeasonList\[slug\] \|\| \{\}\)\.seasons \|\| \[\]/.test(srv),
     "and the page is injected with them");
}

/* ── 7. THE TOP-PROGRAMS BARS ARE SCALED TO THE LARGEST ─────────────────────
   Dan: "the 'top programs by revenue' widget doesn't react to the filters
   being changed." The row set was scoped all along — it comes off
   filteredRows — but the chart took its top ten from an order by periodNet and
   then scaled the bars against top10[0].netRevenue, i.e. the FIRST row rather
   than the biggest. Anything larger computed over 100% and clipped, so four
   bars sat pegged full width across a $1,575-to-$7,650 range and the picture
   never moved. */
{
  const i = code.indexOf("Top Programs by Revenue");
  const slice = code.slice(i, i + 1200);
  ok(!/maxRev = top10\.length > 0 \? top10\[0\]\.netRevenue/.test(slice),
     "the scale is NOT the first row's revenue — that is the bug exactly as it shipped");
  ok(/maxRev = top10\.reduce\(function\(m,p\)\{ return Math\.max\(m, p\.netRevenue\); \}, 0\)/.test(slice),
     "it is the maximum over the rows being drawn");
  ok(/\|\| 1/.test(slice), "with a floor of 1, or an all-zero set divides by zero");
  ok(/\.sort\(function\(a,b\)\{ return b\.netRevenue - a\.netRevenue; \}\)/.test(slice),
     "and the chart is ORDERED by the figure it draws — taking the top ten by periodNet and labelling them with lifetime net is how the ten rows stopped moving");
  ok(/Math\.min\(100,/.test(slice),
     "the width is clamped as well, so a rounding error cannot overflow the track");
  ok(/data-prog-toprev/.test(code), "and the computed percentage is on the element, so a render case can prove exactly one bar reads 100");
}

/* ── 8. STATUS PILLS over All Programs ─────────────────────────────────────
   Dan: "add quick, pill style filters to the top of the 'all programs' section
   to filter by upcoming, in progress, etc." */
{
  ok(/const PROG_STATUSES = \[/.test(code), "the vocabulary is at module scope, so a spec can read it");
  ["Upcoming", "In Progress", "Past", "Canceled"].forEach(k =>
    ok(new RegExp("key: '" + k + "'").test(code), "the pills cover " + k));
  ok(/key: 'Past',\s*label: 'Ran'/.test(code),
     "'Past' is labelled Ran — the same word the table's own badge uses, or a filter stops matching what the reader sees");
  ok(/shownProgs\.map\(function\(p\)/.test(code),
     "the table body reads the SCOPED set, not progsSorted — a pill that lights up and filters nothing looks identical");
  ok(/if \(live\.length < 2\) return null/.test(code),
     "no pill row where every programme shares one status: one status is not a filter");
  ok(/\(counts\[st\.key\] \|\| 0\) > 0/.test(code),
     "and a status with nothing behind it is not offered — a Cancelled pill that can only empty the table is a dead end");
  ok(/progStatusSel\.length\s*\n?\s*\?\s*progsSorted\.filter/.test(code) ||
     /progStatusSel\.length[\s\S]{0,80}progsSorted\.filter/.test(code),
     "an EMPTY selection means ALL, the same rule as the season and instructor pickers");
  ok(/prog-pill-clear/.test(code),
     "so there is a Clear and no 'select all' — two controls producing one state is a control that looks broken");
  ok(/shownProgs\.length !== progs\.length \? <span[\s\S]{0,120}all \{progs\.length\}/.test(code),
     "and the Total row SAYS it covers all of them when the rows above it are scoped, rather than quietly disagreeing");
}

/* ── 9. THE THREE NOISY PANELS ARE GONE, and the fetch went with them ──────
   Dan: "remove these three sections, they are noisy." Each was a full-width
   tinted band above the numbers people come for. What must NOT survive is the
   self-service feed: two Metabase fetches per load whose result nothing reads,
   on the page whose load time is the complaint. */
{
  ok(!/Self-Service &amp; Staff Workload/.test(code), "the self-service band is gone");
  ok(!/Session Attendance/.test(code),                "the attendance band is gone");
  ok(!/Waitlist Demand/.test(code),                   "the waitlist band is gone");
  ok(!/selfservice\/api\/data/.test(code),
     "and the self-service FETCH is gone with it — a fetch nobody reads is the dead end this repo keeps writing down");
  ok(!/setSsData/.test(code), "no dead state left behind either");
  // What must SURVIVE: everything those panels read is still computed and
  // still displayed elsewhere, so restoring a panel is markup, not a rebuild.
  ok(/const checkinSummary = useMemo/.test(code),
     "checkinSummary survives — the Check-Ins tab, the tab badge and the programme table all read it");
  ok(/const showWaitlist = colPresence\.waitlist/.test(code),
     "and the waitlist columns survive in the table and the Excel export");
}

/* ── 10. THE TOOLBAR CLEARS THE BANNER ────────────────────────────────────
   Dan: "we need to 'pin' this top header with all the search stuff. scrolling
   down and having it disappear is super frustrating." It was pinned — at
   top: 0, the same place the early-access banner pins, and the banner wins on
   z-index — so the toolbar parked underneath it and the date fields were cut
   off. The banner owns its height, so the banner publishes it; every page
   reads it with a 0px fallback so a page without the widget is unchanged. */
{
  const fw = fs.readFileSync(path.join(__dirname, "..", "public", "feedback-widget.js"), "utf8");
  ok(/setProperty\("--rec-banner-h", h \+ "px"\)/.test(fw),
     "the banner publishes its own measured height");
  ok(/banner\.offsetHeight/.test(fw),
     "...MEASURED, not a hardcoded 44px — the banner wraps and gets taller on a narrow viewport");
  ok(/window\.addEventListener\("resize", setBannerH\)/.test(fw),
     "and re-measured on resize");
  ok(/ResizeObserver/.test(fw),
     "...and on a rewrap that does not change the window size");
  ok(/top: var\(--rec-banner-h, 0px\)/.test(code),
     "the Programs toolbar sticks BELOW the banner");
  // Every LIVE report page, not just the one Dan happened to be looking at:
  // the bug is in the pair of rules, so it exists everywhere both appear.
  const pages = ["gl", "facility", "facilities", "roster", "memberships", "fasttrack",
                 "waitlist", "users", "directors-report", "instructor-payout"];
  pages.forEach(n => {
    const t = fs.readFileSync(path.join(__dirname, "..", "public", n + ".html"), "utf8");
    ok(/top:\s*var\(--rec-banner-h, 0px\)/.test(t),
       n + ".html's toolbar clears the banner too — the same two rules, so the same bug");
  });
}

/* ── report ─────────────────────────────────────────────────────────────────*/
if (failures.length) {
  console.error("\n✗ programs-summary.spec.js — " + failures.length + " failure(s):\n");
  failures.forEach(f => console.error("  ✗ " + f));
  console.error("\n" + pass + " passed, " + failures.length + " failed.\n");
  process.exit(1);
}
console.log("✓ programs-summary.spec.js — " + pass + " assertions passed.");
