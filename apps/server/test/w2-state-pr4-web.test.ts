/**
 * Spec 24 (PAY-116) PR-4 — web display logic and copy, tested from the
 * server suite (the web app has no test runner), the same way
 * w2-state-round2-web-copy.test.ts reads apps/web/src/lib/w2-issues.ts
 * (payroll-calc-auditor, fail-first; the coder may not edit this file).
 *
 * Tests: C-a2, C-b6, C-c1, C-d2, C-d3, C-e1, C-f3, C-g1, C-g2, C-w3, C-i4.
 *
 * Exact strings pinned: E1, E2 (Spec 24 §9 verbatim); C1–C6 and the W6
 * label (state-local-payroll-sme rulings 2026-10-04, final, supersede §9
 * C1–C3 and add C6); the rewritten download step (D-PL4, final wording of
 * the UX copy file 2026-10-04). New UX copy (help text, warnings, issue
 * copy) is checked by structure and keywords only.
 *
 * Contract assumed — apps/web/src/lib/w2-filing.ts (new, pure, no Vue):
 *  - w3WorksheetLines(w: WorksheetW3): { line: string; label: string;
 *    value: string }[] — money via the same formatting as useMoney().money
 *    ("$1,234.56"). Years < 2026 (no box15State key): exactly today's rows.
 *    From 2026: a row labelled "Total number of Forms W-2" with
 *    String(w2FormCount ?? employeeCount), and rows with line "15", "16",
 *    "17" (state; state wages; state income tax).
 *  - box15MissingIdState(rows: { stateLines }[]): string | null
 *  - affectedEmployees(furnished: { stateCode; taxYear; employees }[],
 *    rows: { stateCode; fromTaxYear }[], target: { stateCode; fromTaxYear }):
 *    number
 *  - multiW2Text(formCount: number, legalName: string): string | null
 *    (admin, per row)
 *  - myMultiW2Text(formCount: number | null, year: number): string | null
 *  - twoUpHelpText(year: number, audience: "admin" | "employee"):
 *    string | null
 *  - bsoMultiFormText(rows: { legalName; formCount; stateLines }[]):
 *    { e1: string; e2: string[] } | null
 *  - stateFilingChecklist(rows: { stateLines }[]): string[]
 *  - markFiledLeadText(formType: string, formLabel: string, period: string):
 *    string — the "Mark as filed" dialog lead sentence.
 * apps/web/src/lib/w2-issues.ts: w2BlockedText(year, notified: boolean).
 * @payroll/shared: W2_TWO_UP_FROM_YEAR (number).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as documents from "@payroll/documents";
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

function src(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

/** Source text with tags removed and whitespace collapsed (template text as rendered). */
function flat(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const line = (
  state: string,
  form: number,
  row: 1 | 2,
  stateIdSource: string | null = "entered",
) => ({
  state,
  box16: "100.00",
  box17: "1.00",
  form,
  row,
  stateIdSource,
});

// ---------------------------------------------------------------------- C-a2

describe("C-a2 the labels the copy points to exist in the web app (guard)", () => {
  it('App.vue nav "Config"; AdminConfigView Company tab + "Company profile"; StateTaxAccountNumbers "State tax account numbers"', () => {
    expect({
      nav: src("apps/web/src/App.vue").includes('label: "Config"'),
      tab: src("apps/web/src/views/admin/AdminConfigView.vue").includes(
        '<Tab value="company">Company</Tab>',
      ),
      profile: src("apps/web/src/views/admin/AdminConfigView.vue").includes(
        "<h3>Company profile</h3>",
      ),
      stateIds: src("apps/web/src/components/StateTaxAccountNumbers.vue").includes(
        "<h3>State tax account numbers</h3>",
      ),
      taxId: src("apps/web/src/views/admin/AdminEmployeeDetailView.vue").includes(
        "<dt>Tax ID</dt>",
      ),
    }).toEqual({ nav: true, tab: true, profile: true, stateIds: true, taxId: true });
  });
});

// ---------------------------------------------------------------------- C-b6

function unionMembers(path: string): string[] {
  const text = src(path).replace(/\/\/[^\n]*/g, "");
  const m = /export type W2IssueCode =([\s\S]*?);/.exec(text);
  if (!m) throw new Error(`no W2IssueCode union in ${path}`);
  return [...(m[1] ?? "").matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1] as string).sort();
}

