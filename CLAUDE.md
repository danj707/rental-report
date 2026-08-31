# Project notes for Claude

## Working preferences (from Dan, dan@rec.us)

- **Always share the Railway PR-preview URL** whenever I open a PR for this repo,
  without being asked — Dan wants to click through the change before merging.
- **Always hand over the direct Metabase card link** whenever a card needs Dan to
  touch it (the date-tag flip after any programmatic save, most often) —
  `https://rec.metabaseapp.com/question/<id>`. Don't just name the card id.
- **Wire a Slack activity notification into every new user-facing surface** —
  new features, buttons, export/download options, and other notable interactions
  should ping the Slack activity feed, without being asked. Dan wants visibility
  into what's being used (and enjoys the vanity of seeing plays/exports roll in).
  See the section below for the exact mechanism.

## overview and annual-report — RETIRED (Dan, 2026-08-28)

*"do 4, nuke that."* Usage over the whole life of `events.jsonl`: **`overview` 8
opens ever, none in three months; `annual-report` 3.**

Neither drew a card already — `annual-report` is in `NON_ADDABLE_REPORTS` and
`overview` is not in `REPORT_TYPES` — so the work was the routes. Both are in
`RETIRED_REPORTS` now, and `reportRetired()` gates `/:org/annual-report` plus its
**generate** route, which calls the model and was the expensive surface to leave
open on a report with three opens.

**A DELETED ROUTE CANNOT SAY "THIS WAS ON PURPOSE", and that was a live bug.**
`/:org/overview` had been removed outright with a comment saying so, which left it
falling through to the generic 404 — **unmarked**. `noteDeadLink()` alerts on *"a
404 that arrived with a valid-looking token"*, so every stale overview link has
been paging someone since the day the route was deleted. `retired-reports.spec.js`
asserts zero `deadlink` events and got one, which is how it surfaced. There is now
an explicit refusing route that sets `res.locals.deliberate404`.

**Generalise it:** when retiring a route, *refuse* rather than delete. A refusal
can be marked deliberate; an absence cannot.

Nothing is deleted — `public/overview.html`, `public/annual-report.html`, the
generate route and `ANNUAL_REPORT_SYS_PROMPT` all stay. **Both stay in
`REPORT_DEPENDENCIES` on purpose**: that map is what `splitBreakageByActivity()`
reads to decide a dropped table under a dead report must not page anyone, and
removing them would lose exactly that.

Guard: `scripts/retired-reports.spec.js` (**18 assertions, in CI**), which boots
the server, requires both reports to 404 and the four reports people actually use
to still serve, and asserts **zero `deadlink` events** despite every request
carrying a real token. Mutation-tested three ways, all failing by name — including
the unmarked overview 404, i.e. the bug it found.

## Report Wizard — DISABLED for every org (Dan, 2026-08-28)

Dan: *"we need to disable it for all orgs... they should not be able to see or
click it."* And, on why: *"This report wizard is nice in concept, but really needs
direct db connectivity via an api."*

**SEE and CLICK are two different gates, and either alone is a half-measure:**

- **SEE** — `report-wizard` is in `RETIRED_REPORTS`, which removes the card from
  the org dashboard and the admin portal.
- **CLICK** — `WIZARD_ENABLED_ORGS` (empty) makes all four wizard routes 404.
  The comment on `RETIRED_REPORTS` explains why hiding is not enough: it controls
  whether a report is **SURFACED**, not whether it works, and campmap served ~24
  visitors a month through direct links the whole time it was listed there. Every
  wizard link already bookmarked or emailed still resolves.

Empty set ⇒ off everywhere. Same shape as `MUNIS_EXPORT_ORGS`:
`WIZARD_ENABLED_ORGS=slug,slug` re-enables the routes for those orgs alone,
without un-hiding the card for anyone.

**THE 404s ARE MARKED DELIBERATE, and this is the part to remember.**
`noteDeadLink()` alerts on *"a 404 that arrived with a valid-looking token"* —
exactly the shape of every stale wizard link from now on. Without `refuse404()` /
`res.locals.deliberate404`, disabling the feature posts one DEAD LINK alert per
stale link, naming a path we turned off on purpose. That is the settings-route
false alarm, at scale. A refused page also logs no `view`, so the report does not
keep looking "active" to the watchdogs that gate alerting on usage.

**Why it is off, with the measurements** (so nobody re-derives them):

- **The shape is wrong for Metabase as middleware.** The schema probe pulls the
  WHOLE card to read five rows — the `users` card returned **104,340 rows in
  52s** — and the page then pulls whole feeds to compute sums a
  `SELECT sum(...) GROUP BY` would answer in milliseconds. Production, warm:
  apex facility **42.7s**, roster 16.9s, programs 15.7s.
- **Direct DB is the right direction but not sufficient alone.** Every table in
  the `materialized` schema has exactly one index — its primary key — so going
  direct inherits the same seq scans *without* the 4-hour cache hiding them.
  Direct DB **plus** the `(organization_id, datetime_at_primary_timezone)` index
  already spec'd in this file is the combination that pays.
- **SOURCE SUBSTITUTION was never fixed and is the finding that outlives this.**
  When a source that justified a prompt has not answered at generate time, the
  model builds from what it does have — measured across 13 generated reports,
  *"Facility rentals by location"* was answered from `gl` and *"Class roster by
  section"* from `calendar`. Both produced **arithmetically correct reports
  answering a question nobody asked**, and no field-level guard can catch it
  because those fields are all genuine for the substituted source.

