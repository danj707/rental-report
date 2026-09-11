#!/usr/bin/env node
/* THE RENTAL SCHEDULE'S COLUMNS, AND WHAT IT IS CALLED.

   Dan, with Euclid's schedule open and most of the column checkboxes turned
   off: "Turning off almost all checkboxes on the rental report, and expecting
   the data to fit on the page (clearly it is truncating, and shouldn't). Also,
   lets drop the 'Weekly' from the rental schedule and just call it the
   Facility Rental Schedule."

   THE CAUSE OF THE TRUNCATION WAS THAT NOTHING IN THE ROW GREW. `.data-row` is
   a flexbox and every column carried a fixed `width`; the one rule with
   flex-grow — `.col-name { flex: 1 }` — named a class NO ELEMENT HAS, so it
   had been dead for as long as the column set has looked like this. Every
   pixel of leftover width was dead space while Reservee clipped at 150px.

   The geometry itself is a browser question and is proven in
   ci-check-render.js; this file pins the rules that produce it, plus the one
   thing a render case cannot check at all — that the page and the SERVER agree
   on what this report is called. */
const fs = require('fs');
const path = require('path');

const PAGE_PATH = path.join(__dirname, '..', 'public', 'facility.html');
const page = fs.readFileSync(PAGE_PATH, 'utf8');
const srv  = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

let pass = 0;
const failures = [];
const ok = (c, m) => { c ? pass++ : failures.push(m); };
const eq = (g, w, m) => ok(g === w, m + ' — got ' + JSON.stringify(g) + ', want ' + JSON.stringify(w));

/* ── THE NAME ─────────────────────────────────────────────────────────────
   DERIVED FROM server.js, NEVER TRANSCRIBED. The server has called this
   "Facility Rental Schedule" in seven places all along — the PDF footer, the
   email subject, the dashboard card — and only the PAGE said "Weekly", so the
   page has been disagreeing with its own exports. A spec carrying its own copy
   of the name agrees with itself and nothing else. */
const label = (/facility:\s*\{\s*label:\s*"([^"]+)"/.exec(srv) || [])[1];
ok(label, "the server's own label for `facility` is readable — without it the next assertions are vacuous");
eq(label, 'Facility Rental Schedule', 'and it is what Dan asked the page to be called');
if (label) {
  ok(page.includes('<title>' + label + '</title>'),
     'the browser tab carries exactly the name the server uses for this report');
  ok(page.includes('<div className="title">' + label + '</div>'),
     '...and so does the header printed at the top of the page and the PDF');
}
ok(!/Weekly Rental Schedule/.test(page),
   '"Weekly" is gone — it was never true of a report whose window the reader picks');

/* ── THE COLUMNS ──────────────────────────────────────────────────────────
   A DEAD RULE IS WORSE THAN NO RULE: `.col-name { flex: 1 }` read as "the row
   grows" to anyone skimming the stylesheet, which is most of why this went
   unnoticed. Asserted over the CSS block only, since the explanation above it
   quotes the old rule on purpose. */
const cssBlock = (page.split('/* ── Column widths')[1] || '').split('</style>')[0];
ok(cssBlock.length > 200, 'the column-width block is readable — without it the rest of this is vacuous');
ok(!/^\s*\.col-name\s*\{/m.test(cssBlock),
   'the dead .col-name rule is gone rather than left to read as though the row grows');

/* THE TEXT COLUMNS GROW, THE RIGID ONES DO NOT. A basis rather than a width,
   so the column keeps the size it has today when there is nothing spare — the
   fix must not move the layout of an org showing every column. */
const grows = { 'col-site': 2, 'col-reservee': 2, 'col-email': 2, 'col-purpose': 3 };
for (const [cls, weight] of Object.entries(grows)) {
  const re = new RegExp('\\.' + cls + '\\s*\\{[^}]*flex:\\s*' + weight + ' 1 (\\d+)px');
  const m = re.exec(cssBlock);
  ok(m, cls + ' grows into spare width, with its old width as the basis');
  /* `min-width: 0`, because a flex item defaults to `min-width: auto` and
     refuses to shrink below its content — which would push the row wider than
     the page instead of wrapping it. */
  ok(new RegExp('\\.' + cls + '\\s*\\{[^}]*min-width:\\s*0').test(cssBlock),
     '...and can still shrink, so a narrow page wraps rather than overflowing');
}
/* THE NARROW COLUMNS STAY NARROW. A centred 46px count or a 62px total that
   grew would leave its heading floating over empty space. */
for (const cls of ['col-start', 'col-end', 'col-hcnt', 'col-total', 'col-sitetype',
                   'col-resident', 'col-booktype', 'col-paid', 'col-permit', 'col-rec-link']) {
  const m = new RegExp('\\.' + cls + '\\s*\\{([^}]*)\\}').exec(cssBlock);
  if (m) ok(!/flex:/.test(m[1]), cls + ' stays rigid — a fixed-size column has no spare width to want');
}

/* THE `!important`s ARE NOT DECORATION, and this is the assertion that names
   the actual defect in `.col-purpose`. `.data-row .cell` is (0,2,0) and sets
   `white-space: nowrap` + `text-overflow: ellipsis`; a bare `.col-x` is
   (0,1,0) and loses. `.col-purpose` said `white-space: normal` WITHOUT one and
   was therefore still being truncated, which is what Dan photographed. */
ok(/\.data-row \.cell\s*\{[^}]*text-overflow:\s*ellipsis/.test(page),
   'the row still truncates by default — without that rule the overrides below are pointless');
for (const cls of ['col-site', 'col-reservee', 'col-email', 'col-purpose', 'col-phone']) {
  const m = new RegExp('\\.' + cls + '\\s*\\{([^}]*)\\}').exec(cssBlock);
  ok(m, cls + ' is readable');
  if (!m) continue;
  const body = m[1];
  ok(/white-space:\s*normal\s*!important/.test(body),
     cls + ' wraps for real — a bare `white-space: normal` loses to `.data-row .cell` and still ellipsises');
  ok(/overflow:\s*visible\s*!important/.test(body),
     '...and is not clipped, or wrapping only hides the overflow instead of showing it');
  ok(/text-overflow:\s*clip\s*!important/.test(body),
     '...and grows no ellipsis of its own');
}

console.log(failures.length
  ? '\n✗ facility-columns.spec.js — ' + failures.length + ' failure(s):\n\n'
    + failures.map(f => '  ✗ ' + f).join('\n') + '\n\n'
    + pass + ' passed, ' + failures.length + ' failed.'
  : '✓ facility-columns.spec.js — ' + pass + ' assertions passed.');
process.exit(failures.length ? 1 : 0);
