# Changelog

All notable changes to this project will be documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.26.0] - 2026-09-26

### Fixed

- **State tax deposits no longer count months twice when a state's schedule
  changes (PAY-91, spec 23)** — when a state moved between monthly and
  quarterly deposits (for example after loading the 2026 schedules for CA,
  NC, NY or MD), months 2 and 3 of the quarter stayed open next to the
  quarter row, and if month 1 was already paid the quarter amount was never
  updated. The deposit sync now rebuilds each state's quarter from what was
  withheld and what was already paid: unpaid months merge into one quarter
  row, the quarter row shows only what is left to pay, and a move back to
  monthly splits the quarter into months. Deposits already marked as paid
  are never changed. Rows that were replaced get the new status "Replaced"
  and drop out of lists, totals, reminders, the calendar and the overdue
  check. Federal deposits and 941 line 13 are unchanged.

### Added

- **Clearer state deposit screens (PAY-91)** — a replaced row shows
  "Replaced · nothing to pay here" and links to the row to pay; open rows
  show "Already paid · Left to pay"; one "Overpaid" chip marks a
  state-quarter where more was paid than owed; "Check with {State}" notes
  appear where the state's crediting of earlier payments is unclear.
  Prose uses state names, and the jurisdiction column shows
  "California (CA)".
- **New admin email (PAY-91)** — "{State} tax deposits for {Q} need
  checking" is sent at most once a day per state and quarter when the
  deposit sync cannot settle that state's rows. It carries no amounts. The
  other states and federal rows still update.

### Changed

