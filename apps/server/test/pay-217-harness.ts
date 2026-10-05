/**
 * PAY-217 (former employees keep W-2-only sign-in through the (j)(6)
 * window) — payroll-calc-auditor test harness. Fail-first: written against
 * the PAY-208 head faad1d9 before the change exists. The coder may not edit
 * this file. Synthetic data only (re-uses the PAY-208 fixtures: contact
 * "W-2 Desk", SSN 900-00-0017, $5,000.00 monthly runs).
 *
 * Legal source, read 2026-10-05 from https://www.law.cornell.edu/cfr/text/26/31.6051-1
 *  (j)(6)  "Forms W-2 furnished on a Web site must be retained on the Web
 *          site through October 15 of the year following the calendar year
 *          to which the Forms W-2 relate (or the first business day after
 *          October 15, if October 15 falls on a Saturday, Sunday, or legal
 *          holiday)"; corrected forms: through that date "or the date 90
 *          days after the corrected forms are posted, whichever is later."
 *  (j)(5)(iii) a correction of a W-2 furnished electronically is furnished
 *          electronically, with the notice within 30 days of posting.
 * Window dates in these tests come from the auditor's own oracle
 * (Python, datetime only; Columbus Day = 2nd Monday of October), not from
 * electronicW2AccessThrough:
 *   TY2026 -> 2027-10-15 (Fri)    TY2027 -> 2028-10-16 (Oct 15 = Sun)
 *   TY2032 -> 2033-10-17 (Oct 15 = Sat)
 *   corrected 2027-09-01 -> 2027-11-30;  corrected 2027-05-01 -> 2027-10-15
 *   corrected 2027-11-10 -> 2028-02-08;  corrected 2027-01-10 (TY2025) -> 2027-04-10
 *   corrected 2027-01-03 (TY2025) -> 2027-04-03;  corrected 2027-03-01 -> 2027-10-15
 *   (90 days = 2027-05-30, earlier than Oct 15). The 90-day date is not
 *   rolled for weekends: the regulation rolls only the October 15 date.
 *
 * Product decisions in force (brief /private/tmp/wagon-pay217-brief.md,
 * "Product Lead decisions" + "Federal SME ruling on OD-2", 2026-10-05):
 * OD-3 W-2s only; /change-password refused; OD-2 = SME option (c): R1-R6
 * (a correction of a year furnished online is posted online to a former
 * employee + IMPORTANT notice, ALSO paper; no hash gate, no w2_on_paper,
 * no onPaper); OD-1 UNDECIDED -> tested behind the explicit job option
 * `restoreTerminatedBans` (both answers).
 *
 * Company time zone for every PAY-217 test: America/Chicago (UTC-5 in
 * CDT, mid-March to early November; UTC-6 otherwise), so a UTC-vs-local
 * slip moves a window edge by a day and fails.
 */

import { and, eq } from "drizzle-orm";
import { auditEvents, authEvents, authSession, authUser, employees } from "@payroll/db";
import { sendW2AvailableNotices } from "../src/filings/annual.js";
import { furnishCorrectionIfNeeded } from "../src/filings/w2-furnish.js";
import { ORIGIN } from "./helpers.js";
import { currentTotp, sessionHeader, TEST_PASSWORD, tokenFromLink } from "./flow-helpers.js";
import {
  type Any,
  boot,
  call,
  deps,
  type Emp,
  type Env,
  makeEmp,
  NEW_VERSION,
  reloginAdmin,
  seedContact,
} from "./pay-208-harness.js";

export * from "./pay-208-harness.js";

export const TZ = "America/Chicago";

/**
 * Fresh app, company time zone America/Chicago, W-2 contact on file.
 *
 * Test-only clock pin: w2_furnishings.furnished_at defaults to the
 * database now(), and PGlite's now() is the REAL clock, not the faked one.
 * A (j)(6) window depends on the posting date of a corrected portal_notice,
 * so a trigger replaces a defaulted furnished_at with the faked clock kept
 * in pay217_clock (moveTo updates it). Explicit furnished_at values (rows
 * the tests insert) are kept as given.
 */
export async function boot217(now: string): Promise<Env> {
  const env = await boot({ now, config: { appTz: TZ } });
  await env.t.pglite.exec(`
    CREATE TABLE pay217_clock (now timestamptz NOT NULL);
    CREATE FUNCTION pay217_furnished_at() RETURNS trigger AS $$
    BEGIN
      IF NEW.furnished_at = now() THEN
        NEW.furnished_at := (SELECT c.now FROM pay217_clock c LIMIT 1);
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
    CREATE TRIGGER pay217_furnished_at BEFORE INSERT ON w2_furnishings
      FOR EACH ROW EXECUTE FUNCTION pay217_furnished_at();
  `);
  await env.t.pglite.query("INSERT INTO pay217_clock (now) VALUES ($1)", [now]);
  const st = await seedContact(env);
  if (st !== 200) throw new Error(`seed contact ${st}`);
  return env;
}

