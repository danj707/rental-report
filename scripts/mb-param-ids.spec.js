#!/usr/bin/env node
/* ============================================================================
 * mb-param-ids.spec.js — a stale Metabase parameter id must not take a report
 * down for an hour.
 *
 * WHY IT EXISTS. Metabase's public card endpoint binds a supplied parameter by
 * the card's own registered `id`, so server.js resolves those ids from each
 * card's public definition and caches them for an hour. SAVING A CARD IN
 * METABASE REGENERATES THEM — which is the routine end of every card change in
 * this repo, the date-tag flip a programmatic push always needs included.
 *
 * Measured 2026-09-01 on the Waitlist report (card 19273): prewarm warmed 15
 * orgs at 22:10, the card was re-saved minutes later, and from then until the
 * cache entry expired EVERY org's live request came back
 *
 *   HTTP 400 {"error_type":"missing-required-parameter",
 *             "error":"Cannot run the query: missing required parameters: #{\"org_id\"}"}
 *
 * while the card itself answered a hand-built request with the current id
 * perfectly. It self-heals on the TTL, which is the worst shape a bug can have:
 * long enough to be reported, gone before anyone looks. A tag that is NOT marked
 * required hides the same staleness — Metabase substitutes by target and nobody
 * notices — so this only bites on required tags, at random, months apart.
 *
 * WHAT THIS PINS: a 400 naming a missing required parameter is evidence about
 * the CACHE, not the card. Drop the entry, re-resolve, retry once — and retry
 * ONLY then, because a heavy card must not be queried twice for a timeout.
 *
 * It LIFTS AND RUNS the real wrapper against a fake Metabase rather than
 * regexing it: a regex passes on an inverted comparison. (The nightStateFrom
 * lesson.)
 * ==========================================================================*/
"use strict";

const fs = require("fs");
const path = require("path");

const SERVER = path.join(__dirname, "..", "server.js");
const src = fs.readFileSync(SERVER, "utf8");

let pass = 0;
const failures = [];
const ok = (c, m) => { c ? pass++ : failures.push(m); };
const eq = (g, w, m) => ok(g === w, m + " — got " + JSON.stringify(g) + ", want " + JSON.stringify(w));

// ── lift the real block ────────────────────────────────────────────────────
const START = "const _origFetch = globalThis.fetch.bind(globalThis);";
const END   = "globalThis.fetch = async function (resource, init) {";
const a = src.indexOf(START);
const b = src.indexOf(END);
if (a < 0 || b < 0) {
  console.error("✗ mb-param-ids.spec.js — could not find the parameter-id block in server.js");
  process.exit(1);
}
// Take everything from the block's start to the end of the wrapper function.
let i = src.indexOf("{", b + END.length - 1), depth = 0, end = -1;
i = src.indexOf("{", b + END.indexOf("{"));
for (let j = i; j < src.length; j++) {
  if (src[j] === "{") depth++;
  else if (src[j] === "}") { depth--; if (depth === 0) { end = j; break; } }
}
let block = src.slice(a, end + 1);

// Two edits so the block can run under the spec's control rather than the
// process's: the real fetch is injected, and the wrapper is RETURNED instead of
// installed globally (installing it would replace the spec's own fetch).
block = block
  .replace(START, "const _origFetch = __fetch;")
  .replace(END, "const wrapped = async function (resource, init) {");

let wrapped = null, meta = null;
try {
  const H = new Function("__fetch", "__METABASE_URL", `
    const METABASE_URL = __METABASE_URL;
    ${block};
    return { wrapped, _cardParamMeta, getCardParamMeta, enrichMetabaseCardUrl };
  `);
  // built per-case below
  meta = H;
  pass++;
} catch (e) {
  failures.push("the parameter-id block THREW when lifted: " + e.message);
}

// ── a fake Metabase ────────────────────────────────────────────────────────
const MB = "https://mb.test";
const UUID = "fff0027f-be52-4f99-adfa-b21dd5605634";
const OLD_ID = "11111111-1111-1111-1111-111111111111";
const NEW_ID = "22222222-2222-2222-2222-222222222222";

