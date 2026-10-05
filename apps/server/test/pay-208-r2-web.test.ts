/**
 * PAY-208 fix round 2 — web items, read from the source the way
 * pay-208-web.test.ts does (payroll-calc-auditor, fail-first against
 * c761fff; the coder may not edit this file).
 *
 * Tests: W-N5, W-CL9, W-LINK, W-N1, W-F1, W-SH1.
 *
 *  - N5: in MyPayslipsView.vue the agreed state is tested before the
 *    contact-missing state, so "Withdraw my agreement" stays reachable when
 *    the contact is later cleared.
 *  - C-L9: the 409 access_check_failed message is S33 plus "Use the code
 *    from the most recent test PDF you opened."
 *  - "Open test PDF" is a real <a> styled as a button (no <Button> inside
 *    the <a>), opening in a new tab.
 *  - N1: the S7b line uses the server's per-year accessThrough, not
 *    electronicW2AccessThrough(year) computed in the browser.
 *  - F1: AdminConfigView shows the S11b note next to the company address
 *    while the W-2 contact uses it (the note appears twice: contact card
 *    and company address).
 *  - S-H1: AdminEmployeeDetailView reads the `pendingEnrollment` flag of
 *    the sign-in email change (tells the admin to re-send the invite).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./annual-w2-corrected-harness.js";

const src = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const MY = "apps/web/src/views/my/MyPayslipsView.vue";
const template = (v: string) => v.slice(v.indexOf("<template>"));
const S33 =
  "That code doesn't match the test PDF. Open the test PDF again and type the code you see.";
const S11B = "Saving a change emails the new details to every employee who gets W-2s online.";

describe("PAY-208 round 2 web", () => {
  it("W-N5 the agreed branch comes before the contact-missing branch in the card template", () => {
    const t = template(src(MY));
    const agreed = t.search(/v-(else-)?if="agreed"/);
    const missing = t.search(/v-(else-)?if="contactMissing"/);
    expect({
      agreedFound: agreed >= 0,
      missingFound: missing >= 0,
      agreedFirst: agreed < missing,
    }).toEqual({
      agreedFound: true,
      missingFound: true,
      agreedFirst: true,
    });
  });

  it("W-CL9 the access-check error is S33 + the two-tabs sentence", () => {
    const v = src(MY).replace(/\s+/g, " ");
    expect(v.includes(`${S33} Use the code from the most recent test PDF you opened.`)).toBe(true);
  });

  it("W-LINK 'Open test PDF' is one <a> (new tab), with no <Button> inside it", () => {
    const t = template(src(MY));
    const m = t.match(/<a\b[^>]*testPdfUrl[^>]*>([\s\S]*?)<\/a>/);
    expect({
      found: m !== null,
      newTab: m !== null && /target="_blank"/.test(m[0]),
      noButtonInside: m !== null && !/<Button\b/.test(m[1]!),
      label: m !== null && m[1]!.includes("Open test PDF"),
    }).toEqual({ found: true, newTab: true, noButtonInside: true, label: true });
  });

  it("W-N1 the S7b line uses the server accessThrough; the API type carries it", () => {
    const v = src(MY);
    expect({
      usesServer: /w2\.accessThrough/.test(v),
      noBrowserCompute: !/electronicW2AccessThrough\(\s*w2\.year\s*\)/.test(v),
      apiType: /accessThrough/.test(src("apps/web/src/lib/api.ts")),
    }).toEqual({ usesServer: true, noBrowserCompute: true, apiType: true });
  });

  it("W-F1 the S11b note also shows by the company address (two places)", () => {
    const v = src("apps/web/src/views/admin/AdminConfigView.vue").replace(/\s+/g, " ");
    expect(v.split(S11B).length - 1).toBeGreaterThanOrEqual(2);
  });

  it("W-SH1 the employee detail view handles pendingEnrollment after a sign-in email change", () => {
    expect(
      src("apps/web/src/views/admin/AdminEmployeeDetailView.vue").includes("pendingEnrollment"),
    ).toBe(true);
  });
});
