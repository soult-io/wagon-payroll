/**
 * PAY-103 R18 PR-5a: the missing-tax-tables alert (server half).
 * payroll-calc-auditor, fail-first; the coder may not edit this file.
 *
 * Contract assumed (build brief §4.2–§4.4, §5 S1–S7; Product Lead decisions
 * 2026-10-06 incl. round 2 and the final copy):
 *
 *   apps/server/src/payroll/tax-alert.ts
 *     coverageYears(today: "YYYY-MM-DD"): number[]
 *       [Y], plus Y+1 when today.slice(5) >= "12-01". Shared with the endpoint.
 *     reportMissingTaxTables(db, config, { year, jurisdictions, today })
 *       → { reported: string[] }   newly reported codes, "federal" first then
 *       USPS codes sorted. Dedupe: audit_events action "tax_tables.missing",
 *       entity "tax_tables", entity_id "<year>:<code>", actor "scheduler",
 *       before null, after { year, jurisdiction, day }. One email per call
 *       per year naming the newly reported jurisdictions, one outbox row
 *       (event_type "tax_tables_missing") per non-banned admin. Zero admins:
 *       audit rows only.
 *     checkTaxTableCoverage({ db, config }, { now: Date })
 *       → { checked: number[]; reported: { year; jurisdictions: string[] }[] }
 *       today = localDate(now, config.appTz); years = coverageYears(today);
 *       when = "upcoming" for year > Y, else "current".
 *   apps/server/src/payroll/scheduler.ts
 *     draftTick({ db, config }, { now: Date }) → { period: {year, month,
 *       periodStart} | null, jobs: {employeeId, year, month, singletonKey}[],
 *       missing: {year, federal, missingStates} | null }
 *       Period from localDate(now, appTz). Coverage of the pay-date year.
 *       Federal missing → jobs [] + alert + log "[payroll] draft tick: <Y>
 *       federal tax tables not installed; no drafts generated (<n> employees)".
 *       States missing → alert for them, jobs = every W-2 employee.
 *       Alert failure → logged by error class, draftTick still resolves.
 *   Email (final copy, /private/tmp/wagon-pay103-copy.md): subject pinned
 *   exactly; body asserted by keywords. Display list: "federal" first,
 *   lowercase, then state names sorted by NAME (dedupe keys stay by code).
 *
 * Fixture: seedDatabase (federal + IL 2025/2026, monthly schedule, autoDraft
 * on), admins A + B, banned admin C, a pending-enrollment admin D (banned
 * until onboarding), one employee user; synthetic active W-2 workers paid
 * since 2024: an IL worker and a no-work-state worker. 2027 tables are the
 * SYNTHETIC test-only fixtures (fixtures/synthetic-2027.ts). Synthetic data
 * only; no prod rows.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, asc, eq, isNull } from "drizzle-orm";
import {
  auditEvents,
  authUser,
  company,
  compensation,
  emailOutbox,
  employees,
  employeeWorkStates,
  notificationSettings,
  payrollRuns,
  paySchedules,
  seedDatabase,
  type SeedDb,
} from "@payroll/db";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db.js";
import { companyName, drainOutbox } from "../src/notify/outbox.js";
import { generateDraftsForPeriod } from "../src/payroll/runs.js";
import { inviteUser } from "../src/auth/users.js";
import { seedSyntheticFederal2027 } from "./fixtures/synthetic-2027.js";
import { createTestApp, ORIGIN, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";

// ---------------------------------------------------------------------------
// Contract loaders (the modules/exports do not exist on f74b51b)
// ---------------------------------------------------------------------------

interface Deps {
  db: Db;
  config: AppConfig;
}
interface TickResult {
  period: { year: number; month: number; periodStart: string } | null;
  jobs: { employeeId: number; year: number; month: number; singletonKey: string }[];
  missing: { year: number; federal: boolean; missingStates: string[] } | null;
}
interface CheckResult {
  checked: number[];
  reported: { year: number; jurisdictions: string[] }[];
}
interface TaxAlertModule {
  coverageYears(today: string): number[];
  reportMissingTaxTables(
    db: Db,
    config: AppConfig,
    input: { year: number; jurisdictions: string[]; today: string },
  ): Promise<{ reported: string[] }>;
  checkTaxTableCoverage(deps: Deps, opts: { now: Date }): Promise<CheckResult>;
}

async function taxAlert(): Promise<TaxAlertModule> {
  return (await import("../src/payroll/tax-alert.js")) as unknown as TaxAlertModule;
}

async function draftTick(deps: Deps, now: string): Promise<TickResult> {
  const mod = (await import("../src/payroll/scheduler.js")) as unknown as Record<string, unknown>;
  if (typeof mod.draftTick !== "function") {
    throw new Error("scheduler.ts does not export draftTick (PAY-103 R18 §4.3)");
  }
  return (mod.draftTick as (d: Deps, o: { now: Date }) => Promise<TickResult>)(deps, {
    now: new Date(now),
  });
}

async function check(deps: Deps, now: string): Promise<CheckResult> {
  return (await taxAlert()).checkTaxTableCoverage(deps, { now: new Date(now) });
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const IL_WORKER = "Synthetic Alert Illinois Worker";
const NO_STATE_WORKER = "Synthetic Alert Nostate Worker";
const NY_WORKER = "Synthetic Alert Newyork Worker";
const IA_WORKER = "Synthetic Alert Iowa Worker";
const ID_WORKER = "Synthetic Alert Idaho Worker";
const TERMINATED_WORKER = "Synthetic Alert Terminated Worker";
const CONTRACTOR = "Synthetic Alert Contractor";
const ADMIN_NAMES = [
  "Alertadmin Alpha",
  "Alertadmin Bravo",
  "Alertadmin Charlie",
  "Alertadmin Delta",
];
const LEGAL_NAMES = [
  IL_WORKER,
  NO_STATE_WORKER,
  NY_WORKER,
  IA_WORKER,
  ID_WORKER,
  TERMINATED_WORKER,
  CONTRACTOR,
  ...ADMIN_NAMES,
];

/** Everything an alert produced, for S7 (no PII / no manual-entry pointer). */
const ARTIFACTS = { subjects: [] as string[], bodies: [] as string[], logs: [] as string[] };

