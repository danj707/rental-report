#!/usr/bin/env node
/**
 * CI guard: every inline <script> in public/*.html must parse.
 *
 * `text/babel` blocks go through @babel/standalone (react preset) — the class of
 * error that has crashed prod on deploy. PLAIN inline blocks go through
 * vm.Script, added 2026-08-22 after the dead-admin incident: a broken string in
 * generated JS silently discards its whole <script> block, so every function in
 * it becomes undefined and every button wired to one stops working. That bug was
 * in the server-rendered dashboard (now covered by ci-check-admin-js.js), but
 * public/org.html carries a 28KB plain block that nothing was parsing either —
 * same failure mode, same blast radius, one file over.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Babel = require('@babel/standalone');

const dir = path.join(__dirname, '..', 'public');
if (!fs.existsSync(dir)) { console.log('no public/ directory — nothing to check'); process.exit(0); }

const files = fs.readdirSync(dir).filter(f => f.endsWith('.html'));
// Any inline block (no src=), with its attributes, so each can be routed to the
// right parser.
const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g;
let failed = 0, jsxBlocks = 0, plainBlocks = 0;

for (const f of files) {
  const html = fs.readFileSync(path.join(dir, f), 'utf8');
  let m, i = 0;
  while ((m = re.exec(html)) !== null) {
    i++;
    const attrs = m[1] || '';
    const code = m[2];
    if (/type\s*=\s*["']text\/babel["']/.test(attrs)) {
      jsxBlocks++;
      try {
        Babel.transform(code, { presets: ['react'], filename: f + '#block' + i });
      } catch (e) {
        console.error('✗ ' + f + ' (babel block #' + i + '): ' + String(e.message).split('\n')[0]);
        failed++;
      }
      continue;
    }
    // A non-JS type (template, json, importmap…) is data, not code.
    if (/type\s*=/.test(attrs) && !/type\s*=\s*["'](?:text|application)\/javascript["']/.test(attrs)) continue;
    plainBlocks++;
    try {
      new vm.Script(code, { filename: f + '#block' + i });
    } catch (e) {
      console.error('✗ ' + f + ' (plain block #' + i + '): ' + String(e.message).split('\n')[0]);
      failed++;
    }
  }
}

console.log('Checked ' + jsxBlocks + ' babel and ' + plainBlocks + ' plain inline block(s) across '
  + files.length + ' HTML file(s) in public/.');
if (failed) { console.error('\n' + failed + ' block(s) failed to parse — fix before deploy.'); process.exit(1); }
console.log('✓ All inline JavaScript parses cleanly.');
