/**
 * run_snapshot contract (spec payroll-engine + documents): the frozen
 * inputs+outputs of a payroll run. Payslip PDFs render from THIS, never from
 * live config. `snapshotHash` = SHA-256 of the canonical JSON so any drift
 * would be detectable.
 */

import { createHash } from "node:crypto";
import type { PayrollResult } from "@payroll/engine";

export const SNAPSHOT_TEMPLATE_VERSION = "1.3.0";

/**
 * Year-to-date accumulations THROUGH this run (inclusive), employee-side.
 * Frozen at issuance so the payslip's YTD block renders from the snapshot
 * alone. Added in template 1.1.0 — optional so pre-1.1.0 snapshots (the
 * initial legacy import) still typecheck; the backfill CLI patches them.
 */
export interface RunSnapshotYtd {
  gross: number;
  federalWithholding: number;
  socialSecurity: number;
  medicare: number;
  stateWithholding: number;
  totalDeductions: number;
  netPay: number;
}

export interface SnapshotW4 {
  filingStatus: "single" | "married_joint" | "married_separate" | "head_of_household";
  federalExempt: boolean;
  multipleJobs: boolean;
  dependentsAmount: number;
  otherIncome: number;
  deductionsAmount: number;
  extraWithholding: number;
  effectiveFrom: string;
  filedDate: string;
}

export interface SnapshotTaxConfig {
  jurisdiction: string;
  taxYear: number;
  standardDeduction: number;
  socialSecurityRate: number;
  socialSecurityWageCap: number;
  medicareRate: number;
  medicareAdditionalRate: number;
  medicareAdditionalThreshold: number;
  stateWithholdingRate: number;
  employerSocialSecurityRate: number;
  employerMedicareRate: number;
  futaRate: number;
  futaWageCap: number;
  /** PAY-18: configured SUTA credit; futaRate above = 6.0% − this. */
  sutaCreditRate: number;
}

export interface SnapshotBracket {
  min: number;
  /** null = open top bracket. */
  max: number | null;
  rate: number;
}

/**
 * The employee's frozen state election (template 1.2.0). Mirrors
 * state_withholding_elections; generic union of IL-W-4 / DE 4 concepts.
 */
export interface SnapshotStateElection {
  filingStatus: "single" | "married_joint" | "married_separate" | "head_of_household";
  allowances: number;
  additionalAllowances: number;
  extraWithholding: number;
  exempt: boolean;
  effectiveFrom: string;
  filedDate: string;
}

/**
 * Frozen state-withholding input (template 1.2.0, PAY-13): the work state,
 * the jurisdiction actually resolved ('CA:married_joint' when a status-specific
 * set applied), the config numbers, the election (or null = form never filed —
 * engine defaults to zero allowances), and the bracket set actually applied.
 * Optional so pre-1.2.0 snapshots still typecheck; absent means the run used
 * the legacy flat stateWithholdingRate path.
 */
export interface SnapshotState {
  workState: string;
  jurisdiction: string;
  taxYear: number;
  kind: "none" | "flat" | "progressive";
  flatRate: number | null;
  standardDeduction: number | null;
  standardDeductionAlt: number | null;
  altMinAllowances: number | null;
  lowIncomeExemption: number | null;
  lowIncomeExemptionAlt: number | null;
  allowanceDeduction: number | null;
  allowanceCredit: number | null;
  additionalAllowanceDeduction: number | null;
  election: SnapshotStateElection | null;
  brackets: SnapshotBracket[];
}

/**
 * Which dates and years drove the run (template 1.3.0, Spec 26 (PAY-173) D5).
 * Absent on snapshots up to 1.2.0 (period-start era).
 */
export interface SnapshotResolution {
  /** Rule marker. */
  basis: "pay_date";
  /** As-of for tax tables, YTD, the W-4 next-year gate and exempt lapse. */
  payDate: string;
  /** = min(periodEnd, payDate); as-of for W-4 and state-election selection. */
  certificateAsOf: string;
  /** = periodStart; as-of for compensation and work state. */
  earnedAsOf: string;
  /** year(payDate); equals taxConfig.taxYear and state.taxYear. */
  taxYear: number;
  ytd: {
    /** = taxYear. */
    year: number;
    /** The D2 key prior YTD was cut at (runId null = a new draft, id +∞). */
    before: { payDate: string; periodStart: string; runId: number | null };
    /** publicIds of the issued runs summed into prior YTD, in key order. */
    runs: string[];
  };
}

