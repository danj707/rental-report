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

## Dev branch

Feature work for these tasks lives on `claude/facility-report-line-removal-1d0c8k`
(same branch name in both `rental-report` and `rec-dashboard`).
