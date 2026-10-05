/**
 * W-2 electronic-delivery consent (PAY-19, D4; PAY-208): an employee must
 * affirmatively agree before their W-2 is furnished electronically (26 CFR
 * 31.6051-1(j); IRS Pub 15-A (2026), "Furnishing Form W-2 to employees
 * electronically"). One row per employee, blanket across tax years until
 * withdrawn. The paper route never closes — the admin prints the employee
 * packet for anyone the electronic channel does not cover.
 *
 * PAY-208:
 *  - The (j)(3) disclosures are versioned (W2_DISCLOSURES_BY_VERSION). The
 *    "2025-01" text is kept byte-for-byte as the record of what earlier
 *    consenters saw; "2026-10" covers (j)(3)(ii)-(viii) and (j)(2)(iii),
 *    names the W-2 contact and carries the federal SME's (j)(3)(viii) date
 *    sentence verbatim.
 *  - consentCoversYear is the one re-consent rule: an active consent covers
 *    tax year Y when Y < 2026 or its version is in
 *    W2_CONSENT_VERSIONS_FROM_2026. electronicW2Channel adds a login and
 *    employees.status = 'active' (a terminated employee's login is banned).
 *  - Consent names the version it agrees to (409 disclosure_changed), needs
 *    a complete W-2 contact (409 w2_contact_missing) and the PDF access
 *    check (409 access_check_failed; (j)(2)(i)).
 *  - A withdrawal queues its written confirmation ((j)(3)(v)(B)) in the
 *    same transaction; a contact change mails the new details to every
 *    active consenter ((j)(3)(vii)).
 */

import { and, eq, inArray, isNotNull, isNull, like } from "drizzle-orm";
import {
  auditEvents,
  company,
  emailOutbox,
  employees,
  w2DeliveryConsents,
  w2Furnishings,
} from "@payroll/db";
import {
  EVENT_TYPE,
  w2ConsentWithdrawn as tplWithdrawn,
  w2ContactChanged as tplContactChanged,
  w2TermsUpdated as tplTermsUpdated,
} from "@payroll/notifications";
import {
  addressLine,
  electronicW2AccessThrough,
  W2_CONSENT_GATE_FROM_TAX_YEAR as SHARED_GATE_YEAR,
  type PostalAddress,
  type W2Contact,
} from "@payroll/shared";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { templateContext } from "../notify/outbox.js";
import { localDate } from "../payroll/run-dates.js";
import { lockEmployee } from "../payroll/locks.js";
import { FilingServiceError } from "./shared.js";

type ReadDb = Pick<Db, "select">;

/** Version of the current disclosure text — bumped when the wording changes. */
export const W2_DISCLOSURE_VERSION = "2026-10";

/** The first tax year a consent must be on a version of the 2026 set (@payroll/shared). */
export const W2_CONSENT_GATE_FROM_TAX_YEAR = SHARED_GATE_YEAR;

/**
 * Versions whose consent covers tax years from W2_CONSENT_GATE_FROM_TAX_YEAR.
 * A wording-only change adds its version here (no re-consent); a (j)(2)(iii)
 * hardware/software change starts a new set with its own from-year.
 */
export const W2_CONSENT_VERSIONS_FROM_2026: ReadonlySet<string> = new Set(["2026-10"]);

/** What the disclosure text is rendered with: the furnisher and its W-2 contact. */
export interface DisclosureContext {
  companyName: string;
  contact: W2Contact | null;
}

/** The SME's (j)(3)(viii) sentence — fixed text, never edited. */
const SME_DATE_SENTENCE =
  "Your W-2 for a tax year will be posted here by the IRS deadline for giving W-2s to employees (usually January 31 of the following year, or the next business day if January 31 falls on a weekend or legal holiday), and will stay available here through at least October 15 of that following year.";

const DISCLOSURES_2025_01: readonly string[] = [
  "By consenting, you agree to receive your Form W-2 electronically through this portal instead of as a paper copy.",
  "You may still request a paper copy of any W-2 at any time by asking your payroll administrator; a paper copy will be provided at no charge.",
  "Your consent applies to every future tax year's W-2 until you withdraw it.",
  "You may withdraw your consent at any time on this page. Withdrawal takes effect immediately: future W-2s will be furnished on paper.",
  "To view and print your electronic W-2 you need a device with a PDF reader.",
  "Your W-2 for a tax year will be available on or before January 31 of the following year and remains accessible here through at least October 15 of that year.",
];

