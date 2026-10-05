/**
 * PAY-217 T-1 .. T-5 — deny by default for a former employee (W-2 only).
 * payroll-calc-auditor, fail-first against faad1d9; the coder may not edit
 * this file. Synthetic data only. Legal source + dates: pay-217-harness.ts.
 *
 * Contract assumed (brief §3 D217-1 C, D217-2, D217-4, §6.1, §6.2, §6.4):
 *  - A user whose employees row is 'terminated' and who has a tax year
 *    furnished online (portal_notice / employee_download) still inside its
 *    (j)(6) window (company-local today) is W-2-only, whatever its role;
 *    'terminated' with no open window -> none. Derived per request from
 *    employees.status + w2_furnishings (nothing stored), so these tests set
 *    the employee row directly and leave the auth row unbanned.
 *  - Route opt-in: Fastify route config `formerEmployeeW2: true`, on exactly
 *    GET /api/me, GET /api/my/w2, GET /api/my/w2/:year/pdf. Every other
 *    session route -> 403 { error: "w2_access_only" } for a W-2-only user;
 *    none -> 403 { error: "account_disabled" } everywhere.
 *  - GET /api/me adds access: "full" | "w2_only" (+ w2AccessThrough ISO date
 *    for w2_only).
 *  - Better Auth mount: with a W-2-only (or none) session, only
 *    POST /sign-in/email, POST /two-factor/verify-totp,
 *    POST /backup-code/verify, GET /get-session, POST /sign-out pass; every
 *    other /api/auth path (including /change-password, Product Lead
 *    2026-10-05) -> 403 { error: "w2_access_only" }. No session -> unchanged.
 *
 * Route discovery: `fastify` is wrapped so every instance gets an onRoute
 * hook before any route is registered (no change to buildApp needed).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { authUser } from "@payroll/db";
import {
  boot217,
  consenter,
  type Emp,
  type Env,
  errorOf,
  freshIp,
  markTerminatedRow,
  me,
  mustSignIn,
  postConsent,
  signIn,
  TEST_PASSWORD,
  userRow,
  yearNotice,
  moveTo,
} from "./pay-217-harness.js";

const seen = vi.hoisted(() => ({
  routes: [] as { method: string; url: string; config: Record<string, unknown> }[],
}));

vi.mock("fastify", async (importOriginal) => {
  // biome-ignore lint/suspicious/noExplicitAny: wrapping the factory
  const mod = (await importOriginal()) as any;
  const orig = mod.default;
  // biome-ignore lint/suspicious/noExplicitAny: wrapping the factory
  const wrapped = (...args: any[]) => {
    const app = orig(...args);
    // biome-ignore lint/suspicious/noExplicitAny: Fastify route options
    app.addHook("onRoute", (r: any) => {
      const methods: string[] = Array.isArray(r.method) ? r.method : [r.method];
      for (const m of methods) {
        seen.routes.push({ method: String(m).toUpperCase(), url: r.url, config: r.config ?? {} });
      }
    });
    return app;
  };
  return { ...mod, default: wrapped, fastify: wrapped };
});

/** The three routes a former employee may reach (brief §6.2, the complete list). */
const OPT_IN = ["GET /api/me", "GET /api/my/w2", "GET /api/my/w2/:year/pdf"].sort();

/**
 * Routes with no session at all — public by design, listed explicitly (a
 * new public route must be added here on purpose, after review).
 */
const PUBLIC = new Set([
  "GET /health",
  "GET /api/runtime-config",
  "POST /api/onboarding/verify-token",
  "POST /api/onboarding/set-password",
  "POST /api/onboarding/totp-enable",
  "POST /api/onboarding/totp-verify",
  // Better Auth: covered by its own allowlist test (T-1c / T-4).
  "GET /api/auth/*",
  "POST /api/auth/*",
  // Bearer-token routes (no session): QA mailbox (APP_ENV=qa only) and the export API.
  "GET /api/qa/mailbox",
  "GET /api/export/payroll-runs",
  "GET /api/export/contractor-payments",
  "GET /api/export/tax-deposits",
  "GET /api/export/tax-filings",
  // The built SPA (registered only when apps/web/dist exists).
  "GET /*",
]);

