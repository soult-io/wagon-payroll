/**
 * PAY-206 review round 3 (payroll-calc-auditor, fail-first; the coder may
 * not edit this file). Product Lead decisions 2026-10-03 (code review
 * round 2):
 *
 *  R1  A correction already delivered online stays delivered after the
 *      employee withdraws consent (26 CFR 31.6051-1(j)(3)(v)(C): withdrawal
 *      does not apply to a statement furnished before it). For a
 *      NON-consented employee a delivery = the latest paper_handed OR the
 *      latest portal_notice, carrying the current hash. Consented is
 *      unchanged (latest portal_notice only).
 *  R2  Year notice: a non-consented recipient is never mailed w2_available
 *      twice for the same year, even when another recipient's failure leaves
 *      the year un-notified and the next tick retries (the outbox marker
 *      `<!-- w2-available:<year> -->` for that user is the check).
 *  R3  Backfill: a notified year whose figures cannot be read (missing tax
 *      config / AnnualFiguresDefectError) counts as failed — the one-shot
 *      flag w2_furnishings_backfilled is NOT set, so a later call retries.
 *  R4  Admin W-2 list `consented` = the server's electronic channel: an
 *      active (not withdrawn) consent AND a login.
 *  R5  GET /api/admin/annual-forms/w2/:employeeId/pdf (Copy D) also refuses
 *      Sec-Fetch-Site cross-site / same-site (403 { error: "cross_site" })
 *      and is limited to 20 per minute (21st -> 429). A refused request on
 *      any PDF route produces exactly one response: one "request completed"
 *      log line and no "Reply was already sent" line.
 *
 * Tax year 2025 (the only year with a bundled fw2). Expected hashes come from
 * w2BoxesHash over the auditor's oracle boxes (harness: Pub 15-T 2025
 * Worksheet 1A, SSA 2025 wage base 176,100), never from the server's
 * figures. Synthetic data only. Every test resets and makes its own
 * employees.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { appSettings, emailOutbox, taxConfig } from "@payroll/db";
import { sendW2AvailableNotices } from "../src/filings/annual.js";
import { bootL4, history, type L4Env } from "./pay-193-l4-harness.js";
import {
  adminRow,
  boxStrings,
  brief,
  freshAdmin,
  furnishModule,
  furnishings,
  hashOf,
  makeW2Emp,
  myPdf,
  oracleBoxes,
  oracleMonths2025,
  oracleRun2025,
  printPacket,
  rawFurnishing,
  resetW2,
  seedHistory2025,
  setNotifiedYears,
  type W2Emp,
  withdrawConsent,
  Y,
} from "./annual-w2-corrected-harness.js";

let env: L4Env;

beforeAll(async () => {
  // "info": request logs are captured in env.logs (R5 counts them).
  env = await bootL4({ adminEmail: "pay-206-round3-admin@test.dev", logLevel: "info" });
}, 180_000);

afterAll(async () => {
  await env.t.close();
});

beforeEach(async () => {
  await resetW2(env.t);
  env.setNow("2026-06-01T10:00:00Z");
});

const deps = () => ({ db: env.t.db, config: env.t.config });

// ---------------------------------------------------------------- oracle

const G = 600_000;
const JAN_NOV = oracleMonths2025(G, 11);
const JAN_DEC = oracleMonths2025(G, 12);
const B_NOV = oracleBoxes(JAN_NOV);
const B_DEC = oracleBoxes(JAN_DEC);

async function mails(userId: string | null, eventType: "w2_changed" | "w2_available") {
  const rows = await env.t.db
    .select()
    .from(emailOutbox)
    .where(eq(emailOutbox.eventType, eventType));
  return rows.filter((r) => r.userId === userId);
}

async function flagSet(key: string): Promise<boolean> {
  const rows = await env.t.db
    .select({ key: appSettings.key })
    .from(appSettings)
    .where(eq(appSettings.key, key));
  return rows.length > 0;
}

async function dropTrigger(name: string, table: string) {
  await env.t.pglite.exec(`DROP TRIGGER IF EXISTS ${name} ON ${table};`);
}

function safeJson(res: { body: string; headers: Record<string, unknown> }): unknown {
  try {
    return JSON.parse(res.body);
  } catch {
    return `<non-JSON ${String(res.headers["content-type"] ?? "")}>`;
  }
}

describe("oracle self-check (no engine)", () => {
  it("6,000.00/month 2025: Jan-Nov and Jan-Dec boxes 1-6", () => {
    expect({ nov: boxStrings(B_NOV), dec: boxStrings(B_DEC) }).toEqual({
      nov: ["66000.00", "6832.87", "66000.00", "4092.00", "66000.00", "957.00"],
      dec: ["72000.00", "7454.04", "72000.00", "4464.00", "72000.00", "1044.00"],
    });
  });
});

// ---------------------------------------------------------------- R1

describe("R1 a correction delivered online stays delivered after consent is withdrawn", () => {
  it("furnishingState, not consented: [backfill H1, portal_notice H2], current H2 -> correctionToFurnish false (corrected true)", async () => {
    const { furnishingState } = await furnishModule();
    const at = new Date("2026-01-20T10:00:00Z");
    const s = furnishingState(
      [
        { id: 1, boxesHash: "h1", furnishedAt: at, method: "backfill" },
        { id: 2, boxesHash: "h2", furnishedAt: at, method: "portal_notice" },
      ],
      "h2",
      { consented: false },
    );
    expect({ corrected: s.corrected, correctionToFurnish: s.correctionToFurnish }).toEqual({
      corrected: true,
      correctionToFurnish: false,
    });
  });

  it("furnishingState, not consented: delivery = latest paper_handed OR latest portal_notice with the current hash", async () => {
    const { furnishingState } = await furnishModule();
    const at = new Date("2026-01-20T10:00:00Z");
    const row = (id: number, boxesHash: string, method: string) => ({
      id,
      boxesHash,
      furnishedAt: at,
      method,
    });
    const toFurnish = (rows: ReturnType<typeof row>[], consented: boolean) =>
      furnishingState(rows, "h2", { consented }).correctionToFurnish;
    expect({
      // A notice of the OLD figures delivered nothing current.
      oldNoticeOnly: toFurnish([row(1, "h1", "portal_notice")], false),
      // Paper of the current figures delivers.
      paperCurrent: toFurnish([row(1, "h1", "portal_notice"), row(2, "h2", "paper_handed")], false),
      // A notice of the current figures delivers (R1).
      noticeCurrent: toFurnish(
        [row(1, "h1", "paper_handed"), row(2, "h2", "portal_notice")],
        false,
      ),
      // Download / print / backfill of the current figures never deliver.
      downloadCurrent: toFurnish(
        [row(1, "h1", "backfill"), row(2, "h2", "employee_download"), row(3, "h2", "admin_print")],
        false,
      ),
      // Consented is unchanged: only portal_notice delivers.
      consentedPaperCurrent: toFurnish(
        [row(1, "h1", "backfill"), row(2, "h2", "paper_handed")],
        true,
      ),
      consentedNoticeCurrent: toFurnish(
        [row(1, "h1", "backfill"), row(2, "h2", "portal_notice")],
        true,
      ),
    }).toEqual({
      oldNoticeOnly: true,
      paperCurrent: false,
      noticeCurrent: false,
      downloadCurrent: true,
      consentedPaperCurrent: true,
      consentedNoticeCurrent: false,
    });
  });

  it("[backfill H_nov, portal_notice H_dec], current Jan-Dec, consent withdrawn -> list toFurnish false; reconcile sends no courtesy mail, writes no row", async () => {
    const { reconcileW2Furnishings } = await furnishModule();
    const e = await makeW2Emp(env, { grossCents: G, login: true, consent: true });
    await seedHistory2025(env, e, JAN_DEC);
    const [hNov, hDec] = await Promise.all([hashOf(e.id, Y, B_NOV), hashOf(e.id, Y, B_DEC)]);
    await rawFurnishing(env.t, {
      employeeId: e.id,
      hash: hNov,
      method: "backfill",
      corrected: false,
      furnishedAt: "2026-01-05T09:00:00Z",
    });
    await rawFurnishing(env.t, {
      employeeId: e.id,
      hash: hDec,
      method: "portal_notice",
      corrected: true,
      furnishedAt: "2026-01-12T09:00:00Z",
    });
    await withdrawConsent(env, e);
    const row = await adminRow(env, e.id);
    const out = await reconcileW2Furnishings(deps(), { today: "2026-01-20" });
    expect({
      list: {
        consented: row.consented,
        corrected: row.corrected,
        correctionToFurnish: row.correctionToFurnish,
        furnished: row.furnished,
      },
      followUps: (out as { followUps?: number }).followUps,
      changedMails: (await mails(e.userId, "w2_changed")).length,
      rows: brief(await furnishings(env.t, e.id)),
      after: (await adminRow(env, e.id)).correctionToFurnish,
    }).toEqual({
      list: { consented: false, corrected: true, correctionToFurnish: false, furnished: "online" },
      followUps: 0,
      changedMails: 0,
      rows: [
        { method: "backfill", hash: hNov, corrected: false },
        { method: "portal_notice", hash: hDec, corrected: true },
      ],
      after: false,
    });
  });
});

// ---------------------------------------------------------------- R2

describe("R2 year notice: a non-consented recipient is mailed once per year across retries", () => {
  it("A (login, no consent) mailed; B (consented) fails -> year un-notified; the retry mails B once and A not again", async () => {
    const a = await makeW2Emp(env, { grossCents: G, login: true, consent: false });
    await seedHistory2025(env, a, JAN_DEC);
    const b = await makeW2Emp(env, { grossCents: G, login: true, consent: true });
    await seedHistory2025(env, b, JAN_DEC);
    await env.t.pglite.exec(`
      CREATE OR REPLACE FUNCTION pay206_r2_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'pay206 injected notice failure'; END $$;
      CREATE TRIGGER pay206_r2_fail BEFORE INSERT ON w2_furnishings FOR EACH ROW
        WHEN (NEW.employee_id = ${b.id}) EXECUTE FUNCTION pay206_r2_fail();`);
    try {
      await sendW2AvailableNotices(deps(), { today: "2026-01-05" }).catch(() => undefined);
    } finally {
      await dropTrigger("pay206_r2_fail", "w2_furnishings");
    }
    const first = {
      a: (await mails(a.userId, "w2_available")).length,
      b: (await mails(b.userId, "w2_available")).length,
      notified: await flagSet("w2_available_notified_years"),
    };
    await sendW2AvailableNotices(deps(), { today: "2026-01-06" });
    const aMails = await mails(a.userId, "w2_available");
    expect({
      first,
      a: aMails.length,
      aMarker: aMails.every((m) => m.bodyHtml.includes(`<!-- w2-available:${Y} -->`)),
      aRows: (await furnishings(env.t, a.id)).length,
      b: (await mails(b.userId, "w2_available")).length,
      bNotices: (await furnishings(env.t, b.id)).filter((r) => r.method === "portal_notice").length,
    }).toEqual({
      first: { a: 1, b: 0, notified: false },
      a: 1,
      aMarker: true,
      aRows: 0,
      b: 1,
      bNotices: 1,
    });
  });

  it("three ticks while B keeps failing: A (no consent) still holds exactly one w2_available mail", async () => {
    const a = await makeW2Emp(env, { grossCents: G, login: true, consent: false });
    await seedHistory2025(env, a, JAN_DEC);
    const b = await makeW2Emp(env, { grossCents: G, login: true, consent: false });
    await seedHistory2025(env, b, JAN_DEC);
    await env.t.pglite.exec(`
      CREATE OR REPLACE FUNCTION pay206_r2_fail_mail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'pay206 injected mail failure'; END $$;
      CREATE TRIGGER pay206_r2_fail_mail BEFORE INSERT ON email_outbox FOR EACH ROW
        WHEN (NEW.user_id = '${b.userId}' AND NEW.event_type = 'w2_available')
        EXECUTE FUNCTION pay206_r2_fail_mail();`);
    try {
      for (const day of ["2026-01-05", "2026-01-06", "2026-01-07"]) {
        await sendW2AvailableNotices(deps(), { today: day }).catch(() => undefined);
      }
    } finally {
      await dropTrigger("pay206_r2_fail_mail", "email_outbox");
    }
    expect({
      a: (await mails(a.userId, "w2_available")).length,
      b: (await mails(b.userId, "w2_available")).length,
      notified: await flagSet("w2_available_notified_years"),
    }).toEqual({ a: 1, b: 0, notified: false });
  });
});

// ---------------------------------------------------------------- R3

describe("R3 backfill: an unreadable notified year counts as failed; the flag is not set", () => {
  it("notified [2023 (issued run, no 2023 federal tax_config), 2025]: 2025 backfilled, failed > 0, flag absent; once 2023 reads, the next call sets the flag", async () => {
    const { backfillW2Furnishings } = await furnishModule();
    const config2023 = await env.t.db
      .select({ id: taxConfig.id })
      .from(taxConfig)
      .where(eq(taxConfig.taxYear, 2023));
    expect(config2023).toEqual([]);
    const old = await makeW2Emp(env, { grossCents: G, login: false });
    await history(env.t, old, "2023-06", "2023-06-25", oracleRun2025(G), null);
    const cur = await makeW2Emp(env, { grossCents: G, login: false });
    await seedHistory2025(env, cur, JAN_DEC);
    await setNotifiedYears(env.t, [2023, Y]);
    const first = (await backfillW2Furnishings(deps(), { today: "2026-03-01" })) as {
      inserted: number;
      skipped: boolean;
      failed: number;
    };
    const firstView = {
      skipped: first.skipped,
      failed: first.failed > 0,
      flag: await flagSet("w2_furnishings_backfilled"),
      cur: brief(await furnishings(env.t, cur.id)),
    };
    // Synthetic 2023 federal config (SSA 2023 wage base 160,200; 2023 std deduction 13,850).
    await env.t.db.insert(taxConfig).values({
      jurisdiction: "federal",
      taxYear: 2023,
      standardDeduction: "13850.00",
      socialSecurityRate: "0.06200",
      socialSecurityWageCap: "160200.00",
      medicareRate: "0.01450",
      medicareAdditionalRate: "0.00900",
      medicareAdditionalThreshold: "200000.00",
      stateWithholdingRate: "0",
      employerSocialSecurityRate: "0.06200",
      employerMedicareRate: "0.01450",
      futaRate: "0.00600",
      futaWageCap: "7000.00",
      sutaCreditRate: "0.05400",
    });
    try {
      const second = (await backfillW2Furnishings(deps(), { today: "2026-03-02" })) as {
        skipped: boolean;
        failed: number;
      };
      expect({
        firstView,
        second: { skipped: second.skipped, failed: second.failed },
        flag: await flagSet("w2_furnishings_backfilled"),
        old2023: (await furnishings(env.t, old.id, 2023)).map((r) => r.method),
      }).toEqual({
        firstView: {
          skipped: false,
          failed: true,
          flag: false,
          cur: [{ method: "backfill", hash: await hashOf(cur.id, Y, B_DEC), corrected: false }],
        },
        second: { skipped: false, failed: 0 },
        flag: true,
        old2023: ["backfill"],
      });
    } finally {
      await env.t.db.delete(taxConfig).where(eq(taxConfig.taxYear, 2023));
    }
  });
});

// ---------------------------------------------------------------- R4

describe("R4 admin list `consented` = active consent AND a login", () => {
  it("login+active true; login+withdrawn false; no login+active consent row false; login+no consent false", async () => {
    const both = await makeW2Emp(env, { grossCents: G, login: true, consent: true });
    const withdrawn = await makeW2Emp(env, { grossCents: G, login: true, consent: true });
    const noLogin = await makeW2Emp(env, { grossCents: G, login: false, consent: true });
    const none = await makeW2Emp(env, { grossCents: G, login: true, consent: false });
    for (const e of [both, withdrawn, noLogin, none]) await seedHistory2025(env, e, JAN_DEC);
    await withdrawConsent(env, withdrawn);
    const c = async (e: W2Emp) => (await adminRow(env, e.id)).consented;
    expect({
      both: await c(both),
      withdrawn: await c(withdrawn),
      noLogin: await c(noLogin),
      none: await c(none),
    }).toEqual({ both: true, withdrawn: false, noLogin: false, none: false });
  });
});

// ---------------------------------------------------------------- R5

let ipSeq = 0;
function ip(): string {
  ipSeq += 1;
  return `10.211.${Math.floor(ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;
}

async function copyD(
  employeeId: number,
  o: { headers?: Record<string, string>; ip?: string; admin?: Record<string, string> } = {},
) {
  const addr = o.ip ?? ip();
  return env.t.app.inject({
    method: "GET",
    url: `/api/admin/annual-forms/w2/${employeeId}/pdf?year=${Y}`,
    headers: { ...(o.admin ?? env.admin), "x-forwarded-for": addr, ...(o.headers ?? {}) },
    remoteAddress: addr,
  });
}

/** Log lines written while `body` runs. */
async function logsDuring<T>(body: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const start = env.logs.length;
  const result = await body();
  // Fastify logs "Reply was already sent" after the response can resolve.
  await new Promise((r) => setTimeout(r, 50));
  return { result, lines: env.logs.slice(start) };
}

