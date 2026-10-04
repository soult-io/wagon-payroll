/**
 * Spec 24 (PAY-116) PR-3 fix round 2 (Product Lead 2026-10-04) —
 * payroll-calc-auditor, fail-first; the coder may not edit this file.
 * Rebuild @payroll/documents before running. Synthetic data only.
 *
 * R1 an unreadable state ID blocks readiness and furnishing on every path:
 *    admin list, notices (consented portal_notice), isMyW2Ready / employee
 *    list, paper furnishing; all recover after the admin re-enters the ID.
 * R3 the v2 furnishing hash covers box 15: a rewritten ciphertext of the
 *    entered row, and an ein_default -> entered change, make the next
 *    furnishing CORRECTED. Stored hash = the auditor's canonical v2
 *    (w2-state-oracle hashV2) with the SHA-256 of the stored ciphertext.
 * R4 an EIN that does not decrypt -> 409 ein_unreadable on every PDF path,
 *    any year; never a 500; no furnishing row; recovers.
 * R5 a 64-character state ID (64 digits: 213.5 pt at 6 pt, wider than
 *    f2_32 127.6 pt and f1_24 186.2 pt) -> block state_id_too_long before
 *    any furnishing row, never a 500. A 32-digit ID fits after auto-size:
 *    200 and printed in full.
 * R7 the W-3 PDF route refuses cross-site / same-site (403 cross_site) and
 *    is limited to 20 per minute per client (21st -> 429).
 *
 * Contract assumed: issue codes "state_id_unreadable", "ein_unreadable",
 * "state_id_too_long" (W2IssueCode, severity block); 409 bodies
 * { error: "w2_not_ready", issues: [code] } (admin), { error: "w2_not_ready" }
 * (employee). Route paths as on 992faea.
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents, company, emailOutbox, w2Furnishings } from "@payroll/db";
import { isMyW2Ready, sendW2AvailableNotices } from "../src/filings/annual.js";
import { encryptField } from "../src/crypto/field-encryption.js";
import type { Db } from "../src/db.js";
import { markedPages, pageXObjectStrings, pdfLib } from "./annual-w2-corrected-harness.js";
import {
  bootEnv,
  consentedEmployee,
  createEmployee,
  enterStateId,
  type Env,
  get,
  insertRuns,
  list,
  rowOf,
  setEin,
  SYNTHETIC_EIN,
} from "./w2-state-harness.js";
import {
  ciphertextDigest,
  expBoxes,
  expLines,
  type FxRun,
  hashV2,
  monthly,
  months,
  st,
} from "./w2-state-oracle.js";

const CA = st("CA");
const IL = st("IL");
const ana = (): FxRun[] => months(2026, 1, 12).map((m) => monthly(m, CA, 1234));
const ivy = (): FxRun[] => months(2026, 1, 12).map((m) => monthly(m, IL, 24750));

const deps = (env: Env) => ({ db: env.t.db, config: env.t.config }) as never;
const db = (env: Env) => env.t.db as unknown as Db;

async function rows(env: Env, employeeId: number) {
  return env.t.db.select().from(w2Furnishings).where(eq(w2Furnishings.employeeId, employeeId));
}

async function outboxCount(env: Env): Promise<number> {
  return (await env.t.db.select().from(emailOutbox)).length;
}

/** Flip one character of the stored ciphertext (still passes the column CHECK). */
function flip(value: string): string {
  const i = "enc:v1:".length + 10;
  return value.slice(0, i) + (value[i] === "A" ? "B" : "A") + value.slice(i + 1);
}

async function corruptStateId(env: Env, state: string): Promise<void> {
  const col = await env.t.pglite.query<{ state_id: string }>(
    "SELECT state_id FROM company_state_ids WHERE state_code = $1",
    [state],
  );
  await env.t.pglite.query("UPDATE company_state_ids SET state_id = $1 WHERE state_code = $2", [
    flip(col.rows[0]?.state_id ?? ""),
    state,
  ]);
}

async function storedStateId(env: Env, state: string): Promise<string> {
  const col = await env.t.pglite.query<{ state_id: string }>(
    "SELECT state_id FROM company_state_ids WHERE state_code = $1",
    [state],
  );
  return col.rows[0]?.state_id ?? "";
}

async function paper(env: Env, employeeId: number, year = 2026) {
  return env.t.app.inject({
    method: "POST",
    url: `/api/admin/annual-forms/w2/${employeeId}/furnished-on-paper?year=${year}`,
    headers: env.admin,
  });
}

