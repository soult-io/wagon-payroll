# Spec 24 — W-2 state boxes 15–17

Status: `DRAFT 2026-09-27 — awaiting owner sign-off` · Ticket: PAY-116 · Depends on:
PAY-13 (work states + frozen `inputs.state` in the run snapshot, template 1.2.0), PAY-11 /
PAY-19 (W-2/W-3 figures and official-form PDFs), PAY-91 (Spec 23: `parseCents` /
`formatCents`, `loadStateLiability`), Spec 11 (PII capture) · Gates:
`state-local-payroll-sme` + `payroll-calc-auditor` (owner decision 2026-09-26, brain #3871),
`security-privacy-reviewer` (new employer identifier; hard stop), `product-ux-designer`
(copy in §9), `federal-payroll-tax-sme` (W-3 box c form count, S24-D12; **ACCEPT pending
the edits of 2026-09-27**, applied: BSO copy §9 E1–E2, empty W-3 state fields, verbatim
quotes)

Decision labels in this spec are `S24-D1`…`S24-D12` so they never collide with the master
register (`plan/decisions.md` D1–D36). A bare `Dn` below means the master register.

## 1. Problem

Owner decision 2026-09-27 (PAY-104 F25, brain #3903): fill W-2 boxes 15–17. Today every
W-2 the app renders leaves boxes 15–20 blank:

- `packages/documents/src/w2.ts` `fillText`: "blank boxes stay blank (D5: boxes 7–14,
  state/local)". That "D5" is a PAY-19 ticket-local decision number (PAY-19 shipped in
  1.9.0, see `CHANGELOG.md` "[1.9.0] - 2026-08-31"), not master D5 (payslip documents).
  It was never recorded in `plan/decisions.md`. D36 now records the change.
- `apps/server/src/filings/annual.ts` `W2Figures` / `WorksheetW3` carry boxes 1–6 only.
  `perEmployeeSums` groups issued-run `payroll_entries` by `(employee, category)`; it has
  no state dimension.
- `payroll_entries` has `category` + `amount`, unique `(run_id, category)`, no
  jurisdiction. The state of a run is `payroll_runs.run_snapshot #>> '{inputs,state,workState}'`
  (`SnapshotState`, `apps/server/src/payroll/snapshot.ts`), resolved on `periodStart`
  (`runs.ts`: `resolveWorkState(tx, input.employeeId, period.periodStart)`). One run = one
  state. Runs with no work-state row (and every pre-1.2.0 run) take the legacy flat
  `stateWithholdingRate` path and have **no** `inputs.state`.
