# Project notes for Claude

## AN ACTUAL MUSCO INTEGRATION, NOT THE REC ADD-ON (2026-09-11)

Dan, the day after the removed-schedule fix: *"what are we doing for the
facility rental report when an actual musco lighting is connected, not just the
rec 'add on'?"* Then, on the answer: *"yes, build 1 and 2. If a rental has an
actual 'Musco Lighting' configuration set (which I think none currrently have)
then I'd want a yellow bar lighlighting that row for easy visibility."*

**THE TIMING IS THE FINDING.** `site_lighting_configuration` — the site→Musco
map, which nothing in this repo had ever read — holds **73 sites across 6
locations and 6 CLC facilities, created 2026-09-09 and 2026-09-10, for exactly
one org: City of Midland.** And **1,230 of their next 1,408 reservations (87%)
sit on one of those sites**, over 184 rentals and 69 of the 73. So a column that
has never been right for anybody is about to matter for nearly every row of that
org's schedule.

### THREE THINGS THE REPORT COULD NOT DO, and the second is a wrong number

**1. `Lighting Sync` was on the card and READ BY NOTHING.** Selected by 17294,
mapped at `facility.html:1446`, rendered on no surface — **sixth instance of the
mapped-and-never-read pattern**, on the one column that says whether the lights
will actually come on. An errored push drew the same confident 💡 as a healthy
one, i.e. a booked team at a dark field.

**2. A SUNSET SCHEDULE RENDERED A TIME THAT MEANS THE OPPOSITE.**
`start_source` is `'sunset'` on **2 of the 9** schedules ever written
(`musco_start_value` is the literal string `'suns'`), and **`lit_from` is NULL
on both** — there is no instant to store, because the switch-on tracks the sun
and moves every day of a recurring rental. `CONCAT_WS` then yields the end
alone, and the exact string those live rows produce is **`"11:00pm"`**. Printed
raw the note reads *"💡 Lit: 11:00pm"* — **lights ON at 11, when it means OFF at
11.** Measured, not reasoned: the window expression was run against all nine
real rows.

**3. Nothing said a site was wired at all.** Not built — see the bottom.

### THE CARD SHIPS THE RULE; THE PAGE WORDS IT

Three new columns — `Lit Start Source`, `Lit End Source`, `Lighting Error` —
and **`Lit Window` is deliberately NOT changed to say "Sunset" in SQL.** The
word is presentation, and the page already owns one definition of how a time is
displayed (`litWindowLabel` → `formatTime`). Composing it in the card would put
a second definition on the far side of a four-hour cache. The spec fails if
`'Sunset'` appears near the `Lit Window` expression.

**CLOCKS ARE ASSIGNED TO THE ENDS THAT ARE NOT RULE-DRIVEN, not read
positionally.** A one-sided `"11:00pm"` is the END when the start is sunset and
the START when the end is, and the string cannot tell those apart. **Two clocks
stay positional and the rule OVERRIDES the clock it produced** — the stored
instant is one day's sunset and the rental recurs, so the rule is the true
statement. *That case failed on the first run of my own spec*, because assigning
"in order" broke the moment a ruled end also had a clock.

### `muscoLit()` — ONE PREDICATE, AND IT NEVER READS AN ADD-ON

The note, the "Lit Only" filter, the row highlight and the Excel export all go
through it. Dan, sending a screenshot of a rental carrying a `💡 Field Lights
($25.00)` line: *"The screenshot is just an example, not an actual musco
lighting integration."* Exactly — **"Field Lights" and "Field Light Fee" are
among the most-attached add-ons on the platform (409 rentals), they are money,
and they turn nothing on.** Both the spec and a render case fail on a highlight
keyed on the add-on name.

**It also carries the `'removed'` test on the PAGE**, which the card already
does in its join. That is not redundant: feeds cache four hours, so a response
fetched before yesterday's paste still says `Lighting = 'Yes'` with
`sync_status = 'removed'`, and this closes the one TTL where the shipped bug
survives. Denylist again — an unclassifiable status stays lit.

### ONLY `synced` IS A CONFIRMATION — and the vocabulary is NOT measured

`LIGHTING_SYNC_STATES` maps `synced` → 💡, `error` → ⚠ (with `last_error`
appended, the difference between *"something failed"* and *"Musco rejected this
field id"*), `pending` → 🕓. **Anything unrecognised, blank included, reports as
unconfirmed rather than drawing the confident lamp**, because the two ways to be
wrong are not symmetric: a healthy row shown as unconfirmed is noise, a broken
one shown as confident is the dark field.

**~~SAID PLAINLY BECAUSE IT WILL BE READ AS MEASURED AND IS NOT~~ — HALF OF IT
IS MEASURED NOW (2026-09-11, same day).** Dan configured the first live
schedule that afternoon and sent it over: *"here's a live reservation in
midland with the musco lighting configured. check the sql and confirm this is
showing up in that output, and on the facility rental report."*

**It does, and it is the exact shape the feature was built for and could not
test.** `Dan Test Lighting` — Baseball PRACTICE Field, Beal LL Grass Field 7,
Wed 16 Dec 2026 6pm-10pm, Sunset → End of reservation:

| | |
|---|---|
| `sync_status` | **`synced`** — the first non-`removed` status ever written |
| `start_source` / `end_source` | `sunset` / `reservation` |
| `musco_start_value` / `_end_value` | `'suns'` / `'2200'` |
| `lit_from` | **NULL** — sunset stores no instant, exactly as predicted |
| `lit_until` | `2026-12-17T04:00:00Z`, `timezone` `America/Chicago` |
| `synced_at` | set. `last_error` NULL |

Card 17294 returns it with **`Lit Window = "10:00pm"`** — the bare one-sided
string — plus `Lit Start Source = 'sunset'` and `Lighting Sync = 'synced'`. The
page's own helpers, lifted from the bytes production serves and run against
that row, render **`💡 Lit: Sunset - 10:00pm`**, the yellow bar, and `synced`
in the Excel export. **Without commit 2 it would have printed `💡 Lit: 10:00pm`
on a booking that ENDS at 10** — the whole point, now demonstrated rather than
argued.

**And the timezone half is proven on real data for the first time too.**
`Lit Until` comes back `2026-12-16T20:00:00-08:00` (Metabase renders Pacific),
so a browser parsing the raw instant shows **8:00pm**; the facility is Central
and the truth is **10:00pm**, which is what the row's own `End` cell says two
columns over. Only the pre-formatted column makes those agree.

**So of the 10 schedules on the platform, 9 are `removed` and 1 is `synced`.**
`'synced'` is measured. **`'error'` is still documentation only** — `last_error`
is NULL on all 10 and nothing has ever failed — which is exactly why an
unrecognised status still refuses the lamp. `LIGHTING_SYNC_STATES` is still the
one place to correct it.

**The golden row is kept in the spec verbatim**, as the only evidence in this
repo that the pipeline works on something real. Mutation-checked **in
isolation** (not merely through the suite, where three earlier assertions catch
the same mutations first and the golden claims are never reached): the sunset
word unmapped, `synced` not drawing the lamp, and the clock beating the rule
all fail it, and the first of those reproduces the live degradation exactly —
`"10:00pm"`.

**MIDLAND HAD NO MANIFEST ROW AT ALL**, found doing this. The two facility rows
are apex and smyrna and both are dateless, so the daily check has never probed
the one org wired for Musco. Added, **deliberately dateless**: the current-month
default returns ~1,471 reservations there, where pinning it to the December
window holding the lit row would fail the day that test rental is deleted.
36 → 37.

### THE CONTROL HAS TO NAME MUSCO — the predicate was right, the LABEL was not

Dan, on the shipped toolbar: *"How are we filtering for when musco lighting is
configured. An 'add on' for field lighting is NOT the same as the musco/rec
integration."*

`muscoLit()` never reads `r.addons` and there are guards that fail if it ever
does — so the filter was correct. **The button said `💡 Lighting`, and the
add-on picker two controls over builds its options FROM THE ROWS**, so on any
org that bills for lighting a checkbox reading `Field Lights` sits inches from
it. They answer opposite questions — the add-on says somebody was CHARGED, the
filter says a schedule will turn the lights ON — and nothing on screen
separated them. **Correct behaviour behind an ambiguous label is
indistinguishable from the bug.** It reads `Musco Lighting` / `Musco Only` now,
and the tooltip names the distinction rather than leaving it to be inferred.

**ABSENT, NOT DISABLED, is unchanged**: `hasLighting` gates it on there being a
schedule in the window, and `hasLighting` reads `muscoLit`, so an add-on can
never summon the control either. It did not render for any org until Midland's
first schedule landed, which is also part of why Dan could not find it.

Guarded by the naming assertions in `facility-lighting.spec.js` and two render
cases — one requiring the button to name Musco **AND** the `Field Lights`
string to be on screen (asserting the naming alone proves nothing about
ambiguity if the collision is not there), one clicking it and keying on the row
COUNT plus the add-on row's absence. Each browser mutation fails exactly one
case by name.

**THE BUTTON READS `💡 Musco`, AND IT STAYS A TOGGLE.** I built the natural
follow-on — a checkbox picker matching the three multi-selects beside it, with
options from the rows (`Rejected` / `Unconfirmed` / `Synced`) so you could
isolate a broken schedule — and **Dan turned it down**: *"I'm fine leaving it
the way it is now with the button, scrap the other adjustments. Only item,
rename it 'Musco', not 'Lighting'."* Recorded because the work was real and the
reasoning is worth not re-deriving:

- A picker's **empty state would have been the opposite of its neighbours'**.
  Every other filter here seeds all-ticked and narrows as you untick; seeding
  Musco that way opens the report already narrowed to lit rentals for the one
  org that has them. Nothing ticked would have to mean *every* rental, so
  all-ticked and empty become different answers and `All` stops being the
  redundant twin of `Clear`. Legible, but a rule that contradicts the three
  controls beside it.
- **It would have made "show me the broken ones" reachable**, which the toggle
  structurally cannot. Worth revisiting only if an org ever has enough rejected
  schedules for that to be a real query — today the answer is the ⚠ on the row.

### THE TOGGLE PASSED NONE OF THE FOUR GATES — FIXED (2026-09-11)

Dan: *"the filter lighting needs to hit the pdf and printed versions."*

`filterLighting` was local state and reached **neither the URL, the share link,
the saved view, nor the PDF** — so a reader who narrowed to lit rentals and hit
Print got **every rental back, silently.** Fourth instance after `gl_codes`,
`refunds` and `pii`, and the first on a control this file had already written
the standing rule for.

It rides as **`musco=1`**, and the semantics question the picker raised
evaporates because it is a BOOLEAN: the default is OFF and nothing persists it,
so an absent parameter resolves to exactly the default. **It may therefore ride
`generatePdf`'s truthy loop** and needs none of the presence handling `pii` and
`site_types` require — whose defaults are ON, which is the whole reason those
two had to be special-cased.

Saved views carry it too, **appended LAST** to both `SAVED_VIEW_PARAMS.facility`
and the page's own `FACILITY_VIEW_PARAMS`: appending is the only change to those
lists that cannot make an existing view read as *edited* the instant it is
applied, and without the page's copy a stale `musco=` outlives its view — the
bug already recorded here for `refunds`. An apply sets it in **both directions**
and `clearView` turns it off, or a plain view opened after a lit one stays
filtered.

**TWO OF MY OWN GUARDS WERE DEFECTIVE, and mutation is what showed both.**

- The gate-1 assertion `/musco:\s*p\.get\('musco'\)/` **SURVIVED its own
  mutation**: `parseViewParams` reads the same key off a saved view's params and
  satisfied a file-wide regex on its own, so removing it from `getParams`
  changed nothing. Scoped to the sliced `getParams` now. *A guard that is
  satisfied by different code is not guarding the thing it names.*
- `generatePdf`'s forward list is **LIFTED AND RUN**, not regexed, because a
  render case at `?musco=1` proves the PAGE reads it and says nothing about
  whether the server SENDS it — which is exactly how the other three shipped.

**AND A LATENT HARNESS GAP, found by being the first to hit it:
`renderToolbar()` RETURNS NULL UNDER `?_print=1`**, and `ci-check-render.js`
waits for `.prompt-panel, .toolbar, .card` before running a case's `act` hook.
So an act-driven print case could never resolve that wait — it hung for the full
45s and reported as an *uncaught error*, which reads as the page being broken
rather than as the harness waiting for something deliberately absent. No print
case had ever used `act`, so it stayed latent. `.report-header` is in the wait
list now; it renders in both modes.

Guards: `facility-lighting.spec.js` 111 → **122 assertions**, mutation-tested
six ways (off the whitelist, state not seeded from the URL, `generatePdf`
dropping it, a view that can only turn it on, either allowlist reordered) — all
failing by name. Three `ci-check-render.js` cases, keyed on the row COUNT and
the add-on row's absence rather than on print mode rendering: `?_print=1&musco=1`
shows the three real schedules, the same URL **without** it still prints
everything (so the first proves the parameter rather than something about print
mode), and `?musco=1` lands filtered on screen. The bug as it shipped fails two
of the three.

### A REVERSAL, STATED: "Lit Only" still means HAS a schedule

I proposed that a rejected schedule should fall OUT of that filter, on the
grounds that its job is *"where will the lights be on"*, and Dan approved the
plan as written. **It is the wrong call and the yellow bar is what makes it
obvious**: a filter that hides the broken ones is how a broken one goes
unnoticed, and the rejected row is the one most worth finding. Same failure
direction as the card's own denylist. The ⚠ makes the state visible INSIDE the
filter instead. The spec fails if the filter ever narrows to confirmed.

### The yellow bar

`.data-row.musco-lit` + `.sub-row.musco-lit`, `#fffbeb` with an inset amber bar,
declared AFTER `:nth-child(even)` because both are (0,2,0) and source order is
what makes it win. **`print-color-adjust` in both spellings** — the PDF is the
copy a grounds crew actually holds, and a highlight the printer drops is not a
highlight.

### Guards

`facility-lighting.spec.js` 38 → **97 assertions**. Mutation-tested **23 ways,
all failing by name**: the sunset word dropped (the bug as it would have
shipped), a real clock worded too, the sources never mapped, the clock beating
the rule, `muscoLit` ignoring `removed`, `muscoLit` reading the add-on, an
unknown status reporting as confirmed, `error` drawing the healthy lamp, the
vendor message dropped, the note back on the raw column, the note losing the
sync state, the filter narrowing to confirmed, the filter back on the raw
column, the yellow bar dropped, either print-color rule dropped, the row class
reading the add-on, Excel writing the raw column, Excel losing a width, and
three on the card.

**Two of my own guards were defective and mutation is what showed it.** The
spec's LIFT started at `litWindowLabel`, which now calls `litSourceWord`
declared above it — so it **died with a bare ReferenceError instead of failing
by name** on the very first run, the Nth instance of a slice reaching past its
own inputs; the boundary is asserted now. And a single
`/print-color-adjust/` **also matches the `-webkit-` prefix**, so deleting the
standard property SURVIVED; the two spellings are asserted separately and both
directions re-verified.

**Four `ci-check-render.js` cases**, over three new fixture rows that each make
a wrong implementation render something *plausible*: a sunset row whose window
is the bare `"11:00pm"` the live rows actually produce, a rejected row, and a
row billing a `Field Lights` add-on with no schedule. The add-on case keys on
the **count** (exactly 3 highlighted) plus the add-on row being present and not
among them — asserting the absence alone passes on a row that never rendered.
All three browser-only mutations were verified to fail **exactly one case each,
by name**, with the other ten passing.

**My new fixture rows broke the two EXISTING lit cases**, which took the first
`.sub-row` saying "Lit" and had silently assumed there was only one. Both are
scoped to their own row now. *A case that depends on there being one of a thing
stops testing what it names the moment there are two.*

### Verified

The card mirror's **whole final SELECT** was run with literals — as a subquery
of a counting wrapper, so the column list and the trailing `ORDER BY` execute
(the card-21682 failure) without shipping 1,492 rows through a tool. Midland
September: **1,492 rows, all lighting columns 0**, new columns resolve. The
window expression was then run against all nine real schedules, which is what
produced the `"11:00pm"` string above. Full `facility · ` render group **31
green**; all **65 CI specs** green.

**THE CARD IS A PASTE, NOT A PUSH** — 17294's date tags are Date-typed and an
API save regenerates every tag as Text, taking the rental schedule down for all
29 orgs. Flip link https://rec.metabaseapp.com/question/17294

### NOT BUILT, and it is the obvious next one

**`site_lighting_configuration` is not read anywhere.** It is the only thing
that can say *"this field has Musco control and nobody scheduled lights"* —
1,229 of Midland's 1,230 upcoming reservations on a lit site, today. Its
`lighting_product_id` (NULL on all 73 rows) is also the intended bridge between
the wired site and the Rec add-on, which is the question underneath Dan's:
whether the $25 someone paid actually turned anything on.

**`pkill -f` SELF-MATCHED AGAIN**, this time because the *grep argument in the
same command line* contained the needle. Exit 144, no output. Assemble the
needle at runtime in Python and skip the current pid; and never let the literal
appear anywhere else in the command.

## MIDLAND'S RENTAL SHOWED MUSCO LIGHTING IT DOES NOT HAVE (2026-09-10)

Dan, with the rental open in Rec: *"the midland rental schedule shows this
facility rental with musco lighting. but the rental itself doesn't have musco
lighting on it, where did this come from?"* Then, on the diagnosis: *"do both,
that lighting should be gone and fix the timezone for the lighting."*

**Two bugs, and the second is the one nobody reported** — because a wrong time
reads as a time.

### A REMOVED SCHEDULE IS STILL A ROW

`reservation_lighting_schedule` is append-only in the way that matters: taking
Musco off a rental writes `sync_status = 'removed'` rather than deleting the
row. Midland's was **created 13:24 and updated 13:27 the same afternoon** — put
on and taken off inside three minutes.

**Card 17294 SELECTED `sync_status` all along and then tested only whether the
ROW EXISTED:**

```sql
CASE WHEN b.lighting_schedule_id IS NOT NULL THEN 'Yes' ELSE NULL END AS "Lighting"
```

So the column it needed was already on the card and already unread — the
mapped-and-never-read pattern, in its sharpest form: the value was not merely
mapped and rendered nowhere, it was selected *and sitting beside the test that
should have used it*.

**MEASURED: all 9 lighting schedules on the platform are `removed`.** So this
column has never been right for anybody, on either of the two orgs that have
ever used Musco — it was simply too rare to be noticed until Midland asked. The
💡 also kept those rentals inside the *"Lit Only"* toolbar filter, which is the
half that would have sent someone to a dark field.

**It is a DENYLIST on the one status observed, not an allowlist.** An unknown or
NULL `sync_status` still shows: a schedule we cannot classify is more likely
live than removed, and the failure direction has to be *"tell someone"* rather
than *"hide it"*. `IS DISTINCT FROM`, never `!=` — a `!=` against NULL is NULL,
so the plain comparison drops the unclassifiable case as well as the removed
one, which is exactly backwards.

**Filtered in the JOIN, not the WHERE.** In the `WHERE` it would drop the whole
rental row from the schedule; at the output it would leave a row **half-lit**,
with a `Lit From` beside a blank `Lighting`. In the join, all five lighting
columns go NULL together. Verified on the real window: Midland September is
**1,488 rows before and 1,488 after**, with `Lighting`, `Lit Window`,
`Lit From`, `Lit Until` and `Lighting Sync` all at 0 non-null.

**It cannot fan out** — 0 reservations on the platform carry more than one
schedule, measured before the join condition was written rather than after.

### THE LIT TIME WAS THE READER'S CLOCK, UNDER A ROW THAT WAS NOT

`lit_from`/`lit_until` are **timestamptz**. The page parsed them with
`new Date(s).getHours()`, i.e. whatever zone the browser sits in — so Dan, in
Eastern, read Midland's **6:00pm Central as 7:00pm**, on a row whose `Begin` and
`End` two columns over said 6:00pm and 7:00pm correctly. Those come off
`reservation_timestamp_range`, a **tsrange** — timestamp WITHOUT time zone, i.e.
already local — which is why one half of the row was right and the other was
not. Same table, same row, two different notions of what a clock is.

Card 17294 now emits **`Lit Window`** pre-formatted, exactly the way it already
emits Begin and End, so nothing downstream parses an instant.

**THE CONVERSION IS PROVEN, NOT ARGUED.** Converting with the schedule's own
`timezone` column reproduces the reservation's own wall clock **to the minute on
8 of the 9 rows** — the ninth is a `set_time` 23:00 end, which correctly does
*not* match its reservation. `rls.timezone` equals `location.timezone` on all
nine, which is what makes the location a safe fallback for a schedule carrying
none.

**Additive, deliberately.** `Lit From` / `Lit Until` stay: they are in the Excel
export, and feeds cache four hours, so a pre-push response and a post-push one
are both live at once. `litWindowLabel()` prefers the column and falls back to
the old browser parse only for that one TTL — rendering nothing there would look
like a rental with no lighting, which is a different and worse lie than being an
offset out.

### THE RENDER CASE FOUND A THIRD DEFECT, IN MY OWN FIX

The card's `to_char(..., 'HH12:MIam')` gives **`06:00pm`**, and every Begin/End
cell on the page goes through `formatTime`, which strips the leading zero to
**`6:00pm`**. So the note I had just written would have printed *"Lit: 06:00pm -
07:00pm"* beside a Begin cell reading *"6:00pm"* — inconsistent on one row,
which is the exact complaint being fixed one field over.

`litWindowLabel` routes both paths through **`formatTime`**, the page's one
definition of how a time is displayed. That also folds the fallback's `6:00 PM`
into the same shape, so a feed expiring mid-session cannot restyle the note.
Found by writing the case, not by reading the diff.

### Guards

`scripts/facility-lighting.spec.js` (**38 assertions, in CI**), which LIFTS AND
RUNS `litWindowLabel` **together with `formatTime`** — lifting it alone would
have proved the wrong thing, since the normalisation is the half that was
missing. Mutation-tested seventeen ways, all failing by name: the gate reverted
(the bug as it shipped), the gate written as `!=`, the gate turned into an
allowlist, the gate moved into the base `WHERE`, `Lit Window` dropped, only one
end converted, the timezone fallback dropped, the ends concatenated with `||`
instead of `CONCAT_WS` (which makes the whole string NULL the moment one end is
missing — two of the nine live rows), `Lit From` dropped, the note back on the
browser clock, the window preferred behind the raw instants, the column never
mapped, the `isNaN` guard removed, a one-sided window printing a dangling
separator, the fallback dropped entirely, the Excel export re-deriving its own
clock, and a header column with no cell under it.

**Two of my own assertions did not discriminate at first.** The `!=` and
allowlist checks both fell over the same literal as the catch-all above them, so
each mutation was caught by a name that did not describe it; they are scoped to
the join clause and ordered ahead of the catch-all now. *A mutation that is
caught by the wrong assertion has not shown that assertion works.*

**Two `ci-check-render.js` cases, and the lit note had NO render coverage at
all** — which is part of why it read the wrong clock for as long as it did: the
column rendered a plausible time either way and no source assertion can tell a
right time from a wrong one. The fixture's lit row makes the two derivations
**deliberately disagree**: `Lit Window` says 6:00pm while the raw instants land
on 11:00 PM in UTC, which is what this harness and GitHub Actions both run. A
fixture where they agreed could not tell the two implementations apart. The
second case requires the note to agree with its own row's Begin and End, which
is the disagreement Dan actually spotted.

### The card was handed over as a PASTE, not pushed

Card 17294 registers `start_date`/`end_date` as **Date**, which is what the app
sends and what a `date/single` parameter binds to. An `update_question` push
regenerates every tag as Text, and the rental schedule is then down for **all 29
orgs** until a human re-flips them — on the most-used card on the platform. The
recorded rule applies: *once a human has configured a card's parameters, a
programmatic save costs more than the change is worth.* Mirror rebuilt at
`sql/report-cards/17294-facility-rental-report.sql`; flip link
https://rec.metabaseapp.com/question/17294

**AND THE MIRROR WAS STALE AGAIN — second time on this card.** It carried
`COALESCE(finalCents, addon.price)` where the live card has
`COALESCE(finalCents, finalCents)`, and **`order_item` has no `price` column at
all**, so pasting the repo copy to make a two-line change would have broken the
card outright. Read the live card first; the mirror is a mirror.

## PINNED: "Happening Today" belongs on the org DASHBOARD (Dan, 2026-09-10)

*"the 'Happening today' is an awesome thought for a new card on the dashboard.
Pin that thought for the weekend."*

**It is the single most-copied card in the org survey — 5 of 5 collections
sampled** (Apex, Clarksville, Norman, Watertown/Torrance, Brookline), which is
the strongest demand signal in that whole exercise. It is deliberately NOT in
this project: it is live data, and the rule already recorded here is that a
dashboard is the place for a live trend while a report answers a question about
a window somebody chose. Same line that moved Laurel's Coffee Chart out.

**It belongs in rec-dashboard's Live Widgets section**, beside the coffee
counter — and that section already has the shape (a per-card feed, a refresh
tick), so this is a query plus a card rather than a new surface.

Three things to settle before building it, all of which this file has already
paid for elsewhere:

- **"Today" is the ORG's today, not UTC.** `toISOString().slice(0,10)` is the
  UTC date, and from 5pm Pacific that is already tomorrow — a "happening today"
  card would drop the evening's programming, which is most of what it is for.
  Build the date from local parts against the org's own timezone
  (`location.timezone` is populated on all 3,099 locations; `organization.config
  #>> '{general,primaryTimezone}'` is populated on all 168 live orgs, and the two
  disagree for 22 of them).
- **It spans sessions AND facility reservations**, which are different tables
  with different grains — a class meeting is a `session`, a rental is a
  `reservation`. One of the two alone is half the day.
- **An empty day is a real answer** and must not read as a broken card. A
  Monday in January genuinely has nothing on it.

## THE BASE DATA REPORTS (2026-09-10) — TWO BUILT, ONE HANDED TO PRODUCT

Dan, on the survey: *"Let's do these as 'base data reports' and scope them so
they can live cross org. Build them out in el segundo first, so they are all in
the same spot, then we'll look into moving them to all orgs."*

| report | card | El Segundo | platform |
|---|---|---|---|
| Account Credit Balances | [21781](https://rec.metabaseapp.com/question/21781) | 45 accounts | 7,664 accounts / $3,948,975 across 83 orgs |
| Account Credit Ledger | [21782](https://rec.metabaseapp.com/question/21782) | 407 entries | 80,951 entries across 90 orgs |
| ~~Facility Rental Refunds Due~~ | 21783, **ARCHIVED** | — | see the hand-off below |

**THESE ARE A DIFFERENT KIND OF ENTRY FROM THE FOUR AQUATICS REPORTS, and the
difference is the point.** Cards 21682-21685 hardcode El Segundo's location
names and GL-code ladders, so they are org-gated by NECESSITY. These three take
`{{org_id}}` and nothing else, so the `orgIds` gate is a ROLLOUT decision:
adding an org's uuid to the list is the whole of what it takes to give it the
report. `custom-reports.spec.js` reads the SQL mirrors and fails on a hardcoded
GL code, a named El Segundo facility or a literal uuid — because that claim rots
SILENTLY otherwise: a card that grows one location name still renders perfectly
here and returns nothing for everybody else.

### ALL THREE TAKE THE SAME DATE RANGE — and a POSITION still is not windowed

I built the first two **undated**, on the argument that a credit balance and an
unrefunded cancellation are both *"what is outstanding RIGHT NOW"* and that a
From/To pair changing nothing is the dead control this file keeps writing down.
**Dan overruled it** — *"those reports should have the same date range filters
as the others for consistency"* — and consistency across the Data Reports card
is the better call, so the `undated` flag and every line of page code behind it
were **removed rather than left unread**: a registry key nothing honours is the
same dead end one level up, and that is why `aquaticsExtraTypes` was deleted
too.

**What could not follow is the arithmetic.** A balance is a POSITION, so it is
current whatever the toolbar says, and the window moves the LEDGER columns only.
The two bases are separated by the COLUMN NAMES — `Balance` against
`Issued in Period` / `Used in Period` / `Entries in Period` — which is exactly
the treatment the Programs summary needed after *"NET REVENUE"* sat lifetime
beside a period figure under one date range and read as a bug for weeks. The
lesson there was that the arithmetic was fine and the labels were the defect, so
the labels do that work here from the start. **The grand total of `Balance` does
not move when the window does**, and that is correct: it is the org's whole
credit liability, which is the number the report exists to produce.

**`Ledger Difference` KEEPS AN ALL-TIME CTE OF ITS OWN, and that is the
load-bearing line.** It compares the live balance against the WHOLE ledger, so
windowing it would make every account with no activity in range falsely read as
drifted. Verified against real data rather than argued: El Segundo over
September reads **1** drifted account, not 27. The spec fails by name on that
mutation.

### FACILITY RENTAL REFUNDS DUE — BUILT, MEASURED, AND HANDED TO PRODUCT

Dan, after seeing it render against real data: *"lets drop this facility rental
refunds due report, this should be in product, and I'm hesitant to build it out
here."*

**He is right, and the measurements are why** — they are kept here in full
because they were expensive, they are the specification if product picks it up,
and nobody should re-derive them. Card **21783 is ARCHIVED, not deleted**, so
the SQL survives in Metabase; the registry entry, the SQL mirror and the
report's spec assertions are gone, and `custom-reports.spec.js` now fails if it
drifts back in as a report without the decision being revisited.

**THE SHAPE, for whoever builds it properly.** Grain is the RESERVATION, because
`order_item.reservation_id` links money to the individual date — so a recurring
rental that lost one Tuesday reports that Tuesday. Both cancellation paths count
(`reservation.canceled_at`, and `facility_rental.canceled_at` with the
reservations unmarked — the second adds 12 rows / $934.75 platform-wide). The
site is `reservation_court` → `court.court_number`, **aggregated never joined**,
since `reservation.court_id` is legacy-NULL and a multi-court reservation would
otherwise multiply the row *and its money*.

**THE SCALE, and the first thing to know: the product already handles most of
it.** 70,702 cancelled reservations are already fully refunded. The residue is
**11,761 reservations across 54 orgs holding $97,893.76**.

**WHEN A REFUND HAPPENS, IT HAPPENS FAST.** Over the 11,022 refunded
cancellations: **62.7% the same day, 84.0% within three days, 95.0% within
SEVEN, 98.9% within thirty**; median 0.5 days, p95 7.0 days. So **seven days is
a measured threshold rather than a guess** — past it the normal process was
never going to catch the item.

**And almost nothing outstanding is inside it**: only **377 ($3,831.75)** are
under a week old, **947** are 8-30 days, **2,175** are 31-90, **8,184
($62,888.27)** are 3-12 months and **82** are over a year. **Median age 155
days.** So it is genuinely aged rather than work-in-flight.

**WHY IT WANTS TO BE A PRODUCT SURFACE AND NOT A REPORT — the median outstanding
amount is $5.00, and nothing in the data separates money DELIBERATELY RETAINED
from money somebody missed.** A cancellation fee and an oversight look
identical; there is no cancellation-policy signal on the reservation to read.
A report can only ever hand an org the list and shrug. The product knows which
cancellations were charged a fee and which were not, and it is the place that
can *act* — so this is a queue with a button, not a page with a total.

**Two smaller findings worth carrying over:**

- **Excluding `credit_id` transactions cuts both ways** — a refund paid out as
  store credit would be invisible and the report would tell staff to refund
  somebody already made whole. Checked: `credit_id` is set on 2,205 of 2,744,498
  transactions (0.08%) and on **ZERO** of those touching a cancelled facility
  reservation, and all 11,122 refund rows on cancelled-rental items have a
  matching transaction, `organization-credit` ones included.
- **The card emits no reservation-level id**, so two identical reservations on
  one rental are indistinguishable and collapse into one display row. Found by
  RENDERING it, not by reading the SQL: El Segundo's live 114 rows drew as 113
  with `Bookings` 114, one genuine merge. For a queue where each row is a
  separate refund to action, that is a real gap — one more column fixes it.

**The live review is what made the decision informed rather than theoretical.**
The real page over El Segundo's real 114 rows rolled up to
**$563.00 + $508.00 + $89.00 = $1,160.00** across three locations, ties to the
independent measurement, and rendered the one partial refund correctly ($42
collected, $20 back, $22 out). It works. It is just the wrong home for it.

### Two of my own probes returned confident zeros, both mine

Recorded because it is the third and fourth instance in this file of *a
measurement rules out the place you looked, not the fact*:

- `section.pricing_policy` has **no `prices` array** — the shape is
  `{"default":{"type":"fixed","cents":11000}}` — so my first GL probe reported
  *"0 paid sections lack a GL code"* by reading a key that does not exist. The
  true figure is **17,351 across 81 orgs**.
- `facility_rental.status` holds exactly **two** values, `confirmed` and
  `in-progress`. My pending-applications probe filtered on
  `pending`/`requested`/`submitted` and returned **0 rows across 0 orgs**, which
  reads as "nobody uses this feature" and was a statement about my WHERE clause.
  The real figure is **1,791 across 56 orgs**.

### Guards, and what is left

`custom-reports.spec.js` 72 → **80 assertions**, and it now **LIFTS AND RUNS the
registry** (supplying the two names it closes over) rather than regexing the
literal — a regex over `numeric: { … }` passes on a key that is present and
wrong. Mutation-tested: a hardcoded El Segundo location in the SQL, and the
all-time CTE getting windowed; both fail by name.

**THEY LIVE IN COLLECTION 3532, "Base Reports for Ninja Project"** — not in El
Segundo's folder, where they were created. Dan: *"are we building them in El
Segundo, or in our ninja reporting base project folder?"* 3532 is where all
fifteen shared cards already sit (17294, 17295, 21649…), and these three are
cross-org by construction, so that is their home. **Moving a card is safe**:
`update_question` has patch semantics, and only a `query` save regenerates the
template tags — which is also why the two SQL updates were safe here and are NOT
safe on 21682-21685, where a human has already flipped the tags and set the
`org_id` default.

**BOTH PUBLIC LINKS ARE LIVE AND HARDCODED**, so these are on for El Segundo
the moment this deploys — hardcoded rather than env-gated for the reason every
other entry is: the report then works on deploy with no Railway variable to
remember. Balances `45b7a450-c2f8-4b46-88a2-bb879056c4b1`, ledger
`e51352ad-b20f-4cc3-9966-b90e5c37928d`.

**Signed off cache-independently through the public endpoint with the app's own
parameter shape**, which is the rule this file keeps: balances **45 rows in
24.6s**, ledger **247 rows in 2.2s** over Aug-Sep 2026. Both were CREATED rather
than re-saved, so each registers its tags once and there was no six-parameter
duplication to flip away.

The no-uuid path still exists and still matters: `customReportEnabled` refuses
an entry without one, so a future entry is simply not offered rather than
rendering a Metabase error that reads as broken.

**MANIFEST ROWS ADDED — 34 → 36.** These cards are not in `REPORT_TYPES`, so the
health check does not probe them and prewarm does not warm them; a re-Texted tag
or a lost column would take the report down for the orgs it serves with nothing
else noticing. Same gap already recorded for `aquatic-lane-hours`.

**The two rows are deliberately different shapes**, which is the
dateless-manifest-row lesson applied rather than repeated: the ledger row
carries **`days: 365`** because a ledger is a BACKWARD flow and an unwindowed
probe would ask for the org's whole history; the balances row sends **no dates
at all**, on purpose — its window moves only the *"in Period"* columns and its
row set is identical either way, so dateless is the honest worst case there.


## THE REFUND VIEW COULD NOT BE SAVED OR PRINTED (2026-09-09)

Dan, on needham's GL Code Rollup with the picker open on his own
*"GL Code Rollup w refund detail"*: *"Looks like the 'save a view' isn't saving
when the refund view is selected. If I save this view, it doesn't update the 'GL
Code Rollup with refund detail'. Then, when I click to print the PDF, it prints
the version without the refund detail."*

**Both halves are one root cause, and it is a CLASSIFICATION mistake rather than
a broken wire.** Refund Detail was filed as per-browser display state:

```js
const LS_REFUND = 'gl_refund_breakdown_v2';
const [showRefunds, setShowRefunds] = useState(() => localStorage.getItem(LS_REFUND) === 'true');
useEffect(() => { localStorage.setItem(LS_REFUND, showRefunds); }, [showRefunds]);
```

It never entered the URL, so:

| surface | why it could not see the mode |
|---|---|
| the saved view | `SAVED_VIEW_PARAMS.gl` is the server's allowlist and had no `refunds` key, so `PUT /saved-views` **dropped it**. Re-saving the view really did change nothing. |
| the PDF | the print page is this page under `?_print=1`, rendered by **Puppeteer with an empty localStorage** — so the mode could only ever be OFF, whatever was on screen |

### IT IS A MODE, NOT A COLUMN PREFERENCE — a deliberate reversal, for this one control

`SAVED_VIEW_PARAMS`'s own comment records the opposite rule for `roster`:
display toggles stay OUT of shared views, because *"a shared view that overwrote
them would take a colleague's chosen columns away."* That rule stands for
`showLocations`, which collapses one column. It does not survive here:

- Refund Detail restructures the **whole table** — a different column set under
  different group headers — which is what `tyler` does, and `tyler` has been in
  the allowlist and set unconditionally on apply all along.
- Dan's view is **named after the mode**. The mode IS the view, and a view that
  cannot carry it cannot reproduce itself, on screen or in the PDF.

So `refunds` follows `tyler` exactly, with two guards that keep the roster
objection paid for:

- **Precedence is URL → applied view → this browser's preference.** localStorage
  is still the no-view default, so nobody's current setting flips.
- **The persist effect is gated on `activeViewId`.** A view SETS the mode; it
  must not quietly rewrite the reader's own default the moment they open
  somebody else's saved view. Clear back to Default view and their preference
  returns on the next load.
- **An apply sets it in BOTH directions** (`setShowRefunds(!!f.refunds)`). A
  view that could only turn a mode on could never turn it off, so opening a
  plain view after the refund one would still render refund columns — and
  `clearView` turns it off, because *"no filters"* has to mean no mode either.

### AND `gl_codes` WAS THE SAME BUG ONE FILTER OVER, in the OPPOSITE half

Found by reading the whole path rather than the reported symptom.
`public/gl.html` has SENT `gl_codes` on the PDF and share link since the
multi-select shipped, and **`generatePdf`'s forward list silently dropped it** —
so every GL-code PDF carried the codes the reader had excluded. This file
asserted the opposite (*"rides both the share link and the export params"*),
which is why nobody looked: the client half was right and the claim was
therefore half true. It was also absent from `SAVED_VIEW_PARAMS.gl`, so a view
could not store a code selection at all.

**Generalise it: a param has FOUR gates on this report and passing three of them
looks exactly like working** — `getParams()`'s explicit whitelist, the page's
`currentFilterParams`, the server's saved-view allowlist, and `generatePdf`'s
forward list. `refunds` failed all four; `gl_codes` failed two.

**Key ORDER in the allowlist is load-bearing.** `cleanViewParams` emits in that
order and the page builds `currentFilterParams` the same way, because the
"edited" marker is a string comparison against the stored params — a different
order makes every freshly-saved view read as dirty the instant it is applied.

### THE SHARE-LINK EFFECT WAS READING ITS OWN DEPS AS `undefined`

Found while adding `showRefunds` to it, and it is the Babel `const`→`var` trap
in a form no runtime assertion here can see. The effect registering
`window.recShareLink` sat ABOVE most of the state it names in its dependency
array (`selectedDesks`, `availableMethods`, and now `showRefunds`). These pages
compile JSX in the browser, so `const` becomes `var`: the deps array evaluated
to `[..., undefined, undefined]` on **every** render instead of throwing, the
effect only ever ran on mount, and the registered closure was from that first
render — **so Copy Link was one change behind the screen, silently.**

The effect moved below everything it reads. The guard is the general form: take
that effect's dep array out of the source, and require every name in it to be
declared before the effect. It fails by name on the move.

Also fixed while in there: the print-mode desk branch tested `params.desks`,
which `getParams()` never returned — dead code whose comment claimed to be
belt-and-braces against the `#report-ready` race.

### Guards

`saved-views.spec.js` 51 → **65 assertions**. Its `ALLOW` list is now DERIVED
from `SAVED_VIEW_PARAMS.gl` rather than a hand-copy, or every byte-for-byte
assertion about the new keys is a comparison of two copies of the same guess.
Mutation-tested thirteen ways, all failing by name: the allowlist reverted (the
bug as it shipped), `generatePdf` dropping both again, an apply that only turns
the mode on, Default view leaving it on, the PDF and the stored view each losing
it, the URL leg dropped, the persist gate removed, `refunds` off the `getParams`
whitelist, the picker row reading *"no filters"* again, a stale `refunds=`
outliving its view, the PDF losing `gl_codes`, and the share-link effect moved
back above its deps.

**Four `ci-check-render.js` cases, keyed on the COMPUTED refund column count**
(`data-gl-refunds` / `data-gl-refund-mode`) rather than on a table existing: the
fixture's tenders give the split view five refund columns against the single
*"Total Refunds"* one, so a page ignoring the param renders a perfectly
plausible table. One of them drives `?_print=1&refunds=1` — the render Dan was
actually looking at. Verified to discriminate: dropping the URL leg fails
**exactly** the two URL-driven cases by name while the other eight keep passing.

## THE LOADING BAR PRINTED "usually about NaNm NaNs" (2026-09-09)

Dan, on Windham's Program Schedule mid-load: *"err this looks like a bug when
the page is loading."* It was, three ways at once, and every one of them came
from **a second renderer reading the shared helpers' arguments by hand.**

`programs-schedule.html` is vanilla JS (deliberately — see that section), so it
draws its own bar around the shared `window.loaderProgress`. That much is right.
What it did with the estimate was not:

| the call it made | what happened |
|---|---|
| `loaderEstimateNote(est)` where the signature is `(ms, basis)` | an object is **truthy**, so `if (!est) return ''` never fired, `basis` arrived `undefined` so the no-history guard never fired, and `fmtSecs(object)` rendered the literal **`usually about NaNm NaNs`** on screen |
| `loaderProgress(elapsed / 1000, est)` where it takes **ms** | measured by running it: **0.03% at five seconds, 0.26% at FORTY** — a bar that never visibly moves, i.e. the forever-spinner the bar replaced |

**THE SECOND ONE IS THE WORSE BUG and it is the one nobody reported**, because a
bar sitting near zero reads as "still working" rather than as broken. The NaN is
what got it looked at.

**And the `basis === 'default'` guard was being bypassed, which is the failure
that guard exists to prevent.** Windham has no recorded history for this report,
so the honest output is **nothing** — the loader must not dress a 25s default up
as *"usually about 25s"*. Passing the object defeated it silently: the note read
as measured history for an org that has never been timed.

### THE FIX IS ONE READER, not three careful call sites

`readEstimate` is exported as **`window.loaderReadEstimate`** (with
`loaderFmtSecs` beside it), and every caller reads the `{ms, basis}` shape
through it. The object/field mismatch cannot recur, which is the same argument
as `progAutopayCell` going through `progAutopayShare` and `siteLabel` having one
definition — *a second reader of a shape is a second chance to get it wrong.*

Two things were rebuilt rather than patched, because the page was missing them
and both are part of the shared contract:

- **The meta line is re-rendered every tick.** It was composed ONCE at start, so
  the elapsed count was absent and **the overrun state was unreachable** — a 93s
  apex load would have said *"usually about 8s"* forever. Elapsed is the one
  number on that panel that is not an estimate.
- **The 350ms show delay.** The page drew its bar immediately, so a warm cache
  flashed it for ~200ms — which reads as a glitch and makes a fast report feel
  slow, the exact thing `SHOW_DELAY_MS` exists for.

### NOTHING COULD SEE ANY OF IT, and that is the reusable part

`node --check` passes (it is valid JS), the page renders, the server boots, and
**`report-loader.spec.js`'s 44 assertions all passed** — because they cover the
CURVE and the estimate's derivation, and there was no case that RENDERED a bar
outside React. `ci-check-render` had twelve programs-schedule cases and not one
of them was about the loading state, since every stub answers instantly.

*Generalise it: a second renderer of a shared thing needs its own coverage. The
helpers were fine — every assertion about them was true, and the page still
printed NaN.*

### Guards

`report-loader.spec.js` 44 → **65 assertions**. The load-bearing half is
BEHAVIOURAL: it **lifts the page's own `startLoader` and runs it against a fake
DOM**, then reads the bytes it wrote — because every source assertion here would
pass on a renderer that composed the note some fourth wrong way. It drives two
bases (org history and none) at 200ms, 5s and 90s and requires: nothing inside
the show delay, no `NaN`, the elapsed count present, *"usually about"* present
for a timed org and **absent** for an untimed one, and at 90s a width that is
both moving and short of full.

**A harness trap in my own spec:** `report-loader.js` closed over
`sandbox.window`, so `readEstimate` reads `ORG_CONFIG` off **that** object — an
`Object.assign({}, sandbox.window, {ORG_CONFIG})` copy silently tested the
default branch twice and the org case proved nothing. It failed by name, which
is the only reason it was found.

Two source assertions generalise past this page: **no page may read
`ORG_CONFIG.loadEstimate` by hand**, and every call to `loaderProgress` is
checked for a `/ 1000` in its arguments.

Mutation-tested seven ways, all failing by name: the object passed to
`estimateNote` (the bug exactly as it shipped — the failure message reproduces
Dan's screenshot, `"5s · usually about NaNm NaNs"`), seconds fed to
`loaderProgress`, the raw config read by hand again, the `default` guard removed,
the show delay dropped, the meta line frozen at start, and the bar hardcoded to
a fixed width.

Plus `loader · the vanilla bar shows no NaN` in `ci-check-render.js` — the spec's
fake DOM proves the composition, only a browser proves the real page **wires it
up** and that the injected `ORG_CONFIG` reaches it. Verified to fail on the
shipped bug while the other four loader cases keep passing, and it requires an
elapsed count **and** no NaN: either alone passes on half the bug, since the note
really did read `5s · usually about NaNm NaNs`.


## THE CLASS ROSTER WAS SCOPED BY THE DATE WINDOW ALONE (2026-09-09)

Dan, on Hatha Yoga after the roster got fast: *"well it kinda does. but its much
faster now"* — over a roster reading **82 of 82** for a class that has **24**
people in it. Speed was the symptom; the number was the bug.

`section_id` rode in the URL and reached `buildMetabaseParams`, which dropped it
for every report except `section-detail`. The page then matched the section by
NAME, as a **substring, in the browser**. A name is not an identity.

**MEASURED AT CLARKSVILLE — sections that share a name:**

| name | sections | bookings |
|---|---|---|
| Water Aerobics Drop-In | **16** | 118 |
| Tico's Tsunami Swimmers | 9 | 55 |
| **Hatha Yoga** | **4** | **82** |
| Tico's Tidal Tots | 4 | 36 |
| ...eight more | 2 each | |

**AND IT DOUBLE-COUNTED PEOPLE, not just runs.** Over the window Dan's link
used, `section_name='Hatha Yoga'` returns **82 rows for 39 distinct people** —
somebody enrolled in two runs appears twice. `section_id` returns **24 rows for
24 people**. So a class of 24 was rendering as 82 lines covering 39 humans.

### THE COMMENT SAID IT WAS IMPOSSIBLE, AND THE COMMENT WAS WRONG

`buildMetabaseParams` carried: *"roster section filtering is client-side...
Passing section_name here would make Metabase reject the query (unknown
parameter)."* **Card 17296 has had a `{{section_name}}` tag with its own `[[ ]]`
block all along.** The claim was simply false, and it is why nobody looked
underneath it — the same failure as the *"organization.config holds no timezone
key"* note corrected on card 21649 the day before. **A wrong statement in a
comment is worse than no comment: it closes the question.** The spec now fails
if that sentence comes back.

### AN UNSTAMPED PARAMETER IS FATAL — measured, and it removed the ordering trap

Found while sequencing this change. Against the real card through the public
endpoint:

| | |
|---|---|
| three stamped parameters | **200**, 1 row, 0.97s |
| the same three plus ONE unstamped `section_id` | **HTTP 400** |

Metabase rejects the **whole query** rather than ignoring the extra. The wrapper
was passing an unknown slug through unstamped, so any card push became an
**ordering trap**: server.js starts sending a new tag and every request for that
report fails until a human saves the card with it — a window spanning CI, a
deploy, and whoever has Metabase open.

`enrichMetabaseCardUrl` **drops** a slug the card does not register now. The
parameter has no effect until the card advertises the tag, which is also right if
a card is rolled back, and it means the server half was safe to deploy before,
after, or without the push. **It is strictly better for the STALE-ID case this
wrapper exists for, too:** dropping yields `missing-required-parameter`, which
`_MB_STALE_ID_RE` catches and retries; passing through yielded a generic error
nothing recovered from. There was no case where sending it helped.

### `section_name` IS DELIBERATELY STILL NOT FORWARDED

Both filters stay on the card and answer different questions. `section_id` is a
link to ONE section and is exact. `section_name` is the report's **free-text
search box**, where a partial name is the point — forwarding it would put a
Metabase query behind every keystroke and give every search term its own feed
cache entry. The client-side name match also stays because it is what a
**pre-push cached feed** still needs: feeds cache four hours, so a tag-less
response and a scoped one are both live at once.

### The push, and what was proven BEFORE it

**Optional is load-bearing.** The report opens unscoped, so a non-optional clause
would fail every roster on the platform. Proven with no downtime, before writing
anything: with no `section_id` the new SQL is **byte-identical** to the live card
once comments are stripped, and the scoped shape adds **exactly that one clause**.

**`::uuid` is cast rather than typed**, so `section_id` survived the push as Text
with no re-flip — only the two DATE tags needed one.

The card came back registering **NINE** parameters (five real + four `string/=`
duplicates) and the roster was down for every org until Dan flipped, exactly as
this file predicts. After the flip: **five, no duplicates, both dates
`date/single`**.

**Sign-off, cache-independently through the public endpoint, over the window the
page actually sends (`daysAhead:14`, since `ROSTER_DEFAULT_DAYS` is 14 and
`roster` is in `FORWARD_REPORTS`):**

| org | rows | time |
|---|---|---|
| apex (heaviest) | 3,819 | 23.6s |
| watertown (Eastern) | 485 | 2.7s |
| clarksville | 54 | 1.0s |

**Additive, proven by re-reading the exact pre-push window:** unscoped
clarksville 2026-09-08 returned **47 rows / 3 sections / 22 columns** before the
push and **47 / 3 / 22** after.

### THE SHARED ROSTER CARD HAD NO MANIFEST ROW AT ALL

Found doing the sign-off — `31bdf26f` was in none of the 27 checks, so a lost
column or a re-Texted date tag on one of the most-used reports on the platform
would have surfaced as a blank roster rather than a failed check. Same gap
already recorded for waitlist and checkins. **Two rows now**, and the second is a
regression case rather than a duplicate: apex is the heaviest, and **watertown is
EASTERN** — card 17296 dates every row by `org.config primaryTimezone` while
Metabase renders Pacific, so a Pacific org structurally cannot catch a conversion
regression here.

**Both rows carry `daysAhead:14`.** Unwindowed they would ask for the org's whole
history — the mistake this file records for card 17301 v7 *and* card 21649, now
guarded against on a third card.

### AND THE programs-monthly ROW WAS REFUSING OUTRIGHT — third instance

Found in the full sweep taken for the roster sign-off. `programs-monthly / apex`
came back

```
missing-required-parameter: #{"end_date" "start_date"}   (HTTP 400, 0.1s)
```

and had been doing so since the row was added on 2026-09-01. **The 0.1s is the
tell** — a refusal, not load — so it never looked like the four genuine timeouts
sitting around it in the same output (`checkins/apex`, `fasttrack/apex`,
`instructor-payout/san-francisco-rec-park`, `programs/apex`, all known-heavy).

**THE ROW SENT NO DATE PARAMETERS AT ALL.** Card 21055 uses `{{start_date}}` and
`{{end_date}}` **BARE inside `generate_series`** — they bound the month series,
so unlike every other card here they cannot sit in an optional `[[ ]]` block and
cannot drop out. A dateless probe therefore cannot run at all, where the same
mistake on 17301 and programs-schedule merely asked for the org's whole history.

`days: 365`, **not** `daysAhead` — this is a BACKWARD monthly revenue rollup and
its own sign-off window was Sep 2025 → Aug 2026. Verified: **13 rows in 7.8s**.

**THE ROW'S OWN LABEL PREDICTED THE WRONG SYMPTOM**, which is part of why it went
unread for eight days: it said *"if this row starts returning 'An error
occurred.', the tags have been reset to Text"*. It was returning
`missing-required-parameter`, so nobody matching on the documented string would
have connected the two. **A guard that names the wrong failure mode is a guard
people learn to skim.**

**Third instance of the dateless-manifest-row bug in one branch** — card 17301
v7, both programs-schedule rows, and this. Worth stating as a rule: **a manifest
row for a card with date tags needs a window unless you have checked that the
card's tags are optional**, and which direction it needs depends on the report,
not on the script's default.

### Guards

`scripts/roster-section-scope.spec.js` (**43 assertions, in CI**), which LIFTS
AND RUNS `buildMetabaseParams`. Mutation-tested nine ways, all failing by name:
the server reverted to `section-detail` only (the bug as it shipped),
`section_name` forwarded, the card clause made non-optional, the `::uuid` cast
dropped, the pre-existing `section_name` clause deleted, the trailing `ORDER BY`
dropped (the card-17300 failure), the filter moved into a JOIN where it would
turn the LEFT JOINs above it inner, the false comment restored, and `section_id`
forwarded for every report.

`mb-param-ids.spec.js` 19 → **22**, driving the real wrapper against a fake
Metabase whose card registers `org_id` and not `section_id`. Mutation-tested both
directions: the unknown slug passed through again, and every parameter dropped
including the registered ones.

**A probe of mine failed and read as a card regression — third time this
session.** `{{org_id}}` is a **UUID**, and I passed the slug `clarksville`, so
`'clarksville'::uuid` 400'd and looked exactly like a broken card. The manifest
uses org UUIDs; check what a parameter actually holds before believing a 400.

**And Chromium cannot reach the sandbox proxy**, so the deployed page could not
be driven directly. The stronger check was to LIFT the SERVED page's own
`rosterWindow` and mapper and run them against the LIVE feed rows — that proves
what the deployed bytes do with production data, which reading the diff does not.

## THE PROGRAM SCHEDULE REPORT IS LIVE — card 21649 (2026-09-08)

Dan asked for *"an identical report to the facility rental report, but for
programs"* — by date, location and site, section AND session based, with the
instructor, a confirmed count and a link to each roster. Built, pushed, wired
and signed off. Page `public/programs-schedule.html`, card
https://rec.metabaseapp.com/question/21649, mirror
`sql/report-cards/21649-programs-schedule.sql`.

**IT IS VISIBLE ON ALL 29 ORG DASHBOARDS the moment this deploys.**
`allAvailable` in the `/:org` route is REPORT_TYPES minus non-addable/retired
where `SHARED_UUIDS[r]` exists, and `DEFAULT_HIDDEN_REPORTS` is empty — so
wiring the uuid IS the rollout. Nothing stages it per org; hiding it anywhere
is `reportHiddenForOrg`.

### THE SITE EXISTS, AND I HAD REPORTED THAT IT COULD NOT

The finding worth keeping, because I published the opposite first. I wrote,
with measurements, that a Site column would be blank for every row of every
org and that room-level detail was a product gap. Dan: *"it's in there
somewhere."* He was right. What my measurements had ruled out was three WRONG
PLACES, each conclusive-looking on its own:

- **`session.location_id` is ALWAYS a location.** Cards 17298 and 17295 both
  carry a `court` branch for it and it resolves a court for **0 of 24,579**
  sessions over a live window. Their branch really is dead code here.
- **There is no `session_court` join table**, and `location` has no parent
  column, so nothing nests.
- **`session.overrides` is a `text[]` of overridden FIELD NAMES**
  (`capacity`, `waitlistConfig`, `enrollmentMinimum`) — not a place a court id
  hides. (It is also why `jsonb_object_keys` errors on it.)

The answer is that **every program session gets a `reservation`** — 24,583 of
24,583 in a live window, 1:1 — and the site hangs off that reservation's
courts. `reservation.court_id` is legacy-NULL on every one of them, which
**this file already recorded** for SF's 557,367 facility reservations (*"the
site link is the `reservation_court` join table"*). I had the note and did not
apply it to programs.

Measured: **15,249 of 24,583 sessions (62%) across 75 orgs carry a site**, and
the name is `court.court_number`, populated on all of them — "Bridge Room",
"Ice - East Rink", "NHS -A Gym", "Outdoor Pickleball Court #5". Exactly the
shape Dan described: location required, site optional.

**Generalise it: a measurement rules out the PLACE YOU LOOKED, not the fact.**
Three empty results in a row read as proof and were three wrong joins.

**AGGREGATED, NEVER JOINED.** 1,444 of those sessions occupy more than one
site and one occupies **sixteen**, so joining `reservation_court` onto the row
set multiplies those sessions up to 16x and every enrolment figure with them.
The `site` CTE aggregates per session and ships **`Site Count`** beside the
name, the same reasoning as `location_count` on 17295 — "Gym A" alone is a
confident half-truth for a session that also holds the annex. The page renders
a *"2 sites"* chip rather than printing one room as though it were the answer.
The reservation is deliberately **not** filtered on `canceled_at`: a cancelled
session's reservation is how staff know which room just came free, which is
the whole reason cancelled meetings stay on this report.

### THE ROSTER LINK KEYS ON `section_id`, AND A NAME WOULD HAVE BEEN WRONG

Dan asked *"don't we have the section or session UUID in there somewhere?"* —
and he was right, card 17295 has emitted `section_id` all along and
`programs.html` already maps and uses it. So the link needed no new plumbing,
only the column on the new card.

**Linking by section NAME would open the wrong roster for one date-row in
seven.** Measured platform-wide: **60% of sections share their name with
another section**, and **14.4% of section-dates** would resolve ambiguously.
The link carries `section_id` plus the row's own single date, so it opens that
meeting's roster and not the run's.

- **No link where nobody is enrolled.** Absent, not disabled — the rental
  schedule's Forms rule.
- `roster-open` (📋) pings the activity feed per the standing rule, **debounced
  PER SECTION** — an admin working down a morning's classes is telling us about
  each class, not about one click — carrying the section and head count, both
  clamped server-side.

### THE ROSTER LINK CANNOT SCOPE A PER-SECTION ROW TO ITS OWN DATE (2026-09-08)

Dan, on the preview: *"this section had a roster link, which gave me 'no
results', but there are 6 people."* Reproduced and fixed — **my link, not the
roster.**

**Card 17296 dates a booking by `COALESCE(the session's own date, THE RUN'S
FIRST SESSION)`.** A `type='section'` booking has no `session_id` — those
people are enrolled in the *run*, not in a meeting — so every one of them is
dated by the first session. Measured on the section Dan opened,
`09.September Code: 9974` at Clarksville: `registration_mode = section`, **30
sessions from Sep 1 to Sep 30, 6 section bookings and 0 session bookings.** My
link asked for `start = end = Sep 10`, a date not one of them carries, so the
roster correctly returned nothing.

**A per-SESSION row keeps the single date** and is exactly right — its
bookings really do belong to that meeting.

**`section_name` NEVER REACHES METABASE.** `buildMetabaseParams` says so in a
comment: roster section filtering is a **client-side substring match in the
page**, and forwarding the parameter would make Metabase reject the query. So
the *window* is the only thing that decides what the feed contains, and the
name narrows it afterwards in the browser. That is why widening the window is
safe here — it cannot pull another section onto the screen.

**THE WINDOW IS FREE, and that is measured rather than assumed.** Same org,
cold, through the preview: **one day 54s, one month 49s, thirteen months
31s** — the widest was the *fastest*. The card's date test is a non-sargable
`COALESCE(...)::date` over a joined column, so it does the same work whatever
the window; that spread is replica load, the same tell as the apex numbers
above.

**Three years back was a bound rather than a guess, and it is now a FALLBACK
only.** Over **45,695** per-section runs, p99 span is **133 days** and p99.9 is
**361**, with **8** spanning more than two years (one artifact at 5,607 days) —
so no fixed lookback is provably complete, which is why the exact fix was worth
a card push.

#### THE EXACT FIX SHIPPED — card 21649 emits `Section First Session` (2026-09-08)

Dan: *"yes add that column to the card, i'll flip the tags."* `MIN(starts_at)`
over the section's whole run, so a per-section row's roster link asks for ONE
day again.

**IT IS THE ONE COLUMN ON THAT CARD IN A DIFFERENT TIMEZONE, deliberately.**
Card 17296 dates every booking by `org.config #>> '{general,primaryTimezone}'`;
card 21649's own `cfg` CTE uses the **majority `location.timezone`**. Those are
not interchangeable — measured, **they disagree for 22 of 168 orgs**, including
live ones (pawnee `America/Chicago` vs `America/Los_Angeles`, niagara-falls
`America/New_York` vs `America/Los_Angeles`, a three-hour gap). The column's
consumer is 17296, so it is computed 17296's way; every other column keeps the
card's own rule. **The practical cost of getting it wrong is small and real:
over 25,339 sections the two rules land the first-session date on a different
DAY for 6 of them** (niagara-falls, reno-sandbox).

**And it corrected a false comment of mine in the card**, inherited from this
file's Tyler-export section: *"organization.config holds no timezone key."* It
does — `primaryTimezone` is populated on all 168 live orgs. A wrong statement in
a card comment sends the next person looking in the wrong place.

- **Reproduced from 17296 rather than approximated.** Its LATERAL filters on
  `deleted_at IS NULL` **alone** — not `canceled_at`, and **not scoped by the
  window**. Scope it by `win` and a run that began before the window reports its
  first IN-WINDOW meeting, which is a different date and a link that finds
  nobody. Verified: **0 rows disagree** with 17296's own LATERAL.
- **ONE `GROUP BY`, not a per-section LATERAL** — the 17295 lesson, where the
  LATERAL cost more than it saved and timed out at apex. It drives from the
  already-windowed `sections` into `session_sectionid_index`.
- **Cannot fan out** (one row per `section_id`, verified 14/14), and clarksville
  still returns **45 rows / 45 distinct sessions** — the same figure as the
  pre-push sign-off, which is the additive proof.
- **PRESENCE-GATED ON THE PAGE.** Feeds cache four hours, so a pre-column
  response and a post-column one are both live at once; the lookback survives as
  that fallback and nothing else. A page that assumed the column would link to a
  date of `undefined`.
- **A single date per row is sound because NO SECTION MIXES BOOKING TYPES** —
  measured, **0 of 23,880** sections carry both `type='section'` and
  `type='session'` confirmed bookings.

### THE SECTION-BASED FILTER EMPTIED THE TABLE FOR EVERY ORG (2026-09-08)

Found while dry-running the column, from **a surprising zero**: a probe filtering
`reg_mode = 'per-section'` returned *"0 of 0 per-section rows"* on a page full of
them. Checked rather than reported — the rule this file already records — and the
page was right while my probe was wrong, which then exposed a worse bug.

**`registration_mode` holds `section` and `per-session`. There is no
`per-section`.** Measured: **138,802 sessions `section`, 22,023 `per-session`.**
`programs-schedule.html` built its grain buttons from a hardcoded
`['all','per-section','per-session']`, so **the majority grain filtered on a
string no row can ever match and emptied the table**, for every org, since the
page shipped.

**THE FIXTURE CARRIED THE SAME FICTION**, which is why eight render cases passed
over it: `"Registration Mode": "per-section"`. The button matched the fixture and
the fixture matched the button. *A test that supplies the value under test cannot
say whether anything supplies it in production* — already recorded here for the
Programs location filter, and reintroduced one page over.

The options are built from the ROWS now, with `grainLabel()` as the single label
definition read by both the row chip and the buttons — two copies is how a filter
stops matching the word the reader can see (the `Past`/`Ran` lesson). The case
keys on the row COUNT after the click: "a button rendered" and "a button that
filters to nothing" look identical otherwise.

**Sending only `end_date` would be exact and does NOT work**, which is worth
recording because it is the tempting answer: the card's optional
`[[ >= start_date ]]` block does drop out (verified — all six rows come back,
17s), but `roster.html` seeds its own state with
`p.get('start_date') || defaults.start`, so the PAGE fills the missing bound
back in and re-narrows to its 14-day default. *An optional clause the API
honours is not the same as a link the page honours.*

**AND THE RENDER CASE PINNED THE BUG.** Every fixture row was `per-section`
and the roster case asserted `start == end`, so it passed on the broken link
and would have failed on the fix — the same shape as
`report-settings.spec.js` requiring `disabled` on the gear. The fixture's
two-meeting section is `per-session` now, and there is a second case for the
per-section window.

### THE HEADER LOGO WAS NEVER STYLED, only used

Dan: *"the new programs report has a super-sized header/logo, should match the
other reports."* `.report-header-logo` was on the `<img>` and had **no CSS rule
anywhere in the file**, so the org mark rendered at its natural size.
`facility.html` carries `height: 42px; max-width: 140px; object-fit: contain`
— lifted verbatim, because the header is meant to match every other report.

**No source assertion can see this**: the class is present either way. The
render case reads the **computed** style rather than the rendered box, because
this harness serves nothing off-origin so the logo never loads and its box is
0 tall whether or not the rule exists.

The roster column is **named** now too (Dan: *"And name that column: Roster"*)
— a bare clipboard glyph in a header row is not a label.

### THE INSTRUCTOR IS A PER-DATE FACT

`session_facilitator` is populated on **48%** of sessions, so the card prefers
the SESSION's own facilitator over the section's and ships **`Instructor
Level`** saying which answered — a cover on one Wednesday is then visible
instead of being overwritten by the section's regular.

**A near-miss worth recording:** apex showed 1,653 instructors from session
level and **0** from section level, and I nearly reported card 17295's
instructor column as broken there. Checked first: the two levels track almost
exactly (apex 1,826 vs 1,810, watertown 317/311, el-segundo 140/139) — the
zero was an artifact of how I had scoped that one probe. *Check a surprising
zero against a second measurement before reporting it.*

### SCOPED BY CONSTRUCTION, unlike 17295 and 21286

Every CTE joins **from** a `win` CTE that applies the date window first, so
nothing computes the org's whole history and discards it — the shape that made
17295 spend 14.0s on `item_tx` for ten times the rows it could contribute to.
The bottom-level `[[ ]]` clauses live inside `win` rather than at the output,
which is why they cannot drift apart from it.

**DEFAULT WINDOW: today + 7 days, a week total** (Dan's call, to keep it off
the slow end). `DEFAULT_WINDOW_DAYS` is already 7 and `FORWARD_REPORTS` decides
the direction, so membership in that set is the entire server change. **The
PAGE derives its own default from LOCAL date parts** rather than reusing the
server's `toISOString().slice(0,10)`, because that is the UTC date — from 5pm
Pacific "today" is already tomorrow and a forward-looking schedule would open
having dropped this evening's classes. Same trap as the fasttrack dates.

### VANILLA JS, NOT REACT+BABEL — a decision, not laziness

Every other report page compiles JSX in the browser, which turns a `const` read
before its declaration into `undefined` two lines later instead of a throw —
the blank-page class this repo has shipped twice. There is no JSX here, so that
class cannot happen. **The loading curve is still the shared one**:
`window.loaderProgress` from `report-loader.js` is a plain function, so this
bar and every React report's bar are the same arithmetic and the spec that
pins the curve still covers it.

### THE PUSH→FLIP DANCE, and what it cost this time

All three tags came back **Text** on the API push, as this file predicts. Dan
flipped them; verified 2026-09-08 that the card registers **THREE** parameters
with both dates `date/single` — the shape the app actually sends — so there
were no duplicates to re-save away. The pushed SQL was **diffed back against
the mirror** before anything else, which is the guard that exists because card
17300 silently lost its trailing `ORDER BY` to transcription.

**Sign-off, cache-independently through the public endpoint, over the window the
app actually sends (today → today+7):**

| org | rows | time |
|---|---|---|
| apex (heaviest) | 801 | **93.0s** |
| watertown (Eastern) | 38 | 28.1s |
| clarksville | 54 | 1.2s |

**APEX AT 93s EXCEEDS THE APP'S 60s FIRST-TRY BUDGET** and falls to the 120s
retry, so apex leans on the 4-hour cache and is one busy minute from a slow load.
That is pre-existing — the `Section First Session` column was measured at
**+0.09s with an identical row count** — and it is the next thing worth looking
at on this card.

### THE SIGN-OFF ROWS SENT NO DATE WINDOW, AND THAT READ AS A CARD REGRESSION

Card 21649 timed out at apex three times — 120s, 200s, 200s — and the card was
fine. Both manifest rows carried no `days`/`start`/`end`, so `verify-report-live`
sent **no date parameters**, the optional `[[ ]]` blocks dropped out, and each
probe asked for the org's **entire history**.

**That defeats the card's whole design premise**, since every CTE joins FROM
`win` precisely so nothing is computed for a session nobody asked about. And the
app never asks it: `programs-schedule` is in `FORWARD_REPORTS` and **not** in
`NO_DATE_REPORTS`, so every real request carries today → today+7.

| org | unwindowed (what the row sent) | windowed (what the app sends) |
|---|---|---|
| watertown | 3,269 rows in 36.8s | **27–38 rows in ~1s** |
| apex | TIMEOUT past 200s, three times | **801 rows in 93.0s** |

**SAME MISTAKE THIS FILE ALREADY RECORDS FOR CARD 17301 v7, in my own words** —
*"the manifest's own norman row runs UNWINDOWED … the regression was predicted in
my own notes and I added a sign-off row for exactly that shape without connecting
the two."* Repeated three weeks later in the same file. **The labels made it
worse:** I pasted WINDOWED numbers into rows that send no window, so they read as
verified.

**AND `days` COULD ONLY LOOK BACKWARD**, which would have left a smaller version
of the same error. `relativeWindow` gives today−(n−1) → today, right for `gl` and
`memberships` and wrong for a forward-looking schedule — it would have tested a
week of sessions that already ran. **`daysAhead` is the other direction**, and a
row must use whichever one its report type actually gets; declaring both now
throws rather than silently preferring one. No other manifest row gains a window:
an empty result is a FAILURE here and a genuinely quiet week is not a broken card
(gl/littleton returns 14 rows over all time), so windowing everything would make
the check cry wolf on small orgs.

**THE COLUMN WAS EXONERATED BY A CONTROLLED A/B, not by argument.** Same session,
back to back at apex, every joined CTE aggregated so Postgres could not eliminate
an unused LEFT JOIN and gut the comparison: **104 rows without the `run` join,
104 rows with it, +0.09s.** An earlier suspicion that `run` was being inlined as
the inner side of a nested loop was **WRONG** and is recorded as wrong — the plan
is a Merge Left Join computed once, over 532 index lookups.

### THE ROSTER LOOKBACK WAS THREE YEARS, AND ONE QUIET MEASUREMENT PUT IT THERE

Dan: *"the clickable class rosters are brutally slow"*, then, on the window in
his own screenshot, *"bruh.....3 years?"*

I measured the roster feed **once, on an idle replica** — one day 54s, one month
49s, thirteen months 31s, the widest being the **fastest** — wrote down *"THE
WINDOW IS FREE"*, and set a three-year lookback on it. The mechanism was real but
half the story: the card's date test is a non-sargable `COALESCE(...)::date` over
a joined column, so a wider window costs no extra **index** work — but it still
**returns and ships every row in it**, and under load that is the entire cost. He
hit 2m42s with the roster falling back to stale cache.

**ONE QUIET MEASUREMENT IS NOT EVIDENCE ABOUT COST** — the same shape as *"one
org's clean data is not evidence about what a column MEANS"*, already in this
file.

**400 days now**, the measured bound: over 45,695 per-section runs p99 is 133
days and p99.9 is 361, so it still contains the run's first session for 99.9% of
sections at roughly a fifth of the rows. It is also **transient** — it runs only
for a feed cached before the column existed, at most one 4-hour TTL after a push.
Verified end to end afterwards: Dan's own section asks for the single day
2026-09-01 and the roster returns its **6 rows in 15.7s**.

**The render case could not tell the fix from the bug**: it asserted
`days > 365`, which passes on three years *and* on 400. It keys on the bound
itself now.

**The apex spread is replica load, not the card — the row count being
identical across all three reads is what says so.** An earlier apex probe timed
out at 60s and I did NOT report it as a finding, because a bare `pg_indexes`
CATALOG query timed out in the same minutes, which is the documented tell that
this replica is loaded.

**Two manifest rows**, and the second is a regression case rather than a
duplicate: apex is the heaviest, and **watertown is EASTERN**. Metabase renders
in `America/Los_Angeles`, so a Pacific org structurally cannot catch a
timezone regression here. Measured: watertown is `America/New_York` and the
card's own conversion moves every row three hours — a 6:00pm class reads
3:00pm without it, and an 8:00am class reads 5:00am, which **slips a day at the
window boundary**. Same reasoning that pins smyrna on fasttrack.

### Decisions on screen

- **Capacity renders `22 / —`, never `22/0`.** NULL capacity is unlimited, not
  zero — the `hasAbsent` rule.
- **Cancelled meetings stay, struck through, with the site.**
- **Unpublished sections are shown and MARKED**, with a toggle to drop them —
  21% of sessions in a live window belong to one and they still hold the room.
  Excluded is never hidden.
- **A status pill row appears only with two or more live statuses.** One status
  is not a filter, and a lone pill that can only empty the table is a dead end.
- **`SHARED_UUIDS` is a hardcoded literal**, like every other entry, so the
  report works on deploy with no Railway variable to remember. It was env-gated
  with omit-when-unset only while the public link did not exist — an omitted key
  404s the data route so the page shows the remedy, where a wired-but-erroring
  card would draw an empty schedule saying *"nothing is running this week."*

### The registry entry that is easy to miss

**The admin dashboard's own `reportMeta` gates the ADDABLE-reports list** —
`/api/admin/...` builds it from `reportMeta` minus non-addable/retired, so a
report registered in `REPORT_TYPES` with no `reportMeta` entry can never be
added to an org from the portal, silently. Three places need the description
and they are still three: `REPORT_DIRECTORY`, the dashboard's `reportMeta`, and
`REPORT_META` in `org.html`.

**And the dashboard's copy lives inside the giant template literal**, so its
`desc` is worded WITHOUT an apostrophe rather than escaped — one bad quote
there discards a 201KB script and every button on the page silently stops
working. `ci-check-admin-js.js` is the only check that sees it.

### THE PAGE ITSELF SHIPPED AS A BINARY FILE — the NUL trap, in real code

`NONE`, the *"no instructor / no site"* sentinel, was written as a **raw NUL
byte** rather than `\u0000`, so git classified `public/programs-schedule.html`
as **binary** and `grep` refused to search it. A file that cannot be read in a
diff cannot be reviewed. **Already recorded in this file for `LOC_NONE` in a
spec, and I reintroduced it in the report itself** — the write-up did not stop
the second instance because it named the spec rather than the property.

Two follow-ons cost real time: **`perl -0pi` splits records ON NUL**, so a
substitution targeting one silently never matches, and
`grep -cP '[\x00-...]'` returns **0** for NUL. Read and write the bytes in
Python.

### Guards

**The report shipped with NO render coverage at all** — the state the waitlist
report was in while its central number stayed wrong for months. Eight
`ci-check-render.js` cases now, over a fixture where **every row is a different
state**, because six rows of markup look identical under most regressions worth
catching: a two-site session (the aggregated-not-joined case), the same section
on a second date, a session with no site and NULL capacity, a per-session
facilitator standing in for the section's, a cancelled empty session, and an
unpublished section that still holds the room.

Every case keys on a computed value or an absence: the row COUNT (so a card
that joined `reservation_court` instead of aggregating it moves it), the
two-site chip, `9 / —` present **and** `9/0` absent, the cancelled row present
while its roster icon is absent, and the unpublished toggle moving the count
**6 → 5** — a case keyed on the checkbox existing passes on a toggle wired to
nothing. Two hooks (`data-ps-rows`, `data-ps-window`) were added to the page
for it.

**The roster case reads BOTH hrefs of the section that meets twice** and
requires `section_id=sec-tot`, `start == end`, and the two dates to DIFFER.
That is the assertion that catches a link keyed on the section NAME (which
would open the wrong roster for one date-row in seven) and one carrying the
run's dates instead of the meeting's.

**`tz` IS A NEW PER-CASE HARNESS FIELD** (`page.emulateTimezone`), and **the
zone alone is not enough**. This sandbox and GitHub Actions both run UTC, where
a date built from `toISOString().slice(0,10)` and one from local parts are
identical — the decorative-timezone-pin trap already recorded for
`fasttrack-dates.spec.js`. But a zone behind UTC only separates the two
derivations between 5pm and midnight local, so the case would still have been
decorative for seventeen hours a day. **So the clock is pinned as well:**
`2026-09-09T05:00Z` is `2026-09-08 22:00` Pacific, so the UTC date is Sep 9 and
the local date is Sep 8, always. The label must read `September 8`, must NOT
read `September 9`, and must not read `Invalid Date NaN`. (Asserting a short
`Sep 8` reports "other" on a perfectly good label — `fmtRangeLabel` writes the
month in full.)

**The beacon is spied on `fetch`**, not read from resource timing — `keepalive`
requests do not reliably appear there — and it asserts the event NAME and the
section, because a JSON body instead of `?event=` 400s silently and has bitten
this repo four times.

**BUT THE RENDER CASE CANNOT PROVE THE SERVER ACCEPTS IT**, and says so: every
`/api/` request the browser makes is answered from `STUBS`, so the page never
reaches the real log route. That half was proven by booting the real server and
POSTing the real beacon — **HTTP 200 `{ok:true}`, and the row lands in
`events.jsonl` carrying `"section":"Tot Lessons AM","enrolled":22`** — plus the
inverse, that the old **JSON-body-with-no-`?event=`** shape still answers
**400**, which is exactly what was silently shipping on four surfaces. Boot the
server with `SKIP_PREWARM=1` and a huge `PREWARM_STARTUP_SKIP_MS` for this, or
the check fans ~28 orgs out against production Metabase — the
run-the-sweep-alone rule applied to one's own verification.

**A NEW STUB MUST GO ABOVE THE GENERIC `/api/data` ONE, not merely above the
catch-all `/api/`.** `STUBS` is searched with `.find`, and
`/\/api\/data/` matches `/:org/programs-schedule/api/data` too — so it
answered first and the page rendered six rows of *another report's shape*.
**The diagnostic signature is worth memorising: the row-COUNT case PASSED
while every case about a VALUE failed** — six rows arrived, so `data-ps-rows`
read 6, but every capacity read `0 / —`, every instructor was absent and the
location said "Topaz Lake". Same fall-through that once left the Facilities
hub's own feed on `rows: []` with three lane cases reporting green.

**And the mutation RUNNER was wrong twice before any mutation was.** Both are
the same class as the render check that printed `CASES.length` on a filtered
run matching nothing, and both would have reported a green suite:

- Its verdict grepped for `"uncaught error"` — a **substring of the harness's
  own SUCCESS line**, *"N page(s) render with no uncaught errors"* — so every
  surviving mutation read as caught. *A runner that cannot say "survived" has
  not tested anything.*
- The replacement counted printed ticks, and **"no ticks" is not the same as
  "the filter matched nothing"**: a single case that FAILS prints no tick
  either, so a genuinely caught mutation was reported VACUOUS. It reads the
  summary line now, tells the three states apart, and **requires the case that
  failed to be the one the mutation names** — otherwise a mutation that broke
  something else entirely reads as caught.

**`ci-check-render.js` itself had the bug on its FAILURE branch**, which is why
that was believable: the success line was fixed to report `running.length` and
the failure line still said `CASES.length`, so a filtered run printed
**"1 of 281 page(s) did not render"** — which reads as one flake in a full
sweep rather than as the only case that ran having failed. Fixed.

**And the case filter must be plain ASCII.** `"programs-schedule ·"` reached
the harness as `"programs-schedule ??"`, the middot mangled in transit, so the
run matched nothing.

**Mutation-tested twelve ways, all caught, each naming its own case:** the
roster link keyed on the section NAME, the roster link carrying the run's dates
instead of this meeting's, NULL capacity rendered as 0, the multi-site chip
dropped, a roster icon offered where nobody is enrolled, the unpublished toggle
made inert, the window default built from the UTC date, the beacon never
firing, and — for the first-session column — the column ignored, the presence
gate dropped (a pre-column feed linking to `undefined`), the column mapped but
never read (the mapped-and-rendered-nowhere pattern, **fifth instance**), and
the grain buttons hardcoded again. A thirteenth was proven by accident — the
stub moved back below the generic `/api/data` one, which is how the first run
failed 7 of 8.

**Twelve cases now.** The three added with the column are the per-section link
asking for the run's first session, a `prefirst` feed falling back to the
lookback, and the section-based filter keeping its rows. **The per-section case
keys on WHICH day, not on `start == end`** — equality alone passes on the
ORIGINAL bug, where both ends were the row's own date — so `data-ps-date` was
added to the row as the hook that lets it compare the two.

Note `scripts/ci-check-html.js` cannot run in this sandbox
(`@babel/standalone` is not installed locally); it runs in CI, and this page
has no JSX for it to compile anyway. The page's single inline block was
parse-checked directly instead.

## PINNED: feature-adoption sparklines on the ORG DASHBOARD (Dan, 2026-09-08)

*"pin a quick item for the org-dashboard feature adoption, the sparklines
showing trends on feature adoption and use."*

**It belongs in rec-dashboard, not here** — same line as the Coffee Chart:
a dashboard is the place for a live trend, a report answers a question about
a window somebody chose. Pinned in this file because the DATA is here.

### The shape already exists

`refreshOrgPulse()` in rec-dashboard already draws a sparkline per card (the
Bookings one) off a six-month feed, with a delta and a pace figure. Adoption
cards are that component with a different series, which is most of why this is
"quick".

### WHICH ADOPTION — the question to settle before building

*"Feature adoption and use"* reads two ways and they have nothing in common:

| reading | source | state |
|---|---|---|
| **our reports** — which of the 23 report types an org actually opens | this repo's event log | **ready**: 96,779 events, ~600/day, and `/api/admin/report-activity` already aggregates it per org/report |
| **Rec product features** — waitlists, autopay, fast track, instant booking | the rec.us database | a different build; every figure needs its own query |

The first is a week's work and is the one the pulse can draw today. The second
is the more interesting question and is not a sparkline job.

### Four traps, all already recorded in this file for other surfaces

- **PREVIEW TRAFFIC IS IN THE LOG.** The 2026-08-29 fix gated Slack *posting*
  to production; it did not stop preview environments **writing** `view` and
  export rows. So any adoption trend crossing that date is contaminated by
  whatever was being tested that day, and a rising line may be us. Establish
  where the contamination starts before drawing a 12-month series.
- **`NON_USAGE_EVENTS` is the denylist that keeps this honest.** `report-down`
  is logged against the real org/report, so counting it as usage lets a broken
  report look adopted — the exact loop `getReportActivity()` was built to avoid.
- **An empty window is not zero adoption.** A fresh volume, a rotated log or a
  short history must render *"since <date>"* rather than a confident flat line
  at zero — the `covers` / `logStartsAt` treatment the campmap activity strip
  already uses, and `failsafe: true` on the activity route.
- **No trend under a floor.** Precedent in this repo: trend arrows refuse to
  draw under 14 elapsed days, `RATE_MIN_VIEWS = 20`, `FEEDBACK_MIN_RATINGS = 5`.
  A sparkline over three data points is a picture of noise.

### And say which events the line counts

`view` alone would understate badly — the six Program Summary bands have **zero**
`view` events by design and are fetched by `programs.html` for ~15 orgs apiece.
Any adoption figure has to count every usage event, exactly as
`getReportActivity()` does, or it reports the platform's most-used surfaces as
unused.

## Card 17301 v7 — PUSHED AND IT IS A REGRESSION (2026-09-04)

**READ THIS BEFORE ANYTHING BELOW.** v7 is live on card 17301 and it TIMES OUT
for every org tested except Pawnee. Measured after the tag flip, through the
public endpoint, one probe at a time with nothing else touching the replica:

| org | v6 (proven) | v7 (live) |
|---|---|---|
| pawnee, 13 months | 7.9s | 100 rows in 29.9s → 20.9s → 2.1s |
| norman, no dates | 25.8s | **TIMEOUT past 200s** |
| norman, 13 months | — | **TIMEOUT past 200s** |
| norman, ONE MONTH | — | **TIMEOUT past 170s** |
| clarksville | 3.9s | **TIMEOUT past 200s** |

**THE ONE-MONTH NORMAN RESULT IS THE IMPORTANT ONE**: a one-month `win` is tiny,
so the cost is not proportional to the window. Scoping is not what saves this
shape and v6's win did not carry over.

### HOW A CHANGE PROVEN THREE WAYS STILL SHIPPED BROKEN

The equivalence work was sound — 157k groups, zero diffs, and it was deliberately
re-run against the shipped OR shape. **The TIMING was not.** The 2.3s figure came
from measuring `tx_oi` alone with a single `IN`; the shipped `tx` has an OR of two
`IN` subqueries and was never timed. I proved the values of what shipped and the
speed of something else, then wrote 2.3s into the card comment, the mirror, the PR
and this file as though it described the deployed query. **Prove the speed of the
exact text you are pushing, not of the fragment you developed.**

Compounding it: the manifest's own norman row runs UNWINDOWED (no `--start`/`--end`
sends no date parameters at all, so the `[[ ]]` blocks drop out), and I had already
measured and written down that the unscoped base path times out past 60s. The
regression was predicted in my own notes and I added a sign-off row for exactly
that shape without connecting the two.

### THE MECHANISM, FOUND 2026-09-06 — THE OR SPANNED THREE TABLES

**Full write-up with the plans and the numbers:
`sql/report-cards/17301-v7-DIAGNOSIS.md`.** The short version:

v7's `tx` OR'd two predicates that **do not live on the same table** —
`oit.order_item_id IN (win)` (on `order_item_transaction`, and separately
indexed) OR `oi.product_type='product' AND (o.customer_user_id, oi.name) IN
(win orphans)` (on two **joined** tables). Postgres cannot evaluate an OR until
every column in it is available, so **both** index-usable predicates were
demoted into a `Join Filter` on the outermost nested loop. The plan therefore
bitmap-scans the org's **entire** `order_item_transaction` on `organization_id`,
index-joins `order_item` and then `order` to every row, and only then filters.

**`win` appears solely as the two hashed SubPlans, evaluated LAST — so
narrowing the window narrows nothing.** That is precisely the one-month-norman
result, explained rather than merely recorded, and
`order_item_transaction_order_item_id_index` is never touched.

Measured at clarksville, unwindowed, 95,988 transactions and **zero orphans**
(so arm 2 matched an empty set and it still timed out):

| shape | |
|---|---|
| arm 1 alone, no joins | **2.7 s** |
| arm 1 alone, with the two joins | **45.9 s** |
| the shipped OR of both | **timeout past 200 s** |

**THE TWO EARLIER DIAGNOSES WERE BOTH RIGHT ABOUT WHAT THEY LOOKED AT**, which
is why they cleared it: `orphan_items` really does not scan the org, and the
subplans really are hashed behind a bitmap index scan. What neither noticed is
that the bitmap index scan is on `organization_id` **alone**, and that the
selective predicate sits **above two nested-loop joins**. A cost estimate
cannot show that; the plan SHAPE can. **Read `EXPLAIN (COSTS OFF)` for shape
before reading any cost** — and prefer `BUFFERS` to wall clock on this replica,
whose load varies enough that a bare `pg_indexes` catalog query timed out at
60s in the middle of this session.

**The fix is proven faster and is NOT built.** Never OR them: one CTE per arm,
and drive `tx_oi` FROM the window INTO the `order_item_id` index rather than
from the ledger — it needs **no joins at all**, since `order_item_id` and
`amount` are both columns on `order_item_transaction`. Norman, the heaviest
org, over the thirteen-month window: **3.5 s** against v6's 25.8 s for the
whole card. The fallback is its own trivially cheap CTE — re-measured, there
are still **10 orphan rows on the entire platform across 2 orgs, of 131,498**.
**And the new shape is value-identical where it has been tested**, proven rather
than assumed, because v7 shipped broken by inheriting a proof of a different
shape. `FULL OUTER JOIN` per order item over the thirteen-month window:
clarksville **12,213 groups** and norman **20,448**, with **0 rows on either
side alone, 0 paid diffs, 0 refund diffs** and totals identical to the cent
($124,889.29 and $406,353.50 paid). The base side's
`deleted_at IS NULL AND confirmed_at IS NOT NULL AND credit_id IS NULL` comes
from the partial predicate on `order_item_transaction_item_log_period_index` —
the item log's own notion of a countable transaction — and zero diffs over
32,661 groups is what confirms that reading.

**That covers `tx_oi` only** — the precise arm, two orgs, one window. The
fallback on base tables, the unwindowed shape prewarm sends, and an end-to-end
comparison of the card's own rows are all still owed, as is the tag flip.

### WHERE IT STANDS

**The rollback WAS executed and card 17301 is v6 today** — re-read live
2026-09-06: v6's SQL byte for byte, and the tag list is the correct THREE
(`org_id` text, `start_date`/`end_date` date). This paragraph used to say the
rollback had been recommended and not carried out, which was stale, and a note
claiming outstanding work costs as much as one claiming work is done.

The v7 mechanism is now known (above). A v7.1 is a real win and is NOT started:
it owes the full equivalence gate over the new shape, and a push plus a date-tag
flip that 400s the Memberships report for every org until a human re-types both
tags. Develop it on a SCRATCH card compared against 17301 through the public
endpoint, so the diagnosis half costs no downtime at all — as this pass did.

**Also worth knowing, found on the way:** `memberships` is in `NO_DATE_REPORTS`, so
prewarm sends `org_id` alone and asks card 17301 for the org's whole history every
morning. The page never does — `defaultDates()` is the current calendar month — and
prewarm's dateless entry carries a different parameter string from anything the page
requests, so that query has always been unreadable by the page. Under v6 that is
a wasted 25s every morning, on the heaviest card on the platform, for an answer
nothing can read.

## The base-table payment path, as originally written up (2026-09-04)

Dan: *"lets explore the bigger win for order item transactions"* and then
*"lets do it"*. Explored, measured, gated three ways, and pushed. **Card 17301
no longer reads `materialized.item_log_report` at all.**

### THE COLUMN THAT BLOCKED IT IS `order_item.product_type`

The earlier attempt died on `column oi.type does not exist` and I recorded the
fallback as needing discovery. The discovery is one query: `order_item` has
**`product_type`**, not `type`, and the customer key is
**`order.customer_user_id`** — which equalling the item log's `customer_id` is
now proven rather than assumed.

### EQUIVALENCE: two orgs, whole history, ZERO diffs

| | item log | base tables |
|---|---|---|
| **pawnee** `tx_oi` groups | 1,628 | 1,628 |
| **pawnee** `tx_cust` groups | 311 | 311 |
| **norman** `tx_oi` groups | **115,053** | **115,053** |
| **norman** `tx_cust` groups | **41,947** | **41,947** |
| norman paid | **$1,866,181.26** | **$1,866,181.26** |
| norman refunded | **$55,550.65** | **$55,550.65** |

0 presence diffs, 0 value diffs, identical to the cent. Plus a **row-by-row**
gate over Pawnee's thirteen-month window: 100 rows, 0 paid diffs, 0 refund
diffs.

Note `order_item.deleted_at` is deliberately NOT filtered — it was left out and
the diffs came back zero across 157k groups, so matching the item log means not
filtering it. Settled empirically rather than guessed.

### THE INDEX IS NOT ENOUGH ON ITS OWN — and this corrects what I told Dan

I said the base tables would take this *"from seconds to milliseconds"*, on the
strength of CLAUDE.md's card-20197 figure (464ms). **That measurement was one
org-MONTH.** Unscoped over Norman's whole history the base path **TIMED OUT past
60s** — 115,053 order items is a big aggregate however well indexed.

**It is the COMBINATION.** Scoped to the window AND on the base tables, Norman's
full thirteen-month payment aggregate is **2.3 s**, reading 20,535 transactions
instead of the org's entire ledger. Against v6's 25.8s for the whole card, that
is the remaining cost almost entirely gone.

| | pawnee (Dan's window) | norman (heaviest) |
|---|---|---|
| v5 (deployed until today) | timeout past 300s | — |
| **v6 (live now)** | **7.9 s** | **25.8 s** |
| v7 candidate, payment aggregate alone | ~1 s | **2.3 s** |

### THE FALLBACK SERVES TEN ROWS ON THE ENTIRE PLATFORM

The measurement that reframes all of this. Of **130,886** membership/pass
purchase rows platform-wide, the number with no `order_item_id` — the only rows
`tx_cust` can ever serve — is **10**, across **2** orgs
(`apex-park-and-recreation-district` and `apex-sandbox`), **all created on one
day, 2025-12-16**, with product names including *"Test Membership"* and
*"Renew Active"*.

So a full scan of a 1230 MB single-index table, on every Memberships load for
every org, existed to decorate **ten test-looking rows**. **v6 already fixed
that** — its scoped pass pulls fallback rows only for orphan pairs, which is an
empty set for 99.99% of org-windows.

**The fallback is NOT deleted.** The card's own comment says it is for desk/admin
sales, the shape could recur, and removing a correctness path because today's
data does not exercise it is how a silent wrong number gets born. What changed is
that its COST is now proportional to its use.

### THE FALLBACK GATE, closed before the push

The one gate left open was the fallback exercised END-TO-END by a real window
row — every other proof tested it at the CTE level. **Closed:** for all ten
orphan rows on the platform, the base path finds **zero** matching order items
AND the item log finds **zero** rows, so both return $0 and agree. The fallback
contributes nothing to any number anywhere today, and the two paths agree that
it does.

### IT REVERSES A RECORDED DECISION, deliberately and narrowly

The `materialized`-schema section says *"index the table, do NOT rebuild the
cards on base tables"*. **That decision stands for the Tyler FINANCE export**,
where divergence would land in a document handed to a finance office and where
the derivation is a per-method CASE ladder. It does **not** survive here, and
the difference is worth stating: this card's derivation is two `SUM…FILTER`
expressions, and the equivalence is measured over two orgs' entire histories at
157k groups with zero diffs rather than argued. Dan made the call
(*"lets do it"*); the earlier decision is not silently overwritten.

**And it does not retire the index ask.** v7 would take card 17301 off
`item_log_report`; cards 17293, 20197 and 17295 are still on it.

## THE RETENTION TAB WAS REWRITING THE REPORT'S DATE RANGE (2026-09-04)

Dan: *"The first few tabs, if they are scoped to the prior 30 days, is fast. But
once you hit the retention report, the filters change to a year. Then the report
tries to load an entire year's data, even if you flip back to the other tabs.
that doesn't seem right."* And then the rule: *"switching back to another tab
shouldn't change the date filter without me explicitly changing it."*

**ONE LINE CAUSED THREE SEPARATELY-REPORTED BUGS.** Clicking Retention ran

```js
var w = mbRetentionWindow(startDate, endDate);
if (w.changed) { setStartDate(w.start); setEndDate(w.end); setActiveRange(null); fetchData(w.start, w.end); }
```

— a tab-local view **silently redefining the whole report's window**, with
nothing anywhere putting it back. What followed:

1. **Every later tab switch re-queried thirteen months** — the *"not all data for
   tabs is caching… it's super slow"* pin. Nothing was wrong with the cache:
   `feedCacheKey` includes the parameter string, so the widened window is a
   different key, and `ensureCheckins` correctly refetches for a window it has
   not seen. **The cache was working; the window had moved underneath it.**
2. **The header disagreed with its own date inputs.** Dan's screenshot reads
   *"Sep 1 – Sep 30, 2026 · 152 memberships"* over Start/End boxes saying
   **09/04/2025 – 09/30/2026** — because `data` was still September while the
   inputs had been rewritten.
3. **It is how a hand-typed thirteen-month window came to be asked for at all**,
   which is what then hit the 504 recorded above. So the 504's *proximate* cause
   was this, not the user.

### THE FIX: the cohort chart gets its own window and its own rows

`retRows` / `retWin` / `retLoading` / `retErr`, fetched by `fetchRetention()`
through `ensureRetention()`. **`startDate` and `endDate` are never written.**

- **The panel reading `data` is what FORCED the widening.** While the chart was
  built from the report's rows, the only way to get twelve months into it was to
  widen the report. `buildCohorts(retRows)` is what makes the decoupling
  possible, so the two changes are one change.
- **`mbRetentionWindow` is UNCHANGED**, and its existing assertions still hold —
  it still derives the twelve months, it is just **read** from the report's dates
  and never written back. Same rule as the Failed check-ins toggle, which scopes
  its own panel and nothing above it: **a tab may show more than the window, it
  may not change it.**
- **Cached by window** (`retWin !== key`), like `ensureCheckins` — flipping onto
  Retention twice must not re-run a twelve-month query.
- **The panel NAMES its own window on screen** (`data-ret-window`), because it
  deliberately covers more than the header and a cohort chart quietly
  disagreeing with the dates above it is how a number stops being trusted.
- **Absent, never an empty chart, when the feed fails** — a cohort chart drawn
  from nothing reads as *"nobody retains"*. Loading / error / empty are three
  distinct states now (`data-ret-state`), where before there was one message
  telling the reader to click Run Report.
- **Rec Insights reads `retRows`** too, or the model describes the toolbar's
  window while the reader is looking at twelve months.

**NOT PREFETCHED, deliberately.** Dan offered *"even if retention was loading in
the background, that would work too"* — but a background fetch would fire a
twelve-month query on **every** Memberships page load, for every org, on the
slowest card on the platform (see the 504 section: ~40s per item-log scan). It
fetches on click and caches by window instead. Worth revisiting if that card ever
gets fast.

### `mbRangeLabel`

New, at module scope so a spec can RUN it. Two guards, both load-bearing:
`'T12:00:00'` rather than a bare ISO date (`new Date("2026-09-01")` is UTC
midnight and renders as Aug 31 west of UTC — **five** instances of that in this
file now), and an `isNaN` check, because an unguarded formatter renders the
literal **"Invalid Date NaN"** on screen between mount and the feed answering —
the `winLabel` lesson from the Programs summary, one report over.

### Guards

`memberships-revenue.spec.js` 82 → **90 assertions**, lifting and RUNNING
`mbRangeLabel`, and **slicing the Retention tab button's own handler** — a
file-wide `setStartDate` test proves nothing, because the date inputs and the
range presets legitimately call it. Mutation-tested: the button rewriting the
dates again (the bug exactly as Dan hit it), the panel back on `data`, the
per-window cache dropped, the label parsing a bare ISO date, and the `isNaN`
guard removed.

**Two of my own mutations were BENIGN and that is worth recording**: dropping the
`if (!d) return ''` early return survives, because the `isNaN` check already
covers null — so the early return is belt-and-braces and the `isNaN` is the real
guard. Distinguishing the two is the point of mutation testing; reporting the
first as "caught" would have been wrong.

Plus two `ci-check-render.js` cases. **No source assertion can prove this one** —
the handler can look correct and a downstream effect can still rewrite the
inputs — so the case reads the date inputs' VALUES either side of the click and
requires them identical. Verified to fail on the real bug. The second case
requires the cohorts to still draw, because a case that only checked the dates
would pass on a Retention tab that renders nothing at all.

**AND THE ESCAPE GUARD CAUGHT MY OWN COPY.** I wrote `\u2014` and `\u2026`
inside JSX **text**, which is not a string literal — they render as the literal
characters. The global unrendered-escape assertion added hours earlier failed on
it immediately. Same class as the `\uD83D\uDD01` that reached the Auto-Renew
tab; the guard paid for itself the same day.

### The third instance of the report-goes-last trap

My new spec block was appended **after** `console.log(passed + " assertions
passed.")`, so all eight assertions ran, incremented the count, and could never
be reported — the count stayed at 82 and I nearly read that as "no new
assertions needed". Third time in these two repos. **If a spec prints a summary,
that print must be the last statement in the file.**

## The Memberships summary 504 on Pawnee (2026-09-04)

Dan: *"memberships report summary page is struggling"* — Pawnee, 09/04/2025 to
09/30/2026, the KPI cards showing 49 active / 22 canceled / 78 expired / $7,965
net collected while the panel under them read **"Server returned 504"**.

**Both halves of that screen are explained, and they are different bugs.**

### THE KPIs WERE THE PREVIOUS WINDOW, not a half-loaded one

`fetchData` sets `error` and leaves `data` alone, so a failed re-run keeps the
last successful window's numbers on screen under a fresh error banner. Nothing
is wrong with that in itself — but it means **the figures a reader is looking at
when they see the error are for a range they are no longer asking about**, and
nothing on screen says so. Not changed here; worth knowing before diagnosing
one of these from a screenshot.

### THE CARD GENUINELY CANNOT ANSWER THAT WINDOW

Measured cache-independently through the public endpoint (`verify-report-live`),
card 17301, Pawnee:

| window | result |
|---|---|
| 2025-09-04 → 2026-09-30 (Dan's) | **TIMEOUT past 300s** |
| 2026-09-01 → 2026-09-30 | **55.0s — and ZERO rows** |

**A one-month window with no output rows at all still costs 55 seconds**, which
is where the cause is: the work is not proportional to the answer. Card 17301's
`tx_oi` and `tx_cust` CTEs each scan `materialized.item_log_report` filtered on
`organization_id` ALONE — the date window is applied only at the very bottom,
against `mp.created_at`. That table has **exactly one index, its primary key**
(2.26M rows, 1230 MB), so each is a full parallel seq scan, and the card does
**two of them per load**. Timing one alone exceeded the 60s tool ceiling.

So 55s is the FLOOR for any Pawnee memberships load, against a 120s budget —
every org-month is one busy minute away from a 504. This is the fourth card with
this exact shape (17293, 20197, 17295 and now 17301); see the
`materialized`-schema section, whose measured conclusion — **index the table,
do not rebuild the cards on base tables** — still stands.

**AND THE STALE-CACHE SAFETY NET STRUCTURALLY CANNOT HELP HERE.** The timeout
path tries `getStaleCached(...)` first, but `feedCacheKey` includes the encoded
parameter string, so **every distinct date range is its own entry** — a window a
person types by hand has never been warmed and has no stale entry to fall back
on, ever. That is why Dan got a 504 instead of stale numbers.

### WHAT WAS FIXED: the page was throwing the answer away

The data route already sends back a sentence that says what to do:

> `Metabase query timed out after 60s+120s retry — try a shorter date range or refresh`

...and **eight report pages threw `new Error("Server returned " + r.status)`,
dropping the body.** So the reader was told the transport and not the remedy, on
a failure whose remedy is one control away — the dead-end pattern this file
keeps writing down, and here the remedy is not a platitude: the same report over
one month returns.

`reportFetchError(r)` reads it, in **`public/open-pdf.js`** — the file every
report page already loads, because eight copies of the recovery would drift the
first time the route's wording changed.

- **IT MUST NOT ASSUME JSON.** A 502/504 from Railway's edge never reaches the
  app and comes back as an HTML page, so a bare `r.json()` on the error path
  would throw INSIDE the error handler and replace a poor message with a
  confusing one. Anything unparseable falls back to the status code — exactly
  today's behaviour — so this can only ever improve a message.
- **The status still travels with the sentence.** *"Which failure was it"* is the
  first thing asked when one of these is reported, and a sentence alone loses it.
- **A 504 with no readable body still says what to try**, because that is the
  edge-timeout case and it is the one where the page has nothing else to go on.
- **`metrics.html` is deliberately untouched** — it does not load `open-pdf.js`,
  and a call to a function that is not on the page is worse than the old throw.
- **`throw await` needs an ASYNC arrow.** Four of the seven call sites were
  one-liners and three were blocks, and a non-async arrow makes this a
  SyntaxError that takes the whole babel block with it — the blank-page class
  this repo has shipped twice, and invisible to `node --check` because the code
  is a string inside an HTML file. The spec walks back from every
  `throw await` to its owning arrow.

### CARD 17301 v6 — PUSHED AND SIGNED OFF (2026-09-04)

Dan: *"i'm here to flip the mb report, it can't take 2 min to run that
memberships query, that's crazy"*. He is right, and the measurement says exactly
where it went:

| | |
|---|---|
| everything in the card EXCEPT the two payment CTEs, over the 13-month window | **559 ms / 100 rows** |
| ONE scan of `item_log_report` for Pawnee | **39.9 s** (1,774 rows out of 2.26M) |
| ...and the card did **two**, unwindowed | |

So **99.3% of the report was the org's entire payment history, computed to
decorate 100 rows.**

v6 lifts the card's own output filter into a `win` CTE and uses it to scope ONE
`MATERIALIZED` pass feeding both aggregates. **The bottom `[[ ]]` clauses stay as
the authority** — deleting either is how two predicates drift apart silently
(the `sec_win` lesson from 17295). `MATERIALIZED` is load-bearing rather than a
hint: without it Postgres inlines the CTE and scans once per reader again.

**PROVEN VALUE-IDENTICAL TWICE, and the second proof was necessary.** The first
used two separately-scoped CTEs: 0 presence diffs, 0 value diffs, 0 fallback
diffs. But the shipped shape is ONE pass whose `WHERE` is the **OR** of what both
aggregates consume, which that proof did not cover — so it was re-run against the
real shape: **0 money diffs, identical dollar totals ($7,245 either way)**, while
reading 99 rows where the deployed card aggregated 1,625 groups.

**THE RESULT, cache-independently through the public endpoint after the flip:**

| org | before | after |
|---|---|---|
| pawnee, 2025-09-04 → 2026-09-30 (Dan's) | **TIMEOUT past 300s** | **100 rows in 7.9s** |
| norman (heaviest, 20,439 rows) | — | **25.8s** |
| clarksville | — | passes |

**Do NOT read a timing taken from the sandbox mid-investigation.** A combined
candidate-vs-deployed probe came back in 3.2s while a bare scan of the same table
minutes earlier took 39.9s — the read replica's buffers were warm from repeated
probing. The 7.9s and 25.8s above are the honest figures because they are the
prescribed sign-off: the public endpoint, the app's own parameter shape, after
the tag flip.

**The push→flip dance behaved exactly as this file predicts.** Both date tags
came back **Text** and the card registered **SIX** parameters (three real +
three `string/=` duplicates), so `verify-report-live` returned
`An error occurred. (HTTP 400)` in 0.1s and the Memberships report was down for
every org until Dan flipped. The remedy is the documented one: open the card, set
both to Date, and **re-save until the list is three** — flip link
https://rec.metabaseapp.com/question/17301

**A manifest row was added for the case that actually broke.** The two existing
memberships rows pass no dates, so they run the default 7-day window and
**structurally cannot catch this class of regression** — a one-month window with
ZERO output rows still cost 55s on v5. The new `pawnee, THIRTEEN MONTHS` row
carries `start`/`end` explicitly, because a long window is the only shape that
discriminates.

**THE FLOOR IS STILL ONE SCAN.** Nothing in SQL avoids reading a 1230 MB
single-index table once. Only an index on `materialized.item_log_report` does —
the platform ask already pinned in this file, now with a fourth card behind it.

### NOT DONE, and why

**A base-table rewrite of the payment CTEs.** `order_item_transaction` carries
`(organization_id, confirmed_at)` and reproduces the item log **exactly** for
`tx_oi` — measured over Pawnee's whole history: 1,625 order items both sides, 0
only-in-base, 0 only-in-item-log, 0 value diffs, and totals identical to the cent
($65,301.98 paid / $10,278.50 refunded). That path is indexed and would take this
from seconds to milliseconds.

**It is not done because the FALLBACK cannot be reproduced without discovery.**
`tx_cust` keys on `order_item_type = 'product'`, and `order_item` has no `type`
column — the obvious guess errors out. Every unknown there is a place a wrong
guess is silent, which is exactly what the `materialized`-schema decision below
warns about. Worth finishing, on its own, with its own equivalence gate; not
worth rushing inside a flip window.

**Card 17301 was not pushed at first, and what changed is worth keeping.** The
first pass through this deliberately held it: the collapse looked right but was
**unmeasured** (no tool here can time a query past 60s), and a push takes the
report down for every org until a human re-types the date tags. So it landed on
a branch and nothing was merged.

**Two things then unblocked it, and neither was a change of mind about the
risk.** First, the equivalence could be measured *without* a scratch card after
all: because the scoped set is a SUBSET of the unscoped one, a single query can
compute both and diff them, which sidesteps the 60s ceiling entirely — the trick
worth remembering for the next card of this shape. Second, Dan said *"i'm here
to flip the mb report"*, which is the one condition the push was waiting on: the
downtime is only unacceptable when nobody is at a keyboard to end it.

### Guards

`scripts/feed-error-message.spec.js` (**32 assertions, in CI**), which LIFTS AND
RUNS `reportFetchError` over the four shapes a failing response really takes —
the route's JSON, the edge's HTML, an unreadable body, and JSON with no `error`
key. Mutation-tested: a page reverted to the bare status, an owning arrow no
longer async, the 504 fallback dropped, the body parsed with no guard at all, and
the ROUTE stopping sending the remedy (the page can only surface what the server
puts in the body, so the pair is the guard).

**Its first draft DIED instead of failing by name** on the unguarded-parse
mutation — sixth instance of that lesson in this file. Every call is wrapped now,
so a throwing implementation fails on the assertion that provoked it; and the
fake response carries **both `text()` and `json()`**, or the mutation errors
about a missing method rather than on the real failure.

Plus two `ci-check-render.js` cases over a new **`timeout504`** stub mode, keyed
on the remedy being ON SCREEN and the bare status NOT being the whole message —
*"an error panel rendered"* passes just as happily on the version Dan was looking
at. Verified to fail on the bug as he hit it. `ci-check-render.js` gained a
per-case **`expectsConsoleError`**, because a case that drives a failing response
expects the page to log it, and without that an error-path case can only ever
fail.

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

## How to talk to Dan (2026-08-31)

- **Lead with the answer or the action.** No preambles, no recaps of what you
  just did or what he just said.
- **Be concise. This is the instruction that gets broken most often (Dan,
  2026-09-01: *"please be less verbose, I don't need 500 lines about what you're
  doing"*).** A reply is a handful of lines: what changed, what it means, what is
  next. Not a section per file touched, not a narration of the steps, not the
  reasoning that led there unless it changes what Dan does. The long-form write-up
  belongs in THIS file and in the PR body — that is what they are for — and a
  point already made in the commit message does not need making again in chat.
- **Ask before architectural changes**, and ask when a question would actually
  change the work — don't guess and don't over-interpret. Reasonable intent from
  context beats being literal.
- **Readability over cleverness**, in code and in writing. Human-sounding.

### Response style for code tasks (Dan, 2026-09-06)

His own words, verbatim, because they are the standard this file keeps failing:

- Be concise. No multi-page explanations or walls of text.
- Lead with a 1-2 sentence summary of what the code does or what changed.
- Use bullet points, not prose paragraphs, for any detail.
- Assume I'm a PM with limited dev skills: explain *what* and *why* in plain
  language, skip deep implementation theory unless I ask.
- Don't explain basic syntax or narrate every line.
- If you change code, give me: what changed, why, and what I need to do next
  (if anything) — as bullets.
- When I ask a yes/no or quick question, answer it directly first. Expand only
  if I follow up.

**This is about CHAT, not about the record.** The long-form reasoning still goes
in this file, in the commit message and in the PR body — that is what they are
for, and dropping it there to be brief in chat loses the thing that stops the
next person re-deriving a measurement. Two different audiences, two different
lengths.

## Lindsay's three questions on court utilization (2026-09-04)

Lindsay Keare, after the backcheck: *"Is there away to add util_actual to the
dashboard? that is likely what SF cares about the most"*, *"How does utilization
treat overlapping courts? i.e. if a pickleball court is booked that is on a
tennis court, does utlization count on both courts? (this was a sticking point
last time)"*, and *"what is the cancellation metric? is this rate booked at any
point or booked and actually occured?"* Measured answers below; nothing was
changed.

### 1. `util_actual` — the report is ALREADY on actual availability

**There is no field called `util_actual` in this repo** — it is Lindsay's own
name, from a brief that computed utilization against measured availability
rather than the flat window. As of PR #190 both surfaces divide by each court's
own published open hours:

| surface | denominator |
|---|---|
| Facilities → Racket Sports (was Court Utilization) | per-court `bookingPolicies.slots`, per weekday |
| QBR + Director's Report (`qbrSumCourt` / `dirCourt`) | the SAME source, via `courtSchedulesFor` |

`scheduled` / `assumed` travel with the number and `utilizationEstimated` is now
true only when part of the denominator really is assumed, so the "EST." tag
means something.

**A pure no-assumptions figure is available and barely differs at SF.** Over
September, courts with a real schedule against all courts:

| | used | available | util |
|---|---|---|---|
| all 106 courts with activity | 7,486.5 h | 34,673.0 h | **21.6%** |
| the 103 on real schedules (`util_actual`) | 7,468.5 h | 33,593.0 h | **22.2%** |
| the 3 assumed (Dolores 4, 5, 6 @ 12 h/day) | 18.0 h | 1,080.0 h | 1.7% |

The assumed courts are **3.1% of the denominator**, so splitting the KPI in two
would put 21.6% next to 22.2% and invite a question about a 0.6pp gap. The
recommendation is to keep ONE number with its provenance stated, and split only
when the assumed share is material — which is what the "103/106 real" readout
in the toolbar is for.

**AND THE TWO CANDIDATE "ACTUAL" DENOMINATORS STILL DISAGREE.** Lindsay's brief
measured `court_slot` (13.58 avg hrs/court-day, range 1.5–26); the
`bookingPolicies` path the tab reads gives 10.85 mean, max 14. Same question,
~20% apart on the denominator, so a `util_actual` built on `court_slot` will not
match the tab (~57%/~43% instead of 70%/53% on SF's QBR quarters). Dan's call
was the tab's source, because the tab is what an org looks at. Worth saying out
loud before anyone reconciles two "actual" figures.

### 2. Overlapping courts — the platform cannot express the overlap

**Utilization is per `court` RECORD**: a booking counts on the court(s) its
reservation is attached to, and nowhere else. A reservation CAN carry more than
one court (`reservation_court` is a join table) and then it legitimately counts
on each — but in September only **6 of SF's reservations do**, and none of them
survives into card 17297's row set (3,880 reservations = 3,880 rows). So there
is **no double counting in these numbers.**

The real exposure is the opposite one, and SF's data cannot answer it:

- SF's 114 courts are **76 Tennis + 38 Pickleball**, each court carrying
  **exactly one sport** (`court_sport`), and **10 locations carry both** — Buena
  Vista, Crocker Amazon, Jackson, Moscone, Parkside Square, Presidio Wall,
  Richmond, Rossi, Stern Grove, Upper Noe. Presidio Wall is the clean example:
  **Courts 1-4 Tennis, Courts A/C/E Pickleball.**
- **`location_site_group_id` is NULL on all 114 courts** and no court carries two
  sports, so *nothing in the data says Court A is painted on Court 1.*
- Measured: **525 time-overlapping Tennis × Pickleball reservation pairs at the
  same location in September.** Either those are separate physical courts (and
  the numbers are right), or they share concrete and the product is not blocking
  one when the other sells.

So: **if the pickleball courts are lines on tennis courts, utilization
UNDERSTATES the pair** — the booked court counts, the shared one reads as
available — and the "106 active sites" count is bookable sites, not physical
ones. It never overstates. Which case SF is in is a question only SF can answer,
and the fix belongs in the product: group the shared courts
(`location_site_group_id`), and reporting can then divide a group's hours by the
group's open hours once. A per-org overlap map here (the `aquaticsScope` shape)
is the fallback if that is a long way off.

### 3. The cancellation metric is BOOKED-THEN-CANCELLED, dated by the booking

`aggregate()` computes `canceled / bookings` over the reservation rows **dated
in the window**, where `Status` is card 19570's
`CASE WHEN r.canceled_at IS NOT NULL THEN 'Canceled' ELSE INITCAP(fr.status) END`.
So it answers *"of everything booked for a date in this window, what share is
now cancelled"* — **booked at any point, cancelled at any point, attributed to
the DATE OF THE BOOKING and not the date of the cancellation.** SF September:
**184 of 4,064 = 4.5%**, rendered 5%.

It is NOT "booked and actually occurred": **no-shows are not recorded anywhere
in the schema**, so a booking nobody turned up for counts as fulfilled.

**AND ON AN OPEN MONTH IT IS A FLOOR, NOT A RATE**, which is the part that
matters for a QBR. Split by whether the date has passed, same read:

| September dates | bookings | cancelled | rate |
|---|---|---|---|
| already played (1-4 Sep) | 1,550 | 117 | **7.6%** |
| still ahead (5-30 Sep) | 2,514 | 67 | **2.7%** |
| whole month | 4,064 | 184 | 4.5% |

The future half has not had its chance to cancel yet, so a part-elapsed month
reads low and can only rise. **Compare closed months only.** One more thing to
know: the denominator is the status chips — untick Canceled and the rate reads
0%, because those rows leave the denominator with the numerator.

## Backcheck: SF Racket Sports, September 2026 (2026-09-04)

Dan, on the deployed tab: *"run a backtest of these numbers against real SF
data to confirm this is all correct."* **They are correct.** Verified three
independent ways, and the one defect it found is at the bottom.

### Leg 1 — the page against card 17297, cache-independent

Fetched the card straight from the Metabase public endpoint with the app's own
parameter shape (3,879 rows in 32.0s), plus the live `/api/schedules` feed from
production, and ran the page's OWN reducers (`cuNormalize` → `filtered` →
`grouped` → `stats`) over them:

| KPI | on screen | recomputed |
|---|---|---|
| Court Utilization | 22% | **21.6%** (7,486.5 used / 34,673.0 available) |
| Courts with Activity | 106 | **106** |
| Distinct Bookings | 2,550 | 2,554 |
| Reservation Rows | 3,873 | 3,879 |
| Total Hours | 7,479.5 | 7,486.5 |
| Instant Bookings | 2,512 · 3,524 h · 47% | 2,517 · 3,531 h · 47% |
| Leagues / Managed | 101 · 3,956 h · 53% | **101 · 3,956 h · 53%** |
| schedule sources | 103/106 real · 12 hrs/day fallback | **103/106 · 12** |
| Alice Marble — Court 1 | 44 bkgs · 36% | **44 bkgs · 36.3%** |

### Leg 2 — the card against the base tables

Independent SQL over `reservation` → `reservation_court` → `court`:
**3,880 rows / 2,555 rentals / 106 courts / 7,488.0 hours.**

- **The hour basis was checked two ways and agrees exactly.** Summing
  `upper(reservation_timestamp_range) − lower(...)` (what the card does) and
  summing `ends_at − starts_at` (a different pair of columns) both give
  **7,488.0**, and **0 rows** have a Pacific-local `starts_at` date outside the
  window. So the tsrange, the timestamptz columns and the window all agree.
- **`reservation.court_id` IS NULL ON ALL 557,367 SF RESERVATIONS.** The site
  link is the `reservation_court` join table, and `reservation.location_id`
  points at `location`, not at a court. Two obvious queries return **zero rows**
  before you find that out — worth knowing before diagnosing "no data".
- Card 17297's `published_at IS NOT NULL` filter hides nothing here: all 114 SF
  courts are live and published, 106 had September activity, and **0** courts
  with activity are excluded by it.

### Leg 3 — the two cards agree with each other

The toolbar and the Racket tab read DIFFERENT cards (19570 vs 17297), so they
are a cross-check rather than a restatement:

| | fresh 19570 read | on screen |
|---|---|---|
| bookings | 4,064 | 4,062 |
| active sites | **106** | 106 |
| charged | $47,821 | $47,808 |
| canceled | 184 → 5% | 183 → 5% |

**4,064 − 184 canceled = 3,880, which IS the court card's row count**, exactly.
Card 17297 excludes canceled reservations and canceled rentals; 19570 keeps them
and the status chips count them. The identity holds this month because **no
September reservation spans two courts** (3,880 reservations = 3,880 card rows) —
it would not hold in a month that had one.

Also: **every one of SF's 4,064 facility rows is `Site Type = court` and none is
an invoice line**, which is why two independently-computed site counts are both
106, and why the org-wide toolbar figure equals the racket figure.

Money, same read: charged $47,821 · collected $32,218 · outstanding $15,602 ·
refunded $74. The Collected card's *"231% of charged to date"* is arithmetically
right and reads oddly: **$13,944 of the month is billed to date and $33,877 is
upcoming**, so money already collected for future bookings exceeds the
to-date charge. The sub-line says so.

### EVERY GAP IS THE OPEN WINDOW, and it is monotonic in read order

September is not a closed month. Ordered by read time — Dan's screen (a warm
4-hour cache entry) → 17297 at 13:56 → 19570 at 14:04 → base SQL at 14:01 —
rows go 3,873 → 3,879 → 3,880 and hours 7,479.5 → 7,486.5 → 7,488.0. **Every
one of those deltas is on the INSTANT side; the managed figures are identical in
all three reads** (101 rentals, 3,956 h), which is exactly what a self-service
booking landing mid-backcheck looks like. Never diff an open window against
itself across two reads — the Clarksville rule, third instance.

### THE DEFECT: the closure branch is dead for every org

`cuNormalize` reads `r.usage_category || r['Usage Category'] || 'Customer
Booking'` — and **card 17297 v4 emits `purpose` (`fr.name`), not
`usage_category`.** So every row defaults to `Customer Booking`, the
`'Closure / Block'` branch in `grouped` can never fire, and `g.closure` is
**always 0** on every org.

What it costs at SF, measured: **66 rows / 219.0 hours** are staff blocks named
*Unavailable* (16 rentals) or *Not Reservable* (2), all `booking_type = managed`
with no attendee count. They are counted as **booked** time, so:

- utilization reads **21.6%** where excluding them gives **21.0%**,
- those 66 blocks sit inside the **101** "Leagues / Managed" bookings, and
- each blocked court's own "N bkgs" count includes them.

Not fixed — which way to fix it is a decision, not a drive-by: a court closed
for maintenance is not utilised, but it is arguably also not *available*, so the
choice is between taking the hours out of the numerator and taking them out of
the denominator, and the two produce different percentages. Flagged to Dan with
the numbers.

### One labelling note that is NOT wrong

`Instant 2,512 + Managed 101 = 2,613`, against `Distinct Bookings 2,550` one row
above. Both are right: the two lower cards sum **per-court** distinct rentals
(`grouped.reduce(... g.customer)`), while the KPI counts distinct rentals across
the whole view — so a rental touching two courts is counted once above and twice
below. The per-court "44 bkgs" figures depend on that per-court counting, so it
is the KPI row's neighbours that invite the comparison, not the arithmetic.

## The Facilities hub loses a tab and a signpost (2026-09-04)

Three asks in one pass, all Dan's, all on `public/facilities.html`.

### Court Utilization is RETIRED AS A TAB — and it really was duplicative

Dan: *"lets remove the 'court utilization' tab off the Facilities report, it's
duplicitive now that we have the racket sports tab."*

He is right about the org he was looking at, and the reason is worth keeping
because it is not obvious from the code. `RacketSportsView` wraps the SAME
`CourtUtilizationView`, filtered by `isRacketCourt` — and when NO court in the
feed carries a sport in its name it falls back to `() => true`, i.e. every
court. Measured over live court-type sites:

| shape | orgs | courts | non-racket courts |
|---|---|---|---|
| **no racket names** — racket tab already = every court | 28 | 276 | 276 |
| mixed | 51 | 1,564 | **721** |
| all racket-named | 22 | 140 | 0 |

**San Francisco is in the first row: 0 of its 114 courts are racket-named**, so
the two tabs rendered identically there. That is what "duplicitive" was
describing.

**THE COST FALLS ON THE 51 MIXED ORGS, and it is real: 721 basketball,
volleyball and multi-use courts now have no utilization view on the hub**, since
their racket tab genuinely filters. Flagged to Dan rather than worked around —
the one-line follow-up, if he wants it, is to drop the keyword filter so the
tab is every court under a racket name.

**The VIEW and card 17297 are NOT retired with the tab.** Racket Sports reads
them, and the card is load-bearing — `facilities.html` pulls it ~174x/30d across
13 orgs while the standalone `/:org/court-utilization` page is barely opened. So
is the stored-coordinates court map, which lives inside that view.

**AND A `?tab=utilization` LINK MUST STILL LAND SOMEWHERE.** With the key gone
the render switch falls through to Summary's *body* while `tab` still says
`utilization`, so **no tab carries `.active`** — a page that looks half-broken
and says nothing. `facEffectiveTab(want)` resolves an unrecognised tab to the
one the page opens on, at module scope for the `nightStateFrom` reason (a regex
over a resolver passes on an inverted comparison). Same shape as
`progEffectiveTab` / `ftEffectiveTab` / `mbEffectiveTab`.

**Every tab now carries `data-fac-tab`**, because *"a tab strip rendered"*
passes just as happily on the version that still has the tab: the render cases
key on the retired tab being **ABSENT from the DOM** and on **Summary being the
lit tab** under the stale link.

**The chip-coverage rule became checkable here for the first time.** Court
Utilization deliberately had no dashboard chip, so the Facilities card's chips
could not be compared to the hub's tabs the way the Memberships ones are. They
can now, and the assertion is set-wise: `chips == TABS − summary`. That is what
fails the next time a tab is added and the card is forgotten — the bug the
Memberships chips shipped with for two days.

### Outdoor Events → Outdoor Facilities

Dan: *"And change outdoor events to outdoor facilities"*. The tab label, the
vertical's own label, the banner, the panel title, the loading line, the
cross-reference from the rental schedule, the dashboard chip, and the Slack
message.

- **The EVENT NAME `outdoor` stays.** Renaming it would redefine every row
  already in `events.jsonl` — the same reasoning that keeps `campmap-book`'s
  `kind` describing the route rather than the button.
- **`outdoor-event-space` stays spelled Rec's way** in the site-type filter and
  in `REC_SITE_TYPES`: that control names Rec's own vocabulary, not our tab.
- The spec fails if the tab and its chip disagree, because **half a rename is
  worse than none** — a chip reading one thing and opening another.

### The Private Instructor Lessons panel is gone

Dan: *"remove this section from the racket sports tab (might only be on SF, but
we just want to remove this section so the instructors report can't be found)."*

**It rendered for EVERY org, and for all but one it was a dead link.**
`LESSONS_REPORT_ORGS` is `{san-francisco-rec-park}`, so `/:org/lessons` 404s
everywhere else — the panel advertised a report 28 orgs could not open.

Removed with its CSS (`.tennis-pending` had no other user; a rule with nothing
to style is what sends the next person looking for the panel it belonged to).
**The Lessons report itself is untouched** — this closes the way in from the
Racket tab and nothing else. Worth knowing: **SF still has a Lessons card on
its org dashboard** (`/api/org-landing` pushes it when the report is enabled),
so the report is still reachable there; hiding that card is a separate call.

### Guards

`report-tabs.spec.js` 124 → **159 assertions**, lifting and RUNNING
`facEffectiveTab` over the real tab strip. Mutation-tested six ways, all failing
by name: the tab put back in `TABS`, the resolver defined but not called by the
tab state (the lift cannot see that — the function is there either way), the
resolver no longer validating against `TABS`, `data-fac-tab` dropped, the chip
renamed while the tab was not, and a dead `tab === 'utilization'` branch left
behind.

Plus two `ci-check-render.js` cases, both verified to fail in a browser on the
real regression: `facilities · no Court Utilization tab` (absence, not a
greyed tab) and `facilities · a stale utilization link lands on Summary` (which
tab is LIT, which is the only thing that separates the fix from the fall-through).

**A sandbox trap, hit for the SECOND time and by my own hand:** sweeping
`/proc/*/cmdline` for `rental-report/server.js` kills this session's harness,
because the sweep's own command line contains that string — every later command
then exits 144 with no output, which reads exactly like the render check
crashing. The needle has to be assembled at runtime (or the current pid
excluded) so the pattern never appears literally in the command.

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
## The settings gear asks for the admin password (2026-09-01)

Dan: *"lets tie those in with the admin un/pw. So show the settings icon, but
require the admin un/pw to be entered when the settings icon is clicked."*

**THIS DELIBERATELY REVERSES the absent-not-greyed rule, for this one control.**
The gear used to be missing from the DOM for anyone without the derived key, so
an org staffer never learned the surface existed — that was the earlier call, and
this trades that concealment for discoverability. Worth stating because the rule
still holds everywhere else, and the render case that used to assert the gear was
ABSENT now asserts a LOCKED one is present.

**THE PROMPT IS NOT THE GATE.** Every settings route still requires the key, so
the modal is a way to OBTAIN the credential and never a way to skip it: a client
that skips it and PUTs anyway still gets a 404. `report-settings-unlock.spec.js`
asserts both routes still refuse without the key — that is the assertion that
fails the day someone "simplifies" this into a client-side reveal.

### THERE IS NO USERNAME, because nothing checks one

`dashboardAuth` reads Basic auth and compares the **password alone** — it never
looks at the username. So the modal asks for a password and names which one
("the admin dashboard password") rather than rendering a username box that is
ignored. A field that looks like it is checked and is not is a lie in the UI.

### What showing the gear COSTS, and the throttle that pays for it

A password prompt reachable by anyone holding an org token is a brute-force
surface against ONE shared secret, and it did not exist while the control was
hidden. So the unlock route is throttled: **5 attempts per IP per 15 minutes**,
then 429.

- **The correct password is ALSO refused while locked out.** Otherwise the
  throttle counts attempts without stopping the next one, and an attacker who
  guesses on try six still gets in. The spec drives exactly that case.
- **Already-unlocked short-circuits BEFORE the throttle**, or a reload storm
  locks the real admin out of their own panel.
- A success **clears** the address, so an admin who mistypes twice does not carry
  those strikes for the rest of the window.
- The map is bounded and swept, so a spray from many addresses cannot grow it.

### The credential never reaches JavaScript

Success sets the **same HttpOnly cookie `dashboardAuth` sets**, carrying the
DERIVED key rather than the password, and returns `{ok:true}`. The body contains
neither secret; the spec asserts the response and the event log contain neither
the password nor the key.

**The page then RELOADS rather than flipping state.** `settingsAdmin` is injected
server-side and decides the first render, so revealing the panel client-side
would be claiming an authorisation the server never granted. The reload reuses
the URL verbatim, so no key is ever appended to it — the same reasoning that
keeps the org token off the campmap card link.

### THE REFUSALS ARE MARKED DELIBERATE, and this is the part that bites

No password configured, the flag off, or an unregistered report all 404 — and
`noteDeadLink()` alerts on *"a 404 that arrived with a valid-looking token"*,
which is byte-identical to the shape of every one of those refusals. Without
`refuse404()` each gear click posts a DEAD LINK alert naming the path the 404
exists to keep quiet. Same trap as the settings routes themselves in August.

**And the spec nearly missed it.** The zero-deadlink assertion was vacuous at
first: with the password set and the flag on, none of the refusal branches ever
ran, so the mutation that reverted `refuse404` to a plain 404 SURVIVED. The live
half now drives a real refusal (`POST /:org/facility/api/settings-unlock` —
`facility` is not in `REPORT_SETTINGS_SCHEMA`) with a perfectly valid token,
which is what makes the assertion mean anything.

### Only the LOCKOUT posts to Slack

`settings-unlock` (🔓) on success and `settings-locked` (🚨) when the throttle
trips. A single wrong entry posts nothing: somebody guessing the admin password
on an org report is a security event, one typo by the person who set it is not.

**The gear renders locked only when the FLAG is on** (`reportSettingsLockable`).
With `reportSettings` off there is nothing to unlock into, and a gear that can
never work for anybody is the dead end this repo keeps writing down. The existing
flag-off notice for a proven key holder is unchanged.

### Guards

`scripts/report-settings-unlock.spec.js` (**69 assertions, in CI**), which LIFTS
AND RUNS the throttle, the password comparison and the lockable gate, plus a live
half that boots a server and drives the real route — wrong password, right
password, the cookie it sets actually opening the settings API, the sixth attempt
429ing, and the correct password refused while locked. `SKIP_SOURCE=1` drops the
source assertions so the live half can be shown to catch a regression alone.

Mutation-tested: the throttle check removed, the derived key returned in the
body, the already-unlocked short-circuit deleted, `refuse404` reverted to a plain
404, the key check removed from `GET /api/settings` (the prompt becoming the
gate), both events dropped from `SLACK_NOTIFY`, and the lockable gate ignoring
the feature flag. **Two of those survived the first draft** — one was a bad
mutation of mine that hit an identical `res.json({ ok: true });` in an unrelated
route (there are ten in server.js), and one was the vacuous deadlink assertion
above, fixed in the spec rather than the mutation.

Three `ci-check-render.js` cases, all of which had to change or be added because
the door's rule changed: the locked gear is present while the WORKING gear is
absent, clicking it opens a password prompt and NOT the settings sheet, and a
refused password is surfaced rather than swallowed.

**That last case cannot prove the server refuses**, and says so in its own
comment: every `/api/` request in that harness is answered from `STUBS`, so the
browser never reaches the real route. The stub answers 401 the way the route
does, and what the case pins is the page's half — the error is shown and the
panel stays shut. Without it, a page that ignored the status would reload and
look exactly like success. `ci-check-render.js` gained an optional per-stub
`status` for this, since a stub that always says 200 cannot express a refusal.

**A spec-brittleness note, second instance in this same file:**
`report-settings.spec.js` pinned the literal `"epact", "settings-open",
"settings-save"` in `SLACK_NOTIFY`, so inserting an event BETWEEN two of them
broke it with nothing about settings-open changing — exactly the failure already
recorded here for `"settings-open"]` at the end of the log route's ALLOWED array.
It tests membership now, and was re-verified to still catch `settings-open` being
removed. Its `refuse404` count also had to scope its split pattern to
`/api/settings",` with the closing quote, or it swallows `/api/settings-unlock`
and counts that route's refusals too.

### "I can't even click it" — the flag-off gear was a dead end

Dan, on production, before any of this deployed: *"the goal here was to make the
settings option clickable, then unlock after entering the password/un for the
admin user. I can't even click it."*

Diagnosed rather than guessed: **production had `reportSettings: false`**
(`/api/admin/flags`), so what he was clicking was the pre-existing FLAG-OFF gear
— `disabled`, with its explanation in a `title` attribute. It only renders for a
proven key holder, so it also confirmed his cookie was working.

Two separate things, and worth keeping apart: the flag being off is a switch, not
a bug. **The gear being unclickable IS a bug**, and it is the dead-end pattern
already written down twice in this file — the explanation was behind a hover, so
clicking did nothing and the feature read as broken.

It is a real button now, opening a notice that names the switch, says the admin
sign-in is fine, and mentions that a PR preview starts with the flag off because
each preview is a fresh volume.

**`report-settings.spec.js` WAS PINNING THE BUG.** Its assertion required
`disabled` on that button, so the fix failed the spec until the assertion's
intent was corrected — the spec had encoded the dead end as the desired
behaviour. The render case now CLICKS the gear and requires the notice on screen;
reverting to `disabled` fails it by name.

## Programs: % on Auto-Pay vs manual collection, and the location filter that could never render (2026-09-01)

Dan: *"Lets add the single metric on the programs summary page. % on Auto-Pay vs
% on manual collection"* — autopay being the new payment-plan type that keeps a
card on file and charges it at each installment date.

One `sum-card` in the summary row, on card 17295 **v7**. The four columns are
additive per section and come off the `pp` LATERAL that `sec_fin` was **already**
running for `pending_cents`, so this costs **no new scan** on a card that is
already past the app's 60s+120s ceiling — the same fold as v6.1's location.

### THE DENOMINATOR IS PAYMENT-PLAN REGISTRATIONS ONLY

`on_autopay` is `BOOL_OR(COALESCE(pl.autopay_enabled, FALSE))` over the item's
installments, so it is **NULL when the item has none** — paid in full — and such
an item is counted on **neither** side. Somebody who paid up front is not "on
manual collection"; folding them in turns the figure into a statement about how
many people use plans rather than how the plan money arrives.

`IS TRUE` / `IS FALSE`, never `IS NOT TRUE`: the near-miss **includes NULL** and
would report every paid-in-full registration as collected manually. The spec
COUNTS both aggregates on each side — a single `.test()` matched the `*_cents`
line and let a mutation of the `*_items` line through on the first draft.

`COALESCE(autopay_enabled, FALSE)` makes an unresolvable plan row read as
**manual**, the safe direction: it is certainly not proven autopay. Measured
before the push: `payment_plan` has 58,304 rows with **zero NULL**
`autopay_enabled` (228 true / 58,076 false), and of 76,370 order items with
installments **zero span more than one plan**, so `BOOL_OR` cannot disagree with
itself between runs.

`plan_cents` is **every** installment, paid and unpaid — the size of the book on
each method. Reusing `pending_cents` here would make the metric *shrink as an org
collects*, which is the opposite of adoption.

### THE TWO READINGS DISAGREE BY 26x, so both are printed

Measured at apex over 22,109 plan registrations:

| | auto-pay | manual |
|---|---|---|
| registrations | **79** | 22,030 |
| plan value | **$211,200.50** | $1,793,561.68 |
| average | $2,673 | $81 |

**10.5% by DOLLARS against 0.4% by COUNT.** Autopay is being used for the
expensive plans. Either number alone reads as the whole answer and is wrong about
the other half, so dollars lead (it sits in a revenue row) and the registration
share is printed beneath *with its own percentage* — two raw counts would leave
the reader to spot the gap. The render fixture makes them differ 11x on purpose,
because a card computing the wrong one renders a perfectly plausible number.

**No plan money at all is `null`, never 0%** — "nobody uses autopay" and "this
org runs no payment plans" are different facts. A **real** 0% must still show:
Shrewsbury has 87 manual plan registrations worth $32,494 and not one on autopay,
and that is an answer. Presence-gated on the column (`colPresence.autopay`) so a
warm pre-v7 cache entry hides the card instead of rendering a confident 0.

### Outstanding now says WHY it is outstanding (card v8, same afternoon)

Dan: *"lets fix the outstanding revenue metric, we'd like to have past-due from
scheduled and on autopay, that's a helpful distinction."*

Four more columns off the **same** `pp` LATERAL, so still no new scan. They
**partition `outstanding` exactly** — every branch mirrors the `pending_cents`
CASE it decomposes, including its `ic.payment_plan IS NULL` test, or an item with
no plan but with installments is counted twice and the parts overshoot.

Measured at apex, all-time over 67,458 unpaid installments:

| | |
|---|---|
| past due | **$24,727.58** (6,952) |
| scheduled, manual | $360,847.84 (59,716) |
| scheduled, on auto-pay | $191,999.90 (790) |
| total | $577,575.32 |

**The single Outstanding figure was 96% not-yet-due money**, and the $24,728 that
is actually late was invisible inside it. That is the whole argument for the
split.

**A NULL `due_at` IS SCHEDULED, NEVER PAST DUE — and apex cannot test that.**
Platform-wide, **15,231 of 166,507 unpaid installments (9%) across 76 orgs have
no due date**, and apex has zero. So `due_at < NOW()` is the strict test (false
for a NULL) and the scheduled side spells `(due_at >= NOW() OR due_at IS NULL)`
out rather than leaning on an implicit ELSE — leaving it implicit drops every
dateless installment from all three buckets and the four silently stop summing to
Outstanding, for those 76 orgs only. Verified platform-wide over **all 76,423
order items with installments: ZERO partition breaks**, and $2,692,752.48 of
dateless money lands in scheduled with $0 in past due. Third instance of *"one
org's clean data is not evidence about what a column MEANS."*

**PAST DUE IS DELIBERATELY NOT SPLIT BY COLLECTION METHOD**, per Dan: *"declines
are flagged in product, they are the same as a non-auto payment past due CC
payment installment."* A past-due auto-pay installment IS a declined card, and
filing it under "on auto-pay" would report it as collecting on schedule when it
is the opposite. It is $121.39 of $24,727.58 at apex anyway. The spec fails if a
`data-out-pastdue-autopay` attribute ever appears.

**A fourth bucket exists because a balance with no plan has no due date.**
`no_plan_balance_value` is the other half of the same CASE — it can be neither
late nor scheduled, and calling it either is a claim about a date that is not
there. Its row renders only where there is one.

**AND THE PARTS ARE CHECKED AGAINST THE TOTAL ON SCREEN.** `progOutstandingSplit`
returns the **residual** rather than trusting the four to add up, and the page
renders an *"Unexplained"* row when it is over 50c — far above per-row rounding
(five figures each rounded to the cent independently) and far below anything that
matters as money. The card guarantees the partition, so that row should never
appear; a breakdown whose parts quietly fail to sum is how a number stops being
trusted, and a pre-v8 row reaching the helper reports its whole balance as
unexplained rather than as scheduled.

**Not done, on purpose:** the Excel export and the per-program Outstanding column
are unchanged. Dan asked for the metric; four more columns on a 13-column table
and on a file people parse is a separate decision.

### THE LOCATION FILTER SHIPPED UNABLE TO RENDER, and no guard could see it

Found while wiring the KPI's presence gate. `progHasLocation` tested
`rows.some(r => 'location' in r)` — and **nothing ever wrote that key**:
`normalizeRow` did not map `location`, and `rollupToPrograms` builds program rows
with a fixed key set. So the gate was false on every feed and the select was
gated out at `locOptions.length > 1`. The filter Dan asked for **never appeared**,
in PR #182, for two days.

**Nothing in CI could catch it, and that is the lesson.**
`programs-location.spec.js` LIFTS AND RUNS the reducer — but it feeds it fixture
rows that already carry `location`, so it proved the reducer filters correctly on
data the page never produces. And there was **no render case for the control at
all**; the season cases were added later and the fixture carried no location
either. Generalise it: *a unit test that supplies the field under test cannot
tell you whether anything supplies it in production.* The presence gate now reads
the RAW response (`raw.some(r => 'location' in r)`), like every other entry in
`colPresence` — a column question has to be asked of the response, never of a
derived object — and the spec asserts the MAPPER carries the field.

### ...and the funnel had to become SECTION-grain, which is a real fix not a tidy-up

`rows` are program rollups; a location and a season are facts about a **section**.
Measured before choosing: **659 of 5,699 programs with a located section (11.6%)
run at more than one location**, max 24 — against **0.7% of sections**. So
filtering whole programs by a primary location keeps money and enrolments from a
site the reader just excluded, for one program in nine. This is a program-grain
problem specifically, and the same argument applies to season (the rollup carried
its FIRST section's season).

So `scopedRows` flattens to sections, filters both dimensions, and **re-rolls up**
with the pure `rollupToPrograms` — giving a program row whose totals are the sum
of exactly the sections still in view, which is the parent-reconciles-to-children
invariant the rollup was built for. With nothing ticked it hands `rows` straight
back rather than flattening and re-rolling for nothing.

**IT TOOK THREE ATTEMPTS TO WRITE A CASE THAT PROVES THE RE-ROLLUP, and the two
failures are the useful part.** Both passed on a build with the re-rollup deleted:

1. `location filters SECTIONS` asserts 100% under a Urho filter (75% if whole
   programs are kept) — but only ONE section survives that filter, so there is
   nothing for a rollup to combine.
2. Ticking `Fall '26` keeps both of Aquatic Exercise's sections and reads 75% —
   and **still passed**, because `progAutopayShare` sums whatever rows it is
   handed and a program row's totals ARE its sections' by construction. The KPI
   is structurally invariant to the re-rollup, so no assertion on it can ever
   discriminate. Neither can `data-prog-count` or `data-prog-sections`: one
   program row with `sections: 2` and two section rows with `sections: 1` add up
   the same.

What actually breaks is the Summary tab's `progMap`, which is keyed by program
and therefore **overwritten once per section** — handed section rows it keeps
only the LAST one, so Fall '26 reads **20 participants instead of 21 + 20**.
`data-prog-participants` is the number that moves, and that case was verified to
fail on the mutation. A case that passes on the regression it names is not a
guard, and *plausible* is not the same as *discriminating*.

### Guards

`scripts/programs-autopay.spec.js` (**48 assertions, in CI**), which LIFTS AND
RUNS `progAutopayShare` against the real apex proportions and reads the SQL
mirror. `programs-location.spec.js` 21 → 27, `programs-season.spec.js` 43 → 49 —
the latter now lifts and runs `rollupToPrograms` too, because a stub would prove
the funnel calls something rather than that the numbers it produces are the
surviving sections'.

Mutation-tested twelve ways, all failing by name: the headline computed by
registration count, non-plan registrations folded into the denominator, no-plan
money reading 0% instead of hiding, the presence gate dropped, the share read off
the unscoped feed, the rollup overwriting instead of summing, `location` left
unmapped (the bug as it shipped), the re-rollup dropped, the manual side using
`IS NOT TRUE`, `plan_cents` reusing the pending filter, the plan-row COALESCE
removed, and a second pass over `payment_plan_installment`.

**Three of those survived the first draft**, all fixed in the spec rather than the
mutation: the paid-in-full fixture row carried no `enrollments`, so a mutation
adding the enrolment count to the manual side had nothing to add; the `IS FALSE`
assertion matched the `*_cents` line and missed a mutated `*_items` line; and the
season spec's `out[0]._sections.length` **THREW** on bare section rows instead of
failing by name — the same "a guard that dies instead of failing has not told
anyone what broke" lesson already recorded in that file, one assertion over.

Plus six `ci-check-render.js` cases, keyed on the computed VALUE rather than on a
card existing, over a fixture where Aquatic Exercise deliberately spans two
locations and a `prev7` stub mode drops the four v7 columns.

### The push

Pushed via the API and **diffed back byte-identical** to the mirror (402 lines).
As always the date tags came back as **Text**, and the served card now registers
**SIX** parameters — `org_id/start_date/end_date` as `date/single` AND the same
three slugs as `string/=`. The app binds by slug, so it sends two values per
variable and Metabase answers `An error occurred.`: **card 17295 is the shared
Programs card, so the report and all six Program Summary bands are down for every
org until a human opens the card and re-saves until that list is three again.**
Nothing in the SQL can fix it. Flip link:
https://rec.metabaseapp.com/question/17295 — and the cache-independent sign-off
(`verify-report-live.js`, programs/apex row) has to follow the flip, not precede
it, because the verifier fails the same way during the window and its failure
carries no extra information.

## THE WAITLIST REPORT'S "CLAIMED" WAS MEASURING EXPIRY (2026-09-01)

Dan asked for an `auto` tag and a waitlist conversion column. Building the
column found that **the number it would have been built on was wrong, and had
been since the `offers` CTE was written.**

Card 19273 inferred a claim from timestamps:

```sql
(tg.updated_at > tg.created_at
 AND ABS(EXTRACT(EPOCH FROM tg.updated_at - tg.expires_at)) <= 2) AS consumed
```

— "the grant was written to at its expiry moment", which is what an **expiry
sweep** does, not what a claim does.

**THE CLINCHING EVIDENCE IS AN IMPOSSIBILITY, not a discrepancy.** Of the 5,371
grants that test called consumed, **5,371 were already expired and ZERO were
still open.** A real claim signal catches some invites *inside* their window; one
that never does is not measuring claiming. Supporting: the average
created→updated gap on those rows is **114h** against an average invite window of
105.8h, while an actual registration lands at a median of **5.3h**.

Measured over 8,529 invites platform-wide (37 orgs, since 2025-10-13):

| | |
|---|---|
| heuristic said claimed | 5,371 — **63.0%** |
| actually booked inside the window | 3,628 — **42.5%** |
| both agree | 3,483 |
| **heuristic only, no registration** | **1,888** |
| booked but the heuristic missed it | 145 |

So conversion read **~20 points high**, and `Avg`/`Median Claim Hours` plus all
six `Claim` buckets were describing invite-window **LENGTHS**. Expect the numbers
on that report to drop — that is the fix landing, not a regression.

### v6: a claim is a REGISTRATION

The first confirmed booking by that participant on that section between the
grant's `created_at` and `expires_at`.

- **STRICTLY inside the window.** Dropping the upper bound counts 641 people who
  came back weeks later by other means — the difference between 42.5% and 50.1%.
- **AND THE PARTS NOW ADD UP.** `offers_expired`/`offers_outstanding` keyed on
  `untouched` (`updated_at = created_at`), so a grant that was touched but never
  claimed fell into **no bucket at all** and claimed + expired + outstanding did
  not equal `offers_sent`. They are now claimed / not-claimed-and-expired /
  not-claimed-and-still-open. Verified at apex: **2,113 + 2,352 + 10 = 4,475**,
  exactly.
- Cost is not a concern: the per-section aggregate is 658ms at apex, and the
  whole card 13.0s.

**DO NOT BUILD AN OPEN RATE.** `temporary_grant.first_viewed_at` is populated on
**66 of 8,529** invites (0.8%) — dead like `memberships.last_used_at`. An
"opened" funnel step would be a confident number over nothing.

### The page: an `auto` tag and a conversion column

`waitlist_config->>'type'` is `automated` | `manual`, emitted as `Waitlist Type`
and falling back to the session config exactly like `Waitlist Mode` so the two
cannot disagree about which row they describe.

- **Adoption is FIVE sections in ONE org** (City of Niagara Falls, which *is*
  onboarded). Dan: *"it's brand new, that's it."* So the tag is an adoption
  signal that fills in over time, not a broken filter — the
  *a-type-filter-returning-almost-nothing-is-a-question-about-the-filter* rule
  does not apply when the feature shipped last week.
- **The tag renders only for `automated`.** A tag on all 28,161 manual sections
  is noise, and its absence already says manual.
- **Presence-gated, not defaulted.** A pre-v6 cache entry has no type at all, and
  *"we cannot tell"* must not render as *"a person does this by hand"*.
- Violet, deliberately **not** the green of a working mode pill: `auto` says WHO
  sends the offer, not whether the waitlist is healthy, and two green pills side
  by side read as one status.
- **`WL_CONV_MIN_OFFERS = 5`.** A rate over a handful of invites is not a rate —
  under the floor the cell prints *"2 of 2"* rather than *"100%"*. Same rule as
  `RATE_MIN_VIEWS` on the campmap strip. **A real 0% still shows**: eight invites
  and nobody registered is an answer.

**Dan's call: the `auto` tag is on the WAITLIST report only.** It would need a
column on card 17295 to reach Programs, and that card is already 104s at apex and
parked on performance — another push means another tag flip and downtime on the
most-used report on the platform, for a tag that belongs beside the mode pill
anyway.

### Guards

`scripts/waitlist-conversion.spec.js` (**49 assertions, in CI**), which lifts and
RUNS `wlConversion` and reads the card mirror — including that the timestamp
heuristic and `untouched` are *gone* and cannot come back, that every one of the
17 pre-existing output columns survived, and that the trailing `ORDER BY` did
(the exact thing that silently vanished on card 17300).

Plus **seven `ci-check-render.js` cases — this report had NO render coverage at
all**, which is part of why its central number stayed wrong. The fixture's four
rows are the four states with deliberately different conversion figures (75% /
20% / under-floor / none), so a swapped cell fails rather than rendering
something plausible, and a `prev6` stub mode proves the tag is absent on an old
feed. The fixture honours the v6 partition invariant, because a fixture that
breaks it would be testing something the feed can never produce.

`scripts/report-cards.manifest.json` gained a **waitlist / apex** row — this
shared card had none at all.

**A process note:** the first render run died on `EADDRINUSE` from a leftover
`node server.js`, which is the stray-server trap already recorded in this file.
Kill strays before driving a page; a stale server is indistinguishable from a
code failure in the output.

## Card 17295 does the whole org's work and then throws it away (2026-09-03)

Dan, after the same bug was fixed on card 21286: *"yes, profile 17295 and scope
it like you did the other card."* Profiled, fixed, and **LIVE since 2026-09-11**
— see the push section at the end, and the mirror
`sql/report-cards/17295-programs-report.sql`
for the candidate.

**THE ONLY DATE FILTER IS THE `[[ ]]` PAIR AT THE VERY BOTTOM**, against the `sd`
LATERAL. So `bk`, `item_tx`, `item_collected`, `sec_fin` (with its
`payment_plan_installment` LATERAL), `slots`, `ppl`, `wl` and `sec_fac` are all
computed over the org's **entire history** and then discarded for out-of-window
sections. Identical shape to the `money` CTE on 21286.

### The measurement, at Watertown over Sep 2026

| | unscoped | scoped |
|---|---|---|
| **`item_tx`** — the dominant CTE | **14.0s** / 9,194 order items | **0.08s** / 890 |
| `slots` | 3.6s / 3,262 sessions | 1.84s / 501 |
| sections | 773 | 177 |
| bookings | 9,430 | 945 |

`item_tx` is where the time goes: two per-item LATERALs
(`order_item_transaction`, `payment_plan_installment`) over ten times the rows
they can possibly contribute to. At apex the same window keeps **1,371 of 5,926
sections and 23,127 of 115,188 bookings.**

**DO NOT READ THE WHOLE-QUERY WALL-CLOCK NUMBERS FROM THIS SANDBOX.** Measured
back to back on the same window, the deployed shape came in at 12.8s and the
candidate at 15.6s and 19.5s — while a six-`COUNT(*)` probe on the same database
ranged 0.25s to 56s. That is the *"run the sweep alone"* caveat with teeth: the
shared Metabase is under variable load and a single whole-query timing from here
is not evidence of anything. The per-CTE figures above are the honest ones,
because each is a controlled comparison of the same sub-workload.

### HOW MUCH IT BUYS DEPENDS ENTIRELY ON THE WINDOW

Sections kept at Watertown: **one month 177 of 773 (23%), a quarter 224 (29%),
twelve months 591 (76%).** So the default page load gets most of the win and a
full-year pull gets very little — which matters, because the failure Dan asked
about (*"a bunch of their reports aren't loading"*) was Watertown taking 3m45s
and then 400ing, and a 12-month Watertown pull measured **259s** alone. **This
fix is for the common case, not for that timeout.** Saying otherwise would be
promising a cure for the thing that actually broke.

### `sec_win` IS THE CARD'S OWN FILTER, LIFTED — not a new one

`sd.first_start` is `MIN(g.mn)` over the per-location groups, i.e. the overall
`MIN(starts_at)`; `sd.last_end` is the overall `MAX(ends_at)`. `sec_env` computes
exactly those. A section with **no sessions** gets NULLs from `sd` (an aggregate
over an empty set) and no `sec_env` row at all, and passes both tests either way
— which is why each bound carries its own `IS NULL` branch.

- **The bottom `[[ ]]` clauses STAY, as the authority.** `sec_win` restricts
  *inputs*; the output is still governed by the filter that always governed it.
  Deleting them "because `sec_win` already does it" is how the two predicates
  drift apart silently.
- **`sec_env` is ONE `GROUP BY`, not a per-section LATERAL.** The first version
  used a LATERAL, which re-does per section the work `sd` already does per
  section — at apex that cost more than it saved and the probe timed out.
- **The main section list is scoped too** (`JOIN sec_win swm`), so the `sd`
  LATERAL itself only runs for sections that can survive.
- The session-booking arm of `slots` carries only a session id, so it needs its
  own `session` join to reach a section before it can be scoped.

**PROVEN IDENTICAL, not assumed.** Watertown, 2026-09-01..30, an md5 over
`row_to_json` of every output column:

| shape | rows | fingerprint |
|---|---|---|
| deployed (v8) | 177 | `50ed1d95b84df5dab22a104bbe1fb629` |
| candidate | 177 | `50ed1d95b84df5dab22a104bbe1fb629` |

### APEX WAS CLOSED WITHOUT THE SCRATCH CARD, and the cheaper proof is stronger

This used to say apex needed a **scratch card** compared through the public
endpoint, because both shapes exceed the 60s ceiling from here. **That was the
wrong shape of proof.** v9 changes exactly one thing — WHICH SECTIONS its CTEs
are computed over — so the only thing that can differ is the SECTION SET, and
that is a small query over `section` and `session` alone. Apex, 1.6s, 2026-09-11:

| window | deployed | v9 | only in deployed | only in v9 |
|---|---|---|---|---|
| one week | 1,040 | 1,040 | **0** | **0** |
| one month | 1,386 | 1,386 | **0** | **0** |
| one year | 5,897 | 5,897 | **0** | **0** |
| all time | 5,985 | 5,985 | **0** | **0** |

**And the stronger form underneath it, which is why no further window needs
testing: over ALL 5,985 apex sections, ZERO have a differing envelope** —
`sd.first_start`/`last_end` are identical to `sec_env.mn`/`mx` row for row — and
the **537** sections with no sessions at all land in the NULL branch identically
on both sides. The two filters therefore select the same sections for ANY
window, which is a stronger claim than the Watertown md5 (one window, one org).

*Generalise it: when a change is localised, prove the localised thing. The
whole-output fingerprint was the shape of proof that fit Watertown, and
reaching for a scratch card was reaching for a bigger version of it rather than
asking what could actually differ.*

### THE PUSH, 2026-09-11 — and apex is STILL parked

Dan: *"no more copy/pasting, I'm here, just update it via the api and give me a
link to flip the card."*

Pushed via `construct_native_query` + `update_question` and **diffed straight
back: byte-identical**, md5 `c172ba0222a3784222c0823eb22cd2c1`, with the
trailing `ORDER BY p.name, s.name` and the `'\s+'` regex inside `sec_fac` both
intact. That check exists because card 17300 silently lost its `ORDER BY` to
transcription, and a backslash crossing a JSON boundary is the other thing most
likely to be mangled. Tags came back **Text** as always — but **THREE, not six**,
because the card was updated rather than re-saved on top of an earlier push, so
there was no duplicate `string/=` set to flip away. Dan flipped both dates.

**Sign-off, cache-independently through the public endpoint, after the flip:**

| org | result |
|---|---|
| watertown, Sep 2026 | **178 rows in 51.7s** |
| apex, the 7-day window the page sends | **TIMEOUT past 200s** |

**THE 177 → 178 IS A NEW SECTION, NOT A v9 CHANGE**, and it was checked rather
than assumed: the deployed filter independently selects **178** sections for that
window, and exactly **one** of them was created after the 177 was measured
(2026-09-08). September is an OPEN window — the Clarksville rule, again.

**v9 DID NOT FIX APEX, and Dan's call is to leave it parked** (*"leave it
parked"*), which is the same call recorded on the manifest row: *"we'll address
this when we move to an api direct model."* Said plainly so nobody reads the
Watertown win as a platform win:

- **Mid-size orgs get it.** Watertown's dominant CTE went 14.0s / 9,194 order
  items to 0.08s / 890.
- **Apex does not.** `sec_env` is itself a GROUP BY over all 36,921 apex
  sessions, so at that size the scoping costs something before it saves
  anything, and the correlated `item_tx` LATERAL is still the floor.
- One timeout is **not** evidence on its own — this card has measured 7.7s to
  59.8s on identical input from here — but it is not evidence of a fix either,
  and the honest summary is that apex is unchanged.

Guard: `scripts/programs-card-window.spec.js` (**34 assertions, in CI**), which
reads the PENDING candidate while it exists and the live mirror after the push,
so it keeps guarding across the rename. Mutation-tested sixteen ways, all failing
by name: either bottom `[[ ]]` clause deleted (the authority removed), each of
the eight scoped CTEs unscoped one at a time, an `IS NULL` branch dropped (which
would silently drop every section with no sessions), `sec_win`'s lower bound
reading `end_date`, the clauses made non-optional, the session-booking arm's own
`session` join dropped, `sec_env` reverted to a LATERAL, an output column
renamed, and the trailing `ORDER BY` dropped — the exact thing that silently
vanished on card 17300.

## Programs: instructor + location on screen, and "by month" (2026-09-01)

Dan: *"lets build out the enhancements to the programs report, including
instructors and locations."* El Segundo ask #2 — *per class, by location, by
month, by instructor* — minus the parts he ruled out.

**Four decisions, all his, all made before any code:** no per-instructor
leaderboard yet; the by-month panel shows BOTH readings stacked; the two columns
go into the Excel export as well as on screen; and the report says **nothing**
about instructor coverage — blank cells, no nudge.

### THE COLUMNS WERE MAPPED AND RENDERED NOWHERE, for a day

`normalizeRow` has carried `instructor` and `instructorCount` since card 17295
v6 shipped on 2026-08-31, and no surface printed either. Exactly the shape of the
location filter that shipped unable to render — and invisible to the same checks,
for the same reason: **a source assertion cannot see a column that is mapped and
never displayed.** The render cases key on the CELL
(`data-prog-seccell-instructor`), not on the column existing.

- A location and an instructor are facts about a **SECTION**, so they sit on
  section rows and a program rollup prints a dash. Summing them into a program
  row would invent *"this program is at Urho Saari"* for the 11.6% of programs
  that span sites.
- **`+N` marks a primary, not a whole truth.** 23 of El Segundo's 286 sections
  carry more than one facilitator and one spans two locations.
- `leftCols` had to grow with them or the Grand Total row's money lands under the
  wrong headers.

### ONE PICKER, TWO CONTROLS — the season menu is now shared

Instructor is a multi-select, same as Seasons (*"I hate single item selections in
pull down menus"*), so it is the **same component**: `MultiPicker` with a `slug`
that drives `data-prog-<slug>-btn|menu|opt|clear`, which is why every existing
season selector in the specs and render cases kept working untouched. The CSS
classes went `season-*` → `mpick-*` for the same reason.

Two copies would have drifted, and the thing that would drift is the part that
already broke once: `.toolbar label` sets `text-transform: uppercase`, `color`
and `flex-direction: column` for the date captions, so the menu rows need
explicit **resets**, not decoration. A fix landing in one copy and not the other
is precisely how that bug comes back.

### "No instructor on file" is an OPTION, and the report says nothing else

**155 of El Segundo's 286 live sections have nobody on file, and they hold 1,170
of 1,418 enrolments (83%) and $39,941.** Three of their biggest programs are
named after the person teaching — *Naomi's HIIT Water Aerobics* (244 enrolled),
*Mary's Water Fitness* (99) — with the field empty; *Cue the Tap Shoes with Jenna
Lockwood* is the one that filled it in.

Dan's call was **say nothing**: no coverage note, no nudge, blank cells. The
bucket stays in the FILTER only, on the `LOC_NONE` argument — without it, ticking
any instructor silently drops 155 sections and nothing on screen says so.

### THE INSTRUCTOR KEY IS THE WHOLE COMMA-JOINED STRING

Card 17295 emits facilitators as one `STRING_AGG(..., ', ')` value, so
**"Penny Finders" and "Eric Stenberg, Penny Finders" are two different options** —
5 sections and 2 at El Segundo, and *neither is that vendor's real total*.

That is honest for a filter (tick the pairing you mean) and would be wrong for a
leaderboard, which is **why there is no leaderboard** — Dan's call, given the fix
is a decision rather than a refactor. Splitting the string is safe today
(**0 of 1,056 instructor names platform-wide contain a comma**) and silently
wrong the first time a vendor is called `Acme, Inc.`. The alternative is a card
change emitting a JSON array; both are open.

### The by-month panel: two peaks, eight weeks apart

Measured at El Segundo: **programming peaks in September (165 sections running),
money peaks in August ($77,813 collected)**, because people pay at registration
and then attend for a term. One chart labelled "by month" is read as whichever
the reader assumed, so both are drawn on one axis with the question each answers
printed on it.

- **The activity series is derived from the feed's own section spans**, which is
  an APPROXIMATION of "has a session this month" and was checked before shipping:
  against real session data over twelve months it is identical in nine and over
  by exactly **one section** in three (a run straddling a month with no sessions
  in it). It over-counts, never under-counts, by at most one in sixty.
- **Future months are hatched.** El Segundo drops from 59 sections in December to
  4 in January — that is unpublished programming, not a collapse in demand, and a
  flat future month drawn like a real zero says the opposite.
- **The panel hides itself under two months.** A single bar labelled "by month"
  is noise; a one-month window correctly gets nothing.
- Nothing in this path touches `new Date()`. `'YYYY-MM'` compares correctly as a
  string and the month range counts integers — `new Date("2026-08-01")` is UTC
  midnight and renders as July 31 across the US, which is the bug already
  recorded for fasttrack dates, check-in day-of-week and the ePACT export.

### Card 21055, and why the money half needed its own card

**Card 17295 returns ONE period figure for the whole window, not a series**, and
is section-grain, so it has nowhere to put twelve numbers. A separate card, not
columns on 17295: that card already runs 104s at apex and is parked on
performance, and a new card cannot regress the report every org opens.

**THE BASE TABLES ARE NOT USABLE HERE, which inverts the usual advice in this
file.** Measured 2026-09-01:

| path | scope | time |
|---|---|---|
| `payment → order_item_transaction → order_item → booking` | apex, **one month** | **TIMEOUT past 60s** |
| `materialized.item_log_report` | apex, all time | **21.4s** |
| `materialized.item_log_report` | el-segundo | 1.7s |

The Tyler export prefers base tables because it needs one org-month and can ride
`order_item_transaction (organization_id, confirmed_at)`. This card needs a year
**aggregated**, and deciding whether a transaction is programme revenue means
joining four tables before it can group. The item log has already done that join.
The cost is a full scan of the 1230 MB single-index table — survivable behind the
4-hour feed cache, and not survivable per request.

- **The filter is `order_item_type = 'reservation-enrollment'.`** The other values
  at apex are `product` (memberships/passes/merch), `site-reservation` (facility),
  `event-ticket`, `deposit`.
- **Verified against the other path rather than assumed.** El Segundo monthly,
  this card against the base-table query: **2026-06 $149 / 2026-07 $5,967 /
  2026-08 $77,813 — identical on all three CLOSED months.** September differed by
  $214 and that is the open-window trap from the Clarksville backcheck, not a
  discrepancy: the two reads were 40 minutes apart.
- **`datetime_at_primary_timezone` is ALREADY localized**, so it is cast bare and
  the card never writes `AT TIME ZONE`. That removes the whole Pacific-rendering
  class of bug from a rollup where it would land boundary payments in the wrong
  month.
- **The basis is the transaction, not `payment.created_at`** (what 17295's Period
  Received uses). Platform-wide over 12 months, **33 of 2,008,894 transactions
  across 8 orgs** fall in a different MONTH under the two bases, max gap 98 days.
  0.0016%, but real — so the panel is labelled collection activity and never
  presented as reconciling to Period Received.
- `generate_series` gives every month a row, so a month with no money is a real 0
  and the page never does date arithmetic to build an axis.

**SHIPPED AND SIGNED OFF 2026-09-01.** Public UUID
`a9f6a60e-43bf-4368-ada9-c6a7245f639c`, tags flipped to Date by Dan, and verified
through the public endpoint **with the app's own `date/single` parameters** —
apex **12 rows in 1.9s** over Sep 2025–Aug 2026. The push→flip dance behaved
exactly as this file predicts and is worth recording as a clean example: the card
registered **three** parameters rather than six, so there were no duplicates, but
both dates came back `string/=`. Probed both shapes before and after the flip:

| parameter shape | before the flip | after |
|---|---|---|
| the card's own types (`string/=`) | 200, 6 rows, 4.8s | **400** |
| what the app sends (`date/single`) | **400 "An error occurred."** | 200, 6 rows, 1.7s |

`buildMetabaseParams` hardcodes `date/single`, so a Text tag is not a cosmetic
problem — it is the whole feed. **The UUID was wired BEFORE the flip on purpose**,
because the page treats an erroring feed exactly as it treats a missing card, so
the panel completed itself the moment the tags changed with no redeploy.

**It is ABSENT until someone creates the public link.** `SHARED_UUIDS` takes it
from `MB_PROGRAMS_MONTHLY_UUID` and omits the key entirely when unset, so the
route 404s and the page draws the activity chart alone. A row of confident $0
bars would say this org collected nothing when the truth is that nothing
answered — the `hasAbsent` / `ciHasStatus` rule.

### THE EXCEL EXPORT WAS IGNORING EVERY FILTER, and that predates this

Found while adding the two columns Dan asked for. `downloadExcel` read `rows` —
the **unscoped** program rollups — so an admin who narrowed to one location, one
season or a search term and hit Excel got the whole org. It reads `filteredRows`
now, the same set the grand total and the summary cards already use.

The two new columns carry the **distinct set** across the program's sections
(`progDistinctFromSections`), not a dash: a spreadsheet row cannot be expanded,
so where the screen makes you open a program the file has to carry the answer.
Joined with **`"; "` and not `", "`**, because the values themselves can contain
a comma and a comma-joined set could never be taken apart again.

### Guards

`scripts/programs-instructor.spec.js` (**67 assertions, in CI**), which LIFTS AND
RUNS the seven helpers rather than regexing them, and reads the card mirror and
`server.js`. Plus **12 new `ci-check-render.js` cases**, keyed on computed values
— the instructor CELL, the program COUNT under a tick, and the two peak MONTHS —
over a fixture where the activity peak (September) and the money peak (August)
are deliberately different months, because a fixture where they coincide cannot
tell a correct panel from one drawing the same series twice. New stub modes:
`previnstr` (a pre-v6 feed, columns absent) and `nomonthly` (card 21055 answers
404, money chart absent while the activity chart still draws).

**Two of my own cases were wrong in ways only the browser shows**, both fixed
before the run reported: `openFirstProgram` clicked whichever program sorted
first, making the case depend on the sort rather than the column; and
`pickInstructor` selected by attribute value, which cannot work for
"No instructor on file" — its value is the `\u0000` sentinel. It ticks by visible
label now.

**A spec-harness note:** the source assertions run over a comment-stripped copy,
because the comments quote the broken forms (`new Date(`, a comma split) on
purpose — and one assertion still failed on correct code first time by matching
`data-prog-season-btn` when it meant the CSS class `.season-btn`. Third instance
of that in this file.

## The Programs Revenue tab: three fixes (2026-09-02) — WAS the pin below

Dan: *"columns misaligned and some of the numbers aren't matching up, and I
think the autopay icon is supposed to be on here, no?"* All three, fixed. The
pin's diagnosis is kept below it, because what it ruled OUT is the useful part.

### "Misaligned" was the table being SQUEEZED, not drifting

The header and body are one table, so they cannot structurally misalign — which
is why the pin sent the next person to the header/body relationship under
scroll. The actual cause: `.prog-table` had `width: 100%` inside a
`.table-scroll`, and that tells the browser to FIT THE CONTAINER — so it
compresses every column to do it, the `nowrap` headers stop sitting over their
own values, and the last one clips mid-word (`PERIOD…` in the screenshot).
`min-width: max-content` lets the columns take their natural width and the
container scroll, which is what a scroller is for.

### A section row now counts itself

The SECTIONS cell printed a dash on section rows, so a parent reading `2` sat
over two rows reading nothing. That is what read as the numbers not matching:
the column is headed Sections and a section row is one of them, so it reads
**1** and 1 + 1 reconciles on screen.

Not touched, deliberately: **Enroll 113 against Utilization 717** at Essex
Junction is the per-session multiplier over 9 camp days — a ~6.3x that looks
like a mismatch and is not. Recorded in the pin so nobody "fixes" it.

### The auto-pay column, finally displayed

Third instance of a column that arrives, is summed, and renders nowhere: card
17295 v7's four per-section columns were mapped AND rolled up per program, and
only the single summary KPI read them.

- **`progAutopayCell(r)` goes through `progAutopayShare([r])`**, not its own
  arithmetic, so the column and the KPI cannot disagree about one program — and
  the spec that guards the KPI's maths guards the column too.
- **DOLLARS, not registrations.** The two readings differ 26x at apex, and this
  cell sits in a row of money.
- **No plan money is a dash, never 0%.** "Nobody uses auto-pay" and "this
  program runs no payment plans" are different facts. A REAL 0% still shows —
  plan money collected entirely by hand is the answer most worth acting on.
- Presence-gated on `colPresence.autopay`, asked of the raw response, so a warm
  pre-v7 cache entry hides the column rather than rendering a confident 0%.
- **The Grand Total row grew with it**, or every figure after it shifts a column
  left — the exact fault the last two column additions caused. A render case
  compares the footer's total colSpan against the header's column count.

**A mutation that survived the first draft**, and the reason is worth keeping:
dropping the `planValue <= 0` guard passed, because `progAutopayShare` already
returns null when items and value are both zero. The discriminating fixture is a
program with plan REGISTRATIONS and no plan DOLLARS — installments that price to
nothing — where the share is non-null with a null percentage and the page would
render `null%`.

Guards: `programs-autopay.spec.js` 94 → **103 assertions**, lifting and RUNNING
`progAutopayCell`. Four render cases keyed on the computed VALUE, the footer's
column count, and the section row's own `1`; all four mutation-tested (the cell
removed, the total row losing the column, the section count back to a dash, and
the presence gate hardcoded true).

## The tables behind the charts are downloadable (2026-09-03)

Dan: *"they are pretty to look at, but harder to get the actual data out that
they need."* Correct, and the gap was total: **every report exported ONE sheet of
raw rows and none of the chart aggregates.** Lane hours by lane, revenue by
site, the day-part grid, bookings by month, programs by month, per-location and
per-instructor — all of it existed only as pictures. Getting "hours by lane" out
meant re-deriving the hour maths by hand, and that maths (`oeRowHours`, the
multi-day exclusion, the clock parse) is not in the export at all.

His call: **both** a per-panel link and a workbook, **Aquatics + Programs first.**

### ONE BUILDER, TWO READERS — the whole design

Each table has one builder, called by **both** the panel's download link and the
workbook sheet. A sheet that reimplemented its panel's rollup would drift the
first time either changed, and no source assertion can tell the two apart — the
same reason `progAutopayCell` goes through `progAutopayShare`.

`aqSheetTables()` is the workbook's registry; `panel-csv.spec.js` asserts every
builder in it is called **at least three times** (its definition, the panel link,
the sheet), so a table you can get one way but not the other fails.

**The builders take the already-reduced table, not the raw feed.** Handed raw
rows they would have to reduce it a second way, which is the drift this exists
to prevent.

**Lane hours are panel-only, deliberately.** They come from card 17294, which
the hub page fetches *only inside the lane-hours panel* — the hub feed carries no
wall-clock times. A sheet would have to re-fetch and re-reduce. The spec pins
that they are absent from the registry AND present on the panel, so the omission
is a decision rather than a gap.

### `csvFromRows` is shared, because the quoting rule was being copied

One writer in `public/open-pdf.js` (already loaded by every page that exports):
RFC4180 quoting, CRLF, ISO dates, empty for null. Both cases it guards are real —
El Segundo has a lane called `Inst Lane 4-2" Depth (25Y) - A`, and a section
named `Camp, Red` shifts every column after it. Fast Track and the roster keep
their own copies (both guarded, one byte-matched against Metabase); the spec
asserts no NEW page grows a third.

### The decisions worth keeping

- **The grids come out LONG, not wide.** One row per weekday per hour, one per
  month per weekday. A 7×24 block has to be unpivoted by hand before it pivots.
- **Revenue by site downloads EVERY site, not the twelve the chart draws** — the
  chart is capped for legibility and a file has no such reason. Said out loud in
  the builder, because a reader diffing 12 bars against 70 rows should know
  which one was capped.
- **A future month's money is BLANK, never 0.** Unsold inventory and
  earned-nothing are different facts — the same rule the hatched bars encode.
- **A blank instructor is its OWN ROW**, not dropped: 65% of El Segundo's
  sections have none, and omitting them would make the file disagree with the
  enrolment total on screen.
- **Per-location and per-instructor are SECTION grain.** 11.6% of programs with
  a located section run at more than one site, so a program-grain rollup files
  money against a site the reader excluded.
- **No control where there is nothing to download** — absent, not disabled, and
  the workbook skips an empty table rather than writing a bare header.
- **The Programs sheets read `filteredRows`**, not the unscoped feed. That exact
  bug is already recorded in this file for the Excel export.
- Both go through `saveTextViaPopup` and ask for the **BOM**: a download started
  from a sandboxed iframe is silently dropped, and Excel sniffs bytes.

### `panel-csv` (📈) — WHICH chart, not that a download happened

Which panel people need the numbers out of is the most useful signal we have
about where the reports stop being enough on screen. So the message **names the
panel** — "downloaded chart data from *facility*" says nothing — and it
**debounces by panel**, because pulling lane hours and then revenue-by-site is
two needs and the default `org|report|event` key would keep only the first.

On **both** log routes: `facilities` is not in `REPORT_TYPES` so the hub needs
its own, `programs` rides the generic one. Miss either allowlist and the beacon
400s and, being fire-and-forget, never complains — the trap that has now bitten
this repo four times.

### Two bugs found while building it

- **`CFG` DOES NOT EXIST ON `programs.html`.** It derives the org from the path
  (`getOrgAndBase`), so `CFG.slug` threw *"CFG is not defined"* the moment the
  link was clicked. Invisible in source review and to every spec — the render
  check caught it on the first run. Copying a component between two pages
  copies its assumptions about what is in scope.
- **The season spec THREW instead of failing.** `programs-season.spec.js` slices
  module scope from `const SEASON_NONE` to `function getParams` and evaluates it
  with `new Function`, which cannot parse JSX — so defining `ProgPanelCsv` in
  that range killed the process with *"Unexpected token '<'"* before a single
  assertion ran. The component now sits deliberately BELOW `getParams`, with a
  comment saying why. **Fourth instance of a slice reaching past its own
  inputs** in this file, and the second where a guard died instead of failing.

### Guards

`scripts/panel-csv.spec.js` (**30 assertions, in CI**, the last five covering
the Community Intel lists below), which LIFTS AND RUNS the
shared writer and all nine builders — a source assertion cannot tell a sheet
that shares a builder from one that reimplements it. Mutation-tested: the comma
quoting dropped, a table removed from the workbook registry, a link offered on
an empty table, and the Programs sheets reading the unscoped feed — all fail by
name.

Plus **five `ci-check-render.js` cases** that read the BYTES the popup is handed
rather than "a link rendered", since a link wired to the wrong table renders
identically. Two mutations were verified against them: the lane-hours link
pointed at a different real table, and the day-part grid emitted wide instead of
long (7 rows instead of 168). `aquatics-scope.spec.js`'s `siteLabel` caller
count went 8 → 9, which is how the download inherits the lane-name fix.

## Community Intel's contact lists download again (2026-09-03)

Dan: *"lets also reenable the csv downloads from the community intel report
(we'd previously hidden them behind a different button)."*

There were seven **"📋 Request CSV"** buttons, and every one of them opened a
sheet reading *"🔒 CSV Export Restricted — to protect user privacy, CSV exports
containing personally identifiable information are no longer available for
direct download"*, pointing the reader at `partnersupport@rec.us`. `git log -S`
shows `users.html` entered this repo already carrying that block, so the modal's
own text was the only stated reason for it anywhere.

**It is reversed on Dan's call, and the Slack record is what pays for it.** The
files carry resident names, emails and phone numbers, so the thing to avoid is a
list leaving the platform with no record of who took what: every download now
beacons `intel-csv` (📇) carrying the **segment and the contact count**, so the
activity feed says *"downloaded the lapsing contact list — 412 contacts"* rather
than that an export happened. Debounced **per segment**, like `epact` and
`ft-export`: pulling the lapsing list and then the non-resident one is two
different asks. The segment is clamped server-side, never echoed.

- **THE RESTRICTION SHEET IS DELETED, not left unreachable.** `requestCSV` and
  `csvRequestModal` are gone with it — a modal nothing opens is the dead-end
  pattern this file keeps writing down, and the spec asserts the copy cannot
  come back.
- **ONE writer for all seven segments** (`downloadContacts`), so `INTEL_COLS` is
  declared once and seven files cannot carry seven shapes. It goes through
  `csvFromRows` + `saveTextViaPopup` with the **BOM**, like every other download
  here — a sandboxed iframe's own download is silently dropped, and Excel sniffs
  bytes rather than trusting UTF-8.
- **An empty list yields no file.** A header row and nothing under it is the
  dead end, so the guard is on the list, not on the button being disabled.
- Eight call sites for seven segments: **`unbooked` is offered twice**, from the
  leverage list and from its own button, and both reach the same writer.

**NO SOURCE ASSERTION CAN CHECK ANY OF THIS.** Seven buttons call one writer
with seven different lists, so a button handed the wrong list renders
identically and produces a perfectly plausible file. So the two render cases
read the BYTES the popup is handed, over an `intelRows()` fixture built so that
**every segment holds different households** — unbooked is Solo + Pascal,
lapsing is Turing, engaged is Johnson, programs-only is Lovelace + Turing. Two
lists of one row cannot be told apart by their length, which is why the second
case keys on the NAME in each file. Verified to fail on the engaged button
pointed at the lapsing list, on the BOM dropped, and on the beacon renamed.

**The fixture's household SIZES are load-bearing**, which is not obvious: the
"activate solo households" lever only renders when pairs convert better than
singles, and that lever is what draws the leverage list's own download button.
A fixture of five single-person households renders no lever and the case would
have nothing to click.

**And the beacon had to be spied on `fetch`, not read from resource timing** —
it is sent with `keepalive`, and those requests do not reliably appear in
`performance.getEntriesByType("resource")`. The first draft of that assertion
passed nothing and read as a page failure.

## The Programs summary revenue labels, and Total Refunds (2026-09-03) — WAS the pin below

Both pins below are FIXED, and the diagnosis under them is kept because what it
ruled out is the useful part: **the arithmetic never changed.**

### The labels were the bug, so the WINDOW figure leads now

Dan, on Apex over 1-31 August: *"it seems these revenue amounts are a bit high,
no? This is august program revenue for Aug"*. The row now reads

| card | figure | sub-line |
|---|---|---|
| **Net Revenue in Period** | `period_net` | *received minus refunds, Aug 1–31* |
| **Refunds in Period** | `period_refunds` | *N% of $X received · $Y all-time* |
| **Lifetime Net Revenue** | `net_total` | *all-time for these programs, not just this period* |

The period figure leads because **a reader of a date-ranged report means that
one by "August revenue"**, and each card now names its own basis instead of
leaving the reader to infer it from a header. Nothing about how either number is
computed moved.

**AND THE TWO TABS DISAGREED UNDER ONE LABEL, which is worse than either card
being vague.** The Summary tab's *"Collected in Period"* showed `period_NET`
while the Revenue tab's card of the **same name** shows `period_RECEIVED` — one
label, two different numbers, on one report. There is exactly one
*"Collected in Period"* now (the Revenue tab's receipts), and both tabs call the
all-time figure **Lifetime Net Revenue**. The spec counts both.

### Total Refunds needed NO card change, and that is the fourth instance

Dan: *"pin to add a 'total refunds' metric/card on this program summary page.
seems like that's a big item we're missing."*

Card 17295 has emitted `refunds`, `period_refunds` and `period_net` **since v3**,
and `public/programs.html` has mapped, rolled up and Excel-exported all three the
whole time — **no surface read them.** So this was client-side: no push, no
date-tag flip, no downtime on the platform's most-used card. Fourth instance of
the mapped-and-rendered-nowhere pattern (the location filter, then instructor,
then the auto-pay columns), and it is why the render cases key on the **CELL**.

- **Windowed leads and lifetime follows, inside one card.** Splitting them into
  two cards would re-open the same lifetime-vs-window question one card over,
  which is the thing the relabel exists to close.
- **The share is refunds against payments RECEIVED in the same window** — a
  cash-flow ratio, not a per-registration refund rate. An August refund of a
  June payment is ordinary, so the two need not describe the same
  registrations, and the tooltip says so.
- **The share is `null`, never 0%, when nothing came in.** "No payments arrived"
  is not a 0% refund rate. A **real** 0% still shows: money in and none back out
  is an answer.
- **Presence-gated on the RAW response** (`colPresence.refunds`), because the
  mapper defaults BOTH refund columns to `0` — a value test renders a confident
  `$0` on every warm pre-v3 cache entry, saying *"this org refunded nothing"*
  when the truth is *"this feed cannot tell us"*. Same rule as `hasAbsent` /
  `ciHasStatus` / `mbHasProductKind`.

### ONE REDUCER, N READERS — `progRevTotals`

Six inline `reduce`s over the same rows is how the summary row and the two Grand
Total rows start reporting different totals for one window. `progRevTotals` is
the single source and the spec fails if any of those reduces comes back inline —
the same rule that sends `progAutopayCell` through `progAutopayShare`.

**`winLabel` is named once and guards both dates.** `fmtRangeShort(null, null)`
does not throw: it renders the literal **"Invalid Date NaN"**, so a card would
print that on screen during the window between mount and the feed answering.

### Guards

`scripts/programs-revenue-labels.spec.js` (**37 assertions, in CI**), which LIFTS
AND RUNS `progRevTotals` over Apex's real proportions ($2,768,423 lifetime
against $275,553 in-window) rather than regexing it. Mutation-tested seven ways,
all failing by name: the labels reverted (the bug exactly as Dan hit it), the
null share defaulting to 0%, the presence gate hardcoded true, the lifetime card
put back first, period refunds summed from the all-time column, a reduce
re-inlined beside the helper, and `winLabel` built without its null guard.

**One assertion could not discriminate at first, and mutation is what showed
it.** The order check used `indexOf("Net Revenue in Period")` — and the LIFETIME
card's own tooltip says *"Read "Net Revenue in Period" for the window"*, so
swapping the two cards left the assertion passing. It keys on the label markup
(`>…</div>`) now.

Plus **seven `ci-check-render.js` cases**, keyed on the computed VALUE, over a
fixture whose lifetime total ($100,000) is **eleven times** its in-window one
($9,000) — that gap IS the complaint, and a fixture where the two are close
cannot tell a card reading the right column from one reading the other. All five
figures are deliberately distinct (100000 / 12000 / 10000 / 1000 / 9000). A new
`prev3` stub mode drops the refund columns, so the pre-v3 degradation is proven
in a browser: the refunds card is **absent from the DOM**, the two revenue cards
still render, and period net reads receipts alone (10,000, not 9,000) — which
also proves the card reads the feed rather than a constant. Both browser-only
mutations were verified to fail: the presence gate hardcoded true, and the
refunds cell reading the all-time column.

### The diagnosis, kept — "NET REVENUE" is LIFETIME, not the window (2026-09-02)

Dan, on Apex over 1-31 August 2026: *"and it seems these revenue amounts are a
bit high, no? This is august program revenue for Aug"* — the tab read
**NET REVENUE $2,768,423** ("total for these programs") beside
**COLLECTED IN PERIOD $275,553** ("payments received in date range"), under a
header saying *August 1, 2026 - August 31, 2026*.

**He is right, and the numbers are not wrong — the LABELS are.** Read out of
card 17295 rather than guessed:

- **Sections are windowed by their SESSION DATES OVERLAPPING the range** (the
  card's last two `[[ ]]` clauses), so August returns every section that *runs*
  in August — 1,529 of them.
- **`net_total` is `received_cents - refund_cents` ALL-TIME for those sections.**
  That is the $2,768,423: the whole registration revenue of every section
  running in August, collected over however many months it took.
- **`period_received` is payments whose `payment.created_at` falls in the window,
  FOR THOSE SECTIONS ONLY.** That is the $275,553.

**Apex's actual August programme money, measured from the item log**
(`order_item_type = 'reservation-enrollment'`, the card 21055 basis):

| month | payments | refunds | net |
|---|---|---|---|
| 2026-06 | $667,137 | $99,763 | $567,374 |
| 2026-07 | $568,461 | $93,695 | $474,766 |
| **2026-08** | **$789,595** | **$67,846** | **$721,749** |

So **neither KPI is August's $721,749** — one is ~3.8x it and the other ~38% of
it, and both are correct for what they actually measure. The ~$514K gap on the
period card is August money paid for sections that do NOT run in August (fall
and winter registrations), which is a real distinction the sub-line *"payments
received in date range"* does not make.

**The detail table already says it and the KPI card does not.** `Net Rev`'s
`title` reads *"Lifetime net revenue for these programs (received minus
refunds)"*; the card says only *"total for these programs"*. Same defect shape
as the guessed grain phrases on the wizard: a confident sub-line under a figure
whose basis it misstates.

**FIXED 2026-09-03 — see the section above.** It was wording, not arithmetic,
exactly as this said: the lifetime figure is named as lifetime, the period
figure says what it is net of, and `period_net` leads. The diagnosis stays
because what it RULED OUT is the useful part — neither number was wrong, so
nobody should go looking for a bug in the card.

#### ...and TOTAL REFUNDS needs no card change (Dan, same afternoon)

*"pin to add a 'total refunds' metric/card on this program summary page. seems
like that's a big item we're missing."*

**Card 17295 has emitted `refunds`, `period_refunds` and `period_net` since v3,
and `public/programs.html` already MAPS all three, rolls them up per program and
writes them into the Excel export** — no KPI card reads them. So this is a
client-side change with no push, no date-tag flip and no downtime on the
platform's most-used card, which is the opposite of what it looks like.

Third instance of the mapped-and-rendered-nowhere pattern in this file (the
location filter, then instructor, then the auto-pay columns). **A source
assertion cannot see a column that is mapped, rolled up and never displayed** —
so whatever is built must be keyed on the CELL in a render case.

**BUILT 2026-09-03 — see the section above.** Both things this said to settle
were settled the way it suggested: windowed leads with all-time on the same
card's sub-line (labelled together, not separately), and the card is
presence-gated on the raw response so a real $0 renders while a pre-v3 feed
shows nothing.

## Laurel's asks on the Programs summary (2026-09-03)

Laurel Rossiter at Shrewsbury, on a call, on why she does not use this report:

> *"registration day opens and I can literally watch people register for stuff
> and keep track... This one, I'm like, oh, let me run this report. But then
> it's bringing up stuff that we canceled like last summer or we never ran...
> I feel like I'm not doing it right."*
> *"Challenge Island, we canceled before it even ran. Like, why is it on this
> report? And that's from, like, last year."*
> *"this enhanced reports when it's not working, we don't have the seasons
> tab."*

Dan: *"Maybe we've gone too deep down the rabbit hole of functionality and lost
focus on what people need."* The measured contrast, on her own window: **her
Metabase card is 4 columns, 0 filters, instant; this report is 7 tabs, 10
controls, 14 KPI cards and 31.4 seconds** — 195 sections, **21 of them
Canceled**, 26 outside the season she was looking at, and four season options
that *did* exist but could not be seen until the load finished.

### CANCELLED SECTIONS ARE OUT BY DEFAULT

`progIsCanceledSection(r)` is the one predicate, read by the funnel **and** by
the control's own count — two copies and the checkbox offers "Show 21
cancelled" while ticking it moves 19 rows.

- **The funnel now runs with NOTHING ticked**, which is the load-bearing change:
  `scopedRows` used to hand `rows` straight back when no filter was picked,
  correct while every filter was opt-in and wrong the moment one became the
  DEFAULT. The early return is gated on `dropCanceled` too.
- **It filters at SECTION grain.** A program is `Canceled` only when every
  section is, so a program-grain test keeps a cancelled section inside a live
  program and drops a live section inside a mostly-cancelled one.
- **Both spellings.** `Canceled` and `Cancelled` are both in the data and the
  section table has tested both since it shipped.
- **Not persisted.** Whether to look at cancellations is a question about this
  window, not a layout preference — an admin returning to a silently widened
  report reads a superset as the whole truth.
- **Absent where there is nothing**: no checkbox reading "Show 0 cancelled".

### THE SEASON PICKER NO LONGER WAITS FOR THE FEED

Her complaint reads as a missing feature and is a timing one: the options were
built from the rows, so **during the 31 seconds the control that would have
narrowed those 31 seconds does not exist.**

`rememberOrgSeasons(slug, rows)` keeps what each org's programs feed last
carried and `knownSeasons` is injected into `ORG_CONFIG`; the options are the
**union** of that and the current rows.

- **Seeded at ZERO.** A season with nothing in this window is still tickable and
  its count says so — the honest form of "we know this season exists".
- **An empty answer never overwrites what we knew.** A feed that did not answer
  is not an org with no seasons.
- **Picking a season CLEARS the dates and refetches.** Intersecting a season
  with a date range typed for a different question is how a filter appears to
  do nothing; the season is the window.
- Empty folds to the card's own literal `No Season`, exactly as `seasonKey`
  already does, or a pre-v6 feed produces a second unticked option for the same
  fact.

### Laurel's Coffee Chart LIVES ON THE ORG DASHBOARD, not here

Built here first, then moved the same afternoon. Dan: *"I ruminated on the live
reports/widgets, and decided they don't belong on the reporting project side...
The new live coffee counter widget, and all other live widgets, need to live on
the org-dashboard project. A dashboard is the spot for live data, not static
reports."*

**The line is between a REPORT and a DASHBOARD, not between two features.** This
page answers a question about a window somebody chose; a panel refreshing itself
under that answer is a second, contradictory clock on the same screen. It is
rec-dashboard's **Live Widgets** section now, and the card mirror moved with it
to `rec-dashboard/sql/enrollments-live.sql`.

**What came out of rental-report when it moved**, so nothing is left half-wired:
the `ProgCoffeeChart` component and its CSS, the `enrollments` report type
(`REPORT_TYPES`, `REPORT_META`, `NON_ADDABLE_REPORTS`, `HEALTH_SKIP_REPORTS`,
its 5-minute TTL and its `SHARED_UUIDS` entry), the `coffeeChart` injection, and
the `coffee-open` beacon in all four places it was wired. A registered report
type nothing serves is the dead-end pattern this file keeps writing down.

**Card 21286 stays** — it is the dashboard's now. See that repo's notes for the
four defects it fixes against Laurel's own card 3571.

### THE 31 SECONDS IS A CACHE MISS BY CONSTRUCTION

Dan: *"wasn't this cached from an earlier run?"* No, and it cannot be:
`feedCacheKey` includes the encoded parameter string, so **every distinct date
window is its own entry**, and prewarm writes exactly three keys per org — no
dates, the default window, and This Month. A window an admin types is a
guaranteed cold run of card 17295.

Four levers, cheapest first, and only the first is done:

1. **Don't block the page on it.** The coffee chart, the toolbar and the season
   picker now paint immediately, so the wait is "list on screen, table filling
   in" rather than 31 seconds of nothing.
2. **Warm the windows people open** — last/next month and the org's season
   spans, 2–3 more queries per org per day.
3. **Serve stale while revalidating**, which needs care: it must never show one
   window's numbers under another window's label.
4. **Split card 17295.** The KPI row needs ~8 aggregates; the section table
   needs 30+ columns per section. Two cards means the numbers land in seconds.
   This is the real fix and it is a push, a tag flip and downtime on the
   platform's most-used card — a decision, not a drive-by.

### THREE PANELS REMOVED, and the fetch went with them

Dan: *"remove these three sections, they are noisy."* Self-Service & Staff
Workload, Session Attendance and Waitlist Demand — three full-width tinted bands
above the numbers people come for, together pushing the charts and the programme
table below the fold on the summary that is meant to be the front door.

**The self-service FEED went too**: two Metabase fetches per load whose result
nothing read any more, on the page whose load time is the complaint. Everything
else is untouched — `checkinSummary` and the waitlist columns are still computed
and still displayed by the Check-Ins tab, the programme table and the Excel
export, so restoring a panel is markup rather than a rebuild.

**CONSEQUENCE WORTH KNOWING:** `selfservice` had no `view` events of its own —
it was ACTIVE purely because this page fetched it — so it will age out of
`REPORT_ACTIVITY_WINDOW_DAYS` and its `schema-break` / `param-drift` alerts will
stop. That is the activity gate working as designed, and it is still a real
change in what is watched.

### "Top Programs by Revenue doesn't react to the filters" — it was the SCALE

The row set was scoped all along (it comes off `filteredRows`). Two things were
wrong and together they made the picture look frozen:

- **The bars were scaled to `top10[0].netRevenue`** — the row that happened to
  sort first, not the largest — so anything bigger computed over 100% and
  clipped. Dan's screenshot has **four bars pegged full width across a
  $1,575-to-$7,650 range**.
- **The chart took its top ten from an order by `periodNet`** and then labelled
  and drew `netRevenue`. A chart whose order disagrees with its own bars barely
  moves when the rows change.

Now sorted by the figure it draws, scaled to the maximum over the rows drawn,
clamped at 100. `data-prog-toprev` carries the computed percentage so a render
case can require **exactly one** bar reading 100.

### Status pills over All Programs

Dan: *"add quick, pill style filters to the top of the 'all programs' section to
filter by upcoming, in progress, etc."* `PROG_STATUSES` at module scope, counts
from the already-scoped set.

- **Empty means ALL**, the same rule as the season and instructor pickers — so
  there is a Clear and no "select all", because two controls producing one state
  is a control that looks broken.
- **`Past` is labelled "Ran"**, the word the table's own badge uses. Two
  spellings of one status on one screen is how a filter stops matching what the
  reader sees.
- **A status with nothing behind it is not offered**, and with fewer than two
  live statuses there is no pill row at all — one status is not a filter, and a
  Cancelled pill that can only empty the table is a dead end.
- **The pills scope the TABLE, not the cards above it.** The ask was a quick way
  to read one table; moving the KPI row with it would make "Upcoming" look like
  the whole report. Which is exactly why the Total row **says what it covers**
  (`Total · all 27`) instead of quietly disagreeing with the rows above it.

### THE TOOLBAR WAS PINNED — UNDERNEATH THE BANNER

Dan: *"we need to 'pin' this top header with all the search stuff. scrolling
down and having it disappear is super frustrating."* It **was** pinned:
`.toolbar` is `position: sticky; top: 0` and has been for months. So is the
early-access banner (`.rec-banner`, z-index 99998), and it wins — so the
toolbar stuck *behind* it and the top of the date fields was cut off the moment
the page scrolled.

**The banner owns its height, so the banner publishes it.**
`feedback-widget.js` sets `--rec-banner-h` on the root element and every report
sticks at `var(--rec-banner-h, 0px)` — a 0px fallback, so a page that never
loads the widget is unchanged.

- **MEASURED, never a constant.** The banner WRAPS on a narrow viewport and
  gets taller: a hardcoded 44px pins the toolbar into it on a laptop and leaves
  a gap on a phone. Re-measured on resize, and through a `ResizeObserver`
  because the message can rewrap without the window changing size.
- **Fixed on all 15 live report pages, not just the one Dan was looking at.**
  The bug is the PAIR of rules, so it exists everywhere both appear — every
  report on the platform had it. The mockups are left alone.

### Guards

`scripts/programs-summary.spec.js` (**68 assertions, in CI**), which LIFTS AND
RUNS `progIsCanceledSection`. Mutation-tested, all failing by
name: the bar scale reverted to the first row (the bug as Dan saw it), the
funnel's early return no longer gated on `dropCanceled` (so the exclusion
silently waits for another filter), the table reading the unscoped set, and —
while the coffee chart was still here — its link's presence gate hardcoded true
and `coffee-open` dropped from the log route's `ALLOWED` list.

**One mutation survived the first draft**, and the reason generalises: the
presence-gate assertion tested `r['Section Id'] ?` file-wide, which also matches
the **nullish coalescing** in `normalizeRow` and in `checkinRows`. Scope an
assertion to the surface it is about.

**Four assertions passed vacuously on the first draft**, for the reason already
recorded in this file: I ran them against a comment-STRIPPED copy of server.js,
and a `/*` inside a template literal means no strip order is sound there — both
orders swallow the region holding the log route. Those assertions read the raw
source and slice the region instead.

Plus **`ci-check-render.js` cases keyed on computed values**: the pill-scoped
table count and the single 100% bar. The fixture gained a **cancelled section
that is its own programme** (so excluding it moves `data-prog-count` 4 → 3;
inside an existing programme the count would not move and no case could
discriminate) and an **Upcoming** programme (so the pills have two live options
and one selects exactly one row).

**Two pre-existing specs had to be taught about the new funnel argument**, and
both are instances of shapes this file already records:
`programs-instructor.spec.js` pinned the literal dependency array, so adding a
fourth dimension broke it with nothing about instructors having changed — it
tests membership now; and `programs-season.spec.js` RUNS the real funnel, so it
had to supply `showCanceledSections`, which it passes as `true` to keep testing
what it was written to test, plus one new assertion that the funnel does NOT
short-circuit when cancellations are hidden.

## PINNED TO FIX: the Programs REVENUE tab table (Dan, 2026-09-02)

*(Recorded first as "the detail table", which was wrong and would have sent the
next person to the wrong surface. Dan asked "are we fixing the programs revenue
tab?" and he is right — the table below is inside `tab === 'revenue'`, the one
with Charged / Received / Outstanding / Refunds / Net Rev and the Grand Total
row. `leftCols` and that Grand Total row belong to the revenue table.)*

Dan, on Essex Junction's Fall Vacation Camps: *"columns misaligned and some of
the numbers aren't matching up, and I think the autopay icon is supposed to be on
here, no?"* Pinned, not fixed. Recorded with what was CHECKED against his
screenshot, so whoever picks it up does not re-derive it or chase phantoms.

### The autopay columns are read by exactly one surface, and no table

**Confirmed by grep: nothing on `programs.html` reads `autopayPlanItems` or
`autopayPlanValue` except `progAutopayShare`**, which draws the single summary
KPI. Card 17295 v7 emits four additive per-section columns
(`autopay_plan_items` / `_value`, `manual_plan_items` / `_value`), they are
mapped, and `rollupToPrograms` even sums them per program — and then no table
column, badge or icon exists anywhere. Dan is right that it should be here: the
data is per section, the rollup is per program, and both are already computed.

Same shape as the location and instructor columns that were mapped and rendered
nowhere for a day. **A source assertion cannot see a column that is mapped,
rolled up and never displayed** — so whatever is built must be keyed on the CELL
in a render case, like `data-prog-instrcell`.

### THE ARITHMETIC IN THAT SCREENSHOT RECONCILES — do not start there

Checked every parent against its two children before pinning:

| | parent | children | |
|---|---|---|---|
| Enroll | 113 | 37 + 76 | ✓ |
| Utilization | 717 / 1,584 | 240/612 + 477/972 | ✓ |
| Charged | $28,273.00 | 9,163 + 19,110 | ✓ |
| Received | $23,520.00 | 7,766.50 + 15,753.50 | ✓ |
| Outstanding | $5,439.00 | 2,082.50 + 3,356.50 | ✓ |
| Fill % | 45.3% | 717/1,584 = 45.27% | ✓ |

So the rollup is not the bug. **Two candidates for what he is reading as "not
matching up":**

1. **The SECTIONS cell.** The parent reads `2` and each child reads `—`, so a
   column headed SECTIONS shows a total with nothing under it. A section row
   should read `1`, or the column should be blank on the parent too — one of the
   two, not both.
2. **Enroll 113 against Utilization 717.** Essex Junction runs
   `registration_mode = per-session` over 9 camp days, so utilization counts
   session seats and enrolment counts registrations — a ~6.3x multiplier that
   looks like a mismatch and is not. Same per-session multiplier already recorded
   for Fast Track's `FT Total`. If it stays, the column needs to say which unit
   it is in.

### The alignment

`leftCols = 4 + regMode + location + instructor` — 6 in his view (Program,
Season, Location, Instructor, Start, End), which is correct, and the Grand Total
row's `2` does land under SECTIONS in the screenshot. So the Grand Total colSpan
is NOT the fault, which is where the last two column additions went wrong and is
the obvious place to look. Start with the header/body width relationship under
horizontal scroll instead — the table scrolls (PERIOD… is cut off mid-word) and
the header is a separate row inside the same scroller.

## The instructor was on screen and nobody could find it (2026-09-02)

Two placement bugs in one afternoon, both reported from the live pages, both
mine, and both the same mistake: the control or the data was rendering correctly
somewhere nobody looks.

### The Aquatics gear was in a footnote

Dan: *"not seeing the report settings options here anywhere"*, with a screenshot
of the top of the Pool / Aquatics tab.

It was rendering. `reportSettings` is ON in production and the injected
`settingsLockable` was `true`, so a **locked gear was on the page** — mounted
inside the scope note at the BOTTOM of the tab, four panels below the fold.

Fixed twice, because the first fix was still wrong. It moved to a scope bar
above the KPI cards, which is where a statement of *what this tab counts*
belongs; then Dan: *"needs to be the upper right corner of the top bar, same as
on every main page of every report."* It is the **last item in the toolbar** now,
like every other report's gear, and it is **labelled** — a bare ⚙ in a dark
toolbar is what made it invisible in the first place. The scope bar stays,
without the gear, because the scope sentence is still worth reading before the
numbers.

**It no longer needs a second mount on the empty branch.** The toolbar renders
whatever the tab shows, so an org with no pool bookings reaches the setting
without the special case that branch existed for.

### THE GEAR IS AN ICON, AND THE PANEL WAS BROKEN BY ITS OWN NEW HOME

Dan: *"just a settings icon here, no text needed, ever on any report. and this
settings page doesn't seem to be working correctly."*

**The label is gone.** Labelling it was an overcorrection for having been
unfindable, and the fix for that was its POSITION. Every report's gear is the
bare glyph, and the spec now fails if a caption comes back.

**Two faults in the panel, both caused by moving it into the toolbar**, and both
things only a browser can see:

- **Every site type read "0 SITES IN VIEW".** The panel counts what each extra
  type would add over the rows on screen — and the `Toolbar` component is passed
  no `rows` prop. The panel moved and its data did not. It gets `viewRows` now,
  the same scoped set every other surface reads.
- **The checkbox rows rendered UPPERCASE, GREY AND STACKED.** `.toolbar label`
  sets `text-transform`, `color` and `flex-direction: column` for the date-field
  captions, and the sheet's rows are `<label>`s inside `.toolbar`. **This is the
  season-menu bug verbatim, reintroduced by me the moment the panel moved into
  the toolbar** — and inline styles would not have saved it, exactly as recorded
  there. The sheet is **portalled onto `<body>`** instead of fighting the
  cascade, which is also where a modal belongs (z-index, overflow).

**And it took the SAVE BUTTON with it.** Dan: *"can we get a 'save' button on
that settings page. don't love the 'auto save', cause it actually didn't."*
There was one, and it was blue — but `.toolbar button` (0,1,1) outranks
`.rs-save` (0,1,0), so inside the toolbar the sheet's Save rendered as the
toolbar's own faint translucent text on a light footer, which reads as inert
rather than as a button. Nothing about the panel ever auto-saved; it looked like
it had no Save at all. The portal fixes that with everything else.

Two things were still worth changing rather than answering *"it is already
there"*:

- **A greyed Save now says why.** It is enabled only when the panel differs from
  what the SERVER holds, and the footnote reads *"Nothing to save — tick or
  untick something first"* or *"Save applies this to everyone, and reloads the
  page."* A disabled button with no explanation is what invites "it didn't
  save".
- **A refused field no longer looks like a save.** The route returns `dropped`
  precisely so a silently discarded setting is impossible, and the panel ignored
  it and reloaded anyway. It surfaces it now.

Generalise it: *moving a component moves what the cascade can do to it, and what
props reach it.* All three of these were introduced by a move that looked like
pure relocation.

Guards: two render cases that OPEN the panel — one requires the Courts row to
count a non-zero number of sites, one requires the sheet to be outside
`.toolbar` and its rows to be neither uppercase nor stacked. Mutation-tested
against the toolbar losing its rows and against the portal being removed; both
fail by name. Plus `facilities · the aquatics gear is last in the toolbar`, which
checks the gear's POSITION in the bar, and `facilities · the aquatics scope is stated above the
numbers` keeps the scope sentence ahead of the figures. Both key on placement
rather than presence, because "a gear rendered" passes just as happily on the
version nobody could find; mutation-tested against the gear leaving the toolbar
and against it not being last.

**And the case was itself wrong for one revision.** It asserted the gear sat in
the SCOPE BAR — true of the first fix, stale the moment the gear moved to the
toolbar — and it was CI that caught it, after I had told Dan a full render run
was clean. That run predated the move. *When you move a control, move the case
that pins where it is, and re-run after the last change rather than before it.*

### THE PROGRAM TABLE PRINTED A DASH FOR EVERY INSTRUCTOR

Dan: *"not seeing instructor names and info on the program pages. filter works,
but doesn't show the data we need."*

Two separate faults, and the second is the one worth writing down.

**The design choice hid it.** Instructor and location went on SECTION rows only,
on the argument that neither is a fact about a program — true, and not a reason
to make an admin expand 23 programs one at a time to find out who teaches them.
The All Programs table carries the **distinct set** now, through
`progDistinctFromSections`, the same helper the Excel export uses, so the file
and the screen cannot disagree. `progSetCell()` renders it: one name reads as
the name, several read as *"2 instructors"* with the full list on hover — a
program spanning four instructors must never print one of them as though it were
the answer.

**And then it rendered a dash on every row, because THE SECTION LIST HAS TWO
NAMES.** `rollupToPrograms` keeps a program's sections in **`_sections`**; the
Summary tab's own `progMap` builds **`sections`**. `progDistinctFromSections`
read only the first, so the new column was empty for exactly the surface it was
added to. It reads both now, rather than each caller being taught which shape it
happens to hold.

**No source assertion could have caught either half.** The column existed, the
helper was correct, and the cell was a dash — so the render cases key on the
CELL's own count (`data-prog-instrcell="2"`), and one of them scans for a real
NAME rather than for the column. Both were seen to fail on the shipped bug.

**A harness note that cost a false failure:** `stubMode` is a per-CASE field,
not a URL parameter. The render check answers the browser's own `/api/` requests,
so a flag on the page URL never reaches the stub — my pre-v6 case passed it in
the query string and reported the column present on a feed that does not have it.
It also duplicated an existing case NAME, which makes a filtered run ambiguous.

**And a full-run failure that was not real:** a `programs ·` run reported 39 of
228 failing while the same cases passed alone. Two render runs were overlapping.
Same self-inflicted contention already recorded for the manifest sweep — before
reading a mass failure as a regression, check nothing else is driving a browser.

Guards: `programs-instructor.spec.js` 70 → **79 assertions**, lifting and
RUNNING `progSetCell`; mutation-tested against the `_sections`-only read, which
is the bug exactly as it shipped. Plus three render cases.

## Programs: a multi-select SEASON filter (2026-08-31)

Dan, on Shrewsbury: *"lets add a program 'season' filter on the programs summary
page, otherwise it's super confusing to try and contain all dates of a
section. Using a season filter will summarize that data much more quickly."*
Then: *"make the season filter a checkbox, multiselectable. I hate single item
selections in pull down menus."*

**No card change.** Card 17295 has always emitted `program_season`
(`COALESCE(si.season_name,'No Season')`) and `public/programs.html` already
mapped it onto every row and printed it in the section table. The whole feature
is a toolbar control plus one insertion in the funnel.

### A SEASON'S DECLARED SPAN DOES NOT CONTAIN ITS OWN SECTIONS

The obvious build is "tick a season, jump the date range to its span" — the
`season` table carries `start_date` and `end_date`, so it looks free. It is
wrong, and measured at Shrewsbury it is wrong by months in both directions:

| season | `season.start_date` → `end_date` | its sections' ACTUAL dates |
|---|---|---|
| Spring/Summer 26 | 2026-04-12 → 2026-09-05 | **2026-03-04 → 2026-11-15** |
| Fall '26 | 2026-10-03 → 2026-11-13 | **2026-08-31 → 2027-02-06** |
| Winter 26 | 2025-12-31 → 2026-04-10 | **2025-10-05 → 2026-06-10** |
| Winter 2025 | 2025-09-07 → 2025-10-12 | 2025-09-08 → **2026-03-26** |
| Pickleball | 2026-01-30 → 2027-01-30 | 2026-02-22 → 2026-03-30 |

Those dates are the season's **registration/publish window**, not the period the
programming runs. Fall '26 declares six weeks and runs five months. So setting
the date range from them would **clip exactly the sections the filter exists to
contain** — the precise opposite of the ask. It is also not reliably there:
platform-wide, of 559 seasons **141 have no start and 190 no end**; only 369
(66%) have both.

So the filter **narrows what is already in view and never touches the dates**,
and the options are built from the ROWS — which means a season with nothing in
the current window cannot be ticked at all, so the control can never produce an
empty result. `programs-season.spec.js` fails if `setStartDate` ever appears
near `season`.

**Still worth building later, and it needs a card change:** a truthful "fit the
dates to these seasons" wants the section-date ENVELOPE per season (min
first_start / max last_end across all that season's sections, unwindowed), not
`season.start_date`. That is two more columns on 17295 and another tag flip.

### ONE FUNNEL, BOTH DIMENSIONS — `locRows` is gone

The location filter shipped hours earlier with `locRows` as its single funnel.
Adding season could have been a second funnel beside it; instead `locRows` was
**renamed `scopedRows`** and applies both. Two funnels is exactly how the
facility Summary shipped chips that scoped some panels and not others and the
page disagreed with itself for a week. `programs-location.spec.js` now asserts
`locRows` is **absent**, so a panel left reading the old name fails rather than
being silently season-unscoped.

**`scopedProgramSet` had the same trap and I nearly shipped it.** It gated on
`if (!locFilter …)`, so with only a season ticked it returned null and the
demographics and retention tabs — which read their own feeds and have no season
column — would have stayed unscoped while every panel beside them moved. It
gates on **either** dimension now, with `seasonSel` in its deps.

### The decisions worth keeping

- **An empty tick list means ALL seasons, not none.** So there is only a
  **Clear** button, no "Select all" — two buttons producing one state is a
  control that looks broken.
- **`progEffectiveSeasons` KEEPS the known ticks and drops only the unknown
  ones**, which is where it deliberately differs from `progEffectiveLoc`.
  Ticking three seasons and having one retire must not silently widen the report
  back to everything; two known seasons is still a deliberate, answerable
  request. Only when NOTHING survives does it fall back — because an empty tick
  list and "all" render identically, and the empty one is the confusing way to
  say it.
- **It takes a `loaded` argument.** Third instance of that bug in this repo: a
  feed that has not answered is not a feed without that season, and resolving on
  mount is how `?ci_rows=failed` shipped broken.
- **`?season=` is REPEATED, not comma-joined**, and read with `getAll`. Season
  names are typed by humans — *"Spring/Summer 26"*, *"Fall '26"* — and nothing
  stops one containing a comma; a `split(',')` would quietly cut it in half. The
  write-back **deletes then appends**, because `append` alone stacks a second
  copy of every value on each render.
- **`seasonKey(r)` is the ONE definition of a row's season**, read by the options
  builder, the funnel and the checkbox list. It folds `''`/null into the card's
  own literal `'No Season'`, because a pre-v6 feed and the `Season` alias both
  produce empty and that is the same fact. Three surfaces deriving it separately
  is how a checkbox lights up and filters nothing.
- **The gate is a VALUE test here, correctly.** Unlike `location`, the column is
  always present — the card COALESCEs it and the page's mapper defaults it — so
  "does this org run seasons" is the only meaningful question. An org with none
  yields exactly one option, and the control hides under two.
- Busiest season first, so the one an admin is working in leads and `No Season`
  sinks to wherever its size puts it.
- **A section can carry MORE THAN ONE season** — 255 of 35,929 platform-wide,
  max 4 — and card 17295 takes `ORDER BY season.name LIMIT 1`, so those report
  under one season only, alphabetically first. Same shape and scale as
  `location_count` (287 of 42,457). Not fixed here; a `season_count` column
  would let the page mark it, as `location_count` does.

### Guards

`scripts/programs-season.spec.js` (**43 assertions, in CI**), which LIFTS AND
RUNS `seasonKey`, `progEffectiveSeasons` and the real `scopedRows` reducer rather
than regexing them. Mutation-tested eleven ways, all failing by name: the season
filter dropped from the funnel, union turned into an intersection,
`scopedProgramSet` gated on `locFilter` alone, an unknown season widening back to
all, the load gate removed, `getAll` reverted to a comma split, the checkboxes
reverted to a single-select, the write-back appending without deleting,
`seasonKey` no longer folding empty into `No Season`, the funnel split back in
two, and a mutation that moves the date range.

**A spec-harness lesson from that last one:** this spec records failures and
reports at the end, so an exception thrown by the *sliced* code killed the
process before a single recorded failure printed — the mutation surfaced as a
bare `ReferenceError` stack naming nothing. The slice now runs behind a try/catch
that records *"the scopedRows funnel THREW"*. A guard that dies instead of
failing has not told anyone what broke.

**The menu was styled wrong twice over, and only half of it was colour** (Dan:
*"make the menu look like the other menu styles. not the white background
menu."*). It shipped as a white popover in a `#2c2c2c` toolbar — but the rows
also rendered **UPPERCASE, grey and STACKED**, because `.toolbar label` sets
`text-transform: uppercase`, `color: #aaa` and `flex-direction: column` for the
date-field captions and these options are `<label>`s inside `.toolbar`. Inline
styles did not save it: none of those three properties were being set inline, so
the toolbar rule simply won. It is real scoped CSS now, and the row rules are
**resets, not decoration**. Generalise it: an inline style only beats the
cascade for the properties it actually names.

Two render cases cover it, and they are the only thing that could — no source
assertion can tell a white popover from a dark one. `act` stamps the menu's
COMPUTED styles onto `<body>` so a `needs` selector can assert them
(`[data-sm-bg="rgb(44, 44, 44)"]`, `[data-sm-transform="none"][data-sm-dir="row"]`).
Both were seen to fail on the real bug: reverting the background fails only the
colour case, and removing the resets fails only the inheritance case.

Plus **eight `ci-check-render.js` cases**, six of them keyed on the PROGRAM COUNT
(`data-prog-count`) rather than on a control existing — "a checkbox rendered"
passes on a filter that filters nothing. The fixture is 4 sections over 3
programs across `Fall '26` / `Spring/Summer 26` / `No Season`, so unfiltered
reads 3, one tick reads 1 and a union reads 2, and an intersection reads 0 —
one number separates all three. Verified to discriminate: dropping the filter
fails the four data cases while *options are CHECKBOXES* and *menu is CLOSED*
keep passing; union→intersection fails only the union case; dropping `season`
from `getParams` fails only the deep-link case. The deep-link case carries the
apostrophe (`?season=Fall%20%2726`) on purpose, since that is what a real season
name has to survive.

## All Users and Households — the first non-aquatics data report (2026-09-09)

Dan: *"lets build the all users/household report next"*, with a base query, then
*"ideally it would include all households sequenced under the same owner. so 1
row for HH owner, then all the profiles below it, next HH, etc."*

The sequencing IS the report page's group hierarchy, so the card emits one row
per PERSON ordered owner-first within each household and `groupBy` is
`["Household"]`. **`People` is 1 per row**, which makes the household subtotal
the household's SIZE and the grand total the head count — otherwise the roll-up
machinery has nothing to say on a report with no money in it.

Card **21715**, public uuid `3825556f-ca08-42b4-b277-d8fa768ebcf5`.
https://rec.metabaseapp.com/question/21715

### FOUR CORRECTNESS CHANGES TO THE BASE QUERY, each measured

1. **Residency comes from `group_type = 'residency'`, not the hardcoded group
   id.** That id IS Watertown's own residency-typed *Watertown Residents*, so
   this returns the identical answer there and a correct one everywhere else.
   It is also **not a name ILIKE** — *"Non-Resident"* CONTAINS *"Resident"*,
   the mistake already recorded here that reported 4,099 live memberships
   across 35 orgs as residents.
2. **It AGGREGATES rather than joining.** One org has TWO residency-typed
   groups, so a plain `LEFT JOIN` duplicates that org's people. Proven absent:
   **5,704 rows against 5,704 distinct people.**
3. **Every org user is returned, not only heads.** The base `INNER JOIN
   household ON owner_id` is 3,444 of Watertown's 5,704 — the other **2,260 are
   the children and partners a camp roster is actually about.** `Household
   Role` is a column, so filtering to *Head of Household* reproduces the base
   query's row set **exactly (3,444 = 3,444)**.
4. **The window tests the household OWNER**, so a household is wholly in or
   wholly out. Filtering each person by their own `created_at` cuts households
   in half, and half a household under a household heading is worse than
   either. Each person's own `Created At` is still a column.

`organization_association` has **no `deleted_at`** (id, created_at, updated_at,
user_id, organization_id, source) — checked, not assumed.

### VERIFIED BY RUNNING THE WHOLE FINAL SELECT

Literals substituted, not a summary probe wrapped around the CTEs — the
specific mistake that let card 21682 ship with *"ORDER BY position 9 is not in
select list"*. Watertown: **5,704 rows / 3,444 households / 3,444 heads / 2,260
members / 4,141 residency Yes**, owner-then-members sequencing confirmed on a
27-row window. Then through the public endpoint with the app's own parameter
shape: **El Segundo 6,519 rows in 9.8s**, and end-to-end through the app: 352
people across 285 households for a three-day window.

**A signal that was not planted:** every Watertown/02472 address reads
`Residency? = Yes` and every out-of-town one reads `No` — Belmont, Boston,
Waltham, Brookline, Natick, Cambridge and Woburn all correctly No.

### NO PUBLIC LINK, NO REPORT

`customReportEnabled` now requires `spec.uuid`, **checked BEFORE the org** so a
missing link is never reported as an org problem. Without it the entry would
build `/api/public/card//query/json` and surface Metabase's own error, which
reads as a BROKEN report rather than an unfinished one. Same shape as
`SHARED_UUIDS` omitting an unset key. Mutation-tested.

**No `locations` key.** The filter is per report and this one has no locations
to offer; an empty dropdown is a control that looks broken.

### Two process slips worth keeping

- **`create_question`'s `collection_id` was malformed in my call**, so the card
  landed in a personal collection and the stray parameter text leaked into the
  description. `update_question` has **patch semantics** and takes `query:
  null`, so both were fixed **without** passing a query — which is what
  regenerates the template tags. Worth knowing: moving or renaming a card is
  safe; only a `query` save costs the flip.
- **A comment I wrote quoted the slug an assertion forbids** (*"no slug
  anywhere in the registry"*), so correct code failed. **Fifth instance in this
  file.** Fixed by rewording the comment rather than teaching the assertion to
  ignore comments — keeping that assertion dumb and literal is more robust, and
  a regex comment-stripper is unsound on server.js anyway.

### What it answers, from Dan's inbox

Alyssa at Essex Junction: *"download a csv of all current households"* — and
the individual-grain sheet was *"too overwhelming"*, which is exactly why the
household is the grouping and the role is a filter rather than two reports.

## WHAT ELSE BELONGS ON THE DATA REPORTS CARD — surveyed, not guessed (2026-09-10)

Dan: *"see what other types of 'data reports' we could add to that new card.
Don't want to go too much into the Seb realm, but some people want a nicely
formatted report. Examine a few large org dashboards, there's lots of boring
data reports in there that might work across orgs. Anything that's a 'one off'
we're ignoring."*

**THE SURVEY IS THE FINDING, and the method is the reusable part.** Five org
collections read card by card — Apex (116 cards), Clarksville (69), Norman (68),
Watertown/Torrance (64), Brookline (52) — and the signal is not what any one org
asked for, it is **which cards our own staff COPIED from one org to another.**
Several carry a byte-identical description across three collections
(*"Base query for account credit balances in Apex"*, *"Audit for main section
fields for a city"*, *"Accounted for issues with payment plans"*), and Brookline's
whole collection is a clone of Apex's with the names left alone. A card somebody
re-pasted into a fourth city is a report the platform should own.

Recurrence alone is not enough, so every candidate was then measured against
LIVE DATA for how many orgs it would return rows for. Nothing below is a guess.

### TIER 1 — the three worth building

| | copied into | live coverage |
|---|---|---|
| **Facility rentals, balances due** | 4 of 5 (Clarksville 6088, Brookline 14590, Norman 4854, Watertown 2979/2980) | **28,711 rentals owing across 106 orgs**, $43.6M all-time, 9.2% of the 312,647 rentals ever billed |
| **Sections with no GL code** | 4 of 5, same description each time | **17,351 PAID sections across 81 orgs — 48.2% of every paid section on the platform** |
| **Account credit balances** | 3 of 5 (Clarksville ×3, Brookline, Apex ×2) | **7,610 accounts across 83 orgs holding $3,957,321** the org owes its customers |

- **Balances due may need no new card.** Card 19570 already computes
  Billed / Collected / Refunded per RESERVATION and the reporting project
  already serves it; this is that card re-grained to the rental with a
  `billed > collected` filter. Check that before writing SQL.
- **The GL audit must split FREE sections out.** 2,808 live sections have no GL
  code and charge nothing, which is correct configuration — folding them in
  reports setup debt that is not there. The number that matters is the paid one.
- **Account credit is the one with no existing home at all.** It is also two
  reports in one: the BALANCE (what is owed) and the LEDGER
  (`credit.creator_user_id` + `admin_note` — who granted it and why), which is
  what Apex's *"Adds and Subtracts by Admin"* actually is.

### TIER 2 — real, but settle a definition first

- **Refunds to be processed** — 4 of 5 (Clarksville ×4, Norman 2216, Watertown
  ×3, Apex 20555), all sharing *"Accounted for issues with payment plans"*.
  **There is no `refund_request` table**, so what these queries key on has to be
  read out of one of them before this can be specified.
- **Pending rental applications** — 3 of 5. **1,791 across 56 orgs.** Small, and
  it pairs naturally with balances due on one facilities-flavoured report.
- **Transaction ledger with the tender split** — 3 of 5, and in Clarksville and
  Brookline it is literally the same five saved questions over
  `materialized.transaction_report` (Total $$ By Payment Method / Total Refunds
  / Total $$ Transactions / Transaction $$ By Week / Transactions). The GL report
  covers the rollup; this is the same money at TRANSACTION grain with cash /
  check / card / credit columns — the exact shape a CivicRec org expects, and
  the shape cards 21684 and 21685 already emit for El Segundo.

### DELIBERATELY NOT RECOMMENDED, and why

- **"Happening Today"** is the single most-copied card in the survey — **5 of 5
  collections** — and it does NOT belong here. It is live data, and the rule
  already recorded in this file is that a dashboard is the place for a live
  trend while a report answers a question about a window somebody chose. It
  belongs in rec-dashboard.
- **Top Sections by Enrollments / Top Activities / Revenue by Program** (4 of 5,
  Clarksville alone holds FOUR copies of one of them) — already the Programs
  report.
- **Active / Expired / Inactive Auto-Renewing Memberships** (3 of 5) — already
  the Memberships report.
- **"User Report — edit this with the zip codes you need"** (Clarksville 15248,
  Brookline 18225, identical description) — **already shipped.** All Users and
  Households answers it, and the Zip Code filter restored on 2026-09-10 is
  precisely the hand-edit that description is describing. Worth telling those
  two orgs rather than building anything.
- **Daily Employee Cash Out Summary** — Clarksville holds **four** copies plus
  *"Transactions Processed by Employees"*, and no other sampled org has it. A
  one-off by Dan's rule, so it is out — but the SHAPE is generic
  (`desk_location` + cashier + tender), so it graduates the day a second org
  asks. Recorded so nobody re-derives that.
- Promo Code Report, SMS Count, Ice/Hockey Export, In Design Report, Mom Prom,
  Daddy/Daughter Dance Tickets — one-offs.

### TWO OF MY OWN MEASUREMENTS WERE WRONG FIRST, and both are the same trap

- **`section.pricing_policy` has no `prices` array.** Reading
  `pricing_policy->'prices'` returned NULL on **all 40,981** live sections, so
  the first probe reported *"0 paid sections lack a GL code"* — a confident zero
  produced by looking in a key that does not exist. The real shape is
  `{"default": {"type": "fixed", "cents": 11000}}`. Checking the surprising zero
  against the raw jsonb is what caught it; the true answer is 17,351.
- **`facility_rental.status` has exactly TWO values** — `confirmed` (244,303)
  and `in-progress` (36,986). My first pending-applications probe filtered on
  `pending`/`requested`/`submitted` and returned **0 rows across 0 orgs**, which
  reads as "nobody uses this feature" and is a statement about my WHERE clause.
  A pending application is one whose rental is still `in-progress`.

*Generalise it, again: a measurement rules out the place you looked, not the
fact. Both zeros here were mine.*

### THE GATE FOR ANY OF THESE IS CROSS-ORG PORTABILITY

`CUSTOM_REPORTS` is registry-driven and `public/custom-report.html` renders any
of them with no page change — `all-users` proved that. What disqualifies a card
is the CARD: 21682 hardcodes El Segundo's three location names and 21684/21685
partition on El Segundo's GL codes, which is why those four are org-gated. Every
Tier 1 candidate above is `org_id` + a date window and nothing else, so each is
one card plus one registry entry.

## All four aquatics reports, and the column picker (2026-09-09)

Dan, on report 1's PDF: *"here's the output, it's super long lol"* — 15 pages for
one month. Then, on the fix: *"How about leaving rental name as a checkbox
option, and adding a filter on the report. I can see that being useful for
future reports."* And: *"go back and build out the other reports, these are
great aquatics reports."*

### THE FORMATTING WAS FINE. THE CARD'S GRAIN IS SIX DIMENSIONS AND JOSEPH ASKED FOR THREE

Measured on September 2026 rather than eyeballed:

| grain | rows | pages |
|---|---|---|
| as shipped | **825** | ~15 |
| drop Rental Name + Booking Type | 258 | ~5 |
| Joseph's brief — month x pool x program type | **12** | **1** |

**`Rental Name` is the whole explosion: 493 of the 825 rows are auto-generated
`Court Reservation: <lane>` strings** carrying no programme at all — a third of
the hours and 60% of the paper. Every heading, both subtotal levels, the grand
total and the CSV footnote were correct throughout.

### HIDING A COLUMN RE-SUMS. It does not blank a cell

`collapseRows()` is the point of the whole feature. A picker that only hid the
column would leave 825 rows that look identical, repeat each other down the page
and still add to the same total — **which reads as a broken report rather than a
shorter one.** Collapsing to the kept dimensions gives 258.

- **The key is `JSON.stringify` of the value array, not a joined string.** Two
  dimension values otherwise straddle the separator — `"a b" + "c"` and
  `"a" + "b c"` — and silently merge two rows that are not the same row.
- **First appearance wins**, so the card's own `ORDER BY` still drives the
  hierarchy and nothing is re-sorted — the property `groupRows` depends on.
- **The collapse must not move the grand total.** A collapse that loses or
  duplicates a row is the one failure a reader cannot see, because the page
  still looks right; the spec asserts the total is unchanged.

### THE EARLY RETURN IS COMPUTED FROM STATE, because hiding is a DEFAULT

`shownRows` skips the collapse only when `shownDims.length === dimCols.length`.
Gating it on *"has the reader filtered yet"* would silently not apply
`hiddenColumns` at all — **the exact bug already recorded for `scopedRows` when
cancelled sections became a default rather than an opt-in.**

### THE FILTERS ARE KEYED BY COLUMN NAME, and this shipped wrong for one revision

`filterRows` looks up `r[key]`, so a map keyed by the URL parameter name
(`f_Program_Type`) matches **nothing** and the filter appears to do nothing at
all. The slug now exists only at the URL boundary.

**NO UNIT ASSERTION COULD SEE IT.** The spec's fixture passed *column* names —
which the app never did — so `filterRows` was proven correct on data nothing
produced. Same lesson as the Programs location filter that shipped unable to
render: *a unit test that supplies the field under test cannot tell you whether
anything supplies it in production.* **The render check is what caught it.**

Other decisions, all following rules already recorded here:

- **Empty means ALL, never none** — hence a Clear and no Select all.
- **Options are built from the rows**, so a filter can never offer a value the
  report cannot produce. The shared aquatics dashboard does exactly that with
  its location list and it reads as broken.
- **A blank value is its own option, labelled** — a row the card could not
  attribute is still a row, and hiding it makes the grand total disagree with
  the CSV.
- **Repeated `?f_<col>=`, read with `getAll`, deleted before appending.** A
  rental name legitimately contains a comma (`Court Reservation: Lane 2 - B,
  Court Reservation: Lane 3 - A`), so a comma split would cut it in half; and
  `append` alone stacks a second copy of every value on each render.
- **Columns persist per browser and are NOT in the URL; filters are the
  reverse.** Which columns you like looking at is a display preference; a filter
  is part of the question the report answers.
- **The deep link's filters resolve only once the feed says what the columns
  are** — the parameter is a slug of the column and the mapping back is lossy.
- **The exports follow the VIEW**, filters and hidden columns both. An export
  quietly carrying rows the reader excluded is the Programs Excel bug verbatim.
  Still no subtotal lines.
- **Filtered-to-nothing is its own empty state**, or the reader widens the dates
  when the fix is to clear a filter.
- **A narrowed view SAYS so, in the page and not the toolbar** — whoever prints
  this has no toolbar to look at, so the note must survive into the PDF.

### The other three reports are registry entries

| # | report | card | groupBy |
|---|---|---|---|
| 2 | Aquatics Classes by Month | 21683 | Month / Location / Program |
| 3 | Aquatics Drop-In Admissions | 21684 | Month / Location / Category |
| 4 | Aquatic Passes and Memberships | 21685 | Month / Location / Category |

All four cards register exactly **four** correctly-typed parameters — `org_id`
(carrying El Segundo's default), `start_date`/`end_date` as `date/single`, and
`location`. No six-parameter duplication, because they were created rather than
re-saved.

**`Participants (section total)` IS NOT ADDITIVE and is deliberately not in
report 2's `numeric` map.** It is a per-section total repeated on every month
that section runs, so summing it down a column double-counts any section
spanning two months — the same trap as the wizard summing `Number of Payments`,
right by luck at one org and latently wrong everywhere else. Left out of
`numeric` it renders per row and never rolls up, which is honest. Making it
additive needs a card change, not a registry edit.

**Each report offers only the locations its OWN card can answer for**, measured:
Hilltop runs no aquatic sections and sells no passes, so it is absent from
reports 2 and 4 while present on 3; the city-wide Rec ID bucket exists only on
report 4, which is the card that sells them.

`hiddenColumns` per report: report 1 `Rental Name` (the 15 pages), report 2
`Section ID` (a uuid is noise on a printed report, but it is what separates two
sections sharing a name — 49 names against 52 ids — so it is hidden rather than
dropped), report 4 `Buyer Zip` (the column beside it already summarises it).

### Guards

`custom-reports.spec.js` 32 → **44 assertions**, lifting and RUNNING
`collapseRows`, `filterRows`, `valueCountsFor` and `levelsSafe`.
Mutation-tested thirteen ways, all failing by name: the collapse dropped, its
key joined with a string, an empty filter meaning none, blanks dropped from the
options, the URL appending without deleting, the exports reading the unfiltered
feed, the table handed the whole column set, the filtered empty state collapsed
into the plain one, the scope note dropped, the print stylesheet hiding it,
report 2 summing the per-section total, and Hilltop offered on a card that
answers nothing for it.

**One mutation SURVIVED the first draft** — the table still rendering
`bodyCols` over `rows`, which is the bug the whole picker exists to prevent.
Every other assertion passed with it in place. Found by mutation, not review.

Plus **4 `ci-check-render.js` cases**, and the fixture gained a row that
**differs from another only in `Rental Name`** — without a pair like that,
hiding a column changes nothing and no case can tell a picker that re-sums from
one that only blanks a cell.

**Two harness lessons, both of which cost a false failure:**

- **`waitForSelector` does not reliably see an attribute VALUE change** on an
  element that was already there. It timed out for 8s on a page that had
  already rendered the right answer. `waitForFunction` polls a predicate, which
  is what this needs. A fixed sleep was flaky — it stamped a stale count on one
  run in two, and *a flaky assertion is not a guard.*
- **`localStorage` survives between render cases.** The case that ticks Rental
  Name ON left it on for the next case, which then saw 6 rows instead of 5 —
  a green baseline turning red only when run as part of the group. Both
  order-sensitive cases clear it in `pre`. Already recorded here for the
  saved-views cases; second instance.

### And I wrote an unrendered escape into JSX text, again

`\u25be` sitting in JSX **text** rather than a string literal renders as the
literal characters. Third instance in this file. Caught before the guard ran,
but the guard exists because it has shipped twice.

### WHERE THEY SHOULD LIVE — decided, not built

Dan: *"where do we think these three reports should live? On the main org
dashboard page? Under the aquatics facility section? In a new 'basic reports'
section?"*

**A "Data Reports" section on the main org dashboard.** They are already pushed
into that page's `available` list, so the change is a header driven off
`CUSTOM_REPORTS` rather than a move. **Not under the Aquatics facility tab** —
that tab is a dashboard over cards 19570/17294 and these are reports over four
different cards with their own window and exports; burying a standalone report
inside a tab of another report is how the aquatics settings gear and the
Private Instructor Lessons panel both became unfindable. **"Data" rather than
"Basic"**, because these are the authoritative row-level exports and the charts
are the derived view.

## Joseph's reports, rebuilt in the reporting project (2026-09-09)

Dan: *"Ok so the reports are in MB and give a raw csv of the data he wants. now
what's missing are the roll ups or total rows at the bottom, correct? … Create a
new card pulling data from the mb cards, add filters that match up with the mb
report, then format it on the frontend to look like his Civic Rec reports?"* Then:
*"lets start with report 1, once we nail that we can move on. Build these ONLY for
El Segundo in their org dashboard, with aptly named report names, same headers and
filters from the mb card/report."*

**Report 1 is BUILT.** `/el-segundo-recreation/aquatic-lane-hours`, reading card
**21682** through its public link
`b1f4ca67-1a91-4e91-8581-5b3dbaf0d9a2`.

### NO, ROLL-UPS WERE NOT THE ONLY GAP — and that is why this is a page

Read off the four CivicRec PDFs rather than assumed. Beyond the raw rows every
one of them carries:

| | |
|---|---|
| a provenance header | Run On, Run By, From/To, **and the filter values echoed back** |
| group headings as HEADINGS | `Category: Rec ID` → `Activity: Wiseburn Rec ID` → rows |
| **two** levels of subtotal | an unlabelled row under each group, then `Totals for Category: X` |
| row numbers that restart per group | 1., 2., 3. |
| accounting negatives | `($26.00)`, `($0.11)` |
| links | receipt # and user name (report D) |

**A native Metabase card can produce none of it.** A dashboard filter binds to a
template TAG, never to a result column, and the visualisation is one flat table.
`GROUPING SETS` can fake subtotal ROWS and they come out as ordinary rows with
blank cells — indistinguishable from data, and they poison the CSV. So the
formatting half was never a Metabase job.

**AND THE WRAPPER CARD IN DAN'S PLAN IS NOT NEEDED.** Metabase can reference a
card from a native query (`{{#21684}}`), but it adds a fifth thing to keep in
sync and breaks the parameter pass-through. The four cards are already the right
feed shape: `org_id` + optional `start_date`/`end_date`, which is exactly what
`buildMetabaseParams` sends. Becoming a feed is a registry entry, not a rewrite.

**One real DATA gap, separate from formatting:** report D (Aquatic Passes) is one
row per transaction — receipt #, date, time, user, zip — and card 21685 is
aggregated. That needs a transaction-grain variant. A, B, C and E already match
our grain.

### `CUSTOM_REPORTS` — a registry, so reports 2–4 are config

One entry in server.js carries the label, the emoji, the public uuid, the numeric
card id, the org allow-list, the group hierarchy, which columns roll up and the
location list. `public/custom-report.html` is ONE page that renders all of them.

- **THE GATE IS THE `orgId`, NEVER THE SLUG.** El Segundo is a dynamic org and
  the two projects already spell it differently; a slug is each project's own
  name for an organisation and they drift — the `town-of-shrewsbury` link 404'd
  for five weeks. The registry contains no slug at all, and the spec asserts it.
- **NOT a `REPORT_TYPES` entry.** A report type with a `SHARED_UUIDS` entry is
  offered to every org, health-checked, prewarmed and subscribable. This card's
  SQL hardcodes El Segundo's locations, so every other org would get an empty
  report. Same shape as `lessons` (SF only): a per-org gate plus its own routes.
- **THE COLUMNS AND THEIR HEADERS ARE READ FROM THE FEED**, in the card's own
  order. Dan asked for "same headers … from the mb card", and inheriting them is
  also the only way that stays true: a transcribed header is a copy that goes
  stale the day the card gains a column — the guessed-grain mistake, one field
  over. The registry names only the group levels and the numeric columns.
- **`REPORT_DIRECTORY` and org.html's card are DERIVED**, not transcribed. The
  server injects `customReportMeta` and `org.html` merges it, so a rename cannot
  leave a card opening a report it does not name.

### THE HIERARCHY IS THE CARD'S OWN `ORDER BY`, so nothing is re-sorted

`groupRows` walks the rows in the order they arrive (Month → Location, which is
card 21682's `ORDER BY 1, 2, …`) and never sorts. Re-sorting here would silently
disagree with the CSV beside it. A parent's totals are the sum of its LEAF rows,
so **a parent reconciles to its children by construction** rather than by a
second pass that could disagree with what is on screen.

**WHICH SUBTOTAL EACH LEVEL GETS IS CIVICREC'S RULE, and it is load-bearing:**
the **deepest** group takes the unlabelled row directly under its rows, every
outer level takes a labelled `Totals for <level>: <value>`. Give both to the
deepest group and it prints the same numbers twice, one directly under the other.

**ONE TABLE, not a table per group.** A "Totals for X" row is only readable
sitting under the columns it totals, and separate `<table>` elements do not share
column widths — the first build had the roll-up drifting out of line with the
numbers above it, which is the one thing that row exists to prevent.

**A row the card could not attribute is grouped as `(none)`, never dropped** —
hiding it makes the grand total disagree with the CSV.

### The exports, and the split that decides what goes in them

- **CSV and Excel are the ROWS ONLY — no subtotal lines.** A data file gets
  re-aggregated by whoever opens it, and a subtotal row indistinguishable from a
  data row double-counts the moment anyone sums a column. Both go through
  `flatTable` → `csvFromRows` → `saveTextViaPopup` with the **BOM**, and Excel
  through the same flat table, so the two files cannot disagree.
- **The group columns are IN the file.** A spreadsheet row cannot be expanded, so
  what the screen puts in a heading the file has to carry per row.
- **PRINT is the formatted one**, and it is the whole export argument: Dan's
  *"mb exporting->pdf looks terrible"*. A print stylesheet we own keeps group
  headings with their rows and never orphans a subtotal.

### The location filter is PER REPORT, which fixes something the dashboard has

The Metabase dashboard drives all four cards from one filter, and **two of its
four values return zero rows on two of the cards** — Hilltop sells drop-in only,
a Rec ID is city-wide. That is the data being honest and it still reads as a
broken filter. Here each report offers only what it can answer: card 1 lists its
three pools and no city-wide bucket. **An unknown value is DROPPED, not
forwarded** — a value outside the list returns nothing and reads as an empty
report rather than as a rejected filter.

A STATIC list, not a live one, for the reason already recorded: the card's CASE
ladder is hand-edited when a pool opens, so a self-updating dropdown would offer
a fourth value returning zero rows everywhere.

### Two defects found by driving the real routes, not by review

- **The beacon overwrote the report TYPE.** `logEvent` merges `extra` over the
  record it builds, so an extra called `report` (I passed the label) replaced
  `aquatic-lane-hours` with `Aquatic Lane Hours` in `events.jsonl` — out of
  `getReportActivity()`'s reach and disagreeing with every other row. Found by
  reading the log back after a real POST.
- **A refused beacon posted a DEAD LINK alert.** `noteDeadLink()` keys on *"a 404
  that arrived with a valid-looking token"*, which is byte-identical to every
  refusal here. All three gated 404s are marked `deliberate404` now. **And the
  spec's zero-deadlink assertion was VACUOUS at first**: its fixture tokens were
  `tok-yes`/`tok-no`, and `noteDeadLink` ignores a token under 8 characters as
  bot noise — so the mutation that unmarks the refusal SURVIVED. Third instance
  of that exact vacuity in this file.

### Verified against the card, not against itself

Recomputed from the feed independently and compared to what the page draws, El
Segundo, August 2026:

| | page | independent |
|---|---|---|
| Wiseburn AC | 5,170 res / 6,467.50 h | **5,170 / 6,467.50** |
| Urho Saari | 638 / 1,871.00 | **638 / 1,871.00** |
| Totals for Month: August 2026 | 5,808 / 8,338.50 | **5,808 / 8,338.50** |
| grand total | 5,808 / 8,338.50 | 862 rows |

8,338.5 is the figure this file already records for card 21682's August. The CSV
was read as BYTES out of the popup: 863 lines (header + 862 rows), the BOM
present, RFC4180 quoting on `Inst Lane 1- 4'6" Depth (25Y) - A`, and **no
`Totals for` or `Grand total` line anywhere in it**.

### Guards

`scripts/custom-reports.spec.js` (**32 assertions, in CI**), which LIFTS AND RUNS
`groupRows`, `flattenTree`, `flatTable`, `columnsOf`, `fmtNum` and `prettyDate`,
plus a live half that boots a server against a fixture org and drives the real
routes. `SKIP_SOURCE=1` drops the source half so the live half can be shown to
catch a regression alone.

The fixture is shaped so a wrong roll-up cannot look right: two months, two
locations inside each, and month totals (13, 21) and a grand (34) that appear
nowhere else — a subtotal read from the wrong level would have to hit one by
accident.

Mutation-tested, all failing by name: the deepest group given a labelled subtotal
too, an outer total reading its first child's subtotal, the CSV built from the
grouped display rows, the BOM dropped, a level the card no longer emits still
grouped on, the empty state removed, the shared dashboard's city-wide value added
to the list, the header reading the toolbar instead of the applied window, the
gate reconciling on the slug, the `report` key smuggled back into the beacon, and
each of the three deliberate-404 markings removed.

Plus **8 `ci-check-render.js` cases**, every one keyed on a COMPUTED FIGURE —
"a totals row appeared" passes on all of the above. `ci-check-render.js` gained a
per-case **`token`**, because these reports are gated on a different org than the
one it resolves, and it now writes an `orgs.json` fixture before the spawn
(`loadDynamicOrgs()` runs at server module scope, so a later write is never seen).

**One of my own absent-assertions was vacuous and mutation is what showed it**:
`[data-sub-level="1"] .sublabel.lbl` matches nothing on any build — `lbl` is on
the ROW — so the duplicate-subtotal mutation passed it. It is `tr[data-sub-level="1"].lbl` now.

`scripts/report-cards.manifest.json` gained an **aquatic-lane-hours / el-segundo**
row (2,239 rows in 23.7s, measured after the build). It matters more here than
usual: this card is not in `REPORT_TYPES`, so **the health check does not probe
it** and a re-Texted date tag would take the report down for El Segundo with
nothing else noticing.

### THE REGISTRY'S PLACEMENT IN server.js IS LOAD-BEARING

It sits above the shared-UUID map, not below it. `card-drift.spec.js` slices
server.js from that map's declaration to the `resolveReportCard` comment and
EVALS the result; sitting in that gap pulled the `REPORT_DIRECTORY` line into the
slice, where the directory is not defined, and the spec **DIED with a bare
ReferenceError instead of failing by name** — Nth instance of a slice reaching
past its own inputs. And writing the marker text into the explanatory comment
moved the slice's own start point, which is the same mistake one level up. Stay
out of the gap and do not quote its boundaries.

### NOT DONE, and worth knowing

- **`Run By` is absent.** CivicRec names the person who ran the report; this
  platform authenticates with an org token and has no user identity, so the
  header states Run On, the window, the location and the source card, and does
  not invent a name.
- **No `REPORT_DEPENDENCIES` entry**, so a dropped column on the base tables card
  21682 reads is not attributed to this report by the schema watchdog. Its tables
  (`reservation`, `reservation_court`, `court`, `location`, `facility_rental`)
  are all declared under other reports, so the break would still be seen — just
  not named here.
- **NOT PREWARMED.** `prewarmCache` walks `REPORT_TYPES`, which this is not in,
  so the first open of the day is a cold query — measured **23.7s unwindowed,
  34.8s for August** through the sandbox. That is why the progress bar matters
  here: after three loads it has a measured estimate for this org and report.
  Warming it is a few lines in prewarm if Joseph ever finds the wait annoying.
- **Reports 2, 3 and 4 are config**, once Dan creates each card's public link:
  a registry entry naming the uuid, the hierarchy and the numeric columns. Card
  21685 also wants the transaction-grain variant above before it matches report D.

## The FIVE CivicRec exports Joseph actually runs (2026-09-09)

Dan forwarded four CivicRec PDFs plus a reservations CSV, all **July 2026** —
their last full month on the old system. These are more specific than the email
and they settle two things the email left open. Same artifact:
https://claude.ai/code/artifact/0a35b7c8-9fbf-4cf3-98b8-10f0cf624070

**THE CUTOVER IS CLEAN, so these are a BASELINE and not a comparison.** Rec holds
**10 aquatic lane reservations in July and 5,882 in August**. July lives in
CivicRec, August lives in Rec. Never diff one against the other.

**Read them with `pdftoppm`** — every one is a page image, `pypdf` extracts an
empty string. `poppler-utils` is not in the sandbox image; `apt-get update` first
or the install 404s on a stale package index.

| | report | July figures | verdict |
|---|---|---|---|
| A | Facility Reservations by Date (CSV) | 7,782 lane rows · 7,861.0 h · $16,634 | **have it** |
| B | Aquatics Drop In Numbers | 4,956 admissions · $17,786.50 | **have it** |
| C | Rec ID Summary per month | 171 IDs · $2,040 | close |
| D | Aquatic Passes by Date | $12,024 over four tender columns | close |
| E | Instructor Transaction Summary by Session | 567 participants · $7,924 · 24.59 h | close at SECTION grain — see the correction |

### THE $0 ROWS ARE THE POINT — this corrects what I wrote on 2026-09-09

I flagged that **8,261 of August's 20,201 transactions carry
`transaction_method = 'free'`** and warned that counting rows overstates passes
sold by ~40%. **That is right for the REVENUE column and wrong as a general
rule.** CivicRec lists membership-holder swipes as their own line with a real
Quantity and a $0.00 Total:

```
AC Lap Swim-Adult                       216   $1,720.00
AC Lap Swim-Adult (Membership Holder)   179       $0.00
```

Those 179 are attendance Joseph reports on. **The drop-in report needs BOTH
columns** — visits including the free ones, revenue excluding them — not one
number with the judgement baked in.

### RESIDENCY HAS A SECOND AND BETTER ANSWER: THE BUYER'S ZIP

The Passes report carries a **Zip** column, and the negative lines on it
(a $70.00 charge with a −$26.00 beside it on the SAME receipt) are the resident
discount, appearing only on 90245 buyers.

- **`users.zip_code` is populated for 2,719 of El Segundo's 2,990 buyers (91%)**,
  and **1,346 are 90245**. So the Zip column is reproducible and residency is
  computable from the BUYER rather than inferred from a product name. Note
  `users` has **no `organization_id`** — scope it through the item log's
  `customer_id`.
- **`residency_zipcode_group` exists platform-wide — 820 zips across 46 orgs —
  and EL SEGUNDO HAS ZERO ROWS.** The platform already has a zip-based residency
  feature they have not switched on. Adding 90245 makes it a first-class flag.

### THE TENDER SPLIT IS A ONE-TO-ONE MAP, and no report of ours has it

Every CivicRec money report breaks out **Cash · Check · Credit/Debit · User
Credit**. Measured at El Segundo, August:

| CivicRec column | `transaction_method` | August |
|---|---|---|
| Cash | `cash` | $6,481 |
| Check | `check` | $6,075 |
| Credit/Debit | `card-online` + `card-present` | $131,188 |
| User Credit | `organization-credit` | **−$2,185** |
| (none) | `free` — the membership swipes above | $0 |

User Credit is negative in both systems (CivicRec's Rec ID report shows
`($5.00)`), so the mapping holds on sign as well as name. **It is columns on
`item_log_report`, not a new card.**

### Per report

**A — Facility Reservations by Date.** Their columns are Date · Location/Facility
· Rental Time · Description · User · Total Paid, **one row per lane**, which is
Joseph's own lane-hours definition falling straight out. We produce this today,
full lane names included (`siteLabel()` was fixed for these exact names). **69%
of their rows are $0.00**, the same membership-holder pattern. The only column
with no home is the free-text note in Description (*"All north lanes are taken by
a team on the 8th"*) — **13 of 7,782 rows**, the reservation instruction field.

**B — Aquatics Drop In Numbers.** Grouped by item name → Receipt Location →
Quantity + Total. Item name already carries pool, category, tier and residency.
**The open question is "Receipt Location" = the DESK**, and 72% of August rows
have no desk because they were bought online — but drop-in is counter-sold, so
coverage there is probably far better. **That measurement is unrun and it decides
whether this report is finished.** Worth knowing: their own export has duplicate
headings ("Plunge REC Swim - Senior" twice with different numbers), so the
two-catalogue-entries-for-one-product problem is not ours.

**C — Rec ID Summary per month.** The product family is already distinct
(`El Segundo Resident ID Card` Adult/Senior/Youth/Infant, `Wiseburn Rec ID`) and
quantity, tier and tender all derive. **The gap is the Category → Activity →
Session HIERARCHY**, which is CivicRec's and not ours — we have flat item names
and two grouping levels have to come from a name-prefix rule or a small org-
supplied map. That is the SAME map report 1's program types need, so ask once.
**Expect August to look like explosive growth and say it is not**: 171 Rec IDs in
July against 2,635 in August is everyone re-registering at cutover.

**D — Aquatic Passes by Date.** Transaction-grain with buyer, date, time and
amount — `item_log_report`'s natural shape — plus the tender columns and the Zip
above. **Receipt # will not match theirs**: we have a stable identity
(`transaction_event_id`) but our own numbering, so it is fine going forward and
no help reconciling history.

**E — Instructor Transaction Summary by Session.** Columns: Activity · Session ·
Participants · Instructor Applicable Total · Hours · Instructor % · Instructor
Hourly · Instructor Fees · After Instructor Dues. **Dan closed two of the three
gaps on 2026-09-09** — read the correction below, then this:

1. **Naomi Gol is NAMED in CivicRec and blank in Rec.** Dan: *"Ignore the fact
   they don't have instructors assigned to all programs, I'll remind them but it
   doesn't block our reporting."* So it stays a note to El Segundo, not a gap on
   our side. The column works; the field is empty.
2. **Per-SESSION grain — NOT BEING BUILT.** Dan: *"lets skip the per session rows
   for now, I think the program level is fine."* CivicRec emits thirty dated rows
   per section and the Instructor Payout report emits one; that is the difference,
   and it is accepted. **Do not start on card 17755's session grain** without
   checking in — the note below about it being the right card to grow describes
   HOW, not whether.
3. **The payout split and the payout DOCUMENT are already built — I said they
   were not, and that was wrong.** See the correction below.

**So ONE column is left on report E: Hours.** At section grain it is the sum of
that section's session durations (their 24.59 h over thirty rows becomes one
figure per section), and it only earns its place if El Segundo pays anyone
hourly — **Instructor Hourly, Instructor Fees and After Instructor Dues all read
$0.00 in Naomi's own July export**, so ask before building it.

### CORRECTION: REPORT E IS NOT "FURTHEST OFF" — the Instructor Payout report is it

Dan, with a screenshot of the report filtered to one instructor: *"here's a
filtered instructor report for a single instructor by section, doesn't this get
them to what they want at a slightly higher level?"* **He is right, and I had
written the opposite twice** — in the row above and in the artifact — on the
strength of reading `instructor.org_cut_bps_override` and finding no hourly-rate
column. I looked at the SCHEMA and never looked at the REPORT. `public/instructor-payout.html` (card 17755)
already covers six of CivicRec's nine columns and then goes further than they do:

| CivicRec column | ours |
|---|---|
| Activity | Program |
| Session | **Section** — theirs is one row per class DATE, ours per section |
| Participants | Enrolled |
| Instructor Applicable Total | Net Revenue (paid − refunded) |
| Instructor % | the split control — 90/10 … 50/50 plus a free-entry pair |
| Instructor Fees / After Instructor Dues | Instr (N%) and Org (100−N%) |
| Hours | **absent** |
| Instructor Hourly | absent |
| (none) | **a printable pay slip per section and per period** |

Grace Maxwell, El Segundo, September: 5 sections, 19 enrolments, $2,827.80 net,
$1,979.46 to the instructor at 70/30, and a check-style voucher naming the pay
period. CivicRec produces no such document.

**Dan then closed it to ONE optional column.** *"lets skip the per session rows
for now, I think the program level is fine."* So per-session grain is not being
built, and what is left of report E is **Hours** — at section grain, the sum of
that section's session durations. **Instructor Hourly / Instructor Fees / After
Instructor Dues all read $0.00 in Naomi's own July export**, so that half of
their template may simply be unused at El Segundo, and Hours only matters if
somebody is paid by the hour. Ask before building either.

**One honest nuance about the split:** ours is a TOOLBAR CHOICE applied to every
row in view, not a rate stored per instructor — so a single-instructor filtered
view (exactly what Dan showed) is right, and one pull across a roster on mixed
splits would not be. `org_cut_bps_override` exists on `instructor` and nothing
reads it; wiring it in is what would make a whole-roster pull correct.

**The empty instructor column at El Segundo is THEIRS, not a gap here** (Dan,
2026-09-09: *"Ignore the fact they don't have instructors assigned to all
programs, I'll remind them but it doesn't block our reporting."*). Grace Maxwell
teaches dance (Hip Hop for Kids, Tutus & Taps, Thriller Workshop) and has a
facilitator on file; every aquatics section does not, so this report and report
2's instructor column are both empty for the programmes Joseph is reporting on
until somebody assigns them. That is a reminder to El Segundo — **it is no longer
carried on our list as a blocker.**

**Generalise it: do not measure a capability from the schema when a report that
answers it already ships.** I searched `instructor` for a rate column, found
none, and wrote "cannot be computed at all" about a number the platform prints on
a voucher.

### THEIR REPORT → OUR REPORT, built side by side (2026-09-09)

Dan: *"give me a direct comparison of what el seg wants and how we can provide
it. fine if it's a report from rec itself, like the transactions/items log …
Screenshots for both would be great, something like their report->our report."*
Built into the same artifact. Two things made it possible and are worth keeping.

**A LOCAL INSTANCE SERVING A DYNAMIC ORG'S REAL DATA.** El Segundo is not in
`server.js` and its token could not be read from here, so the reporting project
could not be screenshotted against it. It can be run locally instead: a scratch
`DATA_DIR` holding an `orgs.json` with the org's real `orgId`
(`8ae77057-…`) and a throwaway local token, plus a
`report-settings.json` carrying the `aquaticsScope` that could not be read from
production. **Shared card UUIDs are hardcoded in `server.js` and the Metabase
public endpoint needs no key, so a local boot serves REAL production data.**

- **Write `prewarm-state.json` with a fresh `lastCompletedAt` BEFORE booting.**
  `PREWARM_STARTUP_SKIP_MS` is 6h and the boot logs
  *"Startup pre-warm skipped"* — otherwise the boot fans out across ~28 orgs
  against production Metabase, which is the self-inflicted load this file already
  records twice.
- **`readReportSettingsStore()` memoises on first read**, so the settings file has
  to exist before the server starts, not after.
- **Chromium cannot reach cdnjs** — only `curl` honours the sandbox proxy — so a
  Puppeteer run must intercept off-host requests and serve them from
  `node_modules/.cache/render-check`, exactly as `ci-check-render.js` does.
  Without it every page renders blank, which reads as a code defect.
- **Puppeteer's default `protocolTimeout` (180s) is shorter than a cold card.**
  The lane-hours panel fetches card 17294 and the first run died on the protocol
  timeout, not on the selector. `protocolTimeout: 900000`, and the second run is
  fast because the feed cache is warm.

**AND I HIT THE pkill SELF-MATCH TRAP FOR THE FOURTH TIME IN THIS FILE.** A
`grep -F "node server.js"` inside the kill pipeline matched the pipeline's own
command line; every later command exited 144 with no output. The recorded remedy
is the right one and I did not follow it: assemble the needle at runtime, or
find the process another way. Note `ss -lptn` could NOT see the listener in this
container, so the reliable route is reading `/proc/*/cmdline` — and the cmdline
is the bare **`node server.js`**, not the absolute path, so a matcher requiring
`rental-report` in it finds nothing.

**THE RESULT: the Aquatics tab on El Segundo's real August data** — 6,770 pool
bookings, $40,834 charged, 69 active sites, and **8,016 lane hours across 67
lanes** with the hour-coverage heat grid and a CSV link on every panel. Note
8,016 against the **8,406.7** this file records from raw SQL: the tab counts
`oeIsArrival` timed bookings only (5,485 of them) and excludes multi-day rows
that carry no per-day hours, which is the documented behaviour rather than a
discrepancy — but the two numbers must not be quoted interchangeably.

### DESK COVERAGE ON DROP-IN IS 100% — the open question is closed

The previous section left this as *"the measurement that decides whether report B
works"*. Measured: **1,375 of 1,375 drop-in rows carry a `desk_location_name`**.
So CivicRec's "Receipt Location" column reproduces exactly, and **report B needs
nothing further**. The org-wide 72%-without-a-desk figure is online *program*
registrations dragging the average down; counter-sold drop-in is unaffected.
Generalise it: **a coverage figure taken over the whole org is not evidence about
one report's row set.**

### What each side actually looks like, with the figures used

| | theirs (CivicRec, July) | ours (Rec, August) |
|---|---|---|
| A lane hours | 7,782 lane rows · 7,861.0 h · $16,634 | 8,016 h · 67 lanes · 5,485 timed bookings |
| B drop-in | 4,956 admissions · $17,786.50 | item × desk × qty × free × revenue, 100% desk |
| C Rec ID | 171 IDs · $2,040 | 2,371 IDs · $1,875, four tender columns |
| D passes | $12,024 over four tender columns | 793 rows · $10,386 · zip on 791 (99.7%) |
| E instructor | 567 participants · $7,924 · 24.59 h | **the Instructor Payout report** — per section, with a pay slip |

**The passes comparison is the strongest single piece of evidence** that this is
columns and not a rebuild: receipt · date · time · user · zip · cash · check ·
card · total · item comes straight out of `item_log_report` joined to
`users.zip_code`, and it is CivicRec's layout line for line apart from the
receipt number being ours rather than theirs.

## BUILT: Joseph's four aquatics cards (2026-09-09)

Dan: *"lets build them - give me the four SQL reports directly in MB and I'll
wire them up with any needed filters."* Built in collection **3994**
(El Segundo, CA) and added to dashboard **3136**.

| # | card | id | link |
|---|---|---|---|
| 1 | Aquatic Lane Hours | 21682 | https://rec.metabaseapp.com/question/21682 |
| 2 | Aquatics Classes by Month and Instructor | 21683 | https://rec.metabaseapp.com/question/21683 |
| 3 | Aquatics Drop-In Admissions | 21684 | https://rec.metabaseapp.com/question/21684 |
| 4 | Aquatic Passes and Memberships | 21685 | https://rec.metabaseapp.com/question/21685 |

### THE FLIP TAX DID NOT APPLY, and the reason is reusable

Every card registered **exactly THREE** template tags, not six — because these
were **created**, not updated. The six-parameter duplication this file records
comes from *re-saving* a card that already had `date/single` tags; a brand-new
card has nothing to duplicate against.

All three tags came back **`type: "text"`**, as always. **But every date bound is
written `{{start_date}}::date` and `{{end_date}}::date + 1`, so the cards run
correctly under a Text tag** — the cast that `sql/facility-permits.sql` and
`gl-account-detail.sql` have always used. Flipping to Date is therefore
**optional here and only needed to attach a Metabase DATE dashboard filter**,
which can only bind to a Date-typed tag. Nothing is broken until then.

**Dan flipped all three anyway and set a DEFAULT VALUE on `org_id`**
(`8ae77057-6bce-4c20-b0f2-366ed5fa14dd`, El Segundo), so the cards open without
a parameter having to be typed and the dashboard's date filters bind. That
configuration is now the reason these four cards must not be saved through the
API again — see the ORDER BY section below.

### WHAT EACH CARD READS, after Dan's *"use the materialized items log"*

| card | source | why |
|---|---|---|
| 3, 4 | `materialized.item_log_report` only | ✔ |
| 4 | + `users` for the buyer's zip | the item log carries `customer_id` but no zip; `users` has **no `organization_id`**, so it is scoped through `customer_id` |
| 2 | `item_log_report` (money) + `booking_report` (participants) + base `session`/`section_facilitator` | **no materialized table carries a session schedule or a facilitator** |
| 1 | base `reservation`/`reservation_court`/`court` | **`booking_report` is enrollment-grain — no court, no lane, no reservation range.** There is no materialized lane data at all |

### THE DECISIONS INSIDE THE CARDS worth not re-deriving

- **Card 1 has NO money column, on purpose.** A reservation spanning two lanes
  emits two rows, so revenue at lane grain double-counts. Facility money stays
  in the Facility Rental report.
- **Card 1's CASE tests `Court Reservation:%` FIRST.** Otherwise a lane called
  *"Court Reservation: Lap Lane 3"* files as Lap Swim programming — the
  ordering-is-load-bearing rule, third instance.
- **Card 2 FULL OUTER JOINs sessions to money**, because the month a class RAN
  and the month its MONEY MOVED are different months and both are real. An inner
  join would silently drop a term paid for in advance.
- **Cards 3 and 4 PARTITION the org's `product` items** — 3 is Lap Swim + Rec
  Swim, 4 is everything else — so there is no overlap and no gap between them.
- **Card 3 emits admissions INCLUDING `free` and revenue EXCLUDING it**, in two
  columns, which is the whole point of that report.
- **Card 4 emits residency BOTH ways** (buyer zip and the product name's own
  Non-Resident label). They should agree; a row where they disagree is a finding.

### VERIFIED — AND CARD 1 SHIPPED BROKEN ANYWAY

Every query was run against production with literal values before being saved —
card 1: 862 rows / 8,338.5 lane hours / 6.9% unmapped; card 2: 226 rows / 781
sessions / 1,171.4 h / 123 of 226 with an instructor; card 3: 24 rows / 1,380
admissions (335 free) / $6,061 / **zero rows without a desk**; card 4: 118 rows /
3,213 sold / $19,557 net / **0.2% with no buyer zip**. Card 21682 was then read
back and its SQL is byte-intact.

**AND CARD 21682 STILL FAILED THE FIRST TIME DAN OPENED IT**, with
`ERROR: ORDER BY position 9 is not in select list`. Its SELECT emits **eight**
columns and the tail read `ORDER BY 1, 2, 3, 9 DESC`. Correct is
`ORDER BY 1, 2, 3, 8 DESC` — 8 is `Lane Hours`.

**HOW A QUERY "RUN AGAINST PRODUCTION" WAS NEVER RUN.** I verified each card by
wrapping its CTE logic in a *summary* `SELECT` (row counts, totals, coverage
percentages) rather than executing the card's own final SELECT. So the CTEs were
proven and **the column list and the `ORDER BY` line were never executed even
once**. Byte-diffing the saved SQL back only proves the text landed intact — it
cannot tell you the text is valid. Same class as the v7 regression at the top of
this file: **prove the exact text you are saving, not the fragment you developed
it with.** For a card, that means running the card's whole final SELECT, with
literals substituted for the tags, before saving it.

**THE FIX WENT THROUGH THE UI, NOT THE API, AND THAT WAS THE POINT.** By then Dan
had flipped all three date tags and hardcoded El Segundo's `org_id`
(`8ae77057-6bce-4c20-b0f2-366ed5fa14dd`) as the parameter's default. An
`update_question` push regenerates every template tag as Text and would have
wiped both. A one-character edit in the UI preserves them. **Generalise it: once
a human has configured a card's parameters, a programmatic save costs more than
the change is worth — hand over the one-line edit instead.**

Cards 21683 / 21684 / 21685 were checked against their own column counts and are
unaffected (`ORDER BY 1,3,4` of 11; `1,2,3,7 DESC` of 14; `1,2,3,10 DESC` of 16).

**Dan made that edit and card 21682 now returns rows in the UI** (2026-09-09) —
so the parameterised path is proven end to end for card 1: the flipped Date tags,
the `org_id` default and the substitution all work together. That is the sign-off
this file's card rule asks for, and it is the FIRST of these four to have it. The
other three have been read back and their SQL is intact, but **none of them has
been executed through the parameterised path**, so do not record them as signed
off until each returns rows in the UI.

### THE BACKCHECK AGAINST DAN'S SCREENSHOTS — three defects, one arithmetic (2026-09-09)

Dan: *"let me drop in what the mb reports look like here and we can confirm they
match the exports from Civic Rec, at least data wise."* Four screenshots of the
dashboard. **Card 3 is correct. The other three each carry one real defect**, and
all four were measured against production rather than read off the screen.

#### CARD 3's TENDER COLUMNS DO NOT TIE TO ITS OWN REVENUE

The only arithmetic error of the four, and the one that matters most because
**every CivicRec money report has its tender columns sum to its total.**

| El Segundo, August 2026 | |
|---|---|
| Cash + Check + Credit/Debit + User Credit | **$6,027.00** |
| Revenue (net of refunds) | **$5,976.00** |
| gap | **$51.00 — exactly August's refunds** |

Card 3's four tender aggregates filter `transaction_type = 'payment'`, while
`Revenue (net of refunds)` subtracts refunds. So the columns are **gross** and
the total is **net**, and they disagree on precisely the refunded rows. Visible
on screen row by row: every row with `Refunds = 0` reconciles to the cent, and
every row with a refund is over by that refund.

**Card 4 already does this correctly** — its tenders carry
`* CASE WHEN transaction_type = 'refund' THEN -1 ELSE 1 END`, so they net. **The
two cards disagree with each other about what a tender column means**, which is
the two-surfaces-disagreeing trap inside one dashboard. Card 3 should copy card
4, not the reverse: CivicRec's User Credit is negative, so signed is the shape
that reproduces theirs.

#### CARD 2 IS THE WHOLE ORG, NOT AQUATICS

Its SQL scopes to `sec.organization_id` and **nothing else** — there is no
aquatics filter anywhere in it. Measured: **367 of El Segundo's 396 sections are
not aquatic** (87 non-aquatic programmes against 5 aquatic-ish), so the card
titled *"Aquatics Classes by Month and Instructor"* returns Lego Club, Basic
Cooking for Kids, Adult Tapping and Ballet & Tap. 685 rows.

Two more things visible on that card, neither a bug:

- **`Sessions in Month 0` beside real money is the FULL OUTER JOIN working.**
  Money moved in a month the class did not run — the design this file already
  records. But a table where most rows read `0 · 0` reads as broken, so it needs
  saying on screen rather than only in the card comment.
- **Two rows for "El Segundo Training Program", same month, same instructor, are
  two DIFFERENT sections sharing a name.** The card groups by section id and
  prints `sec.name`, so identical names are indistinguishable. A `Section ID`
  column would settle it; without one this reads as a duplicate.

#### CARD 4 LEAKS CITY-WIDE FEES — but far less than the screenshot suggests

The screenshot leads with Farmers' Market and Dial-A-Ride, so it looks as if the
card is the whole catalogue. **It is not, and the measurement corrects my own
first read.** August, rows whose item name carries no aquatic facility:

| | rows | gross |
|---|---|---|
| **Rec ID cards** — legitimately Joseph's report C | **2,203** | $1,830 |
| genuinely out of scope (Farmers' Market ×3, cooking materials, Per Player Fee, Outreach Donations, Red Cross cert) | **19** | **~$6,493** |

So it is **19 rows of 3,221 (0.6%) — and about a quarter of the card's money**,
one `Per Player Fee- Non Resident` row alone carrying $3,695. **The fix is
therefore NOT "filter to aquatic"**, which would delete the Rec ID report; it is
*aquatic-named OR Rec ID, and nothing else*.

**THE PARTITION IS WHAT CAUSED THIS, and it was my design.** Card 4's scope is
*"every `product` item EXCEPT Lap Swim / Rec Swim"* — chosen so 3 and 4 partition
with no overlap and no gap. That is a fine property and the wrong objective:
"everything that is not a drop-in swim" is not "aquatic passes", it is the rest
of the city. **A partition is only worth having over a set that is already the
right set.**

Also found: **`El Segundo Recreation ID Card - Adult` (1 row) against
`El Segundo Resident ID Card - Adult` (1,074)** — a third instance of the
two-catalogue-names-for-one-product trap already recorded for the punch passes.

#### CARD 1 IS RIGHT FOR AUGUST; ITS DEFAULT VIEW IS PRE-CUTOVER TEST DATA

August is clean — **5,808 lane reservations, 4,332 auto-generated
(`Court Reservation:`) against 1,476 real rental names, and ZERO staff blocks or
holds.** The classification works.

What Dan's screenshot shows is **2026-04 and 2026-06**, before El Segundo went
live: `Block`, `Swimlane`, `Hold for Reservation`, and a `Pool Reservation:`
prefix that does not appear in August at all. Every one of them falls to
*"Unmapped - assign a category"*, so **the first screen Joseph sees is test data
telling him to go categorise it.** The card has no date floor and the dashboard
filter arrives empty.

Two fixes, neither urgent: a date floor at go-live, and a bucket for staff
blocks/holds so they are never presented as a programme awaiting a mapping.

### THE SCOPE IS A FIELD THE ORG ALREADY MAINTAINS — `category = 'Pool Programming'`

Dan, with a screenshot of a programme's Activities panel reading
*"Aquatics, Swim Lessons"*: *"for the name filter, can't we use the activity,
'Aquatics'? There's literally an activity name that matches swimming stuff."*

**Right, and the level ABOVE the activity is better still.** I was about to ship
a `%swim%|%aqua%|%water%` name regex, which would have been a maintained guess
over a structured field that already exists.

The path is `program_activity` → `activity` → `category`, all org-scoped and all
carrying `deleted_at`. Measured at El Segundo:

| | sections |
|---|---|
| `activity.name = 'Aquatics'` alone | **61** |
| **`category.name = 'Pool Programming'`** | **83** |
| sections with no category at all | **0** |

**"Aquatics" ALONE MISSES 22 SECTIONS**, and they are not marginal — the
category holds five activities and Swim Lessons is the biggest of them:

| activity | sections |
|---|---|
| Swim Lessons | **71** |
| Aquatics | 61 |
| Water Aerobics | 8 |
| Swim Activities | 6 |
| Stroke Refinement | 3 |

So a programme can be tagged `Swim Lessons` without `Aquatics`, which is exactly
what Dan's own screenshot shows carrying both. **One value at the category level
beats five at the activity level** — and it picks up a sixth aquatic activity on
the day El Segundo adds one, with no card edit. Tennis sits under `Sports`,
Zumba under `Fitness`, Hip Hop under `Dance`, so the category genuinely
separates.

- **COVERAGE IS 100%, which is why this is usable at all.** Every one of El
  Segundo's 396 sections carries an activity — unlike the instructor field,
  which is empty on every aquatics section. A structured field is only better
  than a regex if it is actually populated; this one is, and that was measured
  before choosing it.
- **The tag is multi-valued and 3 sections sit in two categories** — all three
  are one programme, `Lego Club (library)`, mis-tagged with a Pool Programming
  activity. That is El Segundo's data entry, not a structural problem, and it
  argues for `BOOL_OR`/`EXISTS` rather than a join that could fan out.

**`site_activity` CANNOT do the same job for card 1.** It exists (court_id →
activity_id) and looks like the principled replacement for that card's hardcoded
list of three location names — but **exactly ONE El Segundo court carries a Pool
Programming activity**, so the table is essentially unpopulated here. Card 1
keeps its location list. Worth knowing so nobody spends an afternoon on it.

### "(no location on sessions)" WAS A LIE, AND MY FIRST DIAGNOSIS WAS WRONG

Dan: *"also for card 2, you're missing some location/site data, it's in there."*
With the admin UI beside it: **Level 1- Tadpoles: Tue/Thurs 4:00pm-4:25pm**, every
session at **Urho Saari Swim Stadium** — and card 2's August row for that exact
section reading `(no location on sessions)`.

**I reached for the wrong cause first, and it was a cause this file already
records.** The note on card 17295 v6 says `session.location_id` is EITHER a court
id OR a location id, and reading one side silently loses the other. That is a
real trap and it is **not what happened here**: measured, **all 2,067 live El
Segundo sessions resolve as a LOCATION, none as a court, none NULL.** Checking
beat pattern-matching, and the pattern was one I had written down myself.

**The real cause is that the location was read from THAT MONTH'S sessions.**
`sess` groups by section × month and the SELECT reads `COALESCE(sess.loc, …)`, so
a row arriving from the money arm alone — money moved, no session ran — has
nowhere to read a location from. Measured on the exact section Dan named:

| Level 1- Tadpoles: Tue/Thurs 4:00pm | sessions |
|---|---|
| 2026-08 | **0** |
| 2026-09 | **8, all Urho Saari** |

August is registration money for a course that starts in September. So the label
blamed the data for something the query did to itself — **the location was never
missing, it was merely not in that month.** Its Mon/Wed siblings have one August
session each, which is why they resolved and the Tue/Thurs ones did not: same
programme, same pool, different answer.

**A SECTION'S LOCATION DOES NOT CHANGE MONTH TO MONTH**, so it is resolved from
the section across all its sessions (`sec_loc`), and the fallback is reworded to
`(no location on file)` — a claim about the record rather than about the month.

**Generalise it: a COALESCE fallback is a sentence the reader believes.** If it
names a cause it must be the actual cause; `(no location on sessions)` asserted
something false about El Segundo's data entry, on a report they would have taken
to be a finding.

Two more things the fix carries, both found by running it:

- **`Section ID` is now a column**, and it settles the apparent duplicate rows:
  49 distinct section NAMES against **52 distinct section IDs** over Aug-Sep.
  `Level 3 - Clownfish: Tue/Thurs 4:30pm-4:55pm` really is two sections, and
  `Semi-Private: Level 1/2 9:30am` and `10:30am` likewise. Not a grouping bug.
- **`s.starts_at IS NOT NULL`**: a NULL start makes a NULL `ym`, and `NULL = NULL`
  never matches in the FULL OUTER JOIN, so such a session emitted a row with a
  blank Month that could never pair with its money. Two sessions at El Segundo.

**AND IT CORRECTS A CLAIM IN THIS FILE.** It says *"every aquatics section has no
facilitator on file"*. **Saul Gonzalez teaches all six `Swim With Me - Adaptive`
sections**, so the instructor column is populated for some aquatics after all —
the coverage gap is real but not total, and the sweeping version of it should not
be repeated to El Segundo.

The corrected SQL is mirrored at `sql/report-cards/21683-aquatics-classes.sql`
and was **verified by running that exact text**, whole final SELECT included,
against production: **97 rows where the live card returns 685**, three locations,
**zero** unresolved. **It is NOT applied to the live card** — Dan has flipped the
date tags and set the org_id default, and `update_question` would regenerate both
as Text, so this goes in through the UI.

### ALL FOUR CARDS ARE APPLIED (2026-09-09)

Dan asked whether the cards could be updated programmatically off their public
links. **They cannot, and access was never the blocker** — I created them and
hold write access and their numeric ids. `update_question` takes SQL only as a
`query_handle` from `construct_native_query`, whose entire input is
`database_id` + `sql`: **there is no template-tag field anywhere in that path**,
so every programmatic save regenerates all three tags as Text and wipes both
Dan's Date flips and the hardcoded `org_id` default. Now that the cards are on a
dashboard the Date-typed tags are what its date filters BIND to, so an API save
breaks the dashboard, not just the cards. Dan: *"all good i'll just
copy/paste"* — and he applied card 2 (21683) the same afternoon.

The other three are mirrored in `sql/report-cards/` and **each was verified by
running THAT EXACT TEXT, whole final SELECT, bare — not wrapped in a summary
SELECT**, which is the specific mistake that let card 21682 ship with
`ORDER BY position 9 is not in select list`.

| card | file | fix |
|---|---|---|
| 21682 | `21682-aquatic-lane-hours.sql` | a go-live date floor + a Staff Block / Closure bucket |
| 21684 | `21684-aquatics-dropin.sql` | the four tender columns now sign refunds |
| 21685 | `21685-aquatic-passes.sql` | scope is aquatic-named **OR** Rec ID, not "everything except drop-in swim" |

**Dan pasted all three the same afternoon, and each was read back and confirmed
BYTE-IDENTICAL to its mirror with all three template tags intact** — `org_id`
text carrying the El Segundo default, `start_date`/`end_date` still typed
**date**. That is what a UI paste buys over an API save, demonstrated rather
than argued.

**AND THE FIRST PASTE OF CARD 21684 DID NOT LAND.** Dan sent a screenshot saying
it was done; the card body was unchanged. **His own screenshot proved it before
the card was re-read**, which is the reusable part: every row with `Refunds = 0`
tied exactly (Hilltop Rec Swim - Youth, 108 + 492 = 600), and every row with a
refund was over by precisely that refund — AC Lap Swim - Adult 227 + 886 =
$1,113 against $1,105 with 1 refund, AC Rec Swim - Youth 42 + 453 = $495 against
$477 with 3. A rendered table is checkable arithmetic, so **check the numbers in
the screenshot against the invariant before believing a card was updated** — the
live read then only confirms what the arithmetic already said.
**CARD 21684 — the tenders now tie to the card's own total.** They filtered
`transaction_type = 'payment'`, i.e. GROSS, while Revenue is net. August: gross
tenders $6,027.00 against revenue $5,976.00, gap **$51.00 = exactly the month's
refunds**, and every row with zero refunds already reconciled. Signed now, and
re-measured: **19 rows, 1,354 admissions of which 323 free, 9 refunds,
$5,976.00 — and the four tenders sum to the revenue on ALL NINETEEN ROWS,
refunded rows included.** Card 21685 already did it this way, so the two cards
had been disagreeing about what a tender column means inside one dashboard.

**CARD 21685 — the leak is a THIRD of the money, not "about a quarter".** I
estimated ~$6,493 gross from a name scan; measured properly over August it is
**$6,413.00 net of $19,557.00 — 32.8% — on 17 rows of 3,213 (0.5%)**, across
seven items (Farmers' Market ×3, Cooking Class Materials, a kitchen fee,
`Per Player Fee- Non Resident`, a Red Cross certificate). The 2,203 Rec ID rows
STAY, which is why the fix is not "filter to aquatic". After: **424 rows, 3,196
sold, $13,144.00 net, 55 items, tenders reconcile on all 424, ZERO rows falling
to the ELSE.** A Military tier was added in the same pass — ~90 Military-priced
pass rows had been reading `(no tier in name)` because the CASE had no branch.

**CARD 21682 — the floor is 33 rows and the bucket fires on real data.**
Everything before 2026-08-01 is **33 reservations / 35.0 lane hours** across
2026-04/06/07, named Block, Swimlane, Hold for Reservation and
`Pool Reservation:` — the pre-cutover test data that was the first thing Joseph
saw, every row of it reading *"Unmapped - assign a category"*. Against 5,808
reservations and 8,338.5 hours in August alone. In LIVE data the new
Staff Block / Closure bucket catches exactly one thing today —
**"Labor Day Closed", 8 reservations / 24.0 h** — so it is a live category and
not defensive decoration. **The hours are KEPT rather than netted out**: closed
lane time is still lane time that was not sold, and which side of a utilisation
ratio it belongs on is Joseph's call, not the card's. Unwindowed after both
fixes: 2,236 rows / 18,987 reservations / 35,983.50 lane hours, 2026-08 ..
2027-01, nothing earlier.

**TWO PRIOR "VERIFIED" ROW COUNTS DO NOT REPRODUCE, and the reason is the same
one.** Card 21684's comment claims 24 rows / 1,380 admissions / $6,061 for
August (really 19 / 1,354 / $5,976 gross-of-nothing), and card 21685's claims
118 rows (really 424 — its grain includes Buyer Zip). Card 21685's **$19,557 net
DOES reproduce exactly**, which is the tell: the money came from a summary probe
that was right, and the row counts came from a probe at a grain the card never
had. Same root cause as the ORDER BY bug — *the card's own SELECT was never
run.* Both verification comments are corrected in the mirrors to today's
measured figures.

### THE FILTER REQUIREMENTS, EXAMINED AGAINST THE BUILT CARDS (2026-09-09)

Dan: *"now examine the filter requirements he asked for."* Four of Joseph's five
cross-cutting requirements are met by the cards as they now stand. **Facility is
the one gap, and it is three separate problems stacked.**

| requirement | verdict |
|---|---|
| custom range + monthly rollup + Jul–Jun FY | **met** — all four carry Date-typed `start_date`/`end_date`, and an FY is just a range |
| individual program name, not category totals | **met** — every card is item- or section-grain |
| net of refunds | **met**, and since the 21684 fix the tenders tie to it |
| mapped to a GL code | **available and unmet** — see the correction above; the column is a perfect facility key and neither money card selects it |
| **filter by facility (AC / Plunge / Hilltop)** | **NOT POSSIBLE TODAY** |

#### 1. A NATIVE CARD CANNOT BE FILTERED BY A RESULT COLUMN

This is the mechanical blocker and it is worth stating plainly, because the
cards *display* Facility and that makes the filter look one drag away. A
Metabase dashboard filter on a native question must bind to a **template tag**.
All four cards register exactly three — `org_id`, `start_date`, `end_date` — so
there is nothing for a Facility widget to attach to. **Adding the filter means
editing all four cards, not configuring the dashboard.**

And the widget it can have is limited: a **Field Filter** maps to a real column
on a real table and therefore cannot bind to a `CASE` expression, so the
facility tag has to be a **plain variable** — a typed value or a static
dropdown, not a live multi-select of the values on screen.

#### 2. THE FOUR CARDS SPELL ONE FACILITY FOUR WAYS

Measured, and this is why one filter value cannot serve the dashboard:

| Joseph's name | card 1 (`location.name`) | cards 3 / 4 (item name) | `desk_location_name` |
|---|---|---|---|
| AC | `El Segundo Wiseburn Aquatic Center` **+** `…Aquatics Center- Competition Pool` | `Aquatic Center` | `El Segundo Wiseburn Aquatic Center` |
| Plunge | **`Urho Saari Swim Stadium`** | `Plunge` | `Plunge` |
| Hilltop | *(absent — see 3)* | `Hilltop` | `Hilltop` |

**The Plunge IS Urho Saari Swim Stadium.** A filter set to `Plunge` returns 1,081
rows on cards 3/4 and **zero** on card 1. The Aquatic Center is likewise two
locations on card 1 and one bucket on cards 3/4.

**And card 4's `Wiseburn` bucket is not the Aquatic Center**, which is the easy
misread — those 182 rows are `Wiseburn Rec ID` cards, a residency product for
the Wiseburn district, plus 2 `Wiseburn Facility Reservation` rows. They belong
with the Rec IDs, not with a pool.

#### 3. CARD 1 EXCLUDES HILLTOP, AND HILLTOP NOW HAS A POOL

Card 21682's `aquatic_sites` CTE names three locations and Hilltop Park is not
one. That was right when the card was written and is not now — see the
correction in the section above.

#### WHAT WIRING IT ACTUALLY TAKES

One canonical label set — `Aquatic Center` / `Plunge` / `Hilltop` — emitted by
all four cards, plus a `facility` template tag on each inside `[[ ]]`. On cards
3 and 4 **drive it off the GL code rather than the item name**: it is
structured, it is El Segundo's own field, and it agrees with the name regex
exactly today, so switching costs nothing and stops the prefix list needing
maintenance. Card 1 needs Urho Saari → Plunge, both Wiseburn locations →
Aquatic Center, and Hilltop Park added; card 2 needs its session location mapped
the same way.

**BUILT the same afternoon — see the next section.** Dan: *"Can't we filter the
report by location? we have that data for all these reports, no?"* and then
*"yes, write all four--and use 'location' as the report filter, not 'facility'."*

### THE LOCATION FILTER, BUILT ACROSS ALL FOUR CARDS (2026-09-09)

**`location`, not `facility`** — Dan's word, and the better one: it is the field
name the platform already uses, and "facility" reads like a building type.

Every card now carries a fourth template tag, `{{location}}`, inside `[[ ]]`, and
every card emits a **`Location` column carrying the SAME canonical values**, so
one dashboard filter drives all four:

| | |
|---|---|
| `El Segundo Wiseburn Aquatic Center` | Competition Pool folded in |
| `Urho Saari Swim Stadium` | staff call it the Plunge |
| `Hilltop Park` | |
| `(City-wide - Rec ID)` | **card 4 only** — a Rec ID answers to neither pool |

#### IT IS A HYBRID, AND THE MEASUREMENT IS WHY

Cards 1 and 2 read a **real `location` record**. Cards 3 and 4 read the **GL
code**, because `materialized.item_log_report` has no location column at all.

The obvious alternative on the money cards is `desk_location_name`, and it is
right for one of them and badly wrong for the other:

| | rows with a desk |
|---|---|
| card 3, drop-in | **1,857 of 1,857 — 100%** |
| card 4, aquatic passes | 175 of 1,051 — **16.7%** |
| card 4, Rec ID cards | 283 of 2,572 — **11.0%** |
| GL code, both cards | **every row** |

Drop-in is counter-sold; passes and Rec IDs are bought online. So a desk-based
filter would drop ~87% of card 4's money **and drop it non-randomly**, keeping
only the counter sales. `desk_location` also has **no `location_id`** — its
columns are id / created_at / updated_at / organization_id / name / description
/ archived_at / enforce_access_control — so a desk cannot even be joined to a
location record. "Plunge" the desk matching "Urho Saari Swim Stadium" the
location is a coincidence of naming, not a relationship.

On card 3 the GL code and the desk agree **1:1 with zero "(no desk)"**, which is
what makes using the GL code on both money cards free rather than a compromise.

#### THE DROPDOWN IS A CUSTOM LIST, NOT A LIVE QUERY — and Dan asked directly

*"Do we need a separate mb query to pull the live location data from El Segundo,
then wire that to the filter?"* **No, and a live one would be worse.** The CASE
ladders in these four cards have to be hand-edited when a pool is added, so a
self-updating dropdown would offer a fourth value that silently returns **zero
rows on every card** — a filter that looks like it works and answers nothing.
A static list of four cannot get ahead of the SQL. Two blocks to edit when a
pool opens, both marked with ▼▼ in the mirrors: `aquatic_sites` on card 21682
and the `scoped` CTE's GL ladder on 21684/21685.

#### THE TAG IS A PLAIN TEXT VARIABLE, so it takes ONE value

A **Field Filter** would allow multi-select and cannot bind to a computed `CASE`
expression, so it is not available here. One location at a time, or blank for
all — which is the common case anyway.

#### `Facility` WAS REPLACED, NOT ADDED BESIDE

On cards 3 and 4 the old `Facility` column (parsed out of the item name) is gone
and `Location` sits in its place, so **the `ORDER BY` positions are unchanged** —
the specific thing that broke card 21682 on its first save. The item name still
carries the facility, so nothing is lost.

#### A `WHERE TRUE` IS LOAD-BEARING ON THREE OF THE FOUR

Cards 2, 3 and 4 had no `WHERE` on their final SELECT at all, so the optional
clause has nothing to hang off. `WHERE TRUE [[AND … ]]` is the idiom; without it
the `[[ ]]` block has to carry the `WHERE` itself and Metabase's substitution
gets fragile.

#### VERIFIED, each by running ITS OWN WHOLE TEXT with literals

| card | with the filter unset | split by location |
|---|---|---|
| 21682 | 2,237 rows | Wiseburn AC 1,854 / Urho Saari 382 / Hilltop **1** |
| 21683 | 125 rows | Urho Saari 93 · Wiseburn AC 31 · `(no location on file)` **1** |
| 21684 | 19 rows (Aug) | 3 locations, **zero unmapped GL**; filtered to Urho Saari → 8 rows, tenders still tie |
| 21685 | 424 rows · $13,144 (Aug) | 4 values, **zero unmapped GL**, identical to the pre-filter run |

Two honest notes rather than glossed ones:

- **Card 2's one `(no location on file)` row** is a section with no session on
  record at all, so there is nothing to read a location from. It drops out when
  the filter is set, which is correct — it cannot be claimed for a location
  nobody recorded. The earlier Aug–Sep windowed run recorded **zero** such rows;
  this run is unwindowed, which is a different question, not a regression.
- **Card 1's hours move between reads** — 35,983.50 → 35,998.50 across one
  afternoon, all on the Wiseburn instant-lane side. August is an open window and
  campers keep booking. Never diff an open window against itself across two
  reads.

**Hilltop is +1 row, and that is the whole of it.** Card 21682 excluded Hilltop
Park entirely; it now has a published pool site and is included **pool only**,
because its other five sites are picnic tables and would otherwise land in a
lane-hours report.

#### VERIFIED LIVE AFTER DAN'S PASTE — and TWO VALUES EMPTY TWO CARDS

Dan: *"ok all four pasted, verify the filter works."* **It works**, and the
verification found something the dropdown does not say out loud.

Read back live: all four cards register the `location` tag as **text**, and the
three original tags survived the paste on every one — `org_id` text carrying the
El Segundo default, `start_date`/`end_date` still typed **date**, which is what
the dashboard's own date filters bind to.

**THE COVERAGE MATRIX, measured unwindowed rather than assumed.** Rows each card
returns for each of the four dropdown values:

| filter value | 1 lane hours | 2 classes | 3 drop-in | 4 passes |
|---|---|---|---|---|
| El Segundo Wiseburn Aquatic Center | 1,854 | 14 sections | 13 | 838 |
| Urho Saari Swim Stadium | 382 | 54 sections | 15 | 111 |
| **Hilltop Park** | 1 | **0** | 8 | **0** |
| **(City-wide - Rec ID)** | **0** | **0** | **0** | 1,867 |

**Both empties are correct, not broken**, and neither was obvious:

- **Hilltop sells drop-in swim and nothing else.** It runs no aquatic programme
  sections and sells no passes or Rec IDs, so cards 2 and 4 have nothing to show.
  I had assumed it carried passes; it does not.
- **A Rec ID is city-wide by construction** — it answers to neither pool — so it
  exists only on card 4, which is the card that sells it.

So picking either of those two leaves most of the dashboard blank. **That is the
data being honest, and it still reads as a broken filter to Joseph**, which is
the argument for a note on the dashboard rather than for changing the SQL. The
alternative — folding Rec IDs under a pool — would file city-wide revenue
against a facility that never earned it.

Zero rows fell to `(unmapped GL …)` on cards 3 and 4, so the GL ladder is
complete for every product in scope.

**One honest gap on card 2:** **15 of its 83 sections carry no session at all**,
so they have no location and drop out whenever the filter is set. Checked rather
than waved through — **all 15 have zero confirmed bookings** (Baby & Me, two
Lego Clubs, four unstarted Tadpoles/Frogs/Clownfish sections, a *Squad Session -
Free Trail*). They are empty shells, so nothing with money or participants in it
is ever hidden by the filter. The earlier Aug–Sep windowed run showed 1 of these
because the window hid the rest.

#### THE PASTE IS DAN'S, AND ADDING THE TAG IS A UI STEP

`update_question` regenerates every template tag as Text and takes SQL only as a
`query_handle` from `construct_native_query`, whose entire input is
`database_id` + `sql` — **there is no template-tag field anywhere in that path**.
Dan has flipped the date tags to Date and hardcoded the `org_id` default, and
the dashboard's date filters BIND to those Date-typed tags, so a programmatic
save breaks the dashboard rather than only the cards. Paste in the UI.

### TWO PLACEMENT GAPS

- **The MCP `update_dashboard` tool has no tab parameter**, so the four cards
  landed on the dashboard's default tab rather than its `aquatics` tab. They have
  to be dragged across by hand.
- **`create_question` HTML-escapes the name.** Card 2 saved as
  `Aquatics Classes by Month &amp;amp; Instructor` and had to be renamed — the
  same `Sales &amp;amp; Mix` escaping trap already recorded in this file, one API
  over. **Do not put an ampersand in a card name passed through this tool.**

### WHERE THIS IS HEADED (Dan, same session)

Two notes worth keeping, neither of them acted on yet:

1. *"Civic (and many orgs) just want data reports, not a fancy visualization. So
   maybe it's worth retroactively building these types of Reports joseph is
   looking for into a more cross functional set of 'data only' reports into the
   org dashboard?"*
2. *"once i can validate that the data looks similar, we'll consider flipping
   these into a new 'custom reports' section in the reporting project. main
   reasons are mb exporting->pdf looks terrible, and if we manage the report we
   can control what the export looks like."*

**These four cards are already the right shape for that flip.** Each takes
`org_id` + optional `start_date`/`end_date`, which is exactly what
`buildMetabaseParams` sends, so becoming a feed behind a reporting-project page
is a `SHARED_UUIDS` entry and a table renderer — not a rewrite. The export
argument is the strongest one on the list: this repo already owns CSV with the
BOM (`csvFromRows` + `saveTextViaPopup`) and PDF via Puppeteer, both of which
beat Metabase's PDF.

## SCOPED: Joseph's four reports as METABASE CARDS (2026-09-09)

Dan: *"I suspect it's just easier to build all of these as custom metabase
reports, no? Scope out just building the 4 reports he wants in metabase, drop the
other stuff."* **Scoped, nothing built.** Full write-up:
https://claude.ai/code/artifact/204633da-2f05-48dd-b1f9-6efc5963e6ca

**All four are buildable as cards; three are rollups over tables already proven.**
The measurements below are new this session and are the ones worth keeping.

### THE AVAILABILITY DENOMINATOR EXISTS, AND THE TAB CANNOT SEE IT

The item this file listed as *"UNVERIFIED — check whether the lanes carry
published open hours"* is **answered: all 67 aquatic lanes carry them.**

| | |
|---|---|
| lanes with `court_slot` rows | **67 of 67** |
| lanes exposing `config->bookingPolicies->slots` | **0 of 67** |
| court-days | 441 |
| open hours/week, interval-UNIONED | **4,207 h** (avg 9.54 h/court-day) |
| open hours/week, naive `SUM` | 4,288 h — **+1.9%, and a 63-hour day** |

`court_slot` is `court_id · day_of_week · open_from · open_to · type · deleted_at`
(**not** `start_time`/`end_time` — I guessed that first and it errored; query
`information_schema.columns` before writing the join, as this file already says).
All El Segundo slots are type `PRIVATE`.

**UNION THE INTERVALS, NEVER `SUM` THEM.** Only **6 of 441** court-days carry
overlapping rows, so a naive sum looks fine until you notice a court-day claiming
63 hours. That is why the card must merge intervals — and it is a number **our own
Facilities tab structurally cannot produce**, because it reads
`bookingPolicies.slots`, which is empty on every one of these lanes.

### REPORT 1's MAPPING IS 31 ROWS, NOT 145

Measured Aug–Sep 2026 over the three aquatic locations: **19,641.5 lane hours,
67 lanes, 145 distinct rental names.** The split is what matters:

| | names | lane hours | share | booking type |
|---|---|---|---|---|
| real names | **31** | 11,679 | **59.5%** | all `managed` |
| `Court Reservation: <lane>` | 114 | 7,963.5 | 40.5% | instant + managed |

So the program-type mapping Joseph fills in is **31 rows**, and the other 40.5% is
auto-generated per-lane names carrying no programme at all — **one honest bucket
(*individual lane reservations*), not a gap.** Top named: Drop In Lanes 4,116 h ·
Loyola Marymount 1,380 · SCAQ 1,132.5 · ESHS Waterpolo 1,008 · Rec Swim 976 ·
Swim Lessons 347.5 · Naomi's 301 · Coastal 300.

**Ship report 1 BEFORE the mapping arrives** — lane × month × rental name is
already useful and the mapping upgrades it without changing the query's shape.

### THE REST OF THE SCOPE

Reports 3 and 4 are single rollups over `materialized.item_log_report`, and **the
platform's index problem does not bite at this org: El Segundo all-time is 1.7 s**
(measured earlier this session). Report 2 is mostly deciding which of cards 17295 /
21055 / 17755 to point him at rather than writing SQL. Every trap is already
recorded in the sections below — the free-row split, the double-count between
rentals and sections, Hilltop having no aquatic site, the duplicate catalogue
names, the missing location column on the item log, and the GL code being a
roll-up rather than a breakout.

**The cost is the flip tax**: four programmatic saves is four cards registering six
parameters until a human re-saves them, so **batch all four into one visit** and
sign each off through the public endpoint AFTER the flip.

### DROPPED THE SAME AFTERNOON, and one claim left unverified

Dan opened with two things about the Aquatics TAB — *"our aquatics facilities
report isn't fine grained and the excel button doesn't do anything"* — and then
redirected to the cards above (*"drop the other stuff"*). Both are parked.

**The Excel claim was NOT reproduced, and I am not recording a verdict on it.**
Static review found the button wired correctly (`exportExcel` → `aqSheetTables` →
`saveWorkbookViaPopup`, with `CFG` and `open-pdf.js` both present), and one thing
worth knowing turned up on the way: **in the toolbar the Excel button and the
settings gear sit AFTER Print / PDF / Summary, and on Dan's ~1573px screenshot
they are past the right edge.** That is a plausible cause and it is a guess — the
browser run that would have settled it was killed when the ask changed. If it
comes back, drive it rather than reading it.

## Joseph's four aquatics reports, measured against live data (2026-09-09)

Dan: *"revisit the el segundo reporting stuff, see how what we have compares to
the requests in the email from Joseph at el seg."* Measured, nothing changed.
Write-up artifact:
https://claude.ai/code/artifact/0a35b7c8-9fbf-4cf3-98b8-10f0cf624070

**EL SEGUNDO WENT LIVE IN AUGUST 2026, and that reframes the whole ask.** Net
revenue by month: **Jul $3,214 · Aug $141,514 · Sep-to-date $47,412**. His
report is due end of September against a July–June fiscal year, so Rec holds
**one complete month**. Whatever he filed for July came from Civic Rec, and the
first Rec-sourced report will look thin for reasons that are not our reporting.

Note the org is **not in `server.js`** — it is a dynamic org served from the
store, so its saved `aquaticsScope` could not be read from the sandbox. That is
the one unverified item below.

### THE ROOT CAUSE OF REPORTS 1 AND 2 IS ONE FACT: LANE TIME IS BOOKED TWO WAYS

Rentals, groups and drop-in go through **facility reservations**, which attach
to each lane. Instructional classes go through **program sections**, which
attach to a building. Measured: of El Segundo's **284 program sessions** in
Jul–Aug, **284 carry a `location_id` and ZERO carry a court** — and there is no
session→court join table anywhere in the schema (`reservation` is the only table
carrying both a `session_id` and a court/site).

So **swim lessons contribute zero lane hours and no report can invent them.**
That is not a gap in the Aquatics tab; it is a gap in what the platform records.

**And the reservation side is exactly what Joseph wants, with no assumptions.**
His definition — *"4 lanes for 1 hour/day, 5 days/week = 20 lane hours/week"* —
is what `reservation_court` already produces, because a rental attaches to each
lane it occupies. Naomi's Water Aerobics in August: **96 lane-reservations
across 8 distinct lanes over 13 days = 83 lane hours**, computed his way.

August aquatic lane hours: **Wiseburn 6,513 h / 53 sites**, **Urho Saari (the
Plunge) 1,872 h / 16 sites**, competition pool 21 h — **~8,406 h**. Named groups:
Drop In Lanes 1,692 h (Urho 1,152 + Wiseburn 540), Loyola Marymount 660, SCAQ
387.5, Rec Swim 224, Coastal 120, Tower 115.5, BCA 94, LAM 93, Naomi's 83, Quest
WP 80, Trojan 80, Mary's 79. The rest is individual lane reservations.

**DOUBLE-COUNT TRAP:** Naomi's and Mary's exist BOTH as a facility rental and as
a program section (Naomi's 83 h rental / 43 h of sessions; Mary's 79 h / 17.5 h).
Summing rental hours and session hours counts them twice. Any lane-hours report
has to pick one side per program and say which.

**HILLTOP CAN NEVER SHOW LANE HOURS.** It sold 282 rec-swim admissions in
August and has **no bookable aquatic site at all** — its only site records are
picnic tables. Hilltop reads zero until its pool is set up as a site.

**STALE AS OF 2026-09-09 — the pool site now EXISTS.** `Hilltop Pool
Semi-Private Party` is a published `pool`-typed court at Hilltop Park with one
reservation (2026-09-05) — the same booking the aquatics-scope backcheck
records as *"1 booking, $256"*. So the sentence above was true when written and
is not now. **Card 21682 still excludes it**: that card's `aquatic_sites` CTE
lists three location names and Hilltop Park is not one of them, so a facility
filter set to Hilltop returns nothing on card 1 while cards 3 and 4 show 297
drop-in rows for it. Add Hilltop Park to the CTE when the facility filter is
wired.

**Nothing tags a booking with a PROGRAM TYPE.** He wants Swim Lessons / Water
Fitness / Open-Rec Swim / Lap Swim / High Schools / Youth Water Polo / Masters.
What exists is a free-text rental name (`SCAQ`, `Quest WP`, `Trojan`,
`Drop In Lanes`). A human reads those; a report cannot group them without a
mapping the org supplies — same shape as `aquaticsScope`, and the single
cheapest thing that would turn the existing lane-hours panel into his report 1.

### THE INSTRUCTOR COLUMN IS EMPTY, AND THE FIELD WORKS FINE

Report 2 asks for *by instructor*. **Every aquatics section has no facilitator
on file** — Naomi's HIIT Water Aerobics, Mary's Water Fitness, Level 1 Tadpoles,
Level 2 Frogs, all blank. Tennis (Sergiu Boerica), Zumba (Sandra Delgado) and
Red Cross (Loretta Zarp) all have one, so this is data entry at El Segundo, not
a reporting gap. Consistent with the 155-of-286 coverage already recorded above.

**ATTENDANCE SPLITS ACROSS TWO REPORTS AND THAT IS NOT A DEFECT.** August has
**1,161 check-ins: 761 pass + 251 membership + 149 booking** (plus 35 undone).
Only the **149 booking scans** attribute to a section — those are report 2's
attendance. The other **1,012 pass/membership scans are org-grain** and are
precisely report 3's drop-in check-in count. Do not try to put them on a class.

### REPORT 4 IS ESSENTIALLY DONE, BECAUSE THE ORG ENCODED IT IN ITEM NAMES

Facility, category, tier and residency are all in the product name:
`AC Lap Swim - Adult`, `Plunge Rec Swim - Youth`, `Hilltop Rec Swim - Adult`,
`Plunge Non-Resident 10 Punch Pass - Adult`. Every non-resident product is
explicitly labelled, so his resident/non-resident split is separable by string.

**His "annual (Rec ID) memberships" IS a product family already:**
`El Segundo Resident ID Card` (**2,455 sold in August**, $2,085) and
`Wiseburn Rec ID` (180, $180). Cleanly separable from pass sales.

**DO NOT COUNT ROWS AS SALES.** **8,261 of August's 20,201 transactions carry
`transaction_method = 'free'`** — punch redemptions and $0 admissions sitting in
the ledger shaped exactly like sales. A row count overstates "passes sold" by
roughly 40%.

**Two naming schemes for one product.** `Aquatic Center 30 Punch Pass - Adult`
(122) and `AC 30 Punch Pass - Adult` (61) are the same thing; a by-name report
lists them twice. Same for the 10/20-punch and Annual Membership families.
Catalogue hygiene, worth fixing before the first monthly report is filed.

### THE CROSS-CUTTING REQUIREMENTS — one of the five genuinely does not hold

- **Filter by facility (AC / Plunge / Hilltop): PARTLY.** Works for lane hours
  and classes, which carry a real site or session location. It does **not** work
  on the revenue ledger: **`materialized.item_log_report` has no location column
  at all** (columns are customer / order item / transaction / gl / desk). The
  facility is in the item NAME, or in `desk_location_name` — and desks are real
  (`El Segundo Wiseburn Aquatic Center`, `Plunge`, `Hilltop`) but **72% of
  August's rows have no desk** ($146,275 of $189,000) because they were bought
  online. So desk cannot be the facility filter.
- **Custom range + monthly rollup + Jul–Jun FY: HAVE IT.** A fiscal year is just
  a range; nothing special is needed.
- **Individual program name, not category totals: HAVE IT.** Everything here is
  section-grain or item-grain.
- **Net of refunds: HAVE IT.** Payments and refunds are separate rows, and the
  Programs report already shows collected / refunds / net separately.
- **Mapped to a GL code: ~~PARTLY~~ — CORRECTED 2026-09-09, it is a FULL
  FACILITY KEY.** This bullet used to read *"almost everything is `001-505-5`…
  the column will not distinguish any of his programs from each other"*. **That
  was wrong, and it was wrong because I read only the first three segments of
  the code.** The full value is `fund-dept-object-?-program`, and at El Segundo
  it separates the facilities perfectly — measured over every `product` row in
  the aquatics + Rec ID scope, with **zero cross-contamination in either
  direction**:

  | GL code | what it is | rows |
  |---|---|---|
  | `001-505-5213-3-43869` | **Aquatic Center** (594 drop-in + 862 pass/ID) | 1,456 |
  | `001-505-5202-3-43869` | **Plunge** (965 drop-in + 116 pass/ID) | 1,081 |
  | `001-505-5214-3-43860` | **Hilltop** (all drop-in) | 297 |
  | `001-505-5213-3-43882` / `-43885` | **Wiseburn Rec ID** | 182 |
  | `001-505-5201-3-43863` | **El Segundo Resident ID** | 2,462 |

  So the GL code and the item-name regex agree **exactly** today — which means
  the GL code is the better facility key of the two: it is structured, El
  Segundo maintains it in their own finance system, and it needs no maintained
  list of name prefixes. **Neither card 3 nor card 4 selects it.** Requirement 5
  is unmet only because the column is not emitted.

  **Generalise it: a truncated identifier is not the identifier.** Reading
  `001-505-5` and concluding the field is useless is the same shape as reading a
  schema instead of the report that already answers the question.

### WHAT WOULD ACTUALLY UNBLOCK HIM, cheapest first

Two of the three biggest wins are El Segundo's to do, not ours:

1. **Assign instructors to the aquatics sections.** Fills report 2's instructor
   column and the Instructor Payout report for aquatics. **El Segundo's to do,
   and Dan's call is that it does not block us** — the columns work, the field is
   empty; he will remind them.
2. **Get a program-type mapping** — which rental names are Masters, High
   Schools, Youth Water Polo. One list turns the existing lane-hours panel into
   his report 1.
3. **Confirm `aquaticsScope` has Wiseburn and Urho ticked.** Their lanes are
   typed `court`, so without both the tab reports 21 hours instead of ~8,406.
   **UNVERIFIED** — the org is dynamic and the setting could not be read here.
4. **Check whether the lanes carry published open hours.** If they do,
   available-vs-reserved (his report 3) is a matter of pointing the existing
   `courtSchedulesFor` / `courtOpenHours` denominator at aquatics rather than
   building anything. If they do not, the denominator is a conversation.
5. **A store-item admission has no duration**, so lane hours for Lap Swim and
   Rec Swim store items can only come from the posted rec-swim window — a number
   El Segundo supplies, never one we measure. Presenting it as measured is the
   `DIR_FT_MINUTES_PER_REG` mistake.

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

**THIS IS THE END OF THE LINE FOR IT, by Dan's 2026-09-01 call** — the branch
stays and nothing else gets built on court-typed lanes. See *"CLOSED — nothing
further gets built on courts-as-pool-lanes"* below before extending anything here.

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

## Aquatics scope is CONFIGURATION now, and the lane guess is gone (2026-09-02)

Dan, reversing the "build nothing further" call below: *"lets make this
configurable. pools can be courts, but courts can never be pools. the 'hack' in
using pools for courts is that orgs need a site to be instant bookable on the
'courts' section, and ONLY courts show up there. So the default setting for the
aquatics report tab is 'pools', but there is a configurable setting on that
report to add in an additional site 'type'."*

**`refineSiteType`'s lane branch is DELETED.** It recovered a court-typed swim
lane from the site name plus an aquatic-sounding location — a guess that had to
be right about every org on the platform from one regex, and that encoded a
product capability gap into reporting. What replaces it is an org saying so.

ONE setting on the `facility` report (`REPORT_SETTINGS_SCHEMA`, which registered
only `roster` before this): **`aquaticsScope`**, default `[]` — the locations or
site names that count as aquatic **on top of pools**.

**IT IS AN INCLUSION, SO EMPTY MEANS POOLS ONLY** — deliberately NOT the
"empty means every one" rule every other multi-select here follows, because this
control does not narrow anything. Pools were never gated on it, so a stale entry
(a renamed location) adds nothing rather than emptying the tab.

Measured at El Segundo before designing: **Wiseburn Aquatic Center 51 court-typed
sites (48 lane-named), Urho Saari 16 (all 16), Recreation Park Courts 17 (0
lanes)**. So those two locations are exactly right and the tennis courts stay
out.

### There WAS an `aquaticsExtraTypes` setting, and it is gone (2026-09-02)

The first build of this paired a site-TYPE list with the scope, and the scope
NARROWED what the types let in. Dan, on the panel: *"and didn't I ask for some
option to select a location and sites in that location? … the goal here is to
choose locations and sites that are NOT aquatics, to include in the aquatics
tab."*

**A TYPE CANNOT EXPRESS WHAT AN ORG MEANS, and El Segundo is the proof:** ticking
`court` brings in 67 real swim lanes **and** 17 tennis and pickleball courts,
and no per-type rule anywhere can separate them. Only the org naming its own
locations can. So the type list was **removed from the schema rather than left
unread** — a registered setting nothing reads is the dead-end pattern this file
keeps writing down, and `aquatics-scope.spec.js` now asserts `aquaticsScope` is
the ONLY facility setting and that a posted `aquaticsExtraTypes` is refused.

Safe to do without a migration because **no org had aquatics settings stored** —
checked before changing the semantics, all seven sampled at platform defaults.

**The panel is a location → site TREE**, not a row of checkboxes (that shape is
what Dan called *"terrible"*, and fairly: 84 site-type and location boxes
overflowing an unpadded white box). Tri-state location boxes (all / some /
none), a per-location *"Tick all N sites here"*, and a live tally of what the
tab will count so the effect is legible **before** saving rather than after a
reload.

- **A whole location stores the LOCATION NAME, not its sites** — two entries for
  El Segundo rather than eighty, and it keeps counting a site added next month.
- **Unticking one site of a whole-location pick has to EXPAND that pick first**,
  or the location entry silently keeps counting the site the admin just
  excluded. The box goes unticked either way, so the tally is the only place
  that shows it — which is what the render case keys on.
- **Pool sites are shown LOCKED, never hidden.** Leaving them out is what makes
  an admin wonder whether the pool is in the number.
- **Locations WITH pools sort first.** Sorting by site count put a complex of
  four soccer fields above the Aquatic Center on an aquatics panel.
- **Anything already saved but absent from this window stays in the tree**, or an
  admin could never untick what they ticked last month.
- **The pool sub-line counts DISTINCT sites**, not feed rows — it read *"3 pool
  sites"* beside a count of `2 / 2` on the same row.
- **The sheet is PORTALLED to `<body>`.** `.toolbar label` (0,1,1) sets
  `text-transform: uppercase`, a grey colour and `flex-direction: column` for the
  date captions, and `.toolbar button` beat `.rs-save`, so Save rendered grey and
  looked inert — which is exactly what Dan reported. An inline style only wins
  for the properties it names; getting out of `.toolbar` fixes all of it at
  once. The `.rs-grp` in the shared stylesheet is a bare divider with no padding
  of its own (the roster pads `.rs-grp-head`/`-body`), hence `.aqt-body`.
- **Save is gated on `dirty`** (Dan: *"don't love the 'auto save', cause it
  actually didn't"*), and the footnote says why it is off.

**The name branches STAY.** A site an org literally called "Pool 1" or "Aquatic
Center Lap Area" is the org's own word, not our inference about a location.

### FIVE surfaces scoped to aquatics, and one of them was hardcoded

The tab, its lane-hours panel, the tab badge, the Excel export and the scope
note. Four built their own `new Set(vert.types)`; the **lane-hours panel
hardcoded `r['Site Type'] === 'pool'`**, so it would have reported eleven hours
beside a tab reporting thousands. They all read `vertRowMatch(r, key)` now, and
the type/scope Sets are built once per vertical rather than per row.

**The gear is mounted on the EMPTY branch too.** An org whose lanes are all typed
`court` has no pool bookings at all until it is configured, so a control only on
the populated branch is a dead end for the one org that needs it.

**`vertScopeNote()` states the scope on screen** — excluded is never hidden, and
an admin looking at a narrowed tab must be able to see that it is narrowed.

The settings sheet's CSS moved to **`public/report-settings.css`**, shared with
the roster. Copying a hundred lines of it into a second page is how two dialogs
start looking like different features — the `.season-*` → `.mpick-*` lesson.

### A `strings` kind, and a validator that stopped discarding silently

`aquaticsScope` is free text, because the catalogue is per-org and lives in the
feed. It is bounded on every axis a stored list can grow along — count (200),
item length (200), duplicates — and **blanks are dropped**, since an empty entry
can never match a location and would sit in the panel looking like a bug.

The `columns` kind now **reports** an entry that is not in its catalogue. It used
to be caught only by the `min` check, so a list with a floor of zero silently
binned a bad value and answered ok — the exact thing that route's own comment
says must not happen.

### Guards

`scripts/aquatics-scope.spec.js` (**52 assertions, in CI**), replacing
`aquatics-lanes.spec.js`. It LIFTS AND RUNS `refineSiteType` and `vertRowMatch`,
and the load-bearing assertion is that **the guess cannot come back**: a
court-typed "North Lane 1 - A" at "El Segundo Wiseburn Aquatic Center" stays a
court.

**One assertion had to be scoped, not deleted.** `!/\['Site Type'\] === 'pool'/`
exists to stop the lane-hours panel hardcoding the type again — and the SETTINGS
panel legitimately asks a row whether it is a pool, to decide what to lock. So
it is asserted over the page **with `AquaticsSettings` cut out**, and there is a
second assertion that the cut removed something, or the first would be vacuous.
Slicing the component hit the `liftFn` trap a **third** time: counting braces
from the first `{` in `function AquaticsSettings({ rows }) {` matches the
DESTRUCTURED PARAMETER and cuts 33 characters. Skip the parameter list first.

Mutation-tested: the scope reverted to narrowing (pools gated on it), the type
list back in the schema, and the lane-hours panel hardcoding `'pool'` again —
all three fail by name.

**A render case that quietly stopped testing what it claimed.** The three lane
cases kept passing after the branch was removed, and it took a bisect to find
why: the fixture builds `Facility` as `"<location> - <site>"`, so those rows say
"Aquatic" in their *name* and are recovered by the name branch. They are the
hour-math guard and nothing more. `Lap Lane 7` at `Wiseburn Center` — no aquatic
word anywhere — is the discriminating row, and `facilities · an unconfigured org
counts no courts` is the case that fails if anyone reinstates the guess.
Generalise it: *when you delete the thing a test was written for, check the test
still fails without it.*

### Seven render cases for the tree, all mutation-tested

`facilities ·` now carries the tree: the locations it lists (keyed on
`Wiseburn Center`, the location with no aquatic word anywhere, and on the tally
at rest equalling the POOL sites and nothing else), a location expanding to its
sites, one site making its location **partial**, pool sites present and locked,
the sheet out of `.toolbar`, Save off until something changes, and **unticking
one site of a whole location dropping the count**.

Seen to fail on the real regression, each by name: `locState` collapsing `some`
into `on`; pool sites hidden instead of locked; the portal dropped (which fails
the cascade case *and* the Save case, because `.toolbar button` steals the blue —
the bug as Dan hit it); Save ungated; a location that no longer expands; and
`toggleSite` not expanding a whole-location pick.

**And the runner was lying about how much it had run.** `ci-check-render.js`
printed `${CASES.length}` on success, so a filtered run that matched **nothing**
reported *"238 page(s) render with no uncaught errors"* — which reads exactly
like a full clean pass, and I took it as one. It reports what actually ran now.

**The configured path is also spec-covered rather than render-covered**, and
deliberately:
driving it in a browser needs the server's settings store changed mid-run, and
`readReportSettingsStore()` memoises on first read, so a file written behind the
server's back is never seen.

**Two sandbox traps, both of which cost real time here:**

- **`pkill -f "node .*server.js"` kills this session's own harness**, and the
  symptom is every subsequent command exiting 144 with no output — which reads
  exactly like the render check crashing. Sweep `/proc/*/cmdline` for
  `rental-report/server.js` instead.
- **`directors-facilities.spec.js` threw before asserting anything**, because its
  slice of `facilities.html` now runs past `VERT_CONFIG`, which reads the
  injected aquatics settings declared above the slice. Same shape as the
  `alertEnabled` reference that left `email-slack-notify.spec.js` dead for
  months. A slice that grows can reach past its own inputs.

### Backcheck of El Segundo's configured tab, and two defects it found (2026-09-02)

Dan, after ticking the two aquatic locations: *"confirm these new numbers are
correct."* **They are.** Recomputed independently from card 19570's own rows
through the public endpoint (cache-independent, 5,641 rows in 20.9s), applying
`refineSiteType` and the tab's own reducers, El Segundo Sep 2026:

| | his screen | recomputed |
|---|---|---|
| charged | $32,339 | **$32,339** |
| instant-book | 27% · $2,093 | **27% · $2,093** |
| managed | 73% · $30,246 | **73% · $30,246** |
| active sites | 67 | **67** |
| bookings | 4,572 | 4,578 |
| canceled | 277 | 278 |
| guests | 1,254 | 1,257 |

**Money and site count identical; the three counts differ by 3-6 because
September is an OPEN window** — his page rendered from a cache entry read before
mine, and the new rows are $0 instant lane slots, which is why the money did not
move. Never diff an open window against itself across two reads; that is the
Clarksville lesson, and it is the whole explanation here.

Also settled: **every row that carries a head count carries exactly 1**, and
`guests == the instant-book count` is not a coincidence — the 1,257 rows with a
head count ARE the instant bookings, and the 3,321 managed ones record none.

**Two real defects, both found by doing this rather than by review:**

- **"Revenue by site" printed "A" and "B" twelve times.** Dan: *"this metric
  missing the full court/site lane names."* Four tabs each carried their own
  `f.split(' - ').slice(1)` — drop everything before the FIRST ' - ' — which
  assumes every site is named `"<location> - <site>"`. El Segundo's lanes are
  named `North Lane 7 - A` and `Inst Lane 4-2" Depth (25Y) - A`, so the rule
  kept the SUBLANE LETTER and threw the lane away. **And it was not only a
  label:** Camping, Outdoor and Fields build `location + '||' + site` from that
  value as a site's IDENTITY, so two lanes at one location whose names end the
  same way merged into one row with their bookings, hours and revenue added
  together — a location with twenty lanes counted as two sites. One module-scope
  `siteLabel(facility, location)` now, trimming a leading copy of the row's
  **own** location and nothing else. Guessing a prefix from a separator cannot
  work; the row carries its location, so test against that.
- **"Avg Party 0.3 guests per booking."** Arithmetically right and reads as
  broken: `guests / bookings` over a denominator where 73% of rows cannot
  answer. The honest figure is **1.0, on the 1,257 of 4,578 that report one**.
  Same rule as `hasAbsent` — a denominator must not include rows that cannot
  answer — and **the Outdoor and Fields tabs had always done it correctly**, so
  the Summary and Aquatics tabs were disagreeing with a right answer already in
  the file. All three tiles now say *"where recorded (N of M)"*, because 1.0 is
  as opaque as 0.3 without it.

**And the rebuild moves his numbers slightly, in the correct direction:** under
the inclusion rule a `pool`-typed site OUTSIDE the ticked locations counts,
where the old narrowing design excluded it. Measured: **68 sites and $32,595**,
the difference being Hilltop Park's *Hilltop Pool Semi-Private Party* — 1
booking, $256. Pools always count, so that is the answer; worth knowing because
the site total changes by one the day this ships.

Guards: `aquatics-scope.spec.js` 52 → **68 assertions**, lifting and RUNNING
`siteLabel` over the real El Segundo names. Mutation-tested: the split rule
restored (which reproduces Dan's *"A"* exactly), and Avg Party back over all
bookings — both fail by name.

### CLOSED — nothing further gets built on courts-as-pool-lanes (Dan, 2026-09-01)

Dan, after walking through the lane classification: *"lets skip 2 for now, since
using courts as pool lanes as a total hack, I don't want to build any of this into
our reporting. pools are pools, courts are not pools."* Asked whether to rip the
lane branch back out or leave it, he chose **leave it, build nothing further on
it.**

So the split is exact, and worth keeping straight:

- **What stays.** `refineSiteType()`'s lane branch and its two guards, the
  Aquatics tab reading 70 lanes / 29,981 hours instead of 24 sites / 11 hours,
  `aquatics-lanes.spec.js` and its render cases. El Segundo keeps the numbers they
  asked for. Removing it would take them back to 11 hours all-time, which is a
  worse answer than the hack.
- **What is dead.** The per-org site/location picker described below — *the whole
  reason this section was PARKED* — plus El Segundo ask #2's aquatics-facing
  location/instructor page work and ask #3 (drop-in / public swim) insofar as
  either would read court-typed lanes. Not deferred, not waiting on
  `REPORT_SETTINGS_SCHEMA`: not being built.

**THE HACK IS A PRODUCT CAPABILITY GAP, AND THAT IS WHY IT DOES NOT BELONG IN
REPORTING.** Dan's own earlier explanation of how the lanes got typed that way:
*"in this case pool lanes are marked as 'court' so users can instant book them,
but this is atypical."* Instant booking is a `court` capability, so an org that
wants a self-bookable lane has no option but to lie about the type. Every report
feature built on top of that lie encodes it further and has to be unwound when
the product grows bookable pools. The fix is on the product side; reporting's job
is to not deepen the workaround.

Reasoning kept below, because it is measured and would otherwise be re-derived.

### PARKED → NOT BUILDING → BUILT: per-org site scoping for a report tab

**SUPERSEDED 2026-09-02 by *"Aquatics scope is CONFIGURATION now"* above** — Dan
reversed the call and the location/site picker described here exists, as the
`aquaticsScope` tree. Kept because the MEASUREMENTS below are what chose a
location picker over a site-type list, and they are still the argument. Read the
newer section first; the words "never started" in this one are history.

#### The original write-up

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

Never started, and now closed by the decision above. Two things would have had to
be settled anyway: `REPORT_SETTINGS_SCHEMA` registers only `roster` today, and the
whole panel is **super-admin gated behind the `reportSettings` flag** by Dan's own
earlier call (*"this power is too much for an org user to handle"*) — so "the org
admin could set it" was a change to that decision, not just a new schema entry.
Neither is the reason it is dead; the reason is that it would scope a report tab
by which courts are pretending to be pools.

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

## Court utilization: ONE availability source (2026-09-03)

Dan, on a partner brief about San Francisco's QBR reading 70% (Q2 2025) against
53% (Q2 2026): *"confirm we're still using a generic denominator for the courts
utilization rate, not the ACTUAL court availability, no?"* — then, on the
answer: *"can we flip the qbr generator to live availability... it should be
referencing the same availability data."*

### THE COURTS TAB WAS ALREADY ON LIVE AVAILABILITY. The QBR was not.

Two code paths, and only one of them was generic:

| surface | denominator, before |
|---|---|
| Courts tab (`facilities.html` → `CourtUtilizationView`) and `/​:org/court-utilization` | **live per-court schedule**, from MCP `list_sites` → `config.bookingPolicies.slots`, per weekday × how many of that weekday fall in the window |
| QBR (`qbrSumCourt`) and Director's Report (`dirCourt`) | flat `QBR_COURT_HRS_PER_DAY = 11` × courts × days, **clamped at 100%** |

`courtSchedulesFor(org)` is now extracted from the route's body, so the route,
the QBR and the Director's Report read **one** source — which is the whole ask.
`courtOpenHours(courtKeys, …)` does the same arithmetic `computeCourtAvail`
does on the tab, so the two cannot disagree.

- **THE COURT KEY IS THE TAB'S OWN LABEL** — `"<location> — <court>"`, em dash.
  The QBR used `"|"` internally; a key that does not match sends every court to
  the fallback and **the number looks unchanged**, which is the worst way for
  this to break.
- **The 100% clamp is gone.** Under a real schedule a court over 100% is a
  finding — booked beyond its published hours — and clamping hid exactly that.
  The flat denominator needed the clamp because it invented what it divided by.
- **`utilizationEstimated` is now TRUE only when some of the denominator really
  is assumed.** It was hardcoded true, so a measured figure carried an "EST."
  tag — the reason a partner asked what the denominator was in the first place.
- **`scheduled` / `assumed` travel with the number** and the report prints
  which: *"from each court's own open hours"*, or *"N of M courts assume X
  hrs/day"*. A utilization that does not say how much of its denominator was
  assumed is how the flat figure got trusted.
- **A failed probe is not cached.** Caching it for four hours would put every
  court on the flat fallback for the rest of the window — the `POS_OK` rule.
- `dowCountsInRange` builds dates from PARTS, never `new Date(ymd)` — UTC
  midnight lands on the previous day west of UTC and would mis-weight a
  quarter's Mondays.

### THE FLIP DOES NOT MOVE SF'S HEADLINE, and that is worth knowing

Measured against SF's live schedules (107 of its 114 courts resolve):

| quarter | flat denominator | live denominator | util |
|---|---|---|---|
| Q2 2025 | 101,101 | **100,867** | 70% either way |
| Q2 2026 | 107,107 | **105,625** | 53% either way |

Within **1.4%**. SF's mean is **10.85 open hrs per court-day**, a coincidence
away from the flat 11 — so the flat figure was accidentally right in aggregate
for this org, and **the −20.6% YoY drop is real in the booking data**, not a
denominator artifact.

Where the flip pays is PER COURT, and there it is large. The spread across
SF's 749 scheduled court-days: 419 at 12h, 112 at 13.5h, 42 at 14h — and **18
at ZERO and 14 at 1.5h**. Presidio Wall runs 1.5 open hrs/day and was being
divided by 11; on a test row it reads **37% instead of 5%**.

**Two candidate availability sources disagree and Dan's call settled it.** The
partner brief measured `court_slot` and got 13.58 avg (range 1.5–26); the
`bookingPolicies` path the tab reads gives 10.85 mean, max 14. Using
`court_slot` would have produced ~57% / ~43% — a defensible-looking number that
disagrees with the Courts tab, which is the two-surfaces-disagreeing trap. The
tab's source wins because the tab is what an org looks at.

### CORRECTED: the SF QBR is RIGHT. A COLD generate can drop sections.

**I reported that the SF QBR was empty and that is wrong.** Dan exported both
quarters and the PDFs carry exactly the figures in the partner brief:

| | Q2 2025 | Q2 2026 |
|---|---|---|
| booked court hours | **70,903** | **56,310** |
| courts | **101** | **107** |
| utilization | **70% EST.** | **53% EST.** |

with the footnote *"Court utilization estimated against a 11 hr/day operating
window"* — the flat denominator, exactly as the brief reverse-engineered it. So
**Lindsay's numbers did come from this generator** and `qbrSumCourt` matches the
brief's definition.

**HOW I GOT IT WRONG, because that is the reusable part.** I probed
`POST /qbr/api/generate` while my own 240s card-17297 query and several MCP SQL
statements were hitting the same Metabase, read the null sections as a finding,
and wrote it down. That is verbatim the trap already recorded in the card
sign-off section — *"RUN THE SWEEP ALONE, or it invents failures on cards you
never touched... never report one as a finding without doing so."* I had the
rule, did not follow it, and published the conclusion. **A null section is
evidence about the last two minutes of load, not about the report.**

**What IS real, and is much narrower.** Re-run clean, nothing else in flight:

| run | result |
|---|---|
| SF Q2 2026, warm cache | `hoursBooked 56310, courts 107, utilization 53` — correct |
| SF Q2 2025, cold | `court: null`, at **128s**, reproducibly |

A **cold** SF generate can drop a section against `fetchMBDirect`'s 120s abort,
and `safe()` swallows it: the response is a 200 and the PDF simply omits the
panel. Dan's export worked because the 4-hour feed cache was warm.

**THAT is the dangerous shape** — a quarterly report that ships without its
court section and looks complete. Worth fixing as its own thing: a section that
failed to load should say so rather than vanish, the same rule as `hasAbsent`
and the permits column. And worth knowing before generating a QBR for a large
org off a cold cache: warm it, or check what populated.

### A spec that THREW instead of failing — fifth instance

`directors-facilities.spec.js` slices server.js from `const DIR_OUTDOOR_TYPES =`
to the literal `"function dirCourt(rows, days) {"`. Adding the availability
arguments moved that marker, so the slice failed and the spec died on a bare
`AssertionError` naming nothing. The end marker is the function NAME ONLY now.
**Fifth instance of a slice reaching past its own inputs**, and the third where
a guard died instead of failing by name.

## Feedback metrics on the Platform Usage cards (2026-09-03)

Dan: *"I feel like displaying the feedback metrics are an easy lift."* It was —
**the data has been in `events.jsonl` since each surface shipped and nothing
displayed it** — but not for the reason it looks. What made it more than a
display job is that **a thumb is recorded three different ways depending on
which surface took it.** Measured against production over the whole log:

| event | field | rows | notes |
|---|---|---|---|
| `insights-feedback` | `score` (1/0) | 18 | AI Insights |
| `vote` | `sentiment` | 15 | a report page's quick thumbs |
| `wizard-feedback` | `vote` | **11** | rental calendar — **and never in `SLACK_NOTIFY`** |
| `chat-feedback` | `score` | 9 | Rec AI Chat |
| `feedback` | `vote` | 9 | Report Wizard — carries the **PROMPT** |
| `update-vote` | `sentiment` | 3 | the What's New popup |
| | | **65** | across 15 orgs, all inside 90 days |

### `/api/admin/feedback` READ TWO OF THE SIX, and the two dead ones

That route filtered `chat-feedback || insights-feedback` — **27 of the 65** — and
those are precisely the two families with **zero activity in the last 30 days**,
while `vote`, `feedback`, `wizard-feedback` and `update-vote` account for **all
17 recent ratings**. So the endpoint the roadmap called *"already exists; needs a
frontend readout"* would have rendered an **empty panel on a month in which
seventeen people rated something.** It goes through the shared aggregator now.

### ONE predicate, and an unreadable row is counted on NEITHER side

`feedbackSentiment(e)` reads all six families and all three field names, at
module scope so the spec can RUN it. `score` is compared **strictly** — a string
`"1"` is a malformed row, not a thumbs up.

**A row with no readable sentiment returns `null` and is counted on neither
side**, reported separately as `unreadable`. A default would file it as
agreement or as a complaint, and a thumbs figure that invents a direction is
worse than one that says it could not tell. The same rule as `hasAbsent`.

**`feedbackSubject(e)` names the thing rated in the ROW'S OWN FIELD** — an
update names the update, a wizard row names the generated report, a rental row
names the site type. Printing the report type for all six reads
*"Report Wizard on report-wizard"*: the report type twice and the thing rated
never, which is the exact defect already fixed once in the Slack branch.

**On a wizard row the PROMPT is the comment.** The question somebody typed and
did not get a good answer to is the highest-signal text on the platform, and it
existed only in a JSONL file — *"all revenue for Pequos summer camp, Week 2
sections"* → thumbs down.

### TWO WINDOWS, each saying which it is

The KPI counts the **same 30 days** as every card beside it, because one card in
a row meaning a different window is the lifetime-vs-window confusion fixed on
the Programs summary the same day. The **list is everything on record** and its
header says so — 30 days holds 17 ratings while the corpus is 65, and the
comments worth reading are older.

- **No share over a handful.** `FEEDBACK_MIN_RATINGS = 5`; under it the counts
  are the whole answer. Same rule as `RATE_MIN_VIEWS` and `WL_CONV_MIN_OFFERS`.
- **The per-org column prints COUNTS, never a percentage** — 30 days is 17
  ratings across 10 orgs, so a per-org share reads "100%" off one thumb. A faint
  dot where there are none, because a grid of `0 · 0` reads as data.
- **`upPct` is null, never 0.** "Nobody has rated anything" is not "everybody
  hated it".
- **THE COUNT OPENS SOMETHING.** A number with nowhere to go is the dead end
  this repo keeps writing down (the Failed check-ins tile, the "2 ending soon"
  section). The KPI is the way in, and the list is **closed until asked for** —
  an always-open list of every rating is a different, noisier feature.
- **`oldest` is a MIN, not an array position.** The header prints that date as a
  fact, and reading it off the last element is an assumption about file order.
  The mutation proves it: with rows sorted newest-first, the positional read
  reports the **newest** rating as the oldest.

### `wizard-feedback` was never in `SLACK_NOTIFY` — FIFTH instance

11 ratings written to `events.jsonl` and none announced, since the day it
shipped. Now wired, debounced **per site type** (rating the pavilion suggestion
and then the picnic-table one is two answers), with the site type in the message
because *"somebody rated a suggestion"* says nothing. **Consequence to expect:
Slack starts getting rental-calendar suggestion thumbs it has never had.**

The guard is the generalised form: every event name `server.js` logs whose name
mentions a vote or feedback must be in `FEEDBACK_SOURCES` **and** in
`SLACK_NOTIFY`, derived from `server.js` rather than transcribed — so a seventh
surface fails the spec instead of being quietly missing.

### A REGEX COMMENT-STRIPPER IS UNSOUND ON server.js — it made four assertions here pass vacuously

Found because this spec passed while the route assertions could not possibly
have matched. **Two independent strays:**

- **line 5837** carries the text `/* stay reachable so it can be` **inside a
  `//` comment** — legal JS. Strip block comments *first* and that opener pairs
  with a real close fifteen hundred lines later, swallowing **2,792 lines**.
  **Nine specs in this repo had that order** and were blind over that region;
  all nine now strip line comments first.
- **line ~5918** carries a `/*` **inside a template literal** — real code, not a
  comment. *No* strip order helps, and both orders swallow the region holding
  `/api/admin/feedback`.

So this spec reads the **RAW** source and slices the route's own text where it
needs to be scoped. **Generalise it: if a spec must not see comments, slice the
region it cares about rather than regex-stripping a 19,000-line file.** And
writing this note as a block comment containing a literal close-comment marker
ends the comment early — the same mistake one level up, which is why the spec's
copy spells it out in words.

### Guards

`scripts/feedback-metrics.spec.js` (**91 assertions, in CI**), which LIFTS AND
RUNS the four helpers over the six shapes production actually writes, and boots
a real server on a fixture `DATA_DIR` for the rendered half — apex 1/1 against
watertown 2/3, so a cell reading the wrong org's counts fails rather than
rendering a plausible number. It also pins **one `<td>` per `<th>`** and that the
feedback cell sits where its header's sort index points, which is the fault the
last three column additions caused. `SKIP_SOURCE=1` drops the source half.

Mutation-tested seven ways, all failing by name: a family dropped from the map
(the bug as `wizard-feedback` shipped), unreadable rows filed as DOWN, the share
floor removed and zero-defaulted, the route back to two families, the event
dropped from `SLACK_NOTIFY`, `oldest` read off an array position, and the list
rendered always-open.

**The route mutation THREW instead of failing by name** — `api.byOrg.apex.up`
became a TypeError and the spec died reporting *"Cannot read properties of
undefined"*, naming nothing. Third instance of that lesson here; the live half
reads through a safe accessor now.

Plus a browser check that the KPI **opens** the panel and closes again, and that
sorting on the new column works — `ci-check-admin-js` proves the handler exists
and parses, which is not the same claim.

## THE SUBTOTAL NUMBERS WERE UNDER THE WRONG HEADERS (2026-09-10)

Dan, with four screenshots across the custom data reports: *"remove the
'metabase card' info / remove the 'rental name' filter / split out the print and
pdf buttons... drop in admissions — misaligned columns and row totals / Aquatic
passes — similar misalignment / Users and HH — report too wide with cut off
columns — remove [thirteen] filters, leave ONLY an open text search field and
residency yes/no"*.

### IT RENDERED CORRECTLY ON THE ONE SHAPE NOBODY COULD SEE IT IN

`GroupedTable`'s subtotal and grand-total rows emitted **two** leading blocks
that both covered the text columns:

```jsx
<td className="sublabel" colSpan={labelSpan}>{it.label}</td>   // 1 + textCols
{textCols.length > 1 && <td colSpan={textCols.length - 1} />}  // ...again
```

so the leading span was `2 x textCols.length` against a header's
`1 + textCols.length`, and every total was pushed `textCols.length - 1` columns
to the RIGHT of its own heading. On Aquatic Passes that put `Sold / Refunds /
Net Revenue` under Cash / Check / Credit.

**The `> 1` guard is why report 1 looked fine.** Lane Hours opens with Rental
Name hidden, which leaves ONE text column, which suppresses the filler — so the
report Dan checked first was the only one that could not show the bug.

**NO EXISTING CASE COULD SEE IT, and there were twelve.** Every one keys on
`[data-total-col="X"][data-total-val="N"]`, and those attributes are on the cell
wherever the cell happens to sit. *An attribute assertion is not a position
assertion.* The new case walks the row summing `colSpan` and requires each total
to land on its own header's index — and it also stamps `data-textcols`, so it
fails rather than passing vacuously on the single-column shape.

### THE PDF DID NOT EXIST — and it is the standing rule's own first customer

There was one **Print / PDF** button calling `window.print()`. Splitting it is
not cosmetic: **print and PDF fail differently.** Print hands the reader's own
browser the page it is already showing and is right by construction. The PDF is
Puppeteer driving this same page under `?_print=1` in a browser that has never
seen this reader — **no localStorage, no state, the URL is the only channel** —
so it needs its own route, `#report-ready` (absent from this page entirely), and
every narrowing written into the query string.

**`hide` IS THE LOAD-BEARING ONE.** The column picker lives in localStorage by
deliberate design (*"which columns you like looking at is a display
preference"*), which means it has **no other way to reach the render**. So
`?hide=` is read on this page, `saveHidden` is gated on it (a shared link must
not rewrite the reader's own default), and `generatePdf` forwards it.

**Three of these CANNOT ride `generatePdf`'s named list**, and both reasons are
new: the per-column filters are `f_<column>` — one key per column, named by the
card's own headers, so there is no fixed list to enumerate — and `f_` and `hide`
are **repeated keys**, where `new URLSearchParams({k: [a, b]})` comma-joins and
a rental name legitimately contains a comma. They are appended after the object
is built. And, as with `pii`, they travel on **presence**: an empty `hide` means
*"the reader unhid everything"*, which is not the report's default.

**`reportLabel`'s CASE ladder ends in `: "Facility Rental Schedule"`**, so every
one of these PDFs would have carried that in its own footer. Read from
`CUSTOM_REPORTS` ahead of the ladder, so a fifth report is named on the day it
is registered rather than added to a chain nobody remembers.

### THE FILTER MENUS WERE THE REPORT RENDERED AS A DROPDOWN

`noFilter` is a per-report **denylist** — a stale entry does nothing, where a
stale allowlist loses a filter silently. It never touches the COLUMN, only its
menu.

- **Rental Name**: 145 distinct values in a real September window. A checkbox
  list that long is a list, not a filter.
- **All Users**: thirteen menus removed, one kept. Residency? has two answers
  and staff ask it; every other dimension there is per-PERSON — a name, an
  email, an address part — so its menu is one checkbox per household.

### A FILTER IS A VOCABULARY, NOT A DIRECTORY — and it is derived, not listed

Dan, on the shell: *"don't add filters for data sets that are huge, like names,
emails, etc. Some of the filters on the users report were thousands of lines,
that makes no sense. we should only be adding filters for items like locations,
sites, membership names, lane or court names, groups, residency status."*

That is a statement about **cardinality**, so it is answered from the ROWS.
`isFilterable(rows, col, cap)` counts distinct values and **bails out the
moment it passes the cap** — on a 6,500-row user report the answer for Email is
known after 101 rows, and building the whole map to throw it away is the cost
this pays on every render.

**`FILTER_MAX_OPTIONS` IS SET BETWEEN TWO MEASURED NUMBERS, not picked.** Card
21685 emits **55** distinct pass and membership names at El Segundo, and Dan
named membership names as exactly the kind of thing that should have a filter;
card 21682 emits **145** rental names, which is the menu he asked to remove. So
the line has to fall between 55 and 145 — it is **100** — and the spec asserts
that range rather than the literal, so moving it costs a measurement. The first
draft was 40, which would have taken the membership-name filter with it.

**Deriving it rather than listing it is the whole point:** a new report inherits
the rule with no registry entry, and a card that GAINS a column gets the right
answer the day it ships, where a hand-kept list is only ever as current as the
last person to edit it. `noFilter` stays as the explicit override for a
LOW-cardinality column a report still does not want a menu for — Household Role
has three values and Dan asked for it gone anyway.

**A COLUMN ALREADY BEING FILTERED KEEPS ITS MENU, whatever its cardinality.** A
deep link can narrow on anything, and a filter with no control to clear it is
the dead end this file keeps recording: the scope note would read
*"Email: ada@example.com"* with nothing on screen able to undo it.

Neither rule touches the COLUMN. It is still shown, still exported, and still
reachable by the search.

**What replaces them is ONE box across every column, hidden ones included.**
`searchRows` is AND over whitespace-separated terms, so *"smith 90245"* works in
either order, and it joins columns with a `\u0001` separator so a term cannot
straddle two of them. It runs BEFORE the collapse — subtotals for rows that are
not on screen is the same defect one level up — and the scope note names it on
the page, because whoever prints this has no toolbar to look at.

**The discriminating render case searches for `SCAQ`, which lives ONLY in Rental
Name — the column this report opens with hidden.** A search restricted to the
visible columns finds nothing and fails; that is the entire reason for the
choice of term.

### Guards

`custom-reports.spec.js` 45 → **56 assertions**, lifting and RUNNING
`searchRows` and **`generatePdf`'s own query builder**. Mutation-tested ten
ways, all failing by name: the filler cell restored (the bug as it shipped, in
both the source assertion and the positional render case), the search reading
only the visible columns, `noFilter` ignored, the buttons recombined, the card
id put back, the forwarding removed, and — the important one — `hide`/`q` folded
into `generatePdf`'s **truthy** loop, which is the plausible half-fix that
passes every populated-value assertion and fails only on empty.

**A guard of mine DIED instead of failing, and the fix generalises.** The
generatePdf lift ended at the forwarding line it was testing, so deleting that
code broke the SLICE and the mutation reported *"the query builder is not where
this expects it"* — naming nothing. It is bounded by the line that CONSUMES the
query string now. Fifth instance in this file.

**And one of my own cases asserted a descendant that has never existed on any
build**: `needs` is ONE `querySelector`, so `'[data-row-count="3"]
[data-scope-note]'` asks for a scope note INSIDE the row counter. It failed on
correct code. Stamp on `<body>` and assert `body[...] [target]`.

`ci-check-render.js` gained an **all-users stub and seven cases**, and the
fixture's residency answers deliberately DIFFER inside one household — a filter
scoped to the household rather than the person would read the same either way.

### THE END-TO-END PDF COULD NOT BE PROVEN BY THE PDF ROUTE, and that is the sandbox

`/api/pdf` timed out at 120s on `#report-ready`: **Chromium here cannot reach
cdnjs** (only `curl` honours the proxy), so React and Babel never load and the
page is blank — which reads exactly like a missing marker. The proof is the
render check's own trick, applied by hand: drive the SERVED print page with the
CDN bundles served from `node_modules/.cache/render-check`. Note they must carry
**`access-control-allow-origin: *`** or the `crossorigin` script tags are
CORS-blocked and it fails the same way for a second reason.

Proven that way, against the real served page:

| URL | what came back |
|---|---|
| `f_Program_Type=Masters&hide=&q=` | **1 of 3 rows**, and `Rental Name` IS in the header — the empty `hide` overrode the report's own default |
| `hide=Rental+Name&hide=Booking+Type&q=scaq` | both columns gone, 1 row, the scope note naming all three |

plus `#report-ready` in the DOM and a real 41KB `%PDF-` either way.

### Still El Segundo, and the answer already exists

The RENDERER is portable — columns, headers, hierarchy and filter values all
come from the feed, and everything added here is registry-driven. `all-users` is
the proof: a non-aquatics report on the same page with no page change, and card
21715 takes `org_id` and nothing else.

**The CARDS are not.** Card 21682's `aquatic_sites` CTE names El Segundo's three
locations literally, and 21684/21685 partition on their GL codes. **Card 1 does
not dodge the courts-as-lanes problem, it hardcodes past it** — it never filters
on site type at all, so it picks up their court-typed lanes by accident of the
location list. The replacement is `aquaticsScope`, already built for the
Facilities Aquatics tab and already the org's own answer to *which sites count
as aquatic*; the cards do not read it.

## EXPORTS MUST RESPECT THE FILTERS (STANDING RULE, Dan 2026-09-09)

Dan, after the rental schedule's PDF printed phone numbers the reader had
switched off: *"any time we make an adjustment to a filter, that it needs to be
picked up by an export/pdf/excel, whatever. exports need to respect filters."*

**So: a filter, toggle, column picker or chip is not finished when the screen is
right. It is finished when the PDF, the print view, Excel, CSV and the emailed
copy all show the same thing the reader is looking at.** An export quietly
carrying rows or columns somebody excluded is worse than one that fails, because
it looks correct.

### A PARAMETER HAS FOUR GATES, AND PASSING THREE LOOKS EXACTLY LIKE WORKING

This is the shape every instance has taken. Three of the gates are on the client
and one is on the server, so the screen and the browser's own Print can both be
perfect while the server-rendered PDF is wrong:

| gate | where | what it costs to miss |
|---|---|---|
| `getParams()`'s explicit whitelist | the page | the deep link silently does nothing — the value reads `undefined` |
| the page's own state / `currentFilterParams` | the page | the share link and the export params drop it |
| the page's export paths (`downloadExcel`, `downloadCsv`, the print branch) | the page | the file carries what the screen excluded |
| **`generatePdf`'s forward list** | **server.js** | **the PDF and the emailed PDF carry it, and nothing on the client can tell** |

**Recorded instances: `gl_codes`, `refunds`, and `pii`.** All three cleared the
client gates and failed the server one. The third happened while its author was
reading the comment describing the first two.

### CLIENT-SIDE AND SERVER-SIDE EXPORTS FAIL DIFFERENTLY

Know which kind you are touching before you reason about it:

- **Client-side — Excel, CSV, the browser's Print.** These read component state
  directly, so they are right the moment the screen is. What breaks here is a
  handler reading the UNSCOPED rows (`rows` instead of `filteredRows`) — already
  recorded for the Programs Excel export and the Aquatics sheets.
- **Server-side — the Puppeteer PDF, and the emailed PDF.** These re-render the
  page under `?_print=1` **with an empty localStorage**, in a browser that has
  never seen the reader's session. **The URL is the only channel.** A preference
  kept only in storage cannot reach them, whatever it looks like on screen.

### THE EMPTY VALUE IS THE ONE THAT BREAKS

`generatePdf`'s forward list is a `forEach` testing `if (filters[k])`. That is
right for every parameter whose empty value is meaningless — and **wrong for any
parameter that is a LIST**, because for a list the empty string is a real answer:
*"the reader excluded everything."*

`pii` shipped broken twice for this reason. Adding it to the truthy list fixes
the case where the columns are ON and leaves the OFF case — the reported bug —
untouched: the empty string is dropped, the print page finds no parameter, falls
back to its default, and prints what the reader hid. **A list parameter is
forwarded on PRESENCE:**

```js
if (filters.pii !== undefined) qsObj.pii = filters.pii;
```

Absent means *"the caller is not speaking about this"*; empty means *"none"*.
They are different answers and the page reads them differently.

### THE GUARD HAS TO CROSS THE BOUNDARY THE BUG CROSSES

`ci-check-render.js` drives the PAGE. A case at `?_print=1&<param>=` proves the
page READS the parameter and says nothing about whether the server SENDS it —
which is why five green render cases sat over a broken PDF. **Lift and run
`generatePdf`'s own query builder** (`facility-addons-forms.spec.js` does this:
slice from `const qsObj = {` to the `URLSearchParams` line and `new Function` it)
so the assertion is about the URL that actually gets built.

And mutation-test the *plausible* fix, not only the absence: folding a list
parameter into the truthy loop passes every populated-value assertion and fails
only on empty.

### THE CHECKLIST

When adding or changing any filter:

1. Is it in `getParams()`'s whitelist?
2. Does the share link carry it — and is every name in that effect's dependency
   array declared ABOVE the effect? (Babel turns `const` into `var`, so a name
   read early is `undefined` in the deps rather than a throw, and the effect then
   only runs on mount.)
3. Do Excel and CSV read the SCOPED rows?
4. Is it in `generatePdf`'s forward list — and if it is a list, forwarded on
   presence rather than truthiness?
5. Does a render case drive the real `?_print=1` URL, and a spec assert the
   server's forwarding?
6. If it persists per browser, is the persist gated so a shared link cannot
   rewrite the reader's own default?

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
class or the whole view), `ft-export` (📤 the people who fast-tracked one section were exported,
with the section, the head count and the hold count), `wizard-feedback` (🗓️ the rental calendar's site-type suggestion was rated,
naming the site type — **11 ratings were recorded and never posted before
2026-09-03**), and three platform alerts —
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

## SAVING A CARD BREAKS EVERY REPORT ON IT FOR AN HOUR (2026-09-01, fixed)

Dan, on El Segundo's Waitlist report: *"hmm, missing a route somewhere?"* — a
screenshot reading **"Server returned 400"**. Not a route, not El Segundo, and
not that branch: **the Waitlist report was down for EVERY org on production**,
and my card 19273 push is what did it.

Metabase's public card endpoint binds a supplied parameter by the card's own
registered **`id`** (the 2026-08-09 incident recorded above). server.js resolves
those ids from each card's public definition and caches them **one hour** per
card in `_cardParamMeta`. **Saving a card in Metabase REGENERATES the ids** —
which is the routine end of every card change here, the date-tag flip a
programmatic push always needs included.

Measured that evening from the production logs: prewarm warmed **15 orgs** off
card 19273 at **22:10**, the card was re-saved minutes later, and from 22:28
onwards every live request came back

```
HTTP 400 {"error_type":"missing-required-parameter",
          "error":"Cannot run the query: missing required parameters: #{\"org_id\"}"}
```

while a hand-built request carrying the **current** id answered in full. Bisected
to the id, not the value: right id → 200 and rows; wrong id + right target →
that exact error, byte for byte.

**IT SELF-HEALS ON THE TTL, WHICH IS THE WORST SHAPE A BUG CAN HAVE** — long
enough to be reported, gone before anyone looks. And it only bites on a
**required** tag: a tag that is not required still substitutes by target, so the
same staleness passes unnoticed on most cards and surfaces at random, months
apart, on whichever card happens to have one.

**Why every other report was fine at the same moment.** Their ids had not
changed, so a stale entry was still a correct one. Roster, memberships and
programs all served normally throughout — which is exactly why this reads as an
org problem or a route problem when it is neither. *A report that is down for one
org and healthy for another is not evidence about that org*: check a second org
on the same report before believing it.

**The fix is in the fetch wrapper, so it covers all ~17 call sites.** A 400 whose
body names a missing required parameter is treated as evidence about the CACHE,
not the card: drop the entry, re-resolve, retry once. Two guards keep it from
becoming a load source — a re-resolution yielding the **same** url means the card
genuinely is refusing (one query, not two), and an **unstamped** url means the
definition read just failed, which is a query whose answer we already know. And
it is gated on 400 alone: a 404 is a card that is gone, a 5xx is Metabase, and a
statement timeout is a heavy card that must never be asked twice.

**A diagnosis note worth keeping:** the `[proxy]` log line prints the URL
**before** the wrapper stamps it, so an id-less URL in the logs is expected and
proves nothing. Read `[mb-params]` lines instead.

Guard: `scripts/mb-param-ids.spec.js` (**19 assertions, in CI**), which LIFTS AND
RUNS the real wrapper against a fake Metabase rather than regexing it.
Mutation-tested six ways, all failing by name: no retry at all (the bug as it
shipped), a retry on any 400 (the heavy card queried twice), either guard
dropped, the cache never invalidated, and the gate on the wrong status.

**One mutation survived the first draft**, and the reason is the usual one: the
timeout case ran with a FRESH cache, so a body-blind retry re-resolved to the
same url and the same-ids guard rescued it. The fixture now seeds a stale id as
well, which is the only shape where the body test is load-bearing. *Plausible is
not the same as discriminating.*

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

**RUN THE SWEEP ALONE, or it invents failures on cards you never touched.**
Measured 2026-09-01: a full manifest run made concurrently with one heavy apex
probe reported `facilities-summary / apex` TIMEOUT at 120s and
`facilities-summary / douglas-county-nv` TIMEOUT at 60s — card 19570, untouched by
that branch. Re-run alone minutes later: **833 rows in 11.3s and 4,392 rows in
31.1s**, both FASTER than their recorded baselines (15.5s and 74.8s). So the two
red rows were entirely self-inflicted contention. This is the local-server timing
caveat below with a second cause: it is not just `node server.js` prewarming ~28
orgs, it is any other query you have in flight. Before reading a TIMEOUT here as
a regression, re-run that row on its own — and never report one as a finding
without doing so.

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

## THE DOCS DESCRIBED A DIFFERENT PLATFORM (2026-09-06)

Dan: *"update the 'how it works' doc and image files to reflect all our changes,
they are substantial."*

Three surfaces, and the **image file is an inline SVG** — the architecture
diagram inside the admin dashboard's *How This Works* section. There are no
`.png`/`.svg` files in the repo at all, which is worth knowing before going
looking for them.

### What was actually wrong

* **The architecture diagram had no App State Store.** Its DATA LAYER row showed
  Metabase, the rec.us database and external services — the app's own Postgres,
  the thing that made today's flip possible, was simply absent. It also still
  described a single instance. Now four boxes, with the store highlighted, and
  the app row reads *"2 replicas, rolling deploys (no volume)"*. Stale counts
  fixed from measurement, not memory: **41** report HTML files (said 15),
  **13** shared cards (said 12), and *"96k events in Postgres"* where it said
  `events.jsonl` — a file that no longer receives events in `db` mode.
* **A FACTUAL ERROR IN THE SECURITY SECTION.** It claimed *"CSV exports are
  disabled; data requests route through a Partner Support modal"* — reversed on
  2026-09-03, and that modal is deleted. The page was telling readers the
  opposite of what the platform does. It now says exports are enabled behind the
  token and **every one is logged to Slack with its segment and row count**,
  which is the thing that actually pays for them.
* **The README described a different product**: one org, one card, *"stateless,
  all data comes fresh from Metabase on each request"*. It is 29 orgs, 23 report
  types, a 4-hour cache and a shared Postgres store. It also carried a **copy of
  the Dockerfile without the emoji font**, i.e. an example that reproduces the
  bug fixed hours earlier.
* **`docs/CONTEXT.md` was a second doc claiming to hold current state**, and had
  drifted furthest of all: `server.js` as *"~3043 lines"* (it is ~20,000), a June
  2026 commit named as HEAD, and *"BLOCKS Railway + rec.metabaseapp.com → cannot
  verify the live deployed site"* — **which is false**, and this file already
  records that believing it meant skipping live verification more than once.

### THE FIX FOR CONTEXT.md IS THE ONE WORTH GENERALISING

It is a **signpost now, not a record**: it points at CLAUDE.md and keeps only
what does not change week to week (where things live, the traps that recur, what
each check is blind to). **Two documents both claiming to hold current state is
how one of them starts lying** — the same argument as one reducer with N
readers, applied to prose. It says at the top that it used to be the other kind,
and why.

### The `pkill` trap, third instance

`pkill -f "[c]i-check-render"` to stop a stale render run **killed this session's
own harness** — every later command exited 144 with no output, which reads
exactly like the thing being killed having crashed. The bracket trick did not
save it. Already recorded twice in this file for `server.js` sweeps; now written
into `docs/CONTEXT.md` as a working constraint, since that is where someone will
look before starting.

## THE PROGRESS BAR LOOKED FINISHED WHILE THE REPORT RAN (2026-09-06)

Dan, on a Community Intelligence load still going at 40s: *"this one is pretty
bad."* The bar was drawn at **98.4%** — indistinguishable from full. That is the
failure the bar was built to prevent, shipped inside the thing built to prevent
it. Reproduced by RUNNING the curve, not reading it.

* **The default was 12s.** The real misses recorded that afternoon ran 1.6s,
  2.4s, 8.6s, 13.4s, **25.4s** and **41.1s**, so an unknown report burned its
  budget in seconds. Now **25s**, on both sides.
* **The tail closed far too fast.** 92% AT the estimate, then the last 8% over
  the whole rest of the wait — but **92% and 99% look the same**, so the entire
  overrun regime read as "done and stuck". *"Under 100" was never the real
  requirement: it has to LOOK unfinished.* Now 80% at the estimate, halving the
  remaining gap every TWO estimate-lengths, ceiling 95.
* **On the `default` basis it never said "still working"** — the case with the
  least trustworthy estimate was the only one that said nothing while filling up.

### THEN WARMING IT ON PRODUCTION FOUND THREE MORE

Dan: *"do a pass through a few reports to build a historical record… don't nuke
the db."* 24 read-only probes (8 org/report pairs × 3 windows, sequential,
paced). All answered; `clarksville/facility` graduated to `basis: org`. Reading
the results back is what exposed the rest:

* **THE PER-REPLICA MEMO WAS NEVER REFRESHED.** `clarksville/gl`, probed just as
  often as `facility`, was still on the default: samples landed on whichever
  replica served each request, and the other kept answering from the empty
  snapshot it memoised at boot. Neither reached the 3-sample floor, and roughly
  half of all reads served a stale view. Worse, each flush wrote its WHOLE map,
  so one replica clobbered the other's samples. The flush is a read-modify-write
  now, with this replica's unflushed samples tracked separately in `_loadNew`.
* **THE POOLED FALLBACK WAS THE BIGGEST ORG'S NUMBER.** It took the p80 of a
  cross-org mixture: pooled `facility` p80 was **95.9s**, which told Pawnee
  *"usually about 96s"* for a report that takes about 3s there. Pooled uses the
  **median** now — the typical org, which is the most it can honestly claim
  about one it has never timed. An org's OWN history still uses the p80.
* **SEVEN REPORT PAGES INJECTED NO `ORG_CONFIG` AT ALL** — memberships,
  fasttrack, waitlist, products, qoq, historic, ice-calendar — so the bar on
  them could never have an estimate. `loadEstimateInject` adds ONLY
  `loadEstimate`, merged onto whatever exists: a full config would hand those
  pages fields they have never had. The spec derives the route list from
  server.js, so a new raw-send page fails instead of being quietly missed.

**And the last minute of history did not survive a deploy** (Dan: *"ensure these
reports persist past a redeployment, otherwise that's stupid"*). Samples batch on
a 60s timer, so SIGTERM discarded up to a minute and a container cycling often
kept none. `shutdown()` flushes them BEFORE `stateStore.close()` — `writeJSON`
only enqueues, and `close()` drains.

**`samples: 0` WAS HARDCODED on the default branch**, so the field reported 0
whatever was stored — which made *"is anything being recorded?"*, the first
question ever asked of it, unanswerable. Generalise it: a diagnostic field that
is constant on one branch is not a diagnostic.

### The favicon was never declared, only guessed

Dan: *"we seem to have lost our favicon?"* The ROUTES were fine — `/favicon.ico`
and `/favicon.png` both serve the rec.us mark. **No report page had ever declared
one**: the only `rel="icon"` in the app was on the maintenance page, so every tab
relied on the browser guessing `/favicon.ico` at the root. It rides the one
middleware every HTML response already passes through, and a page that declares
its own icon keeps it.

### Guards

`report-loader.spec.js` 30 → **44 assertions**. The new ones are about how the
bar LOOKS — at the estimate, at 3x, at an absurd overrun — not merely that it
stays under 100; reverting to the exact shipped shape fails all three by name.
Mutation-tested eight further ways, all caught: the memo frozen at boot, the
pending samples untracked, the pooled fallback back to p80, a report route
losing its injection, and the shutdown flush removed. Plus a render case for the
favicon, mutation-tested by removing the injection.

## THE JUICE ANIMATION IS RETIRED, FOR A PROGRESS BAR (2026-09-06)

Dan: *"I think it's time to retire it across all the reports, just seems not as
professional now that we're pretty robust… With the juicing animation, I was
getting feedback that it was taking forever and no one had any idea how long it
would actually take. Someone is more willing to wait for a progress bar than a
forever spinner."*

`public/report-loader.js` replaces `public/juice-loader.js`, which is **deleted**.
**18 pages** now share one loading state.

### IT WAS NEVER ONE ANIMATION — twelve pages each had their own copy

`juice-loader.js` existed and only **8 pages used it**. Twelve others carried a
hand-pasted duplicate of the glass CSS and the five `<span>` phrases inline, and
the big report pages — facility, gl, memberships, roster, users — had **no body
loader at all**, just a button spinner. So "make it consistent" was most of the
work, and it is the copy-paste drift this file keeps recording.

Two things fell out of doing it:

* **`.juice-loader` had no CSS anywhere.** Fast Track's three tab loaders
  rendered an **empty div** above their caption — a spinner nobody has ever
  seen, on the tabs Dan looks at most.
* **A few blocks smuggled a REAL phrase in among the jokes** — *"Counting
  renewals…"*, *"Adding up the months…"*, *"Counting check-ins…"*. Those are now
  the loader's `label`; they were the only part of the animation that told a
  reader anything.

### THE ESTIMATE IS MEASURED, and only cache MISSES count

`recordLoadTiming` hangs off `logRequest`, the single funnel every feed already
passes through. It keeps the last 20 durations per `org|report`.

**Only misses.** A hit returns in ~200ms and a miss can take 60s+, so a median
over both together describes neither — it just tracks the hit rate. Fold hits in
and the bar finishes in two seconds and then sits at 99% for a minute, which is
*exactly* the feeling being replaced.

**IT HAD TO BE DURABLE AND SHARED, and that is new today.** `REQUEST_LOG` is in
memory, so it empties on every deploy — and since `numReplicas` went to 2 each
container sees only the half of the traffic that landed on it. Proven while
building this: the production request log held **5 entries**. It goes through
the store instead.

**The estimate is the 80th percentile, NOT the median.** The two failure modes
are not symmetric: a bar that finishes early snaps to 100% and reads as fast,
while one that runs out of estimate stalls near the end and reads as broken. It
would rather be too slow than too fast.

**Three steps, each a weaker claim, and it says which answered.** This org's own
history → everyone's history for this **report type** → a flat default.
`basis` travels with the number so the client knows how much to trust it, and on
`default` the loader **prints no estimate at all** — a guess dressed up as
*"about 30s"* is a promise we cannot keep.

**Three samples minimum.** One unlucky 90s run must not become every future
reader's estimate.

Injected into `ORG_CONFIG`, so the bar has its scale **on first paint** — a
separate endpoint would mean drawing before it knew its own scale, i.e. the
guessing this replaces. All **13** injection sites go through `orgConfigInject`
now.

### THE BAR MAY NEVER REACH 100%, and the float nearly broke that

Under the estimate it eases toward 92%; past it, each further estimate-length
halves the remaining gap. **A bar that fills and then sits there is worse than no
bar** — it has told the reader something they can see is false.

**`1 - 0.5^over` UNDERFLOWS TO EXACTLY 0** once `over` passes ~1000, so on a
genuinely long wait the never-reaches-100 curve reached 100. Hence
`CAP_ABSOLUTE = 99.5`. **Found by running the function over a sweep of elapsed
times, not by reading it** — which is the whole argument for lifting these to
module scope.

### A FAST LOAD MUST SHOW NOTHING

A warm cache answers in ~200ms. Flashing a bar for a fifth of a second reads as a
glitch and makes a fast report *feel* slow, so nothing renders for the first
**350ms**.

### The traps this hit

* **NINE PAGES WOULD HAVE SERVED A BLANK BODY.** They referenced
  `<ReportLoader>` after the rename and did not load the script — a
  ReferenceError, React unmounts, 200 with nothing in it. The blank-page class
  this repo has shipped twice. The spec now fails if any page uses the component
  without the script.
* **`const LOAD_TIMING_FILE = path.join(DATA_DIR, …)` was a temporal dead
  zone** — `DATA_DIR` is declared ~1,900 lines below it. `node --check` passed
  and the server died at boot with *"Cannot access 'DATA_DIR' before
  initialization"*. **The render check caught it**, which is exactly what it is
  for. It is a function now.
* **`html.replace("<head>", <string>)` expands `$&` and `$1`.** The injected
  payload is JSON that can legitimately contain them (a display name, a token),
  and one `"$&"` would have spliced the matched tag into the middle of the
  script. Every replacement is a **function** now. Pre-existing; fixed while
  touching the line.

### Guards

`scripts/report-loader.spec.js` (**30 assertions, in CI**), which LIFTS AND RUNS
both the progress curve and the three-step fallback. Mutation-tested nine ways,
all failing by name: the 100% cap removed (the float bug), the bar stalling
instead of creeping, a default estimate worded as a promise, cache hits recorded,
the estimate reverted to the median, the org branch disabled, the pooled fallback
ignoring the report type, and the single-sample floor removed.

**Two of those survived the first draft and were fixed in the SPEC, not the
mutation** — and both for the same reason, which is worth generalising:

* The org-vs-pooled assertion tested **text order** (`basis: "org"` appears
  before `basis: "report"`), and a mutation that disabled the org branch
  entirely left the order intact. *An assertion about where code sits is not an
  assertion about what it does.*
* The pooled fixture had 3 fast `gl` samples against 3 slow `programs` ones, so
  a pool that ignored the report type still landed on a plausible number. It is
  **20 against 3** now: the wrong answer has to be unmistakable, not merely
  possible.

Plus **four `ci-check-render.js` cases**, and the harness gained a per-case
**`stubDelayMs`**: every stub answers instantly, so the 350ms threshold is never
crossed and a "loader renders" case could only ever pass having never seen a
loader.

**THE FAST-LOAD CASE COULD NOT SEE A FLASH, which is the whole thing it tests.**
By the time the data arrives the loader has unmounted, so `[data-rl]` is absent
whether or not it appeared for 200ms on the way — and the first draft passed with
the threshold deleted. It installs a poll **before navigation** and asserts the
bar was *never present at any point*. (A `MutationObserver` cannot be used there:
`evaluateOnNewDocument` runs before the document exists, so `documentElement` is
null and `observe()` throws.) Both browser-only mutations — the threshold removed
and a static bar — were then verified to fail by name.

## EVERY EMOJI IN EVERY PDF WAS A TOFU BOX (2026-09-06)

Dan, on Pawnee's rental schedule PDF: *"look at the last few columns, things
aren't rendering properly"* — Forms, Paid?, Permit and Rec-link all drawing ▯,
and the add-on note lines too.

**The Dockerfile installed `fonts-liberation` and no emoji font.** Liberation
covers Latin text and has **zero** emoji coverage, so Chromium had no glyph for
any emoji and drew the missing-character box. One line:
`fonts-noto-color-emoji`.

### IT IS INVISIBLE EVERYWHERE EXCEPT THE PDF, which is why nothing caught it

A laptop, this sandbox and GitHub's runners all ship an emoji font, so the page
is correct in a browser and in all 268 render cases. **The Puppeteer PDFs are
the one surface where the CONTAINER's own fonts are what render** — the report
pages are drawn by the reader's browser, the PDFs by ours.

**The blast radius was everything, not one report:** the rental schedule's four
icon columns plus its 💡 lit and 📝 instruction note lines, the Director's Report
flames, the QBR, the permit posting sheets. **60 distinct emoji** across the
PDF-rendered files.

### REPRODUCED BEFORE FIXING, because "it must be the font" is a guess

Rendered the exact glyph set twice under `FONTCONFIG_FILE`: Liberation alone
gives boxes, Liberation + Noto Color Emoji gives the icons, and the ASCII line
beside them is identical in both — which is what rules out a markup or encoding
fault.

### THE BUILDER FIELD LIES, and it nearly sent me to the wrong file

`get-service-config` reports `builder: RAILPACK`, which would mean the Dockerfile
is not used at all and editing it does nothing. **The build log settles it:**
`[internal] load build definition from Dockerfile`, followed by the exact
`apt-get` line. Railway prefers a Dockerfile when one is present, whatever the
configured builder says. **Read the build log, not the service config, before
deciding which file builds the image.**

### The guard, and why the obvious one is worthless

A spec that renders emoji and checks they look right **passes on the broken
build**, because the machine running CI has an emoji font. So
`scripts/pdf-fonts.spec.js` (**5 assertions, in CI**) builds its font
environment *from the Dockerfile*: it copies in Liberation, and copies the emoji
font in **only if the Dockerfile asked for one**, then renders the glyph set both
ways and requires the two images to **DIFFER**. Remove the package and both
renders are tofu, the images match, and it fails.

- **The glyphs are read out of the source**, not transcribed — a hardcoded list
  goes stale the first time a column gains an icon, and the guard then silently
  stops covering the thing that broke.
- **It asserts the glyph set is non-empty**, or the font assertion is vacuous.
- **It also requires the emoji render to carry MORE image data**, so a build that
  rendered nothing at all in both cannot pass the difference test for the wrong
  reason.
- **It SKIPS with a message** without puppeteer or the font files, rather than
  passing.

Mutation-tested two ways, both failing by name: the emoji font removed (the bug
exactly as it shipped) and swapped for `fonts-dejavu-core` — a plausible-looking
font package with no emoji coverage.

## TWO REPLICAS EACH WARMED THE WHOLE PLATFORM (2026-09-06)

Found in the systems check straight after the volume was deleted and
`numReplicas` went to 2, and it is the bill that arrived with the thing that
removed the downtime: **the step that stopped deploys being an outage doubled
the prewarm load on the read replica.**

Dan, minutes later, on Pawnee's rental schedule: *"this facility rental report is
struggling right now"* — every Forms / Permit cell showing the amber ⚠. That is
the presence gate working (⚠ is *"the feed did not answer"*, deliberately not the
blank that means *"no permit on this rental"*), and the cards behind it answered
fine on a clean probe minutes later. **The load was mostly MINE** — I was running
a feed sweep (apex/programs twice at 130s, watertown 50s, clarksville 25s)
against production Metabase while he had the report open. That is the
*run-the-sweep-alone* rule in this file, which I have now broken after writing it
down twice. But the doubling below is real and was the other half.

### THE USER-FACING HALF WAS ALREADY FINE, and I reported it wrong first

I told Dan the cache hit rate would roughly halve. **It would not**, and the
reason is worth keeping because it is the shape the rest of the fix copies:
`getDiskCached` — the L2 on the data route's miss path — already asks
`stateStore.cacheGet` before Metabase. So a request landing on the replica that
did not warm a key gets it from Postgres, not from a cold card. That was built
with the store and it works.

**The gap was everything that asks "is this already warm?" SYNCHRONOUSLY**, which
means it can only read this container's own memory.

### `getCached` IS PER CONTAINER, AND PREWARM IS THE CALLER THAT MATTERS

`prewarmCache` tests `if (getCached(cacheKey)) continue;` in four places (prior
month, base, default window, facilities). With one instance that was the whole
truth. With two, each replica warmed **every key independently** — the same ~84
cards fetched twice, four times an hour.

Note the 4:50am cron **is** leader-locked (`leaderCron("prewarm", …)`); the
15-minute `setInterval` never was, and locking it would have been the wrong fix —
it would leave the other replica permanently cold.

**`stateStore.cacheFreshKeys()` is KEYS ONLY, and that is the design.** The
obvious shape is to poll `feed_cache` for changed rows the way `pollKv` polls
config — and it is wrong here, because a feed payload is not a config blob:
**norman/memberships alone is 16.8 MB**. Speculatively moving that every few
seconds to answer a question prewarm asks four times an hour is enormous traffic
for nothing. The payload is still fetched lazily on a real miss, through
`cacheGet`.

- **One query per CYCLE, not per key.** 84 round trips to answer one question is
  its own small stampede.
- **It returns NULL, never an empty Set, when it cannot answer** — disk mode, or
  a failed query. *"The store could not tell us"* and *"nothing is warm"* are
  different facts, and the empty Set reads as the second: prewarm would re-fetch
  the platform's entire warm set from Metabase on every cycle, silently, because
  the fallback is exactly the old behaviour and nothing looks broken. Same rule
  as `hasAbsent` / `ciHasStatus`. **That mutation SURVIVED the first draft** —
  the spec had no case that provoked a live query failure, so it now drops
  `feed_cache` out from under the store (`_query`, a test seam that exists for
  this alone).
- **Memory is tested first**, because it is free and it is the only one of the
  two that reflects a write this container made since the snapshot.
- `expires_at` is the sweeper's column and explicitly **not** the readers' TTL —
  but it is the right test here, because prewarm's job is to refresh a key
  *before* it expires, and it is what `setCache` wrote from `ttlForKey`.

### THE FACILITIES HUB ROUTE HAD NO L2 AT ALL

Pre-existing, and 2 replicas is what made it bite. Every other feed falls through
to the shared store before Metabase; `/:org/facilities/api/summary` went from a
memory miss **straight to a card that sits at 60-120s cold**. On one instance the
only way to miss memory was an eviction. With two it is routine — whichever
replica did not warm the key paid the full cold query for a payload already
sitting in Postgres. It is the most-fetched card on the platform (~174 pulls/30d
across 13 orgs), so it is the miss that matters most.

### `getStaleCached` IS ASYNC NOW, and it is weakest exactly where it matters

It is the *"Metabase is down"* net, and it read memory alone. So at the one
moment its entry cannot be re-fetched by anybody, it could only see what **this**
replica had warmed or served since boot — half the platform's warm entries were
invisible to it.

- **No TTL test on the store read**, deliberately: this function exists to return
  something past its TTL, and applying one would reinstate the 502 it prevents.
- **Every one of the four call sites is inside an async handler and awaits it.**
  A missed `await` is silent and bad — `if (stale)` on a pending Promise is
  always true, so the route answers **200 with a Promise where the rows should
  be**. The spec counts `await getStaleCached(` against `getStaleCached(` rather
  than testing for one of them, which is what fails when a fifth caller is added
  without an await.

### `migrateDynamicOrgs` PUSHES A COMMIT TO `main`, AND WAS NOT LOCKED

The one boot task reaching outside the process that had no leader lock. Two
replicas booting together race to push the same org entries — at best a duplicate
commit, at worst **two deploys triggered by a restart**, since a push to `main`
is a deploy. Locked now, failing open like every other lock here.

Inert today for an unrelated reason worth knowing: it logs
`[migrate] Failed: Could not locate ORGS map closing in server.js` on both
replicas and fails safe (the 9 dynamic orgs load from `orgs.json` regardless).
Pre-existing; not fixed here.

### `/api/admin/store` NAMES THE REPLICA NOW

With `numReplicas > 1` the load balancer picks one per request, so *"is this a
cold-replica problem?"* was only answerable by inference — hitting the endpoint
repeatedly and watching a count wobble, which is literally how two replicas were
confirmed serving. `replica` (from `RAILWAY_REPLICA_ID`, pid as the fallback) and
`memoryCacheEntries` say it outright: a large gap between this replica's memory
and the platform's warm set is the shape of the bug this section exists to
prevent.

### On Datadog (Dan asked)

**Overkill, and it would measure the wrong thing.** What breaks here is Metabase
card latency, and the health check already classifies slow-vs-broken, alerts only
after two consecutive rounds, and gates on whether anyone uses the report.
Datadog says *"p99 is high"*; the health check says *"card 20626 cannot answer
because a column is gone."* The genuinely missing piece was per-replica
visibility, which is the `replica` field above and cost ten minutes. Revisit when
there are several services and traces need to cross them.

### Card 20626 does NOT scan every org — asked and answered

Dan, on a spinning Metabase tab: *"what can we do to stop MB from scanning all
forms across all orgs on that report load"*, and then *"would enabling [Always
require a value] help?"*

**It cannot scan all orgs.** The SQL is `fsl.organization_id = {{org_id}}::uuid`
— a **bare tag, not inside `[[ ]]`** — so the filter can never drop out. A blank
value substitutes `''::uuid` and errors immediately.

**So "Always require a value" buys nothing and costs something.** Flipping it
changes the card's registered parameters, and a *required* Metabase parameter is
exactly what caused the hour-long outage on 2026-09-01 (`missing-required-parameter`
400s for every org, because `_cardParamMeta` caches ids for an hour and a card
save regenerates them). `mb-param-ids` retries that now, but it is real risk for
zero gain. **Generalise it: check whether the SQL already makes a variable
mandatory before reaching for the UI toggle that says it is.**

### Guards

`store.spec.js` 49 → **57 assertions**, `store-live.spec.js` 56 → **64**.
Mutation-tested ten ways, all failing by name: expired keys reported warm,
`cacheFreshKeys` failing to an empty Set (twice — disk mode and a live query
failure), the function returning whole rows instead of keys, prewarm reverted to
memory-only (the bug as it shipped), **one** of the four warm checks left on
`getCached`, the facilities L2 removed, the stale fallback no longer asking the
store, a `getStaleCached` call losing its `await`, and the org migration
unlocked.

The cross-replica assertions are **`[source]`-labelled rather than dressed up**:
proving them behaviourally needs a second container plus a Metabase stub this
harness does not have. The unit spec proves the store answers correctly; these
prove server.js asks. Each is **scoped to the function that must do the asking** —
a file-wide match passes on any other caller.

## THE FLIP, AS IT ACTUALLY WENT (2026-09-06)

Dan: *"ENGAGE"*. Production is on **`db` mode** — config, the event log and the
feed cache all served from Postgres. **Step 4 (delete the volume, `numReplicas:
2`) is NOT done**; it is one click in the Railway dashboard and everything is
verified ready for it.

| | |
|---|---|
| Postgres service | `83964e9e-19bc-48e3-ac23-f5d0cf6c8065`, `postgres-ssl:18`, own volume |
| config keys | **83** |
| events | **96,779** (CLAUDE.md's old "82k" figure was stale; it grows ~600/day) |
| feed cache | **1,725 report + 8 users** entries hydrated from the store |
| `failsafe` | **false**, 34 active report types, 0 inactive |

### IT COST A FIVE-MINUTE OUTAGE, and the defect was mine

Setting `dual` + `STORE_IMPORT=1` restarted the service. `storeBoot()` **awaited
`importFromDisk()` before `app.listen`**, so nothing listened while the import
copied 82k events one row at a time. The healthcheck (300s) never went green,
Railway killed the container — and because a volume forces stop-then-start, the
old one was already gone.

```
11:23:55  [store] STORE_IMPORT=1 — importing the volume…
11:30:33  [store] SIGTERM — draining          (deploy FAILED)
```

**I wrote `STORE_BOOT_TIMEOUT_MS` to stop boot hanging, raced `configure()` with
it, and then awaited a far slower operation OUTSIDE that race.** A guard that
covers the fast path and not the slow one is not a guard. Fixed four ways (PR
#198): the import runs after `listen`, it is refused in `db` mode, the event
insert batches 500 at a time, and the timeout now wraps the whole of `storeBoot`.

**That last one immediately earned its keep.** The `db`-mode boot logged
`boot exceeded 25000ms — listening anyway` while the cache hydrate took 85
seconds for 2,934 entries. Without the wrapping timeout that deploy would have
failed the healthcheck exactly like the first one.

### DUAL WAS NOT DUAL FOR EVENTS (PR #199)

Found in the boot log of the very next deploy: `appendEvent` returned
`usingDb()`, true for **both** dual and db — so in dual every event went to
Postgres and **not** to `events.jsonl`, while `readEvents` in dual still read
the VOLUME. Events were written where nothing read them and the authoritative
log silently stopped growing. It also broke the import's count-based resume,
which would have skipped the file's OLDEST 21 lines.

`appendEvent` takes the record in **db mode only** now. The db-mode mirror of
that case already existed and passed throughout — **the two modes make opposite
claims and only one was being checked**, which is why the dual case had to exist
separately.

### `dashboardAuth` GUARDS ONLY `/`

Caught on the PR preview: `/api/admin/store` answered **200 with no
credentials** while `/` correctly 401'd, because `dashboardAuth` opens with
`if (req.path !== '/') return next();`. Passing it as route middleware protects
nothing. Both store routes check the password by hand now and FAIL CLOSED.
**Generalise it: check what a shared auth helper actually guards before reusing
it.**

### HOW "NOTHING WAS LOST" WAS PROVEN, not asserted

In `db` mode a key Postgres lacks **falls through to disk** — so anything the
import missed works today and breaks the moment the volume goes. The test is a
full re-import in db mode watching the key count: **`keys` stayed at 83 for six
minutes**, so the volume holds nothing Postgres does not.

Events were cross-checked a second way: the 45-day count read from the FILE in
dual (56,304) against POSTGRES in db (56,294) agree within ~10 over 20 minutes
of window slide — not 2x (no duplication), not a fraction (no truncation).

**The six announcement images were downloaded before anything was deleted.**
They are the one thing the migration does not carry, and they would have been
gone for good.

### THE IMPORT'S SLOW PART IS THE CACHE

Both import calls timed out at Railway's edge (153s, then 300s) — the work
continued server-side and the counts prove it, but the response never arrived.
The config and event passes are seconds; the **cache** re-sends every payload
over the wire on every call even though the upsert then does nothing. A top-up
run can now pass `{"cache": false}`. Kept ON by default, because the first
import wants it.

### Traps worth keeping

- **`A || B && C && D` groups as `((A || B) && C) && D`.** A `git rebase ... ||
  git stash && git reset --hard` chain ran the reset unconditionally and
  discarded a working tree. Write the branches out.
- **Railway redacts variable values for an OAuth caller** — `DASHBOARD_PASSWORD`
  cannot be read, so admin-route calls have to come from Dan. Worth knowing
  before planning a verification that needs it.
- **"WAITING FOR CI" is not a wedged builder.** A deploy sat 35 minutes with no
  build logs and I called it wedged twice; Railway was correctly holding it
  behind the `render` check, which genuinely takes ~13 minutes. Read the deploy
  card's own status before diagnosing.
- **A merged PR's branch cannot take follow-up commits.** #198 squashed, so the
  branch still carried the pre-squash commit and #199 failed to merge on a
  conflict. Restart the branch from `main` and replay.

### WHAT IS LEFT

1. **Delete `rental-report-volume`** (Railway offers no detach — deletion is
   irreversible) and set **`numReplicas: 2`**. Scaling is not exposed by the
   Railway MCP tools, so both are dashboard actions.
2. **Rollback to disk mode ends at that click.** Today `dual` would fall back to
   a populated volume; afterwards `/data` is an empty container filesystem.
   Postgres is the system of record from then on, with the daily gist as the
   off-platform copy.
3. **Rotate `DASHBOARD_PASSWORD`** — it passed through the session transcript.
4. Re-upload the announcement images.

## SEAMLESS DEPLOYS — BUILT AND QUEUED, INERT UNTIL THE ENV SAYS SO (2026-09-05)

Dan: *"queue everything up so when I say 'engage' tomorrow AM, we flip to the new
DB model"*, with *"we have some wiggle room, no one is using this on a sunday
AM"*, and the longer arc: *"including the eventual flip to an API and semantic
layer model."*

**Runbook: `docs/DB-MIGRATION-RUNBOOK.md`.** Read that to perform the flip; this
section is why it is shaped the way it is.

### IT SHIPS DOING NOTHING, and that is the whole delivery strategy

With no `DATABASE_URL`/`STORE_DATABASE_URL` the server runs in `disk` mode, which
is byte-identical to the behaviour before `lib/store.js` existed. So this can
merge and deploy on any day, and the flip is a sequence of **environment**
changes — each one reversible without a code change:

| mode | writes | reads | rollback |
|---|---|---|---|
| `disk` | the volume | the volume | — (this is today) |
| `dual` | **both** | the volume | drop two env vars |
| `db` | both | **Postgres** | `STORE_MODE=dual` |

There is deliberately no fourth "Postgres only" mode. Dropping the disk write
buys nothing while the volume is mounted, and once it is detached those writes
land harmlessly on the container's own filesystem.

### THE SEAMS ALREADY EXISTED, which is why this is a swap and not a rewrite

| what was on the volume | the seam | call sites |
|---|---|---|
| ~30 config blobs | `readJSON` / `writeJSON` | 46 reads, 35 writes |
| `events.jsonl` (23 MB, ~600 lines/day) | `readEvents(daysBack)` | 18 readers |
| the feed cache | `getDiskCached` / `setCache` / `hydrate` | those three |
| Metabase (the *next* project) | `fetchMBDirect` | 21 |

**Both config seams are SYNCHRONOUS and Postgres is not**, and that constraint
shapes the whole module: reads come from an in-memory mirror loaded at boot,
writes update it synchronously and enqueue the upsert. The alternative was making
81 call sites async to move a few kilobytes of JSON.

About twenty raw `fs` sites bypassed `readJSON`/`writeJSON` and were routed
through it (campmap and rental-map positions, votes, update-votes, health, health
config, orgs, showcase, the QBR snapshots, the backup gist id). **Two stores
deliberately do NOT move:**

* **`cache-access.json` stays on disk** — a per-replica heuristic about which
  reports are worth holding resident in *this* container's memory. Two replicas
  each writing a full snapshot of their own access log into one row every five
  minutes would simply overwrite each other. What resets on a container swap is a
  residency preference, not warm data.
* **`announce-images/` stays on disk**, being binary. **Consequence, named in the
  runbook rather than discovered: images uploaded before the volume is detached
  will 404 afterwards.** It is the one piece of real data this does not carry.

### POSTGRES ONLY — reversing my own recommendation

I argued for Redis for the feed cache, on TTL support and vacuum churn. Costed
properly the churn is ~84 prewarmed keys rewritten six times a day, which is
nothing for autovacuum, and TTL is one timestamp column the readers already
compute. One service is one URL and one failure mode. Every cache read and write
goes through `cacheGet`/`cacheSet`/`cacheAll`, so Redis drops in there if it ever
earns its place.

### The decisions that are load-bearing

* **An unreachable database FALLS BACK to the volume** rather than failing the
  boot. The flip must be able to be a no-op, never an outage.
* **In `db` mode a key the mirror has never seen falls through to DISK**, not to
  the default. *"Postgres has no row"* and *"this org has no settings"* are
  different facts, and defaulting would silently reset every store the import
  missed. Same rule as `hasAbsent` / `ciHasStatus`.
* **`withLeaderLock` fails OPEN.** A duplicated prewarm is a wasted cycle; a
  database blip that silently stops the health check, the schema watchdog and the
  digest is a platform that has gone quiet with nobody told. Same asymmetry as
  the Slack production gate, and pinned for the same reason.
* **It takes a TRANSACTION-scoped advisory lock, not a session one.** `pg.Pool`
  hands out a different connection each time, so a session lock would be taken on
  one connection and unlocked on another — and the COMMIT is what releases it,
  which is why a client returned to the pool without one leaks the lock.
* **`appendEvent` does NOT push the record locally.** Pushing it and advancing
  the cursor is only safe while every insert is the very next id, which two
  replicas guarantee it is not — the next poll then hands the same record back
  and the log double-counts. Every event arrives by exactly one path (the poll),
  and the insert kicks that poll so the writer sees it in ~150 ms.
* **The store tracks ts ordering**, so `readEvents`'s binary search stays valid.
  Handing it an unsorted array would silently fall back to a linear filter over
  82k records, which is exactly what the byte-offset tail was added to avoid.
* **The import is idempotent** (`ON CONFLICT DO NOTHING`) because a flip gets
  retried, and it copies the **warm cache** too — an empty cache on a Sunday
  morning is ~28 orgs of cold card queries against production Metabase.
* **The cache sweeper is deliberately generous** (a week past expiry).
  `getStaleCached` serves expired entries when Metabase is down, so deleting at
  the TTL removes the safety net exactly when it is needed.
* **The daily gist backup follows the store.** In `db` mode the container's disk
  holds only what *this* replica wrote, so walking the directory would quietly
  start backing up a fraction of the platform's state — worse than a backup that
  is obviously broken.

### `dashboardAuth` GUARDS ONLY `/` — passing it as route middleware is decorative

Caught on the PR preview, not in review or by any spec: `/api/admin/store`
answered **200 with no credentials** while `/` correctly 401'd. The reason is one
line at the top of `dashboardAuth`:

```js
if (req.path !== '/') return next();
```

So it returns `next()` for every other path, and adding it to a route protects
nothing. The read leaks internal state and the POST beside it kicks off a full
import against the platform's config, so both are gated by hand now
(`adminPasswordOk`), accepting either the Basic header or an explicit password.

**IT FAILS CLOSED**, which is the opposite of `dashboardAuth`'s *"no password →
open access"*. That default is right for a root page in dev and wrong for these
two — and it is not hypothetical, because a PR preview is a fresh environment
where an unset `DASHBOARD_PASSWORD` is the normal case. Same call as
`reportSettingsAdminKey()`.

`lastError` is redacted on the way out even for an authenticated caller: a pg
failure message can carry the host and user it could not reach, and this response
is exactly the sort of thing that gets pasted into a chat mid-flip.

Generalise it: **check what a shared auth helper actually guards before reusing
it.** Three assertions cover this now — no password, wrong password, and a server
booted with no `DASHBOARD_PASSWORD` at all — and all three fail on the shipped
bug.

### A POLLED CHANGE HAS TO REACH MODULE-LEVEL STATE, and the spec found that

Most config is read on demand, so refreshing the mirror is enough. Four stores
are not: `orgs.json` is folded into a module-level `ORGS` object at boot, and the
three map-position blobs into `let`s. Without `onKeyChange` → `refreshCachedStores`
**an org added on replica A is "Unknown org" on replica B until B restarts** —
the same shape as the `town-of-shrewsbury` link that 404'd for five weeks.
Found by `store-live.spec.js`, not by review.

### Guards

`scripts/store.spec.js` (**49 assertions, in CI**) lifts and RUNS the module
against a real Postgres. `scripts/store-live.spec.js` (**40 assertions, in CI**)
boots `server.js` twice and drives the real routes — a different claim, and the
one that decides whether the flip works: that server.js reads *through* the store
rather than around it.

**Both SKIP their database half with a message when `STORE_TEST_URL` is unset,
rather than passing.** A spec that reports success without having connected is
the warm-cache sign-off this file already has a rule about. The disk half of
`store-live` still runs, because *"disk mode is unchanged"* is the claim that
matters on every PR.

Mutation-tested twenty ways in total, all failing by name — including the flush
clearing its queue before the upserts land, `flush()` not joining the run in
progress, the poll ignoring in-flight writes, `appendEvent` pushing locally, no
leader lock, the lock never released, `db` mode defaulting instead of falling
through, `dual` mode reading the database, an unreachable database not falling
back, the import walking `announce-images`, the import overwriting on a re-run, a
cache grace of zero falling back to seven days, events written to BOTH backends,
`readEvents` ignoring the store, a polled org never reaching `ORGS`, `storeBoot`
not re-reading config, `STORE_MODE=db` ignored, and a new container not
hydrating the shared cache.

**Two bugs in code I had already convinced myself was right**, both found by
writing the spec:

* `graceMs || DEFAULT` turned a deliberate grace of **zero** back into seven days.
* **`await flush()` returned immediately when a flush was already running** —
  which is the normal case, since `writeJSON` kicks one without awaiting it — so
  `close()` could end the pool mid-drain and lose whatever was queued when the
  container was told to stop. That is precisely the window this project exists to
  close.

**And the race test took three drafts.** A single replica writing in a burst
cannot discriminate: a replica's own upsert returns the rev it just wrote, so its
poll never fetches its own row back. Two replicas writing freely repairs the
divergence by accident on the next poll. It only reproduces when the poll's
SELECT is **issued first** and is still in flight as the write queues — so the
spec drives the poll by hand at that instant, with a pre-assertion that the other
replica's row really is committed, because without it the whole case passes
vacuously on a build that has the bug.

**Two live mutations survive by construction and are labelled as such**, rather
than dressed up: the cache WRITE path needs a Metabase stub this harness does not
have, and the SIGTERM drain cannot be timed over an HTTP round trip. Both are
pinned by the unit spec plus an explicitly-marked `[source]` assertion.

### Two pre-existing specs had to be taught about the change

* **`event-cache.spec.js` DIED instead of failing** — it slices `loadEventCache`
  out of server.js and evals it, and that function now asks the store first, so
  the slice threw a bare `ReferenceError: stateStore is not defined`. **Sixth
  instance of a slice reaching past its own inputs**, and the fourth where a
  guard dies instead of failing by name. It injects a declining stub now, so what
  it tests — the byte-offset tail — is unchanged.
* **`card-drift.spec.js` pinned the literal cron line**, so wrapping it in
  `leaderCron` broke an assertion with nothing about drift having changed. It
  matches on the two facts that matter (the time, and that it calls
  `checkCardParamTypes`) rather than on the wrapper.

### The import is named `stateStore`, not `store`

server.js already has two locals called `store` (the game-scores blob). A
shadowed module reference is the readability trap that only surfaces as a bug
months later, when someone adds `store.readsDb()` inside one of those blocks and
silently gets a leaderboard.

### NOT DONE, and the sequencing is the point

**Step 4 of the runbook — detaching the volume and raising `numReplicas` — is a
Railway change, not a code one, and has not been made.** Until it is, this is all
inert plumbing.

**The API + semantic layer flip is deliberately AFTER this**, for two measured
reasons rather than tidiness:

* Every table in the `materialized` schema has exactly one index, its primary
  key. Going direct today inherits the same seq scans **without** the 4-hour
  cache hiding them — the finding that killed the Report Wizard.
* A direct connection is only safe once the cache is SHARED. With two replicas
  and a per-container cache, every miss doubles.

Both are fixed by the steps above, which is what makes that flip cheaper
afterwards than it would be now. It sits behind `fetchMBDirect` (21 call sites)
and wants the same equivalence gate every card change here gets: FULL OUTER JOIN
old against new, zero row-level and field-level diffs, totals to the cent.

## The seamless-deploys diagnosis, as originally pinned (2026-09-04) — BUILT, see above

Dan: *"any way to get to a seamless style of deployment, where adding a new
feature or deploying didn't take down the whole reporting project?"* Then:
*"pin the seamless deploys, might tackle it this weekend."*

**Kept because what it RULED OUT is the useful part** — three things that look
like the cause and are not. The build is the section above.

**WHAT IS ALREADY FINE, so nobody re-does it:**

- **`healthcheckPath` is already `/healthz`** on the rental-report service, and
  `serverReady` flips the instant `app.listen` fires — so the gate goes green in
  a second or two and Railway's cutover is already health-gated.
- **The feed cache already SURVIVES a deploy.** `CACHE_DIR` is `DATA_DIR/cache`
  on the volume and `hydrateCacheFromDisk()` runs at boot. A push does not empty
  it — worth saying because the opposite was believed.
- **Prewarm is already paced.** `prewarmPace()` gives 3s gaps when Metabase is
  healthy, 12s when degraded, and **aborts the cycle** when unhealthy;
  `PREWARM_STARTUP_SKIP_MS` is 6h, so a restart inside that window skips the
  fan-out entirely.

**THE ACTUAL CAUSE IS ONE REPLICA PLUS A VOLUME.** Service config reads
`numReplicas: 1` and a volume at `/data`. **A Railway volume attaches to a single
instance**, so the old and new containers cannot run at once — the deploy is
stop-then-start by construction, and no health check can hide that gap.

So the order is: move the feed cache and `events.jsonl` off the disk (Postgres or
Redis), *then* raise replicas, *then* the deploy is seamless. Two traps on the
way: `events.jsonl` is read by the admin dashboard, the Slack digest,
`getReportActivity()` (which gates every watchdog alert) and
`/api/admin/feedback`, so moving it changes all four readers; and with 2+
replicas **prewarm would run once per replica** against production Metabase
unless it is leader-elected or moved to a cron service — which would double the
fan-out this is partly meant to avoid.

## A PUSH TO `main` IS AN OPERATIONAL EVENT, not just a code change (Dan, 2026-09-04)

Dan, after a **documentation-only** PR was merged into a project he had parked:
*"I'd planned to let that system sit and reload the cache, not push a MD file
out and disrupt everything."*

**The rule: while this project is parked, nothing goes to `main` — including a
CLAUDE.md-only change.** Park it on a branch and let it ride in with the next
change that has a reason to deploy. "It's only a markdown file" describes the
diff, not the deploy.

What a deploy actually does, read out of the code rather than assumed:

- The feed cache **survives** it. `CACHE_DIR` is `DATA_DIR/cache` on the Railway
  volume and `hydrateCacheFromDisk()` runs at boot, so a restart does not by
  itself empty it.
- `PREWARM_STARTUP_SKIP_MS` is **6 hours**: if a full warm cycle finished inside
  that window the restart serves the hydrated disk cache, and if it did not,
  boot fans out across ~28 orgs against production Metabase. That fan-out is the
  disruption — the same shape as the post-deploy prewarm storm that 502'd the
  facility Summary and got v2 rolled back (see that section).
- So the cost of a push is not "the cache is gone", it is **a restart that can
  trigger a prewarm storm, plus whatever was mid-flight**. Either way it is not
  free, and it is not the author's call to spend when someone has asked for the
  system to be left alone.

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

### What "FT Total" COUNTS — asked and settled (Dan, 2026-09-01)

Dan, on Essex Junction's Fall Vacation Camps: *"why is it 400+ FT's but only 23
people. Is that because 1 person can have multiple sessions/sections fast
tracked?"* — then, on the answer: *"i'm fine with seeing that higher number, it
makes sense."*

**Yes, and the multiplier is per-SESSION.** `FT Total` is
`COUNT(DISTINCT booking_id)`, and both sections are `registration_mode =
per-session` over **9 camp days**. Every one of the 456 FT rows is
`type = 'session'` carrying a session id — **zero** section-level holds — so one
child claiming 9 days is 9 bookings. That is the `Pending ×9` in the expander.

| section | FT holds | badge "people" | children | sessions | days per child |
|---|---|---|---|---|---|
| K-2nd Vacation Camp | 282 | 37 | **43** | 9 | 6.6 |
| 3rd-6th Vacation Camp | 174 | 23 | **26** | 9 | 6.7 |

**NOTHING WAS CHANGED — this is Dan's call, and the number stays as it reads.**
Written down because the question will be asked again and the measurement is
otherwise a re-derivation.

**One inaccuracy is knowingly left in place: the "N people" badge counts booking
ACCOUNTS, not children.** `ft_unique_users` is
`COUNT(DISTINCT customer_user_id)` — the parent who booked — so siblings collapse
into one. Essex Junction: 37 accounts hold 43 children (1.16 each), and the
expander shows the mechanism (*"Aislyn Allen · for Carter Allen"* is one account
with one child; a parent with two kids still appears once).

**And fixing it needs a CARD change, which is why it was not a drive-by.** The
ft_booking rows carry `"User ID"` (the customer) and `"Participant Name"` but
**no participant id**, and counting distinct NAMES would merge two same-named
children — not hypothetical, apex has two different kids both called *Bridger
Wall* (see the ePACT backcheck). A truthful child count is
`fr.participant_user_id::text AS "Participant ID"` on card 17300, one column with
no logic change, plus a tag flip. Not done.

### Export CSV per section, on the flow board (2026-09-01)

Dan: *"add an 'export CSV' button/link to each Fast Track section in this bottom
table. Giving orgs the ability to export a csv of the user information who has
these fast tracked. email, name, section/session fast tracked, etc. Use the same
pdf/csv export functionality that works in a closed iframe sandbox."*

A `⬇ CSV` button beside the people badge on every section row that has
fast-trackers, delivered through **`saveTextViaPopup`** — the ONE popup
implementation in `open-pdf.js` — because a download started by a sandboxed
iframe is silently dropped. **No card change.**

### ONE ROW PER PARTICIPANT PER ACCOUNT, which is the whole reason it is not the badge

The badge counts booking **accounts**; the export counts **children**. Measured
at Essex Junction: 37 accounts hold 43 children, so a parent who fast-tracked two
kids is one line on screen and must be two in the file. Grouping by
`(account, participant)` also gives each child its **own** hold count, which the
badge structurally cannot — and the render fixture carries a two-child account
whose siblings must read 2 and 1, not 3 and 3.

- **The participant key is scoped to the ACCOUNT**, because all the feed has is a
  NAME. Apex really has two different children both called *Bridger Wall* (see
  the ePACT backcheck), so an org-wide name key would merge two families. Two
  same-named children on ONE account still merge, and that is the honest limit.
- **A booking made for the account holder keeps their name** rather than being
  dropped or exported with a blank participant — it is still a real hold.
- **The earliest signup is compared as a STRING**, never through `new Date()`: a
  bare `YYYY-MM-DD` is UTC midnight and lands on the previous day west of UTC.
  The trap is one function over, in `parseCardDate`.
- Converted rows lead, then busiest, then by name, so two runs of the same export
  cannot disagree.

### WHAT IT CANNOT SAY, and why that is not a bug

**It cannot name WHICH sessions.** Card 17300's `ft_booking` rows carry the
section, the customer and the participant NAME — **no session id and no session
date**. So for a per-session camp this exports *"9 fast tracks"* and not the nine
camp days. Splitting the count across the section's sessions, or printing a date,
would be a claim the feed cannot support. One column on the card
(`fr.session_id` / a session date) would fix it; not done, and named here so the
next person does not go looking for it.

### The mechanics that are copied rather than reinvented

- **CRLF and RFC4180 quoting.** A section named `Camp, Red` shifts every column
  after it otherwise, and some Windows importers refuse a bare LF.
- **The BOM is on the FILE ONLY.** Excel sniffs bytes rather than trusting UTF-8,
  so an accented participant name opens as mojibake without it — while a BOM in
  the clipboard copy is a stray character in the first cell. The spec fails if it
  moves into the builder.
- **Absent, not disabled, where there is nobody to export** — a control that
  yields an empty file is the dead end this repo keeps writing down.
- **`stopPropagation`**, because the section row's own click toggles the
  expander, and an export that also opens a panel reads as two accidents.

### The beacon, and the trap it walks past

`ft-export` (📤), and **fasttrack.html had no beacon at all before this** — so
`logClientEvent` is new on that page and copied from `roster.html` deliberately:
the convention is **`?event=<name>` in the QUERY STRING**. A JSON body is read by
nothing on the server, comes back `400 Unknown event`, and a fire-and-forget
beacon never complains — that has now bitten this repo **four** times (campmap,
the Facilities hub, Memberships, Instructor Payout). `fasttrack` IS in
`REPORT_TYPES`, so the generic log route serves it and no dedicated route is
needed.

- **Debounced by SECTION**, like `epact`: an admin pulling four camps' lists is
  four camps.
- **It carries BOTH counts.** *43 people holding 282 camp-days* is a per-session
  camp; *43 holding 43* is a normal section, and the message would read the same
  without the second number. Both are clamped server-side, never echoed from the
  query string.

### Two gaps in my own guard, both worth keeping

- **A value assertion could not catch the date bug.** `new Date(a) < new Date(b)`
  orders two ISO dates identically, so both implementations return the same
  earliest signup and the value test passes either way. The discriminating
  assertion is on the SOURCE — and it failed on correct code first time, because
  the function's own comment quotes `new Date(` on purpose. Comments are stripped
  before the test, exactly as `checkin-status.spec.js` already had to do for the
  uncast date tags.
- **The "no CSV here" case asserted an absence with nothing proving the row was
  on screen.** A vacuous absent assertion passes on a row that never rendered —
  the same trap as the zero-deadlink check in the settings-unlock spec. It keys on
  `data-ft-secrow` now, so the row is required present while the button is
  required absent.

**AND THE RENDER CHECK CAUGHT A DEFECT IN THE CASES THEMSELVES.** All four failed
on the first run with *"the page came up blank"*: the section rows are rendered
behind `isOpen && p.sections.map(...)`, so **nothing under a collapsed program
group exists in the DOM**, and every case sat waiting 45s on a selector that
could never appear. `openFtProgram()` clicks the group first. The button was fine;
the tests were not — which is the same class of mistake as the two `act` hooks
already recorded for the Director's Report flames, and it is only ever found in a
browser.

Guards: `scripts/fasttrack-export.spec.js` (**28 assertions, in CI**), which
LIFTS AND RUNS the three builders over Essex Junction's real shape and boots a
server for the beacon half — a source assertion has never once caught the beacon
bug. `SKIP_SOURCE=1` drops the source half. Mutation-tested eleven ways, all
failing by name: grouped by account only (the bug the export exists to avoid),
the signup compared through `new Date()`, the section filter dropped, no CSV
quoting, the BOM not requested, `stopPropagation` removed, the beacon not fired,
dropped from `SLACK_NOTIFY`, dropped from the log route's `ALLOWED` list, and the
beacon no longer naming its event. Plus four `ci-check-render` cases, one of which
stubs **`window.open`** rather than `saveTextViaPopup` and asserts on the bytes
the popup is handed, so the BOM and the TSV fallback are covered rather than
skipped.

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

## PINNED: creating an org should create it in BOTH projects (Dan, 2026-09-02)

Dan: *"when we create a new org in the org-dashboard or reporting project, it
should automatically create the same org in the alternate project. no more having
to create an org in both spots."*

Not built. Written down with what this session already established, because the
plumbing is half there and the traps are known.

**What exists today.** One direction is already sketched: `POST
/api/admin/add-org` carries the comment *"used by rec-dashboard to sync"*, and
`GET /api/admin/org/:slug` plus `GET /api/admin/org-by-id/:orgId` exist so either
side can ask the other what it serves an org as. What is missing is the CALL —
nothing fires on creation, so both projects are still hand-fed.

**RECONCILE ON `orgId`, NEVER THE SLUG.** The slug is each project's own name for
an organisation and they drift: the dashboard was still calling Shrewsbury
`town-of-shrewsbury` five weeks after the duplicate slug was removed here, and
every report link it rendered 404'd. That is exactly why `org-by-id` was added.
A by-slug check answers "no such org", which is indistinguishable from an org
that was never added. El Segundo is the live example of the same shape — it is
`el-segundo-recreation` here.

**THE GAP THAT WOULD BITE A SYNC IMMEDIATELY:** `add-org`'s existing-org branch
updates the token, the logo and the display name and **silently drops `orgId`**.
So a re-sync — the obvious repair path — cannot fix the one field every shared
card needs, and a wrong `orgId` makes every shared report for that org fail with
`400 Missing org_id`, with no route able to correct it short of deleting and
recreating the org (which burns its token and every link already sent out).
`new-org` refuses a slug that is taken, so there is no other way in. Fix that
field before wiring any automatic creation on top of it.

**And `add-org` has NO auth today** — no `dashboardAuth`, unlike `new-org`. Fine
while nothing calls it; not fine as the entry point for automatic
cross-project org creation. A shared secret or the derived-key pattern
(`reportSettingsAdminKey()`) is the shape to copy.

**Two more things to settle when it is built:** which side owns the token (this
project generates one in `new-org` so an org is never born tokenless — a second
generator would produce two), and what happens when the remote call fails. The
existing `new-org` already models the right answer for its own store: try
GitHub, fall back to `orgs.json`, and never let the failure lose the org.

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

## GL code multi-select (2026-09-01)

Dan: *"lets do the gl code multicheckbox option on the gl code report. everything
starts as selected/checked, there's an unselect all, select all, and individual
checkboxes."*

**THE OPTIONS COME FROM THE ROWS, NOT THE CHART OF ACCOUNTS**, and that was
measured before choosing: at apex the chart holds **974 accounts (888
unarchived)** while only **220 codes carry any activity in twelve months**.
Sourcing from the chart opens a menu of 900+ rows most of which can never match a
receipt in view. Offered to swap it if Dan wants the full chart.

- **An unmapped receipt is its own option, never a dropped row.** `glOptionKey()`
  folds null, `''` and the card's own literal `'none'` into one
  *(Unmapped — no GL code)* entry — three spellings of the same fact would
  otherwise be three checkboxes, and hiding the rows outright is how a total
  stops reconciling against the ledger it came from.
- **`DeskFilter` is GONE — it was generalised into `CheckFilter`**, used by both
  the desk and GL pickers with a per-caller `slug` driving its `data-*` handles.
  A third copy of that markup is how the facility Summary shipped chips that
  scoped some panels and not others. (The payment-method picker keeps its own
  copy: it toggles differently and predates this.)
- **"None" has to STICK.** The reconcile effect runs only when the DATA changes,
  guarded by a signature — on a checkbox click it would widen an empty selection
  straight back to all and the button would look broken. Same shape as the desk
  effect it mirrors.
- **Numeric-aware sort**, so 9 precedes 100 and unmapped sinks last. A GL chart
  in string order is unusable for finding a code.
- **Print and PDF reconstruct the selection from the URL**, because they have no
  React state — an export quietly carrying codes the reader excluded is worse
  than one that fails. `gl_codes` is in `getParams()`'s explicit whitelist and in
  the intent builder, and rides both the share link and the export params.

Guard: `scripts/gl-code-filter.spec.js` (**30 assertions, in CI**), which LIFTS
AND RUNS `glOptionKey`, the comparator and `reconcileFilterSelection`.
Mutation-tested: unmapped folded away, the unmapped sink removed, `None` widened
back to all, the funnel re-deriving its own key, and `gl_codes` dropped from
`getParams()`.

**Three spec bugs of mine worth recording, all found by mutation and all fixed in
the SPEC rather than the mutation:**

- The comparator lift matched **the DESK sort**, which orders fine either way, so
  it proved nothing. It is scoped to the `allGlCodes` memo now.
- `liftFn` counted braces from the first `{`, which for
  `reconcileFilterSelection({ available, … })` is the **destructured parameter**
   — it lifted half a function and threw. It skips the parameter list first.
- A single `.test()` for `glCodes: csv('gl_codes')` passed with either reader
  alone, so dropping it from `getParams()` survived. It counts both.

And one mutation is only discriminating **as a pair**: a stable sort leaves an
element in place on a 0, so removing either unmapped-sink branch alone can still
come out ordered correctly. Removing both fails by name.

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
