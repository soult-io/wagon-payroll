/**
 * Spec 24 (PAY-116) PR-3 — payroll-calc-auditor oracle for the 2026 Form
 * W-2 / W-3 PDF placement (W29, W30, W33, W05-PDF, C1–C4, N1, N2). Imports
 * nothing from src/ and nothing from @payroll/engine. Synthetic data only.
 *
 * Source of every field name and rect below: the auditor's own widget dump
 * (pypdf 6.14.2, every /Widget annotation: fully-qualified /T chain, /Rect,
 * /MaxLen, page) of the official files, downloaded 2026-10-04:
 *   https://www.irs.gov/pub/irs-prior/fw2--2026.pdf
 *     SHA-256 61eca7c81f16d3965819fe1f31be4fe68c1b2887a81f51172f1d2ed2b2b9f087
 *   https://www.irs.gov/pub/irs-prior/fw3--2026.pdf
 *     SHA-256 2df15f40431bd52814cbac85d9843102b09a640b6fe558f201e5214ff1890656
 * The rects equal the Spec 24 S24-D6 table to within 1 pt (the table rounds
 * 63.8 -> 64, 193.4 -> 193, …). Copy B/C/2/D Top fields share names and
 * rects; Copy 2 box 20 has x2 575 (inside the ±1 pt tolerance). Printed
 * labels matched with pdftotext -bbox: fw2 page 3 "15 State Employer's state
 * ID number … 20 Locality name" at y494–495 (row 1 fields y480–492); fw3
 * page 1 "15 State Employer's state ID number" y507, "16 … 19" y483.
 *
 * Instructions (2026 General Instructions for Forms W-2 and W-3, irs.gov/
 * pub/irs-pdf/iw2w3.pdf, "2026", SHA-256 d16b9f50…c792b6):
 *  - W-3 Box 15 (PDF p.26): "Enter the two-letter abbreviation for the name
 *    of the state … Also enter your state-assigned ID number. If the Forms
 *    W-2 … contain wage and income tax information from more than one state
 *    …, enter an 'X' under 'State' and do not enter any state … ID number."
 *    -> one state: f1_23 state + f1_24 ID (N1); more than one: f1_23 "X",
 *    f1_24 empty.
 *  - W-3 Boxes 16–19 (p.26): one sum over the W-2s.
 *  - W-3 Box c (p.25): number of completed Forms W-2 (S24-D12).
 *  - Multiple forms (p.17): a second W-2 repeats boxes a–f; "Do not report
 *    the same federal … tax data to the SSA on more than one Copy A" ->
 *    forms 2..N leave boxes 1–14 empty (N2).
 *  - Boxes 15–20 (p.24): two states / two localities per W-2; more -> a
 *    second Form W-2.
 *  - CORRECTED (p.28 of the 2026 PDF): on the employee's Copies B, C and 2;
 *    never Copy A.
 */

import { pdfLib } from "./annual-w2-corrected-harness.js";

export const FW2_2026_SHA256 = "61eca7c81f16d3965819fe1f31be4fe68c1b2887a81f51172f1d2ed2b2b9f087";
export const FW3_2026_SHA256 = "2df15f40431bd52814cbac85d9843102b09a640b6fe558f201e5214ff1890656";

export type Copy = "CopyB" | "CopyC" | "Copy2" | "CopyD";
export const ALL_COPIES: Copy[] = ["CopyB", "CopyC", "Copy2", "CopyD"];
export const EMPLOYEE_COPIES: Copy[] = ["CopyB", "CopyC", "Copy2"];
/** Template page index of each copy (fw2 2025 and 2026: 3 B, 5 C, 7 Copy 2, 9 D). */
export const COPY_PAGE: Record<Copy, number> = { CopyB: 3, CopyC: 5, Copy2: 7, CopyD: 9 };

export type Rect = readonly [number, number, number, number];

/** One W-2 2026 Top field: path below `topmostSubform[0].<Copy>[0].<Copy>_Top[0].` and rect. */
interface TopField {
  sub: string;
  rect: Rect;
}

