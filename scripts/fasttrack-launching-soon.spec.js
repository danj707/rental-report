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

/* PIN THE TIMEZONE. The go-live block below asserts formatted times, and
   this sandbox and GitHub Actions both run UTC — where a date resolved in
   one zone and a time resolved in another agree all day, so a UTC-only
   assertion cannot see the bug. Eastern is behind UTC, so an evening
   instant is already tomorrow in UTC and the two diverge. Same reasoning
   as fasttrack-dates.spec.js. */
const TZ = "America/New_York";
if (process.env.TZ !== TZ) {
  const r = require("child_process").spawnSync(process.execPath, [__filename],
    { env: Object.assign({}, process.env, { TZ }), stdio: "inherit" });
  process.exit(r.status == null ? 1 : r.status);
}

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

// ── Launching Soon leads the Overview (Dan, 2026-08-26) ────────────────────
// "That section should be at the top, above the 'just launched'." What has not
// opened yet is the only thing on the page whose outcome can still change; a
// section that launched three days ago is a report, one launching tomorrow is
// a decision.

{
  const overviewAt = src.indexOf("activeTab === 'overview'");
  ok(overviewAt > 0, "the Overview tab render should be findable");
  const launchAt = src.indexOf("PipelineLaunchSection", overviewAt);
  const justAt   = src.indexOf("\u{1F525} Just Launched", overviewAt);
  ok(launchAt > 0, "Launching Soon should render inside the Overview");
  ok(justAt > 0, "Just Launched should render inside the Overview");
  ok(launchAt < justAt,
    "Launching Soon must render ABOVE Just Launched — an upcoming launch is " +
    "actionable, one that already happened is not");
}

