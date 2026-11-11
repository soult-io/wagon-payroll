/**
 * Critical user journeys (hardening B) — real browser against the real app:
 * built SPA served by Fastify, backed by in-memory PGlite (e2e:serve boot).
 *
 * Serial: journeys share the single in-memory database and build on each
 * other (journey 1 onboards the employee that 2 and 3 then use).
 *
 * TOTP is driven by computing codes from the enrollment secret with the same
 * @better-auth/utils OTP implementation the server uses (async — always
 * await .totp()). Codes rotate every 30s, so each submission retries once
 * with a fresh code when the first lands on a period boundary.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page, type Response } from "@playwright/test";
import { createOTP } from "@better-auth/utils/otp";
import { base32 } from "@better-auth/utils/base32";
import { EPHEMERAL_EMPLOYEE_NAME } from "./qa.js";
import { step } from "./support/journey.js";
import { newContext } from "./support/walkthrough.js";

test.describe.configure({ mode: "serial" });

interface E2EState {
  baseUrl: string;
  admin: { email: string; password: string; totpSecret: string };
  employee: { email: string; inviteUrl: string };
  run: { publicId: string };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(HERE, "../.state");
/**
 * Ephemeral-mode fixture state, written by @payroll/server's e2e:serve boot.
 * In live-QA mode (E2E_BASE_URL) there is no state file and these journeys
 * are skipped outright — live QA is a shared environment and the journeys
 * MUTATE data (onboarding, issuing payroll runs, approving change requests).
 */
const STATE = (
  process.env.E2E_BASE_URL
    ? null
    : JSON.parse(readFileSync(resolve(STATE_DIR, "state.json"), "utf8"))
) as E2EState;

test.skip(
  Boolean(process.env.E2E_BASE_URL),
  "journeys are ephemeral-fixture only — live QA is read-only (spec 14 §3)",
);

/**
 * Saved browser sessions (storageState, written into the gitignored .state
 * dir). The app rate-limits credential endpoints to 10 req/min — every fresh
 * login costs 2 (sign-in + TOTP verify) — so journey 1 (which exercises
 * login itself) saves the employee session and journey 2 saves the admin
 * session; later journeys restore them instead of logging in again.
 */
const EMPLOYEE_SESSION = resolve(STATE_DIR, "employee-storage.json");
const ADMIN_SESSION = resolve(STATE_DIR, "admin-storage.json");

const EMPLOYEE_PASSWORD = "e2e-employee-passphrase-47";

const NEW_ADDRESS = {
  line1: "742 Evergreen Terrace",
  city: "Springfield",
  state: "IL",
  zip: "62704",
  country: "US",
};

async function totp(secret: string): Promise<string> {
  return createOTP(secret, { digits: 6, period: 30 }).totp();
}

/** Fill the login TOTP challenge and submit, retrying once on a period boundary. */
async function submitLoginTotp(page: Page, secret: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.locator("#totp").fill(await totp(secret));
    await page.getByRole("button", { name: "Verify", exact: true }).click();
    // Admins now land on /admin/dashboard (PAY-31), employees on /my/dashboard.
    const landed = await page
      .waitForURL(/\/(my|admin)\/dashboard/, { timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    if (landed) return;
    if (attempt === 1) throw new Error("login TOTP failed twice");
  }
}

/** Full browser login: password step → TOTP challenge → dashboard. */
async function loginAs(
  page: Page,
  user: { email: string; password: string; secret: string },
): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(user.email);
  await page.locator("#password input").fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator("#totp")).toBeVisible();
  await submitLoginTotp(page, user.secret);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
}

/** Sign out and assert we are back on the login screen. */
async function logout(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL("**/login");
}

