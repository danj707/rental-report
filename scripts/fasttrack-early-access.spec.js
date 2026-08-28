// Spec for EARLY ACCESS as its own registration phase — card 17300 v18 plus the
// page that reads it.
//
// Dan, 2026-08-28: "A new label, I like 'Early Access' if one group can register
// but others cant. Pretty typical that lots of users will FT sections like this,
// so you can have two 'phases' of FT."
//
// ── WHAT MOVED, AND WHY IT IS IN THE CARD THIS TIME ────────────────────────
// A section can carry two registration windows: a `group` one (early access,
// scoped to a member group) and the `default` one (general). Card 17300 computed
// "Reg Status" from `rw.default_opens` alone, so a section already registering
// its early-access families reported `pipeline` — "registration has not
// started", which is false for everyone in that group. Measured live before the
// push: 278 sections across 9 orgs were in that state.
//
// The page had been patching this since 2026-08-27 (ftEffectiveStatus promoted
// `pipeline` to `open`), which kept the Conversions tab correct but could only
// ever say "Open" about a section most families still cannot register for. A
// label needs the card to carry the phase, so v18 emits 'early-access'.
//
// Dry-run against real data before pushing — exactly one transition, nothing
// else moves:
//     draft     -> draft      32942      pipeline  -> pipeline     518
//     open      -> open       14647      published -> published    503
//     closed    -> closed      2545      pipeline  -> early-access 179
//     scheduled -> scheduled    560
//
// ── THE PAGE MUST READ THE SAME BEFORE AND AFTER THE CARD SHIPS ────────────
// The app caches feeds for 4 hours, so a pre-v18 response ('pipeline' + an open
// early window) and a v18 one ('early-access') are BOTH live at once. They must
// resolve identically or the report changes what it says about a section the
// moment a cache expires. That is the single most important assertion here.
//
// ── AND EARLY ACCESS IS STILL REGISTRATION ────────────────────────────────
// Introducing a third status is exactly how the Conversions tab lost these
// sections the first time: it gated on `open || closed`. `ftIsPostReg` is ONE
// helper read by the tab, the badge that labels it and the flow board, because
// the badge and the tab disagreeing is the bug that shipped before — it would
// have undercounted by 561 pending holds at Smyrna alone.
//
// Run: node scripts/fasttrack-early-access.spec.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PAGE = path.join(__dirname, '..', 'public', 'fasttrack.html');
const SQL  = path.join(__dirname, '..', 'sql', 'report-cards', '17300-fast-track.sql');
const src = fs.readFileSync(PAGE, 'utf8');
const sql = fs.readFileSync(SQL, 'utf8');

let n = 0;
const ok = (c, w) => { n++; assert.ok(c, w); };
const is = (a, b, w) => { n++; assert.strictEqual(a, b, w); };

// ── Lift the real helpers and RUN them (the nightStateFrom lesson) ─────────
function cut(name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i > 0, name + ' should be a named module-scope function');
  let d = 0, end = -1;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) { end = k + 1; break; } }
  }
  assert.ok(end > i, 'could not bound ' + name);
  return src.slice(i, end);
}
function cutVar(name) {
  const i = src.indexOf('var ' + name + ' = {');
  assert.ok(i > 0, name + ' should be a module-scope var');
  const end = src.indexOf('\n};', i);
  assert.ok(end > i, 'could not bound ' + name);
  return src.slice(i, end + 3);
}
const NAMES = ['sectionGoLive', 'ftLaunchedAt', 'ftEffectiveStatus', 'ftIsPostReg', 'ftStatusMeta'];
const api = new Function(
  cutVar('FT_STATUS_META') + '\n' + NAMES.map(cut).join('\n') +
  '\nreturn { ' + NAMES.join(', ') + ', FT_STATUS_META };')();
const { ftEffectiveStatus, ftIsPostReg, ftStatusMeta, FT_STATUS_META } = api;

// Fixed instants, never Date.now() — the spec's meaning must not change daily.
// 2026-08-27T15:00Z is an hour after the General Table's early access opened.
const NOW = Date.UTC(2026, 7, 27, 15, 0, 0);

// The same section, as the two feeds that are live at once describe it.
const PRE_V18 = { section: 'General Table', regStatus: 'pipeline',
  earlyAccess: '2026-08-27T07:00:00-07:00', regOpens: '2026-09-03T07:00:00-07:00' };
const V18 = { section: 'General Table', regStatus: 'early-access',
  earlyAccess: '2026-08-27T07:00:00-07:00', regOpens: '2026-09-03T07:00:00-07:00' };

// ── 1. THE CACHE INVARIANT ────────────────────────────────────────────────
is(ftEffectiveStatus(PRE_V18, NOW), 'early-access',
   "a pre-v18 feed's 'pipeline' + an open early window IS early access");
is(ftEffectiveStatus(V18, NOW), 'early-access', "the v18 card's own value passes straight through");
is(ftEffectiveStatus(PRE_V18, NOW), ftEffectiveStatus(V18, NOW),
   'THE CACHE INVARIANT: both live feed shapes must resolve to the same status, or the report ' +
   'changes what it says about a section when a 4-hour cache entry expires');

// ── 2. Early access is still registration ─────────────────────────────────
ok(ftIsPostReg('early-access'), 'early access counts as post-registration — families ARE registering');
ok(ftIsPostReg('open'), 'open counts');
ok(ftIsPostReg('closed'), 'closed counts');
ok(!ftIsPostReg('pipeline'), 'pipeline does not');
ok(!ftIsPostReg('draft'), 'a draft does not — families cannot see it at all');
ok(!ftIsPostReg('published'), 'published-but-not-open does not');
ok(!ftIsPostReg('scheduled'), 'scheduled does not');

