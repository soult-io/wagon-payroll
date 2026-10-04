/**
 * Spec 24 (PAY-116) PR-3 fix round 3 (code-reviewer round 2 HIGH H1, L1,
 * L4) — payroll-calc-auditor, fail-first; the coder may not edit this file.
 * Rebuild @payroll/documents before running. Synthetic data only.
 *
 * H1 The correction path furnishes only a W-2 that can be printed. After a
 *    2026 W-2 was furnished (employee_download), the box 15 ID becomes
 *    unreadable / the EIN becomes unreadable / the stored ID no longer fits
 *    the form: reconcileW2Furnishings and furnishCorrectionIfNeeded (the
 *    late-issue entry point: runs.ts applyLateIssueEffects calls it inside
 *    the issue transaction under the employee lock — called here the same
 *    way) write no w2_furnishings row and queue no mail. After the data is
 *    repaired, reconcile furnishes the correction once (one corrected
 *    portal_notice row, one mail), and a second reconcile does nothing.
 *    backfillEmployeeYearIfNeeded / backfillW2Furnishings write no backfill
 *    row for a W-2 held by ein_unreadable.
 * L1 A year with no bundled form (2024): the admin PDF routes answer 409
 *    { error: "form_not_available", year: 2024 } even when the EIN does not
 *    decrypt — the form check comes before any decrypt or probe.
 * L4 A stored state ID with a character outside WinAnsi ("ID一123", a valid
 *    ciphertext) holds the W-2 as a block (409 w2_not_ready with
 *    state_id_too_long or state_id_unreadable), never a 500; neither the
 *    character nor the ID appears in any response body or captured log.
 */

import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { company, emailOutbox, w2Furnishings } from "@payroll/db";
import { isMyW2Ready, sendW2AvailableNotices } from "../src/filings/annual.js";
import {
  backfillEmployeeYearIfNeeded,
  backfillW2Furnishings,
  furnishCorrectionIfNeeded,
  reconcileW2Furnishings,
} from "../src/filings/w2-furnish.js";
import { encryptField } from "../src/crypto/field-encryption.js";
import { lockEmployee } from "../src/payroll/locks.js";
import type { Db } from "../src/db.js";
import { setNotifiedYears } from "./annual-w2-corrected-harness.js";
import {
  bootEnv,
  consentedEmployee,
  createEmployee,
  enterStateId,
  type Env,
  federalConfig,
  get,
  insertRun,
  insertRuns,
  list,
  rowOf,
  setEin,
  SYNTHETIC_EIN,
} from "./w2-state-harness.js";
import { type FxRun, monthly, months, st } from "./w2-state-oracle.js";

const CA = st("CA");
const ana = (): FxRun[] => months(2026, 1, 12).map((m) => monthly(m, CA, 1234));
const TODAY = "2027-01-05";
const ID64 = `${"1234567890".repeat(6)}1234`;

const deps = (env: Env) => ({ db: env.t.db, config: env.t.config }) as never;

async function methods(env: Env, employeeId: number) {
  return (
    await env.t.db
      .select()
      .from(w2Furnishings)
      .where(eq(w2Furnishings.employeeId, employeeId))
      .orderBy(w2Furnishings.id)
  ).map((r) => ({ method: r.method, corrected: r.corrected }));
}

async function mails(env: Env): Promise<number> {
  return (await env.t.db.select().from(emailOutbox)).length;
}

function flip(value: string): string {
  const i = "enc:v1:".length + 10;
  return value.slice(0, i) + (value[i] === "A" ? "B" : "A") + value.slice(i + 1);
}

async function corruptCa(env: Env): Promise<void> {
  const col = await env.t.pglite.query<{ state_id: string }>(
    "SELECT state_id FROM company_state_ids WHERE state_code = 'CA'",
  );
  await env.t.pglite.query("UPDATE company_state_ids SET state_id = $1 WHERE state_code = 'CA'", [
    flip(col.rows[0]?.state_id ?? ""),
  ]);
}