/** The 2026-10 bullets (copy file S1-a..S1-m with the SME copy changes). */
function disclosures202610(c: DisclosureContext): readonly string[] {
  const co = c.companyName;
  const name = c.contact?.name ?? co;
  const details = c.contact
    ? [addressLine(c.contact.mailingAddress), c.contact.phone, c.contact.email]
        .filter((p) => p !== "")
        .join(" · ")
    : "";
  return [
    `Paper is the default: if you don't agree, ${co} will give you your W-2 on paper.`,
    `What you're agreeing to: getting every W-2 ${co} gives you after you agree, including corrected W-2s, online here instead of on paper, for every tax year, until you withdraw.`,
    `Paper copy any time: you can ask ${name} for a free paper copy of any W-2, at any time. Asking for a paper copy does not withdraw your agreement.`,
    `How to withdraw: use "Withdraw my agreement" on this page at any time, or write (email or letter) to ${name}${details ? `:\n${details}` : "."}`,
    `Confirmation: ${co} will confirm your withdrawal in writing, usually by email, with the date it takes effect. A withdrawal on this page takes effect right away. A written withdrawal takes effect on the day ${co} records it, and your confirmation shows that date.`,
    "W-2s you already have: withdrawing doesn't change a W-2 given to you online before your withdrawal takes effect. That W-2 stays here through October 15 of the year after its tax year.",
    `When online W-2s stop: ${co} stops giving you new W-2s online if you withdraw, if your job with ${co} ends, or if ${co} stops offering W-2s online. After that, you get your W-2s on paper. W-2s already given to you online stay available here through October 15 of the year after their tax year, even if your job ends: you can still sign in to get them.`,
    `If the requirements change: if what you need to open your W-2 changes in a way that could stop you opening it, ${co} will tell you first and ask you to agree again.`,
    `Keeping your details current: W-2 emails go to the email address you sign in with. If it changes, tell ${name}. To change your home or mailing address, use "Request change" on your Profile page. If ${co}'s W-2 contact details change, ${co} will email you the new ones.`,
    "What you need: your W-2 is a PDF file. To view, save and print it, you need a device with a web browser, an internet connection, a PDF reader (most browsers have one built in) and a printer.",
    SME_DATE_SENTENCE,
    "Your tax return: you may need to print your W-2 and attach it to your federal, state or local income tax return.",
  ];
}

/** The disclosure text of every version an employee may have agreed to (A4). */
export const W2_DISCLOSURES_BY_VERSION: Readonly<
  Record<"2025-01" | "2026-10", (c: DisclosureContext) => readonly string[]>
> = {
  "2025-01": () => DISCLOSURES_2025_01,
  "2026-10": disclosures202610,
};

/**
 * The re-consent rule (brief A1, option B): an active (not withdrawn)
 * consent covers tax year `taxYear` when the year is before the gate year,
 * or its version is one of the versions from the gate year.
 */
export function consentCoversYear(
  row: { disclosureVersion: string; withdrawnAt: Date | null } | undefined,
  taxYear: number,
): boolean {
  if (!row || row.withdrawnAt !== null) return false;
  if (taxYear < W2_CONSENT_GATE_FROM_TAX_YEAR) return true;
  return W2_CONSENT_VERSIONS_FROM_2026.has(row.disclosureVersion);
}

// ---------------------------------------------------------------------------
// W-2 contact ((j)(3)(v)(A))
// ---------------------------------------------------------------------------

export interface W2ContactRecord {
  /** The contact with its mailing address resolved; null without name, phone and email. */
  contact: W2Contact | null;
  /** name ∧ phone ∧ email ∧ (contact address ∨ company address). */
  ready: boolean;
}

export type CompanyRow = typeof company.$inferSelect;

function isAddress(v: unknown): v is PostalAddress {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  return ["line1", "city", "state", "zip"].every((k) => typeof a[k] === "string" && a[k] !== "");
}