/** Move the faked clock (Date and the furnished_at pin together). */
export async function moveTo(env: Env, iso: string): Promise<void> {
  env.setNow(iso);
  await env.t.pglite.query("UPDATE pay217_clock SET now = $1", [iso]);
}

let ipSeq = 0;
export function freshIp(): string {
  ipSeq += 1;
  return `10.217.${Math.floor(ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;
}

/**
 * A consenting (2026-10 terms) W-2 employee with a login and twelve
 * $5,000.00 runs per year in `years` (default [2026]).
 */
export async function consenter(
  env: Env,
  label: string,
  years: readonly number[] = [2026],
): Promise<Emp> {
  return makeEmp(env, { label, login: true, consent: NEW_VERSION, years });
}

/** The January year notice (portal_notice for consenters = furnished online). */
export async function yearNotice(env: Env, today = "2027-01-04"): Promise<void> {
  await sendW2AvailableNotices(deps(env), { today });
}

/** POST /api/admin/employees/:id/status, re-signing the admin in after a clock jump. */
export async function setStatus(
  env: Env,
  emp: Emp,
  status: "active" | "terminated",
  terminationDate?: string,
) {
  const send = () =>
    call(env, "POST", `/api/admin/employees/${emp.id}/status`, env.admin, {
      status,
      ...(terminationDate ? { terminationDate } : {}),
    });
  let res = await send();
  if (res.statusCode === 401) {
    await reloginAdmin(env);
    res = await send();
  }
  return res;
}

/** Terminate through the admin route; throws on a non-200. */
export async function terminate(env: Env, emp: Emp, terminationDate?: string) {
  const res = await setStatus(env, emp, "terminated", terminationDate);
  if (res.statusCode !== 200) throw new Error(`terminate ${res.statusCode}: ${res.body}`);
  return res;
}

/** Admin GET with a re-sign-in after a clock jump. */
export async function adminCall(
  env: Env,
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  payload?: unknown,
) {
  let res = await call(env, method, url, env.admin, payload);
  if (res.statusCode === 401) {
    await reloginAdmin(env);
    res = await call(env, method, url, env.admin, payload);
  }
  return res;
}

export interface SignInResult {
  /** HTTP status of the password step, or of the TOTP step when the password step passed. */
  status: number;
  /** Better Auth error code of a refused step (e.g. BANNED_USER), else null. */
  code: string | null;
  session: Record<string, string> | null;
}

/** Password + TOTP sign-in from a fresh client address; never throws. */
export async function signIn(env: Env, email: string): Promise<SignInResult> {
  env.tick();
  const ip = freshIp();
  const headers = { ...ORIGIN, "x-forwarded-for": ip };
  const pw = await env.t.app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers,
    remoteAddress: ip,
    payload: { email, password: TEST_PASSWORD },
  });
  const codeOf = (body: string): string | null => {
    try {
      return ((JSON.parse(body) as { code?: string }).code ?? null) || null;
    } catch {
      return null;
    }
  };
  if (pw.statusCode !== 200) return { status: pw.statusCode, code: codeOf(pw.body), session: null };
  const setCookie = pw.headers["set-cookie"];
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const tf = list.map((c) => c.split(";")[0]!).find((c) => c.startsWith("payroll.two_factor="));
  if (!tf) return { status: 500, code: "no_two_factor_challenge", session: null };
  const userRows = await env.t.db
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.email, email.toLowerCase()));
  const code = await currentTotp(env.t, userRows[0]!.id);
  const v = await env.t.app.inject({
    method: "POST",
    url: "/api/auth/two-factor/verify-totp",
    headers: { ...headers, cookie: tf },
    remoteAddress: ip,
    payload: { code },
  });
  if (v.statusCode !== 200) return { status: v.statusCode, code: codeOf(v.body), session: null };
  const vc = v.headers["set-cookie"];
  const vlist = Array.isArray(vc) ? vc : vc ? [vc] : [];
  const tok = vlist
    .map((c) => c.split(";")[0]!)
    .find((c) => c.startsWith("payroll.session_token="));
  if (!tok) return { status: 500, code: "no_session_cookie", session: null };
  return {
    status: 200,
    code: null,
    session: sessionHeader(decodeURIComponent(tok.slice("payroll.session_token=".length))),
  };
}

/** Sign in or throw (setup helper). Updates emp.session. */
export async function mustSignIn(env: Env, emp: Emp): Promise<Record<string, string>> {
  const r = await signIn(env, emp.email!);
  if (!r.session) throw new Error(`sign-in refused (${r.status} ${r.code ?? ""})`);
  emp.session = r.session;
  return r.session;
}

export async function userRow(env: Env, userId: string) {
  const rows = await env.t.db.select().from(authUser).where(eq(authUser.id, userId));
  const u = rows[0]!;
  return {
    banned: Boolean(u.banned),
    banReason: u.banReason ?? null,
    twoFactorEnabled: Boolean(u.twoFactorEnabled),
  };
}

export async function sessionCount(env: Env, userId: string): Promise<number> {
  const rows = await env.t.db
    .select({ id: authSession.id })
    .from(authSession)
    .where(eq(authSession.userId, userId));
  return rows.length;
}

export async function authEventCount(env: Env, userId: string, event: string): Promise<number> {
  const rows = await env.t.db
    .select({ id: authEvents.id })
    .from(authEvents)
    .where(and(eq(authEvents.userId, userId), eq(authEvents.event, event)));
  return rows.length;
}

export async function auditFor(env: Env, action: string, employeeId: number) {
  return env.t.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.entityId, String(employeeId))))
    .orderBy(auditEvents.id);
}

/** Ban directly (simulates lockout / a pre-release termination ban). */
export async function setBan(env: Env, userId: string, banReason: string | null): Promise<void> {
  await env.t.db
    .update(authUser)
    .set({ banned: banReason !== null, banReason })
    .where(eq(authUser.id, userId));
}

/**
 * The employee row only (no auth change): status 'terminated'. PAY-217 D217-1
 * C derives W-2-only access from employees.status per request, so the guard
 * tests set the data state directly and do not depend on the termination
 * route (tested on its own in the lifecycle file).
 */
export async function markTerminatedRow(
  env: Env,
  emp: Emp,
  terminationDate: string,
): Promise<void> {
  await env.t.db
    .update(employees)
    .set({ status: "terminated", terminationDate })
    .where(eq(employees.id, emp.id));
}

/** A w2_furnishings row inserted as the previous release would have written it. */
export async function insertFurnishing(
  env: Env,
  employeeId: number,
  taxYear: number,
  o: { method?: string; corrected?: boolean; at: string; hash?: string },
): Promise<void> {
  await env.t.pglite.query(
    `INSERT INTO w2_furnishings (employee_id, tax_year, boxes_hash, hash_version, corrected, method, furnished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      employeeId,
      taxYear,
      o.hash ?? "e".repeat(64),
      taxYear >= 2026 ? 2 : 1,
      o.corrected ?? false,
      o.method ?? "portal_notice",
      o.at,
    ],
  );
}

