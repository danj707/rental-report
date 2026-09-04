#!/usr/bin/env node
/* THE SERVER'S OWN ERROR MESSAGE HAS TO REACH THE READER.
   ─────────────────────────────────────────────────────────────────────────────
   Dan, on Pawnee's Memberships summary over 09/04/2025–09/30/2026:
   "memberships report summary page is struggling" — the panel read

       "Looks like reporting has encountered an issue — try loading this report
        again later. Server returned 504"

   The data route had already sent back a sentence saying what to do:

       "Metabase query timed out after 60s+120s retry — try a shorter date range
        or refresh"

   ...and eight report pages threw `new Error("Server returned " + r.status)`,
   dropping the body. So the reader was told the transport and not the remedy,
   on a failure whose remedy is one control away. Measured, cache-independent:
   card 17301 for Pawnee over that window TIMES OUT past 300s, while a
   one-month window returns in 55s — so "try a shorter range" is not a platitude
   here, it is the actual fix.

   Every assertion below is about that path, and none of them is "an error
   renders": a page that shows the status code renders identically. */
const fs = require('fs');
const path = require('path');
const P = f => path.join(__dirname, '..', f);

const failures = [];
let pass = 0;
const ok = (c, m) => { c ? pass++ : failures.push(m); };
const eq = (g, w, m) => ok(g === w, m + ' — got ' + JSON.stringify(g) + ', want ' + JSON.stringify(w));

const shared = fs.readFileSync(P('public/open-pdf.js'), 'utf8');
const srv    = fs.readFileSync(P('server.js'), 'utf8');

/* ── 1. ONE IMPLEMENTATION, in the file every report page already loads ─────
   Eight pages carried the same throw; eight copies of the recovery would drift
   the first time the route's wording changed. Same rule that keeps
   `saveTextViaPopup` and `csvFromRows` in this file. */
