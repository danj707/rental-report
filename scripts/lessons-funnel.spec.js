#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// LESSONS — Acquisition funnel + Retention/LTV
//
// It LIFTS AND RUNS the two aggregators rather than regexing them: every
// defect this change can have is arithmetic about counts and rates, and a
// regex passes on an inverted comparison. The card mirrors are read as
// text, because the things that break there (an org filter on the wrong
// column, a lost ORDER BY) are textual.
// ═══════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const SERVER = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const PAGE = fs.readFileSync(path.join(ROOT, "public", "lessons.html"), "utf8");
const ACQ_SQL = fs.readFileSync(path.join(ROOT, "sql", "report-cards", "21847-lessons-acquisition.sql"), "utf8");
const RET_SQL = fs.readFileSync(path.join(ROOT, "sql", "report-cards", "21848-lessons-retention.sql"), "utf8");
// EVERY "must not appear" ASSERTION READS THE CODE, NOT THE COMMENTS. Both
// cards quote the forbidden forms deliberately — `r.organization_id` and the
// old name regex are named in their headers as the traps they are — so an
// assertion over the raw file fails on correct SQL. Nth instance in this repo.
const strip = sql => sql.split("\n").filter(l => !/^\s*--/.test(l)).join("\n");
const ACQ_CODE = strip(ACQ_SQL), RET_CODE = strip(RET_SQL);

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ " + msg); } }
function eq(a, b, msg) { ok(a === b, msg + " (got " + JSON.stringify(a) + ", want " + JSON.stringify(b) + ")"); }

// ── lift helpers ───────────────────────────────────────────────────
// Bounded by the function's own end, never a fixed-length slice: a fixed
// slice stops covering the tail of a function the moment anything is
// added to it, and then passes by not reaching the code it names.
function liftFn(src, name) {
  const decl = "function " + name + "(";
  const at = src.indexOf(decl);
  assert(at >= 0, "cannot find " + name);
  let i = src.indexOf("{", src.indexOf(")", at));   // skip the parameter list
  let depth = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) break; }
  }
  return src.slice(at, j + 1);
}

// The aggregators close over three small helpers declared above them.
const DEPS = ["lfMonth", "lfIn", "lfPct"].map(n => {
  const m = new RegExp("const " + n + " = [^\\n]+").exec(SERVER);
  assert(m, "cannot find " + n);
  return m[0];
}).join("\n") + "\n" + liftFn(SERVER, "lfQuantile");

const sandbox = new Function(DEPS + "\n" + liftFn(SERVER, "lessonsAcquisition") + "\n" +
  liftFn(SERVER, "lessonsRetention") + "\nreturn { lessonsAcquisition, lessonsRetention };")();
const { lessonsAcquisition, lessonsRetention } = sandbox;

const lsEffectiveTab = new Function(
  /const LS_TABS = \[[^\]]+\];/.exec(PAGE)[0] + "\n" +
  liftFn(PAGE, "lsEffectiveTab") + "\nreturn lsEffectiveTab;")();

// ═══ 1. THE INQUIRY FUNNEL ═════════════════════════════════════════
// The fixture makes every rate DIFFERENT on purpose, and none of them a
// round number that another implementation could land on by accident.
const inq = (date, status, b30, same30, prior) =>
  ({ Instructor: "Ada", Date: date, Status: status, "Booked 30d": !!b30,
     "Booked 90d": !!b30, "Booked Same 30d": !!same30, "Prior Customer": !!prior });

