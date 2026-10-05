/**
 * PAY-217: former employees keep W-2-only sign-in through the (j)(6) window.
 *
 * 26 CFR 31.6051-1(j)(6): a W-2 furnished on a website stays there through
 * October 15 of the year after the tax year (next business day on a
 * weekend or legal holiday), or 90 days after a corrected W-2 is posted
 * when later. There is no exception for employees whose job ended, so a
 * terminated employee with a W-2 still inside that window keeps a login
 * that reaches the W-2 card and nothing else.
 *
 * The scope is DERIVED on every request (brief D217-1 option C) from
 * employees.status and w2_furnishings — nothing is stored, so an unlock, a
 * reset, onboarding or a role change can never widen it, and the window
 * closes on time even when the daily job has not run (fail closed):
 *   - no employees row for the user, or status 'active' → full
 *   - 'terminated' with a year furnished online still in its window → w2_only
 *   - 'terminated' otherwise → none
 * It applies whatever the user's role is.
 *
 * The ban stays the sign-in switch (Better Auth refuses a banned user when
 * the session is created). syncFormerEmployeeLogins, run daily, turns a
 * closed window into a sign-in refusal (ban "w2_access_ended") and lifts
 * that ban again when a later correction re-opens a window (SME R4).
 */

import { and, eq, isNotNull } from "drizzle-orm";
import { auditEvents, authEvents, authSession, authUser, employees } from "@payroll/db";
import type { AppConfig } from "../config.js";
import type { Db } from "../db.js";
import { onlineW2Windows } from "../filings/w2-consent.js";
import { errorClass } from "../filings/shared.js";
import { localDate } from "../payroll/run-dates.js";
import { AUTH_EVENT } from "./audit.js";

/**
 * OD-1 (Neil, 2026-10-05): logins banned "employee_terminated" before this
 * release are NOT re-opened by the daily job. The job option stays (tested
 * both ways) so the answer can change without new machinery.
 */
export const RESTORE_TERMINATED_BANS = false;

/** The ban reason the daily job writes when the last window closed. */
export const W2_ACCESS_ENDED = "w2_access_ended";
/** The ban reason the termination route writes when no window is open. */
export const EMPLOYEE_TERMINATED = "employee_terminated";
/** Bans the rehire route and the job may lift; any other ban stays. */
export const TERMINATION_BAN_REASONS: ReadonlySet<string> = new Set([
  EMPLOYEE_TERMINATED,
  W2_ACCESS_ENDED,
]);

export interface W2Window {
  taxYear: number;
  /** Company-local ISO date: the last day the year stays online. */
  accessThrough: string;
}

export type FormerEmployeeAccess =
  | { kind: "full" }
  | { kind: "w2_only"; years: W2Window[]; accessThrough: string }
  | { kind: "none" };

type ReadDb = Pick<Db, "select">;

/** The latest of the windows' last days (ISO dates compare as strings). */
function latestThrough(years: readonly W2Window[]): string {
  return years.reduce((max, y) => (y.accessThrough > max ? y.accessThrough : max), "");
}

/**
 * The access of one employees row on `today` (company-local): full while
 * active; for a terminated row, w2_only while a year furnished online is
 * inside its window, else none.
 */
export async function employeeW2Access(
  db: ReadDb,
  employee: { id: number; status: string },
  today: string,
  appTz: string,
): Promise<FormerEmployeeAccess> {
  if (employee.status !== "terminated") return { kind: "full" };
  const years = await onlineW2Windows(db, employee.id, today, appTz);
  if (years.length === 0) return { kind: "none" };
  return { kind: "w2_only", years, accessThrough: latestThrough(years) };
}

/** The access of a session user (brief §3 D217-1): see the module comment. */
export async function formerEmployeeAccess(
  db: ReadDb,
  userId: string,
  today: string,
  appTz: string,
): Promise<FormerEmployeeAccess> {
  const rows = await db
    .select({ id: employees.id, status: employees.status })
    .from(employees)
    .where(eq(employees.userId, userId))
    .limit(1);
  const employee = rows[0];
  if (!employee) return { kind: "full" };
  return employeeW2Access(db, employee, today, appTz);
}

/** The admin view of one employee: null unless terminated with an open window. */
export async function formerW2AccessOf(
  db: ReadDb,
  employee: { id: number; status: string },
  today: string,
  appTz: string,
): Promise<{ accessThrough: string; years: number[] } | null> {
  const access = await employeeW2Access(db, employee, today, appTz);
  if (access.kind !== "w2_only") return null;
  return { accessThrough: access.accessThrough, years: access.years.map((y) => y.taxYear) };
}

