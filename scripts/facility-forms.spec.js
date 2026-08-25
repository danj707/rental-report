// Spec for the facility rental report's form-answer helpers.
//
// The "Requests" column and the inline answers panel are built entirely out of
// the pure helpers at module scope in public/facility.html. Every assertion
// here is a way the panel is silently WRONG rather than broken — it renders
// perfectly in all of them, which is why none of the other checks in this repo
// would notice:
//
//   1. Labels come from the form's SCHEMA, never from the submission's keys.
//      Every question on Watertown's field-permit form is named
//      question1..question9, and the picnic form's `question2` is silently
//      "Grill Request".
//   2. `false` is an answer. Watertown's booleans are answered on 485 of 485
//      submissions with zero blanks, and 295 of those are "no grill" — the
//      answer a parks crew most needs. A truthiness filter deletes all of them.
//   3. A choice answer is an opaque VALUE. The waiver's is ["Item 1"], not
//      "I Agree"; the field form's ["Item 5"] is "Watertown Youth Organization".
//      Values are arbitrary and NOT in positional order, so only a lookup
//      through choices[].value works.
//   4. The same key is a different TYPE in different forms — `question1` is a
//      file array on the picnic form and a plain string on the field form — so
//      the renderer must branch on the schema's type, not on the key.
//   5. A chip fires on the exception, not the norm: 484 of 485 rentals uploaded
//      an ID and 484 signed the waiver, so those must NOT become chips or the
//      column is a wall of decoration.
//
// Run: node scripts/facility-forms.spec.js
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PAGE = path.join(__dirname, "..", "public", "facility.html");
const src = fs.readFileSync(PAGE, "utf8");

// Slice the module-scope helper block and evaluate just that: the page builds a
// React tree at module scope, so the file as a whole cannot run here.
const start = src.indexOf("function formLabel(el)");
assert.ok(start > 0, "public/facility.html should declare formLabel at module scope");
const endMarker = "function FormPanel(";
const end = src.indexOf(endMarker, start);
assert.ok(end > start, "public/facility.html should declare FormPanel after the helpers");

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(src.slice(start, end), sandbox);

const {
  formLabel, formChoiceText, formIsAnswered, formAnswerView,
  formEntries, formIsWaiver, formShortLabel, formHeadCount,
  formFlags, formFilterKeys,
} = sandbox;

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, msg); n++; };

/* ── Fixtures: the real shapes, copied from production ──────────────────── */

const PICNIC = [
  { name: "Organization: (If Applicable)", type: "text" },
  { name: "Type of Event:", type: "text", required: true },
  { name: "Is this a public event?", type: "boolean", required: true },
  { name: "Is this a catered event? (If yes, please see Health Dept for a Catering Permit.)",
    type: "boolean", required: true },
  { name: "question2", title: "Grill Request", type: "boolean", required: true },
  { name: "Total estimated Number of Attendees", type: "text", required: true },
  { name: "question1", title: "Please upload a photo of your License or Photo ID.",
    type: "file", required: true },
];

const WAIVER = [
  { name: "Picnic / Pavilion Permit Disclaimer, Release", type: "checkbox", required: true,
    title: "Disclaimer, Release " + "x".repeat(3200),
    choices: [{ text: "I Agree", value: "Item 1" }] },
];

// Note question7's values: Item 4 is listed FIRST and Item 5 second, so any
// positional reading of this array gets the group wrong.
const FIELD = [
  { name: "question1", title: "Organization Name (If applicable)", type: "text" },
  { name: "question7", title: "Group/Customer", type: "checkbox", required: true,
    choices: [{ text: "Watertown Schools", value: "Item 4" },
              { text: "Watertown Youth Organization", value: "Item 5" },
              { text: "Watertown Resident", value: "Item 2" }] },
  { name: "question8", title: "Additional Comments or Requests", type: "comment" },
];

const SCHEMAS = { picnic: PICNIC, waiver: WAIVER, field: FIELD };

