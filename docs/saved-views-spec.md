# Saved views ("saved searches") — spec, GL report first

Status: spec / not built. Written 2026-08-22.
Model: the Rec app's per-page view picker (Default view / named views in the
header, chips for active filters, a `Save view` button that lights up when the
current filters differ from the saved one).

Goal, in Dan's words: set a group of desk locations or GL codes, save it, name
it, and jump back to it from the header later.

---

## 1. The unit of saving is a named URL, not a snapshot

The GL report already keeps most of its filter state in the URL and rebuilds
from it on load — `start_date`, `end_date`, `desks`, `methods`, `tyler` — and
the PDF, print and email paths all reconstruct the view from those same params
(`public/gl.html:1541-1585`, `1595-1628`; `generatePdf` in `server.js`).

So a saved view is just:

```js
{
  id: "v_8f2c…",          // server-generated
  name: "Front desk cash",
  dateMode: "current",     // current | relative | fixed
  relativeRange: null,     // e.g. "lastMonth" when dateMode = relative
  params: "desks=Community%20Recreation%20Center&methods=cash,check",
  display: { view: "table" },   // optional, see §2
  createdAt: "2026-08-22T18:04:11.402Z",
  updatedAt: null,
  deletedAt: null
}
```

Applying a view = swap the query string and let the existing load path do the
work. Nothing in the report needs to learn a second way to be filtered, and
**PDF / print / Excel / email subscriptions inherit saved-view fidelity for
free**, because they already read the same params.

### Fidelity gaps to close first

Four pieces of GL filter/display state are *not* in the URL today:

| State | Where it lives now | Treat as |
|---|---|---|
| GL code / account text filter (`glFilter`) | React state only | **Filter** → add a `glq` URL param, save it |
| Chart mode table/bar/pie (`viewMode`) | `localStorage gl_view_mode_v2` | Display → save in `display` (see §2) |
| Refund detail expanded (`showRefunds`) | `localStorage gl_refund_breakdown_v2` | Display, keep localStorage-only in v1 |
| Locations column (`showLocations`, Norman only) | `localStorage gl_show_locations_v1` | Display, keep localStorage-only in v1 |

Adding `glq` to the URL is a prerequisite — a saved view that quietly loses the
text filter is worse than one that refuses to save it.

## 2. Filters vs display

A saved view stores **filters** (what rows are in scope) and, optionally, the
**chart mode** — a pie of the same rows is legitimately a different "view".
Refund-detail and Locations toggles stay per-browser preferences; they don't
change the numbers, and folding every toggle in makes "is this view dirty?"
noisy for no benefit. Revisit if anyone asks.

## 3. Dates — the open question, answered

Three modes, chosen in the save dialog:

| Mode | Stored | Opens showing | For |
|---|---|---|---|
| `current` **(default)** | nothing | whatever range the page is already on | "Front desk + cash only" — a filter set reused across any period |
| `relative` | a token from the existing vocabulary (`lastMonth`, `prior30`, `prior7`, `last7`, `yesterday`, `today`) | recomputed at open time | "Last month, cash desks" — a monthly close routine |
| `fixed` | literal `start_date` / `end_date` | exactly those dates, forever | "FY26 Q1 close", an audit range |

Specific answers to "what happens when the date range passes":

- **A fixed range never expires and is never silently slid forward.** A GL
  rollup for a closed month is history — pinning it is the whole point. Moving
  it under the user would be the harmful behaviour in a finance document.
- **It must never *look* live.** The chip renders the range inline
  (`FY26 Q1 close · Jul 1 – Sep 30, 2025`) and fixed views carry a 📌 in the
  picker. Relative views show their token ("Last month"); `current` views show
  no date at all, so it's obvious the dates on screen are yours, not the view's.
- **Default to `current`.** Dan's own example is a filter set, not a period —
  making dates opt-in means the common case cannot go stale.
- Optional v1.1 nudge: a fixed view whose `end_date` is >13 months old renders
  muted with an "archived" hint. A hint, never an auto-delete.

