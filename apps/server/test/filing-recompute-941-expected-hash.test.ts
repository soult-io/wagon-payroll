/**
 * PAY-25 follow-up — the filed-941 worksheet correction commits only the
 * figures the admin previewed.
 *
 * Contract under test:
 *   POST /api/admin/tax-filings/:id/recompute takes a REQUIRED
 *   expectedWorksheetHash (64 lowercase hex) = the afterHash of the GET
 *   preview. A fresh recompute whose hash differs at commit time is refused
 *   with 409 { error: "worksheet_changed" } and writes nothing (worksheet,
 *   worksheet_hash, fractions_of_cents, audit_events unchanged). A missing or
 *   malformed field is 400 invalid_body. A matching hash commits as before and
 *   the tax_filing.correct_worksheet audit row's `after` carries the new hash.
 *
 * Fixture (synthetic): two fictional W-2 employees paid monthly in Q2 2026
 * (pay dates 2026-04-15, 2026-05-15, 2026-06-15) with grosses chosen so
 * per-run SS and Medicare both round, in opposite directions. Runs are
 * inserted as issued rows with hand-picked entries (same harness as
 * pay-247-941-taxable-wages.test.ts), so every expected figure is hand
 * arithmetic — nothing comes from engine or service code. The filed
 * worksheet is then tampered out-of-band to the pre-PAY-247 back-solved
 * shape (5a/5c col 1 = EE+ER tax withheld / combined rate, line 7 0.00).
 *
 * Sources (tax year 2026):
 *   - Pub 15 (2026) / i941 Rev. 03/2026 line 5a: SS 6.2% each employee and
 *     employer, wage base $184,500; col 2 = col 1 × 0.124.
 *   - i941 line 5c: Medicare 1.45% each, no wage base; col 2 = col 1 × 0.029.
 *   - i941 line 6 = line 3 + line 5e; line 7 fractions of cents (+/-);
 *     line 10 = lines 6–9; line 12 = line 10 − line 11; line 13 deposits;
 *     line 14 = line 12 − line 13 when positive, line 15 when negative;
 *     line 16 de minimis only when line 12 < $2,500.
 *   - App decision D4: line 7 defaults to the full EE+ER rounding delta, so
 *     line 12 equals the entry-derived liability (the deposits).
 *
 * Independent arithmetic (Python decimal, half-up to the cent), per run:
 *   E1 gross 4,321.70 : SS 267.9454 → 267.95 ; Med 62.66465 → 62.66 ;
 *                       fed 312.00 ; net 3,679.09
 *   E2 gross 2,150.10 : SS 133.3062 → 133.31 ; Med 31.17645 → 31.18 ;
 *                       fed 95.00 ; net 1,890.61
 *   month liability = 407.00 + 2 × 401.26 + 2 × 93.84 = 1,397.20
 * Quarter:
 *   line 1   2 ; line 2 = 3 × 6,471.80 = 19,415.40 ; line 3 = 3 × 407.00 = 1,221.00
 *   5a       19,415.40 (each YTD far below 184,500) × 0.124 = 2,407.5096 → 2,407.51
 *            SS entries = 6 × 401.26 = 2,407.56 (+0.05)
 *   5c       19,415.40 × 0.029 = 563.0466 → 563.05
 *            Med entries = 6 × 93.84 = 563.04 (−0.01)
 *   5e       2,970.56 ; line 6 = 1,221.00 + 2,970.56 = 4,191.56
 *   exact    1,221.00 + 2,407.56 + 563.04 = 4,191.60
 *   line 7   4,191.60 − 4,191.56 = 0.04 ; line 10 = line 12 = 4,191.60
 *   line 13  3 × 1,397.20 = 4,191.60 ; line 14 = line 15 = 0.00
 *   line 16  1,397.20 × 3 ; not de minimis (4,191.60 ≥ 2,500)
 *   tampered (pre-PAY-247): 5a = 2,407.56 / 0.124 = 19,415.81 tax 2,407.56 ;
 *            5c = 563.04 / 0.029 = 19,415.17 tax 563.04 ; 5e 2,970.60 ;
 *            line 6 4,191.60 ; line 7 0.00 (computed 0.00).
 *
 * Each scenario gets its own PGlite database. All data is synthetic.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  auditEvents,
  company,
  employees,
  payrollEntries,
  payrollRuns,
  seedDatabase,
  taxDeposits,
  taxFilings,
  type SeedDb,
} from "@payroll/db";
import { syncFilings, worksheetHash, type Worksheet941 } from "../src/filings/service.js";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";

const REASON = "worksheet corrected to the return as filed (synthetic test)";
const MONTHS = [4, 5, 6] as const;

/** The correct Q2 2026 worksheet, written out by hand (see header). */
function expectedQ2(over: Partial<Worksheet941> = {}): Worksheet941 {
  return {
    form: "941",
    year: 2026,
    quarter: 2,
    line1Employees: 2,
    line2Wages: "19415.40",
    line3FederalWithheld: "1221.00",
    line5aTaxableSsWages: "19415.40",
    line5aTax: "2407.51",
    line5cTaxableMedicareWages: "19415.40",
    line5cTax: "563.05",
    line5dAdditionalMedicare: "0.00",
    line5eTotal: "2970.56",
    line6TotalTaxes: "4191.56",
    line7FractionsOfCents: "0.04",
    line7Computed: "0.04",
    line10TotalAfterAdjustments: "4191.60",
    line11ResearchCredit: "0.00",
    line12TotalAfterCredits: "4191.60",
    line13Deposits: "4191.60",
    line14BalanceDue: "0.00",
    line15Overpayment: "0.00",
    line16: { month1: "1397.20", month2: "1397.20", month3: "1397.20", deMinimis: false },
    ...over,
  };
}

