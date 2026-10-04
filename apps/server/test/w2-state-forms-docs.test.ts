/**
 * Spec 24 (PAY-116) PR-3 "2026 forms" — documents-level suite
 * (payroll-calc-auditor, fail-first; the coder may not edit this file).
 * Exercised from the server suite because @payroll/documents has no test
 * runner: rebuild the package (pnpm --filter @payroll/documents build)
 * before running. Synthetic data only. Oracle: w2-state-forms-oracle.ts
 * (the auditor's own widget dump of the official 2026 PDFs + iw2w3 2026).
 *
 * Tests: W33, W05-PDF (documents level), N1, N2, W06/W09 placement, C1, C2,
 * C3, C4 (guard), A1, D1, P1 (documents level), W15 PDF part (guard).
 *
 * API contract assumed (PR-3 brief §1 items 4–6; names the brief left open
 * are fixed here):
 *  - prepareW2Forms(input: W2Input, copies: W2Copy[]): Promise<PDFDocument[]>
 *    — tax years >= 2026: one pre-flatten document per form (form k = its
 *    own load of the full 11-page template, only `<Copy>_Top[0]` filled).
 *  - W2Input.stateLines: { state: string; stateId: string | null;
 *    box16: string | null; box17: string | null; form: number; row: 1 | 2 }[]
 *  - W2Input.localLines: { locality: string; box18: string; box19: string;
 *    form: number; row: 1 | 2 }[]
 *  - W2Input.formCount: number
 *  - W3Input.w2FormCount: number (W-3 box c for >= 2026, S24-D12);
 *    W3Input.box15State, box15StateId, box16StateWages, box17StateTax,
 *    box18LocalWages, box19LocalTax: string | null (null -> field empty).
 *  - w2LayoutFor(year): { employeePages: number[]; adminCopyDPages: number[];
 *    correctedMarkPages: number[]; correctedMark: { text; size; x; y } };
 *    unknown year throws.
 *  - w2FieldMapFor(year, copy): the 2025 W2FieldMap keys, plus for 2026
 *    stateRows: [{ state, stateId, box16, box17 } x2] and
 *    localRows: [{ box18, box19, box20 } x2] (full field names); unknown
 *    year throws.
 *  - w3FieldMapFor(year): W3_FIELD_MAP (2025); 2026 = W3_FIELD_MAP + box15State,
 *    box15StateId, box16StateWages, box17StateTax, box18LocalWages,
 *    box19LocalTax; unknown year throws.
 *  - Existing exports unchanged: renderW2EmployeePacket(input, { corrected }),
 *    renderW2AdminCopyD, prepareW3, renderW3Pdf, pagesWithCorrectedMark,
 *    pdfStructure, hasTemplate, templateBytes, W2FormAmountError,
 *    W3_FIELD_MAP, w2FieldMap, CORRECTED_MARK.
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { inflateSync } from "node:zlib";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as documents from "@payroll/documents";
import {
  markedPages,
  pageContent,
  pageXObjectStrings,
  pdfLib,
  ROOT,
} from "./annual-w2-corrected-harness.js";
import {
  ALL_COPIES,
  type Copy,
  EMPLOYEE_COPIES,
  expectedFilled,
  federalPlacements,
  filledFields,
  FW2_2026_SHA256,
  FW3_2026_SHA256,
  markBox,
  overlaps,
  rectMismatches,
  rowPlacements,
  W2_2026_ROWS,
  W2_2026_TOP,
  W3_2026,
  W3_CHECKED,
  w2Path,
  widgetRects,
} from "./w2-state-forms-oracle.js";

// ------------------------------------------------------------ loose access

/** New exports are read through this so a missing one fails the test, not the file. */
const docs = documents as unknown as Record<string, unknown>;
// biome-ignore lint/suspicious/noExplicitAny: functions under test, shapes per the contract above
function need(name: string): any {
  const v = docs[name];
  if (v === undefined)
    throw new Error(`@payroll/documents has no export "${name}" (PR-3 contract)`);
  return v;
}
// biome-ignore lint/suspicious/noExplicitAny: input objects carry PR-3 fields not in today's types
type Any = any;
const renderPacket = documents.renderW2EmployeePacket as unknown as (
  input: Any,
  opts?: { corrected?: boolean },
) => Promise<Buffer>;
const renderCopyD = documents.renderW2AdminCopyD as unknown as (
  input: Any,
  opts?: { corrected?: boolean },
) => Promise<Buffer>;
const prepareW3 = documents.prepareW3 as unknown as (input: Any) => Promise<Any>;
const renderW3 = documents.renderW3Pdf as unknown as (input: Any) => Promise<Buffer>;
const prepareW2Forms = (input: Any, copies: Copy[]): Promise<Any[]> =>
  need("prepareW2Forms")(input, copies);

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

afterEach(() => {
  vi.useRealTimers();
});

// ------------------------------------------------------------ synthetic inputs

