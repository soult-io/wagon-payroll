# Deployment guide

How to run the payroll app from the published container image. The app ships as
a single self-contained image (`ghcr.io/soult-io/wagon-payroll`; the old name
`ghcr.io/soult-io/payroll-app` received tags up to `v1.25.0` and receives
nothing after it, though its old tags stay pullable) plus a Postgres
16 database; [compose.example.yml](../compose.example.yml) wires app + one-shot
migrate + db together with production hardening (read-only rootfs,
`no-new-privileges`, `cap_drop: ALL`, memory/CPU limits, healthchecks).

Image tags:

| Tag | Published when | Use for |
|---|---|---|
| `vX.Y.Z` | a release tag is pushed | **production pins** — upgrade deliberately |
| `vX.Y` | a release tag is pushed | tracking a minor line |
| `latest` | every release (and every main merge) | evaluation / quickstart |
| `sha-<full-sha>` | every green merge to `main` | pre-release testing |

## Architecture in one paragraph

A Vue 3 SPA served by a Fastify API (Node 22, one process, one port) backed by
a dedicated Postgres 16. All schema migrations run in a **one-shot migrate
container** that must exit 0 before the app boots (`depends_on:
service_completed_successfully`) — the schema is always migrated before the app
starts, on every deploy, with zero manual steps. Secrets are read as **files**
from `SECRETS_DIR`, never as environment values.

## Prerequisites

- Docker with the compose plugin.
- A reverse proxy for TLS (nginx, Caddy, Traefik — anything). The app
  speaks plain HTTP on one port and trusts the proxy to terminate TLS.

## Quickstart

```sh
cp .env.example .env          # fill in BASE_URL (and SMTP_* if you want email)

# Secret files (layout + why ownership matters: see "Secrets" below)
install -d -m 700 secrets
openssl rand -hex 32 > secrets/db-password
openssl rand -hex 32 > secrets/encryption-key
openssl rand -hex 32 > secrets/session-secret
touch secrets/smtp-password secrets/export-token   # placeholders; see below
chmod 600 secrets/*
sudo chown 10001:10001 secrets/*

docker compose -f compose.example.yml up -d
```

Boot order is enforced by compose: `db` (healthy) → `app-migrate` (one-shot
drizzle migrations, exits 0) → `app`. Verify:

```sh
docker compose -f compose.example.yml ps     # app healthy, app-migrate exited 0
curl -s http://127.0.0.1:8927/health         # {"ok":true}
```

### First run: seed + first admin

```sh
# Reference data: company row, current federal tax tables, default pay
# schedule. Idempotent — safe to re-run.
docker exec payroll-app node dist/cli/seed.js

# First admin — prints a single-use setup link (also queued in the email
# outbox; sent when SMTP is configured). Open it to set password + TOTP.
docker exec payroll-app node dist/cli/create-admin.js you@example.com --name "Admin"
```

## Environment variable reference

Everything the server reads (`apps/server/src/config.ts`). All are optional in
development; in production set `NODE_ENV=production` and see the required
secrets below. The compose example already wires the bolded ones.