- **Calendar labels for state deposits (PAY-91)** — state rows read
  "California deposit due — Q3 2026" (monthly states "Illinois deposit due
  — July 2026") instead of the "941" label, under one "Tax deposits" legend
  entry. Federal rows keep "941 deposit due — August 2026".
- **Only the new image names are published (PAY-68 step 3)** — images are
  published only as `ghcr.io/soult-io/wagon-payroll` and
  `ghcr.io/soult-io/wagon-payroll-verify`. The old names (`payroll-app`,
  `payroll-app-verify`) got their last release tag at v1.25.0; existing
  tags remain pullable. Operators still on the old name must switch their
  `image:` lines.
- **Developer tooling (PAY-92, PAY-93)** — a money-path test-gap audit
  (`plan/test-gap-audit-2026-09.md`, docs only); StrykerJS mutation testing
  for the engine and the server's deposits and filings code, run weekly by
  `.github/workflows/mutation.yml` with a baseline in
  `plan/mutation-baseline-2026-09.md`; a pnpm patch for Stryker's vitest
  runner, and the Dockerfile now copies `patches/` into the build stage so
  the image install applies it. No change to the app.

### Upgrade notes

- **One migration:** `packages/db/drizzle/0022_gorgeous_omega_sentinel.sql`
  adds `period_kind` (month | quarter, default month), the status
  `superseded` with `superseded_at`, a partial unique index on
  (jurisdiction, period_start, period_kind) over rows that are not
  superseded, and CHECK constraints including `amount >= 0`. Existing rows
  become `period_kind = 'month'` with no value change. Checked against
  previous-release data by test T16 in
  `apps/server/test/state-deposit-transitions.test.ts`: v1.24-shape rows
  migrated from 0021 are byte-identical after 0022. **Preflight before
  deploy:** `SELECT count(*) FROM tax_deposits WHERE amount < 0` must
  return 0 (QA: 0, checked 2026-09-26). Apply it only through
  `drizzle-kit migrate` (the `app-migrate` one-shot), which runs it in one
  transaction.
- **The deposit sync now rewrites existing state rows:** it recomputes the
  amount, due date and status of pending and overdue STATE rows (spec 23
  D4). Deposited rows and federal rows are unchanged. Checked against
  previous-release data by T17 (v1.24 rows + 0022 + seed + sync give the
  correct Q3 rows; federal rows identical) and T28 (941 Q3 line 13 is
  unchanged at 1,721.28 with replaced rows present).
- **Loading the 2026 state schedules (`seed.js`)** no longer causes the
  double count. But state deposit rows still tell owners to pay on
  eftps.gov (PAY-105). **Do not run `seed.js` on prod until PAY-105
  ships.**
- **Image names:** from this release, images are published only as
  `ghcr.io/soult-io/wagon-payroll` and `ghcr.io/soult-io/wagon-payroll-verify`.
- **Authenticator apps:** enrollments made before v1.25.0 keep the label
  "Payroll". No action needed.

## [1.25.0] - 2026-09-26

### Added

- **Projected filing dates on the calendar (PAY-51, PAY-52)** — the admin
  calendar now shows upcoming filings before their `tax_filings` row exists:
  the quarterly 941 (generation date and due date) and the annual W-2/W-3
  and 940 (due date; W-2/W-3 also its Jan 1 generation date), for any
  period with at least one issued run. They use a dashed purple style and
  disappear once the real filing row exists.
- **Per-state deposit due-date schedules (PAY-48)** — state `tax_deposits`
  due dates now come from a per-state schedule in a new
  `state_deposit_schedules` table, seeded for 2026 from verified official
  sources: CA, NC, NY quarterly (last day of the month after the quarter),
  MD quarterly (15th of the month after the quarter), IL monthly (15th of
  the next month). Quarterly states get one deposit row per quarter, shown
  as `Q3 2026` in the list, detail view, and reminder emails. States without
  a schedule keep the federal convention (15th of the next month). Weekend
  dates roll forward; holidays do not.
- **Deposit detail view improvements (PAY-37)** — record a payment
  ("Mark as deposited") from the deposit detail page; the EFTPS reference
  card shows the tax year and quarter to pick on eftps.gov; the breakdown
  shows Social Security and Medicare as combined employee + employer rows,
  as EFTPS asks for them. The total is unchanged.
- **Manual workflow to copy old image tags to the new name (PAY-69)** —
  `.github/workflows/ghcr-copy-legacy-tag.yml` copies a tag published
  before the rename from `ghcr.io/soult-io/payroll-app(-verify)` to
  `ghcr.io/soult-io/wagon-payroll(-verify)` by digest, refuses to overwrite
  a tag that points elsewhere, and checks the digest after the copy.
  See `docs/deployment.md`.

### Changed

- **Tax deposits table is easier to read (PAY-38)** — the period shows as
  `Oct 2025` (quarters as `Q3 2025`), due dates stay on one line, the
  Deposited column shows only the date with the EFTPS confirmation behind
  a **View confirmation** action, and Period, Jurisdiction, Amount, Due
  date, Status, and Deposited sort both ways.
- **The app is now called Wagon Payroll (PAY-66, spec 22)** — the tab title,
  header, login page, new authenticator enrollments, and emails use the
  product name from one setting, `BRAND_NAME` (default "Wagon Payroll"),
  served to the web app by `GET /api/runtime-config` (now
  `{ appEnv, brandName }`). `TOTP_ISSUER` stays as an optional override and
  otherwise follows `BRAND_NAME`. Emails lead with the employer's name
  (subject `<company> — <topic>`) and name the product only as the sender:
  "Sent by Wagon Payroll on behalf of <company>". Security emails now say
  "contact <company>" instead of "contact your administrator". The pay-verify
  page is titled "Wagon Payroll QA verification". Payslip and invoice PDFs
  are unchanged.
- **Authenticator apps:** accounts enrolled before this release keep the
  label "Payroll" in the authenticator app. Their codes keep working; no
  action or re-enrollment is needed.
- **Container images have new names (PAY-68)** — the repository is now
  `soult-io/wagon-payroll`, and images are published as
  `ghcr.io/soult-io/wagon-payroll` (app) and
  `ghcr.io/soult-io/wagon-payroll-verify` (pay-verify site). The old names,
  `ghcr.io/soult-io/payroll-app` and `ghcr.io/soult-io/payroll-app-verify`,
  get the same tags in parallel for one release and then stop receiving new
  tags (existing tags stay pullable). **Operators:** switch your `image:`
  lines to the new names. The container name `payroll-app` is unchanged.
- **QA seed gives the sample employee a work state (PAY-49)** — the QA
  fixture now assigns Ada an Illinois work-state election, so seeded QA runs
  show state withholding and IL deposit rows. QA data only; production is
  not affected.
- **QA tooling (PAY-54, PAY-78, PAY-79)** — the pay-verify QA dashboard
  marks flaky, never-run, and not-run results, shows CI and nightly results
  separately, is bound to the tested commit, and shows per-step screens and
  a walkthrough video for each journey; five live-QA journeys run in
  ordinary CI; the verify image build is sturdier and backfills dropped
  runs. No change to the app.

### Upgrade notes

- **One additive migration:** `packages/db/drizzle/0021_puzzling_bishop.sql`
  creates the table `state_deposit_schedules`. The `app-migrate` one-shot
  applies it automatically. The table starts empty, and while it is empty
  every state keeps the federal convention (monthly, due the 15th of the next
  month).
- **Do not load the state deposit schedules yet (known issue PAY-91).** Running
  `seed.js` fills the table. For a quarterly state (CA, NC, NY, MD) that
  already has monthly deposit rows in the current quarter, the deposit sync
  then counts months 2 and 3 of that quarter twice, and the quarter row keeps
  the earlier monthly due date. Wait for the fix before running `seed.js` on
  an existing installation.
- **Existing state deposit rows keep their due dates.** The deposit sync sets
  a due date only when it creates a row.
- **Authenticator apps:** existing enrollments keep the label "Payroll".
- **Image names:** new images are `ghcr.io/soult-io/wagon-payroll` and
  `ghcr.io/soult-io/wagon-payroll-verify`. The old names
  (`ghcr.io/soult-io/payroll-app`, `-verify`) also get this release, then
  stop receiving new tags.

## [1.24.0] - 2026-09-22

### Added

- **pay-verify static QA dashboard (PAY-44/PAY-45, spec 17)** — a PII-free
  static site rebuilt nightly from the emitted QA result summary: latest
  overall pass/fail with timestamp/commit, run-history trend, per-suite
  breakdown (e2e, unit/integration, tax fixtures), rich per-journey e2e
  cards, and tax-worksheet correctness cards (940/941, FUTA, state
  withholding) shown as expected-vs-actual, plus a deep link to the full
  HTML report. Published as `ghcr.io/soult-io/payroll-app-verify`; the
  dashboard defaults to dark mode.

### Fixed

- **Filter dropdowns show their default "All …" label (PAY-42)** — the
  status/form/jurisdiction filters on the Payroll runs, Tax filings, and
  Tax deposits admin lists rendered blank on load. PrimeVue wipes null and
  empty-string Select models at mount (`$formDefaultValue` watcher +
  `findNonEmpty`), so `value: null`/`""` "All …" options never matched.
  The query-backed filters now bind through a `useSelectAll` adapter with a
  non-empty `SELECT_ALL` sentinel; URL/bookmarkable-filter semantics
  (PAY-17) are unchanged.
- **pay-verify site build is resilient to a missing summary artifact** —
  the dashboard build no longer fails when a nightly hasn't emitted a
  summary yet.

## [1.23.0] - 2026-09-21

### Added

- **Per-state tax deposit rows (PAY-47)** — completes the deferred PAY-9 D2
  half. The daily deposit sync now derives per-state monthly `tax_deposits`
  rows from issued runs' frozen snapshots (`inputs.state.workState`),
  summing `state_withholding` per state per month alongside the existing
  federal 941 rows. Same idempotency rules: pending rows recompute on
  late-issued runs, deposited/overdue rows are never rewritten, and months
  with zero/no state withholding produce no row.
- **Jurisdiction filtering on the deposits admin API** —
  `GET /api/admin/tax-deposits?jurisdiction=` accepts `federal` or a
  2-letter uppercase state code. The deposit detail endpoint returns a
  single `state_withholding` breakdown entry for state rows with runs
  scoped to that state; federal detail is unchanged.
- **Jurisdiction filter in the Tax Deposits UI** — dropdown backed by the
  route query (like the other PAY-17 filters, options derived from loaded
  data), plus friendly jurisdiction labels (`Federal` vs state code) in the
  list and the deposit detail header.

State deposit due dates currently follow the same 15th-of-following-month
convention as federal deposits; per-state due-date schedules are a
documented follow-up.

## [1.22.0] - 2026-09-21

### Added

- **Per-state income-tax withholding, phase 2 (PAY-13)** — full state coverage
  and the employee self-service flow:
  - **2026 seed data for all 50 states + DC**: 48 new
    `state-taxes/<ST>-2026.json` seed files — 39 income-tax states + DC with
    official-source citations (incl. mid-2026 legislative updates: AR HB 1001,
    GA HB 463, IN 2.95%, KY 3.5%, NC 4.09%, WV SB 392, HI lump-sum allowance),
    plus explicit `kind='none'` rows for the 8 no-income-tax states. Rules
    that don't fit the engine's config shape are encoded as the closest
    documented fit (exceptions tracked on the Plane issue; MD county tax is
    the loudest omission).
  - **80 golden fixture tests** (`payroll-state-all.test.ts`) cross-checked by
    an independent Python implementation of the documented engine semantics
    (`scripts/gen-state-golden.py`).
  - **Employee state-election change requests**, mirroring the PAY-8 W-4
    flow: shared `stateElectionPayload` schema (exempt ⇒ no allowances/extra,
    same rule as the admin route), `state_election` request type end to end —
    DB check constraint migration, append-only INSERT into
    `state_withholding_elections` on admin approval, effective-date guard,
    audit + outbox notifications, wizard type card + form, payload rendering,
    and the admin current-vs-proposed diff.
  - **Export API per-jurisdiction breakdown**: each exported run carries
    `stateJurisdiction` (the work state frozen in the run snapshot; `null`
    for legacy flat-rate runs), the JSON response totals
    `stateWithholding.byJurisdiction` for state quarterly filings, and the CSV
    gains a trailing `state_jurisdiction` column (existing column positions
    unchanged).
  - **QA E2E employee journey** (ephemeral): wizard submit → admin approve →
    election on the State tax tab → generate/approve/issue → payslip shows
    the computed state withholding (golden $195.93 for the IL scenario).

### Fixed

- The change-request wizard now merges `effectiveFrom` into the submit
  payload for `w4`/`state_election` — the server validates the key inside the
  payload before the top-level value overrides it, so W-4 web submits were
  failing with `invalid_payload`.

## [1.21.0] - 2026-09-21

### Added

- **Per-state income-tax withholding, phase 1 (PAY-13)**: effective-dated
  state withholding computed from the employee's work state, beside the
  legacy flat-rate path (bit-identical for runs without a work-state row).
  New tables `state_tax_configs` / `state_tax_brackets` (jurisdiction
  `<state>` or `<state>:<filing_status>` with fallback, mirroring
  `federal:<status>`; `kind='none'` is the explicit zero-tax row so an
  unconfigured work state fails run generation loudly with
  `no_state_tax_config`), `employee_work_states` (effective-dated work
  location), and `state_withholding_elections` (generic IL-W-4 / DE 4 union:
  regular + estimated-deduction allowances, per-period extra withholding,
  state-only exempt). The engine's new `computeStateWithholding` implements
  the annualized EDD Method B / IL-700-T formula method (wage-base allowance
  deductions, bracket walk, per-allowance credits, low-income exemption, CA
  alt values at 2+ allowances); ENGINE_VERSION 0.3.0, snapshot template 1.2.0
  freezes `inputs.state`. Seeded: IL 2025/2026 (IDOR IL-700-T, 4.95%,
  $2,850/$2,925 allowances), CA 2026 (EDD 26methb.pdf Method B with per-status
  Tables 5/6/7 brackets, SD $5,706/$11,412, LLX $18,896/$37,791, credit
  $168.30, AWAID $1,000), TX 2025/2026 (explicit none) — validated against
  EDD worked Examples E/F and IDOR's IL-700-T example. Admin routes manage
  state config (+ atomic bracket replace), work-state assignment (closing the
  previous window), and elections, all with audit_events; the config page
  gains a "State taxes" tab and the employee detail page a "State tax" tab
  (work-state history + elections). Employee-initiated state change requests
  and further states are phase 2.

## [1.20.0] - 2026-09-20

### Added

- **Admin calendar (PAY-40)**: a month-grid view at /admin/calendar
  aggregating every company date obligation into read-only, colour-coded
  events that link to the matching detail view. The admin-only
  `GET /api/admin/calendar?year=&month=` endpoint aggregates, date-sorted:
  projected paydays from the current pay schedules (company default +
  per-employee overrides), actual payroll-run pay dates (void excluded),
  contractor recurring-invoice generation days (`last_day` / fixed) and the
  following-month payment-due days (template `starts_on`/`ends_on` window
  mirrored from the daily sweep), tax deposit due + deposited dates
  (linking to the PAY-36 deposit detail), filing deadlines + filed dates
  (941 quarterly / 940 / W-2/W-3), and W-8BEN/W-8BEN-E form expiries. All
  date handling is date-only — no timezone math. The grid is Sunday-first
  with adjacent-month days muted, today highlighted, prev/next/today
  navigation via the bookmarkable `?year=&month=` route query, and a colour
  legend; Calendar joins the admin nav.

## [1.19.0] - 2026-09-19

### Added

- **Tax deposit detail view (PAY-36)**: each row on the Tax deposits page
  now opens a detail view at `/admin/deposits/:id` — an EFTPS reference
  card with the exact values to enter on eftps.gov (tax period, amount,
  due date, jurisdiction; deposited rows also show the deposited date and
  EFTPS confirmation number), a per-category breakdown table whose total
  equals the deposit amount, the contributing issued payroll runs (row
  click opens the run), and a read-only list of confirmation attachments.
  Backed by a new `GET /api/admin/tax-deposits/:id` endpoint.
- **Contractors list: search, filters, sorting (PAY-29)**: the
  Contractors page gains a toolbar with search, status/type filters, and
  column sorting; contractors no longer appear on the Employees page.

### Fixed

- **Admin dashboard redirect (PAY-31)**: admins visiting `/my/dashboard`
  are now redirected to `/admin/dashboard`.
- **Navigation dead after idle (PAY-30)**: navigation now recovers from
  stale JS chunks after the app idles through a deploy — a chunk-load
  failure triggers a hard reload, and hashed `/assets/*` files are served
  with immutable caching so old tabs never poison the cache.

## [1.18.0] - 2026-09-18

### Added

- **Filled official Form 940 PDF (PAY-33)**: the 940 filing detail now
  offers a "Filled 940 PDF" download — the official IRS AcroForm (bundled
  2025 revision, SHA-256-pinned) filled from the filing's frozen annual
  FUTA worksheet: entity area (EIN, name, address), the Part 1 state
  questions, Part 2 lines 3–8, the Part 3 credit-adjustment branch
  (zero credit → line 9 = line 7 × 0.054; full 0.054 credit → Part 3
  blank; partial credit → line 10 carries the delta to the worksheet's
  line 12), Part 4 totals with line 13 derived from the balance due, and
  the Form 940-V payment voucher filled when line 14 shows a balance due.
  Form line 8 is always line 7 × 0.006 per the form's own definition; the
  SUTA-credit delta lands in Part 3 instead of being folded into line 8.
  Part 5 stays blank (only required when line 12 exceeds $500 and the
  worksheet carries no per-quarter liability). Rendered on demand and
  flattened (never stored); metadata is pinned to the template revision
  so identical worksheets render byte-identical PDFs. The form ships
  unsigned — signature/date stay blank for wet signature (or e-sign
  after download) before the Letterstream mail upload, same as the 941.

## [1.17.0] - 2026-09-12

### Added

- **Filled official Form 941 PDF (PAY-16)**: the 941 filing detail now
  offers a "Filled 941 PDF" download — the official IRS AcroForm (bundled
  Rev. March 2025 + Rev. March 2026 templates, SHA-256-pinned) filled from
  the filing's frozen quarterly worksheet: entity area (EIN split across
  the two boxes, name, address), Part 1 lines 1–15 in the IRS split
  dollars/cents boxes, the report-for-quarter checkbox on both pages, the
  line-16 deposit-schedule branch (de minimis vs monthly), and the Form
  941-V payment voucher filled when line 14 shows a balance due. Rendered
  on demand and flattened (never stored); metadata is pinned to the
  template revision so identical worksheets render byte-identical PDFs.
  The form ships unsigned — signature/date stay blank for wet signature
  (or e-sign after download) before the Letterstream mail upload.

