/**
 * PAY-163 (Spec 25 (PAY-120), step G1) — unit tests for the pure local-tax
 * guard `checkLocalTaxSupport`. G1 ships the function and a read-only check
 * endpoint; nothing blocks a run yet. These tests pin every reason code the
 * guard can return once enforcement is wired in (G2):
 *
 *   local_coverage_missing · residence_missing · work_locality_unconfirmed ·
 *   local_unsupported_state · local_not_yet_supported · local_outside_work_state
 *
 * All inputs are synthetic. Coverage rows mirror the shape of the seeded
 * coverage list (engine rows for NYC / Yonkers / Maryland, unsupported rows
 * per state and basis).
 */

import { describe, expect, it } from "vitest";
import {
  checkLocalTaxSupport,
  type LocalGuardInput,
  type LocalGuardCoverageRow,
} from "../src/payroll/local-guard.js";

const COVERAGE: LocalGuardCoverageRow[] = [
  { code: "NY-NYC", basis: "residence", handling: "engine" },
  { code: "NY-YONKERS", basis: "residence", handling: "engine" },
  { code: "NY-YONKERS", basis: "work", handling: "engine" },
  { code: "MD", basis: "residence", handling: "engine" },
  { code: "MD", basis: "work", handling: "engine" },
  { code: "OH", basis: "residence", handling: "unsupported" },
  { code: "OH", basis: "work", handling: "unsupported" },
  { code: "PA", basis: "work", handling: "unsupported" },
];

/** Every engine jurisdiction has a 2027 table; nothing exists for 2026. */
const CONFIGS_2027: Record<string, number[]> = {
  "NY-NYC": [2027],
  "NY-YONKERS": [2027],
  "NY-YONKERS-NR": [2027],
  "MD-510": [2027],
  "MD-005": [2027],
  "MD-003": [2027],
  "MD-NONRES": [2027],
};

type Residence = NonNullable<LocalGuardInput["residence"]>;
type WorkState = NonNullable<LocalGuardInput["workState"]>;

function us(stateCode: string, localityCode: string | null = null): Residence {
  return { country: "US", stateCode, localityCode, createdAt: "2027-01-01T00:00:00.000Z" };
}

function abroad(country: string): Residence {
  return { country, stateCode: null, localityCode: null, createdAt: "2027-01-01T00:00:00.000Z" };
}

function work(stateCode: string, localityCode: string | null, localityConfirmed = true): WorkState {
  return { stateCode, localityCode, localityConfirmed };
}

function input(overrides: Partial<LocalGuardInput> = {}): LocalGuardInput {
  return {
    taxYear: 2027,
    payDate: "2027-01-25",
    employmentType: "w2",
    residence: us("TX"),
    workState: work("TX", null, false),
    coverage: COVERAGE,
    localConfigYears: CONFIGS_2027,
    ...overrides,
  };
}

function reasonsOf(i: LocalGuardInput): string[] {
  const result = checkLocalTaxSupport(i);
  return result.ok ? [] : result.reasons;
}

describe("checkLocalTaxSupport — employees with no local tax", () => {
  it("TX resident working in TX is ok", () => {
    expect(checkLocalTaxSupport(input())).toEqual({ ok: true });
  });

  it("a 1099 worker is never checked, even with no residence and no coverage", () => {
    expect(
      checkLocalTaxSupport(
        input({ employmentType: "1099", residence: null, workState: null, coverage: [] }),
      ),
    ).toEqual({ ok: true });
  });

  it("foreign resident with no work state is ok (no locals)", () => {
    expect(checkLocalTaxSupport(input({ residence: abroad("ES"), workState: null }))).toEqual({
      ok: true,
    });
  });

  it("NJ resident working in New York outside Yonkers (locality confirmed as none) is ok", () => {
    expect(
      checkLocalTaxSupport(input({ residence: us("NJ"), workState: work("NY", null) })),
    ).toEqual({ ok: true });
  });

  it("PA resident working in TX is ok — PA is on the list for work only", () => {
    expect(checkLocalTaxSupport(input({ residence: us("PA") }))).toEqual({ ok: true });
  });

  it("New York resident outside NYC and Yonkers, working in NY (no Yonkers work), is ok", () => {
    expect(
      checkLocalTaxSupport(input({ residence: us("NY"), workState: work("NY", null) })),
    ).toEqual({ ok: true });
  });

  it("the result carries no reasons key when ok", () => {
    const result = checkLocalTaxSupport(input());
    expect(Object.keys(result)).toEqual(["ok"]);
  });
});

