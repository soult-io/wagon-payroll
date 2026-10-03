/**
 * Date/time display composable: DB TIMESTAMPTZ + ISO dates → display in the
 * app timezone (spec 1: Europe/Madrid display, DB stores UTC).
 */

import { APP_TIMEZONE } from "@payroll/shared";

export function useDates() {
  /** "2025-06-15" → "15 Jun 2025" (date-only values stay date-only). */
  function date(iso: string | null | undefined): string {
    if (!iso) return "—";
    const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
    if (Number.isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    }).format(d);
  }

  /**
   * Long US date for owner-facing copy (PAY-193 L4): "2026-12-31" →
   * "December 31, 2026"; a TIMESTAMPTZ is read in the display timezone.
   */
  function longDate(iso: string | null | undefined): string {
    if (!iso) return "—";
    const dateOnly = iso.length === 10;
    const d = new Date(dateOnly ? `${iso}T00:00:00Z` : iso);
    if (Number.isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: dateOnly ? "UTC" : APP_TIMEZONE,
    }).format(d);
  }

  /** TIMESTAMPTZ → "15 Jun 2025, 10:24" in the display timezone. */
  function dateTime(iso: string | null | undefined): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: APP_TIMEZONE,
    }).format(d);
  }

  /** DatePicker (Date) → "YYYY-MM-DD" wire format; null-safe. */
  function toIso(d: Date | null | undefined): string | undefined {
    if (!d) return undefined;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  /** "YYYY-MM-DD" → Date for DatePicker models. */
  function fromIso(iso: string | null | undefined): Date | null {
    if (!iso) return null;
    const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  return { date, longDate, dateTime, toIso, fromIso };
}
