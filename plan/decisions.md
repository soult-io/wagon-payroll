# Payroll Webapp — Decision Register

Every decision below requires **explicit owner sign-off** before any code is written.
Status legend: `PENDING` = awaiting owner, `CONFIRMED` = owner verified in interview (2026-07-28).

Full research reports: [research/backend.md](research/backend.md) · [research/frontend.md](research/frontend.md) · [research/auth.md](research/auth.md)

---

## D1 — Backend runtime & framework  `CONFIRMED 2026-07-28: Node.js LTS + TypeScript`

Owner chose Node/TS. Deno was explicitly checked at owner request — **rejected** (see
[research/deno.md](research/deno.md)): pg TLS compat regressions, pg-boss untested, Better Auth CLI
officially unsupported, Deno.cron unstable/non-persistent, 6–9-month LTS lines, no footprint win.

Final stack: **Node.js LTS + Fastify + Drizzle ORM + pg-boss (Postgres job queue) + Better Auth +
pdfmake/pdf-lib.** Existing tested `payroll.ts` math and the pdfmake renderer are reused verbatim.

(Alternatives considered — Go (matrix leader, 94/105, but DIY auth + math port + weakest PDF
ecosystem) and .NET 10 (89/105, first-class decimal, QuestPDF license flag) — documented in
[research/backend.md](research/backend.md).)

## D2 — Frontend framework & design system  `CONFIRMED 2026-07-28: Vue 3 + PrimeVue`

**Vue 3 + Vite SPA + PrimeVue 4.x (Material preset).** Pin PrimeVue 4.x (5.0.0 days old);
a11y audit budgeted for the polish pass; business logic lives in composables to keep any
future library migration cheap. API client generated from the backend's OpenAPI spec
(`openapi-typescript` or hey-api) for end-to-end type safety.

## D3 — Authentication architecture  `CONFIRMED 2026-07-28`

**Recommendation: embedded auth (Better Auth if D1=Node/TS), cookie sessions in Postgres.**
- Server-side sessions, `HttpOnly; Secure; SameSite=Lax` cookie — no JWTs, instant revocation
- **TOTP mandatory at v1** for all users (internet-exposed payroll PII); backup codes; passkeys fast-follow
- Invite-only: self-registration disabled at code level; tokenized email setup flow (≤24h, hashed at rest)
- Argon2id password hashing (OWASP params); RBAC `admin`/`employee` enforced server-side
- Append-only `auth_events` audit table from day one
- No external IdP (Keycloak ~1.25GB, Authentik ~700MB, Zitadel viable but v2-if-needed)

- [ ] **Owner confirm: embedded auth + TOTP-at-v1 ☐** (any deviation: note it)

## D4 — Database topology  `CONFIRMED 2026-07-28 (incl. sole-writer amendment)`