| Variable | Default | Meaning |
|---|---|---|
| `NODE_ENV` | `development` | `production` makes `session-secret` and `encryption-key` **mandatory** (boot fails without them) and disables dev fallbacks. |
| `PORT` | `8927` | Port the Fastify server listens on. The compose example keeps 8927 inside the container and lets you move the **host** bind with `PAYROLL_PORT` (compose-only, see below). |
| `HOST` | `0.0.0.0` | Bind address. |
| `LOG_LEVEL` | `info` | pino level: `trace`/`debug`/`info`/`warn`/`error`. |
| `APP_TZ` | `Europe/Madrid` | Display timezone for dates (the DB stores TIMESTAMPTZ). |
| `BASE_URL` | `http://localhost:$PORT` | **Public URL of the app as users reach it.** Used for setup links in invite/reset emails and auth trusted origins. Behind a proxy this must be the public `https://…` URL, not the container name. |
| `BRAND_NAME` | `Wagon Payroll` | Product name shown in the web app (tab title, header, login card), emails ("Sent by … on behalf of <company>"), and authenticator apps (spec 22). 1–60 characters; control, zero-width, and bidi characters are rejected; an invalid value fails boot. Served to the SPA by the public `GET /api/runtime-config`. |
| `TOTP_ISSUER` | `BRAND_NAME` | Optional override for the app name shown in authenticator apps during TOTP enrollment. Unset or empty → `BRAND_NAME`. Validated like `BRAND_NAME` (invalid fails boot). Entries already enrolled keep the label they were enrolled with; codes are unaffected. |
| `SECRETS_DIR` | `./secrets` (`/run/secrets` in the image) | Directory holding the secret files (see below). |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` | `localhost` / `5432` / `payroll` / `payroll` | Postgres connection. The password is **not** an env var — it is the `db-password` secret file. |
| `SMTP_HOST` | (empty) | Mail server. Empty → emails are logged, not sent (`EMAIL_MODE=log`). |
| `SMTP_PORT` | `587` | SMTP port. |
| `SMTP_USER` / `SMTP_FROM` | (empty) | SMTP login / From address. The password is the `smtp-password` secret file — only read when `SMTP_USER` is set, so credential-less SMTP targets (e.g. QA's Mailpit) need no such file. |
| `SMTP_SECURE` | `false` | `true` = implicit TLS (port 465 style); `false` = STARTTLS/plain per port. |
| `EMAIL_MODE` | (auto) | `smtp` or `log`, overriding the auto-detection (`smtp` when `SMTP_HOST` set, else `log`). `log` prints emails to the server log and marks them sent — handy for evaluation. |
| `APP_ENV` | `production` | Deployment environment label (spec 14). `qa` renders the web "QA — synthetic data" banner (via the public `GET /api/runtime-config`) and registers the QA-only `GET /api/qa/mailbox` endpoint (see `docs/qa.md`). Anything else is byte-identical to normal behavior. |
| `MAILPIT_URL` | `http://localhost:8025` | Mailpit HTTP API base URL — only used by the QA-only mailbox endpoint. |
| `SOURCE_DATABASE_URL` | (empty) | Legacy cutover only: connection string for the old database, read solely by the one-time `migrate:legacy` tooling, never by the running app. |

Compose-only variables (interpolation in `compose.example.yml`, not read by the
app): `PAYROLL_PORT` (host-side bind port, default `8927`) and
`SECRETS_HOST_DIR` (host directory holding the secret files, default
`./secrets`).

## Secrets: the SECRETS_DIR contract

One **file per secret** in a host directory, mounted read-only into the
containers at `/run/secrets`. Secrets are never passed as env values.

| File | Required? | Contents / used for |
|---|---|---|
| `db-password` | **required** | Postgres `payroll` role password (db + app + migrate). |
| `encryption-key` | **required in production** | 32 random bytes (hex) — AES-256-GCM for SSN/bank/EIN at rest. Boot fails without it. |
| `session-secret` | **required in production** | ≥ 32 random chars — session signing. Boot fails without it. |
| `smtp-password` | required* | SMTP account password. \*Compose requires every declared secret file to exist even when SMTP is unused — create an empty placeholder, or remove the entry from your compose copy. |
| `export-token` | optional | Bearer token for the read-only export API ([export-api.md](export-api.md)). Absent → the endpoint answers `503 export_disabled` by design. Create a placeholder file, or comment out the `export-token` entries (top-level `secrets:` + the `app` service list) in your compose copy. |

**Ownership and permissions.** Compose bind-mounts secret files preserving host
ownership, and the `app` and `app-migrate` containers run as the non-root
`payroll` user, **uid/gid 10001** (fixed in the Dockerfile). The migrate
one-shot verifies `db-password` is readable before doing anything and fails
with an explicit `chown 10001:10001` hint when it isn't. So, on the host:

