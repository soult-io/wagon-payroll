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

import {
  addressLine,
  electronicW2AccessThrough,
  longIsoDate,
  PAYSLIPS_NAV_LABEL,
  W2_CARD_HEADING,
  type W2Contact,
} from "@payroll/shared";

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
  /**
   * PAY-226 — an additional deposit that was mailed (taxDepositShortfall) is
   * no longer needed: the quarter's deposits cover it (admin, always on).
   */
  taxDepositShortfallCancelled: "tax_deposit_shortfall_cancelled",
  /** PAY-10 — quarterly filing (Form 941) due-date reminder (admin). */
  taxFilingDue: "tax_filing_due",
  /**
   * PAY-11 — the year notice of an employee's W-2. PAY-208 (OD6, 26 CFR
   * 31.6051-1(j)(5)(i)): always on — for a consenter it is the legal notice
   * of the online W-2, so it is not in WORKFLOW_EVENTS.
   */
  w2Available: "w2_available",
  /**
   * PAY-193 L4 — a late-issued payroll changed an employee's already-released
   * W-2. Always on (not in WORKFLOW_EVENTS): a corrected W-2 notice is not
   * opt-out-able.
   */
  w2Changed: "w2_changed",
  /** PAY-208 ((j)(3)(v)(B)) — written confirmation of a withdrawal. Always on. */
  w2ConsentWithdrawn: "w2_consent_withdrawn",
  /** PAY-208 ((j)(3)(vii)) — the employer's W-2 contact details changed. Always on. */
  w2ContactChanged: "w2_contact_changed",
  /** PAY-208 (D-D) — please review and agree to the updated online-W-2 terms. Always on. */
  w2TermsUpdated: "w2_terms_updated",
  /** PAY-208 (D-A) — an admin changed the employee's sign-in email. Always on. */
  signInEmailChanged: "sign_in_email_changed",
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

/**
 * Admin (PAY-226): an additional deposit the owner was mailed about
 * (taxDepositShortfall) was cancelled, because deposits made for other months
 * of the same quarter already cover it (IRC 6656(e); Pub 15 §11). One mail
 * per sync, naming every cancelled month. No amounts — the app shows them.
 */
export function taxDepositShortfallCancelled(
  ctx: TemplateContext,
  data: { jurisdictionLabel: string; periodLabels: readonly string[] },
): RenderedEmail {
  const periods = joinLabels(data.periodLabels);
  const depositsUrl = `${ctx.appUrl}/admin/deposits`;
  const sentence =
    data.periodLabels.length > 1
      ? `No payment needed — the earlier deposit notices for ${periods} were cancelled; your deposits for the quarter already cover them.`
      : `No payment needed — the earlier deposit notice for ${periods} was cancelled; your deposits for the quarter already cover it.`;
  const body = `<p>${escapeHtml(sentence)}</p><p><a href="${depositsUrl}">${escapeHtml(depositsUrl)}</a></p>`;
  return email(
    ctx,
    `No additional ${data.jurisdictionLabel} tax deposit needed for ${periods}`,
    body,
    `${sentence} ${depositsUrl}`,
  );
}

/** "A", "A and B", "A, B and C". */
function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
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
// PAY-11 / PAY-208 — W-2 year notice (employee)
// ---------------------------------------------------------------------------

/** HTML paragraphs from plain sentences (escaped). URLs stay plain text. */
function paragraphs(parts: readonly string[]): string {
  return parts.map((p) => `<p>${escapeHtml(p)}</p>`).join("");
}

/** {subject-less} body as both HTML and text from the same paragraphs. */
function bodyOf(ctx: TemplateContext, parts: readonly string[]): { html: string; text: string } {
  return {
    html: page(ctx, paragraphs(parts)),
    text: `${parts.join("\n\n")}\n\n${footer(ctx.companyName, ctx.brandName)}`,
  };
}

/** Like email(), for a body written as paragraphs. */
function paragraphEmail(
  ctx: TemplateContext,
  subject: string,
  parts: readonly string[],
): RenderedEmail {
  return { subject: `${ctx.companyName} — ${subject}`, ...bodyOf(ctx, parts) };
}

/** "W-2 Desk: +1 555 0100, w2@example.com, 100 Example Street, …" */
function contactLine(c: W2Contact): string {
  const address = addressLine(c.mailingAddress);
  return [c.phone, c.email, ...(address ? [address] : [])].join(", ");
}

/**
 * Employee: their W-2 for a tax year (January of the following year). Two
 * variants by the electronic channel of that year (PAY-208, 26 CFR
 * 31.6051-1(j)(5)(i)):
 * - consented: the subject starts with the required IMPORTANT phrase (no
 *   company prefix in front of it); the body says how to access AND print
 *   it and until when it stays online (electronicW2AccessThrough);
 * - paper: a courtesy notice only — no IMPORTANT phrase, never "available";
 *   the employer gives a paper W-2. The switch-online line only when the
 *   employee can switch (active, a sign-in, a W-2 contact on file).
 * Never amounts, never the SSN, no attachment, no link with identifiers.
 */
