// Spec for the two card-level watchdogs added after three false "report down"
// alerts on 2026-08-22.
//
// What went wrong: ORGS still carries per-org `mbUuid`s for reports that were
// later moved onto a shared card. The report routes ignore those entries — a
// shared card wins for every report except `gl` — but the health check probed
// `org[rt].mbUuid` directly. So it graded clarksville/roster, smyrna/roster and
// norman/products against legacy cards that nothing serves (two of which still
// JOIN the dropped `class` table) and alerted on reports that load fine.
//
// resolveReportCard() is now the single answer to "which card does the app
// actually query", and the health check asks it.
//
// The second watchdog covers the failure mode CLAUDE.md has warned about for
// months with nothing watching for it: an API/MCP card edit regenerates every
// template tag as Text, a `start_date` tag stops being a Date, the card errors,
// and the app serves stale cache so the report keeps looking healthy.
//
// Run: node scripts/card-drift.spec.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const SERVER = path.join(__dirname, "..", "server.js");
const src = fs.readFileSync(SERVER, "utf8");

function slice(start, end) {
  const a = src.indexOf(start);
  assert.ok(a > 0, `server.js should contain: ${start}`);
  const b = src.indexOf(end, a);
  assert.ok(b > a, `could not find the end of: ${start}`);
  return src.slice(a, b);
}

// Lift the shipping code, not a copy of it.
const lifted = new Function(
  slice("const ORGS = {", "\nconst REPORT_TYPES") + "\n" +
  slice("const REPORT_TYPES", "\n") + "\n" +
  slice("const SHARED_UUIDS = {", "\n// Which card does the app") + "\n" +
  slice("function resolveReportCard", "\n// Facilities hub") + "\n" +
  slice("const DATE_PARAM_TAGS", "// Every card the app actually serves") + "\n" +
  slice("function collectServedCards", "// The mirror image") + "\n" +
  slice("function collectShadowedCards", "// Pure: given fetched card") + "\n" +
  slice("function diffCardParamTypes", "function cardParamDriftFingerprint") + "\n" +
  slice("function cardParamDriftFingerprint", "async function checkCardParamTypes") + "\n" +
  "return { ORGS, REPORT_TYPES, SHARED_UUIDS, resolveReportCard, collectServedCards,"
  + " collectShadowedCards, diffCardParamTypes, cardParamDriftFingerprint };"
)();
const {
  ORGS, REPORT_TYPES, SHARED_UUIDS, resolveReportCard,
  collectServedCards, collectShadowedCards, diffCardParamTypes, cardParamDriftFingerprint,
} = lifted;

let passed = 0;
function test(name, fn) { fn(); console.log(`  ✓ ${name}`); passed++; }

// ── resolveReportCard: the precedence the data routes actually use ──────────

test("a shared card beats a per-org mbUuid for a non-gl report", () => {
  // clarksville/roster: legacy card ce13ffa2 in ORGS, shared card 31bdf26f served.
  const r = resolveReportCard("clarksville", "roster");
  assert.strictEqual(r.shared, true);
  assert.strictEqual(r.mbUuid, SHARED_UUIDS.roster);
  assert.notStrictEqual(r.mbUuid, ORGS.clarksville.roster.mbUuid);
});

test("gl is the exception — a per-org card wins there", () => {
  const r = resolveReportCard("norman", "gl");
  assert.strictEqual(r.shared, false);
  assert.strictEqual(r.mbUuid, ORGS.norman.gl.mbUuid);
});

test("an org with no card of its own falls through to the shared card", () => {
  const r = resolveReportCard("watertown", "roster");
  assert.strictEqual(r.shared, true);
  assert.strictEqual(r.mbUuid, SHARED_UUIDS.roster);
});

test("a report with no shared card resolves to the org's own", () => {
  const r = resolveReportCard("apex", "ice-calendar");
  assert.strictEqual(r.shared, false);
  assert.strictEqual(r.mbUuid, ORGS.apex["ice-calendar"].mbUuid);
});

test("an unknown org or report resolves to nothing rather than throwing", () => {
  assert.strictEqual(resolveReportCard("nope", "made-up").mbUuid, undefined);
  assert.strictEqual(resolveReportCard("apex", "made-up").mbUuid, undefined);
});

test("the health check resolves the card instead of reading org[rt].mbUuid", () => {
  // The regression that caused the false alerts. If this line comes back, the
  // check starts grading reports against cards nothing serves again.
  const check = slice("async function checkOne({ slug, rt, shared })", "await runChunked(");
  assert.ok(check.includes("resolveReportCard(slug, rt)"),
    "checkOne must resolve the served card");
  assert.ok(!/const mbUuid = shared \? SHARED_UUIDS\[rt\] : org\[rt\]\?\.mbUuid;/.test(check),
    "checkOne must not probe the raw per-org mbUuid");
});