const EMPLOYER = {
  legalName: "Synthetic Wagon Co",
  ein: "001234567",
  address: { line1: "1 Test Way", city: "Springfield", state: "IL", zip: "62701", country: "US" },
};
const EMPLOYEE = {
  legalName: "Ada Synthetic",
  ssn: "900-00-0001",
  address: { line1: "2 Sample Rd", city: "Peoria", state: "IL", zip: "61602", country: "US" },
};
/** a–f as the form prints them (formatEin, name split, address lines). */
const A_F = {
  ssn: "900-00-0001",
  ein: "00-1234567",
  employerNameAddress: "Synthetic Wagon Co\n1 Test Way\nSpringfield, IL 62701",
  controlNumber: "7",
  employeeFirstName: "Ada",
  employeeLastName: "Synthetic",
  employeeAddress: "2 Sample Rd\nPeoria, IL 61602",
};
/** 12 x 5,000.00 monthly; FIT 500.00/run; SS 6.2%; Medicare 1.45% (fixture literals). */
const BOXES_2026 = {
  box1Wages: "60000.00",
  box2FederalWithheld: "6000.00",
  box3SsWages: "60000.00",
  box4SsTax: "3720.00",
  box5MedicareWages: "60000.00",
  box6MedicareTax: "870.00",
};

function input2026(stateLines: Any[], localLines: Any[] = [], formCount = 1): Any {
  return {
    taxYear: 2026,
    employer: EMPLOYER,
    employee: EMPLOYEE,
    controlNumber: "7",
    ...BOXES_2026,
    stateLines,
    localLines,
    formCount,
  };
}

/** W01 shape: CA one line. */
const CA_ONE = input2026([
  { state: "CA", stateId: "00000001", box16: "60000.00", box17: "148.08", form: 1, row: 1 },
]);

/** W33 (Spec §11): NY two rows (row 2 nulls) + NYC / Yonkers locals. */
const W33_INPUT = input2026(
  [
    { state: "NY", stateId: "123456789", box16: "60000.00", box17: "2400.00", form: 1, row: 1 },
    { state: "NY", stateId: "123456789", box16: null, box17: null, form: 1, row: 2 },
  ],
  [
    { locality: "NYC", box18: "60000.00", box19: "1655.60", form: 1, row: 1 },
    { locality: "YONKERS", box18: "60000.00", box19: "366.00", form: 1, row: 2 },
  ],
);

/** W05 shape (Spec §11): IL / MD on form 1, NC on form 2. */
const W05_INPUT = input2026(
  [
    { state: "IL", stateId: "000000001", box16: "20000.00", box17: "990.00", form: 1, row: 1 },
    { state: "MD", stateId: "00000003", box16: "20000.00", box17: "100.00", form: 1, row: 2 },
    { state: "NC", stateId: "00000004", box16: "20000.00", box17: "80.00", form: 2, row: 1 },
  ],
  [],
  2,
);

function w3Base2026(extra: Record<string, unknown>): Any {
  return {
    taxYear: 2026,
    employer: EMPLOYER,
    employeeCount: 1,
    w2FormCount: 1,
    box1Wages: "60000.00",
    box2FederalWithheld: "6000.00",
    box3SsWages: "60000.00",
    box4SsTax: "3720.00",
    box5MedicareWages: "60000.00",
    box6MedicareTax: "870.00",
    box15State: null,
    box15StateId: null,
    box16StateWages: null,
    box17StateTax: null,
    box18LocalWages: null,
    box19LocalTax: null,
    ...extra,
  };
}

/** Exact non-empty W-3 field set (W3 page 1): federal part + the box 15–19 values given. */
function w3Expected(c: string, b15: Record<string, string>): Record<string, string | true> {
  const out: Record<string, string | true> = {
    [W3_2026.w2Count.name]: c,
    [W3_2026.ein.name]: "00-1234567",
    [W3_2026.employerName.name]: "Synthetic Wagon Co",
    [W3_2026.employerAddress.name]: "1 Test Way\nSpringfield, IL 62701",
    [W3_2026.box1Wages.name]: "60000.00",
    [W3_2026.box2FederalWithheld.name]: "6000.00",
    [W3_2026.box3SsWages.name]: "60000.00",
    [W3_2026.box4SsTax.name]: "3720.00",
    [W3_2026.box5MedicareWages.name]: "60000.00",
    [W3_2026.box6MedicareTax.name]: "870.00",
  };
  for (const [k, v] of Object.entries(b15)) out[W3_2026[k as keyof typeof W3_2026].name] = v;
  for (const n of W3_CHECKED) out[n] = true;
  return out;
}

const W3_BOX15_19 = [
  "box15State",
  "box15StateId",
  "box16StateWages",
  "box17StateTax",
  "box18LocalWages",
  "box19LocalTax",
] as const;

// =========================================================================== A1

describe("A1 2026 fw2/fw3 bundled and SHA-pinned", () => {
  it("hasTemplate(2026, fw2|fw3) true; templateBytes SHA-256 = the official irs-prior files", () => {
    expect({
      fw2: documents.hasTemplate(2026, "fw2"),
      fw3: documents.hasTemplate(2026, "fw3"),
    }).toEqual({ fw2: true, fw3: true });
    expect({
      fw2: sha(documents.templateBytes(2026, "fw2")),
      fw3: sha(documents.templateBytes(2026, "fw3")),
    }).toEqual({ fw2: FW2_2026_SHA256, fw3: FW3_2026_SHA256 });
  });

  it("a one-byte-flipped copy of each 2026 template fails 'failed checksum' (temp copy of the package; the repo assets are untouched)", async () => {
    const pkg = resolve(ROOT, "packages/documents");
    const assets = join(pkg, "assets/forms/2026");
    expect({
      fw2: existsSync(join(assets, "fw2.pdf")),
      fw3: existsSync(join(assets, "fw3.pdf")),
    }).toEqual({ fw2: true, fw3: true });
    const tmp = mkdtempSync(join(tmpdir(), "pay116-a1-"));
    cpSync(join(pkg, "dist"), join(tmp, "dist"), { recursive: true });
    mkdirSync(join(tmp, "assets/forms/2026"), { recursive: true });
    for (const f of ["fw2.pdf", "fw3.pdf"]) {
      copyFileSync(join(assets, f), join(tmp, "assets/forms/2026", f));
      const bytes = readFileSync(join(tmp, "assets/forms/2026", f));
      const i = Math.floor(bytes.length / 2);
      bytes[i] = (bytes[i] as number) ^ 0x01;
      writeFileSync(join(tmp, "assets/forms/2026", f), bytes);
    }
    const mod = (await import(pathToFileURL(join(tmp, "dist/forms/templates.js")).href)) as {
      templateBytes(year: number, form: string): Buffer;
    };
    expect(() => mod.templateBytes(2026, "fw2")).toThrow(/failed checksum/);
    expect(() => mod.templateBytes(2026, "fw3")).toThrow(/failed checksum/);
  });
});

