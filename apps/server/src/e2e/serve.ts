/**
 * E2E boot entry (hardening B): boots the REAL Fastify app against an
 * in-memory PGlite — the same wiring as the vitest integration harness
 * (test/helpers.ts) — then listens on 127.0.0.1:9898 so Playwright can drive
 * the built SPA against it. Migrations + seeds run at boot, two users are
 * created (admin fully onboarded; employee invited, onboarded by the browser
 * spec), a draft payroll run is generated, and the fixture state (TOTP
 * secret, invite link, run id) is written to e2e/.state/state.json.
 *
 * It also seeds the full QA synthetic dataset (`seedQaDataset`) — the same one
 * `pnpm seed:qa` builds against live QA — so the live-QA specs run here too
 * (PAY-56). That is the largest thing this entry does; everything below is
 * layered on top of it.
 *
 * Production boot (src/index.ts) is untouched: postgres-js over TCP + the
 * pg-boss scheduler. This entry exists for browser E2E only and is never
 * imported by the production start path.
 */

import { PGlite } from "@electric-sql/pglite";
import type { InjectOptions, LightMyRequestResponse } from "fastify";
import { drizzle } from "drizzle-orm/pglite";
import { PGliteDialect } from "kysely";
import { eq } from "drizzle-orm";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { symmetricDecrypt } from "better-auth/crypto";
import { createOTP } from "@better-auth/utils/otp";
import * as schema from "@payroll/db";
import {
  authTwoFactor,
  company,
  compensation,
  employees,
  seedDatabase,
  type SeedDb,
} from "@payroll/db";
import { loadConfig } from "../config.js";
import { buildApp } from "../app.js";
import type { Db } from "../db.js";
import { inviteUser } from "../auth/users.js";
import { syncDeposits } from "../deposits/service.js";
import { syncAnnualFilings } from "../filings/annual.js";
import { syncFilings } from "../filings/service.js";
import { seedQaDataset } from "../qa/seed-qa.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");
const DRIZZLE_DIR = resolve(REPO_ROOT, "packages/db/drizzle");
const STATE_FILE = resolve(REPO_ROOT, "e2e/.state/state.json");

const HOST = "127.0.0.1";
const PORT = 9898;
const BASE_URL = `http://${HOST}:${PORT}`;
const ORIGIN = { origin: BASE_URL };

const ADMIN = { name: "E2E Admin", email: "e2e-admin@example.com" };
const ADMIN_PASSWORD = "correct-horse-battery-staple-9";
const EMPLOYEE = { name: "E2E Employee", email: "e2e-employee@example.com" };

interface Journal {
  entries: { idx: number; tag: string }[];
}

/**
 * Run all migrations in journal order against PGlite.
 * Verbatim from test/helpers.ts — duplicated deliberately so src/ never
 * imports from test/ (build boundary).
 */
async function runMigrations(pglite: PGlite): Promise<void> {
  const journal = JSON.parse(
    readFileSync(resolve(DRIZZLE_DIR, "meta/_journal.json"), "utf8"),
  ) as Journal;
  for (const entry of journal.entries) {
    const file = resolve(DRIZZLE_DIR, `${entry.tag}.sql`);
    const sql = readFileSync(file, "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const stmt = statement.trim();
      if (!stmt) continue;
      try {
        await pglite.exec(stmt);
      } catch (err) {
        // PGlite may lack a contrib extension (e.g. btree_gist); skip only the
        // 0001 raw-SQL statements that depend on it, fail loudly otherwise.
        if (entry.tag.startsWith("0001")) continue;
        throw err;
      }
    }
  }
}

/** Extract a named cookie value from a set-cookie array (from flow-helpers). */
function cookieValue(setCookies: string | string[] | undefined, name: string): string | null {
  if (!setCookies) return null;
  const list = Array.isArray(setCookies) ? setCookies : [setCookies];
  for (const c of list) {
    const [pair] = c.split(";");
    const [k, ...v] = (pair ?? "").split("=");
    if (k?.trim() === name) return decodeURIComponent(v.join("=").trim());
  }
  return null;
}

const pglite = new PGlite("memory://");
await runMigrations(pglite);

const config = loadConfig({
  nodeEnv: "test",
  logLevel: "warn",
  baseUrl: BASE_URL,
  sessionSecret: "e2e-secret-0123456789abcdef0123456789abcdef",
  port: PORT,
  host: HOST,
});

const db = drizzle(pglite, { schema }) as unknown as Db;
const { app, auth } = await buildApp({
  config,
  // The fixtures below (and the journeys that issue them) pay in 2025. Issuing
  // a past pay date in another calendar year is refused (Spec 26 (PAY-173)
  // D9), so this boot issues "as of" the last day of 2025; later pay dates
  // (the live-clock QA draft) are future dates and stay issuable.
  clock: () => new Date("2025-12-31T12:00:00Z"),
  database: {
    db,
    dialect: new PGliteDialect({ pglite }),
    close: () => pglite.close(),
  },
});