// ── collectServedCards / collectShadowedCards ───────────────────────────────

test("every served card is reachable and every report type is covered", () => {
  const served = collectServedCards();
  // One entry per shared card, plus each per-org card a shared one does not shadow.
  for (const rt of Object.keys(SHARED_UUIDS)) {
    assert.ok(served.has(SHARED_UUIDS[rt]), `shared ${rt} card is not in the served set`);
  }
  for (const slug of Object.keys(ORGS)) {
    for (const rt of REPORT_TYPES) {
      const { mbUuid } = resolveReportCard(slug, rt);
      if (mbUuid) assert.ok(served.has(mbUuid), `${slug}/${rt} serves a card nothing checks`);
    }
  }
});

test("every per-org report key is a REPORT_TYPE, so nothing escapes the sweep", () => {
  // collectServedCards walks REPORT_TYPES. A per-org card filed under a key not
  // in that list would be served and never checked — which is how the apex
  // ice-calendar card would have slipped through.
  for (const [slug, org] of Object.entries(ORGS)) {
    for (const [key, val] of Object.entries(org)) {
      if (!val || typeof val !== "object" || !val.mbUuid) continue;
      assert.ok(REPORT_TYPES.includes(key), `${slug}.${key} is not in REPORT_TYPES`);
    }
  }
});

test("shadowed entries are the per-org cards a shared card replaced", () => {
  const shadowed = collectShadowedCards();
  assert.ok(shadowed.length > 0, "there are known shadowed entries today");
  for (const s of shadowed) {
    assert.strictEqual(s.servedBy, SHARED_UUIDS[s.report]);
    assert.notStrictEqual(s.unused, s.servedBy);
    assert.notStrictEqual(s.report, "gl", "gl is never shadowed");
  }
  // The three that raised false alarms must be in here, not in the served set.
  const key = (o, r) => shadowed.some(s => s.org === o && s.report === r);
  assert.ok(key("clarksville", "roster"));
  assert.ok(key("smyrna", "roster"));
  assert.ok(key("norman", "products"));
  const served = collectServedCards();
  assert.ok(!served.has(ORGS.clarksville.roster.mbUuid), "a shadowed card must not be checked");
});

// ── diffCardParamTypes: the Text-instead-of-Date footgun ────────────────────

const dateParam = (tag, type) => ({
  type, slug: tag, target: ["variable", ["template-tag", tag]],
});

test("date/single on both date tags is clean", () => {
  const d = diffCardParamTypes([{
    mbUuid: "aaaaaaaa", served: ["gl (shared)"],
    parameters: [
      dateParam("start_date", "date/single"),
      dateParam("end_date", "date/single"),
      dateParam("org_id", "string/="),
    ],
  }]);
  assert.deepStrictEqual(d.wrongType, []);
});

test("a date tag reset to Text is caught, and names the tag and the reports", () => {
  const d = diffCardParamTypes([{
    mbUuid: "bbbbbbbb", served: ["clarksville/gl", "norman/gl"],
    parameters: [
      dateParam("start_date", "category"),
      dateParam("end_date", "date/single"),
    ],
  }]);
  assert.strictEqual(d.wrongType.length, 1);
  assert.strictEqual(d.wrongType[0].tag, "start_date");
  assert.strictEqual(d.wrongType[0].type, "category");
  assert.deepStrictEqual(d.wrongType[0].served, ["clarksville/gl", "norman/gl"]);
});

test("string/= on a date tag counts too — Text has more than one spelling", () => {
  const d = diffCardParamTypes([{
    mbUuid: "cccccccc", served: ["roster (shared)"],
    parameters: [dateParam("end_date", "string/=")],
  }]);
  assert.strictEqual(d.wrongType.length, 1);
  assert.strictEqual(d.wrongType[0].tag, "end_date");
});

test("a missing type is reported as (none), not skipped", () => {
  const d = diffCardParamTypes([{
    mbUuid: "dddddddd", served: ["x/y"],
    parameters: [{ slug: "start_date", target: ["variable", ["template-tag", "start_date"]] }],
  }]);
  assert.strictEqual(d.wrongType.length, 1);
  assert.strictEqual(d.wrongType[0].type, "(none)");
});

