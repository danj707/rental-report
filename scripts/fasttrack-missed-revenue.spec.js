// Spec for blocked-revenue on the launch cards, and for the Conversions tab
// finally showing sections that are in EARLY ACCESS.
//
// TWO ASKS (Dan, 2026-08-27), on the Smyrna 154th Birthday Concert General
// Table — 273 FT holds, 49 converted, 223 pending, 98% fill:
//
//   "add another metric to the Fast Track recently launched cards — the amount
//    of $$ left on the table due to no remaining capacity ... that's 30k of
//    money left on the table, but we're not calling that out."
//
//   "when clicking on it, you can't even find that section on the conversions
//    tab. That tab should be sorted by most recently launched at the top, with
//    all the conversion, revenue and missed revenue metrics."
//
// (It is $39,025, not 30k.)
//
// ── 1. WHICH MONEY FIGURE ──────────────────────────────────────────────────
// Measured against card 17300 (smyrna, 2026-08-27), each EXACT on all 1,534
// sections:
//
//     Over Demand $  === max(0, FT Total - Capacity) * Section Price
//     Left on Table  === FT Pending * Section Price
//
// Dan asked for money lost to "no remaining capacity", which is Over Demand.
// Left on Table is the value of every unconverted hold whether or not a seat is
// free — at Watertown 100 of the 138 sections carrying it STILL HAVE EMPTY
// SEATS, so it is a follow-up figure and adding spots would capture none of it.
// Reporting Left on Table under a capacity headline would send someone to
// enlarge sections that are already half empty. The spec fails if the launch
// card or the Conversions KPI reads leftOnTable.
//
// ── 2. WHY THE SECTION WAS MISSING FROM THE TAB ────────────────────────────
// Card 17300 computes Reg Status from `rw.default_opens` alone:
//
//     WHEN rw.default_opens > now() THEN 'pipeline'
//
// so a section whose EARLY ACCESS window is open but whose general window is
// still ahead reports as `pipeline`. All four concert tables are in that state
// (early access Aug 24-27, general Aug 31-Sep 3), and the tab filtered on
// `regStatus === 'open' || 'closed'` — so the section carrying 273 holds and
// $39,025 of blocked demand was not on the tab at all. This is the long-open
// issue recorded in CLAUDE.md, fixed client-side rather than with a card push.
//
// ONLY `pipeline` IS PROMOTED, and that restriction is the most important line
// in the change. The first version promoted anything whose go-live had passed,
// which took Smyrna's post-registration set from 127 sections to 1,522 —
// because 1,291 of its sections are `draft`, invisible to families entirely.
// Caught by running it against the real feed before shipping.
//
// Run: node scripts/fasttrack-missed-revenue.spec.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PAGE = path.join(__dirname, '..', 'public', 'fasttrack.html');
const src = fs.readFileSync(PAGE, 'utf8');

let n = 0;
const ok = (cond, what) => { n++; assert.ok(cond, what); };
const is = (a, b, what) => { n++; assert.strictEqual(a, b, what); };

// ── Lift the real helpers and RUN them (the nightStateFrom lesson) ─────────
function cut(name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i > 0, name + ' should be a named module-scope function');
  let d = 0, end = -1;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    const c = src[k];
    if (c === '{') d++;
    else if (c === '}') { d--; if (d === 0) { end = k + 1; break; } }
  }
  assert.ok(end > i, 'could not bound ' + name);
  return src.slice(i, end);
}
const api = {};
new Function(['fmtN', 'sectionGoLive', 'ftLaunchedAt', 'ftEffectiveStatus', 'ftBlockedRevenue']
  .map(cut).join('\n') + '\nreturn { fmtN, sectionGoLive, ftLaunchedAt, ftEffectiveStatus, ftBlockedRevenue };')
  .call(null) && Object.assign(api, new Function(
    ['fmtN', 'sectionGoLive', 'ftLaunchedAt', 'ftEffectiveStatus', 'ftBlockedRevenue'].map(cut).join('\n') +
    '\nreturn { fmtN, sectionGoLive, ftLaunchedAt, ftEffectiveStatus, ftBlockedRevenue };')());
const { ftEffectiveStatus, ftBlockedRevenue, ftLaunchedAt } = api;

// Fixed instants: 2026-08-27T15:00Z, an hour after the General Table's early
// access opened. Never Date.now(), or the spec's meaning changes daily.
const NOW = Date.UTC(2026, 7, 27, 15, 0, 0);