// =========================================================================== C1

describe("C1 per-year layout and field-map selectors", () => {
  it("w2LayoutFor(2025) and (2026): employee pages [3..8], Copy D [9], CORRECTED pages [3,5,7]; 2025 mark = CORRECTED_MARK", () => {
    const layout = need("w2LayoutFor");
    const want = {
      employeePages: [3, 4, 5, 6, 7, 8],
      adminCopyDPages: [9],
      correctedMarkPages: [3, 5, 7],
    };
    const l25 = layout(2025);
    const l26 = layout(2026);
    expect({
      y2025: { ...l25, correctedMark: { ...l25.correctedMark } },
      y2026: {
        employeePages: [...l26.employeePages],
        adminCopyDPages: [...l26.adminCopyDPages],
        correctedMarkPages: [...l26.correctedMarkPages],
        markText: l26.correctedMark.text,
      },
    }).toEqual({
      y2025: { ...want, correctedMark: { ...documents.CORRECTED_MARK } },
      y2026: { ...want, markText: "CORRECTED" },
    });
  });

  it("unknown years throw: w2LayoutFor(2024), w2FieldMapFor(2024, CopyB), w3FieldMapFor(2027)", () => {
    const layout = need("w2LayoutFor");
    const w2map = need("w2FieldMapFor");
    const w3map = need("w3FieldMapFor");
    expect(() => layout(2024)).toThrow();
    expect(() => w2map(2024, "CopyB")).toThrow();
    expect(() => w3map(2027)).toThrow();
  });

  it("w2FieldMapFor(2025, copy) = w2FieldMap(copy) and fills no state/local rows", () => {
    const w2map = need("w2FieldMapFor");
    for (const copy of ALL_COPIES) {
      const m = w2map(2025, copy);
      expect(m).toMatchObject(documents.w2FieldMap(copy));
      expect({ stateRows: m.stateRows ?? [], localRows: m.localRows ?? [] }).toEqual({
        stateRows: [],
        localRows: [],
      });
    }
  });

  it("w2FieldMapFor(2026, copy): the _Top[0] paths of a–f, 1–6 and rows 1–2 of boxes 15–20 (S24-D6 / auditor dump)", () => {
    const w2map = need("w2FieldMapFor");
    for (const copy of ALL_COPIES) {
      const want: Record<string, unknown> = {};
      for (const [k, f] of Object.entries(W2_2026_TOP)) want[k] = w2Path(copy, f.sub);
      want.stateRows = [0, 1].map((i) => ({
        state: w2Path(copy, W2_2026_ROWS.state[i as 0 | 1].sub),
        stateId: w2Path(copy, W2_2026_ROWS.stateId[i as 0 | 1].sub),
        box16: w2Path(copy, W2_2026_ROWS.box16[i as 0 | 1].sub),
        box17: w2Path(copy, W2_2026_ROWS.box17[i as 0 | 1].sub),
      }));
      want.localRows = [0, 1].map((i) => ({
        box18: w2Path(copy, W2_2026_ROWS.box18[i as 0 | 1].sub),
        box19: w2Path(copy, W2_2026_ROWS.box19[i as 0 | 1].sub),
        box20: w2Path(copy, W2_2026_ROWS.box20[i as 0 | 1].sub),
      }));
      expect(w2map(2026, copy), copy).toMatchObject(want);
    }
  });

  it("w3FieldMapFor(2025) = W3_FIELD_MAP; w3FieldMapFor(2026) = W3_FIELD_MAP + f1_23..f1_28 for boxes 15–19", () => {
    const w3map = need("w3FieldMapFor");
    expect(w3map(2025)).toEqual(documents.W3_FIELD_MAP);
    const extra: Record<string, string> = {};
    for (const k of W3_BOX15_19) extra[k] = W3_2026[k].name;
    expect(w3map(2026)).toMatchObject({ ...documents.W3_FIELD_MAP, ...extra });
  });
});

// =========================================================================== W33

