/**
 * PAY-16: assemble the filled-Form-941 PDF input for a tax filing — the
 * filing's frozen worksheet snapshot (figures provably match the snapshot
 * hash) plus the company header (EIN decrypted at render time only, PII
 * never persisted in the PDF layer). The PDF itself renders on demand and
 * is never stored (payslip/W-2 doctrine).
 *
 * Signature journey (ticket caveat, decided): the PDF ships unsigned — the
 * admin wet-signs the printed copy or e-signs the download before the
 * Letterstream mail upload. Part 5's print-name/title/phone boxes stay
 * blank for the same reason.
 */

import type { F941Input } from "@payroll/documents";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { employerBlock } from "./annual.js";
import { getFilingDetail, type Worksheet941 } from "./service.js";
import { FilingServiceError } from "./shared.js";

interface Deps {
  db: Db;
  config: AppConfig;
}

/**
 * The 941 PDF input for one filing row. Reading the detail refreshes the
 * worksheet while unfiled (so the PDF tracks the current figures); filed
 * rows render their frozen snapshot. Throws invalid_input for non-941
 * filings and invalid_transition when no worksheet exists yet.
 */
export async function f941PdfInputFor(deps: Deps, filingId: number): Promise<F941Input> {
  const { db, config } = deps;
  const { filing } = await getFilingDetail(db, filingId);
  if (filing.formType !== "941") {
    throw new FilingServiceError("invalid_input", `filing ${filingId} is not a Form 941 filing`);
  }
  if (!filing.worksheet) {
    throw new FilingServiceError(
      "invalid_transition",
      "no worksheet for this filing yet — the PDF unlocks once the quarter's worksheet exists",
    );
  }
  const w = filing.worksheet as Worksheet941;
  return {
    taxYear: filing.year,
    quarter: filing.quarter,
    employer: await employerBlock(db, config),
    line1Employees: w.line1Employees,
    line2Wages: w.line2Wages,
    line3FederalWithheld: w.line3FederalWithheld,
    line5aTaxableSsWages: w.line5aTaxableSsWages,
    line5aTax: w.line5aTax,
    line5cTaxableMedicareWages: w.line5cTaxableMedicareWages,
    line5cTax: w.line5cTax,
    line5dAdditionalMedicareWages: w.line5dAdditionalMedicareWages,
    line5dAdditionalMedicare: w.line5dAdditionalMedicare,
    line5eTotal: w.line5eTotal,
    line6TotalTaxes: w.line6TotalTaxes,
    line7FractionsOfCents: w.line7FractionsOfCents,
    line10TotalAfterAdjustments: w.line10TotalAfterAdjustments,
    line11ResearchCredit: w.line11ResearchCredit,
    line12TotalAfterCredits: w.line12TotalAfterCredits,
    line13Deposits: w.line13Deposits,
    line14BalanceDue: w.line14BalanceDue,
    line15Overpayment: w.line15Overpayment,
    line16: w.line16,
  };
}
