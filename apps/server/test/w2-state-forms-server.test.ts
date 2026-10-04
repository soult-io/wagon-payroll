/**
 * Spec 24 (PAY-116) PR-3 "2026 forms" — server-level suite
 * (payroll-calc-auditor, fail-first; the coder may not edit this file).
 * Rebuild @payroll/documents before running. Synthetic data only; runs are
 * direct inserts with literal snapshots (w2-state-harness.ts).
 *
 * Tests: W29, W02-PDF, W30, W05-PDF (server), N1, N2 (server), A2, A3, P1,
 * W15 server part (guard).
 *
 * Fixture values (Spec 24 §11, computed by hand in w2-state-oracle.ts):
 *  - W01 Ana: CA 12 x 5,000.00, SWH 12.34/run -> box 1 60000.00, box 2
 *    6000.00 (FIT 500.00/run), box 3 60000.00, box 4 3720.00 (6.2%), box 5
 *    60000.00, box 6 870.00 (1.45%); CA 60000.00 / 148.08, form 1 row 1.
 *  - W02 Ben: CA Jan–Jun 12.34/run, NY Jul–Dec 20.00/run -> CA 30000.00 /
 *    74.04 row 1; NY 60000.00 (= box 1, TSB-M-02(3)I) / 120.00 row 2; NY ID
 *    = the EIN digits (ein_default).
 *  - W23 = Ana + Ben: W-3 box c 2, box 15 "X" (no ID), 16 150000.00, 17
 *    342.12; boxes 1–6: 120000.00 / 12000.00 / 120000.00 / 7440.00 /
 *    120000.00 / 1740.00.
 *  - W05 Dee: IL Jan–Apr 247.50/run, MD May–Aug 25.00, NC Sep–Dec 20.00 ->
 *    IL 20000.00/990.00 f1 r1, MD 20000.00/100.00 f1 r2, NC 20000.00/80.00
 *    f2 r1; formCount 2; W-3 (Dee alone) box c 2, box 15 X, 16 60000.00,
 *    17 1170.00.
 *
 * Contract assumed beyond the documents suite (w2-state-forms-docs.test.ts):
 *  - w2InputFor(deps, employeeId, 2026, opts) returns W2Input with
 *    stateLines (stateId decrypted at render time; IL/NY EIN default = the
 *    9 EIN digits), localLines [] and formCount.
 *  - w3InputFor(deps, 2026, opts) returns W3Input with w2FormCount and
 *    box15State / box15StateId (the decrypted ID when exactly one state,
 *    N1; null for "X") / box16StateWages / box17StateTax, box18LocalWages
 *    and box19LocalTax null.
 *  - A state ID whose ciphertext fails to decrypt (GCM) is a block issue
 *    with code "state_id_unreadable" (new W2IssueCode), severity "block":
 *    admin PDF routes and W-3 -> 409 { error: "w2_not_ready", issues:
 *    ["state_id_unreadable"] }; employee route -> 409 { error:
 *    "w2_not_ready" }; never a 500; no furnishing row written.
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as documents from "@payroll/documents";
import { employees, w2Furnishings } from "@payroll/db";
import {
  isMyW2Ready,
  sendW2AvailableNotices,
  w2InputFor,
  w3InputFor,
} from "../src/filings/annual.js";
import { encryptField } from "../src/crypto/field-encryption.js";
import type { Db } from "../src/db.js";
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
import {
  ALL_COPIES,
  expectedFilled,
  federalPlacements,
  filledFields,
  rectMismatches,
  rowPlacements,
  textOf,
  W2_2026_ROWS,
  W2_2026_TOP,
  W3_2026,
  W3_CHECKED,
  w2Path,
} from "./w2-state-forms-oracle.js";

// biome-ignore lint/suspicious/noExplicitAny: PR-3 shapes are not in today's types
type Any = any;
const docs = documents as unknown as Record<string, unknown>;
function prepareW2Forms(input: Any, copies: string[]): Promise<Any[]> {
  const fn = docs.prepareW2Forms as ((i: Any, c: string[]) => Promise<Any[]>) | undefined;
  if (!fn) throw new Error('@payroll/documents has no export "prepareW2Forms" (PR-3 contract)');
  return fn(input, copies);
}
const prepareW3 = documents.prepareW3 as unknown as (input: Any) => Promise<Any>;

const CA = st("CA");
const NY = st("NY");
const IL = st("IL");
const MD = st("MD");
const NC = st("NC");

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

const BOXES_1Y = {
  box1Wages: "60000.00",
  box2FederalWithheld: "6000.00",
  box3SsWages: "60000.00",
  box4SsTax: "3720.00",
  box5MedicareWages: "60000.00",
  box6MedicareTax: "870.00",
};
/** EIN "00-0000001" as the form prints it, and its 9 digits (IL/NY default ID). */
const EIN_PRINTED = "00-0000001";
const EIN_DIGITS = "000000001";
const COMPANY = "Example Corp";

