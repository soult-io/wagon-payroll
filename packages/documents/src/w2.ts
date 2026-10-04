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
import {
  decodePDFRawStream,
  PDFArray,
  PDFDocument,
  type PDFForm,
  PDFRawStream,
  PDFStream,
  rgb,
  StandardFonts,
} from "pdf-lib";
import { templateBytes } from "./forms/templates.js";
import {
  W2_ADMIN_COPIES,
  W2_EMPLOYEE_COPIES,
  W3_CHECKBOXES,
  type W2Copy,
  type W2FieldMap,
} from "./forms/field-map-2025.js";
import { W2_COPY_PAGES_2026, type W2FieldMap2026 } from "./forms/field-map-2026.js";
import {
  hasStateRows,
  hasW3StateBoxes,
  type W2Layout,
  w2FieldMapFor,
  w2LayoutFor,
  w3FieldMapFor,
} from "./forms/w2-years.js";

export { CORRECTED_MARK } from "./forms/field-map-2025.js";

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
  /**
   * Spec 24 (PAY-116): boxes 15–17, one entry per printed row. Tax years
   * from 2026 only; absent or [] = no state boxes. A 2025 input with lines
   * is refused (S24-D5).
   */
  stateLines?: W2StateLineInput[] | undefined;
  /** Boxes 18–20 (Spec 25 (PAY-120)); same rules as stateLines. */
  localLines?: W2LocalLineInput[] | undefined;
  /** Number of W-2 forms (two state rows per form); absent = 1. */
  formCount?: number | undefined;
}

/** One W-2 state row (boxes 15–17) on form `form`, row `row`. */
export interface W2StateLineInput {
  /** Box 15 — two-letter state code. */
  state: string;
  /** Box 15 — decrypted employer state ID; null leaves it blank. */
  stateId: string | null;
  /** Box 16 — state wages; null leaves it blank (a second row of the same state). */
  box16: string | null;
  /** Box 17 — state income tax; null leaves it blank. */
  box17: string | null;
  /** 1-based W-2 form number. */
  form: number;
  row: 1 | 2;
}

