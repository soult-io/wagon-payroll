/**
 * PAY-163 (Spec 25 (PAY-120)): the work-locality question — New York asks
 * "any work in Yonkers?" (yes / no), Maryland asks for the county. Shared by
 * the Assign-work-state and Answer dialogs (WorkLocalityQuestion.vue).
 */

import { workLocalityOptions } from "@payroll/shared";

export const YES_NO = [
  { label: "Yes", value: "yes" },
  { label: "No", value: "no" },
];

/** Maryland counties (and Baltimore City), alphabetical. */
export const COUNTY_OPTIONS = workLocalityOptions("MD")
  .map((o) => ({ label: o.name, value: o.code as string }))
  .sort((a, b) => (a.label < b.label ? -1 : 1));

/** Work-locality answer → localityCode (undefined = not answered yet). */
export function localityFromAnswer(stateCode: string, answer: string): string | null | undefined {
  if (stateCode === "NY") {
    if (answer === "yes") return "NY-YONKERS";
    return answer === "no" ? null : undefined;
  }
  if (stateCode === "MD") return answer ? answer : undefined;
  return null;
}
