# Project notes for Claude

## Working preferences (from Dan, dan@rec.us)

- **Always share the Railway PR-preview URL** whenever I open a PR for this repo,
  without being asked — Dan wants to click through the change before merging.

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

## Admin "What's New" popup

The dashboard "What's New" popup shows *published* project-updates (the same ones
org admins see) — it is EMPTY until at least one update is published, and each PR
preview is a fresh environment with its own (empty) data store. So a brand-new
preview shows no popup until you publish an update in it first.

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

## Semantic data layer / Metabase exit (CONTEXT ONLY — no work started, 2026-08-17)

Company-level strategy work now overlaps this repo. **Nothing here is a task yet**
— Dan will scope next steps after the 20 Aug meeting. This section exists so a
fresh session doesn't re-derive it.

### The company PRD (owns the decision, we don't)
"Data Strategy & Reporting Recommendations" — Notion, owner Elise, status Draft.
https://app.notion.com/p/rec-team/Data-Strategy-Reporting-Recommendations-3b3f117be00480be80dec3775db1dcd0
Meeting **20 Aug** with Birju, Kevin, Bart. An earlier discussion happened 8/14.

Root problem as they frame it: schema tech debt from the courts-era origin (sites
are still `court` in the model), so data isn't reliably self-serve queryable by
anyone. Four consumers named: Departments, **Dan's reporting app**, Seb, IT teams.

Three decisions in the PRD:
1. **Data infrastructure** → recommendation is a **semantic/view layer** (vs.
   fixing the schema). Build vs. buy TBD (Cube is the buy option, ~3-4mo est from
   a June project plan; Kevin owes an eng estimate, Eliza owes market research).
2. **Report builder** — build vs. buy open; committed to departments for 2026.
3. **What happens to Dan's reporting app** — current recommendation: short term
   leave as-is, **medium term reposition as a third-party integration**, long term
   Rec builds native reports like it. Concerns cited: no eng visibility into
   downstream deps, Metabase performance, UX not Rec-native, Dan as bottleneck.

Their stated requirements that matter to us: *"Semantic layer references our
databases and does not call metabase"* · field-usage tracking so customer reports
don't break (the Apex overnight-break incident) · tenant/row-level security in one
place · automation coverage so the view layer can't drift on new commits · *"anyone
can build on top: Dan, the report builder, Seb, Partner Success."*

### Rec infrastructure that already exists (we had NOT accounted for this)
- **Epsio materialized views** — described in the PRD as a partial, ungoverned
  version of the modeling layer. Refreshes have taken 10+ min locally; views have
  broken on schema migrations.
- **A read replica exists** — the 2 Jul incident came from uncoordinated load on
  the reporting path.
- Bronze/silver/gold naming convention sketched by George and Kael, unbuilt.
- Seb currently writes its own SQL against raw tables.

### What we extracted from this repo (evidence, still valid)
- **257 distinct published fields** across 15 version-controlled queries
  (`sql/report-cards/*.sql` + `sql/gl-code-report.sql`); ~50 are money.
- **242 client-side aggregation sites** in shipping report pages (`reduce` /
  `filter().length`) — facilities.html 48, users.html 47, programs.html 44. Most
  real business logic lives in the browser, not in SQL.
- **5 near-identical Metabase fetch paths**: main `/api/data`, `fetchMBDirect`
  (annual), `qbrFetch` (QBR/director's), `fetchOrgChatData` (chat),
  `fetchWizardSchemas` (wizard).
- **No `pg` dependency** — the app has zero direct DB access today.
- Definition collisions found: `Fill %` computed 5 different ways (2 in SQL, 3 in
  browser JS, incl. two variants in programs.html alone — see the
  `raw['Fill %'] ?? raw['fill_pct']` fallback at programs.html:649); ~50 money
  fields under 6 vocabularies and 2 casing conventions; staff/guest exclusion
  duplicated between users.html and `qbrSumUsers()` ("Mirrors users.html
  exclusions exactly" — a comment, not a guarantee).
- Requirements we've effectively prototyped: `REPORT_DEPENDENCIES` +
  `getReportsForColumn()` (field lineage/impact), server-side org_id injection
  (tenant isolation), `checkSchemaDrift()` (shape drift), and the August batch
  verification method (row count + order-independent checksum + same-snapshot
  `EXCEPT ALL`).

### The Brad divergence (strongest argument we have)
Brad asked for a revenue figure; **the reporting app and Seb returned different
numbers.** Both reading Rec data, no shared definition to adjudicate against, no
alarm — caught only because Brad noticed. This is the customer-visible cost of two
consumers doing independent arithmetic, and it gets worse as the report builder and
a customer API come online. *Specifics still needed: org, question, both figures,
root cause — Dan to supply.*

### Our position (artifact, option B = consumer input + a stance on decision 3)
https://claude.ai/code/artifact/f7b7247e-ca1c-433e-b489-9e29d5faee36
Titled "Notes from Downstream." Agrees with the semantic-layer recommendation;
contributes the 257-field list as the layer's day-one acceptance test and first
field-usage registry entry; proposes a testable MVP (**"whatever set of definitions
makes the 22 existing reports return identical numbers"** + **"Seb and the app
return the same number for the same question"**); and argues against the
third-party-integration path — make the app the layer's **first consumer /
proving ground** instead, since it's the only live consumer and third-party status
would *institutionalize* the Brad divergence. Concedes: Rec-native is the right
long-term destination, the maintenance concern is real, build-vs-buy isn't ours.

Two factual corrections to raise: the app is **not** built on batch exports (it's
live public-card fetches through a caching proxy), and it's iframed into **rec.us
admin, not Metabase** (verify before asserting).

### Index dependency (blocks any direct-DB path)
Already filed separately, repeated here because it's on the critical path:
`materialized.item_log_report` (2.15M rows) and `materialized.transaction_report`
(964k) have **no usable indexes** — every org-scoped query seq-scans a multi-org
view. `payment`/`refund` need `(organization_id, created_at)`;
`order_item_transaction` needs `(organization_id, confirmed_at)`. Metabase's 60s
timeout is currently the only thing keeping these slow rather than fatal.

### Only pending build item (NOT started, awaiting scope)
Graduate `scripts/verify-report-live.js` from liveness ("returned non-empty rows")
to **parity** ("returned these exact rows") — golden snapshots per query ×
representative org, checksummed, in CI. Decision-independent: satisfies the PRD's
automation-coverage requirement, is the test behind the MVP proposal, and catches
ordinary card-edit regressions meanwhile.

## Dev branch

Feature work for these tasks lives on `claude/facility-report-line-removal-1d0c8k`
(same branch name in both `rental-report` and `rec-dashboard`).

Semantic-layer / Metabase-exit context above was captured on
`claude/semantic-data-layer-reporting-756bdw`.