**The improvement work is PARKED, not lost** — schema resilience (warm-cache and
last-known-good schemas, a bounded probe, and never caching an empty result),
org-derived prompts gated on what each org actually has, and a field-name repair
pass that drops a column the feed lacks instead of rendering `$0`. All of it is on
the `claude/report-wizard-improvements-cc9vbm` branch, kept as a **draft PR
(#169)** with the measurements in a comment.

**Nothing is deleted here.** `public/report-wizard.html`, the
generate/feedback/log routes and the wizard specs all stay and keep running, so
re-enabling is configuration rather than a rebuild — which is what made
un-retiring this in August a one-line change.

Guards: `scripts/wizard-disabled.spec.js` (**29 assertions, in CI**) boots with an
empty allowlist and requires all four routes to 404, `wizardVisible: false` in the
injected config, **zero `deadlink` events** despite every request carrying a real
token, and — with one slug in `WIZARD_ENABLED_ORGS` — the page back at 200, so
this is provably a switch and not a deletion. Plus the
`org landing · no wizard card` render case, which asserts the card is **ABSENT
from the DOM**: `org.html` builds its cards client-side, so the card BUILDER is in
the served JS on every load and grepping HTML proves nothing. Un-retiring the
report makes that case fail in a real browser with *"should NOT be present, but it
is"* — verified.

## Report Wizard (2026-08-26) — three things worth knowing

### The wizard's own runs were invisible in Slack — FOURTH instance of the trap

`generate` has been written to `events.jsonl` since the wizard shipped and was
**never in `SLACK_NOTIFY`**, so the highest-signal event on the platform — an org
described a report in English and got one — posted nothing. Same family as the
campmap, Facilities-hub and Memberships beacon bugs: the code was right, the row
was recorded, and nothing reached the channel. Now wired:

| event | fires on | key facts carried |
|---|---|---|
| `generate` (🪄) | a report is generated | title, widget count, sources, **the prompt** |
| `wizard-save` (💾) | Save on a generated report | title, widget count |
| `feedback` (👍/👎) | thumbs on a generated report | title, the typed comment, the prompt |

- **The PROMPT is the event.** "Someone built a report" says nothing; the
  questions orgs type are the only place we learn what reports they wish they
  had. So `generate` **debounces by prompt**, not by org: three different
  questions in two minutes is three reports, and the default
  `org|report|event` key would keep only the first.
- **`feedback` debounces by VOTE DIRECTION**, same reasoning as `update-vote` — a
  reader who thumbs down, re-reads and thumbs up has told us two things.
- **`feedback` has its own message branch now.** It used to fall into the shared
  insights/chat branch, which printed `Report Wizard on *report-wizard*` — the
  report type twice and the report that was rated never.
- **`wizard-save` needed its OWN log route** (`POST /:org/report-wizard/api/log`),
  registered **above** the generic `/:org/:report/api/*` ones, because
  `report-wizard` is not in `REPORT_TYPES` and the generic route 404s it. Fourth
  time this has come up; see the campmap section for the first.
- Guarded by `scripts/wizard-activity.spec.js` (20 assertions, in CI), which
  extracts the real `notifySlack` for the message/debounce half and boots the
  server for the beacon half. `SKIP_SOURCE=1` disables the source-order half so
  the behavioural half can be shown to catch a moved route on its own — it fails
  with the real `404 Unknown report: "report-wizard"`. Mutation-tested five ways
  (event dropped from `SLACK_NOTIFY`, either debounce key reverted, the thumbs
  branch reverted, the route moved below the generic one); all five fail by name.

### The report write-up: the AI writes the prose, the PAGE writes the numbers

A generated report was a title and a stack of charts. It now opens with a
`summary` paragraph and a "Worth knowing" list of `notes`, both from the model —
and a **"Built from"** line that is computed in the page.

**That split is the whole design, and it is not cosmetic.** The model generates
the config *before a single row is fetched*: it has field names and a few sample
values, and no totals, rankings or date ranges. So the system prompt forbids it
from stating any figure, and `wizard-narrative.spec.js` pins that instruction — a
fabricated "$2.5M across 26 programs" would sit beside real KPI cards and read
exactly as authoritative.

- The "Built from" line is the only part that may carry a number: sources used,
  rows that **actually arrived**, and each source's grain.
- **A source that answered with nothing now says so.** Previously a failed fetch
  rendered as widgets full of dashes with nothing on screen explaining why.
- **`WIZARD_SOURCE_GRAIN` lives in server.js and is injected** into `ORG_CONFIG`
  as `sourceGrain`. The spec fails if the page grows its own copy: two maps drift
  the first time a card changes grain, and the line is only worth printing if it
  is true.
- **`WIZARD_MAX_TOKENS` went 3000 → 4000.** The config is ONE JSON object, so
  running short does not truncate the prose — it truncates the JSON and the whole
  generation fails as "AI returned invalid config".
- `summary`/`notes` are normalised server-side (a bare string becomes one note,
  lengths and counts clamped), because the page renders them and a bad shape must
  not be able to blank the report. Reports saved before this shipped have neither
  and render no panel at all rather than an empty decorated box.

### The build screen types, then erases

The prompt box writes an example, holds, erases and moves to the next. Dan's ask,
from the Seb animation.

- **Placeholder only, never the value** — an admin must never find their own
  words racing them.
- **Touching the box is a kill switch, not a pause** (focus, a keystroke, or
  clicking a quick-prompt chip). A placeholder that resumes writing behind a
  half-typed prompt makes a text box feel haunted.
- **The caret matters.** Mid-phrase, "Compare this fall's enrollme" reads as a
  truncation bug without one. It blinks on a fixed-width pair (`▌` / thin space)
  so the text does not jitter, and the caret is composed at the call site so
  `data-rw-typed` keys on the TEXT — fold the caret in and the render guard
  passes on a dead animation.
- The **quick-prompt chips stay** (Dan: "those are great"), and the typed phrases
  are a deliberately DIFFERENT set — reusing the chips would make the panel
  repeat itself twice over.
- `prefers-reduced-motion` gets the old static placeholder.
- Guards: three `ci-check-render.js` cases keyed on `data-rw-typed="1"`,
  `[data-rw-summary]`/`[data-rw-grain="programs"]`/`[data-rw-note]`, all of which
  were seen to fail on an inert animation and a removed narrative, while the
  plain "wizard · build screen" case kept passing — which is the point.
  `ci-check-render.js` CASES now accept an optional `act(page)` hook, because the
  wizard's report screen only exists after a Generate click.

### Backcheck against Clarksville (2026-08-26) — the numbers were right, two labels were not

Dan asked for a backcheck of a generated GL report: **$11,188 payments / $100
refunds / $11,088 net / 65 payments / 5 accounts**, plus a 5-row account table.

**The figures were exactly right, verified two independent ways.**

1. **Page vs card.** Fetched card 17293 straight from the Metabase public
   endpoint (cache-independent, the `verify-report-live.js` path) for
   clarksville over the window the wizard actually used. All 5 rows × 7 columns
   matched the screen cell for cell, and all five KPIs recomputed exactly.
2. **Card vs base data.** Rebuilt the rollup with independent SQL over
   `materialized.item_log_report` — summing in cents rather than per row, and
   splitting payment/refund on `transaction_type` instead of the card's
   per-method CASE ladder. Over an identical **closed** window: **zero diffs**
   across all 5 accounts on payments, refunds and payment counts.

**Why the first comparison showed a $30 / 1-payment gap, and why it was not a
bug.** The wizard's window ends TODAY, and a `card-online` payment landed
between the two reads. Proven rather than assumed: the same card read five
minutes apart went **$11,188/65 → $11,218/66**. Never diff an open window
against itself across two reads — pick a closed one, as the second leg did.

**Three real defects the backcheck did find:**

- **The report carried NO DATE RANGE, anywhere.** The wizard passes no dates, so
  `buildMetabaseParams` silently defaults to a 7-day window, and nothing
  downstream could say which one. A GL rollup with no period on it cannot be
  checked by the person reading it. The feed's `meta.window` now echoes the
  dates that were SENT (not recomputed — recomputing can disagree with what
  Metabase was actually asked) and the "Built from" line prints them. Worth
  knowing: **the default runs BACKWARD for `gl` and FORWARD for `facility`**
  (measured: gl 08-19→08-26, facility 08-26→09-02), so one park-wide window
  label would be wrong.
- **Two of the three grain labels I shipped were FALSE.** `gl` said "one row per
  GL account" — card 17293 groups by gl_code AND `desk_location`, so a
  multi-desk org repeats a GL code (it only looked right at Clarksville, where
  every row is `(No desk location)`). `facility` said "one row per facility
  reservation" — card 17294 emits **19 rows over 4 reservation ids**, one per
  DATE. `programs` was correct (15 rows, 15 distinct `section_id`).
  **`WIZARD_SOURCE_GRAIN` now holds ONLY measured entries, each with the card
  and date recorded above it, and an unmeasured source prints its row count with
  NO grain phrase.** A guessed phrase is a confident sentence about what a row
  means sitting directly under a row count — the exact fabrication the
  prose/number split exists to prevent, which I reintroduced one field over.
  To add a source: `COUNT(DISTINCT id) == row count` against its card, then
  record the card. Never infer it from the card's name.
- **`Number of Payments` is not additive, and the wizard summed it.** It is
  `COUNT(DISTINCT transaction_event_id)` **per GL row**, which is exactly why
  card 17293 also ships `Desk Distinct Payments` ("the app sums these once per
  desk instead of summing the per-GL column"). Summing the per-GL column
  double-counts any payment touching two GL codes. It happened to be right here
  — 65 == the card's own distinct figure of 65, one desk, no split payments — so
  this is a **latent** wrong number, not a current one. `WIZARD_SOURCE_HINTS.gl`
  now spells this out for the model, including that money columns *are* additive
  (or the warning reads as "never sum anything from this source").

Guards: `wizard-narrative.spec.js` 16 → 21 assertions. The window one runs the
REAL `buildMetabaseParams` (with `parseToISO`) and the route's own derivation
lifted verbatim, so a date-defaulting change fails it. Mutation-tested five more
ways — window dropped from meta, the guessed grain fallback restored, the gl
grain reverted to the false phrase, the window formatted with `new Date()`, and
the non-additive warning removed. Plus a `wizard · feed date window` render case
keyed on the FORMATTED string, because the formatting is where the bug lives:
`new Date("2026-08-19")` is UTC midnight and renders as Aug 18 across the US.

**Sandbox caveat, hit again.** A local `node server.js` prewarms ~28 orgs against
PRODUCTION Metabase, and the clarksville gl feed came back `400 "An error
occurred."` locally while the same request on the PR preview returned 200 in
4.3s. Do not read a local 400/500 as a code defect — confirm against the preview
first, as the timing caveat in the health-check section says.

### Two things NOT done, worth knowing

- **`fetchWizardSchemas` excludes `NON_ADDABLE_REPORTS`, so the AI never sees a
  schema for `program-demographics`** — yet the system prompt's entire worked
  example is built on it and the first quick-prompt chip ("Program revenue and
  fill rate by gender") needs it. It works today only because the example
  hardcodes real field names. Fixing it means probing 8 more cards (including the
  heavy `selfservice`/`checkins` ones) on the wizard's warm-up path, which is a
  cost decision, not a drive-by.
- **`scripts/email-slack-notify.spec.js` was dead** and not in CI: `notifySlack`
  references `alertEnabled`, declared above the extracted block, so the spec
  threw `ReferenceError` before asserting anything. Deps injected, 7/7 passing,
  and it is in CI now.

## Memberships: the PAID BOOK, and why the platform counts read so high (2026-08-29)

Dan: *"we're looking for paid memberships, like swim passes, yoga or fitness
memberships, autorenewing memberships"* — and then the admin questions the report
should answer: how many are on auto-renew, what does it make each month, are
sales up or down, where am I losing money, which plans are popular and why.

**A `group` IS the membership record**, so the obvious query returns **141,128
active memberships** and that number is mostly a residency file: **130,170 are
priced at $0**, almost all free resident-verification records (*Torrance
Residents*, *Norman Residents*, *Apex Resident*). The real paid book is
**10,958 memberships ($2,563,002) + 13,802 passes ($737,628) = $3,300,630**
across ~45 orgs.

**The Memberships report was already right about this** — card 17301 reads a
*purchases* view, and a membership reaches it **iff `finalCents > 0`**. Tested,
not assumed: zero exceptions across 102,765 rows. So the report's figures are
sound; it is the platform-level counts that mislead.

### AUTO-RENEW IS A PLAN SETTING, NOT A MEMBER CHOICE

The finding that reframes everything else. Of the **317 plans** carrying a paid
membership: **268 have zero members on auto-renew, 47 have every member on it,
and exactly 2 are mixed** — 4 members platform-wide. Plans named *Monthly* and
*EFT* are 100%; everything priced as an annual or a season is 0%.

So "only 17% of the book auto-renews" is really **"268 plans were never
configured for it"** — a config review with an org list, not a member campaign.
Only **6 orgs** have any auto-renew at all. Economics: **$119,823/month**
platform-wide, median cycle **31 days**, avg charge $69.28.

### SEASON PASSES ARE NOT CHURN — and I got this wrong first

I reported **$846,397 expiring in 90 days with no auto-renew** as money at risk.
**95% of it is season passes reaching the end of their season.** A *2026 Season
Pass* ending 30 September is the product working. Split properly:
**$807,142 is next-season re-buy** and **$39,256 is genuine renewal exposure**.
Both matter; they are not the same job, and one number covering both is how a
report gets distrusted.

The term rule is on the plan, and it predicts everything:

| shape | test | active | book | on auto-renew |
|---|---|---|---|---|
| open-ended / subscription | neither field set | 5,395 | $1,631,303 | 1,848 (34.3%) |
| season | `group.end_date` | 4,637 | $879,940 | **0** |
| rolling term | `group.ends_after_seconds` | 926 | $51,758 | **0** |
| passes | — | 13,802 | $737,628 | **n/a** |

**The `pass` table has no subscription column at all** — no
`stripe_subscription_id`, no `next_renewal_at`. 13,802 active paid passes worth
$737,628 cannot auto-renew as a matter of schema, not configuration.

### The Retention chart flashed up and vanished — a PRE-EXISTING bug

Dan, on the preview: *"under 'retention' this metric (which is awesome) shows
briefly then disappears."* Nothing to do with the paid-book work — byte-identical
on `main`, and the tab's own button had two defects compounding:

```js
var start12 = new Date(now.getTime() - 30 * 86400000);   // THIRTY DAYS
if (startDate > s || endDate < e) { ...refetch... }
```

- **`start12` was 30 days**, despite its name and the comment above it saying
  "auto-expand to 12 months". Even the intended widening gave a month.
- **The condition NARROWED a window that was already wider.** It fires on
  `endDate < e` alone, so on 2026-08-30 a 2025-09-01 → 2026-08-29 window (twelve
  months) was replaced by Jul 31 → Aug 31 — **31 days**.

The pane renders from the previous `data` while the refetch is in flight, so the
full cohort chart drew, the narrow response landed, and `buildCohorts` collapsed
it. That is the whole "shows briefly then disappears".

`mbRetentionWindow()` returns the **UNION** of the current window and the wanted
one, so narrowing is structurally impossible whatever the two dates are. At
module scope so the spec can RUN it.

**The guard needed a timezone to mean anything.** `mbISODate` builds the date
from local parts; swapping it for `toISOString().slice(0,10)` passed the entire
spec, because this sandbox and GitHub Actions both run UTC. The spec now
re-execs under `TZ=America/Los_Angeles` — chosen for the PROPERTY, not an org:
it is behind UTC, so a local evening is already tomorrow in UTC and the two
implementations diverge. A zone ahead of UTC would not discriminate. Same lesson
as `fasttrack-dates.spec.js`, and it was found by mutation, not by review.

### Card 17301 v2 — five columns, and nothing else moved

`Coverage`, `Plan Season End`, `Plan Term Days`, `Auto Renew`, `Period Start`,
via two LEFT JOINs to `public.membership` and `public."group"` — both on primary
keys, so neither can fan out. **Verified before the push**: Norman, 20,341 rows
with and without the joins and a byte-identical md5 over the original columns.
Mirror at `sql/report-cards/17301-memberships.sql` (there was none before).

- **`Auto Renew` is `stripe_subscription_id IS NOT NULL`** — the truth. The
  existing `Renewal Type` infers it from `next_renewal_at` and is **kept
  unchanged** for compatibility, but it is not the same test.
- **`Period Start` + `Next Renewal` give the billing CYCLE**, which is the only
  way to turn a per-cycle charge into a monthly figure. Measured: 50 memberships
  bill weekly, so reading the charge as monthly understates them 4x.

**THE CACHE INVARIANT.** Feeds cache 4 hours, so a pre-v2 response and a v2 one
are both live at once. `mbIsAutoRenew()` resolves them to the same answer, and
`mbHasEconomics()` is **presence, not count** — the panels HIDE on a pre-v2 feed
rather than rendering `$0`, which would say "this org earns nothing from
auto-renew" when the truth is "this feed cannot tell us". Same rule as
`hasAbsent` / `ciHasStatus`. And **`mbProductShape()` returns `unknown`, never
`open`, without the plan columns** — guessing would file all 4,637 season passes
as subscriptions and put $807,142 of re-buy into the churn number.

### v3: every day pass and gate fee was filed as a subscription (2026-08-30)

Dan, on the Auto-Renew tab: *"we're showing memberships that are not
auto-renewing, why?"* — and then, on how gate fees got there: *"lets fix that."*

**A PASS HAS NO GROUP.** v2 read the plan's term rule from `group` alone, so for
a pass both `Plan Season End` and `Plan Term Days` came back NULL — byte-identical
to a monthly subscription. `mbProductShape()` then read "no season end, no term
days" as **open-ended**, and every pass on the platform became an auto-renew
conversion candidate. Norman alone: **16,940 of 20,341 rows are passes**, 10,669
of them with neither term rule, including **4,518 "League Tournament Gate Adult
$5" admissions at ~$6** listed as convertible to a subscription.

**Absence of a group term rule is not evidence of a subscription**, and no
field-level test can catch this — every NULL involved is genuine. The fix is to
carry what the row IS rather than infer it:

- **`Product Kind`** (`mp.product_type`) was **already on the view and already in
  the WHERE clause**, and thrown away. Selecting it is the whole fix.
- **`pass_schema` is joined** so a pass gets its own term rule instead of an
  absent one. Both plan columns are now `COALESCE(gg.…, pss.…)`. Primary-key
  join, so it cannot fan out — verified against prod: Norman **20,341 rows with
  and without it, every row distinct**.

**v3 is additive in ROWS but not in VALUES, and that distinction matters.**
Measured at Norman: 20,341 rows with and without the join, and `Product Kind`
splits them **3,401 memberships / 16,940 passes**. But `Plan Season End` was NULL
on every pass under v2 and is now populated for **6,271** of them — an existing
column whose values change, which is exactly why the shape helper had to be
re-ordered in the same change rather than after it.

**THE PASS TEST IS SETTLED FIRST, before any term rule.** Now that a pass can
carry an end date, testing season first would file a dated pass as a season
membership and put its value in the next-season **re-buy** number, which is a
membership question. Ordering is load-bearing, exactly like `early-access` inside
card 17300's CASE.

**AND THE CACHE INVARIANT DELIBERATELY DOES NOT HOLD HERE.** v2 and v3 cannot
answer the same question: v2 has no column that separates a $20 monthly
membership from a $6 gate fee, so `mbProductShape()` returns **`unknown`** for
every un-kinded row rather than guessing. The resolution is the presence gate —
`mbHasProductKind()` is **presence, not count**, and the "Could Convert" card
renders *"Not in this feed yet"* on a pre-v3 feed. A `0` there would look like an
answer; v2's non-zero was worse, because it counted day passes as subscriptions.
Same rule as `hasAbsent` / `ciHasStatus`, and it is why an org that sells no
passes still gets its count.

Passes are out of the **denominator** as well as the candidate list — counting a
pass as a membership that merely isn't auto-renewing measures the rate against a
base that can never move — and out of the **per-plan config table**, where they
sat at the top reading "0%", looking like a misconfiguration and not being one.
The scope note names them and their value, so they are excluded visibly rather
than silently.

**The render case for the denominator had to be re-keyed.** It asserted
`data-ar-count`, which is the auto-renew COUNT — passes never auto-renew, so that
number reads the same either way and the case could not discriminate. It keys on
`data-ar-base` (the denominator) now. Caught by mutation, not by review.

### The DENOMINATOR was the same bug, and I only half-fixed it (2026-08-30)

Dan, on production, after the pass fix shipped: *"still not understanding why
non-autorenewing memberships are in this tab."* Right — v3 took passes out and
stopped there, and **season and rolling-term plans have exactly the same
property.** Measured on prod over ACTIVE PAID memberships:

| shape | rows | on auto-renew |
|---|---|---|
| open-ended | 5,398 | 1,841 |
| season | 4,650 | **0** |
| rolling term | 932 | **0** |
| passes | 13,802 | n/a — no subscription column exists |

**A rate is only meaningful over a base that can move.** Norman read
**7.1% across 2,887 memberships** when the truth is **97.6% across 209**, with
exactly two cash plans (5 members, $120) left to convert. The "Could Convert: 5"
card was right the whole time and *everything around it* was wrong — and the
per-plan table was six Westwood season passes at "0%" burying the two rows that
are the actual finding.

`mbCanAutoRenew(r)` is the single predicate, read by **both** the rate and the
per-plan table (`memberships-revenue.spec.js` slices each `useMemo` and requires
it in both — a file-wide count passes when one caller uses it twice and the
other not at all). Two branches keep it honest:

- **`unknown` IS ELIGIBLE.** On a pre-v3 feed nothing is excluded, so the tab
  degrades to its old behaviour rather than shrinking a denominator on a guess.
- **A row that IS on auto-renew is eligible whatever its shape.** Those zeros are
  MEASURED, not a schema guarantee, so a season plan that ever does carry a
  subscription must show up rather than vanish. This is the branch that makes
  the exclusion safe to apply at all.

**Excluded ≠ hidden.** The scope note names each excluded family with its count
and value ("2,678 season plans ($317,180)"), because a silent exclusion is how a
number stops being trusted — and *"you have $317k of season passes"* is worth
reading on its own.

**Two spec mutations survived the first draft**, both fixed in the spec rather
than the mutation. Deleting the `unknown` branch passed, because both pre-v3
fixtures happened to carry auto-renew and the safety valve answered first — that
test now builds its own row that is explicitly OFF. And reverting the rate to
every paid row passed every source assertion, because the mutated block still
*mentions* the helper; only the browser could tell, and it does —
`data-ar-base` and `data-ar-pct` both fail by name.

**Generalise it:** when you exclude a population from a numerator's base,
exclude it from every surface that base feeds, and say on screen what you took
out. I applied the argument to passes, wrote it down, and still left two
identical populations in — the write-up did not stop the second instance because
it named passes rather than the property.

### The Auto-Renew tab is the auto-renew BOOK, not an adoption rate (2026-08-30)

Dan, after two rounds of me narrowing a denominator instead: *"the memberships
showing up in the auto renew tab should be those that are setup for auto renew.
Those two memberships totalling 5 aren't auto renewing memberships."*

**Every denominator was contested and the framing was the problem.** Paid
memberships, then non-passes, then subscription-shaped — each was less wrong than
the last and each still put rows on the tab that nobody auto-renews. The table is
now `on > 0`: a plan is listed iff somebody is actually on auto-renew. **That one
rule subsumes every exclusion argued for earlier** — a pass, a season plan and a
desk-paid cash plan all have nobody enrolled and fall out together instead of as
three special cases. The rate is gone; the tab states the book.

An eligible-but-unenrolled plan is a **CANDIDATE**, and the Could Convert card now
NAMES the plans rather than only counting them — "5" is a number to wonder about,
"4 on 1 Month Individual Cash, 1 on 1 Month Family" is a list to work through.

### WHY those 5 could not auto-renew: the payment method, not the plan name

They are on plans *named* "Cash", which is the name-matching trap. There is **no
payment-method column on `group` or `membership`** — but the purchase's
transaction method is on `item_log_report`, and over open-shape active paid
memberships platform-wide it splits perfectly, **zero exceptions in 2,083 rows**:

| method | memberships | on auto-renew |
|---|---|---|
| card-online | 3,312 | 1,841 (55.6%) |
| card-present (desk swipe) | 1,523 | **0** |
| cash | 343 | **0** |
| check | 185 | **0** |
| organization-credit | 32 | **0** |

**CONFIRMED BY DAN AS A PRODUCT RULE, not just a correlation:** *"a/r memberships
are ONLY available via CC."* So the table above is the rule showing through the
data, and the tab may state it in words — an online purchase leaves a reusable
card; a desk swipe, cash, check or org credit does not, so there is nothing for
Stripe to charge.

**Consequence for the Could Convert card:** converting one of these is not
flipping a plan setting, it is getting a card on file, and the card says so.
**Deliberately NOT used as an exclusion:** a cash member CAN
be converted — you ask for a card — whereas a season pass cannot. Excluding them
would delete 2,083 convertible memberships platform-wide, the largest conversion
opportunity there is. **`Card On File` is NOT on the card yet, and it is the obvious next column** —
`bool_or(transaction_method = 'card-online')` inside the `tx_oi` / `tx_cust` CTEs,
which already scan `item_log_report`, so it costs no new scan. It would split
Could Convert into "already pays by card, so the plan setting is the whole job"
versus "pays at the desk, so someone has to capture a card" — two different jobs
currently reported as one number. A single method pick would be wrong for the 36
of 113,819 order items that split across methods; the boolean is deterministic.
It belongs as the *reason* beside a candidate, never as a filter.

### The metrics: renewals, cancellation, and A/R retention (card v4)

Dan: *"where are things like auto-renewing rate per period, cancellation rate,
maybe a chart similar to the retention tab… which a/r memberships are working out
the best, which have a high cancellation rate."*

**THERE IS NO RENEWAL-EVENT HISTORY ANYWHERE.** `public.subscription` is a
marketing opt-in table (name, description, opt_in_by_default) and `membership`
keeps only the CURRENT period. So renewals are **derived**:
`mbRenewalsSoFar()` = (Period Start − Start Date) ÷ cycle.

**Verified by remainder, not by spot check.** Over Norman's auto-renewers the
elapsed time divides into whole cycles: weekly (58) exact, monthly (137) 0.06 off
a whole number — calendar months against a fixed 31-day cycle — annual (12)
exact. Monthly members have renewed up to 7 times.

- **NULL, never 0, when it cannot be derived.** `next_renewal_at` is cleared on
  cancellation, so a cancelled membership has no cycle. A 0 would say a member who
  renewed six times and then left never renewed at all — and averaged into a plan
  it punishes that plan hardest for the members it kept billing longest.
- **Card v4 adds `Cancel Scheduled At`** — a cancellation booked for period end,
  membership still live, still billing, will not renew. **The only
  forward-looking churn signal in the schema**; Norman has 126. `canceled_at` is
  the past. `mbCancelPending()` requires `!mbIsCanceled()`, or the two get added
  together the moment one becomes the other. Presence-gated
  (`mbHasCancelSchedule`) like everything else.
- `Cancel Reason` is carried but **do not build a "why they left" panel on it** —
  other/schedule/cost, 94.2% "other".
- The A/R retention chart reuses **`buildCohorts` and `RetentionChart`
  unchanged**, handed the auto-renewer subset. Two cohort builders would drift
  and two tabs would then report different retention for the same members.

**A CHURN METRIC MAY NOT BE COMPUTED OVER A VIEW THAT HIDES CHURN.** `statusFilter`
defaults to `['active']`, so a cancellation rate taken from `filtered` is
structurally **0.0% for every org, forever** — and reads as a healthy book rather
than a broken number. `filteredAnyStatus` applies every toolbar filter *except*
status; the Auto-Renew tab reads it and every other panel still reads `filtered`.
**Found by the render check**, on a fixture built to make the rate 60%, not by
review. Generalise it: any denominator that must include an outcome cannot be
taken from a view whose default hides that outcome.

**A spec-helper gotcha worth keeping:** `block()` bounded each `useMemo` by the
literal `"}, [filtered]);"`, so the moment one memo's deps changed the slice ran
on into the *next* memo and an assertion about `arPlans` started reading someone
else's code. It matches the dependency line by pattern now.

### THE RENEWAL COUNT WAS WRONG, and one org's clean data is why (2026-08-30)

Apex's Auto-Renew tab reported **228 renewals on average, up to 44,665**, on a
monthly plan. My bug, and the way it happened is the lesson.

`mbRenewalsSoFar` divided by each ROW's own `next_renewal_at −
current_period_start_at`. At Norman that gap really is the billing cycle, and I
verified it there by remainder — weekly exact, monthly 0.06 off — and shipped it
platform-wide. **It does not hold generally: on a membership whose renewal is
imminent the gap is the time REMAINING in the period, not the period's length.**
Measured at Apex over 1,323 auto-renewers:

| row "cycle" | rows | max derived renewals |
|---|---|---|
| under 1 day (smallest **15 minutes**) | 8 | **44,665** |
| 1–6 days | 35 | 671 |
| weekly/monthly | 1,204 | 219 |
| quarterly/annual | 76 | 28 |

43 bad rows dragged whole plan averages. **A BILLING CYCLE IS A PROPERTY OF THE
PLAN, NOT OF ONE ROW'S TIMESTAMPS**, so `mbPlanCycles()` takes the MEDIAN across
each plan's members (sub-day gaps excluded from the vote), and a median is
unmoved by a minority of corrupt rows. The worst Apex row then reads 1,341 days
÷ 30 = **45**, which matches its 2022 start date. `mbRenewalsSoFar` also returns
null above 600 — if the dates are wrong a dash is honest and 44,665 is not.

**Generalise it: one org's data being clean is not evidence about what a column
MEANS.** A rule of the form "these two timestamps are X" has to be checked across
orgs before it ships.

**The spec's first fixture did not discriminate**, and mutation caught that too:
nine clean rows against one bad one passes with the sub-day filter deleted,
because a median over nine good values ignores the tenth. The fixture now makes
the bad rows the majority, which is the only shape where the filter matters.

### Churn is per RENEWAL PERIOD, in the plan's own cadence (2026-08-30)

Dan, on Apex: *"the average cancellation rates, those are crazy high"* — and then
the rule: *"always report the churn rate based on its renewal period."*

The number was right and the framing was wrong. **1,119 of 2,176 = 51% is
LIFETIME-TO-DATE**, everyone who has ever been on auto-renew since 2022. Sitting
in a KPI row between "Median cycle" and "Leaving at period end" it read as a
churn rate. Half a four-year-old subscription book having eventually cancelled is
unremarkable; 51% a month would be a fire.

`mbChurnPerCycle()` is the hazard rate instead: **of all renewal opportunities,
what share ended in a cancellation** — each member contributes its renewals as
opportunities taken plus one if it cancelled. Apex's book reads a few percent per
renewal rather than 51%.

- **Every per-plan rate carries its cadence** (`mbCadence`): a weekly plan losing
  5% a week and a monthly plan losing 5% a month are not the same thing, and the
  table would otherwise invite ranking them against each other.
- **The BOOK-level rate carries NO period label, deliberately.** A book of
  weekly, monthly and annual plans has no single cadence, so "per month" would be
  false for part of it. "Per renewal" is unit-free and true whatever the mix.
- The lifetime figure is kept as a sub-line, and says out loud that it is a
  running total rather than a rate.

### Rec Insights on the Auto-Renew tab, and a gate that was already dead

Dan: *"Add the Rec Insights button to this tab and wire it into some insights we
can gain."* Its own prompt (`AUTORENEW_SYS_PROMPT`), because every number on this
tab is easy to misread — the prompt spells out that the lifetime figure is not
churn, that a weekly rate and a monthly rate are different units, that renewals
are derived rather than logged, and that converting a candidate means capturing a
card rather than flipping a setting. It covers plans to fix ranked by revenue at
risk, who to contact, price/tier structure, and seasonality.

**THE BUTTON'S CONDITION WAS NEVER THE PROBLEM.** The whole insights section sat
INSIDE `{activeTab === 'memberships' && (...)}`, so adding `autorenew` to its own
gate changed nothing — the block was unreachable from any other tab. It is at
page level now. Found by the render check asserting the button and getting no
DOM; the source change looked completely correct.

### Naming people, and slicing retention per plan (2026-08-30)

Dan: *"This '2 ending soon' section is helpful, but can we add a drop
down/expansion option here to show WHO those two users are? Kinda unhelpful
otherwise."* And: *"I want to know this data by WHICH membership as well."*

**A count with nowhere to go is the dead end the Failed check-ins tile had**, one
report over. The pending count is now an expander: it keeps the ROWS, not just a
number, and lists member, email, last billing day and price — each name linking
to their Rec account via `ciUserUrl(recOrgId, r.userId)`. The memberships feed's
`User ID` is already the uuid the admin URL wants, unlike check-ins where
`Member ID` is a 6-character rec_id that looks identical and 404s.

**The list is CLOSED until asked for.** An always-open list is a different and
noisier feature; the render case asserts it is ABSENT from the DOM before the
click, which is the only thing that distinguishes the two.

**`mbPlanKey()` exists because THREE surfaces now key on the plan** — the table,
the retention pills and the retention filter. Two copies drift the first time the
`group || type` fallback changes, and then a pill matches nothing and silently
draws an empty chart. The spec fails if any surface re-derives it inline.

**Retention is filterable per plan, and that is not cosmetic.** A blended curve
answers "does this org retain", which is a different question from "does THIS
plan retain" — at Norman the weekly child-care plans cancel at 100% while the
monthlies sit near 42%, so the blend describes neither. Picking a pill rescopes
the cohorts; the render case keys on the **cohort count** (1 for a single-month
plan against 2 for the book), because a pill that lights without filtering looks
identical otherwise.

**A thin slice says so.** Under 20 members the panel warns that the curve is a
handful of individual departures rather than a trend — a cohort of one is a
100%-then-0% staircase, and drawing it confidently is how a chart lies.

**Still deferred (Dan): the full per-user list.** *"once we get some good metrics,
we'll add in specific user information here."* The leaving-soon expander is the
first slice of it, not the whole thing.

### Sales & Mix was unreadable (2026-08-30)

Dan: *"i have no idea what this entire sectio even means."* Fairly — it was a
second floating series with no axis and no printed values, over an analyst's
vocabulary (*volume effect*, *price/mix effect*).

The arithmetic is unchanged; the presentation is not. Revenue bars now **carry
their unit counts printed on them** rather than a disconnected second series, and
the panel leads with a plain-language headline (`data-sm-headline`) and closes
with a **verdict that names the cause** (`data-sm-verdict`) — "you sold N more
and still made less, because the average sale fell from $X to $Y" — instead of
leaving the reader to infer it from two signed numbers. `mbDecompose()` is
untouched and the spec still pins its VALUES.

### The price/volume bridge answers "where am I losing money"

Norman, measured: Jun→Jul **units +10.4%, revenue −74.9%**. Not churn and not a
discount — **mix**: the $224 family season pass stopped selling and $9 single
passes replaced it. `mbDecompose()` splits the move into volume (+$9,145) and
price/mix (−$75,307), **priced at the PRIOR month's average** so the parts sum.

**Asserting only that the parts sum cannot catch a wrong bridge** — `price` is
*defined* as `total - volume`, so the identity holds however volume is computed.
Caught by mutation; the spec pins the VALUES.

### Popular vs unpopular, with the why

The plan table carries **price beside units**, which is the only way "why is this
one unpopular" is answerable. It is what shows Norman's **YFAC Annual Individual
at $240 against a $20 monthly — exactly 12x, no discount for a year's
commitment** — so 135 people take the monthly and **17 take the annual**.

### Nothing was removed

Additive by construction, and the spec pins it: all 13 table columns, all 21
Excel columns, all 6 views, all 3 tabs and all 6 KPI cards are asserted still
present. Two new tabs (**Auto-Renew**, **Sales & Mix**), both deep-linkable —
the URL write-back was already generic, so the `?ci_rows=` erasure trap did not
recur.

**The scope note is ELI5 now** (Dan: *"this top blue box is way too verbose, no
one is reading that"*). The reasoning did not go in the bin — the excluded counts
are still exact, stated as a fact rather than argued for, and the "why" moved to
the tooltip of the thing it explains.

**Still don't build on `last_used_at`**: NULL on all 155,853 memberships and all
73,888 passes, so the shipped "Last Used" column has never had a value.
`cancel_reason` offers only *other / schedule / cost* and **94.2% say "other"** —
there is no "why they left" panel to build.

Guards: `scripts/memberships-revenue.spec.js` (**44 assertions, in CI**), which
LIFTS AND RUNS the eleven helpers. Mutation-tested seventeen ways, all failing by
name — the pre-v2 shape guessed as open-ended, the cache-invariant fallback
dropped, an unknown cycle defaulted to 30 days, the economics gate reading a
value instead of the column, the bridge priced at the current average,
`Auto Renew` reverted to the inferred column, an Excel column dropped, either
beacon missing from the log allowlist or from `SLACK_NOTIFY`, the card's trailing
`ORDER BY` dropped, and — for v3 — the pass branch deleted (the bug exactly as it
shipped), the pass test moved below the term tests, open-ended back to a bare
`hasPlanTerms`, `mbHasProductKind` hardcoded true, `Plan Season End` reverted to
`gg.end_date` alone, the `pass_schema` join dropped, and the `Product Kind`
column dropped. Plus six more for the denominator — season back in the base (the
bug Dan hit), the real-auto-renewer safety valve removed, `unknown` excluded,
the plan table re-deriving its own rule, and — browser-only, because no source
assertion can see it — the rate reverting to every paid row and season plans
back in the config table.
Plus **23 `ci-check-render.js` cases**, keyed on computed values rather than "a
panel rendered", over a fixture with a `prev2` stub mode that drops the five v2
columns **and `Product Kind`**, and twelve $5 gate admissions carrying it — so
both the pre-v2 degradation and the pass misclassification are proven in a real
browser rather than asserted in source. The old `no candidates guessed without
plan terms` case is **gone**: it pinned a confident `0` on a pre-v3 feed, which
is precisely the false-zero v3 stopped rendering.

**One existing assertion had to be loosened.** `report-settings.spec.js` pinned
`"settings-open"]` — the END of the log route's ALLOWED array — so appending any
later event broke it with nothing about settings-open changing. It now tests
membership in the array, and was re-verified to still catch settings-open being
removed.
## El Segundo's aquatics asks — residency, lane hours, section location (2026-08-31)

Joseph Lormans (El Segundo) asked for four aquatics reports by mid-September on a
July–June FY: **lane hours**, **class/instructional programming** (per class, by
location, by month, by instructor), **drop-in/public swim**, and **passes &
memberships** split resident vs non-resident. Dan: *"lets do 4 and 2 with the
small mb adjustments, then surface the resident vs non-resident metric in the
passes and memberships report"* and *"I like the idea of adding a top level
location filter"* on Programs.

### RESIDENCY IS A TOGGLE ON THE GROUP, NOT A WORD IN ITS NAME

Dan: *"wouldn't it make more sense to flag a group that is residency by
confirming the 'residency group' toggle is turned on instead of doing an
ilike?"* Yes, and the ILIKE was actively wrong. `group.group_type` carries three
values (`for-purchase` 945, `special-group` 582, `residency` 87), and cards
17294 / 17788 / 17689 all tested
`group_type ILIKE '%residen%' OR name ILIKE '%residen%'`.

**"Non-Resident" CONTAINS "Resident".** That name clause sweeps in **96 groups
across 35 orgs — 4,099 live memberships, 1,446 households** that are not
residency groups at all, including **516 people on "2026 Summer/Annual Pool Pass
(Non-residents)" reported as RESIDENTS**. Per org: Tullahoma 43, Reading 38,
Euclid 31, Pawnee 22, Windham 16, Niagara Falls 6, Clarkstown 2.

It is **pure false-positive removal and needs no negative guard**: every
residency-TYPED group already matches the type half (`'residency' ILIKE
'%residen%'`), and **0 orgs have a residency-NAMED group without a
residency-TYPED one** — so no org loses coverage. "Non-Resident Groups" is typed
`special-group`, which the toggle simply cannot match.

**Clarkstown has zero residency-typed groups**, so its `Resident?` column goes
NULL entirely rather than reading `No` on every row — which is the correct
answer, and the reason the column is presence-gated.

### THERE ARE THREE PATHS TO A RESIDENT AND THE OBVIOUS TWO ARE NOT ENOUGH

The first version of card 17301 v5 returned **`No` on all 3,132 El Segundo rows
while 1,317 resident households existed.** Every join is a LEFT JOIN, so a miss
renders a confident `No` — silently.

1. **the product's household** — `membership_household_id` / `pass_household_id`.
   NULL unless the product itself is household-coverage; **every one of El
   Segundo's 3,132 rows is `coverage='individual'`**, so both are null on every
   row. (The purchases view splits this id in two and has no single
   `customer_household_id`, unlike the facility card's booking view.)
2. **the BUYER's own household** — `users.household_id` via `customer_user_id`.
   **This is the path that carries the answer**: 2,610 of El Segundo's buyers
   have it populated and the residency group attaches at household level.
3. **the buyer as an individual** — `membership_user`. Zero rows at El Segundo,
   but the path for orgs that enrol residents individually.

None subsumes the others. **Worth knowing before reconciling a closed FY:** the
test is evaluated at query time against CURRENT membership — "is this person a
resident today", not "were they a resident when they bought".

### Residency is a FILTER, not a sub-tab

Dan asked: *"should that be a metric on the report or a whole new sub-tab?"* A
tab answers the question once and then duplicates every panel beside it;
residency is a **dimension**, so it belongs on the toolbar where it re-scopes
what is already there. `residencyFilter` is applied **inside
`filteredAnyStatus`** — the one place every other toolbar filter already lives —
so a single insertion scopes all four tabs, and the churn metrics keep reading
the any-status view. Plus one side-by-side split panel, and a `Resident?` column
in the Excel export writing an empty string (never `No`) for unknown.

### THE POOL LANES ARE FACILITY RESERVATIONS, AND I GOT THIS WRONG FIRST

I reported lane hours as **blocked** on the strength of `court.type = 'pool'` —
11 hours all-time. Dan: *"For the pool lanes, they are all facility
reservations."* Right, and then the why: *"in this case pool lanes are marked as
'court' so users can instant book them, but this is atypical."*

Re-measured: **74 of El Segundo's 98 lane sites are typed `court`**, and the real
figures are **15,072 slots / 70 lanes / 29,981 hours all-time** (7,252 in the
last 30 days). The Aquatics vertical was showing 24 sites while 70 carried the
traffic. Generalise it: **a type filter that returns almost nothing is a question
about the filter, not an answer about the data.**

`refineSiteType()` exists for exactly this reason already (rinks and gyms are
typed `court` so they instant-book), but El Segundo's lanes are named
"North Lane 1 - A", "Lane 3 - B", `Inst Lane 4-2" Depth (25Y) - A` — **no
pool/swim/aquatic word anywhere**, so the name rule missed all of them.

**THE LANE BRANCH IS THE ONE PLACE THAT FUNCTION CONSULTS THE LOCATION**, and it
is a deliberate, narrow exception. That never-read-the-location rule protects a
tennis court sitting at "Aquatic Park"; a site named "Lane 3 - B" is not a tennis
court — the name is genuinely ambiguous and carries no sport, so the location is
the only thing that can resolve it. **Two independent guards keep the original
intent**: a competing court word in the NAME rejects the site, and so does a
non-aquatic LOCATION.

**The counterexample is real, not invented.** Douglas County's **Johnson Lane
Park** has "Johnson Lane Tennis/Pickleball Court #1/#2" and "Johnson Lane 2-Half
Court Basketball Court" — **"Lane" as a ROAD name**. That is the
`/ball ?field/` → "Football Field" bug one field over.

Measured platform-wide before shipping: 487 sites match `\blane\b`, 373 already
typed `pool`, 305 already recovered by the name rule, **74 court-typed lanes the
name rule misses, 68 of them at an aquatic location**. The 6 exceptions are 3 El
Segundo archived sites and the 3 Johnson Lane Park courts. **Blast radius: two
orgs — El Segundo +66, Northern Door +2.**

### Card 17295 v6 — location and instructor

**`session.location_id` is EITHER a court id OR a location id.** Card 17298
already resolves both and `sec_loc` mirrors it exactly; reading one side silently
loses every section scheduled the other way.

**`facilitator_id` IS `instructor.id`, NOT `users.id`.** The obvious join matches
**0 of 34,070 rows platform-wide** and, being a LEFT JOIN, would render an empty
Instructor column for all 29 orgs without erroring. The path is
`section_facilitator → instructor → users` via `instructor.user_id`, and the name
expression is lifted **verbatim from card 17755** so Instructor Payout and
Programs cannot print different names for one section.

**`location_count` ships beside `location`** because a section CAN span more than
one — 287 of 42,457 located sections (0.7%), and **zero of those collapse to a
single building** — so "location" alone would be a confident half-truth. Primary
is the location holding the most sessions, **ties broken by name so two runs of
the same query cannot disagree.**

Verified no fan-out before pushing: `sec_loc_agg` 282 rows / 282 sections,
`sec_fac` 121 / 121.

### The Programs location filter needed the deep-link work done AGAIN

Third and fourth instances of traps already written down in this file:

- **`loc` had to be added to `getParams()`'s explicit whitelist**, or
  `params.loc` reads `undefined` and the deep link silently does nothing — the
  `?ci_rows=` bug verbatim, and invisible in source review.
- **`progEffectiveLoc(want, options, loaded)` takes a `loaded` argument.**
  Resolving on mount, when the feed has not answered and there are therefore no
  options YET, is not the same fact as "this feed has no such location".
- **The URL write-back mutates only `loc`** rather than rebuilding the query
  string — `?token=`, `?section_id=`, `?program=` and `?tab=` all ride on this URL.
- **Sections with no located session get their own option** (`LOC_NONE`), or they
  vanish the moment anyone picks a location with nothing saying they were dropped.
- Every panel downstream reads the `locRows` funnel, never `rows` — the facility
  Summary invariant, asserted mechanically.

### A blank Aquatics tab, caught only by the render check

`AquaticsHours` copied heat-map markup that called `hour12()` — **a local alias
inside another component, not a module-scope helper.** It threw and React
unmounted the tree. `node --check`, the HTML parse check, the boot check and all
30 specs passed on the broken version; **`ci-check-render.js` is what said "the
page came up blank"**, exactly as that section promises. Fixed to `oeHour12`, and
all 11 identifiers the new component reads were then checked against module scope.

### The 17294 mirror was 53 lines STALE — pushing it would have deleted a feature

The read-live-before-writing rule earned its keep again.
`sql/report-cards/17294-facility-rental-report.sql` was missing the **entire
`Paid?` feature** (`paid_rollup`, `rental_items`, `item_tx`). Pushing the repo
copy to make a one-line residency change would have silently removed that column
for all 29 orgs. The mirror was rebuilt from the live card first, then edited.

**A process slip to disclose: 17689 was pushed WITHOUT a live read.** It serves
(42,305 rows in 20.9s) and the residency swap is one line, but unmirrored edits
since 2026-08-22 cannot be ruled out from here — Metabase keeps revision history
on the card if it needs checking.

### PARKED: per-org site scoping for a report tab

Dan: *"since the spec for sites on the aquatic report is pretty org specific …
why not make this a facility report setting"*, then refined it to *"which
location/sites need to be included in the report tab — a pulldown of
locations/sites so I/someone can edit the report settings and include/exclude
locations and sites?"*

The refined version is the right one, and it is measurable: **a site-TYPE setting
is too coarse** — El Segundo has 92 court-typed sites, of which **71 are lanes
and 21 are not** (8 Pickleball, 2 Basketball, Paddle Tennis, 3 Stair Areas), so
"include type court" drags 21 non-aquatic sites onto the tab. A **LOCATION
picker includes 74, misses 0 lanes, and over-includes exactly 3** — the Stair
Areas at El Segundo Wiseburn Aquatic Center. Two locations to tick: El Segundo
Wiseburn Aquatic Center, Urho Saari Swim Stadium.

Not started. Two things to settle first: `REPORT_SETTINGS_SCHEMA` registers only
`roster` today, and the whole panel is **super-admin gated behind the
`reportSettings` flag** by Dan's own earlier call (*"this power is too much for
an org user to handle"*) — so "the org admin could set it" is a change to that
decision, not just a new schema entry.

### Guards

`scripts/aquatics-lanes.spec.js` (**27 assertions, in CI**) and
`scripts/programs-location.spec.js` (**21 assertions, in CI**), both of which
**LIFT AND RUN** the real functions rather than regexing them — a regex passes on
an inverted comparison. The lane spec's cases are all real site + location names
from prod, Johnson Lane Park included.
`memberships-revenue.spec.js` 70 → 79. Ten new `ci-check-render.js` cases over
`prev5` and `nores` stub modes, so the pre-v5 degradation and the lane
misclassification are proven in a browser rather than asserted in source; the
lane fixture carries `court`-typed rows named "North Lane 1 - A" **plus a
`Johnson Lane Tennis Court` counterexample**.

**A spec-hygiene note worth keeping:** `LOC_NONE` must be written in a spec as a
BACKSLASH-u-0000 escape, never as a raw NUL byte — a raw NUL makes **git classify the
whole file as BINARY**, and a spec that cannot be read in a diff cannot be
reviewed.

`scripts/report-cards.manifest.json` gained **programs/apex** and
**users/norman** rows: both are shared cards that had no cache-independent
sign-off row at all.

## Absent and Failed check-ins (2026-08-26) — one log, two grains

Dan: add 'absent' and 'failed' to the check-in reporting, "pulled directly from
the visitor log". **There is no `visitor_log` table** — that is the product's
name for `public.attendance_event`, which carries SEVEN types, not two:

| type | rows | target_type |
|---|---|---|
| `check_in` | 556,431 | session |
| `check_out` | 37,754 | session |
| `check_in_undone` | 1,200 | session |
| `check_out_undone` | 469 | session |
| **`marked_absent`** | 432 | **session** |
| **`check_in_denied`** | 58 | **organization** |
| `marked_absent_undone` | 22 | session |

**The grains differ, and that decided where each one goes** (Dan's call, after the
measurement): `marked_absent` is session-scoped so it attributes to a section →
**Absent column on the Programs Check-Ins band** (card 18547).
`check_in_denied` is scoped to the ORGANIZATION — all 58 are membership (52) or
pass (6) scans, none has a `target_id` resolving to a session — so a per-section
Failed column could only ever be a dash on every row, forever. It goes on the
**Memberships Check-Ins tab** (card 18151), which is already org-grain.

### THE LOG IS APPEND-ONLY — an undo does not delete anything

`attendance_event` has **no `deleted_at`**. Undoing a mark writes a
`marked_absent_undone` row and the original stays. So a naive
`COUNT(*) FILTER (WHERE type='marked_absent')` counts absences an admin took
back: measured, **Chico 13 instead of 12 and Apex 6 instead of 5**.

Absence is therefore a **STATE**: `DISTINCT ON (target_id, participant_user_id)
… ORDER BY created_at DESC, id DESC`, keeping the pairs whose latest event is the
mark. Two details are load-bearing:

- **The state is resolved over ALL history, then the surviving mark's own date is
  windowed.** Resolving inside the window would count a mark whose undo happens
  to fall the other side of the range.
- **`id` is the tie-break**, so two events in the same millisecond cannot resolve
  differently between runs.

**The same gap still exists for CHECK-INS** — 1,200 `check_in_undone` events are
not netted out of the 556k (~0.2%). Deliberately left alone: Dan said keep the
program check-ins and check-outs as they are, and changing them would move
figures orgs have been reading. Worth revisiting as its own decision.

### Absences on ARCHIVED sections are dropped, and that is correct

The card already excludes `archived_at`/`canceled_at`/`deleted_at` sections, so
those sections have no row for an absence to sit in. Measured: **Reading loses 16
of 66, Jurupa 1 of 13, Apex all 5.** Consistency with the table beats completeness
here — the alternative is a count with nowhere to display it.

### Card 18547 v2 — restructured WITHOUT moving an existing number

The check-in/check-out aggregate is lifted into its own `att` CTE unchanged, the
absence state into `absent_state`/`abs`, and the section list is the **UNION** of
both — so a section where everyone was marked absent and nobody scanned still
gets a row. Verified before pushing, per org, against the deployed card:

| org | sections | check-ins | rows differing on any existing column | Absent |
|---|---|---|---|---|
| Apex | 67 = 67 | 1246 = 1246 | **0** | 0 (all on archived sections) |
| Watertown | 69 = 69 | 7734 = 7734 | **0** | 40 marks / 32 people |

### Card 18151 v3 — a denial is shaped exactly like a check-in, which is the trap

Denials share the card's own `check_in_method_type IN ('membership','pass')`
filter, and all 58 carry a `participant_user_id` whose `users` row survives the
deleted/`[DELETED]` filter, plus a `desk_location_id` and a `check_in_method_id`.
So the card change is only a widened type filter plus a `Status` column
(`'Checked In'` | `'Failed'`).

**But that widens the row set of an existing feed** — the facility Summary bug
verbatim (invoice fee lines arrived shaped like bookings and every row count
became a booking count). The defence is that `ciView` was *already* the single
funnel every panel reads, so excluding failures there fixed every panel at once:

- `ciIsFailed()` is at **module scope**, not inside the component, so
  `checkins-view.spec.js` can RUN it rather than regex over it (the
  `nightStateFrom` lesson).
- **A row with NO `Status` is a SUCCESS.** Testing `=== 'Checked In'` instead
  would make `ciOk` empty against any pre-card feed — including every warm 4-hour
  cache entry — and take the whole tab down. That is the single most dangerous
  line in this change.
- The desk-location counts, the "All locations (N)" label and the empty-state
  message all read successes now.
- **A window with only failures is a new empty state.** With `ciLoc === 'all'`,
  `ciView` used to BE the feed and could not be empty; now it can, and the old
  message would have said "No check-ins at all" — naming a location the reader
  never chose.

### The Failed COUNT was not enough — you have to be able to open it (2026-08-26)

Dan, on the preview: *"i'm seeing the absent people on the program check in
section, but how about the membership check ins, no failed? need a way to filter
failed memberships here."*

Two separate things, and it is worth keeping them apart:

1. **The card and column were working.** Clarkstown's 13 denials are all on
   **2026-08-04**, and the default window is the last 7 days, which holds 15
   check-ins and no refusals. Verified on the preview: Aug 19–26 → 15/0,
   Aug 1–26 → 49 accepted / **13 Failed**, Jan 1–26 Aug → 75/13.
2. **The tile was a dead end.** It reported a count with nowhere to go, so
   "how many were turned away" was answerable and "*who*" was not.

So the Recent Check-Ins list gained an **Accepted / Failed** toggle, and the
**tile itself is now the way in** (it is what prompted the question).

- **IT SCOPES THE LIST ONLY, and that is the whole design.** Every aggregate —
  check-in counts, peak hour, avg per day, time of day, top members, the desk
  counts and the tab badge — stays successes-only, because a refused scan is not
  attendance and folding one in would report a member who was turned away as
  having attended. That is the facility-Summary error (fee lines counted as
  bookings) one field over. It is therefore a **per-panel view toggle**, exactly
  like the All/Weekdays/Weekends slice already on the time-of-day chart, and the
  panel title names the set it is showing. `checkins-view.spec.js` asserts that
  **no panel above `id="ciRecent"` reads `ciListView`** — the mechanical form of
  that invariant.
- **A `failed` selection must not survive a window or desk with no failures.**
  The toggle is hidden in that state, so holding the selection strands the reader
  on an empty table with no way back — and `?ci_rows=failed` is a shareable link,
  so it *will* be opened against a window that has none.
  **`ciEffectiveRowSet(set, failCount)` is at module scope**, read by both the
  render and the reset effect, so the two cannot disagree and a spec can RUN it
  (the `nightStateFrom` lesson again).
- **No toggle where there are no failures** — a Failed button over an empty list
  is a dead end, and the tile already says "every scan accepted". The render case
  asserts the toggle is **ABSENT from the DOM**, via a `nofail` stub mode that
  keeps the `Status` column but drops the denials. That is a different state from
  a feed with no `Status` column at all, which hides the tile entirely.
- **THERE IS NO "WHY", AND NONE IS GUESSED.** `attendance_event.side_effects` is
  `[]` on **all 58** denials — no reason is stored. And it is not inferable
  either: of the 52 membership refusals only **2 were expired, 1 not yet started,
  2 canceled**, so **47 of 52 were refused while the membership looks valid on
  its own dates**. A "Reason" column would be invention sitting beside real rows
  — the same fabrication the wizard's prose/number split exists to prevent. The
  list says who, when, where and which product, and the note on it says the log
  records no reason. The spec fails if a `Reason` column appears.
- Activity: `checkin-failed` (🚫), debounced **by desk** like `checkin-loc` —
  checking the north desk's refusals then the south's is two questions. Carries
  the count, because an org opening a list of refused scans is the signal.

### Two bugs the RENDER CHECK caught that nothing else would have

Both were in my own patch, both passed every source assertion, and both are the
same family as things already written down here.

- **`?ci_rows=failed` could never work.** The resolver ran on mount, when
  `ciRows` is still null and there are therefore no failures *yet* — which is
  not the same fact as "this window has none" — so it flipped the link to the
  accepted list and the write-back effect then destroyed the state. **A feed that
  has not answered is not an empty answer**, exactly as with the permits column
  and the campmap's `POS_OK`; `ciEffectiveRowSet` takes a `loaded` argument for
  it. (Two independent gates gate this now — the argument and the effect's own
  `ciRows &&` — so the render case only fails when BOTH are removed, which is
  how the bug actually shipped. The unit assertions catch each one alone.)
- **`getParams()` is an explicit whitelist and I did not add `ci_rows` to it**,
  so `params.ci_rows` was silently `undefined` and the deep link did nothing.
  Nothing about that is visible in source review — the code reads correctly.

**A window where EVERY scan failed showed no list at all.** `ciView.length > 0`
gates the whole aggregate block, so with nothing accepted the reader got
"11 scans were turned away" and no table under it — the count-with-nowhere-to-go
bug in its sharpest form, inside the change meant to fix it. So the list is now
`ciListPanel()`, **one function called from two places** (the aggregate block and
the failures-only branch) rather than two copies of a table that would drift the
first time a column changed, and the resolver defaults to the refusals when
nothing was accepted. No toggle renders there — there is nothing to switch back
to. A desk misconfigured for a day looks exactly like this.

**And extracting the list broke the tab, exactly as the coding rule predicts.**
`recOrgId` (the org uuid the member links are built from) was a `var` declared
*inside* the aggregate IIFE, so lifting the table into a function above that
block threw **`recOrgId is not defined`** and blanked the Check-Ins tab — the
blank-page class this repo has shipped twice. It is now one `const` at component
scope, above the list that reads it. Two things to take from it: **a refactor
that moves JSX moves what it can see**, and the render check is what turned it
into a caught error instead of a blank tab in production. `node --check`, the
HTML parse check and all 28 specs passed on the broken version.

Guards: `checkins-view.spec.js` 53 → 86 assertions, mutation-tested ten ways
(the list reading raw state instead of the resolved set, the reducer dropping the
strand resolution, the load gate removed, the write-back ungated, an aggregate
reading `ciListView`, the toggle offered with zero failures, the tile no longer
opening the list, an invented `Reason` column, the scroll target removed, and `recOrgId` put back inside the aggregate block) —
all ten fail by name.
`checkin-beacons.spec.js` 12 → 16, mutation-tested three ways (dropped from
`SLACK_NOTIFY`, dropped from `ALLOWED`, debounce key reverted). Plus nine
`ci-check-render.js` cases over two new stub modes (`nofail` — the `Status`
column with no refusals in it, distinct from a feed with no column at all; and
`failonly`), including the strand driven as a real link and the deep-link bug
reproduced in a browser.

### Both cards CAST their date bounds — which kills one failure mode, NOT the re-flip

Found by dry-running the new SQL with a Text-style substitution before pushing,
which is the whole reason to do that. The original 18547 wrote:

```sql
AND ae.created_at < {{end_date}} + INTERVAL '1 day'
```

That only parses while the tag is **typed Date** — Metabase then substitutes
`CAST('2026-08-26' AS date)`. An API push regenerates every tag as **Text**, and
Postgres reads the bare string as an interval literal:

```
ERROR: invalid input syntax for type interval: "2026-08-26"
```

…so the card stays broken until someone flips the tags by hand. **Both cards now
cast explicitly** (`{{end_date}}::date + INTERVAL '1 day'`), which works under
either tag type — the same reason `sql/facility-permits.sql` and
`sql/gl-account-detail.sql` have never needed a re-flip. `checkin-status.spec.js`
fails on an uncast date tag in either file (comments are stripped first, since
they quote the broken form on purpose).

**But the push→flip dance STILL APPLIES — I got this wrong once, so read on.**
Casting removes ONE of two independent failure modes. The other is that an API
push leaves each card registering **SIX** parameters: the three original
`date/single` plus three new `string/=` for the same slugs. The app binds by
slug, so it then sends two values per variable and Metabase answers
`An error occurred.` — nothing in the SQL can fix that, only a human flipping the
tags in the UI clears the duplicates. Confirmed on both cards immediately after
this push: 6 params, HTTP 400, and 3 params + 200 after Dan's flip.

So: **cast the bounds anyway** (it kills the interval-parse failure and is worth
copying to other cards as they are touched), but still expect the flip. Verified
separately that the cast SQL returns identical figures — Watertown 69 sections /
7734 check-ins / 40 absent / 32 people — with an uncast string standing in for a
Text tag.

**And do not hand-roll the verification probe.** A `{type,target,value}` shape
without the registered parameter's `id` returns `An error occurred.` for EVERY
card — proven against card 17293, which serves fine in production. That looks
exactly like a broken card and cost time here. Use
`scripts/verify-report-live.js`, which merges values onto the card's own
registered parameters by slug.

### Both pages are correct BEFORE and after the cards ship

`hasAbsent` / `ciHasStatus` are **presence**, not counts: the Absent column and
the Failed tile are hidden, not zeroed, on a feed without the column. A 0 there
says "nobody was marked absent" when the truth is "this feed cannot tell us".
`r['Absent']` reads to **null**, never 0 — `fmtNum(undefined)` is 0, which is how
that lie gets told.

Guards: `scripts/checkin-status.spec.js` (10 assertions, in CI) pins the SQL rules
and the null-not-zero handling, mutation-tested five ways (naive count, section
list back to attendance-only, undo type dropped, absent read as a number,
denials dropped from the memberships feed). `checkins-view.spec.js` 41 → 53,
mutation-tested four ways including the inverted `ciIsFailed` that blanks the tab.
Plus seven `ci-check-render.js` cases — **the Programs page had no render case at
all before this** — including `programs · absent column hidden pre-card`, which
drives the no-column feed via `stubMode` and asserts the tile is ABSENT from the
DOM (`ci-check-render` gained an `absent:` selector for that: "renders a 0" and
"renders nothing" are different claims).

**Repo SQL mirrors now exist** for both cards (`sql/program-checkins.sql`,
`sql/memberships-checkins.sql`) — there were none before, so the live card was
the only copy. The live card is still the source of truth; read it first.

## Tab chips on the Programs and Community Intel cards (2026-08-28)

Dan: *"i like what you did here with the tabs being directly clickable. can you
roll that out for the programs report and the community intelligence report cards
too?"*

Three lines of `CARD_TABS` config. **Neither page could honour the link those
chips produce**, and both failures were silent.

- **`programs.html` read `?tab=` and then DESTROYED it.** The value went into
  initial state, and `fetchData` — which runs on mount — called
  `setTab('summary')` a millisecond later. So every chip would have landed on
  Summary. Same shape as the `?ci_rows=failed` deep link the check-ins
  write-back used to wipe. The reset is right for **re-running** a report and is
  kept; `fetchData(sd, ed, initial)` skips it on the first load only, and the Run
  Report button deliberately does not pass the flag.
- **A deep-linked tab never asked for its feed.** Participants, Retention and
  Fill Rate fetch lazily from `switchTab`, which a URL never calls — and
  `{tab === 'participants' && …}` with `demoRows` null and `demoLoading` false
  renders **NOTHING**: no loader, no error, no empty state. `ensureTabData(t)` is
  now one function called from the click AND from mount; two copies would drift
  the first time a tab gained a feed.
- **`users.html` did not read `?tab=` at all**, so every Community Intel chip
  would have landed on Demographics. It also now mirrors the tab back into the
  URL on switch (`replaceState`, and the default tab CLEARS the parameter rather
  than writing `?tab=demo`), so the address bar is shareable the way the chips
  are.

### Which tabs get a chip, and why the omissions matter

| card | chips | left off |
|---|---|---|
| `programs` | Revenue, Participants, Retention, Fill Rate, Check-Ins | **Summary** (the card already lands there — a chip would be noise) and **Detail** (a section drill-down with nothing to drill into from here) |
| `users` | Revenue, Strategy | **Guests** and **Products** |

- **`guests` is not a URL destination.** It renders only when
  `s.guestCount > 0`, and the feed has not answered at mount — so honouring
  `?tab=guests` would assert something unknowable, and a guest-less org would get
  a **blank body with no tab button to come back from**. Same load-vs-empty rule
  as the permits column and the campmap's `POS_OK`.
- **`products` is gated on the org HAVING that report**, so a chip would be a dead
  end for everyone else.
- Both resolvers fall back to the page's default rather than rendering nothing,
  and **both are at module scope** (`progEffectiveTab`, `usersEffectiveTab`) so
  the spec can RUN them — the `nightStateFrom` lesson again.

Guards: `scripts/report-tabs.spec.js` (69 assertions, in CI) lifts and runs both
resolvers and asserts **every chip resolves to its own tab** — the invariant a
config-only change breaks silently. Mutation-tested six ways: the mount fetch
clobbering the tab again, the deep link not fetching its feed, `users.html` back
to ignoring `?tab=`, `users` accepting any tab, `detail` accepted with no
`section_id`, and a chip naming a tab the page would rewrite.

Plus six `ci-check-render.js` cases keyed on **which tab is LIT**, not on "a tab
strip rendered" — landing on the wrong tab looks identical otherwise. Three of
them were seen to fail in a real browser on the real regression.

### …and the Fast Track card (2026-08-28)

Dan: *"add the subtab thing for the Fast Track report"*. Three more lines of
`CARD_TABS` — Revenue, Conversions, Demographics — and **the page could not
honour the link they produce either**, in the same two ways plus one new one.

- **`fasttrack.html` did not read `?tab=` at all**, exactly like `users.html`.
  `activeTab` started `'overview'`, so every chip would have landed on Overview.
- **The share-link effect would have DESTROYED it.** That effect rebuilds the
  whole query string from `token`/`season`/`search` and runs on mount, so a
  `?tab=` that survived being read is erased a millisecond later. Third instance
  of the `?ci_rows=` write-back bug. It now writes `tab` too — and so does
  `recShareLink`, or Copy Link hands over a URL that drops the tab the sender was
  looking at. **The spec had to be scoped to the EFFECT**: both builders carry
  the identical line, so a bare `.test()` passed with either one alone — verified
  by mutating each half separately.
- **A deep-linked tab never asked for its feed.** All three chipped tabs render
  from the Community Intel feed, fetched by `switchTab`, which a URL never calls.
  `ensureTabData(t)` is now one function called from the click AND from mount.

**Overview gets no chip** (the card already lands there) but **stays ACCEPTED**
by `ftEffectiveTab` — a `?tab=overview` link someone was handed must not stop
working because the card no longer emits one. Resolver at module scope, like the
other two, so the spec can RUN it.

**The chip icons are pinned to the page's own tab strip.** 💰 Revenue, 🔥
Conversions, 👥 Demographics — I first gave Revenue a 🔥 too, which would have
put two identical glyphs on one card and disagreed with the tab it opens.

Guards: `report-tabs.spec.js` 69 → **98 assertions**, mutation-tested seven more
ways (the page ignoring `?tab=`, the write-back dropping it from either builder,
`activeTab` out of the effect deps, the mount fetch removed, a chip naming a tab
the page rewrites, Overview given a chip, and a chip icon drifting from the
page). Plus four `ci-check-render` cases, three of which were seen to fail in a
browser on a real regression — and they discriminate: removing the mount fetch
leaves *lands on the tab* and *survives the write-back* PASSING while only
*fetches its feed* fails. That one asserts on the browser's own
`performance.getEntriesByType("resource")` rather than on rendered text, because
the harness answers `/users/api/data` from a generic stub and the panel looks
much the same either way — what regressed is that the REQUEST was never made.

## Slack activity notifications — wire every new surface (IMPORTANT)

Standing rule (see Working preferences): any new button, export, download, or
notable interaction ships WITH a Slack activity ping. Don't wait to be asked.

The mechanism lives in `server.js` under "Slack activity notifications":

- `SLACK_NOTIFY` — the Set of event names that actually post to Slack. Add the
  new event name here or it stays silent.
- `SLACK_EVENT_META` — `{ emoji, verb }` per event; the default message reads
  `${emoji} ${orgName} (\`slug\`) ${verb} *${report}*`. Add a custom branch in
  `notifySlack()` if you need extra fields (see the `email` / `game` branches).
- Debounce: `notifySlack()` dedups by `${org}|${report}|${event}` for
  `SLACK_DEFAULT_DEBOUNCE_MS` (60s). Give an event a custom debounce key there if
  distinct sub-events (e.g. per-game, per-recipient) should each post.
- Server-side events (a route the server handles, e.g. the Puppeteer `pdf`) call
  `logEvent(org, report, event, req, extra?)` directly — it appends to the events
  JSONL AND calls `notifySlack`.
- Client-side events (things the server can't see — a client export, a button
  click, a mini-game) beacon `POST /:org/:report/api/log?event=<name>[&extra=…]`
  (fire-and-forget, `keepalive: true`), and the event name must be in that route's
  `ALLOWED` list. Pass extra context as query params and thread them through as the
  `extra` object into `logEvent`.

Wired so far: `created`, `org-deleted`, `pdf`, `excel`, `print`, `summary`
(🧾 lite export), `game` (🕹️ hidden banner mini-game plays),
`outdoor` (🎪 Outdoor Event Spaces tab opened, with the booking count), `view`, `insights`,
feedback/votes, `email`, `munis`, `permits`, `map`, `epact`, `settings-open` (🔍 the report-settings panel was opened, saying whether the org
is already off the platform defaults), `settings-save`/
`settings-reset` (⚙️ a per-org report default changed, naming the fields and
flagging an ePACT template that left the verified set) (📤 a participant list
exported for the ePACT camp-forms vendor, with the count and whether it was one
class or the whole view), and three platform alerts —
`report-down` (a report's card stopped answering, links straight to the report
with its token), `schema-break` (a table or column the reports depend on is
gone), `param-drift` (a date template tag is no longer typed Date). The three
alerts debounce at 6h and @-mention if `SLACK_MENTION_USER_ID` is set. Inert
unless `SLACK_WEBHOOK_URL` is set (prod has it).

## Slack posts ONLY from production — previews were posting too (2026-08-29)

Dan: *"look into these slack notifications…three this AM reporting different info
about the prior day's stats?"* Three **"Daily activity — Fri, Aug 28"** digests
landed within minutes, each with different numbers for the same day.

**Railway PR previews inherit the SERVICE's variables — `SLACK_WEBHOOK_URL`
included — and each preview gets its OWN volume.** So every preview ran the
midnight cron against its own tiny `events.jsonl` and posted the result to the
live channel. The project had exactly three environments and there were exactly
three digests:

| message | environment |
|---|---|
| 429 views across 19 orgs — watertown 321 · apex 52 | **production** — the real one |
| 15 views, *"top reports: report-wizard 15"* | `rental-report-pr-169`, the parked wizard branch |
| *"Quiet day: nothing logged."* | `rental-report-pr-159`, parked, empty volume |

**THE DIGEST WAS ONLY THE VISIBLE HALF.** `notifySlack` reads the same constant,
so every `view` / `generate` / export driven on a preview has been landing in the
activity feed all along — and nothing in the message says which environment sent
it, so preview traffic is indistinguishable from real usage in the feed Dan reads
to decide what orgs actually use. Any usage judgement made from that feed since
previews started is contaminated by whatever was being tested that day.

The fix is one gate at the source: `SLACK_WEBHOOK_URL` resolves to `""` unless
this is production. Both post sites already degrade to a log line when it is
empty, so nothing else changed.

**IT FAILS OPEN, deliberately, and that asymmetry is the part to keep.** Only a
NAMED non-production Railway environment is muted; an *absent*
`RAILWAY_ENVIRONMENT_NAME` still posts. Muting the unknown case is the tempting
stricter rule and it is wrong here — off-Railway means local or CI, where the
webhook is essentially never set, and if Railway ever stopped injecting the name
the strict rule would silently kill the production feed. A duplicate is a
nuisance; a feed that quietly stops is the failure this repo keeps being bitten
by. The spec pins the asymmetry so nobody "tightens" it later.

`/api/admin/report-activity` now reports `environment` and
`slackPostingEnabled`, because a muted preview and a dead production feed look
identical from the outside.

Guard: `scripts/slack-production-only.spec.js` (**14 assertions, in CI**), which
LIFTS AND RUNS the gate under each environment name rather than regexing it — a
regex passes on an inverted comparison. Mutation-tested five ways, all failing by
name: no gate at all (the bug as it shipped), the gate inverted, the strict
"mute anything unknown" variant, a third post site reading `process.env`
directly, and the admin route no longer naming the environment.

## Metabase card updates via API/MCP — template-tag types reset (IMPORTANT)

Updating a card's SQL through the Metabase API/MCP (`construct_native_query` +
`update_question`) regenerates ALL template tags as **Text** — date tags lose
their Date type, so this server's `date/single` parameters stop matching and the
public card returns "An error occurred." (the app then serves stale cache).
**After ANY programmatic card update, Dan must open the card in the Metabase UI
and flip each date variable (Start Date / End Date) back to type Date.** Batch
card updates so Dan can do all the flips in one visit, verify with a
server-style parameterized request afterward, and never assume a card update is
done until that verification passes.

**Read the live card BEFORE writing to it (learned 2026-08-23).** The repo's
`sql/*.sql` file is a mirror, not the source of truth, and it drifts: card 19570
carried a v2.1 speed refactor the repo file did not, so pushing the repo copy
would have silently reverted it — the same shape as the perf regression that got
v2 rolled back in PR #77. Fetch the card's SQL, apply the change to *that*, save,
then mirror the result back into the repo file.

**This is now watched automatically (PR #134).** `checkCardParamTypes()` in
server.js reads every served card's public definition daily at 5:40 and once
after boot, and Slack-alerts (`param-drift`) on any `start_date`/`end_date` that
is not a `date/*` type. It reads definitions only — no query is executed, so it
cannot time out on a heavy card, and it cannot fix anything: only the Metabase UI
can flip a tag back to Date. Check it on demand at `/api/admin/param-drift`.
It does NOT replace the verification above; it is the net for when someone
forgets.

**The alert now carries the LINK, not the card id** (Dan, 2026-08-30, on a real
one: *"lol if ur going to msg me in slack at least give me a link to the mb
report"*). It printed the public uuid — `f4496307` — which **does not resolve in
the Metabase UI**; that addresses cards by their NUMERIC id. No map was needed:
`/api/public/card/:uuid` returns `id`, and the drift check already reads that
exact payload, so `def.id` is simply kept. One link per CARD rather than per
drifted tag (start_date and end_date on one card is one visit to one page), and
a card whose id could not be read falls back to the old wording rather than
emitting `/question/null`. Same links on `/api/admin/param-drift` as `fixLinks`.
**Generalise it: an alert whose fix only a human can perform must contain the
link to perform it.** Guard: `card-drift.spec.js` 22 → 29 assertions, lifting and
RUNNING `metabaseCardUrl`, mutation-tested six ways.

**Worth knowing about the flip itself:** Dan flipping the tags does not always
collapse the parameter list back to three. Checked 2026-08-30 after a flip, card
17301 registered **six** — `org_id/start_date/end_date` as `date/single` AND the
same three slugs as `string/=`. The report served fine, but the watchdog reads
those Text entries and keeps alerting, so the card needs opening and re-saving
until the list is three again.

## Card sign-off — a report MUST return live results before you call it done (IMPORTANT)

Learned the hard way (2026-08-06 → 2026-08-09): the shared Fast Track card was
edited and started **timing out** for large orgs (`canceling statement due to
statement timeout`). The app silently fell back to stale cache, so the report
kept *looking* fine while every live refresh failed — and the daily health
check was fooled the same way (it saw a warm cache hit and never re-probed
Metabase). **Nobody noticed for 3 days.** A warm/stale cache masks a card that
no longer returns fresh data, so "it still renders" is NOT proof it works.

**Rule: after ANY card edit (SQL, template tags, or a Metabase upgrade), confirm
the card actually returns fresh, non-empty rows via a cache-independent live
request — for the HEAVIEST org (biggest = worst case for timeouts), not a small
one.** Never sign off on a warm-cache render alone.

Tooling for this:

```
node scripts/verify-report-live.js --manifest scripts/report-cards.manifest.json
```

It hits the Metabase **public** card endpoint directly (same URL + parameter
shape server.js uses, incl. the required parameter `id`), so no app cache can
hide a broken card. It **fails (exit 1)** on error, empty result, or timeout.
Add a `{card, org}` row to `scripts/report-cards.manifest.json` whenever a new
shared card or large org is onboarded, and run it as the last step of every card
change. Single-card form:
`node scripts/verify-report-live.js --card <uuid> --org <orgId> [--start --end --timeout --min-rows]`.

## Tyler/Munis "GL Account Detail" export (card 20197) — PARKED, button off

**Status 2026-08-21 (Dan): switched OFF for every org.** `MUNIS_EXPORT_ORGS` in
server.js is now empty, which hides the button and 404s the route. The manifest
row for the card came out too, so the daily check stops paying for a 1.23 GB
scan on a report nobody is pulling.

Not broken — parked. Every pull is a full seq scan of
`materialized.item_log_report` (27-48s; see the section below), the export is
not in real use yet, and the table view eng is building may remove the need for
this card altogether. Revisit when someone actually needs a Munis file, or when
that table view lands.

**Nothing was deleted**: `lib/munis.js`, the route, `sql/gl-account-detail.sql`
and card 20197 are all intact. To switch back on, add the slug to
`MUNIS_EXPORT_ORGS` and re-add the `{card, org}` row to
`scripts/report-cards.manifest.json`.

Everything below describes how it works when enabled.

The 🏛️ **Tyler** button on the GL report (Pawnee only) streams a Munis-format
`glgatddt` account detail — PDF for reading, `.csv` for loading. Server-rendered:
`lib/munis.js` (pure transform + layout) → `renderHtmlPdf()` → Puppeteer
`setContent`. No report page is visited, so the export cannot be affected by
page state.

- **Separate card from the GL rollup.** 17293 aggregates to one row per
  gl_code + desk; this needs one row per transaction. Both read
  `materialized.item_log_report`. Nothing here touches 17293, so no other org's
  GL reporting is affected.
- **Tag types don't matter for this one.** The route reads the card's own
  registered parameter types from its public definition and echoes them back, so
  Date or Text both match, and the SQL casts the dates either way. An API edit to
  THIS card needs no re-flip in the UI — unlike every other card in this repo.
  (Metabase auto-typed `start_date`/`end_date` as Date on creation, from their
  names — worth knowing if you ever expect a new tag to default to Text.)
- **Not cached.** An export is pulled rarely and must be exact; a 4-hour-old
  ledger handed to a finance office is worse than a slow one.
- **Three GL states, not two:** code + account name; code with no `gl_account`
  row (`(no account name on file)` — Pawnee has two, 3334 and 886554); and no
  code at all (`(none)` → UNMAPPED, sorts last, flagged for review). Collapsing
  the middle case into UNMAPPED would misreport coded revenue as uncoded.
- **Enable a new org** by adding its slug to `MUNIS_EXPORT_ORGS` in server.js.
  Entity/department on the header come from the existing `getTylerConfig(slug)`;
  add `fiscalYearStartMonth` there if the org isn't on a July FY.
- `MB_GL_DETAIL_UUID` (Railway env) holds the card's public UUID. Unset ⇒ the
  button is hidden and the route 503s.

## The `materialized` schema has no secondary indexes (PINNED, spec'd 2026-08-21)

**PINNED, not being worked (Dan, 2026-08-21).** The table view eng is building
may make this moot, and the one surface that felt the pain — the Tyler export —
is switched off, so nothing is pulling this data today. Do not start on it
without checking in; the write-up below is here so the diagnosis does not have
to be redone.

Still worth passing to whoever owns the Epsio pipeline whenever it next comes
up, because **card 17293 has the same problem** and is hidden only by its
4-hour cache.

**DECISION (Dan, 2026-08-21): if it is ever fixed, the fix is an index on the
materialized table. Do NOT rebuild the card on base tables** — that re-derives finance logic the item
log already encodes, and any divergence would be silent, in a document handed to
a finance office. The base-table numbers below stay only as evidence for how
much an index buys.

The Tyler export failed on a normal month-end pull. `materialized.item_log_report`
carries **exactly one index** — the primary key on `epsio_id`. Nothing on
`organization_id`, nothing on the date column. So every read is a parallel seq
scan of the whole multi-org table:

```
Parallel Seq Scan on item_log_report  (cost=0.00..153217.93 rows=3)
```

Pawnee for one month: **27-48s on a quiet network to return 171 rows**, longer
while a deploy prewarms ~28 orgs into the same Metabase. Shipped mitigations
(PR #121) only buy headroom: request budget 90s → 150s, and a 60s result cache
so PDF-then-.csv is one scan instead of two.

**A join does NOT fix this** — asked and answered, with EXPLAIN:

```
Nested Loop  (cost=1000.14..147177.30)
  ->  Index Only Scan on organization       (1 row)
  ->  Parallel Seq Scan on item_log_report  ← unchanged
```

`WHERE organization_id = X` is already the tightest restriction there is. With
no index, "restrict" means "read every row and discard the misses"; a join just
puts a nested loop on top of the same scan. Same reason a sargable date
predicate buys nothing here — there is no index for it to use.

### This is systemic, not one table

EVERY table in the `materialized` schema has exactly one index — its primary
key. Nothing is indexed on `organization_id`:

| table | rows | size | indexes |
|---|---|---|---|
| `booking_report` | 1,349,340 | 1560 MB | 1 (pkey) |
| `item_log_report` | 2,259,449 | 1230 MB | 1 (pkey) |
| `transaction_report` | 1,005,767 | 976 MB | 1 (pkey) |
| `membership_and_pass_purchases_report` | 120,963 | 132 MB | 1 (pkey) |

So every card reading them scans the whole thing for one org, and the app's
4-hour cache is the only reason that is survivable. Card 17293 (the GL rollup
every org loads) has the same problem and is simply hidden by its cache — the
exact failure mode the card sign-off rule above exists to catch.

### The ask (platform / whoever owns the Epsio pipeline)

```sql
CREATE INDEX CONCURRENTLY item_log_report_org_period_index
  ON materialized.item_log_report (organization_id, datetime_at_primary_timezone);
```

- These are **ordinary tables** (`relkind = 'r'`), not Postgres materialized
  views, so `CREATE INDEX` behaves normally — no REFRESH semantics to work
  around.
- Selectivity is the whole argument: Pawnee is **1,682 of 2,259,449 rows
  (0.07%)**. Today every pull reads 1.23 GB to return 171.
- **Caveat worth raising with them:** the pkey is named
  `population_temp_<uuid>_pkey`, which suggests the table is built under a temp
  name and renamed on repopulation. If so, a hand-added index would be dropped
  on the next full rebuild — so the index needs to belong to the Epsio
  definition, not be bolted on afterwards.
- Indexes must be created on the primary; the read replica Metabase uses cannot
  carry its own.
- The same argument applies to `booking_report` and `transaction_report`.

### Rejected: rebuild card 20197 on base tables

Kept for the measurement only — see the decision at the top. The base tables
are indexed, and one index is named for this exact job:

```
order_item_transaction_item_log_period_index
  ON order_item_transaction (organization_id, confirmed_at)
  INCLUDE (payment_id, refund_id, gl_code)
  WHERE deleted_at IS NULL AND confirmed_at IS NOT NULL AND credit_id IS NULL
```

Measured against it, same org + month: **464ms, identical 171 rows** — versus
27-48s. That is the size of the prize an index on the materialized table would
also capture, without re-deriving anything.

Field mapping (mat-view column → base source):

| view column | base source |
|---|---|
| `order_item_transaction_{id,amount,gl_code,confirmed_at}` | `order_item_transaction` |
| `transaction_type` | `payment_id IS NOT NULL` → payment, `refund_id` → refund |
| `transaction_method` | `payment.payment_method_type` / `refund.payment_method_type` |
| `transaction_event_batch_id` | payment/refund `.transaction_event_id` → `transaction_event` |
| `order_item_{name,type,fee_category}` | `order_item` |
| `desk_location_name` | `transaction_event.desk_location_id` → `desk_location` |
| `customer_*` | `users` — **path not yet confirmed** |
| `datetime_at_primary_timezone` | `confirmed_at AT TIME ZONE <org tz>` — **rule not confirmed** |

**Keep the date filter sargable.** Convert the local bounds to instants:

```sql
oit.confirmed_at >= ( {{start_date}}::timestamp        AT TIME ZONE tz)
AND oit.confirmed_at <  (({{end_date}}::date + 1)::timestamp AT TIME ZONE tz)
```

NOT `(oit.confirmed_at AT TIME ZONE tz)::date BETWEEN …` — wrapping the column
is exactly the mistake that makes the current card unable to use an index even
if one existed.

### Two things to settle before writing it

1. **Timezone.** The view stamps ONE timezone per org — Pawnee is
   `America/Los_Angeles` for all 1,682 rows even though it has a location in
   `America/Chicago`. Majority-location-timezone reproduces that for Pawnee,
   Smyrna and Watertown, but that is an inference about Epsio's rule, not a
   reading of it. Picking wrong slides transactions across midnight in a
   finance document. `organization.config` holds no timezone key.
2. **Customer name path.** `order_item` → order → customer user, unverified.

### Sign-off gate (this is a finance document)

FULL OUTER JOIN new against old on `order_item_transaction_id` over **at least
12 months** for the heaviest org, and require: zero rows present in only one
side, zero field-level diffs on date/amount/gl_code/type/method/batch/customer,
and debit/credit/net totals equal to the cent. Anything less is not sign-off —
see the card sign-off rule above.

Why this was rejected: the two unknowns above are both places where a wrong
guess is silent and wrong in a finance document, and the sign-off gate needed to
retire that risk is most of the cost of the work. An index gets the same speed
while the numbers keep coming from the definition finance already trusts.

## Railway deploys

Railway project **lucid-possibility** (`37e39bf4-114d-446f-b7e3-5a8cedc7fafd`),
service **rental-report** (`7ee6e149-bd03-41db-bd42-aa8a751b1000`).

- **Production** deploys automatically from `main`. Never deploy untested code to
  production — pushing to `main` is a live release to all orgs.
- **The production URL is `https://rental-report-production-a046.up.railway.app`.**
  **There is no `reports.rec.us`** (Dan, 2026-08-28) — it does not resolve, and
  the `BASE_URL=https://reports.rec.us` in the README is a placeholder, as its own
  comment says. Worth knowing because curling it does NOT fail cleanly from this
  sandbox: it returned a plausible-looking 200 page (a real `ORG_CONFIG`, for the
  wrong org) and then `HTTP 000`, which reads as a broken deploy rather than as a
  hostname that was never registered. Verify production against the Railway
  domain above, and `getent hosts` a host before believing a strange response
  from it.
- **PR previews** are created automatically when a PR is opened: an isolated
  environment named `rental-report-pr-<PR#>` with its own URL. This does NOT
  touch production.
- Preview URL pattern:
  `https://rental-report-rental-report-pr-<PR#>.up.railway.app`
  (e.g. PR #29 → https://rental-report-rental-report-pr-29.up.railway.app)
- After opening a PR, confirm the preview actually boots and hand Dan the URL.
  **The sandbox CAN curl `*.up.railway.app` — fetch the preview and check the
  served HTML.** This note used to claim the proxy blocked it (CONNECT 403); that
  was wrong, and believing it meant skipping live verification more than once.
  Railway `list-deployments` on the PR environment tells you WHICH commit is
  serving (a `SUCCESS` for an older commit looks identical to one for yours), so
  use both: deployments for the commit, curl for the behaviour.

## Admin "What's New" popup — REMOVED from admin (PR #134)

Feature updates are for org admins, not for the person who wrote them, so the
popup now appears only on the ORG dashboards (`public/org.html`). The
`adminWhatsNew` block is gone from the admin dashboard in server.js.

Still true of the org-side popup: it shows *published* project-updates, so it is
EMPTY until at least one update is published, and each PR preview is a fresh
environment with its own (empty) data store — a brand-new preview shows no popup
until you publish an update in it first.

## Outdoor Event Spaces tab — hourly, not nightly (2026-08-24)

A tab on the Facilities hub for **pavilions, shelters, picnic areas and bounce
houses** — `court.type` in `('outdoor-event-space','picnic-table','bounce-house')`,
all three real values behind a CHECK constraint, so no name-matching recovery is
needed the way courts need `refineSiteType()`. **Fields are deliberately out**
(Dan): a big enough segment, and a different question — leagues, not parties.

Volume platform-wide, last 365 days: outdoor-event-space **12,987** bookings /
1,195 sites, picnic-table **10,047** / 901, bounce-house **929** / 38. Biggest
users are Easton, Torrance (all three types), Chicorec, Sacramento County,
Windham, Watertown, Norman, Apex.

- **No new SQL.** `OutdoorEventsView` re-fetches card **17294**
  (`/:org/facility/api/data`), the same feed the Camping tab uses, because only
  that card carries the wall-clock `Begin`/`End`. The hub's own feed (19570) does
  not.
- **These are HOURLY or all-day rentals.** Median block is **9h**
  (outdoor-event-space), 8h (picnic-table), 15h (bounce-house); ~54% run 8h+;
  **99.2% are same-day**. So the unit of the tab is the booked HOUR and the
  day-part, and the word "night" appears nowhere on it.
- **`reservation_timestamp_range` is a `tsrange`** — timestamp WITHOUT time zone,
  i.e. already local wall clock. So `Begin`/`End` need no timezone handling and
  Metabase's Pacific report timezone has nothing to shift here. That is the
  OPPOSITE of card 17300, where the column is a `timestamptz` (see the Pacific
  section below) — worth checking the column type before assuming either way.
- **The day-part heat map counts hours COVERED, not hours started.** An 11am–4pm
  shelter rental fills five cells. Start-times-only still renders, still has a
  peak, and answers a different question (when paperwork begins, ~8am, instead of
  when the shelters are full, late morning).
- **A multi-day booking has no per-day hours and must not be given any.** Card
  17294 prints `Begin` on the first day and `End` on the last, so a multi-day row
  carries at most one of them. `oeRowHours()` returns null for those; they are
  counted as day-spans, excluded from every hour figure, shaded their own colour
  on the calendar, and called out on screen. The tempting "repair" — defaulting a
  missing End to end-of-day — invents a ten-hour booking out of a day boundary.
- **"Days used", not occupancy.** The feed only contains sites that were booked at
  least once, so a pavilion nobody reserved is invisible. Every denominator on the
  tab is *booked* sites, "Quietest spaces" says out loud that it means least-used
  of the ones in play, and no total inventory is ever claimed (the AI prompt says
  so too). `/:org/facilities/api/campsites` is campmap-seed-only and cannot supply
  outdoor-space inventory.
- Ranking is by hours, with **days used** as the tiebreak before revenue —
  otherwise a space whose bookings are all multi-day has no hours to rank on and
  sinks to the bottom as though nobody booked it.
- Own banner (`fbx-pavilion` scene) and its own minigame, **Bounce House**
  (`bounce`, 🎈, score = balloons popped) — in `GAME_FACTORIES`, `LB_GAMES` and
  the server's `LEADERBOARD_GAMES`. A one-sided entry means a player sees a Submit
  button that always fails; `facilities-beacons.spec.js` checks both sides.
- Own AI insights route `POST /:org/outdoor/api/insights` with its own prompt.
- Guards: `scripts/outdoor-hours.spec.js` (19 assertions, in CI) pins the hour
  math — mutation-tested against start-times-only, against dropping the multi-day
  guard, and against defaulting a missing End. Plus three
  `ci-check-render.js` cases: the tab renders, `[data-oe-peak="11a"]` (coverage,
  not start times) and `[data-oe-timed="4"]` (multi-day excluded). Both attribute
  cases were seen to fail on the real regression in a real browser.

## Send Test in the subscribe modal — one payload, two buttons (2026-08-24)

Dan: "add a 'Send Test' button to the email subscription option on reports that
offer emails… you'd click to send a test, check the test email, then subscribe."
Requires a real email address, and is scoped to the filters set at the moment it
is pressed.

**The trap this is built around.** `/:org/admin/test-send` already existed for
the Test button beside an EXISTING subscriber, so it read the report's filters
and date range out of the saved subscription. The modal has no subscription yet
— that is the point of the button — so wiring it straight to the old route would
have sent an **unfiltered, default-window** email and reported success. A test
that passes without testing the thing is worse than none: you check your inbox,
see a report, subscribe, and get a different one every morning.

- The route now takes an explicit `reportParams` (a plain string, or the keyed
  object `/admin/subscribe` takes) and `dateRange`, which **beat** the saved
  subscription; with neither, the saved one still wins, so the admin Test button
  is unchanged.
- Both are cleaned by `cleanReportParamString()`, the **same helper**
  `/admin/subscribe` uses — `test-send.spec.js` asserts only one copy of that
  loop exists, because two would drift by a stripped parameter nobody looks at.
- The route echoes the `scope` it used, so the caller can say what it sent
  rather than claiming a filtered test it did not run. That echo is also what
  makes the behaviour observable to the spec without a Resend key.
- **The pages build ONE payload for both buttons** (`subscribePayload()` in
  gl/facility, `digestPayload()` in fasttrack). On Fast Track that matters more
  than it looks: `digest=1` is what makes the email a digest instead of a PDF, so
  a test that dropped it would preview an entirely different email.
- Validation a real outbound email needs: a valid address (both buttons are
  disabled until then), a known report type, a real cadence, and **no date range
  the scheduler itself refuses** — a GL rollup covering today leaves before the
  day has any postings, and sending that as a "test" teaches the reader the
  report is broken.

Guarded by `scripts/test-send.spec.js` (12 assertions, in CI), mutation-tested
four ways: ignoring the override (the original bug), dropping email validation,
allowing a blocked range, and the page rebuilding its filters instead of reusing
the payload. All four fail by name.

## The new verticals reach the Director's Report and the org cards (2026-08-24)

A tab nobody can find is a tab nobody uses, and a quarterly report that stops at
"facility rentals" says nothing about the two segments with their own tabs.

- **`dirOutdoor()` / `dirFields()` slice `facC`** — the facility feed
  `buildDirectorsQuarter()` ALREADY fetches — so both sections cost **zero extra
  Metabase time**. `scripts/directors-facilities.spec.js` asserts no new
  `fetchMBDirect` appears for them.
- **The hour rules are reimplemented server-side, and pinned to the client's.**
  The spec lifts BOTH the server helpers and `facilities.html`'s own
  `oeRowHours`/`oeIsArrival`/`OUTDOOR_TYPES` and requires they agree row by row.
  Two surfaces reporting the same quarter's hours differently is worse than one
  surface not reporting them — a director reads the PDF, a manager reads the tab.
- **The peak hour counts hours COVERED, not started**, same as the tabs. The
  fixture discriminates: starts peak at 10am, coverage at 11am. The panel says
  which rule it used on screen, because "busiest at 7pm" means two different
  things otherwise.
- **Card 17294 repeats a multi-day booking's `Total` on EVERY day of the run** —
  that is why the arrival guard exists, and the spec's tournament rows carry the
  same Total three times so removing the guard triples revenue and fails.
- Mutation-tested five ways: defaulting a missing End to end-of-day, peak from
  start times, counting every row as a booking, lights not read from add-on
  names, and an outdoor type dropped. All five fail by name.

### PINNED: the Pulse "Hours Booked" card (Dan, 2026-08-24)

Mocked up and **deliberately not built** — "we've got a lot of reports and would
prefer to focus on those." Written down so the reasoning does not have to be
redone when it next comes up:

- `refreshOrgPulse()` already fetches **six months of the facility feed** to draw
  the Bookings sparkline, and the hourly verticals are a slice of those same rows
  — so the whole addition is one more `pulse.items.push`, in the same loop, with
  the same sparkline / delta / pace shape. No new query and no new page.
- **Hours, not bookings**, is the unit: Bookings is already a card and counts a
  two-hour picnic table the same as an all-day tournament.
- It would self-hide like Product Sales does — no pavilions and no fields, no
  card.
- If it is ever built, the hour rules must come from the same place as
  `dirOutdoor`/`dirFields` and be pinned by `directors-facilities.spec.js`, or a
  third surface starts reporting a different number for the same month.

Mockup: https://claude.ai/code/artifact/b8db8343-588e-4db8-a65a-ba543ae71eaa

**Org dashboard cards now carry tab chips** (`CARD_TABS` in `public/org.html`):
Facilities → camping / outdoor / fields / racket / golf / aquatics / ice, and
Memberships → **auto-renew / sales & mix** / check-ins / retention. Nested `<a>` is invalid, so a card with
chips renders as `.card-wrap` holding the anchor plus a sibling chip row —
pinning still works through the wrapper (verified in a browser, not assumed).
Every tab renders for every org with its own empty state, so a chip is never a
dead end. Descriptions in **three** places had gone stale and now name the same
things: `REPORT_META` (org.html), `reportMeta` (the admin dashboard, inside the
template literal — no apostrophes), and the Director's Report's own blurb.

### …and the Memberships card lists EVERY tab but the one it lands on (2026-08-30)

Dan: *"make sure you're adding the membership sub-tabs to the main cards on the
org page, similar to the other cards with tabs"*. Auto-Renew and Sales & Mix
shipped as tabs and sat there for days with **no way to reach them from the
dashboard** — the card carried only check-ins and retention.

So the guard is not "the two new chips exist", it is
**`chips == MB_URL_TABS − the landing tab`**, asserted set-wise. Every earlier
chip list was hand-curated against a reason to omit (Summary is where the card
already lands; `detail` has nothing to drill into; `guests`/`products` are gated
on data the feed has not returned). Memberships has no such tab — all four
render for every org with their own empty state — so the coverage rule is
available here, and it is the assertion that fails the next time a tab is added
and the card is forgotten. That is the failure this change was fixing.

**The chip glyphs are READ OUT OF `memberships.html`'s own tab strip**, not
transcribed into the spec the way the Fast Track ones are — a page that
re-themes a tab now fails the spec instead of quietly disagreeing with the
dashboard. The parity check is itself guarded: it asserts the scrape found
**every** tab in `MB_URL_TABS`, or a regex that silently matched nothing would
make the whole comparison vacuous.

**`Sales & Mix` is the first chip label carrying an `&`**, and `tabChipsHTML`
builds its markup as a string for `innerHTML`. Escaping happens **at the render
site, not in the config**: an `&amp;` stored in `CARD_TABS` would leak into
anything that ever reads a label as a string, and it renders as the literal
`Sales &amp; Mix` on screen — which is the same class of bug as the
`\uD83D\uDD01` that reached the Auto-Renew tab. `org landing · salesmix chip
reads as text` pins the rendered text, and the global unrendered-escape guard in
`ci-check-render.js` covers the entity form.

Guards: `report-tabs.spec.js` 98 → **124 assertions**, mutation-tested four ways
— a chip icon drifting from the page, a tab with no chip (the bug as it stood),
a chip naming a tab `mbEffectiveTab` rewrites, and the PAGE re-theming a tab
glyph. All four fail by name. Plus three `ci-check-render` cases, two of which
were seen to fail on the real regression in a browser.

## Memberships Check-Ins tab — one filter, two member ids (2026-08-24)

Five changes Dan asked for on the check-in report, all client-side except the
member link, which needs one column added to card **18151**.

- **The desk-location filter lives in the toolbar and scopes the WHOLE tab.**
  Options are built from the feed's own `Desk Location` values (busiest first),
  so a desk that falls out of use disappears on its own. The invariant that
  matters: **every panel reads `ciView`, never `ciRows`** — the facility Summary
  shipped chips that scoped some panels and not others and the numbers disagreed
  across the page for a week. `scripts/checkins-view.spec.js` fails if a single
  `ciRows` appears inside the derivation block. Not persisted (a search intent,
  not a layout preference) but it IS in the URL as `?ci_loc=`, so a link lands on
  the desk the sender was looking at — and `?tab=checkins|retention` does the
  same for the tab.
- **`Member ID` is NOT a user id.** Card 18151 emits `u.rec_id` as `Member ID` —
  a 6-character code (`5OLLPM`) staff read out at the desk. The Rec admin URL
  (`https://www.rec.us/admin/o/<orgId>/users/<id>`) takes `users.id`, the uuid, so
  the card now also emits `u.id::text AS "User ID"`. A link built from the rec_id
  looks identical and 404s, which is why the render check asserts the href ends
  in the uuid rather than merely that an anchor exists. `ciUserUrl()` returns null
  without both ids and the cell falls back to plain text — so the page is correct
  before AND after the card ships the column.

### Card 18151 v2 — applied and signed off (2026-08-24)

One column added (`u.id::text AS "User ID"`), pushed via the API, date tags
re-flipped by Dan, verified in this order:

- read the live card and diffed BEFORE writing (no drift), then diffed the pushed
  SQL back — landed intact, comment included
- **the additive claim was measured, not assumed.** Same immutable window
  (apex, Aug 1–23) before and after: **22,880 rows both times**, and a sha256
  over the 13 ORIGINAL columns is byte-identical. 6,100 distinct uuids against
  6,100 distinct rec_ids, so the new column neither collapses nor fans out rows.
- cache-independent public-endpoint sign-off: apex (heaviest) **23,525 rows in
  22.3s**; the whole manifest 17/17
- 215 links rendered in a real browser, every href ending in a uuid
- `scripts/report-cards.manifest.json` gained a **checkins / apex** row, so a
  lost column or a re-Texted date tag is caught by the check rather than
  discovered as a blank tab

**Worth knowing for the next card push:** while the tags were Text the card's
public definition carried **six** parameters — the three original ids
(`date/single`) *and* three new ones (`string/=`) for the same slugs. Anything
that binds every registered parameter by slug then sends two values per variable
and gets `An error occurred.`, which reads exactly like a broken card;
`verify-report-live.js` fails that way too. Dan's UI flip cleaned the list back
to three. So during the push→flip window the app AND the verifier both fail, and
the verifier's failure carries no extra information.
- **Check-Ins by Time of Day** is one series at a time (All / Weekdays /
  Weekends). Deliberately not two curves on one axis: there are five weekdays to
  two weekend days, so a weekend total always looks quiet next to a weekday one —
  different denominators, not different demand. The caption carries the per-day
  figure for the slice being shown. This replaced the Hourly Distribution bar
  list, which asked the same question with less.
- **Weekday letters on Daily Check-Ins**, plus shaded weekend columns. Built from
  `ciDow()`, which reads the date string's parts: `new Date("2026-08-24")` is UTC
  midnight, so Monday the 24th renders as Sunday the 23rd in every US timezone —
  the same bug as the Fast Track dates. **`checkins-view.spec.js` re-execs itself
  under `TZ=America/New_York`** for exactly this reason: in UTC (this sandbox and
  GitHub Actions) the broken parse passes every assertion.
- **Top Members monthly bars are buttons.** Clicking one highlights that month
  across every member and names it in a caption ("August 2026 highlighted · 312
  check-ins from 11 of these 15 members"); the column header carries a clickable
  month initial per bar, so which month a bar refers to is readable without
  hovering. The old header printed "Aug / Sep / Oct" as free text beside bars it
  was not aligned with.

### The Memberships beacons had NEVER fired — third instance of the same trap

Found while wiring the ping for the location filter. `public/memberships.html`
(Excel, Print) and `public/instructor-payout.html` (Excel, PDF) POSTed a JSON
**body** — `{action:'excel'}` — to `/:org/:report/api/log`, which reads
`req.query.event`. So every call came back `400 Unknown event` and nothing
reached `events.jsonl` or Slack, since the day each shipped. Nothing caught it:
server.js parses, the server boots, the page renders, the export works, and a
fire-and-forget beacon never complains. This is the campmap bug and the
Facilities-hub bug a third time — **the convention is `?event=<name>` in the
query string**, and `instructor-payout`'s `pdf` beacon was also redundant (the
PDF route logs `pdf` server-side).

**Consequence to expect: Slack starts getting Memberships/Instructor-Payout
`excel` and `print` pings it has never had** — they were being dropped, not
muted.

New events, both on the generic log route's ALLOWED list:

| event | fired by | extra |
|---|---|---|
| `checkin-loc` (🏢) | picking a desk in the Location filter | `location`, `checkins` |
| `checkin-member` (👤) | clicking a member through to their Rec account | — |

`checkin-loc` debounces **by desk** (comparing the north branch then the south is
two looks, not one); `checkin-member` deliberately does NOT key by member, so a
staff member working down a list of regulars is one ping rather than twenty.
Guarded by `scripts/checkin-beacons.spec.js` (12 assertions, in CI), which boots
the server and requires a 200 **plus** a row in events.jsonl — and asserts the
old body-only shape is still rejected, since that is what was shipping.

## Fields tab — leagues, lights, and staff-booked (2026-08-24)

The last facility type with nothing of its own: **1,903 field sites across 74
orgs, ~57k reservations a year**, second only to courts. `field` is a real
`court.type`, and the tab is scoped to exactly that.

- **It CANNOT reuse the Court Utilization pipeline.** Card 17297 filters
  `c.type = 'court'`, so fields are absent from that feed entirely — Racket
  Sports can wrap `CourtUtilizationView`, Fields cannot. It reads card **17294**
  like the Outdoor tab and shares the hour helpers (`oeRowHours`, `oeHeatGrid`).
- **Shape:** median block **4h**, avg 5.9h; 24% ≤2h, 32% 2–4h, 21% 4–8h, **22%
  over 8h** (tournament days); **99.5% same-day**.
- **95.5% staff-booked** — only 2,578 of 56,880 are `instant`. A low instant
  share is the BASELINE for fields, and the panel says so, because reading it as
  a self-service failure would be wrong.
- **Lights are the story, and they are an ADD-ON, not the lighting integration.**
  `reservation_lighting_schedule` has **5** field rows platform-wide, while the
  four most-attached field add-ons are all light fees ("Field Light Fee" 409,
  "Field Lights" 226, "LAGSC Lights - Both Fields" 205,
  "Rental-Athletic Field Light Fee" 109, in 90 days). So the tab reads lights
  from add-on NAMES and ignores the Lighting columns, and cross-checks the light
  count against bookings starting after 5pm — evening bookings with no light fee
  are either daylight or uncollected cost recovery. Staffing/prep add-ons
  (attendant, park services, restroom supply, cleaning, prep & lining) are the
  other family.
- **Sport is inferred from NAMES.** `court.sub_type` is NULL on all 1,903 fields,
  so there is no structured sport. Field name + PARK name together classify ~48%
  of bookings (baseball/softball 13,647, soccer 9,215, multipurpose 8,938,
  football 427, lacrosse 88); **~52% match nothing**. The panel shows the
  unclassified share and steps aside above 40% rather than implying a mix it
  cannot see.
- Own banner (`fbx-ballfield`) and minigame **Sandlot** (`bases`, ⚾, score =
  total bases) — a full at-bat: timed swing, contact quality sets launch angle
  and power, the nearest fielder breaks for the landing spot, the runner takes
  what the retrieve time allows.
- Guards: `scripts/fields-classify.spec.js` (11 assertions, in CI) plus three
  `ci-check-render.js` cases — the tab renders, `[data-fld-peak="7p"]` (hour
  COVERAGE, not start times) and the sport note. The spec caught a real bug on
  its first run: `/ball ?field/` matches inside "Foot**ball Field**", so every
  football field was being filed as baseball; it needs `\bball ?field`.

### Tuning a banner minigame is a measurement job, not a vibe

Sandlot took five rounds of tuning, and every round was diagnosed by
instrumenting `connect()` and printing the actual numbers rather than guessing:

1. **Contact window vs the pitch path.** A window of `H * 0.32` was ~55px of a
   ~63px path, so a swing was either "too far" (strike) or near-perfect (home
   run) with nothing in between. It is now half the PATH.
2. **Hang time was backwards.** `0.42 + power * 0.85` made the hardest hits hang
   longest and therefore easiest to catch. A mishit is a lazy fly; a well-struck
   ball is a line drive. Now `0.50 + (1 - q) * 0.55`.
3. **Catches were measured in SCREEN PIXELS.** The park is projected wide and
   shallow (x stretched ~2.7x), so pixel distance made every fielder look one
   stride from everything. Distances are now polar, in field units.
4. **Five fielders in a 90° wedge leave no gaps** — nearest-fielder distances of
   0.04–0.21 field units, so everything that stayed in the park was caught. Four
   fielders at 0.16 units/sec gives real gaps.
5. **Verify by sweeping the input, not by playing once.** `gametest2.js`-style
   harness: seed `Math.random`, sweep the swing time in 20ms steps, and require
   a spread of outcomes. Final distribution over 50 timings: 29 no-pay, 3
   singles, 13 doubles, 1 triple, 4 home runs. "It felt fine when I clicked it"
   would have shipped the version where every hit was a home run.

## Every Facilities-hub beacon was 404ing — same trap as campmap (2026-08-24)

Found while wiring the Outdoor Events ping. The hub lives at `/:org/facilities`,
but **`facilities` is NOT in `REPORT_TYPES`** (the report type is `facility`, the
rental schedule). So every beacon `public/facilities.html` sends was matching the
generic `/:org/:report/api/log` and coming back
`404 Unknown report: "facilities"` — the **hidden banner game** ping and the
**lite Summary export** ping included, since the day each shipped. Nothing caught
it: server.js parses, the server boots, the page renders, the client code is
correct, and a fire-and-forget beacon never complains.

This is the campmap bug verbatim (see the campmap activity section). Fixed the
same way: a dedicated `POST /:org/facilities/api/log` registered **above** the
generic routes, allowlisting `game`, `summary`, `outdoor`. Events are logged
against `facility` — the hub reads that card, and it keeps `getReportActivity()`
looking at a report type that exists.

**Consequence to expect: Slack gets pings it never got before** — game plays and
Summary exports on the Facilities hub start arriving, because they were being
dropped, not muted. Guarded by `scripts/facilities-beacons.spec.js` (11
assertions, in CI), which checks source registration order AND boots the server to
require a 200 *plus* a row in events.jsonl. Mutation-tested: moving the route back
below the generic ones fails both halves independently.

## Campmap pin positions — a failed LOAD must never become a published layout (IMPORTANT, 2026-08-25)

Dan: *"make sure we're saving the place of these map pins, a few times I'd seen
the map pins reset and then I had to save them on the admin side. Strange."*

Not strange, and not the storage layer — the Railway volume is mounted at `/data`
and `DATA_DIR` is set, and `campmap_positions.json` had all 41 Topaz pins in it
the whole time. **The bug was that a failed load looked exactly like an empty
store, and re-saving is what made it permanent.**

`loadPositions()` mapped a failed response to `{positions:{}}`:

```js
.then(function(r){ return r.ok ? r.json() : {positions:{}}; })
```

which is byte-identical to "this org has never placed a pin". So one transient
failure — a deploy restart, a 502, a dropped connection — rendered every pin on
its seed coordinate with **nothing on screen to say so**.

**The destructive part is the recovery, which is why this was data loss and not a
display glitch.** `saveLayout()` publishes EVERY site in `SEED`, so an admin who
saw the "reset", dragged one pin and hit Save wrote 41 pins of which **40 were
seed defaults**, over the real layout. Reproduced in a browser against a stored
41-pin layout, forcing the GET to 500 once:

| | pins render at | `placed` | a Save then writes |
|---|---|---|---|
| GET succeeds | the stored layout | `true` | 41 pins, **0** at defaults |
| GET 500s once | **seed defaults** | `false` | 41 pins, **40 at seed defaults** |

`loadMarkers()` had the identical shape, so the same blip wiped every
admin-placed marker (Boat Ramp and friends) on the next save.

The fix is `POS_OK` / `MK_OK`, true only when the store actually **answered**:

- **An empty answer from a store that answered is legitimate** — a new org has to
  be able to place its first pins, so the gate keys on "did it answer", never on
  how many pins came back. Gating on the count locks a new org out.
- **Publishing is refused in two places** — the Save button, and inside
  `saveLayout()` itself, because the button is one way in and not the only one.
- **One retry** (1.5s), because the usual cause is a restart mid-request that the
  next request survives; two failures is an outage, not a blip.
- **The viewer still gets a map** on seed coordinates. That is the right
  degradation for a public camper-facing page — what must never happen is writing
  those coordinates back.
- The edit bar says *"Saved layout could not be loaded… these pins are defaults"*,
  because an admin who is not told will re-place 41 pins by hand.

Guarded by `node scripts/campmap-pin-persistence.spec.js` (**10 assertions, in
CI**, after the render check since it drives a real browser and reuses that
check's CDN cache). It has a source half and a behavioural half, and
`SKIP_SOURCE=1` disables the source half **so the browser half can be shown to
catch the bug on its own** — a regex over our own patch is not evidence the page
behaves. Mutation-tested five ways; the bug exactly as it shipped fails with
*"a save was published after a failed load — it would have written 41 pins, 40 of
them seed defaults, over the real layout"*.

**Related trap, still true:** both position writers (`/:org/campmap/api/positions`
and `/:org/facilities/api/campsite-positions`) **replace the location's whole
map**, and they share one store via `campmapStoreKey`. That is safe only while
both clients send every site — the Camping tab sends `loc.sites`, campmap sends
all of `SEED`, and for Douglas the seed and live id sets are identical (41 = 41,
no extras). If a client ever sends a subset, it silently drops the rest.

## Public map activity, handed back to the org (2026-08-25)

Dan: *"we need some metrics here, similar to what we're piping to slack. Number
of total views, clicks, book to rec clicks, etc. Something actionable back to the
org admins, can keep it to one row."*

The campmap is a PUBLIC page whose traffic only ever surfaced in **our** Slack
feed. `GET /:org/facilities/api/campmap-activity?days=30` aggregates the same
events back to the org that owns the campground, and `CampMapStats` in
`public/facilities.html` renders one `.sum-cards` row on the Camping tab:
**Map views · Sites opened · Book clicks · Searches narrowed · Link shares**.

- **Per ORG, not per location.** Events carry no location, so the row mounts once
  at section level. Inside `locs.map(...)` it would render N identical rows and
  imply each location earned those numbers.
- **The book-click RATE is the actionable half** (`books / views`), because it
  says whether the map turns lookers into bookers. Which of the two routes they
  took is on the endpoint (`bookKinds`) but not on the tile — it is interesting
  to us, not to a parks department.
- **No rate on a thin denominator.** `RATE_MIN_VIEWS = 20`: 6 views and 0 clicks
  is not "0% conversion", it is not enough traffic to say. Same reasoning as this
  tab's trend arrows refusing to draw under 14 elapsed days.
- **An empty log is not "nobody uses your map."** A fresh volume, a rotated log
  or a PR preview would render 0 views over 30 days, which an admin reads as a
  verdict on their campground. The route returns `covers` / `logStartsAt` and the
  header says *"since Aug 19"* instead of *"last 30 days"* when it cannot see
  that far back.
- **Both filter events are one signal** — `campmap-filter` (type) and
  `campmap-amenity` count together as "searches narrowed"; splitting makes two
  thin numbers out of one.
- **`!d.totals`, not just `!d`.** The strip renders from a network response, and
  a rewritten route or a stub can answer 200 with the wrong shape; reading
  `d.totals.views` off that throws inside render and unmounts the whole Camping
  tab. That is the blank-page class this repo has been bitten by twice, and the
  render check reproduces it when the guard is removed.
- **No new gate needed.** The global org-token middleware (search *"do not leak
  existence of the org"*) already 404s every `/:org/*` path without a token,
  exempting only calendar, rentalcalendar and campmap. So a tokenless caller sees
  a generic **404, not a 403** — the in-handler check is a backstop for the day
  that exemption list grows.

Guards: `scripts/campmap-activity.spec.js` (10 assertions, in CI) whose fixture
plants every way to be confidently wrong — another org's 99 map views, this org's
50 `facility` views, 77 views outside both windows — so a dropped filter shows as
a specific wrong number (90 / 139 / 65) rather than a vague failure. Its
`topSite` fixture has an unambiguous winner on purpose: a tie made the assertion
order-dependent. Mutation-tested six ways, all caught. Plus the
`facilities · campmap activity` render case, keyed to a view count from the stub
so a strip that renders the wrong field fails too.

## Campmap amenity filter + the book buttons swapped (2026-08-25)

**Amenity checkboxes live in the date toolbar**, on the same reasoning as the
campsite-type select: "which sites have a fire pit" is part of the same question
as "which nights", not a separate mode. `AMEN_FILTER` is a list of rec.us amenity
**tag ids**, and `inView()` ANDs them, so everything that counts, lists or paints
narrows together through `VIEW()`.

- **AND, not OR — because rec.us ANDs its own amenity filter** and the Book button
  hands off to that filtered list. An OR here would show sites the hand-off then
  drops, so the map and rec.us would disagree about the same search.
- **A ticked filter beats the site's own tags in the hand-off URL.** Same reason.
  With nothing ticked, a lone site still hands off its own tags ("more like this").
- **Every amenity is shown and tickable, with its count** (Dan's call). At Topaz
  the counts are the whole point: **six tags express three facts** — Tables and
  Fire Pit are on all 41; Power/Electrical Available, Water Hookup and Electricity
  Hookup cover *exactly the same 15 sites* (21–35, the RV loop); Tent Site is the
  other 26. So three checkboxes read `15/41` and are the same cut, and `41/41`
  explains a tick that moves nothing. Hiding universal ones would stop a camper
  confirming every site has a fire pit.
- **Tent Site and the hookup tags have ZERO overlap**, so under AND a camper
  empties the map in two ticks. `amenConflict()` names the offending pair — a
  blank map alone reads as "this campground is full", which is a different and
  wrong answer.
- **Collapsing the three hookup tags into one "Hookups" box was rejected**: it
  would read better at Topaz and be wrong everywhere else, since `AMENITY_TAGS`
  only covers tags this repo has seen. That belongs in Rec's tag vocabulary.
- In the URL as `?amen=` (stale/unknown ids are dropped so a link cannot empty the
  map) but **not persisted** — a search intent, not a layout preference.
- Activity: `campmap-amenity` (🧺), debounced by the whole amenity **set** rather
  than per tag, since ticking a second box refines one search. A zero result is
  called out in the message, because that is the interesting case.

**`amenityTags` is a new field on `/:org/rentalcalendar/api/sites`, and it is not
redundant.** `amenities` maps ids through `AMENITY_TAGS` and then
`.filter(Boolean)`, so an unseen tag makes it **shorter** than `amenityTagIds` —
anything zipping those two by index mislabels every amenity after the first
unknown one, silently, on a camper-facing page. `amenityTags` is `{id, name}`
pairs where an unknown tag keeps its place under a neutral label.

**The two book buttons swapped** (Dan: *"the tiny link at the bottom I suspect
users will WANT to click, not the big green one"*). Primary is now
**Book Site NN on rec.us** → the site's own page; secondary is
**Book alternate sites for the same dates** → the dated, filtered list.

- **The trade is real and deliberate:** `/sites/{id}` reads no search params
  (rec.us's path builder is `site:({siteId})` with no options and the page never
  calls `useSearchParams`), so the primary route **cannot carry the dates**. Its
  sub-line therefore names the dates to re-enter rather than leaving the camper to
  reconstruct them.
- **`campmap-book`'s `kind` still describes the ROUTE, not the button position**
  (`site-page` / `dated`). Keying on position would silently redefine every
  historical row in the feed.
- The site list's own group CTA is unchanged — there is no single site to go
  straight to from a set of results.

**"Powered by rec.us" badge, upper right, links to rec.us.** The wordmark is
deliberately **text, not an image**: rec.us serves no public logo asset (the
favicon is an "r" glyph on transparent, and the only inline SVG on the marketing
site is an arrow icon), so an `<img>` would either 404 on a camper-facing page or
be a logo redrawn and a brand yellow guessed. **If someone supplies the real
mark, the markup is already shaped for it** — give `.rec-by .mark` a background
image. Guarded by the two `campmap · amenity` render cases, which are deliberately
**semantic** (`[data-am-universal]` / `[data-am-split]`) rather than numeric,
because `ci-check-render` runs against whichever seed org is first and a
hard-coded count would break on a seed reorder rather than on a bug.

## Campsite map availability — 210 days, per site (SUPERSEDES the 30-day ceiling, 2026-08-24)

**The 30-day cap was the MCP TOOL's, not the platform's, and it is gone.** Dan
asked Kevin Liu (eng) why `get_site_availability` stopped at 30 days when a site
can be configured for 180; the answer is that the tool hardcodes it and takes no
range parameter, while rec.us's own booking page calls the REST endpoint underneath:

```
GET https://api.rec.us/v1/sites/{siteId}/nightly-availability?from=YYYY-MM-DD&to=YYYY-MM-DD
```

Same response shape as the MCP tool (`data.checkInDates[date] =
{available, earliestCheckout, latestCheckout} | {available:false, reason}`), so
nothing downstream of the parse had to change. The campmap now runs on it.

**Four things about this endpoint that cost real time to establish:**

1. **It is behind a WAF rule that 403s any request without `sec-fetch-mode`.**
   The block is from the load balancer (`server: awselb/2.0`, no app headers),
   *before* the app — so it looks exactly like the route not existing, and
   `/v1/sites/{id}` answering 200 makes the API look reachable all along.
   Bisecting the header set showed **`sec-fetch-mode: cors` is the only header
   that matters** — not User-Agent, not Origin, not Referer — so we send our own
   honest UA plus that one header rather than impersonating a browser. If that
   rule ever changes, this path 403s and every site silently falls back to the
   30-day MCP feed; nothing breaks, the map just gets short again. Check
   `[rentalcalendar] nightly availability` warnings in the logs.
2. **The span is capped at 210 dates, and 211 is a 400** — a truncation would be
   survivable, an error is not, so the ceiling has to be respected on the way out.
3. **`from` may not be in the past — and "past" is the SITE's local date, not
   UTC.** This one bit immediately. `new Date().toISOString()` is how every
   route in server.js computes today, and it is UTC; a Pacific campground is
   7-8 hours behind, so **from 17:00 local until midnight the UTC date is
   already tomorrow there**. Measured 2026-08-25 00:02 UTC (17:02 PDT): the MCP
   feed's first check-in date was `2026-08-24` while a UTC-dated request started
   `2026-08-25` — i.e. seven hours out of every day where "is anything free
   tonight" comes back `unknown` on all 41 sites, on a page that renders
   perfectly throughout. The fix asks from **yesterday-UTC** and lets rec.us
   decide: it answers 200 while that is still today somewhere west of UTC and
   400s once it is genuinely past. `nightlyStartsYesterday()` probes that once
   per batch and memoises for one cache interval — **deliberately not memoised
   per UTC date, because the answer flips mid-date** (07:00 UTC, when Pacific
   catches up). An extra leading day the browser has already passed is harmless:
   the client only reads dates inside the stay, and `bookingHorizon()` reads the
   far end.
4. **Not every campsite is nightly.** An hourly one answers 200 with
   `{siteUnavailable:{reason:"not-nightly"}, checkInDates:{}}` — **all 12 of
   Pleasant Hill's campsites are `bookingUnit: hourly`**. That is an empty
   answer, not an error, so it must fall through to the MCP feed rather than
   empty the map. The fallback is **per site**, not per request: an org can mix
   the two, and one hourly site must not drag the park back to 30 days.

### The horizon is PER SITE, and it is only readable from the answer

Dan: *"availability should scope to the actual site availability."* Measured at
Topaz Lake, 2026-08-24: **39 of 41 sites take arrivals 180 days out, one takes
90, and one has no window at all and takes the full 210.** Any park-wide number
is wrong for some site in one direction or the other.

**There is nowhere to read the number from.** `defaultReservationWindowDays` is
absent from the public site payload and `court.default_reservation_window_days`
is NULL on all 41 rows. What the API *does* do is answer
`available:false, reason:"outside-window"` for every date past the window — so
the window's end is the last date before the run of them that reaches the END of
the feed. That is `bookingHorizon()` in `public/campmap.html`.

**THE TRAILING RUN IS THE WHOLE SIGNAL.** `outside-window` is also how a
staff-entered hold awaiting payment comes back (established 2026-08-23 — it
genuinely blocks the site), and those land mid-feed. Reading the FIRST one as the
window's end cuts the map off at a hold and hides every open night after it. A
hold on the final night of the feed shaves a day off the horizon; over-trimming
by a night is the safe direction, inventing bookable nights is not.

Consequences wired through the page:

- **A fourth night state, `beyond`** — past the site's own window. Its own colour
  (`--beyond`, slate; not red, which means taken, and not grey, which reads as
  unknown) and its own copy: *"Not open for booking this far ahead yet."*
  Merging it into `booked` paints ~30 open nights red at Topaz and sends campers
  to another campground for dates the site will happily take next month.
- **Before the feed lands, the picker must not assert 30 days** (Dan, 2026-08-25:
  *"why does the arrival date only go out 30 days?"*). `maxArrival()` fell back to
  `DAYS_SHOWN` whenever no site had a horizon — correct once a feed has answered
  and it genuinely cannot tell us (hourly sites, the MCP path), wrong before one
  has arrived, which is every cold load. **A native date picker snapshots min/max
  when it OPENS**, so a camper who clicked Arrive during the cold-cache wait
  stayed capped at today+29 until they closed and reopened it. `AVAIL_LOADED`
  splits the two cases: not-yet falls back to the platform's own 210-day ceiling
  (never under-promising, and `setStay` clamps to the real horizon the moment the
  feed lands), feed-answered still falls back to 30.
- **THE WINDOW CAPS THE ARRIVAL, NOT THE WHOLE STAY.** Asked twice now, so worth
  pinning: 180 days does NOT mean the last arrival is day 166 (180 − the 14-night
  max stay). Measured 2026-08-25 against `/v1/sites?checkInDate&checkOutDate`,
  which is independent of the nightly feed: **arrive day 179 + 14 nights →
  checkout day 193 → all 41 Topaz sites bookable**; arrive day 180 → 0. rec.us
  gives that last arrival a `latestCheckout` a fortnight past its own window.
  Capping arrivals at 166 would refuse 13 days of arrivals it accepts — the same
  shape as the tail-decay bug rejected on 2026-08-23, at the other end.
- **The Arrive picker's bound is `maxArrival()`** — the furthest horizon among
  the sites **in view**, scoped to the type filter for the same reason
  `latestCheckoutFrom` is. Sites whose horizon is unknown (the 30-day feed,
  hourly sites) contribute nothing rather than dragging the park back; if NO site
  in view knows, it falls back to 30 days, i.e. exactly the old behaviour.
- **The checkout picker is bounded by the horizon too** (Dan, 2026-08-25: *"they
  should both be bounded by 180 days, otherwise that makes no sense"*).
  `maxCheckout()` is `maxArrival()` **plus the campground's maximum stay**, not
  the horizon itself: the booking window limits when a stay may START, never how
  long it runs, and rec.us gives the last bookable arrival a `latestCheckout`
  fourteen nights later. Bounding at the horizon itself makes that final arrival
  a one-night stay and decays the longest stay to nothing across the last
  fortnight — measured 2026-08-23 (14 → 8 → 5 → 2 → 1 → 0) and rejected then; it
  is the same regression however the bound is reached, and it is easy to
  reintroduce while "making both fields agree". **This reverses half of the
  asymmetry described below.** The old rule bounded Depart at rec.us's own `latestCheckout` so the
  picker could never offer a stay the engine would refuse; the cost was that
  Depart looked capped at a fortnight (Topaz allows 14 nights, and a booking in
  the way cuts it to 10), so a map that now reaches 180 days read as though it
  still stopped in two weeks — which is exactly how it was first reported.
  What the hard stop used to say by greying the calendar, **`stayCeiling()` now
  says in words**: a chip beside the night count reads *"Longer than the
  14-night maximum stay here"* or *"Longer than these dates allow — a booking
  blocks this arrival after 4 nights"*. The distinction matters: telling a camper
  "14-night maximum" when the real answer is "someone arrives on the 5th" sends
  them to change the wrong thing.
  **The rest of the asymmetry stands** — the checkout still runs one night past
  the last bookable arrival, and no site is ever reported open for nights it
  cannot take, because the per-night verdict is untouched.
- **The page lands with no dates chosen** (Dan, 2026-08-25: *"can we have the
  'depart' calendar just show 'choose arrival date' in red before showing
  availability"*). Depart has no basis without an arrival — its bound, its
  minimum and every night it colours all come from one — so until a stay is
  picked it is disabled and its label reads **"Choose arrival date" in red**.
  The map claims nothing in that state: `statusOn()` returns `unknown` for every
  night, so pins are neutral, the list says what to do, and the summary reads
  "Choose your dates to see what's open." Routed through `statusOn()` on purpose
  rather than each caller growing its own check — that is the failure that made
  the facility Summary and the Camping tab disagree.
  **What this costs:** the old landing state answered "what is free tonight" for
  free, which is the walk-up camper's question — that now takes picking a date.
  A **Tonight** shortcut button was tried and taken back out (Dan: *"tonight
  button = not good"*): it was a second, competing way to set the stay in a
  toolbar that already has two date fields, and the ask was for the page to wait
  for a date rather than to offer a faster way past that. **`PICKED` is the whole
  switch**; flip its initial value to `true` and the page loads on tonight
  exactly as it did before.
- **`sources` on the batch reply** says which feed answered per site. Only the
  nightly one runs past a site's window, so only there does a trailing
  `outside-window` run mean a horizon rather than the end of the request. The
  30-day feed must never produce `beyond`.

### Handing a camper to rec.us WITH their dates (2026-08-25)

Dan: *"once you choose a time range then click 'book on rec.us', it seems stupid
to have to choose the dates again."* Established by reading rec.us's own bundles
and confirmed against the live site:

| URL | takes dates? |
|---|---|
| `/sites/{id}` | **No.** rec.us's own path builder is `site:({siteId})` with no options — unlike its siblings (`organization().index`, `login`, `cartCheckout`), which all take a search-param bag — and the site page's chunk never calls `useSearchParams`. Dates cannot ride on this URL. |
| `/organizations/{slug}?tab=facilityRentals` | **Yes.** A validated schema: `sports`, `location`, `siteType`, `checkInDate`, `checkOutDate`, `amenity`. Verified live — the values land in the page's own `__PAGE__` props, and a bogus date is dropped rather than echoed. |

So the Book button now carries `siteType`, `location`, `checkInDate` and
`checkOutDate`, landing on the campground's rental list already filtered to those
nights — the camper picks their site once instead of re-entering two dates, and
the list only shows what is genuinely free. A secondary link still opens the
single site's own page for anyone who wants it, labelled so it is clear that
route makes them pick dates again. The `campmap-book` ping carries
`kind: dated | site-page`, so the feed shows which route campers actually take.

**CORRECTION (2026-08-25): capacity CAN be carried — `guests` works.** This
section first said it could not, on the strength of the route's zod schema, which
lists only `sports`/`location`/`siteType`/`checkInDate`/`checkOutDate`/`amenity`.
**That schema is the validated subset, not the full set the page honours.** The
tab's own `useQueryStates` reads a much longer list, and two more of them are
useful here:

| param | shape | note |
|---|---|---|
| `guests` | integer | **gated on `siteType === 'campsite'`** — which we always send |
| `subType` | array | same gate; only rec.us's four (`tent`, `rv`, `tent-and-rv`, `lodging`) |
| `amenity` | array | encoding UNCONFIRMED — see below |
| `instantBook` | boolean | |
| `availability`, `reservable`, `time`, `daysOfWeek` | | not useful here |

So the Book URL now also carries `guests` (the site's capacity) and `subType`.
**Read a page's `useQueryStates` before concluding a parameter does not exist** —
the route schema said no and the page said yes.

**`amenity` IS wired, and it takes rec.us's tag ids comma-separated** (Dan tested
the encodings 2026-08-25): a single id works, `?amenity=<uuid>,<uuid>` works, and
**repeating `amenity=` picks up only the first value** — so comma-separated is the
multi-value form (nuqs's default) and repeating the parameter is wrong.

No new data source was needed: `/:org/rentalcalendar/api/sites` was already
reading `amenities.amenityTagIds` and mapping it through `AMENITY_TAGS` to
display names — it just threw the ids away. The route now returns
`amenityTagIds` alongside `amenities`, deliberately unmapped, because
`AMENITY_TAGS` only covers tags this repo has seen and a name round-trip would
silently drop anything new.

**For a group, only the tags EVERY member has.** rec.us ANDs them, so sending one
site's `Tent Site` would drop the RV-only sites the same button names — the
sub_type trap, one field over.

(The id↔name map was already in server.js all along: `0cf5e4e3…` Tables,
`e67c5b0f…` Fire Pit, `25452762…` Tent Site. Cross-referencing site sets could
not separate Tables from Fire Pit — they are on all 41 — but `AMENITY_TAGS` names
both, and Dan's repeated-param test showed the FIRST value wins.)

**A SITE CANNOT BE PRESELECTED.** There is no `site`/`siteId` URL state on the
tab: a rental card's click handler is a plain
`router.push(paths.site({siteId}))`. Filters can narrow the list (Site 09's own
amenity set still leaves the 26 tent sites) but never isolate one. Worth raising
with Kevin/Ankur alongside the MCP range parameter.

**`subType` IS exposed by the REST site payload, contrary to the note below.**
`/v1/sites/{id}` returns `subType: "tent-and-rv"` for all 41 Topaz sites — it is
the MCP `list_sites` tool that omits it, not the platform. The campmap still
falls back to the seed's `kind` because its site feed goes through the MCP, but
"Rec's API does not expose sub_type" is too strong: the REST endpoint does.

**Neither `location` nor `siteType` is validated by rec.us.** Measured: a bogus
`location`, and `siteType` values of `campsite`, `tent-and-rv` and `electric`,
all pass straight into the page's props — only the DATES are checked (a bogus one
is dropped). So `location` is only sent when the LIVE site feed supplied one (the
baked seed's `"default"` placeholder must never be used as a location id), and
`siteType` is always the site TYPE `campsite` rather than a sub_type or one of
the map's own derived kinds.

### `GET /v1/sites` — one request that answers a whole stay (2026-08-25)

Found while investigating what the filtered rec.us page queries. The
facility-rentals tab does not call the per-site feed at all; it calls:

```
GET https://api.rec.us/v1/sites?organizationId=<uuid>&page=1&pageSize=250
    [&checkInDate=YYYY-MM-DD&checkOutDate=YYYY-MM-DD]
    [&amenityTagIds=<uuid>&amenityTagIds=<uuid> …]     (repeated, not comma-joined)
```

**With dates it returns only the sites bookable for the WHOLE range**, in one
request, in ~0.5-0.8s. Measured at Douglas:

| range | Topaz campsites returned |
|---|---|
| no dates | 41 |
| 26-30 Sep | 29 |
| 2-6 Sep | 0 (all taken that week) |
| Jan 2027 | 41 |
| Apr 2027 — past the 180-day window | 0 |

**It agrees exactly with the map's own per-night reduction.** Cross-checked our
`siteNightStates()` verdict against it over three windows: **29/29, 0/0, 41/41,
zero diffs either way**. That makes it a free correctness oracle for the stay
reducer — the same role the reservation-ledger backtest plays, but cheap enough
to run on demand.

**It cannot replace `nightly-availability`.** It answers one yes/no per site for
one range; the map needs per-night detail for the "3 of 4 nights" partial state,
the drawer's night strip, `latestCheckout`, and the trailing-`outside-window` run
the horizon is read from. It is a complement, not a substitute.

**What it WOULD replace is the site feed.** `/:org/rentalcalendar/api/sites` goes
through the MCP `list_sites` tool, and this endpoint is strictly better for the
campmap's purposes — one request, and it carries the fields the MCP path drops:

- **`subType`** — `tent-and-rv` on all 41 Topaz sites. This retires the whole
  "the filter reads the SEED because Rec's API does not expose sub_type" problem
  documented below: the MCP tool omits it, this endpoint does not.
- **`amenityTagIds`** — the UUIDs rec.us's own amenity filter takes. Our current
  feed carries display NAMES only, which is why the `amenity` parameter is not
  wired into the Book URL yet: we cannot send ids we do not have.
- `capacity`, `lat`/`lng`, `customMapX`/`customMapY`, `isInstantBookable`,
  `bookingUnit`, `descriptionMd`, `rulesMd`, images.

**Next step, not yet done:** point the campmap's site feed at this endpoint. It
fixes sub_type, unlocks the amenity filter on the Book URL, and drops a paged MCP
call for a single fast one. Needs the org's `organizationId` (already in `ORGS`)
and the same `sec-fetch-mode: cors` header as the nightly feed.

### The hand-off card is gone (Dan, 2026-08-24)

"Looking for campsite dates more than 30 days out?" existed because the map could
only confirm the ~30 nights the MCP tool enumerated while rec.us took bookings
months further out. The map now covers those dates itself, so the card was
sending campers off a page that can answer them. Removed along with the
`bookAhead` seed key, its server passthrough, and the `campmap-book`
`kind: "later-dates"` event — **expect that Slack event to stop arriving**; the
per-site `campmap-book` ping from the drawer's Book button is untouched.

### Cost, and where it is paid

- Server-side, per site, cached **15 minutes** (`RC_AVAIL_TTL`, shared with the
  MCP path) keyed by `siteId|days`, concurrency-limited to 10 at a time.
- 41 sites × 210 days is **~750KB of JSON — 18.6KB on the wire**, because
  `compression()` is already on and the payload is extremely repetitive. Warm
  cache serves it in ~15ms.
- The page does **not** block on it: it renders on the baked seed and upgrades
  when the feed lands, which is what it always did.

### Guards

`node scripts/campmap-nightly-window.spec.js` — **8 assertions, in CI**, pinning
the date range the server asks for. **It re-execs itself under
`TZ=America/Los_Angeles`** and pins fixed instants rather than reading the clock,
for the same reason `fasttrack-dates.spec.js` does: this sandbox and GitHub
Actions both run UTC, where the broken version looks right 17 hours a day.
Mutation-tested against four regressions, including the bug exactly as it was
first written (always start from UTC today), a local-timezone date derivation,
an off-by-one span (211 dates is a 400), and ignoring the probe result.

`node scripts/campmap-stay.spec.js` — now **33 assertions**, 18 of them new and
covering the horizon, the `beyond` state, and both pickers' bounds.
Mutation-tested against ten regressions: reading the first `outside-window`
instead of the trailing run; treating the 30-day feed as if it knew a horizon;
collapsing `beyond` back into `booked`; taking the shortest horizon in view; a
park-wide floor with unknown counted as 30 days; ignoring the type filter;
reverting Depart to rec.us's `latestCheckout` cap; bounding Depart at the horizon
itself (the tail decay above); losing the checkout's stay allowance; and blaming
the stay rule for a truncation a booking caused. All ten fail the spec by name.

Plus the `campmap · 210-day horizon` case in `ci-check-render.js`, which asserts
`#arrivePick[data-days-ahead="119"]` over a fixture whose site 0 has a 120-day
window and which also plants a mid-feed hold. "An Arrive field rendered" passes
just as happily on the 30-day fallback, which is the assertion that would not
have caught this.

### What the 30-day investigation established that is STILL true

Two config red herrings, both worth knowing:

- **The "180" in the admin panel is a STAY DURATION, not a booking window.**
  40 of the 41 Topaz campsites allow 14 nights; Site 04 alone said 180, which Dan
  then corrected. "Default nights per stay" sits directly above "Default days in
  advance" in that panel, and both read 180 — a data-entry slip.
- `court.default_reservation_window_days` is **NULL on all 41** sites, and the
  largest value anywhere on the platform is **21**. No 180-day window is stored at
  site or org level — which is why the horizon has to be read off the answer.

`latestCheckout` reaches past the arrival window, so **the cap is on arrival
dates only** — never bound the checkout picker to the strip's length. And never
take the longest *stay* any single site offers: one mis-set site would offer a
180-night stay for the whole park. Cap by the org's configured max stay first.
(That is about stay LENGTH; the arrival horizon above is deliberately the
opposite — furthest wins — because it comes from each site's own answer rather
than from one editable field.)

## The old 30-day investigation, kept for the reasoning (2026-08-23)

Superseded by the section above — the map is no longer capped at 30 days. Kept
because the reasoning under it still holds and was expensive: the MCP tool really
does hardcode 30 days (probed three ways, incl. the staff-scoped tool: an
identical 31 keys every time, and a site carrying `nights.maximum = 180` did not
move it), the config red herrings above are still red herrings, and the
asymmetric arrival/checkout cap below is still the right shape — it just runs to
each site's real horizon now instead of to day 30.

### Beyond 30 days: the rentalcalendar pattern exists, and it drops nightly bookings

`public/rentalcalendar.html` (Watertown, Norman, Niagara Falls) shows dates past
30 days — `MAX_DAYS_AHEAD = 30`, no `max` on the date pickers, and a
`beyondRealtime` disclaimer saying availability out there is "based on confirmed
facility bookings and may not reflect all holds". Verified live: 257 booking rows
across 28 November dates.

**But the overlay that feeds it drops every nightly booking.** In
`/:org/rentalcalendar/api/reservations`:

```js
.filter(r => r.date && r.start && r.end && r.site);
```

Nightly rows have no `End` — they are nights, not time slots (`Begin "01:00pm",
End null`). Measured on October at Douglas: **campsite 0 of 46 survive, room 180
of 180 survive.** Latent where it runs (Watertown 65 sites and Norman 182 are
100% hourly) and live but small at Niagara Falls (2 nightly + 3 daily). Douglas is
47% nightly, so this is why campmap could not simply reuse that endpoint to go
past 30 days: a booked campsite would have read as free on a public page.

Decision (Dan, 2026-08-23): **stay at 30 days**, with a per-org hand-off card,
rather than render nights we could not answer for. **SUPERSEDED 2026-08-24** —
the nightly-availability endpoint answers those nights properly, so the map went
to each site's real horizon and the hand-off card was removed. This subsection
still matters for the OTHER page: `/:org/rentalcalendar`'s overlay drops every
nightly booking (the `r.end` filter below), so it is still not a source a
campsite map may use, at any horizon.

### The three flavours of "no", and why the labels matter

A staff-entered hold awaiting payment **blocks the site** (Dan). rec.us reports
those nights as `available:false, reason:"outside-window"` — NOT `conflict`. The
first version of this code binned every non-`conflict` reason as "booking
restriction", which told a camper to try a different stay length for a site that
is simply taken. Now three buckets:

| rec.us reason | shown as | what the camper should do |
|---|---|---|
| `conflict` | Not available | another site or another week |
| min/max-stay | Free, but not for a stay this long | same site, different length |
| anything else (`outside-window`, blackout, closed) | Not available | another site or another week |

### Tested both ways: cap the checkout at 30 days, or let it run? (2026-08-23)

Dan's question: is it safer to cap everything at 30 days and avoid a "but it said
it was free", or allow wiggle room. Tested without creating a booking, because
`latestCheckout` IS rec.us's assertion about nights past its own window.

**rec.us is conflict-aware beyond the window.** It truncates `latestCheckout`
exactly at the next real booking, including bookings in October:

| site | ledger bookings past the window | cap for a 20 Sep arrival |
|---|---|---|
| Site 21 | Sep 24-27 | **Sep 24** — stops at it |
| Site 04 | Sep 25-26 | **Sep 25** |
| Site 22 | **Oct 2-4** | **Oct 2** — 12 nights out |
| Site 27 | Oct 7+ | Oct 4 (full 14 nights, nothing in the way) |

**37 boundary-crossing arrivals, 37 ledger-clear, 0 clashes.**

**Capping the checkout would cost real bookings and fix nothing:**

```
arrival       now: sites / max nights   capped: sites / max nights
2026-09-14         38 / 14                   38 /  8
2026-09-17         33 / 14                   33 /  5
2026-09-20         34 / 14                   34 /  2
2026-09-22         39 / 14                    0 /  0   ← all 39 unbookable
```

The longest stay decays 14 → 8 → 5 → 2 → 1 → 0 across the final week, and the
last arrival night becomes unbookable outright (any stay needs a checkout the cap
forbids).

**DECISION: arrivals capped at 30 nights, checkouts NOT.** The Arrive field's
`max` is the 30th night; the Depart field's `max` is rec.us's own `latestCheckout`
for the chosen arrival, so the picker cannot offer a stay the engine would refuse
nor refuse one it would accept. The asymmetry is
principled — past day 30 there is no arrival data, so offering one would be our
guess, while the checkout bound is not our guess but rec.us's answer. Guarded by
`scripts/campmap-stay.spec.js`.

The residual "but it said it was free" risk is **staleness, not the horizon**:
`RC_AVAIL_TTL` is 15 minutes, so a night can be taken between our fetch and a
camper's click. That is identical inside and outside 30 days. The lever is the
TTL.

### Guard: `node scripts/campmap-stay.spec.js` (33 assertions, in CI)

Slices the pure reducer out of `campmap.html` (the page builds a Leaflet map at
module scope, so the whole block cannot be evaluated) and pins the decisions
above. **Mutation-tested**, and the first version FAILED that test: reverting the
reason→state mapping left all 11 assertions passing, because the mapping lived
inside the fetch callback where the slice could not reach it. It is now
`nightStateFrom(v)`, a named function next to `statusOn`, and both mutations —
lumping non-conflict reasons back into `blocked`, and capping the checkout at the
window — now fail on the right assertion. A spec that has not been seen to fail
on the regression it names is not a guard.

### Backtest: `node scripts/campmap-availability-backtest.js`

Checks the map's nights against the reservation ledger in db 4, which knows
nothing about the availability endpoint. Site ids in `campmap-seeds.json` ARE
court ids, so the two sides join on identity — no display-name matching, which is
what makes the rentalcalendar overlay fragile. Needs `MB_API_KEY`; without it the
script fails rather than reporting a pass it cannot back.

Result 2026-08-23 (PR #143 preview, Dan's pre-merge gate), 1,271 site-nights at
Topaz Lake: **100.00% agreement — 1,271 of 1,271, zero diffs in EITHER
direction.** All 456 site-nights the ledger calls unbookable are blocked on the
map, and no night the map offers is covered by a live reservation. 13 random
sample ranges (8 fully bookable, 5 partial) were all clear, and in every partial
case each withheld night was backed by a real reservation. An unpaid hold counts
as occupied by default (386 of the 456 are holds); `--ignore-unpaid-holds`
measures how much of any gap they are.

**THE NIGHT RULE IS THE WHOLE MEASUREMENT — get it wrong and you invent diffs.**
An earlier run of this script reported 99.45% and 7 "safe" diffs (map blocks,
ledger free). That was not the map: the script used
`lower::date .. upper::date - 1`, and Topaz has reservations ending at **23:00**
rather than the 11:00 checkout, so the final DAY is still occupied and nobody else
can arrive on it. rec.us was right both times. The rule is now the arrival window
— a night N is unbookable if a reservation overlaps
`[N + checkIn .. N+1 + checkOut)` — with `--check-in-hour` / `--check-out-hour`
for orgs on other times. That is the second measurement error in this backtest to
survive being reported as a finding; check what a diff *means* before calling it
one.

**Correction worth remembering:** an earlier pass reported "3 dangerous diffs"
where the map supposedly offered held nights. That was a classification error on
my side — non-`conflict` blocks had been lumped in with "free". The map blocked
those nights all along. Check what `available:false` actually says before calling
a diff dangerous.

## Campsite map — public, un-retired, seed-scoped (Dan, 2026-08-22)

`campmap` is out of `RETIRED_REPORTS`. It was retired in favour of the Facilities
hub's Camping tab, which is right for ADMINS and wrong for campers: the Camping
tab is behind the org token, and `/:org/campmap` is the only **public, no-token**
view of a campground. It never stopped working — it has been quietly serving
~24 visitors a month via direct links the whole time it was "retired". Bringing
it back was surfacing it, not rebuilding it.

- **Seed presence is the whole gate.** The org landing route pushes `campmap`
  only when `CAMPMAP_SEEDS[slug]` exists, same shape as the facility permit chip:
  the card appears where there is a map and nowhere else, so the other ~26 orgs
  never see a link to an empty map. Two orgs qualify today — `douglas-county-nv`
  (Topaz Lake, 41 sites) and `pleasant-hill`. Nothing to configure for a new org
  beyond adding its seed.
- **The card link deliberately omits the token, and that is load-bearing.**
  `org.html` appends `?token=` to every other card, but on THIS page the token
  does more than authenticate — it unlocks drag-to-edit. A staff member copying
  the address bar to send to a camper would otherwise hand over an editable map
  *and* the org token that opens every other report for that org. `cardHTML()`
  routes `campmap` to `publicMapCardHTML()`, which renders a token-free href, a
  PUBLIC badge, and a "Copy link" button so sharing is deliberate. Verified in a
  real browser: the campmap href is `/{slug}/campmap` while a normal card is
  `/{slug}/gl?token=…`.
- Copying the link fires `campmap-share` (Slack), per the standing activity rule.
  Public page views already logged `view`, so camper traffic was pinging Slack
  even while the report was retired.
- **CORRECTION (2026-08-23): that share ping never actually fired.** The route was
  declared ~4,400 lines BELOW the generic `/:org/:report/api/log|share`, and
  Express matches in registration order — so every call hit the generic route,
  which runs `resolveOrg` and 404s any report outside `REPORT_TYPES`. campmap is
  deliberately not one, which is the very reason the dedicated route exists. It
  returned `404 Unknown report: "campmap"` from the day PR #140 merged. Nothing
  caught it: server.js parses, the server boots, the page renders, the client code
  is correct, and a fire-and-forget beacon never complains.

## The campmap site drawer had TWO calendars — one is gone (Dan, 2026-08-23)

The drawer showed a per-night strip for the stay in the bar AND a whole-month
mini-calendar under "Availability". Dan: "the bottom one isn't needed. remove
it." It is gone (`miniCalHtml`, `wireMiniCal`, `calMonth` and their CSS), and the
per-night strip stays — it answers the question for the stay actually being
searched, and two calendars in one panel are two things that can disagree.

`setDate()` survives for the `?date=` deep link, which was its other caller.
And Amenities is now the last section before the Book button, so it is skipped
when a site has no amenity tags rather than leaving a bare heading on top of it.

**Also gone: the "Pin position set by admin." caption**, which Dan flagged as
strange — because it is plumbing talk on a camper-facing page, and so was
"Location from rec.us." A pin in the right place needs no caption. The note now
appears only in EDIT mode, or when the position is genuinely approximate
(`approx && !placed`), which is the one case a camper benefits from knowing.

**The hand-off link is per-org in `campmap-seeds.json` (`bookAhead`) and it is
worth pointing at the campsite-filtered tab**, not the location-filtered one:
Douglas is now
`https://www.rec.us/organizations/douglas-county-nv?tab=facilityRentals&siteType=campsite`
(verified 200). Copy reads "Looking for campsite dates more than 30 days out? /
Click to book directly on rec.us, or call the …" — the day count comes from
`DAYS_SHOWN`, so it stays true if the horizon ever moves.

### Kill stray local servers before driving a page (cost me a wrong "verified")

The drive scripts used a FIXED port, and a leftover `node server.js` from an
earlier run answered on it — so a run that reported the hand-off href showed the
**old** URL, minutes after the seed had been changed, and a fresh boot proved the
new one. A stale server is indistinguishable from a code failure in the output.
Bind a per-run port (or `pkill -f "node .*server.js"` first) and re-check
anything a leftover could have answered. This is the same warning as the timing
caveat in the health-check section, with teeth.

## Campsite type filter — rec.us's four values, and where they actually live (2026-08-23)

The public map's top bar carries a **Campsite Type** control beside the dates.
The four options are rec.us's own, and they are not a guess — `court.sub_type`
carries a CHECK constraint:

```sql
CHECK (sub_type = ANY (ARRAY['tent','rv','tent-and-rv','lodging']))
```

which is exactly the admin dropdown (Tent Only / RV Only / Tent & RV / Lodging).
**Match them EXACTLY, and before the substring rules.** The old `kindInfo` tested
`k.indexOf('rv')>=0` first, so an **RV-only** site was labelled "Tent & RV" — the
one answer a tent camper must never be given. `typeKey()` and `CANON_KINDS` now
match exact values first; `scripts/campmap-stay.spec.js` fails on the revert.

Platform-wide today (db 4, `type='campsite'`, 64 sites):

| sub_type | sites | orgs |
|---|---|---|
| `tent-and-rv` | 42 | 2 (all 41 of Douglas/Topaz + 1 test) |
| NULL | 16 | 3 (incl. **all 12 Pleasant Hill**) |
| `tent` | 5 | 4 |
| `lodging` | 1 | 1 |
| `rv` | **0** | — |

Two consequences worth knowing before reading the control as broken:

- **Topaz Lake is uniformly `tent-and-rv`, so the control shows ONE type there.**
  When a campground is all one type the select renders **disabled**, naming what
  the sites are rather than implying a choice. **It does NOT light up on its own
  when someone varies the types in the admin** — see the next section; the seed
  has to be updated too. What actually varies at Topaz is
  **max trailer length (26–60 ft, 18 distinct values)** and rate ($30 ×26 / $40
  ×15); a rig-length filter is the natural companion and is not built.
- **`electric` / `primitive` are OURS, not Rec's.** Pleasant Hill's 12 campsites
  carry `sub_type` NULL, so `sKind()` derives those two from the site
  description. They stay in the canonical table because they are how those sites
  genuinely differ — but do not mistake them for rec.us values.

`TYPE_FILTER` + `VIEW()` are the whole mechanism: **everything that counts, lists
or paints reads `VIEW()`, never `SEED`** — markers, the site list, the "N of M
open" line, and `latestCheckoutFrom()`. That last one matters: scoped to the
filter, so picking "tent only" cannot offer a checkout only a lodging unit
allows. Filtered-out pins come OFF the map rather than being dimmed (a greyed pin
is indistinguishable from an unavailable one); the open drawer's own site stays
on. The filter is deliberately **not** persisted — it is a search intent, not a
layout preference, and a camper returning to a silently narrowed map would read a
subset as the whole campground. `EDIT` mode ignores it entirely.

### The filter reads the SEED, because Rec's API does not expose sub_type

Verified on the PR #143 preview, 2026-08-23: `/douglas-county-nv/rentalcalendar/api/sites?types=campsite`
returns **41 campsites, `subType: null` on every one** (and `bookingUnit: null`),
while `court.sub_type` in db 4 says `tent-and-rv` for all 41. The MCP
`list_sites` payload has **no `subType` key at all** — `sKind()` prefers
`l.subType` and it is simply never there.

So the filter's options come from `campmap-seeds.json`'s hand-maintained `kind`,
which happens to agree with the database today (Douglas `tent-and-rv` ×41;
Pleasant Hill's real value is NULL, so our derived electric/primitive is the only
signal that exists for it). **Consequence to say out loud: changing Campsite Type
in the rec.us admin will NOT change this map.** Either the seed's `kind` is
updated to match, or the platform starts returning `subType` from `list_sites`.
Worth raising with whoever owns the sites API — `capacity`, `priceCents` and the
nightly policy all come through, so the field is an omission rather than a
limitation. Nothing in the app can detect the drift: there is no runtime DB
access, and a wrong `kind` renders perfectly.

### The live site feed was truncating campsites away entirely

`/:org/rentalcalendar/api/sites` asked the Rec MCP for **one page of 100**.
Douglas County has **194 courts**, so its 41 campsites fell off the end:
`loadSites()` threw `no live sites matched` and `/douglas-county-nv/campmap` ran
**entirely on its baked seed** — no live `sub_type`, price, capacity, amenities or
nightly policy, ever. Nothing complained; the page renders fine on the seed.

Fixed two ways: the route accepts `?types=campsite` (forwarded as the MCP's
`siteTypes`, validated against the tool's enum) and its page size is 250. campmap
asks for `types=campsite` because it only ever plots campsites. Guarded by the
`campmap · type filter` case in `ci-check-render.js`, whose fixture assigns
sub_types the seed does not have — so the case passes only if the LIVE overlay
landed and rebuilt the options from it. Note that is the code PATH being covered:
in production the real feed omits `subType` (above), so the seed's `kind` is what
the options are actually built from.

### And the Depart picker was stale until you touched it

Same session, same area: `setStay()` derives the Depart field's `max` from
rec.us's `latestCheckout`, but `loadAvailability()` only repainted — it never
re-ran `setStay`. So between boot and the first interaction the picker offered the
**fallback** bound (the org's configured max stay, 14 nights at Topaz) instead of
rec.us's answer, i.e. a checkout rec.us had already said it would refuse. That is
the "but it said it was free" the asymmetric cap exists to prevent. It now re-runs
`setStay(SELECTED, DEPART)` when availability lands.

Activity: `campmap-filter` (🔎) posts the type chosen plus what it found
(`sites`, `open`), debounced **by type** — someone trying tent-only then RV-only
is telling us two things. Covered by `scripts/campmap-beacons.spec.js`.

## Campmap activity tracking — route order is the whole trap (2026-08-23)

**Anything campmap-specific must be registered BEFORE the generic
`/:org/:report/api/*` routes**, not near the other campmap handlers further down
server.js. See the correction above for what happens otherwise.

Events, all on `POST /:org/campmap/api/log?event=…` (allowlisted, every string
clamped — the page is public and un-tokened):

| event | fired by | extra |
|---|---|---|
| `campmap-site` | opening a campsite | `site`, `state` (avail/partial/booked/blocked), `nights` |
| `campmap-book` | the site's **Book on rec.us** button | `site`, `nights` |
| ~~`campmap-book`~~ | ~~the hand-off card at the foot of the site list~~ — **removed 2026-08-24** with the card itself; the map now answers those dates | ~~`kind: "later-dates"`~~ |
| `campmap-share` | Copy link / Copy embed on the Camping tab | `kind: link|embed` |

Both debounce **by site**, the same decision as the rentalcalendar's map pins: a
camper comparing six sites should read as six in the feed, not as whichever one
they opened first.

`campmap-site` carries the stay verdict on purpose — "opened Site 12" is trivia;
"opened Site 12, free for their 3 nights" says whether the map is answering the
question. And the hand-off card is its own `kind`: it used to POST
`/api/share?kind=book-ahead`, which normalises kind to `embed|link`, so a booking
hand-off was recorded as a link copy.

Guarded by `scripts/campmap-beacons.spec.js` (7 assertions, in CI), which checks
the source registration order AND boots the server to require a 200 *plus* a row
in events.jsonl — a 200 alone would not have caught the original bug, since the
generic route's 404 was the only symptom. Mutation-tested: moving the routes back
below the generic ones fails it by name.
- Editing still works for admins exactly as before — open the page WITH `?token=`.

## Metabase renders every timestamp in PACIFIC — and dates are not instants (2026-08-24)

Two independent bugs stacked up in the Fast Track report and made Smyrna's 154th
Birthday Concert read **"Oct 2 · Sat 02:00pm–07:00pm"** when Rec's own admin says
**Oct 3, 5:00–10:00pm**. Both are general traps, not fast-track ones.

**1. The Metabase report timezone is `America/Los_Angeles`.** Confirmed with
`current_setting('TimeZone')` on db 4 — every query response also carries
`"results_timezone":"America/Los_Angeles"`. So `to_char(ts, ...)` and `ts::date`
on a `timestamptz` are evaluated in **Pacific**, whatever the org's own timezone
is. Card 17300 does exactly that:

```sql
MIN(sess.starts_at)::date                                AS section_start,
(ARRAY_AGG(to_char(sess.starts_at, 'Dy') ...))[1]        AS section_day,
(ARRAY_AGG(to_char(sess.starts_at, 'HH12:MIam') ...))[1] AS section_time
```

Ground truth for those sections: `starts_at` = `2026-10-03 21:00 UTC` =
**17:00 America/New_York** (what Rec shows) = 14:00 America/Los_Angeles (what we
printed). A Pacific org would look fine, which is why this survived.

**The fix, when it is applied, must convert first** — `location.timezone` is
populated on **all 3,099 locations across all 151 orgs** (Smyrna: uniformly
`America/New_York`), so it is a reliable join, unlike `organization.config`
which holds no timezone key:

```sql
(sess.starts_at AT TIME ZONE loc.timezone)::date            -- not sess.starts_at::date
to_char(sess.starts_at AT TIME ZONE loc.timezone, 'Dy')     -- etc
```

Note `timestamptz AT TIME ZONE 'X'` yields a `timestamp` in that zone, which
`to_char`/`::date` then read literally — no session-timezone dependency left.

**APPLIED to card 17300 as v17 (2026-08-24), and signed off.** Pushed via the
API — which reset `start_date` to Text exactly as the warning below says, so Dan
re-flipped both date tags in the UI immediately after. Verified in that order:

- the live card was re-read and diffed against the repo mirror FIRST (identical,
  no drift), then the pushed SQL was diffed back against the mirror
  (byte-identical, 618 lines) — a hand-transcribed 618-line push needs that
  check, not trust
- cache-independent live sign-off through the public endpoint: smyrna 10,629
  rows in 9.0s, apex (heaviest) 46,984 rows in 57.9s
- the served card now returns `2026-10-03 · Sat · 05:00pm–10:00pm` for all four
  birthday-concert tables, matching Rec's admin exactly. The two summer concerts
  were three hours out too, so this was every Smyrna section, not just upcoming
  ones
- `scripts/report-cards.manifest.json` gained a **smyrna** fasttrack row as the
  timezone regression case: apex is the worst case for timeouts but is Pacific,
  so it structurally cannot catch this class of bug. An Eastern org has to be in
  the manifest for the daily check to see a regression here.

The date was already right in Pacific for this particular section, but an
early-morning Eastern event still slips a day (56 sections across 8 orgs did),
so this was a correctness fix and not only a cosmetic one.

**2. `::date` columns come back as bare `YYYY-MM-DD`, and `new Date()` parses
that as UTC midnight.** So a US browser formats `"2026-10-03"` as **Oct 2** —
which is why the row printed the card's own (correct) `Sat` next to a Friday
date, and how the two bugs were told apart. `parseCardDate()` in
`public/fasttrack.html` builds the date from its parts; real timestamps
(`Reg Opens`, `Reg Closes`, `Publish Date`) must keep going through
`new Date()`, or every countdown on the page shifts.

**The guard has to force a timezone.** `scripts/fasttrack-dates.spec.js`
re-execs itself under `TZ=America/New_York`, because this sandbox AND GitHub
Actions both run UTC — where the broken parse looks correct. Reverting the fix
passed every assertion until the timezone was pinned. A UTC-only date spec is
decorative.

## A section can have TWO registration windows, and the early one is still registration (2026-08-24)

`registration_window` carries a `default` window and, often, a `group` one
(early access, `group_id` set). Card 17300 emits both — `Reg Opens` and
`Early Access Opens` — but `public/fasttrack.html` mapped `earlyAccess` and then
**never read it**, so "when does this go live" came only from the general window.

Smyrna's four birthday-concert tables each have both, a week apart:

| section | early access | general |
|---|---|---|
| Premier Table | Aug 24 | Aug 31 |
| Preferred Table | Aug 25 | Sep 1 |
| Select Table | Aug 26 | Sep 2 |
| General Table | Aug 27 | Sep 3 |

So the report announced *"Reg opens Aug 31 · 8 days"* for sections whose first
families could register the next morning. `sectionGoLive(s)` now returns the
earlier of the two **and which one it is**, because "opens tomorrow" without
saying it is early-access-only is its own kind of wrong. Every go-live question
on the page reads it: the countdown chip, the leaderboard's soonest sort, the
Launching Soon bucket, and Cold Sections.

**The same bug was still in "Just Launched" (fixed 2026-08-24, PR #152).** That
bucket filtered on `r.regOpens` alone, so a section whose early-access window
opened stayed out of it for the entire week before its general window — the
week it is actually converting. It now keys on `sectionGoLive()` and labels the
row `· early access` so the bucket never implies general registration is open.
Guarded by the `fasttrack · just launched` render case
(`[data-launched-kind="early"]`), mutation-tested against the old filter.

### CLOSED 2026-08-28 — 'early-access' is now its own Reg Status (card 17300 v18)

Dan: *"A new label, I like 'Early Access' if one group can register but others
cant. Pretty typical that lots of users will FT sections like this, so you can
have two 'phases' of FT."*

Card 17300 used to compute `Reg Status` from `rw.default_opens` alone, so a
section already registering its early-access families reported `pipeline` —
"registration has not started", which is false for everyone in that group. The
page had patched it since 2026-08-27 (`ftEffectiveStatus` promoted `pipeline` to
`open`), which kept the Conversions tab correct but could only ever say **Open**
about a section most families cannot register for. A label needs the card to
carry the phase, so v18 emits `'early-access'`.

- **Both UNION arms carry the rule**, or one section reads two ways depending on
  which side it came down. The pipeline arm's `WHERE` already scopes to
  `default_opens > now()`, so its test is the short form.
- **Order inside the CASE is load-bearing**: after draft/scheduled/published,
  before `pipeline`. Test it after `pipeline` and it is unreachable.
- **Dry-run before pushing — exactly one transition, nothing else moves:**
  `pipeline → early-access` **179**; draft 32942, open 14647, closed 2545,
  scheduled 560, pipeline 518, published 503 all identical.

**THE CACHE INVARIANT IS THE HARD PART, and it is what the guard is really
for.** Feeds cache for 4 hours, so a pre-v18 response (`pipeline` + an open early
window) and a v18 one (`early-access`) are **both live at once**.
`ftEffectiveStatus` resolves them to the same value, or the report changes what
it says about a section the moment a cache entry expires. The pre-v18 branch that
used to return `'open'` now returns `'early-access'`.

**A third status is exactly how the tab lost these sections the first time** — it
gated on `open || closed`. `ftIsPostReg(st)` is now ONE module-scope helper read
by the Conversions tab, the badge that labels it and the flow board; the badge
and tab disagreeing would have undercounted by 561 pending holds at Smyrna alone.
`ColdPipelineStrip` reads the EFFECTIVE status too — a section in early access is
not cold, and says `pipeline` on a pre-v18 feed.

`FT_STATUS_META` holds label + colour per status. Early Access is violet,
**deliberately not the green of Open**: a reader scanning the column has to see
that most families still cannot register. `ftStatusMeta()` returns a **copy**,
because a caller stamping a key onto it would write into the shared map.

**The transcription slip worth remembering:** the first push landed byte-perfect
except that the card's trailing `ORDER BY 1, 2, 3, 9 DESC, 4` was dropped — `wc
-l` counts newlines, and the file's last line had none, so reading "lines 501-641"
silently stopped one line short. Caught by diffing the pushed SQL back, which is
the whole reason that step exists; re-pushed and re-diffed to byte-identical. The
repo mirror `sql/report-cards/17300-fast-track.sql` matched the live card exactly
before the push (no drift) and now holds v18.

Guards: `scripts/fasttrack-early-access.spec.js` (**38 assertions, in CI**),
which lifts and RUNS the helpers and reads the repo SQL mirror. Mutation-tested
ten ways, all failing by name: the card value not passed through, the pre-v18
promotion reverted to `open` (the cache invariant), `ftIsPostReg` dropping early
access, the table labelling from the raw column, Cold Pipeline back to the raw
column, the label reworded, early access painted the same green as open, the rule
in only one UNION arm, `early-access` tested after `pipeline`, and the trailing
`ORDER BY` dropped. Plus the `fasttrack · early access has its own label` render
case, whose fixture carries the SAME section in **both** feed shapes
(`sec-premier-early` pre-v18, `sec-premier-early-v18`) and requires them to print
the same label — seen to fail in a real browser on both the raw-column relabel
and on `ftIsPostReg` dropping early access.

## FT conversion is measured against the spots FT could win (2026-08-24)

Dan, on Smyrna's 154th Birthday Concert Premier Table three hours after its
early-access window opened — live card figures: **140 FT holds, 25 converted,
115 pending, capacity 25, direct enrolled 0, fill 100%, waitlist 0, $325/seat.**
The section sold out to Fast Track families with zero organic registrations, and
the report showed **17.9% in a 🌤️ WARMING band**, because the card computes
`Conversion % = ft_converted / ft_total`.

**17.9% was the ceiling.** 140 holds chasing 25 seats cannot convert above
25/140 however well it goes, so holds-as-denominator grades a sellout against a
target that does not exist. Dan: *"If there are only 25 spots, and 25 FT
conversions, that's 100% FT conversions."*

`ftConvPct(holds, converted, capacity, direct)` in `public/fasttrack.html` is now
the only source of `convPct`, for sections and for the program rollup:

```
available = capacity - direct enrolments      what FT could win
denom     = min(holds, available)             ...and had holds for
```

- **Client-side on purpose.** The card already emits FT Total, FT Converted,
  Capacity and Direct Enrolled, so no card edit, no date-tag re-flip, and every
  surface that reads `convPct` (heat bands, triage buckets, the Conversions tab,
  the flow board, both tables, the Excel export) changes together.
- The card's holds-based column is kept as `convPctOfHolds` and appears only in
  the tooltip — "25 of 140 held" is worth saying, it just is not the rate.
- **Uncapped section ⇒ falls back to holds** (no ceiling to measure against).
  **No seats left for FT ⇒ null, not 0%** — a section whose seats all went to
  direct registrations gave FT no chance, and 0% would read as an FT failure.
  Over-conversion (capacity lowered later, waitlist promotion) clamps at 100.
- Demand past capacity is the **Demand %** figure's job, not a conversion miss.
  All four concert tables are capacity-bound: old ceilings 17.9%, 31.3%, 75%,
  75.8%, and nothing on screen said so.
- Guards: `scripts/fasttrack-conv.spec.js` (15 assertions, in CI) plus the
  `fasttrack · conv vs capacity` render case (`[data-conv-pct="100"]`) over a
  fixture carrying the real shape. Mutation-tested — reverting the denominator
  to holds fails the spec at the first assertion and the render case by name.

## "Launching Soon" is a section question, not a program question (2026-08-24)

The bucket test was `p._allFutureReg && p.ftSignups > 0` — *every* section in the
program still in the future. Smyrna's Concert Series has four tables opening
within days with 114 fast-trackers **and** two summer concerts that already
happened, so the program with 120 people waiting was excluded while a program
with 3 fast-trackers opening in 29 days was featured. It is now
`p._launch.length > 0` (sections with FT interest whose go-live is ahead), and
every figure on the card is scoped to those sections — a program's spent history
would otherwise inflate its pre-launch demand. Ordered soonest-first, and the
Demand Leaderboard defaults to "Going live soonest".

Guarded by two `ci-check-render.js` cases whose fixture is Smyrna's real shape —
`[data-launch-section]` (the program reached the bucket) and
`[data-golive="early"]` (go-live came from the early window). Both were seen to
fail on the reverted logic.

### ...and the bucket ORDER decided whether it rendered at all (2026-08-26)

Dan, on the Select Table of Smyrna's 154th Birthday Concert: *"This section has
over 200 people fast tracked… It opens in about 10 minutes but it hidden in the
larger program/sections list. It should be flagged as #1 up top."*

Right, and the fix above was only half of it. `_launch` was made section-scoped,
but it was tested **THIRD** in `TriagePanel`'s `else if` chain, behind two
capacity tests reading program-WIDE figures:

```js
if (spotsLeft === 0 && p.ftPending > 0)                  → needsCapacity
else if (p.demandPct > 90 && spotsLeft < p.ftPending)    → needsCapacity
else if (p._launch.length > 0)                           → readyToOpen   ← never reached
```

Measured against production: Concert Series carried **314 pre-launch
fast-trackers across two sections** (Select Table 203 on 45 seats, opening at
14:00Z; General Table 111 on 50), tripped branch 2 at **184.3% demand / 169
spots left / 574 pending**, and was filed under Needs Capacity. It was the
**only one of Smyrna's 19 programs with launching sections** that this happened
to — every other one sits under 58% demand, so **the test fires precisely on the
programs Launching Soon exists to surface.** The header read "256 fast-trackers
primed" with the 314 missing.

Three things worth keeping:

- **It was mislabelled, not just misranked.** Both capacity buckets render
  beneath *"✓ Registration Open · Programs where families can register now"*,
  and the Select Table's `Reg Status` was `pipeline`. The report told Dan
  families could already register, and named capacity as the problem.
- **The diverting figures were two-thirds spent history** — 200 of the program's
  ~353 capacity is the June and July summer concerts. Same trap as above: it was
  removed from the card's numbers but still governed whether the card rendered.
- **No sort change was needed to reach #1.** Everything in Smyrna's cohort opens
  at the same instant, so the existing FT tie-break puts 314 first on its own.

The chain now tests `_launch` first. Pre-launch demand over capacity is not a
separate "needs capacity" story, it *is* the Launching Soon story — the card
leads with the share of capacity fast-tracked pre-launch. **The decision moved
out of the component to a module-scope `triageBucket(p, spotsLeft)`**, for the
`nightStateFrom()` reason: inside `TriagePanel`'s `forEach` a spec could only
regex over the source, and a regex over our own patch is not evidence the page
behaves.

Ranking also moved from `_launchDays` to the go-live **instant**. Calendar days
tie everything opening today, so a cohort opening at 11pm outranked one opening
in three minutes on headcount alone. Changes nothing at Smyrna; matters the day
two windows share a date.

Guards: `scripts/fasttrack-launching-soon.spec.js` (22 assertions, in CI),
mutation-tested four ways — the old order, the calendar-day sort, the launch
branch deleted, and `triageBucket` buried back inside the component; all four
fail by name. Plus the `fasttrack · pre-launch beats capacity` render case,
asserting `[data-launch-list] > *:first-child[data-launch-program]`, i.e. **#1**
rather than merely present.

**The existing fixture could not catch this and never could have.** Concert
Series in `ci-check-render.js` is 198 FT over 375 capacity — **52.8% demand**,
under the threshold, so the capacity test never fired and `fasttrack · launching
soon` passed happily on the broken build. A second program, `prog-birthday`, now
carries the real proportions (336 FT / 295 capacity = 113.9%, two thirds of that
capacity spent), and its spent sections are load-bearing.

### Fast Track reaches the Director's Report, and Launching Soon leads (2026-08-26)

Dan, on a mockup: *"love it, lets add that to the current directors report"*, and
separately *"lets add an option to pin the upcoming launches. That section should
be at the top, above the 'just launched'."*

**The Fast Track section.** It was four small cards tucked inside the Waitlist
panel; it is now its own section between Waitlist and Facilities. Mockup:
https://claude.ai/code/artifact/56759609-e038-4e4a-9693-d3559470561b

- **Zero extra Metabase time** — `buildDirectorsQuarter()` already fetched the
  fasttrack feed for `dirFastTrack()`. Same argument as `dirOutdoor`/`dirFields`.
- **`dirFastTrack()` cuts the quarter itself.** The card is all-time by design,
  so quarterly figures come from `ft_booking` rows (which carry `Signup Date`)
  joined back to their section by `Section ID`. Section-grain columns — revenue,
  capacity, price — stay all-time.
- **Quarterly revenue is DERIVED and labelled as such.** The card has no
  per-quarter revenue, so it is `converted × Section Price`. Measured against the
  card's own all-time total that lands **$571 high on $187,620 (~0.3%)** —
  discounts and price changes. The all-time figure beside it is read from the
  card, never re-derived.
- **Conversion leads with the capacity-aware rate** (90.5% at Watertown) with
  of-signups (76.6%) greyed beneath — the `ftConvPct` reasoning, one report over.
- **`DIR_FT_MINUTES_PER_REG` is the one dial for "time saved".** Nothing in Rec
  measures how long a registration takes to process, so the hours are an INPUT.
  The page states the rate on screen inside a dashed warning box that nothing
  else on the report uses, because an assumed figure must never look like a
  measured one. Set the constant to 0 and the box disappears, leaving the count.
- The section self-hides where there is no Fast Track, and the quarter slice
  falls back to all-time when the quarter holds no bookings — a quarter of zeros
  reads as a verdict rather than as an empty window.

**Launching Soon now leads the Overview**, above Just Launched: what has not
opened yet is the only thing on the page whose outcome can still change.

- **`triageBuckets(programs, now)` moved to MODULE SCOPE.** Two callers read it
  now (the Overview for Launching Soon, `TriagePanel` for the rest), and two
  copies would drift the first time a bucket rule changed — the `triageBucket()`
  lesson one level up.
- **`readyToOpen` no longer counts toward `TriagePanel`'s own emptiness test**,
  or a pipeline-only org renders an empty panel under the section that moved out.
- **The pin already existed and was invisible.** Dan asked for "an option to pin
  the upcoming launches" for a control shipped in PR #152 — a bare 📌 at
  `opacity: .35` that only appeared on hover. It is now a labelled
  **📌 Pin / 📌 Pinned** button, opaque at rest, with `aria-pressed`. Cold
  Sections keeps the icon-only form (`label: false`) where the row is tight.
  Worth generalising: *a control nobody can find is a control that does not
  exist*, and the bug report for it arrives as a feature request.

**Two render cases of mine were wrong in ways only the browser showed**, both in
the `act` hooks rather than the page:

- The order case scraped `div`s for the heading text, but the Launching Soon
  heading is a `<span>` — never found, so the case silently proved nothing. Both
  headings now carry `data-launch-heading` / `data-justlaunched-heading` and the
  case compares `compareDocumentPosition`.
- The flame case asserted **globally distinct durations**. Durations repeat
  ACROSS rows by design (every row runs the same 1..n ladder), so it failed on a
  perfectly good page — 11 flames, 4 durations. It is per-ROW now. The first
  version was worse still: it compared `currentTime % 10`, which two flames can
  collide on by chance, so it passed one run and failed the next. **A flaky
  assertion is not a guard**; make the invariant something computed and stable.

Guards: `fasttrack-launching-soon.spec.js` 22 → 34, mutation-tested four ways
(order reverted, `readyToOpen` recounted, the pin back to 35%, the section not
rendered at top). Six new `ci-check-render` cases — including four for the
Director's Report Fast Track section, which **had no render coverage at all** —
and the burn case re-verified to catch both a static flame and a resynced row.

### Money left on the table, and the tab that could not show it (2026-08-27)

Dan, on the Smyrna 154th Birthday Concert General Table (273 holds, 49
converted, 223 pending, 98% fill): *"add another metric to the Fast Track
recently launched cards — the amount of $$ left on the table due to no remaining
capacity ... that's 30k of money left on the table, but we're not calling that
out."* And: *"when clicking on it, you can't even find that section on the
conversions tab. That tab should be sorted by most recently launched at the top,
with all the conversion, revenue and missed revenue metrics."*

It is **$39,025**, not 30k.

**WHICH MONEY FIGURE — the two are different questions.** Measured against card
17300 (smyrna), each EXACT on all 1,534 sections:

```
Over Demand $  === max(0, FT Total - Capacity) * Section Price
Left on Table  === FT Pending      * Section Price
```

Dan asked for money lost to *no remaining capacity*, which is **Over Demand**.
`Left on Table` is the value of every unconverted hold whether or not a seat is
free — at Watertown **100 of the 138 sections carrying it still have empty
seats**, so it is a follow-up figure and adding spots would capture none of it.
Putting it under a capacity headline sends someone to enlarge sections that are
already half empty. `ftBlockedRevenue()` is the single source, and the spec fails
if a capacity label is fed from `leftOnTable`.

Note the two **coincide on a section exactly at capacity** (273 − 50 == 223
pending), so only a section with free seats can discriminate — both the spec
fixture and the render fixture force them apart, the latter with a
`Left on Table: 999999` sentinel.

**WHY THE SECTION WAS MISSING FROM THE TAB.** This is the long-open `Reg Status`
issue in this file finally biting a reader. Card 17300 computes it from
`rw.default_opens` alone, so a section in **early access** with a later general
window reports `pipeline` — and the Conversions tab filtered on
`regStatus === 'open' || 'closed'`. All four concert tables were in that state,
so the section carrying 273 holds and $39,025 of blocked demand **was not on the
tab at all**, and `jumpToConversions` scrolled to an `#aq-<id>` that did not
exist. Fixed client-side in `ftEffectiveStatus()` — the page already knows both
windows — rather than with a card push, date-tag re-flip and heaviest-org
sign-off.

- **ONLY `pipeline` IS PROMOTED, and that restriction is the most important line
  in the change.** The first version promoted anything whose go-live had passed,
  which took Smyrna's post-registration set from **127 sections to 1,522** —
  1,291 of its sections are `draft`, invisible to families entirely. Caught by
  running the helper against the real feed before shipping, not by review.
  Correct behaviour is **+4 sections**, exactly the four concert tables.
- **The tab BADGE had the same bug** (`postRegPendingTotal` read the raw status),
  so it would have undercounted by 561 pending holds and disagreed with the tab
  it labels — the numbers-disagree-across-the-page trap again.
- **Everything that asks "how recently did this open" reads `ftLaunchedAt()`**,
  the go-live instant, not `regOpens`. Keying on `regOpens` puts an early-access
  section in the future, which is what kept it off the flow board too.
- The flow board now sorts **most recently launched first** (was hottest-first,
  which buried a section that opened an hour ago beneath one that opened three
  weeks ago and converted well). Blocked revenue is the tie-break.

Worth stating plainly: on Smyrna's launched sections, **missed-for-want-of-
capacity ($129,375) now exceeds collected FT revenue ($94,164)** — and all of it
sits on four sections.

**The fifth stat broke the card row, and only a browser could show it.** Dan:
*"small fix on the FT cards, see the spacing issues."* `.launch-stats` was a
non-wrapping flex row built for four stats, so the fifth squeezed every column —
`$39,025` clipped to `$3` and a two-word label broke over three lines on the
240px cards. The row now **wraps** (`flex-wrap` + `white-space: nowrap` on the
value and label), so the fifth stat folds onto a second line instead of
compressing. Mutation-testing the guard proved the wrap is the actual fix and the
shorter label is only copy: with the row wrapping, a long label fits fine. The
label is `Missed` on every card rather than changing wording per state — "No
room" beside `$0` reads as a contradiction, and a stable label makes a grid of
cards scannable. `ci-check-render` gained a per-case `viewport`, because this bug
does not exist at the default width.

Guards: `scripts/fasttrack-missed-revenue.spec.js` (30 assertions, in CI), which
LIFTS AND RUNS the four helpers against fixed instants rather than regexing, and
is mutation-tested six ways — drafts promoted, blocked reading `leftOnTable`, the
board back to hottest-first, launch time keying on `regOpens`, a no-capacity
section claiming nothing is blocked, and the tab reverting to the raw status. All
six fail by name. Plus four `ci-check-render` cases, two of which were seen to
fail on the real bug in a browser (the early-access section absent from the tab,
and the board re-sorted).

### The flames actually burn (Dan, 2026-08-26)

Dan, on an oversubscribed section: *"need more fire on these types of sections.
like flaming. can you do an animation on this."*

The heat scale already carried flame EMOJI as one string per tier. They are now
individual `.ft-flame` spans rendered by `FlameRow`, so each can flicker on its
own clock.

- **Each position has its own duration AND a negative delay.** Same-phase flames
  read as one object flashing, not as fire; the negative delay also means they
  are mid-flicker on first paint instead of all starting together.
- **`transform-origin: 50% 92%`** — the base of the glyph. A flame pinned at its
  centre wobbles like a balloon.
- **The heat haze (`.ft-flames.blazing::before`) is top-tier only**, same
  asymmetry as the rest of the scale: if everything glows, the glow stops
  meaning oversubscribed.
- `aria-hidden` on the row — the number and words beside it already say this, and
  a screen reader reading "fire fire fire fire" is noise.
- `flames` (the string) is KEPT alongside the new `flameCount`, because it is the
  no-JS/print fallback and what the older assertions pin.

**The guard that matters is the browser one, and it was seen to discriminate.**
`fasttrack · flames actually burn` reads `getAnimations()` and requires every
flame running AND their `currentTime`s out of phase. Disabling the animation was
verified to leave `fasttrack · flames are spans` PASSING while that case FAILS —
a static flame renders the same glyphs, so no source assertion can tell the two
apart. `fasttrack-heat.spec.js` 14 → 20, mutation-tested five ways; note the
duration-uniqueness assertion must include the BASE `.ft-flame` duration (flame
#1's), or an `nth-child` colliding with it slips through — it did, first time.

## Never ship a page without rendering it (IMPORTANT — cost us two blank pages)

**The rule: if a change touches a `public/*.html` React page, render that page in
a browser before pushing. Run `node scripts/ci-check-render.js`.** Every other
check in this repo can pass on a page that shows the user nothing.

**Both blank-page incidents had the same shape** (2026-08-22 and 2026-08-23, both
in `facilities.html`'s Camping tab):

A derived value was computed in an **IIFE** that referenced a `const` declared
*further down the same function*. In source that is a temporal dead zone. But
these pages run through **in-browser Babel, which compiles `const` to `var`** —
so instead of a tidy `ReferenceError: Cannot access 'DOW' before initialization`,
the identifier was silently `undefined` and the next line threw:

```
TypeError: Cannot read properties of undefined (reading 'map')
    at CampingView
```

React unmounted the tree. The page still returned **HTTP 200 with a complete HTML
document** and rendered a blank white area under the banner. The second time, it
reached production.

**Why nothing caught it — this is the part to internalise:**

| check | why it passed |
|---|---|
| `node --check server.js` | the file is syntactically valid |
| `ci-check-html.js` | the block *parses*; it only throws when **run** |
| `ci-boot-check.js` | the server boots and serves the page happily |
| `ci-check-admin-js.js` | checks the ADMIN page, not the report pages |
| all seven spec files | none of them mount a component |

Parsing is not running. A page can only be proven to render by rendering it.

**The guard: `node scripts/ci-check-render.js`** (in CI). It boots the server,
drives a real Chromium at each page, and fails on any uncaught exception **or** a
page that comes up empty — the `needs` selector per case is what turns "no errors
thrown" into "actually rendered something". Hermetic: every `/api/` request is
intercepted and answered from fixtures in the script, so it never touches
Metabase, never varies with live data, and cannot fail because a card is slow.
Adding a page is one line in `CASES`; adding a feed is one line in `STUBS`.

Nothing leaves the browser either: React, Babel, Leaflet and xlsx come from
cdnjs on every report page, so a blocked or flaky egress would blank all four
pages — the exact symptom the check looks for, read as a code defect. They are
served from `node_modules/.cache/render-check`, fetched once with `curl` (which
honours the sandbox proxy; Chromium's own requests do not get through). If a
fetch fails the check says *"this check proves nothing without them"* rather than
reporting blank pages. First run needs network; later runs are offline.

Verified in both directions on 2026-08-23 — the fixed page renders (exit 0) and
`main`'s version reproduces the production console error (exit 1):
`facilities · camping: Cannot read properties of undefined (reading 'map')`.
A guard that has not been seen to fail on the real bug is not a guard.

**And the coding rule that removes the class:** in these page components, define
derived values *after* everything they read — the safest place is immediately
before the `return`. Do not scatter IIFEs above their inputs and rely on
declaration order, because Babel turns the error you would want (a throw naming
the identifier) into the error you get (`undefined` two lines later, naming
nothing useful). If a derivation must sit high in the function, compute its
inputs locally instead of reaching down the file for them.

## The admin dashboard is a template literal — check its JS before shipping (IMPORTANT)

**The trap, and it has now bitten twice.** The whole admin dashboard is one giant
JS template literal inside `server.js`. That means every character destined for
the browser passes through TWO parsers: server.js's literal first, the browser
second. The literal eats one level of escaping.

2026-08-22, shipped to production in PR #137: a status string written as

```js
'Watching — alerts if a card\'s Start/End Date tag …'
```

The `\'` collapsed to a bare `'` on the way out, so the browser received an
unterminated string, threw a SyntaxError, and **discarded the entire 201KB
`<script>` block**. Every function declared in it was undefined and *every button
on the admin dashboard silently did nothing*. The only visible symptom was
`Uncaught ReferenceError: clearAllDrift is not defined` on whichever button was
clicked first — which points at an innocent function that was defined correctly.

**Nothing in CI could see it.** `node --check server.js` passes (server.js is
valid — the broken code is a *string* inside it). The specs pass (none render the
page). `ci-boot-check` passes (the server boots and serves the page happily).
The bug existed only in the browser, in generated code, which nothing looked at.
The earlier backtick incident in this same literal was the first bite.

**Now guarded: `node scripts/ci-check-admin-js.js`** (in CI). It boots the
server, fetches `/`, and checks the generated HTML two ways:

1. every inline `<script>` block parses (catches the escaping class), and
2. every inline `on*="handler()"` names a function that is actually declared
   (catches a button wired to a renamed or deleted function).

Verified against the real bug: reintroducing that apostrophe makes it report the
syntax error **plus 20 orphaned handlers** — i.e. it reproduces the symptom Dan
saw, not just the cause.

**Rules for any change to the admin dashboard:**

- Run `node scripts/ci-check-admin-js.js` before pushing. `node --check` is not
  enough and never was.
- **Prefer rewording over escaping.** Inside this literal, an apostrophe in
  emitted JS needs `\\'`, a backtick needs escaping, and `${` needs care. The
  fix here removed the apostrophe rather than double-escaping it, because the
  next person editing the line would have to re-derive the same reasoning.
- A single broken string takes out EVERY button in its block, so the blast
  radius of a typo here is the whole panel, not one feature.

## Watchdog switches in the admin dashboard (Dan, 2026-08-22)

Three toggles in the admin **Feature Flags** block, same switch as the existing
flags and the same `DASHBOARD_PASSWORD` gate:

| flag | stops |
|---|---|
| `schemaBreakAlerts` | the catalog check + `schema-break` |
| `paramDriftAlerts` | the card date-tag check + `param-drift` |
| `reportDownAlerts` | the `report-down` alert (health check still runs) |

**OFF means off everywhere.** Each flag kills the scheduled check AND its alert,
so flipping one does not leave a check burning Metabase time and painting the
panel red. The gates live in three places on purpose: the scheduled entry point
(`checkCatalogDrift` / `checkCardParamTypes` return `{skipped}`), the alert site
(`alertable = active && watchdogEnabled(...)`), and `notifySlack()` as a
backstop. All default **ON**, and a missing/unreadable flag file means watching
— the failure direction must never be silence.

- **A manual run still works while muted** (`opts.force` bypasses the scheduled
  gate; `notifySlack` keeps it quiet). Looking without being paged is the point.
- **`report-down` is different from the other two**: the health check keeps
  running and the panel still shows the failure — only the announcement stops.
  A card that cannot answer is worth seeing on the panel either way.
- **Toggling posts to Slack** (`watchdog` event) with what stops being noticed,
  and @-mentions on OFF. Deliberately NOT in `ALERT_FLAG_BY_EVENT` — the notice
  that a watchdog went quiet must not be silenced by the switch it reports.
  `WATCHDOG_FLAG_META` holds the label/consequence copy; the dashboard confirm
  dialog says the same thing before the switch flips.
- `/api/admin/flags` **POST now rejects an unknown key.** It used to accept any
  key and write a flag nothing reads, which looks like a working toggle and is
  not one. Only `DEFAULT_FLAGS` keys are settable.
- State is readable on `/api/admin/schema-break` (`enabled`),
  `/api/admin/param-drift` (`enabled`) and `/api/admin/report-activity`
  (`reportDownAlerts`) — check these first when an alert did not fire.

## A link that used to work is invisible to every other check (2026-08-25)

Dan: */town-of-shrewsbury/users?token=…* → **"Unknown org"**. Not a regression —
the duplicate `town-of-shrewsbury` entry was removed on 2026-07-20 and the org is
served as **`shrewsbury`** (token `17hO58KgKgNVauE5`). The URL had been dead for
five weeks and nothing noticed, because **the health check probes orgs that
EXIST**: an org that is renamed or removed is not looked at at all, while its URL
keeps circulating in emails and bookmarks. It was found by a human clicking it.

Neither the old slug nor that token is anywhere in this repo's history — only the
changelog line recording the removal — so the link predates 2026-07-20.

`noteDeadLink()` in server.js now watches for it, and two decisions are the whole
design:

- **THE TOKEN IS THE DISCRIMINATOR.** This server is scanned constantly. Alerting
  on every 404 would fire on bot traffic, get muted inside a day, and leave us
  worse off than with no alert at all. A scanner does not know our token shape; a
  stale internal link carries the token it was minted with. So a 404 is only
  interesting **if the request brought a token** — plus a denylist for the usual
  scanner paths (`.php`, `.env`, `wp-*`) in case one ever guesses.
- **THE TOKEN IS NEVER RECORDED.** It is a share credential and `events.jsonl` is
  read by the admin dashboard and echoed to Slack, so logging the thing that
  proves the link was real would leak it into both. The record carries
  `hadToken: true` and nothing more.

Hooked on the RESPONSE (`res.on("finish")`) rather than at each 404 site: about 30
places send a 404 — `resolveOrg` plus every page route's own guard — and a
middleware reading the finished status catches all of them, including ones added
later. It also **names the surviving slug** (`town-of-shrewsbury` → `shrewsbury`)
by stripping `town-of-`/state suffixes and matching against `ORGS`, because a
rename is the usual cause and naming the survivor turns the alert into the fix.

Debounced **6h** — one forwarded email would otherwise post once per recipient.

Guarded by `scripts/deadlink-alert.spec.js` (10 assertions, in CI), which boots
the server and drives the real failing URL. Mutation-tested against five
regressions: the middleware removed, the token gate dropped (so bots alert), the
token logged beside the path, the suggestion dropped, and `deadlink` missing from
`SLACK_NOTIFY` (logged but never posted). All five fail it by name.

**What this does NOT do:** it does not rewrite or alias the old URL. The dead link
still 404s — this watches, it does not redirect. If old `town-of-shrewsbury` links
need to keep working, that is a slug alias plus a decision about honouring the
retired token, and it has not been made.

## Alerts only fire for reports that are actually used (Dan, 2026-08-22)

**Rule: don't alert on a report nobody uses; once it's used, it joins the alert
set on its own.** Nothing to configure and nothing to remember — the events log
already knows, so the watchdogs ask it. `getReportActivity()` in server.js reads
`events.jsonl` over `REPORT_ACTIVITY_WINDOW_DAYS` (default **45**, cached 1h) and
answers `isReportActive(slug, rt)` / `isReportTypeActive(rt)`.

What that gates:

- **Health check** — inactive org/report pairs are not probed at all (saves the
  Metabase time too) and are recorded as `status: "inactive"` so the panel says
  *why* rather than showing a stale tick. An inactive failure never enters the
  failures list, the count, or the email.
- **`schema-break`** — fires only if a dropped table/column breaks an **active**
  report, and the message names only those. Full diff stays in the state file.
- **`param-drift`** — fires only for a card serving an active report.

Three traps this is built around, all of which fail silently if you get them
wrong:

1. **Activity counts EVERY usage event, not just `view`.** The six Program
   Summary bands (`selfservice`, `program-checkins`, `program-demographics`,
   `retention`, `checkins`, `section-detail`) have **zero** `view` events by
   design — they're fetched by `programs.html` for 15 orgs apiece. View-only
   activity would stop watching the most-used reports on the platform.
2. **`report-down` must not count as usage.** It's logged against the real
   org/report, so counting it would let a broken unused report alert once,
   qualify itself as active, and keep alerting forever. `NON_USAGE_EVENTS` is a
   denylist (not an allowlist) so a new export counts as usage the day it ships.
3. **An empty log means watch everything.** A missing events file, a fresh
   volume, or a new PR preview is not evidence that 22 reports went unused.
   `/api/admin/report-activity` reports `failsafe: true` when that's in effect.

`/api/admin/report-activity` is the first place to look when an alert did NOT
fire.

**The bands are now in `REPORT_DEPENDENCIES` (2026-08-22).** They were the
largest hole in that map for exactly the reason above — no `view` events, so they
looked unused, while ~15 orgs each depend on them. Tables and columns were read
out of the live card SQL (19174 selfservice, 18547 program-checkins, 17722
program-demographics, 18151 checkins, 17953 section-detail, 17298 calendar) and
validated against the schema-catalog card before shipping: **22 reports declared,
54 tables, 700 column declarations, zero missing.** Only `annual-report` (dead)
and `qoq` (derived from the GL card, no card of its own) have no entry.

Two of calendar's dependencies have *already* been through the break this map
exists to catch — `class`/`class_activity` and `section_price` were both dropped
and the card migrated — which is the argument for declaring the rest before it
happens again. Deliberately not the cache's `isReportHot()` (3+ opens in 7 days) — right
question for holding rows in memory, wrong one for "does anyone rely on this".

Usage as of 2026-08-22 (log starts 2026-05-22, so ~3 months): dead are
`overview` (8 opens ever, none in 90d, orphaned page — still in
REPORT_DEPENDENCIES) and `annual-report` (3 opens, last 51d). `court-utilization`
as a *page* is dead (2 views/30d) but its **card is load-bearing** —
`facilities.html` pulls it 174x/30d across 13 orgs, so don't retire the card with
the page. `campmap` is in `RETIRED_REPORTS` yet has 24 views/30d across 2 orgs,
so it's more alive than the other two retired reports.

## Health-check alert noise — what caused it, and the three guards (2026-08-22)

Dan got ~20 `report-down` alerts in an afternoon for reports that were all still
serving. Diagnosis, cache-independent: the cards were **slow, not broken**.
`clarksville/roster` returned its 1337 rows in **7.7s one hour and 59.8s the
next** against a 60s budget; `apex/fasttrack` and `apex/ice-calendar` both blew
past 70s. Every marginal miss was one Slack message.

**Partly self-inflicted.** PR #134 pointed the 28 shadowed per-org rows at the
real shared cards (correct for *which* card, wrong about *how many times*). The
per-org loop's comment always said "only reports with a per-org mbUuid" — the
shadowed entries defeated that, so each run fired ~28 extra heavy Metabase
queries against the same cards the shared loop already probes once, which pushed
those cards over their own timeouts. Watchdog as its own load source.

**And two of the ten were never slow — they were health-check bugs.** Probing
with the error body captured showed:

- `_shared/programs` → `missing-required-parameter: end_date, start_date`. The
  probe sent **org_id only, never dates**, so any card with REQUIRED date tags
  failed on *every* run. A permanent false alarm no flap protection can silence
  — and it returns 200 with 15 rows the moment the dates are passed. Cards with
  *optional* date tags were worse in a quieter way: they ran with no date filter
  at all, i.e. the whole table instead of one window, which is a large part of
  why these probes sat on the 60s timeout. `chat-data` fixed exactly this bug
  ("the old path used stale per-org UUIDs with no dates/org_id → cards errored →
  empty"); the health check still had the old shape. It now calls
  `buildMetabaseParams({}, rt, orgId)` like the report route does.
- `_shared/qbr-stats` → last actually checked **2026-07-06**. `_shared` was
  exempt from the stale-entry purge, so when qbr-stats joined
  `HEALTH_SKIP_REPORTS` its `error` row was never re-probed and never cleared —
  47 days in the failure count for a report nothing was looking at. The purge
  now sweeps `_shared` for report types that are skipped or no longer shared.

**Slow is not broken, and only broken alerts (Dan, 2026-08-22).**
`classifyProbeFailure()` splits the two:

- **slow** — a client-side timeout, a Metabase 5xx, or a `statement timeout` /
  `canceling statement` behind an HTTP 400. It could not answer in time *this
  time*; the app serves those from cache anyway. Status `slow`, amber on the
  panel, never a failure, never an alert, and a slow round **resets** the broken
  streak rather than feeding it.
- **error** — the card cannot answer because of what it IS: a dropped table or
  column (`relation "class" does not exist`), a renamed or newly-required
  parameter, an unshared or deleted card (404), a SQL error. These do not fix
  themselves, so they alert — after two consecutive rounds, and only for reports
  in use.

Four guards, all in `runHealthCheck`:

1. **One probe per card.** The per-org loop skips anything
   `resolveReportCard(slug, rt).shared` — the `_shared` row covers that card.
   Per-org probes **31 → 3** (only `norman/gl`, `smyrna/historic`,
   `apex/ice-calendar` have genuinely per-org cards), so a full sweep is
   **45 → 17** probes. Stale per-org rows are purged, or the panel keeps showing
   their old failures forever. Note this is where essentially all of the load
   reduction comes from — activity gating currently removes no probes at all,
   because the 3 surviving per-org combos and all 14 shared types are in use. Its
   value is suppressing `schema-break`/`param-drift` on dead reports and covering
   reports that fall out of use later.
2. **`HEALTH_ALERT_AFTER` (default 2) consecutive failures** before a report is
   called down. One miss is load; two rounds in a row is evidence. `failCount`
   resets on any success, and `lastAlertedAt` is carried across recoveries so a
   card flapping either side of its timeout cannot re-alert every few hours.
3. **The error says what Metabase said.** A statement timeout comes back as HTTP
   400 with the reason in the body, so bare `HTTP 400` could not distinguish a
   dropped table from a slow card — opposite problems, opposite fixes. The body
   (160 chars) is now in `entry.error`, and it is what `classifyProbeFailure()`
   reads.
4. **Slow never alerts** — see above. This is the guard doing most of the work,
   since most of what was firing was cards sitting near their timeout.

Worth knowing separately: **several cards genuinely run near or past 60s, and
how near is wildly variable.** Shared `roster`, same card and same 7-day window,
measured four times on 2026-08-22: **7.7s → 32.9s → 46.3s → 59.8s** (the 59.8s
run was undated — see the probe bug above). Shared `programs` came in at 52s
once and **timed out past 90s** on a quiet retry. `qbr-stats`, `apex/fasttrack`
and `apex/ice-calendar` all exceed 70s (the latter two are in `NO_DATE_REPORTS`,
so no window narrows them).

**Caveat on any timing taken from this sandbox:** a local `node server.js` boot
prewarms ~28 orgs and generates annual-report snapshots against the *production*
Metabase, so measurements taken while one is running are inflated by your own
load. Kill local servers before timing anything.

That spread is the argument for the slow/broken split: the same card, unchanged,
can answer in 8s or not at all depending on ambient load, so a single timeout is
not evidence of anything. It is a real performance problem, deliberately NOT
alerted on — see the `materialized` index section. Amber on the admin panel and
nowhere else.

## Per-org card entries a shared card shadows (know this before trusting ORGS)

`ORGS[slug][report].mbUuid` is NOT necessarily the card the app queries. A
`SHARED_UUIDS[report]` card wins for every report **except `gl`**, where a
per-org card takes precedence. 28 per-org entries are currently shadowed this
way — dead config the report routes never read, and at least two of them
(clarksville and smyrna `roster`, cards 15712 and 15709) still JOIN the dropped
`class` table and fail outright.

**Always ask `resolveReportCard(slug, rt)`** rather than reading `mbUuid`
directly. The daily health check did not, which is how it reported
clarksville/roster, smyrna/roster and norman/products as down on 2026-08-22
while all three loaded fine — it was grading reports against legacy cards.
Fixed in PR #134; `scripts/card-drift.spec.js` fails if that regresses.

The shadowed list is on `/api/admin/param-drift`. Consequence worth remembering:
removing a report from `SHARED_UUIDS` will silently start serving whatever stale
per-org card was hiding underneath it.

## Facility report undercounts revenue — invoice_v2 gap (OPEN, spec'd 2026-08-06)

The facility report (`FACILITIES_SUMMARY` card + `public/facilities.html`) only
counts `order_item`s joined by `reservation_id`. Every **manual invoice line
item** — tournament flat fees, event-space rentals, deposits, janitorial/
security/timing fees billed through **invoice_v2** — has no `reservation_id`, so
the report silently drops it. Verified against prod (db 4): **$2.57M missed
across 74 orgs** ($1.61M paid, **$964K unpaid A/R**). Some orgs show a *minority*
of true facility revenue (Chico 84% missed, Jurupa 80%). Apex misses $91K
(NJST rental $66K, tournament flat fees, service fees).

- **Correct charge field is `applied_pricing->'result'->>'finalCents'`**, NOT
  `order_item.price` (rate-card; comped-to-$0 bookings keep a price → a fictitious
  ~$95K Apex "unpaid balance" that does not exist). Collected/refunded come from
  `order_item_transaction` gated on `confirmed_at IS NOT NULL`.
- **Second bug in the same card**: `DISTINCT ON (fr.id)` collapses each booking to
  its earliest reservation — drops recurring-date revenue and mis-attributes
  court/location/date. So per-site/per-location filtering isn't robust for
  recurring/multi-court managed rentals (fine for Apex single-court instant).
- **The fix (BUILT, shipped in PR #76, then ROLLED BACK in #77 — perf):**
  rebuilt the card to (1) per-reservation grain, (2) union in invoice_v2 manual
  items (`finalCents>0`, no reservation) attributed to the rental's location,
  (3) show **billed vs collected** side by side. Goal per Dan: an *authoritative*
  facility-revenue view — instant + managed + invoiced/paid + invoiced/unpaid —
  sliceable by site type, location, date range (Brad@Marquardt-Miles pickleball
  vs Tim@Apex Tennis Center).
- **Current state (corrected 2026-08-23): v2 IS LIVE.** `FACILITIES_SUMMARY_UUID`
  in server.js is `4c070d95-ab02-4b9d-ac43-ac86257162d5` = card **19570** =
  `sql/facilities-summary-v2.sql`, with the cold-time optimizations in the header
  of that file (Watertown full-year 54s → 6s). This note used to say the UUID
  pointed back at the original `4defd1b6…` and v2 was dormant; that was stale and
  it cost real time — a handoff diagnosed the Summary against the wrong card, and
  I repeated it. **Read line 1348 of server.js before reasoning about which card
  the Summary uses.** The old card is kept for rollback only.
- **Why rolled back:** the v2 card is ~24s warm vs the old card's ~18s — not the
  real problem. The 502 "upstream error" came from the post-deploy **cold-cache +
  prewarm storm**: prewarm fires the heavy query for all ~74 orgs at once, and
  cold that query is far slower (60s+), so Metabase queued and edge requests
  timed out. **Before re-shipping: optimize the v2 SQL cold time** — the `oit`
  CTE aggregates the org's *entire* order_item_transaction ledger (not windowed)
  and there are several full-org order_item scans; scope those to the feed's item
  set. Then re-point the UUID and re-warm off-peak / stagger prewarm.
- Full write-up artifact:
  https://claude.ai/code/artifact/b7b77323-5b23-463a-8f04-480f528effbe

## Summary KPIs vs the Camping tab — a fee line is not a booking (2026-08-23)

Dan: "the filters on our facility summary are incorrect." Summary read
**254 bookings / 46 sites / $2,960**; the Camping tab read **198 / 41 / $2,520**
off the *same feed*. Decomposed against prod (db 4, Douglas County, campsite +
Topaz Lake, Aug 2026) — every number ties exactly:

```
254 bookings = 198 live reservations + 8 canceled + 48 invoice_v2 fee lines
 46 sites    =  41 campsite courts   +  5 distinct FEE NAMES
$2,960       = $2,520 live + $60 canceled-night charges + $380 invoiced
```

**The chips were never the problem.** Location IS applied (`viewRows`), site type
and status are applied in `aggregate()`. The handoff's premise — that the Summary
runs an unfiltered org-wide query — was wrong, and I relayed it before checking.

**Cause 1 — an invoice row is money, not a booking.** Card 19570 unions
invoice_v2 manual lines (Part B) into the reservation feed, shaped like
reservations without being any: `Reservation ID` = an `order_item` id, `Facility`
= **the fee's NAME**, `Status` hard-coded `'Confirmed'`, `Site Type` **inherited**
from a representative court of the rental. So the chips cannot exclude them: a
tournament fee passes a Campsite filter. Anything counting feed ROWS counts fees
as bookings; anything counting `Facility` strings counts fee names as sites (the
5 phantom "campsites", which is why 46 exceeded even the 43 courts that exist
across both Topaz locations). Fixed client-side: counts and site sets come from
`resRows` (non-invoice) only, amounts still come from every row.

**Cause 2 — `Status` came from `fr.status`, so a canceled night looked live.** A
reservation can be canceled on its own while the RENTAL stays Confirmed or
In-progress (one night dropped from a recurring stay). 8 such reservations in
window; **6 were labelled Confirmed/In-Progress** and $60 of canceled charges sat
in Charged. Fixed in the SQL: `CASE WHEN r.canceled_at IS NOT NULL THEN
'Canceled' ELSE INITCAP(fr.status) END`. The client already zeroes a row whose
Status says Canceled, so the $60 leaves on its own — no client change needed.
**SHIPPED AND VERIFIED LIVE — card 19570 is on v2.2 (checked 2026-08-28).** This
line used to read *"Requires a card update to take effect"* and was stale, which
is the FACILITIES_SUMMARY_UUID trap in this same section a second time: a note
that says work is outstanding costs exactly as much as one that says it is done.
The live card was read before anything was written to it, and its executable SQL
is identical to `sql/facilities-summary-v2.sql` — only comment wording differs —
so there is nothing to push. All three template tags are correctly typed
(`org_id:string/=`, `start_date:date/single`, `end_date:date/single`), i.e. the
re-flip happened too.

Measured through the public endpoint (cache-independent), douglas-county-nv,
campsites, Aug 2026:

| | |
|---|---|
| reservations | 218 — **210 live, 8 Canceled** |
| every canceled row's `Total` | **0**, so its **$120** of Billed stays out of Charged |
| distinct `Site ID` | **41** |
| distinct `Facility` NAME | **46** — the 5 phantom "campsites" that are fee names |
| `Site ID` on all 63 invoice rows | NULL |

(Row counts run ahead of the 206/198 recorded on 2026-08-23 simply because the
month has since filled in; the 41-vs-46 gap and the canceled handling are the
invariants, and both hold.)

**Also added to the SQL: a `Site ID` column** (`ct.id`, NULL on invoice rows), so
counting sites is counting identities rather than display names. `siteKey()`
prefers it and falls back to `Facility|Location` for the legacy card.

Guarded by `scripts/facility-summary.spec.js` (11 assertions, in CI) — verified to
fail on the pre-fix page. Correct answer after both fixes: **198 bookings
(206 incl. canceled) / 41 sites / $2,900 Charged**, of which $380 is invoiced and
labelled as such. `$2,900 ≠ $2,520` is not a bug — the Camping tab is explicitly
"base rental, excl. add-ons" while Charged includes the invoiced money v2 exists
to surface.

Already shipped (PR #75, live on `main`): name-based site-type recovery so
"court" excludes rinks/pools/gyms, specific-type revenue breakdown, Location
filter, Ice sub-tab, court-name wrap. Display/scoping only — did not change the
revenue math, so the gap above predates and survives it.

## Per-org report settings (2026-08-27) — and the cache-key bug found under them

Dan: *"we could also add some type of report settings, where you could customize
some report defaults that applied per org. Select columns, etc."* Then, settling
the design questions: *"since it's single tenant, anyone can edit the settings.
we'll figure out a multi tenant thing later. Per org. One report for now, we'll
do the class roster."* And the scope: *"allowing saved views, exporting or
printing pdf's, email subscriptions, default date range for date filters (with a
warning that anything over 30 days can be bad)."*

A ⚙ at the far right of the Class Roster toolbar opens a sheet grouped by
**blast radius** rather than by category, because "default columns" and "cache
lifetime" are not the same kind of decision. Mockup:
https://claude.ai/code/artifact/386455f8-d3d0-44ea-a377-c9dd170f7082

### THE BUG UNDERNEATH: pre-warm was writing keys nothing could read

Found while checking whether a per-org cache TTL was contained. The data route
built its key one way and pre-warm built it another:

```
route  :  `${orgSlug}:${reportType}:v${FEED_VERSION[reportType] || 1}:${paramStr}`
prewarm:  `${slug}:${rt}:${paramStr}`                       ← no version segment
```

Those cannot produce the same string, so **every param'd entry pre-warm wrote
was unreachable from the page that needed it.** The version segment was added to
the route's key to bust the cache when a card gains a column (court-utilization
v2) and pre-warm was never updated. The base key is unreachable too, for a
different and *correct* reason: `getCachedEntry`'s fallback fires only when
`key === baseKey`, and the route's key always carries `v1:` — that fallback was
deliberately narrowed by an earlier fix ("silently serving default-range data
regardless of requested dates"), which is right and should stay.

**Proven by construction, not by measurement.** A live timing test looked
tempting and is worthless here: pre-warm runs at 4:50am and the roster's TTL is
2h, so by any reasonable hour a warm entry is expired anyway and slowness
discriminates nothing. Both key builders now go through one `feedCacheKey()`,
and `report-settings.spec.js` fails if either caller hand-builds a key again or
if the versioned format appears twice.

**Consequence to expect:** first opens that used to be cold can now hit warm
data. That is the point, and the TTL still governs how stale it may be.

### What a setting is, and what it is not

- **PER ORG, proven against a second org rather than inferred from the store's
  shape.** `report-settings.spec.js` changes every field for org A and then
  requires org B to read the platform defaults field by field, in the API *and*
  in the injected `ORG_CONFIG` that decides its first render. An org nobody has
  configured has **no record at all**, which is also why reset DROPS the record
  instead of writing the defaults into it — a later change to a platform default
  still has to reach every org that never customised. The one thing deliberately
  not contained is the shared-card total: org A shortening its cache moves the
  figure org B is priced against, which is the entire reason the budget exists,
  and org B's panel names org A as the one running short.
- **A setting SEEDS; it never overrides.** Precedence is
  `platform default → the org's setting → this person's own choice`. Column
  toggles still live in each reader's `localStorage` and still win. An org
  default that reached in and reset those would produce "my settings keep
  resetting" as the first ticket — the same line that kept columns out of saved
  views.
- **Not a saved view.** A view is a named filter set anyone can make, many per
  report. This is one starting point per org.
- **SUPER-ADMIN ONLY, behind a flag** (Dan, after seeing the panel: *"this power
  is too much for an org user to handle"*). Two gates, and both are deliberate:
  the `reportSettings` feature flag, default **OFF**; and a key that is **not**
  the org token — every staffer at an org has that, and these settings change
  what all of them see plus what the shared card costs. The key is
  `sha256(DASHBOARD_PASSWORD + "|report-settings|v1")` truncated, so it can sit
  in a URL without handing over the admin dashboard, and rotating the password
  rotates it. Look it up at `/api/admin/report-settings-key?password=…`.
  The flag has its own switch in the admin dashboard's Feature Flags block —
  **that block is written by hand per toggle, so a new flag does NOT appear on
  its own**, and one that `applyFlags()` never drives renders permanently off.
  **It FAILS CLOSED**: no `DASHBOARD_PASSWORD` means no key means nobody, which
  is the opposite of `dashboardAuth`'s "no password → open access" for the root
  page — right for a root page in dev, wrong for a control that spends a shared
  resource. Both routes answer **404, not 403**, so a staffer with a valid token
  never learns the surface exists, and the gear is absent from the DOM rather
  than disabled.
- Registry-driven like `SAVED_VIEW_PARAMS`: `REPORT_SETTINGS_SCHEMA` registers
  `roster` alone and every other report 404s.

### The credential had no way to travel — sign in, navigate, nothing there

Dan, on the preview: *"the settings should show if I login as a super admin, then
navigate to the org page and reports, no? Not seeing it on the PR."* Right, and
the first build had no answer for it. **Basic auth is scoped to `/` by the
browser**, so signing into the admin dashboard left nothing behind, and the only
way into the panel was pasting `&admin=<key>` onto every report URL by hand.

A successful password match in `dashboardAuth` now sets **one cookie**, and the
details are the design:

- **It carries the DERIVED KEY, never the password.** If it leaks it opens the
  settings panel and nothing else, and rotating `DASHBOARD_PASSWORD` rotates it.
  No password ⇒ no key ⇒ no cookie, the same fail-closed direction as the key.
- **A cookie is the better credential here, not merely the more convenient one.**
  A URL key leaks through history, referrers and copy-paste — the same reasoning
  that keeps the org token off the campmap card link.
- `HttpOnly` (no page ever reads it — the server injects `settingsAdmin` into
  `ORG_CONFIG`), **`SameSite=Lax`** (rides a click through from the dashboard,
  **not** sent on a cross-site PUT, which is the CSRF defence), `Secure` only
  over https or the cookie is dropped on `http://localhost` and the gear silently
  never appears in dev, 12h.
- The query parameter and `x-admin-key` still work — a link someone was handed
  must not stop working, and the specs drive the routes without a browser. All
  three go through one `reportSettingsKeyMatches()` constant-time compare.
- **The app has no cookie middleware and one name does not justify adding one**,
  so `readCookie()` parses the single header by hand.

**And a proven super-admin with the flag OFF is a different state from an org
staffer.** Rendering both as "no gear" is exactly what made this look broken.
`reportSettingsFlagOff(req)` is `!flag && keyOk` — **gated on the KEY**, so it can
never appear for a token holder, which would advertise the surface the 404s exist
to hide. In that state the page renders a **disabled** gear naming the switch and
where it lives. Absent-not-greyed stays the rule for someone who may never hold
the control; for someone holding the key it is a dead end with no exit. Same
lesson as the Fast Track pin: *a control nobody can find is a control that does
not exist, and the bug report for it arrives as a feature request.*

Worth knowing when a preview looks dead: **each PR preview is a fresh volume, so
`feature-flags.json` starts empty and `reportSettings` defaults OFF there** — the
flag has to be switched on in that environment before anything appears.

### A DELIBERATE 404 looked exactly like a dead link (2026-08-28)

Dan clicked into settings and got a Slack alert: *"DEAD LINK — someone opened
`/apex/roster/api/settings` with a valid-looking token and got a 404 (no such
report)"*. The route was working perfectly; **that 404 IS the refusal.**

`noteDeadLink()` watches for stale internal links and its whole discriminator is
*"a 404 that arrived with a valid-looking token"* — which is byte-identical to
the shape of every deliberate refusal on this surface. So each refused request
posted an alert, and the alert **named in Slack exactly the path the 404 exists
to keep quiet**. It also misclassified: `apex` and `roster` both exist, so it
reported `unknown-report` about a report that is very much real.

`refuse404(res, body)` sets `res.locals.deliberate404` and both settings routes
go through it; the watch skips a marked response. **A refusal is not a dead
link: the path is real and the caller was told no.** Worth copying to any other
route that 404s on purpose behind a token — `saved-views`, the lessons and munis
gates and the per-report "not configured" 404s all have the same shape and were
left alone here rather than widened into this change.

### Opening the panel is its own signal

Dan: *"make sure we're tagging when the settings option is clicked into for any
org in slack, that way I can see and track it."* `settings-open` (🔍) fires from
`openSettings()`, alongside the existing `settings-save` / `settings-reset`.

- **A LOOK is the earlier signal than a change** — most opens will not end in a
  save, and those are the ones that say the surface is being used.
- It carries `custom`, whether this org has already moved off the platform
  defaults, because browsing and revisiting are different things.
  **`rsCustomised()` compares field by field, not "is there a stored record"** —
  a record holding nothing but defaults is not a customised org.
- Default debounce (`org|report|event`, 60s): opening and closing the panel
  twice while editing is one look.
- The value is clamped to `"1"`/`"0"` server-side like every other extra on that
  route, never echoed from the query string.

### The three groups

| group | blast radius | settings |
|---|---|---|
| What it opens on | display only | window, status, run-on-open, default columns, which controls exist |
| How fresh | costs Metabase time on a **shared card** | cache lifetime, "Data as of" stamp, pre-warm the default window |
| The ePACT export | changes a file a HIPAA vendor imports | columns and their order, group label, BOM |

- **The cache dial prices itself, and the platform figure is a SUM.** The first
  version multiplied this org's rate by the org count — "348 card queries/day ·
  29 orgs" — which is simply false: each org's lifetime is its own. Dan spotted
  what it implied (*"can't have one org going rogue and borking it for
  everyone"*). The panel now shows this org's rate plus what every OTHER org has
  actually chosen, against a budget.
- **A per-org floor does not answer that objection, so there is also a
  platform-wide budget.** The floor bounds one org; the CARD is shared, and the
  failure mode is contention on one Metabase queue — this repo has already had
  it, in the post-deploy prewarm storm that 502'd the facility Summary.
  `sharedCardLoad(rt)` sums every visible org's configured rate;
  `REPORT_BUDGET_MULTIPLE` (2) sets the cap as a multiple of what all-defaults
  would cost, **written as a multiple so it cannot go stale as orgs are
  onboarded**. A save that would exceed it is refused, and the refusal **names
  the orgs already running short** — the one dragging the slider is not
  necessarily the one that filled it. It only refuses a change that makes things
  *worse*, so an org already over budget can still lengthen back toward the
  default. Shared cards only: an org on its own card spends nobody else's time.
- The floor of **30 minutes** clamps rather than refuses — a dial that snaps
  teaches the limit where an error just loses the edit.
- **`warmDefaultWindow` is OFF by default.** It adds one Metabase query per org
  per day; a load increase should be switched on and measured, not slipped in.
  When on, pre-warm fetches the window the page will actually ask for, built
  with the real `buildMetabaseParams` so the key is the route's and not an
  approximation of it.
- **Over 30 days the window warns rather than being refused** — a month at Apex
  was ~382 pages and 12,130 rows before the reader had chosen anything, but an
  org running year-round programmes may genuinely want a quarter.
- **`ROSTER_DEFAULT_DAYS` stays a constant.** The server's `next14` relative
  range is pinned to it, so a saved view named "Next 14 days" and the report's
  own default cannot drift. An org's window arrives as an argument to
  `getDefaultRange(today, days)` instead of editing that constant.

### Email subscriptions are deliberately NOT offered here

The roster is not in `EMAIL_SUBSCRIBABLE_REPORTS` (only `facility` and `gl`
are), so it has no subscribe control to remove — and a switch over a control
that does not exist is the same dead end as a greyed button. The spec asserts
its absence *and* asserts why, so the day the roster becomes subscribable the
toggle is one line. Every other item on Dan's list is there: saved views, PDF,
print, Excel, ePACT, the form-questions picker.

**Two invariants the spec enforces about that list**: every removable key has a
label (or the panel renders a raw key), and every removable key is actually read
by something on the page (or it is a switch that controls nothing, which looks
like a working control and is not one).

### The ePACT catalogue excludes SESSION-grain fields, on purpose

The export reproduces her `SELECT DISTINCT` over **whatever columns are
chosen**, so adding a session-grain field (Session Start / Session End) would
stop the dedupe collapsing two same-day sessions and upload the same camper
twice. `EPACT_FIELD_CATALOGUE` therefore offers participant- and section-grain
fields only. Deviating from the verified five is allowed and **never silent**:
the panel flips from green to a warning naming the risk, and the same-five-in-a-
different-order case counts as drift because ePACT maps on position.

Also: the sort had to stop being positional. It was `t[4] || t[2] || t[1]`
(label, last, first); with a configurable column set index 4 need not be the
label, so it now looks the columns up **by name**.

### Guards

`scripts/report-settings.spec.js` (**171 assertions, in CI**) lifts and RUNS the
registry and its validator, and has a live half that boots the server, saves,
clamps, resets and reads the settings back **out of the page's injected
`ORG_CONFIG`** — they decide the first render, so a page that fetched them would
flash the platform defaults first. `SKIP_SOURCE=1` drops the source assertions so
the live half can be shown to catch a regression on its own — a regex over our own
patch is not evidence the server behaves, and all five cookie/flag-notice
mutations below were verified against the live half alone.

Mutation-tested twenty-eight ways, all failing by
name: one org's settings leaking to another, a refusal announced as a DEAD LINK
(the alert Dan saw), `settings-open`
missing from the log route's `ALLOWED` list, the `custom` flag dropped on the way
through, sign-in leaving no cookie (the bug exactly as Dan hit it), the cookie
carrying the password instead of the derived key, `SameSite` dropped, the admin
gate ignoring the cookie, the flag-off notice not gated on the key (so it would
advertise the surface to a staffer),
the flag's switch never driven by `applyFlags`, the feature flag defaulting ON, no-password falling open instead of
closed, the admin gate removed from either route, the budget check dropped, the
panel multiplying by the org count again, the gear rendering for everyone,
pre-warm hand-building its key again, the TTL floor removed,
`warmDefaultWindow` defaulting on, an unknown key silently accepted, a
session-grain field offered, the server's column defaults drifting from the
page's, an org default overriding a reader's columns, `settings-save` dropped
from `SLACK_NOTIFY`, a removable control nothing reads, a removable control with
no label, an email toggle on a report with no subscribe button, and the
wide-window warning removed.

`roster-epact.spec.js` 73 → **94**: the export now runs through a configured org
as well as an unconfigured one, and the assertions that matter are that the
DEFAULT is still the verified five and that an unknown column set falls back
rather than exporting empty columns.

`ci-check-render.js` now boots the server **with** a `DASHBOARD_PASSWORD` and
pre-writes `feature-flags.json` with `reportSettings: true`, or the panel cases
would be testing the closed door instead of the panel. One case deliberately
drops the key and asserts the gear is **ABSENT from the DOM** — "renders a greyed
button" and "renders nothing" are different claims, and only one of them keeps
the power away from an org user.

**`ci-check-render.js` gained a per-case `pre(page)` hook** for the two cookie
cases: a cookie set in `act` is set too late, because the page it decides has
already been served. `roster · signed in, then navigated` carries **no `?admin=`**
— the cookie is the whole test — and `roster · flag off says where the switch is`
flips the flag **from Node, not from the page**, since every `/api/` request the
browser makes is answered from `STUBS` and an in-page fetch would never reach the
server; it runs last of the settings cases and restores the flag in a `finally`,
because the flag is server state every earlier case depends on.

Seven `ci-check-render.js` cases, four of them seen to fail on a real
regression in a browser: the gear is **last** in the toolbar (moving it fails),
the panel opens with all three groups, the drift banner flips when a column is
added (pinning it green fails), and the cache dial's platform total **goes up**
when the lifetime goes down.

**A render-check note worth keeping:** the dial case drives the range input with
the **keyboard**, not by assigning `.value`. React tracks a controlled input's
value internally, so a direct assignment plus a synthetic `input` event is
ignored — the case would have failed on a perfectly good dial.

## Saved views on the Class Roster (2026-08-27)

Dan: *"can we add the ability to save filtered views into this as well. That
functionality is in the GL code report right now."*

The server side was already generic — one registry entry per report — so most of
this was the client, plus two things that were wrong in the GL implementation and
would have been copied straight across.

### A roster view carries the FILTERS and not the columns

`SAVED_VIEW_PARAMS.roster` is `["section_name", "status"]`. The column toggles
and the form-question picker are deliberately out:

- they are **display state**, and they already persist per browser in
  `localStorage`, and
- a view is **shared with everyone who has the report's link**, so one that
  carried columns would take a colleague's chosen columns away the moment they
  opened someone else's filter.

The save dialog says so on screen ("Columns and form questions aren't saved —
those stay per person"). Same line the GL report draws by excluding its display
toggles from the "edited" marker.

### THE DATE MIRROR IS NOW ONE FILE, NOT ONE PER PAGE

A saved view stores a date **intent** (`lastMonth`, `next14`), and something has
to turn that back into a range: the server does in `getDateRange()` because an
email subscription resolves the same vocabulary at 7am, and the page does on
open. That makes the client resolver a hand-written mirror, and a divergence is
silent — a view named "Last month" would open on one window on screen and report
a different one in the emailed PDF.

One mirror is a risk worth pinning. **Two — one per report page — is the same
risk multiplied, and it drifts the first time a token is added to one of them.**
So `public/saved-views.js` now holds `resolveSavedRange`, `RANGE_LABELS`,
`fmtShortDate` and `viewDateLabel`; both pages carry thin wrappers, and
`saved-views.spec.js` checks the shared resolver against the real
`getDateRange()` for **every token in `RANGE_LABELS`** and fails if either page
grows the arithmetic back.

The wrappers are `function` declarations that read `RecSavedViews` at CALL time.
A deferred script has loaded by the time Babel runs a `text/babel` block, but
reading it at module scope would make that an assumption instead of a fact.

### The offered ranges come from the SERVER — because gl.html got this wrong

**A bug found on the way, not introduced by this change.** `gl.html` hardcoded
its own dropdown, and that list included **Today** — which
`REPORT_BLOCKED_RANGES.gl` has always rejected. So saving a GL view with
`Today` failed with a message about 7am email sends, for a view opened at 3pm.
Measured against the real `normalizeViewInput`: `today → REJECTED`, every other
offered token `ok`.

Two registries now, both server-side, and the offered one is **injected into
`ORG_CONFIG` as `savedViewRanges`** (the `WIZARD_SOURCE_GRAIN` pattern):

| | what it is for |
|---|---|
| `SAVED_VIEW_RELATIVE_ACCEPT[report]` | what a stored view may hold. `last7` stays accepted for `gl` though it is not offered — views saved before it was dropped still hold it, and it resolves identically to `prior7`. |
| `SAVED_VIEW_RELATIVE_OFFER[report]` | `[token, label]` pairs, in the order the dialog shows them. **The first is the dialog's default**, read via `defaultSavedRange()` rather than named inline — a hardcoded default can fall outside the list the moment the list changes, which is how Today survived. |

`saved-views.spec.js` asserts, per report, that every OFFERED token is in ACCEPT,
is not in `REPORT_BLOCKED_RANGES`, and has a shared label. That check is what
turns this class of bug into a test failure instead of a support ticket.

### A roster reads FORWARD, and `next14` is the report's own default

GL only looks backwards; a roster answers "who is coming". So the roster's
offered list leads with **Next 14 days** — the fortnight the report itself opens
on — then Next 7, Next 30, Today, and the backward ranges after, because a past
camp's roster is a real question just not the common one.

**`next14` is new in `getDateRange()` and is pinned to `ROSTER_DEFAULT_DAYS`.**
The spec computes the span of `getDateRange("next14")` and requires it to equal
the constant in `public/roster.html`: two numbers for one window would drift, and
a view named "Next 14 days" that opens on a different fortnight than the report's
default is the worst kind of wrong — plausible.

### Applying a view on the roster hits the NETWORK. On GL it never does

The roster's `section_name` is passed to **card 17296**, not merely applied on
screen, so `applyView()` has to re-run the query when the section or the range
moves. Every GL filter is client-side over rows already loaded, so applying a
view there never touches the network. Copying GL's `applyView` verbatim would
have set the section on screen and left the feed showing the old one.

- **`clearView()` deliberately does NOT reset the dates.** Clearing a filter is
  not a request to jump back to the default fortnight.
- The save dialog and the Undo toast are rendered from inside `renderToolbar()`,
  so all three of the page's return paths get them from one place — the picker is
  on screen while rows are still loading, and Save clicked then must still open a
  dialog.
- The PDF, print, Excel and ePACT paths needed **no change at all**: applying a
  view sets the same state a person could set by hand, and `downloadPdf` already
  sends `section_name` and `status` explicitly. That is the whole design.

### Two things the render check caught that source review would not

- **`localStorage` survives between cases in `ci-check-render.js`.** The apply
  case stores its view as "last used", so the next case's page auto-applied it
  and the save dialog opened in *update* mode with that view's own range
  pre-selected — which is correct behaviour and broke an assertion that
  pre-selection was always the default. The case now asserts the option **list**
  (provenance and order), which is the actual invariant; the default is checked
  by running `defaultSavedRange()` in the spec. Worth knowing before adding
  another case: they are not independent.
- **A click on a disabled button is a silent no-op.** `page.type` resolves before
  React commits the state that enables Save, so the case passed in isolation and
  failed inside a full run. It now waits for `!b.disabled`. A guard that behaves
  differently depending on what ran before it is not a guard.

### Guards

`scripts/saved-views.spec.js` 39 → **51 assertions**, in CI. Mutation-tested ten
ways, all failing by name: GL offering Today again, `next14` spanning a different
number of days than the server says, `ROSTER_DEFAULT_DAYS` moving away from
`next14`, either page reimplementing the resolver, the shared resolver drifting
from `getDateRange` on `next7`, `cols` smuggled into the roster allowlist, the
page's clear-on-apply list drifting from the server's, the roster leading with a
backward range, the dialog hardcoding its own list (browser), and `status=all`
being stored so an unfiltered view reads as filtered.

Three new `ci-check-render.js` cases — the picker lists what the feed returned,
applying a view puts its filters on screen **and re-runs the query**, and the
dialog offers exactly the injected list. The apply case's fixture view uses
`next7`, not `next14`, on purpose: `next14` is the report's own default, so a
view carrying it changes no dates and a **missing re-fetch would be invisible**.
That was caught by mutation — the first fixture used `next14` and the
dropped-re-fetch mutation survived.

## Export to ePACT on the Class Roster (2026-08-27)

Dan: orgs export participant lists to upload into **ePACT**, an outside HIPAA
vendor holding camp health forms. Melinda at Apex has been doing it by hand from
a Metabase SQL — a date range, a partial section name, five columns, CSV — and
*"if we could duplicate that functionality into our reporting system, that's a
big unlock. I'd prefer it be the class roster, that's the easiest report and
lift."* Emergency contacts and form questions are explicitly out of scope.

Two buttons, **one builder**: `📤 ePACT` in the toolbar over the whole filtered
view (the Export Permits shape), and a `📤 ePACT` on each section's header row
for the single-class case. Both call `epactRows()` → `epactCsv()`.

### THE MAPPING WAS THE WORK, and two of the five columns are traps

Verified against card **17296** (`✅Class Roster`) and against her SQL on prod
(apex, 2026-08-27) — measured, not read off column names.

| her column | roster field | note |
|---|---|---|
| `Rec ID` | `Rec ID` | the 6-char code staff read out, not a uuid |
| `First Name` / `Last Name` | same | |
| **`Household Owner Email`** | **`Email`** | **NOT `Owner Email`** — see below |
| **`Session Date - Section Name`** | `Session Date` + `Section` | `YYYY-MM-DD`, not the card's `MM/DD/YYYY` |

- **`Household Owner Email` is the roster's `Email` column.** Both her query and
  the card compute `COALESCE(NULLIF(participant.email,''), owner.email)`; the
  roster's own `Owner Email` is `owner.email` **alone**. Her LABEL says Owner and
  her SQL does not, so the mapping that reads right is the wrong one — **and it
  is wrong silently**: most child participants have no email of their own, so the
  two columns agree on the majority of rows and diverge only for the teenagers
  who do. That is a wrong parent address in a camp health vendor for exactly the
  families whose kid is old enough to have their own inbox.
- **`SELECT DISTINCT` is load-bearing and is reproduced.** The roster feed is
  participant × SESSION grain; her label is participant × section × DATE. At apex
  DISTINCT collapses **82,244 rows to 82,127** — the same camper in the same
  section on the same day, from two sessions that day. Without it those campers
  are uploaded twice.
- **Her `JOIN order_item` is a NO-OP.** All 82,244 qualifying apex bookings have
  a live `order_item`, so it removes nothing. Checked rather than assumed,
  because it is an INNER join and would have been a silent row filter.

### Her cancellation filter is already the roster's `Status`, exactly

Dan asked *"does the original sql exclude cancelled?"* — it does
(`b.canceled_at IS NULL AND b.status = 'confirmed'`), and the export therefore
always drops them, **ignoring the on-screen status pill**. The equivalence is not
an assumption:

- card 17296 derives `Status` purely from `canceled_at`
  (`CASE WHEN b.canceled_at IS NOT NULL THEN 'Cancelled' ELSE 'Enrolled' END`), and
- the card is already restricted to `b.status IN ('confirmed','cancelled')`, so
  `planned` (7,103 not-cancelled at apex) and `pending` never reach the page, and
- measured at apex: **0** bookings are `status='cancelled'` with a null
  `canceled_at`. So roster `Enrolled` **IS** her confirmed-and-not-cancelled set
  and the two cannot diverge. 16,831 are confirmed-then-cancelled; both sides
  drop them.

`section.is_rec_managed IS FALSE` is likewise already in the card (uniformly
false at apex across 933 sections). The filter lives inside `epactRows()`, not at
the call sites, so **no caller can opt out of it.**

### A dateless row exports with an EMPTY label, and that is deliberate

`TO_CHAR(NULL)` makes her whole concatenation NULL, so a section with no session
to date it from has no group label in her output either. The tempting repair —
printing the bare section name, or defaulting to today — puts an **invented camp
date beside a real child's name in a vendor's system**. Same rule as the wizard's
prose/number split. The row is still exported; only the label is empty.

### Other decisions worth keeping

- **The date conversion is string surgery, never `new Date()`.** The card emits
  `MM/DD/YYYY` and `new Date(s).toISOString()` reads that as LOCAL midnight,
  which is the previous day in UTC anywhere east of UTC. The fasttrack date bug,
  one report over.
- **The CSV is CRLF and properly quoted.** A section name with a comma
  (`"Camp, Red"`) shifts every column after it otherwise, and some Windows
  importers refuse a bare LF.
- **No button where there is nobody to upload.** The section button is absent
  (not disabled, not zeroed) when a section has only cancellations, and the
  toolbar button is disabled rather than writing a header-only file — a control
  that yields an empty CSV is a dead end.
- **`saveTextViaPopup()` is new in `public/open-pdf.js`** and reuses that file's
  ONE popup implementation via `deliver(build, opts)`. The sandbox-escape trick
  is subtle enough that a second copy would drift the first time a browser
  changed its mind about downloads. Its clipboard fallback converts the CSV to
  TSV (`csvToTsv`, a minimal RFC4180 reader), because a comma-separated paste
  lands the whole row in one cell.
- Activity: **`epact` (📤)**, debounced by `scope|section` — an admin exporting
  four camps in a row is four camps, and the whole-view export cannot be
  swallowed by a per-class one. The count travels with it: 400 campers is a
  different signal from testing the button on a class of six. Scope is
  **normalised server-side**, not trusted from the query string.

### Backcheck against the card: 68/68 rows, and a three-byte difference

Dan exported one section both ways — apex, **After School Care - Hackberry Hill
Elementary School 2026-2027**, over the report's new 14-day default (2026-08-27 →
2026-09-09) — and the two files were diffed byte-for-byte, not eyeballed.

**All 68 data rows identical, in the same order, zero rows on either side alone.**
15 distinct participants over 7 session dates; 15 distinct name+email tuples, so
no participant was merged or duplicated. The section is a good discriminator by
luck: it contains **two different children both called Bridger Wall** (`GLJ096` /
`07XS1Z`, different household emails, one with a trailing space in the first
name), all preserved — a dedupe keyed on the name rather than the whole tuple
would have collapsed them.

The ONE difference was a **UTF-8 BOM**: Metabase writes `EF BB BF` on every CSV
it serves (`csv-include-bom?: true` in its query responses) and the page did not.
Now fixed — `saveTextViaPopup` takes `opts.bom` and the ePACT export asks for it.
Proven: our file + BOM, CRLF→LF, is byte-identical to Metabase's 8,305 bytes.

- **It matters beyond matching.** Excel sniffs bytes rather than trusting UTF-8,
  so without a BOM an accented participant name opens as mojibake. This file
  happens to be all-ASCII, which is why it looked like cosmetics.
- **It cannot break ePACT**, because ePACT already ingests Metabase's BOM'd files
  today — the strongest available evidence for adding one.
- **The BOM goes on the FILE BYTES ONLY, never the clipboard copy.** Pasted into
  a sheet it shows up as a stray character in the first cell. So `epactCsv` stays
  pure text and the BOM is a delivery concern; the spec fails if it moves into the
  builder (which would carry it into the clipboard) or onto the TSV.
- **The remaining delta is line endings** — ours CRLF, Metabase LF — and that is
  deliberate: CRLF is RFC4180 and what Windows importers want, and Metabase's LF
  demonstrates either works.
- **Check a BOM on the BYTES, not on a decoded string.** `TextDecoder` strips it
  by default (`ignoreBOM: false` means *remove* it), so decoding first makes the
  assertion pass either way. The render case got this wrong first time.

### The default window is now 14 days, not the calendar month

Dan, same session: *"this class roster is huge by default. For apex it's like
382 pages. Can we set the default date range to something tighter, like 14
days?"* and *"the goal should be for an admin to start at a tightly filtered view
so they can see what the options are, then set date ranges and type in partial
section names, click 'run'."*

`getDefaultRange()` replaces `getCurrentMonthRange()`: **today → today + 13**,
inclusive, from a `ROSTER_DEFAULT_DAYS` constant. A `14 Days` button beside
Last/This/Next Mo. returns to it, labelled from the same constant. The report
header's `|| 'Current Month'` fallback is gone — it described a default that no
longer exists.

### Guards

`scripts/roster-epact.spec.js` (**73 assertions, in CI**), which **lifts and
RUNS** the five helpers rather than regexing over them, and has a live half that
boots the server and requires a 200 **plus** a row in `events.jsonl` — the
beacon-that-404s trap has now bitten this repo four times and a source assertion
has never caught it.

**The spec's timezone pin took two attempts, and the first one was decorative.**
It re-execs under `Asia/Tokyo`, not `America/New_York`. Eastern does not
discriminate for this input: `new Date("07/06/2026")` is local midnight, and
local midnight in any US zone is still the same date in UTC — the broken
implementation passed the whole spec under Eastern. A zone EAST of UTC is what
separates them. The zone is chosen for that property, not because an org is in
it.

Mutation-tested seventeen ways, all failing by name: the email read from
`ownerEmail`, the cancellation filter dropped, `SELECT DISTINCT` dropped, the
date via `new Date().toISOString()`, a dateless row given the section name
anyway, the default back to a month, `epact` dropped from `SLACK_NOTIFY`, `epact`
dropped from the log route's `ALLOWED`, the debounce key reverted, the `rows`
clamp removed (**only the live half sees that one**), a second popup
implementation, the toolbar button exporting the unfiltered rows, the per-section
button bypassing the shared builder, the section button rendered with nothing to
export, the BOM not requested, the BOM moved into the builder, and the BOM
applied to the clipboard copy as well.

Plus six `ci-check-render.js` cases — **the Class Roster had no render case at
all before this**, and it is the report an admin runs before every camp. Five of
them are keyed on COUNTS or on absence rather than presence, because "a button
rendered" passes on every one of the regressions above. The sixth,
`roster · epact csv is her output`, **stubs `window.open` — not
`saveTextViaPopup` — clicks the real button and asserts on the bytes the popup is
handed**, so the whole delivery path including the BOM is covered rather than
skipped. It checks the header line, three data rows (Ana's two same-day sessions
collapsed, Cass's cancellation dropped), the participant's own email present and
the owner's absent, the BOM on the file, and no BOM on the tab-separated
clipboard copy. Every source assertion in the spec passes on a button wired to
the wrong row set; that case is what proves the file.

## Add-ons moved into the note line; Forms took the column (2026-08-26)

Dan: *"move 'add ons' out of its own column and into the 'notes' section
underneath each reservation row… Replace the addons column with 'Forms', and add
a clickable link to the Form section for a specific reservation, if it has it."*

The deliberately small version of the parked forms feature (see the PARKED
section below): **a link out to Rec, not a panel.**

- **The add-on money had to come with it.** Card 17294's `Total` is the
  reservation's own `order_item`; `Add-On Fees` is a SEPARATE sum and is not
  folded into it. So the note line now leads with the total —
  `Add-ons $40.50: 🍺 Alcohol Permit ($25.00), 💡 Field Light Fee ($15.50)` —
  because dropping the column without it would quietly remove revenue from the
  page. `addonItemsTotalLabel()` is the single implementation, so the number and
  the `data-addon-total` attribute a render check reads cannot drift.
- **The total is summed from the VISIBLE items**, not read off the row. The
  toolbar filters add-ons; printing the row's whole fee beside a filtered list is
  a number that does not add up to what is shown.
- **Notes and add-ons are gated SEPARATELY.** Add-ons used to ride on the Notes
  checkbox, so turning notes off silently took the add-on money with it. Either
  checkbox alone now produces the line; the add-on toggle keeps the old
  `col_addon_fees` localStorage key, so nobody's saved preference flips.
- **Excel keeps `Add-On Fees` as a column** — an export is a data file, not a
  schedule.
- **The Forms column is a link, and the route only COUNTS.** `countFormRows()`
  reduces card 20626 to `{ resId: n }`; no answer, filename, S3 URL or signature
  ever reaches the browser, which sidesteps every trap in the parked section
  below. A rental with no forms renders nothing — a link to an empty Required
  Information tab is a dead end, and 62% of a typical week has no form.
- Link shape: `https://www.rec.us/admin/o/<orgId>/facility-rentals/<resId>?tab=requiredInformation`
- Activity: `form-open` (📄), debounced by rental.

**A cross-file invariant this pinned:** the card joins add-ons into one string
with `", "` and the client splits on commas, so a price containing a thousands
separator would split mid-number (`"Tournament Fee ($1"` + `"250.00)"`). Card
17294 formats with `FM999999990.00`, which emits none — that is the *only* reason
the split is safe, nothing checked it, and the failure would be silent. The spec
now asserts the mask, and changing it to `FM9G999G990.00` fails by name.

### A feed that has not answered must not look like an empty result

Dan, on the preview: *"where did permits go? we're not showing any permits for
watertown."* The permits feed was healthy — 1,488 permits, and 13 of the 21
rentals that day matched — and the chip renders correctly when handed that data
(verified in a browser against the real feed). The bug was that **`permits` had
three states rendered as two**: not-loaded-yet and load-failed both rendered as
an empty cell, byte-identical to "this rental has no permit". Watertown's feed
takes **~6s cold**, so for six seconds a healthy report looked exactly like one
where permits had vanished — and a transient failure looked that way forever,
because `.catch(() => setPermits({}))` maps a failure to "none".

This is the campmap load-vs-empty bug in a read-only surface, and the fix is the
same shape: `permitsOk` / `formsOk`, true only when the feed actually **answered**
(a soft-failed route answers 200 with `error: true`, which is a failure, not an
org without permits). Pending renders a faint `·`, failure an amber `⚠` whose
title says the column is blank for every row and does not mean there are no
permits. **A genuinely absent permit still renders blank** — that is Dan's rule:
blank when there is none, a clickable and exportable icon when there is one.

Two render cases drive the failure path via a per-case `stubMode`, because the
stubs see the API request URL and a query flag on the page URL cannot reach them.

### The Rec Insights button is gone from the rental schedule (Dan, 2026-08-26)

*"not needed there."* Removed the button, its panel, the feedback widget, the
`buildInsightsBlob` payload builder and the CSS. The server routes
`/:org/facility/api/insights` and `/api/insights/score` are left in place but now
have no caller from this page — remove them separately if that matters.

Guards: `scripts/facility-addons-forms.spec.js` (53 assertions, in CI,
mutation-tested six ways — the total dropped, the total read off the row instead
of the visible items, add-ons back on the Notes checkbox, a link on every row,
the feed forwarding answers instead of counting, and the SQL mask gaining a
separator). Plus five `ci-check-render.js` cases; **the rental schedule had no
render case at all before this.** `ci-check-render.js` also gained a
`SHOT_DIR` env hook and a name filter for iterating one page's cases.

## Facility rental "posting sheet" — BUILT (PRs #118, #120, #121)

The one-pager maintenance prints and hangs **at the facility** so anyone walking
up knows what is booked, with a **scannable QR** to the live permit.

- `lib/permit.js` — pure layout (no Express, no Metabase, no fs). `toHtml(sheets)`
  → one `.sheet` per page; the caller supplies each QR as a data URI.
- Server: `POST /:org/facility/permits.pdf` (client posts the rows it is showing,
  so the export honours on-screen filters) → `renderHtmlPdf(html, {plain:true})`.
  `GET /:org/facility/api/permits` feeds the per-row chip a thin `{code, url}`
  map. Slack event: `permits`.
- UI: `public/facility.html` — a per-row chip (own `showPermit` column toggle,
  default ON — do NOT gate it on `showLink`, which defaults off) and an
  "Export Permits" toolbar button over the filtered view.
- **The QR target is `https://www.rec.us/permits/{permitId}`** — no auth, which
  is what makes it safe taped to a fence. Confirmed by decoding the QR out of
  Rec's own permit PDF. The admin `/admin/o/{orgId}/facility-rentals/{resId}`
  URL is NOT usable here.
- Card **20230** (`sql/facility-permits.sql`, public UUID
  `6771e2fe-1d9c-41c1-a921-7d875115305e`, env `MB_PERMITS_UUID`). Issued permits
  only — a draft or revoked permit has no working public page, so a sheet for one
  sends staff to a dead link. Tag types don't matter for this card (the route
  echoes the card's own registered types back), so an API edit needs no re-flip.
- The permit code Rec prints is the **LAST** 8 hex of the permit id.
- Exports re-fetch permits live so a permit revoked since the last page load can
  never be printed; `PERMIT_LIVE_MAX_AGE` (60s) keeps back-to-back exports from
  each paying the full card time (Watertown's card is ~25s).

**Multi-day permits (2026-08-20).** A permit covers the WHOLE rental, and the
sheet goes up once at the start of a run and stays up — so printing only the
exported row's date tells a parks crew the field is booked for one afternoon when
it is actually booked every Friday until September. Card 20230 therefore emits
`Schedule` (JSON `{d,s,e,site}` per occurrence, **multi-date permits only**),
`Date Count`, `First/Last Date`, `Capacity`, `Attendees` and `Add Ons`, and the
sheet:

- **scopes the dates to the site it is hung at** — the Multipurpose Field's sheet
  must not list the same permit's Kitchen booking. Site key = `court.court_number`
  = card 17294's "Facility" column. No match ⇒ fall back to the whole run.
- prints **one sheet per permit per site**, not per row, once a permit is
  multi-date — otherwise a week of a recurring rental yields five identical pages.
- caps the date list at 32 **in JS**, not by CSS clipping, and says "+N more" — a
  sheet that quietly loses rows to overflow looks complete and is not.
- carries add-ons **without quantities**: they are billed per occurrence, so a
  40-date permit holds 79 rows of "Alcohol Permit".

**No per-org opt-in, by design** — the chip only appears where a permit exists,
so orgs that don't issue permits never see it. Nothing has to be "turned on"
for a new org: Douglas County was verified 2026-08-21 with zero issued permits
and behaved correctly before it had any (facility report 200, chip feed
`{permits:{}}`, export a clean 404 rather than an empty PDF), then lit up on
its own once permits were pushed through the same day. Their campsite data
suited the stay layout — 370 multi-day reservations in the next 30 days, up to
12 nights, and **zero** missing site names or capacities, so site scoping and
the capacity line both resolve.

The manifest carries a `facility-permits / douglas-county-nv` row. It ran at
`minRows: 0` while they had none; permits were issued 2026-08-21, so the
override is gone and it uses the default of 1 like every other row — an empty
result now fails, which is the point of the check.

How these are actually used (Dan, 2026-08-21): permits cover essentially ALL
facility reservations, and multi-day is mostly campsites though not exclusively.
Campsite sheets generally will NOT be printed and posted at the site — so for
that segment the per-row chip matters more than the bulk export, and the stay
layout is there to be correct rather than because a crew is hanging it on a
post.

## Dev branch

Feature work for these tasks lives on `claude/facility-report-line-removal-1d0c8k`
(same branch name in both `rental-report` and `rec-dashboard`).