async function putStateId(env: Env, state: string, stateId: string) {
  return env.t.app.inject({
    method: "PUT",
    url: `/api/admin/company/state-ids/${state}`,
    headers: env.admin,
    payload: { stateId },
  });
}

function codes(row: { issues: unknown[] }): string[] {
  return (row.issues as { code: string }[]).map((i) => i.code);
}

// ======================================================================= R1

describe("R1 unreadable state ID blocks readiness and furnishing; recovers after re-entry (clock 2027-01-04)", () => {
  let env: Env;
  let anaId = 0;
  let session: Record<string, string> = {};

  beforeAll(async () => {
    env = await bootEnv({ now: "2027-01-04T12:00:00Z" });
    await setEin(env, SYNTHETIC_EIN);
    await enterStateId(env, "CA", "00000001");
    const a = await consentedEmployee(env, "Ana Roundtwo");
    anaId = a.employeeId;
    session = a.session;
    await insertRuns(env, anaId, ana());
    await corruptStateId(env, "CA");
  }, 180_000);
  afterAll(async () => env.close());

  it("admin list: 200, Ana blocked, state_id_unreadable among the codes as { code, severity: block } (no value)", async () => {
    const l = await list(env, 2026);
    const row = l.json.w2s.find((r) => r.employeeId === anaId);
    const issue = (row?.issues as Record<string, unknown>[] | undefined)?.find(
      (i) => i.code === "state_id_unreadable",
    );
    expect({
      status: l.status,
      blocked: row?.blocked,
      severity: issue?.severity,
      keys: Object.keys(issue ?? {}).filter((k) => !["code", "severity", "state"].includes(k)),
      leak: l.body.includes("00000001"),
    }).toEqual({ status: 200, blocked: true, severity: "block", keys: [], leak: false });
  });

  it("isMyW2Ready false; employee list ready false, downloadable false", async () => {
    const mine = await env.t.app.inject({ method: "GET", url: "/api/my/w2", headers: session });
    const y = (mine.json().w2s as { year: number; ready: boolean; downloadable: boolean }[]).find(
      (w) => w.year === 2026,
    );
    expect({
      ready: await isMyW2Ready(db(env), anaId, 2026),
      list: { ready: y?.ready, downloadable: y?.downloadable },
    }).toEqual({ ready: false, list: { ready: false, downloadable: false } });
  });

  it("notices on 2027-01-04: sent 0, no w2_furnishings row, no outbox mail", async () => {
    const before = await outboxCount(env);
    const out = await sendW2AvailableNotices(deps(env), { today: "2027-01-04" });
    expect({
      out,
      rows: (await rows(env, anaId)).length,
      mails: (await outboxCount(env)) - before,
    }).toEqual({ out: { sent: 0 }, rows: 0, mails: 0 });
  });

  it("paper furnishing -> 409 { error: w2_not_ready, issues: [state_id_unreadable] }; no row; no audit", async () => {
    const res = await paper(env, anaId);
    const audit = await env.t.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "w2_furnishing.paper_handed"));
    expect({
      status: res.statusCode,
      body: res.json(),
      rows: (await rows(env, anaId)).length,
      audit: audit.length,
    }).toEqual({
      status: 409,
      body: { error: "w2_not_ready", issues: ["state_id_unreadable"] },
      rows: 0,
      audit: 0,
    });
  });

  it("recovery: admin re-enters the CA ID -> list unblocked, ready, notice sends 1 (portal_notice row), paper 200", async () => {
    const put = await putStateId(env, "CA", "00000001");
    const row = await rowOf(env, 2026, anaId);
    const ready = await isMyW2Ready(db(env), anaId, 2026);
    const notice = await sendW2AvailableNotices(deps(env), { today: "2027-01-04" });
    const afterNotice = (await rows(env, anaId)).map((r) => r.method);
    const p = await paper(env, anaId);
    expect({
      put: put.statusCode,
      blocked: row.blocked,
      unreadable: codes(row).includes("state_id_unreadable"),
      ready,
      notice,
      afterNotice,
      paper: p.statusCode,
    }).toEqual({
      put: 200,
      blocked: false,
      unreadable: false,
      ready: true,
      notice: { sent: 1 },
      afterNotice: ["portal_notice"],
      paper: 200,
    });
  });
});

// ======================================================================= R3

