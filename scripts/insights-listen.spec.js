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

// ── 5. Source: ONE UTTERANCE PER LINE -- in the BROWSER voice only ──────
// Chrome silently truncates a long utterance at ~15s, so a single string for
// the whole panel stops mid-sentence -- which reads as the feature being
// broken rather than as a browser limit. That is a browser workaround, so it
// belongs to speakBrowser and NOT to the Rec voice, which returns a whole clip
// and reads better for having generated it in one pass.
{
  const speak = liftFn(PAGE, "speakBrowser");
  ok(/new SpeechSynthesisUtterance\(lines\[i\+\+\]\)/.test(speak),
     "speakBrowser queues ONE utterance per line, never one for the joined script");
  ok(/\.cancel\(\)/.test(speak),
     "speakBrowser cancels first -- two readings must never overlap");
  ok(/onerror/.test(speak),
     "a failed voice must call back, or the button stays stuck on Stop forever");
}

// ── 5b. Source: the Rec voice, and its fallback ──────────────────────
// EVERY refusal has to fall through to the browser voice. The route 404s
// wherever ELEVENLABS_API_KEY is unset -- every PR preview, every local boot --
// so a page that surfaced the failure would report a missing env var as a
// broken feature.
{
  const speak = liftFn(PAGE, "speakScript");
  ok(/api\/speak/.test(speak),
     "speakScript asks the server for the Rec voice first");
  ok(/lines\.join\("\\n"\)/.test(speak),
     "...sending the WHOLE script in one request -- the per-line split is a Chrome bug being dodged, not a property of speech");
  // Scoped PAST the try/catch: `a.onerror` also calls speakBrowser, so a
  // file-wide match is satisfied by the mid-playback fallback and says
  // nothing about the refusal path. Found by mutation.
  const tail = speak.slice(speak.indexOf("catch (_)"));
  ok(/if \(r\.ok\)/.test(speak) && /speakBrowser\(lines, onDone\);/.test(tail),
     "a refusal (404 no key / 429 budget / 502 down) falls through to the browser voice rather than surfacing");
  ok(/if \(onVoice\) onVoice\('browser'\);/.test(tail),
     "...and reports WHICH voice spoke, or the beacon cannot tell a fallback from a Rec-voice listen");
  ok(/catch \(_\)/.test(speak),
     "...and so does a network or decode failure");
  ok(/if \(!_speakWanted\) \{ onDone\(\); return; \}/.test(speak),
     "a Stop pressed while the clip generates WINS -- the arriving audio is discarded, never played");
  ok(/a\.onerror = \(\) => \{ _recAudio = null; speakBrowser\(lines, onDone\); \};/.test(speak),
     "audio that fails mid-playback falls back too, rather than ending the reading silently");

  const stop = liftFn(PAGE, "stopSpeech");
  ok(/if \(_recAudio\) \{\s*_recAudio\.pause\(\);/.test(stop) && /speechSynthesis\.cancel\(\)/.test(stop),
     "Stop stops BOTH voices -- either one left running is a page that will not shut up");
  ok(/_speakWanted = false/.test(stop),
     "...and clears the wanted flag, or a clip still generating starts playing after Stop");

  const flagAt = PAGE.indexOf("let _speakWanted");
  ok(flagAt > -1 && flagAt < PAGE.indexOf("async function speakScript"),
     "_speakWanted is declared ABOVE speakScript -- Babel turns let into var, so a read before the declaration is undefined rather than a throw");
}

// ── 6. Source: the page's own wiring ────────────────────────────────────────
{
  ok(/const TTS_OK = typeof window !== "undefined" && "speechSynthesis" in window;/.test(PAGE),
     "support is feature-detected, not assumed");
  ok(/insights && insights\.length > 0 && !insightsLoading && TTS_OK && \(/.test(PAGE),
     "the button is ABSENT where the browser has no voice, AND where there is nothing to read -- a control that can never work is a dead end either way");
  ok(/speaking \? stopSpeaking : speakInsights/.test(PAGE),
     "the same button stops the reading, so there is always a way to shut it up");
  ok(/return \(\) => stopSpeech\(\);/.test(PAGE),
     "the cleanup stops BOTH voices -- the audio element and speechSynthesis both hang off the WINDOW, so either keeps going after a navigation otherwise");
  const eff = PAGE.slice(PAGE.indexOf("return () => stopSpeech();"));
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
  ok(/logClientEvent\('insights-listen', '&n=' \+ insights\.length \+ '&voice=' \+ voice\)/.test(PAGE),
     "the page sends the count AND which voice spoke");
  ok(/voice: req\.query\.voice === "rec" \|\| req\.query\.voice === "browser"/.test(SRC),
     "the voice is clamped to the two real values, never echoed from the query string");
  ok(/rec\.voice === "browser" \? " \(browser voice\)"/.test(SRC),
     "Slack names the voice -- a fallback means the key is unset, the budget is spent or ElevenLabs is down, and none of those announce themselves anywhere else");
}

// ── 8. It is a PROTOTYPE, and the seam is the point ─────────────────────────
// Swapping to ElevenLabs must be a different body for speakScript and nothing
// else, so no caller may reach speechSynthesis directly.
{
  // Counted on the PROPERTY ACCESS, not the bare word: the cleanup's own
  // comment says "speechSynthesis" and a looser count reads that as a caller.
  const body = PAGE.slice(PAGE.indexOf("function App() {"));
  eq((body.match(/window\.speechSynthesis/g) || []).length, 0,
     "the component does not touch speechSynthesis AT ALL any more -- it goes through speakScript and stopSpeech, so the browser voice is now an implementation detail of one function rather than something every caller knows about");
  eq((PAGE.match(/speakScript\(/g) || []).length, 2,
     "speakScript has exactly one definition and one caller");
  eq((PAGE.match(/new Audio\(/g) || []).length, 1,
     "one audio element, in one place -- two would overlap and Stop could only reach one of them");
}

// ── 9. The route spends MONEY and holds a KEY ────────────────────────
// Every assertion here is about something that costs real money or leaks a
// real secret if it regresses, which is why they are worth pinning in source
// even though an end-to-end test would need an ElevenLabs stub.
{
  const route = SRC.slice(SRC.indexOf('app.post("/:org/:report/api/speak"'),
                          SRC.indexOf('app.post("/:org/:report/api/insights"'));
  ok(route.length > 200, "found the speak route");

  ok(/if \(!elevenKey\(\)\) return refuse404\(res,/.test(route),
     "no key means a DELIBERATE 404 -- noteDeadLink alerts on 'a 404 with a valid-looking token', which is byte-identical to this refusal");
  ok(/text\.length > ELEVEN_MAX_CHARS/.test(route),
     "the script is length-clamped -- without it the route is a free TTS proxy for anyone holding an org token");
  ok(/speakBudgetOk\(orgSlug, text\.length\)/.test(route),
     "...and bounded per org per day, so a page in a retry loop cannot quietly run up a bill");

  const cacheAt  = route.indexOf("_speakCache.get(key)");
  const budgetAt = route.indexOf("speakBudgetOk(");
  ok(cacheAt > -1 && budgetAt > cacheAt,
     "the CACHE is checked before the budget -- re-listening to the same insights must not spend from it, or the budget punishes the reader for the button working");

  ok(!/await r\.text\(\)/.test(route) && /ElevenLabs " \+ r\.status/.test(route),
     "an ElevenLabs failure is logged by STATUS and its body is never echoed -- a 401 from them quotes the key back");
  ok(/error: "Voice service unavailable"/.test(route) && !/ELEVEN_KEY/.test(route.slice(route.indexOf("res.status(502)"))),
     "...and the client is told nothing about the key either");

  // Read per REQUEST, not latched into a const at boot: an omit-when-unset
  // key has to light the route up when it is set, not when the box restarts.
  ok(/function elevenKey\(\) \{ return process\.env\.ELEVENLABS_API_KEY \|\| ""; \}/.test(SRC),
     "the key comes from the env and defaults to EMPTY -- never a committed literal");
  ok(!/const ELEVEN_KEY\b/.test(SRC) && /"xi-api-key": elevenKey\(\)/.test(route),
     "...and it is read PER REQUEST, so setting it in Railway does not wait for a restart");
  ok(/pNInz6obpgDQGcFmaJgB/.test(SRC) && /eleven_turbo_v2_5/.test(SRC),
     "the voice and model match the rec-training-video skill, so a report read aloud sounds like the training videos");

  const budget = liftFn(SRC, "speakBudgetOk");
  ok(/cur\.day !== day/.test(budget),
     "the budget resets on the DAY, not on a rolling window -- a rolling one never resets for an org that listens daily");
}

if (failures.length) {
  console.error("\n" + failures.length + " assertion(s) FAILED:");
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(passed + " assertions passed.");
