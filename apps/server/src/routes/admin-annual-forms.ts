/**
 * Admin annual-forms routes (PAY-11 + PAY-19): per-employee W-2 list +
 * on-demand W-2 PDFs, and the W-3 transmittal PDF. PDFs render from figures
 * computed out of frozen issued-run entries and are never stored
 * (payslip/1099 doctrine). The W-2 JSON list carries NO PII — SSN/address/
 * EIN only ever enter the rendered PDF, decrypted at render time. W-2s for
 * a tax year unlock on January 1 of the following year (the service
 * enforces the gate).
 *
 * PAY-19 (D1/D4): the per-employee PDF is the official Copy D (employer
 * records); the print packet (Copies B/C/2 + IRS instructions) exists so
 * the admin can physically furnish W-2s to employees who have NOT consented
 * to electronic delivery — the list rows carry a `consented` flag for that.
 *
 * PAY-162: list box figures are formatCents strings (null while an
 * internal_mismatch / negative_amount issue stands) with `issues` (codes
 * only) and `blocked`. A missing federal tax_config row answers 409
 * missing_tax_config; a blocked W-2 answers 409 w2_not_ready on every PDF
 * route; a year with no bundled official form answers 409
 * form_not_available before any PII is read. No body ever carries an amount.
 *
 * Spec 24 (PAY-116) PR-2: list rows carry stateLines (box 15 state, box 16/17
 * strings or null, form, row, the ID's source — never the ID or its mask),
 * localLines [] and formCount; the response carries yearIssues (year-level
 * reconciliation_mismatch per state). Only legacy_state_runs issues carry
 * amounts (admin JSON only).
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hasTemplate, renderW2AdminCopyD, renderW3Pdf } from "@payroll/documents";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import type { Guards } from "../plugins/guards.js";
import {
  annualBlockBody,
  isW2Available,
  isW2Blocked,
  type W2Figures,
  w2AvailableOn,
  w2BoxStrings,
  w2FiguresWithYearIssues,
  w2InputFor,
  w2YearIssues,
  w3InputFor,
} from "../filings/annual.js";
import { formatCents } from "@payroll/shared";
import { electronicW2Channel } from "../filings/w2-consent.js";
import { PDF_RATE_LIMIT, refuseCrossSite } from "../plugins/fetch-site.js";
import { FilingServiceError } from "../filings/shared.js";
import {
  type FurnishingView,
  furnishAndRender,
  furnishingViews,
  markFurnishedOnPaper,
} from "../filings/w2-furnish.js";

interface Deps {
  db: Db;
  config: AppConfig;
  guards: Guards;
}

const yearQuery = z.object({ year: z.coerce.number().int().min(2020).max(2100) });

const NULL_BOXES = {
  box1Wages: null,
  box2FederalWithheld: null,
  box3SsWages: null,
  box4SsTax: null,
  box5MedicareWages: null,
  box6MedicareTax: null,
};

const NOT_FURNISHED: FurnishingView = {
  corrected: false,
  correctionToFurnish: false,
  furnished: "none",
  furnishedOn: null,
};

/**
 * One W-2 list row: box strings (or null), issues, blocked — never cents.
 * PAY-206 (R8): + corrected, correctionToFurnish, furnished, furnishedOn.
 */
function listRow(f: W2Figures, consented: boolean, furnishing: FurnishingView | undefined) {
  const { employeeId, legalName, issues } = f;
  const boxes = f.box1Cents === null ? NULL_BOXES : w2BoxStrings(f);
  return {
    employeeId,
    legalName,
    ...boxes,
    stateLines: f.stateLines.map((l) => ({
      state: l.state,
      box16: l.box16Cents === null ? null : formatCents(l.box16Cents),
      box17: l.box17Cents === null ? null : formatCents(l.box17Cents),
      form: l.form,
      row: l.row,
      stateIdSource: l.stateIdSource,
    })),
    localLines: [],
    formCount: f.formCount,
    issues,
    blocked: isW2Blocked(f),
    consented,
    ...(furnishing ?? NOT_FURNISHED),
  };
}

/** Parse :employeeId + ?year=, or send 400. */
function employeeYear(
  req: { params: unknown; query: unknown },
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
): { employeeId: number; year: number } | null {
  const employeeId = Number((req.params as { employeeId: string }).employeeId);
  if (!Number.isInteger(employeeId) || employeeId <= 0) {
    reply.code(400).send({ error: "invalid_id" });
    return null;
  }
  const q = yearQuery.safeParse(req.query);
  if (!q.success) {
    reply.code(400).send({ error: "invalid_year", details: q.error.issues });
    return null;
  }
  return { employeeId, year: q.data.year };
}

function serviceError(
  err: unknown,
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
) {
  // PAY-162: W-2/W-3 refusals — fixed bodies, codes and year only.
  const block = annualBlockBody(err);
  if (block) return reply.code(409).send(block);
  if (err instanceof FilingServiceError) {
    const status = err.code === "not_found" ? 404 : err.code === "invalid_input" ? 400 : 409;
    return reply.code(status).send({ error: err.code, message: err.message });
  }
  throw err;
}