async function addWorker(
  t: TestContext,
  name: string,
  state: string | null,
  opts: { status?: "active" | "terminated"; type?: "w2" | "1099" } = {},
): Promise<number> {
  const c = await t.db.select({ id: company.id }).from(company).limit(1);
  if (!c[0]) throw new Error("seedDatabase did not create a company");
  const [row] = await t.db
    .insert(employees)
    .values({
      companyId: c[0].id,
      employmentType: opts.type ?? "w2",
      legalName: name,
      hireDate: "2024-01-01",
      status: opts.status ?? "active",
      ...(opts.status === "terminated" ? { terminationDate: "2025-06-30" } : {}),
    })
    .returning({ id: employees.id });
  if (!row) throw new Error("employee insert returned nothing");
  await t.db.insert(compensation).values({
    employeeId: row.id,
    periodAmount: "4000.00",
    frequency: "monthly",
    effectiveFrom: "2024-01-01",
    effectiveTo: null,
  });
  if (state) {
    await t.db.insert(employeeWorkStates).values({
      employeeId: row.id,
      stateCode: state,
      effectiveFrom: "2024-01-01",
      effectiveTo: null,
    });
  }
  return row.id;
}

interface Fixture {
  t: TestContext;
  deps: Deps;
  company: string;
  ilId: number;
  noStateId: number;
  admins: { a: string; b: string; c: string; d: string };
  adminEmails: { a: string; b: string };
  employeeEmail: string;
  setNow: (iso: string) => void;
}

let seq = 0;

async function boot(opts: { admins?: boolean } = {}): Promise<Fixture> {
  seq += 1;
  let now = new Date("2027-01-02T12:00:00Z");
  const t = await createTestApp({ appTz: "Europe/Madrid", emailMode: "log" }, { clock: () => now });
  await seedDatabase(t.db as unknown as SeedDb);
  const ilId = await addWorker(t, IL_WORKER, "IL");
  const noStateId = await addWorker(t, NO_STATE_WORKER, null);
  const admins = { a: "", b: "", c: "", d: "" };
  const adminEmails = { a: `alert-a-${seq}@example.com`, b: `alert-b-${seq}@example.com` };
  if (opts.admins !== false) {
    admins.a = (
      await inviteAndOnboard(t, { email: adminEmails.a, name: ADMIN_NAMES[0], role: "admin" })
    ).userId;
    admins.b = (
      await inviteAndOnboard(t, { email: adminEmails.b, name: ADMIN_NAMES[1], role: "admin" })
    ).userId;
    admins.c = (
      await inviteAndOnboard(t, {
        email: `alert-c-${seq}@example.com`,
        name: ADMIN_NAMES[2],
        role: "admin",
      })
    ).userId;
    await t.db.update(authUser).set({ banned: true }).where(eq(authUser.id, admins.c));
    // Pending enrollment: invited, never onboarded (banned until then).
    admins.d = (
      await inviteUser(
        { auth: t.auth, db: t.db, config: t.config },
        { name: ADMIN_NAMES[3]!, email: `alert-d-${seq}@example.com`, role: "admin" },
        null,
      )
    ).userId;
  }
  const employeeEmail = `alert-employee-${seq}@example.com`;
  await inviteAndOnboard(t, { email: employeeEmail, role: "employee" });
  return {
    t,
    deps: { db: t.db, config: t.config },
    company: await companyName(t.db),
    ilId,
    noStateId,
    admins,
    adminEmails,
    employeeEmail,
    setNow: (iso) => {
      now = new Date(iso);
    },
  };
}

