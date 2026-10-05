/**
 * PAY-208 fix round 2 — security and code-review items on the admin
 * "Change sign-in email" route (payroll-calc-auditor, fail-first against
 * c761fff; the coder may not edit this file). Synthetic data only.
 *
 * Tests: SH1a-b (S-H1), SM1 (S-M1), SM2 (S-M2), SL1 (S-L1), SL2 (S-L2),
 * CL8 (C-L8). S-L3 has no test: audit_events has no ip / user_agent
 * columns (packages/db/src/schema.ts auditEvents), so there is nothing to
 * assert without a schema change the brief does not ask for.
 *
 * Contract assumed:
 *  - PUT /api/admin/employees/:employeeId/sign-in-email revokes every
 *    outstanding setup token (invite and reset) of the user in the same
 *    transaction (revokeOutstandingSetupTokens); the old link's
 *    /api/onboarding/verify-token and /set-password then answer 400
 *    { error: "invalid_token" }. The response carries
 *    `pendingEnrollment: true` when the user is still pending enrolment
 *    (banReason "pending_enrollment") and false otherwise; no new invite
 *    is sent automatically.
 *  - It deletes the user's sessions and writes auth event
 *    "session_revoked" for the user.
 *  - A unique violation from a concurrent change -> 409 email_exists,
 *    never 500, and no log line carries the database detail.
 *  - 20 requests per minute per client (PDF_RATE_LIMIT); the 21st -> 429.
 *  - :employeeId not a positive integer -> 400 { error: "invalid_id" }.
 *  - An outbox row with recipient_email set never stores the address in
 *    last_error (error class/code only, or the address redacted); GET
 *    /api/admin/notifications/outbox never shows it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { authEvents, authUser, emailOutbox, employees } from "@payroll/db";
import { initiateReset, inviteUser } from "../src/auth/users.js";
import { drainOutbox } from "../src/notify/outbox.js";
import { ORIGIN } from "./helpers.js";
import { tokenFromLink } from "./flow-helpers.js";
import { boot, call, type Emp, type Env, makeEmp, myW2, reloginAdmin } from "./pay-208-harness.js";

const url = (id: number | string) => `/api/admin/employees/${id}/sign-in-email`;
let ipSeq = 0;
function ip(): string {
  ipSeq += 1;
  return `10.211.${Math.floor(ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;
}

/** PUT sign-in-email from its own client address (the route is rate limited). */
async function change(
  env: Env,
  id: number | string,
  email: string,
  extra: Record<string, string> = {},
) {
  const a = ip();
  return env.t.app.inject({
    method: "PUT",
    url: url(id),
    headers: { ...env.admin, "x-forwarded-for": a, ...extra },
    remoteAddress: a,
    payload: { email },
  });
}

async function onboardingStep(env: Env, path: string, payload: Record<string, unknown>) {
  const a = ip();
  return env.t.app.inject({
    method: "POST",
    url: `/api/onboarding/${path}`,
    headers: { ...ORIGIN, "x-forwarded-for": a },
    remoteAddress: a,
    payload,
  });
}

async function linkEmployee(env: Env, userId: string, label: string): Promise<number> {
  const rows = await env.t.db
    .insert(employees)
    .values({
      companyId: env.companyId,
      legalName: `${label} Synthetic`,
      hireDate: "2024-01-01",
      userId,
    })
    .returning();
  return rows[0]!.id;
}

// ---------------------------------------------------------------- S-H1

describe("SH1 setup links issued before a sign-in email change stop working (S-H1)", () => {
  let env: Env;
  beforeAll(async () => {
    env = await boot({ now: "2027-01-04T10:00:00Z" });
  }, 180_000);
  afterAll(async () => env.close());

  it("SH1a pending invite: after the change verify-token and set-password -> 400 invalid_token; pendingEnrollment true; no new invite sent", async () => {
    const inv = await inviteUser(
      { auth: env.t.auth, db: env.t.db, config: env.t.config },
      { name: "Pending Synthetic", email: "pending-old@example.com", role: "employee" },
      null,
    );
    const id = await linkEmployee(env, inv.userId, "Pending");
    const token = tokenFromLink(inv.setupLink);
    const invitesBefore = (
      await env.t.db.select().from(emailOutbox).where(eq(emailOutbox.userId, inv.userId))
    ).length;
    const res = await change(env, id, "pending-new@example.com");
    const verify = await onboardingStep(env, "verify-token", { token });
    const setPw = await onboardingStep(env, "set-password", {
      token,
      password: "another-horse-battery-9",
    });
    const securityMails = (
      await env.t.db
        .select()
        .from(emailOutbox)
        .where(
          and(eq(emailOutbox.userId, inv.userId), sql`${emailOutbox.eventType} LIKE 'security_%'`),
        )
    ).length;
    expect({
      status: res.statusCode,
      pendingEnrollment: (res.json() as { pendingEnrollment?: boolean }).pendingEnrollment,
      verify: [verify.statusCode, (verify.json() as { error?: string }).error],
      setPw: [setPw.statusCode, (setPw.json() as { error?: string }).error],
      noNewInvite: securityMails <= invitesBefore,
    }).toEqual({
      status: 200,
      pendingEnrollment: true,
      verify: [400, "invalid_token"],
      setPw: [400, "invalid_token"],
      noNewInvite: true,
    });
  });

  it("SH1b outstanding reset link: after the change verify-token -> 400 invalid_token; pendingEnrollment true", async () => {
    const e = await makeEmp(env, { label: "Resetpending", login: true });
    const reset = await initiateReset(
      { auth: env.t.auth, db: env.t.db, config: env.t.config },
      e.userId!,
      null,
    );
    const token = tokenFromLink(reset.setupLink);
    const res = await change(env, e.id, "reset-new@example.com");
    const verify = await onboardingStep(env, "verify-token", { token });
    expect({
      status: res.statusCode,
      pendingEnrollment: (res.json() as { pendingEnrollment?: boolean }).pendingEnrollment,
      verify: [verify.statusCode, (verify.json() as { error?: string }).error],
    }).toEqual({ status: 200, pendingEnrollment: true, verify: [400, "invalid_token"] });
  });
});

