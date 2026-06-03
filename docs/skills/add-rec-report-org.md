---
name: add-rec-report-org
description: "Add a new organization to the rec.us rental report platform by updating server.js and pushing to GitHub (which auto-deploys to Railway). Use this skill whenever the user wants to onboard a new org or client, add a new city/department to the rental reports, says anything like 'add [org] to the reports', 'new client', 'onboard [city]', 'set up reports for [org]', or wants to add a new entry to the ORGS map in server.js. Handles the full workflow: collecting org details interactively, generating an access token, patching server.js, logging the change, and pushing to GitHub."
---

# Add New Org to Rental Report Server

## Overview

This skill adds a new organization to the `ORGS` map in `server.js`, generates its
access token, logs the change in the dashboard Updates feed, and pushes to GitHub —
which triggers an automatic Railway redeploy.

**Repo:** `danj707/rental-report`
**File to update:** `server.js`
**Deploy:** Railway auto-deploys on push to `main`

> **CRITICAL — every org MUST have a `token`.** The per-org auth gate in `server.js`
> fails **closed**: `if (!org.token) return res.status(404)…` — a tokenless org
> returns a generic 404 on *every* `/:org/*` route, so the org is completely
> unreachable (not exposed — just broken) until it has a token. Never finish
> onboarding an org without a `token` field. (See Step 2.5.)

> **Note — there is also a self-serve path.** The dashboard has an "Add org" UI that
> writes to `data/orgs.json` (merged into `ORGS` at startup). This skill is the
> *code* path: editing `server.js` directly and pushing. Use the code path when the
> user asks you to add the org, or when you need report types the UI doesn't offer.

---

## Step 1 — Collect Info Interactively

Use `ask_user_input_v0` to gather everything needed. Ask in **two rounds**.

### Round 1 — Org identity

**First, look up the org UUID from Rec — don't ask the user to paste it.** A pasted
UUID can be perfectly well-formed yet *wrong* (e.g. a facility UUID, or another org's
UUID); that sails through any format check and silently scopes the report to the wrong
or empty org. Sourcing the UUID from Rec eliminates that whole class of error.

1. Ask the user for the org's **name** (plus city/state if useful to disambiguate).
2. Call `Rec MCP:search_organizations` with that query. It returns published orgs as
   `{ id, slug, name, displayName }`.
3. **One clear match** → use its `id` as the **Org UUID**, and its `displayName` as a
   sensible default for the Display name field below. (Do *not* reuse Rec's `slug` as
   the ORGS slug — Rec slugs are long-form like `city-of-norman`; keep the ORGS slug
   short, see below.)
4. **Multiple matches** → present them (name + state) and let the user choose.
5. **No match** (org not yet published in Rec search) → fall back to asking for the
   UUID directly, and validate its format before accepting it:
   ```bash
   node -e "process.exit(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(process.argv[1])?0:1)" "$ORG_UUID" \
     && echo "valid UUID" || echo "INVALID — do not use"
   ```

Then ask for the remaining identity fields together:
- **Org slug** — lowercase, no spaces, used in URLs (e.g. `windham`, `clarksville`). The key in the ORGS map. Keep it short — this is *your* slug, not Rec's long-form one.
- **Logo URL** — the full image URL from the rec.us CDN
- **Display name** (optional) — overrides the name shown in the UI when it differs from the slug (e.g. `Littleton PRCE`, `Town of Danvers`, `Windham Parks and Recreation`). The Rec `displayName` from the lookup is usually a good fit. Omit if the auto-generated `"{Slug} Parks & Recreation"` name is fine.

### Round 2 — Report types

For each report type, ask whether it's enabled and (if yes) the Metabase public question UUID. Use `null` (or just omit the line) for any report not being enabled yet.

Current report types (from `REPORT_TYPES` in `server.js`):

