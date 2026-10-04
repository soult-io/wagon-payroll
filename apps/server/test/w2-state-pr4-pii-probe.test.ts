/**
 * Spec 24 (PAY-116) PR-4 S1 — the SSN/address probe: race guard and PII
 * minimisation (payroll-calc-auditor, fail-first; the coder may not edit
 * this file). Synthetic data only.
 *
 * Test double: `decryptField` (src/crypto/field-encryption.ts) as seen by
 * every server module. It records each ciphertext it is called with and,
 * for a ciphertext armed with `failAfter(value, n)`, lets n calls through
 * and throws on every later call (a GCM failure after the probe passed).
 *
 * Tests:
 *  - C-b4 race guard: the probe reads the SSN (or the box f address) fine,
 *    then the render-time decrypt fails -> Copy D 409 { error:
 *    "w2_not_ready", issues: ["ssn_unreadable"] } (["address_unreadable"]),
 *    never 500 (typed SsnUnreadableError / AddressUnreadableError mapped by
 *    annualBlockBody).
 *  - C-b5 minimisation: the SSN probe runs only for a year with a bundled
 *    fw2 template. A 2024 list never decrypts the SSN ciphertext and shows
 *    no ssn_unreadable even though the SSN is corrupt; the 2026 list (fw2
 *    bundled) does read it (the probe exists).
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { employees } from "@payroll/db";
import { encryptAddress } from "../src/crypto/address-encryption.js";
import { encryptField } from "../src/crypto/field-encryption.js";
import {
  bootEnv,
  consentedEmployee,
  createEmployee,
  enterStateId,
  type Env,
  federalConfig,
  get,
  insertRuns,
  list,
  setEin,
  SYNTHETIC_EIN,
} from "./w2-state-harness.js";
import { type FxRun, monthly, months, st } from "./w2-state-oracle.js";

const spy = vi.hoisted(() => ({
  calls: [] as string[],
  armed: new Map<string, number>(),
}));

vi.mock("../src/crypto/field-encryption.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/crypto/field-encryption.js")>();
  return {
    ...orig,
    decryptField: (value: string, key: string) => {
      spy.calls.push(value);
      const left = spy.armed.get(value);
      if (left !== undefined) {
        if (left <= 0) throw new Error("Unsupported state or unable to authenticate data");
        spy.armed.set(value, left - 1);
      }
      return orig.decryptField(value, key);
    },
  };
});

const CA = st("CA");
const NOW = "2027-01-05T12:00:00Z";
const ana = (): FxRun[] => months(2026, 1, 12).map((m) => monthly(m, CA, 1234));
const ana2024 = (): FxRun[] => months(2024, 1, 12).map((m) => monthly(m, null, undefined));

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return { nonJson: body.slice(0, 8) };
  }
}

function failAfter(value: string, n: number): void {
  spy.armed.set(value, n);
}

describe("C-b4 race guard: probe passes, the render-time decrypt fails", () => {
  let env: Env;
  let id = 0;
  let ssnCipher = "";
  let addressCipher = "";
  beforeAll(async () => {
    env = await bootEnv({ now: NOW });
    await setEin(env, SYNTHETIC_EIN);
    await enterStateId(env, "CA", "00000001");
    id = (await consentedEmployee(env, "Ana Race Synthetic")).employeeId;
    await insertRuns(env, id, ana());
    const key = env.t.config.encryptionKey;
    ssnCipher = encryptField("900000019", key);
    addressCipher = encryptAddress(
      { line1: "19 Synthetic Lane", city: "Racetown", state: "CA", zip: "90019", country: "US" },
      key,
    );
    await env.t.db
      .update(employees)
      .set({ taxId: ssnCipher, mailingAddress: addressCipher as never })
      .where(eq(employees.id, id));
  }, 180_000);
  afterAll(async () => {
    spy.armed.clear();
    await env.close();
  });

  it("guard: both values decrypt -> Copy D 200", async () => {
    spy.armed.clear();
    const res = await get(env, `/api/admin/annual-forms/w2/${id}/pdf?year=2026`);
    expect(res.statusCode).toBe(200);
  });

  it("SSN: first decrypt (the probe) passes, later ones throw -> Copy D 409 [ssn_unreadable], never 500; no SSN in the body", async () => {
    spy.armed.clear();
    failAfter(ssnCipher, 1);
    const res = await get(env, `/api/admin/annual-forms/w2/${id}/pdf?year=2026`);
    spy.armed.clear();
    expect({ status: res.statusCode, body: safeJson(res.body) }).toEqual({
      status: 409,
      body: { error: "w2_not_ready", issues: ["ssn_unreadable"] },
    });
    expect(res.body).not.toContain("900000019");
  });

  it("address: first decrypt (the probe) passes, later ones throw -> Copy D 409 [address_unreadable], never 500", async () => {
    spy.armed.clear();
    failAfter(addressCipher, 1);
    const res = await get(env, `/api/admin/annual-forms/w2/${id}/pdf?year=2026`);
    spy.armed.clear();
    expect({ status: res.statusCode, body: safeJson(res.body) }).toEqual({
      status: 409,
      body: { error: "w2_not_ready", issues: ["address_unreadable"] },
    });
    expect(res.body).not.toContain("Racetown");
  });
});

describe("C-b5 minimisation: no SSN decrypt for a year without a bundled fw2 (2024)", () => {
  let env: Env;
  let id = 0;
  let badSsn = "";
  beforeAll(async () => {
    env = await bootEnv({ now: NOW });
    await setEin(env, SYNTHETIC_EIN);
    await enterStateId(env, "CA", "00000001");
    await federalConfig(env, 2024);
    id = await createEmployee(env, "Ana Minimal Synthetic");
    await insertRuns(env, id, ana2024());
    await insertRuns(env, id, ana());
    // A corrupt SSN: if it were probed it would raise ssn_unreadable.
    const good = encryptField("900000023", env.t.config.encryptionKey);
    const i = "enc:v1:".length + 10;
    badSsn = good.slice(0, i) + (good[i] === "A" ? "B" : "A") + good.slice(i + 1);
    await env.t.db.update(employees).set({ taxId: badSsn }).where(eq(employees.id, id));
  }, 180_000);
  afterAll(async () => env.close());

  it("2024 list: 200, no ssn_unreadable, decryptField never called with the tax_id ciphertext; 2026 list (fw2 bundled) reads it and holds", async () => {
    spy.calls.length = 0;
    const l2024 = await list(env, 2024);
    const read2024 = spy.calls.filter((c) => c === badSsn).length;
    spy.calls.length = 0;
    const l2026 = await list(env, 2026);
    const read2026 = spy.calls.filter((c) => c === badSsn).length;
    const codes = (l: Awaited<ReturnType<typeof list>>) =>
      (l.json.w2s.find((r) => r.employeeId === id)?.issues ?? []).map(
        (i) => (i as { code: string }).code,
      );
    expect({
      s2024: l2024.status,
      ssn2024: codes(l2024).includes("ssn_unreadable"),
      read2024,
      s2026: l2026.status,
      ssn2026: codes(l2026).includes("ssn_unreadable"),
      read2026: read2026 > 0,
    }).toEqual({
      s2024: 200,
      ssn2024: false,
      read2024: 0,
      s2026: 200,
      ssn2026: true,
      read2026: true,
    });
  });
});
