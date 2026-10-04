/**
 * Spec 24 (PAY-116) PR-4 Q1 / QA-1 — the QA seed gets a synthetic company
 * EIN (D-PL3, D31) so IL takes the S24-D2 EIN default and Ada's W-2 is not
 * held (risk R1: on 2027-01-01 the qa.spec closed-year test reads 2026).
 * payroll-calc-auditor, fail-first; the coder may not edit this file.
 *
 * Contract assumed (brief Q1): seedQaDataset sets company.ein =
 * encryptField("000000001", key) only when company.ein IS NULL; idempotent;
 * never overwrites a pre-set EIN. A "00" prefix is never a valid EIN.
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { company, employees, seedDatabase, type SeedDb } from "@payroll/db";
import { decryptField, encryptField } from "../src/crypto/field-encryption.js";
import { w2FiguresWithYearIssues } from "../src/filings/annual.js";
import { seedQaDataset } from "../src/qa/seed-qa.js";
import type { Db } from "../src/db.js";
import { createTestApp, type TestContext } from "./helpers.js";

const TODAY = "2026-08-20";

async function storedEin(t: TestContext): Promise<string | null> {
  const rows = await t.db.select({ ein: company.ein }).from(company).limit(1);
  return rows[0]?.ein ?? null;
}

describe("QA-1 seedQaDataset sets a synthetic EIN once (null EIN to start)", () => {
  let t: TestContext;
  let afterFirst: string | null = null;
  let afterSecond: string | null = null;
  beforeAll(async () => {
    t = await createTestApp();
    await seedQaDataset({ db: t.db, auth: t.auth, config: t.config }, { today: TODAY });
    afterFirst = await storedEin(t);
    await seedQaDataset({ db: t.db, auth: t.auth, config: t.config }, { today: TODAY });
    afterSecond = await storedEin(t);
  }, 300_000);
  afterAll(async () => t.close());

  it('company.ein is ciphertext (^enc:v1:) of "000000001"; the second run leaves it byte-identical', () => {
    expect({
      encrypted: /^enc:v1:/.test(afterFirst ?? ""),
      plain: afterFirst ? decryptField(afterFirst, t.config.encryptionKey) : null,
      same: afterSecond === afterFirst,
    }).toEqual({ encrypted: true, plain: "000000001", same: true });
  });

  it("2026 W-2s: Ada's IL line uses the EIN default (stateIdSource ein_default); no W-2 is blocked; no year issue", async () => {
    const [ada] = await t.db
      .select({ id: employees.id })
      .from(employees)
      .where(eq(employees.legalName, "Ada Testworth"));
    const { figures, yearIssues } = await w2FiguresWithYearIssues(t.db as unknown as Db, 2026);
    const row = figures.find((f) => f.employeeId === ada?.id);
    expect({
      il: row?.stateLines
        .filter((l) => l.state === "IL")
        .map((l) => ({ state: l.state, stateIdSource: l.stateIdSource })),
      adaBlocked: row?.issues.some((i) => i.severity === "block"),
      blocked: figures
        .filter((f) => f.issues.some((i) => i.severity === "block"))
        .map((f) => [f.legalName, f.issues.map((i) => i.code)]),
      yearIssues,
    }).toEqual({
      il: [{ state: "IL", stateIdSource: "ein_default" }],
      adaBlocked: false,
      blocked: [],
      yearIssues: [],
    });
  });
});

describe("QA-1 a pre-set company EIN is never overwritten by the QA seed", () => {
  let t: TestContext;
  let preset = "";
  beforeAll(async () => {
    t = await createTestApp();
    await seedDatabase(t.db as unknown as SeedDb);
    preset = encryptField("000000002", t.config.encryptionKey);
    await t.db.update(company).set({ ein: preset });
    await seedQaDataset({ db: t.db, auth: t.auth, config: t.config }, { today: TODAY });
  }, 300_000);
  afterAll(async () => t.close());

  it("company.ein is still the pre-set ciphertext", async () => {
    expect(await storedEin(t)).toBe(preset);
  });
});
