/**
 * PAY-208 fix round 3 (payroll-calc-auditor, fail-first against fad42de; the
 * coder may not edit this file). Synthetic data only.
 *
 * Tests: R3-1a-b, R3-2a (source) + R3-2b (server guard), R3-3 (guard only:
 * PGlite serialises transactions, so the FOR UPDATE race cannot be forced
 * here), R3-4, R3-5, R3-6.
 *
 * Contract assumed:
 *  - R3-1: PUT /api/admin/employees/:id/sign-in-email ends sessions AFTER
 *    the commit; when that fails the route still answers 200 with
 *    `sessionsRevoked: false` (the email change stands) and logs the error
 *    class only; on success `sessionsRevoked: true`.
 *  - R3-2: MyPayslipsView.vue shows "Withdraw my agreement" for any active
 *    (not withdrawn) consent — current or outdated — in a branch placed
 *    before the contactMissing branch.
 *  - R3-4: the withdrawal email says "through at least October 15 of the
 *    year after its tax year".
 *  - R3-5: the January gate of POST .../furnished-on-paper uses the
 *    company-local date (config.appTz). Note: the brief's instant
 *    2027-01-01T00:30Z is Jan 1 in UTC and in Madrid alike, so it cannot
 *    tell the two apart; the test uses 2026-12-31T23:30Z (UTC Dec 31,
 *    Madrid Jan 1 00:30).
 *  - R3-6: PUT /api/admin/company refuses cross-site (403 cross_site).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { authUser, company } from "@payroll/db";
import { ROOT } from "./annual-w2-corrected-harness.js";
import {
  boot,
  call,
  CONTACT,
  CONTACT_ADDRESS,
  consentRow,
  deleteConsent,
  type Emp,
  type Env,
  makeEmp,
  NEW_VERSION,
  notificationsModule,
  OLD_VERSION,
  outbox,
  plain,
  putContact,
} from "./pay-208-harness.js";

const ADDR_A = {
  line1: "1 Synthetic Plaza",
  city: "Fixtureville",
  state: "TX",
  zip: "75001",
  country: "US",
};
const ADDR_B = {
  line1: "2 Synthetic Plaza",
  city: "Fixtureville",
  state: "TX",
  zip: "75002",
  country: "US",
};
const SECRET_DETAIL = "r3-synthetic-adapter-detail-7c1f";

let ipSeq = 0;
async function changeEmail(env: Env, id: number, email: string) {
  ipSeq += 1;
  const ip = `10.214.0.${ipSeq}`;
  return env.t.app.inject({
    method: "PUT",
    url: `/api/admin/employees/${id}/sign-in-email`,
    headers: { ...env.admin, "x-forwarded-for": ip },
    remoteAddress: ip,
    payload: { email },
  });
}
async function emailOf(env: Env, userId: string) {
  return (
    await env.t.db.select({ email: authUser.email }).from(authUser).where(eq(authUser.id, userId))
  )[0]?.email;
}

// ---------------------------------------------------------------- R3-1

describe("R3-1 session revocation after the email change can fail without failing the change", () => {
  let env: Env;
  const logs: string[] = [];
  let ok: Emp;
  let broken: Emp;
  beforeAll(async () => {
    env = await boot({
      now: "2027-01-04T10:00:00Z",
      logStream: { write: (m) => void logs.push(m) },
    });
    ok = await makeEmp(env, { label: "Revokeok", login: true });
    broken = await makeEmp(env, { label: "Revokefail", login: true });
  }, 180_000);
  afterAll(async () => env.close());

  it("R3-1a success -> 200 with sessionsRevoked: true", async () => {
    const res = await changeEmail(env, ok.id, "revokeok-new@example.com");
    expect({
      status: res.statusCode,
      sessionsRevoked: (res.json() as { sessionsRevoked?: boolean }).sessionsRevoked,
    }).toEqual({
      status: 200,
      sessionsRevoked: true,
    });
  });

  it("R3-1b deleteUserSessions throws -> 200, sessionsRevoked: false, the email is changed, the error detail is in no log line or body", async () => {
    const ctx = (await env.t.auth.$context) as unknown as {
      internalAdapter: { deleteUserSessions: (userId: string) => Promise<unknown> };
    };
    const original = ctx.internalAdapter.deleteUserSessions;
    const consoleLines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      consoleLines.push(a.map(String).join(" "));
    });
    ctx.internalAdapter.deleteUserSessions = async () => {
      throw new TypeError(`${SECRET_DETAIL} for ${broken.email}`);
    };
    const mark = logs.length;
    let res: Awaited<ReturnType<typeof changeEmail>>;
    try {
      res = await changeEmail(env, broken.id, "revokefail-new@example.com");
    } finally {
      ctx.internalAdapter.deleteUserSessions = original;
      spy.mockRestore();
    }
    const seen = [...logs.slice(mark), ...consoleLines, res.body].join("\n");
    expect({
      status: res.statusCode,
      sessionsRevoked: (res.json() as { sessionsRevoked?: boolean }).sessionsRevoked,
      email: await emailOf(env, broken.userId!),
      detailLeaked: seen.includes(SECRET_DETAIL),
      oldAddressLeaked: seen.includes(broken.email!),
    }).toEqual({
      status: 200,
      sessionsRevoked: false,
      email: "revokefail-new@example.com",
      detailLeaked: false,
      oldAddressLeaked: false,
    });
  });
});

// ---------------------------------------------------------------- R3-2

describe("R3-2 'Withdraw my agreement' is reachable for an outdated active consent", () => {
  it("R3-2a source: a withdraw link sits in a branch whose condition covers an outdated (not withdrawn) consent, before the contactMissing branch", () => {
    const v = readFileSync(resolve(ROOT, "apps/web/src/views/my/MyPayslipsView.vue"), "utf8");
    const script = v.slice(0, v.indexOf("<template>"));
    const tpl = v.slice(v.indexOf("<template>"));
    const missingAt = tpl.search(/v-(else-)?if="contactMissing"/);
    const conds = [...tpl.matchAll(/v-(?:else-)?if="([^"]+)"/g)].map((m) => ({
      at: m.index!,
      expr: m[1]!,
    }));
    const covers = (expr: string): boolean => {
      if (/outdated|withdrawnAt/.test(expr)) return true;
      return [...expr.matchAll(/[A-Za-z_]\w*/g)].some(([id]) => {
        const def = script.match(new RegExp(`const ${id} = computed\\(([\\s\\S]*?)\\);\\n`));
        return def !== null && /outdated|withdrawnAt/.test(def[1]!);
      });
    };
    const links = [...tpl.matchAll(/Withdraw my agreement<\/a>/g)].map((m) => m.index!);
    const reachable = links.filter((at) => {
      const cond = conds.filter((c) => c.at < at).at(-1);
      return cond !== undefined && covers(cond.expr) && at < missingAt;
    });
    expect({
      missingFound: missingAt >= 0,
      links: links.length > 0,
      reachable: reachable.length > 0,
    }).toEqual({
      missingFound: true,
      links: true,
      reachable: true,
    });
  });

  describe("R3-2b server: DELETE works for an outdated consent (guard)", () => {
    let env: Env;
    let e: Emp;
    beforeAll(async () => {
      env = await boot({ now: "2027-01-04T10:00:00Z" });
      await putContact(env, { ...CONTACT, mailingAddress: CONTACT_ADDRESS });
      e = await makeEmp(env, {
        label: "Oldwithdraw",
        login: true,
        consent: OLD_VERSION,
        years: [2026],
      });
    }, 180_000);
    afterAll(async () => env.close());

    it("DELETE -> 200, the row is withdrawn, one confirmation mail", async () => {
      const res = await deleteConsent(env, e);
      expect({
        status: res.statusCode,
        withdrawn: (await consentRow(env, e.id))[0]?.withdrawnAt !== null,
        mails: (await outbox(env, e.userId, "w2_consent_withdrawn")).length,
      }).toEqual({ status: 200, withdrawn: true, mails: 1 });
    });
  });
});

