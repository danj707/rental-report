#!/usr/bin/env node
/**
 * report-tabs.spec.js — the org dashboard's tab chips, and the deep links they
 * depend on.
 *
 * Dan: "i like what you did here with the tabs being directly clickable. can you
 * roll that out for the programs report and the community intelligence report
 * cards too?"
 *
 * The chips are three lines of config. What made this real work is that NEITHER
 * page could honour the link they produce:
 *
 *   * programs.html read ?tab= into its initial state and then `fetchData` —
 *     which runs on mount — called setTab('summary') and destroyed it. So every
 *     chip would have landed on Summary. Same shape as the ?ci_rows= deep link
 *     the check-ins write-back used to wipe.
 *   * even with the tab surviving, a deep-linked tab has never been through
 *     switchTab, so nothing asked for its lazy feed. Participants with demoRows
 *     null and demoLoading false renders NOTHING — no loader, no empty state.
 *   * users.html did not read ?tab= at all.
 *
 * 2026-08-28, Fast Track ("and add the subtab thing for the Fast Track report"):
 * the SAME two failures, both again silent.
 *
 *   * fasttrack.html did not read ?tab= at all — activeTab started 'overview'.
 *   * and its share-link effect REBUILDS the whole query string on mount from
 *     token/season/search alone, so a ?tab= that survived being read would have
 *     been erased a millisecond later. That is the ?ci_rows= write-back bug for
 *     the third time in this repo.
 *   * all three chipped tabs fetch the Community Intel feed from switchTab,
 *     which a URL never calls — so a deep link landed on an empty body.
 *
 * This spec LIFTS AND RUNS both resolvers rather than regexing over them, and
 * asserts the chip lists cannot name a tab the page will not honour — which is
 * the invariant that keeps a chip from being a dead end.
 *
 * SKIP_SOURCE=1 drops the source-shape assertions.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const PROGRAMS = fs.readFileSync(path.join(ROOT, "public", "programs.html"), "utf8");
const USERS = fs.readFileSync(path.join(ROOT, "public", "users.html"), "utf8");
const FT = fs.readFileSync(path.join(ROOT, "public", "fasttrack.html"), "utf8");
const MEM = fs.readFileSync(path.join(ROOT, "public", "memberships.html"), "utf8");
const ORG = fs.readFileSync(path.join(ROOT, "public", "org.html"), "utf8");

let n = 0;
const SKIP_SOURCE = process.env.SKIP_SOURCE === "1";
const src = (c, w) => { if (SKIP_SOURCE) return; n++; assert.ok(c, w); };
const ok = (c, w) => { n++; assert.ok(c, w); };
const is = (a, b, w) => { n++; assert.deepStrictEqual(a, b, w); };

// ── 1. Lift the resolvers and RUN them ───────────────────────────────────────
function lift(html, names, re) {
  const m = re.exec(html);
  assert.ok(m, "could not lift " + names.join("/"));
  return vm.runInThisContext("(function(){" + m[0] + "\nreturn {" + names.join(",") + "};})()");
}

const P = lift(PROGRAMS, ["PROG_URL_TABS", "progTabAvailable", "progEffectiveTab"],
  /var PROG_URL_TABS = \[[\s\S]*?\nfunction progEffectiveTab\([\s\S]*?\n\}/);
const U = lift(USERS, ["USERS_URL_TABS", "usersEffectiveTab"],
  /var USERS_URL_TABS = \[[\s\S]*?\nfunction usersEffectiveTab\([\s\S]*?\n\}/);
const F = lift(FT, ["FT_URL_TABS", "ftEffectiveTab"],
  /const FT_URL_TABS = \[[\s\S]*?\nfunction ftEffectiveTab\([\s\S]*?\n\}/);
const M = lift(MEM, ["MB_URL_TABS", "mbEffectiveTab"],
  /var MB_URL_TABS = \[[\s\S]*?\nfunction mbEffectiveTab\([\s\S]*?\n\}/);

const ALL_ON = { participantsTab: true, retentionTab: true };

// ── 2. Programs: every offered tab survives, everything else falls back ──────
for (const t of P.PROG_URL_TABS) {
  is(P.progEffectiveTab(t, false, false, ALL_ON), t,
     `programs honours ?tab=${t} — the chip has to land where it says`);
}
is(P.progEffectiveTab("participants", false, false, {}), "summary",
   "a tab this org does NOT have falls back to Summary. `{tab === 'participants' && ...}` "
   + "renders nothing when the flag is off, so a dead chip is a blank body, not a wrong tab");
is(P.progEffectiveTab("retention", false, false, { participantsTab: true }), "summary",
   "…and the same for Retention, which is gated separately");
is(P.progEffectiveTab("nonsense", false, false, ALL_ON), "summary",
   "an unknown tab falls back rather than rendering an empty page");
is(P.progEffectiveTab("", false, false, ALL_ON), "summary", "so does an empty one");
is(P.progEffectiveTab(null, false, false, ALL_ON), "summary", "and a missing one");

// `detail` is a drill-down, not a destination.
is(P.progEffectiveTab("detail", false, false, ALL_ON), "summary",
   "?tab=detail with no section_id falls back — there is nothing to drill into, and the print "
   + "path is the only caller that has one");
is(P.progEffectiveTab("detail", false, true, ALL_ON), "detail",
   "…and WITH a section_id it is honoured, or printing a section detail breaks");

// The pre-existing deep link must not regress.
is(P.progEffectiveTab(null, true, false, ALL_ON), "revenue",
   "?program= still forces Revenue — it predates the chips and is linked from elsewhere");
is(P.progEffectiveTab("checkins", true, false, ALL_ON), "revenue",
   "…and beats an explicit tab, which is the behaviour that shipped");

// ── 3. Community Intel: only the tabs every org has ─────────────────────────
for (const t of U.USERS_URL_TABS) {
  is(U.usersEffectiveTab(t), t, `users honours ?tab=${t}`);
}
is(U.usersEffectiveTab("guests"), "demo",
   "GUESTS IS NOT ACCEPTED FROM THE URL. It renders only when s.guestCount > 0 and the feed has "
   + "not answered at mount, so honouring it would assert something unknowable — and an org with "
   + "no guests would get a blank body with no tab button to come back from");
is(U.usersEffectiveTab("products"), "demo",
   "nor is a cross-report tab, which is gated on the org having that report");
is(U.usersEffectiveTab("nonsense"), "demo", "and anything unknown falls back to Demographics");
is(U.usersEffectiveTab(null), "demo", "as does no tab at all");

// ── 3b. Fast Track: every offered tab survives ──────────────────────────────
for (const t of F.FT_URL_TABS) {
  is(F.ftEffectiveTab(t), t, `fasttrack honours ?tab=${t}`);
}
is(F.ftEffectiveTab("overview"), "overview",
   "OVERVIEW STAYS ACCEPTED even though it gets no chip — a ?tab=overview link someone was "
   + "handed must not stop working just because the card no longer emits one");
is(F.ftEffectiveTab("nonsense"), "overview", "an unknown tab falls back rather than blanking the body");
is(F.ftEffectiveTab(""), "overview", "so does an empty one");
is(F.ftEffectiveTab(null), "overview", "and a missing one");

// ── 3c. Memberships: every offered tab survives ─────────────────────────────
for (const t of M.MB_URL_TABS) {
  is(M.mbEffectiveTab(t), t, `memberships honours ?tab=${t}`);
}
is(M.mbEffectiveTab("nonsense"), "memberships", "an unknown tab falls back rather than blanking the body");
is(M.mbEffectiveTab(""), "memberships", "so does an empty one");
is(M.mbEffectiveTab(null), "memberships", "and a missing one");

// ── 4. THE CHIPS CANNOT NAME A TAB THE PAGE WILL NOT HONOUR ─────────────────
// This is the invariant that keeps a chip from being a dead end, and it is the
// one a config-only change would break silently.
const CARD_TABS = (() => {
  const m = /var CARD_TABS = \{[\s\S]*?\n  \};/.exec(ORG);
  assert.ok(m, "could not find CARD_TABS in org.html");
  return vm.runInThisContext("(" + m[0].replace(/^var CARD_TABS = /, "").replace(/;$/, "") + ")");
})();

ok(Array.isArray(CARD_TABS.programs) && CARD_TABS.programs.length > 0,
   "the Programs card has tab chips — Dan asked for them by name");
ok(Array.isArray(CARD_TABS.users) && CARD_TABS.users.length > 0,
   "so does the Community Intel card");
ok(Array.isArray(CARD_TABS.fasttrack) && CARD_TABS.fasttrack.length > 0,
   "and so does Fast Track — Dan asked for it by name");
ok(Array.isArray(CARD_TABS.memberships) && CARD_TABS.memberships.length > 0,
   "and so does Memberships — Dan: \"make sure you're adding the membership sub-tabs to the "
   + "main cards on the org page, similar to the other cards with tabs\"");

for (const t of CARD_TABS.programs) {
  is(P.progEffectiveTab(t.tab, false, false, ALL_ON), t.tab,
     `the Programs chip "${t.label}" resolves to its own tab — a chip the resolver rewrites is a `
     + `link that goes somewhere else`);
  ok(t.tab !== "summary",
     "…and Summary gets no chip: the card already lands there, so it would be noise");
  ok(t.tab !== "detail", "…and neither does the section drill-down");
}
for (const t of CARD_TABS.users) {
  is(U.usersEffectiveTab(t.tab), t.tab,
     `the Community Intel chip "${t.label}" resolves to its own tab`);
  ok(t.tab !== "demo", "…and Demographics gets no chip, for the same reason as Summary");
}
for (const t of CARD_TABS.fasttrack) {
  is(F.ftEffectiveTab(t.tab), t.tab,
     `the Fast Track chip "${t.label}" resolves to its own tab`);
  ok(t.tab !== "overview",
     "…and Overview gets no chip: the card already lands there, same reasoning as Summary");
}
for (const t of CARD_TABS.memberships) {
  is(M.mbEffectiveTab(t.tab), t.tab,
     `the Memberships chip "${t.label}" resolves to its own tab`);
  ok(t.tab !== "memberships",
     "…and Memberships gets no chip: the card already lands there, same reasoning as Summary");
}
// EVERY non-landing tab the page offers gets a chip. Auto-Renew and Sales & Mix
// shipped as tabs and were NOT on the card for two days — a tab nobody can find
// from the dashboard is a tab nobody uses, which is the whole argument for these
// chips. This is the assertion that fails the next time a tab is added and the
// card is forgotten.
is(CARD_TABS.memberships.map((t) => t.tab).sort(),
   M.MB_URL_TABS.filter((t) => t !== "memberships").sort(),
   "the Memberships card chips cover every tab the page has except the one it lands on");
// The chip icons must match the page's own tab strip, or a reader picks 💰 on
// the dashboard and lands on a tab labelled with something else.
{
  const PAGE_ICON = { revenue: "\uD83D\uDCB0", conversions: "\uD83D\uDD25", demographics: "\uD83D\uDC65" };
  for (const t of CARD_TABS.fasttrack) {
    is(t.icon, PAGE_ICON[t.tab],
       `the Fast Track "${t.label}" chip uses the same glyph as the page's own tab`);
  }
}
// Same for Memberships, and here the glyphs are READ OUT OF THE PAGE rather than
// transcribed: the tab strip is the source of truth, so a page that re-themes a
// tab fails this instead of quietly disagreeing with the dashboard.
{
  const strip = /<div className="report-tabs no-print">[\s\S]*?\n            <\/div>/.exec(MEM);
  ok(!!strip, "the memberships tab strip should be findable");
  const PAGE_ICON = {};
  const re = /activeTab === '([a-z]+)' \? ' active'[\s\S]*?\}\}>\s*\n\s*(\S+) /g;
  let m;
  while ((m = re.exec(strip[0]))) PAGE_ICON[m[1]] = m[2];
  is(Object.keys(PAGE_ICON).sort(), M.MB_URL_TABS.slice().sort(),
     "…and every tab in the strip was read, or the parity check below is vacuous");
  for (const t of CARD_TABS.memberships) {
    is(t.icon, PAGE_ICON[t.tab],
       `the Memberships "${t.label}" chip uses the same glyph as the page's own tab`);
  }
}

for (const [report, tabs] of Object.entries(CARD_TABS)) {
  for (const t of tabs) {
    ok(t.tab && t.icon && t.label,
       `every chip needs a tab, an icon and a label (${report})`);
  }
}

// ── 5. The two things that made the link inert ──────────────────────────────
{
  src(/const fetchData = useCallback\(\(sd, ed, initial\) =>/.test(PROGRAMS),
     "fetchData has to know whether it is the FIRST load");
  src(/if \(!initial\) \{\n\s*var pp = new URLSearchParams\(window\.location\.search\)\.get\('program'\);\n\s*setTab\(pp \? 'revenue' : 'summary'\);/.test(PROGRAMS),
     "…because it reset the tab on mount, one millisecond after ?tab= was read. RE-running a "
     + "report should still return to Summary, so the reset stays — gated");
  src(/fetchData\(startDate, endDate, true\);/.test(PROGRAMS),
     "and the mount effect passes it");
  src(/onClick=\{\(\) => fetchData\(startDate, endDate\)\}/.test(PROGRAMS),
     "while Run Report does NOT, so re-running still returns to Summary");

  src(/const ensureTabData = useCallback/.test(PROGRAMS),
     "kicking a tab's lazy feed is needed from a click AND from a deep link, so it is ONE "
     + "function — two copies drift the first time a tab gains a feed");
  src(/const switchTab = useCallback\(\(t\) => \{\n\s*setTab\(t\);\n\s*ensureTabData\(t\);/.test(PROGRAMS),
     "…called by switchTab");
  src(/ensureTabData\(tab\);/.test(PROGRAMS),
     "…and on mount for the resolved tab, or Participants renders NOTHING: demoRows null and "
     + "demoLoading false hits no loader and no empty state");

  src(/var \[tab, setTab\] = useState\(function\(\)\{ return usersEffectiveTab\(urlParams\.get\('tab'\)\); \}\);/.test(USERS),
     "users.html has to READ ?tab= — it did not, so every chip would have landed on Demographics");
  src(/window\.history\.replaceState\(null, '', window\.location\.pathname/.test(USERS),
     "…and mirror the tab back into the URL, so the address bar is shareable like the chips are");
  src(/if \(t === 'demo'\) q\.delete\('tab'\); else q\.set\('tab', t\)/.test(USERS),
     "the default tab clears the parameter rather than writing ?tab=demo");

  src(/var \[activeTab, setActiveTab\] = useState\(function\(\)\{ return ftEffectiveTab\(SP\.get\('tab'\)\); \}\);/.test(FT),
     "fasttrack.html has to READ ?tab= — it did not, so every chip would have landed on Overview");
  // TWO places build this query string — the replaceState effect and
  // recShareLink — and they carry the identical line, so a bare .test() passes
  // with either one alone. Scoped to the EFFECT, because that is the one whose
  // absence destroys the deep link; and the count pins the Copy Link button too.
  {
    const eff = /useEffect\(function\(\) \{\n\s*if \(isPrint\) return;[\s\S]*?\}, \[seasonFilter[^\]]*\]\);/.exec(FT);
    src(!!eff, "the share-link replaceState effect should be findable");
    src(!!eff && /if \(activeTab !== 'overview'\) p\.set\('tab', activeTab\);/.test(eff[0]),
       "…and it must WRITE the tab. That effect rebuilds the whole query string and runs on "
       + "mount, so a tab it does not write is a tab it DESTROYS a millisecond after the deep "
       + "link set it — and the default tab clears the parameter rather than writing "
       + "?tab=overview");
    src((FT.match(/if \(activeTab !== 'overview'\) p\.set\('tab', activeTab\);/g) || []).length === 2,
       "…in BOTH builders — the effect and recShareLink — or Copy Link hands over a URL that "
       + "drops the tab the sender was looking at");
  }
  src(/\}, \[seasonFilter, searchTerm, activeTab\]\);/.test(FT),
     "…with activeTab in its deps, or the URL stops tracking the tab after the first switch");
  src(/function ensureTabData\(t\) \{/.test(FT),
     "kicking the lazy feed is needed from a click AND from a deep link, so it is ONE function");
  src(/function switchTab\(t\) \{\n\s*setActiveTab\(t\);\n\s*ensureTabData\(t\);\n\s*\}/.test(FT),
     "…called by switchTab");
  src(/useEffect\(function\(\)\{ ensureTabData\(activeTab\); \}, \[\]\);/.test(FT),
     "…and on mount for the resolved tab, or a deep-linked Revenue/Conversions/Demographics tab "
     + "never asks for the Community Intel feed it renders from");
}

console.log("✓ report-tabs.spec.js — " + n + " assertions");
