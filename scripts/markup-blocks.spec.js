#!/usr/bin/env node
/**
 * A <style> OR <script> BLOCK MUST NOT END EARLY.
 *
 * Dan, 2026-09-22, with a screenshot of two hundred lines of CSS printed
 * across the top of the Cost Recovery report: "errrr".
 *
 * The HTML tokenizer ends a <style> element at the FIRST `</style` it meets.
 * It is not parsing CSS, so a CSS comment is no protection: this page carried
 *
 *     /* ... the two links sit AFTER this </style> so the skin wins ... *\/
 *
 * on line 20 of a 205-line stylesheet, and every rule after it rendered as
 * visible text in the body. The same rule governs <script> and `</script`
 * inside a JS string, which is the more famous half of this trap.
 *
 * NOTHING CAUGHT IT. node --check passes (the HTML is not JS). The JSX parse
 * check skips this page (it has no JSX). The server boots and serves 200 with
 * a complete document. All TEN cost-recovery render cases passed, because the
 * page is not broken — it is UNSTYLED, and every case keys on a computed
 * figure, and every figure was right. recess-palette.spec.js passed too: it
 * compares the skin's link position against the FIRST `</style>`, which was
 * the one in the comment.
 *
 * THE TEST IS A COUNT, and that is what makes it sound rather than fussy.
 * Outside HTML comments, a page has as many closers as openers. A `</style>`
 * written inside a CSS comment makes closers EXCEED openers — 1 opener and 2
 * closers on the page above. Measured across all 46 served pages: zero false
 * positives, and the bug as it shipped is flagged.
 */
const fs = require("fs");
const path = require("path");

let passed = 0;
const failures = [];
const ok = (c, l) => { if (c) passed++; else failures.push(l); };

const DIR = path.join(__dirname, "..", "public");
const pages = fs.readdirSync(DIR).filter(f => f.endsWith(".html")).sort();

// HTML comments are stripped first: `<style>` and `</style>` inside <!-- -->
// are inert, and several pages legitimately explain the cascade rule that way
// — including, after the fix, the page this spec exists for.
const stripComments = s => s.replace(/<!--[\s\S]*?-->/g, "");
const count = (s, tag) => [
  (s.match(new RegExp("<" + tag + "[\\s>]", "gi")) || []).length,
  (s.match(new RegExp("</" + tag, "gi")) || []).length,
];

// ── Vacuous-derivation guard. Every claim below compares two counts; if the
// directory read or the regexes stop matching, they are 0 === 0 on every page.
ok(pages.length >= 40, "the public/ glob found " + pages.length + " pages — it should find 40+; every assertion below is vacuous");
let totalOpeners = 0;

for (const f of pages) {
  const src = stripComments(fs.readFileSync(path.join(DIR, f), "utf8"));
  for (const tag of ["style", "script"]) {
    const [open, close] = count(src, tag);
    totalOpeners += open;
    ok(
      open === close,
      f + " has " + open + " <" + tag + "> opener(s) and " + close + " closer(s). " +
      (close > open
        ? "A `</" + tag + "` appears INSIDE the block — the tokenizer ends the element there, whatever the surrounding " +
          (tag === "style" ? "CSS comment" : "JS string") + " says, and everything after it renders as TEXT. Reword it; it cannot be escaped."
        : "An unclosed <" + tag + "> swallows the rest of the document.")
    );
  }
}

ok(totalOpeners >= 40, "only " + totalOpeners + " <style>/<script> openers across " + pages.length + " pages — the regex is not matching and these assertions are vacuous");

// ── And prove the test discriminates, on the bug exactly as it shipped,
// rather than trusting that a count is the right instrument.
const withBug = "<style>\n  /* links sit AFTER this </style> so the skin wins */\n  .a { color: red; }\n</style>";
const [o, c] = count(stripComments(withBug), "style");
ok(o === 1 && c === 2, "the counter does not see the shipped bug — expected 1 opener and 2 closers, got " + o + " and " + c);
ok(count(stripComments("<style>\n  .a { color: red; }\n</style>"), "style").join() === "1,1", "the counter flags a clean block");
ok(count(stripComments("<!-- linked after this page's own </style> -->"), "style").join() === "0,0", "a closer inside an HTML COMMENT counted — those are inert, and several pages explain the cascade that way");

if (failures.length) {
  console.error("\n" + failures.length + " FAILED:");
  failures.forEach(f => console.error("  ✗ " + f));
  process.exit(1);
}
console.log(passed + " assertions passed.");