- No table stores an employer state withholding account number.
- `packages/documents/src/forms/templates.ts` bundles only `f941` for 2026 ("W-2/W-3 2026
  templates land with the year-end annual-forms work"). `templateBytes(2026, "fw2")`
  throws today, so **no 2026 W-2 or W-3 PDF can be rendered at all** until 2026 templates
  are added. 2026 W-2s are due to employees by 2027-02-01 (Jan 31 2027 is a Sunday;
  `annualDueDate`).

Verified on `origin/main` 36c7307: the files above, `apps/server/src/routes/admin-annual-forms.ts`,
`apps/server/src/routes/my-w2.ts`, `apps/server/src/filings/service.ts`
(`computeFreshWorksheet`), `apps/server/src/routes/admin-settings.ts` (EIN write-only,
masked audit), `apps/server/src/crypto/field-encryption.ts` (`enc:v1:`, `maskLast4`),
`apps/server/src/deposits/service.ts` (`loadStateLiability`), `packages/db/src/schema.ts`,
`apps/server/src/qa/seed-qa.ts` (QA employee Ada works in IL from 2024-11-01).

## 2. Domain rules (state-local-payroll-sme, 2026; requirements, not proposals)

Source for form mechanics: IRS 2026 General Instructions for Forms W-2 and W-3
(https://www.irs.gov/pub/irs-pdf/iw2w3.pdf, read 2026-09-27), sections "Boxes 15 through
20", "Multiple forms", "Specific Instructions for Form W-3 — Box 15" and "Boxes 16
through 19", "Copy 1".

- **R1 Box 15** = the 2-letter state code + the employer's state ID number.
- **R2 Box 16 (default; CA, IL, NC, MD)** = sum of `gross_pay` of the tax year's issued
  runs whose snapshot `workState` = that state. **Box 17** = sum of `state_withholding`
  of the same runs.
- **R3 New York** (NYS TSB-M-02(3)I): if the employee worked in NY at any time in the year
  (≥1 issued run in the year with `workState = 'NY'`), NY box 16 = **box 1** (all wages for
  the year); box 17 = the NY withholding sum. No NY run → no NY line.
- **R4** State with income tax, wages there, 0 withheld (exempt election, low income):
  box 15 + 16 filled, box 17 = `0.00`. A state whose frozen `inputs.state.kind = 'none'`
  on every run of the year (TX): no line.
- **R5** Two state lines per W-2. More than two: an additional W-2 with boxes a–f
  repeated, boxes 1–14 **blank**, carrying the next two lines (IRS "Multiple forms": "Do not
  report the same federal … tax data to the SSA on more than one Copy A"). IRS 2026
  General Instructions p.24: "If you need to report information for more than two states or
  localities, prepare a second Form W-2."
- **R6 W-3** box 15: the state + state ID when every W-2 line is one state; "X" and no ID
  when more than one state. Boxes 16 and 17: one sum across all W-2 lines of all states.
- **R7 Legacy runs.** An issued run in the year with `state_withholding > 0` and no
  `workState` makes the state lines of that employee/year unknowable. Refuse, list the
  runs, require an admin to resolve. Never guess.
- **R8 Year** = `pay_date` year (IRS: wages for Dec 13–26 2026 paid Jan 1 2027 go on the
  2027 W-2). The state is the `periodStart` state (R-known-limit K3).
- **R9 Reconciliation**: per state and year, Σ box 17 over all W-2s = Σ `state_withholding`
  by `workState` for issued runs paid in that year (the state-deposit source).

## 3. Scope and non-goals

In scope: boxes 15, 16, 17 on W-2 Copies B, C, 2, D; W-3 boxes 15–17; employer state IDs
per state; blocks and warnings the admin sees; reconciliation; the 2026 fw2/fw3 templates
and field maps (§4 S24-D6, owner decision pending); multi-form W-2s.

Non-goals (known limits, shown to the admin where noted):
- **K1 Boxes 18–20 (local)** stay blank. This is a NY question only: NYC and Yonkers tax
  need residence, and Yonkers also work location (PAY-120, PAY-122). Warning W7 on every NY
  line. *Owner decision pending — §4 S24-D8.*
- **K1-MD Maryland county tax is not a boxes 18–20 case.** Maryland reports county tax in
  box 17 combined with state tax (Comptroller of Maryland, 2025 Employer Reporting of W2s
  Instructions, p.10). The engine withholds MD state tax only (PAY-120), so MD withholding,
  and therefore MD box 17, is incomplete until PAY-120 ships. Box 17 shows what was actually
  withheld; the app never adds tax that was not withheld. Warning W6 on every MD line.
- **K2 Reciprocity** (IL, MD resident-state lines): not modelled (PAY-122). Warning when an IL
  or MD run in the year has an exempt state election (§9 W8).
- **K3** A run whose pay period spans a work-state change is assigned wholly to the
  `periodStart` state. Info note when detected (§9 I2).
- **K4** NY "worked in NY" = an issued run with `workState = 'NY'`. Work in NY by an employee
  whose work state is elsewhere (travel days) is not modelled.
- **K6** NY resident employees working outside NY, and NY convenience-of-the-employer
  cases, are not detected: residence is not modelled (PAY-122). Such an employee gets no NY
  line even where NY may expect one.
- **K7** Field encryption has no GCM associated-data binding (a ciphertext copied to another
  row or column still decrypts). Same as the EIN today (`field-encryption.ts`); not changed
  here.
- **K8** State IDs are not added to `/api/export` or any other export.
- **K5** Box 16 = gross pay because the app has no pre-tax deductions. When pre-tax
  deductions arrive, box 16 rules per state must be revisited.
- Copy 1 (state copy) is not emitted; no state W-2 submission (master D12, filing automation). §4 S24-D9.
- Tax years before 2026 are unchanged (§4 S24-D5).
- W-2c. Boxes 1–6 arithmetic (still `Number` + `round2`; see §13 Q6), except that box 1 is
  also carried in cents for the NY rule (S24-D1 step 4).

## 4. Decisions

### S24-D1 — A pure planner per employee-year, integer cents.

`apps/server/src/filings/w2-state.ts` exports
`planW2StateLines(input: W2StateInput): W2StatePlan`. Pure: no DB, no clock, no config.
Input = the employee's issued runs of the year (as literals) + the resolved state-ID
availability per state + attributions (S24-D7). Output = ordered state lines, form count,
issues. All money is integer cents; strings are produced only by `formatCents` at the API
and PDF edge. `w2FiguresForYear` loads inputs and calls it. PAY-93 mutation testing
targets this file.

```ts
interface W2StateRun {            // one issued run, pay_date in the year
  runPublicId: string;
  payDate: string;                // YYYY-MM-DD
  periodStart: string; periodEnd: string;
  workState: string | null;       // snapshot inputs.state.workState
  stateKind: "none" | "flat" | "progressive" | null;   // snapshot inputs.state.kind
  exempt: boolean;                // snapshot inputs.state.election?.exempt ?? false
  grossCents: number;             // parseCents(gross_pay)
  stateTaxCents: number;          // parseCents(state_withholding) (0 when absent)
}
interface W2StateInput {
  taxYear: number;
  runs: W2StateRun[];
  box1Cents: number;                                   // from the printed box 1 source (step 4)
  stateIds: Record<string, "entered" | "ein_default" | null>;  // availability only, never the value
  attributions: Record<string, string>;                // runPublicId → state (S24-D7)
  moves: { effectiveFrom: string }[];                  // work-state rows, for info I2 only
}
interface W2StateLine { state: string; box16Cents: number; box17Cents: number; form: number }
interface W2StatePlan { lines: W2StateLine[]; formCount: number; issues: W2Issue[] }
```

Algorithm:
1. `effectiveState(run) = run.workState ?? attributions[run.runPublicId] ?? null`.
2. Legacy check (R7): runs with `workState = null`, no attribution, `stateTaxCents > 0` →
   one `legacy_state_runs` **block** issue listing them. Lines are still computed from the
   other runs (for display), but the plan is blocked.
   Runs with `workState = null`, no attribution, `stateTaxCents = 0` → skipped; if the
   employee also has any run with a state that year → `legacy_runs_without_state` **warn**.
3. Group runs by effective state. Drop a state when every run in it has `stateKind = 'none'`
   (attributed legacy runs count as `stateKind = null` = has income tax).
4. Per state: `box16 = Σ grossCents`, `box17 = Σ stateTaxCents`. NY: `box16 = box1Cents` (R3).
   `box1Cents` is `parseCents` of the **same** `sum(gross_pay)::numeric(14,2)::text` row that
   `w2FiguresForYear` turns into the printed box 1, not a second sum over the runs, so
   `formatCents(box1Cents)` equals the printed box 1 string exactly (W02, W08, W21 assert it).
   The planner asserts `Σ grossCents = box1Cents` for the year and throws on a difference.
5. Sort lines by state code (code-point order; `localeCompare` is banned). Line i (0-based)
   goes on form `floor(i / 2) + 1`. `formCount = max(1, ceil(lines / 2))`.
6. Issues per line: missing ID (S24-D3), MD/NY local (K1, K1-MD), IL/MD exempt (K2), move inside a
   run period (K3).

### S24-D2 — Employer state IDs: new table, year-effective, encrypted, write-only.

| Option | For | Against |
|---|---|---|
| (a) JSONB map on `company` | no new table | one ciphertext blob for many values (breaks per-value masking/audit), no history |
| **(b) `company_state_ids` table, one row per (company, state, from_tax_year)** | per-value encryption and audit like EIN; re-rendering an old W-2 prints the ID valid for that year; `company_id` ready for master D10 multi-company | a table |
| (c) (b) with date effective-dating | mid-year precision | a W-2 carries one ID per state per year, so a date adds nothing but edge cases |

**Chosen: (b).** The W-2 for year Y uses the row with the greatest `from_tax_year ≤ Y`.
**IL and NY default** to the company EIN when no row exists (`source = 'ein_default'`),
derived at render, never copied into the table; an entered row overrides it. The default
applies **only when `company.ein IS NOT NULL`**; with no EIN the source is `null`, so
S24-D3 blocks (box 17 > 0) or warns (box 17 = 0).

Format checks (after stripping spaces and dashes), sources from `state-local-payroll-sme`
review 2026-09-27:

| State | Identifier | Check | Source |
|---|---|---|---|
| CA | EDD employer payroll tax account number, 8 digits | `^\d{8}$` | EDD employer registration, step 3 page |
| NC | NCDOR withholding account ID, 9 digits numeric; `APPLIEDFOR` is invalid | `^\d{9}$` | NCDOR W-2 Format (rev 09-26-2025) |
| MD | Central Registration (CR) number, 8 digits. The 10-digit UI number and the 9-digit FEIN are rejected | `^\d{8}$` | Comptroller of Maryland |
| IL | FEIN + optional 3-digit sequence (the sequence defaults to `000`) | `^\d{9}(\d{3})?$` | IL-941 instructions |
| NY | 9-digit EIN + optional 2-digit suffix + optional check digit | `^\d{9}(\d{2})?\d?$` | NYS-45-I (1/26) |
| other | — | free text | — |

Neither IDOR nor NYS DTF states the W-2 box 15 content verbatim; the IL and NY rows (and the
EIN defaults) rest on the withholding-account identifier each state assigns. IL default = the
9 EIN digits (sequence omitted, equivalent to `000`). NY input hint: "Use your New York
withholding ID (your EIN, plus any suffix New York gave you) — not your 7-digit UI employer
registration number."

Free text: trimmed, 1–20 characters, `^[A-Za-z0-9 -]+$`. Stored normalized (digits only for
checked states; trimmed text otherwise) and printed as stored.

**Filed years are frozen (L9).** PUT or DELETE is refused with **409** `state_id_year_filed`
when the change would alter the ID used by any tax year whose `w2_w3` filing is `filed`
(that is, any filed year Y with `fromTaxYear ≤ Y` and no later row ≤ Y). Reason: the W-2s of
a filed year must re-render exactly as filed; a wrong ID on filed W-2s is a W-2c matter
(out of scope). The admin enters the new ID from the first unfiled year instead. A 409, not
a warning, because a warning lets the filed record drift silently.

### S24-D3 — Missing state ID. `DECIDED by owner 2026-09-27: option (b)`

| Option | For | Against |
|---|---|---|
| (a) always render, blank ID | never blocks | a W-2 with state tax and no state account number is incomplete; the state cannot match the tax to the employer |
| **(b) block when box 17 > 0 and no ID; warn when box 17 = 0** | stops the incomplete form where it matters; zero-tax lines still ship | the owner must enter the number before W-2s go out |
| (c) block every line without an ID | strict | blocks exempt-only states where the employer may not be registered at all |

**Decided: (b)** (owner, 2026-09-27, as proposed). A block stops: admin Copy D, admin print
packet, employee self-service download, and the W-3 PDF (§7). The JSON list and the filing worksheet are
never blocked; they show why.

### S24-D4 — Multiple forms and page assembly.

The 2026 fw2 template is two-up (`CopyB_Top[0]` / `CopyB_Bottom[0]` on one page). Fill the
**top half only**; the bottom half stays blank (same as the single-up 2025 behaviour). Form k
is filled on its own template load, flattened, then its kept pages are copied into the
output (`PDFDocument.copyPages`), so field names never collide.
- Form 1: boxes a–f, 1–6, lines 1–2. Forms 2..N: boxes a–f, lines 2k-1 and 2k, boxes 1–14
  empty.
- Employee packet: Copy B × N, Notice to Employee, Copy C × N, Instructions for Employee,
  Copy 2 × N, Instructions (continued). N = 1 → the same 6 pages as today.
- Copy D: N pages.

### S24-D5 — Tax years before 2026 are unchanged.

`STATE_BOXES_FROM_YEAR = 2026` in `w2-state.ts`. For earlier years `w2FiguresForYear`
returns `stateLines: []`, `formCount: 1`, no issues; the W-3 worksheet object is
byte-identical to today's (no new keys); the 2025 PDF fills exactly the fields it fills
today. The 2025 template does have box 15–17 fields (`CopyB[0].Boxes15_ReadOrder[0].f2_29`
… `Box17_ReadOrder[0].f2_36`), but filling them is rejected because:
1. 2025 W-2s were due 2026-02-02 and have been furnished and filed; a re-render must not
   silently differ from the copy the employee has.
2. 2025 data is imported legacy runs without `workState`; R7 would block 2025 downloads that
   work today.
3. An unfiled 2025 `w2_w3` row would change its `worksheet_hash` on the next refresh.
State lines for 2025 would be a W-2c, which is out of scope.

Consequence: **no existing `worksheet_hash` changes.** The 2026 `w2_w3` row is created
only on 2027-01-01 (`syncAnnualFilings` year-close rule), after this ships.

### S24-D6 — 2026 fw2/fw3 templates and field maps in scope. *Owner decision pending.*

**Recommendation: in scope.** Without them no 2026 W-2 or W-3 renders (§1), with or
without state lines. Facts from the IRS PDFs downloaded 2026-09-27
(irs.gov/pub/irs-pdf/fw2.pdf "Created 1/7/26", fw3.pdf), found with the rect-dump method
described at the top of `field-map-2025.ts`:
- fw2 2026: 11 pages, same page indexes as 2025 (0 attention, 1 Copy A, 2 Copy 1, 3 Copy B,
  4 Notice, 5 Copy C, 6 Instructions, 7 Copy 2, 8 Instructions cont., 9 Copy D, 10 employer
  note). **Two-up**: every copy has `Copy?_Top[0]` and `Copy?_Bottom[0]` subforms, so every
  field path differs from 2025. Box 9 moved (`f2_17`, x347), box 14a/14b added
  (`f2_28`, `f2_29`, `f2_30`), so boxes 15–17 renumbered:

  | Box | Line 1 field (Top) | rect | Line 2 field | rect |
  |---|---|---|---|---|
  | 15 state | `Boxes15_ReadOrder[0].Box15_ReadOrder[0].f2_31[0]` | 38,480,64,492 | `Boxes15_ReadOrder[0].f2_33[0]` | 38,456,64,468 |
  | 15 ID | `Boxes15_ReadOrder[0].f2_32[0]` | 66,480,193,492 | `Boxes15_ReadOrder[0].f2_34[0]` | 66,456,193,468 |
  | 16 | `Box16_ReadOrder[0].f2_35[0]` | 195,480,280,492 | `Box16_ReadOrder[0].f2_36[0]` | 195,456,280,468 |
  | 17 | `Box17_ReadOrder[0].f2_37[0]` | 282,480,359,492 | `Box17_ReadOrder[0].f2_38[0]` | 282,456,359,468 |

  Prefix: `topmostSubform[0].{CopyB|CopyC|Copy2|CopyD}[0].{Copy}_Top[0].` (Copy A uses
  `f1_` names and is never filled). Boxes a–f and 1–6 keep numbers `f2_01`–`f2_14` under
  the `_Top[0]` path.
- fw3 2026: field names and rects identical to 2025. New fields used: box 15 state
  `topmostSubform[0].Page1[0].f1_23[0]` (37,492,78,504, MaxLen 2), state ID `f1_24[0]`
  (79,492,265,504), box 16 `f1_25[0]` (37,468,150,480), box 17 `f1_26[0]` (152,468,265,480);
  matched against the printed labels "15 State / Employer's state ID number" (y515) and
  "16 State wages, tips, etc. / 17 State income tax" (y491).
- SHA-256 observed 2026-09-27: fw2 `61eca7c81f16d3965819fe1f31be4fe68c1b2887a81f51172f1d2ed2b2b9f087`,
  fw3 `2df15f40431bd52814cbac85d9843102b09a640b6fe558f201e5214ff1890656`. PR-3 re-downloads,
  re-dumps, and pins what it vetted (the irs-pdf URL will serve 2027 later; the registry
  comment cites the file and date).

### S24-D7 — Legacy runs: admin attribution, never an edit to the run.

| Option | For | Against |
|---|---|---|
| (a) block only; resolution outside the app | no new table | the owner cannot finish the W-2 in the app |
| **(b) block + admin picks the state per listed run, stored in `w2_legacy_run_states`** | issued run and snapshot untouched; audited; the W-2 finishes | one more table and screen |
| (c) void + re-issue the runs (PAY-118) | uses the real correction path | moves deposits, payslips, 941 figures; PAY-118 not built |

**Chosen: (b), built last (PR-5), and only if the preflight (§10) finds such runs on prod or
the owner wants it for self-hosted installs.** An attributed run counts in its state's
box 16/17. Its withholding is **not** in the state-deposit source, so the reconciliation
(S24-D10) shows it on a separate "added by you" line. Attributions are allowed only for issued
runs with no `workState`; the state must be a 2-letter code with a `state_tax_configs`
row for the tax year whose kind is not `none`.

### S24-D8 — Local boxes 18–20 out of scope. *Owner decision pending.*

**Recommendation: out of scope (K1)**, with warning W7 on every NY line. Building them needs
NYC/Yonkers withholding in the engine first (PAY-120, PAY-122). Maryland is not part of this
decision: MD county tax belongs in box 17 (K1-MD), and completing it is PAY-120.

### S24-D9 — Copy 1 not emitted.

IRS: send Copy 1 to the state "if required". Per state (state-local-payroll-sme, 2026-09-27):
- **IL** — W-2s must be submitted electronically (IDOR Pub 131, January 2026).
- **NC** — NC-3 annual reconciliation plus W-2s, electronically through eNC3, due January 31;
  $200 penalty otherwise.
- **MD** — MW508 annual reconciliation plus W-2s by January 31 when MD tax was withheld;
  electronic when filing 25 or more W-2s.
- **CA** — no W-2 filing with the state (wages reported on the DE 9C).
- **NY** — no W-2 filing with the state (wages reported on the NYS-45).

Where a state wants W-2s it wants them electronically, so a paper Copy 1 serves none of these
five. State W-2 submission is filing automation (master D12). **Decision:** no Copy 1. The
W-2/W-3 filing checklist gains one line per state on the W-2s (§9 C1–C5).

### S24-D10 — Reconciliation inside the W-3 worksheet.

For years ≥ 2026 the worksheet carries, per state: `box17` (Σ over W-2 lines, from the
planner) and `runWithholding` (Σ `state_withholding` by `workState`, computed by the
deposits module's `loadStateLiability` query filtered to the pay year, an independent code
path), plus `attributedLegacy` (S24-D7). Rule: `box17 = runWithholding + attributedLegacy`, to the
cent. A mismatch is a **block** (B3) — it can only come from a code defect. "Marked as
deposited" (Σ live deposited `tax_deposits` rows of the state in the year) is shown in the
UI only, **not** stored in the worksheet, so deposit status changes never move the hash.

### S24-D11 — Hold the "W-2s are ready" email while a W-2 of the year is blocked. *Owner decision pending.*

`sendW2AvailableNotices` skips a year while any W-2 of that year has a block issue and
retries on the next tick. The admin detail shows "Employees haven't been told yet: fix the
items above." (§9 I4). *Owner decision pending — §13 Q5.*

### S24-D12 — W-3 box c counts forms, not employees.

IRS 2026 General Instructions p.25, "Box c—Total number of Forms W-2": "Show the number of
completed individual Forms W-2 that you are transmitting with this Form W-3. Do not count
'VOID' Forms W-2." p.26: boxes 16–19 are one sum over those forms. The app never emits a
VOID W-2 (it has no VOID-marked output), so every form counted is a completed form; the
additional state-only W-2s of S24-D4 count. Today
`computeW3Worksheet` sets `employeeCount = figures.length`. For years ≥ 2026 the worksheet
gains `w2FormCount = Σ formCount` and W-3 box c prints `w2FormCount`; `employeeCount` stays
as an informational field. Years < 2026 unchanged (S24-D5).

**SSA filing stays manual through BSO**, which builds the W-3 from the W-2s entered
(iw2w3 2026 p.4); the app never produces Copy A. So the filed box c equals `w2FormCount` only
if the owner enters every additional W-2 in BSO as its own W-2 (boxes a–f repeated, boxes
1–14 blank, the next state lines). §9 E1–E2 tell the owner to do that; §13 Q7 covers
whether BSO accepts it. **Needs
`federal-payroll-tax-sme` sign-off before PR-2 merges.**

## 5. Data model — migration `0023_<drizzle-generated>.sql` (PR-1)

```ts
export const companyStateIds = pgTable(
  "company_state_ids",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull().references(() => company.id),
    stateCode: text("state_code").notNull(),
    /** First tax year this ID applies to; W-2 for year Y uses max(from_tax_year) ≤ Y. */
    fromTaxYear: integer("from_tax_year").notNull(),
    /** Employer state account number — encrypted at rest ("enc:v1:"), write-only. */
    stateId: text("state_id").notNull(),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("company_state_ids_company_state_year_uniq").on(t.companyId, t.stateCode, t.fromTaxYear),
    check("company_state_ids_state_code_check", sql`${t.stateCode} ~ '^[A-Z]{2}$'`),
    check("company_state_ids_year_check", sql`${t.fromTaxYear} BETWEEN 2000 AND 2100`),
    check("company_state_ids_encrypted_check", sql`${t.stateId} ~ '^enc:v1:[A-Za-z0-9_-]{39,}$'`),
  ],
);
```

```sql
CREATE TABLE "company_state_ids" (
  "id" serial PRIMARY KEY NOT NULL,
  "company_id" integer NOT NULL,
  "state_code" text NOT NULL,
  "from_tax_year" integer NOT NULL,
  "state_id" text NOT NULL,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "company_state_ids_company_state_year_uniq" UNIQUE("company_id","state_code","from_tax_year"),
  CONSTRAINT "company_state_ids_state_code_check" CHECK ("state_code" ~ '^[A-Z]{2}$'),
  CONSTRAINT "company_state_ids_year_check" CHECK ("from_tax_year" BETWEEN 2000 AND 2100),
  CONSTRAINT "company_state_ids_encrypted_check" CHECK ("state_id" ~ '^enc:v1:[A-Za-z0-9_-]{39,}$')
);
ALTER TABLE "company_state_ids" ADD CONSTRAINT "company_state_ids_company_id_company_id_fk"
  FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;
```

The encrypted-check makes a plaintext write fail in the database, not only in code. 39 is
the base64url length (no padding) of the smallest `encryptField` output: 12-byte IV + 16-byte
tag + at least 1 ciphertext byte = 29 bytes → 39 characters. A value like `enc:v1:x` fails.

PR-5 only, migration `0024_<drizzle-generated>.sql`:

```sql
CREATE TABLE "w2_legacy_run_states" (
  "run_id" integer PRIMARY KEY NOT NULL,
  "state_code" text NOT NULL,
  "attributed_by" text NOT NULL,
  "attributed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "w2_legacy_run_states_state_code_check" CHECK ("state_code" ~ '^[A-Z]{2}$')
);
ALTER TABLE "w2_legacy_run_states" ADD CONSTRAINT "w2_legacy_run_states_run_id_payroll_runs_id_fk"
  FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE no action ON UPDATE no action;
```

No existing table, column, or row changes. `payroll_runs`, `payroll_entries`, and snapshots
are not touched (issued-run immutability holds). Apply only via `pnpm db:migrate`.

**Safety on live prod data.** Both migrations create empty tables; no lock on existing
tables beyond the FK validation of an empty table (milliseconds). Old code ignores the new
tables, so the migrate → app handover is safe.

## 6. Computation — worked example and rules in cents

**Worked example (CA).** Employee Ana, work state CA all of 2026, CA ID on file. 12 issued
monthly runs, each `gross_pay` 500000¢ and `state_withholding` 1234¢.
- box 1 = 12 × 500000 = 6000000¢ → `60000.00`
- CA box 16 = 6000000¢ → `60000.00`; box 17 = 12 × 1234 = 14808¢ → `148.08`
- 1 line → 1 form. W-3 (Ana alone): box 15 `CA` + ID, box 16 `60000.00`, box 17 `148.08`.
- Reconciliation: `loadStateLiability` CA, pay year 2026 = 14808¢ = Σ box 17. Pass.

**NY example.** Ben: CA Jan–Jun (6 × 500000¢, SWH 1234¢), NY Jul–Dec (6 × 500000¢, SWH
2000¢). box 1 = 6000000¢. CA: 16 = 3000000¢ `30000.00`, 17 = 7404¢ `74.04`. NY: 16 = box 1 =
`60000.00`, 17 = 12000¢ `120.00`. Lines ordered CA, NY on form 1. Box 16 total across lines
(`90000.00`) exceeds box 1; that is expected under R3.

Money parsing: `numeric(12,2)` text → `parseCents` (exact, rejects anything else);
output → `formatCents`. No `Number()` of a money string on this path.

## 7. API

**`GET /api/admin/annual-forms/w2?year=`** — each `w2s[]` row gains (boxes 1–6 unchanged):

```ts
stateLines: {
  state: string;               // "CA"
  box16: string;               // "60000.00"
  box17: string;               // "148.08"
  form: number;                // 1-based form number
  stateIdSource: "entered" | "ein_default" | null;   // never the ID or its mask
}[];
formCount: number;
blocked: boolean;              // any issue with severity 'block'
issues: {
  code: "legacy_state_runs" | "missing_state_id" | "reconciliation_mismatch"
      | "missing_state_id_zero_tax" | "legacy_runs_without_state"
      | "local_tax_md" | "local_tax_ny" | "exempt_reciprocity" | "ny_all_wages"
      | "period_spans_move";
  severity: "block" | "warn" | "info";
  state?: string;
  runs?: { runPublicId: string; payDate: string; stateTax: string }[];
  date?: string;
}[];
```
Years < 2026: `stateLines: []`, `formCount: 1`, `blocked: false`, `issues: []`.

**PDF routes.** `GET /api/admin/annual-forms/w2/:employeeId/pdf`, `…/print-packet`,
`GET /api/admin/annual-forms/w3/pdf`, and the employee W-2 PDF route in `my-w2.ts`. The
service throws a dedicated `W2BlockedError` carrying `codes: W2IssueCode[]` and a **fixed**
message (`"W-2 not ready"`, never built from data). Mapping:
- admin routes → **409** `{ error: "w2_not_ready", issues: codes }`;
- `my-w2.ts` → **409** body exactly `{ error: "w2_not_ready" }` (no `message`, no codes).
W-3 blocked when any W-2 of the year is blocked, or on a reconciliation mismatch.
`W2BlockedError` is not a `FilingServiceError`, so the existing `serviceError` mapper
(which copies `err.message`) never handles it.

**W-3 worksheet** (`tax_filings.worksheet`, form `w2_w3`, years ≥ 2026 only) gains:

```ts
w2FormCount: number;           // W-3 box c = Σ formCount (S24-D12)
box15State: string | null;     // "CA", "X", or null (no state lines)
box16StateWages: string;       // Σ all lines, "0.00" when none
box17StateTax: string;
states: { state: string; w2Lines: number; box16: string; box17: string;
          runWithholding: string; attributedLegacy: string; reconciled: boolean }[];
blockedEmployees: number;
```
No state ID in the worksheet (the row is not encrypted). `worksheet_hash` covers these keys.
When `box15State` is `null` (no W-2 of the year has a state line, e.g. every employee in TX)
the worksheet keeps `box16StateWages`/`box17StateTax` = `"0.00"`, but the W-3 PDF leaves boxes
15–17 (`f1_23`–`f1_26`) **empty** (IRS p.16: "If a box does not apply, leave it blank"; p.24).
`W3Input` carries `null` for all four in that case.

**State IDs.** Every route below, and both legacy-run routes, use
`preHandler: guards.requireRole("admin")` (employee → 403, no session → 401).
- `GET /api/admin/company/state-ids` →
  `{ stateIds: [{ stateCode, fromTaxYear, idMasked: "••••5678", source: "entered" }],
     defaults: [{ stateCode: "IL" | "NY", idMasked, source: "ein_default" }],
     needed: [{ stateCode, taxYear, reason: "tax_withheld" | "wages_only" }] }`.
  `needed` = states on any 2026+ W-2 line without an ID. Plaintext never leaves the server.
- `PUT /api/admin/company/state-ids/:stateCode` body `{ stateId: string, fromTaxYear?: number }`
  (`fromTaxYear` default 2026) → 200 with the masked row. Upsert on
  `(company, state, fromTaxYear)`. Validation per §4 S24-D2; a 400 body never echoes the value.
- `DELETE /api/admin/company/state-ids/:stateCode/:fromTaxYear` → 204.
- PUT and DELETE → 409 `state_id_year_filed` for a filed year (S24-D2, L9).
- Audit: `company.state_id.set` / `company.state_id.delete`, entity `company_state_id`,
  entityId `"{STATE}:{year}"`, before/after `{ idMasked }` only.
- **Masking (M4):** `maskStateId(plain)` = `"••••" + last 4` only when the ID is at least 8
  characters; shorter IDs return `"••••"` alone. Used for API reads, audit rows and the
  settings UI. (`maskLast4` would print a 4-character free-text ID in full.)
- **Settings UI (L10):** the input is cleared after save; the value is never kept in a
  Pinia store, `localStorage`, `sessionStorage`, or the URL; the page shows only the server
  mask.

**Legacy attribution (PR-5):** `PUT /api/admin/annual-forms/w2/legacy-runs/:runPublicId`
body `{ state }`; `DELETE` same path; admin only. An unknown `runPublicId` and a run that is
not eligible (not issued, has a `workState`, W-2 employee check fails) both return **404**
with the same body `{ error: "not_found" }`, so the route does not reveal which runs exist.
409 `filing_filed` when the run's tax year `w2_w3` filing is `filed`. Audit (M3):
- `w2.legacy_state.set`: entity `payroll_run`, entityId = run public id,
  before `{ state: <previous> | null }`, after `{ state }`;
- `w2.legacy_state.delete`: entity `payroll_run`, entityId = run public id,
  before `{ state }`, after `null`.
No amounts, names, or pay dates in either row.

## 8. PDF field-map plan (PR-3)

- New `packages/documents/src/forms/field-map-2026.ts`: `w2FieldMap2026(copy)` with the
  `_Top[0]` paths for boxes a–f, 1–6 and the two state lines (§4 S24-D6); `W3_FIELD_MAP_2026`
  = the 2025 map + `box15State`, `box15StateId`, `box16StateWages`, `box17StateTax`.
  Header comment records the dump method, source URL, download date, the two-up layout.
- A year-keyed selector `w2FieldMapFor(year, copy)` / `w3FieldMapFor(year)`; unknown year →
  throw (same as `templateBytes`).
- `templates.ts` 2026 entry gains `fw2Sha256`, `fw3Sha256`; the stale comment is removed.
- `W2Input` gains `stateLines: { state: string; stateId: string | null; box16: string;
  box17: string }[]` (pre-formatted strings, never floats) and `formCount`. `W3Input` gains
  `box15State`, `box15StateId`, `box16StateWages`, `box17StateTax` (strings, nullable; all
  `null` → the four W-3 state fields stay empty, §7).
- `fillText` comment becomes "blank boxes stay blank (D36: boxes 7–14 and 18–20)".
- The state ID is decrypted in `w2InputFor` / `w3InputFor` at render time only
  (the EIN doctrine), IL/NY default from the decrypted EIN.
- Pre-flatten test API: `prepareW2Forms(input, copies): Promise<PDFDocument[]>` (one per form).
- 2025 path: untouched field map, `stateLines` ignored for years < 2026 (defensive: assert
  empty).

## 9. Admin-facing and employee-facing copy (drafts for product-ux-designer)

`{Employee}` = legal name, `{State}` = state name via `stateName()`, `{Year}` = tax year.

Blocks:
- **B1 missing_state_id**: "Add your {State} account number. {Employee}'s W-2 shows {State}
  tax withheld, but we don't have your {State} employer account number yet. Add it under
  Company settings, State tax account numbers, then download the W-2 again."
- **B2 legacy_state_runs**: "Some of {Employee}'s {Year} pay runs were made before the app
  kept track of work states, and they include state tax. We can't tell which state that tax
  belongs to, and we won't guess. Pick the state for each pay run below to finish this W-2."
  Row: "Paid {date} · {amount} state tax · [Choose state]". Without PR-5: "…Contact support
  to finish this W-2."
- **B3 reconciliation_mismatch**: "The {State} tax on your W-2s ({w2}) doesn't match the
  {State} tax on your issued pay runs ({runs}). Don't send these forms yet. Contact support."
- **Employee, blocked download**: "Your {Year} W-2 is almost ready. {Company} is finishing a
  few details. Please check back soon."
- **W-3 blocked**: "Your W-3 can be made once every W-2 above is ready."

Warnings:
- **W4 missing_state_id_zero_tax**: "{Employee} earned wages in {State} with no {State} tax
  withheld. The W-2 will show the {State} wages without an account number. If {State} gave
  you one, add it under State tax account numbers."
- **W5 legacy_runs_without_state**: "Some of {Employee}'s {Year} pay runs have no work
  state. They had no state tax withheld, so they are not on any state line. If {Employee}
  worked in a state with income tax during those pay periods, check the state lines before
  you hand out this W-2."
- **W6 local_tax_md**: "Maryland reports county tax in box 17 together with state tax. This
  app did not withhold Maryland county tax, so box 17 shows state tax only."
- **W7 local_tax_ny**: "New York City and Yonkers have their own income tax. This app doesn't
  work out local tax yet, so boxes 18–20 are blank. If {Employee} lives in New York City or
  Yonkers, or works in Yonkers, check what you need to withhold and report." (Yonkers
  nonresident earnings tax: NYS-50-T-Y, 1/26.)
- **W8 exempt_reciprocity** (IL, MD): "{Employee} is marked exempt from {State} tax. If
  that's because they live in a neighboring state, their home state may need its own line on
  this W-2. This app doesn't add that line yet."

Info:
- **I1 ny_all_wages**: "New York asks for all of {Employee}'s {Year} wages in box 16, not
  only the New York part."
- **I2 period_spans_move**: "{Employee} changed work state on {date}, partway through a pay
  period. That whole pay run counts in {State}, where the pay period started."
- **I3** reconciliation card per state: "{State} tax check: W-2s {box17} · issued pay runs
  {runWithholding} · marked as deposited {deposited}". With attributions: "· added by you
  {attributedLegacy} (not in your deposits page)".
- **I4** notice hold: "Employees haven't been told their W-2s are ready yet. Fix the items
  above first."
- Settings section "State tax account numbers": intro "Your state gives you an employer
  account number when you register for state payroll tax. It goes in box 15 of each W-2."
  IL/NY default row: "Using your EIN (••••1234). Change it if {State} gave you a different
  number." NY input hint: S24-D2. No tax advice in any string.

SSA filing through BSO (S24-D12; shown on the W-2/W-3 filing detail when any W-2 of the
year has `formCount > 1`):
- **E1** banner: "Some employees get more than one W-2 this year because they worked in more
  than two states. When you enter W-2s in Business Services Online, enter each extra W-2 as its
  own W-2: same employee and employer details (boxes a–f), boxes 1–14 left blank, and the
  next state lines. Then the W-3 that Business Services Online makes will show {w2FormCount}
  W-2s, the same as ours."
- **E2** list, one row per such employee: "{Employee}: {formCount} W-2s. W-2 #{k}: {State},
  {State}" (the state codes on each extra form, from `stateLines[].form`).
- The checklist step today reads "Download the W-2 PDFs (one per employee) and the W-3
  transmittal PDF above." (`AdminFilingDetailView.vue`). PR-4 replaces it with: "Download the
  W-2 PDFs and the W-3 transmittal PDF above. An employee can have more than one W-2."

Filing checklist, one line per state on the year's W-2s (S24-D9):
- **C1 IL**: "Illinois: send your W-2s to the Illinois Department of Revenue electronically."
- **C2 NC**: "North Carolina: file Form NC-3 with your W-2s electronically (eNC3) by
  January 31."
- **C3 MD**: "Maryland: file Form MW508 with your W-2s by January 31. If you have 25 or more
  W-2s, file electronically."
- **C4 CA**: "California: no W-2s to send. Your wages go on the DE 9C each quarter."
- **C5 NY**: "New York: no W-2s to send. Your wages go on the NYS-45 each quarter."
Other states: no line (the SME adds states as they are verified).

## 10. Migration, preflight, rollback

**Preflight (read-only, run by infra on prod before the release; owner's call).** Counts
only; no amounts, names, or ids leave the database. Run inside a read-only transaction (or
as a read-only role); post only the count rows to the PAY-116 Plane ticket; never copy row
output anywhere else.

```sql
BEGIN TRANSACTION READ ONLY;

-- Q-A: legacy runs that would block (R7), per pay year.
SELECT extract(year FROM r.pay_date)::int AS tax_year,
       count(DISTINCT r.id)          AS legacy_runs_with_state_tax,
       count(DISTINCT r.employee_id) AS employees
FROM payroll_runs r
JOIN payroll_entries e ON e.run_id = r.id AND e.category = 'state_withholding'
JOIN employees emp     ON emp.id = r.employee_id AND emp.employment_type = 'w2'
WHERE r.status = 'issued'
  AND e.amount > 0
  AND (r.run_snapshot #>> '{inputs,state,workState}') IS NULL
GROUP BY 1 ORDER BY 1;

-- Q-B: 2026+ issued runs by work-state presence (expect customer zero: no state lines).
SELECT extract(year FROM r.pay_date)::int AS tax_year,
       coalesce(r.run_snapshot #>> '{inputs,state,workState}', '(none)') AS work_state,
       count(*) AS runs
FROM payroll_runs r
WHERE r.status = 'issued' AND r.pay_date >= '2026-01-01'
GROUP BY 1, 2 ORDER BY 1, 2;

ROLLBACK;
```
Q-A rows for 2026 or later decide whether PR-5 is needed before January 2027.

**Deploy order.** Preflight → migrate 0023 (and 0024 with PR-5) → app. QA first; prod only
in an owner-approved release. No new env var or secret; `compose.example.yml` unchanged
(master D9).

**Rollback.** Forward-only; the new tables are never dropped.
- Re-pin the previous image: old code ignores the tables. 2026 W-2 PDFs then fail again
  (no 2026 template) and state lines disappear; nothing is corrupted.
- The 2026 `w2_w3` worksheet only exists from 2027-01-01. If a rollback happens after that,
  the old code recomputes it without the state keys (unfiled rows refresh; filed rows are
  frozen) — expected, no data repair.
- W-2s already handed out with state lines stay correct; re-rendering on the old image would
  lack boxes 15–17, so do not roll back across the furnishing window (January 2027) without
  the owner's call.

## 11. Scenario list for `payroll-calc-auditor` (tests written and failing before code)

GUARDRAILS scenario classes a–g. All data synthetic (names, ids, EIN `00-0000000`-style,
state IDs `00000001`). Expected values computed by hand here, not by the code. Monthly runs,
pay date the 25th, `gross_pay` 500000¢ per run unless stated. "ID" = a synthetic state ID on
file (CA `00000001`). File:
`apps/server/test/w2-state-boxes.test.ts` (integration) + pure planner unit tests with
literal inputs.

| # | Class | Setup | Expected |
|---|---|---|---|
| W01 | g | Ana CA 2026, 12 × gross 500000¢, SWH 1234¢, CA ID | 1 line CA `60000.00` / `148.08`, form 1; formCount 1; W-3 box c `1`, box 15 `CA`+ID, 16 `60000.00`, 17 `148.08` |
| W02 | a,g | Ben CA Jan–Jun, NY Jul–Dec (§6), IDs | CA `30000.00`/`74.04`; NY `60000.00`/`120.00`; order CA, NY; issues: I1 NY, W7 NY. NY box 16 string `===` the rendered box 1 string (`60000.00`, pre-flatten `f2_09` vs `f2_35`) |
| W03 | a (K3) | Cara: work state CA from 2026-01-01, NY from 2026-06-10; gross 400000¢; CA SWH 1000¢, NY SWH 1500¢ | June run is CA. CA `24000.00`/`60.00`; NY `48000.00`/`90.00`; issues: I2 (date 2026-06-10, state CA), I1 NY, W7 NY |
| W04 | a | Ivy IL all year, SWH 24750¢ Jan–Jun, exempt election from Jul (SWH 0) | IL `60000.00` / `1485.00`; W8 (IL exempt) |
| W05 | g (3 states) | Dee IL Jan–Apr (SWH 24750¢), MD May–Aug (2500¢), NC Sep–Dec (2000¢), gross 500000¢, IDs | lines IL `20000.00`/`990.00` f1, MD `20000.00`/`100.00` f1, NC `20000.00`/`80.00` f2; formCount 2; W6 MD. W-3 for Dee alone: box c `2` (employeeCount 1), box 15 `X`, 16 `60000.00`, 17 `1170.00`. PDF: form 2 has a–f, NC on line 1, boxes 1–6 empty; packet 9 pages; Copy D 2 pages |
| W06 | g (none) | Eve TX all year (snapshot kind `none`, SWH 0) | no lines, no issues; PDF fields identical to a box 1–6-only W-2. W-3 with Eve as the only employee: worksheet `box15State` `null`, `box16StateWages`/`box17StateTax` `"0.00"`; W-3 PDF pre-flatten `f1_23`, `f1_24`, `f1_25`, `f1_26` all empty; box c `1` |
| W07 | g,a | Fay TX Jan–Jun, CA Jul–Dec SWH 1234¢ | only CA `30000.00`/`74.04` |
| W08 | g (NY exempt) | Hal NY all year, exempt (SWH 0), no NY row entered, EIN set | NY `60000.00` / `0.00`; ID source `ein_default`; no block; I1, W7; NY box 16 string `===` rendered box 1 string. **Variant W08b:** company EIN unset and SWH 1500¢/run → ID source `null`, `blocked: true` (B1); variant with SWH 0 → W4 warn only |
| W09 | g (0.00, no ID) | Ivy variant: NC all year, exempt (SWH 0), no NC ID | NC line `60000.00`/`0.00`; W4 only; PDF renders with blank ID |
| W10 | S24-D3 block | W01 without CA ID | `blocked: true`, B1; admin Copy D, print packet, W-3 → 409 `{ error: "w2_not_ready", issues: ["missing_state_id"] }`; employee route → 409 body deep-equals `{ error: "w2_not_ready" }` (no `message` key); JSON list 200 |
| W11 | b (R7) | Jon: Jan–Mar legacy runs (no `inputs.state`) SWH 3000¢ each; Apr–Dec CA SWH 1234¢ | B2 listing 3 runs (public ids, pay dates, `30.00`); CA line shown `45000.00`/`111.06`; PDFs 409 |
| W12 | b (PR-5) | W11 + attribute the 3 runs to CA | CA `60000.00` / `201.06`; not blocked; reconciliation CA: box17 20106 = runWithholding 11106 + attributedLegacy 9000. Audit: `w2.legacy_state.set` × 3 (entity `payroll_run`, before `{state:null}`, after `{state:"CA"}`, no amount keys); DELETE one → `w2.legacy_state.delete` before `{state:"CA"}`. Auth: employee 403, no session 401 on PUT and DELETE; unknown public id → 404 `{error:"not_found"}`, same body as a run with a `workState`; year filed → 409 |
| W13 | b (customer-zero shape) | Neo: all 2026 runs legacy, SWH 0 | no lines, no issues, not blocked; W-2 fields identical to main |
| W14 | b | Neo variant: Jan–Jun legacy SWH 0, Jul–Dec CA SWH 1234¢ | CA `30000.00`/`74.04`; W5 |
| W15 | b (pre-2026) | 2025 fixture of `annual-forms.test.ts` + an IL work state for one employee | `stateLines: []`; W-3 worksheet deep-equal to main's (no new keys) and same `worksheet_hash`; 2025 PDF field values identical to main |
| W16 | b | Change the live `state_tax_configs` TX row to `flat` after W06's runs are issued | W06 result unchanged (kind read from the snapshot) |
| W17 | c | Any fixture: `refreshAnnualWorksheet` twice; render the same W-2 twice | second refresh returns false, `updated_at` unchanged; figures JSON deep-equal; pre-flatten field values deep-equal |
| W18 | d | W01, then March run set void (DB path the trigger allows) and a new March run issued, gross 500000¢, SWH 1300¢ | CA `60000.00` / `148.74` |
| W19 | d | W01, March run void, no re-issue | CA `55000.00` / `135.74`; box 1 `55000.00` |
| W20 | e | Kim CA: Dec 2025 period paid 2026-01-05; Jan–Nov 2026 periods paid the 5th of the next month; Dec 2026 period paid 2027-01-05; each gross 500000¢, SWH 1234¢ | 2026: CA `60000.00`/`148.08` (12 runs); the 2027-01-05 run is on 2027 only |
| W21 | e,a | W20 + work state NY from 2027-01-01, Jan 2027 period paid 2027-02-05 NY SWH 2000¢ | 2027 figures (JSON): CA `5000.00`/`12.34` (Dec 2026 period, periodStart state) + NY `10000.00`/`20.00` (NY = box 1); issues: I1 NY, W7 NY; NY `box16` string `===` `money(box1Wages)` of the same JSON row |
| W22 | f | W01; mark the CA Q-deposits deposited, then overdue variants | W-2 figures and worksheet hash unchanged; only the UI "marked as deposited" figure changes |
| W23 | g (W-3) | Ana (W01) + Ben (W02), IDs | W-3 box c `2` (1 + 1 forms); box 15 `X`, no ID; 16 `150000.00`; 17 `342.12` |
| W24 | R9 | W01 + W02 + W05 in one company | per state: CA box17 14808+7404 = 22212 = runWithholding; IL 99000; MD 10000; NC 8000; NY 12000; all reconciled. W-3 box c `4` (Ana 1 + Ben 1 + Dee 2), employeeCount 3 |
| W25 | R9 guard | Force a mismatch (test double for the deposits query) | B3 on the W-3; W-3 PDF 409 |
| W26 | S24-D2 | PUT: CA `123-4567-8`; CA `1234567`; NC `123456789`; NC `APPLIEDFOR`; MD `12-345678`; MD 10-digit UI number `1234567890`; MD FEIN `123456789`; IL `123456789`; IL `123456789000`; IL `ABC 12`; NY `123456789`; NY `12345678901`; NY `123456789012`; NY 7-digit UI number `1234567`; TX free text with a control character | 200 `12345678`; 400; 200; 400; 200 `12345678`; 400; 400; 200; 200; 400; 200; 200; 200; 400; 400. No 400 body contains the submitted value |
| W27 | S24-D2 year | CA rows from 2026 `00000001` and from 2028 `00000002`; then mark the 2026 `w2_w3` filing filed | 2026 and 2027 W-2 use `00000001`; 2028 uses `00000002`. After filing: PUT CA from 2026 → 409 `state_id_year_filed`; DELETE CA/2026 → 409; PUT CA from 2027 → 200 |
| W28 | security | PUT then GET state id; read the audit row; read the DB column; insert plaintext and `enc:v1:x` via SQL; PUT a short free-text ID `AB12` for TX; auth matrix | GET shows `••••0001` only; audit before/after hold `idMasked` only; column matches `^enc:v1:[A-Za-z0-9_-]{39,}$`; both SQL inserts fail the check; `AB12` → GET and audit show `••••` only and no audit JSON contains `AB12`; employee 403 and no session 401 on GET/PUT/DELETE state-ids; no state ID in figures JSON, worksheet, `/api/export` responses, or captured logs |
| W29 | PDF 2026 | W01 pre-flatten, Copy B/C/2/D Top | `f2_31` `CA`, `f2_32` `00000001`, `f2_35` `60000.00`, `f2_37` `148.08`; `f2_33`–`f2_38` line-2 fields empty; box 1–6 in the `_Top[0]` 2026 paths; every `_Bottom[0]` field empty |
| W30 | PDF W-3 2026 | W23 pre-flatten | `f1_02` (box c) `2`; `f1_23` `X`, `f1_24` empty, `f1_25` `150000.00`, `f1_26` `342.12`; boxes e–g and 1–6 as today |
| W31 | S24-D11 | W10 on 2027-01-01 | no `w2_available` email for 2026 while blocked; after adding the CA ID, next tick sends it once |
| W32 | preflight | W11 fixture | Q-A returns (2026, 3, 1); Q-B returns counts only |

Class f (pending / overdue / deposited rows) applies to W-2s only through W22: W-2 figures
come from issued runs, never from deposit status.

**Must fail first on `origin/main` 36c7307:** W01–W14, W16, W18–W31 (no `stateLines`, no
state-ID routes, no 2026 template: `templateBytes(2026, "fw2")` throws). W15 and W17 are
guards that pass before and after. W32 needs only the fixture.

## 12. PR decomposition (in order, each through the code-pipeline; PR titles carry PAY-116)

1. **PR-1 — state IDs.** Migration 0023, schema, `/api/admin/company/state-ids` routes,
   masked audit, "State tax account numbers" section in company settings, IL/NY EIN default
   (read side), `maskStateId`, filed-year 409. Tests W26–W28. Gate: `security-privacy-reviewer`.
2. **PR-2 — planner + figures.** `filings/w2-state.ts` (`planW2StateLines`), the loader
   (per-run query with `workState`, `kind`, `exempt`), `W2Figures` JSON fields, W-3
   worksheet fields for ≥ 2026, reconciliation via the deposits query, `STATE_BOXES_FROM_YEAR`.
   W-3 `w2FormCount` (S24-D12). Tests W01–W11, W13–W25 at the JSON/worksheet level. Gates:
   `state-local-payroll-sme`, `payroll-calc-auditor` (owns the test file; recomputes §11
   independently), `federal-payroll-tax-sme` (box c).
3. **PR-3 — 2026 forms.** 2026 fw2/fw3 assets + SHA pins, `field-map-2026.ts`, year-keyed
   selectors, multi-form assembly, W-3 boxes 15–17. Tests W05 (PDF part), W29, W30, W15 (PDF
   part). Gates: `payroll-calc-auditor` (placement), `state-local-payroll-sme` (sample
   render, synthetic).
4. **PR-4 — blocks, UI, notices.** `W2BlockedError` and the 409s on the four PDF routes,
   `sendW2AvailableNotices` hold (if Q5 is approved), filing-detail state lines + issues +
   reconciliation card, filing checklist lines C1–C5 (S24-D9), BSO copy E1–E2 and the
   rewritten "Download the W-2 PDFs" step in `AdminFilingDetailView.vue` (the separate
   e-file-threshold wording defect in that view is its own ticket, not this PR), QA seed adds a synthetic IL row only if the SME rules the EIN default wrong, one e2e
   on the W-2/W-3 detail. Tests W10, W22, W31 + e2e. Gates: `product-ux-designer` (copy),
   `security-privacy-reviewer` (employee 409 body).
5. **PR-5 — legacy attribution (conditional, §4 S24-D7).** Migration 0024, attribution
   routes (admin only, uniform 404, audited), UI rows under B2, reconciliation "added by
   you". Tests W12, W32. Gates: state SME,
   auditor, security (audit content).

## 13. Questions for the owner

- **Q1 (S24-D3) — DECIDED 2026-09-27:** block a W-2 whose state line has tax withheld and no
  state account number; warn only when no tax was withheld.
- **Q2 (S24-D8, pending)** Local boxes 18–20 stay blank, with the NY warning on each NY W-2
  (MD county tax is a box 17 matter, K1-MD). Recommendation: yes; local tax waits for
  PAY-120 / PAY-122.
- **Q3 (S24-D6, pending)** Add the 2026 W-2/W-3 templates in this ticket. Recommendation: yes;
  without them no 2026 W-2 renders in January 2027.
- **Q4 (S24-D7)** Build the in-app legacy attribution (PR-5) only if the prod preflight finds
  2026 runs with state tax and no work state. Recommendation: yes, conditional.
- **Q5 (S24-D11, pending)** Hold the "your W-2 is ready" email while any W-2 of the year is blocked.
  Recommendation: yes.
- **Q6** Boxes 1–6 are still computed with `Number` and `round2` (float), against the
  integer-cents rule. Recommendation: a separate ticket to move them to cents, before
  January 2027.
- **Q7 (before January 2027)** Someone with a BSO account must confirm that the new BSO W-2
  application (the old one was decommissioned 2026-09-19, per ssa.gov as reported by
  `federal-payroll-tax-sme`; not re-checked here) accepts a W-2 with every federal money box
  blank, and how many state rows it allows per W-2. If BSO allows more than two states on one
  record, the owner's filed W-3 box c would differ from `w2FormCount`, and E1–E2 must change.
  (IRS 2026 General Instructions pp.4, 16, 17, 25.)

## Owner sign-off

- [x] Q1 (S24-D3) decided 2026-09-27: block when box 17 > 0 and no state ID; warn when box 17 = 0
- [ ] Spec 24 approved as written / with amendments (Q2–Q7 answered)
