#!/usr/bin/env node
/**
 * CI guard: parse every <script type="text/babel"> block in public/*.html
 * through @babel/standalone (react preset). Fails the build if any JSX
 * won't compile — the class of error that has crashed prod on deploy.
 * Mirrors the manual pre-push check used during development.
 */
const fs = require('fs');
const path = require('path');
const Babel = require('@babel/standalone');

const dir = path.join(__dirname, '..', 'public');
if (!fs.existsSync(dir)) { console.log('no public/ directory — nothing to check'); process.exit(0); }

const files = fs.readdirSync(dir).filter(f => f.endsWith('.html'));
const re = /<script[^>]*type=["']text\/babel["'][^>]*>([\s\S]*?)<\/script>/g;
let failed = 0, blocks = 0;

for (const f of files) {
  const html = fs.readFileSync(path.join(dir, f), 'utf8');
  let m, i = 0;
  while ((m = re.exec(html)) !== null) {
    i++; blocks++;
    try {
      Babel.transform(m[1], { presets: ['react'], filename: f + '#block' + i });
    } catch (e) {
      console.error('✗ ' + f + ' (babel block #' + i + '): ' + String(e.message).split('\n')[0]);
      failed++;
    }
  }
}

console.log('Checked ' + blocks + ' babel block(s) across ' + files.length + ' HTML file(s) in public/.');
if (failed) { console.error('\n' + failed + ' JSX block(s) failed to parse — fix before deploy.'); process.exit(1); }
console.log('✓ All JSX parses cleanly.');
