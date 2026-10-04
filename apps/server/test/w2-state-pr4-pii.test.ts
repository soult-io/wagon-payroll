/**
 * Spec 24 (PAY-116) PR-4 S1 — an SSN or box f address that does not decrypt
 * holds the W-2 (ssn_unreadable / address_unreadable) on every readiness
 * and furnishing path; nothing answers 500; no value reaches a body or a
 * log (payroll-calc-auditor, fail-first; the coder may not edit this file).
 * Synthetic data only.
 *
 * Tests: C-b1 (SSN ciphertext with one character flipped), C-b2 (current
 * mailing address ciphertext flipped), C-b3 (readable current address, the
 * Dec-31 history value in change_requests.payload flipped).
 *
 * Paths covered (brief S1 "Coverage"): admin list, Copy D, print packet,
 * W-3, employee PDF, GET /api/my/w2 (ready), isMyW2Ready,
 * sendW2AvailableNotices (portal_notice), furnished-on-paper, the late-issue
 * furnishing steps (backfillEmployeeYearIfNeeded, furnishCorrectionIfNeeded
 * — what runs.ts applyLateIssueEffects calls), the one-shot
 * backfillW2Furnishings, and reconcileW2Furnishings.
 *
 * Contract assumed: issue { code: "ssn_unreadable" | "address_unreadable",
 * severity: "block" } (no state key); admin PDF 409 body { error:
 * "w2_not_ready", issues: [code] }; employee 409 body exactly { error:
 * "w2_not_ready" }.
 */

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appSettings, changeRequests, employees, w2Furnishings } from "@payroll/db";
import { encryptAddress } from "../src/crypto/address-encryption.js";
import { encryptField } from "../src/crypto/field-encryption.js";
import { isMyW2Ready, sendW2AvailableNotices } from "../src/filings/annual.js";
import {
  backfillEmployeeYearIfNeeded,
  backfillW2Furnishings,
  furnishCorrectionIfNeeded,
  reconcileW2Furnishings,
} from "../src/filings/w2-furnish.js";
import type { Db } from "../src/db.js";
import {
  bootEnv,
  consentedEmployee,
  enterStateId,
  type Env,
  get,
  insertRuns,
  list,
  setEin,
  SYNTHETIC_EIN,
} from "./w2-state-harness.js";
import { type FxRun, monthly, months, st } from "./w2-state-oracle.js";

const CA = st("CA");
const NOW = "2027-01-05T12:00:00Z";
const TODAY = "2027-01-05";
const ana = (): FxRun[] => months(2026, 1, 12).map((m) => monthly(m, CA, 1234));
const deps = (env: Env) => ({ db: env.t.db, config: env.t.config }) as never;

const SSN = "900000017";
const ADDRESS = {
  line1: "17 Synthetic Lane",
  city: "Fixtureville",
  state: "CA",
  zip: "90017",
  country: "US",
};
const SECRETS = [SSN, "900-00-0017", "Synthetic Lane", "Fixtureville"];

/** Flip one base64url character inside the IV: GCM authentication then fails. */
function flip(ciphertext: string): string {
  const i = "enc:v1:".length + 10;
  return ciphertext.slice(0, i) + (ciphertext[i] === "A" ? "B" : "A") + ciphertext.slice(i + 1);
}

interface Fixture {
  env: Env;
  id: number;
  session: Record<string, string>;
  lines: string[];
}

async function boot(name: string): Promise<Fixture> {
  const lines: string[] = [];
  const env = await bootEnv({ now: NOW, logStream: { write: (m: string) => void lines.push(m) } });
  await setEin(env, SYNTHETIC_EIN);
  await enterStateId(env, "CA", "00000001");
  const emp = await consentedEmployee(env, name);
  await insertRuns(env, emp.employeeId, ana());
  return { env, id: emp.employeeId, session: emp.session, lines };
}

const pdfUrls = (id: number) => [
  `/api/admin/annual-forms/w2/${id}/pdf?year=2026`,
  `/api/admin/annual-forms/w2/${id}/print-packet?year=2026`,
  "/api/admin/annual-forms/w3/pdf?year=2026",
];

async function furnishingCount(env: Env, id: number): Promise<number> {
  return (await env.t.db.select().from(w2Furnishings).where(eq(w2Furnishings.employeeId, id)))
    .length;
}

