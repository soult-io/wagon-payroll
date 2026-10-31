/**
 * Official IRS Form 941 renderer (PAY-16): fill the bundled AcroForm
 * template (assets/forms/<year>/f941.pdf, checksummed — D2) with the frozen
 * quarterly worksheet snapshot, then FLATTEN so the download is a finished
 * document, not an editable form. Rendered on demand, never stored — same
 * doctrine as payslips and W-2/W-3.
 *
 * Figures come straight from the stored Worksheet941 JSON (strings, no float
 * round-trip), so the PDF provably matches the worksheet behind the filing's
 * snapshot hash. Creation/modification metadata is pinned to the template's
 * revision date: identical worksheets render byte-identical PDFs.
 *
 * Signature journey (decided 2026-09-12, ticket caveat resolved): the
 * signature, date, and Part 5 print-name/title/phone boxes are left BLANK —
 * the admin wet-signs the printed copy (or e-signs the download) before the
 * Letterstream mail upload. Notably the official AcroForm itself does not
 * make the signature/date fillable. A typed-name "signature" is only valid
 * for e-file, not paper, so nothing is pre-filled there.
 *
 * prepareF941 returns the filled document BEFORE flattening so tests can
 * assert field placement; renderF941Pdf flattens and serializes.
 */

import { Buffer } from "node:buffer";
import { PDFDocument, type PDFForm } from "pdf-lib";
import { templateBytes } from "./forms/templates.js";
import { F941_REVISION_DATE, f941FieldMap, type MoneyField } from "./forms/f941-field-map.js";
import type { FormAddress } from "./w2.js";

/** Everything a filled Form 941 renders from — the frozen worksheet + company. */
export interface F941Input {
  taxYear: number;
  /** 1–4. */
  quarter: number;
  employer: {
    legalName: string;
    /** EIN on file ("##-#######" or 9 plain digits), or null when unset. */
    ein: string | null;
    address: FormAddress | null;
  };
  /** Worksheet figures, exactly as stored (money as "1234.56" strings). */
  line1Employees: number;
  line2Wages: string;
  line3FederalWithheld: string;
  line5aTaxableSsWages: string;
  line5aTax: string;
  line5cTaxableMedicareWages: string;
  line5cTax: string;
  /** Line 5d column 1; absent on worksheets saved before PAY-98 (left blank). */
  line5dAdditionalMedicareWages?: string;
  line5dAdditionalMedicare: string;
  line5eTotal: string;
  line6TotalTaxes: string;
  line7FractionsOfCents: string;
  line10TotalAfterAdjustments: string;
  line11ResearchCredit: string;
  line12TotalAfterCredits: string;
  line13Deposits: string;
  line14BalanceDue: string;
  line15Overpayment: string;
  line16: { month1: string; month2: string; month3: string; deMinimis: boolean };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Split a money string into the IRS dollars/cents box pair, string-based so
 * cent fidelity is exact. Negatives (line 7 can be "-0.02") carry the minus
 * on the dollars box: "-0" / "02".
 */
export function splitMoneyPair(value: string): { dollars: string; cents: string } {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) throw new Error(`not a money string: ${JSON.stringify(value)}`);
  const cents = (m[3] ?? "").padEnd(2, "0").slice(0, 2) || "00";
  return { dollars: `${m[1]}${m[2]}`, cents };
}

/** "12-3456789" or "123456789" → { first2: "12", last7: "3456789" }. */
export function splitEin(ein: string): { first2: string; last7: string } {
  const digits = ein.replaceAll(/\D/g, "");
  return { first2: digits.slice(0, 2), last7: digits.slice(2) };
}

/** Shared official-form fill helpers (941 + 940): blank values stay blank. */
export function fillText(form: PDFForm, fieldName: string, value: string | null): void {
  if (!value) return; // blank boxes stay blank
  form.getTextField(fieldName).setText(value);
}

export function fillMoney(form: PDFForm, field: MoneyField, value: string | null): void {
  if (value === null) return;
  const { dollars, cents } = splitMoneyPair(value);
  form.getTextField(field.dollars).setText(dollars);
  form.getTextField(field.cents).setText(cents);
}

export function fillEin(
  form: PDFForm,
  first2Field: string,
  last7Field: string,
  ein: string | null,
): void {
  if (!ein) return;
  const { first2, last7 } = splitEin(ein);
  form.getTextField(first2Field).setText(first2);
  form.getTextField(last7Field).setText(last7);
}

// ---------------------------------------------------------------------------
// Form 941 — fill, flatten, serialize
// ---------------------------------------------------------------------------

/**
 * Fill the template — NOT flattened (tests read the field values back).
 * Page 3 is the Form 941-V payment voucher: filled only when line 14 shows
 * a balance due; its boxes stay blank otherwise (a blank voucher page is
 * harmless and keeps the download a constant 3 pages).
 */