Per owner: **dedicated Postgres instance for this app** (own container in the new repo's compose),
self-contained, no dependency on `legacy-db`. One-time migration copies payroll-relevant
data (employees, compensation, w4_elections, tax_config, tax_brackets, payroll history) out of
the `accounting` schema into the new app's schema. **Owner confirmed: the new app is the ONLY
writer** for payroll config/tax data after cutover — old `accounting` payroll tables become
read-only history.

## D5 — Payslip documents: on-demand generation, no stored PDFs  `CONFIRMED by owner (B4/B5)`

- Data is the source of truth; PDFs rendered on-demand at download time
- Historical **data** imported (payroll runs + entries), not PDF files
- ⚠ Open item for spec phase: an issued payslip should be **immutable** — regeneration must be
  deterministic from the frozen run snapshot, never from live config. Spec will enforce a
  `run_snapshot` JSON on the payroll run so config edits never rewrite history.

## D6 — Payroll run workflow  `CONFIRMED by owner (D7/D8 of interview)`

- Draft → approve → issue; admin notified when a draft awaits approval
- Configurable schedule, default: **15th of every month**
- Calculation + payslip only; no payment recording in v1
- Schema must support multiple pay frequencies (monthly in practice)

## D7 — Employee change requests  `CONFIRMED by owner (E)`

- Fields: address, W-4/withholding elections, bank details, legal name (no tax ID changes)
- **Effective-dated** on approval; admin approve/deny with **full comment thread**

## D8 — Notifications  `CONFIRMED by owner (F)`

- SMTP credentials via app config — nothing hardcoded to personal infrastructure
- Per-event (not digest): payslip issued → employee; change request submitted → admin;
  request approved/denied → employee; payroll draft awaiting approval → admin
- Per-user notification settings (opt toggles per event class)

## D9 — Deployment topology  `CONFIRMED by owner (B6)`

- New repository, new service; deployed via established GitOps deployment + reverse proxy pattern
- App must be deployable **without** that pattern too (reusable product) — compose file is
  one deployment artifact, not a hard dependency
- Hardened container conventions (read-only rootfs, dropped caps, resource limits, secrets as files)

## D10 — Schema futures (design-in, build-later)  `CONFIRMED by owner (H)`

- Time-off tracking: tables in schema, no UI in v1
- Contractor/1099 invoicing: schema considerations only, next iteration
- Bookkeeping: out of scope; possible future **export capability** (CSV/JSON/journal entries)
- Compliance filing: not designed in for v1

## D11 — Roles: one app, two roles  `CONFIRMED by owner (C6)`

Single login system, `admin`/`employee` roles on one app. (No compelling case for two apps:
doubles deployment surface and auth complexity for zero security gain at this scale —
RBAC + server-side enforcement is the standard pattern.)

## D12 — Explicit v1 exclusions  `CONFIRMED by owner`

Payments · bookkeeping · mobile app · third-party API · multi-currency · time-off UI ·
invoicing · self-registration · payroll PDF file storage · external file-store integration of any kind

## D13–D18 — 1099 contractors  `CONFIRMED by owner 2026-08-02 ("approved as written")`

Activates the D10 1099 future per `specs/contractors.md` (Spec 10) with research basis
`research/contractors.md`:

- **D13** — Worker model: reuse `employees` (`employment_type='1099'`) + 1:1
  `contractor_details` (tax_status/entity/form/expiry/backup-withholding/services-location)
- **D14** — Money flow: `contractor_invoices` + 1:1 `contractor_payments`, separate from
  `payroll_runs`; payment method tracked for the 1099-K carve-out
- **D15** — Year-end: on-demand 1099-NEC PDF at dated threshold config ($2,000/2026,
  indexed; $600 through 2025); 1042-S detection-only, generation out of scope
- **D16** — Contractor self-service portal deferred; admin enters invoices in V1
- **D17** — Hard server block on paying a contractor without a valid form on file
- **D18** — Export API extended: `GET /api/export/contractor-payments?year=YYYY` behind
  the existing read-only export token

## D19–D21 — PII capture (company EIN + employee TIN)  `CONFIRMED by owner 2026-08-03 ("approved as written")`

Per `specs/pii-capture.md` (Spec 11); reverses interview E10 (initial values were never
captured, so edit paths are needed after all):

- **D19** — Company EIN admin-editable in company settings: validated, encrypted at rest,
  write-only (masked reads), masked audit before/after, no approval loop
- **D20** — Employee TIN two paths: admin direct set (backfill) + employee `'tax_id'`
  change request with encrypted-at-rest payload (ciphertext only in change_requests /
  comments / audit / notifications)
- **D21** — TIN in admin review UI masked by default with explicit reveal control

## D22–D25 — Recurring contractor invoices  `CONFIRMED by owner 2026-08-03 (with separate-scheduler amendment)`

Per `specs/recurring-invoices.md` (Spec 12):

- **D22** — Generated invoices arrive as `submitted`, requiring admin approval (mirrors
  W-2 draft→approve); payments are NEVER auto-recorded (permanent non-goal)
- **D23** — Payment-due reminder notification on the configured pay day if
  approved-but-unpaid (absorbs any standalone reminder)
- **D24** — Schedule model: invoice dated last-day-of-month or fixed day ≤28; payment
  due on fixed day ≤28 of the following month
- **D25** — Template edits affect future generations only; pause/end instead of delete
  once used
- **Amendment** — contractor invoice generation runs as a SEPARATE scheduler (own
  module/registration/tick, independent of the W-2 payroll scheduler)

## D26–D29 — Repo/stack split & release model  `CONFIRMED by owner 2026-08-03 ("approved as written")`

Per `specs/stack-split.md` (Spec 13):

- **D26** — New private `nsoult-agentic/stack-payroll` (house convention); prod/qa
  compose paths; two GitOps stacks from one repo; secrets stay on the home-server fs
- **D27** — QA auto-follows `main` (pin-bot into stack repo); prod follows tagged
  releases only
- **D28** — Release mechanics (AMENDED 2026-08-03, owner: consumer pulls, not producer
  pushes): app repo only publishes artifacts (release PR → owner merge → tag → images +
  GitHub release). Stack repo's own scheduled workflow pulls: QA auto-bumps to latest
  main build (`[skip ci]`); prod gets a pin PR on new release tags → owner merge. Only
  credential: a READ-ONLY upstream token held by the stack repo — no STACK_REPO_TOKEN,
  the app repo holds nothing
- **D29** — Repo + ghcr package private now; public flip + license choice deferred as
  a future explicit decision

## D30–D32 — QA environment  `CONFIRMED by owner 2026-08-03 ("approved as written")`

Per `specs/qa-environment.md` (Spec 14):

- **D30** — Own stack (`qa/` path), own DB, Mailpit-only email (no external SMTP by
  construction), APP_ENV=qa banner, both schedulers enabled
- **D31** — Synthetic-only deterministic `seed:qa`; no production data ever
- **D32** — Playwright targets live QA via E2E_BASE_URL; nightly CI + failure→issue

## D33–D35 — Plane (project management)  `CONFIRMED by owner 2026-08-03 ("approved as written")`

Per `specs/plane-pm.md` (Spec 15):

- **D33** — `nsoult-agentic/stack-plane`, official images version-pinned, `/srv/plane`
- **D34** — `plane.example.com` via the reverse proxy; no SSO (CE limitation); invite-only
- **D35** — Agent access via service-account API key (REST first, MCP optional later)

## D36 — W-2 state boxes 15–17 are filled  `CONFIRMED by owner 2026-09-27 (PAY-104 F25)`

Per Spec 24 in Plane ticket PAY-116 (specs live in Plane, owner 2026-09-27):

- W-2 boxes 15 (state + employer state ID), 16 (state wages) and 17 (state income tax) are
  filled from issued-run entries grouped by the run snapshot's work state, for tax years
  2026 and later. NY box 16 = box 1, all wages for the year, when the employee worked in NY
  at any time in the year (NYS TSB-M-02(3)I). More than two states → an additional W-2 with
  boxes 1–14 blank. The W-3 carries boxes 15–17 (one state + ID, or "X") and box c counts
  W-2 forms, not employees.
- Maryland county tax belongs in box 17 with state tax; the app does not withhold it yet
  (PAY-120), so MD box 17 shows state tax only, with a warning.
- Supersedes the unrecorded PAY-19 rule "blank boxes stay blank (D5: boxes 7–14,
  state/local)" in `packages/documents/src/w2.ts`. That "D5" was a PAY-19 ticket-local
  number (PAY-19 shipped in 1.9.0, see `CHANGELOG.md`), not master D5 above. Boxes 7–14 stay
  blank.
