/**
 * Spec 14 §3 e2e specs — written to run against LIVE QA (E2E_BASE_URL set,
 * seeded by `pnpm seed:qa`) and, where feasible, against the ephemeral
 * PGlite boot as well.
 *
 * Live-QA constraints (shared environment!):
 * - READ-ONLY assertions only: no approving/voiding runs, no change requests,
 *   no profile edits. The one permitted mutation is the admin "send test
 *   email" observability action, which is idempotent-by-design (it just
 *   queues another outbox row captured by Mailpit).
 * - Fixture data comes from the documented seed:qa personas, never from the
 *   ephemeral .state file.
 */

import { expect, test } from "@playwright/test";

/** Non-null or throw — keeps specs free of `!` assertions. */
function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

import {
  EMPLOYEE_SESSION_PATH,
  fetchTaxTableCoverage,
  LIVE_QA,
  loadEphemeralState,
  loginAs,
  newAuthedPage,
  QA_ADMIN,
  QA_CONTRACTOR,
  QA_DRAFT_EMPLOYEE_NAME,
  QA_EMPLOYEE,
  QA_EXPORT_TOKEN,
  serverHistoryDates,
} from "./qa.js";
import { step } from "./support/journey.js";
import { newContext } from "./support/walkthrough.js";

test("login: password + TOTP (fixed seeded credentials in live QA)", async ({ page }) => {
  const user = LIVE_QA ? QA_ADMIN : loadEphemeralState()?.admin;
  test.skip(!user, "ephemeral state missing — run the journeys first (e2e:serve boot writes it)");
  await step(page, "Sign in with password + TOTP", async () => {
    await loginAs(page, must(user, "fixture user"));
  });
});

test("payslip PDF download round-trip (%PDF magic, non-trivial bytes)", async ({ browser }) => {
  if (LIVE_QA) {
    // Carol Mockington (qa-employee login) has 19 issued payslips from the seed.
    const page = await newAuthedPage(browser, QA_EMPLOYEE);
    try {
      const publicId = await step(page, "Employee opens an issued payslip", async () => {
        await page.goto("/my/payslips");
        // The employee payslips table shows Period/Pay date/Gross/Net — no status
        // column (every listed row is issued by definition). Take the first data
        // row; row-click navigates to the detail view.
        const row = page.locator("tbody tr").first();
        await expect(row).toBeVisible();
        await row.click();
        await page.waitForURL(/\/my\/payslips\/[0-9a-f-]{36}/);
        return must(page.url().split("/").pop(), "payslip publicId in URL");
      });
      await step(page, "Payslip PDF downloads (%PDF, non-trivial size)", async () => {
        const pdf = await page.request.get(`/api/payslips/${publicId}/pdf`);
        expect(pdf.status()).toBe(200);
        expect(pdf.headers()["content-type"]).toContain("application/pdf");
        const body = await pdf.body();
        expect(body.subarray(0, 5).toString()).toBe("%PDF-");
        expect(body.length).toBeGreaterThan(2000);
      });
    } finally {
      await page.context().close();
    }
    return;
  }

  // Ephemeral: journey 1 saves the employee session; journey 2 issues the run.
  const state = loadEphemeralState();
  test.skip(!state, "ephemeral state missing — journeys write it");
  const ctx = await newContext(browser, { storageState: EMPLOYEE_SESSION_PATH });
  try {
    const emp = await ctx.newPage();
    const publicId = must(state, "ephemeral state").run.publicId;
    await step(emp, "Payslip PDF downloads (%PDF, non-trivial size)", async () => {
      // Read-only navigation so the step's still shows the payslip whose PDF
      // is fetched (the API call alone leaves the page blank).
      await emp.goto(`/my/payslips/${publicId}`);
      const pdf = await emp.request.get(`/api/payslips/${publicId}/pdf`);
      expect(pdf.status()).toBe(200);
      const body = await pdf.body();
      expect(body.subarray(0, 5).toString()).toBe("%PDF-");
      expect(body.length).toBeGreaterThan(2000);
    });
  } finally {
    await ctx.close();
  }
});

