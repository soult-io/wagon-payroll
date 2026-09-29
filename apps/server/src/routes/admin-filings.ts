/**
 * Admin tax-filing routes (PAY-10): quarterly Form 941 — the computed
 * worksheet (line-by-line, frozen snapshot + hash), filing-status tracking
 * (mark-as-filed with method + reference, e.g. the Letterstream Job ID),
 * the admin-editable line-7 fractions-of-cents (D4), first-class
 * adjustment/notice records per filing (D3 — the CP220 lesson), and the
 * admin-editable reminder-offset schedule (D1). Record-only per D2 — the
 * app never files; the admin files by mail/e-file and records it here.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { renderF940Pdf, renderF941Pdf } from "@payroll/documents";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import type { Guards } from "../plugins/guards.js";
import { f940PdfInputFor } from "../filings/form-940-pdf.js";
import { f941PdfInputFor } from "../filings/form-941-pdf.js";
import { MissingTaxConfigError, W2BlockedError } from "../filings/annual.js";
import {
  addAdjustment,
  DEFAULT_FILING_REMINDER_OFFSETS,
  deleteAdjustment,
  FILING_REMINDER_OFFSET_MAX,
  FILING_REMINDER_OFFSET_MAX_ENTRIES,
  FilingServiceError,
  getFilingDetail,
  getFilingReminderOffsets,
  listFilings,
  markFiled,
  previewWorksheetRecompute,
  recomputeFiledWorksheet,
  setFilingReminderOffsets,
  setFractionsOfCents,
  updateAdjustment,
} from "../filings/service.js";
import {
  addFilingAttachment,
  listFilingAttachments,
  MAX_ATTACHMENT_BYTES,
  readFilingAttachment,
} from "../filings/attachments.js";

interface Deps {
  db: Db;
  config: AppConfig;
  guards: Guards;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONEY = /^-?\d{1,10}(\.\d{1,2})?$/;
const NONNEG_MONEY = /^\d{1,10}(\.\d{1,2})?$/;

const filedBody = z.object({
  filedOn: z.string().regex(ISO_DATE, "filedOn must be YYYY-MM-DD"),
  filingMethod: z.string().trim().min(1).max(50),
  filingReference: z.string().trim().max(100).default(""),
});

const fractionsBody = z.object({
  amount: z.string().regex(MONEY, "amount must be a decimal, e.g. 0.01 or -0.02"),
});

const recomputeBody = z.object({
  reason: z.string().trim().min(1, "reason is required").max(500),
});

const adjustmentBody = z.object({
  kind: z.string().trim().min(1).max(50),
  noticeDate: z.string().regex(ISO_DATE).optional().or(z.literal("")),
  amountDue: z.string().regex(NONNEG_MONEY, "amountDue must be a non-negative decimal"),
  abatedAmount: z.string().regex(NONNEG_MONEY).optional(),
  amountPaid: z.string().regex(NONNEG_MONEY).optional(),
  paidOn: z.string().regex(ISO_DATE).optional().or(z.literal("")),
  eftpsConfirmation: z.string().trim().max(100).optional(),
  note: z.string().max(2000).optional(),
});

const offsetsBody = z.object({
  offsets: z
    .array(z.number().int().min(0).max(FILING_REMINDER_OFFSET_MAX))
    .min(1)
    .max(FILING_REMINDER_OFFSET_MAX_ENTRIES),
});

function serviceError(
  err: unknown,
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
) {
  // PAY-162: fixed bodies, codes and year only — never a message or amount.
  if (err instanceof MissingTaxConfigError) {
    return reply.code(409).send({ error: "missing_tax_config", year: err.year });
  }
  if (err instanceof W2BlockedError) {
    return reply.code(409).send({ error: "w2_not_ready", issues: err.issues });
  }
  if (err instanceof FilingServiceError) {
    const status = err.code === "not_found" ? 404 : err.code === "invalid_input" ? 400 : 409;
    return reply.code(status).send({ error: err.code, message: err.message });
  }
  throw err;
}

function intParam(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function registerAdminFilingRoutes(app: FastifyInstance, deps: Deps): void {
  const { db, config, guards } = deps;
  const admin = guards.requireRole("admin");

  app.get("/api/admin/tax-filings", { preHandler: admin }, async (req, reply) => {
    const q = z
      .object({
        year: z.coerce.number().int().min(2020).max(2100).optional(),
        status: z.enum(["not_started", "ready", "filed"]).optional(),
        formType: z.enum(["941", "940", "w2_w3"]).optional(),
      })
      .safeParse(req.query);
    if (!q.success)
      return reply.code(400).send({ error: "invalid_query", details: q.error.issues });
    const filings = await listFilings(db, q.data);
    return { filings };
  });

  app.get("/api/admin/tax-filings/:id", { preHandler: admin }, async (req, reply) => {
    const id = intParam((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: "invalid_id" });
    try {
      return await getFilingDetail(db, id);
    } catch (err) {
      return serviceError(err, reply);
    }
  });

  app.post("/api/admin/tax-filings/:id/file", { preHandler: admin }, async (req, reply) => {
    const body = filedBody.safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_body", details: body.error.issues });
    const id = intParam((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: "invalid_id" });
    try {
      const filing = await markFiled({ db, config }, id, body.data, req.authUser!.id);
      return { filing };
    } catch (err) {
      return serviceError(err, reply);
    }
  });

  // PAY-25: audited worksheet correction for FILED filings. GET previews the
  // recompute (the confirmation dialog's old → new diff); POST commits with a
  // mandatory reason and writes tax_filing.correct_worksheet. Filing metadata
  // (status/filed_on/method/reference) is never touched.
  app.get("/api/admin/tax-filings/:id/recompute", { preHandler: admin }, async (req, reply) => {
    const id = intParam((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: "invalid_id" });
    try {
      return await previewWorksheetRecompute(db, id);
    } catch (err) {
      return serviceError(err, reply);
    }
  });

  app.post("/api/admin/tax-filings/:id/recompute", { preHandler: admin }, async (req, reply) => {
    const body = recomputeBody.safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_body", details: body.error.issues });
    const id = intParam((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: "invalid_id" });
    try {
      const filing = await recomputeFiledWorksheet(
        { db, config },
        id,
        body.data.reason,
        req.authUser!.id,
      );
      return { filing };
    } catch (err) {
      return serviceError(err, reply);
    }
  });

  // PAY-16: filled official Form 941 PDF from the filing's worksheet
  // snapshot — rendered on demand, flattened, never stored. Ships unsigned:
  // the admin wet/e-signs before the Letterstream mail upload.
  app.get("/api/admin/tax-filings/:id/941-pdf", { preHandler: admin }, async (req, reply) => {
    const id = intParam((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: "invalid_id" });
    try {
      const input = await f941PdfInputFor({ db, config }, id);
      const pdf = await renderF941Pdf(input);
      return reply
        .header("content-type", "application/pdf")
        .header(
          "content-disposition",
          `inline; filename="f941-${input.taxYear}-q${input.quarter}.pdf"`,
        )
        .send(pdf);
    } catch (err) {
      return serviceError(err, reply);
    }
  });

  // PAY-33: filled official Form 940 PDF from the filing's annual FUTA
  // worksheet snapshot — same doctrine as the 941 PDF (PAY-16).
  app.get("/api/admin/tax-filings/:id/940-pdf", { preHandler: admin }, async (req, reply) => {
    const id = intParam((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: "invalid_id" });
    try {
      const input = await f940PdfInputFor({ db, config }, id);
      const pdf = await renderF940Pdf(input);
      return reply
        .header("content-type", "application/pdf")
        .header("content-disposition", `inline; filename="f940-${input.taxYear}.pdf"`)
        .send(pdf);
    } catch (err) {
      return serviceError(err, reply);
    }
  });

  app.put(
    "/api/admin/tax-filings/:id/fractions-of-cents",
    { preHandler: admin },
    async (req, reply) => {
      const body = fractionsBody.safeParse(req.body);
      if (!body.success)
        return reply.code(400).send({ error: "invalid_body", details: body.error.issues });
      const id = intParam((req.params as { id: string }).id);
      if (!id) return reply.code(400).send({ error: "invalid_id" });
      try {
        const filing = await setFractionsOfCents(
          { db, config },
          id,
          body.data.amount,
          req.authUser!.id,
        );
        return { filing };
      } catch (err) {
        return serviceError(err, reply);
      }
    },
  );

  app.post("/api/admin/tax-filings/:id/adjustments", { preHandler: admin }, async (req, reply) => {
    const body = adjustmentBody.safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_body", details: body.error.issues });
    const id = intParam((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: "invalid_id" });
    try {
      const adjustment = await addAdjustment({ db, config }, id, body.data, req.authUser!.id);
      return reply.code(201).send({ adjustment });
    } catch (err) {
      return serviceError(err, reply);
    }
  });

  app.put(
    "/api/admin/tax-filings/:id/adjustments/:adjId",
    { preHandler: admin },
    async (req, reply) => {
      const body = adjustmentBody.safeParse(req.body);
      if (!body.success)
        return reply.code(400).send({ error: "invalid_body", details: body.error.issues });
      const params = req.params as { id: string; adjId: string };
      const id = intParam(params.id);
      const adjId = intParam(params.adjId);
      if (!id || !adjId) return reply.code(400).send({ error: "invalid_id" });
      try {
        const adjustment = await updateAdjustment(
          { db, config },
          id,
          adjId,
          body.data,
          req.authUser!.id,
        );
        return { adjustment };
      } catch (err) {
        return serviceError(err, reply);
      }
    },
  );

  app.delete(
    "/api/admin/tax-filings/:id/adjustments/:adjId",
    { preHandler: admin },
    async (req, reply) => {
      const params = req.params as { id: string; adjId: string };
      const id = intParam(params.id);
      const adjId = intParam(params.adjId);
      if (!id || !adjId) return reply.code(400).send({ error: "invalid_id" });
      try {
        await deleteAdjustment({ db, config }, id, adjId, req.authUser!.id);
        return { ok: true };
      } catch (err) {
        return serviceError(err, reply);
      }
    },
  );

  app.get("/api/admin/tax-filings/reminder-schedule", { preHandler: admin }, async () => {
    const offsets = await getFilingReminderOffsets(db);
    return { offsets, defaultOffsets: [...DEFAULT_FILING_REMINDER_OFFSETS] };
  });

  app.put("/api/admin/tax-filings/reminder-schedule", { preHandler: admin }, async (req, reply) => {
    const body = offsetsBody.safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_body", details: body.error.issues });
    try {
      const offsets = await setFilingReminderOffsets(
        { db, config },
        body.data.offsets,
        req.authUser!.id,
      );
      return { offsets };
    } catch (err) {
      return serviceError(err, reply);
    }
  });

  // ---------------------------------------------------------------------
  // PAY-24: filing attachments (confirmation/evidence PDFs). Raw-body
  // upload (application/pdf parser below — no multipart dependency);
  // admin-only read + write; bytes are AES-256-GCM ciphertext at rest.
  // ---------------------------------------------------------------------

  if (!app.hasContentTypeParser("application/pdf")) {
    app.addContentTypeParser(
      "application/pdf",
      { parseAs: "buffer", bodyLimit: MAX_ATTACHMENT_BYTES },
      (_req, body, done) => done(null, body),
    );
  }

  app.get("/api/admin/tax-filings/:id/attachments", { preHandler: admin }, async (req, reply) => {
    const id = intParam((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: "invalid_id" });
    try {
      return { attachments: await listFilingAttachments(db, id) };
    } catch (err) {
      return serviceError(err, reply);
    }
  });

  app.post("/api/admin/tax-filings/:id/attachments", { preHandler: admin }, async (req, reply) => {
    const id = intParam((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: "invalid_id" });
    if (!Buffer.isBuffer(req.body)) {
      return reply
        .code(415)
        .send({ error: "unsupported_media_type", message: "POST the PDF as application/pdf" });
    }
    const q = z.object({ filename: z.string().max(300).optional() }).safeParse(req.query);
    if (!q.success)
      return reply.code(400).send({ error: "invalid_query", details: q.error.issues });
    try {
      const attachment = await addFilingAttachment(
        { db, config },
        id,
        { filename: q.data.filename ?? "confirmation.pdf", data: req.body },
        req.authUser!.id,
      );
      return reply.code(201).send({ attachment });
    } catch (err) {
      return serviceError(err, reply);
    }
  });

  app.get(
    "/api/admin/tax-filings/:id/attachments/:attachmentId/download",
    { preHandler: admin },
    async (req, reply) => {
      const params = req.params as { id: string; attachmentId: string };
      const id = intParam(params.id);
      const attachmentId = intParam(params.attachmentId);
      if (!id || !attachmentId) return reply.code(400).send({ error: "invalid_id" });
      try {
        const { filename, data } = await readFilingAttachment(
          { db, config },
          id,
          attachmentId,
          req.authUser!.id,
        );
        return reply
          .header("content-type", "application/pdf")
          .header("content-disposition", `inline; filename="${filename.replaceAll('"', "_")}"`)
          .send(data);
      } catch (err) {
        return serviceError(err, reply);
      }
    },
  );
}