describe("W33 2026 map, NY two-row layout + boxes 18–20 (S24-D8, S1)", () => {
  it("Copy B/C/2/D Top: every value by full name; f2_36/f2_38 empty; nothing else filled", async () => {
    const forms = await prepareW2Forms(W33_INPUT, ALL_COPIES);
    expect(forms.length).toBe(1);
    const want = expectedFilled(ALL_COPIES, {
      ...A_F,
      boxes: BOXES_2026,
      states: [
        { state: "NY", stateId: "123456789", box16: "60000.00", box17: "2400.00" },
        { state: "NY", stateId: "123456789", box16: null, box17: null },
      ],
      locals: [
        { box18: "60000.00", box19: "1655.60", box20: "NYC" },
        { box18: "60000.00", box19: "366.00", box20: "YONKERS" },
      ],
    });
    expect(filledFields(forms[0])).toEqual(want);
  });

  it("every box 15–20 row field and every a–f / 1–6 field sits on its copy page within ±1 pt of the table", async () => {
    const [doc] = await prepareW2Forms(W33_INPUT, ALL_COPIES);
    const want = ALL_COPIES.flatMap((c) => [...rowPlacements(c), ...federalPlacements(c)]);
    expect(want.length).toBe(4 * 27);
    expect(rectMismatches(doc, want)).toEqual([]);
  });

  it("W-3: f1_27 120000.00, f1_28 2021.60 (and boxes 15–17 as given), rects ±1 pt on page 1", async () => {
    const w3 = w3Base2026({
      box15State: "NY",
      box15StateId: "123456789",
      box16StateWages: "60000.00",
      box17StateTax: "2400.00",
      box18LocalWages: "120000.00",
      box19LocalTax: "2021.60",
    });
    const doc = await prepareW3(w3);
    expect(filledFields(doc)).toEqual(
      w3Expected("1", {
        box15State: "NY",
        box15StateId: "123456789",
        box16StateWages: "60000.00",
        box17StateTax: "2400.00",
        box18LocalWages: "120000.00",
        box19LocalTax: "2021.60",
      }),
    );
    const placements = W3_BOX15_19.map((k) => ({
      name: W3_2026[k].name,
      rect: W3_2026[k].rect,
      page: 1,
    }));
    expect(rectMismatches(doc, placements)).toEqual([]);
  });
});

// ================================================================ W06 / W09 / W29

describe("2026 single form placement (W01 / W06 / W09 shapes)", () => {
  it("W01 shape: CA row 1 only (f2_31 CA, f2_32 00000001, f2_35 60000.00, f2_37 148.08); row 2 and 18–20 empty", async () => {
    const forms = await prepareW2Forms(CA_ONE, ALL_COPIES);
    expect(forms.length).toBe(1);
    expect(filledFields(forms[0])).toEqual(
      expectedFilled(ALL_COPIES, {
        ...A_F,
        boxes: BOXES_2026,
        states: [{ state: "CA", stateId: "00000001", box16: "60000.00", box17: "148.08" }],
        locals: [],
      }),
    );
  });

  it("W06 shape: no state lines -> only a–f and 1–6 (no _Bottom, no Copy A/1, no boxes 7–20)", async () => {
    const forms = await prepareW2Forms(input2026([]), ALL_COPIES);
    expect(forms.length).toBe(1);
    expect(filledFields(forms[0])).toEqual(
      expectedFilled(ALL_COPIES, { ...A_F, boxes: BOXES_2026, states: [], locals: [] }),
    );
  });

  it("W09 shape: stateId null -> box 15 state printed, ID blank", async () => {
    const forms = await prepareW2Forms(
      input2026([
        { state: "NC", stateId: null, box16: "60000.00", box17: "0.00", form: 1, row: 1 },
      ]),
      ["CopyB"],
    );
    expect(filledFields(forms[0])).toEqual(
      expectedFilled(["CopyB"], {
        ...A_F,
        boxes: BOXES_2026,
        states: [{ state: "NC", stateId: null, box16: "60000.00", box17: "0.00" }],
        locals: [],
      }),
    );
  });

  it("N=1 renders: employee packet 6 pages, Copy D 1 page, no fields left", async () => {
    expect({
      packet: await documents.pdfStructure(await renderPacket(CA_ONE)),
      copyD: await documents.pdfStructure(await renderCopyD(CA_ONE)),
    }).toEqual({
      packet: { pageCount: 6, fieldCount: 0 },
      copyD: { pageCount: 1, fieldCount: 0 },
    });
  });
});

// ======================================================================= W05 / N2