// The four real concert tables, plus rows that must NOT be promoted.
const GENERAL = { section: 'General Table', regStatus: 'pipeline',
  earlyAccess: '2026-08-27T07:00:00-07:00', regOpens: '2026-09-03T07:00:00-07:00',
  ftSignups: 273, ftConverted: 49, ftPending: 223, capacity: 50, overDemand: 39025, ftRevenue: 8575 };
const PREMIER = { section: 'Premier Table', regStatus: 'pipeline',
  earlyAccess: '2026-08-24T07:00:00-07:00', regOpens: '2026-08-31T07:00:00-07:00',
  ftSignups: 111, ftConverted: 25, ftPending: 86, capacity: 25, overDemand: 27950, ftRevenue: 8125 };
const DRAFT = { section: 'A draft', regStatus: 'draft',
  earlyAccess: '2026-01-01T00:00:00Z', regOpens: '2026-01-01T00:00:00Z',
  ftSignups: 4, ftConverted: 0, ftPending: 4, capacity: 10, overDemand: 0, ftRevenue: 0 };
const PUBLISHED = { section: 'Published, not open', regStatus: 'published',
  earlyAccess: null, regOpens: '2026-01-01T00:00:00Z',
  ftSignups: 2, ftConverted: 0, ftPending: 2, capacity: 10, overDemand: 0, ftRevenue: 0 };
const FUTURE = { section: 'Genuinely not open yet', regStatus: 'pipeline',
  earlyAccess: '2026-12-01T00:00:00Z', regOpens: '2026-12-08T00:00:00Z',
  ftSignups: 9, ftConverted: 0, ftPending: 9, capacity: 5, overDemand: 400, ftRevenue: 0 };
const OPEN_CLOSED = { section: 'Already closed', regStatus: 'closed',
  earlyAccess: null, regOpens: '2026-02-01T00:00:00Z', regCloses: '2026-03-01T00:00:00Z',
  ftSignups: 3, ftConverted: 3, ftPending: 0, capacity: 20, overDemand: 0, ftRevenue: 900 };
// The discriminating row: holds waiting, but SEATS ARE FREE. Left on Table is
// 2 x $500 = $1,000 while Over Demand is 0, because demand never exceeded the
// room. This is the shape of 100 of Watertown's 138 sections, and the row that
// makes "add spots" the wrong action. (On a section exactly AT capacity the two
// formulas coincide — 273-50 == 223 pending on the General Table — so a section
// with free seats is the only thing that can tell them apart.)
const SEATS_FREE = { section: 'Fishing Academy', regStatus: 'open',
  earlyAccess: null, regOpens: '2026-08-01T00:00:00Z',
  ftSignups: 9, ftConverted: 7, ftPending: 2, capacity: 13, totalEnrolled: 7,
  overDemand: 0, leftOnTable: 1000, ftRevenue: 3500 };
const NO_CAP = { section: 'No capacity on file', regStatus: 'open',
  earlyAccess: null, regOpens: '2026-08-01T00:00:00Z',
  ftSignups: 7, ftConverted: 2, ftPending: 5, capacity: 0, overDemand: 0, ftRevenue: 300 };

// ── 1. Early access counts as launched ────────────────────────────────────
is(ftEffectiveStatus(GENERAL, NOW), 'open',
   'a section whose EARLY ACCESS window has opened is post-registration, whatever the card says');
is(ftEffectiveStatus(PREMIER, NOW), 'open', 'and so is one that opened three days ago');
is(ftEffectiveStatus(FUTURE, NOW), 'pipeline',
   'a section whose windows are both still ahead stays pipeline — promotion needs a window that has actually opened');

// THE RESTRICTION. Without it, 1,291 Smyrna drafts flood the tab.
is(ftEffectiveStatus(DRAFT, NOW), 'draft',
   'a DRAFT must never be promoted — families cannot see it at all (this took the tab from 127 to 1,522 sections)');
is(ftEffectiveStatus(PUBLISHED, NOW), 'published',
   'a published-but-not-open section must not be promoted either');
is(ftEffectiveStatus(OPEN_CLOSED, NOW), 'closed', "the card's own open/closed answer always wins");