test("journey 1: invite onboarding wizard → backup codes → fresh login with TOTP", async ({
  page,
}) => {
  let totpEnable: Promise<Response> | undefined;
  await step(page, "Set a password from the invite link", async () => {
    await page.goto(STATE.employee.inviteUrl);
    // Token verified on load.
    await expect(page.locator("#pw input")).toBeVisible();
    await page.locator("#pw input").fill(EMPLOYEE_PASSWORD);
    await page.locator("#pw2 input").fill(EMPLOYEE_PASSWORD);
    totpEnable = page.waitForResponse(
      (r) => r.url().includes("/api/onboarding/totp-enable") && r.ok(),
    );
    await page.getByRole("button", { name: "Set password" }).click();
  });

  // TOTP enrollment: secret from the intercepted totpURI payload.
  // NOTE: createOTP().url() base32-ENCODES the raw secret into the URI, while
  // totp()/verify() HMAC the raw string — decode before computing codes.
  let secret = "";
  await step(page, "Enrol an authenticator app (TOTP)", async () => {
    if (!totpEnable) throw new Error("totp-enable response was never awaited");
    const { totpURI } = (await (await totpEnable).json()) as { totpURI: string };
    const uriSecret = new URL(totpURI).searchParams.get("secret");
    if (!uriSecret) throw new Error(`no secret in totpURI: ${totpURI}`);
    secret = new TextDecoder().decode(base32.decode(uriSecret));

    await expect(page.getByAltText("TOTP QR code")).toBeVisible();
    await page.locator("#code").fill(await totp(secret));
    await page.getByRole("button", { name: "Verify and finish setup" }).click();
  });

  await step(page, "Backup codes are shown once", async () => {
    // 10, server-side default.
    await expect(page.locator(".codes li").first()).toBeVisible();
    await expect(page.locator(".codes li")).toHaveCount(10);
  });

  await step(page, "Sign in with password + TOTP", async () => {
    await page.getByRole("button", { name: "Continue to sign in" }).click();
    await page.waitForURL("**/login");
    await loginAs(page, {
      email: STATE.employee.email,
      password: EMPLOYEE_PASSWORD,
      secret,
    });
  });

  await step(page, "Sign out and sign in again", async () => {
    // The session is genuinely re-establishable.
    await logout(page);
    await loginAs(page, {
      email: STATE.employee.email,
      password: EMPLOYEE_PASSWORD,
      secret,
    });
  });

  // Save the session for journeys 2/3 (credential endpoints are rate-limited
  // 10/min — reusing storageState avoids spending logins there).
  await page.context().storageState({ path: EMPLOYEE_SESSION });
});

test("journey 2: admin approves + issues payroll run; employee sees payslip + PDF", async ({
  page,
  browser,
}) => {
  await step(page, "Admin signs in", async () => {
    await loginAs(page, {
      email: STATE.admin.email,
      password: STATE.admin.password,
      secret: STATE.admin.totpSecret,
    });
  });
  await page.context().storageState({ path: ADMIN_SESSION }); // journey 3 reuses it

  await step(page, "Open the run awaiting approval", async () => {
    // The list defaults to the current year — our seeded run is 2025-11, so
    // switch the year filter first.
    await page.goto("/admin/payroll");
    await page.locator(".p-select").first().click();
    await page.getByRole("option", { name: "2025" }).click();
    const row = page.locator("tr", { hasText: "Awaiting approval" }).first();
    await expect(row).toBeVisible();
    await row.click();
    await page.waitForURL(`**/admin/payroll/${STATE.run.publicId}**`);
    await expect(page.locator(".p-tag", { hasText: "Awaiting approval" })).toBeVisible();
    await expect(page.getByText("$3,383.87")).toBeVisible(); // golden net pay, $4,000/mo
  });

  await step(page, "Approve the run", async () => {
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await page.locator(".p-confirmdialog").getByRole("button", { name: "Approve" }).click();
    await expect(page.locator(".p-tag", { hasText: "Approved" })).toBeVisible();
  });

  await step(page, "Issue the payslip (type-to-confirm)", async () => {
    await page.getByRole("button", { name: "Issue payslip" }).click();
    await page.locator(".p-dialog input[placeholder='ISSUE']").fill("ISSUE");
    await page.locator(".p-dialog").getByRole("button", { name: "Issue payslip" }).click();
    await expect(page.locator(".p-tag", { hasText: "Issued" })).toBeVisible();
  });

  // Employee session (separate context, restored from journey 1's saved
  // storageState): issued payslip visible + PDF bytes.
  const ctx = await newContext(browser, { storageState: EMPLOYEE_SESSION });
  const emp = await ctx.newPage();
  await step(emp, "Employee opens the issued payslip", async () => {
    await emp.goto("/my/payslips");
    const slip = emp.locator("tr", { hasText: "$3,383.87" }).first();
    await expect(slip).toBeVisible();
    await slip.click();
    await emp.waitForURL(`**/my/payslips/${STATE.run.publicId}**`);
  });

  await step(emp, "Payslip PDF downloads (%PDF, non-trivial size)", async () => {
    const pdf = await emp.request.get(`/api/payslips/${STATE.run.publicId}/pdf`);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-type"]).toContain("application/pdf");
    const body = await pdf.body();
    expect(body.subarray(0, 5).toString()).toBe("%PDF-");
    expect(body.length).toBeGreaterThan(2000);
  });

  await ctx.close();
});