/** One W-2 local row (boxes 18–20) on form `form`, row `row`. */
export interface W2LocalLineInput {
  /** Box 20 — locality name. */
  locality: string;
  /** Box 18 — local wages. */
  box18: string;
  /** Box 19 — local income tax. */
  box19: string;
  /** 1-based W-2 form number. */
  form: number;
  row: 1 | 2;
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
  /**
   * Spec 24 (PAY-116), tax years from 2026: W-3 box c = number of W-2 forms
   * (S24-D12), required there. Earlier years print employeeCount.
   */
  w2FormCount?: number | undefined;
  /** Box 15 — one state code, or "X" for more than one state; null = blank. */
  box15State?: string | null | undefined;
  /** Box 15 — the employer state ID (one state only); null = blank. */
  box15StateId?: string | null | undefined;
  /** Box 16 — total state wages; null = blank. */
  box16StateWages?: string | null | undefined;
  /** Box 17 — total state income tax; null = blank. */
  box17StateTax?: string | null | undefined;
  /** Box 18 — total local wages; null = blank. */
  box18LocalWages?: string | null | undefined;
  /** Box 19 — total local income tax; null = blank. */
  box19LocalTax?: string | null | undefined;
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
 * Spec 24 (PAY-116): fixed-message rejection of state/local lines (or W-3
 * boxes 15–19) the year's form cannot print — any line before tax year 2026
 * (S24-D5), or a line whose form/row slot is out of range or taken. Never
 * echoes a value.
 */
export class W2FormLinesError extends Error {
  constructor() {
    super("W-2/W-3 state or local lines do not fit the form");
    this.name = "W2FormLinesError";
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

/** money() for a box that may be left blank (null). */
function moneyOrBlank(amount: string | null | undefined): string | null {
  return amount === null || amount === undefined ? null : money(amount);
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

function fillText(form: PDFForm, fieldName: string, value: string | null | undefined): void {
  // Blank boxes stay blank (D36, Spec 24 (PAY-116): boxes 7–14; boxes 18–20
  // only from local lines, Spec 25 (PAY-120)).
  if (!value) return;
  form.getTextField(fieldName).setText(value);
}

// ---------------------------------------------------------------------------
// Form W-2 — fill each copy, prune, assemble the packet
// ---------------------------------------------------------------------------

/** Boxes a–f of one copy, then (when `withBoxes`) boxes 1–6. */
function fillW2Federal(form: PDFForm, map: W2FieldMap, input: W2Input, withBoxes: boolean): void {
  fillText(form, map.ssn, input.employee.ssn);
  fillText(form, map.ein, input.employer.ein ? formatEin(input.employer.ein) : null);
  const employer = [input.employer.legalName, ...addressLines(input.employer.address)];
  fillText(form, map.employerNameAddress, employer.join("\n"));
  fillText(form, map.controlNumber, input.controlNumber);
  const name = splitLegalName(input.employee.legalName);
  fillText(form, map.employeeFirstName, name.first);
  fillText(form, map.employeeLastName, name.last);
  fillText(form, map.employeeAddress, addressLines(input.employee.address).join("\n"));
  if (!withBoxes) return;
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

/** True when the input carries any state or local line. */
function hasLines(input: W2Input): boolean {
  return (input.stateLines?.length ?? 0) > 0 || (input.localLines?.length ?? 0) > 0;
}

/**
 * Single-up years (2025): fill the wanted copies on ONE load of the full
 * template — NOT flattened (tests). The form has no state rows in use, so an
 * input with lines is refused (S24-D5).
 */
async function fillW2Document(input: W2Input, copies: W2Copy[]): Promise<PDFDocument> {
  if (hasLines(input)) throw new W2FormLinesError();
  const doc = await PDFDocument.load(templateBytes(input.taxYear, "fw2"));
  const form = doc.getForm();
  for (const copy of copies) {
    fillW2Federal(form, w2FieldMapFor(input.taxYear, copy), input, true);
  }
  return doc;
}

/** The W-2 form count of a state-box year (absent = 1); a bad count throws. */
function formCountOf(input: W2Input): number {
  const count = input.formCount ?? 1;
  if (!Number.isSafeInteger(count) || count < 1) throw new W2FormLinesError();
  return count;
}

/** Every line sits on a form 1..count, row 1 or 2, one line per slot. */
function checkSlots(lines: readonly { form: number; row: number }[], count: number): void {
  const taken = new Set<string>();
  for (const { form, row } of lines) {
    const slot = `${form}:${row}`;
    const inRange = Number.isSafeInteger(form) && form >= 1 && form <= count;
    if (!inRange || (row !== 1 && row !== 2) || taken.has(slot)) throw new W2FormLinesError();
    taken.add(slot);
  }
}

/** Form `k` of a state-box year: a–f, boxes 1–6 on form 1 only (N2), its rows. */
function fillW2Form(form: PDFForm, map: W2FieldMap2026, input: W2Input, k: number): void {
  // iw2w3 2026, Multiple forms: a further W-2 repeats a–f, but the same
  // federal data is never reported on more than one Copy A — boxes 1–14
  // stay blank on forms 2..N.
  fillW2Federal(form, map, input, k === 1);
  for (const line of input.stateLines ?? []) {
    if (line.form !== k) continue;
    const row = map.stateRows[line.row - 1] as W2FieldMap2026["stateRows"][0];
    fillText(form, row.state, line.state);
    fillText(form, row.stateId, line.stateId);
    fillText(form, row.box16, moneyOrBlank(line.box16));
    fillText(form, row.box17, moneyOrBlank(line.box17));
  }
  for (const line of input.localLines ?? []) {
    if (line.form !== k) continue;
    const row = map.localRows[line.row - 1] as W2FieldMap2026["localRows"][0];
    fillText(form, row.box18, money(line.box18));
    fillText(form, row.box19, money(line.box19));
    fillText(form, row.box20, line.locality);
  }
}

/**
 * Spec 24 (PAY-116) S24-D4: the W-2 forms of one employee-year, filled and
 * NOT flattened (tests assert placement on them). State-box years (two-up
 * templates, 2026 on): form k = its own load of the full template with only
 * the upper W-2 (`<Copy>_Top[0]`) of `copies` filled — a–f, boxes 1–6 on
 * form 1 only, and the state/local lines of form k. Single-up years: one
 * document, as before.
 */
export async function prepareW2Forms(input: W2Input, copies: W2Copy[]): Promise<PDFDocument[]> {
  const maps = copies.map((copy) => w2FieldMapFor(input.taxYear, copy));
  const stateMaps = maps.filter(hasStateRows);
  if (stateMaps.length !== maps.length || maps.length === 0) {
    return [await fillW2Document(input, copies)];
  }
  const bytes = templateBytes(input.taxYear, "fw2");
  const count = formCountOf(input);
  checkSlots(input.stateLines ?? [], count);
  checkSlots(input.localLines ?? [], count);
  const forms: PDFDocument[] = [];
  for (let k = 1; k <= count; k += 1) {
    const doc = await PDFDocument.load(bytes);
    const form = doc.getForm();
    for (const map of stateMaps) fillW2Form(form, map, input, k);
    forms.push(doc);
  }
  return forms;
}

/** The one document of a single-form W-2 (tests); several forms → use prepareW2Forms. */
async function prepareSingle(input: W2Input, copies: W2Copy[]): Promise<PDFDocument> {
  const forms = await prepareW2Forms(input, copies);
  if (forms.length !== 1) throw new W2FormLinesError();
  return forms[0] as PDFDocument;
}

/** Employee packet pre-flatten: Copy B + C + 2 + instruction pages (D1). */
export function prepareW2EmployeePacket(input: W2Input): Promise<PDFDocument> {
  return prepareSingle(input, W2_EMPLOYEE_COPIES);
}

/** Admin Copy D packet pre-flatten (per employee, for employer records). */
export function prepareW2AdminCopyD(input: W2Input): Promise<PDFDocument> {
  return prepareSingle(input, W2_ADMIN_COPIES);
}

/** Options of the employee packet. */
export interface W2EmployeePacketOptions {
  /** Draw "CORRECTED" on Copies B, C and 2 (the employee may hold other figures). */
  corrected?: boolean;
}

/** PAY-206: draw the year's CORRECTED mark on the given template pages. */
async function markCorrected(
  doc: PDFDocument,
  pages: readonly number[],
  mark: W2Layout["correctedMark"],
): Promise<void> {
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const index of pages) {
    doc.getPage(index).drawText(mark.text, {
      font,
      size: mark.size,
      x: mark.x,
      y: mark.y,
      color: rgb(0, 0, 0),
    });
  }
}

/**
 * Single-up years: flatten the WHOLE document first (unfilled copies flatten
 * to blank), then prune to the kept pages — removing pages is trivial once no
 * fields remain, and this sidesteps field-removal quirks in the template's
 * Copy A widgets. PAY-206: `mark` pages (template indexes) get CORRECTED
 * after the flatten and before the prune. No mark → the document is
 * untouched (same bytes).
 */
async function renderPacket(
  doc: PDFDocument,
  keep: readonly number[],
  layout: W2Layout,
  mark: boolean,
): Promise<Buffer> {
  doc.getForm().flatten();
  if (mark) await markCorrected(doc, layout.correctedMarkPages, layout.correctedMark);
  removePagesExcept(doc, keep);
  return Buffer.from(await doc.save());
}

/**
 * State-box years (S24-D4): flatten each form, mark it CORRECTED when asked
 * (its own template pages), then copy the kept pages into one new document.
 * A copy page of `copies` repeats once per form (form order); any other kept
 * page (notice, instructions) comes once, from form 1. For N forms the
 * employee packet is B×N, Notice, C×N, Instructions, 2×N, Instructions
 * (continued); Copy D is N pages.
 */
async function renderForms(
  input: W2Input,
  copies: W2Copy[],
  keep: readonly number[],
  layout: W2Layout,
  mark: boolean,
): Promise<Buffer> {
  const forms = await prepareW2Forms(input, copies);
  for (const doc of forms) {
    doc.getForm().flatten();
    if (mark) await markCorrected(doc, layout.correctedMarkPages, layout.correctedMark);
  }
  const first = forms[0] as PDFDocument;
  const copyPages = copies.map((copy) => W2_COPY_PAGES_2026[copy]);
  const out = await PDFDocument.create();
  const title = first.getTitle();
  if (title) out.setTitle(title);
  for (const index of keep) {
    const sources = copyPages.includes(index) ? forms : [first];
    for (const src of sources) {
      for (const page of await out.copyPages(src, [index])) out.addPage(page);
    }
  }
  return Buffer.from(await out.save());
}

/** Render `copies` of the W-2, keeping the layout's `keep` pages. */
async function renderW2(
  input: W2Input,
  copies: W2Copy[],
  keep: (layout: W2Layout) => readonly number[],
  mark: boolean,
): Promise<Buffer> {
  const layout = w2LayoutFor(input.taxYear);
  if (hasStateRows(w2FieldMapFor(input.taxYear, copies[0] as W2Copy))) {
    return renderForms(input, copies, keep(layout), layout, mark);
  }
  return renderPacket(await fillW2Document(input, copies), keep(layout), layout, mark);
}

/**
 * The employee's ONE W-2 PDF: official Form W-2 filled + flattened — Copy B,
 * Copy C, Copy 2, and the IRS Notice/Instructions-for-Employee pages.
 * PAY-206: `{ corrected: true }` marks Copies B, C and 2 "CORRECTED".
 */
export async function renderW2EmployeePacket(
  input: W2Input,
  opts: W2EmployeePacketOptions = {},
): Promise<Buffer> {
  return renderW2(input, W2_EMPLOYEE_COPIES, (l) => l.employeePages, opts.corrected === true);
}

/** Admin Copy D (employer records) for one employee — filled + flattened. */
export async function renderW2AdminCopyD(input: W2Input): Promise<Buffer> {
  return renderW2(input, W2_ADMIN_COPIES, (l) => l.adminCopyDPages, false);
}

// ---------------------------------------------------------------------------
// Form W-3 — filled transmittal for employer records
// ---------------------------------------------------------------------------

const W3_STATE_KEYS = [
  "box15State",
  "box15StateId",
  "box16StateWages",
  "box17StateTax",
  "box18LocalWages",
  "box19LocalTax",
] as const;

/** Filled W-3 document pre-flatten (tests). */
export async function prepareW3(input: W3Input): Promise<PDFDocument> {
  const doc = await PDFDocument.load(templateBytes(input.taxYear, "fw3"));
  const map = w3FieldMapFor(input.taxYear);
  const stateBoxes = hasW3StateBoxes(map);
  if (!stateBoxes && W3_STATE_KEYS.some((k) => input[k] !== null && input[k] !== undefined)) {
    throw new W2FormLinesError();
  }
  // Spec 24 S24-D12: from 2026, box c counts W-2 forms, not employees.
  let w2Count = input.employeeCount;
  if (stateBoxes) {
    if (input.w2FormCount === undefined) throw new W2FormLinesError();
    w2Count = input.w2FormCount;
  }
  const form = doc.getForm();
  fillText(form, map.w2Count, String(w2Count));
  fillText(form, map.ein, input.employer.ein ? formatEin(input.employer.ein) : null);
  fillText(form, map.employerName, input.employer.legalName);
  fillText(form, map.employerAddress, addressLines(input.employer.address).join("\n"));
  fillText(form, map.box1Wages, money(input.box1Wages));
  fillText(form, map.box2FederalWithheld, money(input.box2FederalWithheld));
  fillText(form, map.box3SsWages, money(input.box3SsWages));
  fillText(form, map.box4SsTax, money(input.box4SsTax));
  fillText(form, map.box5MedicareWages, money(input.box5MedicareWages));
  fillText(form, map.box6MedicareTax, money(input.box6MedicareTax));
  if (stateBoxes) {
    // iw2w3 2026 Box 15: one state → its code and ID; more → "X", no ID.
    fillText(form, map.box15State, input.box15State);
    fillText(form, map.box15StateId, input.box15StateId);
    fillText(form, map.box16StateWages, moneyOrBlank(input.box16StateWages));
    fillText(form, map.box17StateTax, moneyOrBlank(input.box17StateTax));
    fillText(form, map.box18LocalWages, moneyOrBlank(input.box18LocalWages));
    fillText(form, map.box19LocalTax, moneyOrBlank(input.box19LocalTax));
  }

  // Kind-of-payer "941" + kind-of-employer "None apply" (regular 941 corp,
  // D5): real per-choice checkboxes (2025 and 2026 templates).
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

/** Decoded bytes of one content stream, as latin1 text. */
function streamText(stream: unknown): string {
  if (stream instanceof PDFRawStream) {
    return Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1");
  }
  if (stream instanceof PDFStream) return Buffer.from(stream.getContents()).toString("latin1");
  return "";
}

/** "CORRECTED" shown by Tj, hex- or literal-encoded. */
const CORRECTED_SHOW = /<434F52524543544544>\s*Tj|\(CORRECTED\)\s*Tj/i;

/**
 * PAY-206: 0-based pages of a rendered PDF whose own content streams show the
 * CORRECTED mark (form XObjects — the flattened field values — are not
 * searched). Lets callers/tests verify the mark without pdf-lib.
 */
export async function pagesWithCorrectedMark(bytes: Uint8Array): Promise<number[]> {
  const doc = await PDFDocument.load(bytes);
  const marked: number[] = [];
  doc.getPages().forEach((page, i) => {
    const contents = page.node.Contents();
    const streams =
      contents instanceof PDFArray
        ? contents.asArray().map((ref) => doc.context.lookup(ref))
        : [contents];
    if (CORRECTED_SHOW.test(streams.map(streamText).join("\n"))) marked.push(i);
  });
  return marked;
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
