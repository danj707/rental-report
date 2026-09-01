-- 2026-08-10 TABLE-DROP MIGRATION: class/class_activity are being dropped
-- (replaced by program/program_activity, same UUIDs; section.program_id is
-- populated 1:1 with section.class_id). This file is the live card SQL with
-- ONLY that mechanical rename applied - no logic or output changes.
-- Card 17295: ✅ Programs Report — v7 (payment-plan collection method) — 2026-09-01
--
-- v7 APPENDS FOUR COLUMNS AND CHANGES NOTHING ELSE, and it adds NO NEW SCAN:
-- the pp LATERAL inside sec_fin was already reading each order item's
-- payment_plan_installment rows for `pending_cents`, so the collection method
-- comes off a pass the card was already paying for. Same trick as v6.1's fold
-- of the location into sd.
--
--   "autopay_plan_items"  registrations on a payment plan whose plan has
--                         autopay_enabled. Autopay charges a card on file at
--                         each installment date.
--   "manual_plan_items"   registrations on a payment plan WITHOUT it — somebody
--                         has to collect each installment.
--   "autopay_plan_value"  total plan value (every installment, paid and not) on
--   "manual_plan_value"   each side, in dollars.
--
-- THE DENOMINATOR IS PLAN REGISTRATIONS ONLY, and that is the whole point of
-- the shape. `on_autopay` is BOOL_OR over the item's installments, so it is
-- NULL when the item has none — i.e. paid in full, or nothing owed — and such an
-- item is counted on NEITHER side. Somebody who paid up front is not "on manual
-- collection", and folding them in makes the share meaningless.
--
-- Measured on prod before the push: payment_plan carries 58,304 rows with ZERO
-- NULL autopay_enabled (228 true / 58,076 false), and of 76,370 order items
-- with installments ZERO span more than one plan — so BOOL_OR cannot disagree
-- with itself between runs. COALESCE(autopay_enabled, FALSE) makes an
-- unresolvable plan row read as manual, which is the safe direction: it is
-- certainly not proven autopay.
--
-- Verified additive at apex (4,323 sections in sec_fin): the extended LATERAL
-- and a byte-for-byte copy of the original one give pending_cents with ZERO
-- diffs across every section. Figures: 79 autopay items worth $211,200.50
-- against 22,030 manual worth $1,793,561.68 — 10.5% by DOLLARS and 0.4% by
-- COUNT, a 26x gap, because autopay is used for the expensive plans
-- ($2,673 average against $81). Both readings are emitted so neither can be
-- mistaken for the other.
--
-- Card 17295: ✅ Programs Report — v6.1 (location folded into sd) — 2026-09-01
-- v6.1 changes NO OUTPUT. It deletes the sec_loc/sec_loc_agg CTEs and resolves
-- the location inside the sd LATERAL that was already scanning each section's
-- sessions for the date envelope, so the org's sessions are read once instead
-- of twice. Verified before the push: 5,858 apex sections, ZERO diffs on
-- first_start, last_end, location_name and location_count.
--
-- Card 17295: ✅ Programs Report — v6 (location + instructor) — 2026-08-31
--
-- v6 ADDS FOUR COLUMNS AND CHANGES NOTHING ELSE. Every pre-existing column
-- keeps its name, position and expression, and the four new ones are appended
-- at the END, so a warm 4-hour v5 cache entry and a fresh v6 response are both
-- readable by public/programs.html. The page gates on PRESENCE of the column,
-- never on its value (see progHasLocation there) — same rule as
-- mbHasProductKind / ciHasStatus.
--
--   "location"          the section's primary location NAME, resolved from its
--                       sessions. session.location_id is EITHER a court (site)
--                       id OR a location id — card 17298 already resolves it
--                       both ways and this mirrors that exactly. NULL when the
--                       section has no located session; the page renders
--                       "Unassigned" rather than inventing one.
--   "location_count"    distinct resolved locations for the section. A section
--                       CAN span more than one, so "location" alone would be a
--                       confident half-truth. Measured platform-wide: 287 of
--                       42,457 sections with a located session span >1 (0.7%),
--                       and ZERO of those collapse to a single building — so
--                       this is a real edge case, not a main case, and the page
--                       marks it rather than hiding it.
--                       "Primary" is the location holding the most sessions,
--                       ties broken by name so two runs cannot disagree.
--   "instructor"        comma-joined facilitator names.
--                       THE JOIN PATH IS section_facilitator → instructor →
--                       users, via instructor.user_id. facilitator_id points at
--                       instructor.id, NOT users.id: joining it straight to
--                       users matches 0 of 34,070 rows platform-wide and, as a
--                       LEFT JOIN, would render an empty Instructor column for
--                       every org without erroring. The expression is lifted
--                       VERBATIM from card 17755 (Instructor Payout) so the two
--                       reports cannot print different names for one section.
--   "instructor_count"  distinct facilitators, so the page can say "+2 more"
--                       instead of silently truncating.
--
-- None of the four can fan out a row: location comes from the per-section sd
-- LATERAL (one row by construction) and instructor from an aggregate keyed by
-- section_id. Verify before signing off: row count identical with and without
-- them.
--
-- Card 17295: ✅ Programs Report — v5 (section_price → pricing_policy) — 2026-08-05
-- Changes from v4: replaced section_price lateral join (spr) with inline
-- section.pricing_policy->'default'->>'cents' jsonb accessor.
-- section_price table being dropped by Long Nguyen.
/* ============================================================
   Programs Report — v3 (period-scoped revenue)
   Changes from v2:
   - Added period_succeeded_cents / period_refund_cents to item_tx
     scoped to {{start_date}}..{{end_date}} by payment.created_at
     and refund.created_at respectively
   - Bubbled period columns through item_collected → sec_fin
   - Three new output columns: period_received, period_refunds,
     period_net — cash-basis revenue within the selected date range
   ============================================================ */
