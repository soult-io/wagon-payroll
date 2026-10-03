/**
 * Email templates (spec notifications): one function per catalog event, each
 * returning {subject, html, text} (text/plain fallback always present).
 * MJML-free, no external assets. The employer's name (company row) leads; the
 * product name (spec 22 D4) appears only as the tool that sent the message.
 *
 * CONTENT RULES (spec — enforced here, asserted in tests):
 * - change_request_* emails never include amounts.
 * - payslip_issued states the period + "log in to view/download" — never net
 *   pay, never attachments.
 * - bank/SSN data never appears in ANY email.
 */

export const EVENT_TYPE = {
  payrollDraftReady: "payroll_draft_ready",
  payslipIssued: "payslip_issued",
  changeRequestSubmitted: "change_request_submitted",
  changeRequestApproved: "change_request_approved",
  changeRequestDenied: "change_request_denied",
  securityInvite: "security_invite",
  securityPasswordReset: "security_password_reset",
  securityLoginNewDevice: "security_login_new_device",
  /** Admin observability test email (spec admin settings page). */
  adminTestEmail: "admin_test_email",
  /** Spec 10 — contractor invoice workflow + W-8 form lifecycle. */
  contractorInvoiceSubmitted: "contractor_invoice_submitted",
  contractorInvoiceReviewed: "contractor_invoice_reviewed",
  contractorInvoicePaid: "contractor_invoice_paid",
  contractorFormExpiring: "contractor_form_expiring",
  contractorFormExpired: "contractor_form_expired",
  /** Spec 12 — recurring invoice generation + payment-due reminder. */
  contractorRecurringGenerated: "contractor_recurring_generated",
  contractorRecurringPaymentDue: "contractor_recurring_payment_due",
  /** PAY-9 — monthly federal tax deposit due-date reminder (admin). */
  taxDepositDue: "tax_deposit_due",
  /** PAY-91 — a state deposit period could not be worked out (data error; admin, always on). */
  taxDepositSyncFailed: "tax_deposit_sync_failed",
  /** PAY-193 — an additional (shortfall) deposit row was created for a paid period (admin, always on). */
  taxDepositShortfall: "tax_deposit_shortfall",
  /** PAY-10 — quarterly filing (Form 941) due-date reminder (admin). */
  taxFilingDue: "tax_filing_due",
  /** PAY-11 — an employee's W-2 for a tax year is available for download. */
  w2Available: "w2_available",
} as const;

export type EventType = (typeof EVENT_TYPE)[keyof typeof EVENT_TYPE];

/**
 * Toggleable workflow events (the settings UI surface); security + admin events
 * are always on. PAY-7/D3 (2026-08-21): the contractor-facing invoice lifecycle
 * events (reviewed / paid) are user-toggleable like the rest — admin-facing
 * contractor events (submission notices, form expiry, recurring reminders)
 * stay always-on compliance mail.
 */
export const WORKFLOW_EVENTS: readonly EventType[] = [
  EVENT_TYPE.payrollDraftReady,
  EVENT_TYPE.payslipIssued,
  EVENT_TYPE.changeRequestSubmitted,
  EVENT_TYPE.changeRequestApproved,
  EVENT_TYPE.changeRequestDenied,
  EVENT_TYPE.contractorInvoiceReviewed,
  EVENT_TYPE.contractorInvoicePaid,
  EVENT_TYPE.taxDepositDue,
  EVENT_TYPE.taxFilingDue,
  EVENT_TYPE.w2Available,
];

/**
 * PAY-8: per-event audience — who a workflow event can ever fire for.
 * "admin" events notify admins only; "w2"/"contractor" are bound to the
 * recipient's employment type; "all" can fire for any user. The settings
 * surface (GET/PUT /api/my/notification-settings) is scoped by this map so
 * users never see toggles for events that cannot apply to them.
 */
export type EventAudience = "admin" | "w2" | "contractor" | "all";

