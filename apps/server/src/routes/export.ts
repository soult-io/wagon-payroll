/**
 * Read-only payroll export (D10 activation) — requested by the Accountant
 * agent (2026-07-30) for downstream compliance: 941 federal deposits, the
 * quarterly/annual tax package (941/940/W-2/W-3), compliance tracking.
 *
 * Contract (docs/export-api.md):
 * - READ-ONLY. Never mutates payroll data; the D4 sole-writer rule is
 *   untouched (this endpoint only SELECTs, plus its own audit_events row).
 * - Auth: scoped service credential — `Authorization: Bearer <token>` against
 *   $SECRETS_DIR/export-token. Never interactive TOTP, so unattended agents
 *   can call it. No token configured → 503 (explicit deployment decision).
 * - ISSUED runs only — draft/void figures are not authoritative.
 * - Deterministic: figures come from stored payroll_entries (the validated,
 *   frozen truth), ordered canonically; identical request → identical bytes.
 * - No surplus PII: the payload carries company legal_name + ein (required
 *   for filings) but never employee tax_id/bank_details/address.
 * - Range filter keys on pay_date — deposits and filings are keyed on when
 *   wages were PAID, not the period worked.
 * - Every successful call writes an audit_events row (who/when/how many runs).
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, asc, eq, gte, inArray, lte, ne, type SQL, sql } from "drizzle-orm";
import {
  auditEvents,
  company,
  payrollEntries,
  payrollRuns,
  taxAdjustments,
  taxDeposits,
  taxFilings,
} from "@payroll/db";
import { parseCents } from "@payroll/shared";
import type { AppConfig } from "../config.js";
import { decryptField } from "../crypto/field-encryption.js";
import { ContractorServiceError, yearEndSummary } from "../contractors/service.js";
import type { Db } from "../db.js";

export const EXPORT_ACTOR = "service:export";

/** Canonical category order — the 9 payroll_entries categories, fixed for byte-determinism. */
const ENTRY_CATEGORIES = [
  "gross_pay",
  "federal_withholding",
  "social_security",
  "medicare",
  "state_withholding",
  "net_pay",
  "employer_social_security",
  "employer_medicare",
  "employer_futa",
] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const YEAR_RE = /^\d{4}$/;
/** 'federal' or a 2-letter state code — the tax_deposits.jurisdiction values. */
const JURISDICTION_RE = /^(federal|[A-Z]{2})$/;
const FILING_FORMS = ["941", "940", "w2_w3"] as const;

interface ExportDeps {
  db: Db;
  config: AppConfig;
}

interface ExportParams {
  from?: string | undefined;
  to?: string | undefined;
  format: "json" | "csv";
}

interface RunPayload {
  employeeId: number;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  status: string;
  snapshotHash: string | null;
  /**
   * PAY-13: the work state that produced `state_withholding` (frozen in the
   * run snapshot, template ≥1.2.0). null for pre-1.2.0 snapshots and runs on
   * the legacy flat stateWithholdingRate path — a nonzero state_withholding
   * with a null jurisdiction means "legacy run, jurisdiction not recorded".
   */
  stateJurisdiction: string | null;
  entries: Record<string, string | null>;
}

