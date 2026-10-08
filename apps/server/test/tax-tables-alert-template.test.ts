/**
 * PAY-103 R18 PR-5a: the `taxTablesMissing` email template
 * (packages/notifications). payroll-calc-auditor, fail-first; the coder may
 * not edit this file.
 *
 * Contract assumed (brief §4.1 + Product Lead round 2 + final copy
 * /private/tmp/wagon-pay103-copy.md, 2026-10-06):
 *   EVENT_TYPE.taxTablesMissing = "tax_tables_missing"; in WORKFLOW_EVENTS;
 *   EVENT_AUDIENCE = "admin".
 *   taxTablesMissing(ctx, { year: number; federal: boolean;
 *     stateLabels: string[]; when: "upcoming" | "current" }) → {subject, html, text}
 *   - stateLabels are display names already sorted by the caller; "federal"
 *     is listed first, lowercase, mid-sentence; joined "A, B and C".
 *   - Subjects (pinned exactly; the email() helper prefixes "{Company} — "):
 *       upcoming:            "{Year} tax tables aren't installed yet"
 *       current, federal:    "{Year} payroll is on hold: tax tables not installed"
 *       current, states only "{Year} payroll is on hold for employees in {states}"
 *   - Bodies asserted by keywords only. A states-only email never says all
 *     payroll is held. The only link is `${appUrl}/admin`. Labels escaped.
 *     Product name only in the footer. No amounts, names, `@`, `/admin/config`,
 *     "Tax tables" link text, or instruction to install/update/enter/add.
 */

import { describe, expect, it } from "vitest";
import * as notifications from "@payroll/notifications";
import {
  EVENT_AUDIENCE,
  WORKFLOW_EVENTS,
  workflowEventsFor,
  type RenderedEmail,
  type TemplateContext,
} from "@payroll/notifications";

const CTX: TemplateContext = {
  companyName: "Synthetic Bakery LLC",
  brandName: "Wagon Payroll",
  appUrl: "http://localhost",
};

interface Input {
  year: number;
  federal: boolean;
  stateLabels: string[];
  when: "upcoming" | "current";
}

function render(input: Input, ctx: TemplateContext = CTX): RenderedEmail {
  const fn = (notifications as unknown as Record<string, unknown>).taxTablesMissing;
  if (typeof fn !== "function") {
    throw new Error("@payroll/notifications does not export taxTablesMissing (PAY-103 R18)");
  }
  return (fn as (c: TemplateContext, i: Input) => RenderedEmail)(ctx, input);
}

/** Footer sentence as the shared footer() writes it. */
const FOOTER_RE = /Sent by [^\n<]* on behalf of [^\n<]*directly\./;

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#39;", "'")
    .replaceAll("&rsquo;", "'")
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ");
}

/** Body text without the footer (the footer legitimately says "Contact"). */
function bodyText(r: RenderedEmail): string {
  return r.text.replace(FOOTER_RE, "");
}

function hrefs(html: string): string[] {
  return [...html.matchAll(/href\s*=\s*"([^"]*)"/g)].map((m) => m[1]!);
}

const CASES: Record<string, Input> = {
  upcomingFederal: { year: 2027, federal: true, stateLabels: ["Illinois"], when: "upcoming" },
  upcomingStates: { year: 2027, federal: false, stateLabels: ["Illinois"], when: "upcoming" },
  currentFederal: { year: 2027, federal: true, stateLabels: ["Illinois"], when: "current" },
  currentStates: { year: 2027, federal: false, stateLabels: ["New York"], when: "current" },
  currentFederalOnly: { year: 2027, federal: true, stateLabels: [], when: "current" },
};

describe("T0 catalog", () => {
  it("T0a tax_tables_missing is a toggleable admin workflow event", () => {
    const ev = (notifications.EVENT_TYPE as Record<string, string>).taxTablesMissing;
    expect(ev).toBe("tax_tables_missing");
    expect(WORKFLOW_EVENTS as readonly string[]).toContain("tax_tables_missing");
    expect((EVENT_AUDIENCE as Record<string, string>).tax_tables_missing).toBe("admin");
  });

  it("T0b visible to admins only", () => {
    expect(workflowEventsFor({ isAdmin: true }) as readonly string[]).toContain(
      "tax_tables_missing",
    );
    for (const employmentType of [null, "w2", "1099"]) {
      expect(
        workflowEventsFor({ isAdmin: false, employmentType }) as readonly string[],
      ).not.toContain("tax_tables_missing");
    }
  });
});