describe("W05-PDF (documents level) + N2: three states -> two forms", () => {
  it("prepareW2Forms -> 2 documents; form 1 = a–f, 1–6, IL row 1, MD row 2", async () => {
    const forms = await prepareW2Forms(W05_INPUT, ALL_COPIES);
    expect(forms.length).toBe(2);
    expect(filledFields(forms[0])).toEqual(
      expectedFilled(ALL_COPIES, {
        ...A_F,
        boxes: BOXES_2026,
        states: [
          { state: "IL", stateId: "000000001", box16: "20000.00", box17: "990.00" },
          { state: "MD", stateId: "00000003", box16: "20000.00", box17: "100.00" },
        ],
        locals: [],
      }),
    );
  });

  it("N2: form 2 = a–f + NC on row 1 only; boxes 1–14 empty (iw2w3 2026 p.17)", async () => {
    const forms = await prepareW2Forms(W05_INPUT, ALL_COPIES);
    expect(filledFields(forms[1])).toEqual(
      expectedFilled(ALL_COPIES, {
        ...A_F,
        boxes: null,
        states: [{ state: "NC", stateId: "00000004", box16: "20000.00", box17: "80.00" }],
        locals: [],
      }),
    );
  });

  it("employee packet: 9 pages (B1 B2 Notice C1 C2 Instr 2-1 2-2 Instr), fieldCount 0; form 2 pages carry no box 1–6 figure", async () => {
    const bytes = await renderPacket(W05_INPUT);
    const doc = await pdfLib.PDFDocument.load(bytes);
    const shown = (i: number) => pageXObjectStrings(doc, i);
    const form1 = ["IL", "000000001", "MD", "00000003", "990.00", "100.00", "60000.00", "6000.00"];
    const form2 = ["NC", "00000004", "20000.00", "80.00"];
    const federal = ["60000.00", "6000.00", "3720.00", "870.00"];
    const view = (i: number) => ({
      form1: form1.every((v) => shown(i).includes(v)),
      form2: form2.every((v) => shown(i).includes(v)),
      federal: federal.some((v) => shown(i).includes(v)),
    });
    const F1 = { form1: true, form2: false, federal: true };
    const F2 = { form1: false, form2: true, federal: false };
    const INSTR = { form1: false, form2: false, federal: false };
    expect({
      structure: await documents.pdfStructure(bytes),
      pages: Array.from({ length: doc.getPageCount() }, (_, i) => view(i)),
    }).toEqual({
      structure: { pageCount: 9, fieldCount: 0 },
      pages: [F1, F2, INSTR, F1, F2, INSTR, F1, F2, INSTR],
    });
  });

  it("Copy D: 2 pages (form 1, form 2), fieldCount 0", async () => {
    const bytes = await renderCopyD(W05_INPUT);
    const doc = await pdfLib.PDFDocument.load(bytes);
    expect({
      structure: await documents.pdfStructure(bytes),
      p0: ["IL", "MD", "60000.00"].every((v) => pageXObjectStrings(doc, 0).includes(v)),
      p1: ["NC", "80.00"].every((v) => pageXObjectStrings(doc, 1).includes(v)),
      p1Federal: pageXObjectStrings(doc, 1).includes("60000.00"),
    }).toEqual({
      structure: { pageCount: 2, fieldCount: 0 },
      p0: true,
      p1: true,
      p1Federal: false,
    });
  });
});

// =========================================================================== N1

describe("N1 W-3 box 15 (iw2w3 2026 p.26)", () => {
  it("one state: f1_23 state code AND f1_24 employer state ID", async () => {
    const doc = await prepareW3(
      w3Base2026({
        box15State: "CA",
        box15StateId: "00000001",
        box16StateWages: "60000.00",
        box17StateTax: "148.08",
      }),
    );
    expect(filledFields(doc)).toEqual(
      w3Expected("1", {
        box15State: "CA",
        box15StateId: "00000001",
        box16StateWages: "60000.00",
        box17StateTax: "148.08",
      }),
    );
  });

  it("more than one state: f1_23 X, f1_24 empty; box c prints w2FormCount (2), not employeeCount (1)", async () => {
    const doc = await prepareW3(
      w3Base2026({
        w2FormCount: 2,
        box15State: "X",
        box16StateWages: "60000.00",
        box17StateTax: "1170.00",
      }),
    );
    expect(filledFields(doc)).toEqual(
      w3Expected("2", { box15State: "X", box16StateWages: "60000.00", box17StateTax: "1170.00" }),
    );
  });

  it("W06 shape: all box 15–19 inputs null -> f1_23..f1_28 empty", async () => {
    const doc = await prepareW3(w3Base2026({}));
    expect(filledFields(doc)).toEqual(w3Expected("1", {}));
  });
});

// =========================================================================== C2

describe("C2 CORRECTED on 2026 multi-form packets", () => {
  const helper = () => need("pagesWithCorrectedMark") as (b: Uint8Array) => Promise<number[]>;

  it("N=1: marked [0, 2, 4]; unmarked []; Copy D []", async () => {
    const marked = await renderPacket(CA_ONE, { corrected: true });
    const plain = await renderPacket(CA_ONE, { corrected: false });
    const d = await renderCopyD(CA_ONE, { corrected: true });
    expect({
      auditor: await markedPages(marked),
      helper: await helper()(marked),
      plain: await markedPages(plain),
      copyD: await markedPages(d),
    }).toEqual({ auditor: [0, 2, 4], helper: [0, 2, 4], plain: [], copyD: [] });
  });

  it("N=2 (W05 shape): marked [0, 1, 3, 4, 6, 7]; unmarked []; Copy D []", async () => {
    const marked = await renderPacket(W05_INPUT, { corrected: true });
    const plain = await renderPacket(W05_INPUT);
    const d = await renderCopyD(W05_INPUT, { corrected: true });
    expect({
      auditor: await markedPages(marked),
      helper: await helper()(marked),
      plain: await markedPages(plain),
      copyD: await markedPages(d),
      pages: (await documents.pdfStructure(marked)).pageCount,
    }).toEqual({
      auditor: [0, 1, 3, 4, 6, 7],
      helper: [0, 1, 3, 4, 6, 7],
      plain: [],
      copyD: [],
      pages: 9,
    });
  });
});

// =========================================================================== C3

