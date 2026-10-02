# Wagon Payroll Export API (read-only)

Read-only export of **issued** payroll figures for downstream compliance
work — 941 federal deposits, the quarterly/annual tax package
(941/940/W-2/W-3), compliance tracking. Activated 2026-07-30 per the
Accountant agent's request (D10 export capability, read-only form).

- **Read-only.** Never mutates payroll data. The app remains the sole writer
  (D4); this endpoint only SELECTs (plus one `audit_events` row per call).
- **Deterministic.** Figures come from the stored `payroll_entries` of
  issued runs — the validated, frozen truth. Identical request → identical
  bytes. No timestamps in the payload.
- **No surplus PII.** The payload carries the company header required for
  filings (`legal_name`, `ein`) and per-run figures. Employee SSN
  (`tax_id`), bank details, and addresses are never included.
- **Audited.** Every successful call writes an `audit_events` row
  (`actor_id=service:export`, `action=export.payroll_runs`, range, format,
  run count).

## Auth

Scoped service credential, unattended-callable (no interactive TOTP):

```
Authorization: Bearer <token>
```

The token lives at `$SECRETS_DIR/export-token` on the app container
(`/run/secrets` pattern, same as `db-password`). If the file is absent the
endpoint is **disabled** and returns `503 export_disabled` — deploying the
credential is an explicit decision. Wrong/missing token → `401`.

Generate and deploy (on the home server) — ownership matters: compose bind-mounts
preserve host ownership and the app runs as uid/gid **10001**, so the file
must be `0600 10001:10001` like the other secrets:

```
sudo sh -c 'openssl rand -hex 32 > /srv/payroll/secrets/export-token'
sudo chown --reference=/srv/payroll/secrets/db-password /srv/payroll/secrets/export-token
sudo chmod --reference=/srv/payroll/secrets/db-password /srv/payroll/secrets/export-token
# stack redeploy picks it up (declared in the prod compose `secrets:` block —
# prod/docker-compose.yml in nsoult-agentic/stack-payroll)
```

Note: compose requires the file to exist at deploy time once the secret is
declared — to deploy WITHOUT the export API, comment out the `export-token`
entries in the deployment's compose file (top-level `secrets:` + the `app`
service list); the endpoint answers `503 export_disabled` when unconfigured.
(Same rule in `compose.example.yml` for self-hosters.)

## Endpoint

```
GET /api/export/payroll-runs?from=YYYY-MM-DD&to=YYYY-MM-DD&format=json|csv
```

| Param    | Default  | Notes                                                        |
| -------- | -------- | ------------------------------------------------------------ |
| `from`   | (none)   | Inclusive lower bound on **pay_date**                        |
| `to`     | (none)   | Inclusive upper bound on **pay_date**                        |
| `status` | `issued` | Only `issued` is accepted — draft/void are not authoritative |
| `format` | `json`   | `json` or `csv`                                              |

The range keys on **pay_date**, not period dates: deposits and filings are
keyed on when wages were *paid*.

### JSON response

```json
{
  "company": { "legalName": "Example Corp", "ein": "12-3456789" },
  "status": "issued",
  "range": { "from": "2026-01-01", "to": "2026-03-31" },
  "stateWithholding": {
    "byJurisdiction": [
      { "jurisdiction": "CA", "runCount": 2, "stateWithholding": "184.82" },
      { "jurisdiction": "IL", "runCount": 3, "stateWithholding": "490.05" }
    ]
  },
  "runs": [
    {
      "employeeId": 1,
      "periodStart": "2026-01-01",
      "periodEnd": "2026-01-31",
      "payDate": "2026-01-15",
      "status": "issued",
      "snapshotHash": "<sha256 of the frozen run snapshot>",
      "stateJurisdiction": "IL",
      "entries": {
        "gross_pay": "4200.00",
        "federal_withholding": "400.00",
        "social_security": "260.40",
        "medicare": "60.90",
        "state_withholding": "163.35",
        "net_pay": "3315.35",
        "employer_social_security": "260.40",
        "employer_medicare": "60.90",
        "employer_futa": "25.20"
      }
    }
  ]
}
```

