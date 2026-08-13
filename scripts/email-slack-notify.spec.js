// Tests the REAL notifySlack() Slack-notification logic from server.js for the
// new "email" event, by extracting the SLACK_* block + notifySlack from source
// and running it with a mock webhook. Run: node scripts/email-slack-notify.spec.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const start = src.indexOf("const SLACK_NOTIFY = new Set(");
const end = src.indexOf("// Read events file");
assert(start !== -1 && end !== -1 && end > start, "could not locate SLACK block in server.js");
const block = src.slice(start, end);

// Build the block in an isolated scope with injected deps; return notifySlack.
const make = (deps) => new Function(
  "SLACK_WEBHOOK_URL", "SLACK_MENTION_USER_ID", "ORGS", "fetch", "AbortSignal",
  block + "\nreturn { notifySlack };"
)(deps.SLACK_WEBHOOK_URL, deps.SLACK_MENTION_USER_ID, deps.ORGS, deps.fetch, deps.AbortSignal);

function harness() {
  const posts = [];
  const fetch = (url, opts) => { posts.push(JSON.parse(opts.body).text); return Promise.resolve(); };
  const AbortSignalStub = { timeout: () => undefined };
  const ORGS = { apex: { displayName: "Apex Park & Rec" } };
  const { notifySlack } = make({ SLACK_WEBHOOK_URL: "https://hooks.slack/test", SLACK_MENTION_USER_ID: "", ORGS, fetch, AbortSignal: AbortSignalStub });
  return { notifySlack, posts };
}

let passed = 0;
const test = (name, fn) => { fn(); console.log("  ✓ " + name); passed++; };

test("email is a notifiable event; scheduled send formats correctly", () => {
  const { notifySlack, posts } = harness();
  notifySlack({ org: "apex", report: "facility", event: "email", email: "dan@rec.us", schedule: "daily", trigger: "scheduled", status: "sent" });
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0], "📧 Apex Park & Rec (`apex`) emailed *facility* to `dan@rec.us` · daily queue");
});

test("manual send is labeled 'manual send'", () => {
  const { notifySlack, posts } = harness();
  notifySlack({ org: "apex", report: "gl", event: "email", email: "a@b.com", schedule: "daily", trigger: "manual", status: "sent" });
  assert.strictEqual(posts[0], "📧 Apex Park & Rec (`apex`) emailed *gl* to `a@b.com` · manual send");
});

test("failed send is flagged", () => {
  const { notifySlack, posts } = harness();
  notifySlack({ org: "apex", report: "facility", event: "email", email: "x@y.com", schedule: "weekly", trigger: "scheduled", status: "error" });
  assert.match(posts[0], /^⚠️ Apex Park & Rec \(`apex`\) email FAILED for \*facility\* to `x@y\.com` · weekly queue$/);
});

test("a daily run to DIFFERENT recipients posts each (not collapsed)", () => {
  const { notifySlack, posts } = harness();
  for (const e of ["one@x.com", "two@x.com", "three@x.com"])
    notifySlack({ org: "apex", report: "facility", event: "email", email: e, schedule: "daily", trigger: "scheduled", status: "sent" });
  assert.strictEqual(posts.length, 3, "expected one Slack line per recipient");
});

test("duplicate send to the SAME recipient within cooldown is debounced", () => {
  const { notifySlack, posts } = harness();
  const rec = { org: "apex", report: "facility", event: "email", email: "dup@x.com", schedule: "daily", trigger: "scheduled", status: "sent" };
  notifySlack(rec); notifySlack(rec);
  assert.strictEqual(posts.length, 1, "identical rapid re-fire should be deduped");
});

test("unrelated non-notify events still don't post", () => {
  const { notifySlack, posts } = harness();
  notifySlack({ org: "apex", report: "facility", event: "fetch" });
  assert.strictEqual(posts.length, 0);
});

test("existing 'view' event still formats as before (no regression)", () => {
  const { notifySlack, posts } = harness();
  notifySlack({ org: "apex", report: "calendar", event: "view" });
  assert.strictEqual(posts[0], "👀 Apex Park & Rec (`apex`) viewed *calendar*");
});

console.log(`\n${passed}/${passed} passing`);