export async function prepareF941(input: F941Input): Promise<PDFDocument> {
  const map = f941FieldMap(input.taxYear as 2025 | 2026);
  const doc = await PDFDocument.load(templateBytes(input.taxYear, "f941"));
  const form = doc.getForm();
  const { employer } = input;

  // Entity area + report-for-quarter.
  fillEin(form, map.einFirst2, map.einLast7, employer.ein);
  fillText(form, map.legalName, employer.legalName);
  const street = [employer.address?.line1, employer.address?.line2].filter(Boolean).join(" ");
  fillText(form, map.street, street || null);
  fillText(form, map.city, employer.address?.city ?? null);
  fillText(form, map.state, employer.address?.state ?? null);
  fillText(form, map.zip, employer.address?.zip ?? null);
  form.getCheckBox(map.quarterCheckboxes[input.quarter - 1]!).check();

  // Part 1 — the worksheet, line for line. Lines the worksheet does not
  // carry stay blank: 4 (wages ARE subject), 5b (tips), 5f, 8, 9; 5d col 1 on
  // worksheets saved before PAY-98.
  fillText(form, map.line1Employees, String(input.line1Employees));
  fillMoney(form, map.line2Wages, input.line2Wages);
  fillMoney(form, map.line3FederalWithheld, input.line3FederalWithheld);
  fillMoney(form, map.line5aWages, input.line5aTaxableSsWages);
  fillMoney(form, map.line5aTax, input.line5aTax);
  fillMoney(form, map.line5cWages, input.line5cTaxableMedicareWages);
  fillMoney(form, map.line5cTax, input.line5cTax);
  fillMoney(form, map.line5dWages, input.line5dAdditionalMedicareWages ?? null);
  fillMoney(form, map.line5dTax, input.line5dAdditionalMedicare);
  fillMoney(form, map.line5eTotal, input.line5eTotal);
  fillMoney(form, map.line6TotalTaxes, input.line6TotalTaxes);
  fillMoney(form, map.line7FractionsOfCents, input.line7FractionsOfCents);
  fillMoney(form, map.line10TotalAfterAdjustments, input.line10TotalAfterAdjustments);
  fillMoney(form, map.line11ResearchCredit, input.line11ResearchCredit);
  fillMoney(form, map.line12TotalAfterCredits, input.line12TotalAfterCredits);
  fillMoney(form, map.line13Deposits, input.line13Deposits);
  fillMoney(form, map.line14BalanceDue, input.line14BalanceDue);
  fillMoney(form, map.line15Overpayment, input.line15Overpayment);
  // The line-15 election (apply vs refund) is a taxpayer choice made at
  // signing time — both boxes stay unchecked, like Part 5.

  // Page 2 — header + line 16 deposit schedule. The worksheet knows the de
  // minimis branch; monthly schedule otherwise (never semiweekly).
  fillText(form, map.page2Name, employer.legalName);
  fillEin(form, map.page2EinFirst2, map.page2EinLast7, employer.ein);
  if (input.line16.deMinimis) {
    form.getCheckBox(map.line16DeMinimis).check();
  } else {
    form.getCheckBox(map.line16Monthly).check();
    fillMoney(form, map.line16Month1, input.line16.month1);
    fillMoney(form, map.line16Month2, input.line16.month2);
    fillMoney(form, map.line16Month3, input.line16.month3);
    const total = (
      Number(input.line16.month1) +
      Number(input.line16.month2) +
      Number(input.line16.month3)
    ).toFixed(2);
    fillMoney(form, map.line16Total, total);
  }

  // Page 3 — Form 941-V payment voucher, only when a balance is due.
  if (Number(input.line14BalanceDue) > 0) {
    fillEin(form, map.voucherEinFirst2, map.voucherEinLast7, employer.ein);
    fillMoney(form, map.voucherAmount, input.line14BalanceDue);
    form.getCheckBox(map.voucherQuarterCheckboxes[input.quarter - 1]!).check();
    fillText(form, map.voucherName, employer.legalName);
    fillText(form, map.voucherStreet, street || null);
    const cityStateZip = employer.address
      ? `${employer.address.city}, ${employer.address.state} ${employer.address.zip}`
      : null;
    fillText(form, map.voucherCityStateZip, cityStateZip);
  }

  return doc;
}

/** Filled official Form 941 (+ 941-V voucher page) — flattened, 3 pages. */
export async function renderF941Pdf(input: F941Input): Promise<Buffer> {
  const doc = await prepareF941(input);
  doc.getForm().flatten();
  // Pin metadata to the template revision: identical worksheets render
  // byte-identical PDFs (render time deliberately not recorded).
  const revision = new Date(
    F941_REVISION_DATE[input.taxYear] ?? `${input.taxYear}-03-01T00:00:00Z`,
  );
  doc.setCreationDate(revision);
  doc.setModificationDate(revision);
  return Buffer.from(await doc.save());
}