Reuse the server's existing relative vocabulary — `getDateRange()`
(`server.js:3242`) and the `validDateRanges` list at `server.js:6371` — rather
than inventing a second one. That is what makes §7 Phase 3 cheap: the same
token can be handed to `POST /:org/admin/subscribe`, and `rangeBlocked()`
already refuses nonsense pairings (a future range on a backwards-looking GL
report).

## 4. Storage and scope — org-shared, on the volume

Auth is one shared token per org (`ORGS[slug].token`, gate at
`server.js:4351`). **There is no per-user identity anywhere in this app**, so:

- Saved views are **team state**, exactly like Fast Track pins — "any staff
  member with the org token sees the same". Follow that precedent directly:
  `FT_PINS_FILE` + `ftPinsAuth()` at `server.js:6306-6332`.
- File: `DATA_DIR/saved-views.json`, shape
  `{ [orgSlug]: { [reportType]: SavedView[] } }`, through the existing
  `readJSON` / `writeJSON` helpers (`server.js:2256-2261`).
- Persistence in production is real: `DATA_DIR` and `RAILWAY_VOLUME_MOUNT_PATH`
  are both set on the `rental-report` service, so views survive deploys.
  **A PR preview is a fresh environment with an empty store** (same caveat as
  the "What's New" popup), so views must be created inside the preview to test.
- "My views" vs "our views" is not buildable without identity. Recommendation:
  org-shared list in v1, plus a **per-browser default view** in localStorage —
  which view you land on is a personal habit, the list itself is shared.
- A shared token means anyone can delete anyone's view. Mitigate:
  **soft delete** (`deletedAt`, filtered on read) with a 10-second "Undo"
  toast, and an `events.jsonl` line on create / rename / delete. Compact
  tombstones older than 30 days.

## 5. API

```
GET    /:org/:report/api/views        → { views: [...] }        (excludes tombstones)
POST   /:org/:report/api/views        → create   { name, dateMode, relativeRange?, params, display? }
PATCH  /:org/:report/api/views/:id    → rename | update-to-current | restore
DELETE /:org/:report/api/views/:id    → soft delete
```

`/:org/:report/api/*` is **not** in the token-gate whitelist (only top-level
`/api/*` is), so the gate already covers these. Add a `viewsAuth(req, res)`
mirroring `ftPinsAuth` anyway — belt and suspenders, and it returns JSON errors
instead of the gate's bare 404.

Validation matters here, because these params end up in a Puppeteer URL via
`generatePdf`:

- Parse `params` with `URLSearchParams`, then **allowlist per report**. GL:
  `desks`, `methods`, `glq`, `tyler`, `start_date`, `end_date`. Drop everything
  else. Strip `token`, `_print`, `_nocache`, `_refresh` explicitly — the
  subscribe route already does exactly this cleaning at `server.js:6379-6395`;
  reuse it rather than writing a second cleaner.
- `name`: trimmed, 1–60 chars, escaped on render, unique per org+report
  (case-insensitive) — on collision offer "Replace?", don't silently duplicate.
- Dates: `^\d{4}-\d{2}-\d{2}$`, `start <= end`.
- `dateMode` enum; `relativeRange` must be in the `getDateRange()` vocabulary
  and pass `rangeBlocked(report, token)`.
- Caps: 25 views per org+report, 4 KB per view; over-cap is a clear 400, not a
  silent drop. Mirror the pins route's rule: a non-empty request where nothing
  validates is a malformed client, not an intentional clear — reject it.
- Key strictly off the resolved `req.params.org`; never anything client-supplied.

## 6. UI

Header, mirroring the Rec pattern in the screenshot:

- **View picker** at the head of the toolbar, after the nav breadcrumb:
  `Default view ⌄` or the active view's name. Dropdown lists `Default view`
  then saved views A–Z, ✓ on the active one, 📌 on fixed-date ones, with a
  second muted line per row summarising date intent + filters
  ("Last month · 3 desks · cash, check"). Footer row `＋ Save current view…`;
  per-row `⋯` → Rename / Update to current filters / Set as my default / Delete.
- **Dirty state**: as soon as filters diverge from the applied view the label
  reads `Front desk cash · edited` and the `Save view` button enables — greyed
  out otherwise, exactly as in the screenshot. Two actions:
  *Update "Front desk cash"* and *Save as new*.