const deps = (env: Env) => ({ db: env.t.db, config: env.t.config }) as never;

function aToF(employeeId: number, first: string, last: string, ssn: string | null = null) {
  return {
    ssn,
    ein: EIN_PRINTED,
    employerNameAddress: COMPANY,
    controlNumber: String(employeeId),
    employeeFirstName: first,
    employeeLastName: last,
    employeeAddress: null,
  };
}

/** Exact W-3 field set: boxes c, e, f, 1–6, checkboxes, and the box 15–19 values given. */
function w3Expected(
  c: string,
  boxes: string[],
  b15: Partial<Record<keyof typeof W3_2026, string>>,
): Record<string, string | true> {
  const keys = [
    "box1Wages",
    "box2FederalWithheld",
    "box3SsWages",
    "box4SsTax",
    "box5MedicareWages",
    "box6MedicareTax",
  ] as const;
  const out: Record<string, string | true> = {
    [W3_2026.w2Count.name]: c,
    [W3_2026.ein.name]: EIN_PRINTED,
    [W3_2026.employerName.name]: COMPANY,
  };
  keys.forEach((k, i) => {
    out[W3_2026[k].name] = boxes[i] as string;
  });
  for (const [k, v] of Object.entries(b15)) out[W3_2026[k as keyof typeof W3_2026].name] = v;
  for (const n of W3_CHECKED) out[n] = true;
  return out;
}

const W3_15_19 = [
  "box15State",
  "box15StateId",
  "box16StateWages",
  "box17StateTax",
  "box18LocalWages",
  "box19LocalTax",
] as const;

function pick<T extends Record<string, unknown>>(o: T, keys: readonly string[]) {
  return Object.fromEntries(keys.map((k) => [k, o[k]]));
}

// ======================================================= ENV-A: W01 + W02 (W23)

