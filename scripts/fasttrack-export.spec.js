#!/usr/bin/env node
/* ============================================================================
 * fasttrack-export.spec.js — the per-section "⬇ CSV" export on the Fast Track
 * flow board (Dan, 2026-09-01): *"add an 'export CSV' button/link to each Fast
 * Track section in this bottom table. Giving orgs the ability to export a csv of
 * the user information who has these fast tracked."*
 *
 * WHAT THIS PINS, and why each one is a bug that has actually shipped here:
 *
 *   1. ONE ROW PER PARTICIPANT PER ACCOUNT. The section badge counts booking
 *      ACCOUNTS, so a parent who fast-tracked two children is ONE row there —
 *      measured at Essex Junction, 37 accounts hold 43 children. An org working
 *      this list needs the children, and grouping by (account, participant) also
 *      gives each child its own hold count, which the badge cannot.
 *   2. THE PARTICIPANT KEY IS SCOPED TO THE ACCOUNT. All the feed has is a NAME,
 *      and apex really has two different children both called Bridger Wall (see
 *      the ePACT backcheck) — so an org-wide name key would merge two families.
 *   3. THE EARLIEST SIGNUP IS COMPARED AS A STRING, never through new Date():
 *      a bare YYYY-MM-DD parses as UTC midnight and lands on the previous day
 *      west of UTC. Same trap as parseCardDate, one function over.
 *   4. CRLF AND RFC4180 QUOTING. A section named "Camp, Red" shifts every column
 *      after it otherwise, and some Windows importers refuse a bare LF.
 *   5. THE BOM GOES ON THE FILE, NOT THE CLIPBOARD. Excel sniffs bytes rather
 *      than trusting UTF-8, so an accented name opens as mojibake without it —
 *      while a BOM in a paste shows up as a stray character in the first cell.
 *   6. IT GOES THROUGH saveTextViaPopup, the ONE popup implementation in
 *      open-pdf.js, because a download started by a sandboxed iframe is silently
 *      dropped. A second copy drifts the first time a browser changes its mind.
 *   7. THE BEACON NAMES ITS EVENT IN THE QUERY STRING and is allowlisted. A JSON
 *      body comes back 400 Unknown event and a fire-and-forget beacon never
 *      complains — that has bitten this repo FOUR times.
 *
 * It LIFTS AND RUNS the builders, and boots a server for the beacon half —
 * a source assertion has never once caught the beacon bug.
 *
 * Run: node scripts/fasttrack-export.spec.js     (SKIP_SOURCE=1 for the live half alone)
 * ==========================================================================*/
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const src  = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const page = fs.readFileSync(path.join(ROOT, "public", "fasttrack.html"), "utf8");
const pdfjs = fs.readFileSync(path.join(ROOT, "public", "open-pdf.js"), "utf8");
const SKIP_SOURCE = process.env.SKIP_SOURCE === "1";

let passed = 0;
const test = (name, fn) => Promise.resolve(fn()).then(() => { console.log(`  ✓ ${name}`); passed++; });

// ── lift and RUN the builders ──────────────────────────────────────────────
function liftFn(text, name) {
  const start = text.indexOf("function " + name + "(");
  if (start < 0) throw new Error(name + " not found at module scope — a spec cannot run what it cannot reach");
  let depth = 0, i = text.indexOf("{", start);
  for (; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (depth === 0) break; }
  }
  return text.slice(start, i + 1);
}
const headersSrc = /const FT_EXPORT_HEADERS = \[[\s\S]*?\];/.exec(page);
assert.ok(headersSrc, "FT_EXPORT_HEADERS not found at module scope");
const { ftExportRows, ftExportCsv, ftExportFileSlug, FT_EXPORT_HEADERS } = new Function(
  liftFn(page, "ftExportRows") + "\n" + headersSrc[0] + "\n" +
  liftFn(page, "ftExportCsv") + "\n" + liftFn(page, "ftExportFileSlug") +
  "; return { ftExportRows, ftExportCsv, ftExportFileSlug, FT_EXPORT_HEADERS };")();

