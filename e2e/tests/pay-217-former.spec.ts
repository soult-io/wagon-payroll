/**
 * PAY-217 T-27 e2e — a former employee keeps W-2-only sign-in through the
 * (j)(6) window; the admin sees them on the W-2/W-3 page. Ephemeral boot
 * only (synthetic PGlite, spec 14 §3). payroll-calc-auditor, fail-first
 * against faad1d9; the coder may not edit this file.
 *
 * Seed contract assumed (apps/server/src/e2e/serve.ts, written by the coder):
 * e2e/.state/state.json gains
 *   former:       { email, password, totpSecret, legalName, taxYear } —
 *                 a terminated W-2 employee whose `taxYear` W-2 was
 *                 furnished online (a portal_notice row carrying the CURRENT
 *                 figures) and whose window is open on the real boot date;
 *                 a W-2/W-3 tax_filings row for `taxYear` exists.
 *   formerClosed: { email, password, totpSecret } — a terminated employee
 *                 whose only online year's window has closed (banned
 *                 w2_access_ended, as the daily job leaves it).
 * The server clock cannot be moved in a browser run, so "after the window
 * the sign-in is refused" is the formerClosed persona, not a clock jump
 * (the clock-driven edges are server tests T-3, T-19, T-21).
 *
 * Copy is checked by keyword (product-ux-designer owns the final words):
 * screen heading "Your W-2s from …", "Your job with … has ended", nav item
 * "Your W-2s"; admin section heading "Former employees who can still get
 * this W-2 online", sign-in state "Can sign in", action "Mark handed on
 * paper", result "Handed".
 */

import { expect, type Page, test } from "@playwright/test";
import { step } from "./support/journey.js";
import { LIVE_QA, loadEphemeralState, newAuthedPage, totp } from "./qa.js";

interface Persona {
  email: string;
  password: string;
  totpSecret: string;
  legalName?: string;
  taxYear?: number;
}

function personas(): { former?: Persona; formerClosed?: Persona } {
  return (loadEphemeralState() ?? {}) as unknown as { former?: Persona; formerClosed?: Persona };
}