const JAN_4_2027 = "2027-01-04T16:00:00Z";
const FEB_1_2027 = "2027-02-01T16:00:00Z"; // 10:00 CST

function fill(url: string): string {
  return url
    .replace(/:year\b/g, "2026")
    .replace(/:[A-Za-z_]+/g, "1")
    .replace(/\*/g, "x");
}

/** Every Better Auth endpoint (path + the method the mount would forward). */
function betterAuthEndpoints(env: Env): { method: string; path: string }[] {
  // biome-ignore lint/suspicious/noExplicitAny: Better Auth endpoint objects
  return Object.values(env.t.auth.api as Record<string, any>)
    .filter((e) => typeof e === "function" && typeof e.path === "string")
    .map((e) => {
      const m = e.options?.method;
      const methods: string[] = Array.isArray(m) ? m : [m ?? "POST"];
      const method = methods.includes("POST") || methods.includes("*") ? "POST" : "GET";
      return { method, path: e.path as string };
    });
}

describe("PAY-217 guard: deny by default for a former employee", () => {
  let env: Env;
  let former: Emp;
  let adminFormer: Emp;
  let active: Emp;

  beforeAll(async () => {
    env = await boot217(JAN_4_2027);
    former = await consenter(env, "Gdformer");
    adminFormer = await consenter(env, "Gdadminformer");
    active = await consenter(env, "Gdactive");
    await yearNotice(env); // 2026 W-2 furnished online (portal_notice) to all three
    await moveTo(env, FEB_1_2027);
    await markTerminatedRow(env, former, "2027-01-29");
    await markTerminatedRow(env, adminFormer, "2027-01-29");
    // T-2: this former employee held the admin role.
    await env.t.db
      .update(authUser)
      .set({ role: "admin" })
      .where(eq(authUser.id, adminFormer.userId!));
    await mustSignIn(env, former);
    await mustSignIn(env, adminFormer);
    await mustSignIn(env, active);
  }, 300_000);
  afterAll(async () => env.close());

  it("T-1a route inventory: the routes with formerEmployeeW2: true are exactly GET /api/me, GET /api/my/w2, GET /api/my/w2/:year/pdf", () => {
    const flagged = [
      ...new Set(
        seen.routes
          .filter((r) => r.method !== "HEAD" && r.config.formerEmployeeW2 === true)
          .map((r) => `${r.method} ${r.url}`),
      ),
    ].sort();
    expect({ discovered: seen.routes.length > 50, flagged }).toEqual({
      discovered: true,
      flagged: OPT_IN,
    });
  });

  it("T-1b every other registered session route answers 403 w2_access_only to a former employee (never 2xx); the opt-in routes answer 200", async () => {
    const routes = [
      ...new Map(
        seen.routes.filter((r) => r.method !== "HEAD").map((r) => [`${r.method} ${r.url}`, r]),
      ).values(),
    ];
    const wrong: string[] = [];
    let called = 0;
    for (const r of routes) {
      const key = `${r.method} ${r.url}`;
      if (PUBLIC.has(key) || OPT_IN.includes(key)) continue;
      called += 1;
      const ip = freshIp();
      const res = await env.t.app.inject({
        method: r.method as "GET",
        url: fill(r.url),
        headers: { ...former.session!, "x-forwarded-for": ip },
        remoteAddress: ip,
        ...(r.method === "GET" ? {} : { payload: {} }),
      });
      if (res.statusCode !== 403 || errorOf(res) !== "w2_access_only") {
        wrong.push(`${key} -> ${res.statusCode} ${errorOf(res) ?? ""}`);
      }
    }
    const meRes = await me(env, former.session!);
    const list = await env.t.app.inject({
      method: "GET",
      url: "/api/my/w2",
      headers: former.session!,
    });
    expect({
      calledMany: called > 40,
      wrong,
      me: [meRes.statusCode, (meRes.json() as { access?: string }).access],
      list: list.statusCode,
    }).toEqual({ calledMany: true, wrong: [], me: [200, "w2_only"], list: 200 });
  });

  it("T-1c Better Auth surface: with a former session every endpoint but sign-in, TOTP/backup verify, get-session and sign-out answers 403 w2_access_only (incl. /change-password and an unknown plugin path)", async () => {
    const s = await signIn(env, former.email!); // own session: some refused calls would end it on the old code
    if (!s.session) throw new Error(`former sign-in refused (${s.status} ${s.code})`);
    const allowed = new Set([
      "POST /sign-in/email",
      "POST /two-factor/verify-totp",
      "POST /backup-code/verify",
      "GET /get-session",
      "POST /sign-out",
    ]);
    const endpoints = betterAuthEndpoints(env);
    const paths = [
      ...new Map(endpoints.map((e) => [`${e.method} ${e.path}`, e])).values(),
      { method: "POST", path: "/change-password" },
      { method: "POST", path: "/some-future-plugin/action" },
    ];
    const wrong: string[] = [];
    let checked = 0;
    for (const e of paths) {
      const key = `${e.method} ${e.path}`;
      if (allowed.has(key)) continue;
      checked += 1;
      const ip = freshIp();
      const res = await env.t.app.inject({
        method: e.method as "GET",
        url: `/api/auth${fill(e.path)}`,
        headers: { ...s.session, "x-forwarded-for": ip },
        remoteAddress: ip,
        ...(e.method === "POST" ? { payload: {} } : {}),
      });
      if (res.statusCode !== 403 || errorOf(res) !== "w2_access_only") {
        wrong.push(`${key} -> ${res.statusCode} ${errorOf(res) ?? ""}`);
      }
    }
    expect({ checkedMany: checked > 20, wrong }).toEqual({ checkedMany: true, wrong: [] });
  });

  it("T-2 a former employee who held the admin role: admin routes 403 (W-2 only, not admin); /api/me access w2_only", async () => {
    const ping = await env.t.app.inject({
      method: "GET",
      url: "/api/admin/ping",
      headers: adminFormer.session!,
    });
    const emps = await env.t.app.inject({
      method: "GET",
      url: "/api/admin/employees",
      headers: adminFormer.session!,
    });
    const m = await me(env, adminFormer.session!);
    expect({
      ping: [ping.statusCode, errorOf(ping)],
      employees: [emps.statusCode, errorOf(emps)],
      access: (m.json() as { access?: string }).access,
    }).toEqual({
      ping: [403, "w2_access_only"],
      employees: [403, "w2_access_only"],
      access: "w2_only",
    });
  });

  it("T-4 Better Auth: update-user, change-password, two-factor/disable, list-sessions, admin/list-users -> 403 and nothing changes; get-session 200; sign-out 200 and ends the session; a no-session sign-in (password + TOTP) still works", async () => {
    const s = await signIn(env, former.email!);
    if (!s.session) throw new Error(`former sign-in refused (${s.status} ${s.code})`);
    const before = await env.t.db.select().from(authUser).where(eq(authUser.id, former.userId!));
    const ba = async (method: "GET" | "POST", path: string, payload?: Record<string, unknown>) => {
      const res = await env.t.app.inject({
        method,
        url: `/api/auth${path}`,
        headers: s.session!,
        ...(payload ? { payload } : {}),
      });
      return [res.statusCode, errorOf(res)];
    };
    const refused = {
      updateUser: await ba("POST", "/update-user", { name: "Renamed Former" }),
      changePassword: await ba("POST", "/change-password", {
        currentPassword: TEST_PASSWORD,
        newPassword: "another-horse-battery-staple-7",
      }),
      twoFactorDisable: await ba("POST", "/two-factor/disable", { password: TEST_PASSWORD }),
      listSessions: await ba("GET", "/list-sessions"),
      adminListUsers: await ba("GET", "/admin/list-users"),
    };
    const after = await env.t.db.select().from(authUser).where(eq(authUser.id, former.userId!));
    const getSession = await env.t.app.inject({
      method: "GET",
      url: "/api/auth/get-session",
      headers: s.session,
    });
    const signOut = await env.t.app.inject({
      method: "POST",
      url: "/api/auth/sign-out",
      headers: s.session,
      payload: {},
    });
    const afterSignOut = await me(env, s.session);
    const again = await signIn(env, former.email!);
    const r403 = [403, "w2_access_only"];
    expect({
      refused,
      unchanged: {
        name: after[0]!.name === before[0]!.name,
        twoFactor: after[0]!.twoFactorEnabled === before[0]!.twoFactorEnabled,
      },
      getSession: [
        getSession.statusCode,
        (getSession.json() as { user?: { id?: string } } | null)?.user?.id === former.userId,
      ],
      signOut: signOut.statusCode,
      afterSignOut: afterSignOut.statusCode,
      noSessionSignIn: again.status,
    }).toEqual({
      refused: {
        updateUser: r403,
        changePassword: r403,
        twoFactorDisable: r403,
        listSessions: r403,
        adminListUsers: r403,
      },
      unchanged: { name: true, twoFactor: true },
      getSession: [200, true],
      signOut: 200,
      afterSignOut: 401,
      noSessionSignIn: 200,
    });
  });

  it("T-5 active employee unchanged: /api/me access full; payslips list, profile, consent POST 200; /api/my/w2 has no former block", async () => {
    const m = await me(env, active.session!);
    const payslips = await env.t.app.inject({
      method: "GET",
      url: "/api/payslips",
      headers: active.session!,
    });
    const profile = await env.t.app.inject({
      method: "GET",
      url: "/api/my/profile",
      headers: active.session!,
    });
    const consent = await postConsent(env, active);
    const list = await env.t.app.inject({
      method: "GET",
      url: "/api/my/w2",
      headers: active.session!,
    });
    const body = m.json() as { access?: string; w2AccessThrough?: unknown };
    expect({
      access: body.access,
      through: body.w2AccessThrough ?? null,
      payslips: payslips.statusCode,
      profile: profile.statusCode,
      consent: consent.statusCode,
      list: list.statusCode,
      former: (list.json() as { former?: unknown }).former ?? null,
      banned: (await userRow(env, active.userId!)).banned,
    }).toEqual({
      access: "full",
      through: null,
      payslips: 200,
      profile: 200,
      consent: 200,
      list: 200,
      former: null,
      banned: false,
    });
  });
});