describe("ENV-A Ana (W01) + Ben (W02) + Carl (2024) + Eli (2025 IL) — clock 2027-01-04", () => {
  let env: Env;
  let anaId = 0;
  let benId = 0;
  let carlId = 0;
  let eliId = 0;
  let anaSession: Record<string, string> = {};

  beforeAll(async () => {
    env = await bootEnv({ now: "2027-01-04T12:00:00Z" });
    await setEin(env, SYNTHETIC_EIN);
    await enterStateId(env, "CA", "00000001");
    const a = await consentedEmployee(env, "Ana Formtest");
    anaId = a.employeeId;
    anaSession = a.session;
    await insertRuns(env, anaId, ana());
    benId = await createEmployee(env, "Ben Formtest");
    await insertRuns(env, benId, ben());
    // A2: a year with no bundled W-2/W-3 (2024).
    await federalConfig(env, 2024);
    carlId = await createEmployee(env, "Carl Formtest");
    await insertRuns(env, carlId, [monthly("2024-03", null, undefined)]);
    // W15: a 2025 employee with IL work-state runs and IL tax.
    eliId = await createEmployee(env, "Eli Formtest");
    await insertRuns(
      env,
      eliId,
      months(2025, 1, 12).map((m) => monthly(m, IL, 24750)),
    );
  }, 180_000);
  afterAll(async () => env.close());

  it("W29 W2Input: stateLines [CA 00000001 60000.00 148.08 f1 r1], localLines [], formCount 1", async () => {
    const input: Any = await w2InputFor(deps(env), anaId, 2026, { requireBundledForm: true });
    expect({
      stateLines: input.stateLines,
      localLines: input.localLines,
      formCount: input.formCount,
      boxes: pick(input, Object.keys(BOXES_1Y)),
    }).toEqual({
      stateLines: [
        { state: "CA", stateId: "00000001", box16: "60000.00", box17: "148.08", form: 1, row: 1 },
      ],
      localLines: [],
      formCount: 1,
      boxes: BOXES_1Y,
    });
  });

  it("W29 pre-flatten Copy B/C/2/D Top: f2_31 CA, f2_32 00000001, f2_35 60000.00, f2_37 148.08; row 2 and f2_39–f2_44 empty; boxes 1–6 in _Top; every _Bottom empty", async () => {
    const input = await w2InputFor(deps(env), anaId, 2026, { requireBundledForm: true });
    const forms = await prepareW2Forms(input, ALL_COPIES);
    expect(forms.length).toBe(1);
    expect(filledFields(forms[0])).toEqual(
      expectedFilled(ALL_COPIES, {
        ...aToF(anaId, "Ana", "Formtest"),
        boxes: BOXES_1Y,
        states: [{ state: "CA", stateId: "00000001", box16: "60000.00", box17: "148.08" }],
        locals: [],
      }),
    );
  });

  it("W29 rects: rows 1–2 of boxes 15–20 and boxes a–f / 1–6, by full name, ±1 pt of S24-D6 on pages 3/5/7/9", async () => {
    const input = await w2InputFor(deps(env), anaId, 2026, { requireBundledForm: true });
    const [doc] = await prepareW2Forms(input, ALL_COPIES);
    const want = ALL_COPIES.flatMap((c) => [...rowPlacements(c), ...federalPlacements(c)]);
    expect(rectMismatches(doc, want)).toEqual([]);
  });

  it("W02-PDF: Ben CA row 1 (00000001, 30000.00, 74.04), NY row 2 (EIN digits, 60000.00, 120.00); NY f2_36 === f2_09", async () => {
    const input: Any = await w2InputFor(deps(env), benId, 2026, { requireBundledForm: true });
    const [doc] = await prepareW2Forms(input, ["CopyB"]);
    expect({
      stateLines: input.stateLines,
      filled: filledFields(doc),
      nyEqualsBox1:
        textOf(doc, w2Path("CopyB", W2_2026_ROWS.box16[1].sub)) ===
        textOf(doc, w2Path("CopyB", W2_2026_TOP.box1Wages.sub)),
    }).toEqual({
      stateLines: [
        { state: "CA", stateId: "00000001", box16: "30000.00", box17: "74.04", form: 1, row: 1 },
        { state: "NY", stateId: EIN_DIGITS, box16: "60000.00", box17: "120.00", form: 1, row: 2 },
      ],
      filled: expectedFilled(["CopyB"], {
        ...aToF(benId, "Ben", "Formtest"),
        boxes: BOXES_1Y,
        states: [
          { state: "CA", stateId: "00000001", box16: "30000.00", box17: "74.04" },
          { state: "NY", stateId: EIN_DIGITS, box16: "60000.00", box17: "120.00" },
        ],
        locals: [],
      }),
      nyEqualsBox1: true,
    });
  });

  it("W30 W3Input (W23): w2FormCount 2, box15State X, box15StateId null, 150000.00 / 342.12, boxes 18–19 null", async () => {
    const w3: Any = await w3InputFor(deps(env), 2026, { requireBundledForm: true });
    expect(pick(w3, ["employeeCount", "w2FormCount", ...W3_15_19])).toEqual({
      employeeCount: 2,
      w2FormCount: 2,
      box15State: "X",
      box15StateId: null,
      box16StateWages: "150000.00",
      box17StateTax: "342.12",
      box18LocalWages: null,
      box19LocalTax: null,
    });
  });

  it("W30 pre-flatten: f1_02 2; f1_23 X, f1_24 empty, f1_25 150000.00, f1_26 342.12; f1_27/f1_28 empty; e–g and 1–6 as today; rects ±1 pt", async () => {
    const doc = await prepareW3(await w3InputFor(deps(env), 2026, { requireBundledForm: true }));
    expect(filledFields(doc)).toEqual(
      w3Expected("2", ["120000.00", "12000.00", "120000.00", "7440.00", "120000.00", "1740.00"], {
        box15State: "X",
        box16StateWages: "150000.00",
        box17StateTax: "342.12",
      }),
    );
    const placements = W3_15_19.map((k) => ({
      name: W3_2026[k].name,
      rect: W3_2026[k].rect,
      page: 1,
    }));
    expect(rectMismatches(doc, placements)).toEqual([]);
  });

  it("A2: 2026 admin Copy D, print packet, W-3 and the employee's W-2 -> 200 application/pdf, flattened", async () => {
    const urls = [
      `/api/admin/annual-forms/w2/${anaId}/pdf?year=2026`,
      `/api/admin/annual-forms/w2/${anaId}/print-packet?year=2026`,
      "/api/admin/annual-forms/w3/pdf?year=2026",
    ];
    const out: unknown[] = [];
    for (const url of urls) {
      const res = await get(env, url);
      out.push({
        url,
        status: res.statusCode,
        type: res.headers["content-type"],
        structure:
          res.statusCode === 200 ? await documents.pdfStructure(res.rawPayload) : res.json(),
      });
    }
    const mine = await get(env, "/api/my/w2/2026/pdf", anaSession);
    out.push({
      url: "my",
      status: mine.statusCode,
      type: mine.headers["content-type"],
      structure:
        mine.statusCode === 200 ? await documents.pdfStructure(mine.rawPayload) : mine.json(),
    });
    expect(out).toEqual([
      {
        url: urls[0],
        status: 200,
        type: "application/pdf",
        structure: { pageCount: 1, fieldCount: 0 },
      },
      {
        url: urls[1],
        status: 200,
        type: "application/pdf",
        structure: { pageCount: 6, fieldCount: 0 },
      },
      {
        url: urls[2],
        status: 200,
        type: "application/pdf",
        structure: { pageCount: 1, fieldCount: 0 },
      },
      {
        url: "my",
        status: 200,
        type: "application/pdf",
        structure: { pageCount: 6, fieldCount: 0 },
      },
    ]);
  });

  it("A2 guard: 2024 (no bundled form) still -> 409 { error: form_not_available, year: 2024 } on Copy D, print packet, W-3", async () => {
    const urls = [
      `/api/admin/annual-forms/w2/${carlId}/pdf?year=2024`,
      `/api/admin/annual-forms/w2/${carlId}/print-packet?year=2024`,
      "/api/admin/annual-forms/w3/pdf?year=2024",
    ];
    const out: unknown[] = [];
    for (const url of urls) {
      const res = await get(env, url);
      out.push({ url, status: res.statusCode, body: res.json() });
    }
    expect(out).toEqual(
      urls.map((url) => ({ url, status: 409, body: { error: "form_not_available", year: 2024 } })),
    );
  });

  it("W15 server part (guard): a 2025 W-2 with IL work-state runs has no state lines and fills only 2025 boxes a–f / 1–6", async () => {
    const input: Any = await w2InputFor(deps(env), eliId, 2025, { requireBundledForm: true });
    const doc = await documents.prepareW2EmployeePacket(input);
    const filled = filledFields(doc);
    const names = Object.keys(filled);
    expect({
      stateLines: input.stateLines ?? [],
      localLines: input.localLines ?? [],
      formCount: input.formCount ?? 1,
      onlyCopiesBC2: names.every((n) =>
        /^topmostSubform\[0\]\.Copy(B|C|2)\[0\]\.Col_(Left|Right)\[0\]\./.test(n),
      ),
      // 2025 box 15–17 fields (Boxes15_ReadOrder / Box16 / Box17) stay empty.
      stateFields: names.filter((n) => /Box(es)?1[5-7]_ReadOrder/.test(n)),
      box1: filled["topmostSubform[0].CopyB[0].Col_Right[0].Box1_ReadOrder[0].f2_09[0]"],
    }).toEqual({
      stateLines: [],
      localLines: [],
      formCount: 1,
      onlyCopiesBC2: true,
      stateFields: [],
      box1: "60000.00",
    });
  });
});

