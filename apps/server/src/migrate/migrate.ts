/**
 * Legacy migration core (spec 9): one-time copy from an external legacy
 * database (`accounting` schema) into the payroll database, with snapshot
 * reconstruction.
 *
 * Two phases, ALWAYS in this order:
 *   A. Plan + validate — read the source, rebuild every run's inputs from the
 *      historical config that produced it, recompute through the vendored
 *      engine, and require the recomputed entries to match the stored
 *      payroll_entries to the cent. ANY mismatch halts with a detailed report
 *      and NOTHING is ever written (validation also runs in --dry-run).
 *   B. Write (--write only) — insert company/employee/compensation/W-4/tax
 *      rows and the issued runs, all inside one transaction, recording every
 *      row in legacy_migration_map so a re-run is a no-op.
 *
 * Documented choices (spec 9):
 *   - pay_date: the source has none; we use the 15TH of the period month
 *     (owner-confirmed 2026-07-29: the legacy flow paid mid-month — the same
 *     day the app's own default pay schedule uses).
 *   - hire_date: the source has none; we use the earliest compensation
 *     effective_from (first paid period).
 *   - result in run_snapshot: the recomputed engine result. After validation
 *     it equals the stored entries to the cent on all nine stored categories,
 *     EXCEPT for the owner-approved legacy deviations (STORED_AMOUNT_OVERRIDES
 *     below — Q1-2026 941 true-up) where the stored ISSUED amount is the truth
 *     and the divergence is recorded in the snapshot's legacyDeviations. The
 *     derived fields (totalDeductions, totalEmployerCost, ytdGross) exist
 *     only in engine-land, so the recomputed result is the complete + honest
 *     value. engineVersion is recorded as 'legacy-import'.
 *   - Idempotency: legacy_migration_map (entity, source_id) → target_id.
 *     A target run occupying a migrated period WITHOUT a map entry (i.e.
 *     app-created) is a conflict and halts the migration rather than
 *     clobbering live data.
 */

import { and, eq, ne } from "drizzle-orm";
import {
  company,
  compensation,
  employees,
  legacyMigrationMap,
  payrollEntries,
  payrollRuns,
  taxBrackets,
  taxConfig,
  w4Elections,
} from "@payroll/db";
import {
  calculatePayroll,
  FUTA_STATUTORY_RATE,
  type PayrollResult,
  type TaxConfig,
} from "@payroll/engine";
import { round2 } from "@payroll/engine/money";
import type { Db } from "../db.js";
import {
  LEGACY_SNAPSHOT_TEMPLATE_VERSION,
  snapshotHash,
  type RunSnapshot,
  type SnapshotBracket,
  type SnapshotTaxConfig,
  type SnapshotW4,
} from "../payroll/snapshot.js";
import {
  asDate,
  isoDate,
  readSource,
  type SourceData,
  type SourceDb,
  type SourceRun,
} from "./source.js";

export const LEGACY_ENGINE_VERSION = "legacy-import";
export const LEGACY_CREATED_BY = "legacy-import";
export const DEFAULT_FREQUENCY = "monthly";
export const PERIODS_PER_YEAR_MONTHLY = 12;

// ---------------------------------------------------------------------------
// Owner-approved legacy deviations (confirmed against the issued paystubs and
// the filed Q1-2026 Form 941).
//
// Q1-2026 was issued before the 2026 tables existed in the legacy routine and
// before the exempt W-4 (filed 2026-03-17, effective April):
//   - 2026-01 / 2026-02 were computed with the 2025 tables, so their snapshots
//     are reconstructed against the 2025 tax config.
//   - The Q1 941 was filed 2026-03-17 at a per-month federal rate above what
//     the wrong-table Jan/Feb stubs withheld.
//   - At stub regeneration, March absorbed the true-up so stub totals
//     reconcile with the filed return: the stored federal_withholding and
//     net_pay differ from the engine-recomputed amounts. Validation therefore
//     accepts the stored amounts for those two categories on 2026-03 only.
//
// This is the COMPLETE exception surface — validation stays to-the-cent on
// every other run and category.
// ---------------------------------------------------------------------------

/** period → tax-config year to reconstruct with (instead of run.year). */
const TAX_CONFIG_YEAR_OVERRIDES = new Map<string, number>([
  ["2026-01", 2025],
  ["2026-02", 2025],
]);

