/**
 * PAY-206 T21 (payroll-calc-auditor, fail-first; the coder may not edit this
 * file): the w2_changed email names the UI labels the employee actually
 * sees, from one source (spec R11).
 *
 * Interfaces required:
 *  - @payroll/shared exports PAYSLIPS_NAV_LABEL = "Payslips" and
 *    W2_CARD_HEADING = "W-2 wage and tax statements" (the rendered email
 *    text stays exactly as shipped in PAY-193 L4).
 *  - packages/notifications w2Changed, apps/web App.vue (employee nav) and
 *    MyPayslipsView.vue (W-2 card heading) use the constants; no copy of the
 *    literals remains in those files.
 * The web half is a source check: apps/web has no unit-test runner. T22
 * (web: "{year} W-2 (CORRECTED)" row label; admin banner/buttons only for
 * correctionToFurnish && !consented) is not covered here — no web test
 * runner exists; product-ux-designer / browser QA must check it.
 *
 * Review round (Product Lead D11, UX review item 2, 2026-10-03): the daily
 * reconcile also sends w2_changed when the figures moved for a reason that is
 * not a payroll (e.g. a tax-settings edit), so neither body may state a
 * payroll as the cause. Exact new sentences; subjects, tail and the "where"
 * text unchanged. No hard-coded "Jan 31" in either body (the 2026 W-2
 * furnishing date is Feb 1, 2027).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as shared from "@payroll/shared";
import { w2Changed } from "@payroll/notifications";
import { ROOT } from "./annual-w2-corrected-harness.js";

const src = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const constants = shared as unknown as Record<string, unknown>;

describe("T21 one source for the menu labels in the w2_changed email", () => {
  it("@payroll/shared: PAYSLIPS_NAV_LABEL = 'Payslips', W2_CARD_HEADING = 'W-2 wage and tax statements'", () => {
    expect({
      nav: constants.PAYSLIPS_NAV_LABEL,
      heading: constants.W2_CARD_HEADING,
    }).toEqual({ nav: "Payslips", heading: "W-2 wage and tax statements" });
  });

  it('w2Changed (consented) text and HTML name both constants: open {PAYSLIPS_NAV_LABEL}, find "{W2_CARD_HEADING}"', () => {
    const nav = String(constants.PAYSLIPS_NAV_LABEL);
    const heading = String(constants.W2_CARD_HEADING);
    const r = w2Changed(
      {
        companyName: "Example Corp",
        brandName: "Wagon Payroll",
        appUrl: "http://localhost",
      } as never,
      { taxYear: 2025, consented: true },
    );
    const text = r.text.replace(/\s+/g, " ");
    const html = r.html.replaceAll("&quot;", '"').replaceAll("&#34;", '"');
    const phrase = `open ${nav}, and find "${heading}"`;
    expect({
      defined: nav !== "undefined" && heading !== "undefined",
      text: text.includes(phrase),
      html: html.includes(phrase),
    }).toEqual({ defined: true, text: true, html: true });
  });

  it("notifications, App.vue and MyPayslipsView.vue use the constants and keep no copy of the literals", () => {
    const notif = src("packages/notifications/src/index.ts");
    const app = src("apps/web/src/App.vue");
    const view = src("apps/web/src/views/my/MyPayslipsView.vue");
    expect({
      notifUsesNav: notif.includes("PAYSLIPS_NAV_LABEL"),
      notifUsesHeading: notif.includes("W2_CARD_HEADING"),
      notifLiteral: notif.includes("W-2 wage and tax statements"),
      appUsesNav: app.includes("PAYSLIPS_NAV_LABEL"),
      appLiteral: /label:\s*"Payslips"/.test(app),
      viewUsesHeading: view.includes("W2_CARD_HEADING"),
      viewLiteral: view.includes("W-2 wage and tax statements"),
    }).toEqual({
      notifUsesNav: true,
      notifUsesHeading: true,
      notifLiteral: false,
      appUsesNav: true,
      appLiteral: false,
      viewUsesHeading: true,
      viewLiteral: false,
    });
  });
});

describe("D11 / UX item 2: the w2_changed bodies state no cause", () => {
  const ctx = {
    companyName: "Example Corp",
    brandName: "Wagon Payroll",
    appUrl: "http://localhost",
  } as never;
  const flat = (x: string) => x.replace(/\s+/g, " ");
  const LEAD =
    "Example Corp has corrected your 2025 Form W-2. The corrected W-2 is marked CORRECTED and replaces the earlier one. Use the corrected W-2 for your tax return.";
  const NOTICE =
    "Example Corp has corrected your 2025 Form W-2. Example Corp will give you a corrected paper W-2, marked CORRECTED. Use the corrected paper copy for your tax return, not the earlier one. This email is a notice only and is not your W-2.";

  it("consented: text and HTML carry the new lead; no payroll cause; subject unchanged", () => {
    const r = w2Changed(ctx, { taxYear: 2025, consented: true });
    const text = flat(r.text);
    const html = flat(r.html);
    expect({
      textLead: text.includes(LEAD),
      htmlLead: html.includes(LEAD),
      cause: /payroll processed|because of a payroll|processed a payroll/i.test(`${text} ${html}`),
      jan31: /Jan(uary)?\.? 31/i.test(`${text} ${html}`),
      subject: r.subject,
      tail: text.includes(
        "If you already filed your return using the earlier W-2, you may need to amend it.",
      ),
    }).toEqual({
      textLead: true,
      htmlLead: true,
      cause: false,
      jan31: false,
      subject: "IMPORTANT TAX RETURN DOCUMENT AVAILABLE: Your corrected 2025 W-2 from Example Corp",
      tail: true,
    });
  });

  it("paper: text and HTML carry the new notice; no payroll cause; subject unchanged", () => {
    const r = w2Changed(ctx, { taxYear: 2025, consented: false });
    const text = flat(r.text);
    const html = flat(r.html);
    expect({
      textNotice: text.includes(NOTICE),
      htmlNotice: html.includes(NOTICE),
      cause: /payroll processed|because of a payroll|processed a payroll/i.test(`${text} ${html}`),
      jan31: /Jan(uary)?\.? 31/i.test(`${text} ${html}`),
      subject: r.subject,
    }).toEqual({
      textNotice: true,
      htmlNotice: true,
      cause: false,
      jan31: false,
      subject: "Example Corp — Your 2025 W-2 is being corrected",
    });
  });
});