## [1.16.0] - 2026-09-12

### Added

- **Recompute worksheet for filed filings (PAY-25)**: a filed filing whose
  frozen worksheet never matched the actual filing (precedent: the 2025
  Form 940 corrected out-of-band on 2026-09-03) now has a supported admin
  correction path. The filing detail page offers "Recompute worksheet" with
  a line-by-line current-vs-recomputed diff preview and a mandatory
  free-text reason; committing rewrites the worksheet + canonical hash from
  frozen issued-run entries and current config, writes a
  `tax_filing.correct_worksheet` audit event (before/after hashes + reason
  + actor) in the same transaction, and leaves filing metadata (status,
  filed date, method, reference) untouched. Past corrections are listed on
  the detail page.

## [1.15.1] - 2026-09-12

### Fixed

- **Mobile login view**: the login card had no horizontal padding, so at
  phone widths (≤380px) every control rendered glued to the screen edges.
  Added the same 1rem gutter the invite/reset auth views already used, plus
  a Playwright regression spec pinning the 375px layout (no horizontal
  overflow, controls inside the gutter).

## [1.15.0] - 2026-09-12

### Added

- **EFTPS confirmation attachments on tax deposits** (PAY-27): attach the
  eftps.gov acknowledgment PDF / receipt to a deposit row — the documentary
  evidence behind the row's EFTPS confirmation number. Same doctrine as
  PAY-24 filing attachments: new `deposit_attachments` table (migration
  0018, cascade with the deposit), bytes stored AES-256-GCM encrypted at
  rest (confirmations can carry the EIN), raw-body `application/pdf` upload
  with 5 MB cap and `%PDF` magic check, filename sanitization, admin-only
  read + write, upload and download audit-logged
  (`tax_deposit.attach` / `tax_deposit.download_attachment`). The Tax
  Deposits page gains an Attachments dialog per row (list + upload + view).

