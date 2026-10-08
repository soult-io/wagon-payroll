/**
 * PAY-223 PR-2 — T3 (box 15 on an earlier version: the entered ID as
 * posted, OD-3 A; the EIN default prints the current EIN, D-2), the D-1
 * identity rule (federal SME PR-1 note: an earlier version is NOT a
 * byte-exact copy once the SSN or name changed — identity renders from
 * current data and is not version-defining), T7 (read-time integrity check:
 * 409 and a fixed log line with no figure, hash, ciphertext or id) and T8
 * (current path unchanged for 2025 v1 and 2026 v2; the version render of the
 * current version equals the current render; a v1 frozen row with a state
 * line is refused, S24-D5). payroll-calc-auditor, fail-first against
 * 9cb9534; the coder may not edit this file. Synthetic data only.
 *
 * Hand values (integer cents): caRuns A as in pay-223-versions.test.ts
 * ("60000.00" / "6000.00" / "60000.00" / "3720.00" / "60000.00" / "870.00";
 * CA "60000.00" / "148.08"). IL runs: 12 x 500,000, IL withheld 2,000 each
 * -> IL "60000.00" / "240.00"; + a late IL run (gross 100,000, FIT 10,000,
 * SS 6,200, Medicare 1,450, IL 500) -> "61000.00" / "6100.00" / "61000.00"
 * / "3782.00" / "61000.00" / "884.50"; IL "61000.00" / "245.00". The IL box
 * 15 ID is the EIN default: the EIN's 9 digits. T7's hand-made version F =
 * A with box 1 + 100 cents -> box 1 "60001.00" (only box 1 differs, so the
 * render provably reads the frozen figures, not the current ones).
 * 2025 (v1): 12 x $5,000.00, no state -> boxes as A, no lines.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { employees } from "@payroll/db";
import { encryptField } from "../src/crypto/field-encryption.js";
import {
  bodyError,
  boot223,
  CA_ID,
  CA_ID_NEW,
  captureConsole,
  caRuns,
  copyDOf,
  deps,
  type Emp,
  emp,
  type Env,
  expCopyD,
  expFrozen,
  expHash,
  expPacket,
  type Frozen,
  furnRows,
  furnishModule,
  HEX64,
  IL,
  type Ids,
  identityOf,
  insertFrozen,
  insertRawFurnishing,
  lateRun,
  markedOf,
  markedPages,
  moveTo,
  myPdf,
  myVersions,
  pageStrings,
  rehash,
  relogin,
  setCaId,
  sha256,
  versionPdf,
  yearNotice,
} from "./pay-223-harness.js";
import { insertRun, setEin } from "./w2-state-harness.js";
import { type FxRun, monthly, months } from "./w2-state-oracle.js";

type E = Emp & { runs: FxRun[] };

const JAN_4 = "2027-01-04T16:00:00Z";
const ilRuns = (): FxRun[] => months(2026, 1, 12).map((m) => monthly(m, IL, 2000));
const ilLate = (): FxRun => ({ ...lateRun(), state: IL });

async function view(res: { statusCode: number; rawPayload: Buffer; body: string }) {
  return res.statusCode === 200
    ? { pages: await pageStrings(res.rawPayload), marked: await markedPages(res.rawPayload) }
    : { status: res.statusCode, body: bodyError(res) };
}

// ---------------------------------------------------------------- T3 + D-1

describe("T3: box 15 on each version — the entered ID as posted (OD-3 A); the EIN default = the current EIN (D-2); identity from current data (D-1)", () => {
  let env: Env;
  let ct1 = "";
  let ct2 = "";
  const e: Record<string, E> = {};
  beforeAll(async () => {
    env = await boot223(JAN_4);
    ct1 = await setCaId(env, CA_ID);
    e.s = await emp(env, "Sela", caRuns(), { login: true, consent: true });
    e.i = await emp(env, "Ines", ilRuns(), { login: true, consent: true });
    await yearNotice(env, "2027-01-04");
    // The admin re-enters the CA ID; Ines gets a late IL run.
    ct2 = await setCaId(env, CA_ID_NEW);
    await insertRun(env as never, e.i.id, ilLate());
    await moveTo(env, "2027-01-20T16:00:00Z");
    const { reconcileW2Furnishings } = await furnishModule();
    await reconcileW2Furnishings(deps(env), { today: "2027-01-20" });
    for (const v of Object.values(e)) await relogin(env, v);
  }, 300_000);
  afterAll(async () => env.close());

  const idsOld = (): Ids => ({ CA: { source: "entered", ct: ct1 } });
  const idsNew = (): Ids => ({ CA: { source: "entered", ct: ct2 } });
  const IL_IDS: Ids = { IL: { source: "ein_default" } };

  it("oracle self-check: Sela's re-entered ID alone made a corrected posting (same amounts, new ciphertext digest); Ines's late run made hers", async () => {
    const rows = async (x: E) =>
      (await furnRows(env, x.id, 2026)).map((r) => [r.method, r.corrected, r.boxes_hash]);
    expect({ s: await rows(e.s!), i: await rows(e.i!) }).toEqual({
      s: [
        ["portal_notice", false, expHash(e.s!.id, caRuns(), 2026, idsOld())],
        ["portal_notice", true, expHash(e.s!.id, caRuns(), 2026, idsNew())],
      ],
      i: [
        ["portal_notice", false, expHash(e.i!.id, ilRuns(), 2026, IL_IDS)],
        ["portal_notice", true, expHash(e.i!.id, [...ilRuns(), ilLate()], 2026, IL_IDS)],
      ],
    });
  });

  it("entered ID: version 1 prints the ID as posted (77665544), unmarked; version 2 and the main download print the re-entered ID (77665546), marked", async () => {
    const who = identityOf(e.s!.id, "Sela");
    const A = expFrozen(caRuns(), 2026, idsOld());
    const B = expFrozen(caRuns(), 2026, idsNew());
    const v1 = await versionPdf(env, e.s!, 2026, 1);
    const v2 = await versionPdf(env, e.s!, 2026, 2);
    await relogin(env, e.s!);
    const main = await myPdf(env, e.s!, 2026);
    expect({
      list: await myVersions(env, e.s!),
      v1: await view(v1),
      v2: await view(v2),
      main: await view(main),
    }).toEqual({
      list: [
        {
          version: 1,
          kind: "original",
          postedOn: "2027-01-04",
          current: false,
          downloadable: true,
        },
        {
          version: 2,
          kind: "corrected",
          postedOn: "2027-01-20",
          current: true,
          downloadable: true,
        },
      ],
      v1: { pages: expPacket(who, A, { CA: CA_ID }), marked: [] },
      v2: { pages: expPacket(who, B, { CA: CA_ID_NEW }), marked: markedOf(1) },
      main: { pages: expPacket(who, B, { CA: CA_ID_NEW }), marked: markedOf(1) },
    });
  });

  it("EIN default (IL): both versions print the EIN digits in box 15; after the EIN changes, both print the new EIN in box b and box 15 and no new version appears", async () => {
    const A = expFrozen(ilRuns(), 2026, IL_IDS);
    const B = expFrozen([...ilRuns(), ilLate()], 2026, IL_IDS);
    const who = identityOf(e.i!.id, "Ines");
    const before = {
      v1: await view(await versionPdf(env, e.i!, 2026, 1)),
      v2: await view(await versionPdf(env, e.i!, 2026, 2)),
    };
    await setEin(env as never, "00-0000002");
    try {
      const newWho = { ...who, ein: "00-0000002" };
      const after = {
        list: await myVersions(env, e.i!),
        v1: await view(await versionPdf(env, e.i!, 2026, 1)),
        v2: await view(await versionPdf(env, e.i!, 2026, 2)),
      };
      expect({ before, after }).toEqual({
        before: {
          v1: { pages: expPacket(who, A, { IL: "000000001" }), marked: [] },
          v2: { pages: expPacket(who, B, { IL: "000000001" }), marked: markedOf(1) },
        },
        after: {
          list: [
            {
              version: 1,
              kind: "original",
              postedOn: "2027-01-04",
              current: false,
              downloadable: true,
            },
            {
              version: 2,
              kind: "corrected",
              postedOn: "2027-01-20",
              current: true,
              downloadable: true,
            },
          ],
          v1: { pages: expPacket(newWho, A, { IL: "000000002" }), marked: [] },
          v2: { pages: expPacket(newWho, B, { IL: "000000002" }), marked: markedOf(1) },
        },
      });
    } finally {
      await setEin(env as never, "00-0000001");
    }
  });

  it("D-1 (federal SME PR-1 note): after the legal name and SSN are corrected, version 1 renders the corrected identity with the posted amounts and ID — it is not presented as a byte-exact copy; no new version appears", async () => {
    await env.t.db
      .update(employees)
      .set({
        legalName: "Selma Synthetic",
        taxId: encryptField("900000018", env.t.config.encryptionKey),
      })
      .where(eq(employees.id, e.s!.id));
    const who = { ...identityOf(e.s!.id, "Selma"), ssn: "900-00-0018" };
    const A = expFrozen(caRuns(), 2026, idsOld());
    const v1 = await versionPdf(env, e.s!, 2026, 1);
    const list = (await myVersions(env, e.s!)) as Record<string, unknown>[] | undefined;
    expect({
      v1: await view(v1),
      versions: list?.map((v) => [v.version, v.kind, v.current]),
      keys: list?.map((v) => Object.keys(v).sort()),
    }).toEqual({
      v1: { pages: expPacket(who, A, { CA: CA_ID }), marked: [] },
      versions: [
        [1, "original", false],
        [2, "corrected", true],
      ],
      keys: [
        ["current", "downloadable", "kind", "postedOn", "version"],
        ["current", "downloadable", "kind", "postedOn", "version"],
      ],
    });
  });
});

// ---------------------------------------------------------------- T7

describe("T7 integrity on read: frozen figures that do not re-hash, or a box 15 ciphertext whose digest differs (or is missing), give 409 and one fixed log line", () => {
  let env: Env;
  const logs: string[] = [];
  let ct = "";
  const e: Record<string, E> = {};
  /** A with box 1 + 100 cents: a figures set only the frozen row can supply. */
  let F: Frozen;
  beforeAll(async () => {
    env = await boot223(JAN_4, { logs });
    ct = await setCaId(env, CA_ID);
    const ids: Ids = { CA: { source: "entered", ct } };
    for (const label of ["Mira", "Juno", "Kira", "Lena"]) {
      e[label] = await emp(env, label, caRuns(), { login: true, consent: true });
    }
    await yearNotice(env, "2027-01-04");
    const A = expFrozen(caRuns(), 2026, ids);
    F = { ...A, box1Cents: A.box1Cents + 100 };
    const other = encryptField(CA_ID_NEW, env.t.config.encryptionKey);
    const plan: Record<
      string,
      { hash: (id: number) => string; box15: Record<string, string> | null }
    > = {
      // Consistent: renders 200 from the frozen figures.
      Mira: { hash: (id) => rehash(id, 2026, 2, F), box15: { CA: ct } },
      // Figures that do not re-hash to the key.
      Juno: { hash: () => sha256("pay-223 tampered synthetic figures"), box15: { CA: ct } },
      // A ciphertext whose digest is not the figures' stateIdDigest.
      Kira: { hash: (id) => rehash(id, 2026, 2, F), box15: { CA: other } },
      // The entered line's ciphertext missing.
      Lena: { hash: (id) => rehash(id, 2026, 2, F), box15: null },
    };
    for (const [label, p] of Object.entries(plan)) {
      const id = e[label]!.id;
      const hash = p.hash(id);
      await insertRawFurnishing(env, {
        employeeId: id,
        taxYear: 2026,
        hash,
        method: "portal_notice",
        corrected: true,
        at: "2027-01-05T16:00:00Z",
      });
      await insertFrozen(env, {
        employeeId: id,
        taxYear: 2026,
        version: 2,
        hash,
        figures: F,
        box15: p.box15,
      });
    }
  }, 300_000);
  afterAll(async () => env.close());

  it("positive control: a consistent hand-frozen version renders its own figures (box 1 60001.00), marked — employee and Copy D", async () => {
    const who = identityOf(e.Mira!.id, "Mira");
    const v2 = await versionPdf(env, e.Mira!, 2026, 2);
    const d2 = await copyDOf(env, e.Mira!.id, 2026, 2);
    expect({ v2: await view(v2), d2: await view(d2) }).toEqual({
      v2: { pages: expPacket(who, F, { CA: CA_ID }), marked: markedOf(1) },
      d2: { pages: expCopyD(who, F, { CA: CA_ID }), marked: [] },
    });
  });

  it("tampered figures, a foreign ciphertext and a missing ciphertext: employee 409 w2_not_available, admin Copy D 409 w2_version_unreadable; nothing recorded", async () => {
    const out: Record<string, unknown> = {};
    for (const label of ["Juno", "Kira", "Lena"]) {
      const x = e[label]!;
      const before = (await furnRows(env, x.id)).length;
      const v = await versionPdf(env, x, 2026, 2);
      const d = await copyDOf(env, x.id, 2026, 2);
      out[label] = {
        employee: [v.statusCode, bodyError(v)],
        admin: [d.statusCode, bodyError(d)],
        rows: (await furnRows(env, x.id)).length - before,
      };
    }
    const exp = {
      employee: [409, { error: "w2_not_available" }],
      admin: [409, { error: "w2_version_unreadable" }],
      rows: 0,
    };
    expect(out).toEqual({ Juno: exp, Kira: exp, Lena: exp });
  });

  it("the log: the fixed message (+ error class only) once per refused read; no hash, ciphertext, amount, stack or employee key in the line", async () => {
    const cap = captureConsole();
    const start = logs.length;
    try {
      for (const label of ["Juno", "Kira", "Lena"]) {
        await versionPdf(env, e[label]!, 2026, 2);
        await copyDOf(env, e[label]!.id, 2026, 2);
      }
    } finally {
      cap.restore();
    }
    const lines = [...logs.slice(start), ...cap.lines].filter((l) =>
      l.includes("frozen figures failed the integrity check"),
    );
    const msgOf = (l: string) => {
      try {
        return String((JSON.parse(l) as { msg?: unknown }).msg ?? l);
      } catch {
        return l.trim();
      }
    };
    const FIXED =
      /^\[filings\] W-2 version: frozen figures failed the integrity check(?: \([A-Za-z]+\))?$/;
    expect({
      atLeastOnePerRead: lines.length >= 6,
      messages: [...new Set(lines.map((l) => FIXED.test(msgOf(l))))],
      leaks: lines.filter(
        (l) =>
          HEX64.test(l) ||
          l.includes("enc:v1:") ||
          /\d+\.\d{2}\b/.test(l) ||
          l.includes('"stack"') ||
          /employee/i.test(l) ||
          l.includes(CA_ID),
      ),
    }).toEqual({ atLeastOnePerRead: true, messages: [true], leaks: [] });
  });
});

