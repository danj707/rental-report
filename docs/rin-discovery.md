# Rec Instructor Network (RIN) — discovery & reporting proposal

Compiled 2026-08-18 from Slack, Notion, Metabase and live prod (db 4, read replica).
Purpose: inventory everything that exists for RIN today, capture the data-model
nuances, and scope a central cross-org dashboard + a per-city RIN report.

---

## 1. What RIN is

Rec-operated marketplace connecting contracted instructors with players on city
facilities. Rec owns the contractor relationship end-to-end: recruiting,
background checks (Livescan), training, profile setup, payroll/1099s, insurance,
support. Branded as "Rec Instructor Network" since 2025-08-05 (formerly
"Licensed Learning").

**Scale (July 2026, per Mike Kehoe in #rec-instructor-network 2026-08-13):**

| Metric | Value |
|---|---|
| Global GMV, July | $84K (first time over $1M run-rate) |
| Monthly active instructors | 127 |
| San Francisco, July | $55.7K — all-time high, ~+80% YoY |
| Torrance, July | $20.6K — ~+20% YoY |
| 2026 full-year RIN revenue | $656K |

Operating markets: **San Francisco RPD** (largest), **Torrance**, Santa Cruz
County region, Sacramento / West Sacramento region, plus a "hybrid" test at
Watertown. Not currently sold to new partners — limited beta, Rec-operated only
(Mike, #customer-experience 2026-05-14).

**Revenue split (SF, per Mike in #sales-pricing):** instructors keep 75%, city
keeps 12.5%, Rec keeps 12.5%. Standard RIN pricing = implementation fee + Rec and
the city splitting net revenue 50/50 after the instructor's share.

**Qualification bar** (Notion, *Sales Guide to RIN*): facility-dependent activity
(tennis, pickleball, golf, swim), ≥10 sites at 4–6 hrs/day ≥4 days/week, dense
population, 1-on-1 or small-group formats.

---

## 2. Where RIN reporting lives today

### 2.1 Metabase

| Collection / Dashboard | ID | Contents |
|---|---|---|
| `00 Rec Instructor Network` | coll **116** | 57 cards + both dashboards |
| RIN by Org/Region Dashboard | dash **112** | 41 cards — the one ops uses daily |
| Private Lessons + Instructor Management | dash **108** | 11 cards — slot/request hygiene |
| `00 San Francisco Lessons Reporting` | coll **123** | 18 SF-specific cards |
| `00 Torrance Lessons Reporting` | coll **125** | 17 Torrance-specific cards |

Ops-critical cards outside those collections:
- **191** `Ops - Past and Future Schedule V3` — drives payouts
- **458** `Ops - Cancellations to Refund V3.3` — drives refund decisions
- **17755** `✅ Instructor Payout Query` — the shared, org-parameterized card that
  already feeds rental-report (public UUID `a8db6d86-eddc-4511-a28c-ad4bf636859e`)

### 2.2 rental-report (this repo)

- `public/instructor-payout.html` — Instructor Payout report, all orgs (1,180 lines)
- `public/lessons.html` — "Instructor Lessons" report, **SF-only pilot**
  (`LESSONS_REPORT_ORGS`, server.js:1686), 471 lines
- `sql/report-cards/17755-instructor-payout.sql` — the card SQL, v2.1
- Both read the **same** card 17755; no RIN-specific card exists here.

### 2.3 Everything else

- **Airtable** `appYHna6mx2WzrIIk` — lesson roster synced from Metabase cards
  562 / 8093 / 12042; ops edit/delete upcoming lessons here.
- **Google Sheets** — monthly per-org payout workbooks, manually reconciled
  (Lindsay → Jimena review → payment). ~$20K/payout cycle, 2× per month.
- **Notion** — `Rec Instructor Network (RIN)` → Sales Guide, City Deployments,
  Support Centers.

---

## 3. Problems found

### 3.1 The dashboards are structurally fragile

Nearly every revenue chart on dashboard 112 — cards 2544, 2543, 2050, 6205, 577,
612, 624, 991, 827 and more — is a thin MBQL wrapper over **one** shared base
card (portable id `Aq-7x4CfeGdayTKy8-4J3`, an "All Lessons from Private Lessons
and Sections" variant). One breakage in that card takes down the whole dashboard.
That is exactly what happened on 2026-08-13.

Compounding it: there are **at least seven near-duplicate copies** of that same
base query (cards 510, 562, 584, 620, 829, 8093, 12042), differing mainly by date
cutoff and org filter. Fixes have to be applied N times and drift between them.

### 3.2 A dropped table broke the revenue cards — and the pattern is still there

`order_item_reservation_user` **no longer exists** in prod. Card **467**
(`Booked Private Lessons by Instructor - Base Rows`, the revenue base for private
lessons) still references it and errors out. Confirmed live:

```
ERROR: relation "order_item_reservation_user" does not exist
```

**The replacement join is `order_item.booking_id = reservation_user.booking_id`.**
Verified: `reservation_user.booking_id` is 100% populated (798,588 / 798,588 rows
in the last 90 days). `order_item.reservation_id` exists but is *not* the path for
lesson bookings — joining on it returns zero SF lesson rows.

### 3.3 Lesson packs fan out and inflate revenue ~4×

SF lesson packs are sold as one order_item covering many sessions. Joining
order_items to per-session `reservation_user` rows multiplies the pack price by
the session count. Measured for SF, July 2026:

| Stream | Session signups | Distinct bookings | Naive per-session sum | Deduped at order_item |
|---|---|---|---|---|
| `private-lesson` (instant slots) | 274 | 274 | $23,211 | **$23,211** |
| `programmed-class-instructor` (packs) | 378 | 108 | $112,784 | **$28,836** |
| **Total** | | | $135,995 | **$52,047** |

$52.0K deduped vs Mike's reported $55.7K — a ~7% gap explained by refunds,
adjustments/discounts and the exact recognition window. The naive figure is
2.6× too high. This is why the existing base cards carry a hand-rolled
**"net price per session"** column: pack price amortized across sessions.

### 3.4 The rental-report Lessons report misses ~45% of RIN

`server.js:5513` pulls the instructor-payout card (a **programs/sections**
pipeline) and then filters rows by a regex on the program/section name:

```js
const LESSON_RE = /lesson|clinic|coaching|private/i;
```

Two consequences:
- The entire `private-lesson` reservation stream — instructor instant-book slots,
  **$23.2K of SF's $52.0K in July** — is invisible, because those bookings are
  reservations, not section registrations.
- Coverage depends on how someone typed a section name. Anything not matching the
  four keywords silently drops out.

### 3.5 Performance

Ops-facing queries take minutes. Card 458 was measured at "over 3 min to load"
after its rebuild (Dan, 2026-08-17). Dashboard 112 is slow enough that ops
routinely can't tell "slow" from "broken".

### 3.6 Known product gaps feeding bad data

- Instructors cannot create slots longer than 60 min; Jimena **manually edits**
  60→90 min slots in SF every cycle.
- Lessons straddling two 90-min slots aren't detected — Mike asked for a report
  (2026-06-29).
- Refund automations stay "pending review" and are processed by hand (SC County,
  Torrance).
- Payouts are reconciled in Google Sheets with manual cross-checks for
  cancellations and instructor no-shows.
- Open question from Birju (2026-07-28): are instructors creating same-day slots
  to dodge Rec's revenue share?

---

## 4. Data model — how to identify RIN correctly

RIN bookings are **two distinct streams** that must both be counted:

| Stream | `reservation.reservation_type` | Grain | Notes |
|---|---|---|---|
| Instant private lessons | `private-lesson` | 1 booking = 1 session | Instructor-published slots |
| Lesson packs / small group | `programmed-class-instructor` | 1 booking = N sessions | Must amortize price |

Canonical joins as of 2026-08-18:

```sql
reservation r
  JOIN reservation_user ru ON ru.reservation_id = r.id
  LEFT JOIN order_item oi  ON oi.booking_id     = ru.booking_id   -- NEW path
  LEFT JOIN order_item_adjustment adj ON adj.order_item_id = oi.id -- discounts
  LEFT JOIN order_item_transaction oit ON oit.order_item_id = oi.id
       AND oit.confirmed_at IS NOT NULL                            -- collected/refunded
  LEFT JOIN enriched_instructor ei ON ei.instructor_id = r.instructor_id
```

- `reservation.organization_id` is fully populated (0 nulls) — use it directly
  rather than routing through `location`.
- Dedup to **order_item grain** before summing price, then allocate per session.
- Exclude `jessica+.hing@sfgov.org` (SF permit-blocking slots) as card 501 does.
- Watch for orgs mis-tagging their own sections as "Rec Managed" (West Sac,
  flagged by Mike 2026-06-02) — it pollutes global RIN revenue.

**SF org id:** `17380e28-7e02-4b52-82c5-fab18557fd7a`

---

## 5. Proposal

### 5.1 One shared RIN card, org-parameterized

Build `sql/report-cards/NNNNN-rin-lessons.sql` on the pattern already proven by
card 17755: `{{org_id}}` Text + `{{start_date}}` / `{{end_date}}` Date, public
sharing on. One row per booking-session with both streams unioned, price
amortized per session, and billed / collected / refunded side by side.

That single card can back **both** deliverables below, and can replace the seven
duplicate base queries in collection 116.

### 5.2 Per-city RIN report (rental-report, SF first)

A real `rin` report type alongside the existing ones — replacing the regex-based
Lessons report, not sitting next to it:

- Revenue: booked vs collected vs refunded, private vs pack split
- Instructor leaderboard: lessons, distinct students, revenue, cancellation rate
- Court/facility utilization: booked vs published instructor hours, by location
- Student loyalty: repeat rate, lessons per student, lesson-pack conversion
- Slot hygiene: unbooked slots, same-day slot creation, straddling lessons
- Payout preview: per-instructor gross → 75/12.5/12.5 split, exportable

### 5.3 Cross-org RIN dashboard

Same card, no org filter: GMV and MAI by market and month, YoY, market-level unit
economics (revenue per instructor, per court-hour, per student), and a
launch-readiness view against the Notion qualification bar.

### 5.4 Sequencing

1. Fix card 467 and any sibling still on `order_item_reservation_user`.
2. Build + verify the shared RIN card against SF (heaviest org) via
   `scripts/verify-report-live.js` — never sign off on a warm cache.
3. Ship the SF report behind a per-org flag, mirroring `LESSONS_REPORT_ORGS`.
4. Add Torrance, then the cross-org dashboard.
5. Consolidate/archive the duplicate base cards in collection 116.

### 5.5 Open questions for Dan

- Recognize revenue on **purchase date** or **session date**? Mike's $55.7K is
  purchase-date; payouts are session-date. The report probably needs both.
- Should the payout split (75/12.5/12.5) be per-org configurable? Torrance and
  SC County terms are not confirmed here.
- Replace the SF Lessons report outright, or keep it until the RIN report covers
  every chart it has?

---

## 6. People

| Who | Role on RIN |
|---|---|
| Mike Kehoe | Owner — strategy, pricing, market expansion |
| Jimena Prida | SF market ops, payouts, instructor relationships |
| Nazarena | Torrance + Santa Cruz County ops |
| Lindsay Keare | Payout runs, facility coordination |
| Ankur, Long Nguyen | Platform sprint to automate RIN |
| Ceci Badillo, Irving | Scaled-ops support, launch configuration |