function res(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    clone() { return { text: async () => body }; },
    text: async () => body,
    json: async () => JSON.parse(body),
    _body: body,
  };
}
const MISSING = JSON.stringify({
  status: "failed",
  error: 'Cannot run the query: missing required parameters: #{"org_id"}',
  error_type: "missing-required-parameter",
});
const TIMEOUT = JSON.stringify({ status: "failed", error: "canceling statement due to statement timeout" });

// `defId` is what the card's definition currently reports; `goodId` is the id
// the query endpoint will actually accept. Setting them apart is what makes a
// stale cache reproducible.
function build({ defId, goodId, defFails = false }) {
  const calls = { defs: 0, queries: [] };
  const fake = async (url) => {
    if (url.includes("/query/json")) {
      calls.queries.push(url);
      const sentId = (/%22id%22%3A%22([^%]+)%22/.exec(url) || [, null])[1];
      if (sentId === goodId) return res(200, '{"rows":[[1]]}');
      return res(400, MISSING);
    }
    calls.defs++;
    if (defFails) return res(500, "nope");
    return res(200, JSON.stringify({
      id: 19273,
      parameters: [{ id: defId, slug: "org_id", type: "string/=", target: ["variable", ["template-tag", "org_id"]] }],
    }));
  };
  const H = meta(fake, MB);
  return { H, calls };
}

const PARAMS = encodeURIComponent(JSON.stringify(
  [{ type: "string/=", target: ["variable", ["template-tag", "org_id"]], value: "org-uuid" }]));
const QUERY_URL = `${MB}/api/public/card/${UUID}/query/json?parameters=${PARAMS}`;

