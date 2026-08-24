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
(🧾 lite export), `game` (🕹️ hidden banner mini-game plays), `view`, `insights`,
feedback/votes, `email`, `munis`, `permits`, `map`, and three platform alerts —
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

## Campsite map availability — 30 days is the ceiling, and it is not ours (2026-08-23)

**Dan expected >30 days for a properly configured site. It is not a configuration
issue.** `get_site_availability` takes ONLY a `siteId` — no range parameter
exists — and its own description says "the next 30 days". Probed three ways, all
returning an identical 31 keys ending 2026-09-22: public tool on Topaz Site 01,
public tool on Site 04, and the STAFF-scoped tool on Site 04. Site 04 carried
`nights.maximum = 180` at the time and the window did not move, so the horizon is
independent of the site's settings.

Two config red herrings, both worth knowing:

- **The "180" in the admin panel is a STAY DURATION, not a booking window.**
  40 of the 41 Topaz campsites allow 14 nights; Site 04 alone said 180, which Dan
  then corrected. "Default nights per stay" sits directly above "Default days in
  advance" in that panel, and both read 180 — a data-entry slip.
- `court.default_reservation_window_days` is **NULL on all 41** sites, and the
  largest value anywhere on the platform is **21**. No 180-day window is stored at
  site or org level.

`latestCheckout` DOES reach past the 30-day window (a 22 Sep arrival could check
out 6 Oct under the old 14-night rule), so **the cap is on arrival dates only** —
never bound the checkout picker to the strip's length. And never take the longest
window any single site offers: one mis-set site would offer a 180-night stay for
the whole park. Cap by the org's configured max stay first.

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

Decision (Dan, 2026-08-23): **stay at 30 days.** The strip ends with a per-org
hand-off card (`bookAhead` in `campmap-seeds.json`: the org's rec.us
facility-rentals URL + the department to name) rather than rendering nights we
cannot answer for.

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

### Guard: `node scripts/campmap-stay.spec.js` (12 assertions, in CI)

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
| `campmap-book` | the hand-off card at the foot of the site list | `kind: "later-dates"` |
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
**NOT YET APPLIED to card 17300** (needs the Date-tag re-flip + heaviest-org
verification below). The date is right in Pacific for this section, but an
early-morning Eastern event still slips a day, so this is a correctness fix and
not only a cosmetic one.

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