function contactOf(row: CompanyRow | undefined): W2ContactRecord {
  if (!row?.w2ContactName || !row.w2ContactPhone || !row.w2ContactEmail) {
    return { contact: null, ready: false };
  }
  const own = isAddress(row.w2ContactAddress) ? row.w2ContactAddress : null;
  const fallback = isAddress(row.address) ? row.address : null;
  const mailingAddress = own ?? fallback;
  return {
    contact: {
      name: row.w2ContactName,
      phone: row.w2ContactPhone,
      email: row.w2ContactEmail,
      mailingAddress,
    },
    ready: mailingAddress !== null,
  };
}

/** The company's W-2 contact (single company row). */
export async function readW2Contact(db: ReadDb): Promise<W2ContactRecord> {
  const rows = await db.select().from(company).limit(1);
  return contactOf(rows[0]);
}

/** The contact as entered (the admin form): the own address, not the resolved one. */
export async function w2ContactForAdmin(db: ReadDb): Promise<{
  name: string | null;
  phone: string | null;
  email: string | null;
  mailingAddress: PostalAddress | null;
  contactReady: boolean;
}> {
  const rows = await db.select().from(company).limit(1);
  const row = rows[0];
  return {
    name: row?.w2ContactName ?? null,
    phone: row?.w2ContactPhone ?? null,
    email: row?.w2ContactEmail ?? null,
    mailingAddress: isAddress(row?.w2ContactAddress) ? row.w2ContactAddress : null,
    contactReady: contactOf(row).ready,
  };
}

/**
 * (j)(3)(vii), 2nd sentence: one w2_contact_changed mail with `contact` to
 * every employee whose consent is not withdrawn (any version) and who has a
 * login. The one fan-out — the W-2 contact save and a company address
 * change while the contact uses that address. Caller holds the transaction.
 */
export async function queueW2ContactChanged(
  tx: Pick<Db, "select" | "insert">,
  config: AppConfig,
  companyName: string,
  contact: W2Contact,
): Promise<number> {
  const recipients = await tx
    .select({ userId: employees.userId })
    .from(w2DeliveryConsents)
    .innerJoin(employees, eq(employees.id, w2DeliveryConsents.employeeId))
    .where(and(isNull(w2DeliveryConsents.withdrawnAt), isNotNull(employees.userId)))
    .orderBy(employees.id);
  const rendered = tplContactChanged(await templateContext(tx, config, companyName), { contact });
  let notified = 0;
  for (const r of recipients) {
    if (r.userId === null) continue;
    await tx.insert(emailOutbox).values({
      userId: r.userId,
      eventType: EVENT_TYPE.w2ContactChanged,
      subject: rendered.subject,
      bodyHtml: rendered.html,
    });
    notified += 1;
  }
  return notified;
}

/**
 * F1 ((j)(3)(vii)): the company row changed from `before` to `after`. When
 * the W-2 contact is complete and has no address of its own, the company
 * address IS its mailing address — a changed address is a contact change
 * and is mailed. Returns the number of mails queued.
 */
export async function notifyIfContactAddressChanged(
  tx: Pick<Db, "select" | "insert">,
  config: AppConfig,
  before: CompanyRow,
  after: CompanyRow,
): Promise<number> {
  if (isAddress(after.w2ContactAddress)) return 0;
  if (canonical(before.address ?? null) === canonical(after.address ?? null)) return 0;
  const { contact } = contactOf(after);
  if (contact === null || contact.mailingAddress === null) return 0;
  return queueW2ContactChanged(tx, config, after.legalName, contact);
}

/** JSON with sorted keys (jsonb does not keep key order); undefined dropped. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    const entries = Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export interface W2ContactInput {
  name: string;
  phone: string;
  email: string;
  mailingAddress: PostalAddress | null;
}

/**
 * Save the W-2 contact (admin). Audited with before/after. When any value
 * actually changes, one w2_contact_changed mail to every employee with an
 * active consent (any version) and a login ((j)(3)(vii), 2nd sentence), in
 * the same transaction. Returns whether a value changed.
 */
