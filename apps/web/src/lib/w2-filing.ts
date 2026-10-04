/**
 * Spec 24 (PAY-116) PR-4: display logic and copy for the W-2/W-3 filing page,
 * the employee W-2 card and the state tax account numbers screen. Pure — no
 * Vue, no I/O — so the server suite can test it. Final copy:
 * product-ux-designer and state-local-payroll-sme, 2026-10-04.
 */

import { stateName, W2_TWO_UP_FROM_YEAR } from "@payroll/shared";
import { useMoney } from "../composables/useMoney";
import type {
  StateIdFurnished,
  StateIdRow,
  W2StateCheck,
  W2StateLineRow,
  WorksheetW3,
} from "./api";

const { money } = useMoney();

/** One W-3 totals table row. */
export interface W3Line {
  line: string;
  label: string;
  value: string;
}

/** W-3 box 15 as shown: one state code, "X (more than one state)", or "—". */
function box15Text(state: string | null): string {
  if (state === null) return "—";
  return state === "X" ? "X (more than one state)" : state;
}

/**
 * The W-3 totals table. Tax years before 2026 (no box15State key) keep the
 * PAY-11 rows. From 2026: box c is the number of W-2 forms (S24-D12), plus
 * boxes 15–17.
 */
export function w3WorksheetLines(w: WorksheetW3): W3Line[] {
  const federal: W3Line[] = [
    { line: "1", label: "Wages, tips, other compensation", value: money(w.box1Wages) },
    { line: "2", label: "Federal income tax withheld", value: money(w.box2FederalWithheld) },
    { line: "3", label: "Social Security wages", value: money(w.box3SsWages) },
    { line: "4", label: "Social Security tax withheld", value: money(w.box4SsTax) },
    { line: "5", label: "Medicare wages and tips", value: money(w.box5MedicareWages) },
    { line: "6", label: "Medicare tax withheld", value: money(w.box6MedicareTax) },
  ];
  if (w.box15State === undefined) {
    return [{ line: "—", label: "W-2 forms included", value: String(w.employeeCount) }, ...federal];
  }
  return [
    {
      line: "c",
      label: "Total number of Forms W-2",
      value: String(w.w2FormCount ?? w.employeeCount),
    },
    ...federal,
    { line: "15", label: "State", value: box15Text(w.box15State) },
    { line: "16", label: "State wages, tips, etc.", value: money(w.box16StateWages) },
    { line: "17", label: "State income tax", value: money(w.box17StateTax) },
  ];
}

type RowLines = { stateLines: readonly Pick<W2StateLineRow, "state" | "stateIdSource">[] };