WITH cfg AS (
  SELECT o.id AS org_id,
         COALESCE(
            (SELECT l.timezone
               FROM location l
              WHERE l.organization_id = o.id
                AND l.deleted_at IS NULL
                AND l.timezone <> 'UTC'
              GROUP BY l.timezone
              ORDER BY COUNT(*) DESC
              LIMIT 1),
            'America/New_York'
         ) AS tz
  FROM organization o
  WHERE o.id = {{org_id}}::uuid
),
program_activities AS (
  SELECT
    ca.program_id,
    COALESCE(STRING_AGG(DISTINCT a.name, ', ' ORDER BY a.name), 'Uncategorized') AS activity_name,
    COALESCE(STRING_AGG(DISTINCT cat.name, ', ' ORDER BY cat.name), 'Uncategorized') AS category_name
  FROM program_activity ca
  JOIN activity a ON a.id = ca.activity_id
    AND a.organization_id = (SELECT org_id FROM cfg) AND a.deleted_at IS NULL
  LEFT JOIN category cat ON cat.id = a.category_id
    AND cat.organization_id = (SELECT org_id FROM cfg) AND cat.deleted_at IS NULL
  WHERE ca.deleted_at IS NULL
  GROUP BY ca.program_id
),
bk AS (
  SELECT b.id AS booking_id, COALESCE(b.section_id, se.section_id) AS section_id
  FROM cfg
  JOIN booking b      ON b.organization_id = cfg.org_id AND b.deleted_at IS NULL
  LEFT JOIN session se ON se.id = b.session_id AND se.organization_id = cfg.org_id AND se.deleted_at IS NULL
),
item_tx AS (
  SELECT bk.section_id, oi.id AS item_id, oi.payment_plan,
         COALESCE((oi.applied_pricing->'result'->>'finalCents')::numeric,0) AS final_cents,
         COALESCE(t.succeeded_cents,0)        AS succeeded_cents,
         COALESCE(t.canceled_cents,0)         AS canceled_cents,
         COALESCE(t.refund_cents,0)           AS refund_cents,
         COALESCE(t.period_succeeded_cents,0) AS period_succeeded_cents,
         COALESCE(t.period_refund_cents,0)    AS period_refund_cents
  FROM cfg
  JOIN bk ON TRUE
  JOIN order_item oi ON oi.booking_id = bk.booking_id
       AND oi.organization_id = cfg.org_id AND oi.deleted_at IS NULL AND oi.parent_order_item_id IS NULL
  JOIN "order" o ON o.id = oi.order_id AND o.organization_id = cfg.org_id AND o.deleted_at IS NULL
  LEFT JOIN LATERAL (
    SELECT
      SUM(CASE WHEN pmt.status = 'succeeded' THEN oit.amount ELSE 0 END) AS succeeded_cents,
      SUM(CASE WHEN pmt.status = 'canceled'  THEN oit.amount ELSE 0 END) AS canceled_cents,
      SUM(CASE WHEN oit.refund_id IS NOT NULL THEN oit.amount ELSE 0 END) AS refund_cents,
      SUM(CASE WHEN pmt.status = 'succeeded'
                AND (pmt.created_at AT TIME ZONE (SELECT tz FROM cfg))::date >= {{start_date}}::date
                AND (pmt.created_at AT TIME ZONE (SELECT tz FROM cfg))::date <= {{end_date}}::date
           THEN oit.amount ELSE 0 END) AS period_succeeded_cents,
      SUM(CASE WHEN oit.refund_id IS NOT NULL
                AND (r.created_at AT TIME ZONE (SELECT tz FROM cfg))::date >= {{start_date}}::date
                AND (r.created_at AT TIME ZONE (SELECT tz FROM cfg))::date <= {{end_date}}::date
           THEN oit.amount ELSE 0 END) AS period_refund_cents
    FROM order_item_transaction oit
    LEFT JOIN payment pmt ON pmt.id = oit.payment_id
    LEFT JOIN refund r    ON r.id = oit.refund_id
    WHERE oit.order_item_id = oi.id
      AND oit.organization_id = cfg.org_id
      AND oit.deleted_at IS NULL
  ) t ON TRUE
  WHERE bk.section_id IS NOT NULL
),
item_collected AS (
  SELECT section_id, item_id, payment_plan, final_cents, refund_cents,
         CASE WHEN succeeded_cents >= final_cents
              THEN succeeded_cents
              ELSE succeeded_cents + canceled_cents END AS collected_cents,
         period_succeeded_cents,
         period_refund_cents
  FROM item_tx
),
sec_fin AS (
  SELECT ic.section_id,
         SUM(ic.final_cents)            AS charged_cents,
         SUM(ic.collected_cents)        AS received_cents,
         SUM(ic.refund_cents)           AS refund_cents,
         SUM(ic.period_succeeded_cents) AS period_received_cents,
         SUM(ic.period_refund_cents)    AS period_refund_cents,
         SUM(CASE WHEN ic.payment_plan IS NULL
                  THEN GREATEST(ic.final_cents - ic.collected_cents, 0)
                  ELSE COALESCE(pp.pending_cents,0) END) AS pending_cents,
         -- ── v7: how the plan money gets collected ──
         -- IS TRUE / IS FALSE, never a bare test: pp.on_autopay is NULL for an
         -- item with no installments at all, and such an item belongs on
         -- neither side. That NULL is the denominator decision.
         COUNT(*) FILTER (WHERE pp.on_autopay IS TRUE)                        AS autopay_plan_items,
         COUNT(*) FILTER (WHERE pp.on_autopay IS FALSE)                       AS manual_plan_items,
         COALESCE(SUM(pp.plan_cents) FILTER (WHERE pp.on_autopay IS TRUE),0)  AS autopay_plan_cents,
         COALESCE(SUM(pp.plan_cents) FILTER (WHERE pp.on_autopay IS FALSE),0) AS manual_plan_cents
  FROM cfg
  JOIN item_collected ic ON TRUE
  -- ONE PASS over the item's installments for the outstanding balance AND the
  -- collection method. pending_cents keeps its exact original expression and
  -- filter; the two v7 aggregates read the same rows, so no existing figure can
  -- move (proven at apex: 4,323 sections, zero pending_cents diffs against a
  -- copy of the pre-v7 lateral).
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(ppi.amount_cents) FILTER (WHERE ppi.paid_at IS NULL AND ppi.waived_at IS NULL),0) AS pending_cents,
           COALESCE(SUM(ppi.amount_cents),0)                                                             AS plan_cents,
           BOOL_OR(COALESCE(pl.autopay_enabled, FALSE))                                                  AS on_autopay
    FROM payment_plan_installment ppi
    LEFT JOIN payment_plan pl ON pl.id = ppi.payment_plan_id
    WHERE ppi.order_item_id = ic.item_id AND ppi.organization_id = cfg.org_id
  ) pp ON TRUE
  GROUP BY ic.section_id
),
slots AS (
  SELECT per_sess.section_id,
         SUM(per_sess.filled)::int   AS filled_capacity,
         SUM(per_sess.capacity)::int AS total_capacity,
         COUNT(*)::int               AS session_count
  FROM (
    SELECT se.id AS session_id, se.section_id,
           COALESCE(se.capacity, sec0.capacity) AS capacity,
           COUNT(sp.user_id) AS filled
    FROM cfg
    JOIN session se   ON se.organization_id = cfg.org_id AND se.deleted_at IS NULL AND se.canceled_at IS NULL
    JOIN section sec0 ON sec0.id = se.section_id AND sec0.organization_id = cfg.org_id AND sec0.deleted_at IS NULL
    LEFT JOIN (
      SELECT DISTINCT bx.session_id, bx.user_id
      FROM (
        SELECT sess.id AS session_id, b.participant_user_id AS user_id
        FROM cfg
        JOIN booking b   ON b.organization_id = cfg.org_id AND b.deleted_at IS NULL AND b.canceled_at IS NULL
                         AND b.status = 'confirmed' AND b.type = 'section' AND b.section_id IS NOT NULL
        JOIN session sess ON sess.section_id = b.section_id AND sess.organization_id = cfg.org_id
                         AND sess.deleted_at IS NULL AND sess.canceled_at IS NULL
        UNION ALL
        SELECT b.session_id, b.participant_user_id
        FROM cfg
        JOIN booking b ON b.organization_id = cfg.org_id AND b.deleted_at IS NULL AND b.canceled_at IS NULL
                       AND b.status = 'confirmed' AND b.type = 'session' AND b.session_id IS NOT NULL
      ) bx
    ) sp ON sp.session_id = se.id
    GROUP BY se.id, se.section_id, COALESCE(se.capacity, sec0.capacity)
  ) per_sess
  GROUP BY per_sess.section_id
),
ppl AS (
  SELECT bs.section_id, COUNT(DISTINCT bs.participant_user_id) AS enrolled_people
  FROM (
    SELECT b.participant_user_id, COALESCE(b.section_id, se.section_id) AS section_id
    FROM cfg
    JOIN booking b      ON b.organization_id = cfg.org_id AND b.deleted_at IS NULL
                        AND b.canceled_at IS NULL AND b.status = 'confirmed'
    LEFT JOIN session se ON se.id = b.session_id AND se.organization_id = cfg.org_id AND se.deleted_at IS NULL
  ) bs
  WHERE bs.section_id IS NOT NULL
  GROUP BY bs.section_id
),
wl AS (
  SELECT COALESCE(w.section_id, se.section_id) AS section_id,
         COUNT(DISTINCT w.participant_user_id) FILTER (WHERE w.canceled_at IS NULL) AS waitlist_active,
         COUNT(DISTINCT w.participant_user_id)                                      AS waitlist_total,
         COUNT(DISTINCT w.participant_user_id) FILTER (
           WHERE EXISTS (
             SELECT 1
             FROM booking b2
             LEFT JOIN session se2 ON se2.id = b2.session_id AND se2.deleted_at IS NULL
             WHERE b2.organization_id = cfg.org_id
               AND b2.deleted_at IS NULL AND b2.canceled_at IS NULL
               AND b2.status = 'confirmed'
               AND b2.participant_user_id = w.participant_user_id
               AND COALESCE(b2.section_id, se2.section_id) = COALESCE(w.section_id, se.section_id)
               AND b2.created_at >= w.created_at
           )
         ) AS waitlist_converted
  FROM cfg
  JOIN waitlist w ON w.organization_id = cfg.org_id AND w.deleted_at IS NULL
  LEFT JOIN session se ON se.id = w.session_id AND se.organization_id = cfg.org_id AND se.deleted_at IS NULL
  WHERE COALESCE(w.section_id, se.section_id) IS NOT NULL
  GROUP BY COALESCE(w.section_id, se.section_id)
),
-- ── v6.1: the location CTEs are GONE — folded into the sd LATERAL below.
-- v6 resolved a section's location in its own full-org CTE, which scanned every
-- one of the org's sessions a SECOND time: sd was already reading each section's
-- sessions for the date envelope. Measured at apex (36,921 sessions): the CTE
-- cost 4.7s on its own, on a card that already ran 45-140s and had started
-- timing out past the app's own 60s+120s ceiling. One pass gives both.
-- Proven identical before the push: 5,858 apex sections, ZERO diffs on
-- first_start, last_end, location_name and location_count.
sec_fac AS (
  SELECT sf.section_id,
         STRING_AGG(DISTINCT BTRIM(REGEXP_REPLACE(CONCAT_WS(' ', u.first_name, u.last_name), '\s+', ' ', 'g')), ', ') AS instructor_names,
         COUNT(DISTINCT i.id)::int AS instructor_count
  FROM cfg
  JOIN section_facilitator sf ON sf.organization_id = cfg.org_id AND sf.deleted_at IS NULL
  JOIN instructor i           ON i.id = sf.facilitator_id
                             AND i.organization_id = cfg.org_id AND i.deleted_at IS NULL
  JOIN users u                ON u.id = i.user_id
  GROUP BY sf.section_id
)
SELECT
  o.name AS "Org Name",
  p.id   AS program_id,
  p.name AS program,
  s.id   AS section_id,
  s.name AS section,
  CASE WHEN s.canceled_at IS NOT NULL THEN 'Canceled'
       WHEN sd.first_start IS NULL    THEN 'Upcoming'
       WHEN sd.first_start > NOW()    THEN 'Upcoming'
       WHEN sd.last_end   < NOW()     THEN 'Past'
       ELSE 'In Progress' END AS section_status,
  COALESCE(si.season_name,'No Season')                     AS program_season,
  TO_CHAR(sd.first_start AT TIME ZONE cfg.tz,'YYYY-MM-DD')  AS start_date,
  TO_CHAR(sd.last_end    AT TIME ZONE cfg.tz,'YYYY-MM-DD')  AS end_date,
  COALESCE(ca_agg.activity_name, 'Uncategorized')          AS activity_name,
  COALESCE(ca_agg.category_name, 'Uncategorized')          AS category_name,
  COALESCE(ppl.enrolled_people,0)                          AS enrolled,
  CASE WHEN COALESCE(slots.total_capacity,0)=0 THEN COALESCE(slots.filled_capacity,0)
       WHEN s.registration_mode='per-session' THEN slots.filled_capacity
       WHEN slots.session_count>0             THEN slots.filled_capacity / slots.session_count
       ELSE slots.filled_capacity END                      AS utilized,
  CASE WHEN COALESCE(slots.total_capacity,0)=0 THEN NULL
       WHEN s.registration_mode='per-session' THEN slots.total_capacity
       WHEN slots.session_count>0             THEN slots.total_capacity / slots.session_count
       ELSE slots.total_capacity END                       AS capacity,
  CASE WHEN COALESCE(slots.total_capacity,0)=0 THEN NULL
       ELSE ROUND(slots.filled_capacity::numeric / slots.total_capacity * 100, 1) END AS fill_pct,
  ROUND(COALESCE(f.charged_cents,0)/100.0,2)                                AS charged,
  ROUND(COALESCE(f.received_cents,0)/100.0,2)                               AS received,
  ROUND(COALESCE(f.pending_cents,0)/100.0,2)                                AS outstanding,
  ROUND(COALESCE(f.refund_cents,0)/100.0,2)                                 AS refunds,
  ROUND((COALESCE(f.received_cents,0)-COALESCE(f.refund_cents,0))/100.0,2)  AS net_total,
  ROUND(COALESCE(f.period_received_cents,0)/100.0,2)                                          AS period_received,
  ROUND(COALESCE(f.period_refund_cents,0)/100.0,2)                                            AS period_refunds,
  ROUND((COALESCE(f.period_received_cents,0)-COALESCE(f.period_refund_cents,0))/100.0,2)      AS period_net,
  COALESCE(wl.waitlist_active,0)                                                              AS waitlist_active,
  COALESCE(wl.waitlist_total,0)                                                               AS waitlist_total,
  COALESCE(wl.waitlist_converted,0)                                                           AS waitlist_converted,
  ROUND(COALESCE(wl.waitlist_active,0) * COALESCE((s.pricing_policy->'default'->>'cents')::int,0) / 100.0, 2) AS waitlist_demand,
  -- ── v6 additions, APPENDED so v5 cache entries stay readable ──
  sd.location_name                  AS location,
  COALESCE(sd.location_count, 0)    AS location_count,
  sfx.instructor_names              AS instructor,
  COALESCE(sfx.instructor_count, 0) AS instructor_count,
  -- ── v7 additions, APPENDED so v6 cache entries stay readable ──
  COALESCE(f.autopay_plan_items, 0)                  AS autopay_plan_items,
  COALESCE(f.manual_plan_items, 0)                   AS manual_plan_items,
  ROUND(COALESCE(f.autopay_plan_cents,0)/100.0,2)    AS autopay_plan_value,
  ROUND(COALESCE(f.manual_plan_cents,0)/100.0,2)     AS manual_plan_value
