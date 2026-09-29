/**
 * Official IRS-form W-2/W-3 renderers (PAY-19): fill the bundled AcroForm
 * templates (assets/forms/<year>/, checksummed — D2) with figures assembled
 * server-side from frozen issued-run payroll_entries, then FLATTEN so the
 * download is a finished document, not an editable form.
 *
 * Deliverables (D1): the employee packet is ONE PDF — Copy B + Copy C +
 * Copy 2 pages plus the official IRS Notice/Instructions-for-Employee pages
 * (bundling satisfies Pub 1141 §3.1.05); the admin gets Copy D per employee
 * and a filled official W-3 for records. Actual W-2/W-3 filing stays manual
 * via SSA BSO. Copies A (SSA scannable) and 1 (state) are never emitted.
 *
 * The W-2/W-3 PDFs carry FULL figures plus PII (employee SSN + address,
 * company EIN): the server decrypts PII at render time only, and nothing
 * here persists or logs it (PAY-11 doctrine, unchanged).
 *
 * prepare* functions return the filled document BEFORE flattening so tests
 * can assert field placement (boxes 1–6 to the cent in the exact AcroForm
 * fields) — the render* functions flatten and serialize.
 */

import { Buffer } from "node:buffer";
import { PDFDocument, type PDFForm } from "pdf-lib";
import { templateBytes } from "./forms/templates.js";
import {
  W2_ADMIN_COPIES,
  W2_ADMIN_COPY_D_PAGES,
  W2_EMPLOYEE_COPIES,
  W2_EMPLOYEE_PAGES,
  W3_CHECKBOXES,
  W3_FIELD_MAP,
  w2FieldMap,
  type W2Copy,
} from "./forms/field-map-2025.js";

export interface FormAddress {
  line1: string;
  line2?: string | undefined;
  city: string;
  state: string;
  zip: string;
  country: string;
}

/** Everything a W-2 renders from — assembled server-side from stored rows. */
export interface W2Input {
  taxYear: number;
  employer: {
    legalName: string;
    /** Decrypted EIN (formatted ##-####### on render), or null when unset. */
    ein: string | null;
    address: FormAddress | null;
  };
  employee: {
    legalName: string;
    /** Decrypted SSN, formatted ###-##-####; null when not yet on file. */
    ssn: string | null;
    address: FormAddress | null;
  };
  /** Box d control number — the employee ID (D5). */
  controlNumber: string;
  /** Box 1 — wages, tips, other compensation. */
  box1Wages: string;
  /** Box 2 — federal income tax withheld. */
  box2FederalWithheld: string;
  /** Box 3 — Social Security wages (capped). */
  box3SsWages: string;
  /** Box 4 — Social Security tax withheld (employee share). */
  box4SsTax: string;
  /** Box 5 — Medicare wages and tips (no cap). */
  box5MedicareWages: string;
  /** Box 6 — Medicare tax withheld (employee share). */
  box6MedicareTax: string;
}

/** W-3 transmittal — the box-by-box aggregate across all W-2s of the year. */
export interface W3Input {
  taxYear: number;
  employer: W2Input["employer"];
  /** Number of W-2 statements summarized. */
  employeeCount: number;
  box1Wages: string;
  box2FederalWithheld: string;
  box3SsWages: string;
  box4SsTax: string;
  box5MedicareWages: string;
  box6MedicareTax: string;
}

// ---------------------------------------------------------------------------
// Formatting helpers (official forms: plain figures, no $ or thousands commas)
// ---------------------------------------------------------------------------

/** Fixed-message rejection of a W-2/W-3 box value. Never echoes the value. */
export class W2FormAmountError extends Error {
  constructor() {
    super("W-2/W-3 box amount is not an unsigned money string");
    this.name = "W2FormAmountError";
  }
}

/**
 * "8000.00" — IRS information-return convention (no $, no commas). PAY-162:
 * boxes arrive as formatCents strings; only unsigned "d+.dd" is printable
 * (W-2 money boxes are unsigned), anything else throws without echoing it.
 */
function money(amount: string): string {
  if (!/^\d+\.\d{2}$/.test(amount)) throw new W2FormAmountError();
  return amount;
}

/** "123456789" → "12-3456789"; anything already formatted passes through. */
export function formatEin(plain: string): string {
  return /^(\d{2})(\d{7})$/.exec(plain)?.slice(1).join("-") ?? plain;
}

/** "Ada Marie Lovelace" → { first: "Ada Marie", last: "Lovelace" }. */
export function splitLegalName(legalName: string): { first: string; last: string } {
  const parts = legalName.trim().split(/\s+/);
  const last = parts.pop() ?? "";
  return { first: parts.join(" "), last };
}

/** Address as form lines; country appended only when not US. */
function addressLines(address: FormAddress | null): string[] {
  if (!address) return [];
  const lines = [address.line1];
  if (address.line2) lines.push(address.line2);
  lines.push(`${address.city}, ${address.state} ${address.zip}`);
  if (address.country !== "US") lines.push(address.country);
  return lines;
}

function fillText(form: PDFForm, fieldName: string, value: string | null): void {
  if (!value) return; // blank boxes stay blank (D5: boxes 7–14, state/local)
  form.getTextField(fieldName).setText(value);
}

// ---------------------------------------------------------------------------
// Form W-2 — fill each copy, prune, assemble the packet
// ---------------------------------------------------------------------------