describe("local_coverage_missing", () => {
  it("an empty coverage list blocks every W-2 employee (fails closed)", () => {
    expect(reasonsOf(input({ coverage: [] }))).toEqual(["local_coverage_missing"]);
  });

  it("is reported together with a missing residence", () => {
    expect(reasonsOf(input({ coverage: [], residence: null }))).toEqual([
      "local_coverage_missing",
      "residence_missing",
    ]);
  });
});

describe("residence_missing", () => {
  it("no residence effective on the pay date blocks, whatever the work state", () => {
    expect(reasonsOf(input({ residence: null }))).toEqual(["residence_missing"]);
    expect(reasonsOf(input({ residence: null, workState: null }))).toEqual(["residence_missing"]);
  });

  it("does not guess a work-state local while the residence is unknown", () => {
    expect(reasonsOf(input({ residence: null, workState: work("MD", "MD-510") }))).toEqual([
      "residence_missing",
    ]);
  });
});

describe("work_locality_unconfirmed", () => {
  it("New York work state whose locality was never confirmed", () => {
    expect(reasonsOf(input({ residence: us("NJ"), workState: work("NY", null, false) }))).toEqual([
      "work_locality_unconfirmed",
    ]);
  });

  it("Maryland work state whose county was never confirmed", () => {
    expect(
      reasonsOf(input({ residence: us("MD", "MD-510"), workState: work("MD", null, false) })),
    ).toEqual(["work_locality_unconfirmed"]);
  });

  it("Maryland work state confirmed without a county is still unconfirmed (a county is required)", () => {
    expect(reasonsOf(input({ residence: us("DE"), workState: work("MD", null, true) }))).toEqual([
      "work_locality_unconfirmed",
    ]);
  });

  it("other work states need no locality confirmation", () => {
    expect(reasonsOf(input({ residence: us("IL"), workState: work("IL", null, false) }))).toEqual(
      [],
    );
  });
});

describe("local_unsupported_state", () => {
  it("residence in a state listed for residence (OH) blocks", () => {
    expect(reasonsOf(input({ residence: us("OH") }))).toEqual(["local_unsupported_state"]);
  });

  it("work in a state listed for work (PA) blocks", () => {
    expect(reasonsOf(input({ residence: us("NJ"), workState: work("PA", null) }))).toEqual([
      "local_unsupported_state",
    ]);
  });

  it("OH resident working in OH reports the reason once", () => {
    expect(reasonsOf(input({ residence: us("OH"), workState: work("OH", null) }))).toEqual([
      "local_unsupported_state",
    ]);
  });

  it("a foreign residence is never matched against a US state row", () => {
    expect(reasonsOf(input({ residence: abroad("OH" as string) }))).toEqual([]);
  });

  it("a locality-level unsupported row matches the locality code", () => {
    const coverage = [...COVERAGE, { code: "NY-NYC", basis: "residence", handling: "unsupported" }];
    expect(
      reasonsOf(
        input({
          residence: us("NY", "NY-NYC"),
          workState: work("NY", null),
          coverage: coverage as LocalGuardCoverageRow[],
        }),
      ),
    ).toContain("local_unsupported_state");
  });
});