export async function saveW2Contact(
  deps: { db: Db; config: AppConfig },
  actorId: string,
  input: W2ContactInput,
): Promise<{ changed: boolean; notified: number }> {
  return deps.db.transaction(async (tx) => {
    const rows = await tx.select().from(company).limit(1);
    const before = rows[0];
    if (!before) throw new FilingServiceError("not_found", "no company");
    const prev = {
      name: before.w2ContactName,
      phone: before.w2ContactPhone,
      email: before.w2ContactEmail,
      mailingAddress: isAddress(before.w2ContactAddress) ? before.w2ContactAddress : null,
    };
    const changed = canonical(prev) !== canonical(input);
    if (!changed) return { changed: false, notified: 0 };
    const updated = await tx
      .update(company)
      .set({
        w2ContactName: input.name,
        w2ContactPhone: input.phone,
        w2ContactEmail: input.email,
        w2ContactAddress: input.mailingAddress,
      })
      .where(eq(company.id, before.id))
      .returning();
    await tx.insert(auditEvents).values({
      actorId,
      action: "company.w2_contact.update",
      entity: "company",
      entityId: String(before.id),
      before: prev,
      after: input,
    });
    const { contact } = contactOf(updated[0]);
    if (contact === null) return { changed: true, notified: 0 };
    const notified = await queueW2ContactChanged(tx, deps.config, updated[0]!.legalName, contact);
    return { changed: true, notified };
  });
}

// ---------------------------------------------------------------------------
// Consent status, consent, withdrawal
// ---------------------------------------------------------------------------

export interface W2ConsentStatus {
  /** Active consent on the current terms (covers every tax year). */
  consented: boolean;
  /** Active consent on earlier terms: re-consent needed from the gate year. */
  outdated: boolean;
  consentedAt: string | null;
  withdrawnAt: string | null;
  /** The version the employee agreed to (null when never). */
  consentedVersion: string | null;
  /** The current version — the one `disclosures` is. */
  disclosureVersion: string;
  disclosures: readonly string[];
  contactReady: boolean;
  contact: W2Contact | null;
  /** The furnisher's legal name (the card's "{company} will give you …" lines). */
  companyName: string;
}

type ConsentRow = typeof w2DeliveryConsents.$inferSelect;

/** The employee's consent row, if any. */
export async function consentRowOf(
  db: ReadDb,
  employeeId: number,
): Promise<ConsentRow | undefined> {
  const rows = await db
    .select()
    .from(w2DeliveryConsents)
    .where(eq(w2DeliveryConsents.employeeId, employeeId))
    .limit(1);
  return rows[0];
}

function statusOf(
  row: ConsentRow | undefined,
  record: W2ContactRecord,
  companyName: string,
): W2ConsentStatus {
  const active = row !== undefined && row.withdrawnAt === null;
  const current = consentCoversYear(row, W2_CONSENT_GATE_FROM_TAX_YEAR);
  return {
    consented: current,
    outdated: active && !current,
    consentedAt: row?.consentedAt.toISOString() ?? null,
    withdrawnAt: row?.withdrawnAt?.toISOString() ?? null,
    consentedVersion: row?.disclosureVersion ?? null,
    disclosureVersion: W2_DISCLOSURE_VERSION,
    disclosures: W2_DISCLOSURES_BY_VERSION[W2_DISCLOSURE_VERSION]({
      companyName,
      contact: record.contact,
    }),
    contactReady: record.ready,
    contact: record.contact,
    companyName,
  };
}

/** Current consent state for one employee (PII-free: the employer's contact only). */
export async function w2ConsentStatus(db: ReadDb, employeeId: number): Promise<W2ConsentStatus> {
  const rows = await db.select().from(company).limit(1);
  return statusOf(await consentRowOf(db, employeeId), contactOf(rows[0]), rows[0]?.legalName ?? "");
}

/** The consent state the admin employee detail shows (no disclosure text). */
export async function w2ConsentState(
  db: ReadDb,
  employeeId: number,
): Promise<{
  state: "none" | "current" | "outdated" | "withdrawn";
  consentedAt: string | null;
  withdrawnAt: string | null;
}> {
  const row = await consentRowOf(db, employeeId);
  let state: "none" | "current" | "outdated" | "withdrawn" = "none";
  if (row !== undefined) {
    if (row.withdrawnAt !== null) state = "withdrawn";
    else state = consentCoversYear(row, W2_CONSENT_GATE_FROM_TAX_YEAR) ? "current" : "outdated";
  }
  return {
    state,
    consentedAt: row?.consentedAt.toISOString() ?? null,
    withdrawnAt: row?.withdrawnAt?.toISOString() ?? null,
  };
}

