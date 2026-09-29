/**
 * PAY-162 auditor-owned scenario tests (payroll-calc-auditor) — W-2/W-3
 * boxes 1-6 in integer cents, integration half: golden figures G01-G08 and
 * the "fail first" T06-T08, T17. Only the auditor edits expected values.
 *
 * GOLDEN LITERALS were captured by running this file's fixture against the
 * UNCHANGED code at origin/main 1fbd87e40a701e026709726a8a2716df924310d1
 * (2026-09-29). They must pass before and after PAY-162. The 2025 fixture
 * replicates annual-forms.test.ts (thirteen W-2 employees: twelve at
 * $8,000.00 for January 2025, one at $1,111.11/mo for all of 2025) on a
 * fresh database; names and amounts are synthetic ("Example Corp").
 *
 * Independent oracle (hand/Decimal, not the engine):
 * - 2025 fixture: SS 6.2% / Medicare 1.45% per run, wage base $176,100
 *   (not reached). $8,000.00 -> box 4 496.00, box 6 116.00. $1,111.11 x 12:
 *   per run 68.88882 -> 68.89 and 16.110995 -> 16.11, so box 4 826.68,
 *   box 6 193.32. Box 2 per Pub 15-T (2025) Worksheet 1A + annual STANDARD
 *   single table: 96,000 - 8,600 = 87,400 -> 5,578.50 + 22% x (87,400 -
 *   54,875) = 12,734.00 / 12 = 1,061.17 per $8,000 run; $1,111.11/mo ->
 *   13,333.32 - 8,600 < 6,400 -> 0.00. W-3: box 1/3/5 109,333.32, box 2
 *   12,734.04, box 4 6,778.68, box 6 1,585.32.
 * - 2026 (Pub 15 2026: base $184,500; Additional Medicare 0.9% over
 *   $200,000, withheld from the pay period in which wages exceed it):
 *   G04 $1,234.56 x 12: per run 76.54 SS / 17.90 Medicare -> 918.48 /
 *   214.80. G06 $20,000 x 12: SS 1,240.00 x 9 + 279.00 (184,500 - 180,000
 *   = 4,500 x 6.2%) + 0 + 0 = 11,439.00; Medicare 290.00 x 10 + 470.00 x 2
 *   (Nov/Dec wholly over $200,000: 290 + 180) = 3,840.00. G07 $15,375 x 12:
 *   SS 953.25 x 12 = 11,439.00; Medicare 222.9375 -> 222.94 (half-up) x 12
 *   = 2,675.28 vs 184,500 x 1.45% = 2,675.25 (3c <= tol 6c).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import {
  compensation,
  company,
  employees,
  payrollEntries,
  payrollRuns,
  seedDatabase,
  type SeedDb,
  taxFilings,
} from "@payroll/db";
import { prepareW2EmployeePacket, prepareW3, W3_FIELD_MAP, w2FieldMap } from "@payroll/documents";
import {
  computeW3Worksheet,
  syncAnnualFilings,
  w2FiguresForYear,
  w2InputFor,
  w3InputFor,
} from "../src/filings/annual.js";
import { worksheetHash } from "../src/filings/shared.js";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";

/** Commit the golden literals were captured on (unchanged code). */
const GOLDEN_COMMIT = "1fbd87e40a701e026709726a8a2716df924310d1";
const TODAY = "2026-09-29";

// ---------------------------------------------------------------------------
// Golden literals (captured on GOLDEN_COMMIT — do not edit by hand)
// ---------------------------------------------------------------------------