describe("C3 CORRECTED mark clear of every 2026 widget", () => {
  it("N=2 packet: on each marked page the mark is Helvetica-Bold >= 10 pt, unrotated, at w2LayoutFor(2026).correctedMark, inside the page, off every widget of its template page", async () => {
    const layout = need("w2LayoutFor")(2026);
    const template = await pdfLib.PDFDocument.load(documents.templateBytes(2026, "fw2"));
    const bytes = await renderPacket(W05_INPUT, { corrected: true });
    const doc = await pdfLib.PDFDocument.load(bytes);
    const results = (
      [
        [0, 3],
        [1, 3],
        [3, 5],
        [4, 5],
        [6, 7],
        [7, 7],
      ] as const
    ).map(([out, tpl]) => {
      const m = markBox(doc, out, pageContent(doc, out));
      if (typeof m === "string") return { out, error: m };
      const widgets = widgetRects(template, tpl);
      return {
        out,
        baseFont: m.baseFont,
        unrotated: m.unrotated,
        sizeAtLeast10: m.size >= 10,
        atLayout: m.origin.x === layout.correctedMark.x && m.origin.y === layout.correctedMark.y,
        inside:
          m.text.x1 >= m.media.x1 &&
          m.text.y1 >= m.media.y1 &&
          m.text.x2 <= m.media.x2 &&
          m.text.y2 <= m.media.y2,
        widgetsChecked: widgets.length === 94,
        overlapping: widgets.filter((w) => overlaps(m.text, w)).length,
      };
    });
    const ok = (out: number) => ({
      out,
      baseFont: "/Helvetica-Bold",
      unrotated: true,
      sizeAtLeast10: true,
      atLayout: true,
      inside: true,
      widgetsChecked: true,
      overlapping: 0,
    });
    expect(results).toEqual([0, 1, 3, 4, 6, 7].map(ok));
  });
});

// ================================================================ W15 / C4 guards

const INPUT_2025 = {
  taxYear: 2025,
  employer: EMPLOYER,
  employee: { ...EMPLOYEE, ssn: null },
  controlNumber: "7",
  box1Wages: "72000.00",
  box2FederalWithheld: "7454.04",
  box3SsWages: "72000.00",
  box4SsTax: "4464.00",
  box5MedicareWages: "72000.00",
  box6MedicareTax: "1044.00",
};
const W3_2025 = {
  taxYear: 2025,
  employer: EMPLOYER,
  employeeCount: 1,
  box1Wages: "72000.00",
  box2FederalWithheld: "7454.04",
  box3SsWages: "72000.00",
  box4SsTax: "4464.00",
  box5MedicareWages: "72000.00",
  box6MedicareTax: "1044.00",
};
/**
 * Goldens measured by the auditor on origin/main 9f42fda (pre-PR-3) at the
 * fixed clock below; packet and Copy D equal the PAY-206 goldens of
 * annual-w2-corrected-pdf.test.ts (cross-check of the method).
 * PR-3 round 2 R6: the W-3 output is rebuilt without the template's
 * JavaScript, so the 2025 W-3 byte golden (bb55fb2d…8498) is retired; the
 * W-3 guard is now its shown values (measured on 9f42fda), page count, no
 * fields, no script — and identical bytes with or without the null box
 * 15–19 inputs. The 2025 W-2 goldens stay.
 */
const FIXED_NOW = new Date("2026-01-20T12:00:00Z");
const GOLDEN_2025 = {
  packet: "28023c78a10b89e34acdf6a6865ed946acfa4a50904b1454787df593b7b4e782",
  copyD: "9cc0ef38b4b9f9543513eda6c5347c04e1dd68e43f1ef2c5243fe3dcafe166e3",
  corrected: "e7b402d5647a0756982eb083b80222cbbb8af3cd43c2496f6f96ef9f52d65b15",
};

/** The 2025 single-up paths (auditor dump of fw2--2025.pdf), filled values. */
function expected2025(copies: readonly Copy[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of copies) {
    const p = `topmostSubform[0].${c}[0]`;
    Object.assign(out, {
      [`${p}.Col_Left[0].f2_02[0]`]: "00-1234567",
      [`${p}.Col_Left[0].f2_03[0]`]: "Synthetic Wagon Co\n1 Test Way\nSpringfield, IL 62701",
      [`${p}.Col_Left[0].f2_04[0]`]: "7",
      [`${p}.Col_Left[0].FirstName_ReadOrder[0].f2_05[0]`]: "Ada",
      [`${p}.Col_Left[0].LastName_ReadOrder[0].f2_06[0]`]: "Synthetic",
      [`${p}.Col_Left[0].f2_08[0]`]: "2 Sample Rd\nPeoria, IL 61602",
      [`${p}.Col_Right[0].Box1_ReadOrder[0].f2_09[0]`]: "72000.00",
      [`${p}.Col_Right[0].f2_10[0]`]: "7454.04",
      [`${p}.Col_Right[0].Box3_ReadOrder[0].f2_11[0]`]: "72000.00",
      [`${p}.Col_Right[0].f2_12[0]`]: "4464.00",
      [`${p}.Col_Right[0].Box5_ReadOrder[0].f2_13[0]`]: "72000.00",
      [`${p}.Col_Right[0].f2_14[0]`]: "1044.00",
    });
  }
  return out;
}