## [1.14.0] - 2026-09-12

### Added

- **FUTA annual-cap write guard** (PAY-26): per-employee annual
  `employer_futa` can never exceed `futa_wage_cap × futa_rate` for the run's
  tax year (e.g. $7,000 × 0.06 = $420.00). Two layers: `generateDraft`
  rejects an over-cap draft with `futa_cap_exceeded` (reported in the
  generate route's `skipped` list; the transaction rolls back, nothing is
  written), and migration 0017 adds a `BEFORE INSERT` trigger on
  `payroll_entries` enforcing the same invariant against issued-run YTD for
  direct writes — defense in depth behind immutable issued runs. Both layers
  allow a half-cent-per-period rounding tolerance (the per-paycheck cent
  rounding the 940 worksheet already reconciles as `roundingDelta`). Origin:
  the PAY-18/22 rate misconfiguration silently wrote $21.00 instead of
  $210.00 entries on four issued runs; this guard catches that class of
  error at write time.

## [1.13.0] - 2026-09-04

### Added

- **Filing attachments** (PAY-24): upload the filing authority's
  confirmation/evidence PDF (SSA BSO receipt, IRS e-file acknowledgment,
  Letterstream proof) to a tax filing — optionally right in the
  mark-as-filed dialog, or anytime from the filing detail's new Attachments
  card — and view/download it afterwards. Files are stored in the new
  `filing_attachments` table (migration 0016) with AES-256-GCM encrypted
  bytes (confirmations can carry the EIN); upload and download are
  audit-logged; admin-only. Multiple files per filing are supported.