describe("R3 v2 hash covers box 15 (stateIdSource + digest of the stored ciphertext)", () => {
  let env: Env;
  let anaId = 0;
  let ivyId = 0;

  beforeAll(async () => {
    env = await bootEnv({ now: "2027-01-04T12:00:00Z" });
    await setEin(env, SYNTHETIC_EIN);
    await enterStateId(env, "CA", "00000001");
    anaId = await createEmployee(env, "Ana Hashbox");
    await insertRuns(env, anaId, ana());
    ivyId = await createEmployee(env, "Ivy Hashbox");
    await insertRuns(env, ivyId, ivy());
  }, 180_000);
  afterAll(async () => env.close());

  async function printPacket(employeeId: number) {
    return get(env, `/api/admin/annual-forms/w2/${employeeId}/print-packet?year=2026`);
  }

  it("first print: the stored hash = canonical v2 with CA { entered, sha256(stored ciphertext) }; not corrected", async () => {
    const res = await printPacket(anaId);
    const [row] = await rows(env, anaId);
    const want = hashV2(anaId, 2026, expBoxes(ana(), 2026), 1, expLines(ana(), 2026), {
      CA: { source: "entered", digest: ciphertextDigest(await storedStateId(env, "CA")) },
    });
    expect({
      status: res.statusCode,
      hash: row?.boxesHash,
      version: row?.hashVersion,
      marked: res.statusCode === 200 ? await markedPages(res.rawPayload) : null,
    }).toEqual({ status: 200, hash: want, version: 2, marked: [] });
  });

  it("guard: printing again with nothing changed is not a correction", async () => {
    const res = await printPacket(anaId);
    expect(await markedPages(res.rawPayload)).toEqual([]);
  });

  it("the CA ID is re-encrypted (same value, new IV) -> list correctionToFurnish; next print CORRECTED [0,2,4]", async () => {
    await env.t.pglite.query("UPDATE company_state_ids SET state_id = $1 WHERE state_code = 'CA'", [
      encryptField("00000001", env.t.config.encryptionKey),
    ]);
    const row = await rowOf(env, 2026, anaId);
    const res = await printPacket(anaId);
    expect({
      corrected: row.corrected,
      toFurnish: row.correctionToFurnish,
      marked: res.statusCode === 200 ? await markedPages(res.rawPayload) : res.statusCode,
    }).toEqual({ corrected: true, toFurnish: true, marked: [0, 2, 4] });
  });

  it("IL from the EIN default, furnished; then an IL row is entered -> CORRECTED", async () => {
    const first = await printPacket(ivyId);
    const firstMarked =
      first.statusCode === 200 ? await markedPages(first.rawPayload) : first.statusCode;
    const [r0] = await rows(env, ivyId);
    const want = hashV2(ivyId, 2026, expBoxes(ivy(), 2026), 1, expLines(ivy(), 2026), {
      IL: { source: "ein_default", digest: null },
    });
    await enterStateId(env, "IL", "123456789");
    const second = await printPacket(ivyId);
    expect({
      firstMarked,
      firstHash: r0?.boxesHash,
      secondMarked:
        second.statusCode === 200 ? await markedPages(second.rawPayload) : second.statusCode,
    }).toEqual({ firstMarked: [], firstHash: want, secondMarked: [0, 2, 4] });
  });

  it("the list's state lines carry no digest or ciphertext (hash input stays server-side)", async () => {
    const l = await list(env, 2026);
    const stored = await storedStateId(env, "CA");
    expect({
      ciphertext: l.body.includes(stored),
      digest: l.body.includes(ciphertextDigest(stored)),
      digestKey: l.body.includes("stateIdDigest"),
    }).toEqual({ ciphertext: false, digest: false, digestKey: false });
  });
});

// ======================================================================= R4

