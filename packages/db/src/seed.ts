/**
 * Database seeds (spec 1 §6 + spec 2): company row (Example Corp — synthetic
 * placeholder), 2025+2026 tax_config + tax_brackets from the vendored engine
 * constants (single source of truth — no copied numbers), and the default
 * pay_schedules row.
 *
 * Idempotent: safe to run repeatedly and against a partially-seeded DB.
 * Works against any drizzle instance — real Postgres in the CLI, PGlite in
 * tests.
 */

import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { TAX_CONFIG, TAX_CONFIG_2025, type TaxConfig } from "@payroll/engine";
import {
  company,
  contractorReportingConfig,
  paySchedules,
  taxBrackets,
  taxConfig,
} from "./schema.js";
import type * as schema from "./schema.js";

export type SeedDb = PostgresJsDatabase<typeof schema>;

export const SEED_COMPANY_NAME = "Example Corp";

async function seedCompany(db: SeedDb): Promise<void> {
  const existing = await db.select({ id: company.id }).from(company).limit(1);
  if (existing.length > 0) return;
  await db.insert(company).values({ legalName: SEED_COMPANY_NAME });
}

async function seedTaxConfig(db: SeedDb, config: TaxConfig): Promise<void> {
  await db
    .insert(taxConfig)
    .values({
      jurisdiction: "federal",
      taxYear: config.year,
      standardDeduction: String(config.standardDeduction),
      socialSecurityRate: String(config.socialSecurityRate),
      socialSecurityWageCap: String(config.socialSecurityWageCap),
      medicareRate: String(config.medicareRate),
      medicareAdditionalRate: String(config.medicareAdditionalRate),
      medicareAdditionalThreshold: String(config.medicareAdditionalThreshold),
      stateWithholdingRate: String(config.stateWithholdingRate),
      employerSocialSecurityRate: String(config.employerSocialSecurityRate),
      employerMedicareRate: String(config.employerMedicareRate),
      futaRate: String(config.futaRate),
      futaWageCap: String(config.futaWageCap),
      sutaCreditRate: String(config.sutaCreditRate),
    })
    .onConflictDoNothing({ target: [taxConfig.jurisdiction, taxConfig.taxYear] });

  // Bracket sets are per filing status via jurisdiction = 'federal:<status>'
  // (spec payroll-engine §3); the engine constants are the SINGLE set, seeded
  // under both the legacy 'federal' jurisdiction and 'federal:single'.
  for (const jurisdiction of ["federal", "federal:single"]) {
    const rows = config.federalBrackets.map((b, i) => ({
      jurisdiction,
      taxYear: config.year,
      ordinal: i + 1,
      minAmount: String(b.min),
      maxAmount: b.max === Infinity ? null : String(b.max),
      rate: String(b.rate),
    }));
    await db
      .insert(taxBrackets)
      .values(rows)
      .onConflictDoNothing({
        target: [taxBrackets.jurisdiction, taxBrackets.taxYear, taxBrackets.ordinal],
      });
  }
}

async function seedPaySchedule(db: SeedDb): Promise<void> {
  const existing = await db
    .select({ id: paySchedules.id })
    .from(paySchedules)
    .where(sql`${paySchedules.employeeId} IS NULL`)
    .limit(1);
  if (existing.length > 0) return;
  await db.insert(paySchedules).values({
    employeeId: null,
    frequency: "monthly",
    draftDayOfMonth: 15,
    payDayOfMonth: 15,
    autoDraft: true,
    active: true,
  });
}

/**
 * Spec 10 §3: dated 1099-NEC thresholds — $600 through 2025, $2,000 for 2026
 * (OBBBA, inflation-indexed annually from 2027). Lookup falls back to the
 * latest earlier row, so one 2025 row covers every year ≤ 2025 and 2026
 * covers 2027+ until an admin enters the indexed figure.
 */
async function seedContractorReportingConfig(db: SeedDb): Promise<void> {
  await db
    .insert(contractorReportingConfig)
    .values([
      {
        taxYear: 2025,
        necThreshold: "600.00",
        note: "Federal 1099-NEC threshold in effect through 2025",
      },
      {
        taxYear: 2026,
        necThreshold: "2000.00",
        note: "OBBBA (July 2025); inflation-indexed annually from 2027",
      },
    ])
    .onConflictDoNothing({ target: [contractorReportingConfig.taxYear] });
}

/** Run all seeds. Returns a summary for CLI output / test assertions. */
export async function seedDatabase(db: SeedDb): Promise<{ done: true }> {
  await seedCompany(db);
  await seedTaxConfig(db, TAX_CONFIG_2025);
  await seedTaxConfig(db, TAX_CONFIG);
  await seedPaySchedule(db);
  await seedContractorReportingConfig(db);
  // PAY-13 phase 1: TX/IL/CA state withholding tables.
  const { seedStateTaxes } = await import("./state-seeds.js");
  await seedStateTaxes(db);
  // PAY-163: local income-tax coverage list read by the local-tax guard.
  const { seedLocalTaxCoverage } = await import("./local-tax-seeds.js");
  await seedLocalTaxCoverage(db);
  return { done: true };
}
