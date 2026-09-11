#!/usr/bin/env node
/* surveys.spec.js — the admin survey builder.
 *
 * Dan, 2026-09-11: "lets build the survey tool, i need some feedback", then
 * "An open survey builder, I can choose from a 1-5 rating, stars, open text
 * box, etc. Similar to the intercom survey builder." — and the one hard rule,
 * verbatim: "both, just NEVER on a customer facing report, like the watertown
 * facility rental view or the programs view that users see, ONLY on admin
 * stuff."
 *
 * THE RULE IS GUARDED THREE WAYS, because each one alone can be defeated:
 *   1. STRUCTURAL — the three un-tokened customer pages do not load
 *      feedback-widget.js at all, so a resident cannot be shown a survey even
 *      with every server test removed. Asserted, because someone adding the
 *      widget to campmap.html "for the banner" would open the door silently.
 *   2. DERIVED — PUBLIC_REPORTS is ONE Set read by both the org-token
 *      middleware (which decides what goes un-tokened) and surveyFor(). Two
 *      hand-kept lists is how a fourth public page becomes surveyable.
 *   3. RUN — surveyFor() is lifted and executed against each public slug.
 *
 * The rest LIFTS AND RUNS the model. A regex over a validator passes on an
 * inverted comparison, and a survey that stores an unanswerable question
 * renders a prompt with nothing under it — which reads to the respondent as a
 * broken product, not as a question we forgot to finish.
 *
 * SKIP_SOURCE=1 drops the source half so the behavioural half can be shown to
 * catch a regression on its own.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

let pass = 0;
const failures = [];
const test = (name, fn) => {
  try { fn(); pass++; console.log("  ✓ " + name); }
  catch (e) { failures.push(name + " — " + e.message); console.log("  ✗ " + name); }
};
const atest = async (name, fn) => {
  try { await fn(); pass++; console.log("  ✓ " + name); }
  catch (e) { failures.push(name + " — " + e.message); console.log("  ✗ " + name); }
};

const root = path.join(__dirname, "..");
const srv = fs.readFileSync(path.join(root, "server.js"), "utf8");
const widget = fs.readFileSync(path.join(root, "public/feedback-widget.js"), "utf8");
const SKIP_SOURCE = process.env.SKIP_SOURCE === "1";

/* Lift a module-scope function by name. The parameter list is skipped FIRST:
   counting braces from the first `{` matches a DESTRUCTURED parameter and cuts
   the function in half — recorded repeatedly in CLAUDE.md. */
function liftFn(text, name) {
  const start = text.indexOf("function " + name + "(");
  if (start < 0) throw new Error(name + " not found at module scope");
  let p = text.indexOf("(", start), pd = 0, j = p;
  for (; j < text.length; j++) {
    if (text[j] === "(") pd++;
    else if (text[j] === ")") { pd--; if (pd === 0) break; }
  }
  let depth = 0, i = text.indexOf("{", j);
  for (; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (depth === 0) break; }
  }
  return text.slice(start, i + 1);
}
function liftConst(text, name) {
  const re = new RegExp("^const " + name + " *= [\\s\\S]*?;$", "m");
  const m = re.exec(text);
  if (!m) throw new Error(name + " not found at module scope");
  return m[0];
}

/* ── The model, RUN ────────────────────────────────────────────────── */
const TYPES_SRC = /const SURVEY_QUESTION_TYPES = \{[\s\S]*?\n\};/.exec(srv);
assert.ok(TYPES_SRC, "SURVEY_QUESTION_TYPES is where this expects it");
const PUBLIC_SRC = liftConst(srv, "PUBLIC_REPORTS");

const M = new Function("ORGS", "readJSON", "writeJSON", "parseAnnounceExpiry", "SURVEYS", `
  const SURVEYS_FILE = "surveys";
  ${PUBLIC_SRC}
  ${TYPES_SRC[0]}
  ${liftConst(srv, "SURVEY_MAX_QUESTIONS")}
  ${liftConst(srv, "SURVEY_MAX_OPTIONS")}
  ${liftConst(srv, "SURVEY_TEXT_MAX")}
  ${liftFn(srv, "getSurveys")}
  ${liftFn(srv, "surveyClampStr")}
  ${liftFn(srv, "normalizeSurveyQuestion")}
  ${liftFn(srv, "normalizeSurvey")}
  ${liftFn(srv, "surveyIsOpen")}
  ${liftFn(srv, "surveyFor")}
  ${liftFn(srv, "normalizeSurveyAnswers")}
  return { PUBLIC_REPORTS, SURVEY_QUESTION_TYPES, normalizeSurveyQuestion, normalizeSurvey,
           surveyIsOpen, surveyFor, normalizeSurveyAnswers };
`)(
  { apex: {}, watertown: {}, norman: {} },
  () => M_SURVEYS,
  () => {},
  (d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d)) ? Date.parse(d + "T23:59:59.999-08:00") : null),
  null
);
let M_SURVEYS = [];