/** A refused consent: the 409 error code the route sends. */
export class W2ConsentRefused extends Error {
  constructor(public code: "disclosure_changed" | "w2_contact_missing" | "access_check_failed") {
    super(code);
  }
}

/**
 * Record (or renew) the employee's agreement to the CURRENT terms. Checks,
 * in order: the body names the current version (A5), a complete W-2 contact
 * exists (A6), and — only when something will be written — the PDF access
 * check passes ((j)(2)(i), D-B; `accessCheck` consumes the code). Already
 * on the current terms → no write. An outdated row is updated in place
 * (audit w2_consent.reconsent); none or withdrawn → w2_consent.consent.
 * Throws W2ConsentRefused.
 */
export async function consentToElectronicW2(
  db: Db,
  employeeId: number,
  actorId: string,
  opts: { disclosureVersion: unknown; accessCheck: () => boolean },
): Promise<{ status: W2ConsentStatus; change: "consent" | "reconsent" | null }> {
  if (opts.disclosureVersion !== W2_DISCLOSURE_VERSION) {
    throw new W2ConsentRefused("disclosure_changed");
  }
  if (!(await readW2Contact(db)).ready) throw new W2ConsentRefused("w2_contact_missing");
  const change = await db.transaction(async (tx) => {
    // C-L5: the employee lock orders the agreement against the year-notice
    // run (sendOneW2AvailableNotice takes the same lock).
    await lockEmployee(tx, employeeId);
    const before = await consentRowOf(tx, employeeId);
    if (consentCoversYear(before, W2_CONSENT_GATE_FROM_TAX_YEAR)) return null;
    if (!opts.accessCheck()) throw new W2ConsentRefused("access_check_failed");
    const now = new Date();
    const values = {
      disclosureVersion: W2_DISCLOSURE_VERSION,
      consentedAt: now,
      withdrawnAt: null,
      updatedAt: now,
    };
    await tx
      .insert(w2DeliveryConsents)
      .values({ employeeId, ...values })
      .onConflictDoUpdate({ target: [w2DeliveryConsents.employeeId], set: values });
    const reconsent = before !== undefined && before.withdrawnAt === null;
    await tx.insert(auditEvents).values({
      actorId,
      action: reconsent ? "w2_consent.reconsent" : "w2_consent.consent",
      entity: "w2_consent",
      entityId: String(employeeId),
      before: reconsent
        ? {
            disclosureVersion: before.disclosureVersion,
            consentedAt: before.consentedAt.toISOString(),
          }
        : { consented: false, withdrawnAt: before?.withdrawnAt?.toISOString() ?? null },
      after: { consented: true, disclosureVersion: W2_DISCLOSURE_VERSION, accessCheck: "pdf_code" },
    });
    return reconsent ? ("reconsent" as const) : ("consent" as const);
  });
  return { status: await w2ConsentStatus(db, employeeId), change };
}

export interface W2Withdrawal {
  status: W2ConsentStatus;
  /** Company-local ISO date the withdrawal took effect. */
  effectiveOn: string;
  /**
   * How the (j)(3)(v)(B) confirmation goes out: "email" (queued),
   * "paper_needed" (no sign-in to mail — the admin confirms in writing), or
   * null when nothing changed (already withdrawn).
   */
  confirmation: "email" | "paper_needed" | null;
}

/**
 * Withdraw consent (the employee on the consent page, or an admin recording
 * a written request — OD3: effective the day it is recorded, never
 * back-dated). Future W-2s go back to paper; W-2s already furnished online
 * stay reachable (D9). The withdrawal, its audit row and its confirmation
 * mail commit in one transaction, so the mail is queued once. Throws
 * not_found when nothing was ever consented; idempotent when withdrawn.
 */