// ============================================================ ENV-D: W05 (Dee)

describe("ENV-D Dee (W05, three states) — clock 2027-01-04", () => {
  let env: Env;
  let deeId = 0;

  beforeAll(async () => {
    env = await bootEnv({ now: "2027-01-04T12:00:00Z" });
    await setEin(env, SYNTHETIC_EIN);
    await enterStateId(env, "MD", "00000003");
    await enterStateId(env, "NC", "00000004");
    deeId = await createEmployee(env, "Dee Formtest");
    await insertRuns(env, deeId, dee());
  }, 180_000);
  afterAll(async () => env.close());

  it("W05 W2Input: IL (EIN digits) f1 r1, MD f1 r2, NC f2 r1; formCount 2", async () => {
    const input: Any = await w2InputFor(deps(env), deeId, 2026, { requireBundledForm: true });
    expect({
      stateLines: input.stateLines,
      localLines: input.localLines,
      formCount: input.formCount,
    }).toEqual({
      stateLines: [
        { state: "IL", stateId: EIN_DIGITS, box16: "20000.00", box17: "990.00", form: 1, row: 1 },
        { state: "MD", stateId: "00000003", box16: "20000.00", box17: "100.00", form: 1, row: 2 },
        { state: "NC", stateId: "00000004", box16: "20000.00", box17: "80.00", form: 2, row: 1 },
      ],
      localLines: [],
      formCount: 2,
    });
  });

  it("W05 + N2 pre-flatten: form 1 = a–f, 1–6, IL/MD; form 2 = a–f + NC row 1, boxes 1–14 empty", async () => {
    const input = await w2InputFor(deps(env), deeId, 2026, { requireBundledForm: true });
    const forms = await prepareW2Forms(input, ALL_COPIES);
    expect({ count: forms.length, f1: filledFields(forms[0]), f2: filledFields(forms[1]) }).toEqual(
      {
        count: 2,
        f1: expectedFilled(ALL_COPIES, {
          ...aToF(deeId, "Dee", "Formtest"),
          boxes: BOXES_1Y,
          states: [
            { state: "IL", stateId: EIN_DIGITS, box16: "20000.00", box17: "990.00" },
            { state: "MD", stateId: "00000003", box16: "20000.00", box17: "100.00" },
          ],
          locals: [],
        }),
        f2: expectedFilled(ALL_COPIES, {
          ...aToF(deeId, "Dee", "Formtest"),
          boxes: null,
          states: [{ state: "NC", stateId: "00000004", box16: "20000.00", box17: "80.00" }],
          locals: [],
        }),
      },
    );
  });

  it("W05 routes: print packet 9 pages, Copy D 2 pages, flattened field count 0", async () => {
    const packet = await get(env, `/api/admin/annual-forms/w2/${deeId}/print-packet?year=2026`);
    const copyD = await get(env, `/api/admin/annual-forms/w2/${deeId}/pdf?year=2026`);
    expect({
      packet:
        packet.statusCode === 200 ? await documents.pdfStructure(packet.rawPayload) : packet.json(),
      copyD:
        copyD.statusCode === 200 ? await documents.pdfStructure(copyD.rawPayload) : copyD.json(),
    }).toEqual({
      packet: { pageCount: 9, fieldCount: 0 },
      copyD: { pageCount: 2, fieldCount: 0 },
    });
  });

  it("W05 W-3 (Dee alone): box c 2 (employeeCount 1), box 15 X / no ID, 16 60000.00, 17 1170.00", async () => {
    const w3: Any = await w3InputFor(deps(env), 2026, { requireBundledForm: true });
    const doc = await prepareW3(w3);
    expect({
      input: pick(w3, ["employeeCount", "w2FormCount", ...W3_15_19]),
      filled: filledFields(doc),
    }).toEqual({
      input: {
        employeeCount: 1,
        w2FormCount: 2,
        box15State: "X",
        box15StateId: null,
        box16StateWages: "60000.00",
        box17StateTax: "1170.00",
        box18LocalWages: null,
        box19LocalTax: null,
      },
      filled: w3Expected(
        "2",
        ["60000.00", "6000.00", "60000.00", "3720.00", "60000.00", "870.00"],
        {
          box15State: "X",
          box16StateWages: "60000.00",
          box17StateTax: "1170.00",
        },
      ),
    });
  });
});