- All amounts are **strings to the cent** — parse as decimal, never float.
- `ein` is decrypted at read; `null` until configured in admin settings.
- A missing entry category is `null`, never silently `"0.00"` — treat any
  `null` as data corruption and alert.
- `stateJurisdiction` (PAY-13) is the work state that produced
  `state_withholding`, read from the frozen run snapshot (template ≥1.2.0).
  It is `null` for pre-1.2.0 snapshots and legacy flat-rate runs — a nonzero
  `state_withholding` with a `null` jurisdiction means "legacy run,
  jurisdiction not recorded".
- `stateWithholding.byJurisdiction` (PAY-13) totals `state_withholding` per
  jurisdiction (integer-cent sums, sorted by jurisdiction code) — the input
  for state quarterly filings. Only runs with a recorded jurisdiction
  contribute.

### CSV response (`format=csv`)

One header row + one row per issued run, columns:

```
employee_id,period_start,period_end,pay_date,status,snapshot_hash,gross_pay,federal_withholding,social_security,medicare,state_withholding,net_pay,employer_social_security,employer_medicare,employer_futa,state_jurisdiction
```

`state_jurisdiction` is appended as the LAST column so consumers of the
original 15-column layout are unaffected. Empty for legacy runs (see
`stateJurisdiction` above). The company header is JSON-only; CSV consumers
key on one known company.

## Contractor payments (Spec 10, D18)

```
GET /api/export/contractor-payments?year=YYYY
```

Per-contractor payments export for the January 1099/945 package. Same auth,
same read-only + audited doctrine (`action=export.contractor_payments`), same
no-surplus-PII rule: **no TIN, no bank details, no personal address** — the
only address-like data is the company header (`legalName`, decrypted `ein`).

| Param  | Default    | Notes                              |
| ------ | ---------- | ---------------------------------- |
| `year` | (required) | Tax year `YYYY`; keyed on pay_date |

### JSON response

```json
{
  "company": { "legalName": "Example Corp", "ein": "12-3456789" },
  "year": 2026,
  "threshold": "2000.00",
  "contractors": [
    {
      "employeeId": 7,
      "legalName": "Casey Contractor",
      "taxStatus": "us_person",
      "entityType": "individual",
      "form": { "taxForm": "w9", "collected": true, "formExpiresAt": null, "expired": false },
      "review1042": false,
      "payments": [
        { "payDate": "2026-03-15", "amount": "2500.00", "method": "ach", "backupWithheld": "600.00", "reference": "ach-123" }
      ],
      "reportableTotal": "2500.00",
      "grossTotal": "3400.00",
      "backupWithheldTotal": "816.00",
      "threshold": "2000.00",
      "formRequired": true
    }
  ]
}
```

- `threshold` is the dated federal 1099-NEC threshold for the year (from
  `contractor_reporting_config`: $600 through 2025, $2,000 for 2026,
  inflation-indexed from 2027; admin-editable per year). Missing config →
  `409 no_threshold_config`.
- `reportableTotal` EXCLUDES payments by `card` / `third_party_network` — the
  processor reports those on Form 1099-K (the carve-out prevents
  double-reporting). `grossTotal` is everything.
- `formRequired` = US person **and** `reportableTotal ≥ threshold` **and** no
  1042-S review flag. Below-threshold contractors are included with
  `formRequired: false` — the threshold decision is visible, never silent.
- `review1042` = `us_days_log` non-empty or `services_location` us/mixed → the
  contractor needs a **1042-S review** instead of a 1099-NEC (detection only;
  1042-S generation is out of scope, Spec 10 §7).
- `backupWithheldTotal` feeds the Form 945 reminder (24% backup withholding is
  reported on 1099-NEC box 4 and remitted via Form 945).
- Payments on void invoices are excluded from totals.
- All amounts are **strings to the cent** — parse as decimal, never float.

### Errors

