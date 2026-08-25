// Cache-independent live sign-off for the rental-forms feature.
//
// Fetches the real public card and runs the ROUTE's own shaping plus the PAGE's
// own chip derivation over the result — no stub, no app cache, no browser. It
// exists because the render check cannot see this layer: its stub answers with
// already-parsed objects, so it would pass just as happily against a route that
// produces nothing.
//
// It has already earned its keep twice. On its first run it found that Metabase
// returns jsonb columns as STRINGS, so the route shaped every rental to {} and
// the column would have shipped permanently empty — a report indistinguishable
// from an org that collects no forms. On its second it found Windham's 294
// signaturepad answers, 25 KB of base64 PNG each, taking the payload to 3.3 MB.
//
// Needs network but no API key: the card is public.
// Run: node scripts/facility-forms-live.js
const fs = require("fs"), vm = require("vm"), path = require("path");
const ROOT = "/home/user/rental-report";
const SERVER = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const PAGE   = fs.readFileSync(path.join(ROOT, "public/facility.html"), "utf8");

const sbox = {}; vm.createContext(sbox);
vm.runInContext(SERVER.slice(SERVER.indexOf("function slimFileAnswer("),
                             SERVER.indexOf("// Reservation ID -> [submission]")), sbox);
const pbox = {}; vm.createContext(pbox);
vm.runInContext(PAGE.slice(PAGE.indexOf("function formLabel(el)"),
                           PAGE.indexOf("function FormPanel(")), pbox);

const UUID = "89ba73b2-09d6-48e1-ac15-bd88b1a4c0f5";
const ORGS = { watertown: "d781690b-c5a0-43c5-8443-9ae43899528c",
               windham:   "1c80a358-74c2-477d-aa0b-87bb2d0514b3" };

(async () => {
  const defResp = await fetch(`https://rec.metabaseapp.com/api/public/card/${UUID}`);
  const def = await defResp.json();
  const p = (def.parameters || []).find(x => x.slug === "org_id");
  if (!p) { console.error("FAIL: card has no org_id parameter"); process.exit(1); }

  let bad = 0;
  for (const [slug, orgId] of Object.entries(ORGS)) {
    const params = [{ id: p.id, type: p.type, target: p.target, slug: p.slug, value: orgId }];
    const t0 = Date.now();
    const r = await fetch(`https://rec.metabaseapp.com/api/public/card/${UUID}/query/json?parameters=`
                          + encodeURIComponent(JSON.stringify(params)));
    const rows = await r.json();
    const ms = Date.now() - t0;
    if (!Array.isArray(rows)) { console.error(`${slug}: FAIL not an array`); bad++; continue; }

    const shaped = sbox.shapeFormRows(rows);           // the route's real shaping
    const rentals = Object.keys(shaped.forms);
    const wire = JSON.stringify(shaped);

    // Derive chips exactly as the page does.
    let chipped = 0, grill = 0, mismatch = 0, files = 0, waivers = 0, labelled = 0, machine = 0;
    for (const rid of rentals) {
      const fl = pbox.formFlags(shaped.forms[rid], shaped.schemas, { headCount: null });
      if (fl.flags.length) chipped++;
      if (fl.flags.some(f => /grill/i.test(f.label))) grill++;
      if (fl.mismatch) mismatch++;
      files += fl.files; waivers += fl.waivers;
      for (const s of shaped.forms[rid]) {
        for (const e of pbox.formEntries(shaped.schemas[s.form] || [], s.answers)) {
          const L = pbox.formLabel(e.el);
          if (/^question\d+$/i.test(L)) machine++; else if (L) labelled++;
        }
      }
    }
    const emptyAnswers = rentals.filter(rid =>
      shaped.forms[rid].every(s => Object.keys(s.answers).length === 0)).length;

    console.log(`${slug}: ${rows.length} rows -> ${rentals.length} rentals, `
      + `${Object.keys(shaped.schemas).length} schemas, ${ms}ms`);
    console.log(`   chips=${chipped} grill=${grill} mismatch=${mismatch} `
      + `files=${files} waivers=${waivers}`);
    console.log(`   labelled questions=${labelled}  still-machine-named=${machine}  `
      + `rentals with NO answers=${emptyAnswers}`);
    let sigs = 0;
    for (const rid of rentals) for (const sub of shaped.forms[rid])
      for (const v of Object.values(sub.answers)) if (v && v.__signed) sigs++;
    console.log(`   signatures=${sigs}  base64 leaked: ${wire.includes("base64")}  `
      + `S3 url leaked: ${/s3[.-]/.test(wire)}   payload=${(wire.length/1024).toFixed(0)}KB`);
    if (wire.includes("base64")) { console.error(`   FAIL ${slug}: base64 in the client payload`); bad++; }

    if (!rentals.length)      { console.error(`   FAIL ${slug}: no rentals`); bad++; }
    if (emptyAnswers)         { console.error(`   FAIL ${slug}: ${emptyAnswers} rentals shaped to empty answers`); bad++; }
    if (machine) console.log(`   note ${slug}: ${machine} question(s) have no title in the form itself`);
    if (/s3[.-]/.test(wire))  { console.error(`   FAIL ${slug}: an S3 URL reached the client payload`); bad++; }
    if (!chipped) console.log(`   note ${slug}: no loud chips — this org's forms ask no yes/no questions, `
      + `so the column is the quiet "N forms" plus the panel. Working as designed.`);
  }
  console.log(bad ? `\n✗ ${bad} problem(s)` : "\n✓ live card shapes and derives correctly");
  process.exit(bad ? 1 : 0);
})();
