/**
 * PAY-163 (Spec 25 (PAY-120), step G1) — the closed locality list and the
 * shared request schemas in @payroll/shared (used by the API and the web
 * forms), plus the US-state normalizer behind the residence address hint.
 */

import { describe, expect, it } from "vitest";
import {
  isoDate,
  LOCALITY_CODES,
  WORK_LOCALITY_CODES,
  localityName,
  localityState,
  normalizeUsState,
  residenceInput,
  residenceLocalityOptions,
  workLocalityInput,
  workLocalityOptions,
  workStateInput,
} from "@payroll/shared";

const MD_CODES = [
  "MD-001",
  "MD-003",
  "MD-005",
  "MD-009",
  "MD-011",
  "MD-013",
  "MD-015",
  "MD-017",
  "MD-019",
  "MD-021",
  "MD-023",
  "MD-025",
  "MD-027",
  "MD-029",
  "MD-031",
  "MD-033",
  "MD-035",
  "MD-037",
  "MD-039",
  "MD-041",
  "MD-043",
  "MD-045",
  "MD-047",
  "MD-510",
];

describe("LOCALITY_CODES", () => {
  it("is exactly NYC, Yonkers and the 24 Maryland county codes", () => {
    expect([...LOCALITY_CODES]).toEqual(["NY-NYC", "NY-YONKERS", ...MD_CODES]);
  });

  it("work localities exclude NYC (NYC taxes residents only)", () => {
    expect([...WORK_LOCALITY_CODES]).toEqual(["NY-YONKERS", ...MD_CODES]);
  });

  it("names every code, including Baltimore City", () => {
    expect(localityName("NY-NYC")).toBe("New York City");
    expect(localityName("NY-YONKERS")).toBe("Yonkers");
    expect(localityName("MD-510")).toBe("Baltimore City");
    expect(localityName("MD-005")).toBe("Baltimore County");
    expect(localityName("MD-033")).toBe("Prince George's County");
    for (const code of LOCALITY_CODES) expect(localityName(code)).not.toBe(code);
  });

  it("an unknown code is returned as is", () => {
    expect(localityName("XX-999")).toBe("XX-999");
  });

  it("localityState is the code's state prefix", () => {
    expect(localityState("NY-YONKERS")).toBe("NY");
    expect(localityState("MD-510")).toBe("MD");
  });

  it("offers residence options only for New York and Maryland", () => {
    expect(residenceLocalityOptions("NY").map((o) => o.code)).toEqual(["NY-NYC", "NY-YONKERS"]);
    expect(residenceLocalityOptions("MD")).toHaveLength(24);
    expect(residenceLocalityOptions("TX")).toEqual([]);
    expect(workLocalityOptions("NY").map((o) => o.code)).toEqual(["NY-YONKERS"]);
    expect(workLocalityOptions("MD")).toHaveLength(24);
    expect(workLocalityOptions("IL")).toEqual([]);
  });
});

describe("normalizeUsState", () => {
  it("accepts a USPS code in any case, or a full state name", () => {
    expect(normalizeUsState("NY")).toBe("NY");
    expect(normalizeUsState(" md ")).toBe("MD");
    expect(normalizeUsState("New York")).toBe("NY");
    expect(normalizeUsState("maryland")).toBe("MD");
    expect(normalizeUsState("District of Columbia")).toBe("DC");
  });

  it("returns null for anything else", () => {
    expect(normalizeUsState("")).toBeNull();
    expect(normalizeUsState("Ontario")).toBeNull();
    expect(normalizeUsState("XX")).toBeNull();
    expect(normalizeUsState("New York City")).toBeNull();
  });
});