describe("R4 EIN that does not decrypt -> 409 ein_unreadable, never 500, no row; recovers", () => {
  let env: Env;
  let anaId = 0;
  let ivyId = 0;
  let eliId = 0;
  let session: Record<string, string> = {};

  beforeAll(async () => {
    env = await bootEnv({ now: "2027-01-04T12:00:00Z" });
    await setEin(env, SYNTHETIC_EIN);
    await enterStateId(env, "CA", "00000001");
    const a = await consentedEmployee(env, "Ana Einbad");
    anaId = a.employeeId;
    session = a.session;
    await insertRuns(env, anaId, ana());
    ivyId = await createEmployee(env, "Ivy Einbad");
    await insertRuns(env, ivyId, ivy());
    eliId = await createEmployee(env, "Eli Einbad");
    await insertRuns(
      env,
      eliId,
      months(2025, 1, 12).map((m) => monthly(m, null, undefined)),
    );
    const [c] = await env.t.db.select({ ein: company.ein }).from(company).limit(1);
    await env.t.db.update(company).set({ ein: flip(c?.ein ?? "") });
  }, 180_000);
  afterAll(async () => env.close());

  it("Ana (CA entered): Copy D, print packet -> 409 [ein_unreadable]; W-3 2026 -> 409 (ein_unreadable among issues); employee -> bare 409; no row", async () => {
    const body = { error: "w2_not_ready", issues: ["ein_unreadable"] };
    const d = await get(env, `/api/admin/annual-forms/w2/${anaId}/pdf?year=2026`);
    const p = await get(env, `/api/admin/annual-forms/w2/${anaId}/print-packet?year=2026`);
    const w3 = await get(env, "/api/admin/annual-forms/w3/pdf?year=2026");
    const mine = await get(env, "/api/my/w2/2026/pdf", session);
    expect({
      d: [d.statusCode, d.json()],
      p: [p.statusCode, p.json()],
      w3: [w3.statusCode, w3.json().error, (w3.json().issues ?? []).includes("ein_unreadable")],
      mine: [mine.statusCode, mine.json()],
      rows: (await rows(env, anaId)).length,
    }).toEqual({
      d: [409, body],
      p: [409, body],
      w3: [409, "w2_not_ready", true],
      mine: [409, { error: "w2_not_ready" }],
      rows: 0,
    });
  });

  it("Ivy (IL from the EIN default): Copy D -> 409 with ein_unreadable among the issues, never 500", async () => {
    const d = await get(env, `/api/admin/annual-forms/w2/${ivyId}/pdf?year=2026`);
    expect([
      d.statusCode,
      d.json().error,
      (d.json().issues ?? []).includes("ein_unreadable"),
    ]).toEqual([409, "w2_not_ready", true]);
  });

  it("2025 W-2 (no state lines) Copy D -> 409 [ein_unreadable], not 500", async () => {
    const d = await get(env, `/api/admin/annual-forms/w2/${eliId}/pdf?year=2025`);
    expect({ status: d.statusCode, body: d.json() }).toEqual({
      status: 409,
      body: { error: "w2_not_ready", issues: ["ein_unreadable"] },
    });
  });

  it("readiness: list 200 with Ana blocked on ein_unreadable; isMyW2Ready false; notices 0, no row; paper 409, no row", async () => {
    const row = await rowOf(env, 2026, anaId);
    const ready = await isMyW2Ready(db(env), anaId, 2026);
    const notice = await sendW2AvailableNotices(deps(env), { today: "2027-01-04" });
    const p = await paper(env, anaId);
    expect({
      blocked: row.blocked,
      ein: codes(row).includes("ein_unreadable"),
      ready,
      notice,
      paper: [p.statusCode, p.json()],
      rows: (await rows(env, anaId)).length,
    }).toEqual({
      blocked: true,
      ein: true,
      ready: false,
      notice: { sent: 0 },
      paper: [409, { error: "w2_not_ready", issues: ["ein_unreadable"] }],
      rows: 0,
    });
  });

  it("recovery: a valid EIN again -> Copy D 200, ready", async () => {
    await setEin(env, SYNTHETIC_EIN);
    const d = await get(env, `/api/admin/annual-forms/w2/${anaId}/pdf?year=2026`);
    expect({
      status: d.statusCode,
      ready: await isMyW2Ready(db(env), anaId, 2026),
    }).toEqual({ status: 200, ready: true });
  });
});

// ======================================================================= R5

describe("R5 a 64-character state ID: block state_id_too_long before any furnishing row, never 500", () => {
  const ID64 = "1234567890".repeat(6) + "1234";
  let env: Env;
  let anaId = 0;
  let session: Record<string, string> = {};

  beforeAll(async () => {
    env = await bootEnv({ now: "2027-01-04T12:00:00Z" });
    await setEin(env, SYNTHETIC_EIN);
    // Direct insert (the column takes up to 64 characters; PUT validation is per state).
    await enterStateId(env, "CA", ID64);
    const a = await consentedEmployee(env, "Ana Longid");
    anaId = a.employeeId;
    session = a.session;
    await insertRuns(env, anaId, ana());
  }, 180_000);
  afterAll(async () => env.close());

  it("Copy D, print packet, W-3 -> 409 [state_id_too_long]; employee -> bare 409; no row; no body echoes the ID", async () => {
    expect(ID64.length).toBe(64);
    const body = { error: "w2_not_ready", issues: ["state_id_too_long"] };
    const res = [
      await get(env, `/api/admin/annual-forms/w2/${anaId}/pdf?year=2026`),
      await get(env, `/api/admin/annual-forms/w2/${anaId}/print-packet?year=2026`),
      await get(env, "/api/admin/annual-forms/w3/pdf?year=2026"),
    ];
    const mine = await get(env, "/api/my/w2/2026/pdf", session);
    expect({
      admin: res.map((r) => [r.statusCode, r.statusCode === 200 ? "<pdf>" : r.json()]),
      mine: [mine.statusCode, mine.statusCode === 200 ? "<pdf>" : mine.json()],
      rows: (await rows(env, anaId)).length,
      echo: [...res, mine].some((r) => r.body.includes(ID64)),
    }).toEqual({
      admin: [
        [409, body],
        [409, body],
        [409, body],
      ],
      mine: [409, { error: "w2_not_ready" }],
      rows: 0,
      echo: false,
    });
  });

  it("no furnishing path writes a row: notices 0, isMyW2Ready false, paper 409 [state_id_too_long]; list 200", async () => {
    const notice = await sendW2AvailableNotices(deps(env), { today: "2027-01-04" });
    const ready = await isMyW2Ready(db(env), anaId, 2026);
    const p = await paper(env, anaId);
    const l = await list(env, 2026);
    expect({
      notice,
      ready,
      paper: [p.statusCode, p.json()],
      list: l.status,
      rows: (await rows(env, anaId)).length,
    }).toEqual({
      notice: { sent: 0 },
      ready: false,
      paper: [409, { error: "w2_not_ready", issues: ["state_id_too_long"] }],
      list: 200,
      rows: 0,
    });
  });
});

