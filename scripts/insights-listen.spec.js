#!/usr/bin/env node
/**
 * READING THE INSIGHTS OUT LOUD — the script, the seam and the beacon.
 *
 * PROTOTYPE on public/products.html only. What is worth guarding is not that a
 * button exists but WHAT IT WOULD SAY: the spoken script is the whole feature,
 * and it is pure logic, so it LIFTS AND RUNS here rather than being regexed.
 *
 * The rest is the two things this repo has been bitten by on every beacon it
 * has ever shipped: an event missing from the log route's ALLOWED list (a
 * fire-and-forget POST 400s and never complains — four instances recorded), and
 * an event missing from SLACK_NOTIFY (recorded but never announced — five).
 */
const fs = require("fs");
const path = require("path");

const PAGE = fs.readFileSync(path.join(__dirname, "..", "public", "products.html"), "utf8");
const SRC  = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

let passed = 0;
const failures = [];
const ok = (c, m) => { if (c) passed++; else failures.push(m); };
const eq = (a, b, m) => ok(a === b, m + " (got " + JSON.stringify(a) + ", wanted " + JSON.stringify(b) + ")");

// ── Lift ────────────────────────────────────────────────────────────────────
// Bounded by the function's own braces. A fixed-length slice stops covering the
// tail of a function the moment anything is added to it, and then passes by not
// reaching the code it names.
function liftFn(src, name) {
  const start = src.indexOf("function " + name);
  if (start < 0) throw new Error("could not find function " + name);
  const afterParams = src.indexOf(")", start);   // skip the parameter list first
  let depth = 0, i = src.indexOf("{", afterParams);
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) throw new Error("unbalanced braces lifting " + name);
  return src.slice(start, i + 1);
}

let insightLines;
try {
  insightLines = new Function(liftFn(PAGE, "insightLines") + "; return insightLines;")();
} catch (e) {
  console.error("FAILED to lift insightLines: " + e.message);
  process.exit(1);
}

const SAMPLE = {
  type: "risk",
  title: "Westwood pass sales are slipping",
  detail: "Westwood sold 41 passes in August against 78 in July, a 47% drop.",
  action: "Check the August price change",
};

// ── 1. The script says the things a listener cannot see ─────────────────────
{
  const lines = insightLines(SAMPLE);
  ok(lines.length === 3, "a full insight reads as three lines: lead+title, detail, next step");
  ok(/^Heads up\. /.test(lines[0]), "a RISK is flagged as such before its title -- a listener has no red card to look at");
  ok(lines[0].includes(SAMPLE.title), "the title is read");
  eq(lines[1], SAMPLE.detail, "the detail is read verbatim, numbers included");
  ok(/^Next step\. /.test(lines[2]), "the action is introduced as the next step");
  ok(lines[2].includes(SAMPLE.action), "the action itself is read");
}
{
  const lines = insightLines({ ...SAMPLE, type: "opportunity" });
  ok(/^Opportunity\. /.test(lines[0]), "an OPPORTUNITY is flagged too");
}

// ── 2. "signal" is NOT spoken ───────────────────────────────────────────────
// It is a visual category and the third of three values that carries no
// meaning aloud. Saying it before every third card is noise.
{
  const lines = insightLines({ ...SAMPLE, type: "signal" });
  ok(!/signal/i.test(lines.join(" ")), "the word 'signal' is never read aloud");
  ok(lines[0].startsWith(SAMPLE.title), "a signal opens on its own title");
}
{
  const lines = insightLines({ ...SAMPLE, type: undefined });
  ok(!/undefined/.test(lines.join(" ")), "a missing type must not be read as the word 'undefined'");
}

// ── 3. THE ARROW IS NEVER SPOKEN ────────────────────────────────────────────
// On screen the action reads "→ Check the price". An arrow read aloud is
// either silence or the word "arrow", and neither is what it means.
{
  const lines = insightLines(SAMPLE);
  ok(!lines.some(l => l.includes("→")), "no line carries the on-screen arrow glyph");
}

// ── 4. A partial insight degrades rather than reading blanks ────────────────
{
  const lines = insightLines({ type: "signal", title: "Norman is flat", detail: "", action: "" });
  eq(lines.length, 1, "an insight with only a title reads as one line, not three empty ones");
}
{
  eq(insightLines(null).length, 0, "a null insight reads as nothing rather than throwing");
  eq(insightLines({}).length, 0, "an empty insight reads as nothing");
}
{
  const lines = insightLines({ title: "  spaced   out\n\ntitle  ", detail: "a  b" });
  eq(lines[0], "spaced out title", "whitespace is collapsed -- a newline inside a title is a pause that sounds like a fault");
  eq(lines[1], "a b", "collapsed in the detail too");
}

