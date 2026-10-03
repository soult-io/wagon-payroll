/**
 * PAY-206 review round D9 (26 CFR 31.6051-1(j)(6)): the last day (ISO date) a
 * W-2 year furnished electronically stays downloadable after consent is
 * withdrawn — October 15 of taxYear+1, rolled to the next business day. Only
 * a weekend can move it: October 15-17 is never a federal holiday (Columbus
 * Day is the second Monday, October 8-14). Shared so the server gate and the
 * employee's W-2 card state the same date.
 */
export function electronicW2AccessThrough(taxYear: number): string {
  const d = new Date(Date.UTC(taxYear + 1, 9, 15));
  const dow = d.getUTCDay();
  if (dow === 6) d.setUTCDate(d.getUTCDate() + 2);
  if (dow === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