/** Semantic key -> Top-relative path + rect (dump of fw2--2026.pdf, Copy B page 3). */
export const W2_2026_TOP = {
  ssn: { sub: "BoxA_ReadOrder[0].f2_01[0]", rect: [153.2, 732, 278.8, 744] },
  ein: { sub: "Col_Left[0].f2_02[0]", rect: [38, 708, 330.2, 720] },
  employerNameAddress: { sub: "Col_Left[0].f2_03[0]", rect: [38, 636, 330.2, 696] },
  controlNumber: { sub: "Col_Left[0].f2_04[0]", rect: [38, 612, 330.2, 624] },
  employeeFirstName: {
    sub: "Col_Left[0].FirstName_ReadOrder[0].f2_05[0]",
    rect: [38, 588, 171.8, 600],
  },
  employeeLastName: {
    sub: "Col_Left[0].LastName_ReadOrder[0].f2_06[0]",
    rect: [173.8, 588, 308.6, 600],
  },
  employeeAddress: { sub: "Col_Left[0].f2_08[0]", rect: [38, 516, 330.2, 586] },
  box1Wages: { sub: "Col_Right[0].Box1_ReadOrder[0].f2_09[0]", rect: [333.2, 708, 451.6, 720] },
  box2FederalWithheld: { sub: "Col_Right[0].f2_10[0]", rect: [455.6, 708, 574, 720] },
  box3SsWages: { sub: "Col_Right[0].Box3_ReadOrder[0].f2_11[0]", rect: [332.2, 684, 452.6, 696] },
  box4SsTax: { sub: "Col_Right[0].f2_12[0]", rect: [454.6, 684, 574, 696] },
  box5MedicareWages: {
    sub: "Col_Right[0].Box5_ReadOrder[0].f2_13[0]",
    rect: [332.2, 660, 452.6, 672],
  },
  box6MedicareTax: { sub: "Col_Right[0].f2_14[0]", rect: [454.6, 660, 574, 672] },
} as const satisfies Record<string, TopField>;

/** S24-D6 table, boxes 15–20, rows 1 and 2 (rects as printed in the spec). */
export const W2_2026_ROWS = {
  state: [
    { sub: "Boxes15_ReadOrder[0].Box15_ReadOrder[0].f2_31[0]", rect: [38, 480, 64, 492] },
    { sub: "Boxes15_ReadOrder[0].f2_33[0]", rect: [38, 456, 64, 468] },
  ],
  stateId: [
    { sub: "Boxes15_ReadOrder[0].f2_32[0]", rect: [66, 480, 193, 492] },
    { sub: "Boxes15_ReadOrder[0].f2_34[0]", rect: [66, 456, 193, 468] },
  ],
  box16: [
    { sub: "Box16_ReadOrder[0].f2_35[0]", rect: [195, 480, 280, 492] },
    { sub: "Box16_ReadOrder[0].f2_36[0]", rect: [195, 456, 280, 468] },
  ],
  box17: [
    { sub: "Box17_ReadOrder[0].f2_37[0]", rect: [282, 480, 359, 492] },
    { sub: "Box17_ReadOrder[0].f2_38[0]", rect: [282, 456, 359, 468] },
  ],
  box18: [
    { sub: "Box18_ReadOrder[0].f2_39[0]", rect: [361, 480, 445, 492] },
    { sub: "Box18_ReadOrder[0].f2_40[0]", rect: [361, 456, 445, 468] },
  ],
  box19: [
    { sub: "Box19_ReadOrder[0].f2_41[0]", rect: [447, 480, 525, 492] },
    { sub: "Box19_ReadOrder[0].f2_42[0]", rect: [447, 456, 525, 468] },
  ],
  box20: [
    { sub: "f2_43[0]", rect: [527, 480, 574, 492] },
    { sub: "f2_44[0]", rect: [527, 456, 574, 468] },
  ],
} as const satisfies Record<string, readonly [TopField, TopField]>;

/** Boxes 7–14 Top fields (must stay empty on every form; D36). */
export const W2_2026_BOXES_7_14 = [
  "Col_Right[0].Box7_ReadOrder[0].f2_15[0]",
  "Col_Right[0].f2_16[0]",
  "Col_Right[0].f2_17[0]",
  "Col_Right[0].Box10_ReadOrder[0].f2_18[0]",
  "Col_Right[0].f2_19[0]",
  "Col_Right[0].Box12_ReadOrder[0].f2_20[0]",
  "Col_Right[0].Box12_ReadOrder[0].f2_21[0]",
  "Col_Right[0].Box12_ReadOrder[0].f2_22[0]",
  "Col_Right[0].Box12_ReadOrder[0].f2_23[0]",
  "Col_Right[0].Box12_ReadOrder[0].f2_24[0]",
  "Col_Right[0].Box12_ReadOrder[0].f2_25[0]",
  "Col_Right[0].Box12_ReadOrder[0].f2_26[0]",
  "Col_Right[0].Box12_ReadOrder[0].f2_27[0]",
  "Col_Right[0].f2_28[0]",
  "Col_Right[0].f2_29[0]",
  "Col_Right[0].f2_30[0]",
] as const;