const ACQ_ROWS = [
  // in-window: 4 ACCEPTED (3 booked = 75%), 10 PENDING (2 booked = 20%)
  ...Array.from({ length: 4 }, (_, i) => inq("2026-03-0" + (i + 1), "ACCEPTED", i < 3, i < 2, i < 1)),
  ...Array.from({ length: 10 }, (_, i) => inq("2026-03-1" + (i % 10), "PENDING", i < 2, false, false)),
  inq("2026-03-20", "REJECTED", false, false, false),
  inq("2026-03-21", "CANCELED", true, false, false),
  // OUT of window — must not reach totals, but MUST reach the monthly series
  inq("2024-01-05", "ACCEPTED", true, true, false),
  inq("2024-01-06", "PENDING", false, false, false),
];
{
  const a = lessonsAcquisition(ACQ_ROWS, "2026-01-01", "2026-12-31");
  eq(a.totals.inquiries, 16, "window totals exclude out-of-window rows");
  eq(a.totals.accepted, 4, "accepted counted");
  eq(a.totals.pending, 10, "pending counted");
  eq(a.totals.acceptedBooked30Pct, 75, "accepted → booked rate");
  eq(a.totals.pendingBooked30Pct, 20, "pending → booked rate");
  // 10 pending × (75 − 20)pp = 5.5 → 6
  eq(a.totals.liftGap, 6, "the lift gap is stated as a COUNT of inquiries");
  // A DECLINE IS AN ANSWER. An instructor who says no has replied, and
  // folding declines into "never answered" would flatter the reply rate
  // of anyone who declines a lot.
  eq(a.totals.answered, 5, "answered = accepted + declined, not accepted alone");
  eq(a.totals.neverAnsweredPct, 62.5, "never-answered share");

  // THE MONTHLY SERIES IS ALL-TIME, deliberately: a reply rate is only
  // readable as a trend, and one month draws one bar.
  eq(a.monthly.length, 2, "the monthly series spans the card, not the window");
  eq(a.monthly[0].month, "2024-01", "monthly series is sorted oldest first");
  eq(a.monthly[0].answered, 1, "an out-of-window month still reports its answered count");
}
{
  // NULL, NEVER 0, when there is nothing to divide by. "No accepted
  // inquiries yet" and "accepted inquiries never convert" are different
  // facts, and a confident 0% is the one that gets quoted.
  const a = lessonsAcquisition([inq("2026-03-01", "PENDING", false)], "2026-01-01", "2026-12-31");
  eq(a.totals.acceptedBooked30Pct, null, "no accepted inquiries reports null, not 0%");
  eq(a.totals.liftGap, null, "no lift gap can be computed without both rates");
}
{
  const a = lessonsAcquisition([], "2026-01-01", "2026-12-31");
  eq(a.totals.inquiries, 0, "an empty feed is a real answer, not a crash");
  eq(a.totals.neverAnsweredPct, null, "an empty feed reports null, not 0%");
}

// ═══ 2. RETENTION AND LTV ══════════════════════════════════════════
const bk = (cust, date, net, status, channel) =>
  ({ Instructor: "Ada", Date: date, Status: status || "Active", Customer: cust,
     Net: net, Channel: channel || "self", "Fast Track": false });

