/**
 * Spec 24 (PAY-116) PR-1 e2e — "State tax account numbers" on the admin
 * Company tab. Mutating → ephemeral PGlite boot only (spec 14 §3).
 *
 * Saves a synthetic California number and checks the write-only rules the
 * browser can see (Spec 24 L10): only the server mask is shown, the input is
 * cleared after save, and the number is not in the URL, localStorage or
 * sessionStorage.
 */

import { expect, test } from "@playwright/test";
import { LIVE_QA, loadEphemeralState, newAuthedPage } from "./qa.js";

const SYNTHETIC_CA_ID = "00000417";

test("ephemeral only: save a state account number and see only its mask", async ({ browser }) => {
  test.skip(LIVE_QA, "mutating — live QA is read-only (spec 14 §3)");
  const user = loadEphemeralState()?.admin;
  test.skip(!user, "ephemeral state missing — run the journeys first");
  if (!user) return;
  const page = await newAuthedPage(browser, user);
  try {
    await page.goto("/admin/config");
    await page.getByRole("tab", { name: "Company" }).click();
    const card = page.locator("section", {
      has: page.getByRole("heading", { name: "State tax account numbers" }),
    });
    await expect(card.getByText("It goes in box 15 of each W-2.")).toBeVisible();

    await card.locator(".p-select").first().click();
    await page.locator(".p-select-filter").fill("Califor");
    await page.getByRole("option", { name: "California", exact: true }).click();
    // A format error is caught in the browser: shown under the field, value kept.
    await card.locator("#stateIdValue").fill("1234567");
    await card.getByRole("button", { name: "Save account number" }).click();
    await expect(card.locator("#stateIdValueError")).toContainText(
      "California account numbers have 8 digits",
    );
    await expect(card.locator("#stateIdValue")).toHaveAttribute("aria-invalid", "true");
    await expect(card.locator("#stateIdValue")).toHaveValue("1234567");

    await card.locator("#stateIdValue").fill(SYNTHETIC_CA_ID);
    await card.getByRole("button", { name: "Save account number" }).click();

    await expect(card.getByRole("cell", { name: "••••0417" })).toBeVisible();
    await expect(card.locator("#stateIdValue")).toHaveValue("");
    await expect(page.getByText(SYNTHETIC_CA_ID)).toHaveCount(0);

    expect(page.url()).not.toContain(SYNTHETIC_CA_ID);
    const stored = await page.evaluate(() => {
      const dump = (s: Storage) =>
        Array.from({ length: s.length }, (_, i) => {
          const k = s.key(i) ?? "";
          return `${k}=${s.getItem(k) ?? ""}`;
        }).join("\n");
      return `${dump(window.localStorage)}\n${dump(window.sessionStorage)}`;
    });
    expect(stored).not.toContain(SYNTHETIC_CA_ID);

    // Removing asks first; "Keep it" leaves the number, "Remove number" removes it.
    await card.getByRole("button", { name: /Remove California number/ }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByText("Remove California account number?")).toBeVisible();
    await dialog.getByRole("button", { name: "Keep it" }).click();
    await expect(card.getByRole("cell", { name: "••••0417" })).toBeVisible();
    await card.getByRole("button", { name: /Remove California number/ }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove number" }).click();
    await expect(card.getByRole("cell", { name: "••••0417" })).toHaveCount(0);
  } finally {
    await page.close();
  }
});