export async function me(env: Env, headers: Record<string, string>) {
  return env.t.app.inject({ method: "GET", url: "/api/me", headers });
}

export function errorOf(res: { body: string }): string | null {
  try {
    return (JSON.parse(res.body) as { error?: string }).error ?? null;
  } catch {
    return null;
  }
}

/** furnishCorrectionIfNeeded under the employee's own transaction (as the daily reconcile runs it). */
export async function correct(env: Env, employeeId: number, year: number, today: string) {
  return env.t.db.transaction((tx) =>
    furnishCorrectionIfNeeded(tx as never, env.t.config, employeeId, year, today),
  );
}

/** Admin password reset + full re-enrollment through the onboarding routes. */
export async function resetAndReenroll(env: Env, emp: Emp) {
  const res = await adminCall(env, "POST", `/api/admin/users/${emp.userId}/reset`, {});
  if (res.statusCode !== 200) return { reset: res.statusCode, error: errorOf(res), done: false };
  const token = tokenFromLink((res.json() as { setupLink: string }).setupLink);
  const ip = freshIp();
  const headers = { ...ORIGIN, "x-forwarded-for": ip };
  const step = async (url: string, payload: Record<string, unknown>) =>
    (await env.t.app.inject({ method: "POST", url, headers, remoteAddress: ip, payload }))
      .statusCode;
  const steps = [
    await step("/api/onboarding/verify-token", { token }),
    await step("/api/onboarding/set-password", { token, password: TEST_PASSWORD }),
    await step("/api/onboarding/totp-enable", { token }),
  ];
  steps.push(
    await step("/api/onboarding/totp-verify", {
      token,
      code: await currentTotp(env.t, emp.userId!),
    }),
  );
  return { reset: 200, error: null, done: steps.every((s) => s === 200) };
}

/**
 * The PAY-217 module under test (contract): apps/server/src/auth/former-employee.ts
 *  - formerEmployeeAccess(db, userId, today, appTz)
 *      -> { kind: "full" } | { kind: "w2_only", years, accessThrough } | { kind: "none" }
 *  - syncFormerEmployeeLogins({ db, config }, { today?, restoreTerminatedBans? })
 *      -> counts; restoreTerminatedBans defaults to RESTORE_TERMINATED_BANS
 *  - RESTORE_TERMINATED_BANS: boolean (OD-1, set from Neil's answer)
 * Loaded lazily so a missing module fails each test on its own.
 */
export async function formerModule(): Promise<Record<string, Any>> {
  const path = new URL("../src/auth/former-employee.ts", import.meta.url).pathname;
  return (await import(/* @vite-ignore */ path)) as Record<string, Any>;
}
