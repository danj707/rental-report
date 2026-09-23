#!/usr/bin/env node
/**
 * EVERY SPEC IN scripts/ MUST BE NAMED BY A STEP IN ci.yml.
 *
 * Dan, 2026-09-22: "yeah sweep in that spec-coverage guard and the two cache
 * specs" — after the Cost Recovery report shipped with a 126-assertion spec,
 * mutation-tested 18 ways, that WAS NOT IN CI. Every spec here gets its own
 * hand-written step in .github/workflows/ci.yml, and a new spec file is simply
 * not run until somebody remembers to add one. Nobody did, so those assertions
 * ran exactly once, on the author's machine, while the commit message, the PR
 * body and CLAUDE.md all said they were wired.
 *
 * THE LIST IS DERIVED FROM THE DIRECTORY, NEVER TYPED HERE. That is the whole
 * point: this repo has now been bitten four times by a guard you have to
 * remember to extend (gl_codes, refunds, pii, sites all reached the screen and
 * not the PDF, each fixed with a spec naming that one filter). A hand-kept list
 * of specs is satisfied by forgetting to add to it, which is exactly the way
 * this fails. Add scripts/foo.spec.js with no step and the next run of this
 * fails, naming foo and telling the author what to write.
 *
 * A SPEC NAMED ONLY IN A COMMENT DOES NOT COUNT. ci.yml is thick with
 * explanatory comments that quote the very things they describe — this file's
 * own history records an assertion tripped by a comment quoting the string it
 * forbade, more than once — so the parse reads `run:` lines and nothing else,
 * and a synthetic case below proves it rather than asserting the intent.
 */
const fs = require("fs");
const path = require("path");

let passed = 0;
const failures = [];
const ok = (c, l) => { if (c) passed++; else failures.push(l); };
const eq = (a, b, l) => ok(a === b, l + " — expected " + JSON.stringify(b) + ", got " + JSON.stringify(a));

const ROOT = path.join(__dirname, "..");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "ci.yml");

// ── A spec that deliberately does not run in CI goes here WITH ITS REASON.
// Named one by one, never a pattern: an exemption that is a regex quietly
// widens into "any spec I did not want to wire", which is the hand-kept list
// this guard exists to replace. Empty today — every spec in scripts/ runs.
const NOT_IN_CI = {
  // "example.spec.js": "why this one cannot run on a GitHub runner",
};

// ── The parse. Full-line comments are dropped, then only a `run:` line counts.
// Deliberately not js-yaml: it is a TRANSITIVE dependency here, not a declared
// one, so an unrelated npm change would make this DIE with a module error
// rather than fail by name — the recorded rule that a guard which dies has not
// told anyone what broke.
function specsRunBy(yaml) {
  const found = new Set();
  for (const line of yaml.split("\n")) {
    if (line.trim().startsWith("#")) continue;
    const run = line.match(/^\s*(?:-\s*)?run:\s*(.*)$/);
    if (!run) continue;
    for (const m of run[1].matchAll(/scripts\/([A-Za-z0-9._-]+\.spec\.js)/g)) found.add(m[1]);
  }
  return found;
}

const yaml = fs.readFileSync(WORKFLOW, "utf8");
const onDisk = fs.readdirSync(path.join(ROOT, "scripts")).filter(f => f.endsWith(".spec.js")).sort();
const wired = specsRunBy(yaml);

// ── VACUOUS-DERIVATION GUARD, first, because every assertion below is a
// comparison of two derived sets: if the glob or the parse silently stops
// matching, the sets collapse to empty and the whole file passes on nothing.
ok(onDisk.length >= 80, "the scripts/ glob found " + onDisk.length + " spec files — it should find 80+; the derivation is broken and every assertion below this one is vacuous");
ok(wired.size >= 50, "the ci.yml parse found " + wired.size + " spec steps — it should find 50+; the derivation is broken and every assertion below this one is vacuous");

// ── A spec named ONLY in a comment must not count as wired. Proven on a
// synthetic workflow rather than asserted about the implementation, because
// "the parse reads run: lines" is exactly the claim a reader cannot check.
const synthetic = [
  "jobs:",
  "  validate:",
  "    steps:",
  "      # we should really wire scripts/commented-only.spec.js one day",
  "      - name: a real one",
  "        run: node scripts/really-wired.spec.js",
  "      #  run: node scripts/disabled.spec.js",
].join("\n");
const synth = specsRunBy(synthetic);
ok(synth.has("really-wired.spec.js"), "the parse missed a spec on a real run: line");
ok(!synth.has("commented-only.spec.js"), "a spec named only in a COMMENT counted as wired — a comment is not a step, and ci.yml is full of comments quoting the things they describe");
ok(!synth.has("disabled.spec.js"), "a COMMENTED-OUT run: line counted as wired — that is a step somebody switched off");

// ── The claim itself: every spec on disk is run, or exempt with a reason.
const unwired = onDisk.filter(f => !wired.has(f) && !(f in NOT_IN_CI));
ok(
  unwired.length === 0,
  unwired.length + " spec file(s) exist in scripts/ and are run by NO step in ci.yml: " + unwired.join(", ") +
  " — a spec that is not in CI ran once, on the machine of whoever wrote it, and guards nothing on any later push." +
  " Add a step to the validate job:  - name: <what it covers>\\n        run: node scripts/<name>  " +
  "— or, if it genuinely cannot run on a GitHub runner, add it to NOT_IN_CI in this file WITH ITS REASON."
);

// ── The exemption map cannot rot. A key naming a spec that no longer exists is
// an exemption nobody can see is dead, and the next file to take that name
// inherits a pass it never earned.
for (const name of Object.keys(NOT_IN_CI)) {
  ok(onDisk.includes(name), "NOT_IN_CI names " + name + ", which is not in scripts/ — a stale exemption silently widens this list");
  ok(typeof NOT_IN_CI[name] === "string" && NOT_IN_CI[name].trim().length > 10, "NOT_IN_CI[" + name + "] has no real reason — an exemption without one is how the list grows");
  ok(!wired.has(name), "NOT_IN_CI names " + name + ", but ci.yml runs it — it is not exempt, it is wired");
}

// ── The other direction. A `run:` naming a spec that does not exist already
// fails CI loudly (node exits non-zero on a missing module), so this is not
// the load-bearing half — but it fails HERE by name, in one second, instead of
// ninety steps into the validate job.
const ghosts = [...wired].filter(f => !onDisk.includes(f));
eq(ghosts.length, 0, "ci.yml runs spec file(s) that do not exist: " + ghosts.join(", "));

// ── And it covers itself, or the guard is one rename away from being the
// thing it is guarding against.
ok(wired.has("spec-coverage.spec.js"), "this spec is not itself run by ci.yml — a coverage guard that is not in CI is the bug it exists to catch");

if (failures.length) {
  console.error("\n" + failures.length + " FAILED:");
  failures.forEach(f => console.error("  ✗ " + f));
  process.exit(1);
}
console.log(passed + " assertions passed.");