async function alertAudit(t: TestContext) {
  return t.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.action, "tax_tables.missing"))
    .orderBy(asc(auditEvents.id));
}

async function alertMail(t: TestContext) {
  const rows = await t.db
    .select()
    .from(emailOutbox)
    .where(eq(emailOutbox.eventType, "tax_tables_missing"))
    .orderBy(asc(emailOutbox.id));
  for (const r of rows) {
    ARTIFACTS.subjects.push(r.subject);
    ARTIFACTS.bodies.push(r.bodyHtml);
  }
  return rows;
}

function plain(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#39;", "'")
    .replaceAll("&rsquo;", "'")
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ");
}

/** Capture console.log/warn/error lines written while `fn` runs. */
async function withLogs<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const spies = (["log", "warn", "error", "info"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      lines.push(
        a.map((x) => (x instanceof Error ? `${x.name}: ${x.message}` : String(x))).join(" "),
      );
    }),
  );
  try {
    const value = await fn();
    return { value, lines };
  } finally {
    for (const s of spies) s.mockRestore();
    ARTIFACTS.logs.push(...lines);
  }
}

const SUBJECT = {
  upcoming: (co: string, y: number) => `${co} — ${y} tax tables aren't installed yet`,
  currentFederal: (co: string, y: number) =>
    `${co} — ${y} payroll is on hold: tax tables not installed`,
  currentStates: (co: string, y: number, states: string) =>
    `${co} — ${y} payroll is on hold for employees in ${states}`,
};

const sortIds = (ids: string[]) => [...ids].sort();

// ---------------------------------------------------------------------------
// coverageYears (shared with the endpoint)
// ---------------------------------------------------------------------------

describe("coverageYears(today) — one rule for the endpoint and the daily check", () => {
  it("CY1 before Dec 1 → [Y]; Dec 1..31 → [Y, Y+1]; Jan 1 → [Y]", async () => {
    const { coverageYears } = await taxAlert();
    expect(coverageYears("2026-11-30")).toEqual([2026]);
    expect(coverageYears("2026-12-01")).toEqual([2026, 2027]);
    expect(coverageYears("2026-12-31")).toEqual([2026, 2027]);
    expect(coverageYears("2027-01-01")).toEqual([2027]);
    expect(coverageYears("2027-06-15")).toEqual([2027]);
  });
});

// ---------------------------------------------------------------------------
// S1 / S1b / S6: draft tick with no 2027 tables
// ---------------------------------------------------------------------------

