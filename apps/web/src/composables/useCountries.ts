/**
 * Country choices for forms (PAY-163): every ISO 3166-1 alpha-2 region the
 * browser can name, English names from Intl.DisplayNames, sorted by name.
 * Reserved / user-assigned codes (EU, UN, XA…) are left out; Kosovo (XK) is
 * kept because it is in common use.
 */

export interface CountryOption {
  code: string;
  name: string;
}

// Reserved and exceptionally reserved codes that name no country of residence:
// AC Ascension, CP Clipperton, DG Diego Garcia, EA Ceuta & Melilla, IC Canary
// Islands, TA Tristan da Cunha (ISO exceptional reservations), QO Outlying Oceania.
const NOT_COUNTRIES = new Set([
  "AA",
  "AC",
  "CP",
  "DG",
  "EA",
  "EU",
  "EZ",
  "IC",
  "QO",
  "TA",
  "UN",
  "ZZ",
]);

function reserved(code: string): boolean {
  if (NOT_COUNTRIES.has(code)) return true;
  if (code.startsWith("Q") && code >= "QM") return true; // QM–QZ user-assigned
  return code.startsWith("X") && code !== "XK"; // XA–XZ user-assigned
}

let cached: CountryOption[] | null = null;

export function countryOptions(): CountryOption[] {
  if (cached) return cached;
  const names = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const list: CountryOption[] = [];
  for (const a of letters) {
    for (const b of letters) {
      const code = a + b;
      if (reserved(code)) continue;
      const name = names.of(code);
      if (name && name !== code) list.push({ code, name });
    }
  }
  list.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  cached = list;
  return list;
}

/** "ES" → "Spain"; an unknown code is returned as is. */
export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region", fallback: "code" }).of(code) ?? code;
  } catch {
    return code;
  }
}
