/**
 * Employee W-2 routes (PAY-11 + PAY-19): the employee's own annual W-2,
 * available from January 1 of the following year. List + on-demand PDF —
 * same generated-not-stored doctrine as payslips. Employees see only their
 * own W-2 (the employees row is resolved from the session user; foreign
 * years or locked years 404/409 without enumeration).
 *
 * PAY-19 (D4, Pub 1141 §2.4): the PDF download is gated on an active
 * electronic-delivery consent — the consent endpoints carry the required
 * disclosures, and withdrawal re-gates the download immediately.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { and, eq } from "drizzle-orm";
import { employees } from "@payroll/db";
import { hasTemplate, renderW2EmployeePacket } from "@payroll/documents";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import type { Guards } from "../plugins/guards.js";
import {
  listMyW2Years,
  MissingTaxConfigError,
  W2BlockedError,
  w2AvailableOn,
  w2InputFor,
} from "../filings/annual.js";
import {
  consentToElectronicW2,
  w2ConsentStatus,
  withdrawW2Consent,
} from "../filings/w2-consent.js";
import { FilingServiceError } from "../filings/shared.js";

interface Deps {
  db: Db;
  config: AppConfig;
  guards: Guards;
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

/** Render + send the employee packet; maps service errors to HTTP. */
async function sendW2Pdf(
  deps: { db: Db; config: AppConfig },
  employeeId: number,
  year: number,
  reply: FastifyReply,
) {
  try {
    const input = await w2InputFor(deps, employeeId, year);
    // PAY-162: no official form bundled for the year → 409 before rendering.
    if (!hasTemplate(input.taxYear, "fw2")) {
      return reply.code(409).send({ error: "form_not_available", year });
    }
    const pdf = await renderW2EmployeePacket(input);
    return reply
      .header("content-type", "application/pdf")
      .header("content-disposition", `inline; filename="w2-${year}.pdf"`)
      .send(pdf);
  } catch (err) {
    // PAY-162: fixed bodies — the employee never sees issue codes or amounts.
    if (err instanceof MissingTaxConfigError) {
      return reply.code(409).send({ error: "missing_tax_config" });
    }
    if (err instanceof W2BlockedError) return reply.code(409).send({ error: "w2_not_ready" });
    if (err instanceof FilingServiceError) {
      const status = err.code === "not_found" ? 404 : 409;
      return reply.code(status).send({ error: err.code, message: err.message });
    }
    throw err;
  }
}

export function registerMyW2Routes(app: FastifyInstance, deps: Deps): void {
  const { db, config, guards } = deps;

  app.get("/api/my/w2", { preHandler: guards.requireAuth }, async (req) => {
    const years = await listMyW2Years(db, req.authUser!.id);
    return { w2s: years.map((year) => ({ year, availableOn: w2AvailableOn(year) })) };
  });

  /** Consent status + the disclosure text shown before the consent button. */
  app.get("/api/my/w2/consent", { preHandler: guards.requireAuth }, async (req, reply) => {
    const employee = await myEmployee(db, req.authUser!.id);
    if (!employee) return reply.code(404).send({ error: "not_found" });
    return w2ConsentStatus(db, employee.id);
  });

  /** Affirmative consent to electronic W-2 delivery (idempotent). */
  app.post("/api/my/w2/consent", { preHandler: guards.requireAuth }, async (req, reply) => {
    const employee = await myEmployee(db, req.authUser!.id);
    if (!employee) return reply.code(404).send({ error: "not_found" });
    return consentToElectronicW2(db, employee.id, req.authUser!.id);
  });

  /** Withdraw consent — future W-2s are furnished on paper again. */
  app.delete("/api/my/w2/consent", { preHandler: guards.requireAuth }, async (req, reply) => {
    const employee = await myEmployee(db, req.authUser!.id);
    if (!employee) return reply.code(404).send({ error: "not_found" });
    try {
      return await withdrawW2Consent(db, employee.id, req.authUser!.id);
    } catch (err) {
      if (err instanceof FilingServiceError) {
        return reply.code(404).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.get("/api/my/w2/:year/pdf", { preHandler: guards.requireAuth }, async (req, reply) => {
    const year = Number((req.params as { year: string }).year);
    if (!Number.isInteger(year) || year < 2020 || year > 2100) {
      return reply.code(400).send({ error: "invalid_year" });
    }
    const employee = await myEmployee(db, req.authUser!.id);
    if (!employee) return reply.code(404).send({ error: "not_found" });
    // Pub 1141 §2.4: no electronic W-2 without an active consent (D4).
    const consent = await w2ConsentStatus(db, employee.id);
    if (!consent.consented) {
      return reply.code(409).send({
        error: "consent_required",
        message: "consent to electronic W-2 delivery before downloading",
      });
    }
    return sendW2Pdf({ db, config }, employee.id, year, reply);
  });
}