describe("W15 PDF part (guard: passes before and after PR-3) — 2025 unchanged", () => {
  it("2025 pre-flatten field values: exactly boxes a–f and 1–6 on Copies B/C/2 (and D) — with or without empty stateLines/localLines", async () => {
    const withEmpty = { ...INPUT_2025, stateLines: [], localLines: [], formCount: 1 };
    expect({
      packet: filledFields(await documents.prepareW2EmployeePacket(INPUT_2025)),
      packetEmpty: filledFields(await documents.prepareW2EmployeePacket(withEmpty as Any)),
      copyD: filledFields(await documents.prepareW2AdminCopyD(INPUT_2025)),
    }).toEqual({
      packet: expected2025(EMPLOYEE_COPIES),
      packetEmpty: expected2025(EMPLOYEE_COPIES),
      copyD: expected2025(["CopyD"]),
    });
  });

  it("2025 W-2 bytes unchanged: packet and Copy D equal the pre-PR-3 goldens (also with empty state fields)", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: FIXED_NOW });
    const withEmpty = { ...INPUT_2025, stateLines: [], localLines: [], formCount: 1 };
    expect({
      packet: sha(await renderPacket(INPUT_2025)),
      packetEmpty: sha(await renderPacket(withEmpty)),
      copyD: sha(await renderCopyD(INPUT_2025)),
    }).toEqual({
      packet: GOLDEN_2025.packet,
      packetEmpty: GOLDEN_2025.packet,
      copyD: GOLDEN_2025.copyD,
    });
  });

  it("2025 W-3 unchanged in content: 1 page, no fields, the shown values measured on 9f42fda; same bytes with null boxes 15–19", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: FIXED_NOW });
    const w3Nulls = { ...W3_2025, ...Object.fromEntries(W3_BOX15_19.map((k) => [k, null])) };
    const bytes = await renderW3(W3_2025);
    const doc = await pdfLib.PDFDocument.load(bytes);
    expect({
      structure: await documents.pdfStructure(bytes),
      shown: pageXObjectStrings(doc, 0)
        .filter((v: string) => v !== "")
        .sort(),
      sameWithNulls: sha(await renderW3(w3Nulls)) === sha(bytes),
    }).toEqual({
      structure: { pageCount: 1, fieldCount: 0 },
      // "4" = the ZapfDingbats check of the 941 and None boxes; "1" = box c.
      shown: [
        "1",
        "4",
        "4",
        "00-1234567",
        "Synthetic Wagon Co",
        "1 Test Way",
        "Springfield, IL 62701",
        "72000.00",
        "7454.04",
        "72000.00",
        "4464.00",
        "72000.00",
        "1044.00",
      ].sort(),
      sameWithNulls: true,
    });
  });
});

describe("C4 2025 CORRECTED (guard: passes before and after PR-3)", () => {
  it("2025 corrected packet: marked [0, 2, 4], 6 pages, bytes equal the pre-PR-3 golden", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: FIXED_NOW });
    const bytes = await renderPacket(INPUT_2025, { corrected: true });
    expect({
      marked: await markedPages(bytes),
      pages: (await documents.pdfStructure(bytes)).pageCount,
      sha: sha(bytes),
    }).toEqual({ marked: [0, 2, 4], pages: 6, sha: GOLDEN_2025.corrected });
  });
});

// =========================================================================== R6

/** Catalog / object keys that make a PDF run script or act on open (security L1). */
const SCRIPT_KEYS = ["JavaScript", "JS", "OpenAction", "AA", "Perms"];

/** Every SCRIPT_KEYS name used as a dictionary key anywhere in the file (incl. object streams). */
async function scriptKeys(bytes: Uint8Array): Promise<string[]> {
  const doc = await pdfLib.PDFDocument.load(bytes);
  const hits = new Set<string>();
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = obj instanceof pdfLib.PDFDict ? obj : (obj as { dict?: unknown })?.dict;
    if (!(dict instanceof pdfLib.PDFDict)) continue;
    for (const key of (dict as Any).keys()) {
      const name = String(key.asString()).slice(1);
      if (SCRIPT_KEYS.includes(name)) hits.add(name);
    }
  }
  return [...hits].sort();
}

describe("R6 rendered W-3 carries no JavaScript, open action, additional actions or Perms (security L1)", () => {
  it("W-3 2025 and 2026: none of /JavaScript /JS /OpenAction /AA /Perms; still 1 page, no fields", async () => {
    const w3_2025 = await renderW3(W3_2025);
    const w3_2026 = await renderW3(
      w3Base2026({
        box15State: "CA",
        box15StateId: "00000001",
        box16StateWages: "60000.00",
        box17StateTax: "148.08",
      }),
    );
    expect({
      y2025: await scriptKeys(w3_2025),
      y2026: await scriptKeys(w3_2026),
      s2025: await documents.pdfStructure(w3_2025),
      s2026: await documents.pdfStructure(w3_2026),
    }).toEqual({
      y2025: [],
      y2026: [],
      s2025: { pageCount: 1, fieldCount: 0 },
      s2026: { pageCount: 1, fieldCount: 0 },
    });
  });

  it("guard: the 2026 W-2 packet and Copy D carry none either (built with PDFDocument.create)", async () => {
    expect({
      packet: await scriptKeys(await renderPacket(W05_INPUT)),
      copyD: await scriptKeys(await renderCopyD(W05_INPUT)),
    }).toEqual({ packet: [], copyD: [] });
  });
});

// =========================================================================== R5