export function top(copy: Copy): string {
  return `topmostSubform[0].${copy}[0].${copy}_Top[0]`;
}

export function w2Path(copy: Copy, sub: string): string {
  return `${top(copy)}.${sub}`;
}

/** W-3 (fw3 2025 = 2026; page 1). */
export const W3_2026 = {
  w2Count: { name: "topmostSubform[0].Page1[0].BoxesC-H[0].f1_02[0]", rect: [37, 660, 150.2, 672] },
  ein: { name: "topmostSubform[0].Page1[0].BoxesC-H[0].f1_04[0]", rect: [37, 636, 265.4, 648] },
  employerName: {
    name: "topmostSubform[0].Page1[0].BoxesC-H[0].f1_05[0]",
    rect: [37, 612, 265.4, 624],
  },
  employerAddress: {
    name: "topmostSubform[0].Page1[0].BoxesC-H[0].f1_06[0]",
    rect: [37, 552, 265.4, 588],
  },
  box1Wages: {
    name: "topmostSubform[0].Page1[0].Boxes1-14[0].f1_08[0]",
    rect: [267.4, 660, 420.2, 672],
  },
  box2FederalWithheld: {
    name: "topmostSubform[0].Page1[0].Boxes1-14[0].f1_09[0]",
    rect: [422.2, 660, 575, 672],
  },
  box3SsWages: {
    name: "topmostSubform[0].Page1[0].Boxes1-14[0].f1_10[0]",
    rect: [267.4, 636, 420.2, 648],
  },
  box4SsTax: {
    name: "topmostSubform[0].Page1[0].Boxes1-14[0].f1_11[0]",
    rect: [422.2, 636, 575, 648],
  },
  box5MedicareWages: {
    name: "topmostSubform[0].Page1[0].Boxes1-14[0].f1_12[0]",
    rect: [267.4, 612, 420.2, 624],
  },
  box6MedicareTax: {
    name: "topmostSubform[0].Page1[0].Boxes1-14[0].f1_13[0]",
    rect: [422.2, 612, 575, 624],
  },
  // S24-D6 table (directly under Page1[0]).
  box15State: { name: "topmostSubform[0].Page1[0].f1_23[0]", rect: [37, 492, 78, 504] },
  box15StateId: { name: "topmostSubform[0].Page1[0].f1_24[0]", rect: [79, 492, 265, 504] },
  box16StateWages: { name: "topmostSubform[0].Page1[0].f1_25[0]", rect: [37, 468, 150, 480] },
  box17StateTax: { name: "topmostSubform[0].Page1[0].f1_26[0]", rect: [152, 468, 265, 480] },
  box18LocalWages: { name: "topmostSubform[0].Page1[0].f1_27[0]", rect: [267, 468, 420, 480] },
  box19LocalTax: { name: "topmostSubform[0].Page1[0].f1_28[0]", rect: [422, 468, 575, 480] },
} as const;

export const W3_CHECKED = [
  "topmostSubform[0].Page1[0].bKind_ReadOrder[0].b941[0].c1_1[0]",
  "topmostSubform[0].Page1[0].bKindOfEmployer_ReadOrder[0].EmployerCheckboxes[0].None[0].c1_2[0]",
] as const;

// ------------------------------------------------------------ PDF readers

// biome-ignore lint/suspicious/noExplicitAny: pdf-lib objects (see harness pdfLib)
type Doc = any;

/** Every text field with a non-empty value and every checked box: name -> value / true. */
export function filledFields(doc: Doc): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (const f of doc.getForm().getFields()) {
    if (f instanceof pdfLib.PDFTextField) {
      const v = f.getText();
      if (v !== undefined && v !== "") out[f.getName()] = v;
    } else if (f instanceof pdfLib.PDFCheckBox) {
      if (f.isChecked()) out[f.getName()] = true;
    }
  }
  return out;
}

/** Text value of a field looked up by its full name ("" when empty; "<missing>" when absent). */
export function textOf(doc: Doc, name: string): string {
  const f = doc.getForm().getFieldMaybe(name);
  if (!f) return "<missing>";
  return f.getText?.() ?? "";
}