/** The list row's issues of the given code, the blocked flag, and the HTTP status. */
async function listView(f: Fixture, code: string) {
  const l = await list(f.env, 2026);
  const row = l.json.w2s.find((r) => r.employeeId === f.id);
  return {
    status: l.status,
    hits: (row?.issues ?? []).filter((i) => (i as { code: string }).code === code),
    blocked: row?.blocked,
    body: l.body,
  };
}

/** Every route and readiness path for a held W-2; no 500, no value in a body or log. */
function heldEverywhere(
  code: "ssn_unreadable" | "address_unreadable",
  setup: (f: Fixture) => Promise<void>,
) {
  let f: Fixture;
  let mark = 0;
  beforeAll(async () => {
    f = await boot(code === "ssn_unreadable" ? "Ana Ssn Synthetic" : "Ana Addr Synthetic");
    await setup(f);
    mark = f.lines.length;
  }, 180_000);
  afterAll(async () => f.env.close());

  it(`list 200: exactly one {code: ${code}, severity: block} (no state key); blocked true`, async () => {
    const v = await listView(f, code);
    expect({ status: v.status, hits: v.hits, blocked: v.blocked }).toEqual({
      status: 200,
      hits: [{ code, severity: "block" }],
      blocked: true,
    });
    for (const s of SECRETS) expect(v.body, `list body leaks ${s}`).not.toContain(s);
  });

  it("late-issue furnishing steps, run before anything furnishes (year marked notified, backfill not run): backfillEmployeeYearIfNeeded false, no row; one-shot backfill inserts 0", async () => {
    await f.env.t.db
      .insert(appSettings)
      .values({ key: "w2_available_notified_years", value: [2026], updatedAt: new Date() })
      .onConflictDoUpdate({ target: [appSettings.key], set: { value: [2026] } });
    const before = await furnishingCount(f.env, f.id);
    const lazy = await f.env.t.db.transaction((tx) =>
      backfillEmployeeYearIfNeeded(tx as never, f.id, 2026, TODAY),
    );
    const oneShot = await backfillW2Furnishings(deps(f.env), { today: TODAY });
    expect({
      lazy,
      inserted: oneShot.inserted,
      furnished: (await furnishingCount(f.env, f.id)) - before,
    }).toEqual({ lazy: false, inserted: 0, furnished: 0 });
    // Undo the fixture marker so the notice test below starts from an
    // un-notified year (the backfill flag may stay set).
    await f.env.t.db.delete(appSettings).where(eq(appSettings.key, "w2_available_notified_years"));
  });

  it(`Copy D, print packet, W-3 -> 409 {w2_not_ready, [${code}]}; employee PDF -> 409 bare body; no 500; no furnishing row`, async () => {
    const before = await furnishingCount(f.env, f.id);
    const out: unknown[] = [];
    const bodies: string[] = [];
    for (const url of pdfUrls(f.id)) {
      const res = await get(f.env, url);
      bodies.push(res.body);
      out.push({ url, status: res.statusCode, body: safeJson(res.body) });
    }
    const mine = await get(f.env, "/api/my/w2/2026/pdf", f.session);
    bodies.push(mine.body);
    out.push({ url: "my", status: mine.statusCode, body: safeJson(mine.body) });
    expect({
      out,
      furnished: (await furnishingCount(f.env, f.id)) - before,
      leaks: SECRETS.filter((s) => bodies.some((b) => b.includes(s))),
    }).toEqual({
      out: [
        ...pdfUrls(f.id).map((url) => ({
          url,
          status: 409,
          body: { error: "w2_not_ready", issues: [code] },
        })),
        { url: "my", status: 409, body: { error: "w2_not_ready" } },
      ],
      furnished: 0,
      leaks: [],
    });
  });

  it("isMyW2Ready false; /api/my/w2 ready false; notices {sent: 0}; furnished-on-paper 409 w2_not_ready; no furnishing row", async () => {
    const before = await furnishingCount(f.env, f.id);
    const ready = await isMyW2Ready(f.env.t.db as unknown as Db, f.id, 2026);
    const my = await get(f.env, "/api/my/w2", f.session);
    const myRow = (my.json() as { w2s: { year: number; ready: boolean }[] }).w2s.find(
      (r) => r.year === 2026,
    );
    const notice = await sendW2AvailableNotices(deps(f.env), { today: TODAY });
    const paper = await f.env.t.app.inject({
      method: "POST",
      url: `/api/admin/annual-forms/w2/${f.id}/furnished-on-paper?year=2026`,
      headers: f.env.admin,
    });
    expect({
      ready,
      myStatus: my.statusCode,
      myReady: myRow?.ready,
      notice,
      paper: {
        status: paper.statusCode,
        error: (safeJson(paper.body) as { error?: string }).error,
      },
      furnished: (await furnishingCount(f.env, f.id)) - before,
    }).toEqual({
      ready: false,
      myStatus: 200,
      myReady: false,
      notice: { sent: 0 },
      paper: { status: 409, error: "w2_not_ready" },
      furnished: 0,
    });
    for (const s of SECRETS) expect(paper.body).not.toContain(s);
  });

  it("an earlier furnishing with other figures: furnishCorrectionIfNeeded and reconcileW2Furnishings furnish no CORRECTED copy while held", async () => {
    await f.env.t.db.insert(w2Furnishings).values({
      employeeId: f.id,
      taxYear: 2026,
      boxesHash: "0".repeat(64),
      hashVersion: 2,
      corrected: false,
      method: "portal_notice",
      actorId: null,
    });
    const before = await furnishingCount(f.env, f.id);
    const direct = await f.env.t.db.transaction((tx) =>
      furnishCorrectionIfNeeded(tx as never, f.env.t.config, f.id, 2026, TODAY),
    );
    await reconcileW2Furnishings(deps(f.env), { today: TODAY });
    const corrected = await f.env.t.db
      .select()
      .from(w2Furnishings)
      .where(and(eq(w2Furnishings.employeeId, f.id), eq(w2Furnishings.corrected, true)));
    expect({
      direct,
      furnished: (await furnishingCount(f.env, f.id)) - before,
      corrected: corrected.length,
    }).toEqual({ direct: null, furnished: 0, corrected: 0 });
  });

  it("captured logs: no SSN digits, no address text", () => {
    const captured = f.lines.slice(mark).join("");
    expect(SECRETS.filter((s) => captured.includes(s))).toEqual([]);
  });
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return { nonJson: body.slice(0, 40) };
  }
}

