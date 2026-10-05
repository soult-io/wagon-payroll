/**
 * PAY-208 (D-B; 26 CFR 31.6051-1(j)(2)(i)): the one-page test PDF an
 * employee opens before agreeing to online W-2s. It shows a short code they
 * type back, which shows they can open a PDF — the format the W-2 comes in.
 *
 * No personal data: the page carries the code and fixed text only. The code
 * is drawn as its own text item in a standard font so a PDF reader (and a
 * text extractor) shows it as selectable text.
 */

import { Buffer } from "node:buffer";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";

/** Fixed lines above the code (never 6 upper-case letters/digits on their own). */
const LINES = [
  "Online W-2 test file",
  "",
  "You opened this PDF, so your device can open your W-2.",
  "Go back to the Payslips page and type this code:",
] as const;

/** Render the test PDF showing `code`. Pure: no I/O beyond the returned bytes. */
export async function renderAccessCheckPdf(code: string): Promise<Buffer> {
  if (!/^[A-Z0-9]{4,12}$/.test(code)) throw new TypeError("renderAccessCheckPdf: bad code");
  const doc = await PDFDocument.create();
  doc.setTitle("Online W-2 test file");
  doc.setProducer("Wagon Payroll");
  doc.setCreator("Wagon Payroll");
  const page = doc.addPage([612, 396]);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let y = 340;
  for (const [i, line] of LINES.entries()) {
    if (line !== "") {
      page.drawText(line, { x: 54, y, size: i === 0 ? 18 : 12, font: i === 0 ? bold : regular });
    }
    y -= i === 0 ? 30 : 20;
  }
  page.drawText(code, { x: 54, y: y - 30, size: 36, font: bold, color: rgb(0, 0, 0) });
  page.drawText("The code works once and expires after 30 minutes.", {
    x: 54,
    y: y - 70,
    size: 10,
    font: regular,
  });
  return Buffer.from(await doc.save());
}
