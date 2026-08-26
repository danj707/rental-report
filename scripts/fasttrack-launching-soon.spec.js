// Spec for WHICH triage bucket a program lands in, and in what order Launching
// Soon ranks what it holds.
//
// The bug this pins, measured against production on 2026-08-26:
//
//   Smyrna's Concert Series carried 314 fast-trackers across two sections about
//   to go live — the largest pre-launch demand on the platform. Its Select Table
//   had 203 people waiting on 45 seats and opened three minutes after the feed
//   was pulled. It did not appear in Launching Soon at all, because the bucket
//   chain tested `_launch` THIRD, behind two capacity tests reading program-WIDE
//   figures. At 184.3% demand with 169 spots left against 574 pending it tripped
//   the second one and was filed under Needs Capacity — which renders beneath
//   the heading "Registration Open · Programs where families can register now",
//   for a section whose Reg Status was `pipeline`.
//
//   It was the ONLY one of Smyrna's 19 launching programs this happened to. Every
//   other one sits under 58% demand, so the test fires precisely on the programs
//   Launching Soon exists to surface.
//
// Run: node scripts/fasttrack-launching-soon.spec.js
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PAGE = path.join(__dirname, "..", "public", "fasttrack.html");
const src = fs.readFileSync(PAGE, "utf8");

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

/* ── Slice the decider and the ranking out of the page ─────────────────────
   The page builds a React tree at module scope, so it cannot be evaluated
   whole. Both of these are deliberately module-scope so this spec can drive
   the real code rather than restate it — see the comment above triageBucket. */

const bStart = src.indexOf("function triageBucket(p, spotsLeft)");
ok(bStart > 0, "fasttrack.html should declare triageBucket at MODULE scope — "
  + "inside TriagePanel it can only be regexed, and a regex over our own patch "
  + "is not evidence the page behaves");
const bEnd = src.indexOf("/* ── Actionable Triage Panel ── */", bStart);
ok(bEnd > bStart, "the Triage Panel should follow triageBucket");

const sandbox = {
  fmtInt: v => String(Math.round(Number(v) || 0)),
  dayPhrase: d => (d == null ? "" : d <= 0 ? "today" : d === 1 ? "tomorrow" : "in " + d + " days"),
  Math: Math,
};
vm.createContext(sandbox);
vm.runInContext(src.slice(bStart, bEnd), sandbox);
const { triageBucket } = sandbox;

// The ranking comparator, lifted from PipelineLaunchSection's own sort.
const sStart = src.indexOf("function PipelineLaunchSection(props)");
ok(sStart > 0, "fasttrack.html should declare PipelineLaunchSection");
const sortSrc = src.slice(sStart, src.indexOf("if (!items.length) return null;", sStart));
const sortBody = sortSrc.slice(sortSrc.indexOf("sort(function(a, b) {"));
const cmpBox = {};
vm.createContext(cmpBox);
vm.runInContext("var cmp = function(a, b) {"
  + sortBody.slice(sortBody.indexOf("{") + 1, sortBody.lastIndexOf("}")) + "};", cmpBox);
const cmp = cmpBox.cmp;

/* ── The real shapes, from the live card ───────────────────────────────────
   Numbers are production values for Smyrna on 2026-08-26T13:57Z. */

const AT_2PM = new Date("2026-08-26T14:00:00.000Z");

// Concert Series: 6 sections, of which TWO have not opened (Select, General)
// and FOUR are spent (Premier and Preferred already in early access, plus the
// June and July summer concerts at 100 capacity each — 200 of the program's 353).
const CONCERT = {
  program: "Concert Series",
  ftSignups: 645, ftPending: 574, ftConverted: 71, convPct: 29.8,
  capacity: 350, totalEnrolled: 181, demandPct: 184.3,
  _launch: [{ section: "Select Table", ftSignups: 203 }, { section: "General Table", ftSignups: 111 }],
  _launchFt: 314, _launchPending: 314, _launchCapacity: 95,
  _launchOpens: AT_2PM, _launchDays: 0, _launchKind: "early",
};
const LAP = {
  program: "Lap Swimming", ftSignups: 1367, ftPending: 212, ftConverted: 1157, convPct: 84.6,
  capacity: 2522, totalEnrolled: 2083, demandPct: 54.2,
  _launch: new Array(27).fill({ ftSignups: 3 }),
  _launchFt: 85, _launchPending: 85, _launchCapacity: 135,
  _launchOpens: AT_2PM, _launchDays: 0, _launchKind: "early",
};

/* ── 1. THE REPORTED BUG ───────────────────────────────────────────────────
   Concert Series must reach Launching Soon, and NOT Needs Capacity. */