async function storeCa(env: Env, plain: string): Promise<void> {
  await env.t.pglite.query("UPDATE company_state_ids SET state_id = $1 WHERE state_code = 'CA'", [
    encryptField(plain, env.t.config.encryptionKey),
  ]);
}

async function corruptEin(env: Env): Promise<void> {
  const [c] = await env.t.db.select({ ein: company.ein }).from(company).limit(1);
  await env.t.db.update(company).set({ ein: flip(c?.ein ?? "") });
}

async function putCa(env: Env, stateId: string) {
  return env.t.app.inject({
    method: "PUT",
    url: "/api/admin/company/state-ids/CA",
    headers: env.admin,
    payload: { stateId },
  });
}

/** The late-issue entry point, as runs.ts applyLateIssueEffects calls it. */
async function lateIssueFollowUp(env: Env, employeeId: number) {
  return env.t.db.transaction(async (tx) => {
    await lockEmployee(tx as never, employeeId);
    return furnishCorrectionIfNeeded(tx as never, env.t.config, employeeId, 2026, TODAY);
  });
}

/** Boot, enter CA, a consented Ana with W01 runs, furnished once by her own download. */
async function furnishedAna(): Promise<{ env: Env; anaId: number }> {
  const env = await bootEnv({ now: `${TODAY}T12:00:00Z` });
  await setEin(env, SYNTHETIC_EIN);
  await enterStateId(env, "CA", "00000001");
  const a = await consentedEmployee(env, "Ana Roundthree");
  await insertRuns(env, a.employeeId, ana());
  const res = await get(env, "/api/my/w2/2026/pdf", a.session);
  if (res.statusCode !== 200) throw new Error(`setup download -> ${res.statusCode}`);
  return { env, anaId: a.employeeId };
}

// ======================================================================= H1

const H1_CASES: {
  name: string;
  /** Make the W-2 unprintable; the figures hash must differ from the furnished one. */
  breakIt: (env: Env, anaId: number) => Promise<void>;
  repair: (env: Env) => Promise<void>;
}[] = [
  {
    name: "state ID ciphertext corrupted (GCM)",
    breakIt: async (env) => corruptCa(env),
    repair: async (env) => {
      const r = await putCa(env, "00000001");
      if (r.statusCode !== 200) throw new Error(`repair PUT -> ${r.statusCode}`);
    },
  },
  {
    name: "EIN undecryptable (plus a late December run, so the figures changed)",
    breakIt: async (env, anaId) => {
      // An off-cycle December run (own period start; the monthly December run exists).
      await insertRun(env, anaId, {
        payDate: "2026-12-30",
        periodStart: "2026-12-15",
        periodEnd: "2026-12-31",
        grossCents: 100_000,
        swhCents: 100,
        fitCents: 10_000,
        state: CA,
      });
      await corruptEin(env);
    },
    repair: async (env) => setEin(env, SYNTHETIC_EIN),
  },
  {
    name: "stored state ID no longer fits the form (64 digits)",
    breakIt: async (env) => storeCa(env, ID64),
    repair: async (env) => {
      const r = await putCa(env, "00000001");
      if (r.statusCode !== 200) throw new Error(`repair PUT -> ${r.statusCode}`);
    },
  },
];