| key | report |
|---|---|
| `facility` | Weekly Rental Schedule (most orgs have this) |
| `gl` | GL Code Rollup |
| `historic` | Historic Buildings / special venue report |
| `programs` | Program enrollments |
| `roster` | Program/section roster |
| `products` | Product / merchandise sales |
| `memberships` | Membership report |
| `court-utilization` | Court utilization (stacked bar) |
| `overview` | **Internal/aggregate — do NOT offer for self-serve onboarding** (it's in `NON_ADDABLE_REPORTS`). Only add if the user explicitly asks. |

**Tip:** Enable whatever the org has and omit the rest — the landing page and startup log only show report keys with a non-null `mbUuid`.

---

## Step 2 — Build the ORGS Entry

Construct the JS object to insert. Field order matches existing entries: `token`
first, then `orgId`, `logoUrl`, optional `displayName`, then one line per enabled
report. Template:

```js
  {SLUG}: {
    token:   "{GENERATED_TOKEN}",
    orgId:   "{ORG_UUID}",
    logoUrl: "{LOGO_URL}",
    displayName: "{DISPLAY_NAME}",   // omit this line entirely if no custom name
    facility: { mbUuid: "{FACILITY_MBUUID}" },
    gl:       { mbUuid: "{GL_MBUUID}" },
    // ...one line per enabled report...
  },
```

Rules:
- `token` is **required** (see Step 2.5). Quoted string.
- UUID values are quoted strings; an unset report is `{ mbUuid: null }` or simply omitted.
- Only include `displayName` if the user gave one (bare omit it otherwise).
- Match existing indentation: 2-space indent for the slug key, 4-space for properties.

---

## Step 2.5 — Generate the Access Token

Every org needs a unique 16-character base62 token (matches the style of existing
tokens like `6JmoTcHxMOV3ugyO`). Generate one with Node's crypto:

```bash
node -e "const c=require('crypto');const a='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';let s='';for(let i=0;i<16;i++)s+=a[c.randomInt(a.length)];console.log(s)"
```

Use the output as the `token` value in the entry. **Surface the token to the user**
in your final message — they need it to build the shareable `?token=` URLs and it is
not recoverable from anywhere else without reading `server.js`.

---

## Step 3 — Fetch Current server.js from GitHub

Get the current file + its blob SHA (the SHA is required for the PUT in Step 7).

```bash
curl -s \
  -H "Authorization: token ${GITHUB_TOKEN}" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/danj707/rental-report/contents/server.js"
```

**If `GITHUB_TOKEN` is not set:** use the project PAT, or ask the user for a GitHub
PAT with `repo` (or Contents read/write) scope and `export GITHUB_TOKEN=ghp_...`.
A classic PAT with `repo` scope avoids fine-grained permission issues.

The response JSON has `content` (base64) and `sha` (the blob SHA). Decode:

```bash
echo "${CONTENT_BASE64}" | base64 -d > /tmp/server.js.current
```

> Alternatively, clone over HTTPS — `github.com` works even when `api.github.com`
> is blocked on some networks:
> `git clone --depth 1 https://x-access-token:${GITHUB_TOKEN}@github.com/danj707/rental-report.git`
> If you clone, get the SHA with `git rev-parse HEAD:server.js`.

---

## Step 4 — Patch the ORGS Map

> **The old `// windham:` comment marker no longer exists** — `windham` is now a real
> org entry. Insert the new entry at the **end of the ORGS map**, immediately before
> its closing `};` (which sits right before `const REPORT_TYPES`).

Use Python for safe insertion (avoids shell escaping issues with JS content):

```bash
python3 << 'PYEOF'
with open('/tmp/server.js.current', 'r') as f:
    content = f.read()

new_entry = """  {SLUG}: {
    token:   "{TOKEN}",
    orgId:   "{ORG_UUID}",
    logoUrl: "{LOGO_URL}",
    facility: {{ mbUuid: "{FACILITY}" }},
    gl:       {{ mbUuid: "{GL}" }},
  }},
"""  # build this string from the entry you assembled in Step 2

# Primary marker: the ORGS closing }; immediately before REPORT_TYPES.
import re
m = re.search(r'\n\};\n\nconst REPORT_TYPES', content)
if not m:
    raise SystemExit("Could not find ORGS closing boundary — inspect server.js manually.")
idx = m.start() + 1            # position of the closing }
content = content[:idx] + new_entry + content[idx:]

with open('/tmp/server.js.patched', 'w') as f:
    f.write(content)
print("Patch applied — new entry inserted before ORGS closing };")
PYEOF
```

After patching, **show the user the exact entry that was inserted** and ask for
confirmation before pushing. Sanity-check with `node --check /tmp/server.js.patched`.

> **You do NOT need to touch `reportMeta` / `REPORT_META`.** Those are keyed by
> report *type*, not by org, so adding an org requires no reportMeta edits. (Those
> three-place edits only apply when adding a brand-new report *type*.)

---

## Step 5 — Log the Change in the Updates Feed

Per the standing workflow, add an entry to the top of the `UPDATES` array in
`server.js` (find it with `grep -n "const UPDATES" server.js`). Keep it short and
client-appropriate — this feed is visible on dashboards.

```js
{
  date: "{TODAY_ISO}",
  title: "Welcome, {Display Name}!",
  items: ["{Org} is now live on the reporting platform."],
},
```

Apply this edit to the **same** `/tmp/server.js.patched` (or in the clone) so it ships
in one commit with the ORGS change. Insert it as the first element of the array.

---

## Step 6 — Show the Dancing Banana

Before pushing, call `show_widget` with the dancing banana so the user knows
something is happening. Use this exact widget:

```html
<style>
  @keyframes dance {
    0%   { transform: rotate(-20deg) translateY(0px); }
    25%  { transform: rotate(20deg) translateY(-12px); }
    50%  { transform: rotate(-15deg) translateY(0px); }
    75%  { transform: rotate(15deg) translateY(-8px); }
    100% { transform: rotate(-20deg) translateY(0px); }
  }
  @keyframes shadow-pulse {
    0%, 100% { transform: scaleX(1); opacity: 0.3; }
    25%, 75%  { transform: scaleX(0.6); opacity: 0.15; }
    50%       { transform: scaleX(0.9); opacity: 0.25; }
  }
  @keyframes text-bounce {
    0%, 100% { transform: translateY(0); }
    50%      { transform: translateY(-4px); }
  }
  @keyframes dot-pulse {
    0%, 100% { opacity: 0.2; }
    50%      { opacity: 1; }
  }
  .banana-wrap { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 3rem 0 2rem; gap: 0; }
  .banana { font-size: 72px; animation: dance 0.7s ease-in-out infinite; transform-origin: center bottom; display: block; line-height: 1; filter: drop-shadow(0 8px 16px rgba(0,0,0,0.1)); user-select: none; }
  .shadow { width: 60px; height: 10px; background: var(--color-text-secondary); border-radius: 50%; animation: shadow-pulse 0.7s ease-in-out infinite; margin-top: -4px; }
  .label { margin-top: 2rem; font-size: 15px; font-weight: 500; color: var(--color-text-primary); animation: text-bounce 1.4s ease-in-out infinite; letter-spacing: -0.01em; }
  .sublabel { margin-top: 6px; font-size: 13px; color: var(--color-text-secondary); display: flex; align-items: center; gap: 3px; }
  .dot { width: 4px; height: 4px; border-radius: 50%; background: var(--color-text-secondary); animation: dot-pulse 1.2s ease-in-out infinite; display: inline-block; }
  .dot:nth-child(2) { animation-delay: 0.2s; }
  .dot:nth-child(3) { animation-delay: 0.4s; }
  .dot:nth-child(4) { animation-delay: 0.6s; }
  .bar-track { width: 200px; height: 3px; background: var(--color-border-tertiary); border-radius: 99px; margin-top: 1.5rem; overflow: hidden; }
  @keyframes bar-slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(200%); } }
  .bar-fill { width: 60%; height: 100%; background: var(--color-text-warning, #d97706); border-radius: 99px; animation: bar-slide 1.4s ease-in-out infinite; }
</style>
<div class="banana-wrap">
  <span class="banana">🍌</span>
  <div class="shadow"></div>
  <div class="label">Deploying to Railway</div>
  <div class="sublabel">Pushing to GitHub <span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
  <div class="bar-track"><div class="bar-fill"></div></div>
</div>
```

Call it with `loading_messages: ["Warming up the banana", "Choreographing the moves"]`
and `title: "dancing_banana_deploy"`. Then immediately proceed to the push — don't
wait for user input.

---

## Step 7 — Push to GitHub

Base64-encode the patched file and PUT it via the GitHub Contents API:

```bash
SHA="<sha from Step 3>"
ENCODED=$(base64 -w 0 /tmp/server.js.patched)
REQUEST_BODY=$(python3 -c "
import json
print(json.dumps({
    'message': 'Add {SLUG} org to ORGS map',
    'content': '${ENCODED}',
    'sha': '${SHA}'
}))
")
curl -s -X PUT \
  -H "Authorization: token ${GITHUB_TOKEN}" \
  -H "Accept: application/vnd.github.v3+json" \
  -H "Content-Type: application/json" \
  -d "${REQUEST_BODY}" \
  "https://api.github.com/repos/danj707/rental-report/contents/server.js"
```

A successful response includes a `commit` object with the new SHA. (If you cloned in
Step 3, you can instead `git add server.js && git commit && git push` over the HTTPS
token remote.)

---

## Step 8 — Confirm Deployment

After a successful push:

1. **Report the commit URL** — extract `commit.html_url` and show it.
2. **Hand over the token** — restate the generated `token`; the user needs it for every URL.
3. **Remind about Railway** — auto-deploys on push to `main`, ~1–2 minutes.
4. **Share the tokenized report URLs** (token is required on all `/:org/*` routes):
   - `https://rental-report-production-a046.up.railway.app/{SLUG}?token={TOKEN}` (landing page)
   - `…/{SLUG}/facility?token={TOKEN}` (if enabled)
   - `…/{SLUG}/gl?token={TOKEN}` (if enabled)
   - …one per enabled report.

---

## Notes & Edge Cases

- **Token is mandatory** — see the CRITICAL warning. A missing token = the org 404s on every route (the gate fails closed).
- **Slug already exists:** check the ORGS map before patching; if the slug is present, warn and confirm before overwriting.
- **Metabase UUID format:** `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`. Warn if it looks wrong.
- **Logo URL:** usually a rec.us CDN URL (`prod-rec-tech-img-bucket-*.s3.us-west-1.amazonaws.com`), often wrapped in `https://www.rec.us/_next/image?url=…`. Copy the pattern from an existing org.
- **`displayName`:** add it when the friendly name differs from `"{Slug} Parks & Recreation"` (the auto-generated default).
- **`overview` is non-addable** (`NON_ADDABLE_REPORTS`) — don't offer it in the self-serve flow unless explicitly requested.
- **Don't modify `REPORT_TYPES`** — every report key above is already in it. You only edit `REPORT_TYPES` when inventing a brand-new report type.
- **No reportMeta edits for org adds** — `reportMeta`/`REPORT_META` are keyed by report type, not org.
- **Railway env vars** — no changes needed; the ORGS map is code, not config.
