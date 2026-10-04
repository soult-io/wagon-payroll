/**
 * Field map for the bundled 2025 IRS templates (PAY-19, D2) — built by
 * dumping every AcroForm widget's full name, page, and rect from the real
 * PDFs (irs-prior/fw2--2025.pdf, fw3--2025.pdf) and matching each box by
 * position (rects noted inline), then verified by filling a sample and
 * re-reading the values per field plus a visual render check.
 *
 * fw2.pdf layout (11 pages, 0-indexed): 0 attention cover, 1 Copy A (VOID,
 * scannable — unused, SSA filing goes via BSO), 2 Copy 1 (state — unused),
 * 3 Copy B, 4 Notice to Employee, 5 Copy C, 6 Instructions for Employee,
 * 7 Copy 2, 8 Instructions (continued), 9 Copy D, 10 employer note. The
 * copy pages are single-up (lower half of the sheet is left blank for the
 * employer's own use); copies B/C/2/D share the same f2_NN field numbering
 * inside their own subform paths.
 *
 * fw3.pdf layout (2 pages): 0 attention cover, 1 the form. Kind-of-payer
 * and kind-of-employer are real per-choice PDFCheckBox fields, checked
 * directly by name.
 */

// --------------------------------------------------------------------------
// Form W-2 (fw2.pdf)
// --------------------------------------------------------------------------

/** Copies we fill (Copy A = SSA via BSO; Copy 1 = state, no state data). */
export type W2Copy = "CopyB" | "CopyC" | "Copy2" | "CopyD";

/** 0-indexed pages kept for the employee packet: B + C + 2 + instructions. */
export const W2_EMPLOYEE_PAGES = [3, 4, 5, 6, 7, 8] as const;
/**
 * PAY-206: 0-indexed template pages of the employee's Copies B, C and 2 —
 * the only pages that carry "CORRECTED" (2025 General Instructions for Forms
 * W-2 and W-3, p.28). Instruction pages, Copy D and the W-3 are never marked.
 */
export const W2_CORRECTED_MARK_PAGES = [3, 5, 7] as const;
/**
 * PAY-206: the CORRECTED mark — Helvetica-Bold 14 pt in the top margin,
 * left-aligned with the form's left edge. Clear of every AcroForm widget
 * (the highest, box a, sits at y 732-744 on a 612 x 792 page).
 */
export const CORRECTED_MARK = { text: "CORRECTED", size: 14, x: 38, y: 762 } as const;
/** 0-indexed pages kept for the admin per-employee Copy D packet. */
export const W2_ADMIN_COPY_D_PAGES = [9] as const;

/** 0-indexed fw2 2025 page of each filled copy. */
export const W2_COPY_PAGES_2025: Readonly<Record<W2Copy, number>> = {
  CopyB: 3,
  CopyC: 5,
  Copy2: 7,
  CopyD: 9,
};

/** fw2 2025 page layout (PAY-19, PAY-206). */
export const W2_LAYOUT_2025 = {
  employeePages: W2_EMPLOYEE_PAGES,
  adminCopyDPages: W2_ADMIN_COPY_D_PAGES,
  correctedMarkPages: W2_CORRECTED_MARK_PAGES,
  correctedMark: CORRECTED_MARK,
} as const;

/** Semantic W-2 boxes → AcroForm field paths for one copy. */
export interface W2FieldMap {
  /** Box a — employee SSN. */
  ssn: string;
  /** Box b — employer EIN. */
  ein: string;
  /** Box c — employer name/address/ZIP (multiline). */
  employerNameAddress: string;
  /** Box d — control number. */
  controlNumber: string;
  /** Box e — employee first name + initial. */
  employeeFirstName: string;
  /** Box e — employee last name. */
  employeeLastName: string;
  /** Box f — employee address/ZIP (multiline). */
  employeeAddress: string;
  box1Wages: string;
  box2FederalWithheld: string;
  box3SsWages: string;
  box4SsTax: string;
  box5MedicareWages: string;
  box6MedicareTax: string;
}

