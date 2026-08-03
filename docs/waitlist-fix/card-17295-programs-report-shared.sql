-- Card 17295: ✅ Programs Report (shared, {{org_id}}-parameterized — SHARED_UUIDS.programs)
-- v4 (waitlist demand metrics) — 2026-08-03
-- Changes from v3 (additive only; existing columns/CTEs untouched):
--   - New wl CTE over the waitlist table (post-schema-change canonical table):
--     active entries, all-time entries, and joiners who later enrolled in the
--     same section (confirmed booking created at/after their waitlist join)
--   - New spr LATERAL: section default price (for demand $)
--   - Four new output columns appended: waitlist_active, waitlist_total,
--     waitlist_converted, waitlist_demand ($ = active waitlist × default price)
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
class_activities AS (
  SELECT
    ca.class_id,
    COALESCE(STRING_AGG(DISTINCT a.name, ', ' ORDER BY a.name), 'Uncategorized') AS activity_name,
    COALESCE(STRING_AGG(DISTINCT cat.name, ', ' ORDER BY cat.name), 'Uncategorized') AS category_name
  FROM class_activity ca
  JOIN activity a ON a.id = ca.activity_id
    AND a.organization_id = (SELECT org_id FROM cfg) AND a.deleted_at IS NULL
  LEFT JOIN category cat ON cat.id = a.category_id
    AND cat.organization_id = (SELECT org_id FROM cfg) AND cat.deleted_at IS NULL
  WHERE ca.deleted_at IS NULL
  GROUP BY ca.class_id
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
      /* --- lifetime totals (unchanged) --- */
      SUM(CASE WHEN pmt.status = 'succeeded' THEN oit.amount ELSE 0 END) AS succeeded_cents,
      SUM(CASE WHEN pmt.status = 'canceled'  THEN oit.amount ELSE 0 END) AS canceled_cents,
      SUM(CASE WHEN oit.refund_id IS NOT NULL THEN oit.amount ELSE 0 END) AS refund_cents,

      /* --- period-scoped: only transactions within selected date range --- */
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
                  ELSE COALESCE(pp.pending_cents,0) END) AS pending_cents
  FROM cfg
  JOIN item_collected ic ON TRUE
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(ppi.amount_cents) FILTER (WHERE ppi.paid_at IS NULL AND ppi.waived_at IS NULL),0) AS pending_cents
    FROM payment_plan_installment ppi
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
/* --- waitlist demand (v4 NEW) ---
   waitlist is the canonical table (section_waitlist is a compat view over it).
   Active = not canceled, not deleted. Converted = the participant later holds a
   confirmed booking for the same section, created at/after their waitlist join. */
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
  /* --- lifetime revenue (unchanged) --- */
  ROUND(COALESCE(f.charged_cents,0)/100.0,2)                                AS charged,
  ROUND(COALESCE(f.received_cents,0)/100.0,2)                               AS received,
  ROUND(COALESCE(f.pending_cents,0)/100.0,2)                                AS outstanding,
  ROUND(COALESCE(f.refund_cents,0)/100.0,2)                                 AS refunds,
  ROUND((COALESCE(f.received_cents,0)-COALESCE(f.refund_cents,0))/100.0,2)  AS net_total,
  /* --- period-scoped revenue --- */
  ROUND(COALESCE(f.period_received_cents,0)/100.0,2)                                          AS period_received,
  ROUND(COALESCE(f.period_refund_cents,0)/100.0,2)                                            AS period_refunds,
  ROUND((COALESCE(f.period_received_cents,0)-COALESCE(f.period_refund_cents,0))/100.0,2)      AS period_net,
  /* --- waitlist demand (v4 NEW) --- */
  COALESCE(wl.waitlist_active,0)                                                              AS waitlist_active,
  COALESCE(wl.waitlist_total,0)                                                               AS waitlist_total,
  COALESCE(wl.waitlist_converted,0)                                                           AS waitlist_converted,
  ROUND(COALESCE(wl.waitlist_active,0) * COALESCE(spr.price,0) / 100.0, 2)                    AS waitlist_demand
FROM cfg
JOIN section s ON s.organization_id = cfg.org_id AND s.deleted_at IS NULL
JOIN program p ON p.id = s.program_id AND p.organization_id = cfg.org_id AND p.deleted_at IS NULL
JOIN organization o ON o.id = cfg.org_id
LEFT JOIN LATERAL (
  SELECT MIN(se.starts_at) AS first_start, MAX(se.ends_at) AS last_end
  FROM session se
  WHERE se.section_id = s.id AND se.organization_id = cfg.org_id
    AND se.deleted_at IS NULL AND se.canceled_at IS NULL
) sd ON TRUE
LEFT JOIN LATERAL (
  SELECT season.name AS season_name
  FROM section_season ss JOIN season ON season.id = ss.season_id
       AND season.organization_id = cfg.org_id AND season.deleted_at IS NULL
  WHERE ss.section_id = s.id AND ss.organization_id = cfg.org_id AND ss.deleted_at IS NULL
  ORDER BY season.name LIMIT 1
) si ON TRUE
LEFT JOIN LATERAL (
  SELECT sp.price
  FROM section_price sp
  WHERE sp.section_id = s.id AND sp.type = 'default' AND sp.deleted_at IS NULL
  ORDER BY sp.price DESC
  LIMIT 1
) spr ON TRUE
LEFT JOIN class_activities ca_agg ON ca_agg.class_id = s.class_id
LEFT JOIN sec_fin f ON f.section_id = s.id
LEFT JOIN slots    ON slots.section_id = s.id
LEFT JOIN ppl      ON ppl.section_id = s.id
LEFT JOIN wl       ON wl.section_id = s.id
WHERE s.organization_id = cfg.org_id AND s.deleted_at IS NULL
  [[ AND (sd.first_start IS NULL OR (sd.first_start AT TIME ZONE cfg.tz)::date <= {{end_date}}::date) ]]
  [[ AND (sd.last_end   IS NULL OR (sd.last_end   AT TIME ZONE cfg.tz)::date >= {{start_date}}::date) ]]
ORDER BY p.name, s.name
