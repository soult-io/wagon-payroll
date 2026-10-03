/**
 * PAY-206 T3-T6 (payroll-calc-auditor, fail-first; the coder may not edit
 * this file): the CORRECTED mark on the employee W-2 packet
 * (@payroll/documents, exercised from the server suite because the
 * documents package has no test runner; rebuild it before running).
 *
 * Ruling: 2026 iw2w3 p.28 — "CORRECTED" on the employee's new Copies B, C
 * and 2; never on Copy A (never emitted); Copy D is the employer's record
 * and is not marked; the W-3 is not marked.
 *
 * Interfaces required (spec R5):
 *  - renderW2EmployeePacket(input, { corrected: boolean }) — optional 2nd
 *    argument; corrected:true draws "CORRECTED" on template pages 3/5/7
 *    (output pages 0/2/4 of the 6-page packet), never on 4/6/8.
 *  - pagesWithCorrectedMark(bytes): Promise<number[]> exported from
 *    @payroll/documents.
 *  - The mark is drawn with pdf-lib page.drawText (BT … Tf … Tm … Tj … ET
 *    in the page's own content stream), font Helvetica-Bold.
 * The oracle for "is the page marked" is this suite's own content-stream
 * scan (annual-w2-corrected-harness.ts), not the helper under test.
 *
 * Placement (T6): the text box = [x, x + width] x [y + descender, y +
 * ascender] at the drawn size, from the Adobe Helvetica-Bold AFM (C 722,
 * O 778, R 722, E 667, T 611, D 722 per 1000 em; Ascender 718, Descender
 * -207). It must lie inside the MediaBox and intersect no AcroForm widget
 * rect of template pages 3/5/7 (measured from the bundled 2025 fw2.pdf
 * before flatten). Position is read from the PDF, so the builder may move
 * the mark inside the top margin without editing this test.
 * Synthetic data only.
 */

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as documents from "@payroll/documents";
import type { W2Input, W3Input } from "@payroll/documents";
import { markedPages, pageContent, pageShowsAll, pdfLib } from "./annual-w2-corrected-harness.js";

const INPUT: W2Input = {
  taxYear: 2025,
  employer: {
    legalName: "Synthetic Wagon Co",
    ein: "001234567",
    address: { line1: "1 Test Way", city: "Springfield", state: "IL", zip: "62701", country: "US" },
  },
  employee: {
    legalName: "Ada Synthetic",
    ssn: null,
    address: { line1: "2 Sample Rd", city: "Peoria", state: "IL", zip: "61602", country: "US" },
  },
  controlNumber: "7",
  // Jan-Dec 2025 at 6,000.00/month (harness oracle).
  box1Wages: "72000.00",
  box2FederalWithheld: "7454.04",
  box3SsWages: "72000.00",
  box4SsTax: "4464.00",
  box5MedicareWages: "72000.00",
  box6MedicareTax: "1044.00",
};
const BOXES = ["72000.00", "7454.04", "72000.00", "4464.00", "72000.00", "1044.00"];

const W3: W3Input = {
  taxYear: 2025,
  employer: INPUT.employer,
  employeeCount: 1,
  box1Wages: "72000.00",
  box2FederalWithheld: "7454.04",
  box3SsWages: "72000.00",
  box4SsTax: "4464.00",
  box5MedicareWages: "72000.00",
  box6MedicareTax: "1044.00",
};

/**
 * Golden SHA-256 of the HEAD (pre-PAY-206) renders at a fixed clock
 * (2026-01-20T12:00:00Z), measured by the auditor on origin/main a05a03e.
 * The unmarked packet and Copy D must stay byte-identical. Regenerate only
 * through the auditor (a pdf-lib upgrade also moves them).
 */
const GOLDEN_PACKET_SHA = "28023c78a10b89e34acdf6a6865ed946acfa4a50904b1454787df593b7b4e782";
const GOLDEN_COPY_D_SHA = "9cc0ef38b4b9f9543513eda6c5347c04e1dd68e43f1ef2c5243fe3dcafe166e3";
const FIXED_NOW = new Date("2026-01-20T12:00:00Z");

type Render = (input: W2Input, opts?: { corrected?: boolean }) => Promise<Buffer>;
const renderPacket = documents.renderW2EmployeePacket as unknown as Render;
const renderCopyD = documents.renderW2AdminCopyD as unknown as Render;

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

afterEach(() => {
  vi.useRealTimers();
});

describe("T3 corrected packet: CORRECTED on Copy B, C and 2 only", () => {
  it("renderW2EmployeePacket(input, { corrected: true }) -> 6 pages, marked pages [0, 2, 4] (instruction pages 1, 3, 5 unmarked), fieldCount 0", async () => {
    const bytes = await renderPacket(INPUT, { corrected: true });
    const structure = await documents.pdfStructure(bytes);
    expect({ marked: await markedPages(bytes), ...structure }).toEqual({
      marked: [0, 2, 4],
      pageCount: 6,
      fieldCount: 0,
    });
  });

  it("each marked page shows the mark exactly once and still carries boxes 1-6 to the cent", async () => {
    const bytes = await renderPacket(INPUT, { corrected: true });
    const doc = await pdfLib.PDFDocument.load(bytes);
    const counts = [0, 2, 4].map(
      (i) =>
        (pageContent(doc, i).match(/<434F52524543544544>\s*Tj|\(CORRECTED\)\s*Tj/gi) ?? []).length,
    );
    const figures = await Promise.all([0, 2, 4].map((i) => pageShowsAll(bytes, i, BOXES)));
    expect({ counts, figures }).toEqual({ counts: [1, 1, 1], figures: [true, true, true] });
  });

  it("pagesWithCorrectedMark (@payroll/documents) agrees with the auditor's scan: [0, 2, 4] marked, [] unmarked", async () => {
    const helper = (documents as unknown as Record<string, unknown>).pagesWithCorrectedMark as
      | ((b: Uint8Array) => Promise<number[]>)
      | undefined;
    expect(typeof helper).toBe("function");
    const marked = await renderPacket(INPUT, { corrected: true });
    const plain = await renderPacket(INPUT, { corrected: false });
    expect({ marked: await helper!(marked), plain: await helper!(plain) }).toEqual({
      marked: [0, 2, 4],
      plain: [],
    });
  });
});