test("journey 3: address change request round-trip (employee → admin approve → applied)", async ({
  browser,
}) => {
  // Employee session restored from journey 1's storageState (rate-limit budget).
  const empCtx = await newContext(browser, { storageState: EMPLOYEE_SESSION });
  const page = await empCtx.newPage();
  await step(page, "Employee fills in a new address", async () => {
    await page.goto("/my/requests/new");
    await page
      .getByRole("button", { name: /Address/ })
      .first()
      .click();
    await page.locator("#line1").fill(NEW_ADDRESS.line1);
    await page.locator("#city").fill(NEW_ADDRESS.city);
    await page.locator("#state").fill(NEW_ADDRESS.state);
    await page.locator("#zip").fill(NEW_ADDRESS.zip);
    await page.locator("#country").fill(NEW_ADDRESS.country);
    await page.getByRole("button", { name: "Review", exact: true }).click();
    await expect(page.getByText(NEW_ADDRESS.line1)).toBeVisible(); // review shows payload
  });

  const publicId = await step(page, "Employee submits the request (Pending)", async () => {
    await page.getByRole("button", { name: "Submit request" }).click();
    await page.waitForURL(/\/my\/requests\/[0-9a-f-]{36}/);
    await expect(page.locator(".p-tag", { hasText: "Pending" })).toBeVisible();
    const id = page.url().split("/").pop();
    if (!id) throw new Error("no publicId in request URL");
    return id;
  });

  // Admin reviews the diff and approves (session from journey 2's storageState).
  const ctx = await newContext(browser, { storageState: ADMIN_SESSION });
  const admin = await ctx.newPage();
  await step(admin, "Admin reviews the proposed vs current address", async () => {
    await admin.goto("/admin/requests");
    // Scoped to this journey's own employee: the QA dataset seeds Carol's
    // pending address change too, so "the first Address row" is only this one
    // by accident of the list's descending submitted-at order.
    const row = admin
      .locator("tr", { hasText: "Address" })
      .filter({ hasText: EPHEMERAL_EMPLOYEE_NAME })
      .first();
    await expect(row).toBeVisible();
    await row.click();
    await admin.waitForURL(`**/admin/requests/${publicId}**`);
    await expect(admin.getByText(NEW_ADDRESS.line1)).toBeVisible(); // proposed
    await expect(admin.getByText("Not on file")).toBeVisible(); // current
  });

  await step(admin, "Admin approves and applies", async () => {
    await admin.getByRole("button", { name: "Approve & apply" }).click();
    await expect(admin.locator(".p-tag", { hasText: "Approved" })).toBeVisible();
  });
  await ctx.close();

  await step(page, "Employee sees Approved and the new address on the profile", async () => {
    await page.reload();
    await expect(page.locator(".p-tag", { hasText: "Approved" })).toBeVisible();
    await page.goto("/my/profile");
    await expect(page.getByText(NEW_ADDRESS.line1)).toBeVisible();
    await expect(page.getByText(NEW_ADDRESS.city)).toBeVisible();
  });
  await empCtx.close();
});

