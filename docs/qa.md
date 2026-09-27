# QA environment runbook (spec 14)

A permanent, disposable-data QA deployment for clicking through features and
as a live target for the nightly end-to-end suite. **All data is synthetic
and re-seedable; no production data ever lands here.**

## Topology

- `payroll-qa` app container — same image as prod (auto-bumped pin per
  spec 13), `APP_ENV=qa`, served at `https://payroll-qa.example.com`.
- `payroll-qa-db` — own postgres:16-alpine container + volume; fully
  self-contained, never connected to the prod DB.
- Mailpit — the app's only SMTP target in QA (captures all outbound mail; web
  UI internal-only). No external SMTP credentials exist in QA: real email
  cannot leave the network by construction.
- Migrate one-shot runs on every redeploy (same as prod); `seed:qa` is a
  manual CLI step after first boot (idempotent).
- Both schedulers ENABLED (payroll + contractor recurring) — scheduled
  behavior is exactly what QA exists to exercise.
- Separate secrets dir `/srv/payroll-qa/secrets` (db password, encryption
  key, session secret, export token — all distinct from prod values). **No
  `smtp-password`** — Mailpit takes no credentials and the app no longer
  requires the file when `SMTP_USER` is unset.

The compose/stack side lives in the stack repo (`nsoult-agentic/stack-payroll`,
`qa/` path) and must set these app env vars:

| Env var | QA value | Notes |
| --- | --- | --- |
| `APP_ENV` | `qa` | enables the banner + `/api/qa/mailbox` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_FROM` | `mailpit` / `1025` / any address | no `SMTP_USER` → no SMTP auth |
| `MAILPIT_URL` | `http://mailpit:8025` | Mailpit HTTP API for the mailbox endpoint |

## Seeding / re-seeding

```sh
# After first boot (migrations already ran via the one-shot):
docker exec payroll-qa node dist/cli/seed-qa.js
```

Idempotent — safe to re-run any time (existence checks / `onConflictDoNothing`
throughout; a re-run creates nothing twice). To **wipe and start over**:

```sh
docker compose -f qa/docker-compose.yml down -v   # drops the QA db volume
docker compose -f qa/docker-compose.yml up -d     # migrate one-shot re-runs
docker exec payroll-qa node dist/cli/seed-qa.js
```

## Fixed QA credentials (FAKE — QA-only, safe to publish)

| Account | Email | Password | TOTP |
| --- | --- | --- | --- |
| Admin | `qa-admin@example.test` | `qa-admin-passphrase-742` | raw: `QAADMIN0FIXED1TOTP2SECRET3SEED456` |
| Employee | `qa-employee@example.test` | `qa-employee-passphrase-318` | raw: `QAEMPLOYEE0FIXED1TOTP2SECRET3SEED` |
| Contractor (Dave) | `qa-contractor@example.test` | `qa-contractor-passphrase-519` | raw: `QACONTRACTOR0FIXED1TOTP2SEED345` |

The **raw** TOTP secrets are what the app stores (and what
`@better-auth/utils`' `createOTP(secret).totp()` computes codes from — the e2e
suite uses these directly). For authenticator apps, the base32-encoded forms
are:

- admin: `KFAUCRCNJFHDARSJLBCUIMKUJ5KFAMSTIVBVERKUGNJUKRKEGQ2TM===`
- employee: `KFAUKTKQJRHVSRKFGBDESWCFIQYVIT2UKAZFGRKDKJCVIM2TIVCUI===`
- contractor: `KFAUGT2OKRJECQ2UJ5JDARSJLBCUIMKUJ5KFAMSTIVCUIMZUGU======`

All three accounts are fully enrolled (password + TOTP verified, workflow
notification defaults on). No backup codes are seeded. The contractor login
is linked to Dave Placeholder's employee record (PAY-7 — contractor
self-service e2e).

**QA export token** (bearer for the QA export API + `/api/qa/mailbox`) is
also fixed and documented — it guards synthetic data only, so it lives here
instead of a GitHub secret:

```text
5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed
```

("seed" × 16 — 64 hex chars, `openssl rand -hex 32` format.) The QA stack's
`/srv/payroll-qa/secrets/export-token` file must contain exactly this value;
the other three QA secrets (db-password, encryption-key, session-secret) are
random per-install as usual.

## Persona inventory

**W-2 employees** (payroll history: previous calendar year in full + current
year through last month, issued through the real draft→approve→issue pipeline
— figures are engine-exact to the cent):

