/**
 * SYNTHETIC — NOT PUBLISHED 2027 VALUES — TEST ONLY.
 *
 * Spec 26 (PAY-173) §8 fixtures. 2027 federal and state withholding tables
 * are not published. These rows exist so tests can prove WHICH year's table a
 * run used; they are not forecasts. PAY-183 / PAY-187 seed the real values.
 *
 * - SYN-2027 federal: a copy of the seeded 2026 `federal` / `federal:single`
 *   rows with two marker changes: social_security_wage_cap = 190,000.00 and
 *   standard_deduction = 2026 value + 1,000.00. Brackets, rates, futa_rate,
 *   futa_wage_cap and suta_credit_rate are copied unchanged.
 * - SYN-IL-2027: IL flat 0.0500 (2026 IL-700-T: 0.0495); allowance amounts
 *   copied from the seeded IL 2026 row.
 * - SYN IL 2027 deposit schedule: monthly, due day 15.
 *
 * No CA 2027 row and no TX 2027 row exist in any fixture (S-1 / S-1b).
 */

import { and, eq } from "drizzle-orm";
import { stateDepositSchedules, stateTaxConfigs, taxBrackets, taxConfig } from "@payroll/db";
import type { Db } from "../../src/db.js";

export const SYNTHETIC_NOTE = "SYNTHETIC — NOT PUBLISHED 2027 VALUES — TEST ONLY";

/** SYN-2027 marker values (dollars, as stored in NUMERIC(12,2)). */
export const SYN_2027 = {
  socialSecurityWageCap: "190000.00",
  standardDeductionDelta: 1000,
} as const;

/** Copy the seeded 2026 federal rows to 2027 with the two SYN markers. */
export async function seedSyntheticFederal2027(db: Db): Promise<void> {
  const base = await db
    .select()
    .from(taxConfig)
    .where(and(eq(taxConfig.jurisdiction, "federal"), eq(taxConfig.taxYear, 2026)));
  const row = base[0];
  if (!row) throw new Error("seed the 2026 federal tax_config row first (seedDatabase)");
  const { id: _id, ...rest } = row;
  // SYNTHETIC — NOT PUBLISHED 2027 VALUES — TEST ONLY
  await db.insert(taxConfig).values({
    ...rest,
    taxYear: 2027,
    socialSecurityWageCap: SYN_2027.socialSecurityWageCap,
    standardDeduction: (Number(row.standardDeduction) + SYN_2027.standardDeductionDelta).toFixed(2),
  });
  for (const jurisdiction of ["federal", "federal:single"]) {
    const brackets = await db
      .select()
      .from(taxBrackets)
      .where(and(eq(taxBrackets.jurisdiction, jurisdiction), eq(taxBrackets.taxYear, 2026)));
    if (brackets.length === 0) throw new Error(`no 2026 ${jurisdiction} brackets seeded`);
    // SYNTHETIC — NOT PUBLISHED 2027 VALUES — TEST ONLY (brackets copied from 2026)
    await db
      .insert(taxBrackets)
      .values(brackets.map(({ id: _b, ...b }) => ({ ...b, taxYear: 2027 })));
  }
}

/** SYN-IL-2027: flat 5.00 %, allowances as IL 2026. */
export async function seedSyntheticIl2027(db: Db): Promise<void> {
  const base = await db
    .select()
    .from(stateTaxConfigs)
    .where(and(eq(stateTaxConfigs.jurisdiction, "IL"), eq(stateTaxConfigs.taxYear, 2026)));
  const row = base[0];
  if (!row) throw new Error("seed the IL 2026 state_tax_configs row first (seedDatabase)");
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = row;
  // SYNTHETIC — NOT PUBLISHED 2027 VALUES — TEST ONLY
  await db.insert(stateTaxConfigs).values({
    ...rest,
    taxYear: 2027,
    flatRate: "0.0500",
    note: SYNTHETIC_NOTE,
  });
}

/** SYN IL 2027 deposit schedule (monthly, due day 15). */
export async function seedSyntheticIlDepositSchedule2027(db: Db): Promise<void> {
  // SYNTHETIC — NOT PUBLISHED 2027 VALUES — TEST ONLY
  await db.insert(stateDepositSchedules).values({
    stateCode: "IL",
    taxYear: 2027,
    frequency: "monthly",
    dueDay: 15,
    note: SYNTHETIC_NOTE,
    source: SYNTHETIC_NOTE,
  });
}