/** Font size and shown text of one field's normal appearance (pre-flatten). */
function appearance(doc: Any, name: string): { size: number | null; text: string } {
  // pdf-lib builds appearances lazily (on save / flatten); build them as flatten would.
  doc.getForm().updateFieldAppearances();
  const field = doc.getForm().getTextField(name);
  const widget = field.acroField.getWidgets()[0];
  const ap = widget.getNormalAppearance();
  const stream = ap instanceof pdfLib.PDFRef ? doc.context.lookup(ap) : ap;
  const filter = String(stream.dict.get(pdfLib.PDFName.of("Filter")) ?? "");
  const raw =
    stream instanceof pdfLib.PDFRawStream
      ? pdfLib.decodePDFRawStream(stream).decode()
      : filter === "/FlateDecode"
        ? inflateSync(Buffer.from(stream.getContents()))
        : stream.getContents();
  const src = Buffer.from(raw).toString("latin1");
  const tf = [...src.matchAll(/\/[^\s/]+\s+([\d.]+)\s+Tf/g)].pop();
  const shown = [...src.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj|<([0-9A-Fa-f]*)>\s*Tj/g)]
    .map((m) => (m[1] !== undefined ? m[1] : Buffer.from(m[2] ?? "", "hex").toString("latin1")))
    .join("");
  return { size: tf ? Number(tf[1]) : null, text: shown };
}

describe("R5 long state IDs on the 2026 W-2 (f2_32: no MaxLen, DoNotScroll, 8 pt, width 127.6 pt)", () => {
  // Auditor dump: f2_32/f2_34 MaxLen none, Ff 8388608 (DoNotScroll), DA
  // HelveticaLTStd-Bold 8 pt, rect 65.8–193.4 (127.6 pt). Digits are 556/1000
  // em in Helvetica and Helvetica-Bold. 32 digits: 142.3 pt at 8 pt (does not
  // fit), 106.8 pt at 6 pt (fits) -> auto-size between 6 and 8 pt.
  const ID32 = "12345678901234567890123456789012";
  it("a 32-digit ID is filled in full, auto-sized below 8 pt and not below 6 pt, and its text width fits the field", async () => {
    const forms = await prepareW2Forms(
      input2026([
        { state: "CA", stateId: ID32, box16: "60000.00", box17: "148.08", form: 1, row: 1 },
      ]),
      ["CopyB"],
    );
    const name = w2Path("CopyB", W2_2026_ROWS.stateId[0].sub);
    const a = appearance(forms[0], name);
    const size = a.size ?? 0;
    expect({
      value: forms[0].getForm().getTextField(name).getText(),
      shown: a.text,
      shrunk: size < 8,
      atLeast6: size >= 6,
      fits: 32 * 0.556 * size <= 127.6,
    }).toEqual({ value: ID32, shown: ID32, shrunk: true, atLeast6: true, fits: true });
  });
});

// =========================================================================== D1

describe("D1 a 2025 W2Input with state or local lines is refused (S24-D5 defensive)", () => {
  const line = {
    state: "IL",
    stateId: "86429753",
    box16: "72000.00",
    box17: "1782.00",
    form: 1,
    row: 1,
  };
  const local = { locality: "NYC", box18: "72000.00", box19: "1987.20", form: 1, row: 1 };
  const cases: [string, () => Promise<unknown>][] = [
    [
      "packet + stateLines",
      () => renderPacket({ ...INPUT_2025, stateLines: [line], localLines: [], formCount: 1 }),
    ],
    [
      "Copy D + stateLines",
      () => renderCopyD({ ...INPUT_2025, stateLines: [line], localLines: [], formCount: 1 }),
    ],
    [
      "prepare packet + stateLines",
      () =>
        documents.prepareW2EmployeePacket({
          ...INPUT_2025,
          stateLines: [line],
          localLines: [],
          formCount: 1,
        } as Any),
    ],
    [
      "packet + localLines",
      () => renderPacket({ ...INPUT_2025, stateLines: [], localLines: [local], formCount: 1 }),
    ],
  ];
  for (const [name, run] of cases) {
    it(`${name} -> rejects; the message carries no ID, SSN or amount (P1)`, async () => {
      const err = await run().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, "expected a rejection").toBeInstanceOf(Error);
      const msg = String((err as Error).message);
      for (const secret of ["86429753", "72000.00", "1782.00", "1987.20", "NYC"]) {
        expect(msg).not.toContain(secret);
      }
    });
  }
});

// =========================================================================== P1

describe("P1 (documents level): malformed 2026 line amounts are refused without echo", () => {
  const bad: [string, Any][] = [
    [
      "box16 with a comma",
      input2026([
        { state: "CA", stateId: "86429753", box16: "60,000.00", box17: "148.08", form: 1, row: 1 },
      ]),
    ],
    [
      "negative box17",
      input2026([
        { state: "CA", stateId: "86429753", box16: "60000.00", box17: "-148.08", form: 1, row: 1 },
      ]),
    ],
    [
      "box19 float-shaped",
      input2026(
        [
          {
            state: "NY",
            stateId: "86429753",
            box16: "60000.00",
            box17: "2400.00",
            form: 1,
            row: 1,
          },
        ],
        [{ locality: "NYC", box18: "60000.00", box19: "1655.6", form: 1, row: 1 }],
      ),
    ],
  ];
  for (const [name, input] of bad) {
    it(`${name} -> W2FormAmountError (fixed message; no ID, SSN or amount)`, async () => {
      const err = await renderPacket(input).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(documents.W2FormAmountError);
      const msg = String((err as Error).message);
      for (const secret of [
        "86429753",
        "900-00-0001",
        "60,000.00",
        "148.08",
        "1655.6",
        "60000.00",
      ]) {
        expect(msg).not.toContain(secret);
      }
    });
  }
});