describe("S1 draft tick, 2027-01-15 09:12 Madrid, bundled tables only", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await boot();
  }, 180_000);
  afterAll(async () => f.t.close());

  it("S1 no jobs; alert federal + IL once; one email per admin; no runs; no throw", async () => {
    const { value: r, lines } = await withLogs(() => draftTick(f.deps, "2027-01-15T08:12:00Z"));
    expect(r.period).toEqual({ year: 2027, month: 1, periodStart: "2027-01-01" });
    expect(r.jobs).toEqual([]);
    expect(r.missing).toEqual({ year: 2027, federal: false, missingStates: ["IL"] });

    const audit = await alertAudit(f.t);
    expect(audit.map((a) => a.entityId).sort()).toEqual(["2027:IL", "2027:federal"]);
    for (const a of audit) {
      expect(a.actorId).toBe("scheduler");
      expect(a.entity).toBe("tax_tables");
      expect(a.before).toBeNull();
      expect(a.after).toEqual({
        year: 2027,
        jurisdiction: a.entityId.slice(5),
        day: "2027-01-15",
      });
    }

    const mail = await alertMail(f.t);
    expect(sortIds(mail.map((m) => m.userId))).toEqual(sortIds([f.admins.a, f.admins.b]));
    for (const m of mail) {
      expect(m.status).toBe("pending");
      expect(m.subject).toBe(SUBJECT.currentFederal(f.company, 2027));
      const body = plain(m.bodyHtml);
      expect(body).toContain("2027 federal and Illinois tax tables");
      expect(body).toContain("no new payroll drafts will appear");
    }

    expect(await f.t.db.select().from(payrollRuns)).toEqual([]);
    expect(
      lines.some((l) =>
        /^\[payroll\] draft tick: 2027 federal tax tables not installed; no drafts generated \(\d+ employees?\)/.test(
          l,
        ),
      ),
      lines.join("\n"),
    ).toBe(true);
    expect(lines.some((l) => l.startsWith("[tax-tables] 2027 missing:"))).toBe(true);
  });

  it("S1b re-tick same instant and next day → no new audit or outbox rows", async () => {
    const auditBefore = (await alertAudit(f.t)).length;
    const mailBefore = (await alertMail(f.t)).length;
    const again = await draftTick(f.deps, "2027-01-15T08:12:00Z");
    expect(again.jobs).toEqual([]);
    expect(again.missing).toEqual({ year: 2027, federal: false, missingStates: ["IL"] });
    await draftTick(f.deps, "2027-01-16T08:12:00Z");
    // The daily check shares the dedupe with the draft tick.
    const daily = await check(f.deps, "2027-01-16T06:41:00Z");
    expect(daily.checked).toEqual([2027]);
    expect(daily.reported.flatMap((r) => r.jurisdictions)).toEqual([]);
    expect((await alertAudit(f.t)).length).toBe(auditBefore);
    expect((await alertMail(f.t)).length).toBe(mailBefore);
  });

  it("S6 banned admin and pending-enrollment admin get no outbox row", async () => {
    const recipients = new Set((await alertMail(f.t)).map((m) => m.userId));
    expect(recipients.has(f.admins.c)).toBe(false);
    expect(recipients.has(f.admins.d)).toBe(false);
    expect(recipients.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// S1c: an alert failure never fails the tick and does not burn the dedupe
// ---------------------------------------------------------------------------

class SyntheticOutboxFailure extends Error {}

/** Test-only db wrapper: insert(emailOutbox) rejects, at any transaction depth. */
function failingOutboxDb(db: Db): Db {
  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(obj, prop) {
        if (prop === "insert") {
          return (table: unknown) => {
            if (table === emailOutbox) throw new SyntheticOutboxFailure("synthetic outbox failure");
            return (obj as unknown as { insert: (t: unknown) => unknown }).insert(table);
          };
        }
        if (prop === "transaction") {
          return (fn: (tx: object) => unknown, ...rest: unknown[]) =>
            (obj as unknown as { transaction: (...a: unknown[]) => unknown }).transaction(
              (tx: object) => fn(wrap(tx)),
              ...rest,
            );
        }
        const v = Reflect.get(obj, prop, obj) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(obj) : v;
      },
    });
  return wrap(db as unknown as object) as unknown as Db;
}

describe("S1c outbox insert fails during the draft tick", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await boot();
  }, 180_000);
  afterAll(async () => f.t.close());

  it("S1c draftTick resolves, jobs [], failure logged by class only, no audit row kept", async () => {
    const failing = { db: failingOutboxDb(f.t.db), config: f.t.config };
    const { value: r, lines } = await withLogs(() => draftTick(failing, "2027-01-15T08:12:00Z"));
    expect(r.jobs).toEqual([]);
    const failureLines = lines.filter((l) => l.includes("SyntheticOutboxFailure"));
    expect(failureLines.length, lines.join("\n")).toBeGreaterThanOrEqual(1);
    for (const l of failureLines) {
      for (const name of LEGAL_NAMES) expect(l).not.toContain(name);
      expect(l).not.toMatch(/\d+\.\d{2}/);
      expect(l).not.toContain("@");
      expect(l).not.toContain("synthetic outbox failure"); // class, not message
    }
    expect(await alertAudit(f.t)).toEqual([]);
    expect(await alertMail(f.t)).toEqual([]);
  });

  it("S1c-2 the next tick with a healthy outbox reports and mails (dedupe not burned)", async () => {
    await draftTick(f.deps, "2027-01-16T08:12:00Z");
    expect((await alertAudit(f.t)).map((a) => a.entityId).sort()).toEqual([
      "2027:IL",
      "2027:federal",
    ]);
    expect((await alertMail(f.t)).length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// S2: the daily check (current year; next year from Dec 1 APP_TZ)
// ---------------------------------------------------------------------------

describe("S2 daily check across Nov 30 → Dec 1 → Jan", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await boot();
  }, 180_000);
  afterAll(async () => f.t.close());

  it("S2 2026-11-30T12:00Z → checked [2026], nothing reported, no rows", async () => {
    const r = await check(f.deps, "2026-11-30T12:00:00Z");
    expect(r.checked).toEqual([2026]);
    expect(r.reported.flatMap((x) => x.jurisdictions)).toEqual([]);
    expect(await alertAudit(f.t)).toEqual([]);
    expect(await alertMail(f.t)).toEqual([]);
  });

  it("S2b 2026-11-30T23:30Z (Madrid Dec 1 00:30) → [2026, 2027]; upcoming email federal + Illinois", async () => {
    const { value: r, lines } = await withLogs(() => check(f.deps, "2026-11-30T23:30:00Z"));
    expect(r.checked).toEqual([2026, 2027]);
    expect(r.reported.filter((x) => x.jurisdictions.length > 0)).toEqual([
      { year: 2027, jurisdictions: ["federal", "IL"] },
    ]);
    const audit = await alertAudit(f.t);
    expect(audit.map((a) => a.entityId).sort()).toEqual(["2027:IL", "2027:federal"]);
    for (const a of audit) expect((a.after as { day: string }).day).toBe("2026-12-01");
    const mail = await alertMail(f.t);
    expect(sortIds(mail.map((m) => m.userId))).toEqual(sortIds([f.admins.a, f.admins.b]));
    for (const m of mail) {
      expect(m.subject).toBe(SUBJECT.upcoming(f.company, 2027));
      const body = plain(m.bodyHtml);
      expect(body).toContain("2027 federal and Illinois tax tables");
      expect(body).toContain("aren't installed yet");
      expect(body).toContain("Nothing changes for your 2026 payrolls");
    }
    expect(lines.some((l) => /^\[tax-tables\] 2027 missing: .*federal.*IL/.test(l))).toBe(true);
  });

  it("S2c 2026-12-02, 2026-12-15, 2027-01-02 → no new rows (dedupe across Dec→Jan)", async () => {
    const auditBefore = (await alertAudit(f.t)).length;
    const mailBefore = (await alertMail(f.t)).length;
    for (const now of ["2026-12-02T06:41:00Z", "2026-12-15T06:41:00Z", "2027-01-02T06:41:00Z"]) {
      const r = await check(f.deps, now);
      expect(
        r.reported.flatMap((x) => x.jurisdictions),
        now,
      ).toEqual([]);
    }
    expect((await check(f.deps, "2027-01-02T06:41:00Z")).checked).toEqual([2027]);
    expect((await alertAudit(f.t)).length).toBe(auditBefore);
    expect((await alertMail(f.t)).length).toBe(mailBefore);
  });

  it("S2d new NY worker while federal 2027 is still missing → federal wording naming New York; one audit row 2027:NY", async () => {
    // Product Lead round 3 (option a): template `federal` = "federal Y is
    // missing right now"; stateLabels = the newly reported states only.
    await addWorker(f.t, NY_WORKER, "NY");
    const auditBefore = await alertAudit(f.t);
    const mailBefore = (await alertMail(f.t)).length;
    const r = await check(f.deps, "2027-01-03T06:41:00Z");
    expect(r.reported.filter((x) => x.jurisdictions.length > 0)).toEqual([
      { year: 2027, jurisdictions: ["NY"] },
    ]);
    const auditAfter = await alertAudit(f.t);
    const newAudit = auditAfter.slice(auditBefore.length);
    expect(newAudit.map((a) => a.entityId)).toEqual(["2027:NY"]);
    expect(auditAfter.filter((a) => a.entityId === "2027:federal")).toHaveLength(1);
    const fresh = (await alertMail(f.t)).slice(mailBefore);
    expect(sortIds(fresh.map((m) => m.userId))).toEqual(sortIds([f.admins.a, f.admins.b]));
    for (const m of fresh) {
      expect(m.subject).toBe(SUBJECT.currentFederal(f.company, 2027));
      const body = plain(m.bodyHtml);
      expect(body).toContain("2027 federal and New York tax tables");
      expect(body).toContain("no new payroll drafts will appear");
      expect(body).not.toContain("Illinois");
      expect(body).not.toContain("Everyone else's payroll goes ahead");
    }
  });
});

