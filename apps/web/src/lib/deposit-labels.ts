/**
 * PAY-193 D9.6: shared labels for additional (shortfall) deposit rows — a row
 * with seq > 0 is an extra payment for a period whose earlier deposit was
 * already made. Used by the deposits list and the deposit detail page.
 */

/** True for an additional deposit (seq > 0). */
export function isAdditionalDeposit(row: { seq: number }): boolean {
  return row.seq > 0;
}

/** "December 2026" → "Additional deposit for December 2026" on a seq > 0 row. */
export function withAdditionalPrefix(row: { seq: number }, periodLabel: string): string {
  return isAdditionalDeposit(row) ? `Additional deposit for ${periodLabel}` : periodLabel;
}
