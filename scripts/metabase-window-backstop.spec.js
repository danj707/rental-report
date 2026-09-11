#!/usr/bin/env node
/**
 * THE SERVER-SIDE BACKSTOP FOR A HALF-OPEN DATE WINDOW.
 *
 * Marina at Norman asked for 1-31 August and got 1 August -> today: 338 rows and
 * $96,293.47 against August's real $82,258.22, seventeen per cent high, with
 * eleven days of September in a file named "Aug 2026". The parameter was
 * dropped in three places and noticed by none -- the page omitted a blank date
 * from the query string, buildMetabaseParams only backfilled when BOTH were
 * missing, and the card's end bound lives in an optional [[ ]] block that drops
 * out entirely when no parameter arrives.
 *
 * The ten report pages refuse to send it now (report-window.spec.js). This
 * guards the other half: that the SERVER cannot pass one through either, for a
 * saved view, an email subscription, a hand-built link or a page written next
 * year.
 *
 * It LIFTS AND RUNS the real buildMetabaseParams rather than regexing it -- a
 * regex passes on an inverted comparison, and the whole defect here was a
 * condition that read correctly and covered one case too few.
 */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

let passed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { passed++; return; }
  failures.push(msg);
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + " (got " + JSON.stringify(actual) + ", wanted " + JSON.stringify(expected) + ")");
}

// ── Lift ────────────────────────────────────────────────────────────────────
// Bounded by the function's own braces, not by a fixed slice: a fixed-length
// slice stops covering the tail of a function the moment anything is added to
// it, and then passes by not reaching the code it names.
function liftFn(name) {
  const start = SRC.indexOf("function " + name);
  if (start < 0) throw new Error("could not find function " + name + " in server.js");
  // Skip the parameter list first -- counting braces from the first "{" would
  // match a DESTRUCTURED PARAMETER and cut the function in half.
  const afterParams = SRC.indexOf(")", start);
  let depth = 0, i = SRC.indexOf("{", afterParams);
  const open = i;
  for (; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) throw new Error("unbalanced braces lifting " + name);
  return SRC.slice(start, i + 1);
}

function constFrom(name) {
  const m = SRC.match(new RegExp("^const " + name + "\\s*=\\s*[^;]+;", "m"));
  if (!m) throw new Error("could not find const " + name);
  return m[0];
}

const quiet = { log() {}, warn() {}, error() {} };
let build;
try {
  build = new Function("console", [
    constFrom("FORWARD_REPORTS"),
    constFrom("NO_DATE_REPORTS"),
    constFrom("DEFAULT_WINDOW_DAYS"),
    liftFn("parseToISO"),
    liftFn("buildMetabaseParams"),
    "return buildMetabaseParams;",
  ].join("\n"))(quiet);
} catch (e) {
  console.error("FAILED to lift buildMetabaseParams: " + e.message);
  process.exit(1);
}

// A guard that DIES instead of failing by name has not told anyone what broke,
// so every call goes through here.
function windowOf(query, reportType) {
  let params;
  try {
    params = build(query, reportType, "org-uuid");
  } catch (e) {
    return { threw: e.message };
  }
  const out = {};
  for (const p of params) {
    const tag = p.target && p.target[1] && p.target[1][1];
    if (tag === "start_date" || tag === "end_date") out[tag] = p.value;
  }
  return out;
}

const DAYS = Number(constFrom("DEFAULT_WINDOW_DAYS").match(/=\s*(\d+)/)[1]);
function shift(iso, days) {
  return new Date(new Date(iso + "T00:00:00Z").getTime() + days * 86400000).toISOString().slice(0, 10);
}

// ── 1. A half-open window is BOUNDED, not passed through ────────────────────
// This is the bug exactly as Marina hit it.
{
  const w = windowOf({ start_date: "2026-08-01" }, "products");
  eq(w.start_date, "2026-08-01", "a supplied start is never moved");
  ok(!!w.end_date, "start_date alone MUST get an end_date -- without one the card's optional [[ ]] block drops out and the report runs through today");
  eq(w.end_date, shift("2026-08-01", DAYS), "the missing end is bounded DEFAULT_WINDOW_DAYS after the start we were given");
}
{
  const w = windowOf({ end_date: "2026-08-31" }, "products");
  eq(w.end_date, "2026-08-31", "a supplied end is never moved");
  ok(!!w.start_date, "end_date alone MUST get a start_date -- without one the report runs from the beginning of the org's history");
  eq(w.start_date, shift("2026-08-31", -DAYS), "the missing start is bounded DEFAULT_WINDOW_DAYS before the end we were given");
}

