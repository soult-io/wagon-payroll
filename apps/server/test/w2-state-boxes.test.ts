/**
 * Spec 24 (PAY-116) PR-2 — payroll-calc-auditor integration tests: W-2
 * boxes 15-17 in the admin W-2 list JSON and the W-3 worksheet (years >=
 * 2026), state blocks on the PDF routes, years < 2026 unchanged.
 *
 * Every scenario boots its own PGlite app (isolated fixtures; the file
 * passes shuffled). Runs are direct inserts with literal snapshots, never
 * generateDraft. Expected values: the auditor's oracle (w2-state-oracle.ts,
 * no src/ or engine import) recomputes boxes 16/17, form/row and every W-3
 * total from the fixture runs; the Spec 24 §11 hand values are asserted
 * next to it. Sources: see w2-state-oracle.ts header (iw2w3 2026 boxes
 * 15-20, box c, W-3 boxes 15-17; NYS TSB-M-02(3)I; Spec 24 R1-R9).
 *
 * Fail first on origin/main a58dfc5: no stateLines / localLines / formCount
 * / yearIssues on the list, no state keys on the W-3 worksheet, no state
 * blocks. Guards (pass before and after) are named "guard".
 *
 * Interfaces required (PR-2 brief §5-§6):
 *  - GET /api/admin/annual-forms/w2?year= rows: stateLines [{state, box16,
 *    box17, form, row, stateIdSource}] (strings | null), localLines [],
 *    formCount, issues (W2Issue: code, severity, state?, runs?, date?);
 *    response yearIssues [].
 *  - computeW3Worksheet(db, year) for year >= 2026: + w2FormCount,
 *    box15State, box16StateWages, box17StateTax, states[], blockedEmployees.
 *  - State blocks -> 409 {error:"w2_not_ready", issues:[codes]} on admin PDF
 *    routes; employee route body exactly {error:"w2_not_ready"}.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { stateTaxConfigs, taxDeposits } from "@payroll/db";
import { computeW3Worksheet, syncAnnualFilings } from "../src/filings/annual.js";
import type { Db } from "../src/db.js";
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
  type ListRow,
  rowOf,
  scrubTimestamps,
  setEin,
  stateView,
  SYNTHETIC_EIN,
  voidRun,
  workState,
  w2w3Row,
} from "./w2-state-harness.js";
import {
  apiLines,
  boxStrings,
  canonicalSha,
  expBoxes,
  expFormCount,
  expLines,
  expW3,
  type FxRun,
  money,
  months,
  monthly,
  st,
} from "./w2-state-oracle.js";

const AFTER_YEAR_END = "2027-01-05T12:00:00Z";
const TODAY_2027 = "2027-01-05";

type Source = "entered" | "ein_default" | null;

const CA = st("CA");
const NY = st("NY");
const IL = st("IL");
const MD = st("MD");
const NC = st("NC");
const TX_NONE = st("TX", "none");

const ana = (): FxRun[] => months(2026, 1, 12).map((m) => monthly(m, CA, 1234));
const ben = (): FxRun[] => [
  ...months(2026, 1, 6).map((m) => monthly(m, CA, 1234)),
  ...months(2026, 7, 12).map((m) => monthly(m, NY, 2000)),
];
const dee = (): FxRun[] => [
  ...months(2026, 1, 4).map((m) => monthly(m, IL, 24750)),
  ...months(2026, 5, 8).map((m) => monthly(m, MD, 2500)),
  ...months(2026, 9, 12).map((m) => monthly(m, NC, 2000)),
];

/** The expected state view of one list row, from the oracle. */
function expView(
  runs: readonly FxRun[],
  year: number,
  sources: Record<string, Source>,
  issues: unknown[],
) {
  const lines = expLines(runs, year);
  return {
    stateLines: apiLines(lines, sources),
    localLines: [],
    formCount: expFormCount(lines),
    issues,
    blocked: issues.some((i) => (i as { severity: string }).severity === "block"),
  };
}

const w3 = (env: Env, year: number) => computeW3Worksheet(env.t.db as unknown as Db, year);
const sync = (env: Env, today = TODAY_2027) =>
  syncAnnualFilings({ db: env.t.db, config: env.t.config } as never, { today });

function scenario(setup: (env: Env) => Promise<void>, opts: { now?: string } = {}) {
  const ctx = { env: undefined as unknown as Env };
  beforeAll(async () => {
    ctx.env = await bootEnv(opts);
    await setup(ctx.env);
  });
  afterAll(async () => ctx.env.close());
  return ctx;
}

// ---------------------------------------------------------------------------
// W01 — CA single state (Spec 24 §6 worked example)
// ---------------------------------------------------------------------------

