/**
 * PAY-103 R18 PR-5a: pg-boss wiring of the missing-tax-tables alert
 * (brief §4.3, §2 D2-a). payroll-calc-auditor, fail-first; the coder may not
 * edit this file.
 *
 * pg-boss needs a real Postgres, so it is replaced by an in-memory fake that
 * records `work` handlers and `send` calls; the handlers then run against the
 * real PGlite DB. `syncDeposits` is wrapped (vi.mock, original by default) so
 * a test can make it throw and can see whether it ran. Only `Date` is faked
 * (the workers call `new Date()`).
 *
 * Contract assumed:
 *   TICK_QUEUE worker = draftTick({db, config}, {now: new Date()}) then one
 *     boss.send(GENERATE_QUEUE, {employeeId, year, month}, {singletonKey}) per job.
 *   GENERATE_QUEUE worker logs skipped reasons as counts by code:
 *     `[payroll] draft generation skipped: {"no_state_tax_config":1}`.
 *   DEPOSIT_TICK_QUEUE worker: first step is checkTaxTableCoverage, wrapped:
 *     its failure is logged by error class and the deposit steps still run;
 *     a syncDeposits failure cannot stop it (it already ran).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import {
  auditEvents,
  company,
  compensation,
  emailOutbox,
  employees,
  employeeWorkStates,
  seedDatabase,
  type SeedDb,
} from "@payroll/db";
import type { Db } from "../src/db.js";
import { seedSyntheticFederal2027 } from "./fixtures/synthetic-2027.js";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard } from "./flow-helpers.js";

type Handler = (jobs: { data: unknown }[]) => Promise<unknown>;

const boss = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  sent: [] as { queue: string; data: unknown; options: unknown }[],
}));

vi.mock("pg-boss", () => {
  class PgBoss {
    async start() {}
    async stop() {}
    async createQueue() {}
    async schedule() {}
    async unschedule() {}
    async work(name: string, handler: Handler) {
      boss.handlers.set(name, handler);
    }
    async send(queue: string, data: unknown, options: unknown) {
      boss.sent.push({ queue, data, options });
      return "job-id";
    }
  }
  return { PgBoss, default: PgBoss };
});

const deposits = vi.hoisted(() => ({ calls: 0, failWith: null as Error | null }));

vi.mock("../src/deposits/service.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/deposits/service.js")>();
  return {
    ...orig,
    syncDeposits: async (...args: Parameters<typeof orig.syncDeposits>) => {
      deposits.calls += 1;
      if (deposits.failWith) throw deposits.failWith;
      return orig.syncDeposits(...args);
    },
  };
});

const TICK = "payroll-draft-tick";
const GENERATE = "payroll-generate-draft";
const DEPOSIT_TICK = "tax-deposit-tick";

class SyntheticOutboxFailure extends Error {}
class SyntheticDepositFailure extends Error {}

async function addWorker(t: TestContext, name: string, state: string | null): Promise<number> {
  const c = await t.db.select({ id: company.id }).from(company).limit(1);
  const [row] = await t.db
    .insert(employees)
    .values({
      companyId: c[0]!.id,
      employmentType: "w2",
      legalName: name,
      hireDate: "2024-01-01",
      status: "active",
    })
    .returning({ id: employees.id });
  await t.db.insert(compensation).values({
    employeeId: row!.id,
    periodAmount: "4000.00",
    frequency: "monthly",
    effectiveFrom: "2024-01-01",
    effectiveTo: null,
  });
  if (state) {
    await t.db.insert(employeeWorkStates).values({
      employeeId: row!.id,
      stateCode: state,
      effectiveFrom: "2024-01-01",
      effectiveTo: null,
    });
  }
  return row!.id;
}

/** insert(emailOutbox) rejects, at any transaction depth. */
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

async function captureLogs<T>(
  fn: () => Promise<T>,
): Promise<{ value: T | Error; lines: string[] }> {
  const lines: string[] = [];
  const spies = (["log", "warn", "error", "info"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    }),
  );
  try {
    return { value: await fn(), lines };
  } catch (err) {
    return { value: err as Error, lines };
  } finally {
    for (const s of spies) s.mockRestore();
  }
}

interface Booted {
  t: TestContext;
  ilId: number;
  noStateId: number;
  handler: (name: string) => Handler;
}

async function bootScheduler(dbFor: (db: Db) => Db = (db) => db): Promise<Booted> {
  const t = await createTestApp({ appTz: "Europe/Madrid", emailMode: "log" });
  await seedDatabase(t.db as unknown as SeedDb);
  const ilId = await addWorker(t, "Synthetic Wiring Illinois Worker", "IL");
  const noStateId = await addWorker(t, "Synthetic Wiring Nostate Worker", null);
  await inviteAndOnboard(t, { email: "wiring-admin@example.com", role: "admin" });
  boss.handlers.clear();
  const { startScheduler } = await import("../src/payroll/scheduler.js");
  await startScheduler({ db: dbFor(t.db), config: t.config, databaseUrl: "postgres://unused" });
  return {
    t,
    ilId,
    noStateId,
    handler: (name) => {
      const h = boss.handlers.get(name);
      if (!h) throw new Error(`no worker registered for ${name}`);
      return h;
    },
  };
}