describe("S2e daily check 2027-01-02 on a fresh DB (no December alert)", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await boot();
  }, 180_000);
  afterAll(async () => f.t.close());

  it("S2e one current-year email per admin, federal + Illinois", async () => {
    const r = await check(f.deps, "2027-01-02T12:00:00Z");
    expect(r.checked).toEqual([2027]);
    expect(r.reported.filter((x) => x.jurisdictions.length > 0)).toEqual([
      { year: 2027, jurisdictions: ["federal", "IL"] },
    ]);
    const mail = await alertMail(f.t);
    expect(mail).toHaveLength(2);
    for (const m of mail) {
      expect(m.subject).toBe(SUBJECT.currentFederal(f.company, 2027));
      const body = plain(m.bodyHtml);
      expect(body).toContain("2027 federal and Illinois tax tables");
      expect(body).toContain("no new payroll drafts will appear");
      expect(body).not.toContain("aren't installed yet");
    }
  });
});

describe("S2f display order: states sorted by name, dedupe keys by code", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await boot();
    await addWorker(f.t, IA_WORKER, "IA");
    await addWorker(f.t, ID_WORKER, "ID");
  }, 180_000);
  afterAll(async () => f.t.close());

  it("S2f IA/ID/IL → 'federal, Idaho, Illinois and Iowa'; codes federal, IA, ID, IL", async () => {
    const r = await check(f.deps, "2027-01-02T12:00:00Z");
    expect(r.reported.filter((x) => x.jurisdictions.length > 0)).toEqual([
      { year: 2027, jurisdictions: ["federal", "IA", "ID", "IL"] },
    ]);
    expect((await alertAudit(f.t)).map((a) => a.entityId).sort()).toEqual([
      "2027:IA",
      "2027:ID",
      "2027:IL",
      "2027:federal",
    ]);
    for (const m of await alertMail(f.t)) {
      expect(plain(m.bodyHtml)).toContain("2027 federal, Idaho, Illinois and Iowa tax tables");
    }
  });
});