const GOLDEN_W3_2025 = {
  form: "w2_w3",
  year: 2025,
  employeeCount: 13,
  box1Wages: "109333.32",
  box2FederalWithheld: "12734.04",
  box3SsWages: "109333.32",
  box4SsTax: "6778.68",
  box5MedicareWages: "109333.32",
  box6MedicareTax: "1585.32",
} as const;
const GOLDEN_W3_2025_HASH = "9e5e6e0429512d46113b82fa1b37ff6db369bdb7850bce59e341ff561341c332";
/** legalName -> [box1, box2, box3, box4, box5, box6] as printed. */
const GOLDEN_W2_2025: Record<string, string[]> = {
  "Annual Acct A": ["8000.00", "1061.17", "8000.00", "496.00", "8000.00", "116.00"],
  "Annual Acct B": ["8000.00", "1061.17", "8000.00", "496.00", "8000.00", "116.00"],
  "Annual Cap 01": ["8000.00", "1061.17", "8000.00", "496.00", "8000.00", "116.00"],
  "Annual Cap 02": ["8000.00", "1061.17", "8000.00", "496.00", "8000.00", "116.00"],
  "Annual Cap 03": ["8000.00", "1061.17", "8000.00", "496.00", "8000.00", "116.00"],
  "Annual Cap 04": ["8000.00", "1061.17", "8000.00", "496.00", "8000.00", "116.00"],
  "Annual Cap 05": ["8000.00", "1061.17", "8000.00", "496.00", "8000.00", "116.00"],
  "Annual Cap 06": ["8000.00", "1061.17", "8000.00", "496.00", "8000.00", "116.00"],
  "Annual Cap 07": ["8000.00", "1061.17", "8000.00", "496.00", "8000.00", "116.00"],
  "Annual Cap 08": ["8000.00", "1061.17", "8000.00", "496.00", "8000.00", "116.00"],
  "Annual Cap 09": ["8000.00", "1061.17", "8000.00", "496.00", "8000.00", "116.00"],
  "Annual Cap 10": ["8000.00", "1061.17", "8000.00", "496.00", "8000.00", "116.00"],
  "Annual Rounding": ["13333.32", "0.00", "13333.32", "826.68", "13333.32", "193.32"],
};

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let t: TestContext;
let ADMIN: Record<string, string>;
let acctAId: number;
let roundingId: number;
let g04Id: number;
let g06Id: number;
let g07Id: number;

beforeAll(async () => {
  expect(GOLDEN_COMMIT).toMatch(/^[0-9a-f]{40}$/);
  t = await createTestApp();
  await seedDatabase(t.db as unknown as SeedDb);
  const admin = await inviteAndOnboard(t, { email: "cents-admin@test.dev", role: "admin" });
  ADMIN = sessionHeader((await login(t, admin.email, TEST_PASSWORD)).sessionCookie);

  // 2025 fixture (mirrors annual-forms.test.ts).
  for (let i = 1; i <= 10; i += 1) {
    const id = await createEmployee(`Annual Cap ${String(i).padStart(2, "0")}`, "2025-01-01");
    await addCompensation(id, 8000, "2025-01-01");
    await issueRun(id, 2025, 1);
  }
  for (const [email, name] of [
    ["cents-acct-a@test.dev", "Annual Acct A"],
    ["cents-acct-b@test.dev", "Annual Acct B"],
  ] as const) {
    const user = await inviteAndOnboard(t, { email, name });
    const id = await createEmployee(name, "2025-01-01", user.userId);
    await addCompensation(id, 8000, "2025-01-01");
    await issueRun(id, 2025, 1);
    if (name === "Annual Acct A") acctAId = id;
  }
  roundingId = await createEmployee("Annual Rounding", "2025-01-01");
  await addCompensation(roundingId, 1111.11, "2025-01-01");
  for (let month = 1; month <= 12; month += 1) await issueRun(roundingId, 2025, month);

  // 2026 scenarios (seeded 2026 federal tax_config: base 184,500.00).
  g04Id = await createEmployee("Cents G04 Many Runs", "2026-01-01");
  await addCompensation(g04Id, 1234.56, "2026-01-01");
  g06Id = await createEmployee("Cents G06 Cap Crossing", "2026-01-01");
  await addCompensation(g06Id, 20000, "2026-01-01");
  g07Id = await createEmployee("Cents G07 At Cap", "2026-01-01");
  await addCompensation(g07Id, 15375, "2026-01-01");
  for (let month = 1; month <= 12; month += 1) {
    for (const id of [g04Id, g06Id, g07Id]) await issueRun(id, 2026, month);
  }
}, 600_000);

afterAll(async () => {
  await t.close();
});

