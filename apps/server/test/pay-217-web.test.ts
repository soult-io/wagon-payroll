/**
 * PAY-217 T-26 — web: a former employee (access "w2_only") reaches one
 * screen, the W-2 card. Tested from the server suite (the web app has no
 * test runner; same method as pay-208-web.test.ts): a pure routing helper
 * plus source checks of the wiring. payroll-calc-auditor, fail-first
 * against faad1d9; the coder may not edit this file.
 *
 * Contract assumed — apps/web/src/lib/former-access.ts (pure, no Vue):
 *  - FORMER_W2_ROUTE_NAME = "my-w2-access" (route path "/my/w2").
 *  - formerEmployeeRedirect(access, to: { name?: string | null; meta?: { public?: boolean } })
 *      -> { name: "my-w2-access" } when access === "w2_only" and `to` is not
 *         public and not my-w2-access; else null (access "full" / null /
 *         undefined -> always null).
 *  - isW2AccessOnly(status: number, body: unknown) -> true only for
 *    403 { error: "w2_access_only" } (the API client maps it to a redirect).
 * Wiring (source): router.ts has the my-w2-access route at /my/w2 and calls
 * formerEmployeeRedirect in beforeEach BEFORE ensureEmployee (which calls the
 * refused /api/my/profile) and before the admin redirect; the auth store
 * keeps `access` and `w2AccessThrough` from GET /api/me; api.ts handles
 * w2_access_only; the view MyW2AccessView.vue exists; R3: no onPaper copy.
 * The "no refused API request on load" check runs in the browser (T-27).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./annual-w2-corrected-harness.js";

// biome-ignore lint/suspicious/noExplicitAny: contract-shaped dynamic import
type Any = any;
const LIB = "apps/web/src/lib/former-access.ts";
async function lib(): Promise<Record<string, Any>> {
  return (await import(/* @vite-ignore */ resolve(ROOT, LIB))) as Record<string, Any>;
}
function need(mod: Record<string, Any>, name: string): Any {
  const v = mod[name];
  if (v === undefined) throw new Error(`${LIB} has no export "${name}"`);
  return v;
}
const src = (p: string) =>
  existsSync(resolve(ROOT, p)) ? readFileSync(resolve(ROOT, p), "utf8") : "";

const PRIVATE = [
  { name: "my-payslips", meta: { requiresAuth: true } },
  { name: "my-profile", meta: { requiresAuth: true } },
  { name: "admin-dashboard", meta: { requiresAuth: true, requiresAdmin: true } },
  { name: "my-dashboard", meta: { requiresAuth: true } }, // "/" redirects here
  { name: "my-requests", meta: { requiresAuth: true } },
  { name: "my-settings", meta: { requiresAuth: true } },
];
const PUBLIC = [
  { name: "login", meta: { public: true } },
  { name: "accept-invite", meta: { public: true } },
  { name: "reset-password", meta: { public: true } },
];

describe("PAY-217 T-26 web routing for a former employee", () => {
  it("T-26a w2_only: /my/payslips, /my/profile, /admin/dashboard, / (my-dashboard) -> my-w2-access; public routes and my-w2-access itself pass; full / unknown access never redirected", async () => {
    const m = await lib();
    const f = need(m, "formerEmployeeRedirect");
    expect({
      routeName: need(m, "FORMER_W2_ROUTE_NAME"),
      former: PRIVATE.map((to) => f("w2_only", to)),
      formerPublic: PUBLIC.map((to) => f("w2_only", to)),
      formerSelf: f("w2_only", { name: "my-w2-access", meta: { requiresAuth: true } }),
      full: [...PRIVATE, ...PUBLIC].map((to) => f("full", to)),
      unknown: [f(null, PRIVATE[0]), f(undefined, PRIVATE[0])],
    }).toEqual({
      routeName: "my-w2-access",
      former: PRIVATE.map(() => ({ name: "my-w2-access" })),
      formerPublic: PUBLIC.map(() => null),
      formerSelf: null,
      full: [...PRIVATE, ...PUBLIC].map(() => null),
      unknown: [null, null],
    });
  });

  it("T-26b isW2AccessOnly: only 403 { error: w2_access_only }", async () => {
    const g = need(await lib(), "isW2AccessOnly");
    expect([
      g(403, { error: "w2_access_only" }),
      g(403, { error: "forbidden" }),
      g(403, { error: "account_disabled" }),
      g(401, { error: "w2_access_only" }),
      g(403, null),
    ]).toEqual([true, false, false, false, false]);
  });

  it("T-26c wiring: route /my/w2 named my-w2-access; beforeEach checks access before ensureEmployee and the admin redirect; store keeps access + w2AccessThrough; api.ts maps w2_access_only; the view exists; no onPaper", () => {
    const router = src("apps/web/src/router.ts");
    const guard = router.slice(router.indexOf("router.beforeEach"));
    const at = (s: string) => guard.indexOf(s);
    const store = src("apps/web/src/stores/auth.ts");
    const web = [
      router,
      store,
      src("apps/web/src/lib/api.ts"),
      src("apps/web/src/views/my/MyW2AccessView.vue"),
    ].join("\n");
    expect({
      route: /path:\s*"\/my\/w2",\s*\n?\s*name:\s*"my-w2-access"/.test(router),
      guardCallsHelper: at("formerEmployeeRedirect(") > 0,
      beforeEnsureEmployee:
        at("formerEmployeeRedirect(") > 0 && at("formerEmployeeRedirect(") < at("ensureEmployee("),
      beforeAdminRedirect:
        at("formerEmployeeRedirect(") > 0 &&
        at("formerEmployeeRedirect(") < at('name: "admin-dashboard"'),
      storeAccess: /\baccess\b/.test(store) && store.includes("w2AccessThrough"),
      apiMaps: src("apps/web/src/lib/api.ts").includes("w2_access_only"),
      view: existsSync(resolve(ROOT, "apps/web/src/views/my/MyW2AccessView.vue")),
      noOnPaper: !web.includes("onPaper"),
    }).toEqual({
      route: true,
      guardCallsHelper: true,
      beforeEnsureEmployee: true,
      beforeAdminRedirect: true,
      storeAccess: true,
      apiMaps: true,
      view: true,
      noOnPaper: true,
    });
  });
});