// ---------------------------------------------------------------- S-M2

describe("SM2 the employee's sessions end on a sign-in email change (S-M2)", () => {
  let env: Env;
  let e: Emp;
  beforeAll(async () => {
    env = await boot({ now: "2027-01-04T10:00:00Z" });
    e = await makeEmp(env, { label: "Sessionend", login: true, years: [2026] });
  }, 180_000);
  afterAll(async () => env.close());

  it("the old session -> 401; auth event session_revoked for the user; pendingEnrollment false for an enrolled user", async () => {
    const before = (await myW2(env, e)).statusCode;
    const res = await change(env, e.id, "sessionend-new@example.com");
    const after = (await myW2(env, e)).statusCode;
    const events = await env.t.db
      .select({ event: authEvents.event })
      .from(authEvents)
      .where(and(eq(authEvents.userId, e.userId!), eq(authEvents.event, "session_revoked")));
    expect({
      before,
      status: res.statusCode,
      pendingEnrollment: (res.json() as { pendingEnrollment?: boolean }).pendingEnrollment,
      after,
      revokedEvents: events.length,
    }).toEqual({
      before: 200,
      status: 200,
      pendingEnrollment: false,
      after: 401,
      revokedEvents: 1,
    });
  });
});

// ---------------------------------------------------------------- S-M1

describe("SM1 a delivery error naming the old address is never stored or shown (S-M1)", () => {
  let env: Env;
  let e: Emp;
  const OLD = () => e.email!;
  beforeAll(async () => {
    env = await boot({ now: "2027-01-04T10:00:00Z" });
    e = await makeEmp(env, { label: "Bounceold", login: true });
  }, 180_000);
  afterAll(async () => env.close());

  it("five failed attempts to the old address: last_error never contains it; the admin outbox view never shows it", async () => {
    const res = await change(env, e.id, "bounce-new@example.com");
    const old = OLD();
    const transport = {
      sendMail: async (m: { to: string }) => {
        if (m.to.toLowerCase() === old.toLowerCase()) {
          throw new Error(`550 5.1.1 <${m.to}>: Recipient address rejected: User unknown`);
        }
      },
    };
    const errors: (string | null)[] = [];
    for (let i = 0; i < 5; i += 1) {
      await drainOutbox({
        db: env.t.db,
        config: { ...env.t.config, emailMode: "smtp" },
        transport,
        resolveRecipientEmail: async (userId: string) =>
          (
            await env.t.db
              .select({ email: authUser.email })
              .from(authUser)
              .where(eq(authUser.id, userId))
          )[0]?.email ?? null,
      } as never);
      const rows = await env.t.db.select({ lastError: emailOutbox.lastError }).from(emailOutbox);
      errors.push(...rows.map((r) => r.lastError));
      env.tick(2 ** (i + 1) * 60 * 1000 + 1000);
    }
    await reloginAdmin(env);
    const view = await call(env, "GET", "/api/admin/notifications/outbox", env.admin);
    const failed = await env.t.db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.status, "failed"));
    expect({
      change: res.statusCode,
      someError: errors.some((x) => x !== null),
      failedRows: failed.length,
      inLastError: errors.filter((x) => x?.toLowerCase().includes(old.toLowerCase())).length,
      inView: view.body.toLowerCase().includes(old.toLowerCase()),
    }).toEqual({ change: 200, someError: true, failedRows: 1, inLastError: 0, inView: false });
  });
});

// ---------------------------------------------------------------- S-L1, C-L8