export function registerAdminAnnualFormRoutes(app: FastifyInstance, deps: Deps): void {
  const { db, config, guards } = deps;
  const admin = guards.requireRole("admin");

  /** Per-employee W-2 figures for the year (review list — figures, no PII). */
  app.get("/api/admin/annual-forms/w2", { preHandler: admin }, async (req, reply) => {
    const q = yearQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_year", details: q.error.issues });
    let figures: W2Figures[];
    let yearIssues: Awaited<ReturnType<typeof w2YearIssues>>;
    try {
      ({ figures, yearIssues } = await w2FiguresWithYearIssues(db, q.data.year));
    } catch (err) {
      return serviceError(err, reply);
    }
    const electronic = await electronicW2Channel(
      db,
      figures.map((f) => f.employeeId),
    );
    const furnishing = await furnishingViews({ db, config }, q.data.year, figures);
    return {
      year: q.data.year,
      available: isW2Available(q.data.year),
      availableOn: w2AvailableOn(q.data.year),
      // PAY-162 (D3): the official W-2/W-3 form is bundled for the year.
      formAvailable: hasTemplate(q.data.year, "fw2") && hasTemplate(q.data.year, "fw3"),
      w2s: figures.map((f) =>
        listRow(f, electronic.has(f.employeeId), furnishing.get(f.employeeId)),
      ),
      yearIssues,
    };
  });

  /**
   * Copy D for one employee (employer records; PII at render time only).
   * Round 3 R5: refused cross-site / same-site before auth; 20/min per client.
   */
  app.get(
    "/api/admin/annual-forms/w2/:employeeId/pdf",
    { preHandler: [refuseCrossSite, admin], config: { rateLimit: PDF_RATE_LIMIT } },
    async (req, reply) => {
      const employeeId = Number((req.params as { employeeId: string }).employeeId);
      if (!Number.isInteger(employeeId) || employeeId <= 0) {
        return reply.code(400).send({ error: "invalid_id" });
      }
      const q = yearQuery.safeParse(req.query);
      if (!q.success)
        return reply.code(400).send({ error: "invalid_year", details: q.error.issues });
      try {
        const input = await w2InputFor({ db, config }, employeeId, q.data.year, {
          requireBundledForm: true,
        });
        const pdf = await renderW2AdminCopyD(input);
        return reply
          .header("content-type", "application/pdf")
          .header(
            "content-disposition",
            `inline; filename="w2-${q.data.year}-employee-${employeeId}-copy-d.pdf"`,
          )
          .send(pdf);
      } catch (err) {
        return serviceError(err, reply);
      }
    },
  );

  /**
   * Print-ready employee packet (Copies B/C/2 + IRS instructions) for one
   * employee — the physical-furnishing route for employees who have not
   * consented to electronic delivery (D4). Consent-independent. PAY-206:
   * records admin_print (the printed copy can reach the employee) before
   * rendering; CORRECTED when the employee may hold other figures.
   */
  app.get(
    "/api/admin/annual-forms/w2/:employeeId/print-packet",
    // PAY-206 review round D10: refused cross-site / same-site; 20/min per client.
    { preHandler: [refuseCrossSite, admin], config: { rateLimit: PDF_RATE_LIMIT } },
    async (req, reply) => {
      const target = employeeYear(req, reply);
      if (!target) return reply;
      try {
        const pdf = await furnishAndRender({ db, config }, target.employeeId, target.year, {
          method: "admin_print",
          actorId: req.authUser!.id,
        });
        return reply
          .header("content-type", "application/pdf")
          .header(
            "content-disposition",
            `inline; filename="w2-${target.year}-employee-${target.employeeId}-print-packet.pdf"`,
          )
          .send(pdf);
      } catch (err) {
        return serviceError(err, reply);
      }
    },
  );

  /**
   * PAY-206 (R8): the admin gave the employee the current W-2 on paper.
   * Idempotent; audit w2_furnishing.paper_handed. No amounts in the body.
   */
  app.post(
    "/api/admin/annual-forms/w2/:employeeId/furnished-on-paper",
    { preHandler: admin },
    async (req, reply) => {
      const target = employeeYear(req, reply);
      if (!target) return reply;
      try {
        const { corrected } = await markFurnishedOnPaper(
          { db, config },
          target.employeeId,
          target.year,
          req.authUser!.id,
        );
        return { furnished: "paper", corrected };
      } catch (err) {
        return serviceError(err, reply);
      }
    },
  );

  /**
   * On-demand W-3 transmittal PDF for the year (admin-only). PR-3 R7: refused
   * cross-site / same-site before auth; 20/min per client, like the W-2 PDFs.
   */
  app.get(
    "/api/admin/annual-forms/w3/pdf",
    { preHandler: [refuseCrossSite, admin], config: { rateLimit: PDF_RATE_LIMIT } },
    async (req, reply) => {
      const q = yearQuery.safeParse(req.query);
      if (!q.success)
        return reply.code(400).send({ error: "invalid_year", details: q.error.issues });
      try {
        const input = await w3InputFor({ db, config }, q.data.year, { requireBundledForm: true });
        const pdf = await renderW3Pdf(input);
        return reply
          .header("content-type", "application/pdf")
          .header("content-disposition", `inline; filename="w3-${q.data.year}.pdf"`)
          .send(pdf);
      } catch (err) {
        return serviceError(err, reply);
      }
    },
  );
}