test("every date/* subtype is accepted, not just date/single", () => {
  for (const t of ["date/single", "date/range", "date/all-options", "date/month-year"]) {
    const d = diffCardParamTypes([{ mbUuid: "e", served: [], parameters: [dateParam("start_date", t)] }]);
    assert.deepStrictEqual(d.wrongType, [], `${t} should be accepted`);
  }
});

test("non-date tags are left alone whatever their type", () => {
  const d = diffCardParamTypes([{
    mbUuid: "ffffffff", served: [],
    parameters: [dateParam("org_id", "string/="), dateParam("section_name", "category")],
  }]);
  assert.deepStrictEqual(d.wrongType, []);
});

test("a card with no parameters at all is not drift", () => {
  assert.deepStrictEqual(diffCardParamTypes([{ mbUuid: "g", served: [], parameters: [] }]).wrongType, []);
  assert.deepStrictEqual(diffCardParamTypes([{ mbUuid: "g", served: [] }]).wrongType, []);
  assert.deepStrictEqual(diffCardParamTypes([]).wrongType, []);
});

test("a tag read off the target wins when slug and target disagree", () => {
  const d = diffCardParamTypes([{
    mbUuid: "hhhhhhhh", served: [],
    parameters: [{ type: "category", slug: "renamed", target: ["variable", ["template-tag", "start_date"]] }],
  }]);
  assert.strictEqual(d.wrongType.length, 1, "the template tag is what the app addresses");
  assert.strictEqual(d.wrongType[0].tag, "start_date");
});

test("DATE_PARAM_TAGS matches the tags the server actually sends as dates", () => {
  // If a third date tag is ever sent, it has to be watched too.
  const sent = new Set();
  for (const m of src.matchAll(/type: "date\/single", target: \["variable", \["template-tag", "([^"]+)"\]\]/g)) {
    sent.add(m[1]);
  }
  assert.ok(sent.size > 0, "the server should send date/single parameters somewhere");
  for (const tag of sent) {
    assert.ok(lifted.DATE_PARAM_TAGS ? lifted.DATE_PARAM_TAGS.has(tag) : true, tag);
  }
  // The set is declared in server.js; read it back out of the source to compare.
  const decl = slice("const DATE_PARAM_TAGS", ");");
  for (const tag of sent) {
    assert.ok(decl.includes(`"${tag}"`), `DATE_PARAM_TAGS is missing ${tag}`);
  }
});

// ── fingerprint: a still-broken card must not re-alert every morning ────────

test("the fingerprint is stable across ordering and changes with the breakage", () => {
  const a = { wrongType: [
    { mbUuid: "u1", tag: "start_date", type: "category" },
    { mbUuid: "u2", tag: "end_date", type: "category" },
  ] };
  const b = { wrongType: [...a.wrongType].reverse() };
  assert.strictEqual(cardParamDriftFingerprint(a), cardParamDriftFingerprint(b));
  assert.notStrictEqual(cardParamDriftFingerprint(a), cardParamDriftFingerprint({
    wrongType: a.wrongType.concat({ mbUuid: "u3", tag: "start_date", type: "category" }),
  }));
  assert.strictEqual(cardParamDriftFingerprint({ wrongType: [] }), "");
});

// ── wiring: the alert has to actually leave the building ────────────────────

test("param-drift is wired into Slack with a debounce and a message", () => {
  assert.ok(/SLACK_NOTIFY = new Set\(\[[^\]]*"param-drift"/.test(src),
    "param-drift must be in SLACK_NOTIFY or it stays silent");
  assert.ok(/"param-drift": 6 \* 60 \* 60 \* 1000/.test(src), "param-drift needs a debounce");
  assert.ok(/"param-drift": \{ emoji:/.test(src), "param-drift needs event meta");
  assert.ok(src.includes('rec.event === "param-drift"'), "param-drift needs a message branch");
});

test("the check is scheduled daily and once after boot", () => {
  assert.ok(/cron\.schedule\("40 5 \* \* \*", \(\) => \{ checkCardParamTypes\(\)/.test(src));
  assert.ok(/setTimeout\(\(\) => \{ checkCardParamTypes\(\)\.catch\(\(\) => \{\}\); \}, 150 \* 1000\)/.test(src));
});

test("a failed read is never reported as drift", () => {
  const body = slice("async function checkCardParamTypes", "// Same cadence");
  assert.ok(body.includes("if (defs.length === 0)"),
    "zero readable definitions must short-circuit, not flag every card");
  assert.ok(/return \{ ok: false, error: "no card definitions could be read"/.test(body));
});

console.log(`\n${passed}/${passed} passing`);