export function w2Available(
  ctx: TemplateContext,
  data: {
    taxYear: number;
    consented: boolean;
    contact: W2Contact | null;
    canSwitchOnline: boolean;
  },
): RenderedEmail {
  const year = data.taxYear;
  const co = ctx.companyName;
  if (data.consented) {
    const through = longIsoDate(electronicW2AccessThrough(year));
    const parts = [
      `Your ${year} Form W-2 from ${co} is ready.`,
      `To view and print it, sign in at ${ctx.appUrl}, open ${PAYSLIPS_NAV_LABEL}, and find "${W2_CARD_HEADING}". Select Download PDF, then print or save it from your PDF reader. It stays available there through ${through}.`,
      "Keep a copy with your tax records. You may need to print it and attach it to your tax return.",
      ...(data.contact
        ? [`Want a paper copy too? Ask ${data.contact.name} at ${data.contact.email}.`]
        : []),
    ];
    return {
      subject: `IMPORTANT TAX RETURN DOCUMENT AVAILABLE: Your ${year} W-2 from ${co}`,
      ...bodyOf(ctx, parts),
    };
  }
  const parts = [
    `${co} will give you your ${year} Form W-2 on paper. This email is a notice only and is not your W-2.`,
    ...(data.canSwitchOnline
      ? [
          `Prefer to get it online? Sign in at ${ctx.appUrl}, open ${PAYSLIPS_NAV_LABEL}, and agree to the terms under "${W2_CARD_HEADING}". You can then download it there.`,
        ]
      : []),
  ];
  return paragraphEmail(ctx, `Your ${year} W-2 will be given to you on paper`, parts);
}

// ---------------------------------------------------------------------------
// PAY-208 — online W-2 agreement: withdrawal, contact change, updated terms
// ---------------------------------------------------------------------------

/**
 * Employee ((j)(3)(v)(B)): written confirmation of a withdrawal and the date
 * it takes effect (`effectiveOn`, company-local ISO date; shown long). Says
 * what changes ((j)(7)), what does not ((v)(C), (j)(6)), how to agree again,
 * and the W-2 contact. No amounts, no SSN, no links.
 */
export function w2ConsentWithdrawn(
  ctx: TemplateContext,
  data: {
    effectiveOn: string;
    contact: W2Contact | null;
    /** PAY-208 (N1): W-2s already given online and still available, with their last day (ISO). */
    stillOnline?: readonly { taxYear: number; accessThrough: string }[];
  },
): RenderedEmail {
  const still = (data.stillOnline ?? [])
    .map((w) => `Your ${w.taxYear} W-2 stays available through ${longIsoDate(w.accessThrough)}.`)
    .join(" ");
  const parts = [
    `This confirms that you withdrew your agreement to get your W-2s online. It takes effect on ${longIsoDate(data.effectiveOn)}.`,
    `From that date, ${ctx.companyName} will give you your W-2s on paper.`,
    `W-2s given to you online before that date don't change. Each one stays available through at least October 15 of the year after its tax year: sign in at ${ctx.appUrl}, open ${PAYSLIPS_NAV_LABEL}, and find "${W2_CARD_HEADING}".${still ? ` ${still}` : ""}`,
    `To get your W-2s online again, sign in, open ${PAYSLIPS_NAV_LABEL}, and agree to the terms.`,
    data.contact
      ? `Questions, or didn't ask for this? Contact ${data.contact.name}: ${contactLine(data.contact)}.`
      : `Questions, or didn't ask for this? Contact ${ctx.companyName}.`,
  ];
  return paragraphEmail(ctx, "Your online W-2 withdrawal is confirmed", parts);
}

/** Employee ((j)(3)(vii), 2nd sentence): the new W-2 contact details. Nothing else. */
export function w2ContactChanged(
  ctx: TemplateContext,
  data: { contact: W2Contact },
): RenderedEmail {
  const c = data.contact;
  const lead = `${ctx.companyName} has new contact details for W-2 questions, paper copy requests and withdrawing from online W-2s:`;
  const lines = [c.name, addressLine(c.mailingAddress), c.phone, c.email].filter((l) => l !== "");
  const html = `<p>${escapeHtml(lead)}</p><p>${lines.map(escapeHtml).join("<br>")}</p>`;
  return email(ctx, "New contact for your W-2 questions", html, `${lead}\n${lines.join("\n")}`);
}

/**
 * Employee (PAY-208 D-D): the online-W-2 terms changed; their agreement to
 * the earlier terms does not cover W-2s from `gateYear` on. Asks them to
 * review and agree again. Once per employee per terms version.
 */