// ---------------------------------------------------------------------------
// S3: federal present, state missing (D5)
// ---------------------------------------------------------------------------

describe("S3 synthetic federal-2027, no IL-2027: draft tick 2027-01-15", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await boot();
    await seedSyntheticFederal2027(f.t.db);
  }, 180_000);
  afterAll(async () => f.t.close());

  it("S3 alert IL only; jobs = both workers; no-state worker drafted, IL worker skipped", async () => {
    const { value: r, lines } = await withLogs(() => draftTick(f.deps, "2027-01-15T08:12:00Z"));
    expect(r.missing).toEqual({ year: 2027, federal: true, missingStates: ["IL"] });
    expect([...r.jobs].sort((a, b) => a.employeeId - b.employeeId)).toEqual(
      [f.ilId, f.noStateId]
        .sort((a, b) => a - b)
        .map((id) => ({ employeeId: id, year: 2027, month: 1, singletonKey: `${id}:2027-01-01` })),
    );
    expect(lines.some((l) => l.includes("no drafts generated"))).toBe(false);

    expect((await alertAudit(f.t)).map((a) => a.entityId)).toEqual(["2027:IL"]);
    const mail = await alertMail(f.t);
    expect(mail).toHaveLength(2);
    for (const m of mail) {
      expect(m.subject).toBe(SUBJECT.currentStates(f.company, 2027, "Illinois"));
      const body = plain(m.bodyHtml);
      expect(body).toContain("2027 Illinois tax tables");
      expect(body).toContain("employees who work in Illinois");
      expect(body).not.toMatch(/federal/i);
      expect(body).not.toContain("no new payroll drafts will appear for you to review");
    }

    // As the GENERATE_QUEUE worker does, one call per job.
    const generated: { employeeId: number; periodStart: string }[] = [];
    const skipped: { employeeId: number; reason: string }[] = [];
    for (const job of r.jobs) {
      const out = await generateDraftsForPeriod(f.deps, {
        year: job.year,
        month: job.month,
        employeeId: job.employeeId,
        autoDraftOnly: true,
        createdBy: "scheduler",
      });
      generated.push(
        ...out.generated.map((g) => ({ employeeId: g.employeeId, periodStart: g.periodStart })),
      );
      skipped.push(...out.skipped);
    }
    expect(generated).toEqual([{ employeeId: f.noStateId, periodStart: "2027-01-01" }]);
    expect(skipped).toEqual([{ employeeId: f.ilId, reason: "no_state_tax_config" }]);
  });
});

// ---------------------------------------------------------------------------
// S4: covered regression + APP_TZ period
// ---------------------------------------------------------------------------