test("journey 4: session expiry mid-session redirects to login (PAY-6)", async ({ browser }) => {
  // Employee session from journey 1; clearing cookies simulates the session
  // expiring (or being revoked) while the SPA is already open.
  const ctx = await newContext(browser, { storageState: EMPLOYEE_SESSION });
  const page = await ctx.newPage();
  await step(page, "Employee is on the dashboard", async () => {
    await page.goto("/my/dashboard");
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  });

  await step(page, "Session expires; next navigation lands on login", async () => {
    await ctx.clearCookies();
    // SPA navigation fires an authed API call with the dead session → 401 →
    // the handler redirects straight to /login instead of toasting errors.
    await page.getByRole("link", { name: "Payslips", exact: true }).click();
    await page.waitForURL("**/login**");
    await expect(page.locator("#email")).toBeVisible();
    // The attempted path is preserved for post-login return.
    expect(page.url()).toContain("redirect=/my/payslips");
  });
  await ctx.close();
});

test("journey 5: back navigation preserves the list filter state (PAY-17)", async ({ browser }) => {
  // Admin session from journey 2; the seeded run (2025-11, issued in journey 2)
  // lives outside the default current-year filter.
  const ctx = await newContext(browser, { storageState: ADMIN_SESSION });
  const page = await ctx.newPage();
  // Scoped to THIS journey's own employee: the boot now also seeds the QA
  // dataset (PAY-56), so "the first issued row" is some other persona's run.
  // A test that only passes against a near-empty database is not a test.
  const issuedRow = () =>
    page.locator("tr", { hasText: "Issued" }).filter({ hasText: EPHEMERAL_EMPLOYEE_NAME }).first();

  await step(page, "Filter the runs list to 2025 (the URL carries it)", async () => {
    await page.goto("/admin/payroll");
    await page.locator(".p-select").first().click();
    await page.getByRole("option", { name: "2025" }).click();
    await expect(page).toHaveURL(/\/admin\/payroll\?year=2025/);
  });

  await step(page, "Open the run; the filter rides along", async () => {
    await expect(issuedRow()).toBeVisible();
    await issuedRow().click();
    await expect(page).toHaveURL(new RegExp(`/admin/payroll/${STATE.run.publicId}\\?year=2025`));
  });

  await step(page, "Back to runs keeps the 2025 filter", async () => {
    await page.getByRole("button", { name: "Back to runs" }).click();
    await expect(page).toHaveURL(/\/admin\/payroll\?year=2025/);
    await expect(page.locator(".p-select").first()).toContainText("2025");
    await expect(issuedRow()).toBeVisible();
  });

  await step(page, "Browser back keeps the 2025 filter too", async () => {
    // Query-param-driven filters make it free.
    await issuedRow().click();
    await expect(page).toHaveURL(new RegExp(`/admin/payroll/${STATE.run.publicId}\\?year=2025`));
    await page.goBack();
    await expect(page).toHaveURL(/\/admin\/payroll\?year=2025/);
    await expect(page.locator(".p-select").first()).toContainText("2025");
  });
  await ctx.close();
});