/** Distinct states of the rows' W-2 lines, in code-point order (localeCompare is banned). */
function lineStates(rows: readonly RowLines[]): string[] {
  const states = new Set(rows.flatMap((r) => r.stateLines.map((l) => l.state)));
  return [...states].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Carry-over e: the state W-3 box 15 prints without an account number — every
 * W-2 line of the year has that one state, and some line of it has no ID.
 * Null otherwise (no lines, several states, or the ID is there).
 */
export function box15MissingIdState(rows: readonly RowLines[]): string | null {
  const states = lineStates(rows);
  if (states.length !== 1) return null;
  const missing = rows.some((r) => r.stateLines.some((l) => l.stateIdSource === null));
  return missing ? (states[0] ?? null) : null;
}

/** Warning in the W-3 card and the Mark as filed dialog (carry-over e). */
export function box15MissingIdText(state: string): string {
  const name = stateName(state);
  return `Your W-2s and W-3 show ${name} in box 15 with no ${name} account number, because we don't have one on file. That's fine if ${name} never gave you one. If it did, add it under Config → Company → State tax account numbers before you file.`;
}

/** A saved (or about to be saved) state ID row: its state and first tax year. */
export type StateIdTarget = Pick<StateIdRow, "stateCode" | "fromTaxYear">;

/**
 * The first tax year of the state's next saved row after `target`, or null
 * when no later row exists (the row at `target` then covers every later year).
 */
export function nextRowYear(rows: readonly StateIdTarget[], target: StateIdTarget): number | null {
  const later = rows
    .filter((r) => r.stateCode === target.stateCode && r.fromTaxYear > target.fromTaxYear)
    .map((r) => r.fromTaxYear);
  return later.length === 0 ? null : Math.min(...later);
}

/** The furnished entries a row at `target` covers: its state, from its year up to the next row's. */
function coveredEntries(
  furnished: readonly StateIdFurnished[],
  rows: readonly StateIdTarget[],
  target: StateIdTarget,
): StateIdFurnished[] {
  const next = nextRowYear(rows, target) ?? Number.POSITIVE_INFINITY;
  return furnished.filter(
    (f) =>
      f.stateCode === target.stateCode &&
      f.taxYear >= target.fromTaxYear &&
      f.taxYear < next &&
      f.employees > 0,
  );
}

/**
 * Carry-over f: how many employees already hold a W-2 with the number a
 * change at `target` would replace (the years the row covers, up to the next
 * row's fromTaxYear).
 */
export function affectedEmployees(
  furnished: readonly StateIdFurnished[],
  rows: readonly StateIdTarget[],
  target: StateIdTarget,
): number {
  return coveredEntries(furnished, rows, target).reduce((n, f) => n + f.employees, 0);
}

/** The affected tax years, ascending ("2026", "2026 and 2027"). */
export function affectedYearsText(
  furnished: readonly StateIdFurnished[],
  rows: readonly StateIdTarget[],
  target: StateIdTarget,
): string {
  const years = [...new Set(coveredEntries(furnished, rows, target).map((f) => f.taxYear))];
  return years
    .sort((a, b) => a - b)
    .map(String)
    .join(" and ");
}

/** Header of the confirm shown before saving over a number already on W-2s. */
export const STATE_ID_CHANGE_HEADER = "Change the number on W-2s already given out?";

/** Body of that confirm (n ≥ 1). */
export function stateIdChangeText(n: number, years: string, state: string): string {
  const name = stateName(state);
  const same =
    "If you're typing the same number again, nothing changes and no one gets a corrected W-2.";
  if (n === 1) {
    return `1 employee already has their ${years} W-2 with your ${name} account number on it. If you save a different number, they get a corrected W-2: if they get their W-2 online, we email them; if they get it on paper, you'll need to print and hand them a corrected copy. ${same}`;
  }
  return `${n} employees already have their ${years} W-2 with your ${name} account number on it. If you save a different number, each of them gets a corrected W-2: employees who get their W-2 online are emailed, and you'll need to print and hand out corrected copies for the others. ${same}`;
}

/** Added to the remove confirm when W-2s with this number were given out (n ≥ 1). */
export function stateIdRemoveText(n: number, years: string, state: string): string {
  const who = n === 1 ? "1 employee already has their" : `${n} employees already have their`;
  return `${who} ${years} W-2 with this number on it. If you remove it, those W-2s will need correcting, and any that show ${stateName(state)} tax withheld go on hold until you add a number again.`;
}

/** Toast body after a save that matched the stored number (`unchanged: true`). */
export function stateIdUnchangedText(state: string): string {
  return `That's the ${stateName(state)} number we already have. Nothing changed, and no W-2s were corrected.`;
}

/** Admin, per W-2 with more than one form (carry-over d). */
export function multiW2Text(formCount: number, legalName: string): string | null {
  if (formCount <= 1) return null;
  return `${legalName} has ${formCount} W-2s because they worked in more than two states. Federal amounts are on W-2 #1 only. The other W-2s show the remaining state lines. Give all of them to the employee together. They're in the same PDF.`;
}

/** Employee W-2 card, per year with more than one form (count only, S3). */
export function myMultiW2Text(formCount: number | null, year: number): string | null {
  if (formCount === null || formCount <= 1) return null;
  return `You have ${formCount} W-2s for ${year} because you worked in more than two states. Your federal amounts are on W-2 #1. The others show your other states only. They're all in the same PDF. Keep them together for your tax return.`;
}

/** Two-up page help (S24-D4), from W2_TWO_UP_FROM_YEAR; null before. */
export function twoUpHelpText(year: number, audience: "admin" | "employee"): string | null {
  if (year < W2_TWO_UP_FROM_YEAR) return null;
  return audience === "admin"
    ? "On each W-2 page, the W-2 is the top form. The bottom form is left blank on purpose. You can cut the page along the middle or hand out the whole page."
    : "On each W-2 page, your W-2 is the top form. The bottom form is left blank on purpose, so you don't need to fill it in.";
}

type BsoRow = {
  legalName: string;
  formCount: number;
  stateLines: readonly Pick<W2StateLineRow, "state" | "form">[];
};

/**
 * S24-D12 Business Services Online copy (Spec 24 §9 E1/E2), shown when any
 * employee has more than one W-2. E2 names the extra forms' states by
 * two-letter code (BSO entry uses codes).
 */
export function bsoMultiFormText(rows: readonly BsoRow[]): { e1: string; e2: string[] } | null {
  const multi = rows.filter((r) => r.formCount > 1);
  if (multi.length === 0) return null;
  const total = rows.reduce((n, r) => n + r.formCount, 0);
  const e1 = `Some employees get more than one W-2 this year because they worked in more than two states. When you enter W-2s in Business Services Online, enter each extra W-2 as its own W-2: same employee and employer details (boxes a–f), boxes 1–14 left blank, and the next state lines. Then the W-3 that Business Services Online makes will show ${total} W-2s, the same as ours.`;
  const e2 = multi.map((r) => {
    const forms: string[] = [];
    for (let k = 2; k <= r.formCount; k++) {
      const states = r.stateLines.filter((l) => l.form === k).map((l) => l.state);
      forms.push(`W-2 #${k}: ${states.join(", ")}`);
    }
    return `${r.legalName}: ${r.formCount} W-2s. ${forms.join(". ")}`;
  });
  return { e1, e2 };
}

const NEXT_BUSINESS_DAY =
  "by January 31, or the next business day if January 31 falls on a weekend or holiday";

/** S24-D9 checklist lines C1–C5 (state SME final strings, 2026-10-04). */
const STATE_STEPS: Readonly<Record<string, string>> = {
  CA: "California: no W-2s to send. Your wages go on the DE 9C each quarter.",
  IL: `Illinois: send your W-2s to the Illinois Department of Revenue electronically ${NEXT_BUSINESS_DAY}.`,
  MD: `Maryland: file Form MW508 with your W-2s ${NEXT_BUSINESS_DAY}. If you have 25 or more W-2s, file electronically.`,
  NC: `North Carolina: file Form NC-3 with your W-2s electronically (eNC3) ${NEXT_BUSINESS_DAY}.`,
  NY: "New York: no W-2s to send. Your wages go on the NYS-45 each quarter.",
};

/** C6: any other state with a W-2 state line. */
function otherStateStep(state: string): string {
  const name = stateName(state);
  return `${name}: check with ${name}'s tax department whether you need to send them your W-2s or a yearly withholding report, and when it's due. This app doesn't list ${name}'s steps yet.`;
}

/** "How to file" state lines: one per distinct state on the year's W-2 lines, by code. */
export function stateFilingChecklist(rows: readonly RowLines[]): string[] {
  return lineStates(rows).map((s) => STATE_STEPS[s] ?? otherStateStep(s));
}

/** "How to file" step 1 for W-2/W-3 (D-PL4). */
export const W2_DOWNLOAD_STEP =
  "Download the W-2 PDFs and the W-3 records copy on this page. An employee can have more than one W-2.";

/** Under the W-3 totals table (D-PL1): the W-3 is a records copy. */
export const W3_RECORDS_NOTE =
  "This W-3 is for your records. Don't mail it. When you file your W-2s online through Business Services Online (BSO), BSO makes the W-3 for you from the W-2s you enter. Use this copy to check that BSO's totals match ours. A paper W-3 is only sent with paper Copy A of each W-2, and this app doesn't make Copy A.";

/** The W-3 card header while any W-2 is on hold. */
export const W3_ON_HOLD_TEXT = "Your W-3 can be made once every W-2 below is ready.";

/** Round 4: the W-3 card header when only the year's state tax check holds it. */
export const W3_STATE_CHECK_HOLD_TEXT =
  "Your W-3 can be made once the state tax check below matches.";

/** The "Mark as filed" dialog lead sentence. */
export function markFiledLeadText(formType: string, formLabel: string, period: string): string {
  if (formType === "w2_w3") {
    return "File your W-2s through Business Services Online (BSO) first, then record it here.";
  }
  return `File ${formLabel} for ${period} first — by mail or e-file — then record it here.`;
}

/** One W-2 state line in the W-2 table: "IL: wages $1.00 · tax $0.10". */
export function stateLineText(line: Pick<W2StateLineRow, "state" | "box16" | "box17">): string {
  return `${line.state}: wages ${money(line.box16)} · tax ${money(line.box17)}`;
}

/** Tag next to a state line: where its box 15 number comes from (never the number). */
export function stateIdSourceTag(source: W2StateLineRow["stateIdSource"]): string | null {
  if (source === "ein_default") return "Uses your EIN";
  if (source === null) return "No state number";
  return null;
}

/** State tax check card (I3). */
export const STATE_CHECK_INTRO =
  "For each state, the tax on your W-2s should match the tax withheld on your issued pay runs. \"Marked as deposited\" is what you've marked as deposited on Tax deposits. It's shown for comparison and can be lower if a deposit isn't due yet or you haven't marked it.";

/** The card when the check can't run because some W-2 boxes are withheld. */
export const STATE_CHECK_WITHHELD =
  'The state tax check will show once the W-2s marked "Totals unreadable" or "Negative total" are fixed.';

/** One state's line on the State tax check card. */
export function stateCheckText(c: W2StateCheck): string {
  return `${stateName(c.state)}: W-2s ${money(c.box17)} · issued pay runs ${money(c.runWithholding)} · marked as deposited ${money(c.deposited)}`;
}
