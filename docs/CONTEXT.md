# Context handoff — rec.us rental-report platform

## Who/what
I'm Dan, technical owner of the **rec.us rental-report platform** — a Node.js/Express
multi-tenant reporting app. Pulls from Metabase, renders HTML reports client-side
(React no-build CDN, Chart.js, SheetJS), PDF via Puppeteer. Auto-deploys to Railway
from the `danj707/rental-report` GitHub repo on every push to `main`.

You (Claude) can push to my repo directly. Network here allows github.com AND
api.github.com. Push pattern:
  git clone https://x-access-token:<PAT>@github.com/danj707/rental-report.git
  (or Contents API: GET blob SHA → PUT base64)

## Resources
- Repo: danj707/rental-report
- PAT (Contents read/write): in Claude memory / supply directly — NOT stored here (public repo)
- Deployed base: https://rental-report-production-a046.up.railway.app
- Live skill (READ-ONLY to you): /mnt/skills/user/add-rec-report-org/SKILL.md
- Repo source-of-truth skill: docs/skills/add-rec-report-org.md
- Metabase rec.metabaseapp.com is blocked from your network — I supply UUIDs directly

## server.js structure (verified, reference by grep not line #)
- ORGS map ends with `};` immediately before `const REPORT_TYPES` (~line 151) — org insert point
- ORGS entry shape: token (first), orgId, logoUrl, optional displayName, then { mbUuid } report keys
- REPORT_TYPES (9): facility, gl, historic, programs, roster, overview, products,
  memberships, court-utilization. NON_ADDABLE_REPORTS = {overview}
- Token gate ~line 814: `if (!org.token) return next();` (FAILS OPEN: tokenless org = public)
- UPDATES array ~line 2780 (memory's ~2380 is STALE — grep for it)
- reportMeta/REPORT_META keyed by report TYPE, not org

## Standing instructions (every applicable push)
1. UPDATES log: new { date, title, items } at TOP of UPDATES array in server.js
   (client-facing feed — skip for internal-only changes like skill/docs edits)
2. Metrics page: after report changes, update public/metrics.html — REPORT_META,
   REPORT_ORDER, REPORT_COLORS, .badge-<type> CSS
3. New report TYPE metadata in 3 places: reportMeta in `/` route (~1706),
   reportMeta in `/:org` route (~1452), REPORT_META in public/org.html
4. Edit public/*.html directly (single source of truth; old pub_*.html rule is dead)

## Open threads (update as these move)
- programs.html: in-progress SQL+HTML build (Reg Mode + Cancellations cols; enrollment-netting
  decision pending). Two MB questions to save for Norman.
- gl.html: # Pmts / # Rfnds count columns — code delivered, push was blocked mid prior session
- Norman GL SQL: add desk_location → "Desk Location" col; ready to save as MB question
- Danvers GL: orgCreditPayments / Org Credit Refunds MB query not yet updated
- AI insights prototype: court-utilization-insights.jsx for Apex — validate tone, then
  integrate into server.js (cached Haiku call behind a Railway API endpoint)

## How I work
Incremental, concise prose-forward replies, targeted edits over rewrites, ship each
change immediately. Validate multi-CTE SQL with simplified core first (LIMIT 12–15 for
MCP preview). Syntax-check inline scripts by extracting <script> blocks to .js and
running node --check.