// ---------------------------------------------------------------- R3-4

describe("R3-4 the withdrawal email matches the disclosure date sentence", () => {
  it("the general sentence says 'through at least October 15 of the year after its tax year'", async () => {
    const n = await notificationsModule();
    const r = n.w2ConsentWithdrawn(
      { companyName: "Example Corp", brandName: "Wagon Payroll", appUrl: "http://localhost" },
      { effectiveOn: "2027-02-28", contact: { ...CONTACT, mailingAddress: CONTACT_ADDRESS } },
    ) as { html: string; text: string };
    const phrase = "through at least October 15 of the year after its tax year";
    expect({
      text: r.text.replace(/\s+/g, " ").includes(phrase),
      html: plain(r.html).includes(phrase),
    }).toEqual({
      text: true,
      html: true,
    });
  });
});

// ---------------------------------------------------------------- R3-5

describe("R3-5 furnished-on-paper uses the company-local January gate (Europe/Madrid)", () => {
  let env: Env;
  let e: Emp;
  beforeAll(async () => {
    env = await boot({ now: "2026-12-31T22:00:00Z", config: { appTz: "Europe/Madrid" } });
    e = await makeEmp(env, { label: "Madridpaper", years: [2026] });
  }, 180_000);
  afterAll(async () => env.close());

  it("at 2026-12-31T23:30Z (Jan 1 00:30 in Madrid) marking the 2026 W-2 given on paper succeeds", async () => {
    env.setNow("2026-12-31T23:30:00Z");
    const res = await call(
      env,
      "POST",
      `/api/admin/annual-forms/w2/${e.id}/furnished-on-paper?year=2026`,
      env.admin,
      {},
    );
    expect({
      status: res.statusCode,
      furnished: (res.json() as { furnished?: string }).furnished,
    }).toEqual({
      status: 200,
      furnished: "paper",
    });
  });
});

