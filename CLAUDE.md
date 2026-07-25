# Project notes for Claude

## Working preferences (from Dan, dan@rec.us)

- **Always share the Railway PR-preview URL** whenever I open a PR for this repo,
  without being asked — Dan wants to click through the change before merging.

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

## Dev branch

Feature work for these tasks lives on `claude/facility-report-line-removal-1d0c8k`
(same branch name in both `rental-report` and `rec-dashboard`).
