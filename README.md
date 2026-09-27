# Wagon Payroll

Stable, deterministic, authoritative payroll webapp for small business.
**Feature-complete v1** — auth + TOTP onboarding, monthly payroll lifecycle
(draft → approve → issue/void) with immutable snapshots and payslip PDFs,
employee self-service (payslips, profile, change requests with threaded
review), notification outbox with SMTP, admin configuration (tax tables, pay
schedule, company, users, audit viewers), and one-time legacy migration
tooling for the cutover from `legacy_accounting.accounting`.

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
