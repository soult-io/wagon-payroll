/**
 * Shared fixtures/helpers for the live-QA e2e specs (spec 14 §3).
 *
 * Credentials here are the FIXED, DOCUMENTED, FAKE QA-only logins created by
 * `pnpm seed:qa` (docs/qa.md) — publishing them is deliberate: they guard a
 * synthetic-data environment only. The TOTP values are the RAW secrets
 * (createOTP HMAC keys, exactly as seeded into the twoFactor table); the
 * base32-encoded forms for authenticator apps are documented in docs/qa.md.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createOTP } from "@better-auth/utils/otp";
import { newContext } from "./support/walkthrough.js";

export const LIVE_QA = Boolean(process.env.E2E_BASE_URL);

export const QA_ADMIN = {
  email: "qa-admin@example.test",
  password: "qa-admin-passphrase-742",
  totpSecret: "QAADMIN0FIXED1TOTP2SECRET3SEED456",
};

export const QA_EMPLOYEE = {
  email: "qa-employee@example.test",
  password: "qa-employee-passphrase-318",
  totpSecret: "QAEMPLOYEE0FIXED1TOTP2SECRET3SEED",
};

/** Dave Placeholder's portal login (PAY-7) — linked to his contractor record. */
export const QA_CONTRACTOR = {
  email: "qa-contractor@example.test",
  password: "qa-contractor-passphrase-519",
  totpSecret: "QACONTRACTOR0FIXED1TOTP2SEED345",
};

/**
 * FIXED, DOCUMENTED QA export token — bearer for the QA-only mailbox endpoint
 * (and the QA export API). Like the logins/TOTP above it guards a
 * synthetic-data environment only, so it deliberately lives in the repo
 * instead of a GitHub secret (owner 2026-08-06: the app repo holds no repo
 * secrets). The QA stack's /srv/payroll-qa/secrets/export-token file must
 * contain exactly this value ("seed" repeated — 64 hex chars, openssl -hex 32
 * format).
 */
export const QA_EXPORT_TOKEN = "5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed";