test("scheduler draft: seeded current-period run shows in admin approvals (read-only)", async ({
  browser,
}) => {
  // De-gated with PAY-7/8/9/23 (PAY-56). The old skip reason said "the
  // ephemeral boot has no pg-boss scheduler context", but this assertion never
  // needed the scheduler — only the seeded row it leaves behind, which the boot
  // now has. Still strictly read-only.
  //
  // PAY-225 (Spec 14 §2 as amended, owner D-C = C1): the seed leaves a
  // current-period draft ONLY while today's year has tax tables. Whether it
  // does comes from the server, never the clock: the ephemeral boot writes the
  // seed's own summary to state.json (qa.draftPeriod, null when uncovered);
  // live QA asks GET /api/admin/tax-tables/coverage.
  const page = await newAuthedPage(browser, QA_ADMIN);
  try {
    const expectation = await step(page, "Read whether today's year has tax tables", async () => {
      if (!LIVE_QA) {
        const qa = must(loadEphemeralState(), "ephemeral state (e2e:serve writes it)").qa;
        return {
          covered: qa.draftPeriod !== null,
          draftPeriod: qa.draftPeriod,
          latestCoveredYear: qa.latestCoveredYear,
        };
      }
      const cov = await fetchTaxTableCoverage(page);
      const serverYear = Number(cov.today.slice(0, 4));
      const current = must(
        cov.years.find((y) => y.year === serverYear),
        `coverage entry for ${serverYear}`,
      );
      return {
        covered: current.federal && current.missingStates.length === 0,
        draftPeriod: null,
        latestCoveredYear: must(cov.latestCoveredYear, "latestCoveredYear"),
      };
    });

    // Ada's runs, from the read-only admin API (pay-date year filter is the
    // server's; the list carries employee ids, not names).
    const adaRuns = async () => {
      const emps = await page.request.get("/api/admin/employees");
      expect(emps.status()).toBe(200);
      const { employees } = (await emps.json()) as {
        employees: { id: number; legalName: string }[];
      };
      const ada = must(
        employees.find((e) => e.legalName.startsWith(QA_DRAFT_EMPLOYEE_NAME)),
        `${QA_DRAFT_EMPLOYEE_NAME} in the employee list`,
      );
      const runs = await page.request.get(`/api/admin/payroll-runs?employeeId=${ada.id}`);
      expect(runs.status()).toBe(200);
      return (
        (await runs.json()) as {
          runs: { periodStart: string; payDate: string; status: string }[];
        }
      ).runs;
    };

    if (expectation.covered) {
      // The year filter is the PAY-date year (Spec 26); take it from the draft
      // run itself, never from the browser's "current year" default (§4.6).
      const year = await step(page, "Find the current-period draft's pay-date year", async () => {
        const runs = await adaRuns();
        const draft = runs.find(
          (r) =>
            r.status === "awaiting_approval" &&
            (expectation.draftPeriod === null || r.periodStart.startsWith(expectation.draftPeriod)),
        );
        return Number(must(draft, "Ada's awaiting-approval run").payDate.slice(0, 4));
      });
      await step(page, "Current-period draft awaits approval in the runs list", async () => {
        await page.goto(`/admin/payroll?year=${year}`);
        // The seed leaves ONE current-period draft awaiting approval, Ada's.
        // Scoped to her so this cannot pass on some other run's row.
        // Read-only assertion — never approve/void here.
        const row = page
          .locator("tr", { hasText: "Awaiting approval" })
          .filter({ hasText: QA_DRAFT_EMPLOYEE_NAME });
        await expect(row.first()).toBeVisible();
      });
      return;
    }

    // Uncovered (C1): no current-period draft, and the last covered year's
    // December run is issued, not left open (C2 rejected).
    const nextYear = expectation.latestCoveredYear + 1;
    await step(page, "No current-period draft while the year has no tax tables", async () => {
      const open = (await adaRuns()).filter((r) =>
        ["draft", "awaiting_approval", "approved"].includes(r.status),
      );
      expect(open, `${QA_DRAFT_EMPLOYEE_NAME} has no open run`).toEqual([]);
      await page.goto(`/admin/payroll?year=${nextYear}&status=awaiting_approval`);
      await expect(page.getByText("No runs")).toBeVisible();
      await expect(page.locator("tr", { hasText: "Awaiting approval" })).toHaveCount(0);
    });

    // PAY-103 R18: the missing-tax-tables banner replaces the draft.
    await step(page, "Missing-tax-tables banner names the year", async () => {
      // Ephemeral: the boot's app clock is pinned to 2025-12-31, so the
      // coverage endpoint would answer for 2025. The seed date is the
      // runner's UTC date (the clock-shift preload reaches both processes;
      // see qa-seed-boot-state.spec), and state.json says it is uncovered.
      let uncovered: number[];
      if (!LIVE_QA) {
        const serverYear = new Date().getUTCFullYear();
        expect(serverYear).toBeGreaterThan(expectation.latestCoveredYear);
        uncovered = [serverYear];
      } else {
        const cov = await fetchTaxTableCoverage(page);
        uncovered = cov.years
          .filter((e) => !e.federal || e.missingStates.length > 0)
          .map((e) => e.year);
      }
      expect(uncovered.length, "at least one uncovered year to name").toBeGreaterThan(0);
      await page.goto("/admin/payroll");
      const banner = page.getByTestId("missing-tax-tables-banner");
      await expect(banner).toBeVisible();
      for (const y of uncovered) {
        await expect(banner).toContainText(String(y));
      }
    });
  } finally {
    await page.context().close();
  }
});