// ============================================================ ENV-N1: W01 alone

describe("N1 W-3 for one state prints the state AND the employer state ID (iw2w3 2026 p.26) — W01 alone", () => {
  let env: Env;
  beforeAll(async () => {
    env = await bootEnv({ now: "2027-01-04T12:00:00Z" });
    await setEin(env, SYNTHETIC_EIN);
    await enterStateId(env, "CA", "00000001");
    await insertRuns(env, await createEmployee(env, "Ana Formtest"), ana());
  }, 180_000);
  afterAll(async () => env.close());

  it("W3Input box15State CA, box15StateId 00000001; pre-flatten f1_02 1, f1_23 CA, f1_24 00000001, f1_25 60000.00, f1_26 148.08", async () => {
    const w3: Any = await w3InputFor(deps(env), 2026, { requireBundledForm: true });
    const doc = await prepareW3(w3);
    expect({
      input: pick(w3, ["employeeCount", "w2FormCount", ...W3_15_19]),
      filled: filledFields(doc),
    }).toEqual({
      input: {
        employeeCount: 1,
        w2FormCount: 1,
        box15State: "CA",
        box15StateId: "00000001",
        box16StateWages: "60000.00",
        box17StateTax: "148.08",
        box18LocalWages: null,
        box19LocalTax: null,
      },
      filled: w3Expected(
        "1",
        ["60000.00", "6000.00", "60000.00", "3720.00", "60000.00", "870.00"],
        {
          box15State: "CA",
          box15StateId: "00000001",
          box16StateWages: "60000.00",
          box17StateTax: "148.08",
        },
      ),
    });
  });
});