// Both directions, on the report the defect was reported against.
for (const rt of ["products", "gl", "facility", "roster", "programs", "memberships"]) {
  const a = windowOf({ start_date: "2026-08-01" }, rt);
  ok(!!a.start_date && !!a.end_date, rt + ": start-only must come back with both bounds");
  const b = windowOf({ end_date: "2026-08-31" }, rt);
  ok(!!b.start_date && !!b.end_date, rt + ": end-only must come back with both bounds");
}

// ── 2. IT CANNOT INVERT, which is why the span is anchored on the bound we
// were given rather than on today. "Missing end means today" is the tempting
// rule and it is wrong for a FORWARD report: a facility window starting in
// December would be handed an end date in September and return nothing.
{
  const far = "2126-12-01";
  for (const rt of ["facility", "calendar", "roster", "historic", "programs-schedule"]) {
    const w = windowOf({ start_date: far }, rt);
    ok(w.end_date >= w.start_date, rt + ": a forward window starting in the future must not be given an end date BEFORE its start");
  }
  const past = "1999-01-05";
  for (const rt of ["products", "gl"]) {
    const w = windowOf({ end_date: past }, rt);
    ok(w.start_date <= w.end_date, rt + ": a backward window ending long ago must not be given a start date AFTER its end");
  }
}

// ── 3. THE BOTH-BLANK CASE IS UNTOUCHED, and that distinction is the whole
// design. Blank-both is a deliberate, shipped state: waitlist is in
// NO_DATE_REPORTS, opens all-time and carries its own "Clear dates" button,
// and elsewhere blank-both hits the server's own 7-day default. Tightening
// this into "no blank dates" would empty the waitlist report for every org.
{
  const w = windowOf({}, "waitlist");
  eq(w.start_date, undefined, "waitlist with no dates must stay ALL-TIME -- it is in NO_DATE_REPORTS and has a 'Clear dates' button");
  eq(w.end_date, undefined, "waitlist with no dates must send no end_date either");
  for (const rt of Array.from(new Function(constFrom("NO_DATE_REPORTS") + "; return NO_DATE_REPORTS;")())) {
    const b = windowOf({}, rt);
    ok(b.start_date === undefined && b.end_date === undefined, rt + " is in NO_DATE_REPORTS: a blank window must send no date parameters at all");
  }
}
{
  const w = windowOf({}, "products");
  ok(!!w.start_date && !!w.end_date, "a dated report with no dates still gets the server's own default window");
  eq(shift(w.start_date, DAYS), w.end_date, "the default window still spans DEFAULT_WINDOW_DAYS");
}

// NO_DATE_REPORTS says what a BLANK window means. It says nothing about a
// half-open one, which no report has ever wanted -- so the backstop applies
// there too.
{
  const w = windowOf({ start_date: "2026-08-01" }, "waitlist");
  ok(!!w.end_date, "a half-open window is bounded even on a NO_DATE report -- that set governs the BLANK case only");
}

// ── 4. A complete window is passed through untouched ────────────────────────
{
  const w = windowOf({ start_date: "2026-08-01", end_date: "2026-08-31" }, "products");
  eq(w.start_date, "2026-08-01", "a complete window's start is passed through unchanged");
  eq(w.end_date, "2026-08-31", "a complete window's end is passed through unchanged");
}
{
  // The inverted case belongs to the client (the page refuses to run it). The
  // server must not silently "repair" it into a window nobody asked for.
  const w = windowOf({ start_date: "2026-08-31", end_date: "2026-08-01" }, "products");
  eq(w.start_date, "2026-08-31", "an inverted window is NOT rewritten by the server");
  eq(w.end_date, "2026-08-01", "an inverted window's end is left alone too");
}

// ── 5. An unreadable bound is passed through, never built on ────────────────
// Inventing a range around a date we could not read would put a confident
// window on a report whose input was garbage.
{
  const w = windowOf({ start_date: "not-a-date" }, "products");
  ok(!w.threw, "an unreadable bound must not throw");
  eq(w.end_date, undefined, "an unreadable start must NOT have a window invented around it");
}