/** period → stored-entry categories whose stored amount is the issued truth. */
const STORED_AMOUNT_OVERRIDES = new Map<
  string,
  { categories: ReadonlySet<string>; reason: string }
>([
  [
    "2026-03",
    {
      categories: new Set(["federal_withholding", "net_pay"]),
      reason:
        "Q1-2026 Form 941 reconciliation true-up: the 941 was filed 2026-03-17 at a per-month " +
        "federal rate above what the wrong-table (2025) Jan/Feb stubs withheld; the March stub " +
        "absorbed both Jan/Feb corrections, so its stored federal_withholding and net_pay are " +
        "the issued truth and intentionally diverge from the engine-recomputed amounts " +
        "(owner-approved deviation).",
    },
  ],
]);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface ValidationFailure {
  sourceRunId: number;
  year: number;
  month: number;
  category: string;
  stored: string;
  recomputed: string;
}

/** Recomputed entries diverge from stored source entries — halt, write nothing. */
export class MigrationValidationError extends Error {
  constructor(public failures: ValidationFailure[]) {
    super(
      `snapshot reconstruction failed validation for ${failures.length} categor${
        failures.length === 1 ? "y" : "ies"
      } — migration halted, nothing was written`,
    );
  }
}

/** Structural problem (missing config, null dates, period conflict) — halt. */
export class MigrationHaltError extends Error {}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface EntityReport {
  entity: string;
  sourceRows: number;
  inserted: number;
  /** Already in the target (seeded or previously migrated). */
  existing: number;
}

export interface RunReport {
  sourceRunId: number;
  period: string;
  grossPay: string;
  netPay: string;
  inserted: boolean;
}

export interface MigrationReport {
  dryRun: boolean;
  entities: EntityReport[];
  runsValidated: number;
  runs: RunReport[];
  skippedTables: { table: string; rows: number }[];
  runsWithStubPath: number;
}

