/**
 * Local income-tax places (Spec 25 (PAY-120), PAY-163): the CLOSED list of
 * locality codes the app knows, their display names, and the request schemas
 * for residence and work-locality capture — shared by the API and the web
 * forms so both validate the same way.
 *
 * Codes: `NY-NYC`, `NY-YONKERS`, and `MD-<county FIPS>` for the 23 Maryland
 * counties plus Baltimore City (`MD-510`). The database enforces the same
 * list with CHECK constraints. Adding a place is deliberate — a migration and
 * new withholding math — never free text: a typo would silently mean zero tax.
 * ZIP codes cross locality lines, so a place is never derived from a ZIP.
 */

import { z } from "zod";
import { isoDate } from "./change-requests.js";
import { STATE_NAMES } from "./states.js";

const NY_LOCALITIES = [
  { code: "NY-NYC", name: "New York City" },
  { code: "NY-YONKERS", name: "Yonkers" },
] as const;

/** Maryland counties by FIPS code, plus Baltimore City (510, an independent city). */
const MD_LOCALITIES = [
  { code: "MD-001", name: "Allegany County" },
  { code: "MD-003", name: "Anne Arundel County" },
  { code: "MD-005", name: "Baltimore County" },
  { code: "MD-009", name: "Calvert County" },
  { code: "MD-011", name: "Caroline County" },
  { code: "MD-013", name: "Carroll County" },
  { code: "MD-015", name: "Cecil County" },
  { code: "MD-017", name: "Charles County" },
  { code: "MD-019", name: "Dorchester County" },
  { code: "MD-021", name: "Frederick County" },
  { code: "MD-023", name: "Garrett County" },
  { code: "MD-025", name: "Harford County" },
  { code: "MD-027", name: "Howard County" },
  { code: "MD-029", name: "Kent County" },
  { code: "MD-031", name: "Montgomery County" },
  { code: "MD-033", name: "Prince George's County" },
  { code: "MD-035", name: "Queen Anne's County" },
  { code: "MD-037", name: "St. Mary's County" },
  { code: "MD-039", name: "Somerset County" },
  { code: "MD-041", name: "Talbot County" },
  { code: "MD-043", name: "Washington County" },
  { code: "MD-045", name: "Wicomico County" },
  { code: "MD-047", name: "Worcester County" },
  { code: "MD-510", name: "Baltimore City" },
] as const;

const ALL_LOCALITIES = [...NY_LOCALITIES, ...MD_LOCALITIES];

/** Places a work-state row can name. NYC taxes residents only, so it is never a work locality. */
export const WORK_LOCALITY_CODES = [
  "NY-YONKERS",
  "MD-001",
  "MD-003",
  "MD-005",
  "MD-009",
  "MD-011",
  "MD-013",
  "MD-015",
  "MD-017",
  "MD-019",
  "MD-021",
  "MD-023",
  "MD-025",
  "MD-027",
  "MD-029",
  "MD-031",
  "MD-033",
  "MD-035",
  "MD-037",
  "MD-039",
  "MD-041",
  "MD-043",
  "MD-045",
  "MD-047",
  "MD-510",
] as const;
export type WorkLocalityCode = (typeof WORK_LOCALITY_CODES)[number];

/** Every place a residence can name. */
export const LOCALITY_CODES = ["NY-NYC", ...WORK_LOCALITY_CODES] as const;
export type LocalityCode = (typeof LOCALITY_CODES)[number];

/** States whose work-state rows must answer the work-locality question. */
export const WORK_LOCALITY_STATES: readonly string[] = ["NY", "MD"];

export interface LocalityOption {
  code: LocalityCode;
  name: string;
}

const NAMES: ReadonlyMap<string, string> = new Map(ALL_LOCALITIES.map((l) => [l.code, l.name]));

/** "MD-510" → "Baltimore City"; an unknown code is returned as is. */
export function localityName(code: string): string {
  return NAMES.get(code) ?? code;
}

