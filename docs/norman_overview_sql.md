# Norman Facility Overview — Metabase SQL

## Setup

Create a new **Native Query** question in Metabase, paste the SQL below,
configure the two template tags, save, make public, and add the UUID to
`server.js` under `norman.overview.mbUuid`.

**Template tags:**
| Tag | Type | Optional |
|-----|------|---------|
| `start_date` | Date | Yes |
| `end_date` | Date | Yes |

---

## SQL

```sql
WITH

rental_metrics AS (
  SELECT
    r.location_id,
    COUNT(DISTINCT r.id)   AS reservation_count,
    COUNT(DISTINCT fr.id)  AS rental_count,
    COALESCE(SUM((oi.applied_pricing->'result'->>'finalCents')::numeric)/100.0,0) AS rental_revenue
  FROM reservation r
  LEFT JOIN facility_rental fr
    ON fr.id = r.facility_rental_id AND fr.deleted_at IS NULL AND fr.status != 'canceled'
  LEFT JOIN order_item oi
    ON oi.reservation_id = r.id AND oi.deleted_at IS NULL AND oi.parent_order_item_id IS NULL
    AND (oi.applied_pricing->'result'->>'finalCents') IS NOT NULL
  WHERE r.deleted_at IS NULL
    [[ AND lower(r.reservation_timestamp_range)::date >= {{start_date}}::date ]]
    [[ AND lower(r.reservation_timestamp_range)::date <= {{end_date}}::date ]]
  GROUP BY r.location_id
),

-- NOTE: Two-step approach to avoid session fan-out.
-- Step 1 finds DISTINCT sections with sessions in the period.
-- Step 2 joins bookings/revenue once per section (not once per session).
-- Without this split, class revenue is inflated N× where N = sessions/section.
sections_in_range AS (
  SELECT DISTINCT
    sess.location_id,
    sec.id     AS section_id,
    sec.class_id
  FROM session sess
  JOIN section sec ON sec.id = sess.section_id AND sec.deleted_at IS NULL
  JOIN class c
    ON c.id = sec.class_id AND c.deleted_at IS NULL
    AND c.organization_id = '574923bd-9e7b-43e0-9e5f-7ce256189cbf'
  WHERE sess.deleted_at IS NULL AND sess.canceled_at IS NULL
    AND sess.organization_id = '574923bd-9e7b-43e0-9e5f-7ce256189cbf'
    [[ AND sess.starts_at::date >= {{start_date}}::date ]]
    [[ AND sess.starts_at::date <= {{end_date}}::date ]]
),

class_metrics AS (
  SELECT
    sir.location_id,
    COUNT(DISTINCT sir.class_id)    AS class_count,
    COUNT(DISTINCT sir.section_id)  AS section_count,
    COUNT(DISTINCT b.id)            AS enrollment_count,
    COALESCE(SUM((oi.applied_pricing->'result'->>'finalCents')::numeric)/100.0, 0) AS class_revenue
  FROM sections_in_range sir
  LEFT JOIN booking b
    ON b.section_id = sir.section_id AND b.deleted_at IS NULL
    AND b.canceled_at IS NULL AND b.organization_id = '574923bd-9e7b-43e0-9e5f-7ce256189cbf'
  LEFT JOIN order_item oi
    ON oi.booking_id = b.id AND oi.deleted_at IS NULL AND oi.parent_order_item_id IS NULL
    AND (oi.applied_pricing->'result'->>'finalCents') IS NOT NULL
  GROUP BY sir.location_id
),

checkin_metrics AS (
  SELECT
    COALESCE(l_sess.id, l_desk.id) AS location_id,
    COUNT(ae.id) AS checkin_count
  FROM attendance_event ae
  LEFT JOIN session sess
    ON sess.id = ae.target_id AND ae.target_type = 'session' AND sess.deleted_at IS NULL
  LEFT JOIN location l_sess ON l_sess.id = sess.location_id
  LEFT JOIN desk_location_lookup dll ON dll.desk_location_id = ae.desk_location_id
  LEFT JOIN location l_desk ON l_desk.id = dll.location_id
  WHERE ae.organization_id = '574923bd-9e7b-43e0-9e5f-7ce256189cbf'
    AND ae.type = 'check_in'
    [[ AND ae.created_at::date >= {{start_date}}::date ]]
    [[ AND ae.created_at::date <= {{end_date}}::date ]]
  GROUP BY COALESCE(l_sess.id, l_desk.id)
),

store_summary AS (
  SELECT
    COUNT(pp.id) AS store_transactions,
    COALESCE(SUM(pp.quantity), 0) AS items_sold,
    COALESCE(SUM((oi.applied_pricing->'result'->>'finalCents')::numeric)/100.0, 0) AS store_revenue
  FROM product_purchase pp
  JOIN product p ON p.id = pp.product_id AND p.deleted_at IS NULL AND p.type = 'product'
  LEFT JOIN order_item oi
    ON oi.product_purchase_id = pp.id AND oi.deleted_at IS NULL
    AND oi.parent_order_item_id IS NULL
    AND (oi.applied_pricing->'result'->>'finalCents') IS NOT NULL
  WHERE pp.organization_id = '574923bd-9e7b-43e0-9e5f-7ce256189cbf'
    AND pp.deleted_at IS NULL AND pp.canceled_at IS NULL
    [[ AND pp.created_at::date >= {{start_date}}::date ]]
    [[ AND pp.created_at::date <= {{end_date}}::date ]]
),

membership_summary AS (
  SELECT COUNT(*) FILTER (WHERE status = 'active') AS active_memberships
  FROM membership
  WHERE organization_id = '574923bd-9e7b-43e0-9e5f-7ce256189cbf' AND deleted_at IS NULL
)

SELECT
  l.name                                                                AS "Location",
  COALESCE(rm.reservation_count, 0)                                     AS "Reservations",
  COALESCE(rm.rental_count,      0)                                     AS "Rentals",
  COALESCE(rm.rental_revenue,    0)                                     AS "Rental Revenue",
  COALESCE(cm.class_count,       0)                                     AS "Classes",
  COALESCE(cm.section_count,     0)                                     AS "Sections",
  COALESCE(cm.enrollment_count,  0)                                     AS "Enrollments",
  COALESCE(cm.class_revenue,     0)                                     AS "Class Revenue",
  COALESCE(rm.rental_revenue, 0) + COALESCE(cm.class_revenue, 0)        AS "Total Revenue",
  COALESCE(ci.checkin_count,     0)                                     AS "Check-ins",
  ms.active_memberships                                                 AS "Active Memberships",
  ss.items_sold                                                         AS "Items Sold",
  ss.store_revenue                                                      AS "Store Revenue"
FROM location l
LEFT JOIN rental_metrics  rm ON rm.location_id = l.id
LEFT JOIN class_metrics   cm ON cm.location_id = l.id
LEFT JOIN checkin_metrics ci ON ci.location_id = l.id
CROSS JOIN store_summary      ss
CROSS JOIN membership_summary ms
WHERE l.organization_id = '574923bd-9e7b-43e0-9e5f-7ce256189cbf'
  AND l.deleted_at IS NULL
  AND (COALESCE(rm.reservation_count,0) + COALESCE(cm.enrollment_count,0) + COALESCE(ci.checkin_count,0)) > 0
ORDER BY COALESCE(rm.rental_revenue,0) + COALESCE(cm.class_revenue,0) DESC
```

---

## What changed vs initial version

The original `class_metrics` CTE joined `session → section → booking → order_item`
in a single pass. Because a section can have **many sessions** in the date range,
each booking's `order_item` was summed once per session — inflating class revenue
by the average sessions-per-section factor (6–18× depending on location).

The fix uses two CTEs:
1. **`sections_in_range`** — `DISTINCT` sections that have ≥1 session in the period
2. **`class_metrics`** — aggregates bookings and revenue against those sections directly

This eliminates the fan-out entirely while correctly preserving date-range scoping.

**Observed impact (2026 YTD):**

| Location | Old class rev | Fixed class rev | Factor |
|----------|-------------|----------------|--------|
| 12th Ave | $467,240 | $82,553 | 5.7× |
| WFAC | $440,490 | $58,955 | 7.5× |
| Irving | $139,950 | $21,700 | 6.4× |
| Whittier | $75,750 | $9,200 | 8.2× |
| YFAC | $131,919 | $68,549 | 1.9× |

Total class revenue: **$1,259,764 → $245,372** (5.1× reduction)
