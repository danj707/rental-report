# rec.us Rental-Report Platform — Working Context

> Living handoff doc. Paste into a new chat to bootstrap. Update the **Current state** + **Open threads** sections as work ships. Last shipped: Public Apex Calendar (HEAD 7fb5107, 2026-06-04).

## What this is
Multi-tenant reporting dashboard for parks & rec orgs. Node/Express `server.js` + React-CDN HTML in `public/*.html`, Metabase public-card data, Railway auto-deploy from GitHub `main`. Repo: `danj707/rental-report`. Live: https://rental-report-production-a046.up.railway.app

## Operating constraints (read first)
- **Context bloat kills these chats.** NEVER load full `server.js` (~3043 lines) or full HTML files into context. NEVER render calendar/schedule HTML as an artifact (re-renders every turn). Edit on disk, `node --check`, push via git. Use tight `grep -n` / `sed -n 'X,Yp'` / `curl -sL` raw fetches.
- **Sandbox network** allows github.com / raw.githubusercontent.com / api.github.com / npm / pypi / anthropic. BLOCKS Railway + rec.metabaseapp.com -> cannot verify the live deployed site or hit Metabase directly. Browser-direct calendar always falls back to sample data; live data only flows through the server proxy after deploy.
- `/tmp/rrgit` = persistent local clone, PAT-authed (`x-access-token` in origin URL), git identity set (`dan@rec.us`). Survives sessions incl. uncommitted edits.

## Current state (HEAD = 7fb5107)
**Public Apex Calendar SHIPPED.** Live at `/apex/calendar?token=<APEX_TOKEN>`.
- `public/calendar.html` — standalone Week+List calendar: color-by-activity, filter chips, Full/Waitlist badges, all-day lane (>=7h), cards deep-link to rec.us/sections/{id}. Fetch chain: `/{org}/calendar/api/data` -> MB public `8a3dac9b-6c34-45e1-a7d0-3a177477fe17` -> built-in sample.
- server.js fully wired (ORGS entry, REPORT_TYPES, NON_ADDABLE, PII-strip proxy, explicit `/:org/calendar` route, reportMeta x2, How This Works, UPDATES). Calendar is PUBLIC — proxy strips reservee/email/phone/notes/name per-row.
- `org.html` + `metrics.html` sync points done.

## server.js structure map (~line numbers)
111 apex ORGS · 159 REPORT_TYPES · ~161 NON_ADDABLE_REPORTS · 1164 `GET /:org/:report/api/data` (MB proxy) · explicit HTML routes end ~1397 · ~1550 `/:org` catch-all (calls `next()`) · 1587 `/:org` landing reportMeta · 1867 root `/` dashboard · 1899 root reportMeta (has `color`) · ~2315 How This Works · ~2826 `const UPDATES = [` (newest-first) · ~2962 `express.static("public")`.

## New-report wiring checklist (proven)
1. ORGS `mbUuid` per org · 2. REPORT_TYPES append · 3. NON_ADDABLE_REPORTS if not self-serve · 4. PII/transform in proxy · 5. explicit `app.get("/:org/<report>")` sendFile (404 guards + logEvent) · 6. reportMeta in BOTH landing (~1590) AND root (~1900, color) · 7. `org.html` REPORT_META · 8. How This Works `<li>` · 9. UPDATES top entry · 10. metrics.html 4 sync points (badge CSS, REPORT_META, REPORT_ORDER, REPORT_COLORS) · 11. `node --check` + commit + push · 12. note Railway backup limit.

## Standing instructions (every applicable change)
- UPDATES log: new entry at TOP of `UPDATES` array.
- metrics.html: REPORT_META, REPORT_ORDER (mirror REPORT_TYPES), REPORT_COLORS, `.badge-<type>` CSS.
- Report card metadata (label/icon/color/desc/AI flag) in ALL THREE: root reportMeta (~1900), `/:org` landing reportMeta (~1590), `org.html` REPORT_META.
- New org/report -> update How This Works Reports list.

## Open threads to iterate
- **Calendar polish** (likely next): live-data verification once deployed; whether to surface more fields; mobile layout; wiring calendar into other orgs beyond Apex.
- Littleton session-calendar SQL (Denver tz; needs `starts_at` confirmed `timestamptz` UTC; normalizeRow keys Program/Section/Activity/Status/Section URL; Begin Sort = sort-only).
- programs.html: Reg Mode col (Section/Session-based) + Cancellations col + Cancel% (client-computed), gated on data presence. Existing Enrollments/Fill% include canceled bookings.
- AI insights for Apex court-utilization (prototype `court-utilization-insights.jsx`; prod = cached Haiku behind Railway endpoint).
- Danvers GL: query missing `Organization Credit Payments` + `Org Credit Refunds` -> Acct Credit card won't render until updated.
- Org UUID pulldown (self-serve): blocked on public Rec REST search endpoint URL.
- Smyrna: payment-channel segmentation (in-person vs online CC) in GL — pending follow-up.
- Boot-time org guard quarantine loop: NOT confirmed live — verify before relying.

## Key identifiers
- Repo `danj707/rental-report`
- Apex MB calendar UUID `8a3dac9b-6c34-45e1-a7d0-3a177477fe17` · Calendar: color `#ea580c`, icon calendar
- `?token=` required on all `/:org/*` except `/`, `/api/*`, `/metrics`, `/hotdog`
- Confirm HEAD: `curl -s api.github.com/repos/danj707/rental-report/commits/main`
- (Secrets — PAT, per-org tokens, ORGS UUIDs — live in chat memory / env, NOT in this public file.)

## Gotchas
- `applied_pricing->'result'->>'finalCents'` = correct Total (honors overrides); `order_item.price` = original only.
- Strip `[[ AND ... ]]` optional-filter syntax before `preview_query`.
- MB template var dates must be set to **Date** type in question editor (default Text -> 400).
- Rec MCP `discover_schema`/`explore_table_details` 500 — use `preview_query` on `information_schema.columns`.
- `program` table has no `organization_id` — scope via `section.organization_id`.
- Timestamps stored local time per-org — no `AT TIME ZONE` except Denver/Littleton.
