# Wagon Payroll

US payroll and payroll-tax software for small businesses: run payroll, track
tax deposits, and prepare the federal forms (941, 940, W-2/W-3, 1099-NEC),
with employee self-service.

> [!WARNING]
> **Not ready for you to run yet.** Wagon Payroll runs one real company today,
> its maintainers' own, and it only handles that company's simple setup. It
> is not ready for anyone else to run their payroll on. Please don't put real
> employee data into your own copy yet. See [Current limits](#current-limits)
> for what's missing. You're welcome to read the code, try it with made-up
> data, and contribute.

What works today: sign-in with a password and a one-time code app (TOTP),
monthly payroll (draft → approve → issue, or void before it's issued) with
locked payroll records and payslip PDFs, tax deposit tracking with
reminders, federal worksheets and filled IRS forms (941, W-2 and W-3; Form
940 for 2025 only so far), 1099-NEC for contractors, and employee
self-service (payslips, W-2s, profile, change requests).

## Current limits

Wagon Payroll is built and tested for one shape of company: one US company,
salaried employees paid once a month, and a small, steady payroll. Outside
that shape it can give wrong numbers. Known gaps:

**Federal**

- Federal withholding is only right for W-4s marked *Single* or *Married
  filing separately*. *Married filing jointly* and *Head of household* are
  withheld as if *Single*, which takes out too much.
- The W-4 Step 2 "multiple jobs" checkbox is saved but not used, so those
  employees have too little withheld.
- Federal deposit due dates assume a monthly depositor. Semiweekly
  depositors, and the next-day rule for $100,000 or more, aren't handled.
  Due dates move off weekends but not off federal holidays.
- Form 941 line 1 counts employees in the quarter's first month instead of
  its last, so it's wrong if your headcount changes during a quarter. Lines
  5c and 5d are wrong once anyone's pay passes $200,000 for the year
  (Additional Medicare tax). FUTA credit-reduction states (Form 940
  Schedule A) aren't handled.
- Only the current W-4 (2020 and later) is supported, not older W-4s with
  allowances.
- 1099-NEC forms are PDFs for your records and your contractors. Filing them
  with the IRS (for example through IRIS) is up to you.
- No pre-tax deductions (401(k), health plans, HSA), no bonus or
  off-cycle runs, and no corrections after a payroll is issued (no 941-X or
  W-2c).

**Pay**

- Monthly pay only. Weekly, every-two-weeks and twice-a-month payrolls can't
  be run, and many states don't allow monthly pay for some or all employees.
  Enter every salary as a monthly amount: the salary form also offers weekly,
  every-two-weeks and twice-a-month, and picking one of those gives wrong pay
  and taxes.
- Salaried only: no hourly pay, hours entry or overtime.
- Starting partway through a year isn't supported: there's no way to enter
  pay from a previous provider, so wage caps and year-end totals would be
  wrong.

**State and local**

- State income tax tables are included for every state. Only a few have been
  checked against the state's own published tables, and some are known
  simplifications that withhold too little.
- No state unemployment tax (SUI), no quarterly state wage reports, and no
  new-hire reporting, in any state.
- An employee with no work state on file has no state income tax withheld,
  and the app doesn't warn you. Set a work state for every employee who
  works in a US state.
- State deposit schedules are set up for five states only (CA, IL, MD, NC,
  NY). For every other state, deposit reminders assume monthly deposits due
  the 15th of the next month, which may not match that state's rules. No
  state withholding returns are produced.
- No local income taxes (for example NYC, Yonkers, Maryland counties,
  Pennsylvania, Ohio), and the app doesn't stop you from running payroll for
  employees who owe them. No state-required employee deductions either, such
  as California SDI or New York paid family leave.
- One state per employee: living in one state and working in another isn't
  handled.

**Running your own copy**

- New tax tables each year aren't delivered automatically: they ship in the
  code, and you have to install the new release and re-run the seed step.
  Until the next year's tables are installed, payroll for that year can't be
  prepared. There's no promise yet on when each year's tables will ship.
- Security hardening isn't finished, and the setup guide
  ([docs/deployment.md](docs/deployment.md)) has only been used on the
  maintainers' own servers.
- Dates and times in the web app always show in the Europe/Madrid time zone.
  The server also works out "today" (deadlines, reminders, daily jobs) in
  Madrid unless you set `APP_TZ` to your own time zone.

**Out of scope by design:** Wagon Payroll doesn't move money (no direct
deposit) and doesn't file or pay anything for you. You pay deposits on EFTPS
and file the forms it prepares. One company per install.

We're working toward a first release that others can run, with these limits
closed or blocked inside the app. Progress shows in the
[CHANGELOG](CHANGELOG.md).

## Architecture (one paragraph)

A Vue 3 + PrimeVue SPA (`apps/web`) talks to a Fastify API (`apps/server`,
Node 22) that owns a dedicated Postgres 16 database via Drizzle migrations
(`packages/db`). All withholding math lives in `packages/engine` — `payroll.ts`/
`money.ts` vendored verbatim from a battle-tested internal accounting codebase,
pure and deterministic, with their original unit tests as the regression oracle.
Shared Zod schemas live in `packages/shared`. Deployment is a single
self-contained container image published to ghcr (`compose.example.yml` shows
a reference deployment: app + one-shot migrate + postgres).

## Quickstart

Prereqs: Node ≥ 22, pnpm 11 (`npm install -g pnpm`), Docker for the database.

```sh
# 1. Install dependencies
pnpm install

# 2. Start Postgres (the example compose db service works standalone for dev)
mkdir -p secrets && echo payroll > secrets/db-password
docker compose -f compose.example.yml up -d db

# 3. Run migrations (needs DATABASE_URL; matches the dev compose defaults)
DATABASE_URL=postgres://payroll:payroll@localhost:5432/payroll pnpm db:migrate

# 4. Dev servers — API on :8927, web on :5173 (proxying /api → :8927)
pnpm dev

# Or individually:
pnpm --filter @payroll/server dev
pnpm --filter @payroll/web dev
```

Useful checks:

```sh
pnpm -r run typecheck              # tsc / vue-tsc across all packages
pnpm test                          # ALL tests: engine 61 + server 133 (vitest)
pnpm -r run build                  # build everything
pnpm db:generate                   # regenerate SQL migrations from the schema
```

Environment variables are documented in [.env.example](.env.example); secrets
are read as **files** from `SECRETS_DIR`, never as env values (spec 8).

## Legacy migration & cutover

Maintainers only. This one-time tool moved the maintainers' own company onto
Wagon Payroll. It reads one specific old database and is not a general import
from other payroll providers.

One-time import of payroll history from a legacy accounting database
(`legacy_accounting.accounting`), with snapshot reconstruction validated to
the cent before any write. Dry-run by default; `--write` is idempotent
(ledger table `legacy_migration_map`):

```sh
SOURCE_DATABASE_URL=postgres://…@legacy-db:5432/legacy_accounting \
  pnpm migrate:legacy --dry-run --verbose   # analysis only, zero writes
SOURCE_DATABASE_URL=postgres://…@legacy-db:5432/legacy_accounting \
  pnpm migrate:legacy --write               # perform (re-run = no-op)
```

The full cutover procedure (secrets, deploy order, verification, rollback) is
deployment-specific and intentionally not part of this repo — the migration
CLI above is everything the codebase needs.

## Run it (Docker)

For trying it out with made-up data only. See [Current limits](#current-limits)
before using it for real payroll.

Prereqs: Docker with the compose plugin. The published image is
`ghcr.io/soult-io/wagon-payroll` — no build required. (The old name,
`ghcr.io/soult-io/payroll-app`, received tags up to `v1.25.0` and receives
nothing after it; its old tags stay pullable — switch your `image:` line.)

```sh
# 1. Configure — every knob is documented inline
cp .env.example .env          # set BASE_URL; SMTP_* optional

# 2. Secrets — one file per secret; the app runs as uid 10001 and must read them
install -d -m 700 secrets
openssl rand -hex 32 > secrets/db-password
openssl rand -hex 32 > secrets/encryption-key
openssl rand -hex 32 > secrets/session-secret
touch secrets/smtp-password secrets/export-token   # placeholders are fine
chmod 600 secrets/* && sudo chown 10001:10001 secrets/*

# 3. Boot — db (healthy) → app-migrate (one-shot) → app on 127.0.0.1:8927
docker compose -f compose.example.yml up -d

# 4. First run only — seed reference data, then create the first admin
#    (prints a single-use setup link: password + TOTP enrollment)
docker exec payroll-app node dist/cli/seed.js
docker exec payroll-app node dist/cli/create-admin.js you@example.com --name "Admin"
```

For production, pin the image to a release tag (`:vX.Y.Z`) instead of
`:latest`, and put a TLS-terminating reverse proxy in front with `BASE_URL`
set to the public URL. The full guide — env-var reference, the SECRETS_DIR
contract, migrate-then-boot, health endpoint, backups, upgrades, and the
release process — is [docs/deployment.md](docs/deployment.md). The disposable
QA environment (synthetic seed, fixed credentials, nightly e2e against live
QA) is documented in [docs/qa.md](docs/qa.md).

## Repo layout

```
apps/server/        Fastify API + serves built SPA (Node 22 LTS)
  src/migrate/      legacy cutover tooling (pnpm migrate:legacy)
apps/web/           Vue 3 + Vite SPA (PrimeVue 4.x, Material preset)
packages/engine/    vendored payroll.ts + money.ts + tests (from an internal accounting codebase)
packages/db/        Drizzle schema + migrations
packages/shared/    Zod schemas, types shared by server+web
docs/               operations docs (deployment, QA, export API)
Dockerfile          multi-stage: build web → build server → runtime
compose.example.yml reference deployment: app + migrate one-shot + postgres
.github/workflows/  CI: test → build image → push ghcr (main); release.yml: tags → release images + GitHub release
```

## Database notes

- Money is always `NUMERIC(12,2)`; rates `NUMERIC(6,5)`; rounding half-up,
  defined once in `packages/engine` (spec 1).
- Better Auth's own tables (`user`, `session`, …) are created by the Better
  Auth CLI in step 2 — they are deliberately absent from `packages/db`.
- The compensation non-overlap exclusion constraint and issued-run immutability
  trigger are raw SQL migration steps (`packages/db/drizzle/`), not Drizzle DSL.

## Postgres upgrades

Major version is pinned (`postgres:16-alpine`). Upgrades are manual:
`pg_dump` from the old container, bring up the new pinned image on an empty
volume, restore, then point the app at it. Nightly backups: `pg_dump` sidecar
or host backup job, 30-day retention (spec 8).

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the
dev setup, test/lint commands, and PR expectations.

## Security

Please report vulnerabilities privately via GitHub's private vulnerability
reporting — see [SECURITY.md](SECURITY.md).

## License

[AGPL-3.0](LICENSE)

`packages/documents/assets/forms/*`: official IRS forms, U.S. Government works,
public domain (17 U.S.C. §105); SHA-256-pinned in
`packages/documents/src/forms/templates.ts`.