export async function withdrawW2Consent(
  deps: { db: Db; config: AppConfig },
  employeeId: number,
  actorId: string,
): Promise<W2Withdrawal> {
  const { db, config } = deps;
  const out = await db.transaction(async (tx) => {
    const before = await consentRowOf(tx, employeeId);
    if (before === undefined) {
      throw new FilingServiceError("not_found", "no W-2 electronic-delivery consent on file");
    }
    if (before.withdrawnAt !== null) {
      return { withdrawnAt: before.withdrawnAt, confirmation: null };
    }
    const now = new Date();
    const effectiveOn = localDate(now, config.appTz);
    // C-L6: only the request that actually withdraws writes the audit row
    // and the confirmation mail.
    const changed = await tx
      .update(w2DeliveryConsents)
      .set({ withdrawnAt: now, updatedAt: now })
      .where(
        and(eq(w2DeliveryConsents.employeeId, employeeId), isNull(w2DeliveryConsents.withdrawnAt)),
      )
      .returning({ withdrawnAt: w2DeliveryConsents.withdrawnAt });
    if (changed.length === 0) {
      const row = await consentRowOf(tx, employeeId);
      return { withdrawnAt: row?.withdrawnAt ?? now, confirmation: null };
    }
    await tx.insert(auditEvents).values({
      actorId,
      action: "w2_consent.withdraw",
      entity: "w2_consent",
      entityId: String(employeeId),
      before: { consented: true, disclosureVersion: before.disclosureVersion },
      after: { consented: false, effectiveOn },
    });
    const emp = await tx
      .select({ userId: employees.userId })
      .from(employees)
      .where(eq(employees.id, employeeId))
      .limit(1);
    const userId = emp[0]?.userId ?? null;
    if (userId === null) return { withdrawnAt: now, confirmation: "paper_needed" as const };
    const rendered = tplWithdrawn(await templateContext(tx, config), {
      effectiveOn,
      contact: (await readW2Contact(tx)).contact,
      stillOnline: await stillOnline(tx, employeeId, effectiveOn, config.appTz),
    });
    await tx.insert(emailOutbox).values({
      userId,
      eventType: EVENT_TYPE.w2ConsentWithdrawn,
      subject: rendered.subject,
      bodyHtml: rendered.html,
    });
    return { withdrawnAt: now, confirmation: "email" as const };
  });
  return {
    status: await w2ConsentStatus(db, employeeId),
    effectiveOn: localDate(out.withdrawnAt, config.appTz),
    confirmation: out.confirmation,
  };
}

/**
 * N1: the tax years already furnished online (portal_notice or
 * employee_download) and still inside their access window on `today`, with
 * the window's last day — October 15 of the next year, or 90 days after the
 * latest corrected posting when later ((j)(6)).
 */
async function stillOnline(
  db: ReadDb,
  employeeId: number,
  today: string,
  appTz: string,
): Promise<{ taxYear: number; accessThrough: string }[]> {
  const rows = await db
    .select({
      taxYear: w2Furnishings.taxYear,
      method: w2Furnishings.method,
      corrected: w2Furnishings.corrected,
      furnishedAt: w2Furnishings.furnishedAt,
    })
    .from(w2Furnishings)
    .where(
      and(
        eq(w2Furnishings.employeeId, employeeId),
        inArray(w2Furnishings.method, ["portal_notice", "employee_download"]),
      ),
    );
  const years = [...new Set(rows.map((r) => r.taxYear))].sort((a, b) => a - b);
  const out: { taxYear: number; accessThrough: string }[] = [];
  for (const taxYear of years) {
    let latest: Date | null = null;
    for (const r of rows) {
      if (r.taxYear !== taxYear || r.method !== "portal_notice" || !r.corrected) continue;
      if (latest === null || r.furnishedAt.getTime() > latest.getTime()) latest = r.furnishedAt;
    }
    const through = electronicW2AccessThrough(
      taxYear,
      latest === null ? null : localDate(latest, appTz),
    );
    if (today <= through) out.push({ taxYear, accessThrough: through });
  }
  return out;
}

/** Active consents of `employeeIds` whose employee has a login and is active. */
async function activeConsents(db: ReadDb, employeeIds: readonly number[]) {
  if (employeeIds.length === 0) return [];
  return db
    .select({
      employeeId: w2DeliveryConsents.employeeId,
      disclosureVersion: w2DeliveryConsents.disclosureVersion,
      withdrawnAt: w2DeliveryConsents.withdrawnAt,
    })
    .from(w2DeliveryConsents)
    .innerJoin(employees, eq(employees.id, w2DeliveryConsents.employeeId))
    .where(
      and(
        inArray(w2DeliveryConsents.employeeId, [...employeeIds]),
        isNull(w2DeliveryConsents.withdrawnAt),
        isNotNull(employees.userId),
        eq(employees.status, "active"),
      ),
    );
}

