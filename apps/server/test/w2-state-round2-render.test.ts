/**
 * Spec 24 (PAY-116) PR-3 fix round 2, R2 (payroll-calc-auditor, fail-first;
 * the coder may not edit this file): a W-2 PDF that fails to render leaves
 * no w2_furnishings row (employee_download / admin_print). Synthetic data.
 *
 * Test double: @payroll/documents renderW2EmployeePacket is wrapped so it
 * throws while FAIL.on is true (a render failure after the input was built,
 * e.g. a pdf-lib error). Everything else is the real package.
 * Expected: the request does not answer 200 and no furnishing row exists;
 * with the double off the same request answers 200 and writes one row.
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { w2Furnishings } from "@payroll/db";
import {
  bootEnv,
  consentedEmployee,
  enterStateId,
  type Env,
  get,
  insertRuns,
  setEin,
  SYNTHETIC_EIN,
} from "./w2-state-harness.js";
import { monthly, months, st } from "./w2-state-oracle.js";

const FAIL = vi.hoisted(() => ({ on: false }));

vi.mock("@payroll/documents", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  const real = orig.renderW2EmployeePacket as (...a: unknown[]) => Promise<Buffer>;
  return {
    ...orig,
    renderW2EmployeePacket: async (...a: unknown[]) => {
      if (FAIL.on) throw new Error("synthetic render failure");
      return real(...a);
    },
  };
});

const CA = st("CA");

describe("R2 no furnishing row for a W-2 PDF that fails to render (clock 2027-01-04)", () => {
  let env: Env;
  let anaId = 0;
  let session: Record<string, string> = {};

  beforeAll(async () => {
    env = await bootEnv({ now: "2027-01-04T12:00:00Z" });
    await setEin(env, SYNTHETIC_EIN);
    await enterStateId(env, "CA", "00000001");
    const a = await consentedEmployee(env, "Ana Renderfail");
    anaId = a.employeeId;
    session = a.session;
    await insertRuns(
      env,
      anaId,
      months(2026, 1, 12).map((m) => monthly(m, CA, 1234)),
    );
  }, 180_000);
  afterAll(async () => env.close());

  const furnished = async () =>
    (await env.t.db.select().from(w2Furnishings).where(eq(w2Furnishings.employeeId, anaId))).map(
      (r) => r.method,
    );

  it("render fails: admin print packet and employee download are not 200 and write no row", async () => {
    FAIL.on = true;
    try {
      const packet = await get(env, `/api/admin/annual-forms/w2/${anaId}/print-packet?year=2026`);
      const mine = await get(env, "/api/my/w2/2026/pdf", session);
      expect({
        packetOk: packet.statusCode === 200,
        mineOk: mine.statusCode === 200,
        rows: await furnished(),
      }).toEqual({ packetOk: false, mineOk: false, rows: [] });
    } finally {
      FAIL.on = false;
    }
  });

  it("control: render succeeds -> 200 and one row per request (admin_print, employee_download)", async () => {
    const packet = await get(env, `/api/admin/annual-forms/w2/${anaId}/print-packet?year=2026`);
    const mine = await get(env, "/api/my/w2/2026/pdf", session);
    expect({
      packet: packet.statusCode,
      mine: mine.statusCode,
      rows: (await furnished()).sort(),
    }).toEqual({ packet: 200, mine: 200, rows: ["admin_print", "employee_download"] });
  });
});