const BLOB = "Filippello Grove requested dates and times:\nfrom 8/31/2026 to 11/22/2026\n\n"
  + "Day\tStart time\tEnd time\n"
  + Array.from({ length: 30 }, () => "Monday\t5.30pm\t9.15pm").join("\n");

const picnicHot = {
  form: "picnic", name: "Picnic Table Permit Requests", at: "Jul 22, 2026",
  answers: {
    "Type of Event:": "Quinceañera",
    "Is this a public event?": true,
    "Is this a catered event? (If yes, please see Health Dept for a Catering Permit.)": true,
    "question2": true,
    "Total estimated Number of Attendees": "45",
    "question1": [{ name: "License_Front.jpg", size: 1811804 },
                  { name: "License_Back.jpg", size: 1303548 }],
  },
};
const picnicQuiet = {
  form: "picnic", name: "Picnic Table Permit Requests", at: "Aug 14, 2026",
  answers: {
    "Type of Event:": "Birthday party",
    "Is this a public event?": false,
    "Is this a catered event? (If yes, please see Health Dept for a Catering Permit.)": false,
    "question2": false,
    "Total estimated Number of Attendees": "10",
    "question1": [{ name: "id.jpg", size: 1094005 }],
  },
};
const waiverSub = {
  form: "waiver", name: "Picnic/ Pavilion Permit Disclaimer, Release", at: "Aug 14, 2026",
  answers: { "Picnic / Pavilion Permit Disclaimer, Release": ["Item 1"] },
};
const fieldSub = {
  form: "field", name: "Field/ Court/ Track/ Rink Permit Application 2026", at: "Aug 1, 2026",
  answers: { "question1": "Watertown Youth Soccer", "question7": ["Item 5"], "question8": BLOB },
};

/* ── 1. Labels come from the schema, never the submission key ───────────── */

eq(formLabel({ name: "question2", title: "Grill Request" }), "Grill Request",
  "a title must win over the machine name — `question2` is not a label");
eq(formLabel({ name: "Type of Event:" }), "Type of Event:",
  "with no title the name is the label");
eq(formShortLabel("Grill Request"), "Grill",
  "chip labels drop the interrogative scaffolding: 'Grill Request' -> 'Grill'");
eq(formShortLabel("Is this a catered event? (If yes, please see Health Dept for a Catering Permit.)"),
  "Catered",
  "a parenthetical instruction must not reach a 196px column, and 'event' carries nothing");
eq(formShortLabel("Is this a public event?"), "Public", "leading 'Is this a' is scaffolding");

/* ── 2. `false` is an answer, not a blank ───────────────────────────────── */

ok(formIsAnswered(false), "false is an ANSWER — filtering it deletes every 'no grill'");
ok(formIsAnswered(0), "0 is an answer");
ok(!formIsAnswered(undefined), "an absent key is unanswered");
ok(!formIsAnswered(""), "an empty string is unanswered");
ok(!formIsAnswered([]), "an empty array is unanswered");

const quietEntries = formEntries(PICNIC, picnicQuiet.answers);
const grillQuiet = quietEntries.find(e => e.el.name === "question2");
ok(grillQuiet.answered, "a false boolean must survive into the panel");
eq(formAnswerView(grillQuiet.el, grillQuiet.value).text, "No",
  "a false boolean renders as 'No', not as a blank cell");

/* ── 3. Choice answers map value -> text, and NOT by position ───────────── */

eq(formChoiceText(WAIVER[0], "Item 1"), "I Agree",
  "the waiver's answer is the value 'Item 1'; only the schema turns it into 'I Agree'");
eq(formChoiceText(FIELD[1], "Item 5"), "Watertown Youth Organization",
  "Item 5 is listed SECOND — reading choices by position returns the wrong group");
eq(formChoiceText(FIELD[1], "Item 4"), "Watertown Schools", "first choice still resolves");
eq(formChoiceText(FIELD[1], "Item 9"), "Item 9",
  "an unknown value falls back to itself rather than to the wrong label");