- Employer state IDs are stored per state, encrypted at rest and write-only, like the EIN
  (D19).
- A W-2 whose state line has tax withheld and no employer state ID is blocked; with no tax
  withheld it only warns (owner 2026-09-27, PAY-116 S24-D3).
- Still pending in PAY-116: local boxes 18–20 (proposed out of scope, S24-D8), the 2026
  W-2/W-3 templates (proposed in scope, S24-D6), and holding the "W-2 ready" email while a
  W-2 is blocked (S24-D11).

---

## After sign-off

Once D1–D4 are decided, the compartmentalized specs get written, one file each:
1. `specs/data-model.md` — full schema (incl. D10 futures), migrations strategy
2. `specs/payroll-engine.md` — calculation integration, run lifecycle, idempotency
3. `specs/auth.md` — flows, session model, audit events
4. `specs/change-requests.md` — state machine, effective dating, comment threads
5. `specs/documents.md` — payslip rendering, immutability, download API
6. `specs/notifications.md` — SMTP config, event catalog, templates
7. `specs/frontend.md` — routes, screens, component inventory
8. `specs/deployment.md` — repo layout, Dockerfile, compose, CI, reverse proxy
9. `specs/migration.md` — data copy from `accounting` schema, cutover, retiring the agent routine

Each spec gets its own explicit owner approval before the build begins.