export async function totp(secret: string): Promise<string> {
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

/**
 * How long the credential rate-limit window takes to clear. Longer than the
 * suite's own 60s test timeout (e2e/playwright.config.ts), which is why
 * {@link extendedTimeoutMs} exists — see spec 18.
 */
export const LOGIN_RATE_LIMIT_BACKOFF_MS = 65_000;

/** Headroom on top of the backoff for the retried login itself. */
export const LOGIN_BACKOFF_SLACK_MS = 15_000;

/**
 * Budget a test needs if it is about to sleep out the rate-limit window.
 *
 * Playwright treats a timeout of 0 as "no timeout", so 0 must stay 0 — adding
 * to it would silently impose a finite deadline on a test that had none.
 */
export function extendedTimeoutMs(currentMs: number, backoffMs: number): number {
  if (currentMs === 0) return 0;
  return currentMs + backoffMs + LOGIN_BACKOFF_SLACK_MS;
}

/** Full browser login: password step → TOTP challenge → dashboard. */
export async function loginAs(
  page: Page,
  user: { email: string; password: string; totpSecret: string },
): Promise<void> {
  // The live-QA server rate-limits credential endpoints to 10 req/min and the
  // UI renders a 429 as "Invalid email or password" — so a throttled sign-in
  // looks exactly like wrong credentials (#totp never appears). With several
  // seeded users logging in per suite run, the first login past the limit
  // fails flakily (2026-08-07 + 2026-08-21 nightlies). Wait out the window
  // and retry instead of failing the test.
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto("/login");
    await page.locator("#email").fill(user.email);
    await page.locator("#password input").fill(user.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const challenged = await page
      .locator("#totp")
      .waitFor({ timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (challenged) {
      await submitLoginTotp(page, user.totpSecret);
      await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
      return;
    }
    if (attempt < 2) {
      // Extend THIS test's budget before sleeping. The backoff is longer than
      // the default 60s timeout, so without this the retry path can never
      // complete: every throttled login times out, and the retry that follows
      // reports the spec as merely "flaky" (spec 18, PAY-55).
      test.setTimeout(extendedTimeoutMs(test.info().timeout, LOGIN_RATE_LIMIT_BACKOFF_MS));
      await page.waitForTimeout(LOGIN_RATE_LIMIT_BACKOFF_MS);
    }
  }
  throw new Error(`login as ${user.email} failed — #totp never appeared (credential rate limit?)`);
}

// ---------------------------------------------------------------------------
// Live-QA session cache — the API rate-limits credential endpoints to
// 10 req/min (spec 3), so 4 full logins in one suite run get throttled (the
// UI renders the 429 as "Invalid email or password", which is what the
// 2026-08-07 nightly hit). Log in ONCE per user per worker (serial suite =
// one process) and hand out fresh contexts carrying the cached storage state.
// ---------------------------------------------------------------------------

interface QaUser {
  email: string;
  password: string;
  totpSecret: string;
}
type StoredState = Awaited<ReturnType<BrowserContext["storageState"]>>;

const sessionCache = new Map<string, StoredState>();

/** Fresh page authenticated as `user`, logging in only on first use. */
export async function newAuthedPage(browser: Browser, user: QaUser): Promise<Page> {
  const cached = sessionCache.get(user.email);
  const ctx = await newContext(browser, cached ? { storageState: cached } : {});
  const page = await ctx.newPage();
  if (!cached) {
    await loginAs(page, user);
    sessionCache.set(user.email, await ctx.storageState());
  }
  return page;
}

// ---------------------------------------------------------------------------
// Persona names, for scoping list rows.
//
// The ephemeral boot seeds the QA dataset too (PAY-56), so no list is a single
// row any more and every spec must say WHICH record it means. These live here,
// next to the logins, because they are the same category of fact — and because
// two specs previously each declared their own `EMPLOYEE_NAME` with different
// values.
// ---------------------------------------------------------------------------

/** This boot's own employee. MUST match `EMPLOYEE.name` in apps/server/src/e2e/serve.ts. */
export const EPHEMERAL_EMPLOYEE_NAME = "E2E Employee";

/** A QA-seed W-2 persona — exists in BOTH modes, so safe for live-QA specs. */
export const QA_EMPLOYEE_NAME = "Carol Mockington";

/** The persona whose current-period draft the seed leaves awaiting approval. */
export const QA_DRAFT_EMPLOYEE_NAME = "Ada";

// ---------------------------------------------------------------------------
// Ephemeral-mode fixture state (e2e:serve boot output), used by specs that
// also run against the local PGlite server.
// ---------------------------------------------------------------------------

export interface EphemeralState {
  baseUrl: string;
  admin: { email: string; password: string; totpSecret: string };
  employee: { email: string; inviteUrl: string };
  run: { publicId: string };
  /**
   * PAY-81: the QA seed's own summary (years and months only), written by
   * serve.ts so specs never derive a year from a clock. `draftPeriod` is null
   * when today's year has no tax tables (Spec 14 §2 as amended, D-C = C1).
   */
  qa: {
    latestCoveredYear: number;
    historyThrough: string | null;
    draftPeriod: string | null;
    w2Year: number;
  };
}

/** GET /api/admin/tax-tables/coverage (year-rollover guard brief §4.5). */
export interface TaxTableCoverageResponse {
  today: string;
  latestCoveredYear: number | null;
  years: { year: number; federal: boolean; missingStates: string[] }[];
}

/** Read the server's tax-table coverage (admin session on `page`). */
export async function fetchTaxTableCoverage(page: Page): Promise<TaxTableCoverageResponse> {
  const res = await page.request.get("/api/admin/tax-tables/coverage");
  expect(res.status(), "GET /api/admin/tax-tables/coverage").toBe(200);
  return (await res.json()) as TaxTableCoverageResponse;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(HERE, "../.state");

export function loadEphemeralState(): EphemeralState | null {
  try {
    return JSON.parse(readFileSync(resolve(STATE_DIR, "state.json"), "utf8")) as EphemeralState;
  } catch {
    return null;
  }
}

/** "YYYY-MM" of the month before `ym` ("YYYY-MM"). */
export function previousMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/**
 * PAY-225 (brief §4.7, B8): the dates the read-only history specs assert,
 * from the SERVER, never the runner's clock.
 * - lastHistoryMonths: the month before server today when today's year has
 *   tax tables; otherwise December of the latest covered year. One entry,
 *   except on live QA in the midnight window where APP_TZ (the endpoint's
 *   `today`) and UTC (the seed's date) fall in different months: on the 1st
 *   the seed may still hold one month less, on the last day of a month one
 *   month more. The spec accepts any listed month.
 * - closedYear: min(server year − 1, latest covered year).
 * Ephemeral boot: the QA seed's own summary in state.json (when uncovered the
 * server year is above L, so min(Y − 1, L) = L). Live QA: the coverage
 * endpoint (admin session on `page`).
 */
export async function serverHistoryDates(
  page: Page,
): Promise<{ lastHistoryMonths: string[]; closedYear: number }> {
  if (!LIVE_QA) {
    const state = loadEphemeralState();
    if (!state) throw new Error("ephemeral state missing — e2e:serve writes it");
    const { qa } = state;
    if (qa.draftPeriod !== null) {
      // Covered: the draft is the current period; history ends the month before.
      const lastHistoryMonth = previousMonth(qa.draftPeriod);
      expect(qa.historyThrough, "seed history ends the month before the draft").toBe(
        lastHistoryMonth,
      );
      return {
        lastHistoryMonths: [lastHistoryMonth],
        closedYear: Number(qa.draftPeriod.slice(0, 4)) - 1,
      };
    }
    const lastHistoryMonth = `${qa.latestCoveredYear}-12`;
    expect(qa.historyThrough, "uncovered: history ends in December of L").toBe(lastHistoryMonth);
    return { lastHistoryMonths: [lastHistoryMonth], closedYear: qa.latestCoveredYear };
  }
  const cov = await fetchTaxTableCoverage(page);
  const serverYear = Number(cov.today.slice(0, 4));
  const latest = cov.latestCoveredYear;
  if (latest === null) throw new Error("coverage: no covered tax year");
  const current = cov.years.find((y) => y.year === serverYear);
  const covered = current?.federal === true && current.missingStates.length === 0;
  if (!covered)
    return { lastHistoryMonths: [`${latest}-12`], closedYear: Math.min(serverYear - 1, latest) };
  const thisMonth = cov.today.slice(0, 7);
  const months = [previousMonth(thisMonth)];
  const day = Number(cov.today.slice(8, 10));
  const [y, m] = thisMonth.split("-").map(Number) as [number, number];
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (day === 1) months.push(previousMonth(previousMonth(thisMonth)));
  if (day === lastDay) months.push(thisMonth);
  return { lastHistoryMonths: months, closedYear: Math.min(serverYear - 1, latest) };
}

export const EMPLOYEE_SESSION_PATH = resolve(STATE_DIR, "employee-storage.json");
