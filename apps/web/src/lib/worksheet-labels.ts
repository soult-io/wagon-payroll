/**
 * PAY-251: one label map per filing worksheet (Form 941, Form 940, W-3),
 * shared by the worksheet tables on the filing page and the "Recompute
 * worksheet" dialog. Each flattened worksheet key maps to its form line and
 * plain label, or to null when it is not a line on the form (hidden). Pure —
 * no Vue, no I/O — so the server suite can test it.
 */

import { useDates } from "../composables/useDates";
import { useMoney } from "../composables/useMoney";
import type { FilingWorksheet, WorksheetW3State } from "./api";

const { money, percent } = useMoney();
const { date } = useDates();

export type FieldKind = "money" | "count" | "yesNo" | "percent" | "quarter" | "date" | "text";

/** A worksheet field as shown: form line (null = no line on the form), label, value kind. */
export interface FieldLabel {
  line: string | null;
  label: string;
  kind: FieldKind;
}

const money_ = (line: string | null, label: string): FieldLabel => ({ line, label, kind: "money" });

/** Form 941, keyed by flattened worksheet key. Declaration order = row order. */
export const WORKSHEET_941_FIELDS = {
  form: null,
  year: null,
  quarter: null,
  line1Employees: {
    line: "1",
    label: "Employees paid (pay period incl. the 12th of month 1)",
    kind: "count",
  },
  line2Wages: money_("2", "Wages, tips, and other compensation"),
  line3FederalWithheld: money_("3", "Federal income tax withheld"),
  line5aTaxableSsWages: money_("5a", "Taxable Social Security wages"),
  line5aTax: money_("5a", "Social Security tax"),
  line5cTaxableMedicareWages: money_("5c", "Taxable Medicare wages"),
  line5cTax: money_("5c", "Medicare tax"),
  line5dAdditionalMedicare: money_("5d", "Additional Medicare withholding"),
  line5eTotal: money_("5e", "Total Social Security and Medicare taxes"),
  line6TotalTaxes: money_("6", "Total taxes (line 3 + line 5e)"),
  line7FractionsOfCents: money_("7", "Fractions of cents"),
  // The default line 7 before an admin override — not a line on the form.
  line7Computed: null,
  line10TotalAfterAdjustments: money_("10", "Total taxes after adjustments"),
  line11ResearchCredit: money_("11", "Qualified small business R&D credit"),
  line12TotalAfterCredits: money_("12", "Total taxes after credits"),
  line13Deposits: money_("13", "Total deposits + adjustment payments"),
  line14BalanceDue: money_("14", "Balance due"),
  line15Overpayment: money_("15", "Overpayment"),
  "line16.month1": money_("16", "Month 1 liability"),
  "line16.month2": money_("16", "Month 2 liability"),
  "line16.month3": money_("16", "Month 3 liability"),
  "line16.deMinimis": {
    line: "16",
    label: "Line 12 is under $2,500 (no monthly breakdown)",
    kind: "yesNo",
  },
} as const satisfies Record<string, FieldLabel | null>;

/** Form 940 (FUTA). */
export const WORKSHEET_940_FIELDS = {
  form: null,
  year: null,
  sutaCreditRate: { line: null, label: "SUTA credit rate", kind: "percent" },
  futaRate: { line: null, label: "Net FUTA rate", kind: "percent" },
  line3TotalPayments: money_("3", "Total payments to all employees"),
  line7FutaTaxableWages: money_("7", "Total taxable FUTA wages (first $7,000 per employee)"),
  line8FutaTax: money_("8", "FUTA tax before adjustments"),
  line12TotalFutaTax: money_("12", "Total FUTA tax after adjustments"),
  futaTaxPerFrozenEntries: money_(
    null,
    "FUTA withheld in frozen payroll entries (accrued-liability truth)",
  ),
  roundingDelta: money_(null, "Rounding delta (frozen entries − line 12)"),
  depositThresholdCrossedQuarter: {
    line: null,
    label: "Quarter FUTA liability crossed $500",
    kind: "quarter",
  },
  depositDueBy: { line: null, label: "Deposit due by", kind: "date" },
  balanceDue: money_("14", "Balance due"),
} as const satisfies Record<string, FieldLabel | null>;

/** W-3 transmittal (the per-state rows are in WORKSHEET_W3_STATE_FIELDS). */
export const WORKSHEET_W3_FIELDS = {
  form: null,
  year: null,
  employeeCount: { line: null, label: "W-2 forms included", kind: "count" },
  w2FormCount: { line: "c", label: "Total number of Forms W-2", kind: "count" },
  box1Wages: money_("1", "Wages, tips, other compensation"),
  box2FederalWithheld: money_("2", "Federal income tax withheld"),
  box3SsWages: money_("3", "Social Security wages"),
  box4SsTax: money_("4", "Social Security tax withheld"),
  box5MedicareWages: money_("5", "Medicare wages and tips"),
  box6MedicareTax: money_("6", "Medicare tax withheld"),
  box15State: { line: "15", label: "State", kind: "text" },
  box16StateWages: money_("16", "State wages, tips, etc."),
  box17StateTax: money_("17", "State income tax"),
  blockedEmployees: { line: null, label: "Employees with W-2s on hold", kind: "count" },
} as const satisfies Record<string, FieldLabel | null>;