export const EVENT_AUDIENCE: Partial<Record<EventType, EventAudience>> = {
  [EVENT_TYPE.payrollDraftReady]: "admin",
  [EVENT_TYPE.changeRequestSubmitted]: "admin",
  [EVENT_TYPE.taxDepositDue]: "admin",
  [EVENT_TYPE.taxFilingDue]: "admin",
  [EVENT_TYPE.payslipIssued]: "w2",
  [EVENT_TYPE.w2Available]: "w2",
  [EVENT_TYPE.contractorInvoiceReviewed]: "contractor",
  [EVENT_TYPE.contractorInvoicePaid]: "contractor",
  [EVENT_TYPE.changeRequestApproved]: "all",
  [EVENT_TYPE.changeRequestDenied]: "all",
};

/**
 * The workflow events relevant to a viewer. Admins keep the full list
 * (admin views are unaffected by PAY-8). A user with no linked employee
 * record yet (employmentType null) sees every non-admin event — the
 * worker-type-bound events become relevant the moment the record exists.
 */
export function workflowEventsFor(viewer: {
  isAdmin: boolean;
  employmentType?: string | null;
}): readonly EventType[] {
  if (viewer.isAdmin) return WORKFLOW_EVENTS;
  return WORKFLOW_EVENTS.filter((eventType) => {
    const audience = EVENT_AUDIENCE[eventType] ?? "all";
    if (audience === "all") return true;
    if (audience === "admin") return false;
    if (viewer.employmentType == null) return true;
    if (audience === "w2") return viewer.employmentType === "w2";
    return viewer.employmentType === "1099";
  });
}

/**
 * Spec 10 contractor events — compliance notices to admins (form expiry,
 * payment gate, recurring scheduler) and contractor-facing invoice lifecycle
 * mail. The admin-facing ones are always on; the contractor-facing ones
 * (invoice reviewed / paid) are user-toggleable via WORKFLOW_EVENTS
 * (PAY-7/D3, 2026-08-21).
 */
export const CONTRACTOR_EVENTS: readonly EventType[] = [
  EVENT_TYPE.contractorInvoiceSubmitted,
  EVENT_TYPE.contractorInvoiceReviewed,
  EVENT_TYPE.contractorInvoicePaid,
  EVENT_TYPE.contractorFormExpiring,
  EVENT_TYPE.contractorFormExpired,
  EVENT_TYPE.contractorRecurringGenerated,
  EVENT_TYPE.contractorRecurringPaymentDue,
];