// A pipeline section whose close date has passed is closed, not open.
is(ftEffectiveStatus({ regStatus: 'pipeline', earlyAccess: '2026-02-01T00:00:00Z',
    regOpens: '2026-02-08T00:00:00Z', regCloses: '2026-03-01T00:00:00Z' }, NOW), 'closed',
   'a promoted section past its close date should read closed');

// ── 2. Launch recency is the GO-LIVE instant ──────────────────────────────
is(ftLaunchedAt(GENERAL), Date.parse('2026-08-27T07:00:00-07:00'),
   'launch time is the EARLIER window — keying on regOpens puts an early-access section in the future');
ok(ftLaunchedAt(GENERAL) > ftLaunchedAt(PREMIER),
   'the General Table launched after the Premier Table, so it sorts first');
is(ftLaunchedAt({}), null, 'a section with no windows has no launch instant');

// ── 3. Blocked revenue is OVER DEMAND, not pending value ──────────────────
is(ftBlockedRevenue(GENERAL), 39025,
   'the General Table has $39,025 of demand beyond its 50 seats');
// THE DISCRIMINATOR. Holds worth $1,000 are waiting, but the room has seats, so
// nothing is blocked BY CAPACITY. A helper reading leftOnTable would say $1,000.
is(ftBlockedRevenue(SEATS_FREE), 0,
   'a section with holds waiting but SEATS FREE has nothing blocked by capacity — reading leftOnTable here would say $1,000');
is(ftBlockedRevenue(OPEN_CLOSED), 0,
   'a section that had room reports zero, not null — "nothing blocked" is a real answer');
is(ftBlockedRevenue(NO_CAP), null,
   'no capacity on file means we cannot say — null renders a dash rather than claiming nothing is blocked');
is(ftBlockedRevenue(null), null, 'a missing row is not an answer');

// ── 4. The page reads the right field in the right places ─────────────────
ok(/'data-blocked-rev'/.test(src), 'the launch cards should expose the blocked figure for a render check');
is((src.match(/'data-blocked-rev'/g) || []).length, 2,
   'BOTH launch card variants (pre-launch and just-launched) should carry it');

// The capacity headline must never be fed by leftOnTable.
{
  const cardBlocks = src.split("'data-blocked-rev'").slice(1).map(b => b.slice(0, 400));
  cardBlocks.forEach((b, i) => {
    ok(!/leftOnTable/.test(b),
       'launch card ' + i + ' must not read leftOnTable under a capacity label — most of it has seats free');
  });
}
ok(/ftBlockedRevenue\(r\)/.test(src), 'the cards should go through the one helper, not inline the arithmetic');

// ── 5. The Conversions tab ────────────────────────────────────────────────
ok(/var st = ftEffectiveStatus\(r, nowMs\);/.test(src),
   'the tab should gate on the EFFECTIVE status, not the card’s raw one');
is((src.match(/r\.regStatus === 'open' \|\| r\.regStatus === 'closed'/g) || []).length, 0,
   'the old raw-status filter must be gone, or early-access sections stay missing');

ok(/data-conv-rev/.test(src), 'the tab needs an FT revenue KPI');
ok(/data-conv-blocked/.test(src), 'and a missed-for-want-of-capacity KPI');
ok(/ftBlockedRevenue\(r\) \|\| 0/.test(src), 'the missed KPI should sum the helper, not a raw column');
{
  const kpi = src.slice(src.indexOf('data-conv-blocked') - 900, src.indexOf('data-conv-blocked') + 400);
  ok(!/leftOnTable/.test(kpi), 'the missed KPI must not be built from leftOnTable');
}

// Sorted most-recently-launched first.
ok(/var ta = ftLaunchedAt\(a\) \|\| 0, tb = ftLaunchedAt\(b\) \|\| 0;[\s\S]{0,80}return tb - ta;/.test(src),
   'the flow board should sort by launch instant descending');
is((src.match(/if \(cb !== ca\) return cb - ca;/g) || []).length, 0,
   'the old hottest-first sort must be gone — it buried a section that opened an hour ago');
ok(/most recent first/.test(src), 'and the header should say so, rather than describing the old order');

// Membership keys on the go-live instant too, or an early-access section is
// filtered out of the board even once it is on the tab.
ok(/var at = ftLaunchedAt\(r\);[\s\S]{0,140}now - at\) <= 30 \* 86400000/.test(src),
   'the 30-day window should be measured from the go-live instant');

console.log('✓ fasttrack-missed-revenue.spec.js — ' + n + ' assertions');
