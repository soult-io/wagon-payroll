/**
 * Spec 24 (PAY-116) PR-4 round 2, S1 (security MEDIUM) — the QA seed writes
 * synthetic users, employees and a synthetic company EIN, so it must refuse
 * to run anywhere but QA or a test boot (payroll-calc-auditor, fail-first;
 * the coder may not edit this file).
 *
 * Contract assumed: seedQaDataset(deps, opts) throws before ANY write unless
 * deps.config.appEnv === "qa" or deps.config.nodeEnv === "test". The error
 * message is fixed (it does not echo the environment). The QA stack runs the
 * seed with APP_ENV=qa, NODE_ENV=production; the vitest harness and the
 * ephemeral e2e boot use nodeEnv "test" (qa-seed-ein.test.ts and
 * qa-seed.test.ts keep covering that path: createTestApp's appEnv is the
 * default "production" with nodeEnv "test").
 */

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authUser, company, employees, payrollRuns } from "@payroll/db";
import { decryptField } from "../src/crypto/field-encryption.js";
import { seedQaDataset } from "../src/qa/seed-qa.js";
import { createTestApp, type TestContext } from "./helpers.js";

const TODAY = "2026-08-20";

async function counts(t: TestContext) {
  const n = async (
    table: typeof company | typeof employees | typeof authUser | typeof payrollRuns,
  ) => {
    const [row] = await t.db.select({ n: sql<number>`count(*)::int` }).from(table as never);
    return row?.n ?? 0;
  };
  const [einRow] = await t.db
    .select({ n: sql<number>`count(*)::int` })
    .from(company)
    .where(sql`${company.ein} IS NOT NULL`);
  return {
    company: await n(company),
    companyWithEin: einRow?.n ?? 0,
    employees: await n(employees),
    users: await n(authUser),
    runs: await n(payrollRuns),
  };
}

describe("S1 seedQaDataset refuses outside QA / test, before any write", () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestApp();
  }, 120_000);
  afterAll(async () => t.close());

  it('appEnv "production" / nodeEnv "production": throws a fixed message; no company, EIN, user, employee or run written', async () => {
    const before = await counts(t);
    const run = (appEnv: string) =>
      seedQaDataset(
        { db: t.db, auth: t.auth, config: { ...t.config, appEnv, nodeEnv: "production" } },
        { today: TODAY },
      ).then(
        () => ({ threw: false, message: "" }),
        (err: unknown) => ({
          threw: true,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    const prod = await run("production");
    const staging = await run("staging-synthetic");
    const after = await counts(t);
    expect({
      prodThrew: prod.threw,
      stagingThrew: staging.threw,
      fixedMessage: prod.message.length > 0 && prod.message === staging.message,
      echoesEnv: staging.message.includes("staging-synthetic"),
      after,
    }).toEqual({
      prodThrew: true,
      stagingThrew: true,
      fixedMessage: true,
      echoesEnv: false,
      after: before,
    });
    expect(after.companyWithEin).toBe(0);
  });
});

describe('S1 appEnv "qa" with nodeEnv "production" (the QA stack) runs (guard)', () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestApp();
  }, 120_000);
  afterAll(async () => t.close());

  it("seeds: the QA admin exists and the company EIN is the synthetic 000000001", async () => {
    const summary = await seedQaDataset(
      { db: t.db, auth: t.auth, config: { ...t.config, appEnv: "qa", nodeEnv: "production" } },
      { today: TODAY },
    );
    const [row] = await t.db.select({ ein: company.ein }).from(company).limit(1);
    expect({
      admin: summary.users.admin.email.length > 0,
      ein: row?.ein ? decryptField(row.ein, t.config.encryptionKey) : null,
    }).toEqual({ admin: true, ein: "000000001" });
  }, 300_000);
});