/** Per-run entry amounts (EE = ER for SS and Medicare). */
interface RunEntries {
  gross: string;
  fed: string;
  ss: string;
  med: string;
  net: string;
}

/** The pre-PAY-247 back-solved shape the filed row is tampered to. */
function tamperedShape(base: Worksheet941): Worksheet941 {
  return {
    ...base,
    line5aTaxableSsWages: "19415.81",
    line5aTax: "2407.56",
    line5cTaxableMedicareWages: "19415.17",
    line5cTax: "563.04",
    line5eTotal: "2970.60",
    line6TotalTaxes: "4191.60",
    line7FractionsOfCents: "0.00",
    line7Computed: "0.00",
  };
}

interface Fixture {
  t: TestContext;
  admin: Record<string, string>;
  adminUserId: string;
  filingId: number;
  /** The filed hash before tampering (the correct figures). */
  filedHash: string;
  tampered: Worksheet941;
  tamperedHash: string;
}

interface Preview {
  beforeWorksheet: Worksheet941;
  afterWorksheet: Worksheet941;
  beforeHash: string | null;
  afterHash: string;
}

/**
 * Fresh DB → admin → fictional employee → three issued Q2 2026 runs →
 * deposits for `depositedMonths` → 941 Q2 row computed, checked against the
 * hand-written figures, marked filed → frozen worksheet tampered.
 */