describe("local_not_yet_supported", () => {
  it("NYC resident working in NY with no table for the pay-date year (all of 2026)", () => {
    expect(
      reasonsOf(
        input({
          taxYear: 2026,
          payDate: "2026-12-25",
          residence: us("NY", "NY-NYC"),
          workState: work("NY", null),
        }),
      ),
    ).toEqual(["local_not_yet_supported"]);
  });

  it("NYC resident working in NY is ok once the year's NYC table exists", () => {
    expect(
      checkLocalTaxSupport(input({ residence: us("NY", "NY-NYC"), workState: work("NY", null) })),
    ).toEqual({ ok: true });
  });

  it("with no local tables at all (G1: none are loaded yet) every engine local is not yet supported", () => {
    expect(
      reasonsOf(
        input({
          residence: us("MD", "MD-510"),
          workState: work("MD", "MD-005"),
          localConfigYears: {},
        }),
      ),
    ).toEqual(["local_not_yet_supported"]);
  });

  it("Maryland resident needs the table of the county of residence, not the work county", () => {
    const resident = input({ residence: us("MD", "MD-510"), workState: work("MD", "MD-005") });
    expect(checkLocalTaxSupport(resident)).toEqual({ ok: true });
    expect(
      reasonsOf({ ...resident, localConfigYears: { ...CONFIGS_2027, "MD-510": [2026] } }),
    ).toEqual(["local_not_yet_supported"]);
    // The work county's table is not needed for a Maryland resident.
    expect(
      checkLocalTaxSupport({ ...resident, localConfigYears: { ...CONFIGS_2027, "MD-005": [] } }),
    ).toEqual({ ok: true });
  });

  it("nonresident working in Maryland needs the special nonresident table", () => {
    const nonresident = input({ residence: us("DE"), workState: work("MD", "MD-510") });
    expect(checkLocalTaxSupport(nonresident)).toEqual({ ok: true });
    expect(
      reasonsOf({ ...nonresident, localConfigYears: { ...CONFIGS_2027, "MD-NONRES": [] } }),
    ).toEqual(["local_not_yet_supported"]);
  });

  it("nonresident working in Yonkers needs the Yonkers nonresident table", () => {
    const nonresident = input({ residence: us("NJ"), workState: work("NY", "NY-YONKERS") });
    expect(checkLocalTaxSupport(nonresident)).toEqual({ ok: true });
    expect(
      reasonsOf({ ...nonresident, localConfigYears: { ...CONFIGS_2027, "NY-YONKERS-NR": [] } }),
    ).toEqual(["local_not_yet_supported"]);
  });

  it("NYC resident working in Yonkers needs both the NYC and the Yonkers nonresident tables", () => {
    const both = input({ residence: us("NY", "NY-NYC"), workState: work("NY", "NY-YONKERS") });
    expect(checkLocalTaxSupport(both)).toEqual({ ok: true });
    expect(reasonsOf({ ...both, localConfigYears: { ...CONFIGS_2027, "NY-NYC": [] } })).toEqual([
      "local_not_yet_supported",
    ]);
    expect(
      reasonsOf({ ...both, localConfigYears: { ...CONFIGS_2027, "NY-YONKERS-NR": [] } }),
    ).toEqual(["local_not_yet_supported"]);
  });

  it("Yonkers resident working in Yonkers owes no nonresident tax (only the resident table is needed)", () => {
    const resident = input({
      residence: us("NY", "NY-YONKERS"),
      workState: work("NY", "NY-YONKERS"),
      localConfigYears: { "NY-YONKERS": [2027] },
    });
    expect(checkLocalTaxSupport(resident)).toEqual({ ok: true });
  });

  it("foreign resident working in Yonkers owes the nonresident tax", () => {
    const i = input({
      residence: abroad("ES"),
      workState: work("NY", "NY-YONKERS"),
      localConfigYears: {},
    });
    expect(reasonsOf(i)).toEqual(["local_not_yet_supported"]);
  });
});

describe("local_outside_work_state", () => {
  it("NYC resident whose work state is NJ", () => {
    expect(
      reasonsOf(input({ residence: us("NY", "NY-NYC"), workState: work("NJ", null) })),
    ).toEqual(["local_outside_work_state"]);
  });

  it("Maryland resident whose work state is DE", () => {
    expect(
      reasonsOf(input({ residence: us("MD", "MD-003"), workState: work("DE", null) })),
    ).toEqual(["local_outside_work_state"]);
  });

  it("Yonkers resident with no work state", () => {
    expect(reasonsOf(input({ residence: us("NY", "NY-YONKERS"), workState: null }))).toEqual([
      "local_outside_work_state",
    ]);
  });

  it("New York residence outside NYC and Yonkers with no work state", () => {
    expect(reasonsOf(input({ residence: us("NY"), workState: null }))).toEqual([
      "local_outside_work_state",
    ]);
  });

  it("does not also report not-yet-supported for the local it cannot compute", () => {
    expect(
      reasonsOf(
        input({
          taxYear: 2026,
          residence: us("NY", "NY-NYC"),
          workState: work("NJ", null),
          localConfigYears: {},
        }),
      ),
    ).toEqual(["local_outside_work_state"]);
  });

  it("TX resident with no work state is ok (no resident local)", () => {
    expect(reasonsOf(input({ workState: null }))).toEqual([]);
  });
});

describe("reason ordering and purity", () => {
  it("returns reasons in the fixed table order, without duplicates", () => {
    expect(
      reasonsOf(
        input({
          coverage: [],
          residence: null,
          workState: work("NY", null, false),
        }),
      ),
    ).toEqual(["local_coverage_missing", "residence_missing", "work_locality_unconfirmed"]);
    expect(reasonsOf(input({ residence: us("OH"), workState: work("MD", null, false) }))).toEqual([
      "work_locality_unconfirmed",
      "local_unsupported_state",
    ]);
  });

  it("does not mutate its input", () => {
    const i = input({ residence: us("NY", "NY-NYC"), workState: work("NJ", null) });
    const copy = structuredClone(i);
    checkLocalTaxSupport(i);
    expect(i).toEqual(copy);
  });
});