// Three customers with deliberately DIFFERENT shapes, so a mean cannot be
// confused with a median and a customer count cannot be a row count:
//   alice  3 lessons, $300   (repeat, 2nd lesson 5 days later)
//   bob    1 lesson,  $50    (one and done)
//   cara   2 lessons, $400   (repeat, 2nd lesson 40 days later)
// plus a CANCELLED booking that must count nowhere but the cancel total.
const RET_ROWS = [
  bk("alice", "2026-01-01", 100), bk("alice", "2026-01-06", 100), bk("alice", "2026-02-10", 100),
  bk("bob", "2026-01-15", 50, "Active", "staff"),
  bk("cara", "2026-01-20", 200), bk("cara", "2026-03-01", 200),
  bk("dan", "2026-01-25", 999, "Canceled"),
];
{
  const r = lessonsRetention(RET_ROWS, "2026-01-01", "2026-12-31");
  eq(r.totals.bookings, 7, "every row is counted as a booking");
  eq(r.totals.live, 6, "cancelled bookings are excluded from the live set");
  eq(r.totals.canceled, 1, "...and reported, so the exclusion is visible");
  // A CANCELLED BOOKING MUST NOT MINT A CUSTOMER. dan appears only on a
  // cancellation, so counting him would inflate the denominator of every
  // rate on the tab and deflate the mean LTV with a $0 customer.
  eq(r.totals.customers, 3, "a customer known only from a cancellation is not a customer");
  eq(r.totals.net, 750, "net excludes the cancelled booking's money");
  eq(r.totals.meanLtv, 250, "mean LTV over customers, not over bookings");
  eq(r.totals.medianLtv, 300, "median LTV is a percentile, not the mean");
  eq(r.totals.repeat, 2, "repeat customers");
  eq(r.totals.oneAndDone, 1, "one-and-done customers");
  eq(r.totals.repeatPct, 66.7, "repeat share");
  eq(r.totals.meanLtvRepeat, 350, "mean LTV of repeat customers");
  eq(r.totals.meanLtvOnce, 50, "mean LTV of one-and-done customers");
  // The gaps are 5 and 40 days, so the median is 22.5 — a value neither
  // customer has, which is what makes this assertion discriminate.
  eq(r.totals.medianDaysToSecond, 22.5, "median days to the second lesson");
  eq(r.totals.secondWithin30, 1, "only one second lesson lands inside 30 days");
  eq(r.totals.secondWithin60, 2, "both land inside 60");
  eq(r.totals.meanLessons, 2, "mean lessons per customer");

  // CHANNEL COUNTS EVERY ROW, cancelled included: who pressed the button
  // is a fact about the booking, not about whether it survived.
  eq(r.channel.self, 6, "self-serve channel count");
  eq(r.channel.staff, 1, "staff channel count");
  eq(r.channel.instructor, 0, "the instructor channel is emitted at zero, not omitted");

  // New vs returning, keyed on each customer's FIRST lesson in scope.
  const jan = r.monthly.find(m => m.month === "2026-01");
  eq(jan.newCust, 3, "January is everybody's first month");
  // A CUSTOMER CANNOT BE BOTH NEW AND RETURNING IN ONE MONTH. alice books
  // twice in January and is counted once, as new — "returning" means her
  // first lesson was in an EARLIER month, not that she came back at all.
  // Counting her on both sides would make newCust + returningCust exceed
  // the month's real customer count on every month that has a repeat.
  eq(jan.returningCust, 0, "alice's second January lesson does not also make her a returning customer");
  eq(jan.customers, 3, "...so the month's two sides still sum to its customers");
  const feb = r.monthly.find(m => m.month === "2026-02");
  eq(feb.newCust, 0, "February mints no new customers");
  eq(feb.returningCust, 1, "February is one returning customer");

  // Cohorts are offsets from the customer's own first month.
  const c = r.cohorts.find(x => x.cohort === "2026-01");
  eq(c.size, 3, "the January cohort is three customers");
  eq(c.months[1], 1, "one of them books again in month +1");
  eq(c.months[2], 1, "and one in month +2");
}
{
  // Null, never zero, where a side is empty — same rule as the funnel.
  const r = lessonsRetention([bk("solo", "2026-01-01", 80)], "2026-01-01", "2026-12-31");
  eq(r.totals.meanLtvRepeat, null, "no repeat customers reports null, not $0");
  eq(r.totals.medianDaysToSecond, null, "no second lesson reports null, not 0 days");
  eq(r.totals.oneAndDone, 1, "...while the one-and-done count is real");
}
{
  // THE WINDOW MOVES ONLY THE WINDOWED FIGURES. A lifetime value is a
  // position — current whatever the toolbar says — so narrowing the range
  // must not shrink it. This is the assertion that fails if somebody
  // "fixes" the tab by windowing LTV.
  const wide = lessonsRetention(RET_ROWS, "2026-01-01", "2026-12-31");
  const narrow = lessonsRetention(RET_ROWS, "2026-02-01", "2026-02-28");
  eq(narrow.totals.meanLtv, wide.totals.meanLtv, "LTV does not move with the toolbar");
  eq(narrow.totals.customers, wide.totals.customers, "the customer count does not move with the toolbar");
  eq(narrow.totals.windowBookings, 1, "...but the windowed booking count does");
  eq(wide.totals.windowBookings, 6, "...in both directions");
}

// ═══ 3. THE TAB RESOLVER ═══════════════════════════════════════════
eq(lsEffectiveTab("acquisition"), "acquisition", "a known tab resolves to itself");
eq(lsEffectiveTab("retention"), "retention", "...for every tab");
eq(lsEffectiveTab("overview"), "overview", "...including the landing tab");
eq(lsEffectiveTab("nonsense"), "overview", "an unknown tab lands on Overview, not on nothing");
eq(lsEffectiveTab(""), "overview", "an absent tab lands on Overview");
eq(lsEffectiveTab(null), "overview", "a null tab lands on Overview");