describe("residenceInput", () => {
  const base = { country: "US", stateCode: "TX", localityCode: null, effectiveFrom: "2026-01-01" };

  it("accepts a US residence without a locality", () => {
    expect(residenceInput.safeParse(base).success).toBe(true);
  });

  it("accepts NYC, Yonkers and a Maryland county", () => {
    for (const [stateCode, localityCode] of [
      ["NY", "NY-NYC"],
      ["NY", "NY-YONKERS"],
      ["NY", null],
      ["MD", "MD-510"],
    ] as const) {
      expect(residenceInput.safeParse({ ...base, stateCode, localityCode }).success).toBe(true);
    }
  });

  it("accepts a foreign residence with no state and no locality", () => {
    expect(residenceInput.safeParse({ ...base, country: "ES", stateCode: null }).success).toBe(
      true,
    );
  });

  it("accepts sameAsBefore: true only", () => {
    expect(residenceInput.safeParse({ ...base, sameAsBefore: true }).success).toBe(true);
    expect(residenceInput.safeParse({ ...base, sameAsBefore: false }).success).toBe(false);
  });

  it("rejects bad combinations", () => {
    const bad: Record<string, unknown>[] = [
      { ...base, stateCode: "MD", localityCode: null }, // Maryland needs a county
      { ...base, stateCode: "TX", localityCode: "NY-NYC" }, // locality outside the state
      { ...base, stateCode: "NY", localityCode: "NY-BRONX" }, // not on the closed list
      { ...base, stateCode: "XX" }, // not a state
      { ...base, stateCode: null }, // US needs a state
      { ...base, country: "ES", stateCode: "TX" }, // foreign residence has no US state
      { ...base, country: "ES", stateCode: null, localityCode: "NY-NYC" },
      { ...base, country: "usa" },
      { ...base, effectiveFrom: "2026-13-45" },
      { ...base, extra: "x" }, // strict
    ];
    for (const body of bad)
      expect(residenceInput.safeParse(body).success, JSON.stringify(body)).toBe(false);
  });
});

describe("workStateInput / workLocalityInput", () => {
  it("New York and Maryland must answer the locality question", () => {
    expect(workStateInput.safeParse({ stateCode: "NY", effectiveFrom: "2026-01-01" }).success).toBe(
      false,
    );
    expect(
      workStateInput.safeParse({ stateCode: "NY", effectiveFrom: "2026-01-01", localityCode: null })
        .success,
    ).toBe(true);
    expect(
      workStateInput.safeParse({
        stateCode: "NY",
        effectiveFrom: "2026-01-01",
        localityCode: "NY-YONKERS",
      }).success,
    ).toBe(true);
    expect(
      workStateInput.safeParse({ stateCode: "MD", effectiveFrom: "2026-01-01", localityCode: null })
        .success,
    ).toBe(false);
    expect(
      workStateInput.safeParse({
        stateCode: "MD",
        effectiveFrom: "2026-01-01",
        localityCode: "MD-510",
      }).success,
    ).toBe(true);
  });

  it("NYC is never a work locality; a locality must match the state", () => {
    expect(
      workStateInput.safeParse({
        stateCode: "NY",
        effectiveFrom: "2026-01-01",
        localityCode: "NY-NYC",
      }).success,
    ).toBe(false);
    expect(
      workStateInput.safeParse({
        stateCode: "IL",
        effectiveFrom: "2026-01-01",
        localityCode: "MD-510",
      }).success,
    ).toBe(false);
  });

  it("other states need no locality answer", () => {
    expect(workStateInput.safeParse({ stateCode: "IL", effectiveFrom: "2026-01-01" }).success).toBe(
      true,
    );
    expect(
      workStateInput.safeParse({ stateCode: "IL", effectiveFrom: "2026-01-01", localityCode: null })
        .success,
    ).toBe(true);
  });

  it("the locality-only body is strict and uses the work list", () => {
    expect(workLocalityInput.safeParse({ localityCode: null }).success).toBe(true);
    expect(workLocalityInput.safeParse({ localityCode: "MD-510" }).success).toBe(true);
    expect(workLocalityInput.safeParse({ localityCode: "NY-NYC" }).success).toBe(false);
    expect(workLocalityInput.safeParse({}).success).toBe(false);
    expect(workLocalityInput.safeParse({ localityCode: null, x: 1 }).success).toBe(false);
  });
});

describe("isoDate (round-trip strict)", () => {
  it("accepts real calendar dates, including 29 February in a leap year", () => {
    for (const d of ["2026-01-01", "2026-12-31", "2024-02-29", "2000-02-29"]) {
      expect(isoDate.safeParse(d).success, d).toBe(true);
    }
  });

  it("rejects dates that do not exist", () => {
    for (const d of [
      "2026-02-30",
      "2025-02-29",
      "2026-04-31",
      "2026-13-01",
      "2026-00-10",
      "1900-02-29",
    ]) {
      expect(isoDate.safeParse(d).success, d).toBe(false);
    }
  });
});