describe("S4 covered year and the APP_TZ period", () => {
  let f: Fixture;
  let w2Ids: number[];
  beforeAll(async () => {
    f = await boot();
    const terminated = await addWorker(f.t, TERMINATED_WORKER, "IL", { status: "terminated" });
    await addWorker(f.t, CONTRACTOR, null, { type: "1099" });
    // Today's selection: every W-2 employee, any status (brief §11 pins it).
    w2Ids = [f.ilId, f.noStateId, terminated].sort((a, b) => a - b);
  }, 180_000);
  afterAll(async () => f.t.close());

  it("S4 2026-10-15 09:12 Madrid: jobs = every W-2 employee, same singletonKey; nothing reported", async () => {
    const r = await draftTick(f.deps, "2026-10-15T07:12:00Z");
    expect(r.period).toEqual({ year: 2026, month: 10, periodStart: "2026-10-01" });
    expect(r.missing).toBeNull();
    expect([...r.jobs].sort((a, b) => a.employeeId - b.employeeId)).toEqual(
      w2Ids.map((id) => ({
        employeeId: id,
        year: 2026,
        month: 10,
        singletonKey: `${id}:2026-10-01`,
      })),
    );
    const daily = await check(f.deps, "2026-10-15T05:41:00Z");
    expect(daily.checked).toEqual([2026]);
    expect(daily.reported.flatMap((x) => x.jurisdictions)).toEqual([]);
    expect(await alertAudit(f.t)).toEqual([]);
    expect(await alertMail(f.t)).toEqual([]);
  });

  it("S4c America/Chicago, 2027-01-01T03:00Z is still Dec 2026 locally → period 2026-12", async () => {
    const r = await draftTick(
      { db: f.t.db, config: { ...f.t.config, appTz: "America/Chicago" } },
      "2027-01-01T03:00:00Z",
    );
    expect(r.period).toEqual({ year: 2026, month: 12, periodStart: "2026-12-01" });
    expect(r.missing).toBeNull();
    expect(r.jobs.map((j) => j.singletonKey).sort()).toEqual(
      w2Ids.map((id) => `${id}:2026-12-01`).sort(),
    );
  });

  it("S4d autoDraft off → period null, no jobs", async () => {
    await f.t.db
      .update(paySchedules)
      .set({ autoDraft: false })
      .where(isNull(paySchedules.employeeId));
    try {
      const r = await draftTick(f.deps, "2026-10-15T07:12:00Z");
      expect(r.period).toBeNull();
      expect(r.jobs).toEqual([]);
    } finally {
      await f.t.db
        .update(paySchedules)
        .set({ autoDraft: true })
        .where(isNull(paySchedules.employeeId));
    }
  });

  it("S4b 2026-12-31T23:30Z, Madrid (local 2027-01-01) → period 2027-01", async () => {
    const r = await draftTick(f.deps, "2026-12-31T23:30:00Z");
    expect(r.period).toEqual({ year: 2027, month: 1, periodStart: "2027-01-01" });
  });
});

// ---------------------------------------------------------------------------
// S5: toggle (WORKFLOW_EVENTS, audience admin, default on)
// ---------------------------------------------------------------------------