describe("C-b6 ssn_unreadable / address_unreadable in both W2IssueCode unions, with copy", () => {
  it("server and web unions both carry the two codes and stay equal", () => {
    const server = unionMembers("apps/server/src/filings/w2-boxes.ts");
    const web = unionMembers("apps/web/src/lib/api.ts");
    expect({
      server: ["ssn_unreadable", "address_unreadable"].filter((c) => !server.includes(c)),
      equal: web,
    }).toEqual({ server: [], equal: server });
  });

  it("labels and texts: non-empty, no amount; SSN text points to Employees and Tax ID; address text says contact support", async () => {
    const mod = (await import(resolve(ROOT, "apps/web/src/lib/w2-issues.ts"))) as Record<
      string,
      Any
    >;
    const out: Record<string, unknown> = {};
    for (const code of ["ssn_unreadable", "address_unreadable"]) {
      const issue = { code, severity: "block" };
      const label = mod.w2IssueLabel(issue);
      const text = mod.w2IssueText(issue, { legalName: "Ana Synthetic", year: 2026 });
      out[code] = {
        label: typeof label === "string" && label.length > 0,
        text: typeof text === "string" && text.includes("Ana Synthetic"),
        noAmount: !/\$|\d/.test(
          `${label ?? ""} ${text ?? ""}`
            .replace(/\bW-[23]\b/g, "")
            .replace(/\b2026\b/g, "")
            .replace(/\bbox(?:es)? \d+(?:[–-]\d+)?\b/g, ""),
        ),
      };
    }
    const ssn = String(
      mod.w2IssueText(
        { code: "ssn_unreadable", severity: "block" },
        { legalName: "A", year: 2026 },
      ),
    );
    const addr = String(
      mod.w2IssueText(
        { code: "address_unreadable", severity: "block" },
        { legalName: "A", year: 2026 },
      ),
    );
    out.ssnPointer = /\bEmployees\b/.test(ssn) && /\bTax ID\b/.test(ssn);
    out.addrSupport = /support/i.test(addr);
    const ok = { label: true, text: true, noAmount: true };
    expect(out).toEqual({
      ssn_unreadable: ok,
      address_unreadable: ok,
      ssnPointer: true,
      addrSupport: true,
    });
  });
});

// ---------------------------------------------------------------------- C-c1

const DOWNLOAD_STEP =
  "Download the W-2 PDFs and the W-3 records copy on this page. An employee can have more than one W-2.";

describe("C-c1 the W-3 reads as a records copy (carry-over c, D-PL1, D-PL4)", () => {
  const view = () => src("apps/web/src/views/admin/AdminFilingDetailView.vue");
  // The lib may not exist yet; a missing file is empty text here (the
  // contract tests below fail on the missing module themselves).
  const libSrc = () =>
    existsSync(resolve(ROOT, "apps/web/src/lib/w2-filing.ts"))
      ? src("apps/web/src/lib/w2-filing.ts")
      : "";

  it('the view says neither "W-3 transmittal PDF" nor "Download W-3 PDF"', () => {
    const v = flat(view());
    expect({
      transmittalPdf: v.includes("W-3 transmittal PDF"),
      downloadPdf: v.includes("Download W-3 PDF"),
    }).toEqual({ transmittalPdf: false, downloadPdf: false });
  });

  it("the rewritten download step (D-PL4) is in the view or the lib, verbatim", () => {
    const text = `${flat(view())}\n${libSrc()}`;
    expect(text.includes(DOWNLOAD_STEP)).toBe(true);
  });

  it("a records-copy note: within one short passage, the W-3 is for your records, not to mail, BSO makes the filed W-3, no Copy A", () => {
    const text = flat(`${view()}\n${libSrc()}`);
    const notes = [...text.matchAll(/W-3 is for your records/g)].map((m) =>
      text.slice(m.index ?? 0, (m.index ?? 0) + 600),
    );
    const hit = notes.some(
      (n) => /Don.t mail/.test(n) && /Business Services Online/.test(n) && /Copy A/.test(n),
    );
    expect(hit).toBe(true);
  });

  it('mark-filed lead for w2_w3 names Business Services Online and not "mail"; other forms unchanged', async () => {
    const fn = need(await lib(), "markFiledLeadText");
    const w2 = String(fn("w2_w3", "Forms W-2/W-3", "2026"));
    expect({
      bso: w2.includes("Business Services Online"),
      mail: /mail/i.test(w2),
      f941: fn("941", "Form 941", "Q1 2026"),
    }).toEqual({
      bso: true,
      mail: false,
      f941: "File Form 941 for Q1 2026 first — by mail or e-file — then record it here.",
    });
  });
});

