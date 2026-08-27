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
feedback/votes, `email`, `munis`, `permits`, `map`, `epact` (📤 a participant list
exported for the ePACT camp-forms vendor, with the count and whether it was one
class or the whole view), and three platform alerts —
`report-down` (a report's card stopped answering, links straight to the report
with its token), `schema-break` (a table or column the reports depend on is
gone), `param-drift` (a date template tag is no longer typed Date). The three
alerts debounce at 6h and @-mention if `SLACK_MENTION_USER_ID` is set. Inert
unless `SLACK_WEBHOOK_URL` is set (prod has it).

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
Memberships → check-ins / retention. Nested `<a>` is invalid, so a card with
chips renders as `.card-wrap` holding the anchor plus a sibling chip row —
pinning still works through the wrapper (verified in a browser, not assumed).
Every tab renders for every org with its own empty state, so a chip is never a
dead end. Descriptions in **three** places had gone stale and now name the same
things: `REPORT_META` (org.html), `reportMeta` (the admin dashboard, inside the
template literal — no apostrophes), and the Director's Report's own blurb.

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

**STILL OPEN, and it is in the CARD, not the client.** Card 17300's
`Reg Status` is computed from `rw.default_opens` only:

```sql
WHEN rw.default_opens > now() THEN 'pipeline'
```

so a section in early access is reported as `pipeline`. **486 sections across 7
orgs are in that state right now** (measured 2026-08-24). Consequence: the
Conversions tab's `postReg` set is gated on `regStatus === 'open' || 'closed'`,
so those sections are missing from the tab whose entire job is watching Fast
Track convert — and no client-side fix reaches it without either re-deriving
status from the two windows in the page or editing the card. A card edit means
the usual API/date-tag re-flip dance plus heaviest-org sign-off, so it is Dan's
call rather than a drive-by.

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
Requires a card update to take effect.

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

`scripts/roster-epact.spec.js` (**69 assertions, in CI**), which **lifts and
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

Mutation-tested fourteen ways, all failing by name: the email read from
`ownerEmail`, the cancellation filter dropped, `SELECT DISTINCT` dropped, the
date via `new Date().toISOString()`, a dateless row given the section name
anyway, the default back to a month, `epact` dropped from `SLACK_NOTIFY`, `epact`
dropped from the log route's `ALLOWED`, the debounce key reverted, the `rows`
clamp removed (**only the live half sees that one**), a second popup
implementation, the toolbar button exporting the unfiltered rows, the per-section
button bypassing the shared builder, and the section button rendered with nothing
to export.

Plus six `ci-check-render.js` cases — **the Class Roster had no render case at
all before this**, and it is the report an admin runs before every camp. Five of
them are keyed on COUNTS or on absence rather than presence, because "a button
rendered" passes on every one of the regressions above. The sixth,
`roster · epact csv is her output`, **stubs `saveTextViaPopup`, clicks the real
button and asserts on the bytes** — the header line, three data rows (Ana's two
same-day sessions collapsed, Cass's cancellation dropped), the participant's own
email present and the owner's absent. Every source assertion in the spec passes
on a button wired to the wrong row set; that case is what proves the file.

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