describe("PAY-217 T-3 window close is enforced per request, without the daily job (company-local date)", () => {
  let env: Env;
  let former: Emp;
  beforeAll(async () => {
    env = await boot217(JAN_4_2027);
    former = await consenter(env, "Gdclose");
    await yearNotice(env);
    await moveTo(env, FEB_1_2027);
    await markTerminatedRow(env, former, "2027-01-29");
  }, 240_000);
  afterAll(async () => env.close());

  it("TY2026 window ends Fri 2027-10-15: same session at 23:30 Oct 15 Chicago -> 200; at 00:30 Oct 16 Chicago -> 403 account_disabled on /api/my/w2 and /api/me; the login itself is not banned (job not run)", async () => {
    await moveTo(env, "2027-10-16T04:00:00Z"); // 2027-10-15 23:00 CDT
    await mustSignIn(env, former);
    await moveTo(env, "2027-10-16T04:30:00Z"); // 23:30 CDT, still Oct 15
    const lastDay = await env.t.app.inject({
      method: "GET",
      url: "/api/my/w2",
      headers: former.session!,
    });
    const lastMe = await me(env, former.session!);
    await moveTo(env, "2027-10-16T05:30:00Z"); // 00:30 CDT Oct 16 (UTC date unchanged)
    const nextDay = await env.t.app.inject({
      method: "GET",
      url: "/api/my/w2",
      headers: former.session!,
    });
    const nextMe = await me(env, former.session!);
    expect({
      lastDay: lastDay.statusCode,
      lastMe: [lastMe.statusCode, (lastMe.json() as { w2AccessThrough?: string }).w2AccessThrough],
      nextDay: [nextDay.statusCode, errorOf(nextDay)],
      nextMe: [nextMe.statusCode, errorOf(nextMe)],
      banned: (await userRow(env, former.userId!)).banned,
    }).toEqual({
      lastDay: 200,
      lastMe: [200, "2027-10-15"],
      nextDay: [403, "account_disabled"],
      nextMe: [403, "account_disabled"],
      banned: false,
    });
  });
});