// ---------------------------------------------------------------------- C-d2

describe("C-d2 W2_TWO_UP_FROM_YEAR (@payroll/shared) matches the documents' first two-up year (S24-D4)", () => {
  it("equals the first bundled year whose fw2 field map fills the upper W-2 (<Copy>_Top) — 2026", () => {
    const firstTwoUp = [2025, 2026]
      .filter((y) => {
        documents.w2LayoutFor(y); // throws for a year without a layout
        const m = documents.w2FieldMapFor(y, "CopyB") as unknown as Record<string, unknown>;
        return JSON.stringify(m).includes("CopyB_Top[0]");
      })
      .at(0);
    expect({
      constant: (shared as Record<string, unknown>).W2_TWO_UP_FROM_YEAR,
      firstTwoUp,
    }).toEqual({ constant: 2026, firstTwoUp: 2026 });
  });
});

// ---------------------------------------------------------------------- C-d3

describe("C-d3 multi-W-2 and two-up help text", () => {
  it("multiW2Text: text only for formCount > 1; names the employee and more than two states", async () => {
    const fn = need(await lib(), "multiW2Text");
    const two = fn(2, "Dee Synthetic");
    expect({
      one: fn(1, "Dee Synthetic"),
      two: typeof two === "string" && two.includes("Dee Synthetic") && /two states/i.test(two),
      three: typeof fn(3, "Dee Synthetic") === "string",
    }).toEqual({ one: null, two: true, three: true });
  });

  it("myMultiW2Text: text only for formCount > 1 (null and 1 -> null); names the count and the year", async () => {
    const fn = need(await lib(), "myMultiW2Text");
    const two = fn(2, 2026);
    expect({
      none: fn(null, 2026),
      one: fn(1, 2026),
      two: typeof two === "string" && two.includes("2026") && /\b2\b/.test(two) && /W-2s/.test(two),
    }).toEqual({ none: null, one: null, two: true });
  });

  it("twoUpHelpText: admin and employee text only for years >= 2026; the bottom form is blank on purpose", async () => {
    const fn = need(await lib(), "twoUpHelpText");
    const out: Record<string, unknown> = {};
    for (const who of ["admin", "employee"]) {
      const t26 = fn(2026, who);
      out[who] = {
        y2025: fn(2025, who),
        y2026: typeof t26 === "string" && /blank/i.test(t26),
        y2027: typeof fn(2027, who) === "string",
      };
    }
    const want = { y2025: null, y2026: true, y2027: true };
    expect(out).toEqual({ admin: want, employee: want });
  });
});

// ---------------------------------------------------------------------- C-e1