// ================================================================ A3 notices

describe("A3 sendW2AvailableNotices on 2027-01-01 (the template is no longer the reason to hold)", () => {
  let env: Env;
  let anaId = 0;
  beforeAll(async () => {
    env = await bootEnv({ now: "2027-01-01T09:00:00Z" });
    await setEin(env, SYNTHETIC_EIN);
    await enterStateId(env, "CA", "00000001");
    anaId = (await consentedEmployee(env, "Ana Formtest")).employeeId;
    await insertRuns(env, anaId, ana());
  }, 180_000);
  afterAll(async () => env.close());

  it("unblocked 2026: isMyW2Ready true; first tick sends 1, second tick sends 0", async () => {
    const ready = await isMyW2Ready(env.t.db as unknown as Db, anaId, 2026);
    const first = await sendW2AvailableNotices(deps(env), { today: "2027-01-01" });
    const second = await sendW2AvailableNotices(deps(env), { today: "2027-01-01" });
    expect({ ready, first, second }).toEqual({
      ready: true,
      first: { sent: 1 },
      second: { sent: 0 },
    });
  });
});

describe("A3 blocked 2026 W-2 (W10: no CA ID) sends nothing; after the ID is entered the next tick sends once", () => {
  let env: Env;
  let anaId = 0;
  beforeAll(async () => {
    env = await bootEnv({ now: "2027-01-01T09:00:00Z" });
    await setEin(env, SYNTHETIC_EIN);
    anaId = (await consentedEmployee(env, "Ana Formtest")).employeeId;
    await insertRuns(env, anaId, ana());
  }, 180_000);
  afterAll(async () => env.close());

  it("blocked: sent 0, isMyW2Ready false; CA ID entered: sent 1, isMyW2Ready true", async () => {
    const blocked = {
      notice: await sendW2AvailableNotices(deps(env), { today: "2027-01-01" }),
      ready: await isMyW2Ready(env.t.db as unknown as Db, anaId, 2026),
    };
    await enterStateId(env, "CA", "00000001");
    const fixed = {
      notice: await sendW2AvailableNotices(deps(env), { today: "2027-01-01" }),
      ready: await isMyW2Ready(env.t.db as unknown as Db, anaId, 2026),
    };
    expect({ blocked, fixed }).toEqual({
      blocked: { notice: { sent: 0 }, ready: false },
      fixed: { notice: { sent: 1 }, ready: true },
    });
  });
});

// ======================================================================= P1