describe("SL1 concurrent duplicate -> 409, never 500 (S-L1); CL8 id validation (C-L8)", () => {
  let env: Env;
  const logs: string[] = [];
  let a: Emp;
  let b: Emp;
  beforeAll(async () => {
    env = await boot({
      now: "2027-01-04T10:00:00Z",
      logStream: { write: (m) => void logs.push(m) },
    });
    a = await makeEmp(env, { label: "Racea", login: true });
    b = await makeEmp(env, { label: "Raceb", login: true });
  }, 180_000);
  afterAll(async () => env.close());

  it("SL1 two admins set the same new address at once: one 200, one 409 email_exists; no 500; no database detail in any log line", async () => {
    const mark = logs.length;
    const out = await Promise.all([
      change(env, a.id, "race@example.com"),
      change(env, b.id, "race@example.com"),
    ]);
    const owners = await env.t.db
      .select({ id: authUser.id })
      .from(authUser)
      .where(sql`lower(${authUser.email}) = 'race@example.com'`);
    const fresh = logs.slice(mark).join("\n");
    expect({
      statuses: out.map((r) => r.statusCode).sort(),
      error: out
        .map((r) => (r.statusCode === 409 ? (r.json() as { error?: string }).error : null))
        .filter(Boolean),
      owners: owners.length,
      pgDetail: /23505|duplicate key|unique constraint|user_email_key|already exists/i.test(fresh),
    }).toEqual({ statuses: [200, 409], error: ["email_exists"], owners: 1, pgDetail: false });
  });

  it("SL1b deterministic: the address is taken between the check and the update (test-only trigger) -> 409 email_exists, no 500, no database detail in logs, nothing changed", async () => {
    // Test-only trigger (synthetic): when user A's email is set to the target,
    // first give the target to user B, so A's own UPDATE hits the unique key
    // (23505) after the route's "is it taken?" check passed.
    await env.t.pglite.exec(`
      CREATE OR REPLACE FUNCTION pay208_steal_email() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.email = 'stolen@example.com' AND OLD.email <> NEW.email THEN
          UPDATE "user" SET email = 'stolen@example.com' WHERE id = '${b.userId}';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER pay208_steal BEFORE UPDATE OF email ON "user"
        FOR EACH ROW WHEN (OLD.id = '${a.userId}') EXECUTE FUNCTION pay208_steal_email();`);
    const mark = logs.length;
    const before = (
      await env.t.db
        .select({ email: authUser.email })
        .from(authUser)
        .where(eq(authUser.id, a.userId!))
    )[0]?.email;
    const r = await change(env, a.id, "stolen@example.com");
    await env.t.pglite.exec(
      'DROP TRIGGER pay208_steal ON "user"; DROP FUNCTION pay208_steal_email();',
    );
    const after = (
      await env.t.db
        .select({ email: authUser.email })
        .from(authUser)
        .where(eq(authUser.id, a.userId!))
    )[0]?.email;
    const fresh = logs.slice(mark).join("\n");
    expect({
      status: r.statusCode,
      error: (r.json() as { error?: string }).error,
      unchanged: after === before,
      pgDetail: /23505|duplicate key|unique constraint|user_email_key|already exists/i.test(fresh),
    }).toEqual({ status: 409, error: "email_exists", unchanged: true, pgDetail: false });
  });

  it("CL8 non-numeric, zero, negative or fractional :employeeId -> 400 invalid_id", async () => {
    const out: unknown[] = [];
    for (const id of ["abc", "0", "-1", "1.5"]) {
      const r = await change(env, id, "whatever@example.com");
      out.push([r.statusCode, (r.json() as { error?: string }).error]);
    }
    expect(out).toEqual([
      [400, "invalid_id"],
      [400, "invalid_id"],
      [400, "invalid_id"],
      [400, "invalid_id"],
    ]);
  });
});

// ---------------------------------------------------------------- S-L2

describe("SL2 the route is rate limited like the PDF routes (S-L2)", () => {
  let env: Env;
  let e: Emp;
  beforeAll(async () => {
    env = await boot({ now: "2027-01-04T10:00:00Z" });
    e = await makeEmp(env, { label: "Ratelimitmail", login: true });
  }, 180_000);
  afterAll(async () => env.close());

  it("21 requests from one client in a minute: the first 20 are answered, the 21st -> 429", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 21; i += 1) {
      const r = await env.t.app.inject({
        method: "PUT",
        url: url(e.id),
        headers: { ...env.admin, "x-forwarded-for": "10.212.0.1" },
        remoteAddress: "10.212.0.1",
        payload: { email: e.email },
      });
      statuses.push(r.statusCode);
    }
    expect({ first20: statuses.slice(0, 20).every((s) => s !== 429), last: statuses[20] }).toEqual({
      first20: true,
      last: 429,
    });
  });
});