describe("S5 per-admin toggle, enforced by the outbox drain", () => {
  let f: Fixture;
  let cookieA: string;
  let cookieB: string;
  let cookieE: string;
  beforeAll(async () => {
    f = await boot();
    cookieA = (await login(f.t, f.adminEmails.a, TEST_PASSWORD)).sessionCookie;
    cookieB = (await login(f.t, f.adminEmails.b, TEST_PASSWORD)).sessionCookie;
    cookieE = (await login(f.t, f.employeeEmail, TEST_PASSWORD)).sessionCookie;
  }, 180_000);
  afterAll(async () => f.t.close());

  const put = (cookie: string, enabled: boolean) =>
    f.t.app.inject({
      method: "PUT",
      url: "/api/my/notification-settings",
      headers: { ...ORIGIN, ...sessionHeader(cookie) },
      payload: { settings: [{ eventType: "tax_tables_missing", enabled }] },
    });
  const get = async (cookie: string) => {
    const res = await f.t.app.inject({
      method: "GET",
      url: "/api/my/notification-settings",
      headers: sessionHeader(cookie),
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { settings: { eventType: string; enabled: boolean }[] }).settings;
  };

  it("S5a admin A turns the email off → 200", async () => {
    const res = await put(cookieA, false);
    expect(res.statusCode, res.body).toBe(200);
    expect((await get(cookieA)).find((s) => s.eventType === "tax_tables_missing")).toEqual({
      eventType: "tax_tables_missing",
      enabled: false,
    });
  });

  it("S5b an employee cannot toggle it → 400 not_applicable", async () => {
    const res = await put(cookieE, false);
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe("not_applicable");
  });

  it("S5c admin B sees it on by default, also with no settings row (pre-release admin)", async () => {
    expect((await get(cookieB)).find((s) => s.eventType === "tax_tables_missing")).toEqual({
      eventType: "tax_tables_missing",
      enabled: true,
    });
    await f.t.db
      .delete(notificationSettings)
      .where(
        and(
          eq(notificationSettings.userId, f.admins.b),
          eq(notificationSettings.eventType, "tax_tables_missing"),
        ),
      );
    expect((await get(cookieB)).find((s) => s.eventType === "tax_tables_missing")).toEqual({
      eventType: "tax_tables_missing",
      enabled: true,
    });
  });

  it("S5d the employee's settings list does not include it", async () => {
    expect((await get(cookieE)).map((s) => s.eventType)).not.toContain("tax_tables_missing");
  });

  it("S5e both rows written; drain suppresses A's, sends B's", async () => {
    await check(f.deps, "2027-01-02T12:00:00Z");
    const mail = await alertMail(f.t);
    expect(sortIds(mail.map((m) => m.userId))).toEqual(sortIds([f.admins.a, f.admins.b]));
    await drainOutbox({
      db: f.t.db,
      config: f.t.config,
      resolveRecipientEmail: async () => null,
      log: () => {},
    });
    const after = await alertMail(f.t);
    expect(after.find((m) => m.userId === f.admins.a)?.status).toBe("suppressed");
    expect(after.find((m) => m.userId === f.admins.b)?.status).toBe("sent");
  });

  it("S5f the coverage endpoint still lists 2027 uncovered for A", async () => {
    f.setNow("2027-01-02T12:00:00Z");
    const res = await f.t.app.inject({
      method: "GET",
      url: "/api/admin/tax-tables/coverage",
      headers: sessionHeader(cookieA),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { years: unknown[] }).years).toEqual([
      { year: 2027, federal: false, missingStates: ["IL"] },
    ]);
  });

  it("S5g turning it back on does not resend an already-reported year", async () => {
    expect((await put(cookieA, true)).statusCode).toBe(200);
    const before = (await alertMail(f.t)).length;
    await check(f.deps, "2027-01-03T12:00:00Z");
    expect((await alertMail(f.t)).length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// S6b: reportMissingTaxTables directly — ordering, zero admins
// ---------------------------------------------------------------------------

describe("S6b reportMissingTaxTables with no admins", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await boot({ admins: false });
  }, 180_000);
  afterAll(async () => f.t.close());

  it("S6b reports federal first then codes sorted; audit rows only; second call reports nothing", async () => {
    const { reportMissingTaxTables } = await taxAlert();
    const first = await reportMissingTaxTables(f.t.db, f.t.config, {
      year: 2027,
      jurisdictions: ["NY", "federal", "IL"],
      today: "2027-01-02",
    });
    expect(first.reported).toEqual(["federal", "IL", "NY"]);
    expect((await alertAudit(f.t)).map((a) => a.entityId).sort()).toEqual([
      "2027:IL",
      "2027:NY",
      "2027:federal",
    ]);
    expect(await alertMail(f.t)).toEqual([]);
    const second = await reportMissingTaxTables(f.t.db, f.t.config, {
      year: 2027,
      jurisdictions: ["federal", "IL", "NY"],
      today: "2027-01-03",
    });
    expect(second.reported).toEqual([]);
    expect((await alertAudit(f.t)).length).toBe(3);
  });

  it("S6c the same code in another year is a separate report", async () => {
    const { reportMissingTaxTables } = await taxAlert();
    const r = await reportMissingTaxTables(f.t.db, f.t.config, {
      year: 2028,
      jurisdictions: ["federal"],
      today: "2027-12-01",
    });
    expect(r.reported).toEqual(["federal"]);
  });
});

// ---------------------------------------------------------------------------
// S7: no PII, no manual-entry pointer (runs last; reads ARTIFACTS)
// ---------------------------------------------------------------------------

describe("S7 every subject, body and log line from S1–S6", () => {
  it("S7 no legal name, amount, @, /admin/config, Tax tables link; only appUrl/admin", () => {
    expect(ARTIFACTS.subjects.length).toBeGreaterThan(0);
    expect(ARTIFACTS.bodies.length).toBeGreaterThan(0);
    expect(ARTIFACTS.logs.length).toBeGreaterThan(0);
    for (const s of [...ARTIFACTS.subjects, ...ARTIFACTS.bodies, ...ARTIFACTS.logs]) {
      for (const name of LEGAL_NAMES) expect(s).not.toContain(name);
      expect(s).not.toMatch(/\d+\.\d{2}/);
      expect(s).not.toContain("@");
      expect(s).not.toContain("/admin/config");
    }
    for (const html of ARTIFACTS.bodies) {
      for (const m of html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) {
        expect(m[1]).not.toMatch(/tax tables/i);
      }
      const links = [...html.matchAll(/href\s*=\s*"([^"]*)"/g)].map((m) => m[1]);
      for (const l of links) expect(l).toBe("http://localhost/admin");
    }
  });
});
