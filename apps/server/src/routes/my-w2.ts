/**
 * Employee W-2 routes (PAY-11 + PAY-19 + PAY-208): the employee's own annual
 * W-2, available from January 1 of the following year. List + on-demand PDF
 * — same generated-not-stored doctrine as payslips. Employees see only their
 * own W-2 (the employees row is resolved from the session user; foreign
 * years or locked years 404/409 without enumeration).
 *
 * The PDF download is gated per tax year on a consent that covers the year
 * (consentCoversYear; 26 CFR 31.6051-1(j); IRS Pub 15-A (2026), "Furnishing
 * Form W-2 to employees electronically") — the consent endpoints carry the
 * required disclosures. PAY-206 review round D9 ((j)(6)): when the consent
 * does not cover a year (withdrawn, or earlier terms), a year already
 * furnished electronically stays downloadable through its access window
 * (electronicAccessAlreadyFurnished); every other year is gated. The D9
 * window reads "today" from the app clock (deps.clock) in the company
 * timezone; the January availability gate keeps the real date.
 *
 * PAY-208: consent names the disclosure version (409 disclosure_changed),
 * needs the W-2 contact (409 w2_contact_missing) and the PDF access check
 * — GET /api/my/w2/consent/test-pdf shows a single-use code the employee
 * types back (409 access_check_failed). Consent routes refuse cross-site.
 *
 * PAY-217: a former employee (requireAuth access "w2_only") reaches the list
 * and the PDF only (route config formerEmployeeW2): the list holds the years
 * furnished online whose (j)(6) window is open today, plus the W-2 contact;
 * a PDF outside that list, or of figures never posted online, is 409
 * w2_not_available (checked under the employee lock). The consent routes
 * stay refused (403 w2_access_only): a consent would post a paper year
 * online.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { and, eq } from "drizzle-orm";
import { employees } from "@payroll/db";
import { renderAccessCheckPdf } from "@payroll/documents";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import type { Guards } from "../plugins/guards.js";
import {
  annualBlockBody,
  furnishAfterConsent,
  listMyW2Years,
  myUpcomingW2Year,
  myW2FormCount,
  w2AvailableOn,
} from "../filings/annual.js";
import {
  consentCoversYear,
  consentRowOf,
  consentToElectronicW2,
  onlineW2Windows,
  readW2Contact,
  W2ConsentRefused,
  w2ConsentStatus,
  withdrawW2Consent,
} from "../filings/w2-consent.js";
import { createAccessCodeStore } from "../filings/w2-access-check.js";
import { errorClass, FilingServiceError } from "../filings/shared.js";
import {
  currentFiguresWentOnline,
  electronicAccessAlreadyFurnished,
  FrozenFiguresRaceError,
  furnishAndRender,
  isMyW2Corrected,
  W2NotAvailableError,
  w2AccessThrough,
} from "../filings/w2-furnish.js";
import { companyName } from "../notify/outbox.js";
import { electronicW2AccessThrough } from "@payroll/shared";
import { localDate } from "../payroll/run-dates.js";
import { PDF_RATE_LIMIT, refuseCrossSite } from "../plugins/fetch-site.js";

interface Deps {
  db: Db;
  config: AppConfig;
  guards: Guards;
  /** Test override: the wall clock for the D9 access window. */
  clock?: () => Date;
}