// ═══ 4. THE CARDS ══════════════════════════════════════════════════
// THE TRAP. instructor_reservation_request.organization_id is NULL on
// every row since 2026-05, so a card scoped on it reports the whole
// funnel as zero for the most recent five months.
ok(!/\br\.organization_id\b/.test(ACQ_CODE),
   "the acquisition card must not scope inquiries on r.organization_id — it is NULL since 2026-05");
ok(/FROM instructor i\s*\n\s*JOIN instructor_reservation_request r ON r\.instructor_id = i\.id/.test(ACQ_CODE),
   "the acquisition card resolves the org through the instructor");
ok(/i\.organization_id = \{\{org_id\}\}::uuid/.test(ACQ_SQL),
   "...and that instructor is org-scoped");

for (const [name, sql] of [["acquisition", ACQ_SQL], ["retention", RET_SQL]]) {
  const code = name === "acquisition" ? ACQ_CODE : RET_CODE;
  // The booking predicate is card 17755's, character for character, so
  // the two cards cannot disagree about which bookings exist. SF has 98
  // live `planned` bookings that a bare canceled_at test would fold in.
  ok(/\(\(b\.status = 'confirmed' AND b\.canceled_at IS NULL\)\s*\n?\s*OR b\.canceled_at IS NOT NULL\)/.test(sql),
     name + ": the booking predicate matches card 17755's");
  // A lesson is a section with a FACILITATOR, never a name match.
  ok(/EXISTS \(SELECT 1 FROM section_facilitator sf/.test(sql),
     name + ": a lesson is defined structurally, by the section having a facilitator");
  ok(!/lesson\|clinic\|coaching\|private/.test(code),
     name + ": the card must not use the page's old name regex");
  // NO DATE TAGS. One Text tag means no flip and no push→flip outage.
  ok(!/\{\{start_date\}\}|\{\{end_date\}\}/.test(sql),
     name + ": the card registers no date tags");
  ok(/\{\{org_id\}\}/.test(sql), name + ": the card takes org_id");
  // The trailing ORDER BY is what silently vanished from card 17300.
  ok(/\nORDER BY "Date", "Instructor"\s*$/.test(sql.trimEnd() + "\n"),
     name + ": the trailing ORDER BY survives");
  ok(/AS "Instructor"/.test(sql), name + ": every row carries its instructor, or the filter has nothing to key on");
}
ok(/lb\.customer_user_id::text\s+AS "Customer"/.test(RET_SQL),
   "retention is keyed on the customer id, not on a name that two people can share");
ok(/oi\.booking_id = lb\.id/.test(RET_SQL),
   "the money lateral is driven into order_item_bookingid_index");

// ═══ 5. THE WIRING ═════════════════════════════════════════════════
ok(/NO_DATE_REPORTS = new Set\(\[[^\]]*"lessons-acquisition"[^\]]*"lessons-retention"[^\]]*\]\)/.test(SERVER),
   "both cards are in NO_DATE_REPORTS, or buildMetabaseParams invents a window they cannot take");
// HARDCODED, LIKE EVERY OTHER ENTRY. These were env-gated with
// omit-when-unset only while the public links did not exist (the
// programs-monthly shape); Dan created both on 2026-09-14, so the report
// must now work on deploy with no Railway variable to remember. What the
// assertion is really about is unchanged and is the reason the gate
// existed: a key must NEVER resolve to something falsy, because the route
// would then build a URL with no card id and surface Metabase's own error
// — which reads as a broken report rather than an unfinished one. A
// literal fallback is strictly stronger than the old shape, since there
// is no longer an unset case at all. The env override stays so a preview
// can point at a scratch card.
const UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
ok(new RegExp('"lessons-acquisition":\\s*process\\.env\\.MB_LESSONS_ACQ_UUID \\|\\| "' + UUID_RE + '"').test(SERVER),
   "the acquisition uuid falls back to a real public uuid, never to nothing");