// ---------------------------------------------------------------------------
// Daily job
// ---------------------------------------------------------------------------

export interface SyncResult {
  checked: number;
  ended: number;
  restored: number;
  failed: number;
}

type Change = "ended" | "restored" | null;

/** What the job does for one former employee's login (brief §4.4 + SME R4). */
function changeFor(
  access: FormerEmployeeAccess,
  user: { banned: boolean | null; banReason: string | null },
  restoreTerminatedBans: boolean,
): Change {
  if (access.kind === "none") return user.banned ? null : "ended";
  if (access.kind !== "w2_only" || !user.banned) return null;
  if (user.banReason === W2_ACCESS_ENDED) return "restored";
  if (user.banReason === EMPLOYEE_TERMINATED && restoreTerminatedBans) return "restored";
  return null;
}

/** Apply one change in its own transaction (ban + sessions + events, or unban + events). */
async function applyChange(
  db: Db,
  employeeId: number,
  userId: string,
  change: "ended" | "restored",
): Promise<void> {
  await db.transaction(async (tx) => {
    if (change === "ended") {
      await tx
        .update(authUser)
        .set({ banned: true, banReason: W2_ACCESS_ENDED, updatedAt: new Date() })
        .where(eq(authUser.id, userId));
      await tx.delete(authSession).where(eq(authSession.userId, userId));
    } else {
      await tx
        .update(authUser)
        .set({ banned: false, banReason: null, updatedAt: new Date() })
        .where(eq(authUser.id, userId));
    }
    await tx.insert(authEvents).values({
      userId,
      event: change === "ended" ? AUTH_EVENT.userDisabled : AUTH_EVENT.userEnabled,
      ip: null,
      userAgent: null,
    });
    await tx.insert(auditEvents).values({
      actorId: "scheduler",
      action: change === "ended" ? "employee.w2_access_ended" : "employee.w2_access_restored",
      entity: "employee",
      entityId: String(employeeId),
      before: null,
      after: change === "ended" ? { banReason: W2_ACCESS_ENDED } : { banReason: null },
    });
  });
}

/**
 * Daily (annualTick, after reconcileW2Furnishings): for every terminated
 * employee with a login, company-local today —
 *   none, not banned              → ban "w2_access_ended", sessions deleted,
 *                                   auth_events user_disabled, audit
 *                                   employee.w2_access_ended
 *   w2_only, banned w2_access_ended → unban (a correction re-opened a
 *                                   window, SME R4), user_enabled, audit
 *                                   employee.w2_access_restored
 *   w2_only, banned employee_terminated → the same only when
 *                                   restoreTerminatedBans (OD-1)
 * A lockout or pending_enrollment ban is never lifted; active employees are
 * never read. Idempotent. One failing employee is logged by error class
 * only and skipped; the log carries counts, never a name, address or id.
 */
export async function syncFormerEmployeeLogins(
  deps: { db: Db; config: AppConfig },
  opts: { today?: string; restoreTerminatedBans?: boolean } = {},
): Promise<SyncResult> {
  const { db, config } = deps;
  const today = opts.today ?? localDate(new Date(), config.appTz);
  const restore = opts.restoreTerminatedBans ?? RESTORE_TERMINATED_BANS;
  const rows = await db
    .select({
      employeeId: employees.id,
      status: employees.status,
      userId: authUser.id,
      banned: authUser.banned,
      banReason: authUser.banReason,
    })
    .from(employees)
    .innerJoin(authUser, eq(authUser.id, employees.userId))
    .where(and(eq(employees.status, "terminated"), isNotNull(employees.userId)))
    .orderBy(employees.id);
  const out: SyncResult = { checked: 0, ended: 0, restored: 0, failed: 0 };
  for (const r of rows) {
    out.checked += 1;
    try {
      const access = await employeeW2Access(
        db,
        { id: r.employeeId, status: r.status },
        today,
        config.appTz,
      );
      const change = changeFor(access, r, restore);
      if (change === null) continue;
      await applyChange(db, r.employeeId, r.userId, change);
      out[change] += 1;
    } catch (err) {
      out.failed += 1;
      console.error(
        `[auth] former-employee sign-in sync: one employee failed (${errorClass(err)})`,
      );
    }
  }
  return out;
}

/** True when the user's employee is terminated with no open window (reset/unlock refusal, brief §4.5). */
export async function w2AccessEnded(
  db: ReadDb,
  userId: string,
  today: string,
  appTz: string,
): Promise<boolean> {
  return (await formerEmployeeAccess(db, userId, today, appTz)).kind === "none";
}
