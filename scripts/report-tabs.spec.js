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
}

console.log("✓ report-tabs.spec.js — " + n + " assertions");
