/**
 * PAY-208 fixture helper for suites whose subject is NOT the consent itself
 * (payroll-calc-auditor; the coder may not edit this file). After PAY-208,
 * POST /api/my/w2/consent needs a complete W-2 contact (409
 * w2_contact_missing otherwise) and a body { disclosureVersion } equal to
 * the current version (409 disclosure_changed otherwise). These helpers give
 * the older suites a consent through the real route on both the old and the
 * new code: the contact is written only when the PAY-208 columns exist, and
 * the version is read from the module's own constant.
 * Synthetic data only.
 */

import type { TestContext } from "./helpers.js";
import {
  pageContent,
  pageXObjectStrings,
  pdfLib,
  shownStrings,
} from "./annual-w2-corrected-harness.js";

/**
 * PAY-208 D-B (federal SME minimum design): the "Open test PDF" route. One
 * page, no personal data; shows a 6-character code (no look-alike
 * characters) as selectable text, drawn as its own text item.
 */
export const TEST_PDF_URL = "/api/my/w2/consent/test-pdf";

/** Every string the PDF shows (page content + form XObjects). */
export async function pdfStrings(bytes: Uint8Array): Promise<string[]> {
  const doc = await pdfLib.PDFDocument.load(bytes);
  const out: string[] = [];
  for (let i = 0; i < doc.getPageCount(); i += 1) {
    out.push(...shownStrings(pageContent(doc, i)), ...pageXObjectStrings(doc, i));
  }
  return out;
}

/** The access code: the one shown string of exactly 6 upper-case letters/digits. */
export async function codeFromPdf(bytes: Uint8Array): Promise<string | null> {
  const hits = (await pdfStrings(bytes))
    .map((s) => s.trim())
    .filter((s) => /^[A-Z0-9]{6}$/.test(s));
  return hits.length === 1 ? hits[0]! : null;
}

let fixtureIp = 0;
/** GET the test PDF (own client address: the route is PDF-rate-limited). */
export async function fetchTestPdf(t: TestContext, session: Record<string, string>, ip?: string) {
  fixtureIp += 1;
  const addr = ip ?? `10.209.${Math.floor(fixtureIp / 250) % 250}.${(fixtureIp % 250) + 1}`;
  return t.app.inject({
    method: "GET",
    url: TEST_PDF_URL,
    headers: { ...session, "x-forwarded-for": addr },
    remoteAddress: addr,
  });
}

/** A fresh access code, or undefined when the route does not exist (old code). */
export async function accessCodeFor(
  t: TestContext,
  session: Record<string, string>,
): Promise<string | undefined> {
  const res = await fetchTestPdf(t, session);
  if (res.statusCode !== 200) return undefined;
  return (await codeFromPdf(res.rawPayload)) ?? undefined;
}

/** Synthetic W-2 contact columns (migration 0028); a no-op before 0028. */
export async function seedW2ContactIfSupported(t: TestContext): Promise<void> {
  await t.pglite.exec(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'company' AND column_name = 'w2_contact_name') THEN
        EXECUTE $q$UPDATE company SET
          w2_contact_name = 'W-2 Desk',
          w2_contact_phone = '+1 555 0100',
          w2_contact_email = 'w2@example.com',
          w2_contact_address = '{"line1":"100 Example Street","city":"Springfield","state":"IL","zip":"62701","country":"US"}'::jsonb$q$;
      END IF;
    END $$;`);
}

/** The disclosure version the running code shows (its own constant). */
export async function currentDisclosureVersion(): Promise<string> {
  const mod = (await import("../src/filings/w2-consent.js")) as { W2_DISCLOSURE_VERSION: string };
  return mod.W2_DISCLOSURE_VERSION;
}

/**
 * POST /api/my/w2/consent naming the current version (contact seeded
 * first) and, when the test-PDF route exists (D-B), the code read from it.
 */
export async function consentViaApi(t: TestContext, session: Record<string, string>) {
  await seedW2ContactIfSupported(t);
  const accessCode = await accessCodeFor(t, session);
  return t.app.inject({
    method: "POST",
    url: "/api/my/w2/consent",
    headers: session,
    payload: {
      disclosureVersion: await currentDisclosureVersion(),
      ...(accessCode !== undefined ? { accessCode } : {}),
    },
  });
}