for (const c of H1_CASES) {
  describe(`H1 correction path, ${c.name}`, () => {
    let env: Env;
    let anaId = 0;
    beforeAll(async () => {
      ({ env, anaId } = await furnishedAna());
    }, 180_000);
    afterAll(async () => env.close());

    it("guard: furnished once (employee_download); a reconcile with nothing changed does nothing", async () => {
      const out = await reconcileW2Furnishings(deps(env), { today: TODAY });
      expect({ out, rows: await methods(env, anaId) }).toEqual({
        out: { checked: 1, followUps: 0, failed: 0 },
        rows: [{ method: "employee_download", corrected: false }],
      });
    });

    it("broken: reconcile and the late-issue follow-up write no row and queue no mail", async () => {
      await c.breakIt(env, anaId);
      const before = await mails(env);
      // Late-issue entry point first, so each path is judged on its own.
      const late = await lateIssueFollowUp(env, anaId);
      const rec = await reconcileW2Furnishings(deps(env), { today: TODAY });
      expect({
        followUps: rec.followUps,
        failed: rec.failed,
        late,
        rows: await methods(env, anaId),
        mails: (await mails(env)) - before,
      }).toEqual({
        followUps: 0,
        failed: 0,
        late: null,
        rows: [{ method: "employee_download", corrected: false }],
        mails: 0,
      });
    });

    it("repaired: reconcile furnishes the correction once (corrected portal_notice + one mail); a second reconcile does nothing", async () => {
      await c.repair(env);
      const before = await mails(env);
      const first = await reconcileW2Furnishings(deps(env), { today: TODAY });
      const mid = (await mails(env)) - before;
      const second = await reconcileW2Furnishings(deps(env), { today: TODAY });
      expect({
        first: first.followUps,
        second: second.followUps,
        rows: await methods(env, anaId),
        mails: mid,
        mailsAfterSecond: (await mails(env)) - before,
      }).toEqual({
        first: 1,
        second: 0,
        rows: [
          { method: "employee_download", corrected: false },
          { method: "portal_notice", corrected: true },
        ],
        mails: 1,
        mailsAfterSecond: 1,
      });
    });
  });
}

describe("H1 backfill: no backfill row for a W-2 held by ein_unreadable", () => {
  let env: Env;
  let anaId = 0;
  let benId = 0;
  beforeAll(async () => {
    env = await bootEnv({ now: `${TODAY}T12:00:00Z` });
    await setEin(env, SYNTHETIC_EIN);
    await enterStateId(env, "CA", "00000001");
    anaId = await createEmployee(env, "Ana Backfill");
    await insertRuns(env, anaId, ana());
    benId = await createEmployee(env, "Ben Backfill");
    await insertRuns(env, benId, ana());
    // The previous release notified 2026 (the backfill's precondition).
    await setNotifiedYears(env.t, [2026]);
    await corruptEin(env);
  }, 180_000);
  afterAll(async () => env.close());

  it("the W-2 is held: list row blocked with ein_unreadable (guard)", async () => {
    const row = await rowOf(env, 2026, anaId);
    expect({
      blocked: row.blocked,
      ein: (row.issues as { code: string }[]).some((i) => i.code === "ein_unreadable"),
    }).toEqual({ blocked: true, ein: true });
  });

  it("lazy backfill (late-issue path, backfillEmployeeYearIfNeeded) -> false, no row", async () => {
    const wrote = await env.t.db.transaction(async (tx) => {
      await lockEmployee(tx as never, anaId);
      return backfillEmployeeYearIfNeeded(tx as never, anaId, 2026, TODAY);
    });
    expect({ wrote, rows: await methods(env, anaId) }).toEqual({ wrote: false, rows: [] });
  });

  it("one-shot backfillW2Furnishings -> inserted 0, no row for either employee", async () => {
    const out = await backfillW2Furnishings(deps(env), { today: TODAY });
    expect({
      inserted: out.inserted,
      ana: await methods(env, anaId),
      ben: await methods(env, benId),
    }).toEqual({ inserted: 0, ana: [], ben: [] });
  });
});

// ======================================================================= L1

describe("L1 no bundled form (2024): form_not_available comes before any decrypt", () => {
  let env: Env;
  let carlId = 0;
  beforeAll(async () => {
    env = await bootEnv({ now: `${TODAY}T12:00:00Z` });
    await setEin(env, SYNTHETIC_EIN);
    await federalConfig(env, 2024);
    carlId = await createEmployee(env, "Carl Noform");
    await insertRuns(env, carlId, [monthly("2024-03", null, undefined)]);
    await corruptEin(env);
  }, 180_000);
  afterAll(async () => env.close());

  it("EIN undecryptable: Copy D, print packet, W-3, paper for 2024 -> 409 { error: form_not_available, year: 2024 }", async () => {
    const urls = [
      `/api/admin/annual-forms/w2/${carlId}/pdf?year=2024`,
      `/api/admin/annual-forms/w2/${carlId}/print-packet?year=2024`,
      "/api/admin/annual-forms/w3/pdf?year=2024",
    ];
    const out: unknown[] = [];
    for (const url of urls) {
      const r = await get(env, url);
      out.push({ url, status: r.statusCode, body: r.json() });
    }
    const p = await env.t.app.inject({
      method: "POST",
      url: `/api/admin/annual-forms/w2/${carlId}/furnished-on-paper?year=2024`,
      headers: env.admin,
    });
    out.push({ url: "paper", status: p.statusCode, body: p.json() });
    const body = { error: "form_not_available", year: 2024 };
    expect(out).toEqual([
      ...urls.map((url) => ({ url, status: 409, body })),
      { url: "paper", status: 409, body },
    ]);
  });
});