// ---------------------------------------------------------------- T8

describe("T8 (2026, v2): the current render is unchanged and the version render of the current version equals it — single and multi-form", () => {
  let env: Env;
  let ids: Ids = {};
  const e: Record<string, E> = {};
  beforeAll(async () => {
    env = await boot223(JAN_4);
    const ct = await setCaId(env, CA_ID);
    ids = { CA: { source: "entered", ct }, IL: { source: "ein_default" }, NC: { source: null } };
    const { multiRuns } = await import("./pay-223-harness.js");
    e.p = await emp(env, "Pia", caRuns(), { login: true, consent: true });
    e.m = await emp(env, "Moe", multiRuns(), { login: true, consent: true });
    await yearNotice(env, "2027-01-04");
  }, 300_000);
  afterAll(async () => env.close());

  it("employee packet and Copy D: current = oracle; version 1 = current, page for page, with the same (absent) marks", async () => {
    const { multiRuns } = await import("./pay-223-harness.js");
    const out: Record<string, unknown> = {};
    const exp: Record<string, unknown> = {};
    for (const [k, label, runs] of [
      ["p", "Pia", caRuns()],
      ["m", "Moe", multiRuns()],
    ] as const) {
      const x = e[k]!;
      const who = identityOf(x.id, label);
      const f = expFrozen(runs, 2026, ids);
      const idt = { CA: CA_ID, IL: "000000001", NC: null };
      const cur = await view(await myPdf(env, x, 2026));
      const ver = await view(await versionPdf(env, x, 2026, 1));
      const dCur = await view(await copyDOf(env, x.id, 2026, null));
      const dVer = await view(await copyDOf(env, x.id, 2026, 1));
      out[k] = { cur, ver, dCur, dVer };
      exp[k] = {
        cur: { pages: expPacket(who, f, idt), marked: [] },
        ver: { pages: expPacket(who, f, idt), marked: [] },
        dCur: { pages: expCopyD(who, f, idt), marked: [] },
        dVer: { pages: expCopyD(who, f, idt), marked: [] },
      };
    }
    expect(out).toEqual(exp);
  });
});