| Code | Meaning                                             |
| ---- | --------------------------------------------------- |
| 400  | `invalid_year` (year required as `YYYY`)            |
| 401  | missing or wrong bearer token                       |
| 409  | `no_threshold_config` (run seeds / enter the year)  |
| 503  | export disabled (no `export-token` in SECRETS_DIR)  |

## Tax deposits (PAY-197)

```
GET /api/export/tax-deposits?from=YYYY-MM-DD&to=YYYY-MM-DD&jurisdiction=federal&includeSuperseded=false
```

The payroll tax deposits recorded in the app: what is due, when, and, once
the owner marks a deposit made, the deposit date and the EFTPS
acknowledgment number. Same auth, read-only and audited
(`action=export.tax_deposits`). No company EIN, no employee data.

| Param               | Default | Notes                                                      |
| ------------------- | ------- | ---------------------------------------------------------- |
| `from`              | (none)  | Inclusive lower bound on **period_start**                  |
| `to`                | (none)  | Inclusive upper bound on **period_start**                  |
| `jurisdiction`      | (all)   | `federal` or a 2-letter state code (`CA`)                  |
| `includeSuperseded` | `false` | `true` adds rows replaced by a state period transition     |

### JSON response

```json
{
  "range": { "from": "2026-08-01", "to": "2026-09-30" },
  "deposits": [
    {
      "jurisdiction": "federal",
      "form": "941",
      "periodKind": "month",
      "periodStart": "2026-08-01",
      "periodEnd": "2026-08-31",
      "amountCents": 123456,
      "dueDate": "2026-09-15",
      "status": "deposited",
      "depositedOn": "2026-08-20",
      "confirmation": "012345678901234",
      "supersededAt": null
    }
  ]
}
```

- `amountCents` is an **integer number of cents**, converted from the stored
  `NUMERIC(12,2)` by string arithmetic.
- `form` is `"941"` for federal rows and `null` for state rows. FUTA (Form
  940) deposits are not tracked in the app and never appear here.
- `confirmation` is the EFTPS EFT acknowledgment number (15 digits) as
  entered for federal rows, or the state portal reference for state rows, a
  string kept verbatim. Do not
  parse it as a number: leading zeros matter. `null` until recorded.
- `periodEnd` is the last day of the month, or of the quarter for
  `periodKind = "quarter"` (state quarterly depositors).
- For federal rows the period is the calendar month of the **pay dates**
  (IRS Pub 15 monthly schedule: payments made during the month), not the
  period worked. In EFTPS the deposit is a Form 941 payment for the quarter
  that contains `periodStart`.
- Federal rows assume a monthly-schedule Form 941 filer. The semiweekly
  schedule, the $100,000 next-day rule and Form 944 are not modelled.