/** Fill one copy (single-up layout: one field set per copy page). */
function fillW2Copy(form: PDFForm, copy: W2Copy, input: W2Input): void {
  const map = w2FieldMap(copy);
  fillText(form, map.ssn, input.employee.ssn);
  fillText(form, map.ein, input.employer.ein ? formatEin(input.employer.ein) : null);
  const employer = [input.employer.legalName, ...addressLines(input.employer.address)];
  fillText(form, map.employerNameAddress, employer.join("\n"));
  fillText(form, map.controlNumber, input.controlNumber);
  const name = splitLegalName(input.employee.legalName);
  fillText(form, map.employeeFirstName, name.first);
  fillText(form, map.employeeLastName, name.last);
  fillText(form, map.employeeAddress, addressLines(input.employee.address).join("\n"));
  fillText(form, map.box1Wages, money(input.box1Wages));
  fillText(form, map.box2FederalWithheld, money(input.box2FederalWithheld));
  fillText(form, map.box3SsWages, money(input.box3SsWages));
  fillText(form, map.box4SsTax, money(input.box4SsTax));
  fillText(form, map.box5MedicareWages, money(input.box5MedicareWages));
  fillText(form, map.box6MedicareTax, money(input.box6MedicareTax));
}

/** Remove all pages except the kept 0-indexed ones (descending order). */
function removePagesExcept(doc: PDFDocument, keep: readonly number[]): void {
  for (let i = doc.getPageCount() - 1; i >= 0; i -= 1) {
    if (!keep.includes(i)) doc.removePage(i);
  }
}

/** Fill the wanted copies on the full template — NOT flattened (tests). */
async function fillW2Document(input: W2Input, copies: W2Copy[]): Promise<PDFDocument> {
  const doc = await PDFDocument.load(templateBytes(input.taxYear, "fw2"));
  const form = doc.getForm();
  for (const copy of copies) {
    fillW2Copy(form, copy, input);
  }
  return doc;
}

/** Employee packet pre-flatten: Copy B + C + 2 + instruction pages (D1). */
export function prepareW2EmployeePacket(input: W2Input): Promise<PDFDocument> {
  return fillW2Document(input, W2_EMPLOYEE_COPIES);
}

/** Admin Copy D packet pre-flatten (per employee, for employer records). */
export function prepareW2AdminCopyD(input: W2Input): Promise<PDFDocument> {
  return fillW2Document(input, W2_ADMIN_COPIES);
}

/**
 * Flatten the WHOLE document first (unfilled copies flatten to blank), then
 * prune to the kept pages — removing pages is trivial once no fields remain,
 * and this sidesteps field-removal quirks in the template's Copy A widgets.
 */
async function renderPacket(doc: PDFDocument, keep: readonly number[]): Promise<Buffer> {
  doc.getForm().flatten();
  removePagesExcept(doc, keep);
  return Buffer.from(await doc.save());
}

/**
 * The employee's ONE W-2 PDF: official Form W-2 filled + flattened — Copy B,
 * Copy C, Copy 2, and the IRS Notice/Instructions-for-Employee pages.
 */
export async function renderW2EmployeePacket(input: W2Input): Promise<Buffer> {
  return renderPacket(await prepareW2EmployeePacket(input), W2_EMPLOYEE_PAGES);
}

/** Admin Copy D (employer records) for one employee — filled + flattened. */
export async function renderW2AdminCopyD(input: W2Input): Promise<Buffer> {
  return renderPacket(await prepareW2AdminCopyD(input), W2_ADMIN_COPY_D_PAGES);
}

// ---------------------------------------------------------------------------
// Form W-3 — filled transmittal for employer records
// ---------------------------------------------------------------------------

/** Filled W-3 document pre-flatten (tests). */
export async function prepareW3(input: W3Input): Promise<PDFDocument> {
  const doc = await PDFDocument.load(templateBytes(input.taxYear, "fw3"));
  const form = doc.getForm();
  fillText(form, W3_FIELD_MAP.w2Count, String(input.employeeCount));
  fillText(form, W3_FIELD_MAP.ein, input.employer.ein ? formatEin(input.employer.ein) : null);
  fillText(form, W3_FIELD_MAP.employerName, input.employer.legalName);
  fillText(form, W3_FIELD_MAP.employerAddress, addressLines(input.employer.address).join("\n"));
  fillText(form, W3_FIELD_MAP.box1Wages, money(input.box1Wages));
  fillText(form, W3_FIELD_MAP.box2FederalWithheld, money(input.box2FederalWithheld));
  fillText(form, W3_FIELD_MAP.box3SsWages, money(input.box3SsWages));
  fillText(form, W3_FIELD_MAP.box4SsTax, money(input.box4SsTax));
  fillText(form, W3_FIELD_MAP.box5MedicareWages, money(input.box5MedicareWages));
  fillText(form, W3_FIELD_MAP.box6MedicareTax, money(input.box6MedicareTax));

  // Kind-of-payer "941" + kind-of-employer "None apply" (regular 941 corp,
  // D5): real per-choice checkboxes in the 2025 template.
  for (const name of Object.values(W3_CHECKBOXES)) {
    form.getCheckBox(name).check();
  }

  return doc;
}

/** Filled official W-3 for employer records — flattened, one page. */
export async function renderW3Pdf(input: W3Input): Promise<Buffer> {
  const doc = await prepareW3(input);
  doc.getForm().flatten();
  doc.removePage(0); // attention cover — after flatten, so no widgets dangle
  return Buffer.from(await doc.save());
}

/**
 * Structural facts about a rendered PDF — page count + remaining AcroForm
 * fields (0 once flattened). Exists so callers/tests can verify the
 * flatten + prune contract without depending on pdf-lib themselves.
 */
export async function pdfStructure(
  bytes: Uint8Array,
): Promise<{ pageCount: number; fieldCount: number }> {
  const doc = await PDFDocument.load(bytes);
  return { pageCount: doc.getPageCount(), fieldCount: doc.getForm().getFields().length };
}