// ── the Essex Junction shape, which is why this export exists ──────────────
// A per-session camp over 9 days: one hold per child per DAY. Alyssa Callan has
// two children on the same account — the case the "N people" badge cannot show.
const SEC = "sec-k2";
const booking = (account, email, participant, status, day) => ({
  "Row Type": "ft_booking", "Section ID": SEC, "Program": "Fall Vacation Camps (Sept-Dec 2026)",
  "Section": "K-2nd Vacation Camp (Fall 2026)", "Season": "Fall 2026", "Reg Mode": "per-session",
  "User ID": "acct-" + account.toLowerCase().replace(/\W+/g, "-"), "User Name": account,
  "User Email": email, "Participant Name": participant, "FT Status": status,
  "Signup Date": "2026-08-" + String(day).padStart(2, "0"),
});
const FEED = [
  // Aislyn Allen — one child, 3 holds, all pending.
  booking("Aislyn Allen", "allenaislynm@gmail.com", "Carter Allen", "Pending", 12),
  booking("Aislyn Allen", "allenaislynm@gmail.com", "Carter Allen", "Pending", 11),
  booking("Aislyn Allen", "allenaislynm@gmail.com", "Carter Allen", "Pending", 14),
  // Alyssa Callan — TWO children on ONE account. This is the row the badge hides.
  booking("Alyssa Callan", "acallan@ejrp.org", "Layla Callan", "Pending", 13),
  booking("Alyssa Callan", "acallan@ejrp.org", "Layla Callan", "Converted", 13),
  booking("Alyssa Callan", "acallan@ejrp.org", "Tiger Callan", "Pending", 13),
  // A booking made for the account holder themselves — no separate participant.
  { ...booking("Dana Reed", "dana@example.com", "", "Pending", 20) },
  // Another section entirely: it must not leak into this export.
  { ...booking("Someone Else", "else@example.com", "Kid Else", "Pending", 9), "Section ID": "sec-other" },
];

