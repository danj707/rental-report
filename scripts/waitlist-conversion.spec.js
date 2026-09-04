#!/usr/bin/env node
/* ============================================================================
 * waitlist-conversion.spec.js — the Waitlist report's invite conversion, the
 * `auto` tag, and the definition of a claim.
 *
 * WHY IT EXISTS. Card 19273 inferred a claim from timestamps:
 *
 *     (tg.updated_at > tg.created_at
 *      AND ABS(EXTRACT(EPOCH FROM tg.updated_at - tg.expires_at)) <= 2)
 *
 * "the grant was written to at its expiry moment" — which is what an EXPIRY
 * SWEEP does, not what a claim does. It shipped that way for months and the
 * report's central number was wrong the whole time.
 *
 * THE CLINCHING EVIDENCE, measured 2026-09-01 over 8,529 invites platform-wide:
 * of the 5,371 grants that test called consumed, **5,371 were already expired
 * and ZERO were still open**. A real claim signal catches some invites inside
 * their window; one that never does is not measuring claiming. Supporting: the
 * average created→updated gap on those rows is 114h against an average invite
 * window of 105.8h, while an actual registration lands at a median of 5.3h.
 *
 *   heuristic said claimed             5,371  (63.0%)
 *   actually booked in the window      3,628  (42.5%)   <- the truth
 *   heuristic only, no registration    1,888             <- pure over-count
 *   booked but heuristic missed it       145
 *
 * So conversion read ~20 points high, and Avg/Median Claim Hours plus all six
 * Claim buckets were describing invite-window LENGTHS.
 *
 * WHAT THIS PINS:
 *
 *   1. A claim is a REGISTRATION — a confirmed booking by that participant on
 *      that section, STRICTLY inside the grant's own window. Dropping the upper
 *      bound counts 641 people who came back later by other means, which is the
 *      difference between 42.5% and 50.1%.
 *   2. The timestamp heuristic is GONE, and cannot come back.
 *   3. claimed / expired / outstanding PARTITION offers_sent exactly. They keyed
 *      on `untouched`, so a touched-but-unclaimed grant fell into no bucket and
 *      the parts did not add up. Verified at apex: 2,113 + 2,352 + 10 = 4,475.
 *   4. A rate over a handful of invites is not a rate. Under the floor the page
 *      shows the raw counts — "2 of 2", never "100%".
 *   5. The `auto` tag renders only for 'automated', and is PRESENCE-gated: a
 *      pre-v6 feed has no type at all, and "we cannot tell" must not render as
 *      "a person does this by hand".
 *   6. NO OPEN RATE. temporary_grant.first_viewed_at is populated on 66 of
 *      8,529 invites (0.8%) — dead like memberships.last_used_at.
 *
 * It LIFTS AND RUNS wlConversion rather than regexing it — a regex passes on an
 * inverted comparison. (The nightStateFrom lesson.)
 * ==========================================================================*/
"use strict";

const fs = require("fs");
const path = require("path");

const PAGE = path.join(__dirname, "..", "public", "waitlist.html");
const CARD = path.join(__dirname, "..", "sql", "report-cards", "19273-waitlist-demand.sql");
const src = fs.readFileSync(PAGE, "utf8");
const card = fs.readFileSync(CARD, "utf8");

let pass = 0;
const failures = [];
const ok = (c, m) => { c ? pass++ : failures.push(m); };
const eq = (g, w, m) => ok(g === w, m + " — got " + JSON.stringify(g) + ", want " + JSON.stringify(w));

// Both files QUOTE the broken forms on purpose — the card's header prints the
// old heuristic and the page's comments describe it — so every source assertion
// runs over a comment-stripped copy or it fails on correct code. Same note as
// checkin-status.spec.js and programs-instructor.spec.js.
const code = src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const sql = card.replace(/^\s*--.*$/gm, "");

function liftFn(text, name) {
  const start = text.indexOf("function " + name + "(");
  if (start < 0) throw new Error(name + " not found at module scope — a spec cannot run what it cannot reach");
  let depth = 0, i = text.indexOf("{", start);
  for (; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (depth === 0) break; }
  }
  return text.slice(start, i + 1);
}

let wlConversion = null, WL_CONV_MIN_OFFERS = null;
try {
  const H = new Function(
    "const WL_CONV_MIN_OFFERS = " + (/const WL_CONV_MIN_OFFERS = (\d+)/.exec(src) || [, "5"])[1] + ";\n" +
    liftFn(src, "wlConversion") + "\n" +
    "return { wlConversion, WL_CONV_MIN_OFFERS };")();
  wlConversion = H.wlConversion; WL_CONV_MIN_OFFERS = H.WL_CONV_MIN_OFFERS;
  pass++;
} catch (e) {
  failures.push("wlConversion THREW when lifted: " + e.message);
}