export interface RunSnapshot {
  inputs: {
    periodAmount: number;
    frequency: "weekly" | "biweekly" | "semimonthly" | "monthly";
    periodsPerYear: number;
    w4: SnapshotW4 | null;
    taxConfig: SnapshotTaxConfig;
    /** Bracket set actually applied (filing-status resolved). */
    brackets: SnapshotBracket[];
    /** PAY-13: frozen state input when a work state was effective (template 1.2.0). */
    state?: SnapshotState;
    priorYtdGross: number;
    periodStart: string;
    periodEnd: string;
    payDate: string;
    /** Display fields copied in at issuance so re-renders never drift (D5). */
    company: { legalName: string };
    employee: { legalName: string; preferredName: string | null };
    /** Spec 26 (PAY-173): dates/years used (template 1.3.0). */
    resolution?: SnapshotResolution;
  };
  result: PayrollResult;
  engineVersion: string;
  templateVersion: string;
  /** YTD accumulations through this run (template ≥1.1.0). */
  ytd?: RunSnapshotYtd;
  /**
   * Migration-only (legacy import): categories where the ISSUED amount
   * deliberately differs from the recomputed engine result, with the reason.
   * Absent on app-generated runs. See apps/server/src/migrate/migrate.ts
   * STORED_AMOUNT_OVERRIDES.
   */
  legacyDeviations?: {
    category: string;
    stored: string;
    recomputed: string;
    reason: string;
  }[];
  /** Migration-only annotation (e.g. prior-year tax tables applied). */
  legacyNotes?: string[];
}

/** Canonical JSON: object keys sorted recursively, so hashing is stable. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function snapshotHash(snapshot: RunSnapshot): string {
  return createHash("sha256").update(canonicalJson(snapshot), "utf8").digest("hex");
}

/**
 * The parts of a snapshot that must be reproduced by a recompute for a draft
 * to still be current (Spec 26 (PAY-173) D4). Display names (frozen at
 * generation) and `resolution` (absent before 1.3.0) are left out, so a
 * pre-1.3.0 draft with identical numbers still passes; `inputs.payDate` is
 * in, so a pay date edited after generation always mismatches.
 */
function fingerprintParts(s: RunSnapshot): Record<string, unknown> {
  // JSON round trip: a stored snapshot came back from jsonb, so compare the
  // recomputed one in the same form (undefined-valued keys dropped).
  const plain = JSON.parse(JSON.stringify(s)) as RunSnapshot & {
    inputs: Record<string, unknown>;
  };
  const { company: _c, employee: _e, resolution: _r, ...inputs } = plain.inputs;
  return {
    inputs,
    result: plain.result,
    ytd: plain.ytd ?? null,
    engineVersion: plain.engineVersion,
  };
}

/**
 * Field NAMES (never values) that differ between two snapshots' fingerprint
 * parts: input keys by name (`taxConfig`, `priorYtdGross`, `payDate`, `w4`),
 * result keys as `result.<key>`, then `ytd` and `engineVersion`.
 */
export function fingerprintDiff(stored: RunSnapshot, recomputed: RunSnapshot): string[] {
  const a = fingerprintParts(stored);
  const b = fingerprintParts(recomputed);
  const differs = (x: unknown, y: unknown) => canonicalJson(x ?? null) !== canonicalJson(y ?? null);
  const keysOf = (x: unknown, y: unknown) =>
    [...new Set([...Object.keys((x ?? {}) as object), ...Object.keys((y ?? {}) as object)])].sort();
  const fields: string[] = [];
  const ai = a["inputs"] as Record<string, unknown>;
  const bi = b["inputs"] as Record<string, unknown>;
  for (const k of keysOf(ai, bi)) if (differs(ai[k], bi[k])) fields.push(k);
  const ar = (a["result"] ?? {}) as Record<string, unknown>;
  const br = (b["result"] ?? {}) as Record<string, unknown>;
  for (const k of keysOf(ar, br)) if (differs(ar[k], br[k])) fields.push(`result.${k}`);
  if (differs(a["ytd"], b["ytd"])) fields.push("ytd");
  if (differs(a["engineVersion"], b["engineVersion"])) fields.push("engineVersion");
  return fields;
}