test("journey 6: admin user visiting /my/dashboard is redirected to /admin/dashboard", async ({
  browser,
}) => {
  // Fresh context with the admin session saved in journey 2.
  const ctx = await newContext(browser, { storageState: ADMIN_SESSION });
  const page = await ctx.newPage();

  await step(page, "Admin visiting /my/dashboard lands on /admin/dashboard", async () => {
    await page.goto("/my/dashboard");
    await page.waitForURL("**/admin/dashboard");
  });

  await step(page, "Admin visiting / lands on /admin/dashboard", async () => {
    await page.goto("/");
    await page.waitForURL("**/admin/dashboard");
  });

  // Spec 22 (PAY-66): the header shows the product name; the "Payroll" nav
  // item names the feature and still routes to the payroll list.
  await step(
    page,
    "Header shows the product name; Payroll nav opens the payroll list",
    async () => {
      await expect(page.locator(".topbar .brand")).toHaveText("Wagon Payroll");
      await expect(page).toHaveTitle("Wagon Payroll");
      await page
        .locator(".topbar .nav")
        .getByRole("link", { name: "Payroll", exact: true })
        .click();
      await page.waitForURL(/\/admin\/payroll(\?|$)/);
    },
  );

  // PAY-269: the e2e admin has no employee record, so "My payroll" never
  // appears and this link is the only menu route to their own settings.
  const nav = page.locator(".topbar .nav");
  const mySettings = nav.getByRole("link", { name: "My settings", exact: true });
  const myPayroll = nav.getByRole("button", { name: "My payroll" });

  await step(page, "Admin with no employee record opens My settings from the menu", async () => {
    await expect(mySettings).toBeVisible();
    await expect(myPayroll).toHaveCount(0);
    await mySettings.click();
    await page.waitForURL("**/my/settings");
    await expect(page.getByRole("heading", { name: "My settings", exact: true })).toBeVisible();
    await expect(
      page.getByText(
        "Your email notifications and how you sign in. Changes here apply only to you.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sign-in and security" })).toBeVisible();
  });

  await step(page, "Admin with an employee record keeps the My payroll menu instead", async () => {
    // Hold the employee check open: until it answers, neither item may show.
    let answerProfile = () => {};
    const profileHeld = new Promise<void>((resolve) => {
      answerProfile = resolve;
    });
    await page.route("**/api/my/profile", async (route) => {
      await profileHeld;
      await route.fulfill({ json: { profile: { employmentType: "w2" } } });
    });
    await page.goto("/admin/dashboard");
    await expect(nav.getByRole("link", { name: "Payroll", exact: true })).toBeVisible();
    await expect(mySettings).toHaveCount(0);
    await expect(myPayroll).toHaveCount(0);

    answerProfile();
    await expect(myPayroll).toBeVisible();
    await expect(mySettings).toHaveCount(0);

    await myPayroll.click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await page.waitForURL("**/my/settings");
    await page.unroute("**/api/my/profile");
  });

  await ctx.close();
});

