/**
 * US state (and DC) names by USPS code — the one map every screen, email and
 * label uses to show "California" instead of "CA" (PAY-91 UX).
 */
export const STATE_NAMES: Readonly<Record<string, string>> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  DC: "District of Columbia",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
};

/** "CA" → "California"; "federal" → "Federal"; an unknown code is returned as is. */
export function stateName(code: string): string {
  if (code === "federal") return "Federal";
  return STATE_NAMES[code] ?? code;
}

/** "CA" → "California (CA)"; "federal" → "Federal" (jurisdiction column + filter). */
export function jurisdictionLabel(code: string): string {
  if (code === "federal") return "Federal";
  const name = STATE_NAMES[code];
  return name ? `${name} (${code})` : code;
}

const CODE_BY_NAME: ReadonlyMap<string, string> = new Map(
  Object.entries(STATE_NAMES).map(([code, name]) => [name.toLowerCase(), code]),
);

/**
 * Free-text US state (as typed in an address) → 2-letter USPS code, or null.
 * Accepts a code in any case ("md") or the full name ("Maryland"); anything
 * else — a city, a province, a typo — is null, never a guess.
 */
export function normalizeUsState(text: string): string | null {
  const trimmed = text.trim();
  const upper = trimmed.toUpperCase();
  if (Object.hasOwn(STATE_NAMES, upper)) return upper;
  return CODE_BY_NAME.get(trimmed.toLowerCase()) ?? null;
}