const fieldEntries = formEntries(FIELD, fieldSub.answers);
const group = fieldEntries.find(e => e.el.name === "question7");
eq(formAnswerView(group.el, group.value).text, "Watertown Youth Organization",
  "a single-element choice array renders as its text");

/* ── 4. Branch on the schema TYPE, not the key ──────────────────────────── */

// `question1` is a file array on the picnic form and a plain string on the
// field form. A key-driven renderer throws on one of them.
const fileEntry = formEntries(PICNIC, picnicHot.answers).find(e => e.el.name === "question1");
eq(formAnswerView(fileEntry.el, fileEntry.value).kind, "file", "question1 is a file on the picnic form");
eq(formAnswerView(fileEntry.el, fileEntry.value).files.length, 2, "both licence images are counted");
const strEntry = fieldEntries.find(e => e.el.name === "question1");
eq(formAnswerView(strEntry.el, strEntry.value).kind, "text",
  "the SAME key is a plain string on the field form — the type comes from the schema");

const blobEntry = fieldEntries.find(e => e.el.name === "question8");
eq(formAnswerView(blobEntry.el, blobEntry.value).kind, "blob",
  "a 1.4 KB pasted schedule must be a clamped block, never a table cell");
eq(formAnswerView({ type: "text" }, "Soccer").kind, "text", "a short answer stays inline");

/* ── 5. Question ORDER comes from the schema, not the submission ────────── */

// jsonb does not preserve key order, so the submission's own order is
// meaningless — and JS object key order would put question1/question2 first.
const ordered = formEntries(PICNIC, picnicHot.answers).map(e => e.el.name);
eq(ordered[0], "Organization: (If Applicable)", "panel order follows the FORM, not the answers");
eq(ordered[4], "question2", "the grill question keeps its place in the form");
eq(ordered.length, PICNIC.length, "every question appears, answered or not");

// An answer whose question was deleted from the form must still surface.
const orphan = formEntries(PICNIC, Object.assign({ "retired-question": "yes" }, picnicHot.answers));
ok(orphan.some(e => e.orphan && e.el.name === "retired-question"),
  "an answer with no matching question is appended, never silently dropped");

/* ── 6. A waiver is not a questionnaire ─────────────────────────────────── */

ok(formIsWaiver(WAIVER), "one choice question with 3,257 characters of legalese is a waiver");
ok(!formIsWaiver(PICNIC), "a 7-question request form is not a waiver");
ok(!formIsWaiver([{ name: "q", type: "checkbox", title: "Shirt size" }]),
  "a single SHORT choice question is an ordinary question, not a waiver");

/* ── 7. Chips: the exception, not the norm ──────────────────────────────── */

const hot = formFlags([picnicHot, waiverSub], SCHEMAS, { headCount: 30 });
const labels = hot.flags.map(f => f.label);
ok(labels.indexOf("Grill") !== -1, "grill (39% of real rentals) is a chip — via the schema's title");
ok(labels.indexOf("Catered") !== -1, "catered is a chip");
ok(labels.indexOf("Public") !== -1, "a public event is a chip");
eq(hot.waivers, 1, "the waiver is counted, not chipped");
eq(hot.files, 2, "both files counted");
ok(!labels.some(l => /agree|licen|photo|upload/i.test(l)),
  "the ID upload and the waiver are on ~100% of rentals — chipping them is decoration");

const quiet = formFlags([picnicQuiet, waiverSub], SCHEMAS, { headCount: 10 });
eq(quiet.flags.length, 0, "a rental whose answers are all 'no' carries NO loud chip");
eq(quiet.quiet, "2 forms", "...just the quiet paperwork-is-in summary");
ok(!quiet.mismatch, "10 on the form against 10 booked is not a mismatch");

/* ── 8. The head-count disagreement (15% of real rentals) ───────────────── */

