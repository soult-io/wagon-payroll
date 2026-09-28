/**
 * Spec 24 (PAY-116) PR-1 — employer state ID helpers: format normalization
 * per state (S24-D2), masking that never throws and never shows a short ID
 * (M4, L1), and the year-effective lookup with the IL/NY EIN default
 * (W27 "2026 and 2027 use 00000001; 2028 uses 00000002", W08 read side:
 * the default applies only while company.ein is set).
 *
 * All identifiers are synthetic.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { company, companyStateIds, seedDatabase, type SeedDb } from "@payroll/db";
import { normalizeStateId } from "@payroll/shared";
import { encryptField } from "../src/crypto/field-encryption.js";
import { maskStateId, resolveStateId } from "../src/company/state-ids.js";
import { createTestApp, type TestContext } from "./helpers.js";

const KEY = "unit-test-key";

describe("normalizeStateId (S24-D2 format checks)", () => {
  it("strips spaces and dashes for checked states and keeps digits only", () => {
    expect(normalizeStateId("CA", "123-4567-8")).toEqual({ ok: true, value: "12345678" });
    expect(normalizeStateId("MD", " 12 345678 ")).toEqual({ ok: true, value: "12345678" });
    expect(normalizeStateId("IL", "123-45-6789-000")).toEqual({ ok: true, value: "123456789000" });
  });

  it("applies each state's pattern", () => {
    const ok = (s: string, v: string) => normalizeStateId(s, v).ok;
    expect(ok("CA", "12345678")).toBe(true);
    expect(ok("CA", "123456789")).toBe(false);
    expect(ok("NC", "123456789")).toBe(true);
    expect(ok("NC", "APPLIEDFOR")).toBe(false);
    expect(ok("MD", "12345678")).toBe(true);
    expect(ok("MD", "1234567890")).toBe(false);
    expect(ok("MD", "123456789")).toBe(false);
    expect(ok("IL", "123456789")).toBe(true);
    expect(ok("IL", "123456789000")).toBe(true);
    expect(ok("IL", "1234567890")).toBe(false);
    expect(ok("NY", "123456789")).toBe(true);
    expect(ok("NY", "12345678901")).toBe(true);
    expect(ok("NY", "123456789012")).toBe(true);
    expect(ok("NY", "1234567890")).toBe(true); // EIN + check digit
    expect(ok("NY", "1234567")).toBe(false);
    expect(ok("NY", "1234567890123")).toBe(false);
  });

  it("free text for other states: trimmed, 1–20 of [A-Za-z0-9 -]", () => {
    expect(normalizeStateId("TX", "  Acct 12-AB9 ")).toEqual({ ok: true, value: "Acct 12-AB9" });
    expect(normalizeStateId("TX", "A".repeat(20)).ok).toBe(true);
    expect(normalizeStateId("TX", "A".repeat(21)).ok).toBe(false);
    expect(normalizeStateId("TX", "   ").ok).toBe(false);
    expect(normalizeStateId("TX", "AB\u000712").ok).toBe(false);
    expect(normalizeStateId("TX", "AB_12").ok).toBe(false);
  });

  it("refusals use the approved copy, without a trailing period", () => {
    const msg = (s: string, v: string) => {
      const r = normalizeStateId(s, v);
      return r.ok ? null : r.message;
    };
    expect(msg("CA", "1")).toBe(
      "California account numbers have 8 digits. Use the employer payroll tax account number from EDD (California's Employment Development Department)",
    );
    expect(msg("NC", "APPLIEDFOR")).toBe(
      'North Carolina withholding account IDs have 9 digits. "APPLIEDFOR" can\'t go on a W-2, so add the number once North Carolina sends it',
    );
    expect(msg("MD", "1")).toBe(
      "Maryland Central Registration (CR) numbers have 8 digits. Don't use your 10-digit unemployment insurance number or your EIN",
    );
    expect(msg("IL", "1")).toBe(
      "Illinois account IDs are your 9-digit EIN, or your EIN followed by the 3-digit number Illinois gave you",
    );
    expect(msg("NY", "1")).toBe(
      "New York withholding IDs are your 9-digit EIN plus any suffix New York gave you. Don't use your 7-digit unemployment insurance (UI) number",
    );
    expect(msg("TX", "")).toBe("Account numbers can use 1 to 20 letters, digits, spaces or dashes");
  });

  it("a refusal message never contains the value", () => {
    const res = normalizeStateId("CA", "7654321");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).not.toContain("7654321");
  });
});

describe("maskStateId (M4, L1)", () => {
  it("shows the last 4 only for IDs of 8 characters or more", () => {
    expect(maskStateId(encryptField("12345678", KEY), KEY)).toBe("••••5678");
    expect(maskStateId(encryptField("123456789012", KEY), KEY)).toBe("••••9012");
    expect(maskStateId(encryptField("1234567", KEY), KEY)).toBe("••••");
    expect(maskStateId(encryptField("AB12", KEY), KEY)).toBe("••••");
  });

  it("never throws: wrong key, flipped byte, malformed ciphertext → ••••", () => {
    const enc = encryptField("12345678", KEY);
    expect(maskStateId(enc, "another-key")).toBe("••••");
    const i = "enc:v1:".length + 5;
    const flipped = enc.slice(0, i) + (enc[i] === "A" ? "B" : "A") + enc.slice(i + 1);
    expect(maskStateId(flipped, KEY)).toBe("••••");
    expect(maskStateId("enc:v1:x", KEY)).toBe("••••");
    expect(maskStateId("enc:v1:", KEY)).toBe("••••");
  });
});

describe("resolveStateId (year-effective, IL/NY EIN default)", () => {
  let t: TestContext;
  let companyId: number;

  beforeAll(async () => {
    t = await createTestApp();
    await seedDatabase(t.db as unknown as SeedDb);
    const [row] = await t.db.select({ id: company.id }).from(company).limit(1);
    companyId = row?.id ?? 1;
    const key = t.config.encryptionKey;
    await t.db.update(company).set({ ein: encryptField("98-7654321", key) });
    await t.db.insert(companyStateIds).values([
      { companyId, stateCode: "CA", fromTaxYear: 2026, stateId: encryptField("00000001", key) },
      { companyId, stateCode: "CA", fromTaxYear: 2028, stateId: encryptField("00000002", key) },
      { companyId, stateCode: "NY", fromTaxYear: 2028, stateId: encryptField("12345678901", key) },
    ]);
  });

  afterAll(async () => {
    await t.close();
  });

  const lookup = (stateCode: string, taxYear: number) =>
    resolveStateId(t.db, t.config.encryptionKey, { companyId, stateCode, taxYear });

  it("W27: the row with the greatest from_tax_year ≤ the year applies", async () => {
    expect(await lookup("CA", 2026)).toEqual({ source: "entered", value: "00000001" });
    expect(await lookup("CA", 2027)).toEqual({ source: "entered", value: "00000001" });
    expect(await lookup("CA", 2028)).toEqual({ source: "entered", value: "00000002" });
    expect(await lookup("CA", 2031)).toEqual({ source: "entered", value: "00000002" });
    expect(await lookup("CA", 2025)).toEqual({ source: null, value: null });
    expect(await lookup("NC", 2026)).toEqual({ source: null, value: null });
  });

  it("IL and NY fall back to the EIN digits; an entered row overrides from its year", async () => {
    expect(await lookup("IL", 2026)).toEqual({ source: "ein_default", value: "987654321" });
    expect(await lookup("NY", 2027)).toEqual({ source: "ein_default", value: "987654321" });
    expect(await lookup("NY", 2028)).toEqual({ source: "entered", value: "12345678901" });
  });

  it("no EIN → no default (source null)", async () => {
    const [saved] = await t.db.select({ ein: company.ein }).from(company).limit(1);
    await t.db.update(company).set({ ein: null });
    try {
      expect(await lookup("IL", 2026)).toEqual({ source: null, value: null });
      expect(await lookup("NY", 2027)).toEqual({ source: null, value: null });
      expect(await lookup("NY", 2028)).toEqual({ source: "entered", value: "12345678901" });
    } finally {
      await t.db.update(company).set({ ein: saved?.ein ?? null });
    }
  });
});