describe("T1 subjects (pinned to the final copy)", () => {
  it("T1a upcoming, federal missing", () => {
    expect(render(CASES.upcomingFederal!).subject).toBe(
      "Synthetic Bakery LLC — 2027 tax tables aren't installed yet",
    );
  });
  it("T1b upcoming, states only (same subject)", () => {
    expect(render(CASES.upcomingStates!).subject).toBe(
      "Synthetic Bakery LLC — 2027 tax tables aren't installed yet",
    );
  });
  it("T1c current, federal missing", () => {
    expect(render(CASES.currentFederal!).subject).toBe(
      "Synthetic Bakery LLC — 2027 payroll is on hold: tax tables not installed",
    );
    expect(render(CASES.currentFederalOnly!).subject).toBe(
      "Synthetic Bakery LLC — 2027 payroll is on hold: tax tables not installed",
    );
  });
  it("T1d current, states only: names the states", () => {
    expect(render(CASES.currentStates!).subject).toBe(
      "Synthetic Bakery LLC — 2027 payroll is on hold for employees in New York",
    );
    expect(
      render({ year: 2027, federal: false, stateLabels: ["Illinois", "New York"], when: "current" })
        .subject,
    ).toBe("Synthetic Bakery LLC — 2027 payroll is on hold for employees in Illinois and New York");
  });
  it("T1e subject starts with the company name", () => {
    for (const c of Object.values(CASES))
      expect(render(c).subject.startsWith(`${CTX.companyName} — `)).toBe(true);
  });
});

describe("T2 jurisdiction list wording", () => {
  it("T2a federal first, lowercase, mid-sentence; joinLabels rule", () => {
    const one = render({ year: 2027, federal: true, stateLabels: [], when: "current" });
    expect(one.text).toContain("The 2027 federal tax tables");
    const two = render(CASES.upcomingFederal!);
    expect(two.text).toContain("The 2027 federal and Illinois tax tables");
    expect(stripTags(two.html)).toContain("2027 federal and Illinois tax tables");
    const three = render({
      year: 2027,
      federal: true,
      stateLabels: ["Illinois", "New York"],
      when: "upcoming",
    });
    expect(three.text).toContain("The 2027 federal, Illinois and New York tax tables");
    expect(three.text).not.toMatch(/Federal/);
  });

  it("T2b states only: 'The 2027 New York tax tables', no 'federal'", () => {
    const r = render(CASES.currentStates!);
    expect(r.text).toContain("The 2027 New York tax tables");
    expect(bodyText(r)).not.toMatch(/federal/i);
  });

  it("T2d federal still missing + one newly reported state (round 3): 'federal and New York', federal wording", () => {
    const r = render({ year: 2027, federal: true, stateLabels: ["New York"], when: "current" });
    expect(r.subject).toBe(
      "Synthetic Bakery LLC — 2027 payroll is on hold: tax tables not installed",
    );
    expect(r.text).toContain("The 2027 federal and New York tax tables");
    expect(stripTags(r.html)).toContain("2027 federal and New York tax tables");
    expect(bodyText(r)).toContain("no new payroll drafts will appear for you to review");
    expect(bodyText(r)).not.toContain("Everyone else's payroll goes ahead");
  });

  it("T2c labels keep the caller's order (caller sorts by name)", () => {
    const r = render({
      year: 2027,
      federal: false,
      stateLabels: ["Idaho", "Iowa"],
      when: "upcoming",
    });
    expect(r.text).toContain("The 2027 Idaho and Iowa tax tables");
  });
});

