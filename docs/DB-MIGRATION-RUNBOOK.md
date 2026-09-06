# Moving off the volume — the engage runbook

**What this buys:** deploys stop being an outage. Today `numReplicas: 1` plus a
Railway volume at `/data` makes every deploy stop-then-start *by construction* —
a volume attaches to a single instance, so the old and new containers cannot run
at once and no health check can hide the gap.

**What it is not:** the health check (`/healthz`, green in a second or two), the
disk cache surviving a restart (`hydrateCacheFromDisk`) and the paced prewarm are
all already fine. Do not go looking there.

Everything below is already merged and **inert**: with no database URL the server
runs in `disk` mode, which is byte-identical to the behaviour before any of this
existed. The flip is a sequence of environment changes, each reversible without
a code change.

---

## Before you start

- **Service:** `rental-report` (`7ee6e149-bd03-41db-bd42-aa8a751b1000`) in
  Railway project **lucid-possibility** (`37e39bf4-114d-446f-b7e3-5a8cedc7fafd`).
- **Production URL:** `https://rental-report-production-a046.up.railway.app`
  (there is no `reports.rec.us`).
- Have `GET /api/admin/store` open in a tab, behind the admin password. It is the
  one place that says what the store actually **did**, as opposed to what the
  environment **asked for** — a store that quietly fell back to the volume and
  one that never had a URL look identical from outside.

Each step names what to check and how to undo it. Do not move on until the check
passes.

---

## Step 1 — provision Postgres

Add a Postgres service to the project. Railway injects `DATABASE_URL` into *that*
service, not into `rental-report`, so copy the value across as
**`STORE_DATABASE_URL`** on `rental-report`.

> `STORE_DATABASE_URL` is read first, `DATABASE_URL` second. Prefer the explicit
> name: a bare `DATABASE_URL` landing on this service later for some unrelated
> reason would otherwise engage the store on its own.

**Do not set it yet.** Provision, note the URL, continue.

---

## Step 2 — `dual`: write both, read the volume

On `rental-report`:

```
STORE_DATABASE_URL = <the Postgres URL>
STORE_MODE         = dual
STORE_IMPORT       = 1
```

The service restarts. On boot it creates its three tables, then starts copying
the volume in **in the background, after the server is already listening** —
config blobs, the event log, and the warm feed cache. From then on it writes to
**both** while still **reading the volume**, so the volume stays the authority
and nothing in this step can lose data.

> The import runs after `listen` on purpose. The first attempt at this flip
> awaited it *before* `listen`, inserting 82k events one row at a time; the
> healthcheck never went green, Railway killed the container, and because a
> volume forces stop-then-start the old one was already gone. That was a five
> minute production outage. It is batched now and never blocks the healthcheck —
> and it is why `STORE_IMPORT=1` is honoured only in `dual`: importing while
> reads already come from Postgres is the one ordering with no safe fallback.

**Check** — `GET /api/admin/store`:

```json
{ "mode": "dual", "ready": true, "keys": 30, "events": 82000, "errors": 0 }
```

- `ready: true` — it connected. `"mode": "disk"` here means it fell back; the
  reason is in the boot log as `[store] configure: …`.
- `keys` ≈ the number of `.json` files on the volume.
- `events` ≈ the line count of `events.jsonl`. **This climbs for a minute or two
  after boot** — the import runs behind the live server. Let it settle;
  `[store] import: {...}` in the logs is the completion line.
- `errors: 0`.

Then open two or three reports and the admin dashboard. Everything should look
exactly as it did — because it is still reading the volume.

**Undo:** remove `STORE_MODE` and `STORE_DATABASE_URL`. Back to disk, instantly.

**Run the import from the LIVE server**, not from a boot flag:

```
curl -X POST '<production URL>/api/admin/store/import' \
  -H 'Content-Type: application/json' \
  -d '{"password":"<the admin dashboard password>"}'
```

It answers with the counts — `{"keys":N,"skipped":0,"events":M,"cache":C,"errors":[]}`
— and logs `[store] import: {...}`. Idempotent for config and the cache: neither
overwrites a row that already exists.

**The event resume is count-based**, so it only works when `events` holds
nothing but rows a previous import of this file put there. If the table has
stray rows the import skips that many of the file's OLDEST lines. Add
`"resetEvents": true` to truncate the table first and re-import the whole log —
opt-in, never the default, because truncating an event log by accident is
unrecoverable.