if (wlConversion) {
  // ── the rate itself ──────────────────────────────────────────────────────
  eq(wlConversion(20, 15).pct, 75, "15 of 20 claim links is 75%");
  eq(wlConversion(20, 4).pct, 20, "4 of 20 is 20%");
  eq(wlConversion(8, 0).pct, 0, "A REAL ZERO IS AN ANSWER — eight invites and nobody registered is worth seeing");
  eq(wlConversion(3, 3).pct, null,
     "THE FLOOR: three-of-three is not '100% conversion', it is three people");
  eq(wlConversion(3, 3).thin, true, "...and the caller is told it is thin so it can print the counts");
  eq(wlConversion(3, 3).claimed, 3, "...with the raw counts still available to print");
  eq(wlConversion(3, 3).sent, 3, "...both of them");
  eq(wlConversion(WL_CONV_MIN_OFFERS, 1).thin, false, "the floor is inclusive at its own value");
  eq(wlConversion(0, 0).pct, null, "no invites is not 0% conversion — there was nothing to convert");
  eq(wlConversion(0, 0).thin, false, "...and it is not 'thin' either, it is absent; the caller renders a dash");
  eq(wlConversion(null, null).pct, null, "a missing column does not throw");
  eq(wlConversion(7, 3).pct, 43, "rounding is to whole percent");
  ok(WL_CONV_MIN_OFFERS >= 3, "the floor is a real floor, not 1");
}

// ── the card: a claim is a registration ────────────────────────────────────
ok(!/ABS\(EXTRACT\(EPOCH FROM tg\.updated_at - tg\.expires_at\)\)/.test(sql),
   "THE TIMESTAMP HEURISTIC IS GONE — it was detecting the expiry sweep, not a claim");
ok(!/\buntouched\b/.test(sql),
   "...and so is `untouched`, which left a touched-but-unclaimed grant in no bucket at all");
ok(/\(bk\.booked_at IS NOT NULL\) AS consumed/.test(sql),
   "a claim is a REGISTRATION: consumed is driven by an actual confirmed booking");
ok(/b2\.created_at >= tg\.created_at/.test(sql) && /b2\.created_at <= tg\.expires_at/.test(sql),
   "STRICTLY INSIDE THE WINDOW — dropping the upper bound counts 641 people who came back later by other means");
ok(/b2\.status = 'confirmed'/.test(sql) && /b2\.canceled_at IS NULL/.test(sql),
   "...and only a confirmed, uncancelled booking counts");
ok(/EXTRACT\(EPOCH FROM bk\.booked_at - tg\.created_at\)\/3600\.0 AS hrs/.test(sql),
   "claim TIME is measured to the booking, or the buckets describe invite-window lengths again");

// The three outcomes must partition offers_sent.
ok(/COUNT\(\*\) FILTER \(WHERE NOT t\.consumed AND t\.expired\) AS offers_expired/.test(sql),
   "expired is not-claimed-and-expired");
ok(/COUNT\(\*\) FILTER \(WHERE NOT t\.consumed AND NOT t\.expired\) AS offers_outstanding/.test(sql),
   "outstanding is not-claimed-and-still-open, so the three add up to offers_sent");

ok(/COALESCE\(s\.waitlist_config->>'type', sm\.session_type\) AS "Waitlist Type"/.test(sql),
   "Waitlist Type is emitted, falling back to the session config exactly like Mode");
ok(/se\.waitlist_config->>'type' AS session_type/.test(sql),
   "...and the session lateral actually supplies that fallback");

// NO OPEN RATE.
ok(!/first_viewed_at/.test(sql),
   "nothing is built on first_viewed_at — it is populated on 66 of 8,529 invites (0.8%)");
ok(!/first_viewed_at/.test(code), "...and the page does not reach for it either");

// Every pre-existing output column survives. This card is read by a shipped
// report; a v6 that quietly dropped one would be a regression dressed as a fix.
["Waitlist Mode", "Mode Source", "Link Expiration Min", "Offers Sent", "People Offered",
 "Offers Claimed", "Claimants", "Offers Expired", "Offers Outstanding", "Avg Claim Hours",
 "Median Claim Hours", "Claim 1h", "Claim 48h Plus", "Waitlist Converted", "Pressure %",
 "Est Demand", "Oldest Active Join"].forEach(c => {
  ok(card.indexOf('AS "' + c + '"') >= 0, "the card still emits: " + c);
});
// The trailing ORDER BY is the exact thing that silently vanished on card 17300
// when 641 lines were transcribed and `wc -l` miscounted the last line.
ok(/ORDER BY COALESCE\(wl\.waitlist_active,0\) DESC, p\.name, s\.name\s*$/.test(card.trim()),
   "the trailing ORDER BY survived the push");

// ── the page: the auto tag ─────────────────────────────────────────────────
ok(/wlType:\s*raw\['Waitlist Type'\] \?\? null/.test(code),
   "PRESENCE, NOT A DEFAULT: a pre-v6 feed leaves the type null rather than reading as manual");
ok(/r\.wlType === 'automated' &&/.test(code),
   "the tag renders only for 'automated' — a tag on all 28,161 manual sections stops meaning anything");
ok(/data-wl-auto=/.test(code) && /data-wl-conv=/.test(code) && /data-wl-convthin=/.test(code),
   "the tag and both conversion states carry handles a render case can key on");
ok(/wlConversion\(r\.offersSent, r\.offersClaimed\)/.test(code),
   "the column reads offers SENT and CLAIMED — reading Waitlist Converted instead would answer a different question (registered at any point after joining, not off an invite)");
ok(!/\.autotag[^}]*background:\s*#dcfce7/.test(src),
   "the auto tag is not the green of a working mode pill — it says WHO sends the offer, not whether the waitlist is healthy");

// ── report ─────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error("\n✗ waitlist-conversion.spec.js — " + failures.length + " failure(s):\n");
  failures.forEach(f => console.error("  ✗ " + f));
  console.error("\n" + pass + " passed, " + failures.length + " failed.\n");
  process.exit(1);
}
console.log("✓ waitlist-conversion.spec.js — " + pass + " assertions passed.");