describe("C-b1 SSN ciphertext with one character flipped (2026, CA ID set, consented)", () => {
  heldEverywhere("ssn_unreadable", async (f) => {
    const key = f.env.t.config.encryptionKey;
    await f.env.t.db
      .update(employees)
      .set({ taxId: flip(encryptField(SSN, key)) })
      .where(eq(employees.id, f.id));
  });
});

describe("C-b2 current mailing address ciphertext with one character flipped", () => {
  heldEverywhere("address_unreadable", async (f) => {
    const key = f.env.t.config.encryptionKey;
    await f.env.t.db
      .update(employees)
      .set({ mailingAddress: flip(encryptAddress(ADDRESS, key)) as never })
      .where(eq(employees.id, f.id));
  });
});

describe("C-b3 readable current address; the Dec-31 history value (change_requests.payload) flipped", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await boot("Ana History Synthetic");
    const key = f.env.t.config.encryptionKey;
    await f.env.t.db
      .update(employees)
      .set({ mailingAddress: encryptAddress(ADDRESS, key) as never })
      .where(eq(employees.id, f.id));
    await f.env.t.db.insert(changeRequests).values({
      employeeId: f.id,
      requestType: "mailing_address",
      payload: flip(encryptAddress({ ...ADDRESS, line1: "18 Synthetic Lane" }, key)),
      effectiveFrom: "2026-06-01",
      status: "approved",
      decidedBy: "test",
      decidedAt: new Date("2026-05-20T00:00:00Z"),
      appliedAt: new Date("2026-05-20T00:00:00Z"),
    });
  }, 180_000);
  afterAll(async () => f.env.close());

  it("list: exactly one address_unreadable block (the box f resolution path, not only the current column)", async () => {
    const v = await listView(f, "address_unreadable");
    expect({ status: v.status, hits: v.hits, blocked: v.blocked }).toEqual({
      status: 200,
      hits: [{ code: "address_unreadable", severity: "block" }],
      blocked: true,
    });
  });

  it("Copy D -> 409 {w2_not_ready, [address_unreadable]}, never 500", async () => {
    const res = await get(f.env, pdfUrls(f.id)[0] as string);
    expect({ status: res.statusCode, body: safeJson(res.body) }).toEqual({
      status: 409,
      body: { error: "w2_not_ready", issues: ["address_unreadable"] },
    });
  });
});