**In `dual`, events are written to the VOLUME, not to Postgres.** The volume is
the authority in this mode and it is what `readEvents` reads, so the log keeps
growing where the readers look. Postgres gets the whole log once, when you run
the import. (The first version of this took the record in dual too — events went
to Postgres, nothing read them, and the volume's log silently stopped growing.)

**A residual gap, named rather than discovered:** events logged between the
import and the restart into `db` land on the volume only. Run the import as the
last thing before flipping, and on a quiet morning that is a handful of rows.

---

## Step 3 — `db`: read Postgres, keep writing the volume

```
STORE_MODE   = db
STORE_IMPORT = (remove)
```

Reads now come from Postgres. The volume keeps receiving every write, so it stays
a current backup and rolling back is one variable.

**Check:**

- `/api/admin/store` reports `"mode": "db"`, `errors: 0`.
- Feature flags on the admin dashboard read correctly.
- A report page loads and its **Data as of** stamp is recent — that proves the
  feed cache came back from the store rather than being rebuilt.
- Change one per-org report setting, reload, confirm it stuck.
- `/api/admin/report-activity` still shows orgs as active and `failsafe: false`.
  That reads the event log, so it is the check that the log came across; a
  `failsafe: true` means it is reading an empty log.

**Undo:** `STORE_MODE = dual`. The volume is still current.

Leave it here as long as you like. Everything after this is about replicas, and
nothing above needs them.

---

## Step 4 — detach the volume, raise replicas

The step that actually removes the downtime, and the only one that costs a
restart of its own.

1. Detach the volume from `rental-report`.
2. Set `numReplicas: 2`.

`DATA_DIR` now points at each container's own ephemeral disk. That is deliberate:
writes still go there, they are simply no longer read across containers.

**Check:**

- Two replicas healthy.
- Deploy a trivial change and watch — requests should be served throughout.
- Add a test org on one replica; the other should resolve it within a few seconds
  (the store polls every 4s and folds `orgs.json` back into `ORGS`).
- Next morning: **exactly one** daily Slack digest, and one prewarm cycle in the
  logs. Every scheduled job takes a `pg_try_advisory_xact_lock`.

**Undo:** `numReplicas: 1` and re-attach the volume. The data is in Postgres
either way; the volume will be stale by however long it was detached, which is
why `dual` — not `db` — is the mode to roll back *to* if you also want the volume
current again.

---

## What changes, and what does not

| | before | after |
|---|---|---|
| deploys | stop-then-start | rolling |
| config, event log, feed cache | the volume | Postgres, shared |
| a new container | starts with the volume's warm cache | starts with the **platform's** warm cache |
| crons and prewarm | once (one instance) | once (advisory lock) |
| `cache-access.json` | on the volume, survives deploys | **per container**, resets |
| `announce-images/` | on the volume | **still on disk** |

**Two deliberate exceptions.**

- **`cache-access.json` stays on disk.** It is a per-replica heuristic — which
  reports are worth holding resident in *this* container's memory — not shared
  state. Two replicas each writing a full snapshot of their own access log into
  one row every five minutes would simply overwrite each other. The cost is that
  the hint resets when a container is replaced. The feed cache itself is shared,
  so what resets is a memory-residency preference, not warm data.
- **`announce-images/` stays on disk**, because it is binary and does not belong
  in a `jsonb` column. **Consequence: announcement images uploaded before the
  volume is detached will 404 afterwards.** Either re-upload them after step 4,
  or keep the volume attached to a single replica until they move to object
  storage. This is the one piece of real data the migration does not carry, and
  it is named here rather than discovered.

**The daily gist backup follows the store.** In `db` mode it backs up what
Postgres holds rather than walking the container's directory — otherwise it would
quietly start capturing one replica's fraction of the platform's state, which is
worse than an obviously broken backup.

---

## If something looks wrong

| symptom | look at |
|---|---|
| `/api/admin/store` says `mode: disk` with a URL set | the boot log — `[store] configure: …` names the connection failure. The server falls back on purpose rather than failing to boot. |
| a setting saves and then reverts | `errors` on `/api/admin/store`, then the `[store] flush …` lines |
| an org is unknown on one replica | it should self-heal within ~4s; if not, look for `[store] pollKv` errors |
| two Slack digests | a replica could not take the advisory lock and failed **open** — deliberate, because a database blip must not silently stop the watchdogs. Check `[cron]` warnings |
| a report shows another window's numbers | not this. `feedCacheKey` includes the encoded parameter string, so every window is its own entry |

---

## Guards

```
node scripts/store.spec.js        # the module (49 assertions)
node scripts/store-live.spec.js   # the wiring, through a real server (29)
```

Both **skip the database half with a message** when `STORE_TEST_URL` is unset,
rather than passing — a spec that reports success without having connected is the
warm-cache sign-off this repo already has a rule about. The disk half of
`store-live` still runs without a database, because "disk mode is unchanged" is
the claim that matters on every PR.

To run them here:

```
STORE_TEST_URL='postgres://user@host:5432/scratch?sslmode=disable' \
  node scripts/store.spec.js && node scripts/store-live.spec.js
```

---

## Not in this change

**The API and semantic-layer flip.** That sits behind `fetchMBDirect` (21 call
sites) and is separate work, deliberately sequenced after this one for two
measured reasons:

- Every table in the `materialized` schema has exactly one index, its primary
  key. Going direct today inherits the same sequential scans *without* the 4-hour
  cache hiding them — the finding that killed the Report Wizard.
- A direct connection is only safe once the cache is shared. With two replicas
  and a per-container cache, every miss doubles.

Both are fixed by the steps above, which is what makes that flip cheaper
afterwards than it would be now.
