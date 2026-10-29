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

export type FieldKind = "money" | "count" | "yesNo" | "percent" | "quarter" | "date" | "stateCode";

/** A worksheet field as shown: form line (null = no line on the form), label, value kind. */
export interface FieldLabel {
  line: string | null;
  label: string;
  kind: FieldKind;
}

const field = (line: string | null, label: string, kind: FieldKind = "money"): FieldLabel => ({
  line,
  label,
  kind,
});

/** Form 941, keyed by flattened worksheet key. Declaration order = row order. */
export const WORKSHEET_941_FIELDS = {
  form: null,
  year: null,
  quarter: null,
  line1Employees: field("1", "Employees paid (pay period incl. the 12th of month 1)", "count"),
  line2Wages: field("2", "Wages, tips, and other compensation"),
  line3FederalWithheld: field("3", "Federal income tax withheld"),
  line5aTaxableSsWages: field("5a", "Taxable Social Security wages"),
  line5aTax: field("5a", "Social Security tax"),
  line5cTaxableMedicareWages: field("5c", "Taxable Medicare wages"),
  line5cTax: field("5c", "Medicare tax"),
  line5dAdditionalMedicare: field("5d", "Additional Medicare Tax withheld"),
  line5eTotal: field("5e", "Total Social Security and Medicare taxes"),
  line6TotalTaxes: field("6", "Total taxes before adjustments (lines 3 + 5e + 5f)"),
  line7FractionsOfCents: field("7", "Fractions of cents"),
  // The default line 7 before an admin override — not a line on the form.
  line7Computed: null,
  line10TotalAfterAdjustments: field("10", "Total taxes after adjustments"),
  line11ResearchCredit: field("11", "Qualified small business R&D credit"),
  line12TotalAfterCredits: field("12", "Total taxes after credits"),
  line13Deposits: field("13", "Total deposits for the quarter (incl. overpayments applied)"),
  line14BalanceDue: field("14", "Balance due"),
  line15Overpayment: field("15a", "Overpayment"),
  "line16.month1": field("16", "Month 1 liability"),
  "line16.month2": field("16", "Month 2 liability"),
  "line16.month3": field("16", "Month 3 liability"),
  "line16.deMinimis": field("16", "Line 12 is under $2,500 (no monthly breakdown)", "yesNo"),
} as const satisfies Record<string, FieldLabel | null>;

/** Form 940 (FUTA). */
export const WORKSHEET_940_FIELDS = {
  form: null,
  year: null,
  sutaCreditRate: field(null, "SUTA credit rate", "percent"),
  futaRate: field(null, "Net FUTA rate", "percent"),
  line3TotalPayments: field("3", "Total payments to all employees"),
  line7FutaTaxableWages: field("7", "Total taxable FUTA wages (first $7,000 per employee)"),
  line8FutaTax: field("8", "FUTA tax before adjustments"),
  line12TotalFutaTax: field("12", "Total FUTA tax after adjustments"),
  futaTaxPerFrozenEntries: field(null, "FUTA tax recorded in issued pay runs"),
  roundingDelta: field(null, "Rounding difference (pay runs vs. line 12)"),
  depositThresholdCrossedQuarter: field(null, "Quarter FUTA liability crossed $500", "quarter"),
  depositDueBy: field(null, "Deposit due by", "date"),
  balanceDue: field("14", "Balance due"),
} as const satisfies Record<string, FieldLabel | null>;

/** W-3 transmittal (the per-state rows are in WORKSHEET_W3_STATE_FIELDS). */
export const WORKSHEET_W3_FIELDS = {
  form: null,
  year: null,
  employeeCount: field(null, "W-2 forms included", "count"),
  w2FormCount: field("c", "Total number of Forms W-2", "count"),
  box1Wages: field("1", "Wages, tips, other compensation"),
  box2FederalWithheld: field("2", "Federal income tax withheld"),
  box3SsWages: field("3", "Social Security wages"),
  box4SsTax: field("4", "Social Security tax withheld"),
  box5MedicareWages: field("5", "Medicare wages and tips"),
  box6MedicareTax: field("6", "Medicare tax withheld"),
  box15State: field("15", "State", "stateCode"),
  box16StateWages: field("16", "State wages, tips, etc."),
  box17StateTax: field("17", "State income tax"),
  blockedEmployees: field(null, "Employees with W-2s on hold", "count"),
} as const satisfies Record<string, FieldLabel | null>;

/** One state's W-3 reconciliation row; `state` is the row key, not a field. */
export const WORKSHEET_W3_STATE_FIELDS = {
  w2Lines: field(null, "W-2 state lines", "count"),
  box16: field(null, "W-2 box 16 total"),
  box17: field(null, "W-2 box 17 total"),
  runWithholding: field(null, "State tax withheld in pay runs"),
  attributedLegacy: field(null, "Older withholding attributed"),
  reconciled: field(null, "Matches pay runs", "yesNo"),
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
    case "stateCode":
      return box15Text(v as string | null);
  }
}

/**
 * Flatten nested objects and arrays to dotted keys (`line16.month1`). The
 * top-level W-3 `states` array is left out — stateDiff matches it by code.
 */
function flatten(obj: unknown, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (obj === null || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (!prefix && k === "states" && (obj as { form?: unknown }).form === "w2_w3") continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object") Object.assign(out, flatten(v, key));
    else out[key] = v;
  }
  return out;
}

/** W-3 state rows by state code (the row without its `state` key). */
function statesByCode(ws: FilingWorksheet | null): Map<string, Record<string, unknown>> {
  const states = (ws as { states?: WorksheetW3State[] } | null)?.states ?? [];
  return new Map(states.map(({ state, ...rest }) => [state, rest]));
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
  // A key in either side counts: a figure the recompute drops still shows (after "—").
  const changed = (k: string) => String(before[k]) !== String(after[k]);
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
  const raw = (v: unknown) => (v === undefined ? "—" : String(v));
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key in map || !changed(key)) continue;
    rows.push({ key, title: "Other figure", before: raw(before[key]), after: raw(after[key]) });
  }
  return rows;
}

/** W-3 state rows that changed, matched by state code, titled "NY — W-2 box 16 total". */
function stateDiff(before: FilingWorksheet | null, after: FilingWorksheet): RecomputeDiffRow[] {
  const b = statesByCode(before);
  const a = statesByCode(after);
  // Codes from both sides, so a state the recompute removes still shows.
  return [...new Set([...b.keys(), ...a.keys()])].flatMap((code) =>
    diffAgainst(WORKSHEET_W3_STATE_FIELDS, "", b.get(code) ?? {}, a.get(code) ?? {}).map((r) => ({
      ...r,
      key: `states.${code}.${r.key}`,
      title: `${code} — ${r.title}`,
    })),
  );
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
  if (after.form !== "w2_w3") return diffAgainst({}, "", b, a);
  return [...diffAgainst(WORKSHEET_W3_FIELDS, "Box", b, a), ...stateDiff(before, after)];
}
