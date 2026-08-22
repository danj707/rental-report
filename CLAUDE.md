# Project notes for Claude

## Working preferences (from Dan, dan@rec.us)

- **Always share the Railway PR-preview URL** whenever I open a PR for this repo,
  without being asked — Dan wants to click through the change before merging.
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
  NOTE: the session sandbox's outbound proxy blocks `*.up.railway.app` (CONNECT
  403), so I cannot curl the preview to verify it. Verify boot via Railway
  `list-deployments` on the PR environment instead — status `SUCCESS` means it's
  up for Dan's browser even though I can't reach it.

## Admin "What's New" popup — REMOVED from admin (PR #134)

Feature updates are for org admins, not for the person who wrote them, so the
popup now appears only on the ORG dashboards (`public/org.html`). The
`adminWhatsNew` block is gone from the admin dashboard in server.js.

Still true of the org-side popup: it shows *published* project-updates, so it is
EMPTY until at least one update is published, and each PR preview is a fresh
environment with its own (empty) data store — a brand-new preview shows no popup
until you publish an update in it first.

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
fire. Deliberately not the cache's `isReportHot()` (3+ opens in 7 days) — right
question for holding rows in memory, wrong one for "does anyone rely on this".

Usage as of 2026-08-22 (log starts 2026-05-22, so ~3 months): dead are
`overview` (8 opens ever, none in 90d, orphaned page — still in
REPORT_DEPENDENCIES) and `annual-report` (3 opens, last 51d). `court-utilization`
as a *page* is dead (2 views/30d) but its **card is load-bearing** —
`facilities.html` pulls it 174x/30d across 13 orgs, so don't retire the card with
the page. `campmap` is in `RETIRED_REPORTS` yet has 24 views/30d across 2 orgs,
so it's more alive than the other two retired reports.

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
- **Current state:** `sql/facilities-summary-v2.sql` = the rebuilt query, saved
  as Metabase card **19570** (public UUID `4c070d95-ab02-4b9d-ac43-ac86257162d5`,
  date tags flipped, sharing on). `public/facilities.html` already has the
  billed/collected UI, gated on a `hasBilled` flag → **dormant** because
  `FACILITIES_SUMMARY_UUID` in server.js points back at the original card
  `4defd1b6…`. Flipping that one line re-activates it.
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
