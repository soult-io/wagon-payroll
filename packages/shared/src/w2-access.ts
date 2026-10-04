/**
 * PAY-206 review round D9 (26 CFR 31.6051-1(j)(6)): the last day (ISO date) a
 * W-2 year furnished electronically stays downloadable after consent is
 * withdrawn — October 15 of taxYear+1, rolled to the next business day. Only
 * a weekend can move it: October 15-17 is never a federal holiday (Columbus
 * Day is the second Monday, October 8-14). Shared so the server gate and the
 * employee's W-2 card state the same date.
 *
 * PAY-208 ((j)(6), 2nd sentence): a corrected W-2 posted online stays
 * available through the later of that date and 90 days after the corrected
 * form is posted. `correctedPostedOn` = the company-local ISO date of the
 * latest corrected posting (null / omitted when there is none).
 */
export function electronicW2AccessThrough(
  taxYear: number,
  correctedPostedOn?: string | null,
): string {
  const d = new Date(Date.UTC(taxYear + 1, 9, 15));
  const dow = d.getUTCDay();
  if (dow === 6) d.setUTCDate(d.getUTCDate() + 2);
  if (dow === 0) d.setUTCDate(d.getUTCDate() + 1);
  const oct15 = d.toISOString().slice(0, 10);
  if (!correctedPostedOn) return oct15;
  const posted = new Date(`${correctedPostedOn.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(posted.getTime())) return oct15;
  posted.setUTCDate(posted.getUTCDate() + CORRECTED_W2_ACCESS_DAYS);
  const plus90 = posted.toISOString().slice(0, 10);
  return plus90 > oct15 ? plus90 : oct15;
}

/** PAY-208 ((j)(6)): days a corrected W-2 stays online after it is posted. */
export const CORRECTED_W2_ACCESS_DAYS = 90;

/**
 * Spec 24 (PAY-116) S24-D4: the first tax year whose W-2 pages are two-up
 * (the W-2 is the upper form of each copy page; the lower one is left blank
 * on purpose). The help text on the admin W-2 list and the employee W-2 card
 * shows from this year. Must equal the documents package's first two-up
 * year (w2LayoutFor) — a server test asserts it.
 */
export const W2_TWO_UP_FROM_YEAR = 2026;

/**
 * PAY-210 (PAY-208 brief §2.5): the first tax year whose W-2/W-3 review page
 * states that overtime pay, tips and Trump-account contributions are not
 * recorded by the app.
 */
export const W2_UNRECORDED_PAY_FROM_YEAR = 2026;

/** A postal address as stored on the company / W-2 contact (jsonb). */
export interface PostalAddress {
  line1: string;
  line2?: string | null | undefined;
  city: string;
  state: string;
  zip: string;
  country?: string | null | undefined;
}

/**
 * PAY-208 (26 CFR 31.6051-1(j)(3)(v)(A)): the person or department employees
 * write to about W-2s — name, mailing address, phone and email. The mailing
 * address is already resolved (the contact's own, else the company address).
 */
export interface W2Contact {
  name: string;
  phone: string;
  email: string;
  mailingAddress: PostalAddress | null;
}

/** "{line1}, {line2}, {city}, {state} {zip}" (line2 only when present). */
export function addressLine(a: PostalAddress | null | undefined): string {
  if (!a) return "";
  return [a.line1, a.line2, a.city, `${a.state} ${a.zip}`.trim()]
    .filter((p): p is string => typeof p === "string" && p.trim() !== "")
    .join(", ");
}

/** "2027-02-28" → "February 28, 2027" (a date only; no time zone shift). */
export function longIsoDate(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(d);
}
