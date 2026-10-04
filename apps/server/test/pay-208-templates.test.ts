/**
 * PAY-208 — @payroll/notifications templates and event registry
 * (payroll-calc-auditor, fail-first against d0f722f; the coder may not edit
 * this file). Exact strings: the subjects S13, S17, S19, S21 and the S20
 * body (copy file /private/tmp/wagon-pay208-copy.md, SME copy changes
 * final); other bodies by content. Synthetic data only.
 *
 * Tests: N1-N8.
 *
 * Contract assumed:
 *  - w2Available(ctx, { taxYear, consented, contact, canSwitchOnline }).
 *    The consented variant computes {accessThrough} itself as the long date
 *    of electronicW2AccessThrough(taxYear). contact = { name, phone, email,
 *    mailingAddress } (mailingAddress already resolved: the W-2 contact
 *    address, else the company address).
 *  - w2ConsentWithdrawn(ctx, { effectiveOn: ISO date, contact }) — the body
 *    shows the long date ("February 28, 2027"), never ISO.
 *  - w2ContactChanged(ctx, { contact }).
 *  - EVENT_TYPE.w2ConsentWithdrawn = "w2_consent_withdrawn",
 *    EVENT_TYPE.w2ContactChanged, EVENT_TYPE.w2TermsUpdated (D-D),
 *    EVENT_TYPE.signInEmailChanged (D-A): all always on (not in
 *    WORKFLOW_EVENTS, no EVENT_AUDIENCE entry); w2_available leaves both.
 */

import { describe, expect, it } from "vitest";
import {
  CONTACT,
  CONTACT_ADDRESS,
  hasAmount,
  IMPORTANT,
  need,
  notificationsModule,
  plain,
  scrub,
} from "./pay-208-harness.js";

const CTX = { companyName: "Example Corp", brandName: "Wagon Payroll", appUrl: "http://localhost" };
const C = { ...CONTACT, mailingAddress: CONTACT_ADDRESS };
const ADDRESS_LINE = "100 Example Street, Springfield, IL 62701";
type R = { subject: string; html: string; text: string };
const norm = (s: string) => s.replace(/\s+/g, " ");
const both = (r: R) => [norm(r.text), plain(r.html)];
const containsAll = (r: R, parts: readonly string[]) =>
  parts.filter((p) => !both(r).every((b) => b.includes(p)));

