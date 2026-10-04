/**
 * Field map for the bundled 2026 IRS templates — Spec 24 (PAY-116) S24-D6.
 * Built like field-map-2025.ts: every AcroForm widget's full name, page and
 * rect dumped from the official files (irs.gov/pub/irs-prior/fw2--2026.pdf,
 * fw3--2026.pdf, downloaded 2026-10-04, SHA-256 pinned in templates.ts),
 * each box matched by position (rects noted inline, 612 x 792 pt, y from
 * the bottom), then verified by filling a sample and re-reading every field
 * by its full name.
 *
 * fw2.pdf 2026: same 11 pages and page indexes as 2025 (3 B, 4 Notice, 5 C,
 * 6 Instructions, 7 Copy 2, 8 Instructions continued, 9 D). New: every copy
 * page is two-up — `<Copy>_Top[0]` holds the upper W-2 and `<Copy>_Bottom[0]`
 * the same field set 396 pt lower. Only the Top set is filled; the lower W-2
 * stays blank (S24-D4). a–f and 1–6 keep the 2025 numbers f2_01–f2_14 and
 * rects under the new `_Top[0]` segment. Boxes 15–20 are renumbered +2
 * against 2025 (new box 14b f2_29/f2_30): 15 f2_31–f2_34, 16 f2_35/f2_36,
 * 17 f2_37/f2_38, 18 f2_39/f2_40, 19 f2_41/f2_42, 20 f2_43/f2_44 (no
 * ReadOrder subform). Copies B, C, 2 and D share names and rects (Copy 2
 * box 20 ends at x575 instead of x574).
 *
 * fw3.pdf 2026: every widget name and rect equals 2025, so the W-3 map is the
 * 2025 map plus boxes 15–19 (f1_23–f1_28, directly under Page1[0]).
 */

import { W3_FIELD_MAP, type W2Copy, type W2FieldMap } from "./field-map-2025.js";

/** One W-2 state row (boxes 15–17). */
export interface W2StateRowFields {
  /** Box 15 — state (two letters). */
  state: string;
  /** Box 15 — employer's state ID number. */
  stateId: string;
  /** Box 16 — state wages. */
  box16: string;
  /** Box 17 — state income tax. */
  box17: string;
}

/** One W-2 local row (boxes 18–20). */
export interface W2LocalRowFields {
  /** Box 18 — local wages. */
  box18: string;
  /** Box 19 — local income tax. */
  box19: string;
  /** Box 20 — locality name. */
  box20: string;
}

/** A two-up W-2 map of one copy (2026 on): the 2025 boxes plus two state and two local rows. */
export interface W2FieldMapWithStateRows extends W2FieldMap {
  stateRows: readonly [W2StateRowFields, W2StateRowFields];
  localRows: readonly [W2LocalRowFields, W2LocalRowFields];
}

/**
 * Field map for the upper W-2 of one copy page. Rect-verified anchors (Copy
 * B, page 3): a–f and 1–6 as in field-map-2025.ts; row 1 of boxes 15–20 at
 * y480–492, row 2 at y456–468; box 15 state x38–64, state ID x66–193, box 16
 * x195–280, box 17 x282–359, box 18 x361–445, box 19 x447–525, box 20
 * x527–574.
 */