describe("R5 a 32-digit state ID fits after auto-size: 200 and printed in full", () => {
  const ID32 = "12345678901234567890123456789012";
  let env: Env;
  let anaId = 0;

  beforeAll(async () => {
    env = await bootEnv({ now: "2027-01-04T12:00:00Z" });
    await setEin(env, SYNTHETIC_EIN);
    await enterStateId(env, "CA", ID32);
    anaId = await createEmployee(env, "Ana Midid");
    await insertRuns(env, anaId, ana());
  }, 180_000);
  afterAll(async () => env.close());

  it("Copy D 200 showing the full ID; W-3 (one state) 200 showing the full ID in box 15", async () => {
    const d = await get(env, `/api/admin/annual-forms/w2/${anaId}/pdf?year=2026`);
    const w3 = await get(env, "/api/admin/annual-forms/w3/pdf?year=2026");
    const shown = async (bytes: Buffer) =>
      pageXObjectStrings(await pdfLib.PDFDocument.load(bytes), 0).includes(ID32);
    expect({
      d: d.statusCode,
      dShown: d.statusCode === 200 ? await shown(d.rawPayload) : null,
      w3: w3.statusCode,
      w3Shown: w3.statusCode === 200 ? await shown(w3.rawPayload) : null,
    }).toEqual({ d: 200, dShown: true, w3: 200, w3Shown: true });
  });
});

// ======================================================================= R7

describe("R7 W-3 PDF route: cross-site refused, 20 per minute", () => {
  let env: Env;

  beforeAll(async () => {
    env = await bootEnv({ now: "2027-01-04T12:00:00Z" });
    await setEin(env, SYNTHETIC_EIN);
    await enterStateId(env, "CA", "00000001");
    await insertRuns(env, await createEmployee(env, "Ana Routew3"), ana());
  }, 180_000);
  afterAll(async () => env.close());

  const w3 = (headers: Record<string, string>, ip: string) =>
    env.t.app.inject({
      method: "GET",
      url: "/api/admin/annual-forms/w3/pdf?year=2026",
      headers: { ...env.admin, "x-forwarded-for": ip, ...headers },
      remoteAddress: ip,
    });

  it("Sec-Fetch-Site cross-site / same-site -> 403 { error: cross_site }; same-origin, none, absent -> 200", async () => {
    const out: Record<string, unknown> = {};
    for (const site of ["cross-site", "same-site"]) {
      const r = await w3({ "sec-fetch-site": site }, "10.116.7.1");
      out[site] = [r.statusCode, r.statusCode === 403 ? r.json() : "<not refused>"];
    }
    for (const site of ["same-origin", "none"]) {
      out[site] = (await w3({ "sec-fetch-site": site }, "10.116.7.2")).statusCode;
    }
    out.absent = (await w3({}, "10.116.7.3")).statusCode;
    expect(out).toEqual({
      "cross-site": [403, { error: "cross_site" }],
      "same-site": [403, { error: "cross_site" }],
      "same-origin": 200,
      none: 200,
      absent: 200,
    });
  });

  it("20 requests per minute from one client pass; the 21st -> 429", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 21; i += 1) statuses.push((await w3({}, "10.116.7.9")).statusCode);
    expect({
      first20: statuses.slice(0, 20).filter((s) => s === 429).length,
      n21: statuses[20],
    }).toEqual({ first20: 0, n21: 429 });
  });
});
