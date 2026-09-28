/**
 * Local income-tax guard — Spec 25 (PAY-120), PAY-163 (step G1).
 *
 * `checkLocalTaxSupport` decides whether the app can withhold every local
 * income tax an employee owes for one pay date, or must hold the pay run.
 * Pure: no I/O, no clock — the loader (local-guard-inputs.ts) resolves the
 * residence (on the pay date), the work state, the coverage list and which
 * local tax tables exist.
 *
 * G1 only REPORTS the result (GET /api/admin/local-tax/check); nothing calls
 * it from draft generation, approve or issue yet — enforcement is step G2.
 *
 * Coverage rows are data (local_tax_coverage): `engine` = the app computes
 * the local, `unsupported` = hold the run. A row's code is a USPS state
 * ('OH', 'MD') or a locality ('NY-NYC'); basis says whether living there or
 * working there triggers it. Local tax jurisdictions (the tables' keys):
 * the residence locality for residents ('NY-NYC', 'NY-YONKERS', 'MD-510'),
 * 'NY-YONKERS-NR' / 'MD-NONRES' for nonresidents working there.
 */

export type LocalGuardReason =
  | "local_coverage_missing"
  | "residence_missing"
  | "work_locality_unconfirmed"
  | "local_unsupported_state"
  | "local_not_yet_supported"
  | "local_outside_work_state";

/** Fixed report order (the order of the reason table). */
const REASON_ORDER: readonly LocalGuardReason[] = [
  "local_coverage_missing",
  "residence_missing",
  "work_locality_unconfirmed",
  "local_unsupported_state",
  "local_not_yet_supported",
  "local_outside_work_state",
];

export interface LocalGuardCoverageRow {
  code: string;
  basis: "residence" | "work";
  handling: "unsupported" | "engine";
}

export interface LocalGuardInput {
  /** Local tax year = the pay-date year. */
  taxYear: number;
  payDate: string;
  employmentType: "w2" | "1099";
  /** Residence effective on the pay date; null = none on file. */
  residence: {
    country: string;
    stateCode: string | null;
    localityCode: string | null;
    createdAt: string;
  } | null;
  /** Work state row in force; null = no work-state row. */
  workState: { stateCode: string; localityCode: string | null; localityConfirmed: boolean } | null;
  coverage: LocalGuardCoverageRow[];
  /** Local tax jurisdiction → tax years that have a table. */
  localConfigYears: Record<string, number[]>;
}

export type LocalGuardResult = { ok: true } | { ok: false; reasons: LocalGuardReason[] };

/** Work states whose rows must carry a confirmed work locality. */
const WORK_LOCALITY_STATES = new Set(["NY", "MD"]);
/** Work states where "confirmed, no locality" is not an answer (a county is required). */
const WORK_LOCALITY_REQUIRED = new Set(["MD"]);

/**
 * Jurisdiction owed by a NONRESIDENT working under an engine work row, by the
 * row's code. A code with no entry maps to itself, which has no table, so it
 * reports local_not_yet_supported (fails closed until the math exists).
 */
const NONRESIDENT_JURISDICTION: Readonly<Record<string, string>> = {
  "NY-YONKERS": "NY-YONKERS-NR",
  MD: "MD-NONRES",
};

function stateOf(code: string): string {
  return code.slice(0, 2);
}

/** Coverage row of `handling` for `basis` whose code is one of `codes`. */
function findRow(
  coverage: LocalGuardCoverageRow[],
  basis: LocalGuardCoverageRow["basis"],
  handling: LocalGuardCoverageRow["handling"],
  codes: (string | null)[],
): LocalGuardCoverageRow | undefined {
  return coverage.find(
    (r) => r.basis === basis && r.handling === handling && codes.includes(r.code),
  );
}

function workLocalityUnconfirmed(workState: NonNullable<LocalGuardInput["workState"]>): boolean {
  if (!WORK_LOCALITY_STATES.has(workState.stateCode)) return false;
  if (!workState.localityConfirmed) return true;
  return WORK_LOCALITY_REQUIRED.has(workState.stateCode) && workState.localityCode === null;
}

interface LocalOwed {
  /** Tax table key ('NY-NYC', 'NY-YONKERS-NR', 'MD-510', 'MD-NONRES'). */
  jurisdiction: string;
  /** The place, for messages: the residence locality, or the work locality/state. */
  place: string;
}

