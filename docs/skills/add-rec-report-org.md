---
name: add-rec-report-org
description: "Add a new organization to the rec.us rental report platform by updating server.js and pushing to GitHub (which auto-deploys to Railway). Use this skill whenever the user wants to onboard a new org or client, add a new city/department to the rental reports, says anything like 'add [org] to the reports', 'new client', 'onboard [city]', 'set up reports for [org]', or wants to add a new entry to the ORGS map in server.js. Handles the full workflow: collecting org details interactively, patching server.js, and pushing to GitHub."
---

# Add New Org to Rental Report Server

## Overview

This skill adds a new organization to the `ORGS` map in `server.js` and pushes the change to GitHub, triggering an automatic Railway redeploy.

**Repo:** `danj707/rental-report`  
**File to update:** `server.js`  
**Deploy:** Railway auto-deploys on push to `main`

---

## Step 1 — Collect Info Interactively

Use `ask_user_input_v0` to gather everything needed. Ask in **two rounds** to keep it manageable.

### Round 1 — Org identity

Ask these three together:
- **Org slug** — lowercase, no spaces, used in URLs (e.g. `windham`, `clarksville`). Will be the key in the ORGS map.
- **Org UUID** — the rec.us organization UUID (looks like `460566d3-3a51-4387-a7a0-0b010923e40d`)
- **Logo URL** — the full image URL from the rec.us CDN

### Round 2 — Report types

For each of the three report types, ask whether it's enabled and (if yes) what the Metabase public question UUID is. Present as a multi-step or sequential ask. Use `null` for any report that isn't being enabled yet.

Report types:
- **facility** — Weekly Rental Schedule (most orgs have this)
- **gl** — GL Code Rollup
- **historic** — Historic Buildings / special venue report (Smyrna only so far)

**Tip:** It's fine to enable some and leave others as `null` — the index page and startup log only show non-null reports.

---

## Step 2 — Build the ORGS Entry

Construct the JS object string to insert. Template:

```js
  {SLUG}: {
    orgId:   "{ORG_UUID}",
    logoUrl: "{LOGO_URL}",
    facility: { mbUuid: {FACILITY_MBUUID} },
    gl:       { mbUuid: {GL_MBUUID} },
    {HISTORIC_LINE}
  },
```

Rules:
- UUID values are quoted strings: `"21e74d52-f49a-46d6-bc2d-f9348027854f"`
- Null values are bare: `null` (not quoted)
- Only include the `historic:` line if it has a non-null UUID (to keep things clean — though leaving it as `null` is also fine)
- Use the same indentation/style as existing entries (2-space indent for the key, 4-space for properties)

Example output for a new org "windham" with facility + gl but no historic:
```js
  windham: {
    orgId:   "REPLACE_WITH_ORG_UUID",
    logoUrl: "https://...",
    facility: { mbUuid: "REPLACE_ME" },
    gl:       { mbUuid: "REPLACE_ME" },
  },
```

---

## Step 3 — Fetch Current server.js from GitHub

Use `bash_tool` to call the GitHub Contents API and get the current file + its SHA (required for the PUT).

```bash
curl -s \
  -H "Authorization: token ${GITHUB_TOKEN}" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/danj707/rental-report/contents/server.js"
```

**If `GITHUB_TOKEN` is not set:** Ask the user to provide a GitHub Personal Access Token with `repo` scope. They can create one at https://github.com/settings/tokens. Store it in the shell session: `export GITHUB_TOKEN=ghp_...`

The API response is JSON with:
- `content`: base64-encoded file content
- `sha`: the blob SHA (needed for the PUT)

Decode the content:
```bash
echo "${CONTENT_BASE64}" | base64 -d > /tmp/server.js.current
```

---

## Step 4 — Patch the ORGS Map

Find the insertion point in the file. The new entry goes **before the closing comment block** at the end of the ORGS map. Look for the commented-out `windham` example entry:

```js
  // windham: {
  //   orgId:   "REPLACE_WITH_ORG_UUID",
```

Insert the new org entry **just before** that comment block (or before the `};` closing the ORGS map if there's no comment block). Keep the windham comment in place as a template for future additions.

Use Python for safe string insertion (avoids shell escaping issues with JS content):

```bash
python3 << 'PYEOF'
with open('/tmp/server.js.current', 'r') as f:
    content = f.read()

new_entry = """  {SLUG}: {{
    orgId:   "{ORG_UUID}",
    logoUrl: "{LOGO_URL}",
    facility: {{ mbUuid: {FACILITY} }},
    gl:       {{ mbUuid: {GL} }},
  }},
"""

# Insert before the windham comment (or before closing }; of ORGS)
marker = "  // windham:"
if marker in content:
    content = content.replace(marker, new_entry + marker, 1)
else:
    # Fallback: insert before the closing }; of the ORGS block
    marker2 = "};\n\nconst REPORT_TYPES"
    content = content.replace(marker2, new_entry + "};\n\nconst REPORT_TYPES", 1)

with open('/tmp/server.js.patched', 'w') as f:
    f.write(content)

print("Patch applied successfully")
PYEOF
```

After patching, **show the user the new entry** that was inserted and ask for confirmation before pushing.

---

## Step 5 — Show the Dancing Banana

Before pushing, call `show_widget` with the dancing banana animation so the user knows something is happening. Use this exact widget:

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

Call it with `loading_messages: ["Warming up the banana", "Choreographing the moves"]` and `title: "dancing_banana_deploy"`. Then immediately proceed to the push — don't wait for user input.

---

## Step 6 — Push to GitHub

Base64-encode the patched file and PUT it via the GitHub Contents API:

```bash
# Get the SHA from Step 3
SHA="<sha from API response>"

# Encode the patched file
ENCODED=$(base64 -w 0 /tmp/server.js.patched)

# Build the request body
REQUEST_BODY=$(python3 -c "
import json
print(json.dumps({
    'message': 'Add {SLUG} org to ORGS map',
    'content': '${ENCODED}',
    'sha': '${SHA}'
}))
")

# Push
curl -s -X PUT \
  -H "Authorization: token ${GITHUB_TOKEN}" \
  -H "Accept: application/vnd.github.v3+json" \
  -H "Content-Type: application/json" \
  -d "${REQUEST_BODY}" \
  "https://api.github.com/repos/danj707/rental-report/contents/server.js"
```

A successful response includes a `commit` object with the new SHA. Parse and confirm.

---

## Step 7 — Confirm Deployment

After a successful push:

1. **Report the commit URL** — extract `commit.html_url` from the API response and show it to the user
2. **Remind about Railway** — Railway auto-deploys on push to `main`, typically takes 1-2 minutes
3. **Share the new report URLs** — tell the user their new reports will be live at:
   - `https://rental-report-production-a046.up.railway.app/{SLUG}/facility` (if facility enabled)
   - `https://rental-report-production-a046.up.railway.app/{SLUG}/gl` (if gl enabled)
   - `https://rental-report-production-a046.up.railway.app/{SLUG}/historic` (if historic enabled)

---

## Notes & Edge Cases

- **Slug already exists:** Before patching, check if the slug already exists in the ORGS map. If it does, warn the user and confirm they want to overwrite.
- **Metabase UUID format:** UUIDs should match the pattern `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`. Warn if format looks wrong.
- **Logo URL:** Often a rec.us CDN URL from `prod-rec-tech-img-bucket-*.s3.us-west-1.amazonaws.com`. Can be retrieved from the rec.us admin or from the existing org's `logoUrl` pattern.
- **Don't modify REPORT_TYPES** — adding `historic` for a new org doesn't require changing that array since it already includes it.
- **Railway env vars** — no changes needed; the ORGS map is code, not config.