```sh
chmod 600 <secrets-dir>/*
sudo chown 10001:10001 <secrets-dir>/*   # REQUIRED — the container user must read them
```

(The `db` container reads its copy as root, so it works either way.) Generate
with `openssl rand -hex 32`; keep one line per file — trailing whitespace is
trimmed.

## Migrate-then-boot

Every deploy runs `app-migrate` first: `drizzle-kit migrate` against
`DATABASE_URL` assembled from the `DB_*` env + the `db-password` file, then
exits. `app` only starts after it completes successfully — a failed migration
blocks the new app version from booting instead of running against a stale
schema. Seeds are **not** part of the one-shot; run `seed.js` by hand on first
install (idempotent, safe to re-run).

## Health endpoint

`GET /health` → `{"ok":true}` (HTTP 200). The compose healthcheck polls it
every 30 s; point your proxy's health check at it too.

## Reverse proxy note

TLS terminates at the proxy — the app container speaks plain HTTP and binds
loopback-only by default (`127.0.0.1:$PAYROLL_PORT:8927`). Proxy the public
hostname to `127.0.0.1:8927` (or the container name over a shared docker
network), enable HTTPS + HSTS there, and set **`BASE_URL` to the public
`https://` URL** — invite/reset links and auth trusted origins depend on it.
WebSockets are not required.

## Backups & upgrades

- Nightly `pg_dump` of the `payroll` database, 30-day retention, plus a dump
  before any migration that makes you nervous. Sessions live in the same DB —
  a restore means logged-out users.
- Postgres major version is pinned (`postgres:16-alpine`); upgrades are manual
  dump/restore (see README).
- App upgrades: bump the image tag in your compose copy and
  `docker compose up -d` — the migrate one-shot handles the schema. Pin to a
  `vX.Y.Z` release tag in production rather than tracking `latest`.

## Missing tax tables notice

Tax tables are the yearly rates and limits used to work out the taxes on each
paycheck: one set per year for federal, plus one for each state your employees
work in.

When a payroll year's tables aren't installed, admins see a notice at the top
of the Dashboard and Payroll pages and get an email: from December 1 for the
coming year, and as soon as it's spotted for the current year. You're emailed
only once about each missing table for a given year.

Until the tables are installed, payroll with a pay date in that year can't be
prepared, so no new drafts appear. When only some states are missing, only
employees who work in those states are held; everyone else's payroll goes
ahead. Payrolls already issued aren't affected.

The notice shows for as long as tables are missing. Each admin can turn the
email off under My payroll → Settings ("Tax tables not installed"); that
doesn't hide the notice.

## Release process (for maintainers of this repo)

Prod moves only through tagged releases — two explicit approvals (spec 13,
D28 amended 2026-08-03: **consumer pulls, producer never pushes**). This repo
publishes artifacts only; it knows nothing about any deployment repo and holds
no cross-repo credential.

1. **Release PR** in this repo (CHANGELOG + version bump), proposed by the
   agent or a maintainer → owner reviews and merges.
2. Tag the merge commit `vX.Y.Z` and push the tag.
3. `.github/workflows/release.yml` re-verifies the tagged commit, publishes
   `ghcr.io/soult-io/wagon-payroll` tagged `vX.Y.Z` + `vX.Y` + `latest`, and
   creates the GitHub release. (The legacy `ghcr.io/soult-io/payroll-app`
   received tags up to `v1.25.0` and receives nothing after it.)
4. The deployment repo (`nsoult-agentic/stack-payroll`) polls for new releases
   on a schedule and opens a **prod-pin PR** itself, using its own token.
5. **Owner merges the pin PR** → the deployment automation (GitOps)
   redeploys prod; the migrate one-shot runs first, as always.

Emergency fix = the same flow with a smaller version bump.

Releases tagged before the PAY-68 rename (up to `v1.24.0`) exist only under
`ghcr.io/soult-io/payroll-app`. To make one pullable under the new name, run
the manual `ghcr-copy-legacy-tag` workflow (Actions tab): it copies the tag
without a rebuild, so the digest stays the same.
