/**
 * Spec 24 (PAY-116) PR-4 Q2 e2e — the W-2/W-3 filing detail for the CURRENT
 * year: state lines per W-2, the state tax check, the W-3 records-copy note,
 * and the "How to file" checklist. Ephemeral boot only (spec 14 §3): it
 * relies on apps/server/src/e2e/serve.ts inserting a current-year w2_w3
 * tax_filings row (status not_started, quarter 0) whose worksheet is filled
 * by refreshAnnualWorksheet. The QA seed (with the Q1 synthetic EIN) gives
 * Ada Testworth an IL line through the EIN default.
 *
 * Exact strings pinned: the rewritten download step (D-PL4) and C1 Illinois
 * (state SME final ruling 2026-10-04). Everything else is checked by
 * keyword: the UX copy may still move. Amounts depend on the clock, so the
 * test compares the two amounts on the Illinois tax-check line with each
 * other, never with literals. No download is clicked: before January 1 of
 * the next year the PDFs answer 409 invalid_transition.
 */

import { expect, test } from "@playwright/test";
import { step } from "./support/journey.js";
import { LIVE_QA, loadEphemeralState, newAuthedPage } from "./qa.js";

const DOWNLOAD_STEP =
  "Download the W-2 PDFs and the W-3 records copy on this page. An employee can have more than one W-2.";
const C1_IL =
  "Illinois: send your W-2s to the Illinois Department of Revenue electronically by January 31, or the next business day if January 31 falls on a weekend or holiday.";
const AMOUNT = /\$?([\d,]+\.\d{2})/;

test("ephemeral only: current-year W-2/W-3 detail shows IL state lines, the IL tax check, the W-3 records note and the IL checklist line (Spec 24 PR-4)", async ({
  browser,
}) => {
  test.skip(LIVE_QA, "relies on the ephemeral boot's current-year W-2/W-3 row (spec 14 §3)");
  const user = loadEphemeralState()?.admin;
  test.skip(!user, "ephemeral state missing — run the journeys first");
  if (!user) return;
  const year = String(new Date().getFullYear());
  const page = await newAuthedPage(browser, user);
  try {
    await step(page, "Open this year's W-2/W-3 filing", async () => {
      await page.goto(`/admin/filings?year=${year}`);
      const row = page
        .locator("tbody tr", { hasText: "W-2/W-3" })
        .filter({ hasText: year })
        .first();
      await expect(row).toBeVisible();
      await row.click();
      await expect(
        page.getByRole("heading", { name: new RegExp(`Forms W-2/W-3 — ${year}`) }),
      ).toBeVisible();
    });

    await step(page, "Ada's W-2 row shows an IL state line with box 16 and box 17", async () => {
      const ada = page.locator("tbody tr", { hasText: "Ada Testworth" }).first();
      await expect(ada).toBeVisible();
      const cell = ada.locator("td", { hasText: /\bIL\b/ }).first();
      await expect(cell).toBeVisible();
      await expect(cell).toHaveText(/\bIL\b\D*[\d,]+\.\d{2}\D*[\d,]+\.\d{2}/);
    });

    await step(
      page,
      "State tax check: Illinois W-2s amount equals issued pay runs amount",
      async () => {
        const card = page.locator("section, div", {
          has: page.getByRole("heading", { name: /State tax check/i }),
        });
        const il = card
          .getByText(/Illinois|\bIL\b/)
          .filter({ hasText: /pay runs/ })
          .first();
        await expect(il).toBeVisible();
        const text = (await il.textContent()) ?? "";
        const w2 = AMOUNT.exec(text.slice(text.search(/W-2s/)))?.[1];
        const runs = AMOUNT.exec(text.slice(text.search(/pay runs/)))?.[1];
        expect(w2, `no W-2s amount in "${text}"`).toBeTruthy();
        expect(runs, `no pay-runs amount in "${text}"`).toBeTruthy();
        expect(w2).toBe(runs);
      },
    );

    await step(page, 'W-3 records-copy note visible; "Company settings" nowhere', async () => {
      await expect(page.getByText(/W-3 is for your records/).first()).toBeVisible();
      await expect(page.getByText(/Business Services Online/).first()).toBeVisible();
      await expect(page.getByText("Company settings")).toHaveCount(0);
      await expect(page.getByText("W-3 transmittal PDF")).toHaveCount(0);
    });

    await step(page, "How to file: the rewritten download step and the Illinois line", async () => {
      await page.getByRole("button", { name: "How to file" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(DOWNLOAD_STEP);
      await expect(dialog).toContainText(C1_IL);
    });
  } finally {
    await page.context().close();
  }
});