/** The session user's W-2 employee row, or null (contractor / no profile). */
async function myEmployee(db: Db, userId: string) {
  const rows = await db
    .select()
    .from(employees)
    .where(and(eq(employees.userId, userId), eq(employees.employmentType, "w2")))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Render + send the employee packet; maps service errors to HTTP. PAY-206:
 * the employee_download furnishing is recorded (under the employee lock)
 * before any byte is rendered or sent; the packet says CORRECTED when the
 * employee may hold a copy with other figures.
 */
async function sendW2Pdf(
  deps: { db: Db; config: AppConfig },
  employeeId: number,
  year: number,
  actorId: string,
  reply: FastifyReply,
  formerEmployee?: { today: string },
) {
  try {
    // PAY-162: requireBundledForm stops before any PII is read when the
    // year has no official form.
    const pdf = await furnishAndRender(deps, employeeId, year, {
      method: "employee_download",
      actorId,
      ...(formerEmployee ? { formerEmployee } : {}),
    });
    return reply
      .header("content-type", "application/pdf")
      .header("content-disposition", `inline; filename="w2-${year}.pdf"`)
      .send(pdf);
  } catch (err) {
    // PAY-217: one body for never online / window closed / not posted.
    if (err instanceof W2NotAvailableError) {
      return reply.code(409).send({ error: "w2_not_available" });
    }
    // PAY-162: every refusal is the same bare body — no year, no codes, no
    // ids — whether the W-2 is held, unreadable, unconfigured, has no
    // official form, or does not exist for this employee and year.
    // PAY-223: a state ID re-entered mid-download rolled the record back;
    // the employee retries.
    const block = annualBlockBody(err);
    if (block || err instanceof FilingServiceError || err instanceof FrozenFiguresRaceError) {
      return reply.code(409).send({ error: "w2_not_ready" });
    }
    throw err;
  }
}

/**
 * PAY-217: the former employee's W-2 list — only the years furnished online
 * whose window is open today, each downloadable when its current figures
 * went online; the W-2 contact for questions and paper copies.
 */
async function formerW2List(deps: { db: Db; config: AppConfig }, userId: string, today: string) {
  const { db, config } = deps;
  const employee = await myEmployee(db, userId);
  const windows = employee ? await onlineW2Windows(db, employee.id, today, config.appTz) : [];
  const w2s = [];
  for (const { taxYear: year, accessThrough } of employee ? windows : []) {
    const formCount = await myW2FormCount(db, employee!.id, year);
    const ready = formCount !== null;
    w2s.push({
      year,
      availableOn: w2AvailableOn(year),
      ready,
      corrected: ready ? await isMyW2Corrected(db, employee!.id, year) : false,
      downloadable: ready && (await currentFiguresWentOnline(db, employee!.id, year)),
      formCount,
      accessThrough,
    });
  }
  return {
    w2s,
    upcomingYear: null,
    former: {
      companyName: await companyName(db),
      contact: (await readW2Contact(db)).contact,
    },
  };
}

export function registerMyW2Routes(app: FastifyInstance, deps: Deps): void {
  const { db, config, guards } = deps;
  const now = deps.clock ?? (() => new Date());
  const today = () => localDate(now(), config.appTz);
  /** The January availability gate: the real date in the company time zone (not deps.clock). */
  const gateToday = () => localDate(new Date(), config.appTz);
  const codes = createAccessCodeStore();

  /** True when the employee may download `year`: the consent covers it, or D9. */
  async function canDownload(employeeId: number, year: number): Promise<boolean> {
    const row = await consentRowOf(db, employeeId);
    if (consentCoversYear(row, year)) return true;
    return electronicAccessAlreadyFurnished(db, employeeId, year, today(), config.appTz);
  }

  /** The employee's W-2 list (PAY-11 … PAY-208). */
  async function activeW2List(userId: string) {
    // PAY-208: the January gate reads the company-local date (config.appTz).
    const years = await listMyW2Years(db, userId, gateToday());
    // PAY-208 (2.2b, OD5): the consent prompt shows before January.
    const upcomingYear = await myUpcomingW2Year(db, userId, gateToday());
    const employee = years.length > 0 ? await myEmployee(db, userId) : null;
    const w2s = [];
    for (const year of years) {
      // PAY-162 (D2): a bare ready flag — never why a W-2 is not ready.
      // Spec 24 (PAY-116) PR-4 (S3): + the form count, null unless ready.
      const formCount = employee ? await myW2FormCount(db, employee.id, year) : null;
      const ready = formCount !== null;
      // PAY-206 (R7): a bare corrected flag — no reasons, no dates of change.
      const corrected = employee && ready ? await isMyW2Corrected(db, employee.id, year) : false;
      // PAY-208: the same per-year gate as the PDF route.
      const downloadable = employee !== null && ready && (await canDownload(employee.id, year));
      w2s.push({
        year,
        availableOn: w2AvailableOn(year),
        ready,
        corrected,
        downloadable,
        formCount,
        // PAY-208 (N1, (j)(6)): the last day this W-2 stays online.
        accessThrough: employee
          ? await w2AccessThrough(db, employee.id, year, config.appTz)
          : electronicW2AccessThrough(year),
      });
    }
    return { w2s, upcomingYear };
  }

  // PAY-217: a former employee gets their online years + the W-2 contact.
  app.get(
    "/api/my/w2",
    { preHandler: guards.requireAuth, config: { formerEmployeeW2: true } },
    async (req) => {
      const userId = req.authUser!.id;
      if (req.access?.kind === "w2_only") return formerW2List({ db, config }, userId, today());
      return activeW2List(userId);
    },
  );

  /** Consent status + the disclosure text shown before the agree button. */
  app.get("/api/my/w2/consent", { preHandler: guards.requireAuth }, async (req, reply) => {
    const employee = await myEmployee(db, req.authUser!.id);
    if (!employee) return reply.code(404).send({ error: "not_found" });
    return w2ConsentStatus(db, employee.id);
  });

  /**
   * PAY-208 D-B: the one-page test PDF with a new single-use access code.
   * The code is only in the PDF bytes (no header, no file name, no log).
   */
  app.get(
    "/api/my/w2/consent/test-pdf",
    {
      preHandler: [refuseCrossSite, guards.requireAuth],
      config: { rateLimit: PDF_RATE_LIMIT },
    },
    async (req, reply) => {
      const employee = await myEmployee(db, req.authUser!.id);
      if (!employee) return reply.code(404).send({ error: "not_found" });
      const pdf = await renderAccessCheckPdf(codes.issue(employee.id));
      return reply
        .header("content-type", "application/pdf")
        .header("content-disposition", 'inline; filename="w2-test.pdf"')
        .header("cache-control", "no-store")
        .send(pdf);
    },
  );

  /**
   * Affirmative agreement to the current terms (idempotent on the current
   * version). Body { disclosureVersion, accessCode }.
   */
  app.post(
    "/api/my/w2/consent",
    { preHandler: [refuseCrossSite, guards.requireAuth] },
    async (req, reply) => {
      const employee = await myEmployee(db, req.authUser!.id);
      if (!employee) return reply.code(404).send({ error: "not_found" });
      const body = (req.body ?? {}) as { disclosureVersion?: unknown; accessCode?: unknown };
      try {
        const out = await consentToElectronicW2(db, employee.id, req.authUser!.id, {
          disclosureVersion: body.disclosureVersion,
          accessCheck: () => codes.consume(employee.id, body.accessCode),
        });
        if (out.change !== null) {
          // 2.2a: a year already notified on paper is furnished online now.
          try {
            await furnishAfterConsent({ db, config }, employee.id, gateToday());
          } catch (err) {
            req.log.error(`W-2 late consent furnishing failed (${errorClass(err)})`);
          }
        }
        return out.status;
      } catch (err) {
        if (err instanceof W2ConsentRefused) return reply.code(409).send({ error: err.code });
        throw err;
      }
    },
  );

  /** Withdraw — future W-2s on paper; the written confirmation is queued. */
  app.delete(
    "/api/my/w2/consent",
    { preHandler: [refuseCrossSite, guards.requireAuth] },
    async (req, reply) => {
      const employee = await myEmployee(db, req.authUser!.id);
      if (!employee) return reply.code(404).send({ error: "not_found" });
      try {
        const out = await withdrawW2Consent({ db, config }, employee.id, req.authUser!.id);
        return { ...out.status, effectiveOn: out.effectiveOn };
      } catch (err) {
        if (err instanceof FilingServiceError) {
          return reply.code(404).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );

  // D10: refused cross-site / same-site; 20 per minute per client.
  app.get(
    "/api/my/w2/:year/pdf",
    {
      preHandler: [refuseCrossSite, guards.requireAuth],
      config: { rateLimit: PDF_RATE_LIMIT, formerEmployeeW2: true },
    },
    async (req, reply) => {
      const year = Number((req.params as { year: string }).year);
      if (!Number.isInteger(year) || year < 2020 || year > 2100) {
        return reply.code(400).send({ error: "invalid_year" });
      }
      const employee = await myEmployee(db, req.authUser!.id);
      if (!employee) return reply.code(404).send({ error: "not_found" });
      // PAY-217: a former employee — window + posted figures, under the lock.
      if (req.access?.kind === "w2_only") {
        return sendW2Pdf({ db, config }, employee.id, year, req.authUser!.id, reply, {
          today: today(),
        });
      }
      // 26 CFR 31.6051-1(j): no electronic W-2 without a consent that covers
      // the year, except a year already furnished electronically, inside
      // its access window (review round D9, PAY-208).
      if (!(await canDownload(employee.id, year))) {
        return reply.code(409).send({
          error: "consent_required",
          message: "consent to electronic W-2 delivery before downloading",
        });
      }
      return sendW2Pdf({ db, config }, employee.id, year, req.authUser!.id, reply);
    },
  );
}