/**
 * Placement of a field looked up by full name: its widget's rect and the
 * 0-based page holding the widget. Null when the field does not exist.
 */
export function placement(doc: Doc, name: string): { page: number; rect: number[] } | null {
  const f = doc.getForm().getFieldMaybe(name);
  if (!f) return null;
  const widget = f.acroField.getWidgets()[0];
  const ref = doc.context.getObjectRef(widget.dict);
  let page = -1;
  doc.getPages().forEach((p: Doc, i: number) => {
    const annots = p.node.Annots();
    if (!annots) return;
    for (const r of annots.asArray()) if (r === ref) page = i;
  });
  const r = widget.getRectangle();
  return { page, rect: [r.x, r.y, r.x + r.width, r.y + r.height] };
}

/** Every rect / page mismatch (> tol pt on any coordinate) among `want`. */
export function rectMismatches(
  doc: Doc,
  want: readonly { name: string; rect: Rect; page: number }[],
  tol = 1,
): string[] {
  const bad: string[] = [];
  for (const w of want) {
    const got = placement(doc, w.name);
    if (!got) {
      bad.push(`${w.name}: field not found`);
      continue;
    }
    const off = got.rect.some((v, i) => Math.abs(v - (w.rect[i] as number)) > tol);
    if (off || got.page !== w.page) {
      bad.push(
        `${w.name}: page ${got.page} rect [${got.rect.map((v) => v.toFixed(1))}] want page ${w.page} [${w.rect}]`,
      );
    }
  }
  return bad;
}

/** The 14 state/local row fields of one copy with their table rects. */
export function rowPlacements(copy: Copy): { name: string; rect: Rect; page: number }[] {
  const out: { name: string; rect: Rect; page: number }[] = [];
  for (const key of Object.keys(W2_2026_ROWS) as (keyof typeof W2_2026_ROWS)[]) {
    for (const f of W2_2026_ROWS[key]) {
      out.push({ name: w2Path(copy, f.sub), rect: f.rect, page: COPY_PAGE[copy] });
    }
  }
  return out;
}

/** The a–f and 1–6 fields of one copy with their dump rects. */
export function federalPlacements(copy: Copy): { name: string; rect: Rect; page: number }[] {
  return Object.values(W2_2026_TOP).map((f) => ({
    name: w2Path(copy, f.sub),
    rect: f.rect,
    page: COPY_PAGE[copy],
  }));
}

// ------------------------------------------------------- expected W-2 values

export interface FormExpect {
  ssn?: string | null;
  ein?: string | null;
  employerNameAddress?: string | null;
  controlNumber?: string | null;
  employeeFirstName?: string | null;
  employeeLastName?: string | null;
  employeeAddress?: string | null;
  /** Boxes 1–6, or null for forms 2..N (N2). */
  boxes: {
    box1Wages: string;
    box2FederalWithheld: string;
    box3SsWages: string;
    box4SsTax: string;
    box5MedicareWages: string;
    box6MedicareTax: string;
  } | null;
  /** Row 1 / row 2 of boxes 15–17; null box16/box17 = empty. */
  states: ({
    state: string;
    stateId: string | null;
    box16: string | null;
    box17: string | null;
  } | null)[];
  /** Row 1 / row 2 of boxes 18–20. */
  locals: ({ box18: string; box19: string; box20: string } | null)[];
}