(async () => {
  await test("it exports one row per PARTICIPANT, not per account", () => {
    const rows = ftExportRows(SEC, FEED);
    // 3 accounts but FOUR participants: Carter, Layla, Tiger, Dana.
    assert.strictEqual(rows.length, 4, "expected 4 participant rows, got " + rows.length);
    const names = rows.map(r => r.participant).sort();
    assert.deepStrictEqual(names, ["Carter Allen", "Dana Reed", "Layla Callan", "Tiger Callan"]);
  });

  await test("...and each participant carries ITS OWN hold count", () => {
    const rows = ftExportRows(SEC, FEED);
    const by = Object.fromEntries(rows.map(r => [r.participant, r]));
    assert.strictEqual(by["Carter Allen"].holds, 3);
    assert.strictEqual(by["Layla Callan"].holds, 2, "the two siblings must not share a count");
    assert.strictEqual(by["Tiger Callan"].holds, 1);
    assert.strictEqual(by["Layla Callan"].converted, 1);
    assert.strictEqual(by["Layla Callan"].pending, 1);
    assert.strictEqual(by["Carter Allen"].converted, 0);
  });

  await test("a booking for the account holder keeps their name rather than exporting blank", () => {
    const rows = ftExportRows(SEC, FEED);
    const dana = rows.find(r => r.account === "Dana Reed");
    assert.ok(dana, "the self-booking was dropped");
    assert.strictEqual(dana.participant, "Dana Reed");
  });

  await test("another section's holds do not leak in", () => {
    const rows = ftExportRows(SEC, FEED);
    assert.ok(!rows.some(r => r.participant === "Kid Else"), "sec-other bled into this export");
    assert.strictEqual(ftExportRows("sec-other", FEED).length, 1);
  });

  await test("the account carries the email, so an org can actually contact them", () => {
    const rows = ftExportRows(SEC, FEED);
    const layla = rows.find(r => r.participant === "Layla Callan");
    assert.strictEqual(layla.email, "acallan@ejrp.org");
    assert.strictEqual(layla.account, "Alyssa Callan");
  });

  await test("the earliest signup wins", () => {
    const rows = ftExportRows(SEC, FEED);
    const carter = rows.find(r => r.participant === "Carter Allen");
    // Rows arrive 08-12, 08-11, 08-14; the earliest is the 11th.
    assert.strictEqual(carter.firstSignup, "2026-08-11");
  });

  await test("...and it is compared as a STRING, never through new Date()", () => {
    // A VALUE assertion cannot catch this: new Date(a) < new Date(b) orders two
    // ISO dates identically, so both implementations return 08-11 and the test
    // above passes either way. What differs is that new Date('2026-08-11') is UTC
    // midnight, which is the previous day west of UTC — the same trap as
    // parseCardDate one function over. So this is asserted on the SOURCE, and it
    // is the only thing here that discriminates.
    // COMMENTS ARE STRIPPED FIRST. The function's own comment quotes the broken
    // form on purpose, so a bare test fails on correct code — the same note is
    // already recorded for checkin-status.spec.js and the uncast date tags.
    const body = liftFn(page, "ftExportRows")
      .replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(!/new Date\(/.test(body),
      "ftExportRows must compare the card's own ISO strings, not construct Dates");
  });

  await test("two same-named children on DIFFERENT accounts stay two rows", () => {
    // Apex really has two different children both called Bridger Wall (the ePACT
    // backcheck). The participant key is scoped to the ACCOUNT for exactly this,
    // and an org-wide name key would merge two families into one row.
    const twins = [
      booking("Household One", "one@example.com", "Bridger Wall", "Pending", 5),
      booking("Household Two", "two@example.com", "Bridger Wall", "Pending", 6),
    ];
    const rows = ftExportRows(SEC, twins);
    assert.strictEqual(rows.length, 2, "the two families were merged into one row");
    assert.deepStrictEqual(rows.map(r => r.account).sort(), ["Household One", "Household Two"]);
    rows.forEach(r => assert.strictEqual(r.holds, 1, "and neither inherited the other's hold"));
  });

  await test("converted rows lead, then the busiest — so two runs cannot disagree", () => {
    const rows = ftExportRows(SEC, FEED);
    assert.strictEqual(rows[0].participant, "Layla Callan", "the only converted participant should lead");
    const rest = rows.slice(1).map(r => r.holds);
    assert.deepStrictEqual(rest, [3, 1, 1], "the rest should be busiest-first");
  });

  await test("an empty feed exports nothing rather than a header-only file", () => {
    assert.strictEqual(ftExportRows(SEC, []).length, 0);
    assert.strictEqual(ftExportRows(SEC, null).length, 0);
  });

  // ── the CSV itself ───────────────────────────────────────────────────────
  await test("the header row is the documented column set", () => {
    const csv = ftExportCsv(ftExportRows(SEC, FEED));
    assert.strictEqual(csv.split("\r\n")[0], FT_EXPORT_HEADERS.join(","));
    ["Participant", "Account Email", "Fast Tracks", "Pending"].forEach(h =>
      assert.ok(FT_EXPORT_HEADERS.includes(h), "missing column " + h));
  });

  await test("it is CRLF, and every row has the same column count", () => {
    const csv = ftExportCsv(ftExportRows(SEC, FEED));
    assert.ok(csv.endsWith("\r\n"), "should end with CRLF");
    assert.ok(!/[^\r]\n/.test(csv), "found a bare LF — some Windows importers refuse it");
    const lines = csv.trim().split("\r\n");
    assert.strictEqual(lines.length, 5, "header + 4 participants");
  });

  await test("a comma in a section name is QUOTED, not left to shift every column", () => {
    const rows = ftExportRows(SEC, FEED.map(r => ({ ...r, "Section": 'Camp, Red' })));
    const csv = ftExportCsv(rows);
    assert.ok(csv.includes('"Camp, Red"'), "the section name should be quoted");
    // And the row still has exactly as many fields as the header.
    const line = csv.trim().split("\r\n")[1];
    assert.strictEqual((line.match(/,/g) || []).length - 1, FT_EXPORT_HEADERS.length - 1,
      "the quoted comma still shifted the columns");
  });

  await test("an embedded quote is DOUBLED", () => {
    const csv = ftExportCsv([{ program: "P", section: 'The "Big" Camp', season: "", regMode: "",
                               participant: "A", account: "B", email: "c@d.e",
                               holds: 1, converted: 0, pending: 1, firstSignup: "2026-08-01" }]);
    assert.ok(csv.includes('"The ""Big"" Camp"'), "quotes must be doubled, not dropped");
  });

  await test("the filename slug survives being a filename", () => {
    assert.strictEqual(ftExportFileSlug("K-2nd Vacation Camp (Fall 2026)"), "k-2nd-vacation-camp-fall-2026");
    assert.strictEqual(ftExportFileSlug("///"), "");
  });

  // ── delivery and wiring ──────────────────────────────────────────────────
  if (!SKIP_SOURCE) {
    await test("it delivers through saveTextViaPopup — the ONE popup implementation", () => {
      assert.ok(/window\.saveTextViaPopup\(csv, name, \{ bom: true \}\)/.test(page),
        "the export must go through open-pdf.js's popup, with a BOM on the file");
      assert.ok(/<script src="\/open-pdf\.js"/.test(page), "open-pdf.js is not loaded on this page");
      // ...and there is exactly one implementation of it, in that file.
      assert.strictEqual((pdfjs.match(/window\.saveTextViaPopup = /g) || []).length, 1);
      assert.ok(!/window\.saveTextViaPopup = /.test(page), "the page must not grow its own copy");
    });

    await test("the BOM is a DELIVERY option, never baked into the builder", () => {
      // A BOM inside ftExportCsv would ride into the clipboard copy, where it
      // shows up as a stray character in the first cell.
      assert.ok(!/﻿/.test(liftFn(page, "ftExportCsv")), "the builder must stay pure text");
      const csv = ftExportCsv(ftExportRows(SEC, FEED));
      assert.ok(!csv.startsWith("﻿"), "the built string must carry no BOM");
    });

    await test("the button is ABSENT when there is nobody to export", () => {
      assert.ok(/hasUsers && React\.createElement\('button', \{\s*\n?\s*type: 'button', 'data-ft-export'/.test(page),
        "the CSV button must be gated on hasUsers — a control that yields an empty file is a dead end");
    });

    await test("clicking it does NOT also toggle the expander", () => {
      assert.ok(/onClick: function\(e\) \{ e\.stopPropagation\(\); exportSectionCsv\(s\); \}/.test(page),
        "the section row's own onClick opens the panel; the export must stop propagation");
    });

    await test("the beacon names its event in the QUERY STRING", () => {
      assert.ok(/new URLSearchParams\(\{ event: event \}\)/.test(page),
        "logClientEvent must put the event in the query string, not a JSON body");
      assert.ok(!/api\/log[^\n]*body:\s*JSON\.stringify/.test(page),
        "a body-only ping comes back 400 and never complains — the four-time trap");
      assert.ok(/logClientEvent\('ft-export'/.test(page), "the export must ping ft-export");
    });

    await test("ft-export is allowlisted on the log route, or the beacon 400s", () => {
      const m = /const ALLOWED = (\["excel"[^\]]+\]);/.exec(src);
      assert.ok(m, "the generic log route's ALLOWED list moved");
      assert.ok(JSON.parse(m[1]).includes("ft-export"), "ft-export is not allowlisted");
    });

    await test("...and in SLACK_NOTIFY, or it records and is never seen", () => {
      const m = /const SLACK_NOTIFY = new Set\((\[[^\]]+\])\)/.exec(src);
      assert.ok(m, "SLACK_NOTIFY not found");
      // MEMBERSHIP, not position: pinning an adjacent literal breaks the day
      // someone inserts an event between two others, with nothing to do with this.
      assert.ok(JSON.parse(m[1]).includes("ft-export"), "ft-export is missing from SLACK_NOTIFY");
      assert.ok(/"ft-export": \{ emoji:/.test(src), "ft-export needs an emoji/verb entry");
    });

    await test("it debounces by SECTION — four camps read as four camps", () => {
      assert.ok(/rec\.event === "ft-export"\s*\n\s*\?\s*`\$\{rec\.org\}\|\$\{rec\.report\}\|ft-export\|\$\{rec\.section \|\| ""\}`/.test(src),
        "without the section in the key, pulling four lists posts once");
    });

    await test("its Slack message names the section and BOTH counts", () => {
      assert.ok(/rec\.event === "ft-export"/.test(src) && /rec\.people/.test(src) && /rec\.holds/.test(src),
        "43 people holding 282 camp-days is a per-session camp; 43 holding 43 is not");
    });
  }

  // ── live: the beacon actually records ────────────────────────────────────
  const PORT = 3996;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-export-"));
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir,
           METABASE_URL: "http://127.0.0.1:9", RESEND_API_KEY: "",
           SLACK_WEBHOOK_URL: "", DASHBOARD_PASSWORD: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let boot = "";
  child.stdout.on("data", d => { boot += d; });
  child.stderr.on("data", d => { boot += d; });

  const { org, token } = (() => {
    const i = src.indexOf("const ORGS = {");
    const j = src.indexOf("\nconst REPORT_TYPES", i);
    const ORGS = require("vm").runInNewContext("(" + src.slice(src.indexOf("{", i), j).trim().replace(/;$/, "") + ")");
    const slug = Object.keys(ORGS).find(k => ORGS[k] && ORGS[k].token);
    assert.ok(slug, "no org with a token in server.js");
    return { org: slug, token: ORGS[slug].token };
  })();
  const TOK = "token=" + encodeURIComponent(token);

  const post = (qs, body) => new Promise((res, rej) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, method: "POST",
        path: `/${org}/fasttrack/api/log?${qs}${qs ? "&" : ""}${TOK}`, timeout: 15000,
        headers: body ? { "Content-Type": "application/json" } : {} },
      r => { let b = ""; r.on("data", d => b += d); r.on("end", () => res({ status: r.statusCode, body: b })); });
    req.on("error", rej); req.on("timeout", () => { req.destroy(); rej(new Error("timeout")); });
    req.end(body ? JSON.stringify(body) : undefined);
  });
  const events = () => {
    const f = path.join(dataDir, "events.jsonl");
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return {}; } });
  };

  try {
    await new Promise((res, rej) => {
      const t0 = Date.now(), tick = () => {
        if (Date.now() - t0 > 60000) return rej(new Error("server did not boot\n" + boot.slice(-600)));
        const r = http.get({ host: "127.0.0.1", port: PORT, path: "/", timeout: 3000 }, x => { x.resume(); res(); });
        r.on("error", () => setTimeout(tick, 400));
        r.on("timeout", () => { r.destroy(); setTimeout(tick, 400); });
      }; tick();
    });

    await test("live · the export ping records, with both counts", async () => {
      const r = await post("event=ft-export&section=K-2nd%20Vacation%20Camp&people=43&holds=282");
      assert.strictEqual(r.status, 200, r.body);
      const rec = events().filter(x => x.event === "ft-export").pop();
      assert.ok(rec, "nothing reached events.jsonl — a 200 alone would not prove it");
      assert.strictEqual(rec.report, "fasttrack");
      assert.strictEqual(rec.section, "K-2nd Vacation Camp");
      assert.strictEqual(rec.people, 43);
      assert.strictEqual(rec.holds, 282);
    });

    await test("live · the old body-only shape is still rejected", async () => {
      const r = await post("", { action: "ft-export" });
      assert.strictEqual(r.status, 400, "a body-only ping must not be accepted: " + r.body);
    });

    await test("live · absurd counts are dropped, not stored", async () => {
      await post("event=ft-export&section=X&people=-3&holds=99999999");
      const rec = events().filter(x => x.event === "ft-export").pop();
      assert.strictEqual(rec.people, undefined, "a negative count should be dropped");
      assert.strictEqual(rec.holds, undefined, "an absurd count should be dropped");
    });

    await test("live · a very long section name is clamped", async () => {
      await post("event=ft-export&section=" + encodeURIComponent("x".repeat(400)));
      const rec = events().filter(x => x.event === "ft-export").pop();
      assert.ok(rec.section.length <= 120, "section name should be clamped");
    });
  } finally {
    child.kill("SIGKILL");
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n✓ fasttrack-export.spec.js — ${passed} assertions passed`);
})().catch(e => { console.error("\n✗ fasttrack-export.spec.js\n" + (e && e.stack || e)); process.exit(1); });