/** Any engine residence row in the state (NY counts even outside NYC/Yonkers). */
function stateHasResidentLocals(
  coverage: LocalGuardCoverageRow[],
  stateCode: string | null,
): boolean {
  return (
    stateCode !== null &&
    coverage.some(
      (r) => r.basis === "residence" && r.handling === "engine" && stateOf(r.code) === stateCode,
    )
  );
}

/**
 * The locals this employee's run would carry, and the place of a resident
 * local that cannot be computed because the work state differs (or is
 * missing). Residence is known here.
 */
function applicableLocals(
  input: LocalGuardInput,
  residenceCodes: (string | null)[],
  workCodes: (string | null)[],
  workConfirmed: boolean,
): { locals: LocalOwed[]; outsidePlace: string | null } {
  const { residence, workState, coverage } = input;
  const locals: LocalOwed[] = [];
  let outsidePlace: string | null = null;

  const residentRow = findRow(coverage, "residence", "engine", residenceCodes);
  const residenceState = residence?.country === "US" ? residence.stateCode : null;
  const residencePlace = residence?.localityCode ?? residenceState;

  if (workState === null && stateHasResidentLocals(coverage, residenceState)) {
    outsidePlace = residencePlace;
  }
  if (residentRow && residencePlace !== null) {
    if (workState === null || workState.stateCode !== residenceState) {
      outsidePlace = residencePlace;
    } else {
      locals.push({ jurisdiction: residencePlace, place: residencePlace });
    }
  }

  const workRow = workConfirmed ? findRow(coverage, "work", "engine", workCodes) : undefined;
  // A resident of the same local owes the resident tax only (no nonresident tax).
  if (workState && workRow && workRow.code !== residentRow?.code) {
    locals.push({
      jurisdiction: NONRESIDENT_JURISDICTION[workRow.code] ?? workRow.code,
      place: workState.localityCode ?? workState.stateCode,
    });
  }
  return { locals, outsidePlace };
}

interface Analysis {
  reasons: Set<LocalGuardReason>;
  /** The place behind the first hold that is about a place, or null. */
  place: string | null;
}

function analyze(input: LocalGuardInput): Analysis {
  const { residence, workState, coverage } = input;
  const reasons = new Set<LocalGuardReason>();
  const places: (string | null)[] = [];

  if (coverage.length === 0) reasons.add("local_coverage_missing");
  if (residence === null) reasons.add("residence_missing");
  const unconfirmed = workState !== null && workLocalityUnconfirmed(workState);
  if (unconfirmed) reasons.add("work_locality_unconfirmed");

  const residenceCodes =
    residence?.country === "US" ? [residence.stateCode, residence.localityCode] : [];
  const workCodes = workState ? [workState.stateCode, workState.localityCode] : [];
  const unsupported =
    findRow(coverage, "residence", "unsupported", residenceCodes) ??
    findRow(coverage, "work", "unsupported", workCodes);
  if (unsupported) {
    reasons.add("local_unsupported_state");
    places.push(unsupported.code);
  }

  // Which locals apply is unknowable without a residence; residence_missing holds the run.
  if (residence !== null) {
    const { locals, outsidePlace } = applicableLocals(
      input,
      residenceCodes,
      workCodes,
      !unconfirmed,
    );
    const missing = locals.find(
      (l) => !(input.localConfigYears[l.jurisdiction] ?? []).includes(input.taxYear),
    );
    if (missing) {
      reasons.add("local_not_yet_supported");
      places.push(missing.place);
    }
    if (outsidePlace !== null) {
      reasons.add("local_outside_work_state");
      places.push(outsidePlace);
    }
  }
  return { reasons, place: places[0] ?? null };
}

export function checkLocalTaxSupport(input: LocalGuardInput): LocalGuardResult {
  if (input.employmentType !== "w2") return { ok: true };
  const { reasons } = analyze(input);
  if (reasons.size === 0) return { ok: true };
  return { ok: false, reasons: REASON_ORDER.filter((r) => reasons.has(r)) };
}

/**
 * The state or locality code behind a hold about a place
 * (local_unsupported_state, local_not_yet_supported, local_outside_work_state),
 * for the admin message ("… lives or works in {place} …"); null when nothing
 * is held for a place. Same inputs and rules as checkLocalTaxSupport.
 */
export function holdPlace(input: LocalGuardInput): string | null {
  if (input.employmentType !== "w2") return null;
  return analyze(input).place;
}
