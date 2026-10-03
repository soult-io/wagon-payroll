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
import { renderW2EmployeePacket } from "@payroll/documents";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import type { Guards } from "../plugins/guards.js";
import { annualBlockBody, isMyW2Ready, listMyW2Years, w2AvailableOn } from "../filings/annual.js";
import {
  consentToElectronicW2,
  w2ConsentStatus,
  withdrawW2Consent,
} from "../filings/w2-consent.js";
import { FilingServiceError } from "../filings/shared.js";
import { furnishForRender, isMyW2Corrected } from "../filings/w2-furnish.js";

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
) {
  try {
    // PAY-162: requireBundledForm stops before any PII is read when the
    // year has no official form.
    const { input, corrected } = await furnishForRender(deps, employeeId, year, {
      method: "employee_download",
      actorId,
    });
    const pdf = await renderW2EmployeePacket(input, { corrected });
    return reply
      .header("content-type", "application/pdf")
      .header("content-disposition", `inline; filename="w2-${year}.pdf"`)
      .send(pdf);
  } catch (err) {
    // PAY-162: every refusal is the same bare body — no year, no codes, no
    // ids — whether the W-2 is held, unreadable, unconfigured, has no
    // official form, or does not exist for this employee and year.
    const block = annualBlockBody(err);
    if (block || err instanceof FilingServiceError) {
      return reply.code(409).send({ error: "w2_not_ready" });
    }
    throw err;
  }
}

export function registerMyW2Routes(app: FastifyInstance, deps: Deps): void {
  const { db, config, guards } = deps;

  app.get("/api/my/w2", { preHandler: guards.requireAuth }, async (req) => {
    const userId = req.authUser!.id;
    const years = await listMyW2Years(db, userId);
    const employee = years.length > 0 ? await myEmployee(db, userId) : null;
    const w2s = [];
    for (const year of years) {
      // PAY-162 (D2): a bare ready flag — never why a W-2 is not ready.
      const ready = employee ? await isMyW2Ready(db, employee.id, year) : false;
      // PAY-206 (R7): a bare corrected flag — no reasons, no dates of change.
      const corrected = employee && ready ? await isMyW2Corrected(db, employee.id, year) : false;
      w2s.push({ year, availableOn: w2AvailableOn(year), ready, corrected });
    }
    return { w2s };
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
    return sendW2Pdf({ db, config }, employee.id, year, req.authUser!.id, reply);
  });
}