describe("P1 no state ID, SSN or amount in logs or errors; a GCM failure of the state ID is a block, never a 500", () => {
  const STATE_ID = "86429753";
  const SSN = "900000001";
  const lines: string[] = [];
  let env: Env;
  let anaId = 0;
  let session: Record<string, string> = {};
  const SECRETS = [STATE_ID, SSN, "900-00-0001", "60000.00", "148.08", "6000.00", "3720.00"];
  const urls = () => [
    `/api/admin/annual-forms/w2/${anaId}/pdf?year=2026`,
    `/api/admin/annual-forms/w2/${anaId}/print-packet?year=2026`,
    "/api/admin/annual-forms/w3/pdf?year=2026",
  ];

  beforeAll(async () => {
    env = await bootEnv({
      now: "2027-01-04T12:00:00Z",
      logStream: { write: (m: string) => void lines.push(m) },
    });
    await setEin(env, SYNTHETIC_EIN);
    await enterStateId(env, "CA", STATE_ID);
    const a = await consentedEmployee(env, "Ana Formtest");
    anaId = a.employeeId;
    session = a.session;
    await env.t.db
      .update(employees)
      .set({ taxId: encryptField(SSN, env.t.config.encryptionKey) })
      .where(eq(employees.id, anaId));
    await insertRuns(env, anaId, ana());
  }, 180_000);
  afterAll(async () => env.close());

  it("render path: the 2026 PDFs carry the ID and SSN (W29 f2_01/f2_32), and the captured logs carry none of them", async () => {
    const before = lines.length;
    const statuses: number[] = [];
    for (const url of urls()) statuses.push((await get(env, url)).statusCode);
    statuses.push((await get(env, "/api/my/w2/2026/pdf", session)).statusCode);
    const input = await w2InputFor(deps(env), anaId, 2026, { requireBundledForm: true });
    const [doc] = await prepareW2Forms(input, ["CopyB"]);
    const captured = lines.slice(before).join("");
    expect({
      statuses,
      ssnOnForm: textOf(doc, w2Path("CopyB", W2_2026_TOP.ssn.sub)),
      idOnForm: textOf(doc, w2Path("CopyB", W2_2026_ROWS.stateId[0].sub)),
      logged: captured.includes("/api/admin/annual-forms"),
      leaks: SECRETS.filter((s) => captured.includes(s)),
    }).toEqual({
      statuses: [200, 200, 200, 200],
      ssnOnForm: "900-00-0001",
      idOnForm: STATE_ID,
      logged: true,
      leaks: [],
    });
  });

  it("GCM failure (one ciphertext character flipped): admin PDFs and W-3 -> 409 [state_id_unreadable]; employee -> bare 409; list 200; no 500; no furnishing row; no leak", async () => {
    const col = await env.t.pglite.query<{ state_id: string }>(
      "SELECT state_id FROM company_state_ids WHERE state_code = 'CA'",
    );
    const value = col.rows[0]?.state_id ?? "";
    const i = "enc:v1:".length + 10;
    const flipped = value.slice(0, i) + (value[i] === "A" ? "B" : "A") + value.slice(i + 1);
    await env.t.pglite.query("UPDATE company_state_ids SET state_id = $1 WHERE state_code = 'CA'", [
      flipped,
    ]);
    const furnishedBefore = (
      await env.t.db.select().from(w2Furnishings).where(eq(w2Furnishings.employeeId, anaId))
    ).length;
    const before = lines.length;
    const out: unknown[] = [];
    const bodies: string[] = [];
    for (const url of urls()) {
      const res = await get(env, url);
      bodies.push(res.body);
      out.push({ url, status: res.statusCode, body: res.json() });
    }
    const mine = await get(env, "/api/my/w2/2026/pdf", session);
    bodies.push(mine.body);
    out.push({ url: "my", status: mine.statusCode, body: mine.json() });
    const l = await list(env, 2026);
    const furnishedAfter = (
      await env.t.db.select().from(w2Furnishings).where(eq(w2Furnishings.employeeId, anaId))
    ).length;
    const captured = lines.slice(before).join("");
    const body = { error: "w2_not_ready", issues: ["state_id_unreadable"] };
    expect({
      out,
      list: l.status,
      furnished: furnishedAfter - furnishedBefore,
      bodyLeaks: SECRETS.filter((s) => bodies.some((b) => b.includes(s))),
      logLeaks: SECRETS.filter((s) => captured.includes(s)),
    }).toEqual({
      out: [
        ...urls().map((url) => ({ url, status: 409, body })),
        { url: "my", status: 409, body: { error: "w2_not_ready" } },
      ],
      list: 200,
      furnished: 0,
      bodyLeaks: [],
      logLeaks: [],
    });
  });
});
