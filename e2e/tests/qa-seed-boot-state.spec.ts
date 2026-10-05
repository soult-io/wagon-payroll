/**
 * PAY-81 / year-rollover guard brief §4.3 (payroll-calc-auditor, fail-first;
 * the coder may not edit this file). Ephemeral boot only.
 *
 * Contract assumed: apps/server/src/e2e/serve.ts writes, from the QA seed's
 * own summary (never from `new Date()`),
 *   state.json.qa = { latestCoveredYear, historyThrough, draftPeriod, w2Year }
 * with w2Year = latestCoveredYear, and upserts the W-2/W-3 row for w2Year
 * instead of the calendar year. Years and months only (no PII).
 *
 * The expected values are derived from the server's "today". The Playwright
 * runner shares the server's clock (the clock-shift job passes the same
 * --import preload through NODE_OPTIONS to both), and serve.ts seeds for the
 * UTC date, so the runner's UTC date is the seed date. The browser clock is
 * never used here.
 *
 * Rules (owner decision D-C = C1, brief D-A = A1):
 *   L = latestCoveredYear <= Y (today's year).
 *   L = Y → historyThrough = last month (Dec of Y−1 in January), draftPeriod = this month.
 *   L < Y → historyThrough = L-12, draftPeriod = null (no current-period draft).
 */

import { expect, test } from "@playwright/test";
import { LIVE_QA, QA_ADMIN, loadEphemeralState, newAuthedPage } from "./qa.js";

interface QaBootFacts {
  latestCoveredYear: number;
  historyThrough: string | null;
  draftPeriod: string | null;
  w2Year: number;
}

const ym = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;

test("ephemeral boot: state.json carries the QA seed's covered year, history end, draft period and W-2 year (PAY-81)", async ({
  browser,
}) => {
  test.skip(LIVE_QA, "ephemeral boot only: state.json is written by e2e:serve");

  const state = loadEphemeralState() as
    | (ReturnType<typeof loadEphemeralState> & { qa?: QaBootFacts })
    | null;
  expect(state, "e2e/.state/state.json written by e2e:serve").not.toBeNull();
  const qa = state?.qa;
  expect(qa, "state.json has a qa block from the seed summary").toBeDefined();
  if (!qa) return;

  const now = new Date();
  const Y = now.getUTCFullYear();
  const M = now.getUTCMonth() + 1;
  const L = qa.latestCoveredYear;

  expect(Number.isInteger(L)).toBe(true);
  expect(L).toBeLessThanOrEqual(Y);
  // 2026 tables are bundled; tables are only ever added.
  expect(L).toBeGreaterThanOrEqual(2026);
  expect(qa.w2Year).toBe(L);
  if (L === Y) {
    expect({ historyThrough: qa.historyThrough, draftPeriod: qa.draftPeriod }).toEqual({
      historyThrough: M === 1 ? ym(Y - 1, 12) : ym(Y, M - 1),
      draftPeriod: ym(Y, M),
    });
  } else {
    expect({ historyThrough: qa.historyThrough, draftPeriod: qa.draftPeriod }).toEqual({
      historyThrough: ym(L, 12),
      draftPeriod: null,
    });
  }

  // Cross-check against what the server actually holds (read-only API).
  const page = await newAuthedPage(browser, QA_ADMIN);
  try {
    const filingsRes = await page.request.get("/api/admin/tax-filings?formType=w2_w3");
    expect(filingsRes.status()).toBe(200);
    const { filings } = (await filingsRes.json()) as { filings: { year: number }[] };
    const w2Years = filings.map((f) => f.year);
    // The boot's W-2/W-3 row is for w2Year, never for an uncovered later year.
    expect(w2Years).toContain(qa.w2Year);
    expect(w2Years.filter((y) => y > qa.w2Year)).toEqual([]);

    const through = qa.historyThrough;
    expect(through).not.toBeNull();
    if (through) {
      const issuedRes = await page.request.get(
        `/api/admin/payroll-runs?status=issued&year=${through.slice(0, 4)}`,
      );
      expect(issuedRes.status()).toBe(200);
      const { runs: issued } = (await issuedRes.json()) as { runs: { periodStart: string }[] };
      const lastIssued = issued
        .map((r) => r.periodStart.slice(0, 7))
        .sort()
        .at(-1);
      expect(lastIssued).toBe(through);
    }

    const pendingRes = await page.request.get("/api/admin/payroll-runs?status=awaiting_approval");
    expect(pendingRes.status()).toBe(200);
    const { runs: pending } = (await pendingRes.json()) as {
      runs: { periodStart: string; payDate: string }[];
    };
    const pendingThisYear = pending
      .filter((r) => r.payDate.startsWith(`${Y}-`))
      .map((r) => r.periodStart.slice(0, 7));
    expect(pendingThisYear).toEqual(qa.draftPeriod ? [qa.draftPeriod] : []);
  } finally {
    await page.context().close();
  }
});