async function createEmployee(
  legalName: string,
  hireDate: string,
  userId?: string,
): Promise<number> {
  const companyRows = await t.db.select({ id: company.id }).from(company).limit(1);
  const rows = await t.db
    .insert(employees)
    .values({
      companyId: companyRows[0]?.id ?? 1,
      legalName,
      hireDate,
      ...(userId ? { userId } : {}),
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("employee insert failed");
  return row.id;
}

async function addCompensation(employeeId: number, amount: number, from: string): Promise<void> {
  await t.db.insert(compensation).values({
    employeeId,
    periodAmount: String(amount),
    frequency: "monthly",
    effectiveFrom: from,
    effectiveTo: null,
  });
}

async function issueRun(employeeId: number, year: number, month: number): Promise<void> {
  const gen = await t.app.inject({
    method: "POST",
    url: "/api/admin/payroll-runs/generate",
    headers: ADMIN,
    payload: { year, month, employeeId },
  });
  expect(gen.statusCode, gen.body).toBe(201);
  const run = (gen.json() as { generated: { publicId: string }[] }).generated[0];
  if (!run) throw new Error("no run generated");
  for (const action of ["approve", "issue"] as const) {
    const res = await t.app.inject({
      method: "POST",
      url: `/api/admin/payroll-runs/${run.publicId}/${action}`,
      headers: ADMIN,
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
  }
}

// ---------------------------------------------------------------------------
// Shape-tolerant readers (golden tests must pass before AND after PAY-162)
// ---------------------------------------------------------------------------

const CENTS_KEYS = ["box1Cents", "box2Cents", "box3Cents", "box4Cents", "box5Cents", "box6Cents"];
const WIRE_KEYS = [
  "box1Wages",
  "box2FederalWithheld",
  "box3SsWages",
  "box4SsTax",
  "box5MedicareWages",
  "box6MedicareTax",
];

/** Independent cents -> "123.45" (no shared helper). */
function centsText(c: bigint): string {
  const neg = c < 0n;
  const a = neg ? -c : c;
  return `${neg ? "-" : ""}${a / 100n}.${(a % 100n).toString().padStart(2, "0")}`;
}
function textCents(s: string): bigint {
  const m = /^(-?)(\d+)\.(\d\d)$/.exec(s);
  if (!m) throw new Error("bad money literal");
  const v = BigInt(m[2] ?? "") * 100n + BigInt(m[3] ?? "");
  return m[1] ? -v : v;
}

/** The six printed box strings of one W2Figures row, old (number $) or new (integer cents) shape. */
function boxStrings(f: unknown): string[] {
  const r = f as Record<string, unknown>;
  return CENTS_KEYS.map((ck, i) => {
    const c = r[ck];
    if (typeof c === "number") return centsText(BigInt(c));
    const d = r[WIRE_KEYS[i] ?? ""];
    if (typeof d === "number") return d.toFixed(2);
    return String(d);
  });
}

async function figuresByName(year: number): Promise<Map<string, unknown>> {
  const figures = await w2FiguresForYear(t.db, year);
  return new Map(figures.map((f) => [f.legalName, f as unknown]));
}

/** Per-run amounts of one category, in pay-date order, as printed strings. */
async function perRun(employeeId: number, category: string): Promise<string[]> {
  const rows = await t.db
    .select({ amount: payrollEntries.amount })
    .from(payrollEntries)
    .innerJoin(payrollRuns, eq(payrollEntries.runId, payrollRuns.id))
    .where(
      and(
        eq(payrollRuns.employeeId, employeeId),
        eq(payrollRuns.status, "issued"),
        eq(payrollEntries.category, category),
      ),
    )
    .orderBy(asc(payrollRuns.payDate));
  return rows.map((r) => r.amount);
}

async function listRows(year: number) {
  const res = await t.app.inject({
    method: "GET",
    url: `/api/admin/annual-forms/w2?year=${year}`,
    headers: ADMIN,
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { w2s: Record<string, unknown>[] }).w2s;
}

// ---------------------------------------------------------------------------
// Golden: pass before and after
// ---------------------------------------------------------------------------

describe("G01-G03 2025 fixture is byte-identical (golden, captured on 1fbd87e)", () => {
  it("G01 W-3 worksheet deep-equals the captured literal, same worksheetHash", async () => {
    const w3 = await computeW3Worksheet(t.db, 2025);
    expect(w3).toEqual(GOLDEN_W3_2025);
    expect(Object.keys(w3).sort()).toEqual(Object.keys(GOLDEN_W3_2025).sort());
    expect(worksheetHash(w3)).toBe(GOLDEN_W3_2025_HASH);
    expect(w3.box1Wages).toBe("109333.32");
  });

  it("G01 oracle: the captured W-3 equals the hand-computed 2025 totals", () => {
    expect(GOLDEN_W3_2025).toEqual({
      form: "w2_w3",
      year: 2025,
      employeeCount: 13,
      box1Wages: "109333.32",
      box2FederalWithheld: "12734.04",
      box3SsWages: "109333.32",
      box4SsTax: "6778.68",
      box5MedicareWages: "109333.32",
      box6MedicareTax: "1585.32",
    });
  });

  it("G02 the 13 per-employee box strings equal the captured literals", async () => {
    const byName = await figuresByName(2025);
    expect([...byName.keys()].sort()).toEqual(Object.keys(GOLDEN_W2_2025).sort());
    for (const [name, golden] of Object.entries(GOLDEN_W2_2025)) {
      expect(boxStrings(byName.get(name)), name).toEqual(golden);
    }
  });

  it("G02 oracle: captured per-employee strings equal the hand computation", () => {
    const capped = ["8000.00", "1061.17", "8000.00", "496.00", "8000.00", "116.00"];
    for (const [name, golden] of Object.entries(GOLDEN_W2_2025)) {
      if (name === "Annual Rounding") {
        expect(golden).toEqual(["13333.32", "0.00", "13333.32", "826.68", "13333.32", "193.32"]);
      } else {
        expect(golden, name).toEqual(capped);
      }
    }
  });

  it("G02 PDF field text is the captured box strings (W-2 Copy B, W-3 box 1)", async () => {
    const input = await w2InputFor({ db: t.db, config: t.config }, acctAId, 2025, { today: TODAY });
    const doc = await prepareW2EmployeePacket(input);
    const form = doc.getForm();
    const map = w2FieldMap("CopyB");
    const printed = [
      map.box1Wages,
      map.box2FederalWithheld,
      map.box3SsWages,
      map.box4SsTax,
      map.box5MedicareWages,
      map.box6MedicareTax,
    ].map((name) => form.getTextField(name).getText() ?? null);
    expect(printed).toEqual(GOLDEN_W2_2025["Annual Acct A"]);

    const w3 = await prepareW3(
      await w3InputFor({ db: t.db, config: t.config }, 2025, { today: TODAY }),
    );
    expect(w3.getForm().getTextField(W3_FIELD_MAP.box1Wages).getText()).toBe("109333.32");
  });

  it("G03 sync stores the golden hash; a second sync refreshes nothing", async () => {
    await syncAnnualFilings({ db: t.db, config: t.config }, { today: TODAY });
    const rows = await t.db
      .select()
      .from(taxFilings)
      .where(
        and(eq(taxFilings.formType, "w2_w3"), eq(taxFilings.year, 2025), eq(taxFilings.quarter, 0)),
      );
    expect(rows[0]?.worksheetHash).toBe(GOLDEN_W3_2025_HASH);
    expect(rows[0]?.worksheet).toEqual(GOLDEN_W3_2025);
    const again = await syncAnnualFilings({ db: t.db, config: t.config }, { today: TODAY });
    expect(again.refreshed).toBe(0);
    const after = await t.db
      .select({ hash: taxFilings.worksheetHash })
      .from(taxFilings)
      .where(
        and(eq(taxFilings.formType, "w2_w3"), eq(taxFilings.year, 2025), eq(taxFilings.quarter, 0)),
      );
    expect(after[0]?.hash).toBe(GOLDEN_W3_2025_HASH);
  });
});

describe("G04 / G06 / G07 2026 scenarios — engine entries and box strings (golden figures)", () => {
  it("G04 $1,234.56 x 12: per run 76.54 SS / 17.90 Medicare; boxes 14814.72 / 918.48 / 214.80", async () => {
    expect(await perRun(g04Id, "social_security")).toEqual(Array(12).fill("76.54"));
    expect(await perRun(g04Id, "medicare")).toEqual(Array(12).fill("17.90"));
    const f = (await figuresByName(2026)).get("Cents G04 Many Runs");
    const [b1, , b3, b4, b5, b6] = boxStrings(f);
    expect([b1, b3, b4, b5, b6]).toEqual(["14814.72", "14814.72", "918.48", "14814.72", "214.80"]);
  });

  it("G06 $20,000 x 12, cap 184,500: SS stops at the base, Additional Medicare from November", async () => {
    expect(await perRun(g06Id, "social_security")).toEqual([
      ...Array(9).fill("1240.00"),
      "279.00",
      "0.00",
      "0.00",
    ]);
    expect(await perRun(g06Id, "medicare")).toEqual([
      ...Array(10).fill("290.00"),
      "470.00",
      "470.00",
    ]);
    const f = (await figuresByName(2026)).get("Cents G06 Cap Crossing");
    const [b1, , b3, b4, b5, b6] = boxStrings(f);
    expect([b1, b3, b4, b5, b6]).toEqual([
      "240000.00",
      "184500.00",
      "11439.00",
      "240000.00",
      "3840.00",
    ]);
  });

  it("G07 $15,375 x 12, exactly at the cap: 953.25 SS; Medicare 222.9375 rounds half-up to 222.94", async () => {
    expect(await perRun(g07Id, "social_security")).toEqual(Array(12).fill("953.25"));
    expect(await perRun(g07Id, "medicare")).toEqual(Array(12).fill("222.94"));
    const f = (await figuresByName(2026)).get("Cents G07 At Cap");
    const [b1, , b3, b4, b5, b6] = boxStrings(f);
    expect([b1, b3, b4, b5, b6]).toEqual([
      "184500.00",
      "184500.00",
      "11439.00",
      "184500.00",
      "2675.28",
    ]);
  });
});

describe("G08 W-3 totals = sum of the W-2s, every box (golden)", () => {
  for (const year of [2025, 2026]) {
    it(`${year}: each W-3 box equals an independent BigInt sum of the printed W-2 boxes`, async () => {
      const figures = await w2FiguresForYear(t.db, year);
      const w3 = (await computeW3Worksheet(t.db, year)) as unknown as Record<string, unknown>;
      expect(w3.employeeCount).toBe(figures.length);
      WIRE_KEYS.forEach((key, i) => {
        const total = figures.reduce((acc, f) => acc + textCents(boxStrings(f)[i] ?? ""), 0n);
        expect(w3[key], key).toBe(centsText(total));
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Must fail first on 1fbd87e (new shapes / new behaviour)
// ---------------------------------------------------------------------------

describe("T06-T08 integer cents inside, strings at the edge (fail first)", () => {
  it("T06 w2FiguresForYear(2025): integer-cents fields and runCount", async () => {
    const figures = (await w2FiguresForYear(t.db, 2025)) as unknown as Record<string, unknown>[];
    for (const f of figures) {
      for (const k of CENTS_KEYS)
        expect(Number.isSafeInteger(f[k]), `${f.legalName} ${k}`).toBe(true);
    }
    const a = figures.find((f) => f.employeeId === acctAId);
    const r = figures.find((f) => f.employeeId === roundingId);
    expect(a?.box1Cents).toBe(800_000);
    expect(a?.runCount).toBe(1);
    expect(r?.box1Cents).toBe(1_333_332);
    expect(r?.runCount).toBe(12);
  });

  it("T07 admin W-2 list: box strings, issues [] and blocked false for acctA", async () => {
    const row = (await listRows(2025)).find((w) => w.employeeId === acctAId);
    expect(row?.box1Wages).toBe("8000.00");
    expect(row?.box2FederalWithheld).toBe("1061.17");
    expect(row?.box3SsWages).toBe("8000.00");
    expect(row?.box4SsTax).toBe("496.00");
    expect(row?.box5MedicareWages).toBe("8000.00");
    expect(row?.box6MedicareTax).toBe("116.00");
    expect(row?.issues).toEqual([]);
    expect(row?.blocked).toBe(false);
  });

  it("T08 PDF inputs carry strings: W-2 '8000.00', W-3 '109333.32'", async () => {
    const w2 = await w2InputFor({ db: t.db, config: t.config }, acctAId, 2025, { today: TODAY });
    expect(w2.box1Wages).toBe("8000.00");
    expect(w2.box6MedicareTax).toBe("116.00");
    const w3 = await w3InputFor({ db: t.db, config: t.config }, 2025, { today: TODAY });
    expect(w3.box1Wages).toBe("109333.32");
    expect(w3.box6MedicareTax).toBe("1585.32");
  });
});

describe("T17 + G04/G06/G07 issues part: no block, no warn (fail first: `issues` is new)", () => {
  it("T17 every 2025 W-2 has issues [] and blocked false", async () => {
    const rows = await listRows(2025);
    expect(rows).toHaveLength(13);
    for (const row of rows) {
      expect(row.issues, String(row.legalName)).toEqual([]);
      expect(row.blocked, String(row.legalName)).toBe(false);
    }
  });

  it("G04 / G06 / G07 raise no issue (drift within tol; Additional Medicare in box 6)", async () => {
    const rows = await listRows(2026);
    for (const id of [g04Id, g06Id, g07Id]) {
      const row = rows.find((w) => w.employeeId === id);
      expect(row?.issues, String(row?.legalName)).toEqual([]);
      expect(row?.blocked).toBe(false);
    }
  });

  it("w2FiguresForYear carries the same empty issues list", async () => {
    for (const year of [2025, 2026]) {
      const figures = (await w2FiguresForYear(t.db, year)) as unknown as Record<string, unknown>[];
      for (const f of figures) expect(f.issues, String(f.legalName)).toEqual([]);
    }
  });
});