/** One state's W-3 reconciliation row; `state` is the row key, not a field. */
export const WORKSHEET_W3_STATE_FIELDS = {
  w2Lines: { line: null, label: "W-2 state lines", kind: "count" },
  box16: money_(null, "W-2 box 16 total"),
  box17: money_(null, "W-2 box 17 total"),
  runWithholding: money_(null, "State tax withheld in pay runs"),
  attributedLegacy: money_(null, "Older withholding attributed"),
  reconciled: { line: null, label: "Matches pay runs", kind: "yesNo" },
} as const satisfies Record<keyof Omit<WorksheetW3State, "state">, FieldLabel | null>;

/** A worksheet table row (line number, label, formatted value). */
export interface WorksheetLine {
  line: string;
  label: string;
  value: string;
}

/** A table row whose line number and label come from the map; `label` overrides the text. */
export function fieldRow(f: FieldLabel, value: string, label = f.label): WorksheetLine {
  return { line: f.line ?? "—", label, value };
}

type FieldMap = Readonly<Record<string, FieldLabel | null>>;

const FORM_LABELS: Record<string, string> = {
  "941": "Form 941",
  "940": "Form 940",
  w2_w3: "Forms W-2/W-3",
};

export function formLabel(formType: string): string {
  return FORM_LABELS[formType] ?? formType;
}

/** "Q3 2026" for a quarter, "2026" for an annual filing (quarter 0). */
export function periodLabel(year: number, quarter: number): string {
  return quarter === 0 ? String(year) : `Q${quarter} ${year}`;
}

/** "Form 941, Q3 2026" — names the filing a recompute rewrites. */
export function filingName(formType: string, year: number, quarter: number): string {
  return `${formLabel(formType)}, ${periodLabel(year, quarter)}`;
}

/** W-3 box 15 as shown: one state code, "X (more than one state)", or "—". */
export function box15Text(state: string | null | undefined): string {
  if (state === null || state === undefined) return "—";
  return state === "X" ? "X (more than one state)" : state;
}

function formatValue(kind: FieldKind, v: unknown): string {
  if (v === undefined) return "—";
  switch (kind) {
    case "money":
      return money(v as string | number | null);
    case "count":
      return v === null ? "—" : String(v);
    case "yesNo":
      return v ? "Yes" : "No";
    case "percent":
      return percent(v as string | number | null);
    case "quarter":
      return v === null ? "None" : `Q${String(v)}`;
    case "date":
      return date(v as string | null);
    case "text":
      return box15Text(v as string | null);
  }
}

/** Flatten nested objects to dotted keys (`line16.month1`); arrays are left out. */
function flatten(obj: unknown, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (obj === null || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (Array.isArray(v)) continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object") Object.assign(out, flatten(v, key));
    else out[key] = v;
  }
  return out;
}

/** W-3 state rows flattened by state code: `states.NY.box16`. */
function flattenStates(ws: unknown): Record<string, unknown> {
  const states = (ws as { states?: WorksheetW3State[] } | null)?.states ?? [];
  const out: Record<string, unknown> = {};
  for (const s of states) {
    for (const [k, v] of Object.entries(s)) {
      if (k !== "state") out[`states.${s.state}.${k}`] = v;
    }
  }
  return out;
}

export interface RecomputeDiffRow {
  key: string;
  title: string;
  before: string;
  after: string;
}

function title(prefix: string, f: FieldLabel): string {
  return f.line === null ? f.label : `${prefix} ${f.line} — ${f.label}`;
}

/** Rows for the keys of `map` that changed, in map order; changed unmapped keys follow as "Other figure". */
function diffAgainst(
  map: FieldMap,
  prefix: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): RecomputeDiffRow[] {
  const changed = (k: string) => k in after && String(before[k]) !== String(after[k]);
  const rows: RecomputeDiffRow[] = [];
  for (const [key, f] of Object.entries(map)) {
    if (f === null || !changed(key)) continue;
    rows.push({
      key,
      title: title(prefix, f),
      before: formatValue(f.kind, before[key]),
      after: formatValue(f.kind, after[key]),
    });
  }
  for (const key of Object.keys(after)) {
    if (key in map || !changed(key)) continue;
    rows.push({
      key,
      title: "Other figure",
      before: before[key] === undefined ? "—" : String(before[key]),
      after: String(after[key]),
    });
  }
  return rows;
}

/** W-3 state rows that changed, matched by state code, titled "NY — W-2 box 16 total". */
function stateDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): RecomputeDiffRow[] {
  const codes = [...new Set(Object.keys(after).map((k) => k.split(".")[1] ?? ""))];
  return codes.flatMap((code) => {
    const strip = (o: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(o)
          .filter(([k]) => k.startsWith(`states.${code}.`))
          .map(([k, v]) => [k.slice(`states.${code}.`.length), v]),
      );
    return diffAgainst(WORKSHEET_W3_STATE_FIELDS, "", strip(before), strip(after)).map((r) => ({
      ...r,
      key: `states.${code}.${r.key}`,
      title: `${code} — ${r.title}`,
    }));
  });
}

/** The recompute dialog's change table: changed, visible fields only, labelled and formatted. */
export function recomputeDiffRows(
  before: FilingWorksheet | null,
  after: FilingWorksheet,
): RecomputeDiffRow[] {
  const b = flatten(before);
  const a = flatten(after);
  if (after.form === "941") return diffAgainst(WORKSHEET_941_FIELDS, "Line", b, a);
  if (after.form === "940") return diffAgainst(WORKSHEET_940_FIELDS, "Line", b, a);
  return [
    ...diffAgainst(WORKSHEET_W3_FIELDS, "Box", b, a),
    ...stateDiff(flattenStates(before), flattenStates(after)),
  ];
}