describe("PAY-208 templates", () => {
  it("N1 w2Available consented: S19 subject exactly; S20 body paragraphs exactly (access AND print, accessThrough long date, contact line)", async () => {
    const n = await notificationsModule();
    const r = need(n, "w2Available")(CTX, {
      taxYear: 2026,
      consented: true,
      contact: C,
      canSwitchOnline: true,
    }) as R;
    expect({
      subject: r.subject,
      missing: containsAll(r, [
        "Your 2026 Form W-2 from Example Corp is ready.",
        'To view and print it, sign in at http://localhost, open Payslips, and find "W-2 wage and tax statements". Select Download PDF, then print or save it from your PDF reader. It stays available there through October 15, 2027.',
        "Keep a copy with your tax records. You may need to print it and attach it to your tax return.",
        "Want a paper copy too? Ask W-2 Desk at w2@example.com.",
      ]),
      noAmount: !hasAmount(scrub(r.text)),
    }).toEqual({
      subject: `${IMPORTANT}: Your 2026 W-2 from Example Corp`,
      missing: [],
      noAmount: true,
    });
  });

  it("N2 w2Available consented for 2025 — accessThrough is the business-day roll (2026-10-15, a Thursday)", async () => {
    const n = await notificationsModule();
    const r = need(n, "w2Available")(CTX, {
      taxYear: 2025,
      consented: true,
      contact: C,
      canSwitchOnline: true,
    }) as R;
    expect(containsAll(r, ["It stays available there through October 15, 2026."])).toEqual([]);
  });

  it("N3 w2Available paper: S21 subject exactly; notice-only body; the switch line only with canSwitchOnline; never the IMPORTANT phrase or 'available'", async () => {
    const n = await notificationsModule();
    const fn = need(n, "w2Available");
    const yes = fn(CTX, {
      taxYear: 2026,
      consented: false,
      contact: C,
      canSwitchOnline: true,
    }) as R;
    const no = fn(CTX, {
      taxYear: 2026,
      consented: false,
      contact: C,
      canSwitchOnline: false,
    }) as R;
    const SWITCH =
      'Prefer to get it online? Sign in at http://localhost, open Payslips, and agree to the terms under "W-2 wage and tax statements". You can then download it there.';
    expect({
      subject: yes.subject,
      sameSubject: no.subject === yes.subject,
      missingYes: containsAll(yes, [
        "Example Corp will give you your 2026 Form W-2 on paper. This email is a notice only and is not your W-2.",
        SWITCH,
      ]),
      noSwitchWhenNo: both(no).every(
        (b) => !b.includes("Prefer to get it online?") && !b.includes(CTX.appUrl),
      ),
      noPhrase: [yes, no].every((r) => !`${r.subject} ${r.text} ${r.html}`.includes(IMPORTANT)),
      noAvailable: [yes, no].every((r) => !/available/i.test(`${r.subject} ${r.text}`)),
    }).toEqual({
      subject: "Example Corp — Your 2026 W-2 will be given to you on paper",
      sameSubject: true,
      missingYes: [],
      noSwitchWhenNo: true,
      noPhrase: true,
      noAvailable: true,
    });
  });

  it("N4 w2ConsentWithdrawn: S13 subject exactly; S14 confirmation + long effective date, paper from then, Oct 15 for W-2s already online, how to agree again, the contact (all four); no ISO date, no amount", async () => {
    const n = await notificationsModule();
    const r = need(n, "w2ConsentWithdrawn")(CTX, { effectiveOn: "2027-02-28", contact: C }) as R;
    expect({
      subject: r.subject,
      missing: containsAll(r, [
        "This confirms that you withdrew your agreement to get your W-2s online. It takes effect on February 28, 2027.",
        "From that date, Example Corp will give you your W-2s on paper.",
        "October 15 of the year after its tax year",
        "To get your W-2s online again, sign in, open Payslips, and agree to the terms.",
        CONTACT.name,
        CONTACT.phone,
        CONTACT.email,
        ADDRESS_LINE,
      ]),
      noIso: both(r).every((b) => !b.includes("2027-02-28")),
      noAmount: !hasAmount(scrub(r.text.replace(ADDRESS_LINE, ""))),
      linksAppUrlOnly: [...r.html.matchAll(/href="([^"]*)"/g)].every((m) => m[1] === CTX.appUrl),
    }).toEqual({
      subject: "Example Corp — Your online W-2 withdrawal is confirmed",
      missing: [],
      noIso: true,
      noAmount: true,
      linksAppUrlOnly: true,
    });
  });

  it("N5 w2ContactChanged: S17 subject exactly; the new contact details; nothing else money-like", async () => {
    const n = await notificationsModule();
    const r = need(n, "w2ContactChanged")(CTX, { contact: C }) as R;
    expect({
      subject: r.subject,
      missing: containsAll(r, [
        "Example Corp has new contact details for W-2 questions, paper copy requests and withdrawing from online W-2s:",
        CONTACT.name,
        ADDRESS_LINE,
        CONTACT.phone,
        CONTACT.email,
      ]),
      noAmount: !hasAmount(scrub(r.text)),
    }).toEqual({
      subject: "Example Corp — New contact for your W-2 questions",
      missing: [],
      noAmount: true,
    });
  });

  it("N6 event registry: the new PAY-208 events exist and are always on; w2_available is no longer a workflow toggle (OD6)", async () => {
    const n = await notificationsModule();
    const T = n.EVENT_TYPE as Record<string, string>;
    const W = n.WORKFLOW_EVENTS as string[];
    const A = n.EVENT_AUDIENCE as Record<string, string>;
    const names = [
      "w2ConsentWithdrawn",
      "w2ContactChanged",
      "w2TermsUpdated",
      "signInEmailChanged",
      "w2Available",
    ];
    expect({
      w2ConsentWithdrawn: T.w2ConsentWithdrawn,
      defined: names.map((k) => typeof T[k] === "string"),
      inWorkflow: names.filter((k) => W.includes(T[k]!)),
      inAudience: names.filter((k) => T[k] !== undefined && A[T[k]!] !== undefined),
      employeeSurface: (n.workflowEventsFor as (v: unknown) => string[])({
        isAdmin: false,
        employmentType: "w2",
      }).includes("w2_available"),
    }).toEqual({
      w2ConsentWithdrawn: "w2_consent_withdrawn",
      defined: [true, true, true, true, true],
      inWorkflow: [],
      inAudience: [],
      employeeSurface: false,
    });
  });

  it("N7 no template carries an SSN-like or bank-like value", async () => {
    const n = await notificationsModule();
    const rendered = [
      need(n, "w2Available")(CTX, {
        taxYear: 2026,
        consented: true,
        contact: C,
        canSwitchOnline: true,
      }),
      need(n, "w2Available")(CTX, {
        taxYear: 2026,
        consented: false,
        contact: C,
        canSwitchOnline: true,
      }),
      need(n, "w2ConsentWithdrawn")(CTX, { effectiveOn: "2027-02-28", contact: C }),
      need(n, "w2ContactChanged")(CTX, { contact: C }),
    ] as R[];
    expect(
      rendered.filter((r) => /\b\d{3}-\d{2}-\d{4}\b|routing|account number|\bssn\b/i.test(r.html)),
    ).toEqual([]);
  });
});