export function w2FieldMap2026(copy: W2Copy): W2FieldMapWithStateRows {
  const p = `topmostSubform[0].${copy}[0].${copy}_Top[0]`;
  const f = (n: number) => `f2_${String(n).padStart(2, "0")}[0]`;
  const localRow = (row: 0 | 1): W2LocalRowFields => ({
    box18: `${p}.Box18_ReadOrder[0].${f(39 + row)}`,
    box19: `${p}.Box19_ReadOrder[0].${f(41 + row)}`,
    box20: `${p}.${f(43 + row)}`,
  });
  return {
    ssn: `${p}.BoxA_ReadOrder[0].${f(1)}`,
    ein: `${p}.Col_Left[0].${f(2)}`,
    employerNameAddress: `${p}.Col_Left[0].${f(3)}`,
    controlNumber: `${p}.Col_Left[0].${f(4)}`,
    employeeFirstName: `${p}.Col_Left[0].FirstName_ReadOrder[0].${f(5)}`,
    employeeLastName: `${p}.Col_Left[0].LastName_ReadOrder[0].${f(6)}`,
    employeeAddress: `${p}.Col_Left[0].${f(8)}`, // f2_07 = name suffix (unused)
    box1Wages: `${p}.Col_Right[0].Box1_ReadOrder[0].${f(9)}`,
    box2FederalWithheld: `${p}.Col_Right[0].${f(10)}`,
    box3SsWages: `${p}.Col_Right[0].Box3_ReadOrder[0].${f(11)}`,
    box4SsTax: `${p}.Col_Right[0].${f(12)}`,
    box5MedicareWages: `${p}.Col_Right[0].Box5_ReadOrder[0].${f(13)}`,
    box6MedicareTax: `${p}.Col_Right[0].${f(14)}`,
    stateRows: [
      {
        // Row 1's box 15 state sits one subform deeper (Box15_ReadOrder).
        state: `${p}.Boxes15_ReadOrder[0].Box15_ReadOrder[0].${f(31)}`,
        stateId: `${p}.Boxes15_ReadOrder[0].${f(32)}`,
        box16: `${p}.Box16_ReadOrder[0].${f(35)}`,
        box17: `${p}.Box17_ReadOrder[0].${f(37)}`,
      },
      {
        state: `${p}.Boxes15_ReadOrder[0].${f(33)}`,
        stateId: `${p}.Boxes15_ReadOrder[0].${f(34)}`,
        box16: `${p}.Box16_ReadOrder[0].${f(36)}`,
        box17: `${p}.Box17_ReadOrder[0].${f(38)}`,
      },
    ],
    localRows: [localRow(0), localRow(1)],
  };
}

/**
 * The 2026 W-3 map: the 2025 map (unchanged widgets) plus boxes 15–19.
 * Rect-verified anchors (page 1): box 15 state x37–78/y492–504 (MaxLen 2),
 * state ID x79–265/y492–504; box 16 x37–150, 17 x152–265, 18 x267–420, 19
 * x422–575, all y468–480 (18 and 19 MaxLen 16).
 */
export const W3_FIELD_MAP_2026 = {
  ...W3_FIELD_MAP,
  /** Box 15 — state, or "X" when the W-2s carry more than one state. */
  box15State: "topmostSubform[0].Page1[0].f1_23[0]",
  /** Box 15 — employer's state ID number (one state only). */
  box15StateId: "topmostSubform[0].Page1[0].f1_24[0]",
  box16StateWages: "topmostSubform[0].Page1[0].f1_25[0]",
  box17StateTax: "topmostSubform[0].Page1[0].f1_26[0]",
  box18LocalWages: "topmostSubform[0].Page1[0].f1_27[0]",
  box19LocalTax: "topmostSubform[0].Page1[0].f1_28[0]",
} as const;

/** 0-indexed fw2 2026 page of each filled copy (same indexes as 2025). */
export const W2_COPY_PAGES_2026: Readonly<Record<W2Copy, number>> = {
  CopyB: 3,
  CopyC: 5,
  Copy2: 7,
  CopyD: 9,
};

/**
 * Box 15 state ID widths (pt; widget rect, auditor dump and ours): W-2
 * f2_32/f2_34 x65.8–193.4 (no MaxLen, DoNotScroll, 8 pt), W-3 f1_24
 * x79.2–265.4. A long ID is shrunk to fit, never below 6 pt.
 */
export const W2_STATE_ID_WIDTH_2026 = 127.6;
export const W3_STATE_ID_WIDTH_2026 = 186.2;

/**
 * fw2 2026 page layout. Employee packet: Copy B, Notice to Employee, Copy C,
 * Instructions for Employee, Copy 2, Instructions (continued); admin: Copy D.
 * CORRECTED goes on Copies B, C and 2 only — "2026 General Instructions for
 * Forms W-2 and W-3", Corrections, p.28 (printed page number, checked on the
 * PDF footer): the employer writes "CORRECTED" on the employee's new copies
 * (B, C, and 2), and "Do not write “CORRECTED” on Copy A of Form W-2."
 * The mark's place was re-checked on this template: box a is still
 * y732–744 and the printed labels start at y≈747, so 14 pt text at x38/y762
 * stays clear of every widget and label on pages 3/5/7 (Copy D's
 * VOID box at y740–750 is never marked).
 */
export const W2_LAYOUT_2026 = {
  employeePages: [3, 4, 5, 6, 7, 8],
  adminCopyDPages: [9],
  correctedMarkPages: [3, 5, 7],
  correctedMark: { text: "CORRECTED", size: 14, x: 38, y: 762 },
} as const;