test("contractor My Invoices: Dave sees approved+paid invoices, PDF round-trips (PAY-7)", async ({
  browser,
}) => {
  const page = await newAuthedPage(browser, QA_CONTRACTOR);
  try {
    await step(page, "Contractor sees invoices with status chips", async () => {
      // UI surface: the list page shows Dave's seeded invoices with status chips.
      await page.goto("/my/invoices");
      const row = page.locator("tbody tr").first();
      await expect(row).toBeVisible();
      await expect(page.getByText("Paid").first()).toBeVisible();
    });

    const invoices = await step(page, "Only approved/paid invoices leave the server", async () => {
      // API surface (read-only): D1 visibility — only approved/paid leave the
      // server; paid rows carry the payment join.
      const list = await page.request.get("/api/my/invoices");
      expect(list.status()).toBe(200);
      const body = (await list.json()) as {
        invoices: { id: number; status: string; payment: unknown }[];
      };
      expect(body.invoices.length).toBeGreaterThan(0);
      expect(body.invoices.every((i) => ["approved", "paid"].includes(i.status))).toBe(true);
      expect(body.invoices.some((i) => i.status === "paid" && i.payment !== null)).toBe(true);
      return body.invoices;
    });

    await step(page, "Invoice PDF downloads (%PDF, non-trivial size)", async () => {
      // PDF round-trip on the first listed invoice.
      const pdf = await page.request.get(`/api/my/invoices/${invoices[0]!.id}/pdf`);
      expect(pdf.status()).toBe(200);
      expect(pdf.headers()["content-type"]).toContain("application/pdf");
      const body = await pdf.body();
      expect(body.subarray(0, 5).toString()).toBe("%PDF-");
      expect(body.length).toBeGreaterThan(1000);
    });
  } finally {
    await page.context().close();
  }
});

test("PAY-8 scoped UI: contractor sees Invoices, not Payslips; /my/payslips redirects", async ({
  browser,
}) => {
  const page = await newAuthedPage(browser, QA_CONTRACTOR);
  try {
    await step(page, "Contractor nav shows Invoices, not Payslips", async () => {
      await page.goto("/my/dashboard");
      const nav = page.locator("nav .nav-link");
      await expect(nav.getByText("Invoices")).toBeVisible();
      await expect(nav.getByText("Payslips")).toHaveCount(0);
    });

    await step(page, "Direct /my/payslips redirects to the dashboard", async () => {
      await page.goto("/my/payslips");
      await expect(page).toHaveURL(/\/my\/dashboard$/);
    });

    await step(page, "Admin-only notification events are not offered", async () => {
      const settings = await page.request.get("/api/my/notification-settings");
      expect(settings.status()).toBe(200);
      const { settings: rows } = (await settings.json()) as {
        settings: { eventType: string }[];
      };
      const eventTypes = rows.map((r) => r.eventType);
      expect(eventTypes).not.toContain("payroll_draft_ready");
      expect(eventTypes).not.toContain("change_request_submitted");
      expect(eventTypes).not.toContain("payslip_issued");
      expect(eventTypes).toContain("contractor_invoice_paid");
    });
  } finally {
    await page.context().close();
  }
});