// ======================================================================= L4

describe("L4 a stored state ID outside WinAnsi ('ID一123'): block, never 500, never echoed", () => {
  const ODD = "ID一123";
  const lines: string[] = [];
  let env: Env;
  let anaId = 0;
  let session: Record<string, string> = {};

  beforeAll(async () => {
    env = await bootEnv({
      now: `${TODAY}T12:00:00Z`,
      logStream: { write: (m: string) => void lines.push(m) },
    });
    await setEin(env, SYNTHETIC_EIN);
    await enterStateId(env, "CA", ODD);
    const a = await consentedEmployee(env, "Ana Oddid");
    anaId = a.employeeId;
    session = a.session;
    await insertRuns(env, anaId, ana());
  }, 180_000);
  afterAll(async () => env.close());
  afterEach(() => vi.restoreAllMocks());

  it("PDF routes 409 w2_not_ready (state_id_too_long | state_id_unreadable); list blocked; not ready; notices 0; no row; nothing echoed in bodies or logs", async () => {
    const consoleLines: string[] = [];
    for (const k of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, k).mockImplementation((...a: unknown[]) => {
        consoleLines.push(a.map(String).join(" "));
      });
    }
    const before = lines.length;
    const admin = [
      await get(env, `/api/admin/annual-forms/w2/${anaId}/pdf?year=2026`),
      await get(env, `/api/admin/annual-forms/w2/${anaId}/print-packet?year=2026`),
      await get(env, "/api/admin/annual-forms/w3/pdf?year=2026"),
    ];
    const mine = await get(env, "/api/my/w2/2026/pdf", session);
    const l = await list(env, 2026);
    const row = l.json.w2s?.find((r) => r.employeeId === anaId);
    const ready = await isMyW2Ready(env.t.db as unknown as Db, anaId, 2026);
    const notice = await sendW2AvailableNotices(deps(env), { today: TODAY });
    const BLOCK = ["state_id_too_long", "state_id_unreadable"];
    const isBlock = (r: { statusCode: number; json(): { error?: string; issues?: string[] } }) =>
      r.statusCode === 409 &&
      r.json().error === "w2_not_ready" &&
      (r.json().issues ?? []).length === 1 &&
      BLOCK.includes((r.json().issues ?? [])[0] as string);
    const bodies = [...admin, mine, l].map((r) => r.body);
    const logged = lines.slice(before).join("") + consoleLines.join("\n");
    const leaks = (text: string) =>
      ["一", ODD, "\\u4e00", "\\u4E00", "e4b880"].filter((s) => text.includes(s));
    expect({
      admin: admin.map(isBlock),
      mine: [mine.statusCode, mine.statusCode === 200 ? "<pdf>" : mine.json()],
      list: l.status,
      blocked: row?.blocked,
      ready,
      notice,
      rows: await methods(env, anaId),
      bodyLeaks: bodies.flatMap(leaks),
      logLeaks: leaks(logged),
      logged: logged.includes("/api/admin/annual-forms"),
    }).toEqual({
      admin: [true, true, true],
      mine: [409, { error: "w2_not_ready" }],
      list: 200,
      blocked: true,
      ready: false,
      notice: { sent: 0 },
      rows: [],
      bodyLeaks: [],
      logLeaks: [],
      logged: true,
    });
  });
});