test("journey 7: deposit detail view (PAY-36/PAY-37/PAY-38)", async ({ browser }) => {
  // Admin session from journey 2. The e2e fixture issues a 2025-10 run and
  // syncs deposits at boot; the list defaults to the current year, so open it
  // pinned to 2025 via the query param (PAY-17 filter state).
  const ctx = await newContext(browser, { storageState: ADMIN_SESSION });
  const page = await ctx.newPage();

  // Scoped to THIS boot's own 2025-10 fixture. The QA dataset seeds a full year
  // of 2025 payroll for three personas (PAY-56), so ~12 federal 2025 deposits
  // exist and the FIRST row is December's, not the PAY-36 fixture. Every
  // assertion below therefore names the October row explicitly — the readability
  // checks from PAY-38 included, which previously leaned on `.first()`.
  // PAY-49: Ada's IL work-state election adds a state deposit row per month,
  // so October has TWO rows — pin the FEDERAL one (this journey asserts the
  // federal breakdown layout: EFTPS reference, combined Medicare, quarter).
  const row = page
    .locator(".p-datatable-tbody tr", { hasText: "Oct 2025" })
    .filter({ hasText: "federal" })
    .first();

  await step(page, "Deposits list for 2025: readable, sortable, no EFTPS noise", async () => {
    await page.goto("/admin/deposits?year=2025");
    await expect(row).toBeVisible();

    // PAY-38: three-letter month in the period column.
    await expect(row.locator("td").first()).toContainText("Oct 2025");

    // PAY-38: the EFTPS string does not appear in the table body.
    await expect(page.locator(".p-datatable-tbody")).not.toContainText("EFTPS");

    // PAY-38: sortable columns exist.
    await expect(page.locator("th.p-datatable-sortable-column").first()).toBeVisible();
  });

  await step(page, "Open the October federal deposit detail", async () => {
    await row.click();
    await expect(page).toHaveURL(/\/admin\/deposits\/\d+/);

    await expect(page.getByText("EFTPS reference")).toBeVisible();
    await expect(page.getByText("Breakdown")).toBeVisible();
    await expect(page.getByText("Contributing runs")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Attachments" })).toBeVisible();

    // The breakdown carries the combined categories, not employee/employer halves.
    await expect(page.getByText("Medicare (employee + employer)")).toBeVisible();

    await expect(page.getByText("Tax year")).toBeVisible();
    await expect(page.getByText("Quarter")).toBeVisible();
    await expect(page.getByRole("button", { name: "Mark as deposited" })).toBeVisible();
  });

  await step(page, "Back to the deposits list", async () => {
    await page.getByRole("button", { name: "Back to deposits" }).click();
    await expect(page).toHaveURL(/\/admin\/deposits/);
  });

  await ctx.close();
});

test("journey 8: a state that moved to quarterly shows payments already made (PAY-91)", async ({
  browser,
}) => {
  // e2e:serve seeds IL 2023 monthly rows (July deposited, August open), then a
  // synthetic IL-2023 quarterly schedule, then syncs: August is replaced by one
  // Q3 2023 row. No 2023 runs exist, so nothing is left to pay and the July
  // payment is an overpayment.
  const ctx = await newContext(browser, { storageState: ADMIN_SESSION });
  const page = await ctx.newPage();
  const quarterRow = page.locator(".p-datatable-tbody tr", { hasText: "Q3 2023" });
  const julyRow = page.locator(".p-datatable-tbody tr", { hasText: "Jul 2023" });

  await step(page, "IL 2023 list: one quarter row, the replaced month is gone", async () => {
    await page.goto("/admin/deposits?year=2023&jurisdiction=IL");
    await expect(quarterRow).toBeVisible();
    await expect(quarterRow).toContainText("Illinois (IL)");
    // The 0.00 anchor row shows "Overpaid" INSTEAD OF "Nothing left to pay".
    await expect(quarterRow).toContainText("Overpaid");
    await expect(quarterRow).not.toContainText("Nothing left to pay");
    await expect(quarterRow.getByRole("button", { name: "Mark as deposited" })).toHaveCount(0);
    // One Overpaid chip per quarter: never next to the July "Deposited" chip.
    await expect(julyRow).toContainText("Deposited");
    await expect(julyRow).not.toContainText("Overpaid");
    // Period column only: the July row's due and deposit dates are in August.
    await expect(
      page.locator(".p-datatable-tbody tr td:first-child", { hasText: "Aug 2023" }),
    ).toHaveCount(0);
  });

  await step(page, "Quarter detail lists the July payment and the overpayment", async () => {
    await quarterRow.click();
    await expect(page).toHaveURL(/\/admin\/deposits\/\d+/);
    const card = page.getByTestId("deposit-credits");
    await expect(
      card.getByRole("heading", { name: "Payments already made for Q3 2023" }),
    ).toBeVisible();
    await expect(card).toContainText("July 2023 payment on");
    await expect(card).toContainText("$100.00 — $0.00 counted here");
    await expect(card).toContainText("Illinois now takes one payment per quarter.");
    await expect(page.getByTestId("left-to-pay")).toContainText(
      "Already paid: $0.00 · Left to pay: $0.00",
    );
    await expect(page.getByText("Total withholding for Q3 2023: $0.00")).toBeVisible();
    await expect(
      page.getByText(
        "Your recorded payments for Q3 2023 are $100.00 more than that quarter's withholding.",
      ),
    ).toBeVisible();
    await expect(
      page.getByText("Payments already recorded for Q3 2023 cover this amount."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Mark as deposited" })).toHaveCount(0);
  });

  await ctx.close();
});