const cv = triageBucket(CONCERT, Math.max(0, CONCERT.capacity - CONCERT.totalEnrolled));
eq(cv.bucket, "readyToOpen",
  "A PROGRAM WITH A SECTION THAT HAS NOT OPENED BELONGS IN LAUNCHING SOON. "
  + "Concert Series (314 pre-launch FT, 203 of them on one 45-seat table opening "
  + "in minutes) was filed under Needs Capacity because the capacity tests ran "
  + "first on program-wide figures — so the biggest pre-launch demand on the "
  + "platform never appeared in the panel that exists to show it.");
ok(/Registration opens today/.test(cv.action),
  "...and its instruction says when it opens, not that it needs more spots");
ok(!/May need more spots/.test(cv.action),
  "...so the reader is not told to add capacity to something not yet on sale");

// The capacity tests DO both fire on this program. That is the whole reason the
// order matters: this is not a program that merely happened to miss them.
ok(CONCERT.demandPct > 90 && (CONCERT.capacity - CONCERT.totalEnrolled) < CONCERT.ftPending,
  "the demand test genuinely fires on Concert Series — reordering is what fixes "
  + "it, not a threshold that no longer matches");

/* ── 2. The capacity buckets still work for programs that ARE open ─────────
   Reordering must not silence the signal it was moved behind. */

const soldOut = { program: "Sold Out", ftSignups: 40, ftPending: 12, convPct: 70,
                  capacity: 20, totalEnrolled: 20, demandPct: 200, _launch: [] };
eq(triageBucket(soldOut, 0).bucket, "needsCapacity",
  "a program with no launching sections and no spots left is still Needs Capacity");
ok(/No spots left/.test(triageBucket(soldOut, 0).action), "...with its own instruction");

const oversub = { program: "Oversubscribed", ftSignups: 100, ftPending: 60, convPct: 40,
                  capacity: 100, totalEnrolled: 50, demandPct: 100, _launch: [] };
eq(triageBucket(oversub, 50).bucket, "needsCapacity",
  "the demand test still fires when nothing is pre-launch");
ok(/Demand at 100%/.test(triageBucket(oversub, 50).action), "...naming the demand");

const stalled = { program: "Stalled", ftSignups: 9, ftPending: 9, convPct: 0,
                  capacity: 40, totalEnrolled: 0, demandPct: 22.5, _launch: [] };
eq(triageBucket(stalled, 40).bucket, "stalled", "stalled is unchanged");
const winning = { program: "Winning", ftSignups: 30, ftPending: 2, convPct: 88,
                  capacity: 40, totalEnrolled: 30, demandPct: 75, _launch: [] };
eq(triageBucket(winning, 10).bucket, "convertingWell", "convertingWell is unchanged");
eq(triageBucket(winning, 10).action, null,
  "convertingWell carries no instruction, so a stale one is never left on screen");
const quiet = { program: "Quiet", ftSignups: 1, ftPending: 1, convPct: 10,
                capacity: 40, totalEnrolled: 1, demandPct: 2.5, _launch: [] };
eq(triageBucket(quiet, 39).bucket, null, "a program with nothing to say is in no bucket");

/* ── 3. A pre-launch program is never filed under "Registration Open" ──────
   Both capacity buckets render beneath that heading, so this is a correctness
   claim about the page's copy, not only about ranking. */

const heading = src.indexOf("Programs where families can register now");
ok(heading > 0, "the capacity buckets still render under a 'register now' heading");
const capBucket = src.indexOf("label: 'Needs Capacity'");
ok(capBucket > heading,
  "Needs Capacity sits under that heading — which is why a program holding an "
  + "unopened section must not be routed there");

/* ── 4. Launching Soon ranks on the go-live INSTANT, then on headcount ─────
   Calendar days tie everything opening today, so a program opening at 11pm
   would outrank one opening in three minutes purely on FT. */

eq(cmp(CONCERT, LAP) < 0, true,
  "at the same instant the bigger cohort leads: Concert Series' 314 above Lap "
  + "Swimming's 85 — which is Dan's ask, that it be flagged #1 up top");

const later = Object.assign({}, LAP, { _launchOpens: new Date("2026-08-26T23:00:00.000Z"), _launchFt: 9999 });
eq(cmp(CONCERT, later) < 0, true,
  "SOONEST WINS OVER BIGGEST: a 9,999-strong cohort opening tonight does not "
  + "outrank one opening in three minutes. Ranking on _launchDays ties both at 0 "
  + "and lets headcount decide.");

const earlier = Object.assign({}, LAP, { _launchOpens: new Date("2026-08-26T13:59:00.000Z"), _launchFt: 1 });
eq(cmp(earlier, CONCERT) < 0, true, "...and one minute earlier really is sooner");

const noDate = Object.assign({}, LAP, { _launchOpens: null, _launchDays: null });
eq(cmp(CONCERT, noDate) < 0, true, "a program with no known go-live sorts last, not first");
ok(!/a\._launchDays == null \? 1e9/.test(sortSrc),
  "the comparator no longer ranks on calendar days");

console.log(`✓ fasttrack-launching-soon.spec.js — ${n} assertions passed`);
