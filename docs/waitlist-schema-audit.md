# Waitlist schema-change audit (2026-08-03)

## What changed upstream

The `section.waitlist_config` jsonb column (and the identical `session.waitlist_config`)
no longer has the boolean-ish `enabled` key. The new shape, verified against
Rec-Prod-ReadReplica on 2026-08-03, is:

```json
{ "mode": "remain-active | reopen-registration | off", "linkExpirationMinutes": 480 }
```

- `enabled` is present on **zero** rows. Any SQL doing `waitlist_config ->> 'enabled'`
  now returns NULL on every row and silently disables whatever branch/filter used it.
- Observed `mode` values across all non-null section configs (prod-wide):
  `remain-active` 34,051 · `off` 877 · `reopen-registration` 63.
  21,485 sections have `waitlist_config IS NULL` (waitlist never configured → off).
- Session-level configs have the same shape (206,138 rows; `remain-active` 198,425 ·
  `off` 7,170 · `reopen-registration` 543).
- There is also a new `section.waitlist_override` text column (`on` 15 · `off` 143 ·
  NULL otherwise) — a manual per-section override. No report uses it yet; semantics
  should be confirmed with eng before reporting on it.
- Table changes: `waitlist` is the canonical base table (now carries
  `organization_id` and `temporary_grant_id`); `section_waitlist` is now just a
  compatibility **view** over it. No `status` column — active entries are
  `canceled_at IS NULL AND deleted_at IS NULL`.

## Scan scope

All Metabase cards referenced by this app (65 public UUIDs in `server.js`:
per-org `mbUuid`s + `SHARED_UUIDS` + facilities summary). 12 per-org UUIDs are 404
(unpublished/archived) — harmless, since report types with a `SHARED_UUIDS` entry
ignore the per-org UUID anyway. The remaining 53 live cards were pulled and their
native SQL searched for any waitlist reference. Also scanned: this repo's own SQL
(`docs/fasttrack-v5.sql`, `docs/fasttrack-v6.sql`) and all `public/*.html` consumers.

## Findings

### Broken — 5 cards, all the same one-line bug (6 occurrences)

All five compute a `"Status"` output column with:

```sql
(COALESCE(s.waitlist_config, sec.waitlist_config) ->> 'enabled') = 'true'
```

which is now always NULL, so the `Full - Waitlist Open` / `Closed - Full - Waitlist`
branches can never fire. Every full session/section renders as plain `Full` /
`Closed - Full`. No WHERE clauses are affected — display/status only.

| Card | Name | Used by |
|---|---|---|
| 17298 | ✅Calendar Schedule | **SHARED_UUIDS.calendar — all orgs' live Calendar report** (2 occurrences, incl. Closed branch) |
| 16765 | Session Schedule | Apex per-org calendar card (superseded by 17298 in this app, still public) |
| 16897 | Session Schedule - Watertown | per-org, superseded, still public |
| 17161 | Session Schedule - Joplin | per-org, superseded, still public |
| 17302 | Calendar Schedule (Shrewsbury) | per-org, superseded, still public |

Measured impact at audit time: **5,225 upcoming, non-canceled, full sessions**
prod-wide have waitlist mode on and are currently mislabeled.

Front-end knock-on (`public/calendar.html`, schedule views): the Waitlist badge and
the "Waitlist Available" availability filter key off the Status string, so they
show nothing / match nothing — same silent failure the other chat found on the
report side.

### Fix (one-line, same in all 6 spots)

```sql
-- old
AND (COALESCE(s.waitlist_config, sec.waitlist_config) ->> 'enabled') = 'true'
-- new: any configured mode other than 'off' means the waitlist is on;
-- NULL config coalesces to 'off'
AND COALESCE(COALESCE(s.waitlist_config, sec.waitlist_config) ->> 'mode', 'off') <> 'off'
```

`<> 'off'` (rather than `IN ('remain-active','reopen-registration')`) so any future
"on-flavored" mode keeps counting as waitlist-open.

### Not broken — 3 cards + repo SQL

`17194 FT Report`, `17300 ✅ Fast Track Utilization Report`,
`17557 Fast Track Report - Shrewsbury`, and `docs/fasttrack-v5/v6.sql` all count
`"Waitlisted"` from the `waitlist` **table** (filtering `deleted_at`/`canceled_at`
only) and never touch `waitlist_config`. Unaffected.

### Clean — 45 cards

No waitlist reference at all (facility, GL, roster, products, memberships, users,
demographics, retention, payout, check-ins, self-service, etc.).

## Status

- [ ] Apply the mode fix to card 17298 (shared Calendar — the one that matters)
- [ ] Apply the same fix to 16765 / 16897 / 17161 / 17302 (superseded but still public)
- [ ] Decide whether reports should honor `waitlist_override` (confirm semantics with eng)