eq(formHeadCount(formEntries(PICNIC, picnicHot.answers)), 45, "the attendee answer is found by label");
ok(hot.mismatch, "45 on the form against 30 booked is a mismatch");
eq(hot.mismatch.form, 45, "the form's number");
eq(hot.mismatch.booked, 30, "the booking's number");
ok(!formFlags([picnicHot], SCHEMAS, { headCount: null }).mismatch,
  "no booked head count means nothing to disagree with — not a mismatch");
ok(!formFlags([picnicHot], SCHEMAS, { headCount: 45 }).mismatch, "agreement is not a mismatch");

/* ── 9. Filter keys drive every surface from one place ──────────────────── */

const keys = formFilterKeys(hot);
ok(keys.indexOf("grill") !== -1, "the grill filter matches the grill rental");
ok(keys.indexOf("catered") !== -1, "the catered filter matches");
ok(keys.indexOf("public") !== -1, "the public filter matches");
ok(keys.indexOf("mismatch") !== -1, "the count-mismatch filter matches");
ok(formFilterKeys(quiet).indexOf("grill") === -1, "...and does not match the quiet rental");

const fieldFlags = formFlags([fieldSub], SCHEMAS, { headCount: null });
ok(fieldFlags.note, "a 1.4 KB pasted schedule marks the rental as carrying a note");
ok(formFilterKeys(fieldFlags).indexOf("note") !== -1, "the note filter matches it");

/* ── 10. A rental with no forms is blank, not an alarm ──────────────────── */

const none = formFlags([], SCHEMAS, { headCount: 10 });
eq(none.flags.length, 0, "no forms means no chips");
eq(none.forms, 0, "...and no count");
eq(formFilterKeys(none).length, 0,
  "no forms must not match any filter — 62% of a typical week has no form at all, "
  + "and only 1 of Watertown's 1,137 requested forms is genuinely outstanding");

/* ── 11. The export contract: a filtered PDF must carry the answers ─────────
   Dan, on the design: "if an org filters and then exports to a PDF, the
   expanded version should be included. Otherwise they'll never see the
   expanded view."

   Nobody can click a printed page, so both halves have to ride on the PDF URL
   or the export is misleading: `form_filter` keeps the printed rows the same
   rows that were on screen, and `forms=1` opens the answers on them. Each of
   these is a one-line omission that leaves a PDF looking perfectly fine while
   showing none of the thing the filter was for, so they are pinned at the
   source rather than trusted. */

const SERVER = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

ok(/qs\.set\(['"]forms['"], *['"]1['"]\)/.test(src),
  "downloadPdf must ask the PDF for expanded answers");
ok(/qs\.set\(['"]form_filter['"]/.test(src),
  "downloadPdf must carry the active form filters, or the PDF prints rows the screen was hiding");

// generatePdf re-opens the report page with a WHITELIST of params. A param
// missing from it is silently dropped, which is the whole failure mode.
const whitelist = SERVER.slice(SERVER.indexOf('["locations", "location", "sites"'));
const wlEnd = whitelist.indexOf("].forEach");
const wl = whitelist.slice(0, wlEnd);
ok(/"forms"/.test(wl), "server.js generatePdf must forward `forms` to the print page");
ok(/"form_filter"/.test(wl), "server.js generatePdf must forward `form_filter` to the print page");

// The print page has to read them back, before it signals #report-ready.
ok(/forms: *p\.get\(['"]forms['"]\)/.test(src), "the page must read `forms` off the URL");
ok(/form_filter: *p\.get\(['"]form_filter['"]\)/.test(src), "the page must read `form_filter` off the URL");
ok(/params\._print === '1' && params\.forms === '1'/.test(src),
  "print mode must open every visible rental's answers — a printed page cannot be clicked");

// And the standing activity rule: a new surface pings the feed.
ok(/"form-view"/.test(SERVER) && /"form-filter"/.test(SERVER),
  "form-view and form-filter must be wired into the Slack notify set");
ok(/rec\.event === "form-view"[\s\S]{0,120}rec\.rental/.test(SERVER),
  "form-view debounces by RENTAL, so comparing three bookings reads as three looks");

console.log(`✓ facility-forms.spec.js — ${n} assertions passed`);
