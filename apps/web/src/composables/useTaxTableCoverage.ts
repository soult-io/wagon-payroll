/**
 * PAY-103 R18: which payroll years are missing tax tables, for the admin
 * banner. Coverage and "today" come only from the server (company-local
 * date), never from the browser clock.
 *
 * A notice, not a gate: a failed read shows no banner and no toast (same rule
 * as the dashboard's local-tax check). The email alert does not depend on it.
 */

import { stateName } from "@payroll/shared";
import { computed, ref } from "vue";
import { adminPayrollApi, type TaxTableCoverageResponse } from "../lib/api";

export interface MissingTaxTablesLine {
  year: number;
  /** Bold lead, so the meaning does not depend on colour. */
  lead: string;
  text: string;
  /** The year is the server's current year: payroll is on hold now. */
  onHold: boolean;
}

/** "A", "A and B", "A, B and C" (no serial comma), as the notification emails join lists. */
function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

const RATES = "(the yearly rates used to work out paycheck taxes)";

function lineFor(
  year: number,
  federalMissing: boolean,
  missingStates: string[],
  currentYear: number,
): MissingTaxTablesLine {
  // Display order is by state name, not USPS code (copy §0).
  const stateNames = missingStates.map((c) => stateName(c)).sort();
  const jurisdictions = joinLabels([...(federalMissing ? ["federal"] : []), ...stateNames]);
  const states = joinLabels(stateNames);
  const tables = `The ${year} ${jurisdictions} tax tables ${RATES}`;
  const onHold = year <= currentYear;
  if (onHold) {
    return federalMissing
      ? {
          year,
          onHold,
          lead: `${year} payroll is on hold.`,
          text: `${tables} aren't installed, so no payroll with a ${year} pay date can be prepared until they are.`,
        }
      : {
          year,
          onHold,
          lead: `${year} payroll is on hold for employees in ${states}.`,
          text: `${tables} aren't installed, so their payroll with a ${year} pay date can't be prepared until they are. Everyone else's payroll goes ahead as usual.`,
        };
  }
  const forWhom = federalMissing ? "" : ` for employees who work in ${states}`;
  return {
    year,
    onHold,
    lead: `${year} tax tables aren't installed yet.`,
    text: `${tables} aren't in place, so payroll with a ${year} pay date can't be prepared${forWhom} until they're installed. Your ${year - 1} payrolls aren't affected.`,
  };
}

export function useTaxTableCoverage() {
  const coverage = ref<TaxTableCoverageResponse | null>(null);

  async function load(): Promise<void> {
    try {
      coverage.value = await adminPayrollApi.taxTableCoverage();
    } catch {
      coverage.value = null; // a notice; the page works without it
    }
  }

  /** Uncovered years, current year first. */
  const lines = computed<MissingTaxTablesLine[]>(() => {
    const cov = coverage.value;
    if (!cov) return [];
    const currentYear = Number(cov.today.slice(0, 4));
    return cov.years
      .filter((y) => !y.federal || y.missingStates.length > 0)
      .sort((a, b) => a.year - b.year)
      .map((y) => lineFor(y.year, !y.federal, y.missingStates, currentYear));
  });

  /** error while any listed year is on hold now, else warn. */
  const severity = computed<"error" | "warn">(() =>
    lines.value.some((l) => l.onHold) ? "error" : "warn",
  );

  return { coverage, load, lines, severity };
}