// ── 6. An empty string is a missing date, not a supplied one ────────────────
// The pages omit a blank date from the query string, but a saved view or a
// hand-built link can carry "start_date=".
{
  const w = windowOf({ start_date: "2026-08-01", end_date: "" }, "products");
  ok(!!w.end_date, "end_date='' is MISSING, not supplied -- it must be bounded like an absent one");
  eq(w.end_date, shift("2026-08-01", DAYS), "an empty end_date is bounded the same way an absent one is");
}
{
  const w = windowOf({ start_date: "", end_date: "" }, "waitlist");
  eq(w.start_date, undefined, "both empty is still the blank-both case, not a half-open one");
}

// ── 7. The anchor is the NORMALISED date, and it is pinned to UTC ──────────
// parseToISO runs first, so the bound reaching the anchor is always
// YYYY-MM-DD -- and an ISO date string is UTC midnight by spec whatever the
// server's zone is. That is why a US timezone CANNOT discriminate here: the
// two derivations agree in every zone behind UTC, which is the decorative
// timezone pin this repo has already shipped once.
//
// A zone EAST of UTC is what separates them, and only for an input parseToISO
// had to normalise: new Date("08/01/2026") is LOCAL midnight, which in Tokyo
// is the previous day in UTC. So the spec re-execs under Asia/Tokyo -- chosen
// for that property, not because an org is in it -- and drives a non-ISO bound.
{
  const w = windowOf({ start_date: "08/01/2026" }, "products");
  eq(w.start_date, "2026-08-01", "a non-ISO bound is normalised before anything is built from it (TZ=" + (process.env.TZ || "unset") + ")");
  eq(w.end_date, "2026-08-08", "the window is anchored on the NORMALISED bound, not on a local-midnight parse of the raw one (TZ=" + (process.env.TZ || "unset") + ")");
  const b = windowOf({ end_date: "08/31/2026" }, "products");
  eq(b.start_date, "2026-08-24", "the same, in the other direction (TZ=" + (process.env.TZ || "unset") + ")");
}

// ── 8. Source assertions: the shape that made this survivable ───────────────
{
  const fn = liftFn("buildMetabaseParams");
  ok(/!query\.start_date\s*&&\s*!query\.end_date/.test(fn),
     "the both-blank branch must still be a BOTH test -- widening it to 'either missing' would empty the waitlist report for every org");
  ok(/else if/.test(fn),
     "the half-open branch must be an ELSE of the both-blank one, or the two conditions can both fire and the defaults fight");
  ok(!/new Date\(\s*query\.(start|end)_date\s*\)/.test(fn),
     "a bound must never be parsed with a bare new Date(query.x) -- that is local-midnight and slips a day west of UTC");
  ok(/T00:00:00Z/.test(fn),
     "the anchor must be pinned to UTC explicitly");
  ok(/isNaN/.test(fn),
     "an unreadable bound must be detected, not built on");
}

// The backstop is worth nothing if the two routes that can receive a half-open
// window stop going through it. Both derive their CACHE KEY from the same call,
// so a filled-in date shifts the key consistently at fetch and at lookup.
{
  const callers = (SRC.match(/buildMetabaseParams\(\s*req\.query/g) || []).length;
  ok(callers >= 2, "the data route and the facilities summary must both still build their parameters from req.query (found " + callers + ")");
}

// ── Timezone re-exec ────────────────────────────────────────────────────────
// The sentinel is an explicit env flag, NOT a test of TZ itself: checking
// whether TZ "looks Pacific" is how a re-exec becomes an infinite loop, because
// "America/Los_Angeles" does not contain the word the test was looking for.
if (!process.env.REC_WINDOW_SPEC_TZ_CHILD) {
  const { spawnSync } = require("child_process");
  const r = spawnSync(process.execPath, [__filename], {
    stdio: "inherit",
    env: Object.assign({}, process.env, { TZ: "Asia/Tokyo", REC_WINDOW_SPEC_TZ_CHILD: "1" }),
  });
  if (r.status !== 0) failures.push("the spec FAILED under TZ=Asia/Tokyo (a zone AHEAD of UTC, where a local-midnight parse lands on the previous UTC day -- a zone behind UTC cannot discriminate here)");
}

if (failures.length) {
  console.error("\n" + failures.length + " assertion(s) FAILED:");
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(passed + " assertions passed.");
