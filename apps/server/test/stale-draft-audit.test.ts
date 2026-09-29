/**
 * PAY-173 review, LOW 4: the `run.stale_detected` audit row is written in its
 * own statement after the refused transaction. If that write fails, the
 * client must still get the 409 stale_draft, not the database error.
 * Synthetic people.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { auditEvents, payrollRuns, seedDatabase, type SeedDb } from "@payroll/db";
import type { Db } from "../src/db.js";
import { transitionRun } from "../src/payroll/runs.js";
import { PayrollServiceError } from "../src/payroll/errors.js";
import { createTestApp, type TestContext } from "./helpers.js";
import { createEmployee, gen, monthPeriod } from "./pay-date-helpers.js";

let t: TestContext;

beforeAll(async () => {
  t = await createTestApp();
  await seedDatabase(t.db as unknown as SeedDb);
}, 120_000);

afterAll(async () => {
  await t.close();
});

/** A Db whose top-level (non-transaction) audit_events inserts fail. */
function failingAuditDb(db: Db): Db {
  return new Proxy(db as unknown as Record<string | symbol, unknown>, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === "insert") {
        return (table: unknown) => {
          if (table === auditEvents) throw new Error("simulated audit write failure");
          return (value as (t: unknown) => unknown).call(target, table);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as Db;
}

describe("stale draft with a failing audit write", () => {
  it("still refuses with stale_draft and logs the audit failure", async () => {
    const emp = await createEmployee(t, 500_000);
    const { run } = await gen(t, emp, monthPeriod("2026-11", "2026-11-15"));
    // Pay date edited in the DB after generation → the draft is stale (D4).
    await t.db.update(payrollRuns).set({ payDate: "2026-11-20" }).where(eq(payrollRuns.id, run.id));

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const outcome = await transitionRun(
        {
          db: failingAuditDb(t.db),
          config: t.config,
          clock: () => new Date("2026-11-10T12:00:00Z"),
        },
        { publicId: run.publicId, action: "approve", actorId: "stale-audit-admin" },
      ).then(
        () => "approved",
        (err: unknown) => (err instanceof PayrollServiceError ? err.code : String(err)),
      );
      expect({ outcome, logged: warn.mock.calls.length > 0 }).toEqual({
        outcome: "stale_draft",
        logged: true,
      });
    } finally {
      warn.mockRestore();
    }
  });
});