export interface MigrateOptions {
  /** Default true: full analysis + validation, zero writes. */
  dryRun?: boolean;
  verbose?: boolean;
  log?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// Entry-category ↔ result-field contract (both schemas use the same nine)
// ---------------------------------------------------------------------------

const ENTRY_FIELDS = [
  ["gross_pay", "grossPay"],
  ["federal_withholding", "federalWithholding"],
  ["social_security", "socialSecurity"],
  ["medicare", "medicare"],
  ["state_withholding", "stateWithholding"],
  ["net_pay", "netPay"],
  ["employer_social_security", "employerSocialSecurity"],
  ["employer_medicare", "employerMedicare"],
  ["employer_futa", "employerFUTA"],
] as const satisfies readonly (readonly [string, keyof PayrollResult])[];

function cents(n: number): string {
  return n.toFixed(2);
}

// ---------------------------------------------------------------------------
// Planned (validated, not yet written) entities
// ---------------------------------------------------------------------------

interface PlannedRun {
  source: SourceRun;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  snapshot: RunSnapshot;
  hash: string;
  entries: { category: string; amount: string }[];
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function toEngineConfig(
  cfg: SourceData["taxConfig"][number],
  brackets: SourceData["taxBrackets"],
): TaxConfig {
  return {
    year: cfg.tax_year,
    standardDeduction: Number(cfg.standard_deduction),
    federalBrackets: brackets.map((b) => ({
      min: Number(b.min_amount),
      max: b.max_amount === null ? Infinity : Number(b.max_amount),
      rate: Number(b.rate),
    })),
    socialSecurityRate: Number(cfg.social_security_rate),
    socialSecurityWageCap: Number(cfg.social_security_wage_cap),
    medicareRate: Number(cfg.medicare_rate),
    medicareAdditionalRate: Number(cfg.medicare_additional_rate),
    medicareAdditionalThreshold: Number(cfg.medicare_additional_threshold),
    stateWithholdingRate: Number(cfg.state_withholding_rate),
    employerSocialSecurityRate: Number(cfg.employer_social_security_rate),
    employerMedicareRate: Number(cfg.employer_medicare_rate),
    futaRate: Number(cfg.futa_rate),
    futaWageCap: Number(cfg.futa_wage_cap),
    // Legacy rows predate PAY-18: the credit is the residual vs statutory.
    sutaCreditRate: Math.round((FUTA_STATUTORY_RATE - Number(cfg.futa_rate)) * 100_000) / 100_000,
  };
}

function toSnapshotTaxConfig(cfg: SourceData["taxConfig"][number]): SnapshotTaxConfig {
  return {
    jurisdiction: "federal",
    taxYear: cfg.tax_year,
    standardDeduction: Number(cfg.standard_deduction),
    socialSecurityRate: Number(cfg.social_security_rate),
    socialSecurityWageCap: Number(cfg.social_security_wage_cap),
    medicareRate: Number(cfg.medicare_rate),
    medicareAdditionalRate: Number(cfg.medicare_additional_rate),
    medicareAdditionalThreshold: Number(cfg.medicare_additional_threshold),
    stateWithholdingRate: Number(cfg.state_withholding_rate),
    employerSocialSecurityRate: Number(cfg.employer_social_security_rate),
    employerMedicareRate: Number(cfg.employer_medicare_rate),
    futaRate: Number(cfg.futa_rate),
    futaWageCap: Number(cfg.futa_wage_cap),
    // Legacy rows predate PAY-18: the credit is the residual vs statutory.
    sutaCreditRate: Math.round((FUTA_STATUTORY_RATE - Number(cfg.futa_rate)) * 100_000) / 100_000,
  };
}

// ---------------------------------------------------------------------------
// Phase A — plan + validate
// ---------------------------------------------------------------------------

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: phase-A validate pipeline — linear by design (spec 9 halt semantics)
function planAndValidate(
  data: SourceData,
  log: (line: string) => void,
  verbose: boolean,
): { planned: PlannedRun[] } {
  const employee = data.employees[0];
  if (!employee) throw new MigrationHaltError("source has no employees row");
  if (data.employees.length > 1) {
    log(
      `note: source has ${data.employees.length} employees; migrating all runs against employee id ${employee.id} (sole-employee deployment)`,
    );
  }
  const companyName = employee.entity;

  // ---- per-run reconstruction, chronological (prior-YTD accumulates) ----
  const entriesByRun = new Map<number, Map<string, string>>();
  for (const e of data.entries) {
    let m = entriesByRun.get(e.run_id);
    if (!m) {
      m = new Map();
      entriesByRun.set(e.run_id, m);
    }
    m.set(e.category, e.amount);
  }

  const planned: PlannedRun[] = [];
  const failures: ValidationFailure[] = [];
  /** employeeId:taxYear → entry category → accumulated STORED sums (the historical truth). */
  const priorYtd = new Map<string, Map<string, number>>();

  for (const run of data.runs) {
    const mm = String(run.month).padStart(2, "0");
    const periodStart = `${run.year}-${mm}-01`;
    const lastDay = lastDayOfMonth(run.year, run.month);
    const periodEnd = `${run.year}-${mm}-${String(lastDay).padStart(2, "0")}`;
    // Spec 9 (amended 2026-07-29): source has no pay_date — the legacy flow
    // paid on the 15th of the period month (owner-confirmed).
    const payDate = `${run.year}-${mm}-15`;
    const periodLabel = `${run.year}-${mm}`;

    // Compensation covering the period's first day (source semantics:
    // effective_from <= day <= effective_to|∞).
    const comp = data.compensation.find(
      (c) =>
        c.employee_id === run.employee_id &&
        isoDate(c.effective_from) <= periodStart &&
        (c.effective_to === null || periodStart <= isoDate(c.effective_to)),
    );
    if (!comp) {
      throw new MigrationHaltError(
        `run ${run.id} (${periodLabel}): no source compensation covers ${periodStart}`,
      );
    }
    const periodAmount = Number(comp.monthly_salary);

    // W-4 election effective on the period (source semantics: election for
    // the period's tax year whose effective_from is on/before period start).
    const w4 = data.w4Elections.find(
      (w) =>
        w.employee_id === run.employee_id &&
        w.tax_year === run.year &&
        w.effective_from !== null &&
        isoDate(w.effective_from) <= periodStart,
    );
    const federalExempt = w4?.federal_exempt ?? false;
    const snapshotW4: SnapshotW4 | null = w4
      ? {
          filingStatus: "single",
          federalExempt: w4.federal_exempt,
          multipleJobs: false,
          dependentsAmount: 0,
          otherIncome: 0,
          deductionsAmount: 0,
          extraWithholding: 0,
          effectiveFrom: isoDate(w4.effective_from),
          filedDate: isoDate(w4.filed_date),
        }
      : null;

    // Statutory config for the period's year — with the owner-approved
    // legacy overrides: 2026-01/02 were issued against the 2025 tables
    // because the 2026 config did not yet exist in the legacy routine.
    const cfgYear = TAX_CONFIG_YEAR_OVERRIDES.get(periodLabel) ?? run.year;
    const cfg = data.taxConfig.find((c) => c.tax_year === cfgYear);
    if (!cfg) {
      throw new MigrationHaltError(
        `run ${run.id} (${periodLabel}): no source tax_config for ${cfgYear}`,
      );
    }
    const bracketRows = data.taxBrackets.filter((b) => b.tax_year === cfgYear);
    if (bracketRows.length === 0) {
      throw new MigrationHaltError(
        `run ${run.id} (${periodLabel}): no source tax_brackets for ${cfgYear}`,
      );
    }

    // Prior-YTD from previously validated STORED entries, in order.
    const ytdKey = `${run.employee_id}:${run.year}`;
    const ytdSoFarByCat = priorYtd.get(ytdKey) ?? new Map<string, number>();
    const ytdSoFar = ytdSoFarByCat.get("gross_pay") ?? 0;

    // Recompute through the vendored engine (the same math that produced the
    // legacy rows; the engine is vendored verbatim from mcp-accounting).
    const result = calculatePayroll({
      monthlySalary: periodAmount,
      periodsPerYear: PERIODS_PER_YEAR_MONTHLY,
      priorYtdGross: ytdSoFar,
      taxConfig: toEngineConfig(cfg, bracketRows),
      federalExempt,
    });

    // Validate: recomputed == stored, to the cent, all nine categories.
    const stored = entriesByRun.get(run.id);
    if (!stored) {
      throw new MigrationHaltError(
        `run ${run.id} (${periodLabel}): source run has no payroll_entries`,
      );
    }
    const storedOverride = STORED_AMOUNT_OVERRIDES.get(periodLabel);
    const deviations: NonNullable<RunSnapshot["legacyDeviations"]> = [];
    for (const [category, field] of ENTRY_FIELDS) {
      const storedAmount = stored.get(category);
      if (storedAmount === undefined) {
        throw new MigrationHaltError(
          `run ${run.id} (${periodLabel}): missing entry category '${category}'`,
        );
      }
      const recomputedAmount = cents(result[field] as number);
      if (Number(storedAmount).toFixed(2) !== recomputedAmount) {
        if (storedOverride?.categories.has(category)) {
          // Owner-approved deviation: the ISSUED amount is the truth; record
          // it in the snapshot instead of failing validation.
          deviations.push({
            category,
            stored: Number(storedAmount).toFixed(2),
            recomputed: recomputedAmount,
            reason: storedOverride.reason,
          });
          continue;
        }
        failures.push({
          sourceRunId: run.id,
          year: run.year,
          month: run.month,
          category,
          stored: Number(storedAmount).toFixed(2),
          recomputed: recomputedAmount,
        });
      }
    }
    // Accumulate YTD from stored amounts regardless — the halt report then
    // covers ALL divergent runs, not just the first.
    for (const [category] of ENTRY_FIELDS) {
      ytdSoFarByCat.set(
        category,
        round2((ytdSoFarByCat.get(category) ?? 0) + Number(stored.get(category))),
      );
    }
    priorYtd.set(ytdKey, ytdSoFarByCat);

    const snapshot: RunSnapshot = {
      inputs: {
        periodAmount,
        frequency: DEFAULT_FREQUENCY,
        periodsPerYear: PERIODS_PER_YEAR_MONTHLY,
        w4: snapshotW4,
        taxConfig: toSnapshotTaxConfig(cfg),
        brackets: bracketRows.map(
          (b): SnapshotBracket => ({
            min: Number(b.min_amount),
            max: b.max_amount === null ? null : Number(b.max_amount),
            rate: Number(b.rate),
          }),
        ),
        priorYtdGross: ytdSoFar,
        periodStart,
        periodEnd,
        payDate,
        company: { legalName: companyName },
        employee: { legalName: employee.full_name, preferredName: null },
      },
      result,
      engineVersion: LEGACY_ENGINE_VERSION,
      templateVersion: LEGACY_SNAPSHOT_TEMPLATE_VERSION,
      // YTD through this run, from STORED (validated) amounts — includes
      // owner-approved deviation runs (e.g. 2026-03 true-up) at their issued
      // values, which is exactly what an employee's YTD must reflect.
      ytd: {
        gross: ytdSoFarByCat.get("gross_pay") ?? 0,
        federalWithholding: ytdSoFarByCat.get("federal_withholding") ?? 0,
        socialSecurity: ytdSoFarByCat.get("social_security") ?? 0,
        medicare: ytdSoFarByCat.get("medicare") ?? 0,
        stateWithholding: ytdSoFarByCat.get("state_withholding") ?? 0,
        totalDeductions: round2(
          (ytdSoFarByCat.get("gross_pay") ?? 0) - (ytdSoFarByCat.get("net_pay") ?? 0),
        ),
        netPay: ytdSoFarByCat.get("net_pay") ?? 0,
      },
      ...(deviations.length > 0 ? { legacyDeviations: deviations } : {}),
      ...(cfgYear !== run.year
        ? {
            legacyNotes: [
              `reconstructed with the ${cfgYear} tax tables — issued before the ${run.year} ` +
                `config existed in the legacy routine (owner-approved override 2026-07-29)`,
            ],
          }
        : {}),
    };

    planned.push({
      source: run,
      periodStart,
      periodEnd,
      payDate,
      snapshot,
      hash: snapshotHash(snapshot),
      entries: ENTRY_FIELDS.map(([category]) => ({
        category,
        amount: Number(stored.get(category)).toFixed(2),
      })),
    });
    if (verbose) {
      log(
        `  validated ${periodLabel}: gross ${cents(result.grossPay)} / net ${cents(result.netPay)}` +
          (federalExempt ? " (W-4 exempt)" : "") +
          (deviations.length > 0 ? " (legacy deviation: stored issued amounts kept)" : ""),
      );
    }
  }

  if (failures.length > 0) throw new MigrationValidationError(failures);
  log(`phase A: ${planned.length} run(s) reconstructed and validated to the cent`);
  return { planned };
}

// ---------------------------------------------------------------------------
// Phase B — write
// ---------------------------------------------------------------------------

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: migration orchestrator — the two-phase flow reads top-to-bottom deliberately
export async function migrateLegacy(
  deps: { source: SourceDb; db: Db },
  options: MigrateOptions = {},
): Promise<MigrationReport> {
  const dryRun = options.dryRun ?? true;
  const verbose = options.verbose ?? false;
  const log = options.log ?? (() => {});

  log(`reading source (accounting schema)…`);
  const data = await readSource(deps.source);
  log(
    `source: ${data.employees.length} employee(s), ${data.compensation.length} compensation row(s), ` +
      `${data.w4Elections.length} W-4 election(s), ${data.taxConfig.length} tax year(s), ` +
      `${data.taxBrackets.length} bracket(s), ${data.runs.length} run(s), ${data.entries.length} entr${
        data.entries.length === 1 ? "y" : "ies"
      }`,
  );
  for (const s of data.skippedCounts) {
    log(
      `NOT migrated (spec 9): accounting.${s.table} (${s.rows < 0 ? "absent" : `${s.rows} row(s)`})`,
    );
  }
  if (data.runsWithStubPath > 0) {
    log(
      `NOT migrated (spec 9/D5): pay_stub_path on ${data.runsWithStubPath} run(s) — files stay in the legacy document store`,
    );
  }

  const { planned } = planAndValidate(data, log, verbose);

  // Existing migration ledger (drives idempotency; empty on first run).
  const existingMap = await deps.db.select().from(legacyMigrationMap);
  const mapped = new Map(existingMap.map((m) => [`${m.entity}:${m.sourceId}`, m.targetId]));
  if (mapped.size > 0)
    log(`ledger: ${mapped.size} row(s) already migrated — re-run will skip them`);

  // Rows already present by NATURAL key (e.g. `pnpm seed` ran at deploy) —
  // the write phase adopts them into the ledger instead of inserting.
  const companyPresent =
    (
      await deps.db
        .select({ id: company.id })
        .from(company)
        .where(eq(company.legalName, data.employees[0]?.entity ?? ""))
        .limit(1)
    ).length > 0;
  const taxConfigPresent = new Set(
    (
      await deps.db
        .select({ taxYear: taxConfig.taxYear })
        .from(taxConfig)
        .where(eq(taxConfig.jurisdiction, "federal"))
    ).map((r) => r.taxYear),
  );
  const bracketsPresent = new Set(
    (
      await deps.db
        .select({ taxYear: taxBrackets.taxYear, ordinal: taxBrackets.ordinal })
        .from(taxBrackets)
        .where(eq(taxBrackets.jurisdiction, "federal"))
    ).map((r) => `${r.taxYear}:${r.ordinal}`),
  );

  const src = data;
  const employee = src.employees[0]!;
  const report: MigrationReport = {
    dryRun,
    entities: [],
    runsValidated: planned.length,
    runs: [],
    skippedTables: data.skippedCounts,
    runsWithStubPath: data.runsWithStubPath,
  };

  const plannedRunRows: RunReport[] = planned.map((p) => ({
    sourceRunId: p.source.id,
    period: p.periodStart.slice(0, 7),
    grossPay: cents(p.snapshot.result.grossPay),
    netPay: cents(p.snapshot.result.netPay),
    inserted: !mapped.has(`run:${p.source.id}`),
  }));
  report.runs = plannedRunRows;

  const entityPlan: EntityReport[] = [
    {
      entity: "company",
      sourceRows: 1,
      inserted: mapped.has(`company:${employee.entity}`) || companyPresent ? 0 : 1,
      existing: mapped.has(`company:${employee.entity}`) || companyPresent ? 1 : 0,
    },
    {
      entity: "employee",
      sourceRows: src.employees.length,
      inserted: src.employees.filter((e) => !mapped.has(`employee:${e.id}`)).length,
      existing: src.employees.filter((e) => mapped.has(`employee:${e.id}`)).length,
    },
    {
      entity: "compensation",
      sourceRows: src.compensation.length,
      inserted: src.compensation.filter((c) => !mapped.has(`compensation:${c.id}`)).length,
      existing: src.compensation.filter((c) => mapped.has(`compensation:${c.id}`)).length,
    },
    {
      entity: "w4_elections",
      sourceRows: src.w4Elections.length,
      inserted: src.w4Elections.filter((w) => !mapped.has(`w4:${w.id}`)).length,
      existing: src.w4Elections.filter((w) => mapped.has(`w4:${w.id}`)).length,
    },
    {
      entity: "tax_config",
      sourceRows: src.taxConfig.length,
      inserted: src.taxConfig.filter(
        (c) => !mapped.has(`tax_config:${c.tax_year}`) && !taxConfigPresent.has(c.tax_year),
      ).length,
      existing: src.taxConfig.filter(
        (c) => mapped.has(`tax_config:${c.tax_year}`) || taxConfigPresent.has(c.tax_year),
      ).length,
    },
    {
      entity: "tax_brackets",
      sourceRows: src.taxBrackets.length,
      inserted: src.taxBrackets.filter(
        (b) =>
          !mapped.has(`tax_brackets:${b.id}`) && !bracketsPresent.has(`${b.tax_year}:${b.ordinal}`),
      ).length,
      existing: src.taxBrackets.filter(
        (b) =>
          mapped.has(`tax_brackets:${b.id}`) || bracketsPresent.has(`${b.tax_year}:${b.ordinal}`),
      ).length,
    },
    {
      entity: "payroll_runs",
      sourceRows: planned.length,
      inserted: plannedRunRows.filter((r) => r.inserted).length,
      existing: plannedRunRows.filter((r) => !r.inserted).length,
    },
  ];
  report.entities = entityPlan;

  if (dryRun) {
    log(`dry-run plan (zero writes):`);
    for (const e of entityPlan) {
      log(
        `  ${e.entity}: ${e.sourceRows} source row(s) — ${e.inserted} to insert, ${e.existing} already migrated`,
      );
    }
    log(`re-run with --write to perform the migration`);
    return report;
  }

  // ------------------------------------------------------------- writes
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: phase-B write transaction — single atomic flow, spec 9
  await deps.db.transaction(async (tx) => {
    const record = async (entity: string, sourceId: string | number, targetId: string | number) => {
      await tx.insert(legacyMigrationMap).values({
        entity,
        sourceId: String(sourceId),
        targetId: String(targetId),
      });
    };

    // company — find-or-create by legal name (the seed usually beat us to it).
    let companyId: number;
    const companyKey = `company:${employee.entity}`;
    const mappedCompany = mapped.get(companyKey);
    if (mappedCompany) {
      companyId = Number(mappedCompany);
    } else {
      const found = await tx
        .select()
        .from(company)
        .where(eq(company.legalName, employee.entity))
        .limit(1);
      if (found[0]) {
        companyId = found[0].id;
        log(`company '${employee.entity}' already present (id ${companyId}) — adopting`);
      } else {
        const inserted = await tx
          .insert(company)
          .values({ legalName: employee.entity })
          .returning();
        companyId = inserted[0]!.id;
        log(`company '${employee.entity}' created (id ${companyId})`);
      }
      await record("company", employee.entity, companyId);
    }

    // employee — hire_date = earliest compensation effective_from (documented).
    const employeeKey = `employee:${employee.id}`;
    let targetEmployeeId: number;
    const mappedEmployee = mapped.get(employeeKey);
    if (mappedEmployee) {
      targetEmployeeId = Number(mappedEmployee);
    } else {
      const hireDate = src.compensation
        .filter((c) => c.employee_id === employee.id)
        .map((c) => isoDate(c.effective_from))
        .sort()[0];
      if (!hireDate)
        throw new MigrationHaltError("cannot derive hire_date: employee has no compensation rows");
      const inserted = await tx
        .insert(employees)
        .values({
          companyId,
          employmentType: "w2",
          legalName: employee.full_name,
          hireDate,
          status: "active",
          createdAt: asDate(employee.created_at),
        })
        .returning();
      targetEmployeeId = inserted[0]!.id;
      await record("employee", employee.id, targetEmployeeId);
      log(
        `employee '${employee.full_name}' created (id ${targetEmployeeId}, hire_date ${hireDate})`,
      );
    }

    // compensation — natural key (employee, effective_from).
    for (const c of src.compensation.filter((c) => c.employee_id === employee.id)) {
      const key = `compensation:${c.id}`;
      if (mapped.has(key)) continue;
      const from = isoDate(c.effective_from);
      const found = await tx
        .select()
        .from(compensation)
        .where(
          and(eq(compensation.employeeId, targetEmployeeId), eq(compensation.effectiveFrom, from)),
        )
        .limit(1);
      if (found[0]) {
        await record("compensation", c.id, found[0].id);
        continue;
      }
      const inserted = await tx
        .insert(compensation)
        .values({
          employeeId: targetEmployeeId,
          periodAmount: Number(c.monthly_salary).toFixed(2),
          frequency: DEFAULT_FREQUENCY,
          effectiveFrom: from,
          effectiveTo: c.effective_to === null ? null : isoDate(c.effective_to),
        })
        .returning();
      await record("compensation", c.id, inserted[0]!.id);
    }

    // W-4 elections — natural key (employee, tax_year, effective_from).
    for (const w of src.w4Elections.filter((w) => w.employee_id === employee.id)) {
      const key = `w4:${w.id}`;
      if (mapped.has(key)) continue;
      if (w.effective_from === null) {
        throw new MigrationHaltError(
          `source w4_elections id ${w.id} (${w.tax_year}) has NULL effective_from — the target schema requires it`,
        );
      }
      const from = isoDate(w.effective_from);
      const found = await tx
        .select()
        .from(w4Elections)
        .where(
          and(
            eq(w4Elections.employeeId, targetEmployeeId),
            eq(w4Elections.taxYear, w.tax_year),
            eq(w4Elections.effectiveFrom, from),
          ),
        )
        .limit(1);
      if (found[0]) {
        await record("w4", w.id, found[0].id);
        continue;
      }
      const inserted = await tx
        .insert(w4Elections)
        .values({
          employeeId: targetEmployeeId,
          taxYear: w.tax_year,
          filingStatus: "single",
          federalExempt: w.federal_exempt,
          multipleJobs: false,
          dependentsAmount: "0",
          otherIncome: "0",
          deductionsAmount: "0",
          extraWithholding: "0",
          effectiveFrom: from,
          filedDate: isoDate(w.filed_date),
          renewalDeadline: w.renewal_deadline === null ? null : isoDate(w.renewal_deadline),
          note: w.note ?? "",
        })
        .returning();
      await record("w4", w.id, inserted[0]!.id);
    }

    // tax_config — natural key (jurisdiction, tax_year); seed usually present.
    for (const c of src.taxConfig) {
      const key = `tax_config:${c.tax_year}`;
      if (mapped.has(key)) continue;
      const found = await tx
        .select()
        .from(taxConfig)
        .where(and(eq(taxConfig.jurisdiction, "federal"), eq(taxConfig.taxYear, c.tax_year)))
        .limit(1);
      if (found[0]) {
        await record("tax_config", c.tax_year, found[0].id);
        continue;
      }
      const inserted = await tx
        .insert(taxConfig)
        .values({
          jurisdiction: "federal",
          taxYear: c.tax_year,
          standardDeduction: c.standard_deduction,
          socialSecurityRate: c.social_security_rate,
          socialSecurityWageCap: c.social_security_wage_cap,
          medicareRate: c.medicare_rate,
          medicareAdditionalRate: c.medicare_additional_rate,
          medicareAdditionalThreshold: c.medicare_additional_threshold,
          stateWithholdingRate: c.state_withholding_rate,
          employerSocialSecurityRate: c.employer_social_security_rate,
          employerMedicareRate: c.employer_medicare_rate,
          futaRate: c.futa_rate,
          futaWageCap: c.futa_wage_cap,
        })
        .returning();
      await record("tax_config", c.tax_year, inserted[0]!.id);
    }

    // tax_brackets — natural key (jurisdiction, tax_year, ordinal).
    for (const b of src.taxBrackets) {
      const key = `tax_brackets:${b.id}`;
      if (mapped.has(key)) continue;
      const found = await tx
        .select()
        .from(taxBrackets)
        .where(
          and(
            eq(taxBrackets.jurisdiction, "federal"),
            eq(taxBrackets.taxYear, b.tax_year),
            eq(taxBrackets.ordinal, b.ordinal),
          ),
        )
        .limit(1);
      if (found[0]) {
        await record("tax_brackets", b.id, found[0].id);
        continue;
      }
      const inserted = await tx
        .insert(taxBrackets)
        .values({
          jurisdiction: "federal",
          taxYear: b.tax_year,
          ordinal: b.ordinal,
          minAmount: b.min_amount,
          maxAmount: b.max_amount,
          rate: b.rate,
        })
        .returning();
      await record("tax_brackets", b.id, inserted[0]!.id);
    }

    // payroll runs + entries — the payload of the whole exercise.
    let insertedRuns = 0;
    for (const p of planned) {
      const key = `run:${p.source.id}`;
      if (mapped.has(key)) continue;

      // Refuse to clobber an APP-CREATED run occupying this period.
      const occupying = await tx
        .select({ id: payrollRuns.id })
        .from(payrollRuns)
        .where(
          and(
            eq(payrollRuns.employeeId, targetEmployeeId),
            eq(payrollRuns.periodStart, p.periodStart),
            ne(payrollRuns.status, "void"),
          ),
        )
        .limit(1);
      if (occupying[0]) {
        throw new MigrationHaltError(
          `period ${p.periodStart.slice(0, 7)} already has run id ${occupying[0].id} in the target ` +
            `(not from a previous migration) — refusing to clobber app-created data; resolve manually`,
        );
      }

      const createdAt = asDate(p.source.created_at);
      const inserted = await tx
        .insert(payrollRuns)
        .values({
          employeeId: targetEmployeeId,
          periodStart: p.periodStart,
          periodEnd: p.periodEnd,
          payDate: p.payDate,
          status: "issued",
          runSnapshot: p.snapshot,
          snapshotHash: p.hash,
          createdBy: LEGACY_CREATED_BY,
          issuedAt: createdAt, // spec 9: issued_at = created_at
          createdAt,
          updatedAt: asDate(p.source.updated_at),
        })
        .returning();
      const runId = inserted[0]!.id;
      await tx
        .insert(payrollEntries)
        .values(p.entries.map((e) => ({ runId, category: e.category, amount: e.amount })));
      await record("run", p.source.id, runId);
      insertedRuns += 1;
      if (verbose)
        log(
          `  imported run ${p.periodStart.slice(0, 7)} (source id ${p.source.id} → run id ${runId})`,
        );
    }
    log(
      `phase B: ${insertedRuns} run(s) imported, ${planned.length - insertedRuns} skipped (already migrated)`,
    );
  });

  log(`--write complete:`);
  for (const e of report.entities) {
    log(`  ${e.entity}: ${e.inserted} inserted, ${e.existing} already present`);
  }
  return report;
}