// The buckets are computed ONCE, at module scope, because two callers now read
// them (the Overview for Launching Soon, TriagePanel for the rest). Two copies
// drift the first time a bucket rule changes — the triageBucket() lesson again.
ok(/^function triageBuckets\(programs, now\) \{/m.test(src),
  "triageBuckets should be a module-scope function, not inlined in TriagePanel");
eq((src.match(/var buckets = \{ needsCapacity: \[\], readyToOpen: \[\], stalled: \[\], convertingWell: \[\] \}/g) || []).length, 1,
  "the bucket set must be built in exactly one place");

// TriagePanel must NOT also render Launching Soon, or it appears twice.
{
  const tp = src.slice(src.indexOf("function TriagePanel(props)"));
  const body = tp.slice(0, tp.indexOf("\nfunction "));
  eq((body.match(/PipelineLaunchSection/g) || []).length, 0,
    "TriagePanel must not render Launching Soon as well — that renders it twice");
  ok(!/needsAttention = buckets\.needsCapacity\.length \+ buckets\.readyToOpen\.length/.test(body),
    "readyToOpen must not count toward TriagePanel's own emptiness test, or a " +
    "pipeline-only org renders an empty panel under the section that moved out");
}

// ── The pin is a control, not a ghost ──────────────────────────────────────
// It already existed on Launching Soon and Dan still asked for "an option to
// pin the upcoming launches" — the report telling us a 35%-opacity bare emoji
// is not a discoverable affordance.
ok(/className: 'pin-toggle'[^,]*\+ \(showLabel \? ' pin-labelled' : ''\)/.test(src),
  "PinBtn should have a labelled form");
ok(/\.pin-toggle\.pin-labelled \{[^}]*opacity: 1/.test(src),
  "the labelled pin must be fully opaque at rest — that is the whole fix");
ok(/'aria-pressed': on \? 'true' : 'false'/.test(src),
  "a toggle should report its state to assistive tech");
ok(/label: false/.test(src),
  "the tight Cold Sections row should keep the icon-only form");


/* ══════════════════════════════════════════════════════════════════════════
   THE GO-LIVE TIME. Launching Soon sorts on the go-live INSTANT with headcount
   only as a tie-break, and every chip printed CALENDAR DAYS — so four cohorts
   opening at different times on one date all read "OPENS IN 2 DAYS" and the
   ordering looked arbitrary. Measured at Needham (2026-08-31): Senior Exercise,
   Senior Yoga and Senior Strength & Balance all go live Sep 2 09:00 ET on their
   early-access windows, while Adult Badminton — carrying 19 fast-trackers
   against their 4, 4 and 2 — goes live Sep 2 12:00 ET on its general one. The
   sort was right; the display could not show why.

   The time is real data, not midnight boilerplate: of ~2,030 registration
   windows opening in the future platform-wide, only 5 sit at UTC midnight, and
   the modes are 16:00 UTC (620 windows), 15:00 (391) and 14:00 (369).

   This LIFTS AND RUNS both formatters rather than regexing them, and it runs
   under a NON-UTC zone — see the re-exec at the top of this block. In UTC a
   date resolved in one zone and a time resolved in another agree all day, so a
   UTC-only assertion cannot see the bug it is here to catch.
   ══════════════════════════════════════════════════════════════════════════ */
{
  const fmtCtx = {};
  vm.createContext(fmtCtx);
  for (const name of ["fmtGoLive", "fmtTimeShort"]) {
    const s = src.indexOf("function " + name + "(");
    ok(s > 0, name + " should be declared at MODULE scope so this spec can RUN it");
    let depth = 0, i = src.indexOf("{", s);
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") { depth--; if (depth === 0) break; }
    }
    vm.runInContext(src.slice(s, i + 1), fmtCtx);
  }
  const { fmtGoLive, fmtTimeShort } = fmtCtx;

  // Needham's real pair, as instants. 13:00Z is 09:00 EDT, 16:00Z is 12:00 EDT.
  const early   = new Date("2026-09-02T13:00:00Z");
  const general = new Date("2026-09-02T16:00:00Z");

  ok(/\d{1,2}:\d{2}\s?(AM|PM)/i.test(fmtGoLive(early)),
    "fmtGoLive must print a TIME — printing the date alone is the bug: "
    + JSON.stringify(fmtGoLive(early)));
  ok(fmtGoLive(early) !== fmtGoLive(general),
    "two cohorts opening the same DAY at different times must not format identically — "
    + "that is exactly what made a correct sort look arbitrary");

  // The zone abbreviation. These are timestamptz rendered in the READER's
  // browser zone, so a Needham admin sees 9:00 AM EDT and a Californian sees
  // 6:00 AM PDT for the same instant. Both true; "9:00 AM" bare is a number two
  // people would disagree about while looking at one screen.
  ok(/\b[A-Z]{2,5}\b\s*$/.test(fmtGoLive(early)),
    "fmtGoLive must name the timezone it resolved in: " + JSON.stringify(fmtGoLive(early)));

  // ONE toLocaleString call. Composing the date and the time from two calls lets
  // them resolve in different zones, and then a card prints Sep 2 beside a time
  // belonging to Sep 3. Pinned by VALUE under a known zone rather than by
  // counting calls, because the value is what a reader sees.
  if (process.env.TZ === "America/New_York") {
    eq(fmtGoLive(early), "Sep 2, 9:00 AM EDT",
      "fmtGoLive under America/New_York");
    eq(fmtGoLive(general), "Sep 2, 12:00 PM EDT",
      "fmtGoLive under America/New_York, the later window");
    eq(fmtTimeShort(early), "9:00 AM", "fmtTimeShort is the bare time");
    // THE CROSS-MIDNIGHT CASE, which is why the zone is forced. This instant is
    // Sep 2 in UTC and Sep 1 in Eastern, so a date and a time resolved in
    // different zones disagree by a day here and nowhere else in this block.
    const late = new Date("2026-09-02T01:00:00Z");
    eq(fmtGoLive(late), "Sep 1, 9:00 PM EDT",
      "an instant that is tomorrow in UTC must print ONE consistent local day");
  }

  ok(fmtGoLive(null) === "" && fmtTimeShort(null) === "",
    "a missing go-live formats to nothing rather than throwing — the facility "
    + "feed can carry a null and a formatter that throws blanks the tab");

  /* EVERY go-live display carries a time. The panel that reads worst is not
     necessarily the one being edited: leaving one surface on a bare date makes
     it disagree with the card above it about the same section, which is worse
     than either alone. These are the five sites. */
  const GOLIVE_SITES = [
    [/Early access opens ' : 'Reg opens '\)\s*\n?\s*\+ fmtGoLive\(rt\.nextOpen\)/,
      "the section countdown line"],
    [/'Early access ' : 'Reg opens '\)\s*\n?\s*\+ fmtGoLive\(opens\)/,
      "the Launching Soon chip sub-line"],
    [/\+ fmtDateShort\(od\) \+ ' ' \+ fmtTimeShort\(od\)/,
      "the per-section rows on a Launching Soon card"],
    [/\+ fmtGoLive\(sectionGoLive\(r\)\.at\)/,
      "the Cold Sections pill"],
    [/fmtDateShort\(glc\.at\) \+ ' ' \+ fmtTimeShort\(glc\.at\)/,
      "the flow board's pre-launch label"],
    [/general registration opens '\s*\n?\s*\+ \(r\.regOpens \? fmtGoLive\(new Date\(r\.regOpens\)\)/,
      "the early-access tooltip"],
  ];
  for (const [rx, what] of GOLIVE_SITES) {
    ok(rx.test(src), what + " must print the go-live TIME, not the date alone");
  }

  // And the attribute a render case can key on, so the browser half asserts the
  // ORDER against the real instants rather than against rendered prose.
  ok(/'data-launch-golive': opens\.toISOString\(\)/.test(src),
    "the Launching Soon chip should carry its go-live instant as an attribute");
}

console.log(`✓ fasttrack-launching-soon.spec.js — ${n} assertions passed`);
