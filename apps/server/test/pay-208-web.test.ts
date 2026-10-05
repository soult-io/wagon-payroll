/**
 * PAY-208 T18 — web display logic and copy, tested from the server suite
 * (the web app has no test runner; same method as w2-state-pr4-web.test.ts).
 * payroll-calc-auditor, fail-first against d0f722f; the coder may not edit
 * this file. Exact strings: S3, S-btn, S9, S31, S32, S8 and S18 (copy file
 * /private/tmp/wagon-pay208-copy.md, SME copy changes final). Other copy
 * by presence of its label.
 *
 * Contract assumed — apps/web/src/lib/w2-filing.ts (pure, no Vue):
 *  - unrecordedPayText(year: number): string | null — S18 for year >= 2026
 *    (W2_UNRECORDED_PAY_FROM_YEAR), else null.
 *  - reconsentBannerText(n: number, year: number): string | null — S8,
 *    null when n = 0.
 *  - undeliveredNoticesText(names: string[], year: number): string | null
 *    — the (j)(5)(ii) admin line; null when no names.
 * @payroll/shared: W2_UNRECORDED_PAY_FROM_YEAR = 2026.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as shared from "@payroll/shared";
import { ROOT } from "./annual-w2-corrected-harness.js";

// biome-ignore lint/suspicious/noExplicitAny: contract-shaped dynamic import
type Any = any;
async function lib(): Promise<Record<string, Any>> {
  return (await import(resolve(ROOT, "apps/web/src/lib/w2-filing.ts"))) as Record<string, Any>;
}
function need(mod: Record<string, Any>, name: string): Any {
  const fn = mod[name];
  if (fn === undefined) throw new Error(`apps/web/src/lib/w2-filing.ts has no export "${name}"`);
  return fn;
}
const src = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const MY = "apps/web/src/views/my/MyPayslipsView.vue";
const FILING = "apps/web/src/views/admin/AdminFilingDetailView.vue";
const CONFIG = "apps/web/src/views/admin/AdminConfigView.vue";
const EMP = "apps/web/src/views/admin/AdminEmployeeDetailView.vue";
const API = "apps/web/src/lib/api.ts";

const S18 = (y: number) =>
  `This app doesn't record overtime pay, tips, or employer contributions to a Trump account for an employee or an employee's dependent. If you paid any of these in ${y} outside this app, they must be reported on the W-2, and this app can't add them. Get help from a tax professional before you give out your ${y} W-2s.`;

describe("PAY-208 T18 web", () => {
  it("T18a PAY-210 line: S18 exactly for 2026 and 2027, null for 2025; from-year constant 2026; no support promise (OD7)", async () => {
    const f = need(await lib(), "unrecordedPayText");
    expect({
      y2025: f(2025),
      y2026: f(2026),
      y2027: f(2027),
      fromYear: (shared as Record<string, unknown>).W2_UNRECORDED_PAY_FROM_YEAR,
      noSupport: !/contact support/i.test(String(f(2026))),
    }).toEqual({
      y2025: null,
      y2026: S18(2026),
      y2027: S18(2027),
      fromYear: 2026,
      noSupport: true,
    });
  });

  it("T18b re-consent banner S8: singular, plural, none", async () => {
    const f = need(await lib(), "reconsentBannerText");
    expect({ zero: f(0, 2026), one: f(1, 2026), two: f(2, 2026) }).toEqual({
      zero: null,
      one: '1 employee needs to agree to the new online-W-2 terms. Until they do, give them a paper 2026 W-2 with "Print packet". They\'ll see a prompt on their Payslips page.',
      two: '2 employees need to agree to the new online-W-2 terms. Until they do, give them a paper 2026 W-2 with "Print packet". They\'ll see a prompt on their Payslips page.',
    });
  });

  it("T18c (j)(5)(ii) admin line: names, year, paper within 30 days; null when none", async () => {
    const f = need(await lib(), "undeliveredNoticesText");
    const t = String(f(["Ana Synthetic", "Bo Synthetic"], 2026));
    expect({
      none: f([], 2026),
      names: t.includes("Ana Synthetic") && t.includes("Bo Synthetic"),
      year: t.includes("2026"),
      paper30: /paper/i.test(t) && t.includes("30 days"),
      noAt: !t.includes("@"),
    }).toEqual({ none: null, names: true, year: true, paper30: true, noAt: true });
  });

  it("T18d employee card: renders on upcomingYear; outdated state with S3; S-btn; the access check (S31, S32) and no 'I opened it' checkbox; bullets not in muted small text; old wording gone", () => {
    const v = src(MY);
    const cardIf = [...v.matchAll(/v-if="([^"]*w2[^"]*)"/g)].map((m) => m[1]!).join(" | ");
    expect({
      cardOnUpcoming: /upcomingYear/.test(cardIf) || /upcomingYear/.test(v),
      outdated: v.includes("outdated"),
      s3: v.includes("I agree to the updated terms"),
      sBtn: v.includes("I agree to get my W-2s online"),
      s31: v.includes("Open test PDF"),
      s32: v.includes("Code from the test PDF"),
      noCheckbox: !/I opened it/i.test(v),
      notMutedSmall: !v.includes('<ul class="muted small">'),
      oldButtonGone: !v.includes("I consent to electronic W-2 delivery"),
      noPub1141: !v.includes("Pub 1141"),
    }).toEqual({
      cardOnUpcoming: true,
      outdated: true,
      s3: true,
      sBtn: true,
      s31: true,
      s32: true,
      noCheckbox: true,
      notMutedSmall: true,
      oldButtonGone: true,
      noPub1141: true,
    });
  });

  it("T18e admin views and the API client carry the new surfaces", () => {
    const filing = src(FILING);
    const config = src(CONFIG);
    const emp = src(EMP);
    const api = src(API);
    expect({
      filing: [
        "reconsentNeeded",
        "undeliveredNotices",
        "paper — needs to agree again",
        "unrecordedPayText",
      ].filter((s) => !filing.includes(s)),
      config: ["W-2 contact", "Name or department", "Save W-2 contact"].filter(
        (s) => !config.includes(s),
      ),
      emp: ["W-2 delivery", "Record written withdrawal"].filter((s) => !emp.includes(s)),
      api: [
        "disclosureVersion",
        "accessCode",
        "/api/my/w2/consent/test-pdf",
        "/api/admin/company/w2-contact",
        "w2-consent/withdraw",
        "sign-in-email",
        "upcomingYear",
      ].filter((s) => !api.includes(s)),
      noPub1141: [
        API,
        MY,
        "apps/server/src/filings/w2-consent.ts",
        "apps/server/src/routes/my-w2.ts",
      ].filter((p) => src(p).includes("Pub 1141")),
    }).toEqual({ filing: [], config: [], emp: [], api: [], noPub1141: [] });
  });
});