/** Constant-time token comparison (hashed first so length never leaks). */
function tokenOk(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function badRequest(reply: FastifyReply, error: string, message: string) {
  return reply.code(400).send({ error, message });
}

/**
 * Validate the query string. Returns null after sending the error reply —
 * callers just `if (!params) return;`.
 */
function parseParams(req: FastifyRequest, reply: FastifyReply): ExportParams | null {
  const q = req.query as { from?: string; to?: string; status?: string; format?: string };
  if ((q.status ?? "issued") !== "issued") {
    badRequest(
      reply,
      "unsupported_status",
      "only status=issued is exportable — draft/void figures are not authoritative",
    );
    return null;
  }
  if (q.from && !DATE_RE.test(q.from)) {
    badRequest(reply, "invalid_date", "from must be YYYY-MM-DD");
    return null;
  }
  if (q.to && !DATE_RE.test(q.to)) {
    badRequest(reply, "invalid_date", "to must be YYYY-MM-DD");
    return null;
  }
  if (q.from && q.to && q.from > q.to) {
    badRequest(reply, "invalid_range", "from must be on or before to");
    return null;
  }
  const format = q.format ?? "json";
  if (format !== "json" && format !== "csv") {
    badRequest(reply, "unsupported_format", "format must be json or csv");
    return null;
  }
  return { from: q.from, to: q.to, format };
}

interface DepositQuery {
  from?: string | undefined;
  to?: string | undefined;
  jurisdiction?: string | undefined;
  includeSuperseded: boolean;
}

/** Validate the tax-deposits query. Returns null after sending the 400 reply. */
function parseDepositQuery(req: FastifyRequest, reply: FastifyReply): DepositQuery | null {
  const q = req.query as {
    from?: string;
    to?: string;
    jurisdiction?: string;
    includeSuperseded?: string;
  };
  const fail = (error: string, message: string) => {
    badRequest(reply, error, message);
    return null;
  };
  if (q.from !== undefined && !DATE_RE.test(q.from)) {
    return fail("invalid_date", "from must be YYYY-MM-DD");
  }
  if (q.to !== undefined && !DATE_RE.test(q.to)) {
    return fail("invalid_date", "to must be YYYY-MM-DD");
  }
  if (q.from && q.to && q.from > q.to) {
    return fail("invalid_range", "from must be on or before to");
  }
  if (q.jurisdiction !== undefined && !JURISDICTION_RE.test(q.jurisdiction)) {
    return fail("invalid_jurisdiction", "jurisdiction must be federal or a 2-letter state code");
  }
  const flag = q.includeSuperseded ?? "false";
  if (flag !== "true" && flag !== "false") {
    return fail("invalid_include_superseded", "includeSuperseded must be true or false");
  }
  return {
    from: q.from,
    to: q.to,
    jurisdiction: q.jurisdiction,
    includeSuperseded: flag === "true",
  };
}

/** The work state frozen in a run snapshot (template ≥1.2.0), else null. */
function extractStateJurisdiction(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const state = (snapshot as { inputs?: { state?: { workState?: unknown } } }).inputs?.state;
  return typeof state?.workState === "string" && state.workState ? state.workState : null;
}

/** Issued runs in range (pay_date-keyed) with their stored entries, canonical order. */
async function fetchRuns(db: Db, params: ExportParams): Promise<RunPayload[]> {
  const conditions = [eq(payrollRuns.status, "issued")];
  if (params.from) conditions.push(gte(payrollRuns.payDate, params.from));
  if (params.to) conditions.push(lte(payrollRuns.payDate, params.to));

  const runs = await db
    .select({
      id: payrollRuns.id,
      employeeId: payrollRuns.employeeId,
      periodStart: payrollRuns.periodStart,
      periodEnd: payrollRuns.periodEnd,
      payDate: payrollRuns.payDate,
      status: payrollRuns.status,
      snapshotHash: payrollRuns.snapshotHash,
      runSnapshot: payrollRuns.runSnapshot,
    })
    .from(payrollRuns)
    .where(and(...conditions))
    .orderBy(asc(payrollRuns.payDate), asc(payrollRuns.employeeId));

  const entryRows =
    runs.length === 0
      ? []
      : await db
          .select({
            runId: payrollEntries.runId,
            category: payrollEntries.category,
            amount: payrollEntries.amount,
          })
          .from(payrollEntries)
          .where(
            inArray(
              payrollEntries.runId,
              runs.map((r) => r.id),
            ),
          );
  const byRun = new Map<number, Map<string, string>>();
  for (const e of entryRows) {
    let m = byRun.get(e.runId);
    if (!m) {
      m = new Map();
      byRun.set(e.runId, m);
    }
    m.set(e.category, e.amount);
  }

  return runs.map((r) => ({
    employeeId: r.employeeId,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    payDate: r.payDate,
    status: r.status,
    snapshotHash: r.snapshotHash,
    stateJurisdiction: extractStateJurisdiction(r.runSnapshot),
    // Canonical order; null (not "0.00") if a category is missing — a
    // corrupted run must be visible, never silently zeroed.
    entries: Object.fromEntries(ENTRY_CATEGORIES.map((c) => [c, byRun.get(r.id)?.get(c) ?? null])),
  }));
}

/**
 * PAY-13: state_withholding totals per jurisdiction (integer-cent sums,
 * sorted by jurisdiction for byte-determinism). Jurisdictions come from the
 * frozen run snapshots, so the totals are reproducible from stored data
 * alone; runs whose snapshot predates template 1.2.0 contribute nothing.
 */
function stateWithholdingByJurisdiction(
  runs: RunPayload[],
): { jurisdiction: string; runCount: number; stateWithholding: string }[] {
  const cents = new Map<string, { total: number; runCount: number }>();
  for (const run of runs) {
    if (!run.stateJurisdiction) continue;
    const amount = run.entries.state_withholding;
    const amountCents =
      amount === null || amount === undefined ? 0 : Math.round(Number(amount) * 100);
    const acc = cents.get(run.stateJurisdiction) ?? { total: 0, runCount: 0 };
    acc.total += amountCents;
    acc.runCount += 1;
    cents.set(run.stateJurisdiction, acc);
  }
  return [...cents.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([jurisdiction, acc]) => ({
      jurisdiction,
      runCount: acc.runCount,
      stateWithholding: (acc.total / 100).toFixed(2),
    }));
}

function toCsv(runs: RunPayload[]): string {
  // state_jurisdiction is appended LAST so existing column-position consumers
  // of the original 15-column layout are unaffected.
  const header = [
    "employee_id",
    "period_start",
    "period_end",
    "pay_date",
    "status",
    "snapshot_hash",
    ...ENTRY_CATEGORIES,
    "state_jurisdiction",
  ].join(",");
  const lines = runs.map((r) =>
    [
      r.employeeId,
      r.periodStart,
      r.periodEnd,
      r.payDate,
      r.status,
      r.snapshotHash,
      ...ENTRY_CATEGORIES.map((c) => r.entries[c] ?? ""),
      r.stateJurisdiction ?? "",
    ].join(","),
  );
  return `${[header, ...lines].join("\n")}\n`;
}

/** Byte-order comparison (collation-independent, so output bytes never depend on the DB locale). */
function cmp(a: string | number, b: string | number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Last day of the deposit period: the month of period_start, or the quarter
 * that starts there ('quarter' rows start in Jan/Apr/Jul/Oct — DB check).
 */
function periodEndOf(periodStart: string, periodKind: string): string {
  const [y = 0, m = 0] = periodStart.split("-").map((p) => Number.parseInt(p, 10));
  const months = periodKind === "quarter" ? 3 : 1;
  // Day 0 of the month after the period = the period's last day.
  return new Date(Date.UTC(y, m - 1 + months, 0)).toISOString().slice(0, 10);
}

/**
 * PAY-197: tax_deposits rows for the export, canonical order (period_start,
 * jurisdiction, period_kind, id). Amounts are integer cents converted from
 * NUMERIC(12,2) text by string arithmetic (parseCents), never a float.
 */
async function fetchDeposits(
  db: Db,
  q: { from?: string | undefined; to?: string | undefined; jurisdiction?: string | undefined },
  includeSuperseded: boolean,
) {
  const conditions: SQL[] = [];
  if (q.from) conditions.push(gte(taxDeposits.periodStart, q.from));
  if (q.to) conditions.push(lte(taxDeposits.periodStart, q.to));
  if (q.jurisdiction) conditions.push(eq(taxDeposits.jurisdiction, q.jurisdiction));
  if (!includeSuperseded) conditions.push(ne(taxDeposits.status, "superseded"));

  const rows = await db
    .select({
      id: taxDeposits.id,
      jurisdiction: taxDeposits.jurisdiction,
      periodKind: taxDeposits.periodKind,
      periodStart: taxDeposits.periodStart,
      amount: taxDeposits.amount,
      dueDate: taxDeposits.dueDate,
      status: taxDeposits.status,
      depositedOn: taxDeposits.depositedOn,
      eftpsConfirmation: taxDeposits.eftpsConfirmation,
      supersededAt: taxDeposits.supersededAt,
    })
    .from(taxDeposits)
    .where(and(...conditions));

  rows.sort(
    (a, b) =>
      cmp(a.periodStart, b.periodStart) ||
      cmp(a.jurisdiction, b.jurisdiction) ||
      cmp(a.periodKind, b.periodKind) ||
      cmp(a.id, b.id),
  );

  return rows.map((r) => ({
    jurisdiction: r.jurisdiction,
    // Federal deposits are Form 941 (FUTA/940 deposits are not tracked in-app);
    // state withholding deposits have no federal form.
    form: r.jurisdiction === "federal" ? "941" : null,
    periodKind: r.periodKind,
    periodStart: r.periodStart,
    periodEnd: periodEndOf(r.periodStart, r.periodKind),
    amountCents: parseCents(r.amount),
    dueDate: r.dueDate,
    status: r.status,
    depositedOn: r.depositedOn,
    // Verbatim text: acknowledgment numbers keep their leading zeros.
    confirmation: r.eftpsConfirmation,
    supersededAt: r.supersededAt ? r.supersededAt.toISOString() : null,
  }));
}

/**
 * PAY-197: tax_filings rows for a year with their linked tax_adjustments.
 * The frozen worksheet is passed through verbatim (worksheetHash covers its
 * decimal strings). Annual forms are stored with quarter 0 and exported as
 * quarter null. Adjustment `note` (free text) is never exported.
 */
async function fetchFilings(db: Db, year: number, form: string | undefined) {
  const conditions: SQL[] = [eq(taxFilings.year, year)];
  if (form) conditions.push(eq(taxFilings.formType, form));

  const filings = await db
    .select({
      id: taxFilings.id,
      formType: taxFilings.formType,
      year: taxFilings.year,
      quarter: taxFilings.quarter,
      dueDate: taxFilings.dueDate,
      status: taxFilings.status,
      filedOn: taxFilings.filedOn,
      filingMethod: taxFilings.filingMethod,
      filingReference: taxFilings.filingReference,
      worksheetHash: taxFilings.worksheetHash,
      worksheet: taxFilings.worksheet,
    })
    .from(taxFilings)
    .where(and(...conditions));
  filings.sort((a, b) => cmp(a.formType, b.formType) || cmp(a.quarter, b.quarter));

  const adjustments =
    filings.length === 0
      ? []
      : await db
          .select({
            filingId: taxAdjustments.filingId,
            kind: taxAdjustments.kind,
            noticeDate: taxAdjustments.noticeDate,
            amountDue: taxAdjustments.amountDue,
            abatedAmount: taxAdjustments.abatedAmount,
            amountPaid: taxAdjustments.amountPaid,
            paidOn: taxAdjustments.paidOn,
            eftpsConfirmation: taxAdjustments.eftpsConfirmation,
          })
          .from(taxAdjustments)
          .where(
            inArray(
              taxAdjustments.filingId,
              filings.map((f) => f.id),
            ),
          )
          .orderBy(sql`${taxAdjustments.noticeDate} asc nulls last`, asc(taxAdjustments.id));

  return filings.map((f) => ({
    form: f.formType,
    year: f.year,
    quarter: f.quarter === 0 ? null : f.quarter,
    dueDate: f.dueDate,
    status: f.status,
    filedOn: f.filedOn,
    filingMethod: f.filingMethod,
    filingReference: f.filingReference,
    worksheetHash: f.worksheetHash,
    worksheet: f.worksheet ?? null,
    adjustments: adjustments
      .filter((a) => a.filingId === f.id)
      .map((a) => ({
        kind: a.kind,
        noticeDate: a.noticeDate,
        amountDueCents: parseCents(a.amountDue),
        abatedAmountCents: parseCents(a.abatedAmount),
        amountPaidCents: parseCents(a.amountPaid),
        paidOn: a.paidOn,
        confirmation: a.eftpsConfirmation,
      })),
  }));
}

/**
 * Bearer-token gate. Returns true when authorized; otherwise the error reply
 * is already sent (503 when unconfigured, 401 on missing/wrong token).
 */
async function authorize(
  req: FastifyRequest,
  reply: FastifyReply,
  config: AppConfig,
): Promise<boolean> {
  if (!config.exportToken) {
    await reply.code(503).send({
      error: "export_disabled",
      message: "no export-token in SECRETS_DIR — the export endpoint is disabled",
    });
    return false;
  }
  const header = req.headers.authorization;
  const provided = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!provided || !tokenOk(provided, config.exportToken)) {
    await reply.code(401).send({ error: "unauthorized" });
    return false;
  }
  return true;
}

export function registerExportRoutes(app: FastifyInstance, deps: ExportDeps): void {
  const { db, config } = deps;

  app.get("/api/export/payroll-runs", async (req, reply) => {
    if (!(await authorize(req, reply, config))) return;

    const params = parseParams(req, reply);
    if (!params) return;

    const runsPayload = await fetchRuns(db, params);

    const [companyRow] = await db.select().from(company).limit(1);
    const companyPayload = {
      legalName: companyRow?.legalName ?? null,
      // Filings need the full EIN (decrypted at read); absent until configured.
      ein: companyRow?.ein ? decryptField(companyRow.ein, config.encryptionKey) : null,
    };

    // Auditable access trail — one row per successful call.
    await db.insert(auditEvents).values({
      actorId: EXPORT_ACTOR,
      action: "export.payroll_runs",
      entity: "export",
      entityId: `${params.from ?? ""}..${params.to ?? ""}`,
      after: { format: params.format, status: "issued", runCount: runsPayload.length },
    });

    if (params.format === "csv") {
      // Company header is JSON-only — CSV consumers key on one known company.
      return reply.header("content-type", "text/csv; charset=utf-8").send(toCsv(runsPayload));
    }

    return {
      company: companyPayload,
      status: "issued",
      range: { from: params.from ?? null, to: params.to ?? null },
      // PAY-13: per-jurisdiction state withholding (state quarterly filings).
      stateWithholding: { byJurisdiction: stateWithholdingByJurisdiction(runsPayload) },
      runs: runsPayload,
    };
  });

  /**
   * Spec 10 §5 (D18): contractor-payments export for the Accountant agent's
   * January 1099/945 package. Per contractor: classification + form status +
   * payments + reportable total (1099-K carve-out applied) + dated threshold
   * + form-required flag. NO TIN, no bank details, no personal address —
   * same PII doctrine as the payroll export. Read-only + audited.
   */
  app.get("/api/export/contractor-payments", async (req, reply) => {
    if (!(await authorize(req, reply, config))) return;

    const q = req.query as { year?: string };
    if (!q.year || !/^\d{4}$/.test(q.year)) {
      return badRequest(reply, "invalid_year", "year is required as YYYY");
    }
    const year = Number(q.year);

    let summary: Awaited<ReturnType<typeof yearEndSummary>>;
    try {
      summary = await yearEndSummary(db, year);
    } catch (err) {
      if (err instanceof ContractorServiceError && err.code === "no_threshold_config") {
        return reply.code(409).send({ error: err.code, message: err.message });
      }
      throw err;
    }

    const [companyRow] = await db.select().from(company).limit(1);
    const companyPayload = {
      legalName: companyRow?.legalName ?? null,
      ein: companyRow?.ein ? decryptField(companyRow.ein, config.encryptionKey) : null,
    };

    // Auditable access trail — one row per successful call.
    await db.insert(auditEvents).values({
      actorId: EXPORT_ACTOR,
      action: "export.contractor_payments",
      entity: "export",
      entityId: String(year),
      after: { year, contractorCount: summary.rows.length },
    });

    return {
      company: companyPayload,
      year,
      threshold: summary.threshold,
      contractors: summary.rows.map((row) => ({
        employeeId: row.employeeId,
        legalName: row.legalName,
        taxStatus: row.taxStatus,
        entityType: row.entityType,
        form: {
          taxForm: row.taxForm,
          collected: row.formCollectedAt !== null,
          formExpiresAt: row.formExpiresAt,
          expired: row.formExpired,
        },
        review1042: row.review1042,
        payments: row.payments.map((p) => ({
          payDate: p.payDate,
          amount: p.amount,
          method: p.method,
          backupWithheld: p.backupWithheld,
          reference: p.reference,
        })),
        reportableTotal: row.reportableTotal.toFixed(2),
        grossTotal: row.grossTotal.toFixed(2),
        backupWithheldTotal: row.backupWithheldTotal.toFixed(2),
        threshold: row.threshold.toFixed(2),
        formRequired: row.formRequired,
      })),
    };
  });

  /**
   * PAY-197: tax deposits (EFTPS acknowledgment numbers, due dates, status)
   * for the Accountant's read-only MCP. Range keys on period_start. No EIN,
   * no internal ids, no reminder bookkeeping. Read-only + audited.
   */
  app.get("/api/export/tax-deposits", async (req, reply) => {
    if (!(await authorize(req, reply, config))) return;

    const q = parseDepositQuery(req, reply);
    if (!q) return;
    const { includeSuperseded } = q;

    const deposits = await fetchDeposits(db, q, includeSuperseded);

    await db.insert(auditEvents).values({
      actorId: EXPORT_ACTOR,
      action: "export.tax_deposits",
      entity: "export",
      entityId: `${q.from ?? ""}..${q.to ?? ""}`,
      after: {
        jurisdiction: q.jurisdiction ?? null,
        includeSuperseded,
        depositCount: deposits.length,
      },
    });

    return { range: { from: q.from ?? null, to: q.to ?? null }, deposits };
  });

  /**
   * PAY-197: tax filings for a year (941 per quarter, 940, W-2/W-3) with the
   * frozen worksheet and linked notice adjustments in integer cents. The
   * worksheets are company-level aggregates. Read-only + audited.
   */
  app.get("/api/export/tax-filings", async (req, reply) => {
    if (!(await authorize(req, reply, config))) return;

    const q = req.query as { year?: string; form?: string };
    if (!q.year || !YEAR_RE.test(q.year)) {
      return badRequest(reply, "invalid_year", "year is required as YYYY");
    }
    if (q.form !== undefined && !(FILING_FORMS as readonly string[]).includes(q.form)) {
      return badRequest(reply, "invalid_form", "form must be 941, 940 or w2_w3");
    }
    const year = Number.parseInt(q.year, 10);

    const filings = await fetchFilings(db, year, q.form);

    await db.insert(auditEvents).values({
      actorId: EXPORT_ACTOR,
      action: "export.tax_filings",
      entity: "export",
      entityId: String(year),
      after: { year, form: q.form ?? null, filingCount: filings.length },
    });

    return { year, filings };
  });
}