ok(/function reportFetchError\(/.test(shared),
   'the reader lives in open-pdf.js, which every report page already loads');
ok(/window\.reportFetchError = reportFetchError/.test(shared),
   '...and is exported, or a babel block cannot see it');

/* ── 2. RUN IT, over the four shapes a failing response really takes ────────
   A regex over a fallback chain passes on an inverted one. */
let reportFetchError;
try {
  const i = shared.indexOf('async function reportFetchError(');
  reportFetchError = new Function(
    shared.slice(i).replace(/\nif \(typeof window[\s\S]*$/, '') +
    '\nreturn reportFetchError;')();
  pass++;
} catch (e) {
  failures.push('reportFetchError THREW when lifted: ' + e.message);
}

if (reportFetchError) {
  /* THE FAKE RESPONSE CARRIES BOTH text() AND json(), so an implementation
     that reaches for the wrong one exercises the REAL failure (JSON.parse
     choking on the edge's HTML) rather than a TypeError about a missing
     method — which would fail for the wrong reason and prove nothing. */
  const res = (status, body) => ({
    status,
    text: async () => body,
    json: async () => JSON.parse(body),
  });
  /* AND EVERY CALL IS ATTEMPTED, so a throwing implementation fails on the
     assertion that provoked it, by name. A guard that dies instead of failing
     has not told anyone what broke — recorded five times in CLAUDE.md, and
     this spec's first draft made it a sixth. */
  const attempt = async (what, fn) => {
    try { return await fn(); }
    catch (e) { failures.push(what + ' — the reader THREW: ' + e.message); return new Error(''); }
  };
  const run = async () => {
    /* THE ROUTE'S OWN SENTENCE WINS, and the status still travels with it —
       "which failure was it" is the first thing asked when one of these is
       reported, and a sentence alone loses it. */
    const timeout = await attempt('a 504 carrying the route\'s JSON message', () =>
      reportFetchError(res(504, JSON.stringify({
        error: 'Metabase query timed out after 60s+120s retry — try a shorter date range or refresh' }))));
    ok(/try a shorter date range/.test(timeout.message),
       "the route's own remedy reaches the reader");
    ok(/504/.test(timeout.message), '...with the status still on it');
    ok(!/^Server returned/.test(timeout.message), '...and not the bare status it replaced');

    /* IT MUST NOT ASSUME JSON. A 502/504 from Railway's edge never reaches the
       app and comes back as an HTML page; a bare r.json() there would throw
       INSIDE the error handler and replace a poor message with a confusing
       one. This is the assertion that makes the change safe to ship. */
    const edge = await attempt('a 504 carrying HTML from the edge', () =>
      reportFetchError(res(504, '<html><body>Application failed to respond</body></html>')));
    ok(edge instanceof Error, 'an HTML body from the edge still produces an Error, not a throw');
    ok(/shorter date range/.test(edge.message),
       '...and a 504 with no readable body still says what to try');
    ok(/504/.test(edge.message), '...and still carries the status');

    // A body that cannot be read at all — falls back to exactly today's wording,
    // so this change can only ever improve a message, never degrade one.
    const dead = await attempt('a body that cannot be read', () => reportFetchError({
      status: 500,
      text: async () => { throw new Error('consumed'); },
      json: async () => { throw new Error('consumed'); },
    }));
    eq(dead.message, 'Server returned 500', 'an unreadable body falls back to the status code');

    const empty = await attempt('an empty body', () => reportFetchError(res(500, '')));
    eq(empty.message, 'Server returned 500', '...and so does an empty one');

    // JSON with no `error` key is not a message.
    const shapeless = await attempt('JSON with no error key', () =>
      reportFetchError(res(500, JSON.stringify({ rows: [] }))));
    eq(shapeless.message, 'Server returned 500', 'JSON carrying no error key is not treated as one');
  };
  const done = run();
  process.on('beforeExit', () => {});
  module.exports = done;
  // Synchronous report below runs after the awaits resolve.
  done.then(report).catch(e => { failures.push('the run THREW: ' + e.message); report(); });
} else { report(); }

function report() {
  /* ── 3. NO PAGE MAY KEEP THE OLD THROW ───────────────────────────────────
     Scoped to the pages that actually load the shared file: metrics.html does
     not, and a spec that demanded it there would be asking for a call to a
     function that is not on the page. */
  const pages = fs.readdirSync(P('public')).filter(f => f.endsWith('.html'));
  const withShared = pages.filter(f => /open-pdf\.js/.test(fs.readFileSync(P('public/' + f), 'utf8')));
  ok(withShared.length >= 7, 'the shared file is loaded by the report pages (' + withShared.length + ')');
  withShared.forEach(f => {
    const s = fs.readFileSync(P('public/' + f), 'utf8');
    if (!/Server returned/.test(s) && !/reportFetchError/.test(s)) return;  // no data fetch
    ok(!/throw new Error\(`Server returned \$\{r\.status\}`\)/.test(s),
       f + ' no longer throws away the response body');
    /* AND THE OWNING ARROW IS ASYNC. `throw await` inside a non-async arrow is
       a SyntaxError that takes the whole babel block with it — the blank-page
       class this repo has shipped twice — and it is invisible to node --check
       because the code is a string inside an HTML file. */
    if (/throw await reportFetchError/.test(s)) {
      const lines = s.split('\n');
      lines.forEach((ln, i) => {
        if (!/throw await reportFetchError/.test(ln)) return;
        const ctx = lines.slice(Math.max(0, i - 4), i + 1).join('\n');
        ok(/async r\s*=>/.test(ctx), f + ':' + (i + 1) + ' sits inside an ASYNC arrow');
      });
    }
  });

  /* ── 4. THE ROUTE STILL SENDS SOMETHING WORTH READING ────────────────────
     The page can only surface what the server puts in the body, so the pair is
     the guard: drop the sentence from the route and the reader is back to a
     status code however well the page behaves. */
  ok(/try a shorter date range or refresh/.test(srv),
     'the data route still sends the remedy in its 504 body');
  ok(/res\.status\(isTimeout \? 504 : 500\)\.json\(\{ error: msg \}\)/.test(srv),
     '...on the `error` key the reader looks for');

  /* AND THE STALE FALLBACK CANNOT RESCUE A TYPED WINDOW. `feedCacheKey`
     includes the encoded parameter string, so every distinct date range is its
     own entry — the timeout path's getStaleCached() has nothing to serve for a
     window nobody has asked for before. That is why Dan saw a 504 rather than
     stale numbers, and it is why the MESSAGE is the whole mitigation until the
     card is faster. */
  ok(/getStaleCached\(req\.orgSlug, req\.reportType, cacheKey\)/.test(srv),
     'the timeout path still tries a stale entry first, keyed by the window');

  if (failures.length) {
    console.error('\n✗ feed-error-message.spec.js — ' + failures.length + ' failure(s):\n');
    failures.forEach(f => console.error('  ✗ ' + f));
    console.error('\n' + pass + ' passed, ' + failures.length + ' failed.\n');
    process.exit(1);
  }
  console.log('✓ feed-error-message.spec.js — ' + pass + ' assertions passed.');
}
