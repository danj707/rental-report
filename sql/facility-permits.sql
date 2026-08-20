/* ============================================================
   Facility Rental Permits — Metabase card 20230
   ("✅ Facility Rental Permits (posting sheets)")
   Collection 3532, database 4 (Rec-Prod-ReadReplica).
   Variable: {{org_id}}

   Powers the per-row permit button and the "Export Permits" posting sheets on
   the facility rental report.

   WHY THIS IS A SEPARATE CARD: it joins to the facility feed on
   "Reservation ID" — card 17294 emits facility_rental.id under that name, and
   facility_rental_permit.facility_rental_id is the same key. So permits attach
   to schedule rows with NO change to 17294, and therefore no date-tag reset and
   no risk to the most-used report in the app.

   Tag type doesn't matter here: the route echoes back the card's own registered
   parameter types (same approach as card 20197), so an API edit needs no
   re-flip in the Metabase UI.

   ISSUED ONLY. A rental can hold several permit rows — a draft alongside the
   issued one (Goodyear rental 3c61382f has exactly that) — and a draft has no
   working public page, so posting a sheet for one would send staff to a dead
   link. Revoked permits are excluded for the same reason: revoking is precisely
   what turns the public page off.

   The permit code Rec prints is the LAST 8 hex of the permit id, not the first
   — verified against Goodyear permit da1f3fb2-…-50d967747eb8, printed as
   67747EB8.

   The public permit URL takes no auth, which is what makes it safe as a QR on a
   fence post. Confirmed by decoding the QR out of Rec's own permit PDF:
   https://www.rec.us/permits/da1f3fb2-d426-4a8e-926c-50d967747eb8
   ============================================================ */
SELECT
  frp.facility_rental_id                              AS "Reservation ID",
  frp.id                                              AS "Permit ID",
  UPPER(RIGHT(frp.id::text, 8))                       AS "Permit Code",
  'https://www.rec.us/permits/' || frp.id::text       AS "Permit URL",
  -- Rec's own permit page shows a holder line even when the column is null:
  -- it falls back to the rental's customer. Goodyear permit da1f3fb2 stores
  -- NULL and displays "Ramada Rental Club", which is the customer. Resolving it
  -- here rather than in the app keeps the sheet identical to the permit.
  COALESCE(
    NULLIF(BTRIM(frp.permit_holder_name), ''),
    NULLIF(BTRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), '')
  )                                                   AS "Permit Holder",
  NULLIF(BTRIM(frp.purpose_of_use), '')               AS "Purpose",
  NULLIF(BTRIM(frp.details), '')                      AS "Details",
  fr.name                                             AS "Rental Name",
  frp.issued_at                                       AS "Issued At"
FROM facility_rental_permit frp
JOIN facility_rental fr ON fr.id = frp.facility_rental_id
LEFT JOIN users u ON u.id = fr.customer_user_id
WHERE frp.organization_id = {{org_id}}::uuid
  AND frp.status = 'issued'
  AND frp.deleted_at IS NULL
  AND frp.revoked_at IS NULL
ORDER BY frp.issued_at DESC NULLS LAST