describe("T4 unmarked packet is today's render, byte for byte", () => {
  it("corrected:false and no option -> no marked page; both byte-identical to the HEAD golden", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: FIXED_NOW });
    const off = await renderPacket(INPUT, { corrected: false });
    const none = await renderPacket(INPUT);
    expect({
      marked: await markedPages(off),
      off: sha(off),
      none: sha(none),
    }).toEqual({ marked: [], off: GOLDEN_PACKET_SHA, none: GOLDEN_PACKET_SHA });
  });
});

describe("T5 Copy D and the W-3 are never marked", () => {
  it("renderW2AdminCopyD ignores any corrected option: no mark, bytes equal the HEAD golden; the W-3 has no mark", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: FIXED_NOW });
    const d = await renderCopyD(INPUT, { corrected: true });
    const w3 = await documents.renderW3Pdf(W3);
    expect({
      copyD: await markedPages(d),
      copyDSha: sha(d),
      w3: await markedPages(w3),
    }).toEqual({ copyD: [], copyDSha: GOLDEN_COPY_D_SHA, w3: [] });
  });
});

// ---------------------------------------------------------------- T6 placement

/** Adobe Helvetica-Bold AFM advance widths (1/1000 em) for the mark's glyphs. */
const HB_WIDTH: Record<string, number> = { C: 722, O: 778, R: 722, E: 667, T: 611, D: 722 };
const HB_ASCENDER = 718;
const HB_DESCENDER = -207;

interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
}

/** Widget rects of one template page (before flatten). */
async function templateWidgets(pageIndex: number): Promise<Rect[]> {
  const doc = await pdfLib.PDFDocument.load(documents.templateBytes(2025, "fw2"));
  const annots = doc.getPage(pageIndex).node.Annots();
  const rects: Rect[] = [];
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

/** The mark's text block on an output page: font resource, size, Tm origin. */
// biome-ignore lint/suspicious/noExplicitAny: pdf-lib objects (see harness pdfLib)
function markGeometry(doc: any, pageIndex: number) {
  const content = pageContent(doc, pageIndex);
  const at = content.search(/<434F52524543544544>\s*Tj|\(CORRECTED\)\s*Tj/i);
  if (at < 0) return null;
  const block = content.slice(content.lastIndexOf("BT", at), at);
  const tf = [...block.matchAll(/\/([^\s/]+)\s+([\d.]+)\s+Tf/g)].pop();
  const tm = [
    ...block.matchAll(
      /([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+Tm/g,
    ),
  ].pop();
  if (!tf || !tm) return { error: "no Tf/Tm in the mark's text block" };
  const [a, b, c, d, e, f] = tm.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const fonts = doc.getPage(pageIndex).node.Resources().lookup(pdfLib.PDFName.of("Font"));
  const font = doc.context.lookup(fonts.get(pdfLib.PDFName.of(tf[1]!)));
  const baseFont = font?.get(pdfLib.PDFName.of("BaseFont"))?.toString() ?? null;
  const box = doc.getPage(pageIndex).getMediaBox() as {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  return {
    baseFont,
    size: Number(tf[2]) * a,
    unrotated: b === 0 && c === 0 && a === d,
    x: e,
    y: f,
    box,
  };
}

describe("T6 placement: inside the page, clear of every field", () => {
  for (const [outIndex, templateIndex, copy] of [
    [0, 3, "Copy B"],
    [2, 5, "Copy C"],
    [4, 7, "Copy 2"],
  ] as const) {
    it(`${copy} (template page ${templateIndex}): Helvetica-Bold, unrotated; text box inside the MediaBox and off all ${"widget"} rects`, async () => {
      const bytes = await renderPacket(INPUT, { corrected: true });
      const doc = await pdfLib.PDFDocument.load(bytes);
      const g = markGeometry(doc, outIndex);
      expect(g, "no CORRECTED text block on the page").not.toBeNull();
      expect(g).not.toHaveProperty("error");
      const m = g as Exclude<ReturnType<typeof markGeometry>, null | { error: string }>;
      const width = ([..."CORRECTED"].reduce((s, ch) => s + HB_WIDTH[ch]!, 0) / 1000) * m.size;
      const text: Rect = {
        x1: m.x,
        x2: m.x + width,
        y1: m.y + (HB_DESCENDER / 1000) * m.size,
        y2: m.y + (HB_ASCENDER / 1000) * m.size,
      };
      const widgets = await templateWidgets(templateIndex);
      expect({
        baseFont: m.baseFont,
        unrotated: m.unrotated,
        sizeAtLeast10: m.size >= 10,
        inside:
          text.x1 >= m.box.x &&
          text.y1 >= m.box.y &&
          text.x2 <= m.box.x + m.box.width &&
          text.y2 <= m.box.y + m.box.height,
        widgetsChecked: widgets.length > 0,
        overlapping: widgets.filter((w) => overlaps(text, w)),
      }).toEqual({
        baseFont: "/Helvetica-Bold",
        unrotated: true,
        sizeAtLeast10: true,
        inside: true,
        widgetsChecked: true,
        overlapping: [],
      });
    });
  }
});
