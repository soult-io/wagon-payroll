/**
 * Playwright config (hardening B + spec 14 §3):
 *
 * - DEFAULT (ephemeral): the webServer is the real Fastify app booted against
 *   in-memory PGlite by @payroll/server's e2e:serve script (migrations +
 *   seeds + fixtures; serves the built SPA from apps/web/dist).
 * - LIVE QA (E2E_BASE_URL set): no local server is booted — the suite runs
 *   against that URL (the nightly job sets it from the QA_E2E_BASE_URL repo
 *   variable; unset → ephemeral default).
 *   Fixture-driven specs branch: journeys are ephemeral-only; the qa.spec
 *   specs use the documented seeded QA credentials/TOTP and stay read-only.
 *
 * - WALKTHROUGH (E2E_WALKTHROUGH=1, spec 20): a separate, NON-gating re-run of
 *   the journey files at human pace — slowMo, per-character typing, screen
 *   holds (tests/support/walkthrough.ts) — recorded and joined into one video
 *   per journey by reporters/walkthrough-reporter.ts. Ephemeral boot ONLY: it
 *   refuses to start when E2E_BASE_URL is set. Its output lives apart, in
 *   test-results-walkthrough/, so it never mixes with the gating evidence.
 *
 * Chromium only; serial (journeys share the single in-memory database).
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices, type ReporterDescription } from "@playwright/test";
import { JOURNEY_FILES } from "./reporters/evidence-reporter.js";
import { VIDEO_SIZE, WALKTHROUGH, WALKTHROUGH_SLOWMO_MS } from "./tests/support/walkthrough.js";

const liveBaseUrl = process.env.E2E_BASE_URL;
const HERE = dirname(fileURLToPath(import.meta.url));

// The recording is published; it may only ever show the synthetic local boot.
if (WALKTHROUGH && liveBaseUrl) {
  throw new Error("E2E_WALKTHROUGH records the local synthetic boot only — unset E2E_BASE_URL");
}

/** Walkthrough overrides: journeys only, human pace, recorded, never retried. */
const walkthroughMode = WALKTHROUGH
  ? {
      testMatch: [...JOURNEY_FILES].map((f) => `**/${f}`),
      outputDir: "./test-results-walkthrough",
      // Human pace is slow: a journey takes minutes, not seconds.
      timeout: 300_000,
      retries: 0,
      reporter: [
        ["list"],
        [
          "./reporters/walkthrough-reporter.ts",
          { outputFile: resolve(HERE, "test-results-walkthrough/walkthrough-evidence.json") },
        ],
      ] satisfies ReporterDescription[],
      projects: [
        {
          name: "walkthrough",
          use: {
            ...devices["Desktop Chrome"],
            viewport: VIDEO_SIZE,
            video: { mode: "on" as const, size: VIDEO_SIZE },
            launchOptions: { slowMo: WALKTHROUGH_SLOWMO_MS },
          },
        },
      ],
    }
  : {};

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  // CI also writes a json report (spec 17 §2) — the verify-summary job and the
  // pay-verify site consume it. Output path is relative to this config's dir.
  //
  // The journey-evidence reporter (spec 20) runs only for the ephemeral CI
  // boot, never against live QA (spec 20 D2). It writes next to the stills
  // under test-results/, which the e2e job uploads as pay-verify-evidence.
  reporter: process.env.CI
    ? [
        ["github"],
        ["html", { open: "never" }],
        ["json", { outputFile: "playwright-results.json" }],
        ...(liveBaseUrl
          ? []
          : [
              [
                "./reporters/evidence-reporter.ts",
                { outputFile: resolve(HERE, "test-results/journey-evidence.json") },
              ] as const,
            ]),
      ]
    : [["list"]],
  use: {
    // PAY-259: localhost, not 127.0.0.1: passkeys need a domain name.
    baseURL: liveBaseUrl ?? "http://localhost:9898",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  ...(liveBaseUrl
    ? {}
    : {
        webServer: {
          command: "pnpm --filter @payroll/server e2e:serve",
          url: "http://localhost:9898/health",
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          // Playwright ignores webServer stdout by default. The boot logs the
          // DATE it seeded for, and the dataset is clock-dependent, so with
          // `reuseExistingServer` on a stale boot from last month silently
          // invalidates the "previous calendar month" assertions. Piping it is
          // what makes that visible (PAY-56).
          stdout: "pipe",
        },
      }),
  ...walkthroughMode,
});