async function runAt(iso: string, fn: () => Promise<unknown>) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
  try {
    return await captureLogs(fn);
  } finally {
    vi.useRealTimers();
  }
}

const alertAudit = (t: TestContext) =>
  t.db
    .select({ entityId: auditEvents.entityId })
    .from(auditEvents)
    .where(eq(auditEvents.action, "tax_tables.missing"))
    .orderBy(asc(auditEvents.id));

afterEach(() => {
  boss.sent.length = 0;
  deposits.calls = 0;
  deposits.failWith = null;
});

describe("W1 TICK_QUEUE worker", () => {
  let b: Booted;
  beforeAll(async () => {
    b = await bootScheduler();
  }, 180_000);
  afterAll(async () => b.t.close());

  it("W1a covered (2026-10-15): one GENERATE job per W-2 employee, unchanged key (regression)", async () => {
    await runAt("2026-10-15T07:12:00Z", () => b.handler(TICK)([]));
    const sends = boss.sent
      .filter((s) => s.queue === GENERATE)
      .map((s) => ({ data: s.data, options: s.options }))
      .sort(
        (x, y) =>
          (x.data as { employeeId: number }).employeeId -
          (y.data as { employeeId: number }).employeeId,
      );
    expect(sends).toEqual(
      [b.ilId, b.noStateId]
        .sort((x, y) => x - y)
        .map((id) => ({
          data: { employeeId: id, year: 2026, month: 10 },
          options: { singletonKey: `${id}:2026-10-01` },
        })),
    );
  });

  it("W1b 2027-01-15 with no 2027 tables: no GENERATE job; alert written", async () => {
    await runAt("2027-01-15T08:12:00Z", () => b.handler(TICK)([]));
    expect(boss.sent.filter((s) => s.queue === GENERATE)).toEqual([]);
    expect((await alertAudit(b.t)).map((a) => a.entityId).sort()).toEqual([
      "2027:IL",
      "2027:federal",
    ]);
  });
});

describe("W2 GENERATE_QUEUE worker logs skip counts", () => {
  let b: Booted;
  beforeAll(async () => {
    b = await bootScheduler();
    await seedSyntheticFederal2027(b.t.db);
  }, 180_000);
  afterAll(async () => b.t.close());

  it("W2a IL worker in 2027 (no IL table) → counts by reason code, no ids", async () => {
    const { lines } = await runAt("2027-01-15T08:13:00Z", () =>
      b.handler(GENERATE)([{ data: { employeeId: b.ilId, year: 2027, month: 1 } }]),
    );
    const line = lines.find((l) => l.startsWith("[payroll] draft generation skipped:"));
    expect(line, lines.join("\n")).toBe(
      '[payroll] draft generation skipped: {"no_state_tax_config":1}',
    );
  });
});

describe("W3 DEPOSIT_TICK_QUEUE worker runs the coverage check first", () => {
  let b: Booted;
  beforeAll(async () => {
    b = await bootScheduler();
  }, 180_000);
  afterAll(async () => b.t.close());

  it("W3a 2026-11-30 07:41 Madrid: nothing reported (regression)", async () => {
    const { value } = await runAt("2026-11-30T06:41:00Z", () => b.handler(DEPOSIT_TICK)([]));
    expect(value).not.toBeInstanceOf(Error);
    expect(await alertAudit(b.t)).toEqual([]);
    expect(deposits.calls).toBe(1);
  });

  it("W3b a syncDeposits failure cannot stop it: 2026-12-01 07:41 Madrid reports 2027", async () => {
    deposits.failWith = new SyntheticDepositFailure("synthetic deposit failure");
    await runAt("2026-12-01T06:41:00Z", () => b.handler(DEPOSIT_TICK)([]));
    expect((await alertAudit(b.t)).map((a) => a.entityId).sort()).toEqual([
      "2027:IL",
      "2027:federal",
    ]);
    const mail = await b.t.db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.eventType, "tax_tables_missing"));
    expect(mail).toHaveLength(1);
  });

  it("W3c next day: no new rows (dedupe)", async () => {
    await runAt("2026-12-02T06:41:00Z", () => b.handler(DEPOSIT_TICK)([]));
    expect(await alertAudit(b.t)).toHaveLength(2);
  });
});

describe("W4 a coverage-step failure never fails the deposit tick", () => {
  let b: Booted;
  beforeAll(async () => {
    b = await bootScheduler(failingOutboxDb);
  }, 180_000);
  afterAll(async () => b.t.close());

  it("W4a outbox down at 2026-12-01: tick resolves, logged by class, deposit steps still run", async () => {
    const { value, lines } = await runAt("2026-12-01T06:41:00Z", () => b.handler(DEPOSIT_TICK)([]));
    expect(value).not.toBeInstanceOf(Error);
    expect(
      lines.some((l) => l.includes("SyntheticOutboxFailure")),
      lines.join("\n"),
    ).toBe(true);
    expect(lines.some((l) => l.includes("synthetic outbox failure"))).toBe(false);
    expect(deposits.calls).toBe(1);
    expect(await alertAudit(b.t)).toEqual([]);
  });
});