test("tax deposits: admin sees the computed schedule incl. last month (PAY-9)", async ({
  browser,
}) => {
  const page = await newAuthedPage(browser, QA_ADMIN);
  try {
    // The QA seed syncs deposits from 2 years of issued payroll history — the
    // last month of that history must be listed (read-only assertion). That
    // is the previous calendar month while today's year has tax tables, else
    // December of the latest covered year (PAY-225, B8). From the server,
    // never the runner's clock.
    const { lastHistoryMonths } = await serverHistoryDates(page);
    let lastHistoryMonth = lastHistoryMonths[0];
    if (lastHistoryMonths.length > 1) {
      // Live-QA midnight window only: take the candidate the server holds.
      const res = await page.request.get("/api/admin/tax-deposits");
      expect(res.status()).toBe(200);
      const { deposits } = (await res.json()) as { deposits: { periodStart: string }[] };
      const held = new Set(deposits.map((d) => d.periodStart.slice(0, 7)));
      lastHistoryMonth = lastHistoryMonths.find((m) => held.has(m));
    }
    const prev = new Date(
      `${must(lastHistoryMonth, `a deposit row for one of ${lastHistoryMonths.join(", ")}`)}-01T00:00:00Z`,
    );
    // Pin the year filter to the month under assertion. It defaults to the
    // CURRENT year and filters server-side, so every January — when the seed
    // has produced no current-year runs yet — the default view is empty.
    await step(page, "Deposit schedule lists the last month of history", async () => {
      await page.goto(`/admin/deposits?year=${prev.getUTCFullYear()}`);
      await expect(page.getByRole("heading", { name: "Tax deposits" })).toBeVisible();
      // Three-letter month, matching AdminDepositsView's periodLabel since PAY-38
      // ("Aug 2026", not "August 2026"). `month: "short"` gives the same list.
      const label = `${prev.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${prev.getUTCFullYear()}`;
      await expect(page.locator("tbody tr", { hasText: label }).first()).toBeVisible();

      // Jurisdiction + reminder schedule editor render.
      await expect(page.locator("tbody").getByText("federal").first()).toBeVisible();
      await expect(page.getByRole("heading", { name: "Reminder schedule" })).toBeVisible();
    });

    await step(page, "Deposits API: federal + IL, newest first", async () => {
      // API surface (read-only): newest period first, federal jurisdiction.
      const list = await page.request.get("/api/admin/tax-deposits");
      expect(list.status()).toBe(200);
      const { deposits } = (await list.json()) as {
        deposits: { periodStart: string; jurisdiction: string; amount: string }[];
      };
      expect(deposits.length).toBeGreaterThan(0);
      // PAY-49: Ada's IL work-state election means state deposit rows exist
      // alongside the federal schedule — both jurisdictions are expected here.
      expect(deposits.every((d) => d.jurisdiction === "federal" || d.jurisdiction === "IL")).toBe(
        true,
      );
      expect(deposits.some((d) => d.jurisdiction === "federal")).toBe(true);
      expect(deposits.some((d) => d.jurisdiction === "IL")).toBe(true);
      expect(Number(deposits[0]!.amount)).toBeGreaterThan(0);
    });
  } finally {
    await page.context().close();
  }
});