export const SECURITY_EVENTS: readonly EventType[] = [
  EVENT_TYPE.securityInvite,
  EVENT_TYPE.securityPasswordReset,
  EVENT_TYPE.securityLoginNewDevice,
  EVENT_TYPE.adminTestEmail,
];

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface TemplateContext {
  companyName: string;
  /** Product name (spec 22), from AppConfig.brandName. */
  brandName: string;
  /** Public app URL for "log in" links (no deep links to sensitive data). */
  appUrl: string;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Footer sentence (spec 22 D4), shared by the HTML and plain-text bodies. */
function footer(companyName: string, brandName: string): string {
  return `Sent by ${brandName} on behalf of ${companyName}. This is an automated message — please don't reply. Questions? Contact ${companyName} directly.`;
}

function page(ctx: TemplateContext, bodyHtml: string): string {
  const company = escapeHtml(ctx.companyName);
  return `<!doctype html>
<html><body style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
<h2 style="margin:0 0 16px">${company}</h2>
${bodyHtml}
<p style="color:#777;font-size:12px;margin-top:32px">${footer(company, escapeHtml(ctx.brandName))}</p>
</body></html>`;
}

function email(
  ctx: TemplateContext,
  subject: string,
  bodyHtml: string,
  text: string,
): RenderedEmail {
  return {
    subject: `${ctx.companyName} — ${subject}`,
    html: page(ctx, bodyHtml),
    text: `${text}\n\n${footer(ctx.companyName, ctx.brandName)}`,
  };
}

const CHANGE_REQUEST_LABELS: Record<string, string> = {
  address: "address",
  mailing_address: "mailing address",
  w4: "withholding (W-4) election",
  state_election: "state withholding election",
  bank_details: "bank details",
  legal_name: "legal name",
  tax_id: "tax ID",
};

export function crLabel(requestType: string): string {
  return CHANGE_REQUEST_LABELS[requestType] ?? requestType;
}

// ---------------------------------------------------------------------------
// Workflow events
// ---------------------------------------------------------------------------

export function payrollDraftReady(
  ctx: TemplateContext,
  data: { employeeName: string; periodStart: string; periodEnd: string; payDate: string },
): RenderedEmail {
  const body = `<p>A payroll draft for <strong>${escapeHtml(data.employeeName)}</strong> (period ${data.periodStart} → ${data.periodEnd}, pay date ${data.payDate}) awaits your review.</p><p><a href="${ctx.appUrl}">Log in to review and approve</a>.</p>`;
  return email(
    ctx,
    "payroll draft ready",
    body,
    `A payroll draft for ${data.employeeName} (period ${data.periodStart} to ${data.periodEnd}, pay date ${data.payDate}) awaits your review. Log in to approve: ${ctx.appUrl}`,
  );
}

export function payslipIssued(
  ctx: TemplateContext,
  data: { periodLabel: string; payDate: string },
): RenderedEmail {
  // Spec: period + "log in to view/download" — NEVER net pay, NEVER attachments.
  const body = `<p>Your payslip for <strong>${escapeHtml(data.periodLabel)}</strong> (pay date ${data.payDate}) has been issued.</p><p><a href="${ctx.appUrl}">Log in to view and download it</a>.</p>`;
  return email(
    ctx,
    "payslip issued",
    body,
    `Your payslip for ${data.periodLabel} (pay date ${data.payDate}) has been issued. Log in to view and download it: ${ctx.appUrl}`,
  );
}

export function changeRequestSubmitted(
  ctx: TemplateContext,
  data: { employeeName: string; requestType: string },
): RenderedEmail {
  // Spec: never amounts — type + employee only.
  const label = crLabel(data.requestType);
  const body = `<p><strong>${escapeHtml(data.employeeName)}</strong> submitted a change request for their <strong>${label}</strong>.</p><p><a href="${ctx.appUrl}">Log in to review the request</a>.</p>`;
  return email(
    ctx,
    "change request submitted",
    body,
    `${data.employeeName} submitted a change request for their ${label}. Log in to review: ${ctx.appUrl}`,
  );
}

export function changeRequestApproved(
  ctx: TemplateContext,
  data: { requestType: string; effectiveFrom: string },
): RenderedEmail {
  const label = crLabel(data.requestType);
  const body = `<p>Your change request for your <strong>${label}</strong> was approved, effective ${data.effectiveFrom}.</p><p><a href="${ctx.appUrl}">Log in to view details</a>.</p>`;
  return email(
    ctx,
    "change request approved",
    body,
    `Your change request for your ${label} was approved, effective ${data.effectiveFrom}. Log in to view details: ${ctx.appUrl}`,
  );
}

export function changeRequestDenied(
  ctx: TemplateContext,
  data: { requestType: string },
): RenderedEmail {
  const label = crLabel(data.requestType);
  const body = `<p>Your change request for your <strong>${label}</strong> was denied.</p><p><a href="${ctx.appUrl}">Log in to view the reason and thread</a>.</p>`;
  return email(
    ctx,
    "change request denied",
    body,
    `Your change request for your ${label} was denied. Log in to view the reason: ${ctx.appUrl}`,
  );
}

// ---------------------------------------------------------------------------
// Security events (always on)
// ---------------------------------------------------------------------------

function inviteLead(company: string, brand: string): string {
  return `${company} has invited you to view your pay and tax documents in ${brand}, the payroll system ${company} uses.`;
}

export function securityInvite(ctx: TemplateContext, data: { setupLink: string }): RenderedEmail {
  const lead = inviteLead(escapeHtml(ctx.companyName), escapeHtml(ctx.brandName));
  const body = `<p>${lead}</p><p><a href="${data.setupLink}">Set up your account</a> (single-use link, valid 24 hours). You will choose a password and enroll an authenticator app.</p>`;
  return email(
    ctx,
    "you're invited",
    body,
    `${inviteLead(ctx.companyName, ctx.brandName)} Set up your account with this single-use link (valid 24 hours): ${data.setupLink}`,
  );
}

export function securityPasswordReset(
  ctx: TemplateContext,
  data: { setupLink: string },
): RenderedEmail {
  const company = escapeHtml(ctx.companyName);
  const body = `<p>Someone asked to reset the password for your ${company} account in ${escapeHtml(ctx.brandName)}. You will need to set a new password and re-enroll your authenticator app.</p><p><a href="${data.setupLink}">Reset your password</a> (single-use link, valid 24 hours). If you did not request this, contact ${company}.</p>`;
  return email(
    ctx,
    "password reset",
    body,
    `Someone asked to reset the password for your ${ctx.companyName} account in ${ctx.brandName}. Reset with this single-use link (valid 24 hours): ${data.setupLink} If you did not request this, contact ${ctx.companyName}.`,
  );
}

export function securityLoginNewDevice(
  ctx: TemplateContext,
  data: { userAgent: string | null; ip: string | null; at: string },
): RenderedEmail {
  const ua = data.userAgent ?? "unknown device";
  const ip = data.ip ?? "unknown IP";
  const company = escapeHtml(ctx.companyName);
  const body = `<p>Your ${company} account in ${escapeHtml(ctx.brandName)} was just signed in to from a device we haven't seen before:</p><ul><li>Device: ${escapeHtml(ua)}</li><li>IP: ${escapeHtml(ip)}</li><li>Time: ${escapeHtml(data.at)}</li></ul><p>If this wasn't you, contact ${company} right away.</p>`;
  return email(
    ctx,
    "new device sign-in",
    body,
    `Your ${ctx.companyName} account in ${ctx.brandName} was just signed in to from a device we haven't seen before: Device: ${ua}; IP: ${ip}; Time: ${data.at}. If this wasn't you, contact ${ctx.companyName} right away.`,
  );
}

export function adminTestEmail(ctx: TemplateContext, data: { by: string }): RenderedEmail {
  const body = `<p>This is a test email from ${escapeHtml(ctx.brandName)} settings for ${escapeHtml(ctx.companyName)}, requested by ${escapeHtml(data.by)}. Email delivery is working.</p>`;
  return email(
    ctx,
    "test email",
    body,
    `This is a test email from ${ctx.brandName} settings for ${ctx.companyName}, requested by ${data.by}. Email delivery is working.`,
  );
}

// ---------------------------------------------------------------------------
// Spec 10 — contractor invoice workflow + W-8 form lifecycle
// ---------------------------------------------------------------------------

const TAX_FORM_LABELS: Record<string, string> = {
  w9: "W-9",
  w8ben: "W-8BEN",
  w8ben_e: "W-8BEN-E",
  w8eci: "W-8ECI",
};

export function taxFormLabel(taxForm: string): string {
  return TAX_FORM_LABELS[taxForm] ?? taxForm.toUpperCase();
}

/** Admin: a contractor self-submitted an invoice (D16 portal; V1 invoices are admin-entered). */
export function contractorInvoiceSubmitted(
  ctx: TemplateContext,
  data: { contractorName: string; description: string },
): RenderedEmail {
  const body = `<p><strong>${escapeHtml(data.contractorName)}</strong> submitted an invoice: ${escapeHtml(data.description)}.</p><p><a href="${ctx.appUrl}">Log in to review it</a>.</p>`;
  return email(
    ctx,
    "contractor invoice submitted",
    body,
    `${data.contractorName} submitted an invoice (${data.description}). Log in to review it: ${ctx.appUrl}`,
  );
}

/** Contractor: their invoice was approved or rejected (no amounts). */
export function contractorInvoiceReviewed(
  ctx: TemplateContext,
  data: { description: string; approved: boolean; note: string | null },
): RenderedEmail {
  const decision = data.approved ? "approved" : "rejected";
  const notePart = data.note ? ` Note: ${escapeHtml(data.note)}` : "";
  const body = `<p>Your invoice (${escapeHtml(data.description)}) was <strong>${decision}</strong>.${notePart}</p><p><a href="${ctx.appUrl}">Log in to view details</a>.</p>`;
  const textNote = data.note ? ` Note: ${data.note}` : "";
  return email(
    ctx,
    `invoice ${decision}`,
    body,
    `Your invoice (${data.description}) was ${decision}.${textNote} Log in to view details: ${ctx.appUrl}`,
  );
}

/** Contractor: payment recorded against their invoice. */
export function contractorInvoicePaid(
  ctx: TemplateContext,
  data: { description: string; payDate: string },
): RenderedEmail {
  const body = `<p>Payment for your invoice (${escapeHtml(data.description)}) was recorded, pay date ${data.payDate}.</p><p><a href="${ctx.appUrl}">Log in to view details</a>.</p>`;
  return email(
    ctx,
    "invoice paid",
    body,
    `Payment for your invoice (${data.description}) was recorded, pay date ${data.payDate}. Log in to view details: ${ctx.appUrl}`,
  );
}

/** Admin: a contractor's W-8 expires within 30 days — collect a renewal before the payment gate re-arms. */
export function contractorFormExpiring(
  ctx: TemplateContext,
  data: { contractorName: string; taxForm: string; expiresAt: string; daysLeft: number },
): RenderedEmail {
  const form = taxFormLabel(data.taxForm);
  const body = `<p>The <strong>${form}</strong> on file for <strong>${escapeHtml(data.contractorName)}</strong> expires on ${data.expiresAt} (${data.daysLeft} days). Collect a renewal — payments are blocked once the form expires.</p><p><a href="${ctx.appUrl}">Log in to update the record</a>.</p>`;
  return email(
    ctx,
    `contractor ${form} expiring`,
    body,
    `The ${form} on file for ${data.contractorName} expires on ${data.expiresAt} (${data.daysLeft} days). Collect a renewal — payments are blocked once the form expires: ${ctx.appUrl}`,
  );
}

/** Admin: a contractor's form expired — the payment gate has re-armed. */
export function contractorFormExpired(
  ctx: TemplateContext,
  data: { contractorName: string; taxForm: string; expiresAt: string },
): RenderedEmail {
  const form = taxFormLabel(data.taxForm);
  const body = `<p>The <strong>${form}</strong> on file for <strong>${escapeHtml(data.contractorName)}</strong> expired on ${data.expiresAt}. Payments are blocked until a new form is collected.</p><p><a href="${ctx.appUrl}">Log in to update the record</a>.</p>`;
  return email(
    ctx,
    `contractor ${form} expired`,
    body,
    `The ${form} on file for ${data.contractorName} expired on ${data.expiresAt}. Payments are blocked until a new form is collected: ${ctx.appUrl}`,
  );
}

// ---------------------------------------------------------------------------
// Spec 12 — recurring contractor invoices
// ---------------------------------------------------------------------------

/** Admin: the recurring scheduler generated an invoice — it awaits approval (spec 12 §2). */
export function contractorRecurringGenerated(
  ctx: TemplateContext,
  data: { contractorName: string; amountLabel: string; periodLabel: string; description: string },
): RenderedEmail {
  const body = `<p>Recurring invoice for <strong>${escapeHtml(data.contractorName)}</strong> — ${escapeHtml(data.amountLabel)}, ${data.periodLabel} — was generated and is awaiting your approval (${escapeHtml(data.description)}).</p><p><a href="${ctx.appUrl}">Log in to review it</a>.</p>`;
  return email(
    ctx,
    "recurring invoice awaiting approval",
    body,
    `Recurring invoice for ${data.contractorName} — ${data.amountLabel}, ${data.periodLabel} — was generated and is awaiting your approval (${data.description}). Log in to review it: ${ctx.appUrl}`,
  );
}

/** Admin: pay day arrived and the generated invoice is approved but unpaid (spec 12 §3). */
export function contractorRecurringPaymentDue(
  ctx: TemplateContext,
  data: { contractorName: string; amountLabel: string; description: string },
): RenderedEmail {
  const body = `<p>Payment due today: <strong>${escapeHtml(data.contractorName)}</strong> — ${escapeHtml(data.amountLabel)} (${escapeHtml(data.description)}). The invoice is approved but no payment is recorded.</p><p><a href="${ctx.appUrl}">Log in to record the payment</a>.</p>`;
  return email(
    ctx,
    "contractor payment due today",
    body,
    `Payment due today: ${data.contractorName} — ${data.amountLabel} (${data.description}). The invoice is approved but no payment is recorded. Log in to record the payment: ${ctx.appUrl}`,
  );
}

// ---------------------------------------------------------------------------
// PAY-9 — monthly federal tax deposits (admin reminder)
// ---------------------------------------------------------------------------

/**
 * Admin: a monthly deposit's configured reminder offset landed today.
 * Informational/record-only (D3): EFTPS has no API — the email points the
 * admin at eftps.gov and the app's deposit list; the actual payment always
 * happens on eftps.gov.
 */
export function taxDepositDue(
  ctx: TemplateContext,
  data: {
    jurisdiction: string;
    periodLabel: string;
    amountLabel: string;
    dueDate: string;
    /** PAY-193: an additional (seq > 0) deposit for an already-paid period. */
    additional?: boolean;
  },
): RenderedEmail {
  const jurisdiction = data.jurisdiction === "federal" ? "Federal" : data.jurisdiction;
  const body = `<p>The <strong>${escapeHtml(jurisdiction)}</strong> payroll tax deposit for <strong>${escapeHtml(data.periodLabel)}</strong> — ${escapeHtml(data.amountLabel)} — is due on <strong>${data.dueDate}</strong>.</p><p>Make the payment on eftps.gov, then <a href="${ctx.appUrl}">log in to record the deposit and EFTPS confirmation number</a>.</p>`;
  return email(
    ctx,
    `${data.additional ? "Additional tax" : "tax"} deposit due ${data.dueDate}`,
    body,
    `The ${jurisdiction} payroll tax deposit for ${data.periodLabel} (${data.amountLabel}) is due on ${data.dueDate}. Make the payment on eftps.gov, then log in to record it: ${ctx.appUrl}`,
  );
}

/**
 * Admin (PAY-91): the daily deposit sync could not work out one state's
 * deposits for a period (bad payroll data, e.g. a negative withholding
 * total). That period was skipped; everything else was updated. No amounts.
 */
export function taxDepositSyncFailed(
  ctx: TemplateContext,
  data: { jurisdictionLabel: string; periodLabel: string },
): RenderedEmail {
  const state = escapeHtml(data.jurisdictionLabel);
  const period = escapeHtml(data.periodLabel);
  const depositsUrl = `${ctx.appUrl}/admin/deposits`;
  const body = `<p>We couldn't work out the <strong>${state}</strong> tax deposits for <strong>${period}</strong>. Until this is fixed, the ${state} amount for ${period} may not be right. Check it before you pay.</p><p>The payroll data for that period needs checking; every other deposit was updated as usual. <a href="${depositsUrl}">Open your tax deposits</a>, and contact support about this period.</p>`;
  return email(
    ctx,
    `${data.jurisdictionLabel} tax deposits for ${data.periodLabel} need checking`,
    body,
    `We couldn't work out the ${data.jurisdictionLabel} tax deposits for ${data.periodLabel}. Until this is fixed, the ${data.jurisdictionLabel} amount for ${data.periodLabel} may not be right. Check it before you pay. The payroll data for that period needs checking; every other deposit was updated as usual. Open your tax deposits, and contact support about this period: ${depositsUrl}`,
  );
}

/**
 * Admin (PAY-193): a payroll was issued for a period whose deposit was
 * already made (or already due), so an additional deposit row was created
 * for the difference. One mail per new row. No amounts — the app shows them.
 * `earlierDeposited`: some earlier row of the period is deposited ("was
 * made"); otherwise the earlier row is unpaid ("was already due").
 */
export function taxDepositShortfall(
  ctx: TemplateContext,
  data: {
    jurisdictionLabel: string;
    periodLabel: string;
    overdue: boolean;
    earlierDeposited: boolean;
  },
): RenderedEmail {
  const j = data.jurisdictionLabel;
  const period = data.periodLabel;
  const depositsUrl = `${ctx.appUrl}/admin/deposits`;
  const sentences = [
    data.earlierDeposited
      ? `A payroll for ${period} was issued after the ${j} deposit for that period was made.`
      : `A payroll for ${period} was issued after the ${j} deposit for that period was already due, so its taxes weren't included in it.`,
    `${ctx.brandName} added an additional deposit for the difference.`,
    "Open Tax deposits to see the amount and due date.",
    ...(data.overdue ? ["It is already past its due date."] : []),
  ].join(" ");
  const body = `<p>${escapeHtml(sentences)}</p><p><a href="${depositsUrl}">${escapeHtml(depositsUrl)}</a></p>`;
  return email(
    ctx,
    `Additional ${j} tax deposit for ${period}`,
    body,
    `${sentences} ${depositsUrl}`,
  );
}

// ---------------------------------------------------------------------------
// PAY-10 — quarterly filing (Form 941) due-date reminder (admin)
// ---------------------------------------------------------------------------

/**
 * Admin: a quarterly filing's configured reminder offset landed today.
 * Record-only (D2): the app computes the worksheet and tracks the filing;
 * the admin files by mail (Letterstream) or e-file and marks it filed here.
 */
export function taxFilingDue(
  ctx: TemplateContext,
  data: { formLabel: string; periodLabel: string; dueDate: string },
): RenderedEmail {
  const body = `<p><strong>${escapeHtml(data.formLabel)}</strong> for <strong>${escapeHtml(data.periodLabel)}</strong> is due on <strong>${data.dueDate}</strong> and has not been marked as filed.</p><p>File the return, then <a href="${ctx.appUrl}">log in to record the filing date and reference</a>.</p>`;
  return email(
    ctx,
    `${data.formLabel} for ${data.periodLabel} due ${data.dueDate}`,
    body,
    `${data.formLabel} for ${data.periodLabel} is due on ${data.dueDate} and has not been marked as filed. File the return, then log in to record it: ${ctx.appUrl}`,
  );
}

// ---------------------------------------------------------------------------
// PAY-11 — W-2 availability notice (employee)
// ---------------------------------------------------------------------------

/**
 * Employee: their W-2 for a tax year is available (January of the following
 * year). Content rules: states the tax year + "log in to view/download" —
 * never amounts, never the SSN, no attachment (same doctrine as
 * payslip_issued).
 */
export function w2Available(ctx: TemplateContext, data: { taxYear: number }): RenderedEmail {
  const body = `<p>Your <strong>W-2 for ${data.taxYear}</strong> is available.</p><p><a href="${ctx.appUrl}">Log in to view and download it</a> from your payslips page.</p>`;
  return email(
    ctx,
    `your ${data.taxYear} W-2 is available`,
    body,
    `Your W-2 for ${data.taxYear} is available. Log in to view and download it: ${ctx.appUrl}`,
  );
}