await seedDatabase(db as unknown as SeedDb);

// PAY-56: the full QA synthetic dataset, in the ephemeral boot too. Four
// live-QA specs were gated on `E2E_BASE_URL` only because this boot lacked
// their fixtures, so they ran nowhere but the nightly.
//
// `seedQaDataset` is idempotent and is the same builder `pnpm seed:qa` uses
// against live QA. `today` is deliberately the live clock, not a fixed date:
// PAY-9 asserts the PREVIOUS calendar month is present, which only holds
// against a real one.
const qaSeed = await seedQaDataset({ db, auth, config });
// The seeded date is logged because the dataset is CLOCK-DEPENDENT and
// `reuseExistingServer` is on outside CI: a boot left over from last month
// silently invalidates the "previous calendar month" assertions, and this line
// is what makes that visible in the Playwright output.
console.log(
  `e2e:serve seeded QA dataset for ${new Date().toISOString().slice(0, 10)}: ` +
    `${qaSeed.payroll.issued + qaSeed.payroll.existing} issued runs`,
);

/** Decrypted base32 TOTP secret for a user (same path as test/flow-helpers). */
async function decryptedTotpSecret(userId: string): Promise<string> {
  const rows = await db
    .select()
    .from(authTwoFactor)
    .where(eq(authTwoFactor.userId, userId))
    .limit(1);
  if (!rows[0]) throw new Error("no twoFactor row");
  const ctx = await auth.$context;
  return symmetricDecrypt({ key: ctx.secretConfig, data: rows[0].secret });
}

/** Complete onboarding through the real HTTP endpoints (inject, no browser). */
async function onboard(token: string, userId: string, password: string): Promise<void> {
  const post = (
    url: string,
    payload: NonNullable<InjectOptions["payload"]>,
  ): Promise<LightMyRequestResponse> =>
    app.inject({ method: "POST", url, headers: ORIGIN, payload });

  const verify = await post("/api/onboarding/verify-token", { token });
  if (verify.statusCode !== 200) throw new Error(`verify-token: ${verify.body}`);
  const setPw = await post("/api/onboarding/set-password", { token, password });
  if (setPw.statusCode !== 200) throw new Error(`set-password: ${setPw.body}`);
  const enable = await post("/api/onboarding/totp-enable", { token });
  if (enable.statusCode !== 200) throw new Error(`totp-enable: ${enable.body}`);

  const secret = await decryptedTotpSecret(userId);
  const code = await createOTP(secret, { digits: 6, period: 30 }).totp();
  const verifyTotp = await post("/api/onboarding/totp-verify", { token, code });
  if (verifyTotp.statusCode !== 200) throw new Error(`totp-verify: ${verifyTotp.body}`);
}

/** Full login via inject → session cookie value (from flow-helpers login()). */
async function loginSession(email: string, password: string): Promise<string> {
  const signIn = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: ORIGIN,
    payload: { email, password },
  });
  if (signIn.statusCode !== 200) throw new Error(`sign-in: ${signIn.body}`);
  const twoFactorCookie = cookieValue(signIn.headers["set-cookie"], "payroll.two_factor");
  if (!twoFactorCookie) throw new Error(`expected 2FA challenge: ${signIn.body}`);

  const rows = await db
    .select({ id: schema.authUser.id })
    .from(schema.authUser)
    .where(eq(schema.authUser.email, email))
    .limit(1);
  if (!rows[0]) throw new Error(`user ${email} not found`);
  const secret = await decryptedTotpSecret(rows[0].id);
  const code = await createOTP(secret, { digits: 6, period: 30 }).totp();

  const verify = await app.inject({
    method: "POST",
    url: "/api/auth/two-factor/verify-totp",
    headers: { ...ORIGIN, cookie: `payroll.two_factor=${twoFactorCookie}` },
    payload: { code },
  });
  if (verify.statusCode !== 200) throw new Error(`verify-totp: ${verify.body}`);
  const session = cookieValue(verify.headers["set-cookie"], "payroll.session_token");
  if (!session) throw new Error("no session cookie after 2FA verify");
  return session;
}

// ---------------------------------------------------------------- fixtures
// Admin: fully onboarded (journey 2/3 log in via the browser with computed
// TOTP codes from the secret in the state file).
const adminInvite = await inviteUser(
  { auth, db, config },
  { name: ADMIN.name, email: ADMIN.email, role: "admin" },
  null,
);
const adminToken = new URL(adminInvite.setupLink).searchParams.get("token");
if (!adminToken) throw new Error("no admin invite token");
await onboard(adminToken, adminInvite.userId, ADMIN_PASSWORD);
const adminTotpSecret = await decryptedTotpSecret(adminInvite.userId);

// Employee: invited only — journey 1 completes onboarding in the browser.
const empInvite = await inviteUser(
  { auth, db, config },
  { name: EMPLOYEE.name, email: EMPLOYEE.email, role: "employee" },
  null,
);