// ── 5. Source: ONE UTTERANCE PER LINE ───────────────────────────────────────
// Chrome silently truncates a long utterance at ~15s, so a single string for
// the whole panel stops mid-sentence -- which reads as the feature being
// broken rather than as a browser limit.
{
  const speak = liftFn(PAGE, "speakScript");
  ok(/new SpeechSynthesisUtterance\(lines\[i\+\+\]\)/.test(speak),
     "speakScript queues ONE utterance per line, never one for the joined script");
  ok(/\.cancel\(\)/.test(speak),
     "speakScript cancels first -- two readings must never overlap");
  ok(/onerror/.test(speak),
     "a failed voice must call back, or the button stays stuck on Stop forever");
}

// ── 6. Source: the page's own wiring ────────────────────────────────────────
{
  ok(/const TTS_OK = typeof window !== "undefined" && "speechSynthesis" in window;/.test(PAGE),
     "support is feature-detected, not assumed");
  ok(/insights && insights\.length > 0 && !insightsLoading && TTS_OK && \(/.test(PAGE),
     "the button is ABSENT where the browser has no voice, AND where there is nothing to read -- a control that can never work is a dead end either way");
  ok(/speaking \? stopSpeaking : speakInsights/.test(PAGE),
     "the same button stops the reading, so there is always a way to shut it up");
  ok(/return \(\) => \{ if \(TTS_OK\) window\.speechSynthesis\.cancel\(\); \};/.test(PAGE),
     "the cleanup cancels -- speechSynthesis hangs off the WINDOW, so it keeps talking after a navigation otherwise");
  const eff = PAGE.slice(PAGE.indexOf("return () => { if (TTS_OK)"));
  ok(/^\s*return[\s\S]{0,120}\}, \[insights\]\);/.test(eff),
     "...and it is keyed on [insights], so a Refresh stops the old ones being narrated");
}

// ── 7. The beacon, both halves ──────────────────────────────────────────────
// A fire-and-forget POST that 400s never complains. Four recorded instances of
// exactly this, and no source assertion has ever caught one -- so both lists
// are asserted here.
{
  const allowed = SRC.match(/const ALLOWED = \[[^\]]*"excel"[^\]]*\]/);
  ok(!!allowed, "found the generic log route's ALLOWED list");
  ok(allowed && allowed[0].includes('"insights-listen"'),
     "insights-listen is on the log route's ALLOWED list, or the beacon 400s silently");
  const notify = SRC.match(/const SLACK_NOTIFY = new Set\(\[[^\]]*\]\)/);
  ok(!!notify, "found SLACK_NOTIFY");
  ok(notify && notify[0].includes('"insights-listen"'),
     "insights-listen is in SLACK_NOTIFY, or it is recorded and never announced");
  ok(/"insights-listen":\s*\{ emoji:/.test(SRC),
     "insights-listen has SLACK_EVENT_META, or the message renders with no emoji or verb");
  ok(/rec\.event === "insights-listen"/.test(SRC),
     "the message names the COUNT -- without it Slack cannot separate a click from a listen");
  ok(/insights: Number\.isFinite\(ciN\)/.test(SRC),
     "the count is clamped server-side, never echoed from the query string");
  ok(/logClientEvent\('insights-listen', '&n=' \+ insights\.length\)/.test(PAGE),
     "the page sends the count");
}

// ── 8. It is a PROTOTYPE, and the seam is the point ─────────────────────────
// Swapping to ElevenLabs must be a different body for speakScript and nothing
// else, so no caller may reach speechSynthesis directly.
{
  // Counted on the PROPERTY ACCESS, not the bare word: the cleanup's own
  // comment says "speechSynthesis" and a looser count reads that as a caller.
  const body = PAGE.slice(PAGE.indexOf("function App() {"));
  const touches = (body.match(/window\.speechSynthesis/g) || []).length;
  const cancels = (body.match(/window\.speechSynthesis\.cancel\(\)/g) || []).length;
  eq(touches, cancels,
     "inside the component, speechSynthesis is only ever CANCELLED -- every word spoken goes through speakScript, which is the one seam ElevenLabs would replace");
  eq((PAGE.match(/speakScript\(/g) || []).length, 2,
     "speakScript has exactly one definition and one caller");
}

if (failures.length) {
  console.error("\n" + failures.length + " assertion(s) FAILED:");
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(passed + " assertions passed.");