(async function () {
  if (!meta) return;

  // 1 — the base behaviour: the id is resolved and stamped.
  {
    const { H, calls } = build({ defId: NEW_ID, goodId: NEW_ID });
    const r = await H.wrapped(QUERY_URL);
    eq(r.status, 200, "an id-less request is stamped from the card's definition and answers");
    eq(calls.queries.length, 1, "...in exactly one query");
  }

  // 2 — THE BUG AS IT SHIPPED. The cache holds the pre-save id; the card now
  // reports a new one. Without the retry every org's request fails for an hour.
  {
    const { H, calls } = build({ defId: NEW_ID, goodId: NEW_ID });
    H._cardParamMeta.set(UUID, { ts: Date.now(), byTag: new Map([["org_id", OLD_ID]]) });
    const r = await H.wrapped(QUERY_URL);
    eq(r.status, 200,
       "A RE-SAVED CARD MUST NOT TAKE THE REPORT DOWN: a stale id is re-resolved and the query retried");
    eq(calls.queries.length, 2, "...at the cost of exactly one extra query");
    ok(/%22id%22%3A%2222222222/.test(calls.queries[1] || ""), "...and the retry carries the CURRENT id");
  }

  // 3 — a 400 that is not about parameters must cost ONE query. A heavy card
  // that timed out must never be asked twice; that is how a slow report becomes
  // a down one.
  //
  // THE FIXTURE HAS TO PUT A STALE ID IN THE CACHE TOO, or it cannot tell the
  // two apart: with fresh ids a body-blind retry re-resolves to the SAME url and
  // the same-ids guard silently rescues it, so the mutation survives. Found by
  // mutation, not by review — plausible is not the same as discriminating.
  {
    const calls = { defs: 0, queries: [] };
    const H = meta(async (url) => {
      if (url.includes("/query/json")) { calls.queries.push(url); return res(400, TIMEOUT); }
      calls.defs++;
      return res(200, JSON.stringify({ id: 1, parameters: [{ id: NEW_ID, slug: "org_id", type: "string/=", target: ["variable", ["template-tag", "org_id"]] }] }));
    }, MB);
    H._cardParamMeta.set(UUID, { ts: Date.now(), byTag: new Map([["org_id", OLD_ID]]) });
    const r = await H.wrapped(QUERY_URL);
    eq(r.status, 400, "a statement timeout is still a 400 to the caller");
    eq(calls.queries.length, 1, "A TIMEOUT IS NOT A STALE ID — the heavy card is not queried a second time");
  }

  // 4 — a 404 is a card that is gone, and a 5xx is Metabase itself. Neither is
  // evidence about our cached ids.
  for (const [status, label] of [[404, "a deleted or unshared card"], [503, "Metabase itself"]]) {
    const calls = { queries: [] };
    const H = meta(async (url) => {
      if (url.includes("/query/json")) { calls.queries.push(url); return res(status, MISSING); }
      return res(200, JSON.stringify({ id: 1, parameters: [{ id: NEW_ID, slug: "org_id", type: "string/=", target: ["variable", ["template-tag", "org_id"]] }] }));
    }, MB);
    await H.wrapped(QUERY_URL);
    eq(calls.queries.length, 1, label + " is not retried, whatever the body says");
  }

  // 5 — the card is genuinely refusing: it wants a parameter we do not send, and
  // re-resolution yields the same ids. One query, not two.
  {
    const { H, calls } = build({ defId: NEW_ID, goodId: "never-matches" });
    const r = await H.wrapped(QUERY_URL);
    eq(r.status, 400, "a card that really is refusing still refuses");
    eq(calls.queries.length, 1,
       "SAME IDS AFTER RE-RESOLVING MEANS THE CARD IS THE PROBLEM — no second query");
  }

  // 6 — the definition read fails during the retry. Firing an id-less query is a
  // request whose answer we already know.
  {
    const calls = { queries: [] };
    let defCalls = 0;
    const H = meta(async (url) => {
      if (url.includes("/query/json")) { calls.queries.push(url); return res(400, MISSING); }
      defCalls++;
      // first read succeeds (populating the stale entry), the retry's read fails
      if (defCalls > 1) return res(500, "nope");
      return res(200, JSON.stringify({ id: 1, parameters: [{ id: OLD_ID, slug: "org_id", type: "string/=", target: ["variable", ["template-tag", "org_id"]] }] }));
    }, MB);
    await H.wrapped(QUERY_URL);
    eq(calls.queries.length, 1,
       "a failed definition read does not become an UNSTAMPED retry — that query cannot succeed");
  }

  // 7 — everything else passes through untouched, including the card-definition
  // read itself. A wrapper that recursed on its own lookup would hang.
  {
    let seen = null;
    const H = meta(async (url) => { seen = url; return res(200, "{}"); }, MB);
    await H.wrapped("https://example.com/anything");
    eq(seen, "https://example.com/anything", "a non-Metabase fetch is passed through verbatim");
    await H.wrapped(`${MB}/api/public/card/${UUID}`);
    eq(seen, `${MB}/api/public/card/${UUID}`, "...and so is a card-definition read, so there is no recursion");
  }

  // ── source: the pieces the behaviour above depends on ────────────────────
  ok(/function invalidateCardParamMeta\(/.test(src),
     "the invalidation is a named function, not an inline delete buried in the wrapper");
  ok(/resp\.status !== 400/.test(src),
     "the retry is gated on 400 specifically");
  ok(/resp\.clone\(\)\.text\(\)/.test(src),
     "the error body is read from a CLONE — consuming the response would hand the caller an empty body");
  ok(src.indexOf("if (resp.ok) return resp;") > 0,
     "a successful response is returned without being cloned or inspected");

  if (failures.length) {
    console.error("\n✗ mb-param-ids.spec.js — " + failures.length + " failure(s):\n");
    failures.forEach(f => console.error("  ✗ " + f));
    console.error("\n" + pass + " passed, " + failures.length + " failed.\n");
    process.exit(1);
  }
  console.log("✓ mb-param-ids.spec.js — " + pass + " assertions passed.");
})();