- **Filter chips** beside the picker (`Community Recreation Center ✕`), one per
  active filter group, ✕ clears it. Worth building even without saved views:
  today the toolbar shows only badge counts, so what is filtered is invisible
  at a glance.
- **Unresolved-filter warning — the one that matters.** Today, when a saved
  desk or tender is absent from the newly loaded data the effects prune it, and
  if *nothing* matches they fall back to **all**
  (`public/gl.html:1551-1556`, `1576-1580`). A view named "Front desk only"
  that silently renders every desk is the same class of failure as a
  stale-cache render: it looks right and is wrong. On apply, diff requested vs
  resolved and show an inline warning —
  `⚠ 2 of 3 saved desk locations aren't in this date range` — with
  "show anyway / change dates". **Never widen a financial filter silently.**
- **Print/PDF**: picker and chips hide in `print-mode` (same as `.nav-crumb`),
  but the view name goes into the PDF header line, so an exported page says
  which saved view produced it.
- **Empty state**: with no saved views the picker is just a `＋ Save view`
  button — no dropdown chrome.
- **URL**: applying a view does `history.replaceState` with the view's params
  plus `view=<id>`, so a copied link reproduces the filters *and* names the
  view for whoever opens it.

## 7. Slack activity ping (standing rule)

- `view-save` → add to `SLACK_NOTIFY` and `SLACK_EVENT_META`
  (`💾`, "saved a view of"), with a custom branch in `notifySlack()` so the
  message carries the name: `💾 Norman (norman) saved a view of *GL* —
  "Front desk cash"`. Fire it server-side with `logEvent()` inside the POST
  route — the server sees the create, so no beacon is needed.
- `view-apply` → `events.jsonl` only at first. A picker gets clicked all day;
  if Dan wants the signal in Slack, add it with a `view`-style 30-minute
  debounce and it needs adding to the `ALLOWED` list at `server.js:4571`.

## 8. Phasing

- **Phase 1 — GL only.** Store + 4 routes, `glq` URL param, header picker +
  save dialog + dirty state, unresolved-filter warning, `view-save` ping.
  Dates default to `current`.
- **Phase 2 — generalize.** Extract `public/saved-views.js` as a
  self-injecting widget (the `nav-breadcrumb.js` pattern) and a
  `SAVED_VIEW_PARAMS` map per report in `server.js`; the routes are already
  `:report`-shaped. Facility, products, memberships and users are the natural
  next ones — each already has URL-driven filters.
- **Phase 3 — views as subscriptions.** "Email me this view" in the picker →
  existing `POST /:org/admin/subscribe` with the view's `params` as
  `reportParams` and its `relativeRange` as `reportDateRanges`. Offer it only
  for `current` / `relative` views: a fixed range mailed weekly is the same
  report forever, and the UI should say so rather than let someone set it up.

## 9. Decisions for Dan

1. **Org-shared or per-browser?** Recommend org-shared — matches the shared
   token and the "easy team reference" goal.
2. **Does a view capture chart mode, or filters only?** Recommend filters +
   chart mode; refund/Locations toggles stay per-browser.
3. **Should applying a view ping Slack?** Recommend no — events only, it's a
   high-frequency click.
4. **One org-wide default view everyone lands on?** Recommend per-browser
   default in v1; an org default is a Phase-2 admin toggle if wanted.

## 10. Sign-off checks

- Round trip: create → reload → apply → export PDF; the PDF rows must match the
  screen exactly (really a test that the allowlist dropped nothing).
- A saved view whose desks are absent from the new range shows the warning and
  does **not** silently widen to all desks.
- A fixed-date view opened months later returns the same numbers it was saved
  with. If it doesn't, that's a finding worth chasing on its own.
- Persistence across a deploy: create a view in prod, redeploy, confirm it
  survives — otherwise the failure is discovered by a user losing their views.
- Validation: the 26th view is rejected; `token=` inside `params` is stripped;
  another org's slug cannot read or write the list.
- No Metabase card changes here, so the card sign-off rule and
  `scripts/report-cards.manifest.json` are untouched.