describe("C-e1 box15MissingIdState (W-3 box 15, one state without an ID)", () => {
  it("NC only with one null source -> NC; two states -> null; all NC with IDs -> null; no lines -> null", async () => {
    const fn = need(await lib(), "box15MissingIdState");
    expect({
      ncMissing: fn([{ stateLines: [line("NC", 1, 1)] }, { stateLines: [line("NC", 1, 1, null)] }]),
      twoStates: fn([{ stateLines: [line("NC", 1, 1, null)] }, { stateLines: [line("CA", 1, 1)] }]),
      allIds: fn([{ stateLines: [line("NC", 1, 1)] }, { stateLines: [line("NC", 1, 1)] }]),
      none: fn([{ stateLines: [] }]),
      empty: fn([]),
    }).toEqual({ ncMissing: "NC", twoStates: null, allIds: null, none: null, empty: null });
  });
});

// ---------------------------------------------------------------------- C-f3

describe("C-f3 affectedEmployees respects the next row's fromTaxYear (W27 shape)", () => {
  it("rows CA 2026 + CA 2028; furnished 2026 (2), 2027 (3), 2028 (5), NC 2026 (7): 2026 -> 5, 2028 -> 5, new 2027 -> 3, NC -> 7, TX -> 0", async () => {
    const fn = need(await lib(), "affectedEmployees");
    const furnished = [
      { stateCode: "CA", taxYear: 2026, employees: 2 },
      { stateCode: "CA", taxYear: 2027, employees: 3 },
      { stateCode: "CA", taxYear: 2028, employees: 5 },
      { stateCode: "NC", taxYear: 2026, employees: 7 },
    ];
    const rows = [
      { stateCode: "CA", fromTaxYear: 2026 },
      { stateCode: "CA", fromTaxYear: 2028 },
      { stateCode: "NC", fromTaxYear: 2026 },
    ];
    expect({
      ca2026: fn(furnished, rows, { stateCode: "CA", fromTaxYear: 2026 }),
      ca2028: fn(furnished, rows, { stateCode: "CA", fromTaxYear: 2028 }),
      ca2027new: fn(furnished, rows, { stateCode: "CA", fromTaxYear: 2027 }),
      nc: fn(furnished, rows, { stateCode: "NC", fromTaxYear: 2026 }),
      tx: fn(furnished, rows, { stateCode: "TX", fromTaxYear: 2026 }),
      none: fn([], rows, { stateCode: "CA", fromTaxYear: 2026 }),
    }).toEqual({ ca2026: 5, ca2028: 5, ca2027new: 3, nc: 7, tx: 0, none: 0 });
  });
});

// ---------------------------------------------------------------------- C-g1

/** W24: Ana (CA, 1 form), Ben (CA + NY, 1 form), Dee (IL, MD / NC, 2 forms). */
const W24_ROWS = [
  { legalName: "Ana TwentyFour", formCount: 1, stateLines: [line("CA", 1, 1)] },
  { legalName: "Ben TwentyFour", formCount: 1, stateLines: [line("CA", 1, 1), line("NY", 1, 2)] },
  {
    legalName: "Dee TwentyFour",
    formCount: 2,
    stateLines: [line("IL", 1, 1, "ein_default"), line("MD", 1, 2), line("NC", 2, 1)],
  },
];

const E1_4 =
  "Some employees get more than one W-2 this year because they worked in more than two states. When you enter W-2s in Business Services Online, enter each extra W-2 as its own W-2: same employee and employer details (boxes a–f), boxes 1–14 left blank, and the next state lines. Then the W-3 that Business Services Online makes will show 4 W-2s, the same as ours.";

describe("C-g1 BSO copy E1/E2 (S24-D12, §9 verbatim)", () => {
  it('W24 rows: E1 exact with "4 W-2s" (Σ formCount); E2 = ["Dee TwentyFour: 2 W-2s. W-2 #2: NC"]', async () => {
    const fn = need(await lib(), "bsoMultiFormText");
    expect(fn(W24_ROWS)).toEqual({ e1: E1_4, e2: ["Dee TwentyFour: 2 W-2s. W-2 #2: NC"] });
  });

  it("no row with formCount > 1: null (no E1, no E2)", async () => {
    const fn = need(await lib(), "bsoMultiFormText");
    expect(fn(W24_ROWS.slice(0, 2))).toBeNull();
  });
});

