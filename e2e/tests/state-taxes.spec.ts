/**
 * PAY-13 phase 1 e2e — state withholding admin surfaces.
 *
 * Read-only everywhere (safe for live QA): the "State taxes" tab renders on
 * the admin config page and the "State tax" tab on an employee detail page.
 * The mutating flow (assign work state → it appears in the history table)
 * runs only against the ephemeral PGlite boot, per spec 14 §3.
 *
 * All logins go through newAuthedPage's per-worker session cache — the API
 * rate-limits credential endpoints (spec 3), and raw loginAs calls in a new
 * spec file hit the 429 wall when suites run together.
 */

import { expect, test, type Page } from "@playwright/test";
import {
  EMPLOYEE_SESSION_PATH,
  LIVE_QA,
  loadEphemeralState,
  newAuthedPage,
  EPHEMERAL_EMPLOYEE_NAME,
  QA_ADMIN,
  QA_EMPLOYEE_NAME,
} from "./qa.js";
import { step } from "./support/journey.js";
import { newContext } from "./support/walkthrough.js";

function adminUser() {
  return LIVE_QA ? QA_ADMIN : loadEphemeralState()?.admin;
}

/**
 * The employee these specs drive.
 *
 * The ephemeral employee exists only in the local boot. The read-only spec
 * below runs in BOTH modes, so against live QA it must name a persona the QA
 * seed provides. The mutating specs are LIVE_QA-skipped, so they always get
 * the ephemeral one.
 */
const EMPLOYEE_NAME = LIVE_QA ? QA_EMPLOYEE_NAME : EPHEMERAL_EMPLOYEE_NAME;

/**
 * Open one employee's State tax tab.
 *
 * Named rather than "the first row": the boot now seeds the full QA dataset
 * (PAY-56), so the first employee is whichever persona sorts first — these
 * specs were silently operating on the wrong record.
 */
async function openStateTaxTab(page: Page) {
  await page.goto("/admin/employees");
  await page.locator("tbody tr", { hasText: EMPLOYEE_NAME }).first().click();
  await page.waitForURL(/\/admin\/employees\/\d+/);
  await page.getByRole("tab", { name: "State tax" }).click();
}

test("config page: State taxes tab renders", async ({ browser }) => {
  const user = adminUser();
  test.skip(!user, "ephemeral state missing — run the journeys first");
  const page = await newAuthedPage(browser, user!);
  try {
    await step(page, "Config page: State taxes tab lists jurisdictions", async () => {
      await page.goto("/admin/config");
      await page.getByRole("tab", { name: "State taxes" }).click();
      await expect(page.getByText("Jurisdiction", { exact: true })).toBeVisible();
      await expect(page.getByText("Computation kind")).toBeVisible();
      await expect(page.getByText("resolution falls back to the bare state code")).toBeVisible();
    });
  } finally {
    await page.close();
  }
});

test("employee detail: State tax tab renders work-state and election tables", async ({
  browser,
}) => {
  const user = adminUser();
  test.skip(!user, "ephemeral state missing — run the journeys first");
  const page = await newAuthedPage(browser, user!);
  try {
    await step(page, "Employee State tax tab shows work state + elections", async () => {
      await openStateTaxTab(page);
      await expect(page.getByRole("heading", { name: /^Where .+ works$/ })).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "State withholding elections (append-only)" }),
      ).toBeVisible();
    });
  } finally {
    await page.close();
  }
});

test("ephemeral only: assign a work state and see it in the history", async ({ browser }) => {
  test.skip(LIVE_QA, "mutating — live QA is read-only (spec 14 §3)");
  const user = loadEphemeralState()?.admin;
  test.skip(!user, "ephemeral state missing — run the journeys first");
  const page = await newAuthedPage(browser, user!);
  try {
    await step(page, "Open the employee's State tax tab", async () => {
      await openStateTaxTab(page);
    });
    await step(page, "Assign work state IL", async () => {
      await page.getByRole("button", { name: "Assign" }).click();
      await page.getByLabel("State (USPS code)").fill("IL");
      await page.getByRole("button", { name: "Assign", exact: true }).last().click();
      await expect(page.getByText("Work state assigned")).toBeVisible();
      // Scope to the work-state card — inactive tab panels stay mounted, so a
      // bare tbody.first() would land in the hidden Compensation table.
      const workStateCard = page.locator("section", {
        has: page.getByRole("heading", { name: /^Where .+ works$/ }),
      });
      await expect(workStateCard.getByRole("cell", { name: "IL", exact: true })).toBeVisible();
    });
  } finally {
    await page.close();
  }
});

/**
 * PAY-13 phase 2 e2e — the full employee journey: file a state withholding
 * election through the change-request wizard, admin approves it, the election
 * lands on the State tax tab, and the next issued payslip shows the computed
 * state withholding. Mutating → ephemeral PGlite only.
 */