/** The exact non-empty field set of one pre-flatten 2026 form for `copies`. */
export function expectedFilled(copies: readonly Copy[], e: FormExpect): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (copy: Copy, sub: string, v: string | null | undefined) => {
    if (v !== null && v !== undefined && v !== "") out[w2Path(copy, sub)] = v;
  };
  for (const copy of copies) {
    put(copy, W2_2026_TOP.ssn.sub, e.ssn);
    put(copy, W2_2026_TOP.ein.sub, e.ein);
    put(copy, W2_2026_TOP.employerNameAddress.sub, e.employerNameAddress);
    put(copy, W2_2026_TOP.controlNumber.sub, e.controlNumber);
    put(copy, W2_2026_TOP.employeeFirstName.sub, e.employeeFirstName);
    put(copy, W2_2026_TOP.employeeLastName.sub, e.employeeLastName);
    put(copy, W2_2026_TOP.employeeAddress.sub, e.employeeAddress);
    if (e.boxes) {
      for (const k of Object.keys(e.boxes) as (keyof NonNullable<FormExpect["boxes"]>)[]) {
        put(copy, W2_2026_TOP[k].sub, e.boxes[k]);
      }
    }
    e.states.forEach((s, i) => {
      if (!s) return;
      put(copy, W2_2026_ROWS.state[i as 0 | 1].sub, s.state);
      put(copy, W2_2026_ROWS.stateId[i as 0 | 1].sub, s.stateId);
      put(copy, W2_2026_ROWS.box16[i as 0 | 1].sub, s.box16);
      put(copy, W2_2026_ROWS.box17[i as 0 | 1].sub, s.box17);
    });
    e.locals.forEach((l, i) => {
      if (!l) return;
      put(copy, W2_2026_ROWS.box18[i as 0 | 1].sub, l.box18);
      put(copy, W2_2026_ROWS.box19[i as 0 | 1].sub, l.box19);
      put(copy, W2_2026_ROWS.box20[i as 0 | 1].sub, l.box20);
    });
  }
  return out;
}

// --------------------------------------------------- CORRECTED mark geometry

/** Adobe Helvetica-Bold AFM advance widths (1/1000 em) for "CORRECTED". */
const HB_WIDTH: Record<string, number> = { C: 722, O: 778, R: 722, E: 667, T: 611, D: 722 };
const HB_ASCENDER = 718;
const HB_DESCENDER = -207;

export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export function overlaps(a: Box, b: Box): boolean {
  return a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
}

/** Widget rects on one page of a document (before flatten). */
export function widgetRects(doc: Doc, pageIndex: number): Box[] {
  const annots = doc.getPage(pageIndex).node.Annots();
  const rects: Box[] = [];
  for (let i = 0; i < (annots?.size() ?? 0); i += 1) {
    const a = annots.lookup(i, pdfLib.PDFDict);
    if (a.get(pdfLib.PDFName.of("Subtype"))?.toString() !== "/Widget") continue;
    const [x1, y1, x2, y2] = a
      .lookup(pdfLib.PDFName.of("Rect"), pdfLib.PDFArray)
      .asArray()
      .map((n: { asNumber(): number }) => n.asNumber());
    rects.push({
      x1: Math.min(x1, x2),
      y1: Math.min(y1, y2),
      x2: Math.max(x1, x2),
      y2: Math.max(y1, y2),
    });
  }
  return rects;
}

/** The mark's text box on a rendered page (from its own content stream), or a reason. */
export function markBox(
  doc: Doc,
  pageIndex: number,
  content: string,
):
  | {
      baseFont: string | null;
      unrotated: boolean;
      size: number;
      origin: { x: number; y: number };
      text: Box;
      media: Box;
    }
  | string {
  const at = content.search(/<434F52524543544544>\s*Tj|\(CORRECTED\)\s*Tj/i);
  if (at < 0) return "no CORRECTED text block";
  const block = content.slice(content.lastIndexOf("BT", at), at);
  const tf = [...block.matchAll(/\/([^\s/]+)\s+([\d.]+)\s+Tf/g)].pop();
  const tm = [
    ...block.matchAll(
      /([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+Tm/g,
    ),
  ].pop();
  if (!tf || !tm) return "no Tf/Tm in the mark's text block";
  const [a, b, c, d, e, f] = tm.slice(1, 7).map(Number) as number[];
  const fonts = doc.getPage(pageIndex).node.Resources().lookup(pdfLib.PDFName.of("Font"));
  const font = doc.context.lookup(fonts.get(pdfLib.PDFName.of(tf[1] as string)));
  const size = Number(tf[2]) * (a as number);
  const width = ([..."CORRECTED"].reduce((s, ch) => s + (HB_WIDTH[ch] as number), 0) / 1000) * size;
  const mb = doc.getPage(pageIndex).getMediaBox();
  return {
    baseFont: font?.get(pdfLib.PDFName.of("BaseFont"))?.toString() ?? null,
    unrotated: b === 0 && c === 0 && a === d,
    size,
    origin: { x: e as number, y: f as number },
    text: {
      x1: e as number,
      x2: (e as number) + width,
      y1: (f as number) + (HB_DESCENDER / 1000) * size,
      y2: (f as number) + (HB_ASCENDER / 1000) * size,
    },
    media: { x1: mb.x, y1: mb.y, x2: mb.x + mb.width, y2: mb.y + mb.height },
  };
}