## [1.12.1] - 2026-09-03

### Fixed

- **W-2/W-3 filing detail polish** (PAY-23): the Employee W-2s table uses
  full column titles ("Wages, tips, other compensation", "Federal income tax
  withheld", "Social Security tax", "Medicare tax") with nowrap headers — the
  card scrolls horizontally instead of abbreviating or double-wrapping. The
  Delivery column now carries only the status tag (electronic/paper); the
  per-employee actions moved to a dedicated Documents column, and "Copy D"
  reads as the action it is ("Download Copy D"). "Download W-3 PDF" moved
  from the Employee W-2s header row into the W-3 transmittal totals section
  header. UI-only; covered by a live-QA e2e spec.

## [1.12.0] - 2026-09-03

### Added

- **Field-level encryption for employee address data** (PAY-21): the
  residential and mailing addresses added in PAY-20 (migration 0014) —
  `employees.address` / `mailing_address`, the effective-dated history in
  `change_requests.payload`, and the pre-change snapshots in `audit_events`
  before/after — are now AES-256-GCM ciphertext at rest (`enc:v1:`),
  following the tax_id/bank_details pattern. Decryption stays server-side
  only at the existing read points (W-2/W-3 rendering, admin directory,
  employee profile, change-request views); API shapes are unchanged and
  reads tolerate legacy plaintext rows. Includes a one-off, idempotent,
  transactional data migration for existing rows — run
  `pnpm --filter @payroll/server encrypt-addresses` once after deploy.

## [1.11.1] - 2026-09-01

### Fixed

- Create the **in-progress-year 940 filing row** with a live worksheet
  (PAY-22): `syncAnnualFilings` skipped every year whose Dec 31 hadn't
  passed, so no 940 row existed until January — losing the FUTA
  deposit-liability monitor in-year. The current-year 940 is now created as
  `not_started` with a live worksheet (issued runs YTD at the year's
  configured `suta_credit_rate`), promotes to `ready` on Jan 1 of the
  following year (the W-2 availability gate), and its deposit-rule section
  reflects the running YTD liability. The w2_w3 row intentionally stays
  year-close-only (W-2s are never furnished before year-end); reminder
  cadence is unchanged and cannot fire before the January window.

## [1.11.0] - 2026-09-01

### Added

- Configurable per-year **FUTA SUTA credit rate** for the 940 worksheet
  (PAY-18): `tax_config.suta_credit_rate` (NUMERIC(6,5), default 0.054 = the
  full credit → 0.6% net) drives the Form 940 worksheet, so employers that
  paid no SUTA can set 0 and accrue the full statutory 6.0% ($420/employee on
  the $7,000 cap). Admins edit it under Configuration → Tax tables (audited
  `PUT /api/admin/tax-config`); the net rate is mirrored into `futa_rate` so
  payroll-run accrual, snapshots, and W-2s keep the existing code path, and
  the 940 filing detail now shows the rate assumption (6.0% − credit = net).
  Existing rows backfill to 0.054 — identical to current behavior.

## [1.10.0] - 2026-09-01

### Added

- Effective-dated employee **mailing address** on W-2 box f (PAY-20):
  employees gain an optional mailing address (`employees.mailing_address`),
  and W-2 box f now renders the address effective as of **Dec 31 of the tax
  year** — the mailing address first, falling back to the residential address
  effective at the same date. History resolves through approved
  change_requests (latest change with `effective_from <= as-of`, with the
  pre-first-change value recovered from the approve audit event).
- The mailing address joins the **change-request flow** (new
  `mailing_address` request type, one-pending-per-employee enforced) and
  **admin direct edit** (`PATCH /api/admin/employees/:id` with an optional
  effective-from date, recorded as an already-approved change request so both
  flows share one effective-dated history). Employee profile + request wizard
  and the admin employee detail screen expose the new field. Payslips are
  unchanged; exports stay PII-free.

### Fixed

- Change-request approvals with an effective-date **override** now persist
  the applied date onto the request row (the originally requested date is
  preserved in the audit event), so effective-dated resolution sees the date
  the change actually took effect.

## [1.9.0] - 2026-08-31

### Added

- Official IRS-form W-2/W-3 PDFs (PAY-19): the PAY-11 lookalike documents
  are replaced by the **official IRS AcroForm templates** (2025 revisions,
  bundled under `packages/documents/assets/forms/2025/` and SHA-256-pinned
  in a year registry), filled via a rect-verified field map and **flattened
  on render** so downloads are finished documents. The employee packet is
  one PDF — Copies B/C/2 plus the IRS Notice/Instructions pages (Pub 1141
  §3.1.05); the admin gets Copy D per employee for records, a print-ready
  employee packet, and the filled official W-3. Box d carries the employee
  ID; SSA filing stays manual via BSO (Copy A/1 are never emitted).
- Electronic-delivery consent flow (PAY-19, Pub 1141 §2.4): employees must
  affirmatively consent before their W-2 PDF is served — the consent
  endpoint furnishes the required disclosures (paper-copy right, withdrawal
  and consequences, PDF-reader requirement, Jan 31 → Oct 15 posting
  window), withdrawal re-gates the download immediately, and both actions
  are audited. The admin W-2 list shows per-employee delivery status and a
  consent-independent **print packet** route for paper furnishing.

## [1.8.0] - 2026-08-30

### Added

- Annual forms package (PAY-11): when a calendar year with issued payroll
  runs ends, the app computes a deterministic **Form 940 (FUTA) worksheet**
  from frozen issued-run entries — lines 3/7/8/12 with the per-employee
  $7,000 FUTA wage cap from the year's tax config, the frozen-entry
  accrued-liability truth reconciled to the cent via a documented rounding
  delta (941 line-7 doctrine), and the $500 quarterly deposit rule with the
  crossing quarter and due date. **W-2/W-3 generation**: per-employee W-2
  box figures (contractors excluded) and the W-3 transmittal aggregate, with
  on-demand PDFs rendered server-side — SSN/address/EIN decrypted at render
  time only, never persisted or exposed over JSON. W-2s become available to
  employees in **January of the following year** via self-service download on
  the payslips page, announced by a once-per-year `w2_available` email (year
  + log-in only, no amounts). Annual filings reuse the PAY-10 tax_filings
  infrastructure (no migration): refresh-unfiled-on-read, freeze-when-filed,
  due-date reminder emails, and mark-as-filed with per-form e-file help
  (IRS-authorized e-file for 940, SSA Business Services Online for W-2/W-3).

[1.8.0]: https://github.com/soult-io/payroll-app/releases/tag/v1.8.0

## [1.7.0] - 2026-08-30

### Added

- Back navigation preserving list filter state (PAY-17): every detail page
  (filing, payroll run review, employee, contractor, request review/thread,
  payslip) now has a back arrow button in the header. List filters are
  encoded in the route query (`?year=`, `?status=`, `?form=`, `?tab=`) via a
  new `useQueryFilters` composable, so filtered lists are bookmarkable and
  browser-back restores them; lists pass their query onto detail URLs and
  the back button returns to the list with the same filters applied. Covers
  the admin filings / deposits / payroll runs / employees / contractors
  (incl. year-end tab) / requests lists and the employee payslips (year
  selector), invoices, and requests lists. The admin requests "All" filter
  is an explicit `?status=all` sentinel so it doesn't collide with the
  "pending" default.

[1.7.0]: https://github.com/soult-io/payroll-app/releases/tag/v1.7.0

## [1.6.0] - 2026-08-29

### Added

- Quarterly Form 941 package (PAY-10): when a quarter with issued payroll
  runs ends, the app computes a deterministic line-by-line 941 worksheet
  from frozen issued-run entry snapshots (SHA-256 hashed; lines 1–16 incl.
  line 13 deposit reconciliation and the line 16 monthly liability
  breakdown with de minimis evaluation) and tracks the filing through
  ready → filed on a new admin "Tax filings" page. Mark-as-filed records
  date + method + reference (e.g. the Letterstream Job ID) with a "How to
  file" help dialog; filed worksheets freeze forever. Line 7 fractions of
  cents defaults to the computed rounding delta and is admin-editable while
  unfiled. First-class adjustment/notice records per filing (CP220-style
  notices, abatements, payments) feed line 13. Due-date reminder emails
  (`tax_filing_due`) on an admin-configurable offset schedule (default
  14/7/0 days). Record-only: filing still happens by mail or e-file.

[1.6.0]: https://github.com/soult-io/payroll-app/releases/tag/v1.6.0

## [1.5.0] - 2026-08-28

### Added

- Tax deposits year paging + status filter (PAY-15): the admin Tax
  Deposits page now pages by year (options derived from the data, current
  year included even with no rows) and filters by status
  (pending/deposited/overdue), matching the payroll-runs list. The list
  endpoint accepts optional `year` and `status` query params.

[1.5.0]: https://github.com/soult-io/payroll-app/releases/tag/v1.5.0

## [1.4.0] - 2026-08-26

### Added

- Current-month tax deposit rows (PAY-14): the Tax Deposits page now shows
  the current month's deposit as soon as a payroll run issues in it,
  instead of waiting for the month to close. Due dates, overdue marking,
  and reminder emails stay relative to the 15th of the following month, so
  a current-month row is never overdue and never reminds, and a deposit
  recorded early (e.g. paid the day payroll runs) is never rewritten by
  later recomputation.

[1.4.0]: https://github.com/soult-io/payroll-app/releases/tag/v1.4.0

## [1.3.0] - 2026-08-25

### Added

- Monthly federal tax deposits (PAY-9): the app now computes each month's
  941 deposit (employee federal withholding + both sides of Social Security
  and Medicare, from issued-run snapshots — deterministic to the cent),
  schedules it for the 15th of the following month with weekend roll, and
  tracks it through pending → deposited/overdue on a new admin "Tax
  deposits" page with a mark-as-deposited action (date + EFTPS confirmation
  number). A daily scheduler tick syncs the computed schedule and emails
  due-date reminders on an admin-configurable offset schedule (default: 5
  days before + on the due date) via the new admin-only `tax_deposit_due`
  notification event. The schema is jurisdiction-ready for state deposits
  (PAY-13). Record-only: payments still happen on eftps.gov.