// Employee record + monthly compensation so payroll generation has inputs.
const companyRows = await db.select({ id: company.id }).from(company).limit(1);
if (!companyRows[0]) throw new Error("seed did not create a company");
const [empRow] = await db
  .insert(employees)
  .values({
    userId: empInvite.userId,
    companyId: companyRows[0].id,
    legalName: EMPLOYEE.name,
    hireDate: "2024-01-01",
  })
  .returning();
if (!empRow) throw new Error("employee insert returned nothing");
await db.insert(compensation).values({
  employeeId: empRow.id,
  periodAmount: "4000",
  frequency: "monthly",
  effectiveFrom: "2025-01-01",
  effectiveTo: null,
});

// PAY-36 fixture: an ISSUED run (2025-10) + deposit sync, so the Tax deposits
// page has a row for journey 6 (the scheduler's daily sync doesn't run here).
// Issued BEFORE the 2025-11 draft below is generated: a draft generated first
// would miss October in its YTD and be refused as stale at approve (Spec 26
// (PAY-173) D4).
const adminCookie = await loginSession(ADMIN.email, ADMIN_PASSWORD);
const gen2 = await app.inject({
  method: "POST",
  url: "/api/admin/payroll-runs/generate",
  headers: { ...ORIGIN, cookie: `payroll.session_token=${adminCookie}` },
  payload: { year: 2025, month: 10, employeeId: empRow.id },
});
if (gen2.statusCode !== 201) throw new Error(`generate: ${gen2.body}`);
const runPublicId2 = (gen2.json() as { generated: { publicId: string }[] }).generated[0]?.publicId;
if (!runPublicId2) throw new Error("generate returned no run");

for (const action of ["approve", "issue"] as const) {
  const res = await app.inject({
    method: "POST",
    url: `/api/admin/payroll-runs/${runPublicId2}/${action}`,
    headers: { ...ORIGIN, cookie: `payroll.session_token=${adminCookie}` },
  });
  if (res.statusCode !== 200) throw new Error(`${action}: ${res.body}`);
}

// Draft payroll run (2025-11) through the real admin endpoint — the same
// $4,000/mo inputs as the synthetic engine golden case (net $3,383.87).
const gen = await app.inject({
  method: "POST",
  url: "/api/admin/payroll-runs/generate",
  headers: { ...ORIGIN, cookie: `payroll.session_token=${adminCookie}` },
  payload: { year: 2025, month: 11, employeeId: empRow.id },
});
if (gen.statusCode !== 201) throw new Error(`generate: ${gen.body}`);
const runPublicId = (gen.json() as { generated: { publicId: string }[] }).generated[0]?.publicId;
if (!runPublicId) throw new Error("generate returned no run");

mkdirSync(dirname(STATE_FILE), { recursive: true });
writeFileSync(
  STATE_FILE,
  `${JSON.stringify(
    {
      baseUrl: BASE_URL,
      admin: { email: ADMIN.email, password: ADMIN_PASSWORD, totpSecret: adminTotpSecret },
      employee: { email: EMPLOYEE.email, inviteUrl: empInvite.setupLink },
      run: { publicId: runPublicId },
    },
    null,
    2,
  )}\n`,
);

// Recompute everything DERIVED from issued runs, now that this boot has issued
// its own. The QA seed already ran these, but that was before the 2025-10 run
// above existed, so its 2025 Q4 941 and W-2/W-3 worksheets would otherwise
// exclude it. No today override — the Oct 2025 deposit shows as overdue, which
// also exercises the overdue chip.
// PAY-91 journey fixture (synthetic, 2023 — a year no other fixture uses).
// IL monthly deposit rows as an older release wrote them (July deposited,
// August still open), then an IL-2023 QUARTERLY schedule row. The quarterly
// schedule is SYNTHETIC — IL's real schedule is not this; it only exists so
// the sync below performs a monthly → quarterly transition the browser can
// see. No 2023 runs exist, so the quarter owes nothing: the Q3 2023 row reads
// "Nothing left to pay", lists the July payment, and flags the overpayment.
await pglite.exec(`
  INSERT INTO tax_deposits (jurisdiction, period_start, amount, due_date, status, deposited_on, eftps_confirmation, created_by)
  VALUES ('IL', '2023-07-01', '100.00', '2023-08-15', 'deposited', '2023-08-14', 'SYN-E2E-PAY91', 'scheduler'),
         ('IL', '2023-08-01', '100.00', '2023-09-15', 'overdue', NULL, NULL, 'scheduler');
  INSERT INTO state_deposit_schedules (state_code, tax_year, frequency, due_day, note, source)
  VALUES ('IL', 2023, 'quarterly', NULL, 'PAY-91 e2e fixture', 'synthetic');
`);

await syncDeposits({ db, config });
await syncFilings({ db, config });
await syncAnnualFilings({ db, config });

await app.listen({ port: PORT, host: HOST });
console.log(`e2e:serve ready at ${BASE_URL} (state → ${STATE_FILE})`);

const shutdown = () => {
  void app.close().then(() => pglite.close());
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