// ---------------------------------------------------------------------- C-g2

const NEXT_DAY =
  "by January 31, or the next business day if January 31 falls on a weekend or holiday";
const C = {
  CA: "California: no W-2s to send. Your wages go on the DE 9C each quarter.",
  IL: `Illinois: send your W-2s to the Illinois Department of Revenue electronically ${NEXT_DAY}.`,
  MD: `Maryland: file Form MW508 with your W-2s ${NEXT_DAY}. If you have 25 or more W-2s, file electronically.`,
  NC: `North Carolina: file Form NC-3 with your W-2s electronically (eNC3) ${NEXT_DAY}.`,
  NY: "New York: no W-2s to send. Your wages go on the NYS-45 each quarter.",
};
/** C6 (state SME ruling P3): any other state with a W-2 state line; {State} = full name. */
const c6 = (name: string) =>
  `${name}: check with ${name}'s tax department whether you need to send them your W-2s or a yearly withholding report, and when it's due. This app doesn't list ${name}'s steps yet.`;

describe("C-g2 filing checklist C1–C6 (S24-D9; state SME final strings 2026-10-04)", () => {
  it("state lines {CA, IL, MD, NC, NY, OR, PA} across rows (with repeats), TX without a line: seven lines in code-point order; TX none", async () => {
    const fn = need(await lib(), "stateFilingChecklist");
    const rows = [
      { stateLines: [line("PA", 1, 1), line("NY", 1, 2)] },
      { stateLines: [line("NC", 1, 1), line("MD", 1, 2), line("IL", 2, 1)] },
      { stateLines: [line("CA", 1, 1), line("NY", 1, 2)] },
      { stateLines: [line("OR", 1, 1)] },
      // A TX employee: kind none, so the W-2 has no state line at all.
      { stateLines: [] },
    ];
    expect(fn(rows)).toEqual([C.CA, C.IL, C.MD, C.NC, C.NY, c6("Oregon"), c6("Pennsylvania")]);
  });

  it("no state lines anywhere -> []; one other state -> its C6 line only", async () => {
    const fn = need(await lib(), "stateFilingChecklist");
    expect({
      none: fn([{ stateLines: [] }]),
      empty: fn([]),
      wa: fn([{ stateLines: [line("WA", 1, 1)] }, { stateLines: [line("WA", 1, 1)] }]),
    }).toEqual({ none: [], empty: [], wa: [c6("Washington")] });
  });
});

// ---------------------------------------------------------------------- W6

describe("W6 local_tax_md (state SME final ruling 2026-10-04)", () => {
  it('label exactly "Maryland local tax"; text covers county and nonresident tax, names the employee and year, no amount', async () => {
    const mod = (await import(resolve(ROOT, "apps/web/src/lib/w2-issues.ts"))) as Record<
      string,
      Any
    >;
    const issue = { code: "local_tax_md", severity: "warn", state: "MD" };
    const text = String(mod.w2IssueText(issue, { legalName: "Dee Synthetic", year: 2026 }));
    expect({
      label: mod.w2IssueLabel(issue),
      county: /county tax/.test(text),
      nonresident: /nonresident/.test(text),
      employee: text.includes("Dee Synthetic"),
      year: text.includes("2026"),
      noAmount: !/\$/.test(text),
    }).toEqual({
      label: "Maryland local tax",
      county: true,
      nonresident: true,
      employee: true,
      year: true,
      noAmount: true,
    });
  });
});

// ---------------------------------------------------------------------- C-w3

const W3_2025 = {
  form: "w2_w3",
  year: 2025,
  employeeCount: 2,
  box1Wages: "120000.00",
  box2FederalWithheld: "12000.00",
  box3SsWages: "120000.00",
  box4SsTax: "7440.00",
  box5MedicareWages: "120000.00",
  box6MedicareTax: "1740.00",
};