async function bootFiledQ2(
  tag: string,
  depositedMonths: readonly number[],
  expectedBeforeFiling: Worksheet941,
): Promise<Fixture> {
  const t = await createTestApp();
  await seedDatabase(t.db as unknown as SeedDb);
  const adminUser = await inviteAndOnboard(t, {
    email: `recompute941-${tag}@test.dev`,
    role: "admin",
  });
  const admin = sessionHeader((await login(t, adminUser.email, TEST_PASSWORD)).sessionCookie);

  const companyRows = await t.db.select({ id: company.id }).from(company).limit(1);
  const people: Array<{ name: string; entries: RunEntries }> = [
    {
      name: "Avery Testworth",
      entries: { gross: "4321.70", fed: "312.00", ss: "267.95", med: "62.66", net: "3679.09" },
    },
    {
      name: "Jordan Samplefield",
      entries: { gross: "2150.10", fed: "95.00", ss: "133.31", med: "31.18", net: "1890.61" },
    },
  ];
  for (const person of people) {
    const emp = await t.db
      .insert(employees)
      .values({ companyId: companyRows[0]!.id, legalName: person.name, hireDate: "2026-01-01" })
      .returning();
    const employeeId = emp[0]!.id;
    for (const m of MONTHS) {
      const mm = String(m).padStart(2, "0");
      const last = new Date(Date.UTC(2026, m, 0)).getUTCDate();
      const run = await t.db
        .insert(payrollRuns)
        .values({
          employeeId,
          periodStart: `2026-${mm}-01`,
          periodEnd: `2026-${mm}-${last}`,
          payDate: `2026-${mm}-15`,
          status: "issued",
          runSnapshot: { synthetic: "recompute-941-expected-hash" },
          createdBy: "test",
          issuedAt: new Date(`2026-${mm}-15T12:00:00Z`),
        })
        .returning();
      const runId = run[0]!.id;
      const e = person.entries;
      await t.db.insert(payrollEntries).values([
        { runId, category: "gross_pay", amount: e.gross },
        { runId, category: "federal_withholding", amount: e.fed },
        { runId, category: "social_security", amount: e.ss },
        { runId, category: "employer_social_security", amount: e.ss },
        { runId, category: "medicare", amount: e.med },
        { runId, category: "employer_medicare", amount: e.med },
        { runId, category: "net_pay", amount: e.net },
      ]);
    }
  }

  // Monthly federal deposits of the month's liability (1,397.20), due the
  // 15th of the following month (2026-05-15 Fri, 06-15 Mon, 07-15 Wed).
  for (const m of MONTHS) {
    const mm = String(m).padStart(2, "0");
    const due = `2026-${String(m + 1).padStart(2, "0")}-15`;
    const deposited = depositedMonths.includes(m);
    await t.db.insert(taxDeposits).values({
      jurisdiction: "federal",
      periodStart: `2026-${mm}-01`,
      amount: "1397.20",
      dueDate: due,
      status: deposited ? "deposited" : "pending",
      ...(deposited ? { depositedOn: due, eftpsConfirmation: `SYNTH-EFTPS-${mm}` } : {}),
      createdBy: "test",
    });
  }

  const inserted = await t.db
    .insert(taxFilings)
    .values({ formType: "941", year: 2026, quarter: 2, dueDate: "2026-07-31", status: "ready" })
    .returning({ id: taxFilings.id });
  const filingId = inserted[0]!.id;

  // Detail read computes the unfiled worksheet; it must already match the
  // hand-written figures (PAY-247 is on main).
  const detail = await t.app.inject({
    method: "GET",
    url: `/api/admin/tax-filings/${filingId}`,
    headers: admin,
  });
  expect(detail.statusCode, detail.body).toBe(200);
  const computed = (await filingRow(t, filingId))!;
  expect(computed.worksheet).toEqual(expectedBeforeFiling);
  const filedHash = worksheetHash(expectedBeforeFiling);
  expect(computed.worksheetHash).toBe(filedHash);

  const filed = await t.app.inject({
    method: "POST",
    url: `/api/admin/tax-filings/${filingId}/file`,
    headers: admin,
    payload: {
      filedOn: "2026-07-20",
      filingMethod: "mail",
      filingReference: "SYNTH-941-Q2",
      expectedWorksheetHash: filedHash,
    },
  });
  expect(filed.statusCode, filed.body).toBe(200);

  // Tamper out-of-band to the pre-PAY-247 shape; hash and line 7 move with it.
  const tampered = tamperedShape(expectedBeforeFiling);
  const tamperedHash = worksheetHash(tampered);
  await t.db
    .update(taxFilings)
    .set({ worksheet: tampered, worksheetHash: tamperedHash, fractionsOfCents: "0.00" })
    .where(eq(taxFilings.id, filingId));

  return {
    t,
    admin,
    adminUserId: adminUser.userId,
    filingId,
    filedHash,
    tampered,
    tamperedHash,
  };
}

async function filingRow(t: TestContext, id: number) {
  return (await t.db.select().from(taxFilings).where(eq(taxFilings.id, id)).limit(1))[0];
}

async function correctionAudits(f: Fixture) {
  return f.t.db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.action, "tax_filing.correct_worksheet"),
        eq(auditEvents.entityId, String(f.filingId)),
      ),
    );
}