const q = (over) => Object.assign({ type: "rating5", prompt: "How is it?" }, over);
const draft = (over) => Object.assign({ title: "T", questions: [q()] }, over);

/* ── Question types: the seven Dan named ──────────────────────────── */
test("the seven question types Dan asked for all exist", () => {
  for (const t of ["rating5", "stars", "nps", "yesno", "single", "multi", "text"]) {
    assert.ok(M.SURVEY_QUESTION_TYPES[t], t + " is missing from the vocabulary");
  }
});
test("rating5 and stars are SEPARATE types — he named both, and the face changes the answer", () => {
  assert.ok(M.SURVEY_QUESTION_TYPES.rating5 && M.SURVEY_QUESTION_TYPES.stars);
  assert.notStrictEqual(M.SURVEY_QUESTION_TYPES.rating5.label, M.SURVEY_QUESTION_TYPES.stars.label);
});
test("...and they share one scale, so the readout can treat them as one", () => {
  const a = M.SURVEY_QUESTION_TYPES.rating5, b = M.SURVEY_QUESTION_TYPES.stars;
  assert.strictEqual(a.min, b.min); assert.strictEqual(a.max, b.max);
});
test("NPS is 0–10, not 1–5 — a five-point NPS is not an NPS", () => {
  assert.strictEqual(M.SURVEY_QUESTION_TYPES.nps.min, 0);
  assert.strictEqual(M.SURVEY_QUESTION_TYPES.nps.max, 10);
});
test("yes/no supplies its own options, so the composer cannot mistype them", () => {
  const out = M.normalizeSurveyQuestion({ type: "yesno", prompt: "Useful?" }, 0);
  assert.deepStrictEqual(out.options, ["Yes", "No"]);
});

/* ── A question that cannot be answered is never stored ───────────── */
test("a choose-one with no options is REFUSED, not stored as an empty prompt", () => {
  assert.strictEqual(M.normalizeSurveyQuestion({ type: "single", prompt: "Pick" }, 0), null);
});
test("...and one with a single option is refused too — that is not a choice", () => {
  assert.strictEqual(M.normalizeSurveyQuestion({ type: "single", prompt: "Pick", options: ["A"] }, 0), null);
});
test("a duplicate option is collapsed, or it splits its own vote", () => {
  const out = M.normalizeSurveyQuestion({ type: "single", prompt: "P", options: ["A", "A", "B"] }, 0);
  assert.deepStrictEqual(out.options, ["A", "B"]);
});
test("an unknown question type is dropped rather than rendered blank", () => {
  assert.strictEqual(M.normalizeSurveyQuestion({ type: "slider", prompt: "P" }, 0), null);
});
test("a question with no prompt is dropped", () => {
  assert.strictEqual(M.normalizeSurveyQuestion({ type: "text", prompt: "   " }, 0), null);
});
test("a survey whose every question is unanswerable is REFUSED with a reason", () => {
  const r = M.normalizeSurvey({ title: "T", questions: [{ type: "single", prompt: "P" }] });
  assert.ok(r.error && /answered/i.test(r.error), "got " + JSON.stringify(r));
});
test("a survey with no title is refused", () => {
  assert.ok(M.normalizeSurvey({ questions: [q()] }).error);
});