describe("C-w3 w3WorksheetLines", () => {
  it("2026 W23 worksheet: box c 2 (Total number of Forms W-2), 15 X (more than one state), 16 $150,000.00, 17 $342.12", async () => {
    const fn = need(await lib(), "w3WorksheetLines");
    const lines = fn({
      ...W3_2025,
      year: 2026,
      w2FormCount: 2,
      box15State: "X",
      box16StateWages: "150000.00",
      box17StateTax: "342.12",
      states: [],
      blockedEmployees: 0,
    }) as { line: string; label: string; value: string }[];
    const byLine = (l: string) => lines.find((x) => x.line === l)?.value;
    expect({
      c: lines.find((x) => x.label === "Total number of Forms W-2")?.value,
      b15: byLine("15"),
      b16: byLine("16"),
      b17: byLine("17"),
      b1: byLine("1"),
      noIncluded: lines.some((x) => x.label === "W-2 forms included"),
    }).toEqual({
      c: "2",
      b15: "X (more than one state)",
      b16: "$150,000.00",
      b17: "$342.12",
      b1: "$120,000.00",
      noIncluded: false,
    });
  });

  it("2026: box c falls back to employeeCount without w2FormCount; box 15 one state -> code; null -> —", async () => {
    const fn = need(await lib(), "w3WorksheetLines");
    const one = fn({
      ...W3_2025,
      year: 2026,
      box15State: "IL",
      box16StateWages: "1.00",
      box17StateTax: "0.01",
    });
    const none = fn({
      ...W3_2025,
      year: 2026,
      w2FormCount: 3,
      box15State: null,
      box16StateWages: "0.00",
      box17StateTax: "0.00",
    });
    const val = (ls: { line: string; label: string; value: string }[], l: string) =>
      ls.find((x) => x.line === l)?.value;
    const c = (ls: { line: string; label: string; value: string }[]) =>
      ls.find((x) => x.label === "Total number of Forms W-2")?.value;
    expect({ c1: c(one), s1: val(one, "15"), c2: c(none), s2: val(none, "15") }).toEqual({
      c1: "2",
      s1: "IL",
      c2: "3",
      s2: "—",
    });
  });

  it("2025 worksheet: exactly the rows the view shows on fd56964 (no box 15–17, 'W-2 forms included')", async () => {
    const fn = need(await lib(), "w3WorksheetLines");
    expect(fn(W3_2025)).toEqual([
      { line: "—", label: "W-2 forms included", value: "2" },
      { line: "1", label: "Wages, tips, other compensation", value: "$120,000.00" },
      { line: "2", label: "Federal income tax withheld", value: "$12,000.00" },
      { line: "3", label: "Social Security wages", value: "$120,000.00" },
      { line: "4", label: "Social Security tax withheld", value: "$7,440.00" },
      { line: "5", label: "Medicare wages and tips", value: "$120,000.00" },
      { line: "6", label: "Medicare tax withheld", value: "$1,740.00" },
    ]);
  });
});

// ---------------------------------------------------------------------- C-i4

describe("C-i4 w2BlockedText(year, notified): the email clause only while the year is not notified", () => {
  it("not notified: says employees will be emailed later; notified: says they already got the email, never that they won't", async () => {
    const mod = (await import(resolve(ROOT, "apps/web/src/lib/w2-issues.ts"))) as Record<
      string,
      Any
    >;
    const before = String(mod.w2BlockedText(2026, false));
    const after = String(mod.w2BlockedText(2026, true));
    expect({
      beforeEmail: /email/i.test(before) && !/already/i.test(before),
      afterAlready: /already/i.test(after) && /email/i.test(after),
      noWontGet: !/won't get/i.test(before) && !/won't get/i.test(after),
      differ: before !== after,
      years: before.includes("2026") && after.includes("2026"),
    }).toEqual({
      beforeEmail: true,
      afterAlready: true,
      noWontGet: true,
      differ: true,
      years: true,
    });
  });
});