describe("T8 (2025, v1): the 2025 render is unchanged (S24-D5), the version render equals it, and a v1 frozen row with a state line is refused", () => {
  let env: Env;
  const e: Record<string, E> = {};
  const runs25 = () => caRuns(2025).map((r) => ({ ...r, state: null, swhCents: undefined }));
  let bad: Frozen;
  beforeAll(async () => {
    env = await boot223("2026-01-05T16:00:00Z");
    e.o = await emp(env, "Otto", runs25(), { login: true, consent: true });
    e.u = await emp(env, "Ugo", runs25(), { login: true, consent: true });
    await yearNotice(env, "2026-01-05");
    // Defensive: a v1 frozen row carrying a state line (only a bug or a
    // tamper could write it; v1 hashes boxes 1-6 only, so it re-hashes).
    const A = expFrozen(runs25(), 2025);
    bad = {
      ...A,
      box1Cents: A.box1Cents + 100,
      stateLines: [
        {
          state: "CA",
          form: 1,
          row: 1,
          box16Cents: A.box1Cents,
          box17Cents: 14_808,
          stateIdSource: null,
          stateIdDigest: null,
        },
      ],
    };
    const hash = rehash(e.u.id, 2025, 1, bad);
    await insertRawFurnishing(env, {
      employeeId: e.u.id,
      taxYear: 2025,
      hash,
      method: "portal_notice",
      corrected: true,
      at: "2026-01-06T16:00:00Z",
      version: 1,
    });
    await insertFrozen(env, {
      employeeId: e.u.id,
      taxYear: 2025,
      version: 1,
      hash,
      figures: bad,
      box15: null,
    });
  }, 300_000);
  afterAll(async () => env.close());

  it("2025 employee packet and Copy D: current = oracle (boxes a-f, 1-6 only); version 1 = current", async () => {
    const x = e.o!;
    const who = identityOf(x.id, "Otto");
    const f = expFrozen(runs25(), 2025);
    expect({
      cur: await view(await myPdf(env, x, 2025)),
      ver: await view(await versionPdf(env, x, 2025, 1)),
      dCur: await view(await copyDOf(env, x.id, 2025, null)),
      dVer: await view(await copyDOf(env, x.id, 2025, 1)),
    }).toEqual({
      cur: { pages: expPacket(who, f, {}), marked: [] },
      ver: { pages: expPacket(who, f, {}), marked: [] },
      dCur: { pages: expCopyD(who, f, {}), marked: [] },
      dVer: { pages: expCopyD(who, f, {}), marked: [] },
    });
  });

  it("a v1 frozen row with a state line: listed, but the employee gets 409 w2_not_available and the admin 409 w2_version_unreadable (never a 500, never a 2025 PDF with state boxes)", async () => {
    const v = await versionPdf(env, e.u!, 2025, 2);
    const d = await copyDOf(env, e.u!.id, 2025, 2);
    expect({
      listed: ((await myVersions(env, e.u!, 2025)) as unknown[] | undefined)?.length,
      employee: [v.statusCode, bodyError(v)],
      admin: [d.statusCode, bodyError(d)],
    }).toEqual({
      listed: 2,
      employee: [409, { error: "w2_not_available" }],
      admin: [409, { error: "w2_version_unreadable" }],
    });
    void bad;
  });
});