test("ephemeral only: employee state election flows request → approval → payslip", async ({
  browser,
}) => {
  test.skip(LIVE_QA, "mutating — live QA is read-only (spec 14 §3)");
  const state = loadEphemeralState();
  test.skip(!state, "ephemeral state missing — run the journeys first");

  // The wizard defaults effective_from to the first of next month — compute
  // that month so the payroll run generated below is covered by the election.
  const now = new Date();
  const effective = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const effYear = effective.getFullYear();
  const effMonth = effective.getMonth() + 1;

  // --- 1. Employee files the election through the change-request wizard ---
  const empCtx = await newContext(browser, { storageState: EMPLOYEE_SESSION_PATH });
  try {
    const emp = await empCtx.newPage();
    await step(emp, "Employee fills in an IL withholding election", async () => {
      await emp.goto("/my/requests/new");
      await emp.getByRole("button", { name: /State withholding/ }).click();
      await emp.locator("#stateCode").fill("il"); // form normalizes to uppercase
      // PrimeVue InputNumber keeps the id on the wrapper; the input is inside.
      await emp.locator("#allowances input").fill("1");
      await emp.locator("#extraWithholding input").fill("10");
      await emp.getByRole("button", { name: "Review", exact: true }).click();
      // Inactive step panels stay mounted — assert on the step-3 heading, which
      // only exists in the (visible) review panel.
      await expect(emp.getByRole("heading", { name: "Review — State withholding" })).toBeVisible();
    });
    await step(emp, "Employee submits the request (Pending)", async () => {
      await emp.getByRole("button", { name: "Submit request" }).click();
      await emp.waitForURL(/\/my\/requests\/[0-9a-f-]{36}/);
      await expect(emp.getByText("Pending").first()).toBeVisible();
    });
  } finally {
    await empCtx.close();
  }

  // --- 2. Admin approves the request ---
  const adminPage = await newAuthedPage(browser, state!.admin);
  let runPublicId = "";
  try {
    await step(adminPage, "Admin approves the election request", async () => {
      await adminPage.goto("/admin/requests");
      await adminPage.locator("tr", { hasText: "State withholding" }).first().click();
      await adminPage.waitForURL(/\/admin\/requests\/[0-9a-f-]{36}/);
      await adminPage.getByRole("button", { name: "Approve & apply" }).click();
      await expect(adminPage.getByText("Request approved")).toBeVisible();
    });

    // --- 3. Election + work state on the employee's State tax tab ---
    const employeeId = await step(
      adminPage,
      "Election and IL work state on the State tax tab",
      async () => {
        await openStateTaxTab(adminPage);
        const id = Number(adminPage.url().match(/\/admin\/employees\/(\d+)/)?.[1]);
        expect(id).toBeGreaterThan(0);
        const workStateCard = adminPage.locator("section", {
          has: adminPage.getByRole("heading", { name: /^Where .+ works$/ }),
        });
        // The previous spec test usually assigned IL already; assign if missing.
        if (!(await workStateCard.getByRole("cell", { name: "IL", exact: true }).isVisible())) {
          await adminPage.getByRole("button", { name: "Assign" }).click();
          await adminPage.getByLabel("State (USPS code)").fill("IL");
          await adminPage.getByRole("button", { name: "Assign", exact: true }).last().click();
          await expect(adminPage.getByText("Work state assigned")).toBeVisible();
        }
        const electionsCard = adminPage.locator("section", {
          has: adminPage.getByRole("heading", {
            name: "State withholding elections (append-only)",
          }),
        });
        await expect(electionsCard.getByRole("cell", { name: "IL", exact: true })).toBeVisible();
        return id;
      },
    );

    // --- 4. Generate → approve → issue the run for the effective month ---
    // page.request shares the context cookies but sends no Origin header —
    // the app's CSRF check 403s mutating calls without it.
    const origin = { origin: new URL(adminPage.url()).origin };
    const gen = await adminPage.request.post("/api/admin/payroll-runs/generate", {
      data: { year: effYear, month: effMonth, employeeId },
      headers: origin,
    });
    expect(gen.status()).toBe(201);
    runPublicId = ((await gen.json()) as { generated: { publicId: string }[] }).generated[0]!
      .publicId;
    for (const action of ["approve", "issue"] as const) {
      const res = await adminPage.request.post(`/api/admin/payroll-runs/${runPublicId}/${action}`, {
        headers: origin,
      });
      expect(res.status()).toBe(200);
    }
  } finally {
    await adminPage.close();
  }

  // --- 5. The issued payslip shows the computed IL state withholding ---
  // IL 2026: 4.95% × (48000 − 2925 × 1 allowance) / 12 + $10 extra = $195.93.
  const empCtx2 = await newContext(browser, { storageState: EMPLOYEE_SESSION_PATH });
  try {
    const emp = await empCtx2.newPage();
    await step(emp, "Issued payslip shows IL state withholding −$195.93", async () => {
      await emp.goto(`/my/payslips/${runPublicId}`);
      const stateCell = emp
        .locator("dt", { hasText: "State withholding" })
        .locator("xpath=following-sibling::dd[1]");
      await expect(stateCell).toHaveText("−$195.93");
    });
  } finally {
    await empCtx2.close();
  }
});