export function w2TermsUpdated(ctx: TemplateContext, data: { gateYear: number }): RenderedEmail {
  const co = ctx.companyName;
  const parts = [
    `${co} has updated the terms for getting your W-2 online.`,
    `To keep getting your W-2s online, sign in at ${ctx.appUrl}, open ${PAYSLIPS_NAV_LABEL}, read the updated terms under "${W2_CARD_HEADING}", and agree to them again.`,
    `Until you do, ${co} will give you your W-2s for ${data.gateYear} and later on paper. W-2s you already have online stay available.`,
  ];
  return paragraphEmail(ctx, "Please review the updated terms for your online W-2s", parts);
}

/**
 * Employee (PAY-208 D-A): an administrator changed the email address they
 * sign in with. Sent to the old AND the new address. No address in the body.
 */
export function signInEmailChanged(ctx: TemplateContext): RenderedEmail {
  const co = ctx.companyName;
  const parts = [
    `An administrator at ${co} changed the email address you use to sign in to ${ctx.brandName}.`,
    "From now on, sign in with the new address. Your W-2 emails and other notices go to the new address.",
    `If you didn't ask for this, contact ${co} right away.`,
  ];
  return paragraphEmail(ctx, "Your sign-in email was changed", parts);
}

// ---------------------------------------------------------------------------
// PAY-193 L4 — W-2 changed notice (employee)
// ---------------------------------------------------------------------------

/**
 * Employee: a payroll issued late changed their W-2 for a tax year after the
 * w2_available notice went out. Two variants by electronic W-2 consent
 * (federal-payroll-tax-sme ruling: 26 CFR 31.6051-1(j)(1),(j)(5); iw2w3 2026
 * "Correcting Forms W-2 and W-3"):
 * - consented: the subject starts with the required IMPORTANT phrase (no
 *   company prefix in front of it) and the body says where to get the copy;
 * - not consented (paper): a courtesy notice only — no IMPORTANT phrase, no
 *   link, never "available"; the employer hands over a corrected paper W-2.
 * Never amounts, never the SSN.
 */
/** PAY-217 round 2 (F1): the print step, as in the w2Available notice. */
const PRINT_STEP = "Select Download PDF, then print or save it from your PDF reader.";

export function w2Changed(
  ctx: TemplateContext,
  data: {
    taxYear: number;
    consented: boolean;
    /**
     * PAY-208 (N2, (j)(6)): ISO date the corrected W-2 stays online through
     * (electronicW2AccessThrough(year, posted on)); consented variant only.
     */
    accessThrough?: string;
    /**
     * PAY-217: the employee's job has ended — the W-2 page is the only page
     * after sign-in. Consented variant only.
     */
    former?: boolean;
    /**
     * PAY-217 (SME R2, round 2 N3): the employee left the electronic channel
     * (withdrawal or termination) — the company also gives a paper copy.
     * Consented variant only.
     */
    paperToo?: boolean;
  },
): RenderedEmail {
  const year = data.taxYear;
  if (data.consented) {
    const through = data.accessThrough
      ? ` It stays available there through ${longIsoDate(data.accessThrough)}.`
      : "";
    const lead = (co: string) =>
      `${co} has corrected your ${year} Form W-2. The corrected W-2 is marked CORRECTED and replaces the earlier one. Use the corrected W-2 for your tax return.`;
    const paper = (co: string) => (data.paperToo ? ` ${co} will also give you a paper copy.` : "");
    const tail =
      "If you already filed your return using the earlier W-2, you may need to amend it.";
    const where = (signIn: string) =>
      data.former
        ? `To view and print it, sign in at ${signIn}. Your W-2s open right after you sign in. ${PRINT_STEP}`
        : `To view and print it, sign in at ${signIn}, open ${PAYSLIPS_NAV_LABEL}, and find "${W2_CARD_HEADING}". ${PRINT_STEP}`;
    const appUrl = escapeHtml(ctx.appUrl);
    const co = escapeHtml(ctx.companyName);
    const body = `<p>${lead(co)}${paper(co)}</p><p>${where(`<a href="${appUrl}">${appUrl}</a>`)}</p><p>${tail}${through}</p>`;
    return {
      subject: `IMPORTANT TAX RETURN DOCUMENT AVAILABLE: Your corrected ${year} W-2 from ${ctx.companyName}`,
      html: page(ctx, body),
      text: `${lead(ctx.companyName)}${paper(ctx.companyName)} ${where(ctx.appUrl)} ${tail}${through}\n\n${footer(ctx.companyName, ctx.brandName)}`,
    };
  }
  const notice = (co: string) =>
    `${co} has corrected your ${year} Form W-2. ${co} will give you a corrected paper W-2, marked CORRECTED. Use the corrected paper copy for your tax return, not the earlier one. This email is a notice only and is not your W-2.`;
  return email(
    ctx,
    `Your ${year} W-2 is being corrected`,
    `<p>${notice(escapeHtml(ctx.companyName))}</p>`,
    notice(ctx.companyName),
  );
}
