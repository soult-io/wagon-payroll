/**
 * Loader for the local-tax guard (Spec 25 (PAY-120), PAY-163): resolves the
 * inputs `checkLocalTaxSupport` needs from the database. The guard itself is
 * pure (local-guard.ts); this file is the only place that reads for it. It
 * never reads or decrypts the home address.
 */

import { localTaxCoverage } from "@payroll/db";
import type { LocalGuardCoverageRow, LocalGuardInput } from "./local-guard.js";
import { type DbLike, resolveResidence, resolveWorkState } from "./resolve.js";

/** The coverage list (empty when the seed was never run — the guard then fails closed). */
export async function loadLocalCoverage(db: DbLike): Promise<LocalGuardCoverageRow[]> {
  const rows = await db
    .select({
      code: localTaxCoverage.code,
      basis: localTaxCoverage.basis,
      handling: localTaxCoverage.handling,
    })
    .from(localTaxCoverage);
  return rows as LocalGuardCoverageRow[];
}

/**
 * Local tax jurisdiction → tax years with a table. PAY-163 (step G1) ships no
 * local tax tables, so every local the app would compute is reported as not
 * yet supported; the tables and this lookup arrive with step L1.
 */
export function loadLocalConfigYears(): Record<string, number[]> {
  return {};
}

export interface GuardEmployee {
  id: number;
  employmentType: string;
}

/**
 * Guard input for one employee. Residence resolves on the pay date; the work
 * state resolves on `workStateAsOf` (the period start in a pay run; the check
 * endpoint only has a pay date and passes that).
 */
export async function localGuardInputFor(
  db: DbLike,
  employee: GuardEmployee,
  dates: { payDate: string; workStateAsOf: string },
  shared: { coverage: LocalGuardCoverageRow[]; localConfigYears: Record<string, number[]> },
): Promise<LocalGuardInput> {
  const [residence, workState] = await Promise.all([
    resolveResidence(db, employee.id, dates.payDate),
    resolveWorkState(db, employee.id, dates.workStateAsOf),
  ]);
  return {
    taxYear: Number(dates.payDate.slice(0, 4)),
    payDate: dates.payDate,
    employmentType: employee.employmentType === "1099" ? "1099" : "w2",
    residence: residence
      ? {
          country: residence.country,
          stateCode: residence.stateCode,
          localityCode: residence.localityCode,
          createdAt: residence.createdAt.toISOString(),
        }
      : null,
    workState: workState
      ? {
          stateCode: workState.stateCode,
          localityCode: workState.localityCode,
          localityConfirmed: workState.localityConfirmedAt !== null,
        }
      : null,
    coverage: shared.coverage,
    localConfigYears: shared.localConfigYears,
  };
}