FROM cfg
JOIN section s ON s.organization_id = cfg.org_id AND s.deleted_at IS NULL
JOIN program p ON p.id = s.program_id AND p.organization_id = cfg.org_id AND p.deleted_at IS NULL
JOIN organization o ON o.id = cfg.org_id
-- ONE PASS PER SECTION for the date envelope AND the location. The inner
-- GROUP BY deliberately does NOT drop rows whose location is NULL — the
-- min/max must see every session — so the NULLs are excluded at the OUTER
-- aggregate with FILTER instead. location_count therefore counts distinct
-- LOCATED locations, exactly as the old CTE's COUNT(*) over its groups did.
-- Primary = most sessions, ties broken by name so two runs cannot disagree.
LEFT JOIN LATERAL (
  SELECT MIN(g.mn) AS first_start,
         MAX(g.mx) AS last_end,
         (ARRAY_AGG(g.loc ORDER BY g.n DESC, g.loc)
            FILTER (WHERE g.loc IS NOT NULL))[1] AS location_name,
         COUNT(g.loc)::int                       AS location_count
  FROM (
    SELECT COALESCE(lf.name, ld.name) AS loc,
           COUNT(*)                   AS n,
           MIN(se.starts_at)          AS mn,
           MAX(se.ends_at)            AS mx
    FROM session se
    -- session.location_id is EITHER a court (site) id or a location id.
    -- Resolve both, exactly as card 17298 does — reading only one side
    -- silently loses every section scheduled the other way.
    LEFT JOIN court    ct ON ct.id = se.location_id AND ct.deleted_at IS NULL
    LEFT JOIN location lf ON lf.id = ct.location_id AND lf.deleted_at IS NULL
    LEFT JOIN location ld ON ld.id = se.location_id AND ld.deleted_at IS NULL
    WHERE se.section_id = s.id AND se.organization_id = cfg.org_id
      AND se.deleted_at IS NULL AND se.canceled_at IS NULL
    GROUP BY COALESCE(lf.name, ld.name)
  ) g
) sd ON TRUE
LEFT JOIN LATERAL (
  SELECT season.name AS season_name
  FROM section_season ss JOIN season ON season.id = ss.season_id
       AND season.organization_id = cfg.org_id AND season.deleted_at IS NULL
  WHERE ss.section_id = s.id AND ss.organization_id = cfg.org_id AND ss.deleted_at IS NULL
  ORDER BY season.name LIMIT 1
) si ON TRUE
LEFT JOIN program_activities ca_agg ON ca_agg.program_id = s.program_id
LEFT JOIN sec_fin f ON f.section_id = s.id
LEFT JOIN slots    ON slots.section_id = s.id
LEFT JOIN ppl      ON ppl.section_id = s.id
LEFT JOIN wl       ON wl.section_id = s.id
LEFT JOIN sec_fac     sfx ON sfx.section_id = s.id
WHERE s.organization_id = cfg.org_id AND s.deleted_at IS NULL
  [[ AND (sd.first_start IS NULL OR (sd.first_start AT TIME ZONE cfg.tz)::date <= {{end_date}}::date) ]]
  [[ AND (sd.last_end   IS NULL OR (sd.last_end   AT TIME ZONE cfg.tz)::date >= {{start_date}}::date) ]]
ORDER BY p.name, s.name
