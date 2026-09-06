# rec.us Reports

Multi-tenant reporting for parks & recreation departments. Node/Express +
React-via-CDN, reading Metabase public cards, deployed on Railway.

**Production:** https://rental-report-production-a046.up.railway.app
(there is no `reports.rec.us` — it has never resolved.)

Serving **29 orgs** across **23 report types**, from **13 shared Metabase cards**
plus per-org ones.

## How It Works

```
  ENTRY                    rec.us admin portal  ·  tokenized links  ·  public calendars
                                         │
                                         ▼
  GATE                     token middleware — 16 chars, fail-closed (generic 404)
                                         │
                                         ▼
  APP        ┌──────────────────────────────────────────────────────────────┐
  (Railway)  │  Node / Express  ×2 replicas, rolling deploys, no volume     │
             │                                                              │
             │  report pages   Metabase proxy   AI insights   Puppeteer PDF │
             │  PII stripper   email digests    watchdogs     Slack feed    │
             └──────────────────────────────────────────────────────────────┘
                    │                     │                      │
                    ▼                     ▼                      ▼
        ┌───────────────────┐  ┌────────────────────┐  ┌──────────────────┐
        │ Metabase          │  │ App State Store    │  │ External         │
        │ public card API   │  │ (Postgres, SHARED) │  │ Anthropic · MCP  │
        │ → rec.us read     │  │ config · events    │  │ GitHub · Resend  │
        │   replica         │  │ feed cache         │  │                  │
        └───────────────────┘  └────────────────────┘  └──────────────────┘
```

A staff browser never talks to Metabase. Every query is proxied server-side,
which removes the CORS problem (Metabase OSS sends no browser-friendly headers)
and keeps the card UUIDs off the client.

### State, replicas and deploys

State — org config, the event log, the warm feed cache — used to live on a
Railway volume. **A volume attaches to one instance**, so the service was pinned
to a single replica and every deploy was stop-then-start by construction: no
health check can hide a gap the disk itself is forcing.

That state is in Postgres now, shared by both replicas. The volume is gone,
`numReplicas` is 2, and deploys are rolling.

- **The feed cache is shared** — a new container starts warm, and either replica
  answers from the same rows.
- **Scheduled work runs once.** Prewarm, the health check, the watchdogs, the
  nightly backup and the daily digest each take a Postgres advisory lock. It
  **fails open** deliberately: a duplicated cycle is a nuisance; a platform that
  silently stops watching itself is not.
- **Config propagates in ~4s** via a rev-cursor poll, so an org added on one
  replica resolves on the other without a restart.
- **Two things stay on local disk on purpose** — the memory-residency hint (a
  per-container heuristic) and uploaded announcement images (binary).

Rollback is an env var, not a deploy: `STORE_MODE` = `disk` | `dual` | `db`.
With no database URL the app behaves exactly as it did before the store existed.
Full procedure in [`docs/DB-MIGRATION-RUNBOOK.md`](docs/DB-MIGRATION-RUNBOOK.md).

### Caching, and why reports can still be slow

Feeds cache for ~4 hours, keyed by org + report + **the encoded parameter
string** — so every distinct date window is its own entry, and a window someone
types by hand is a guaranteed cold run.

Cold runs are genuinely slow: several Metabase cards sit at 30–100s, because
every table in the `materialized` schema has exactly one index (its primary
key), so an org-scoped read is a full scan. Prewarm keeps the common windows
warm; the reports show a **progress bar** whose estimate is the 80th percentile
of that org+report's own recent cache misses.

## Running it

```bash
npm install
npm start          # http://localhost:3100
```

With no `STORE_DATABASE_URL` it runs in disk mode against `data/`, which needs
no external services beyond Metabase.

### Environment

| Variable | Notes |
|---|---|
| `METABASE_URL` | e.g. `https://rec.metabaseapp.com` |
| `DASHBOARD_PASSWORD` | gates `/` and the admin APIs; **absent = admin APIs fail closed** |
| `STORE_DATABASE_URL` | engages the Postgres store. Absent ⇒ disk mode |
| `STORE_MODE` | `disk` \| `dual` \| `db` |
| `DATA_DIR` | local state root (default `./data`) |
| `SLACK_WEBHOOK_URL` | activity feed — **muted outside production** on purpose |
| `ANTHROPIC_API_KEY` | AI insights, chat, the report wizard |
| `RESEND_API_KEY` | email subscriptions |
| `MB_*_UUID` | per-feature public card UUIDs |

## Tests

```bash
npm test                            # the spec suite
node scripts/ci-check-render.js     # drives every page in a real browser
node scripts/verify-report-live.js --manifest scripts/report-cards.manifest.json
```

Three of those matter more than they look:

- **`ci-check-render.js` is the only check that runs the pages.** `node --check`,
  the HTML parse check and the boot check all pass on a page that renders a
  blank white screen — which has reached production twice. It boots the server,
  drives Chromium at every page with stubbed feeds, and fails on an uncaught
  error or an empty body.
- **`verify-report-live.js` hits Metabase's public endpoint directly**, so no app
  cache can hide a card that has stopped answering. Run it after every card
  change, against the *heaviest* org. **Run it alone** — a concurrent query makes
  it invent timeouts on cards you never touched.
- **`ci-check-admin-js.js`** — the admin dashboard is one giant template literal
  inside `server.js`, so a stray apostrophe silently discards the whole script
  block and every button stops working. `node --check` cannot see it.

## Deployment

Railway builds from the **`Dockerfile`** (despite the service config reporting
`RAILPACK` — the build log is the authority). `main` deploys to production
automatically; opening a PR creates an isolated preview environment at
`https://rental-report-rental-report-pr-<N>.up.railway.app`.

`fonts-noto-color-emoji` in the Dockerfile is load-bearing, not decoration:
`fonts-liberation` has zero emoji coverage, and without it every emoji in every
server-rendered PDF is a tofu box. It is invisible in development because every
dev machine has an emoji font.

## Working on this

Read [`CLAUDE.md`](CLAUDE.md) first. It is the long-form record of what has been
measured, what was tried and rejected, and which traps have bitten more than
once. Most of what looks like an obvious improvement here has a paragraph
explaining why it is not.