describe("W01 Ana CA 2026", () => {
  let id = 0;
  const s = scenario(async (env) => {
    await enterStateId(env, "CA");
    id = await createEmployee(env, "Ana Synthetic");
    await insertRuns(env, id, ana());
  });

  it("list: CA 60000.00 / 148.08, form 1 row 1, formCount 1, localLines [], no issues; yearIssues []", async () => {
    const l = await list(s.env, 2026);
    const row = l.json.w2s.find((r) => r.employeeId === id)!;
    expect(stateView(row)).toEqual(expView(ana(), 2026, { CA: "entered" }, []));
    expect(row.stateLines).toEqual([
      {
        state: "CA",
        box16: "60000.00",
        box17: "148.08",
        form: 1,
        row: 1,
        stateIdSource: "entered",
      },
    ]);
    expect(l.json.yearIssues).toEqual([]);
  });

  it("W-3 worksheet: box c 1, box 15 CA, 16 60000.00, 17 148.08, CA reconciled (runs 148.08)", async () => {
    const ws = await w3(s.env, 2026);
    const exp = expW3(2026, [{ runs: ana() }]);
    expect(ws).toEqual(exp);
    expect({
      w2FormCount: ws.w2FormCount,
      box15State: ws.box15State,
      box16: ws.box16StateWages,
      box17: ws.box17StateTax,
    }).toEqual({ w2FormCount: 1, box15State: "CA", box16: "60000.00", box17: "148.08" });
  });

  it("stored w2_w3 worksheet (2027-01-05 sync) = the oracle object; worksheet_hash = auditor's canonical SHA", async () => {
    await sync(s.env);
    const row = await w2w3Row(s.env, 2026);
    const exp = expW3(2026, [{ runs: ana() }]);
    expect({ worksheet: row?.worksheet, hash: row?.worksheetHash }).toEqual({
      worksheet: exp,
      hash: canonicalSha(exp),
    });
  });

  it("guard (P1): no state ID value or mask anywhere in the list body or worksheet", async () => {
    const l = await list(s.env, 2026);
    const ws = JSON.stringify(await w3(s.env, 2026));
    for (const text of [l.body, ws]) {
      expect(text).not.toContain("00000001");
      expect(text).not.toContain("••••");
      expect(text).not.toContain("idMasked");
    }
  });
});

// ---------------------------------------------------------------------------
// W02 — CA -> NY (R3), issue order O1
// ---------------------------------------------------------------------------

describe("W02 Ben CA Jan-Jun, NY Jul-Dec", () => {
  let id = 0;
  const s = scenario(async (env) => {
    await enterStateId(env, "CA");
    await setEin(env, SYNTHETIC_EIN);
    id = await createEmployee(env, "Ben Synthetic");
    await insertRuns(env, id, ben());
  });

  it("CA 30000.00/74.04 row 1; NY 60000.00/120.00 row 2; issues [local_tax_ny, ny_all_wages] (O1)", async () => {
    const row = await rowOf(s.env, 2026, id);
    const issues = [
      { code: "local_tax_ny", severity: "warn", state: "NY" },
      { code: "ny_all_wages", severity: "info", state: "NY" },
    ];
    expect(stateView(row)).toEqual(
      expView(ben(), 2026, { CA: "entered", NY: "ein_default" }, issues),
    );
    expect((row.stateLines as { box16: string }[]).map((l) => l.box16)).toEqual([
      "30000.00",
      "60000.00",
    ]);
  });

  it("NY box 16 string === the row's box 1 string", async () => {
    const row = await rowOf(s.env, 2026, id);
    const ny = (row.stateLines as { state: string; box16: string }[]).find((l) => l.state === "NY");
    expect(ny?.box16).toBe(row.box1Wages);
    expect(row.box1Wages).toBe("60000.00");
  });
});

// ---------------------------------------------------------------------------
// W03 — move mid-period (K3, I2)
// ---------------------------------------------------------------------------

