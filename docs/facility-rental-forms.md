# Surfacing facility rental forms on the rental schedule

Status: **design proposal, not built.** Mockup: `public/facility-forms-mockup.html`
(standalone, no server) — also published at
https://claude.ai/code/artifact/b9e73d8c-335e-4aab-94d5-7e2a5f63b61d

Everything below was measured against prod (db 4) on 2026-08-25, using Watertown
(`d781690b-c5a0-43c5-8443-9ae43899528c`) and the rental Dan flagged,
`451ff272-a2b9-464f-8131-de7423d978e8`.

## Where the data lives

```
form                        -- schema jsonb: pages[0].elements[] = the questions
form_submission             -- submission jsonb: the answers
form_submission_lookup      -- .facility_rental_id  ← THE JOIN for rentals
form_lookup                 -- which form was REQUESTED of a rental / site config
```

`form_submission_lookup` is polymorphic (`booking_id`, `facility_rental_id`,
`rental_application_id`, `product_purchase_id`); rentals join on
`facility_rental_id`. The class roster card (17296) already emits
`json_build_object('submission', fs.submission, 'schema', f.schema->'pages'->0->'elements')`
— the same shape works here, but must be an **array**: a rental averages 2.08 forms.

## Shape of the data (why the design is what it is)

Platform-wide: **1,210 forms across 93 orgs**, avg 5 questions, **max 113**;
454 are single-question waivers; 187 have a label over 300 chars, the longest
**18,003**; 179 carry a file upload, 132 a signature.

Watertown: **546 rentals with forms, 2.08 forms each, 98% carry 2+**, 9.0 answers
per rental (max 20). Only **38%** of the Sept 6 week's 47 rentals have any form.
Rental forms are broadly used — Sacramento County 660 rentals, Rocklin 585,
Watertown 546, Windham 532, Menifee 414.

The flagged rental carries two forms:

| form | shape |
|---|---|
| Picnic Table Permit Requests | 9 questions: 4 text, 3 boolean, 1 comment, 1 file |
| Picnic / Pavilion Permit Disclaimer, Release | 1 checkbox whose title is **3,257 chars** of legalese |

Answer distribution over all 485 picnic submissions — this is what makes a
chip-style summary viable:

- **grill requested 189 (39%)**, not requested 295
- catered 26 (5%), public event 20 (4%)
- **form head count disagrees with `facility_rental.attendee_count` on 73 (15%)**
- notes: avg 41 chars, max 656, 31 over 120 chars
- `Alternate Date` is "n/a"-ish on **252 of 485 (52%)** — mostly noise
- `Organization` answered on only 78 (16%) — unanswered is the norm
- a file is attached on 484 of 485

## Recommendation

**Ship B; keep A as a column toggle; add C later.**

- **B — chips in the row, Q&A inline on click.** Row stays one line and carries only
  actionable answers; clicking expands the full Q&A in place.
- **A — always-on inline sub-row.** Reuses the existing `.sub-row` (mono, indented,
  used today for Notes/Add-Ons). Readable, prints, but triples a day section's
  height and cannot render the 1.4 KB case below. Ship as a `Show answers`
  checkbox beside the existing column toggles, **off by default**, honoured by
  Print/PDF.
- **C — full form on the permit posting sheet** (`lib/permit.js`). Not an
  alternative to B, an addition: the sheet already prints per rental and hangs at
  the facility, and grill/attendees/catered is what a crew there needs.

**Not a column per question.** Watertown's rentals draw on 9 different forms with
disjoint question sets — ~40 columns at 38% fill for one week — and a waiver's
question cannot be a column header. This is why the Programs/roster pulldown does
not transfer: a roster is one form per section, rentals are not.

### Chip the exception, not the norm

484 of 485 uploaded an ID and 484 signed the waiver, so those collapse into a quiet
`✓ 2 forms`; only their **absence** goes loud. Grill (39%), catered (5%), public
(4%) and count mismatch (15%) are frequent enough to scan for, rare enough to
stand out. The day's section header rolls them up
("5 rentals · 2 grills · 1 catered · 1 count mismatch") so a crew need not expand
anything.

## Five traps (each cost real time to find)

1. **Answers are keyed by machine name — the schema join is mandatory.** Every
   question on `Field/ Court/ Track/ Rink Permit Application 2026` is named
   `question1…question9`; the picnic form's `question2` is "Grill Request". Render
   `title ?? name`, never a bare `questionN`.
2. **`false` is an answer, not a blank.** Booleans: 485 answered, 0 blank, 2
   distinct. Truthiness-filtering deletes all 295 "no grill" answers. Filter on
   `undefined`.
3. **Choice answers are opaque values.** The waiver's answer is `["Item 1"]`, not
   "I Agree"; the field form's `["Item 5"]` is "Watertown Youth Organization".
   Values are arbitrary and **not in positional order** (`Item 4` is listed
   first), so map through `choices[].value → choices[].text`.
4. **The same key is a different type in different forms.** `question1` is a file
   array on the picnic form and the string "Watertown Youth Soccer" on the field
   form — a probe query failed with `ERROR: cannot get array length of a scalar`.
   Branch on the schema's `type`, not the key. This is the shape of the
   blank-page bugs already in this repo.
5. **Uploaded files cannot be displayed.** The submission carries a direct S3 URL
   that *looks* usable; fetching it returns **403 AccessDenied**
   (`curl → status=403, content-type=application/xml`). No signing path exists in
   this app, so render a name+size chip linking into Rec admin — an inline
   preview would be a broken image on essentially every picnic row.

Also: **jsonb does not preserve key order**, so question order must come from the
schema's `elements[]` array, never from the submission's keys.

## Cost and open decisions

- **One new column on card 17294** (`Forms`, JSON array). No new card, no second
  round trip. Longest Watertown submission is 2,052 bytes.
- **Watch the multi-day expansion.** 17294 emits one row per day via
  `generate_series`, so a 40-date permit would repeat the same form JSON 40 times.
  Emit on the arrival day only — the rule `dirOutdoor`/the permit sheet already use.
- **A blank cell is legitimately blank.** Only **1 of 1,137** requested forms at
  Watertown is outstanding, so "no form" means none was ever asked for. No red
  state for absence, or the column cries wolf on 62% of rows.
- **PII decision needed.** Filenames are not neutral
  (`JPM_Driver_s_License_back_2023-2028…jpg`). This report is shared by tokened
  link, exported to Excel and mailed by subscription. Proposal: chip on screen,
  filename only in the expanded panel, nothing in Excel or email.
- **Auto-derive chips vs curate per org.** Auto-derivation (boolean yes → chip,
  file → 📎, long text → 📝) covers all 93 orgs with no config; curated labels read
  better. Proposal: auto-derived with an optional override.
- **Is the count mismatch a chip or a footnote?** Fires on 15% — may just mean the
  party grew since booking.
- **Slack activity** (standing rule): `form-view` when a rental's forms are opened,
  debounced by rental; `form-filter` when filtering by grill/catered, debounced by
  filter. Both need adding to `SLACK_NOTIFY`, `SLACK_EVENT_META` and the log
  route's `ALLOWED` list.