/**
 * Field map for one copy. Rect-verified anchors (CopyB, page 3, 612×792 pt,
 * y from bottom): box a x153–279/y732–744, box b y708–720, box c y636–696
 * (multiline), box d y612–624, box e y588–600 (first x38–172, last
 * x174–309, suffix x311–330 unused), box f y516–586 (multiline); right
 * column boxes 1/2 at y708–720, 3/4 at y684–696, 5/6 at y660–672.
 */
export function w2FieldMap(copy: W2Copy): W2FieldMap {
  const p = `topmostSubform[0].${copy}[0]`;
  const f = (n: number) => `f2_${String(n).padStart(2, "0")}[0]`;
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
  };
}

/** Copies whose fields survive into the employee packet. */
export const W2_EMPLOYEE_COPIES: W2Copy[] = ["CopyB", "CopyC", "Copy2"];
/** Copies whose fields survive into the admin Copy D packet. */
export const W2_ADMIN_COPIES: W2Copy[] = ["CopyD"];

// --------------------------------------------------------------------------
// Form W-3 (fw3.pdf)
// --------------------------------------------------------------------------

/** 0-indexed page kept for the filled W-3 (page 0 is the attention cover). */
export const W3_FORM_PAGE = 1;

/**
 * Semantic W-3 boxes → AcroForm field paths. Rect-verified anchors (page 1,
 * 612×792 pt): box c (W-2 count) x37–150/y660–672, box e (EIN) y636–648,
 * box f (name) y612–624, box g (address) y552–588 multiline; right column
 * boxes 1/2 at y660–672, 3/4 at y636–648, 5/6 at y612–624.
 */
export const W3_FIELD_MAP = {
  /** Box a — control number (left blank; optional on the W-3). */
  controlNumber: "topmostSubform[0].Page1[0].f1_01[0]",
  /** Box c — total number of Forms W-2. */
  w2Count: "topmostSubform[0].Page1[0].BoxesC-H[0].f1_02[0]",
  /** Box e — employer EIN. */
  ein: "topmostSubform[0].Page1[0].BoxesC-H[0].f1_04[0]",
  /** Box f — employer name. */
  employerName: "topmostSubform[0].Page1[0].BoxesC-H[0].f1_05[0]",
  /** Box g — employer address and ZIP (multiline). */
  employerAddress: "topmostSubform[0].Page1[0].BoxesC-H[0].f1_06[0]",
  box1Wages: "topmostSubform[0].Page1[0].Boxes1-14[0].f1_08[0]",
  box2FederalWithheld: "topmostSubform[0].Page1[0].Boxes1-14[0].f1_09[0]",
  box3SsWages: "topmostSubform[0].Page1[0].Boxes1-14[0].f1_10[0]",
  box4SsTax: "topmostSubform[0].Page1[0].Boxes1-14[0].f1_11[0]",
  box5MedicareWages: "topmostSubform[0].Page1[0].Boxes1-14[0].f1_12[0]",
  box6MedicareTax: "topmostSubform[0].Page1[0].Boxes1-14[0].f1_13[0]",
} as const;

/**
 * W-3 checkbox field names (rect-verified: 10×10 pt boxes at y710–720):
 * kind of payer "941" and kind of employer "None apply" — correct for a
 * regular 941-filing corporation (D5). Real PDFCheckBox fields, checked
 * via pdf-lib's check().
 */
export const W3_CHECKBOXES = {
  kindOfPayer941: "topmostSubform[0].Page1[0].bKind_ReadOrder[0].b941[0].c1_1[0]",
  kindOfEmployerNone:
    "topmostSubform[0].Page1[0].bKindOfEmployer_ReadOrder[0].EmployerCheckboxes[0].None[0].c1_2[0]",
} as const;
