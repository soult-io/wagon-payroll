/**
 * Spec 24 (PAY-116) PR-4 round 2, A1 (code-reviewer LOW-1) — box f is the
 * mailing address in effect on Dec 31 of the tax year (PAY-20). When an
 * approved mailing_address change request decides that value, the CURRENT
 * mailing_address column is not needed, so an unreadable current value must
 * not hold the W-2 (payroll-calc-auditor, fail-first; the coder may not
 * edit this file). Synthetic data only.
 *
 * A1a: current mailing ciphertext corrupt; approved change request
 *      effective 2026-06-01 (<= 2026-12-31) readable -> no
 *      address_unreadable, not blocked, Copy D 200, and the W-2 input's box f
 *      is the history address.
 * A1b (converse, guard): current mailing ciphertext corrupt; the only
 *      approved change request is effective 2027-03-01 (after Dec 31) and
 *      has no approve audit row -> the current value decides box f ->
 *      address_unreadable, Copy D 409.
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changeRequests, employees } from "@payroll/db";
import { encryptAddress } from "../src/crypto/address-encryption.js";
import { w2InputFor } from "../src/filings/annual.js";
import {
  bootEnv,
  createEmployee,
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
const ana = (): FxRun[] => months(2026, 1, 12).map((m) => monthly(m, CA, 1234));
const CURRENT = {
  line1: "20 Current Lane",
  city: "Nowville",
  state: "CA",
  zip: "90020",
  country: "US",
};
const HISTORY = {
  line1: "21 History Lane",
  city: "Thenville",
  state: "CA",
  zip: "90021",
  country: "US",
};

function flip(ciphertext: string): string {
  const i = "enc:v1:".length + 10;
  return ciphertext.slice(0, i) + (ciphertext[i] === "A" ? "B" : "A") + ciphertext.slice(i + 1);
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return { nonJson: body.slice(0, 8) };
  }
}

describe("A1 an unreadable current mailing address only holds the W-2 when it decides box f", () => {
  let env: Env;
  let decided = 0;
  let needed = 0;
  beforeAll(async () => {
    env = await bootEnv({ now: "2027-01-05T12:00:00Z" });
    await setEin(env, SYNTHETIC_EIN);
    await enterStateId(env, "CA", "00000001");
    const key = env.t.config.encryptionKey;
    decided = await createEmployee(env, "Ana Decided Synthetic");
    needed = await createEmployee(env, "Ana Needed Synthetic");
    for (const [id, effectiveFrom] of [
      [decided, "2026-06-01"],
      [needed, "2027-03-01"],
    ] as const) {
      await insertRuns(env, id, ana());
      await env.t.db
        .update(employees)
        .set({ mailingAddress: flip(encryptAddress(CURRENT, key)) as never })
        .where(eq(employees.id, id));
      await env.t.db.insert(changeRequests).values({
        employeeId: id,
        requestType: "mailing_address",
        payload: encryptAddress(HISTORY, key),
        effectiveFrom,
        status: "approved",
        decidedBy: "test",
        decidedAt: new Date("2026-05-20T00:00:00Z"),
        appliedAt: new Date("2026-05-20T00:00:00Z"),
      });
    }
  }, 180_000);
  afterAll(async () => env.close());

  const codes = async (id: number) => {
    const l = await list(env, 2026);
    const row = l.json.w2s.find((r) => r.employeeId === id);
    return {
      status: l.status,
      codes: (row?.issues ?? []).map((i) => (i as { code: string }).code),
      blocked: row?.blocked,
    };
  };

  it("A1a history entry decides Dec 31: no address_unreadable, not blocked, Copy D 200, box f = the history address", async () => {
    const view = await codes(decided);
    const pdf = await get(env, `/api/admin/annual-forms/w2/${decided}/pdf?year=2026`);
    let line1: unknown = "threw";
    try {
      const input = await w2InputFor(
        { db: env.t.db, config: env.t.config } as never,
        decided,
        2026,
        { requireBundledForm: true },
      );
      line1 = input.employee.address?.line1 ?? null;
    } catch (err) {
      line1 = `threw ${err instanceof Error ? err.name : "?"}`;
    }
    expect({
      status: view.status,
      addressHold: view.codes.includes("address_unreadable"),
      blocked: view.blocked,
      pdf: pdf.statusCode,
      line1,
    }).toEqual({
      status: 200,
      addressHold: false,
      blocked: false,
      pdf: 200,
      line1: "21 History Lane",
    });
  });

  it("A1b (guard) only change after Dec 31, no audit row: the corrupt current value decides box f -> address_unreadable, Copy D 409", async () => {
    const view = await codes(needed);
    const pdf = await get(env, `/api/admin/annual-forms/w2/${needed}/pdf?year=2026`);
    expect({
      addressHold: view.codes.includes("address_unreadable"),
      blocked: view.blocked,
      pdf: { status: pdf.statusCode, body: safeJson(pdf.body) },
    }).toEqual({
      addressHold: true,
      blocked: true,
      pdf: { status: 409, body: { error: "w2_not_ready", issues: ["address_unreadable"] } },
    });
  });
});