// ── 3. Nothing else was promoted ──────────────────────────────────────────
is(ftEffectiveStatus({ regStatus: 'draft', earlyAccess: '2026-01-01T00:00:00Z',
    regOpens: '2026-01-01T00:00:00Z' }, NOW), 'draft',
   'a DRAFT is never promoted (this took the tab from 127 to 1,522 sections once)');
is(ftEffectiveStatus({ regStatus: 'published', regOpens: '2026-01-01T00:00:00Z' }, NOW), 'published',
   'published-but-not-open is not promoted');
is(ftEffectiveStatus({ regStatus: 'pipeline', earlyAccess: '2026-12-01T00:00:00Z',
    regOpens: '2026-12-08T00:00:00Z' }, NOW), 'pipeline',
   'both windows still ahead stays pipeline — promotion needs a window that HAS opened');
is(ftEffectiveStatus({ regStatus: 'open', regOpens: '2026-08-01T00:00:00Z' }, NOW), 'open',
   "the card's own open answer always wins");
is(ftEffectiveStatus({ regStatus: 'pipeline', earlyAccess: '2026-02-01T00:00:00Z',
    regOpens: '2026-02-08T00:00:00Z', regCloses: '2026-03-01T00:00:00Z' }, NOW), 'closed',
   'a section past its close date is closed, not early access');
is(ftEffectiveStatus({ regStatus: 'pipeline', regOpens: '2026-08-01T00:00:00Z' }, NOW), 'early-access',
   'a general window that has opened while the card still says pipeline is a card lag, resolved the same way');

// ── 4. The label ──────────────────────────────────────────────────────────
is(ftStatusMeta('early-access').label, 'Early Access', "Dan's wording, exactly");
assert.notStrictEqual(ftStatusMeta('early-access').color, ftStatusMeta('open').color);
n++;
ok(ftStatusMeta('nonsense-status').label === 'nonsense-status',
   'an unknown status renders itself rather than blanking the cell');
is(ftStatusMeta('open').key, 'open', 'the meta carries its own key, for a render check to assert on');
ok(ftStatusMeta('early-access') !== FT_STATUS_META['early-access'],
   'ftStatusMeta returns a COPY — a caller stamping onto it must not write into the shared map');
Object.keys(FT_STATUS_META).forEach(function (k) {
  ok(FT_STATUS_META[k].label && FT_STATUS_META[k].color,
     'every status in the map has a label and a colour: ' + k);
});

// ── 5. The page reads the helper, not the raw column ──────────────────────
is((src.match(/r\.regStatus === 'closed' \? 'Closed' : 'Open'/g) || []).length, 0,
   'the Conversions table must not label from the raw column — it would print Open over an early-access section');
// The regression shape is an open||closed test that does NOT also admit early
// access. ftEffectiveStatus's passthrough and ftIsPostReg both list all three,
// so the lookahead lets those two stand and catches every reverted gate.
is((src.match(/=== 'open' \|\| \w+ === 'closed'(?! \|\| \w+ === 'early-access')/g) || []).length, 0,
   'every post-registration gate must admit early access (via ftIsPostReg), or the tab and its badge drift apart');
ok(/var cold = sections\.filter\(function\(r\)\{ return ftEffectiveStatus\(/.test(src),
   'Cold Pipeline must use the EFFECTIVE status — a section in early access is not cold, and reads ' +
   "'pipeline' on a pre-v18 feed");
is((src.match(/ftIsPostReg\(/g) || []).length >= 3, true,
   'ftIsPostReg is read by the tab, the badge and the spec — one helper, so they cannot disagree');

// ── 6. The card SQL carries the rule, in BOTH union arms ──────────────────
const sqlNoComments = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*--[^\n]*$/gm, '');
is((sqlNoComments.match(/'early-access'/g) || []).length, 2,
   "both UNION arms must emit 'early-access' — one section would otherwise read two ways depending " +
   'on which side of the union it came down');
ok(/rw\.group_opens IS NOT NULL[\s\S]{0,120}?rw\.group_opens <= now\(\)[\s\S]{0,80}?THEN 'early-access'/
     .test(sqlNoComments),
   'the rule is: a group window that EXISTS and has OPENED');
// Ordering inside the CASE is load-bearing: 'early-access' must be tested BEFORE
// 'pipeline' or it is unreachable, and AFTER draft/scheduled/published in the
// main arm or an unpublished section could claim to be registering.
const mainArm = sqlNoComments.slice(sqlNoComments.indexOf("THEN 'draft'"));
ok(mainArm.indexOf("'early-access'") < mainArm.indexOf("'pipeline'"),
   "'early-access' must be tested before 'pipeline', or it can never match");
ok(mainArm.indexOf("THEN 'published'") < mainArm.indexOf("'early-access'"),
   'and after draft/scheduled/published, or an unpublished section could report as registering');
ok(!/ORDER BY 1 ASC, 2 ASC, 3 ASC, 9 DESC, 4 ASC[\s\S]*ORDER BY/.test(sql) &&
   /ORDER BY 1 ASC, 2 ASC, 3 ASC, 9 DESC, 4 ASC/.test(sql),
   "the card's trailing ORDER BY survived the push (it was dropped once in transcription)");

console.log('✓ fasttrack-early-access.spec.js — ' + n + ' assertions');
