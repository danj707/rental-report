# rec.us Rental-Report Platform — orientation

> **This file is a signpost, not the record.** The record is
> [`../CLAUDE.md`](../CLAUDE.md): what has been measured, what was tried and
> rejected, and which traps have bitten more than once. Read that.
>
> This file used to be a "living handoff doc" duplicating current state, and it
> drifted badly — it described `server.js` as ~3,043 lines (it is ~20,000), named
> a June 2026 commit as HEAD, and claimed the sandbox cannot reach Railway or
> Metabase, which is wrong and cost real time to disbelieve. Two docs both
> claiming to hold current state is how one of them starts lying. This one now
> holds only the things that do not change week to week.

## What this is

Multi-tenant reporting for parks & rec orgs. Node/Express `server.js` plus
React-via-CDN pages in `public/*.html`, reading Metabase public cards, deployed
on Railway from GitHub `main`.

- Repo: `danj707/rental-report`
- Production: https://rental-report-production-a046.up.railway.app
  (**there is no `reports.rec.us`** — it has never resolved; the `BASE_URL` in
  older notes is a placeholder.)
- PR previews: `https://rental-report-rental-report-pr-<N>.up.railway.app`

## Working constraints

- **Never load a whole large file into context.** `server.js` is ~20k lines and
  the report pages are thousands each. Use `grep -n`, `sed -n 'X,Yp'`, and edit
  in place.
- **The sandbox CAN reach Railway and Metabase.** An older version of this file
  said it could not; that was wrong, and believing it meant skipping live
  verification more than once.
- **A push to `main` is an operational event**, not merely a code change — it
  restarts production. Since the volume was removed deploys are rolling rather
  than an outage, but they are still not free. See CLAUDE.md.
- **Never `pkill -f` a pattern that could match this session's own harness.**
  The symptom is every later command exiting 144 with no output, which reads
  exactly like the thing you were running having crashed.

## Before you change a Metabase card

Read the live card first — the `sql/` mirrors drift, and one has already been 53
lines stale, where pushing the repo copy would have silently deleted a live
feature. Then expect the tag flip: an API push regenerates every template tag as
**Text**, the card then registers six parameters instead of three, and the report
400s for every org until a human re-types them in the Metabase UI. Sign off with
`scripts/verify-report-live.js` against the heaviest org, **run alone** — a
concurrent query makes it invent timeouts on cards you never touched.

## Before you ship a page change

`node scripts/ci-check-render.js`. It is the only check that RUNS the pages —
`node --check`, the HTML parse check and the boot check all pass happily on a
page that renders a blank white screen, which has reached production twice.

## The checks, and what each one alone cannot see

| check | catches | blind to |
|---|---|---|
| `npm test` | logic, in the specs' own terms | anything only a browser does |
| `ci-check-render.js` | blank pages, wrong computed values | a card that stopped answering |
| `ci-check-admin-js.js` | the admin dashboard's template-literal escaping | the report pages |
| `verify-report-live.js` | a card that no longer answers | the pages themselves |
| `pdf-fonts.spec.js` | a PDF with no glyphs for its icons | everything else |

## Where things live

| | |
|---|---|
| `server.js` | routes, org registry, Metabase proxy, cron, admin dashboard |
| `public/*.html` | one file per report, React via CDN, Babel in-browser |
| `public/report-loader.js` | the shared loading progress bar |
| `public/open-pdf.js` | the one popup/export implementation every page uses |
| `lib/store.js` | the Postgres-backed state store (config, events, feed cache) |
| `sql/` | mirrors of the live Metabase cards — **not** the source of truth |
| `scripts/*.spec.js` | the guards; most lift and RUN the function they pin |
| `docs/DB-MIGRATION-RUNBOOK.md` | the store flip, step by step, with undos |