const completed = (lines: string[]) => lines.filter((l) => l.includes("request completed")).length;
const alreadySent = (lines: string[]) =>
  lines.filter((l) => /already sent|FST_ERR_REP_ALREADY_SENT/i.test(l)).length;

describe("R5 Copy D route: Sec-Fetch-Site and rate limit; one response per refused request", () => {
  for (const site of ["cross-site", "same-site"]) {
    it(`Copy D, Sec-Fetch-Site: ${site} -> 403 { error: "cross_site" }, no PDF`, async () => {
      const a = await makeW2Emp(env, { grossCents: G, login: false });
      await seedHistory2025(env, a, JAN_DEC);
      const res = await copyD(a.id, { headers: { "sec-fetch-site": site } });
      expect([res.statusCode, safeJson(res)]).toEqual([403, { error: "cross_site" }]);
    });
  }

  it("Copy D: same-origin, none and no header -> 200 PDF", async () => {
    const a = await makeW2Emp(env, { grossCents: G, login: false });
    await seedHistory2025(env, a, JAN_DEC);
    const statuses = [
      (await copyD(a.id, { headers: { "sec-fetch-site": "same-origin" } })).statusCode,
      (await copyD(a.id, { headers: { "sec-fetch-site": "none" } })).statusCode,
      (await copyD(a.id)).statusCode,
    ];
    expect(statuses).toEqual([200, 200, 200]);
  });

  it("Copy D: 20 requests per minute pass the limiter; the 21st -> 429", async () => {
    const admin = await freshAdmin(env);
    const codes: number[] = [];
    for (let i = 0; i < 21; i += 1) {
      // Unknown employee: 404 after the limiter.
      codes.push((await copyD(987_654, { ip: "10.211.250.1", admin })).statusCode);
    }
    expect({ first20: codes.slice(0, 20).filter((s) => s === 429).length, n21: codes[20] }).toEqual(
      { first20: 0, n21: 429 },
    );
  });

  it("every refusal on the three PDF routes (cross-site with and without a session, 429) logs one 'request completed' and no 'Reply was already sent'", async () => {
    const e = await makeW2Emp(env, { grossCents: G, login: true, consent: true });
    await seedHistory2025(env, e, JAN_DEC);
    const xs = { "sec-fetch-site": "cross-site" };
    const noSession = (url: string) => async () => {
      const addr = ip();
      return env.t.app.inject({
        method: "GET",
        url,
        headers: { "x-forwarded-for": addr, ...xs },
        remoteAddress: addr,
      });
    };
    const cases: [string, () => Promise<{ statusCode: number }>][] = [
      ["mine cross-site", () => myPdf(env, e, Y, { headers: xs })],
      ["packet cross-site", () => printPacket(env, e.id, Y, { headers: xs })],
      ["copyD cross-site", () => copyD(e.id, { headers: xs })],
      ["mine cross-site no session", noSession(`/api/my/w2/${Y}/pdf`)],
      [
        "packet cross-site no session",
        noSession(`/api/admin/annual-forms/w2/${e.id}/print-packet?year=${Y}`),
      ],
      [
        "copyD cross-site no session",
        noSession(`/api/admin/annual-forms/w2/${e.id}/pdf?year=${Y}`),
      ],
    ];
    const seen: Record<string, { status: number; completed: number; alreadySent: number }> = {};
    for (const [name, call] of cases) {
      const { result, lines } = await logsDuring(call);
      seen[name] = {
        status: result.statusCode,
        completed: completed(lines),
        alreadySent: alreadySent(lines),
      };
    }
    // 429 on each route: 20 refused-cheaply requests, then the 21st.
    const admin = await freshAdmin(env);
    const limited = async (name: string, call: () => Promise<{ statusCode: number }>) => {
      for (let i = 0; i < 20; i += 1) await call();
      const { result, lines } = await logsDuring(call);
      seen[name] = {
        status: result.statusCode,
        completed: completed(lines),
        alreadySent: alreadySent(lines),
      };
    };
    const noConsent = await makeW2Emp(env, { grossCents: G, login: true, consent: false });
    await limited("mine 429", () => myPdf(env, noConsent, Y, { ip: "10.211.251.1" }));
    await limited("packet 429", () => printPacket(env, 987_654, Y, { ip: "10.211.251.2", admin }));
    await limited("copyD 429", () => copyD(987_654, { ip: "10.211.251.3", admin }));
    const one = (status: number) => ({ status, completed: 1, alreadySent: 0 });
    expect(seen).toEqual({
      "mine cross-site": one(403),
      "packet cross-site": one(403),
      "copyD cross-site": one(403),
      "mine cross-site no session": one(403),
      "packet cross-site no session": one(403),
      "copyD cross-site no session": one(403),
      "mine 429": one(429),
      "packet 429": one(429),
      "copyD 429": one(429),
    });
  });
});