/**
 * The employees whose W-2 delivery channel for `taxYear` is electronic (A2,
 * the one definition): a consent that covers the year (consentCoversYear)
 * AND a login AND employees.status = 'active' (termination bans the login,
 * so a terminated employee cannot reach an online W-2). The admin list,
 * correctionToFurnish, the correction follow-up and the year notice all use
 * it.
 */
export async function electronicW2Channel(
  db: ReadDb,
  employeeIds: readonly number[],
  taxYear: number,
): Promise<Set<number>> {
  const rows = await activeConsents(db, employeeIds);
  return new Set(rows.filter((r) => consentCoversYear(r, taxYear)).map((r) => r.employeeId));
}

/**
 * Brief 2.2d: the employees who would be on the electronic channel for
 * `taxYear` but for earlier terms (active consent, login, status active,
 * the consent does not cover the year).
 */
export async function reconsentNeededFor(
  db: ReadDb,
  employeeIds: readonly number[],
  taxYear: number,
): Promise<Set<number>> {
  const rows = await activeConsents(db, employeeIds);
  return new Set(rows.filter((r) => !consentCoversYear(r, taxYear)).map((r) => r.employeeId));
}

// ---------------------------------------------------------------------------
// D-D: the one-time "please review the updated terms" email
// ---------------------------------------------------------------------------

/** The outbox marker of the terms notice for the current version (one per user). */
function termsMarker(): string {
  return `<!-- w2-terms-updated:${W2_DISCLOSURE_VERSION} -->`;
}

/**
 * PAY-208 D-D: mail every active employee with a login whose active consent
 * is on earlier terms, once per employee per disclosure version (the outbox
 * marker is the record — restart-safe). Sent only once the W-2 contact is
 * complete: before that nobody can agree again. Run by the daily tick.
 */
export async function sendW2TermsUpdateNotices(deps: {
  db: Db;
  config: AppConfig;
}): Promise<{ sent: number }> {
  const { db, config } = deps;
  if (!(await readW2Contact(db)).ready) return { sent: 0 };
  const rows = await db
    .select({
      userId: employees.userId,
      disclosureVersion: w2DeliveryConsents.disclosureVersion,
      withdrawnAt: w2DeliveryConsents.withdrawnAt,
    })
    .from(w2DeliveryConsents)
    .innerJoin(employees, eq(employees.id, w2DeliveryConsents.employeeId))
    .where(
      and(
        isNull(w2DeliveryConsents.withdrawnAt),
        isNotNull(employees.userId),
        eq(employees.status, "active"),
      ),
    )
    .orderBy(employees.id);
  const outdated = rows.filter((r) => !consentCoversYear(r, W2_CONSENT_GATE_FROM_TAX_YEAR));
  if (outdated.length === 0) return { sent: 0 };
  const rendered = tplTermsUpdated(await templateContext(db, config), {
    gateYear: W2_CONSENT_GATE_FROM_TAX_YEAR,
  });
  let sent = 0;
  for (const r of outdated) {
    const userId = r.userId;
    if (userId === null) continue;
    const queued = await db.transaction(async (tx) => {
      const already = await tx
        .select({ id: emailOutbox.id })
        .from(emailOutbox)
        .where(
          and(
            eq(emailOutbox.userId, userId),
            eq(emailOutbox.eventType, EVENT_TYPE.w2TermsUpdated),
            like(emailOutbox.bodyHtml, `%${termsMarker()}%`),
          ),
        )
        .limit(1);
      if (already.length > 0) return false;
      await tx.insert(emailOutbox).values({
        userId,
        eventType: EVENT_TYPE.w2TermsUpdated,
        subject: rendered.subject,
        bodyHtml: `${rendered.html}${termsMarker()}`,
      });
      return true;
    });
    if (queued) sent += 1;
  }
  return { sent };
}