async function preview(f: Fixture): Promise<Preview> {
  const res = await f.t.app.inject({
    method: "GET",
    url: `/api/admin/tax-filings/${f.filingId}/recompute`,
    headers: f.admin,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Preview;
}

function commit(f: Fixture, payload: Record<string, unknown>) {
  return f.t.app.inject({
    method: "POST",
    url: `/api/admin/tax-filings/${f.filingId}/recompute`,
    headers: f.admin,
    payload,
  });
}

/** Row and audit trail exactly as left by the tamper — nothing written. */
async function expectUntouched(f: Fixture) {
  const row = (await filingRow(f.t, f.filingId))!;
  expect(row.worksheet).toEqual(f.tampered);
  expect(row.worksheetHash).toBe(f.tamperedHash);
  expect(row.fractionsOfCents).toBe("0.00");
  expect(row.status).toBe("filed");
  expect(await correctionAudits(f)).toHaveLength(0);
}

async function expectFilingMetadataUnchanged(f: Fixture) {
  const row = (await filingRow(f.t, f.filingId))!;
  expect(row.status).toBe("filed");
  expect(row.filedOn).toBe("2026-07-20");
  expect(row.filingMethod).toBe("mail");
  expect(row.filingReference).toBe("SYNTH-941-Q2");
}

// ---------------------------------------------------------------------------
// A + D + E — correction of the back-solved Q2 shape, re-run, frozen after
// ---------------------------------------------------------------------------

describe("941 Q2 2026 correction — preview, commit with the preview hash, re-run", () => {
  let f: Fixture;
  let firstAfterHash: string;

  beforeAll(async () => {
    f = await bootFiledQ2("a", MONTHS, expectedQ2());
  }, 120_000);
  afterAll(async () => {
    await f.t.close();
  });

  it("A1 preview: before = tampered back-solved shape, after = the hand-computed figures", async () => {
    const p = await preview(f);
    expect(p.beforeHash).toBe(f.tamperedHash);
    expect(p.beforeWorksheet).toEqual(f.tampered);
    expect(p.afterWorksheet).toEqual(expectedQ2());
    expect(p.afterHash).toBe(worksheetHash(expectedQ2()));
    expect(p.afterHash).toBe(f.filedHash);
    firstAfterHash = p.afterHash;
    // Read-only.
    await expectUntouched(f);
  });

  it("A2 commit with the preview's afterHash stores the figures, hash, line 7 and one audit row", async () => {
    const res = await commit(f, { reason: REASON, expectedWorksheetHash: firstAfterHash });
    expect(res.statusCode, res.body).toBe(200);

    const row = (await filingRow(f.t, f.filingId))!;
    expect(row.worksheet).toEqual(expectedQ2());
    expect(row.worksheetHash).toBe(worksheetHash(expectedQ2()));
    expect(row.worksheetHash).toBe(worksheetHash(row.worksheet));
    expect(row.fractionsOfCents).toBe("0.04");
    await expectFilingMetadataUnchanged(f);

    const audits = await correctionAudits(f);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorId).toBe(f.adminUserId);
    expect((audits[0]!.before as { worksheetHash: string }).worksheetHash).toBe(f.tamperedHash);
    const after = audits[0]!.after as { worksheetHash: string; reason: string };
    expect(after.worksheetHash).toBe(firstAfterHash);
    expect(after.reason).toBe(REASON);
  });

  it("D re-run: a second preview shows no change; committing it leaves the worksheet identical", async () => {
    const p = await preview(f);
    expect(p.beforeHash).toBe(p.afterHash);
    expect(p.afterWorksheet).toEqual(p.beforeWorksheet);
    expect(p.afterWorksheet).toEqual(expectedQ2());

    const res = await commit(f, {
      reason: "re-verified against the filed return (synthetic test)",
      expectedWorksheetHash: p.afterHash,
    });
    expect(res.statusCode, res.body).toBe(200);
    const row = (await filingRow(f.t, f.filingId))!;
    expect(row.worksheet).toEqual(expectedQ2());
    expect(row.worksheetHash).toBe(worksheetHash(expectedQ2()));
    expect(row.fractionsOfCents).toBe("0.04");
    await expectFilingMetadataUnchanged(f);
    // One audit row per committed correction.
    expect(await correctionAudits(f)).toHaveLength(2);
  });

  it("E after the correction, syncFilings and the detail read never rewrite the filed row", async () => {
    // Move the inputs: a further $10.00 federal deposit for June (shortfall
    // row, seq 1). A fresh recompute now differs (line 13 4,201.60, line 15
    // 10.00) — the preview shows it — but the filed row must stay frozen.
    await f.t.db.insert(taxDeposits).values({
      jurisdiction: "federal",
      periodStart: "2026-06-01",
      amount: "10.00",
      dueDate: "2026-07-15",
      status: "deposited",
      depositedOn: "2026-07-15",
      seq: 1,
      createdBy: "test",
    });
    const p = await preview(f);
    expect(p.afterWorksheet).toEqual(
      expectedQ2({
        line13Deposits: "4201.60",
        line14BalanceDue: "0.00",
        line15Overpayment: "10.00",
      }),
    );
    expect(p.afterHash).not.toBe(p.beforeHash);

    await syncFilings({ db: f.t.db, config: f.t.config }, { today: "2026-10-15" });
    const detail = await f.t.app.inject({
      method: "GET",
      url: `/api/admin/tax-filings/${f.filingId}`,
      headers: f.admin,
    });
    expect(detail.statusCode, detail.body).toBe(200);

    const row = (await filingRow(f.t, f.filingId))!;
    expect(row.worksheet).toEqual(expectedQ2());
    expect(row.worksheetHash).toBe(worksheetHash(expectedQ2()));
    expect(row.fractionsOfCents).toBe("0.04");
    await expectFilingMetadataUnchanged(f);
    expect(await correctionAudits(f)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// B — stale preview: inputs change between preview and commit
// ---------------------------------------------------------------------------

describe("941 Q2 2026 correction — stale preview is refused", () => {
  let f: Fixture;

  // Only the April and May deposits are recorded when the return is filed:
  // line 13 = 2 × 1,397.20 = 2,794.40 ; line 14 = 4,191.60 − 2,794.40 = 1,397.20.
  const beforeJuneDeposit = expectedQ2({ line13Deposits: "2794.40", line14BalanceDue: "1397.20" });

  beforeAll(async () => {
    f = await bootFiledQ2("b", [4, 5], beforeJuneDeposit);
  }, 120_000);
  afterAll(async () => {
    await f.t.close();
  });

  it("B 409 worksheet_changed when the fresh hash differs from the previewed one; nothing written", async () => {
    const stale = await preview(f);
    expect(stale.afterWorksheet).toEqual(beforeJuneDeposit);

    // Between preview and commit the June deposit is recorded as made.
    await f.t.db
      .update(taxDeposits)
      .set({ status: "deposited", depositedOn: "2026-07-15", eftpsConfirmation: "SYNTH-EFTPS-06" })
      .where(
        and(eq(taxDeposits.jurisdiction, "federal"), eq(taxDeposits.periodStart, "2026-06-01")),
      );

    const res = await commit(f, { reason: REASON, expectedWorksheetHash: stale.afterHash });
    expect(res.statusCode, res.body).toBe(409);
    expect((res.json() as { error: string }).error).toBe("worksheet_changed");
    await expectUntouched(f);
    await expectFilingMetadataUnchanged(f);
  });

  it("B a fresh preview then commits the new figures (line 13 = 4,191.60, line 14 = 0.00)", async () => {
    const p = await preview(f);
    expect(p.afterWorksheet).toEqual(expectedQ2());
    const res = await commit(f, { reason: REASON, expectedWorksheetHash: p.afterHash });
    expect(res.statusCode, res.body).toBe(200);
    const row = (await filingRow(f.t, f.filingId))!;
    expect(row.worksheet).toEqual(expectedQ2());
    expect(row.worksheetHash).toBe(worksheetHash(expectedQ2()));
    expect(row.fractionsOfCents).toBe("0.04");
    await expectFilingMetadataUnchanged(f);
    const audits = await correctionAudits(f);
    expect(audits).toHaveLength(1);
    expect((audits[0]!.after as { worksheetHash: string }).worksheetHash).toBe(p.afterHash);
  });
});

// ---------------------------------------------------------------------------
// C — expectedWorksheetHash is required and validated
// ---------------------------------------------------------------------------

describe("941 Q2 2026 correction — expectedWorksheetHash is required", () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await bootFiledQ2("c", MONTHS, expectedQ2());
  }, 120_000);
  afterAll(async () => {
    await f.t.close();
  });

  it("C missing expectedWorksheetHash → 400 invalid_body, nothing written", async () => {
    const res = await commit(f, { reason: REASON });
    expect(res.statusCode, res.body).toBe(400);
    expect((res.json() as { error: string }).error).toBe("invalid_body");
    await expectUntouched(f);
  });

  it("C malformed expectedWorksheetHash → 400 invalid_body, nothing written", async () => {
    const good = (await preview(f)).afterHash;
    for (const bad of [
      "",
      good.toUpperCase(),
      good.slice(1),
      `${good}0`,
      `${good.slice(0, 63)}g`,
      123,
      null,
    ]) {
      const res = await commit(f, { reason: REASON, expectedWorksheetHash: bad });
      expect(res.statusCode, `${String(bad)}: ${res.body}`).toBe(400);
      expect((res.json() as { error: string }).error).toBe("invalid_body");
    }
    await expectUntouched(f);
  });

  it("C the stored (before) hash is not the preview hash → 409, nothing written", async () => {
    const res = await commit(f, { reason: REASON, expectedWorksheetHash: f.tamperedHash });
    expect(res.statusCode, res.body).toBe(409);
    expect((res.json() as { error: string }).error).toBe("worksheet_changed");
    await expectUntouched(f);
  });
});

// ---------------------------------------------------------------------------
// Line 7 admin override on the frozen row — recompute keeps it (current
// behaviour, documented here; computeFreshWorksheet treats
// fractions_of_cents ≠ frozen line7Computed as a human-set line 7).
// ---------------------------------------------------------------------------

describe("941 Q2 2026 correction — frozen line 7 admin override is preserved", () => {
  let f: Fixture;

  // Frozen: back-solved shape with line 7 set by an admin to 0.01 (computed
  // default was 0.00), so line 10 = line 12 = 4,191.60 + 0.01 = 4,191.61 and
  // line 14 = 4,191.61 − 4,191.60 = 0.01.
  // Recomputed with the override kept: line 6 = 4,191.56, line 7 = 0.01,
  // line7Computed = 0.04, line 10 = line 12 = 4,191.57,
  // line 15 = 4,191.60 − 4,191.57 = 0.03, line 14 = 0.00.
  const withOverride = expectedQ2({
    line7FractionsOfCents: "0.01",
    line10TotalAfterAdjustments: "4191.57",
    line12TotalAfterCredits: "4191.57",
    line14BalanceDue: "0.00",
    line15Overpayment: "0.03",
  });

  beforeAll(async () => {
    f = await bootFiledQ2("override", MONTHS, expectedQ2());
    f.tampered = {
      ...f.tampered,
      line7FractionsOfCents: "0.01",
      line7Computed: "0.00",
      line10TotalAfterAdjustments: "4191.61",
      line12TotalAfterCredits: "4191.61",
      line14BalanceDue: "0.01",
      line15Overpayment: "0.00",
    };
    f.tamperedHash = worksheetHash(f.tampered);
    await f.t.db
      .update(taxFilings)
      .set({ worksheet: f.tampered, worksheetHash: f.tamperedHash, fractionsOfCents: "0.01" })
      .where(eq(taxFilings.id, f.filingId));
  }, 120_000);
  afterAll(async () => {
    await f.t.close();
  });

  it("preview and commit keep fractions_of_cents 0.01; line7Computed tracks 0.04", async () => {
    const p = await preview(f);
    expect(p.beforeHash).toBe(f.tamperedHash);
    expect(p.afterWorksheet).toEqual(withOverride);
    expect(p.afterHash).toBe(worksheetHash(withOverride));

    const res = await commit(f, { reason: REASON, expectedWorksheetHash: p.afterHash });
    expect(res.statusCode, res.body).toBe(200);
    const row = (await filingRow(f.t, f.filingId))!;
    expect(row.worksheet).toEqual(withOverride);
    expect(row.worksheetHash).toBe(worksheetHash(withOverride));
    expect(row.fractionsOfCents).toBe("0.01");
    await expectFilingMetadataUnchanged(f);
    expect(await correctionAudits(f)).toHaveLength(1);
  });
});