- `dueDate` is the app's due date: the 15th of the month after `periodEnd`
  for federal rows (the state's schedule for state rows), moved to Monday
  when it falls on a weekend. Legal holidays are not applied. The IRS moves
  a due date that falls on a District of Columbia legal holiday to the next
  business day (Pub 15), so the app's date can be one business day earlier
  than the IRS date, never later. `status = "overdue"` follows the app's
  date.
- `status`: `pending`, `deposited`, `overdue`, or `superseded`. `supersededAt`
  is an ISO timestamp on superseded rows, else `null`.
- `range` echoes the request; an omitted bound is `null`. An empty value
  (`?from=`) or a date that does not exist (`2026-02-30`) is rejected with
  `400 invalid_date`; leave the parameter out instead.
- Order: `periodStart`, `jurisdiction`, `periodKind`, then insertion order
  (byte order, independent of the database locale).

## Tax filings (PAY-197)

```
GET /api/export/tax-filings?year=YYYY&form=941|940|w2_w3
```

The filings the company must make for a year, with the frozen worksheet
figures and any IRS notice adjustments. Same auth, read-only and audited
(`action=export.tax_filings`).

| Param  | Default    | Notes                       |
| ------ | ---------- | --------------------------- |
| `year` | (required) | Tax year `YYYY`             |
| `form` | (all)      | `941`, `940`, or `w2_w3`    |

### JSON response

```json
{
  "year": 2026,
  "filings": [
    {
      "form": "941",
      "year": 2026,
      "quarter": 3,
      "dueDate": "2026-11-02",
      "status": "ready",
      "filedOn": null,
      "filingMethod": null,
      "filingReference": null,
      "worksheetHash": "<sha256 of the worksheet>",
      "worksheet": { "form": "941", "year": 2026, "quarter": 3, "line2Wages": "12000.00" },
      "adjustments": [
        {
          "kind": "CP220",
          "noticeDate": "2026-09-10",
          "amountDueCents": 2500,
          "abatedAmountCents": 0,
          "amountPaidCents": 2500,
          "paidOn": "2026-09-20",
          "confirmation": "001112223334445"
        }
      ]
    }
  ]
}
```

- One entry per stored filing row. The 941 row for a quarter is created on
  the first daily run after the quarter ends, so a quarter in progress is
  absent.
- `quarter` is 1 to 4 for Form 941 and `null` for the annual forms (940,
  W-2/W-3).
- `status`: `not_started`, `ready` (worksheet computed), or `filed`.
- `worksheet` is the frozen line-by-line worksheet with its values
  unchanged: amounts are **decimal strings to the cent**. Key order is the
  database's, not the order the app wrote; `worksheetHash` is the SHA-256 of
  the worksheet JSON with keys sorted at every level, so sort keys the same
  way before checking it. Some fields are rates (`futaRate`, `sutaCreditRate`), not money. All
  worksheets are company-level totals. `null` until first computed.
- `adjustments` amounts are integer cents. The free-text note on an
  adjustment is never exported.
- `dueDate` is the app's due date: a weekend rolls to Monday; legal
  holidays (District of Columbia, per Pub 15) are not applied, so the app's
  date can be earlier than the IRS date, never later. The 940 due date is
  always January 31 (rolled); the app does not apply the February 10
  extension the Form 940 instructions allow when all FUTA tax was deposited
  on time.
- The 940 worksheet's `balanceDue` assumes no FUTA deposits were made (the
  app does not track them). If FUTA was deposited through EFTPS, reconcile
  `balanceDue` against those deposits. `sutaCreditRate` and `futaRate` may
  be absent on 940 worksheets saved before v1.11.
- The 941 worksheet's `line13Deposits` is the app's figure (its deposit rows
  plus adjustment payments), not an EFTPS balance.
- Order: `form`, `quarter`; adjustments by `noticeDate` (undated last),
  then insertion order.

## Aggregation recipes (Accountant)

- **Monthly 941 deposit** for month M (`from=YYYY-MM-01&to=YYYY-MM-<last>`):
  per run, `federal_withholding + social_security + medicare +
  employer_social_security + employer_medicare`; sum across runs.
- **Quarterly Form 941**: quarter range on pay_date; sum employee+employer
  FICA and federal withholding; wages = sum of `gross_pay`.
- **Annual Form 940 (FUTA)**: year range; FUTA wages and
  `employer_futa` totals (per-employee $7,000 cap is already applied per run).
- **State quarterly filings** (PAY-13): quarter range on pay_date; use
  `stateWithholding.byJurisdiction` for the per-state totals, or group runs
  by `stateJurisdiction` for per-employee detail. `null` jurisdictions are
  legacy flat-rate runs — reconcile those separately.
- **W-2/W-3**: year range per employee; Box 1/3/5 wages = `gross_pay` (adjust
  per form rules), Box 2 = `federal_withholding`, Box 4 = `social_security`,
  Box 6 = `medicare`.

## Errors

| Code | Meaning                                             |
| ---- | --------------------------------------------------- |
| 400  | `unsupported_status` / `invalid_date` / `invalid_range` / `unsupported_format` (payroll-runs); `invalid_date` / `invalid_range` / `invalid_jurisdiction` / `invalid_include_superseded` (tax-deposits); `invalid_year` / `invalid_form` (tax-filings) |
| 401  | missing or wrong bearer token                       |
| 503  | export disabled (no `export-token` in SECRETS_DIR)  |