describe("W03 Cara moves CA -> NY on 2026-06-10", () => {
  let id = 0;
  const cara = (): FxRun[] => [
    ...months(2026, 1, 6).map((m) => monthly(m, CA, 1000, { grossCents: 400_000 })),
    ...months(2026, 7, 12).map((m) => monthly(m, NY, 1500, { grossCents: 400_000 })),
  ];
  const s = scenario(async (env) => {
    await enterStateId(env, "CA");
    await enterStateId(env, "NY", "123456789");
    id = await createEmployee(env, "Cara Synthetic");
    await workState(env, id, "CA", "2026-01-01", "2026-06-09");
    await workState(env, id, "NY", "2026-06-10");
    await insertRuns(env, id, cara());
  });

  it("June run counts in CA: CA 24000.00/60.00, NY 48000.00/90.00; I2 (CA, 2026-06-10), W7, I1", async () => {
    const row = await rowOf(s.env, 2026, id);
    const issues = [
      { code: "period_spans_move", severity: "info", state: "CA", date: "2026-06-10" },
      { code: "local_tax_ny", severity: "warn", state: "NY" },
      { code: "ny_all_wages", severity: "info", state: "NY" },
    ];
    expect(stateView(row)).toEqual(expView(cara(), 2026, { CA: "entered", NY: "entered" }, issues));
    expect(
      (row.stateLines as { box16: string; box17: string }[]).map((l) => [l.box16, l.box17]),
    ).toEqual([
      ["24000.00", "60.00"],
      ["48000.00", "90.00"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// W04 — IL exempt from July (W8)
// ---------------------------------------------------------------------------

describe("W04 Ivy IL, exempt from July", () => {
  let id = 0;
  const ivy = (): FxRun[] => [
    ...months(2026, 1, 6).map((m) => monthly(m, IL, 24750)),
    ...months(2026, 7, 12).map((m) => monthly(m, st("IL", "flat", true), 0)),
  ];
  const s = scenario(async (env) => {
    await setEin(env, SYNTHETIC_EIN);
    id = await createEmployee(env, "Ivy Synthetic");
    await insertRuns(env, id, ivy());
  });

  it("IL 60000.00 / 1485.00 (EIN default); exempt_reciprocity warn; not blocked", async () => {
    const row = await rowOf(s.env, 2026, id);
    const issues = [{ code: "exempt_reciprocity", severity: "warn", state: "IL" }];
    expect(stateView(row)).toEqual(expView(ivy(), 2026, { IL: "ein_default" }, issues));
    expect(row.stateLines).toEqual([
      {
        state: "IL",
        box16: "60000.00",
        box17: "1485.00",
        form: 1,
        row: 1,
        stateIdSource: "ein_default",
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// W05 — three states -> two forms; W-3 box c counts forms (S24-D12)
// ---------------------------------------------------------------------------

describe("W05 Dee IL / MD / NC", () => {
  let id = 0;
  const s = scenario(async (env) => {
    await setEin(env, SYNTHETIC_EIN);
    await enterStateId(env, "MD", "00000002");
    await enterStateId(env, "NC", "000000003");
    id = await createEmployee(env, "Dee Synthetic");
    await insertRuns(env, id, dee());
  });

  it("IL 20000.00/990.00 f1r1, MD 20000.00/100.00 f1r2, NC 20000.00/80.00 f2r1; formCount 2; W6 MD (O1)", async () => {
    const row = await rowOf(s.env, 2026, id);
    const issues = [{ code: "local_tax_md", severity: "warn", state: "MD" }];
    expect(stateView(row)).toEqual(
      expView(dee(), 2026, { IL: "ein_default", MD: "entered", NC: "entered" }, issues),
    );
    expect(row.formCount).toBe(2);
  });

  it("W-3 for Dee alone: box c 2, employeeCount 1, box 15 X, 16 60000.00, 17 1170.00", async () => {
    const ws = await w3(s.env, 2026);
    expect(ws).toEqual(expW3(2026, [{ runs: dee() }]));
    expect([
      ws.w2FormCount,
      ws.employeeCount,
      ws.box15State,
      ws.box16StateWages,
      ws.box17StateTax,
    ]).toEqual([2, 1, "X", "60000.00", "1170.00"]);
  });
});

// ---------------------------------------------------------------------------
// W06 / W16 — kind none; live config never read
// ---------------------------------------------------------------------------

describe("W06 Eve TX all year (kind none)", () => {
  let id = 0;
  const eve = (): FxRun[] => months(2026, 1, 12).map((m) => monthly(m, TX_NONE, 0));
  const s = scenario(async (env) => {
    id = await createEmployee(env, "Eve Synthetic");
    await insertRuns(env, id, eve());
  });

  it("no lines, no issues, formCount 1", async () => {
    const row = await rowOf(s.env, 2026, id);
    expect(stateView(row)).toEqual({
      stateLines: [],
      localLines: [],
      formCount: 1,
      issues: [],
      blocked: false,
    });
  });

  it('W-3: box15State null, box16/17 "0.00", states [], box c 1', async () => {
    const ws = await w3(s.env, 2026);
    expect(ws).toEqual(expW3(2026, [{ runs: eve() }]));
    expect([
      ws.box15State,
      ws.box16StateWages,
      ws.box17StateTax,
      ws.states,
      ws.w2FormCount,
    ]).toEqual([null, "0.00", "0.00", [], 1]);
  });
});

describe("W16 a live state_tax_configs change after issue is ignored", () => {
  let eveId = 0;
  let fayId = 0;
  const eve = (): FxRun[] => months(2026, 1, 12).map((m) => monthly(m, TX_NONE, 0));
  const s = scenario(async (env) => {
    await enterStateId(env, "CA");
    eveId = await createEmployee(env, "Eve Sixteen");
    fayId = await createEmployee(env, "Fay Sixteen");
    await insertRuns(env, eveId, eve());
    await insertRuns(env, fayId, ana());
    for (const [jurisdiction, kind] of [
      ["TX", "flat"],
      ["CA", "none"],
    ] as const) {
      await env.t.db
        .insert(stateTaxConfigs)
        .values({ jurisdiction, taxYear: 2026, kind, flatRate: kind === "flat" ? "0.05000" : null })
        .onConflictDoUpdate({
          target: [stateTaxConfigs.jurisdiction, stateTaxConfigs.taxYear],
          set: { kind, flatRate: kind === "flat" ? "0.05000" : null },
        });
    }
  });

  it("TX (snapshot none, live flat): still no line; CA (snapshot progressive, live none): line kept", async () => {
    const eveRow = await rowOf(s.env, 2026, eveId);
    const fayRow = await rowOf(s.env, 2026, fayId);
    expect({ eve: stateView(eveRow), fay: stateView(fayRow) }).toEqual({
      eve: { stateLines: [], localLines: [], formCount: 1, issues: [], blocked: false },
      fay: expView(ana(), 2026, { CA: "entered" }, []),
    });
  });
});

// ---------------------------------------------------------------------------
// W07 — TX then CA
// ---------------------------------------------------------------------------

describe("W07 Fay TX Jan-Jun, CA Jul-Dec", () => {
  let id = 0;
  const fay = (): FxRun[] => [
    ...months(2026, 1, 6).map((m) => monthly(m, TX_NONE, 0)),
    ...months(2026, 7, 12).map((m) => monthly(m, CA, 1234)),
  ];
  const s = scenario(async (env) => {
    await enterStateId(env, "CA");
    id = await createEmployee(env, "Fay Synthetic");
    await insertRuns(env, id, fay());
  });

  it("only CA 30000.00 / 74.04; box 1 60000.00", async () => {
    const row = await rowOf(s.env, 2026, id);
    expect(stateView(row)).toEqual(expView(fay(), 2026, { CA: "entered" }, []));
    expect([row.box1Wages, row.stateLines]).toEqual([
      "60000.00",
      [
        {
          state: "CA",
          box16: "30000.00",
          box17: "74.04",
          form: 1,
          row: 1,
          stateIdSource: "entered",
        },
      ],
    ]);
  });
});

// ---------------------------------------------------------------------------
// W08 / W08b / W08c — NY, EIN default
// ---------------------------------------------------------------------------

const hal = (swh: number): FxRun[] =>
  months(2026, 1, 12).map((m) => monthly(m, st("NY", "progressive", swh === 0), swh));
const NY_INFO = [
  { code: "local_tax_ny", severity: "warn", state: "NY" },
  { code: "ny_all_wages", severity: "info", state: "NY" },
];

describe("W08 Hal NY exempt, no NY row, EIN set", () => {
  let id = 0;
  const s = scenario(async (env) => {
    await setEin(env, SYNTHETIC_EIN);
    id = await createEmployee(env, "Hal Synthetic");
    await insertRuns(env, id, hal(0));
  });

  it("NY 60000.00 / 0.00, source ein_default, not blocked; NY box 16 === box 1", async () => {
    const row = await rowOf(s.env, 2026, id);
    expect(stateView(row)).toEqual(expView(hal(0), 2026, { NY: "ein_default" }, NY_INFO));
    expect((row.stateLines as { box16: string }[])[0]?.box16).toBe(row.box1Wages);
  });
});

describe("W08b Hal NY, no EIN, 15.00 withheld per run", () => {
  let id = 0;
  const s = scenario(async (env) => {
    await setEin(env, null);
    id = await createEmployee(env, "Hal Bee");
    await insertRuns(env, id, hal(1500));
  });

  it("NY 60000.00 / 180.00, source null, missing_state_id block (B1), blocked", async () => {
    const row = await rowOf(s.env, 2026, id);
    const issues = [{ code: "missing_state_id", severity: "block", state: "NY" }, ...NY_INFO];
    expect(stateView(row)).toEqual(expView(hal(1500), 2026, { NY: null }, issues));
    expect(row.blocked).toBe(true);
  });
});

describe("W08c Hal NY, no EIN, nothing withheld", () => {
  let id = 0;
  const s = scenario(async (env) => {
    await setEin(env, null);
    id = await createEmployee(env, "Hal Cee");
    await insertRuns(env, id, hal(0));
  });

  it("missing_state_id_zero_tax warn only (W4), not blocked", async () => {
    const row = await rowOf(s.env, 2026, id);
    const issues = [
      { code: "missing_state_id_zero_tax", severity: "warn", state: "NY" },
      ...NY_INFO,
    ];
    expect(stateView(row)).toEqual(expView(hal(0), 2026, { NY: null }, issues));
  });
});

describe("W09 NC all year exempt, no NC ID", () => {
  let id = 0;
  const nc = (): FxRun[] => months(2026, 1, 12).map((m) => monthly(m, st("NC", "flat", true), 0));
  const s = scenario(async (env) => {
    id = await createEmployee(env, "Ivy Nine");
    await insertRuns(env, id, nc());
  });

  it("NC 60000.00 / 0.00, W4 only, not blocked", async () => {
    const row = await rowOf(s.env, 2026, id);
    const issues = [{ code: "missing_state_id_zero_tax", severity: "warn", state: "NC" }];
    expect(stateView(row)).toEqual(expView(nc(), 2026, { NC: null }, issues));
  });
});

// ---------------------------------------------------------------------------
// W10 — missing CA ID blocks every PDF route (S24-D3, brief A5)
// ---------------------------------------------------------------------------

describe("W10 W01 without a CA ID (clock 2027-01-05)", () => {
  let id = 0;
  let session: Record<string, string> = {};
  const s = scenario(
    async (env) => {
      const emp = await consentedEmployee(env, "Ana Ten");
      id = emp.employeeId;
      session = emp.session;
      await insertRuns(env, id, ana());
    },
    { now: AFTER_YEAR_END },
  );

  it("list 200: blocked, issues [missing_state_id CA]; CA line still shown", async () => {
    const l = await list(s.env, 2026);
    expect(l.status).toBe(200);
    const row = l.json.w2s.find((r) => r.employeeId === id)!;
    expect(stateView(row)).toEqual(
      expView(ana(), 2026, { CA: null }, [
        { code: "missing_state_id", severity: "block", state: "CA" },
      ]),
    );
  });

  it("admin Copy D, print packet, W-3 -> 409 {error: w2_not_ready, issues: [missing_state_id]}", async () => {
    const urls = [
      `/api/admin/annual-forms/w2/${id}/pdf?year=2026`,
      `/api/admin/annual-forms/w2/${id}/print-packet?year=2026`,
      `/api/admin/annual-forms/w3/pdf?year=2026`,
    ];
    const out: unknown[] = [];
    for (const url of urls) {
      const res = await get(s.env, url);
      out.push({ url, status: res.statusCode, body: res.json() });
    }
    expect(out).toEqual(
      urls.map((url) => ({
        url,
        status: 409,
        body: { error: "w2_not_ready", issues: ["missing_state_id"] },
      })),
    );
  });

  it("employee route -> 409 body exactly {error: w2_not_ready} (guard)", async () => {
    const res = await get(s.env, "/api/my/w2/2026/pdf", session);
    expect({ status: res.statusCode, body: res.json() }).toEqual({
      status: 409,
      body: { error: "w2_not_ready" },
    });
  });

  it("W-3 worksheet still computes: blockedEmployees 1, CA reconciled", async () => {
    const ws = await w3(s.env, 2026);
    expect(ws).toEqual(expW3(2026, [{ runs: ana(), blocked: true }]));
  });
});

// ---------------------------------------------------------------------------
// W11 — legacy runs with state tax (R7, B2)
// ---------------------------------------------------------------------------

describe("W11 Jon legacy Jan-Mar with tax, CA Apr-Dec (clock 2027-01-05)", () => {
  let id = 0;
  let legacy: { publicId: string; payDate: string }[] = [];
  const jon = (): FxRun[] => [
    ...months(2026, 1, 3).map((m) => monthly(m, null, 3000)),
    ...months(2026, 4, 12).map((m) => monthly(m, CA, 1234)),
  ];
  const s = scenario(
    async (env) => {
      await enterStateId(env, "CA");
      id = await createEmployee(env, "Jon Synthetic");
      const runs = await insertRuns(env, id, jon());
      legacy = runs.slice(0, 3);
    },
    { now: AFTER_YEAR_END },
  );

  it("list: legacy_state_runs block listing 3 runs (public id, pay date, 30.00); CA 45000.00/111.06 shown", async () => {
    const row = await rowOf(s.env, 2026, id);
    const issues = [
      {
        code: "legacy_state_runs",
        severity: "block",
        runs: legacy.map((r) => ({
          runPublicId: r.publicId,
          payDate: r.payDate,
          stateTax: "30.00",
        })),
      },
    ];
    expect(stateView(row)).toEqual(expView(jon(), 2026, { CA: "entered" }, issues));
    expect(row.stateLines).toEqual([
      {
        state: "CA",
        box16: "45000.00",
        box17: "111.06",
        form: 1,
        row: 1,
        stateIdSource: "entered",
      },
    ]);
  });

  it("Copy D and W-3 -> 409 w2_not_ready [legacy_state_runs]", async () => {
    const d = await get(s.env, `/api/admin/annual-forms/w2/${id}/pdf?year=2026`);
    const w = await get(s.env, `/api/admin/annual-forms/w3/pdf?year=2026`);
    expect([d.statusCode, d.json(), w.statusCode, w.json()]).toEqual([
      409,
      { error: "w2_not_ready", issues: ["legacy_state_runs"] },
      409,
      { error: "w2_not_ready", issues: ["legacy_state_runs"] },
    ]);
  });

  it("W-3 worksheet: CA box 17 111.06 = issued CA runs 111.06 (legacy runs have no work state)", async () => {
    const ws = await w3(s.env, 2026);
    expect(ws).toEqual(expW3(2026, [{ runs: jon(), blocked: true }]));
  });
});

// ---------------------------------------------------------------------------
// W13 / W14 — legacy runs without state tax
// ---------------------------------------------------------------------------

describe("W13 Neo all 2026 runs legacy, no state tax (customer-zero shape)", () => {
  let id = 0;
  const neo = (): FxRun[] => months(2026, 1, 12).map((m) => monthly(m, null, undefined));
  const s = scenario(async (env) => {
    id = await createEmployee(env, "Neo Synthetic");
    await insertRuns(env, id, neo());
  });

  it("no lines, no issues, not blocked, boxes 1-6 as before", async () => {
    const row = await rowOf(s.env, 2026, id);
    expect(stateView(row)).toEqual({
      stateLines: [],
      localLines: [],
      formCount: 1,
      issues: [],
      blocked: false,
    });
    expect(row).toMatchObject(boxStrings(expBoxes(neo(), 2026)));
  });
});

describe("W14 Neo legacy Jan-Jun (SWH 0), CA Jul-Dec", () => {
  let id = 0;
  const neo = (): FxRun[] => [
    ...months(2026, 1, 6).map((m) => monthly(m, null, 0)),
    ...months(2026, 7, 12).map((m) => monthly(m, CA, 1234)),
  ];
  const s = scenario(async (env) => {
    await enterStateId(env, "CA");
    id = await createEmployee(env, "Neo Fourteen");
    await insertRuns(env, id, neo());
  });

  it("CA 30000.00 / 74.04; legacy_runs_without_state warn (W5)", async () => {
    const row = await rowOf(s.env, 2026, id);
    expect(stateView(row)).toEqual(
      expView(neo(), 2026, { CA: "entered" }, [
        { code: "legacy_runs_without_state", severity: "warn" },
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// W15 — 2025 unchanged (S24-D5)
// ---------------------------------------------------------------------------

describe("W15 tax year 2025 with an IL work state", () => {
  let a = 0;
  let b = 0;
  const legacy25 = (): FxRun[] => months(2025, 1, 12).map((m) => monthly(m, null, undefined));
  const il25 = (): FxRun[] => months(2025, 1, 12).map((m) => monthly(m, IL, 24750));
  const OLD_KEYS = [
    "box1Wages",
    "box2FederalWithheld",
    "box3SsWages",
    "box4SsTax",
    "box5MedicareWages",
    "box6MedicareTax",
    "employeeCount",
    "form",
    "year",
  ];
  const expected = () => {
    const ba = expBoxes(legacy25(), 2025);
    const bb = expBoxes(il25(), 2025);
    return {
      form: "w2_w3",
      year: 2025,
      employeeCount: 2,
      box1Wages: money(ba.box1 + bb.box1),
      box2FederalWithheld: money(ba.box2 + bb.box2),
      box3SsWages: money(ba.box3 + bb.box3),
      box4SsTax: money(ba.box4 + bb.box4),
      box5MedicareWages: money(ba.box5 + bb.box5),
      box6MedicareTax: money(ba.box6 + bb.box6),
    };
  };
  const s = scenario(async (env) => {
    a = await createEmployee(env, "Fifteen Legacy");
    b = await createEmployee(env, "Fifteen Illinois");
    await insertRuns(env, a, legacy25());
    await insertRuns(env, b, il25());
  });

  it("guard: W-3 worksheet keys and values exactly as on main; stored hash = canonical SHA of that object", async () => {
    const ws = await w3(s.env, 2025);
    expect(Object.keys(ws).sort()).toEqual(OLD_KEYS);
    expect(ws).toEqual(expected());
    await sync(s.env, "2026-10-04");
    const row = await w2w3Row(s.env, 2025);
    expect({ worksheet: row?.worksheet, hash: row?.worksheetHash }).toEqual({
      worksheet: expected(),
      hash: canonicalSha(expected()),
    });
  });

  it("list rows: stateLines [], localLines [], formCount 1, issues []; yearIssues []", async () => {
    const l = await list(s.env, 2025);
    const view = (id: number) => stateView(l.json.w2s.find((r) => r.employeeId === id)!);
    const none = { stateLines: [], localLines: [], formCount: 1, issues: [], blocked: false };
    expect({ a: view(a), b: view(b), yearIssues: l.json.yearIssues }).toEqual({
      a: none,
      b: none,
      yearIssues: [],
    });
  });
});

// ---------------------------------------------------------------------------
// W17 — idempotent refresh
// ---------------------------------------------------------------------------

describe("W17 refresh twice", () => {
  let id = 0;
  const s = scenario(async (env) => {
    await enterStateId(env, "CA");
    id = await createEmployee(env, "Ana Seventeen");
    await insertRuns(env, id, ana());
  });

  it("guard: second sync refreshes nothing, updated_at unchanged; list JSON deep-equal", async () => {
    await sync(s.env);
    const first = await w2w3Row(s.env, 2026);
    const list1 = (await list(s.env, 2026)).json;
    const again = await sync(s.env);
    const second = await w2w3Row(s.env, 2026);
    const list2 = (await list(s.env, 2026)).json;
    expect(again.refreshed).toBe(0);
    expect(second?.updatedAt).toEqual(first?.updatedAt);
    expect(second?.worksheetHash).toBe(first?.worksheetHash);
    expect(list2).toEqual(list1);
  });

  it("the stored worksheet carries the state keys (w2FormCount 1, CA 148.08)", async () => {
    await sync(s.env);
    const row = await w2w3Row(s.env, 2026);
    expect(row?.worksheet).toEqual(expW3(2026, [{ runs: ana() }]));
  });
});

// ---------------------------------------------------------------------------
// W18 / W19 — void and re-issue
// ---------------------------------------------------------------------------

describe("W18 March voided and re-issued with SWH 13.00", () => {
  let id = 0;
  const afterRuns = (): FxRun[] => [
    ...ana().filter((r) => !r.payDate.startsWith("2026-03")),
    monthly("2026-03", CA, 1300),
  ];
  const s = scenario(async (env) => {
    await enterStateId(env, "CA");
    id = await createEmployee(env, "Ana Eighteen");
    const runs = await insertRuns(env, id, ana());
    await voidRun(env, runs[2]!.id);
    await insertRun(env, id, monthly("2026-03", CA, 1300));
  });

  it("CA 60000.00 / 148.74 (14808 - 1234 + 1300 = 14874); W-3 reconciled", async () => {
    const row = await rowOf(s.env, 2026, id);
    expect(stateView(row)).toEqual(expView(afterRuns(), 2026, { CA: "entered" }, []));
    expect((row.stateLines as { box17: string }[])[0]?.box17).toBe("148.74");
    expect(await w3(s.env, 2026)).toEqual(expW3(2026, [{ runs: afterRuns() }]));
  });
});

describe("W19 March voided, no re-issue", () => {
  let id = 0;
  const afterRuns = (): FxRun[] => ana().filter((r) => !r.payDate.startsWith("2026-03"));
  const s = scenario(async (env) => {
    await enterStateId(env, "CA");
    id = await createEmployee(env, "Ana Nineteen");
    const runs = await insertRuns(env, id, ana());
    await voidRun(env, runs[2]!.id);
  });

  it("box 1 55000.00; CA 55000.00 / 135.74", async () => {
    const row = await rowOf(s.env, 2026, id);
    expect(stateView(row)).toEqual(expView(afterRuns(), 2026, { CA: "entered" }, []));
    expect([row.box1Wages, row.stateLines]).toEqual([
      "55000.00",
      [
        {
          state: "CA",
          box16: "55000.00",
          box17: "135.74",
          form: 1,
          row: 1,
          stateIdSource: "entered",
        },
      ],
    ]);
  });
});

// ---------------------------------------------------------------------------
// W20 / W21 — pay-date year (R8), 2027 CA + NY
// ---------------------------------------------------------------------------

describe("W20/W21 Kim paid the 5th of the next month; NY from 2027-01-01", () => {
  let id = 0;
  const kim = (): FxRun[] => [
    monthly("2025-12", CA, 1234, { payDate: "2026-01-05" }),
    ...months(2026, 1, 11).map((m) =>
      monthly(m, CA, 1234, {
        payDate: `2026-${String(Number(m.slice(5, 7)) + 1).padStart(2, "0")}-05`,
      }),
    ),
    monthly("2026-12", CA, 1234, { payDate: "2027-01-05" }),
    monthly("2027-01", NY, 2000, { payDate: "2027-02-05" }),
  ];
  const s = scenario(async (env) => {
    await federalConfig(env, 2027);
    await setEin(env, SYNTHETIC_EIN);
    await enterStateId(env, "CA");
    id = await createEmployee(env, "Kim Synthetic");
    await workState(env, id, "CA", "2025-12-01", "2026-12-31");
    await workState(env, id, "NY", "2027-01-01");
    await insertRuns(env, id, kim());
  });

  it("W20 2026: 12 runs by pay date -> CA 60000.00 / 148.08", async () => {
    const row = await rowOf(s.env, 2026, id);
    expect(stateView(row)).toEqual(expView(kim(), 2026, { CA: "entered" }, []));
    expect(row.stateLines).toEqual([
      {
        state: "CA",
        box16: "60000.00",
        box17: "148.08",
        form: 1,
        row: 1,
        stateIdSource: "entered",
      },
    ]);
  });

  it("W21 2027: CA 5000.00/12.34 (Dec 2026 period) + NY 10000.00/20.00 (= box 1); W7, I1", async () => {
    const row = await rowOf(s.env, 2027, id);
    expect(stateView(row)).toEqual(
      expView(kim(), 2027, { CA: "entered", NY: "ein_default" }, NY_INFO),
    );
    const lines = row.stateLines as { state: string; box16: string; box17: string }[];
    expect(lines.map((l) => [l.state, l.box16, l.box17])).toEqual([
      ["CA", "5000.00", "12.34"],
      ["NY", "10000.00", "20.00"],
    ]);
    expect(lines[1]?.box16).toBe(row.box1Wages);
  });
});

// ---------------------------------------------------------------------------
// W22 — deposit status never moves W-2 figures or the worksheet hash
// ---------------------------------------------------------------------------

describe("W22 CA deposits pending -> deposited -> overdue", () => {
  let id = 0;
  const s = scenario(async (env) => {
    await enterStateId(env, "CA");
    id = await createEmployee(env, "Ana TwentyTwo");
    await insertRuns(env, id, ana());
    for (const q of [1, 2, 3, 4]) {
      await env.t.db.insert(taxDeposits).values({
        jurisdiction: "CA",
        periodStart: `2026-${String((q - 1) * 3 + 1).padStart(2, "0")}-01`,
        periodKind: "quarter",
        amount: money(3 * 1234),
        dueDate: q === 4 ? "2027-01-31" : `2026-${String(q * 3 + 1).padStart(2, "0")}-30`,
        status: "pending",
        createdBy: "test",
      });
    }
  });

  it("figures and worksheet (with state keys) identical across deposit statuses", async () => {
    const snap = async () => {
      const ws = await w3(s.env, 2026);
      return { row: stateView(await rowOf(s.env, 2026, id)), ws, hash: canonicalSha(ws) };
    };
    const pending = await snap();
    await s.env.t.db
      .update(taxDeposits)
      .set({ status: "deposited", depositedOn: "2026-12-15" })
      .where(eq(taxDeposits.jurisdiction, "CA"));
    const deposited = await snap();
    await s.env.t.db
      .update(taxDeposits)
      .set({ status: "overdue", depositedOn: null })
      .where(eq(taxDeposits.jurisdiction, "CA"));
    const overdue = await snap();
    expect(deposited).toEqual(pending);
    expect(overdue).toEqual(pending);
    expect(pending.ws).toEqual(expW3(2026, [{ runs: ana() }]));
  });
});

// ---------------------------------------------------------------------------
// W23 / W24 — W-3 totals across employees (R6, R9, S24-D12)
// ---------------------------------------------------------------------------

describe("W23 W-3 for Ana + Ben", () => {
  const s = scenario(async (env) => {
    await enterStateId(env, "CA");
    await setEin(env, SYNTHETIC_EIN);
    await insertRuns(env, await createEmployee(env, "Ana TwentyThree"), ana());
    await insertRuns(env, await createEmployee(env, "Ben TwentyThree"), ben());
  });

  it("box c 2, box 15 X, 16 150000.00, 17 342.12; CA 222.12 and NY 120.00 reconciled", async () => {
    const ws = await w3(s.env, 2026);
    expect(ws).toEqual(expW3(2026, [{ runs: ana() }, { runs: ben() }]));
    expect([ws.w2FormCount, ws.box15State, ws.box16StateWages, ws.box17StateTax]).toEqual([
      2,
      "X",
      "150000.00",
      "342.12",
    ]);
  });
});

describe("W24 R9 Ana + Ben + Dee, five states", () => {
  const s = scenario(async (env) => {
    await enterStateId(env, "CA");
    await enterStateId(env, "MD", "00000002");
    await enterStateId(env, "NC", "000000003");
    await setEin(env, SYNTHETIC_EIN);
    await insertRuns(env, await createEmployee(env, "Ana TwentyFour"), ana());
    await insertRuns(env, await createEmployee(env, "Ben TwentyFour"), ben());
    await insertRuns(env, await createEmployee(env, "Dee TwentyFour"), dee());
  });

  it("per state box 17 = issued-run withholding: CA 222.12, IL 990.00, MD 100.00, NC 80.00, NY 120.00; box c 4, employeeCount 3", async () => {
    const ws = await w3(s.env, 2026);
    expect(ws).toEqual(expW3(2026, [{ runs: ana() }, { runs: ben() }, { runs: dee() }]));
    expect({
      states: (
        ws.states as { state: string; box17: string; runWithholding: string; reconciled: boolean }[]
      ).map((x) => [x.state, x.box17, x.runWithholding, x.reconciled]),
      c: ws.w2FormCount,
      employees: ws.employeeCount,
      box16: ws.box16StateWages,
      box17: ws.box17StateTax,
    }).toEqual({
      states: [
        ["CA", "222.12", "222.12", true],
        ["IL", "990.00", "990.00", true],
        ["MD", "100.00", "100.00", true],
        ["NC", "80.00", "80.00", true],
        ["NY", "120.00", "120.00", true],
      ],
      c: 4,
      employees: 3,
      box16: "210000.00",
      box17: "1512.12",
    });
  });
});

// ---------------------------------------------------------------------------
// W34 — inputs.locals fail closed (integration variants)
// ---------------------------------------------------------------------------

describe("W34 snapshot inputs.locals variants (clock 2027-01-05)", () => {
  const ids: Record<string, number> = {};
  const variants: [string, unknown][] = [
    ["object", {}],
    ["string", "x"],
    ["jsonNull", null],
    ["malformedElement", [{}]],
    ["wellFormed", [{ code: "NY-NYC", category: "local_resident_withholding", cents: 16556 }]],
  ];
  const s = scenario(
    async (env) => {
      await enterStateId(env, "CA");
      for (const [name, locals] of variants) {
        ids[name] = await createEmployee(env, `Locals ${name}`);
        await insertRun(env, ids[name]!, monthly("2026-01", CA, 1234, { locals }));
      }
      ids.emptyArray = await createEmployee(env, "Locals emptyArray");
      await insertRun(env, ids.emptyArray, monthly("2026-01", CA, 1234, { locals: [] }));
      ids.absent = await createEmployee(env, "Locals absent");
      await insertRun(env, ids.absent, monthly("2026-01", CA, 1234));
    },
    { now: AFTER_YEAR_END },
  );

  it('list 200; {}, "x", null, [{}], [ {NY-NYC} ] -> exactly [{code: local_boxes_pending, severity: block}]; [] and absent -> no issue', async () => {
    const l = await list(s.env, 2026);
    expect(l.status).toBe(200);
    const by = (name: string) => l.json.w2s.find((r) => r.employeeId === ids[name]) as ListRow;
    const got = Object.fromEntries(
      Object.keys(ids).map((name) => [
        name,
        { issues: by(name).issues, blocked: by(name).blocked, localLines: by(name).localLines },
      ]),
    );
    const pending = {
      issues: [{ code: "local_boxes_pending", severity: "block" }],
      blocked: true,
      localLines: [],
    };
    const clean = { issues: [], blocked: false, localLines: [] };
    expect(got).toEqual({
      object: pending,
      string: pending,
      jsonNull: pending,
      malformedElement: pending,
      wellFormed: pending,
      emptyArray: clean,
      absent: clean,
    });
  });

  it("Copy D of a flagged W-2 -> 409 w2_not_ready [local_boxes_pending]", async () => {
    const res = await get(s.env, `/api/admin/annual-forms/w2/${ids.object}/pdf?year=2026`);
    expect({ status: res.statusCode, body: res.json() }).toEqual({
      status: 409,
      body: { error: "w2_not_ready", issues: ["local_boxes_pending"] },
    });
  });
});

// ---------------------------------------------------------------------------
// S1 — state-ids `needed` (brief A3; guards on a58dfc5)
// ---------------------------------------------------------------------------

type Needed = { stateCode: string; taxYear: number; reason: string };
const byCode = (a: Needed, b: Needed) =>
  a.stateCode < b.stateCode ? -1 : a.stateCode > b.stateCode ? 1 : 0;

describe("S1 needed with an EIN (guard)", () => {
  const s = scenario(async (env) => {
    await setEin(env, SYNTHETIC_EIN);
    await insertRuns(env, await createEmployee(env, "Needed NY"), hal(1500));
    await insertRuns(env, await createEmployee(env, "Needed CA"), ana());
    await insertRuns(
      env,
      await createEmployee(env, "Needed NC"),
      months(2026, 1, 12).map((m) => monthly(m, st("NC", "flat", true), 0)),
    );
    await insertRuns(
      env,
      await createEmployee(env, "Needed TX"),
      months(2026, 1, 3).map((m) => monthly(m, TX_NONE, 0)),
    );
  });

  it("NY covered by the EIN default; CA tax_withheld; NC wages_only; TX never", async () => {
    const res = await get(s.env, "/api/admin/company/state-ids");
    expect(res.statusCode).toBe(200);
    expect([...(res.json() as { needed: Needed[] }).needed].sort(byCode)).toEqual([
      { stateCode: "CA", taxYear: 2026, reason: "tax_withheld" },
      { stateCode: "NC", taxYear: 2026, reason: "wages_only" },
    ]);
  });
});

describe("S1 needed without an EIN (guard)", () => {
  const s = scenario(async (env) => {
    await setEin(env, null);
    await insertRuns(env, await createEmployee(env, "Needed NY NoEin"), hal(1500));
  });

  it("NY needed, tax_withheld", async () => {
    const res = await get(s.env, "/api/admin/company/state-ids");
    expect((res.json() as { needed: Needed[] }).needed).toEqual([
      { stateCode: "NY", taxYear: 2026, reason: "tax_withheld" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// P1 — no state ID, mask or EIN in bodies, worksheet or logs
// ---------------------------------------------------------------------------

describe("P1 PII stays out of the figures path", () => {
  const logs: string[] = [];
  let id = 0;
  const s = { env: undefined as unknown as Env };
  beforeAll(async () => {
    s.env = await bootEnv({ logStream: { write: (m: string) => void logs.push(m) } });
    await setEin(s.env, "27-1828182");
    await enterStateId(s.env, "CA", "31415926");
    id = await createEmployee(s.env, "Pii Synthetic");
    await insertRuns(s.env, id, ben());
  });
  afterAll(async () => s.env.close());

  it("list, worksheet, stored filing and logs carry no ID, EIN, mask or idMasked; lines present", async () => {
    const from = logs.length;
    const l = await list(s.env, 2026);
    const ws = await w3(s.env, 2026);
    await sync(s.env);
    const stored = await w2w3Row(s.env, 2026);
    const row = l.json.w2s.find((r) => r.employeeId === id)!;
    expect((row.stateLines as unknown[]).length).toBe(2);
    const texts = {
      list: scrubTimestamps(l.body),
      worksheet: JSON.stringify(ws),
      stored: JSON.stringify(stored?.worksheet),
      logs: logs.slice(from).join("\n"),
    };
    for (const [name, text] of Object.entries(texts)) {
      for (const needle of ["31415926", "271828182", "27-1828182", "••••", "idMasked"]) {
        expect(text.includes(needle), `${name} contains ${needle}`).toBe(false);
      }
    }
  });
});