ok(new RegExp('"lessons-retention":\\s*process\\.env\\.MB_LESSONS_RET_UUID \\|\\| "' + UUID_RE + '"').test(SERVER),
   "the retention uuid falls back to a real public uuid, never to nothing");
// ...and the two are not the same card, which a copy-paste would make
// them — one uuid in both slots renders the retention tab's numbers under
// the funnel's labels and looks entirely plausible.
{
  const acq = (SERVER.match(new RegExp('"lessons-acquisition":\\s*process\\.env\\.MB_LESSONS_ACQ_UUID \\|\\| "(' + UUID_RE + ')"')) || [])[1];
  const ret = (SERVER.match(new RegExp('"lessons-retention":\\s*process\\.env\\.MB_LESSONS_RET_UUID \\|\\| "(' + UUID_RE + ')"')) || [])[1];
  ok(acq && ret && acq !== ret, "the two reports point at two different cards");
}
// PRESENCE, NOT EMPTINESS: an unwired card and a card with no rows are
// different facts and the page draws them differently.
ok(/reason: SHARED_UUIDS\["lessons-acquisition"\] \? "error" : "unwired"/.test(SERVER),
   "the route separates an unwired card from one that errored");
ok(/Promise\.all\(\[/.test(SERVER.slice(SERVER.indexOf("lessons/api/funnel"), SERVER.indexOf("lessons/api/funnel") + 2500)),
   "the two cards are fetched in parallel, so the slow one never blocks the funnel");

// ONE PICKER, ALL THREE TABS. A filter that moved two tabs and not the
// third is the facility-Summary bug where chips scoped some panels.
ok(/req\.query\.instructor/.test(SERVER.slice(SERVER.indexOf('app.get("/:org/lessons/api/data"'),
                                              SERVER.indexOf('app.get("/:org/lessons/api/data"') + 2500)),
   "the Overview feed is scoped by the instructor too");
// A name no longer in the feed resolves to ALL, not to an empty report.
ok(/const instructor = want && names\.has\(want\) \? want : ""/.test(SERVER),
   "an instructor who has left the feed resolves to all, not to an empty report");
ok(/names\.add\(n\)/.test(SERVER),
   "the instructor list is built from the ROWS, so the picker cannot offer a name the report cannot draw");

// ═══ 6. THE PAGE ═══════════════════════════════════════════════════
{
  // The PDF is this page under ?_print=1 in a browser with no state, so
  // the URL is the only channel. Four gates, and passing three looks
  // exactly like working.
  const pdf = PAGE.slice(PAGE.indexOf("function downloadPdf()"), PAGE.indexOf("function downloadPdf()") + 900);
  ok(/qs\.set\("tab", tab\)/.test(pdf), "the PDF carries the tab");
  ok(/qs\.set\("instructor", instructor\)/.test(pdf), "the PDF carries the instructor");
}
ok(/u\.searchParams\.set\("tab", tab\)/.test(PAGE), "the tab is mirrored into the URL");
ok(/u\.searchParams\.set\("instructor", instructor\)/.test(PAGE), "the instructor is mirrored into the URL");
// Mutating only those two keys — ?token= and ?_print= ride on this URL.
ok(/const u = new URL\(window\.location\.href\);/.test(PAGE),
   "the URL write-back mutates the existing query string rather than rebuilding it");
ok(/instructor \? "&instructor=" \+ encodeURIComponent\(instructor\)/.test(PAGE),
   "the Overview fetch sends the instructor");
// Absent, not disabled: no picker where there is only one instructor to
// pick, because a control that can only mean 'all' is a dead end.
ok(/funnel\.instructors\.length > 1/.test(PAGE),
   "the instructor picker is absent where there is nothing to choose between");
ok(/new Date\(/.test(PAGE.slice(PAGE.indexOf("function lsMonthLabel"), PAGE.indexOf("function lsMonthLabel") + 400)) === false,
   "lsMonthLabel never parses a month through new Date() — that lands a month early west of UTC");

console.log(passed + " assertions passed" + (failed ? ", " + failed + " FAILED" : "") + ".");
process.exit(failed ? 1 : 0);