/* ── Ids address the answers ──────────────────────────────────────── */
test("EDITING KEEPS EACH QUESTION'S ID, or every answer re-keys under its neighbour", () => {
  const first = M.normalizeSurvey(draft({
    questions: [q({ prompt: "Rate it" }), q({ type: "text", prompt: "Why?" })],
  })).survey;
  const ids = first.questions.map(x => x.id);
  // Insert a NEW question at the top, exactly as the composer would send it.
  const again = M.normalizeSurvey({
    title: "T",
    questions: [
      q({ prompt: "Brand new" }),                                   // no id — new
      { id: ids[0], type: "rating5", prompt: "Rate it" },
      { id: ids[1], type: "text", prompt: "Why?" },
    ],
  }, first).survey;
  assert.strictEqual(again.questions[1].id, ids[0], "the first question lost its id");
  assert.strictEqual(again.questions[2].id, ids[1], "the second question lost its id");
  assert.ok(!ids.includes(again.questions[0].id), "the new question took an id that already has answers");
});
test("...and a NEW question never reuses the id of a deleted one", () => {
  const first = M.normalizeSurvey(draft({
    questions: [q({ prompt: "A" }), q({ prompt: "B" }), q({ prompt: "C" })],
  })).survey;
  const bId = first.questions[1].id;
  const again = M.normalizeSurvey({
    title: "T",
    questions: [
      { id: first.questions[0].id, type: "rating5", prompt: "A" },
      q({ prompt: "New one" }),                                     // B was deleted
    ],
  }, first).survey;
  assert.notStrictEqual(again.questions[1].id, bId,
    "the new question inherited the deleted question's answers");
});
test("the composer carries the id through an edit rather than re-numbering", () => {
  const edit = srv.slice(srv.indexOf("function svyEdit("), srv.indexOf("async function svySave("));
  assert.ok(/return \{ id:q\.id,/.test(edit), "svyEdit must load each question's id");
  const save = srv.slice(srv.indexOf("async function svySave("), srv.indexOf("async function svyStatus("));
  assert.ok(!/id: 'q'\+\(i\+1\)/.test(save), "an id minted from the position re-keys the answers");
});
test("two questions given the same id are separated — one id would lose an answer", () => {
  const { survey } = M.normalizeSurvey(draft({
    questions: [q({ id: "a" }), q({ id: "a", prompt: "And now?" })],
  }));
  assert.notStrictEqual(survey.questions[0].id, survey.questions[1].id);
});

/* ── Targeting: empty means ALL, on both axes ─────────────────────── */
test("no orgs ticked means EVERY org, matching every other multi-select here", () => {
  const { survey } = M.normalizeSurvey(draft());
  survey.status = "live";
  M_SURVEYS = [survey];
  assert.ok(M.surveyFor("apex", "facility"));
  assert.ok(M.surveyFor("watertown", "facility"));
});
test("no reports ticked means every ADMIN surface", () => {
  const { survey } = M.normalizeSurvey(draft());
  survey.status = "live";
  M_SURVEYS = [survey];
  assert.ok(M.surveyFor("apex", "gl"));
  assert.ok(M.surveyFor("apex", "memberships"));
});
test("a ticked org excludes the others", () => {
  const { survey } = M.normalizeSurvey(draft({ targeting: { orgs: ["apex"] } }));
  survey.status = "live";
  M_SURVEYS = [survey];
  assert.ok(M.surveyFor("apex", "facility"));
  assert.strictEqual(M.surveyFor("watertown", "facility"), null);
});
test("a ticked report excludes the others", () => {
  const { survey } = M.normalizeSurvey(draft({ targeting: { reports: ["gl"] } }));
  survey.status = "live";
  M_SURVEYS = [survey];
  assert.ok(M.surveyFor("apex", "gl"));
  assert.strictEqual(M.surveyFor("apex", "facility"), null);
});
test("an org that does not exist is dropped from targeting rather than stored", () => {
  const { survey } = M.normalizeSurvey(draft({ targeting: { orgs: ["apex", "nope"] } }));
  assert.deepStrictEqual(survey.targeting.orgs, ["apex"]);
});

/* ── NEVER on a customer-facing page ──────────────────────────────── */
test("THE RULE: no survey is ever offered on calendar, rentalcalendar or campmap", () => {
  const { survey } = M.normalizeSurvey(draft());
  survey.status = "live";
  M_SURVEYS = [survey];
  for (const p of M.PUBLIC_REPORTS) {
    assert.strictEqual(M.surveyFor("apex", p), null, p + " was offered a survey");
  }
});
test("...even when that page is explicitly ticked, because the tick is dropped on save", () => {
  const { survey } = M.normalizeSurvey(draft({ targeting: { reports: ["campmap", "gl"] } }));
  assert.deepStrictEqual(survey.targeting.reports, ["gl"]);
});
test("...and it is the FIRST test in surveyFor, so it reads as a rule not a filter", () => {
  const src = liftFn(srv, "surveyFor");
  const pub = src.indexOf("PUBLIC_REPORTS.has(report)");
  const targeting = src.indexOf("targeting");
  assert.ok(pub > -1 && (targeting === -1 || pub < targeting),
    "the public-page test must come before any targeting test");
});

/* ── Open / closed ────────────────────────────────────────────────── */
test("a draft is never offered", () => {
  const { survey } = M.normalizeSurvey(draft());
  assert.strictEqual(M.surveyIsOpen(survey), false);
});
test("a closed survey is never offered", () => {
  const { survey } = M.normalizeSurvey(draft({ status: "closed" }));
  assert.strictEqual(M.surveyIsOpen(survey), false);
});
test("a start date with no end is open-ended, not never-open", () => {
  const s = { status: "live", startsAt: Date.now() - 1000, endsAt: null };
  assert.strictEqual(M.surveyIsOpen(s), true);
});
test("an end date with no start is open until then", () => {
  const s = { status: "live", startsAt: null, endsAt: Date.now() + 1000 };
  assert.strictEqual(M.surveyIsOpen(s), true);
});
test("a survey that has not started yet is not offered", () => {
  assert.strictEqual(M.surveyIsOpen({ status: "live", startsAt: Date.now() + 6e4 }), false);
});
test("a survey past its end date is not offered", () => {
  assert.strictEqual(M.surveyIsOpen({ status: "live", endsAt: Date.now() - 6e4 }), false);
});
test("the OLDEST live survey wins, so a new one does not jump the queue", () => {
  const a = M.normalizeSurvey(draft({ title: "First" })).survey;
  const b = M.normalizeSurvey(draft({ title: "Second" })).survey;
  a.status = b.status = "live";
  a.createdAt = 1000; b.createdAt = 2000;
  M_SURVEYS = [b, a];
  assert.strictEqual(M.surveyFor("apex", "facility").title, "First");
});

/* ── Answers are read BY ID against the survey's own definition ───── */
const answerable = M.normalizeSurvey({
  title: "Mixed",
  questions: [
    { id: "r", type: "rating5", prompt: "Rate" },
    { id: "n", type: "nps", prompt: "Recommend?" },
    { id: "c", type: "single", prompt: "Pick", options: ["A", "B"] },
    { id: "m", type: "multi", prompt: "Any", options: ["X", "Y", "Z"] },
    { id: "t", type: "text", prompt: "Why?" },
  ],
}).survey;

test("a scale answer outside its range is dropped, not clamped into a rating nobody gave", () => {
  const { answers } = M.normalizeSurveyAnswers(answerable, { r: 9 });
  assert.strictEqual(answers.r, undefined);
});
test("an NPS of 0 is a real answer, not a missing one", () => {
  const { answers, answered } = M.normalizeSurveyAnswers(answerable, { n: 0 });
  assert.strictEqual(answers.n, 0);
  assert.strictEqual(answered, 1);
});
test("a choice that is not on the list is dropped rather than stored raw", () => {
  const { answers } = M.normalizeSurveyAnswers(answerable, { c: "C" });
  assert.strictEqual(answers.c, undefined);
});
test("a multi keeps only options the question offered", () => {
  const { answers } = M.normalizeSurveyAnswers(answerable, { m: ["X", "Q", "Z"] });
  assert.deepStrictEqual(answers.m, ["X", "Z"]);
});
test("an answer under an id the survey does not have is ignored", () => {
  const { answers, answered } = M.normalizeSurveyAnswers(answerable, { ghost: 5 });
  assert.deepStrictEqual(answers, {});
  assert.strictEqual(answered, 0);
});
test("free text is clamped rather than refused — a long answer is still an answer", () => {
  const { answers } = M.normalizeSurveyAnswers(answerable, { t: "x".repeat(9000) });
  assert.strictEqual(answers.t.length, 2000);
});
test("whitespace-only text is not an answer", () => {
  const { answered } = M.normalizeSurveyAnswers(answerable, { t: "   " });
  assert.strictEqual(answered, 0);
});

/* ── Source assertions ─────────────────────────────────────────────── */
if (!SKIP_SOURCE) {
  test("the three customer pages do not load feedback-widget.js AT ALL", () => {
    for (const f of ["calendar", "rentalcalendar", "campmap"]) {
      const p = path.join(root, "public", f + ".html");
      if (!fs.existsSync(p)) continue;
      assert.ok(!fs.readFileSync(p, "utf8").includes("feedback-widget.js"),
        f + ".html loads the feedback widget — a customer could be shown a survey");
    }
  });
  test("...while the admin report pages do, or the survey reaches nobody", () => {
    const loaded = fs.readdirSync(path.join(root, "public"))
      .filter(f => f.endsWith(".html"))
      .filter(f => fs.readFileSync(path.join(root, "public", f), "utf8").includes("feedback-widget.js"));
    assert.ok(loaded.length >= 20, "only " + loaded.length + " pages carry the widget");
  });
  test("the org-token middleware reads PUBLIC_REPORTS rather than re-typing the three slugs", () => {
    assert.ok(/PUBLIC_REPORTS\.has\(segs\[1\]\)/.test(srv),
      "the middleware must read the same Set surveyFor() reads");
    assert.ok(!/segs\[1\] === "calendar" \|\| segs\[1\] === "rentalcalendar"/.test(srv),
      "the hand-typed public list cannot come back — two lists is how they drift");
  });
  test("the widget's org-dashboard slug matches the server's, or targeting it matches nothing", () => {
    const s = /const SURVEY_ORG_SURFACE = "([^"]+)"/.exec(srv);
    const w = /var SURVEY_ORG_SURFACE = "([^"]+)"/.exec(widget);
    assert.ok(s && w, "both declarations must exist");
    assert.strictEqual(w[1], s[1]);
  });
  test("the composer never offers a customer-facing page as a target", () => {
    const route = srv.slice(srv.indexOf('app.get("/api/admin/surveys"'), srv.indexOf('app.post("/api/admin/surveys"'));
    assert.ok(/PUBLIC_REPORTS\.has\(t\)/.test(route),
      "a composer that offers a page and then drops it is a control that looks like it works");
  });
  test("the readout is password-gated — it returns what orgs typed about us", () => {
    const i = srv.indexOf('app.post("/api/admin/surveys/responses"');
    assert.ok(i > 0, "the readout must be a POST so the password rides in the body");
    assert.ok(/dashboardPasswordBlocked\(req, res\)/.test(srv.slice(i, i + 400)));
    assert.ok(!/app\.get\("\/api\/admin\/surveys\/:id\/responses"/.test(srv),
      "an ungated GET of verbatim feedback cannot come back");
  });
  test("every survey write is password-gated", () => {
    for (const r of ["surveys", "surveys/status", "surveys/delete"]) {
      const i = srv.indexOf('app.post("/api/admin/' + r + '"');
      assert.ok(i > 0, r + " route missing");
      assert.ok(/dashboardPasswordBlocked\(req, res\)/.test(srv.slice(i, i + 300)), r + " is ungated");
    }
  });
  test("a response is written to the EVENT LOG, not to a read-modify-write blob", () => {
    const i = srv.indexOf('app.post("/:org/:report/api/survey"');
    const body = srv.slice(i, i + 2200);
    assert.ok(/logEvent\(org, report, "survey-response"/.test(body),
      "answers must be appended, or two replicas racing lose one");
    assert.ok(!/saveSurveys\(/.test(body), "a response must never rewrite the survey document");
  });
  test("a survey that has closed refuses a late submit rather than dropping it silently", () => {
    const i = srv.indexOf('app.post("/:org/:report/api/survey"');
    assert.ok(/surveyIsOpen\(survey\)\) return res\.status\(409\)/.test(srv.slice(i, i + 2200)));
  });
  test("survey-response posts to Slack", () => {
    assert.ok(/"survey-response"\]\);|"survey-response",/.test(srv), "not in SLACK_NOTIFY");
    assert.ok(/"survey-response": \{ emoji/.test(srv), "no SLACK_EVENT_META entry");
  });
  test("...and the message carries the WORDS, not just that a survey was answered", () => {
    // The MESSAGE branch, not the debounce-key chain — both mention the event,
    // and a slice from the first match proves nothing about the post.
    const i = srv.indexOf('} else if (rec.event === "survey-response") {');
    assert.ok(i > 0, "no message branch for survey-response — it would fall into the generic line");
    const body = srv.slice(i, i + 2400);
    assert.ok(/surveyTitle/.test(body), "the post must name the survey");
    assert.ok(/“\$\{|\\u201C/.test(body) || /> /.test(body), "the free text must be quoted into the post");
  });
  test("survey-dismiss is deliberately NOT posted to Slack", () => {
    const notify = /const SLACK_NOTIFY = new Set\(\[[\s\S]*?\]\);/.exec(srv)[0];
    assert.ok(!/"survey-dismiss"/.test(notify),
      "one post per dismissal would drown the feed it is meant to inform");
  });
  test("the readout withholds a MEAN under a floor but always shows the distribution", () => {
    const fn = liftFn(srv, "surveyReadout");
    assert.ok(/SURVEY_MIN_FOR_STATS/.test(fn), "no floor on the derived figure");
    assert.ok(/out\.dist = dist/.test(fn), "the distribution must be unconditional — it is the raw data");
  });
  test("NPS is promoters minus detractors, never a mean", () => {
    const fn = liftFn(srv, "surveyReadout");
    assert.ok(/promoters - detractors/.test(fn), "an NPS mean is meaningless");
    assert.ok(/out\.mean = null;/.test(fn), "an NPS must not leave a mean for a surface to print");
  });
  test("the widget's textarea cap matches the server's, or a long answer is cut on arrival", () => {
    // The server's comment claims the widget stops at the same number. A claim
    // in a comment that nothing checks is the kind that goes stale silently.
    const s = /const SURVEY_TEXT_MAX *= *(\d+);/.exec(srv);
    const w = /setAttribute\("maxlength", "(\d+)"\)/.exec(widget);
    assert.ok(s && w, "both caps must exist");
    assert.strictEqual(w[1], s[1]);
  });
  test("the widget asks once per browser — answered OR dismissed both count", () => {
    assert.ok(/if \(surveySeen\(\)\[s\.id\]\) return;/.test(widget),
      "being re-asked something you declined is worse than never being asked");
  });
  test("the widget remembers a send only after the server confirms it", () => {
    const i = widget.indexOf('surveyRemember(survey.id, "done")');
    assert.ok(i > widget.indexOf("if (!r.ok) throw new Error"),
      "marking it done optimistically loses an answer that never landed");
  });
  test("the survey card is not a modal — it must never cover the report", () => {
    assert.ok(/\.rec-svy\{position:fixed;right/.test(widget), "the card must be a corner card");
    assert.ok(!/\.rec-svy\{position:fixed;inset:0/.test(widget), "a full-screen overlay is an interruption");
  });
  test("prompts and options are set as TEXT, never innerHTML", () => {
    assert.ok(/e\.textContent = text/.test(widget), "surveyEl must write textContent");
    const render = widget.slice(widget.indexOf("function surveyRenderQuestion"), widget.indexOf("function surveyMount"));
    assert.ok(!/innerHTML/.test(render), "a rendered question must not go through innerHTML");
  });
  test("the card is hidden in print mode, like the rest of the widget", () => {
    assert.ok(/@media print\{\.rec-svy\{display:none!important;\}\}/.test(widget));
  });
}

/* ══ LIVE HALF ═══════════════════════════════════════════════════════════
   Boots a real server and drives the real routes. The source half above can
   only ever say the code reads correctly; this says a survey published in the
   composer reaches a report page, that an answer lands in the event log, and —
   the one that matters — that a customer-facing page is handed nothing.

   Metabase points at a dead port: nothing here needs a card to answer, and a
   spec that reaches production to prove a gate fails when the replica is busy. */
const http = require("http");
const os = require("os");
const { spawn } = require("child_process");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "surveys-"));
const PORT = 3860 + Math.floor(Math.random() * 100);
const PW = "svy-test-password";
fs.writeFileSync(path.join(dataDir, "orgs.json"), JSON.stringify({
  "fixture-a": { token: "svyTokenAAAAAAAA", orgId: "11111111-1111-1111-1111-111111111111", logoUrl: "", displayName: "Fixture A" },
  "fixture-b": { token: "svyTokenBBBBBBBB", orgId: "22222222-2222-2222-2222-222222222222", logoUrl: "", displayName: "Fixture B" },
}));
// A completed warm, so the boot does not fan ~28 orgs out against production
// Metabase — the self-inflicted load CLAUDE.md records more than once.
fs.writeFileSync(path.join(dataDir, "prewarm-state.json"),
  JSON.stringify({ lastCompletedAt: new Date().toISOString() }));

/* A FAKE SLACK, because the message branch is the half a source assertion
   cannot reach: notifySlack early-returns on an empty SLACK_WEBHOOK_URL, so
   with the webhook unset the branch is never executed and "the code mentions
   surveyTitle" is all anyone has proved. This captures the real post. */
const slackPosts = [];
const slack = http.createServer((req, res) => {
  let b = ""; req.on("data", d => { b += d; });
  req.on("end", () => { try { slackPosts.push(JSON.parse(b)); } catch (_) {} res.end("ok"); });
});
const SLACK_PORT = PORT + 1;
slack.listen(SLACK_PORT, "127.0.0.1");

const child = spawn(process.execPath, [path.join(root, "server.js")], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, DASHBOARD_PASSWORD: PW,
         METABASE_URL: "http://127.0.0.1:9", RESEND_API_KEY: "",
         SLACK_WEBHOOK_URL: "http://127.0.0.1:" + SLACK_PORT + "/hook",
         RAILWAY_ENVIRONMENT_NAME: "production" },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
child.stdout.on("data", d => { out += d; });
child.stderr.on("data", d => { out += d; });

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({
      host: "127.0.0.1", port: PORT, path: p, method, timeout: 20000,
      headers: payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {},
    }, res => {
      let b = ""; res.on("data", d => { b += d; });
      res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, body: b, json: j, headers: res.headers }); });
    });
    r.on("error", reject);
    r.on("timeout", () => { r.destroy(); reject(new Error("timeout")); });
    if (payload) r.write(payload);
    r.end();
  });
}
const waitUp = () => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const tick = () => {
    if (Date.now() - t0 > 45000) return reject(new Error("server did not boot:\n" + out.split("\n").slice(-15).join("\n")));
    const r = http.get({ host: "127.0.0.1", port: PORT, path: "/healthz", timeout: 2000 }, res => { res.resume(); resolve(); });
    r.on("error", () => setTimeout(tick, 400));
    r.on("timeout", () => { r.destroy(); setTimeout(tick, 400); });
  };
  tick();
});
const events = () => {
  try {
    return fs.readFileSync(path.join(dataDir, "events.jsonl"), "utf8")
      .split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
};

const TOK = "?token=svyTokenAAAAAAAA";
const SURVEY = {
  title: "How is the schedule?",
  intro: "Two quick questions.",
  questions: [
    { id: "q1", type: "rating5", prompt: "Rate the schedule", required: true },
    { id: "q2", type: "single", prompt: "Which view?", options: ["Week", "Month"] },
    { id: "q3", type: "text", prompt: "Anything else?" },
  ],
};

(async () => {
  try {
    await waitUp();

    let created;
    await atest("a survey can be published through the composer route", async () => {
      const r = await req("POST", "/api/admin/surveys", Object.assign({ password: PW, status: "live" }, SURVEY));
      assert.strictEqual(r.status, 200, r.body.slice(0, 200));
      created = r.json.survey;
      assert.ok(created && created.id, "no survey came back");
      assert.strictEqual(created.questions.length, 3);
    });

    await atest("...and a wrong password is refused, so the composer is not the gate", async () => {
      const r = await req("POST", "/api/admin/surveys", Object.assign({ password: "nope", status: "live" }, SURVEY));
      assert.strictEqual(r.status, 401);
    });

    await atest("the report page is handed the survey", async () => {
      const r = await req("GET", "/fixture-a/facility/api/survey" + TOK);
      assert.strictEqual(r.status, 200, r.body.slice(0, 200));
      assert.ok(r.json.survey, "no survey delivered to an admin report");
      assert.strictEqual(r.json.survey.id, created.id);
      assert.strictEqual(r.json.survey.questions.length, 3);
    });

    await atest("THE RULE, in a running server: a customer-facing page is handed nothing", async () => {
      for (const page of ["calendar", "rentalcalendar", "campmap"]) {
        const r = await req("GET", "/fixture-a/" + page + "/api/survey");
        assert.ok(r.status === 404 || (r.json && r.json.survey === null),
          page + " was handed a survey (status " + r.status + ", body " + r.body.slice(0, 120) + ")");
      }
    });

    await atest("...and a submit from one is refused even with a valid survey id", async () => {
      const r = await req("POST", "/fixture-a/campmap/api/survey", { surveyId: created.id, answers: { q1: 5 } });
      assert.notStrictEqual(r.status, 200, "a campmap submit was accepted");
      assert.strictEqual(events().filter(e => e.report === "campmap" && e.event === "survey-response").length, 0);
    });

    await atest("an answer lands in the EVENT LOG, with the words intact", async () => {
      const r = await req("POST", "/fixture-a/facility/api/survey" + TOK, {
        surveyId: created.id,
        answers: { q1: 4, q2: "Month", q3: "  The week view wraps on my laptop.  " },
      });
      assert.strictEqual(r.status, 200, r.body.slice(0, 200));
      const e = events().filter(x => x.event === "survey-response").pop();
      assert.ok(e, "nothing reached events.jsonl");
      assert.strictEqual(e.answers.q1, 4);
      assert.strictEqual(e.answers.q2, "Month");
      assert.strictEqual(e.answers.q3, "The week view wraps on my laptop.");
      assert.strictEqual(e.report, "facility");
    });

    await atest("...and the Slack post carries the survey name and the words, not just an event", async () => {
      // notifySlack fires after the response, so give it a moment to land.
      for (let i = 0; i < 40 && !slackPosts.some(p => /How is the schedule/.test(p.text || "")); i++) {
        await new Promise(r => setTimeout(r, 100));
      }
      const post = slackPosts.map(p => p.text || "").find(t => /How is the schedule/.test(t));
      assert.ok(post, "no Slack post named the survey — got " + JSON.stringify(slackPosts.map(p => (p.text || "").slice(0, 60))));
      assert.ok(/The week view wraps on my laptop\./.test(post),
        "the free text is the reason to run a survey, and it is not in the post: " + post);
      assert.ok(/\b4\b/.test(post), "the scale answers should be summarised inline: " + post);
    });

    await atest("a missing REQUIRED answer is refused and says which one", async () => {
      const r = await req("POST", "/fixture-a/facility/api/survey" + TOK, { surveyId: created.id, answers: { q3: "hi" } });
      assert.strictEqual(r.status, 400);
      assert.deepStrictEqual(r.json.missing, ["q1"]);
    });

    await atest("an answer to a question the survey does not have is not an answer", async () => {
      const r = await req("POST", "/fixture-a/facility/api/survey" + TOK, { surveyId: created.id, answers: { ghost: 3 } });
      assert.strictEqual(r.status, 400);
    });

    await atest("a dismissal is recorded but does NOT count as a response", async () => {
      const r = await req("POST", "/fixture-a/facility/api/survey-dismiss" + TOK, { surveyId: created.id });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(events().filter(e => e.event === "survey-dismiss").length, 1);
    });

    await atest("the readout reads the answers back", async () => {
      const r = await req("POST", "/api/admin/surveys/responses", { password: PW, id: created.id });
      assert.strictEqual(r.status, 200, r.body.slice(0, 200));
      assert.strictEqual(r.json.responses, 1);
      assert.strictEqual(r.json.dismissed, 1);
      const q1 = r.json.questions.find(q => q.id === "q1");
      assert.strictEqual(q1.dist[4], 1, "the distribution must show the rating that was given");
      assert.strictEqual(q1.mean, null, "one rating must not be reported as an average");
      const q3 = r.json.questions.find(q => q.id === "q3");
      assert.strictEqual(q3.texts[0].text, "The week view wraps on my laptop.");
    });

    await atest("...and it refuses without the password, because it returns what orgs typed", async () => {
      const r = await req("POST", "/api/admin/surveys/responses", { id: created.id });
      assert.strictEqual(r.status, 401);
    });

    await atest("closing it stops collection — and says so rather than dropping the answer", async () => {
      const s = await req("POST", "/api/admin/surveys/status", { password: PW, id: created.id, status: "closed" });
      assert.strictEqual(s.status, 200);
      const g = await req("GET", "/fixture-a/facility/api/survey" + TOK);
      assert.strictEqual(g.json.survey, null, "a closed survey was still offered");
      const p = await req("POST", "/fixture-a/facility/api/survey" + TOK, { surveyId: created.id, answers: { q1: 5 } });
      assert.strictEqual(p.status, 409, "a late submit must be refused, not silently binned");
      assert.strictEqual(events().filter(e => e.event === "survey-response").length, 1);
    });

    await atest("editing keeps the id, so a survey keeps the answers it has collected", async () => {
      const r = await req("POST", "/api/admin/surveys", Object.assign({ password: PW, id: created.id, status: "live" },
        SURVEY, { title: "Renamed" }));
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.survey.id, created.id);
      const rd = await req("POST", "/api/admin/surveys/responses", { password: PW, id: created.id });
      assert.strictEqual(rd.json.responses, 1, "the readout lost its responses on an edit");
    });

    await atest("org targeting holds across two real orgs", async () => {
      await req("POST", "/api/admin/surveys", Object.assign({ password: PW, id: created.id, status: "live" },
        SURVEY, { targeting: { orgs: ["fixture-b"], reports: [] } }));
      const a = await req("GET", "/fixture-a/facility/api/survey" + TOK);
      const b = await req("GET", "/fixture-b/facility/api/survey?token=svyTokenBBBBBBBB");
      assert.strictEqual(a.json.survey, null, "an untargeted org was offered the survey");
      assert.ok(b.json.survey, "the targeted org was not offered it");
    });

    await atest("the delivery route is no-store, or publishing never reaches an open tab", async () => {
      /* ASSERTED AS A PAIR, because either half alone is satisfied by the
         wrong thing. The page-level no-store middleware sits above this route
         and would supply the header today, so the LIVE read passes even with
         the route's own set deleted — it is proving the header arrives, not
         that this route guarantees it. The SOURCE half is what fails when the
         route starts depending on its line number, which is exactly the
         registration-order bug this repo has now shipped four times. */
      const r = await req("GET", "/fixture-b/facility/api/survey?token=svyTokenBBBBBBBB");
      assert.ok(/no-store/.test(String(r.headers["cache-control"] || "")),
        "Cache-Control was " + JSON.stringify(r.headers["cache-control"]));
      const i = srv.indexOf('app.get("/:org/:report/api/survey"');
      assert.ok(/res\.set\("Cache-Control", "no-store"\)/.test(srv.slice(i, i + 1400)),
        "the route must set it itself, not inherit it from a middleware above");
    });

    await atest("a tokenless request to an admin page gets nothing at all", async () => {
      const r = await req("GET", "/fixture-b/facility/api/survey");
      assert.strictEqual(r.status, 404, "the org token gate must still apply");
    });

  } catch (e) {
    failures.push("live half — " + (e && e.message));
    console.log("  ✗ live half threw: " + (e && e.message));
  } finally {
    child.kill();
    slack.close();
    console.log("");
    if (failures.length) {
      console.log(failures.length + " FAILED:");
      failures.forEach(f => console.log("  ✗ " + f));
      process.exit(1);
    }
    console.log(pass + " assertions passed.");
  }
})();