/** The state a locality code belongs to ("NY-YONKERS" → "NY"). */
export function localityState(code: string): string {
  return code.slice(0, 2);
}

/** Residence choices for a state ([] for states with no local income tax the app knows). */
export function residenceLocalityOptions(stateCode: string): LocalityOption[] {
  return ALL_LOCALITIES.filter((l) => localityState(l.code) === stateCode).map((l) => ({
    code: l.code,
    name: l.name,
  }));
}

/** Work-locality choices for a state (New York: Yonkers only; Maryland: every county). */
export function workLocalityOptions(stateCode: string): LocalityOption[] {
  return residenceLocalityOptions(stateCode).filter((l) => l.code !== "NY-NYC");
}

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const countryCode = z.string().regex(/^[A-Z]{2}$/, "expected a 2-letter uppercase country code");
const usStateCode = z.string().regex(/^[A-Z]{2}$/, "expected a 2-letter uppercase state code");

/** PUT /api/admin/employees/:employeeId/residence. */
export const residenceInput = z
  .strictObject({
    country: countryCode,
    stateCode: usStateCode.nullable(),
    localityCode: z.enum(LOCALITY_CODES).nullable(),
    effectiveFrom: isoDate,
    /** "Still the same": re-confirms the current residence from this date. */
    sameAsBefore: z.literal(true).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.country === "US") {
      if (v.stateCode === null || !Object.hasOwn(STATE_NAMES, v.stateCode)) {
        ctx.addIssue({
          code: "custom",
          path: ["stateCode"],
          message: "a US residence needs a state",
        });
      }
    } else if (v.stateCode !== null || v.localityCode !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["stateCode"],
        message: "a residence outside the US has no US state or locality",
      });
    }
    if (v.localityCode !== null && localityState(v.localityCode) !== v.stateCode) {
      ctx.addIssue({
        code: "custom",
        path: ["localityCode"],
        message: "the locality is not in that state",
      });
    }
    if (v.stateCode === "MD" && v.localityCode === null) {
      ctx.addIssue({
        code: "custom",
        path: ["localityCode"],
        message: "a Maryland residence needs its county (or Baltimore City)",
      });
    }
  });
export type ResidenceInput = z.infer<typeof residenceInput>;

const workLocalityCode = z.enum(WORK_LOCALITY_CODES).nullable();

/**
 * Check a work-locality answer against a work state: New York answers the
 * Yonkers question (null = no), Maryland names a county, other states have
 * no work locality. Returns an issue message, or null when the answer fits.
 */
export function workLocalityProblem(
  stateCode: string,
  localityCode: string | null | undefined,
): string | null {
  if (WORK_LOCALITY_STATES.includes(stateCode) && localityCode === undefined) {
    return "this state needs the work-locality answer";
  }
  if (stateCode === "MD" && localityCode === null) {
    return "a Maryland work state needs the county";
  }
  if (localityCode != null && localityState(localityCode) !== stateCode) {
    return "the locality is not in that state";
  }
  return null;
}

/** PUT /api/admin/employees/:employeeId/work-state (the PAY-13 body plus the locality answer). */
export const workStateInput = z
  .object({
    stateCode: usStateCode,
    effectiveFrom: isoDate,
    localityCode: workLocalityCode.optional(),
  })
  .superRefine((v, ctx) => {
    const problem = workLocalityProblem(v.stateCode, v.localityCode);
    if (problem) ctx.addIssue({ code: "custom", path: ["localityCode"], message: problem });
  });
export type WorkStateInput = z.infer<typeof workStateInput>;

/** PUT /api/admin/employees/:employeeId/work-state/locality (backfill on the open row). */
export const workLocalityInput = z.strictObject({ localityCode: workLocalityCode });
export type WorkLocalityInput = z.infer<typeof workLocalityInput>;