| Persona | State | Persona coverage |
| --- | --- | --- |
| Ada Testworth | IL | W-4 exempt (zero federal withholding); has a state work-state election (flat-rate IL income tax); the ONE current-period draft run awaiting approval is hers |
| Bob Fakeley | TX | mid-year salary change — two compensation rows ($3,800 → $4,200 effective July 1 of the current year) |
| Carol Mockington | WA | pending address change request with a 3-comment thread; carries the `qa-employee` login |

**Contractors (1099):**

| Persona | Coverage |
| --- | --- |
| Dave Placeholder (US, W-9) | monthly $800 paid invoices this year — above the NEC threshold from March on (form required); recurring retainer template + one approved-but-unpaid generated invoice for the previous period (payment-due reminder fodder); carries the `qa-contractor` login for the My Invoices self-service e2e (PAY-7) |
| Erin Sampleton (US, W-9) | below the NEC threshold; backup withholding ON (24% withheld on her $400 payment); recurring template |
| Frida Nullstadt (DE, W-8BEN) | clean W-8BEN — `form_required=false`, not expiring (valid through (collected+3)-12-31); recurring template |
| Gustav Testenberg (SE, W-8BEN) | `us_days_log` entries → 1042-S review flag; W-8 expiring 20 days after seed date — inside the 30-day renewal-notification window (manual `form_expires_at` override; the app rule would always yield a Dec-31 expiry) |

## QA-only surfaces in the app

- **Banner** — `GET /api/runtime-config` (unauthenticated, returns only
  `{ appEnv, brandName }`) drives the persistent "QA — synthetic data" banner
  on every page incl. login when `APP_ENV=qa`; `brandName` is the product
  name the SPA shows (spec 22).
- **Mailbox** — `GET /api/qa/mailbox?to=<address>&latest=true` exists **only**
  under `APP_ENV=qa` (404 elsewhere), is gated by the same export-token
  bearer credential as the export API, and proxies Mailpit
  (`MAILPIT_URL`) returning `{ subject, from, to, date, text, html }` of the
  latest matching message.

## Nightly e2e

`.github/workflows/e2e-nightly.yml` runs the Playwright suite at `17 5 * * *`
UTC (plus `workflow_dispatch`) against the QA base URL from the
`QA_E2E_BASE_URL` repo variable (`E2E_BASE_URL` disables the ephemeral boot;
fixture journeys skip, the `qa.spec` specs run read-only against the seeded
data). When the variable is unset — e.g. on forks — the job skips cleanly
with a notice. **No GitHub secrets
are needed** — the QA export token for the mailbox endpoint is the fixed
documented value above (this repo intentionally holds no repo secrets).
On failure (scheduled runs only) it opens or comments on an open issue
labelled `e2e-nightly` instead of spamming duplicates.

**Verify summary (spec 17 §2):** on **every** run — pass or fail, in both
`ci.yml` and this nightly — the suites' json reporter output is assembled by
`@payroll/verify-summary` into a versioned, PII-free `summary.json` and
uploaded (with the Playwright html report) as an artifact
(`pay-verify-summary` in CI, `pay-verify-summary-nightly` here). That summary
is the ingest source of truth for the `pay-verify` visibility site (PAY-41).

**Runner (spec 14 amendment 2026-08-06):** QA sits behind a reverse-proxy
access list (LAN/VPN only), so this job runs on a **repo-scoped self-hosted
runner inside the QA network** (label `qa-e2e`) — GitHub-hosted runners get
403. If the runner is asleep at cron time the job queues (24h window) and
runs on wake. Playwright system libraries are pre-installed on the runner
host (one-time setup), so the workflow runs `playwright install chromium`
WITHOUT `--with-deps`. To reproduce this pattern: register a repo-scoped
self-hosted runner with the `qa-e2e` label on a host that can reach your QA
deployment, install the Playwright system dependencies once, and run the
runner as a service.

**Security rule:** the `qa-e2e` runner accepts `schedule` and
`workflow_dispatch` jobs only — never a `pull_request*` (or any other)
trigger, since a fork PR would run its code on the QA network. CI fails a PR that
adds one, and the fork-approval repo setting stops a fork PR's
workflows from running unreviewed; the full rule is in
[CONTRIBUTING.md → CI workflows and the self-hosted runner](../CONTRIBUTING.md#ci-workflows-and-the-self-hosted-runner).

To run the suite against live QA by hand:

```sh
E2E_BASE_URL=https://payroll-qa.example.com \
pnpm --filter @payroll/e2e e2e
```