[1.3.0]: https://github.com/soult-io/payroll-app/releases/tag/v1.3.0

## [1.2.0] - 2026-08-21

### Added

- Session-expiry redirect (PAY-6): an expired or revoked session now
  redirects straight to the login page (preserving the attempted path for
  post-login return) instead of surfacing error toasts from in-flight API
  calls. Both API clients report unexpected 401s through a single
  session-expired hook; onboarding and pre-auth flows are unaffected.

[1.2.0]: https://github.com/soult-io/payroll-app/releases/tag/v1.2.0

## [1.1.0] - 2026-08-21

### Added

- Role- and worker-type-scoped UI (PAY-8): the nav shows Payslips only to
  W-2 employees and Invoices only to contractors, with matching route guards
  (a wrong-type direct URL redirects to the dashboard). Notification settings
  are scoped by a new per-event audience declaration (`EVENT_AUDIENCE`):
  non-admins no longer see or set admin-only events, and worker-type events
  only surface for the matching type. `PUT /api/my/notification-settings`
  rejects out-of-audience events with `not_applicable`.

### Fixed

- Live-QA e2e: `loginAs` waits out the credential rate-limit window (429
  rendered as "Invalid email or password") and retries, fixing the flaky
  `#totp` login failures in the nightly suite.

[1.1.0]: https://github.com/soult-io/payroll-app/releases/tag/v1.1.0