describe("T3 consequence wording by case (keywords)", () => {
  it("T3a upcoming, federal: no 2027 payroll; prior year unchanged", () => {
    const t = bodyText(render(CASES.upcomingFederal!));
    expect(t).toContain("aren't installed yet");
    expect(t).toContain(
      "Payroll with a pay date in 2027 can't be prepared until they're installed",
    );
    expect(t).toContain("Nothing changes for your 2026 payrolls");
    expect(t).not.toContain("employees who work in");
  });

  it("T3b upcoming, states only: only employees in those states; others unaffected", () => {
    const t = bodyText(render(CASES.upcomingStates!));
    expect(t).toContain("can't be prepared for employees who work in Illinois");
    expect(t).toContain("Everyone else's payroll isn't affected");
    expect(t).toContain("2026 payrolls");
  });

  it("T3c current, federal: no new drafts at all", () => {
    const t = bodyText(render(CASES.currentFederal!));
    expect(t).toContain("payroll with a pay date in 2027 can't be prepared");
    expect(t).toContain("no new payroll drafts will appear for you to review");
    expect(t).toContain("Payrolls you've already issued aren't affected");
    expect(t).not.toContain("Everyone else");
  });

  it("T3d current, states only: never says all payroll is on hold", () => {
    const r = render(CASES.currentStates!);
    const t = bodyText(r);
    expect(t).toContain("can't be prepared for employees who work in New York");
    expect(t).toContain("Everyone else's payroll goes ahead as usual");
    expect(t).not.toContain("no new payroll drafts will appear for you to review");
    expect(t).not.toMatch(/payroll with a pay date in 2027 can't be prepared[,.]/);
    expect(r.subject).not.toContain("tax tables not installed");
  });

  it("T3e upcoming and current render different wording", () => {
    const up = render(CASES.upcomingFederal!);
    const cur = render(CASES.currentFederal!);
    expect(up.html).not.toBe(cur.html);
    expect(up.text).not.toBe(cur.text);
    expect(up.subject).not.toBe(cur.subject);
  });

  it("T3f every variant states the dashboard notice", () => {
    for (const c of Object.values(CASES)) {
      expect(bodyText(render(c))).toContain("you'll see a notice about this on your dashboard");
    }
  });
});

describe("T4 links, escaping, fallback", () => {
  it("T4a the only link is appUrl/admin; text ends with it", () => {
    for (const c of Object.values(CASES)) {
      const r = render(c);
      expect(hrefs(r.html)).toEqual(["http://localhost/admin"]);
      expect(r.text).toContain("on your dashboard: http://localhost/admin");
    }
  });

  it("T4b state labels are HTML-escaped", () => {
    const r = render({
      year: 2027,
      federal: false,
      stateLabels: ['<script>alert("x")</script>'],
      when: "current",
    });
    expect(r.html).not.toContain("<script>");
    expect(r.html).toContain("&lt;script&gt;");
  });

  it("T4c the company name is escaped in the HTML", () => {
    const r = render(CASES.currentFederal!, { ...CTX, companyName: "A&B <Co>" });
    expect(r.html).toContain("A&amp;B &lt;Co&gt;");
    expect(r.html).not.toContain("<Co>");
  });

  it("T4d plain-text fallback carries the facts and has no tags", () => {
    for (const c of Object.values(CASES)) {
      const r = render(c);
      expect(r.text.length).toBeGreaterThan(80);
      expect(r.text).toContain("2027");
      expect(r.text).not.toMatch(/<[a-z/][^>]*>/i);
    }
  });
});

describe("T5 content rules", () => {
  it("T5a product name appears only in the footer (once in html, once in text, never in subject)", () => {
    for (const c of Object.values(CASES)) {
      const r = render(c);
      expect(r.subject).not.toContain("Wagon Payroll");
      expect(r.html.split("Wagon Payroll").length - 1).toBe(1);
      expect(r.text.split("Wagon Payroll").length - 1).toBe(1);
      expect(bodyText(r)).not.toContain("Wagon Payroll");
    }
  });

  it("T5b no amounts, @, SSN/bank words, /admin/config, or 'Tax tables' link text", () => {
    for (const c of Object.values(CASES)) {
      const r = render(c);
      for (const s of [r.subject, r.html, r.text]) {
        expect(s).not.toMatch(/\d+\.\d{2}/);
        expect(s).not.toContain("$");
        expect(s).not.toContain("@");
        expect(s).not.toContain("/admin/config");
        expect(s).not.toMatch(/routing|account number|\bssn\b|social security number/i);
      }
      for (const m of r.html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) {
        expect(m[1]).not.toMatch(/tax tables/i);
      }
    }
  });

  it("T5c fact + consequence only: no install/update/enter/add/contact-support instruction", () => {
    for (const c of Object.values(CASES)) {
      const t = bodyText(render(c));
      expect(t).not.toMatch(/\binstall\b/i);
      expect(t).not.toMatch(/\b(update|upgrade|enter|add|contact support|contact us)\b/i);
      expect(t).not.toMatch(/manual|by hand|Config/);
    }
  });
});