// ---------------------------------------------------------------- R3-6, R3-3

describe("R3-6 PUT /api/admin/company refuses cross-site; R3-3 guard", () => {
  let env: Env;
  let e: Emp;
  const putCompany = (address: unknown, extra: Record<string, string> = {}) =>
    call(
      env,
      "PUT",
      "/api/admin/company",
      { ...env.admin, ...extra },
      { legalName: "Example Corp", address },
    );
  beforeAll(async () => {
    env = await boot({ now: "2027-01-04T10:00:00Z" });
    await putCompany(ADDR_A);
    await putContact(env, { ...CONTACT, mailingAddress: null });
    e = await makeEmp(env, { label: "Crosscompany", login: true, consent: NEW_VERSION });
  }, 180_000);
  afterAll(async () => env.close());

  it("R3-6 cross-site PUT -> 403 cross_site; the address is unchanged; no w2_contact_changed mail", async () => {
    const res = await putCompany(ADDR_B, { "sec-fetch-site": "cross-site" });
    const row = (await env.t.db.select().from(company).limit(1))[0]!;
    expect({
      status: res.statusCode,
      error: (res.json() as { error?: string }).error,
      line1: (row.address as { line1?: string } | null)?.line1,
      mails: (await outbox(env, e.userId, "w2_contact_changed")).length,
    }).toEqual({ status: 403, error: "cross_site", line1: ADDR_A.line1, mails: 0 });
  });

  it("R3-3 (guard only) two concurrent saves of the same new address -> one w2_contact_changed mail", async () => {
    const out = await Promise.all([putCompany(ADDR_B), putCompany(ADDR_B)]);
    expect({
      statuses: out.map((r) => r.statusCode),
      mails: (await outbox(env, e.userId, "w2_contact_changed")).length,
    }).toEqual({ statuses: [200, 200], mails: 1 });
  });
});