## [1.0.3] - 2026-08-21

### Fixed

- Reverted primevue 5.0 → 4.5.x and @primeuix/themes 3.0 → 2.0.x: PrimeVue 5
  left MIT for the commercial PrimeUI license and bundles
  `@primeui/license-manager`, which showed an "invalid PrimeUI license"
  notice to end users. dependabot now ignores primevue and `@primeuix/*`
  semver-major updates so this cannot regress.

[1.0.3]: https://github.com/soult-io/payroll-app/releases/tag/v1.0.3

## [1.0.2] - 2026-08-21

### Added

- Contractor self-service **My Invoices** (PAY-7): contractors see their own
  invoices like W-2 employees see payslips — a year-grouped `/my/invoices`
  page (approved + paid invoices only, per D1), with status chips, per-year
  paid/pending totals, and an on-demand invoice PDF per row (never stored).
  New endpoints: `GET /api/my/invoices` (with the 1:1 payment join) and
  `GET /api/my/invoices/:id/pdf` (404 on foreign or hidden invoices).
- The contractor-facing invoice lifecycle emails (invoice reviewed / invoice
  paid) are now user-toggleable in notification settings (D3).
- QA seed: the Dave Placeholder contractor persona has a portal login for
  self-service e2e (documented in docs/qa.md).