test("W-2/W-3 filing detail: full headers, Documents column, W-3 action placement (PAY-23)", async ({
  browser,
}) => {
  const page = await newAuthedPage(browser, QA_ADMIN);
  try {
    // The most recent CLOSED year with history — derived, never hardcoded:
    // the QA seed's history is a rolling window, so a literal year silently
    // stops existing once the window moves past it. PAY-225: min(server year
    // − 1, latest covered year), from the server, never the runner's clock.
    const closedYear = String((await serverHistoryDates(page)).closedYear);
    // The year filter defaults to the CURRENT year and W-2/W-3 is a closed-year
    // form, so this row is never on the default view. Pin it by query param,
    // the same way PAY-9 above does — no coupling to a PrimeVue class name.
    await step(page, "Open last year's W-2/W-3 filing", async () => {
      await page.goto(`/admin/filings?year=${closedYear}`);
      const row = page
        .locator("tbody tr", { hasText: "W-2/W-3" })
        .filter({ hasText: closedYear })
        .first();
      await expect(row).toBeVisible();
      await row.click();

      await expect(
        page.getByRole("heading", { name: new RegExp(`Forms W-2/W-3 — ${closedYear}`) }),
      ).toBeVisible();
    });

    await step(page, "W-3 action in the W-3 card; full W-2 column titles", async () => {
      // Spec 24 (PAY-116) PR-4 (D-PL1): the W-3 is a records copy — heading
      // "W-3 totals (for your records)", button "Download W-3 (records copy)".
      // Matched by keyword: the UX wording may still move. The button is
      // only rendered when no W-2 of the year is on hold; from 2027-01-01 the
      // closed year is 2026 (state lines), which the Q1 seed EIN keeps
      // unblocked (risk R1).
      const w3Section = page.locator("section", {
        has: page.getByRole("heading", { name: /W-3 totals/ }),
      });
      // The W-3 download belongs to the W-3 card header, not the W-2 list.
      await expect(w3Section.getByRole("button", { name: /^Download W-3\b/ })).toBeVisible();
      await expect(w3Section.getByRole("button", { name: "Download W-3 PDF" })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Employee W-2s" })).toBeVisible();

      // Full column titles; Delivery (status) and Documents (actions) are split.
      const w2Table = w3Section.locator("table").last();
      for (const label of [
        "Wages, tips, other compensation",
        "Federal income tax withheld",
        "Social Security tax",
        "Medicare tax",
        "Delivery",
        "Documents",
      ]) {
        await expect(w2Table.locator("th", { hasText: label }).first()).toBeVisible();
      }
      await expect(w2Table.getByRole("button", { name: "Download Copy D" }).first()).toBeVisible();
      await expect(w2Table.getByRole("button", { name: "Print packet" }).first()).toBeVisible();

      // The abbreviated double-wrapping headers are gone.
      await expect(w2Table.getByText("fed. withheld")).toHaveCount(0);
      await expect(w2Table.getByText("SS tax")).toHaveCount(0);
    });
  } finally {
    await page.context().close();
  }
});

test("email capture: admin test email lands in Mailpit (via /api/qa/mailbox)", async ({
  browser,
}) => {
  test.skip(!LIVE_QA, "live-QA only — Mailpit capture requires APP_ENV=qa");
  test.setTimeout(240_000);

  const page = await newAuthedPage(browser, QA_ADMIN);
  try {
    // Benign, idempotent-by-design observability action (queues an outbox row).
    // POST must come from inside the page: the server's csrfOriginCheck rejects
    // mutating requests without a matching Origin (page.request sends none).
    // Navigate first — a fresh context page sits on about:blank, where the
    // relative fetch URL cannot resolve.
    await page.goto("/");
    const status = await page.evaluate(async () => {
      const res = await fetch("/api/admin/settings/test-email", { method: "POST" });
      return res.status;
    });
    expect(status).toBe(202);

    // The outbox drain worker runs every minute in QA — poll the mailbox.
    const deadline = Date.now() + 200_000;
    let found: { subject: string; text: string } | null = null;
    while (Date.now() < deadline) {
      const res = await page.request.get(
        `/api/qa/mailbox?to=${encodeURIComponent(QA_ADMIN.email)}&latest=true`,
        { headers: { authorization: `Bearer ${QA_EXPORT_TOKEN}` } },
      );
      if (res.ok()) {
        const body = (await res.json()) as { subject: string; text: string };
        if (body.subject.includes("test email")) {
          found = body;
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    expect(found, "test email to appear in Mailpit within ~3 minutes").toBeTruthy();
    expect(must(found, "test email in Mailpit").text).toContain("Email delivery is working");
  } finally {
    await page.context().close();
  }
});
