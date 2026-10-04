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
  type PDFPage,
  PDFRawStream,
  PDFStream,
  rgb,
  StandardFontEmbedder,
  StandardFonts,
} from "pdf-lib";
import { templateBytes } from "./forms/templates.js";
import {
  W2_ADMIN_COPIES,
  W2_EMPLOYEE_COPIES,
  W3_CHECKBOXES,
  W3_FORM_PAGE,
  type W2Copy,
  type W2FieldMap,
} from "./forms/field-map-2025.js";
import type {
  W2FieldMapWithStateRows,
  W2LocalRowFields,
  W2StateRowFields,
} from "./forms/field-map-2026.js";
import { type W2Layout, w2YearFor } from "./forms/w2-years.js";

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
 * Spec 24 (PAY-116) PR-3 R5: a box 15 state ID too wide for its field even at
 * the smallest allowed size (STATE_ID_MIN_SIZE). Fixed message; never echoes
 * the ID.
 */
export class W2StateIdTooLongError extends Error {
  constructor() {
    super("W-2/W-3 state ID does not fit the form");
    this.name = "W2StateIdTooLongError";
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
// Box 15 state ID sizing (R5)
// ---------------------------------------------------------------------------

/** The template's state ID size (Helvetica-Bold 8 pt) and the smallest we shrink to. */
const STATE_ID_SIZE = 8;
const STATE_ID_MIN_SIZE = 6;
/** pdf-lib draws single-line text inside the rect less 1 pt border + 1 pt padding a side. */
const STATE_ID_INSET = 4;
/** Measured in Helvetica-Bold: never narrower than the Helvetica the appearance uses. */
// StandardFonts and the embedder's FontNames are the same strings (two enums).
const STATE_ID_FONT = StandardFontEmbedder.for(
  StandardFonts.HelveticaBold as unknown as Parameters<typeof StandardFontEmbedder.for>[0],
);

/**
 * The font size that fits `id` into a field `width` pt wide: the template's
 * 8 pt when it fits, else the largest tenth of a point down to 6 pt; null
 * when it does not fit even at 6 pt.
 */
function stateIdSize(id: string, width: number): number | null {
  const perPoint = STATE_ID_FONT.widthOfTextAtSize(id, 1);
  const room = width - STATE_ID_INSET;
  if (perPoint * STATE_ID_SIZE <= room) return STATE_ID_SIZE;
  const size = Math.floor((room / perPoint) * 10) / 10;
  return size >= STATE_ID_MIN_SIZE ? size : null;
}

/**
 * Spec 24 (PAY-116) PR-3 R5: true when the year's W-2 (and, for a single
 * state, W-3) box 15 can print `id` in full at 6 pt or more. Years without
 * state rows print no ID: always true. Lets the server block a W-2 before any
 * furnishing (state_id_too_long) with the renderer's own rule.
 */
export function stateIdFitsForm(year: number, id: string): boolean {
  const entry = w2YearFor(year);
  if (!entry.twoUp) return true;
  const narrowest = Math.min(entry.stateIdWidth.w2, entry.stateIdWidth.w3);
  return stateIdSize(id, narrowest) !== null;
}

/** Fill a box 15 state ID, shrunk to fit its field; W2StateIdTooLongError when it cannot. */
function fillStateId(
  form: PDFForm,
  fieldName: string,
  id: string | null | undefined,
  width: number,
) {
  if (!id) return;
  const size = stateIdSize(id, width);
  if (size === null) throw new W2StateIdTooLongError();
  const field = form.getTextField(fieldName);
  field.setFontSize(size);
  field.setText(id);
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

/** The W-2 form count of a two-up year (absent = 1); a bad count throws. */
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

/** Form `k` of a two-up year: a–f, boxes 1–6 on form 1 only (N2), its rows. */
function fillW2Form(
  form: PDFForm,
  map: W2FieldMapWithStateRows,
  input: W2Input,
  k: number,
  stateIdWidth: number,
): void {
  // iw2w3 2026, Multiple forms: a further W-2 repeats a–f, but the same
  // federal data is never reported on more than one Copy A — boxes 1–14
  // stay blank on forms 2..N.
  fillW2Federal(form, map, input, k === 1);
  for (const line of input.stateLines ?? []) {
    if (line.form !== k) continue;
    const row = map.stateRows[line.row - 1] as W2StateRowFields;
    fillText(form, row.state, line.state);
    fillStateId(form, row.stateId, line.stateId, stateIdWidth);
    fillText(form, row.box16, moneyOrBlank(line.box16));
    fillText(form, row.box17, moneyOrBlank(line.box17));
  }
  for (const line of input.localLines ?? []) {
    if (line.form !== k) continue;
    const row = map.localRows[line.row - 1] as W2LocalRowFields;
    fillText(form, row.box18, money(line.box18));
    fillText(form, row.box19, money(line.box19));
    fillText(form, row.box20, line.locality);
  }
}

/**
 * Spec 24 (PAY-116) S24-D4: the W-2 forms of one employee-year, filled and
 * NOT flattened (tests assert placement on them). Two-up years (2026 on):
 * form k = its own load of the full template with only the upper W-2
 * (`<Copy>_Top[0]`) of `copies` filled — a–f, boxes 1–6 on form 1 only, and
 * the state/local lines of form k. Single-up years: ONE load with every copy
 * filled; an input with lines is refused (S24-D5).
 */
export async function prepareW2Forms(input: W2Input, copies: W2Copy[]): Promise<PDFDocument[]> {
  const year = w2YearFor(input.taxYear);
  const bytes = templateBytes(input.taxYear, "fw2");
  if (!year.twoUp) {
    if (hasLines(input)) throw new W2FormLinesError();
    const doc = await PDFDocument.load(bytes);
    const form = doc.getForm();
    for (const copy of copies) fillW2Federal(form, year.w2Map(copy), input, true);
    return [doc];
  }
  const count = formCountOf(input);
  checkSlots(input.stateLines ?? [], count);
  checkSlots(input.localLines ?? [], count);
  const forms: PDFDocument[] = [];
  for (let k = 1; k <= count; k += 1) {
    const doc = await PDFDocument.load(bytes);
    const form = doc.getForm();
    for (const copy of copies) {
      fillW2Form(form, year.w2Map(copy), input, k, year.stateIdWidth.w2);
    }
    forms.push(doc);
  }
  return forms;
}

/** The one document of a single-form W-2 (tests); several forms → prepareW2Forms. */
async function prepareSingle(input: W2Input, copies: W2Copy[]): Promise<PDFDocument> {
  const forms = await prepareW2Forms(input, copies);
  if (forms.length !== 1) throw new Error("multi-form W-2: use prepareW2Forms");
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
async function markCorrected(doc: PDFDocument, layout: W2Layout): Promise<void> {
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const mark = layout.correctedMark;
  for (const index of layout.correctedMarkPages) {
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
 * Copy A widgets. PAY-206: CORRECTED is drawn after the flatten and before
 * the prune. No mark → the document is untouched (same bytes).
 */
async function renderPacket(
  doc: PDFDocument,
  keep: readonly number[],
  layout: W2Layout,
  mark: boolean,
): Promise<Buffer> {
  doc.getForm().flatten();
  if (mark) await markCorrected(doc, layout);
  removePagesExcept(doc, keep);
  return Buffer.from(await doc.save());
}

/** A new document (no template catalog: no script, no open action) titled like `from`. */
async function cleanDocument(from: PDFDocument): Promise<PDFDocument> {
  const out = await PDFDocument.create();
  const title = from.getTitle();
  if (title) out.setTitle(title);
  return out;
}

/**
 * Two-up years (S24-D4): flatten each form, mark it CORRECTED when asked
 * (its own template pages), then copy the kept pages into one new document
 * — one copyPages per form. A copy page of `copies` repeats once per form
 * (form order); any other kept page (notice, instructions) comes once, from
 * form 1. For N forms the employee packet is B×N, Notice, C×N,
 * Instructions, 2×N, Instructions (continued); Copy D is N pages.
 */
async function renderForms(
  forms: PDFDocument[],
  copyPages: readonly number[],
  keep: readonly number[],
  layout: W2Layout,
  mark: boolean,
): Promise<Buffer> {
  for (const doc of forms) {
    doc.getForm().flatten();
    if (mark) await markCorrected(doc, layout);
  }
  const first = forms[0] as PDFDocument;
  const out = await cleanDocument(first);
  const perForm = keep.filter((i) => copyPages.includes(i));
  const copied = [
    await out.copyPages(first, [...keep]),
    ...(await Promise.all(forms.slice(1).map((doc) => out.copyPages(doc, perForm)))),
  ];
  keep.forEach((index, at) => {
    out.addPage(copied[0]?.[at] as PDFPage);
    if (!perForm.includes(index)) return;
    for (const pages of copied.slice(1)) out.addPage(pages[perForm.indexOf(index)] as PDFPage);
  });
  return Buffer.from(await out.save());
}

/** Render `copies` of the W-2, keeping the layout's `keep` pages. */
async function renderW2(
  input: W2Input,
  copies: W2Copy[],
  keep: (layout: W2Layout) => readonly number[],
  mark: boolean,
): Promise<Buffer> {
  const year = w2YearFor(input.taxYear);
  const forms = await prepareW2Forms(input, copies);
  if (!year.twoUp) {
    return renderPacket(forms[0] as PDFDocument, keep(year.layout), year.layout, mark);
  }
  const copyPages = copies.map((copy) => year.copyPages[copy]);
  return renderForms(forms, copyPages, keep(year.layout), year.layout, mark);
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
  const year = w2YearFor(input.taxYear);
  const doc = await PDFDocument.load(templateBytes(input.taxYear, "fw3"));
  if (!year.twoUp && W3_STATE_KEYS.some((k) => input[k] !== null && input[k] !== undefined)) {
    throw new W2FormLinesError();
  }
  // Spec 24 S24-D12: from 2026, box c counts W-2 forms, not employees.
  let w2Count = input.employeeCount;
  if (year.twoUp) {
    if (input.w2FormCount === undefined) throw new W2FormLinesError();
    w2Count = input.w2FormCount;
  }
  const map = year.w3Map;
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
  if (year.twoUp) {
    const m = year.w3Map;
    // iw2w3 2026 Box 15: one state → its code and ID; more → "X", no ID.
    fillText(form, m.box15State, input.box15State);
    fillStateId(form, m.box15StateId, input.box15StateId, year.stateIdWidth.w3);
    fillText(form, m.box16StateWages, moneyOrBlank(input.box16StateWages));
    fillText(form, m.box17StateTax, moneyOrBlank(input.box17StateTax));
    fillText(form, m.box18LocalWages, moneyOrBlank(input.box18LocalWages));
    fillText(form, m.box19LocalTax, moneyOrBlank(input.box19LocalTax));
  }

  // Kind-of-payer "941" + kind-of-employer "None apply" (regular 941 corp,
  // D5): real per-choice checkboxes (2025 and 2026 templates).
  for (const name of Object.values(W3_CHECKBOXES)) {
    form.getCheckBox(name).check();
  }

  return doc;
}

/**
 * Filled official W-3 for employer records — flattened, one page. R6
 * (security L1): the form page is copied into a new document, so the
 * template's document JavaScript, open action and /Perms never reach the
 * output (the attention cover, page 0, is dropped).
 */
export async function renderW3Pdf(input: W3Input): Promise<Buffer> {
  const doc = await prepareW3(input);
  doc.getForm().flatten();
  const out = await cleanDocument(doc);
  for (const page of await out.copyPages(doc, [W3_FORM_PAGE])) out.addPage(page);
  return Buffer.from(await out.save());
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