### Fixed

- `create-contractor-template` CLI accepts the documented kebab-case flags
  (`--pay-day`, `--starts-on`, …) in addition to camelCase.

[1.0.2]: https://github.com/soult-io/payroll-app/releases/tag/v1.0.2

## [1.0.1] - 2026-08-20

Maintenance release: dependency updates across the board. No functional
changes.

### Changed

- Production dependencies: primevue 4.5 → 5.0 (with strictly typed form
  fields for the new InputNumber API), @primeuix/themes 3.0, pinia 4.0,
  vue-router 5.2, pino 10, drizzle-orm 0.45, fastify 5.12, better-auth
  1.6.29, zod 4.4.3, pg 8.23, nodemailer 9.0.5, pg-boss 12.27, and others.
- Dev dependencies: vite 8.2, vitest 4.1, @playwright/test 1.62.1,
  @types/node 26 (with explicit `types: ["node"]` in the affected packages),
  tsx 4.23, vue-tsc 3.3.
- GitHub Actions: pnpm/action-setup 6, upload-artifact 7,
  build-push-action 7, login-action 4, github-script 9.
- TypeScript intentionally held at 5.9.x (5.9.3); dependabot is configured
  to ignore TypeScript semver-major bumps until the toolchain is ready.

[1.0.1]: https://github.com/soult-io/payroll-app/releases/tag/v1.0.1

## [1.0.0] - 2026-08-19

First public release.

### Payroll core

- Monthly payroll lifecycle: scheduled draft generation (configurable pay
  schedule, default monthly on the 15th), admin approval, issue and void.
- Deterministic calculation engine (`@payroll/engine`): federal withholding
  from yearly bracket tables, Social Security, Medicare, employer-side taxes;
  every issued run carries an immutable, hash-verified input snapshot.
- Payslips: generated on demand as PDF (the database is the source of truth —
  no stored files), grouped per year, with per-category YTD totals (gross,
  federal withholding, Social Security, Medicare, net).
- Effective-dated compensation and W-4 elections, including exempt status.

### Contractors (1099 / non-US)

- Domestic 1099-NEC contractors and nonresident contractors (W-8BEN on file,
  expiry tracking, no US-source withholding), with entity types.
- Contractor payments: record, void, per-year totals against the reporting
  threshold; 1042 review flag for edge cases.
- Recurring contractor payment scheduler — the contractor analogue of the
  W-2 payroll scheduler (draft → approve → record).

### Self-service & admin

- Auth with invite-only registration, TOTP second factor, role-based access
  (admin / employee).
- Employee self-service: payslip history + PDF download, profile view, change
  requests (address, legal name, bank details, W-4 elections, TIN) with
  effective dating and threaded admin review (approve / deny).
- Admin configuration: employees, compensation, W-4 elections, tax brackets
  per year, pay schedule, company details (incl. EIN, encrypted at rest),
  users and invites, audit views.
- Notification outbox with per-event SMTP email settings (new payslip,
  change-request events, payroll lifecycle events).

### Integrations & operations

- Read-only export API (`/api/export/…`) for issued payroll runs and
  contractor payments, gated by a scoped service token — built for unattended
  downstream consumers (tax deposit and filing workflows); exports contain no
  surplus PII.
- One-time legacy migration CLI: imports payroll history from a legacy
  accounting schema with snapshot reconstruction validated to the cent before
  any write; dry-run by default, idempotent `--write`.
- Single self-contained container image (`ghcr.io/soult-io/payroll-app`);
  secrets read as files from `SECRETS_DIR`; Postgres 16 via Drizzle
  migrations; reference deployment in `compose.example.yml`.

### Quality gates

- CI: lint/format (Biome), build, typecheck, engine unit tests (regression
  oracle) and server integration tests (PGlite), end-to-end Playwright suite
  gating every image push; Trivy CRITICAL gate on the published image;
  CodeQL.
- Nightly e2e against a live QA deployment (self-hosted runner inside the QA
  network), with failures filed as deduplicated GitHub issues.

[1.0.0]: https://github.com/soult-io/payroll-app/releases/tag/v1.0.0