/** Password step; true when the TOTP challenge appears. */
async function passwordStep(page: Page, p: Persona): Promise<boolean> {
  await page.goto("/login");
  await page.locator("#email").fill(p.email);
  await page.locator("#password input").fill(p.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  return page
    .locator("#totp")
    .waitFor({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
}

/** Session routes a former employee must never be sent to on load (they answer 403 w2_access_only). */
const REFUSED = [
  /\/api\/my\/profile/,
  /\/api\/change-requests/,
  /\/api\/payslips/,
  /\/api\/my\/w2\/consent/,
  /\/api\/admin\//,
];

test("PAY-217 T-27 former employee: TOTP sign-in lands on the W-2 card only, downloads, cannot reach other screens; a closed window refuses sign-in; the admin sees and marks paper", async ({
  browser,
}) => {
  test.skip(
    LIVE_QA,
    "relies on the ephemeral boot's synthetic former-employee personas (spec 14 §3)",
  );
  const state = loadEphemeralState();
  test.skip(!state, "ephemeral state missing — run the journeys first");
  const { former, formerClosed } = personas();
  expect(former, "state.json has no `former` persona (PAY-217 seed)").toBeTruthy();
  expect(formerClosed, "state.json has no `formerClosed` persona (PAY-217 seed)").toBeTruthy();
  if (!former || !formerClosed || !state) return;
  const year = String(former.taxYear);

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const refusedCalls: string[] = [];
  page.on("response", async (res) => {
    const url = res.url();
    if (REFUSED.some((r) => r.test(url))) refusedCalls.push(`${res.status()} ${url}`);
    if (res.status() === 403) {
      const body = await res.text().catch(() => "");
      if (body.includes("w2_access_only")) refusedCalls.push(`403 w2_access_only ${url}`);
    }
  });
  try {
    await step(
      page,
      "Former employee signs in with password + TOTP and lands on /my/w2",
      async () => {
        expect(await passwordStep(page, former)).toBe(true);
        await page.locator("#totp").fill(await totp(former.totpSecret));
        await page.getByRole("button", { name: "Verify", exact: true }).click();
        await page.waitForURL(/\/my\/w2$/);
        await expect(page.getByRole("heading", { name: /Your W-2s from/ })).toBeVisible();
        await expect(page.getByText(/Your job with .+ has ended/)).toBeVisible();
      },
    );

    await step(
      page,
      "Only the W-2 card: the year is listed with Download PDF; no payslips, profile or requests nav",
      async () => {
        await expect(page.getByText(new RegExp(`${year} W-2`)).first()).toBeVisible();
        await expect(page.getByRole("link", { name: /Download .*PDF/ }).first()).toBeVisible();
        for (const label of [/^Payslips$/, /^Profile$/, /^Requests$/, /^Settings$/]) {
          await expect(page.getByRole("link", { name: label })).toHaveCount(0);
        }
        expect(refusedCalls).toEqual([]);
      },
    );

    await step(page, "The PDF downloads (200, application/pdf)", async () => {
      const res = await page.request.get(`/api/my/w2/${year}/pdf`);
      expect([res.status(), res.headers()["content-type"]]).toEqual([200, "application/pdf"]);
    });

    await step(
      page,
      "A typed URL to payslips, profile or the admin area goes back to /my/w2",
      async () => {
        for (const path of ["/my/payslips", "/my/profile", "/admin/dashboard", "/"]) {
          await page.goto(path);
          await page.waitForURL(/\/my\/w2$/);
        }
        expect(refusedCalls).toEqual([]);
      },
    );
  } finally {
    await ctx.close();
  }

  const closedCtx = await browser.newContext();
  const closedPage = await closedCtx.newPage();
  try {
    await step(closedPage, "A former employee whose window closed cannot sign in", async () => {
      expect(await passwordStep(closedPage, formerClosed)).toBe(false);
      await expect(closedPage).toHaveURL(/\/login/);
    });
  } finally {
    await closedCtx.close();
  }

  const admin = await newAuthedPage(browser, state.admin);
  try {
    await step(
      admin,
      `Admin: the ${year} W-2/W-3 page lists the former employee who can still sign in`,
      async () => {
        await admin.goto(`/admin/filings?year=${year}`);
        const row = admin
          .locator("tbody tr", { hasText: "W-2/W-3" })
          .filter({ hasText: year })
          .first();
        await expect(row).toBeVisible();
        await row.click();
        const section = admin.locator("section, div", {
          has: admin.getByRole("heading", {
            name: /Former employees who can still get this W-2 online/,
          }),
        });
        await expect(section.first()).toBeVisible();
        const person = section
          .first()
          .getByText(former.legalName ?? "")
          .first();
        await expect(person).toBeVisible();
        await expect(
          section
            .first()
            .getByText(/Can sign in/)
            .first(),
        ).toBeVisible();
      },
    );

    await step(admin, "Admin marks the paper copy handed; the row shows Handed", async () => {
      const section = admin
        .locator("section, div", {
          has: admin.getByRole("heading", {
            name: /Former employees who can still get this W-2 online/,
          }),
        })
        .first();
      await section
        .getByRole("button", { name: /Mark handed on paper/ })
        .first()
        .click();
      // C3 (round 2): the action asks for confirmation first (confirm.require).
      const dialog = admin.locator('[role="alertdialog"], [role="dialog"]').first();
      await expect(dialog).toBeVisible();
      await expect(section.getByText(/Handed/)).toHaveCount(0);
      await dialog
        .getByRole("button", { name: /Yes|Confirm|Mark/ })
        .first()
        .click();
      await expect(section.getByText(/Handed/).first()).toBeVisible();
    });
  } finally {
    await admin.context().close();
  }
});
