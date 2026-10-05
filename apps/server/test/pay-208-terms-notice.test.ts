/**
 * PAY-208 D-D — the one-time "please review the updated W-2 terms" email
 * ((j)(2)(iii) spirit: tell consenters before their consent stops covering
 * 2026). payroll-calc-auditor, fail-first against d0f722f; the coder may not
 * edit this file. Synthetic data only.
 *
 * Tests: DD1-DD3.
 *
 * Contract assumed:
 *  - EVENT_TYPE.w2TermsUpdated, always on.
 *  - sendW2TermsUpdateNotices(deps: { db, config }) exported from
 *    apps/server/src/filings/w2-consent.ts -> { sent: number }; run by the
 *    daily annualTick (apps/server/src/payroll/scheduler.ts).
 *  - Recipients: employees with status 'active', a login, and an active
 *    (not withdrawn) consent whose version is not the current one. Never:
 *    withdrawn, terminated, no login, already current, no consent.
 *  - Once per employee per disclosure version, deduplicated in the
 *    database (restart-safe: no in-memory state).
 *  - Content: asks to review and agree again; link = appUrl only; no
 *    amounts, no SSN.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { annualTick } from "../src/payroll/scheduler.js";
import {
  allOutbox,
  boot,
  consentModule,
  deps,
  type Emp,
  type Env,
  hasAmount,
  makeEmp,
  need,
  NEW_VERSION,
  notificationsModule,
  OLD_VERSION,
  outbox,
  plain,
  postConsent,
  relogin,
  scrub,
  seedContact,
  SSN_FORMS,
} from "./pay-208-harness.js";

let env: Env;
const e: Record<string, Emp> = {};
let ev = "w2_terms_updated";

beforeAll(async () => {
  env = await boot({ now: "2026-10-20T10:00:00Z" });
  await seedContact(env);
  ev = ((await notificationsModule()).EVENT_TYPE as Record<string, string>).w2TermsUpdated ?? ev;
  e.outdated = await makeEmp(env, {
    label: "Ddoutdated",
    login: true,
    consent: OLD_VERSION,
    years: [2025, 2026],
  });
  e.withdrawn = await makeEmp(env, {
    label: "Ddwithdrawn",
    login: true,
    consent: OLD_VERSION,
    withdrawnAt: "2026-03-01T10:00:00Z",
    years: [2026],
  });
  e.terminated = await makeEmp(env, {
    label: "Ddterm",
    login: true,
    consent: OLD_VERSION,
    years: [2026],
    terminated: true,
  });
  e.noLogin = await makeEmp(env, { label: "Ddnologin", consent: OLD_VERSION, years: [2026] });
  e.current = await makeEmp(env, {
    label: "Ddcurrent",
    login: true,
    consent: NEW_VERSION,
    years: [2026],
  });
  e.none = await makeEmp(env, { label: "Ddnone", login: true, years: [2026] });
}, 240_000);
afterAll(async () => env.close());

describe("PAY-208 D-D review-the-updated-terms email", () => {
  it("DD1 the daily tick mails only the active, logged-in, outdated consenter — once; content asks to agree again, appUrl only, no amounts or SSN", async () => {
    await annualTick(deps(env));
    const count = async (k: string) => (await outbox(env, e[k]!.userId, ev)).length;
    const mail = (await outbox(env, e.outdated!.userId, ev))[0];
    const text = plain(mail?.bodyHtml ?? "");
    const hrefs = [...(mail?.bodyHtml ?? "").matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect({
      eventDefined:
        ((await notificationsModule()).EVENT_TYPE as Record<string, string>).w2TermsUpdated !==
        undefined,
      outdated: await count("outdated"),
      withdrawn: await count("withdrawn"),
      terminated: await count("terminated"),
      current: await count("current"),
      none: await count("none"),
      total: (await allOutbox(env, ev)).length,
      agreeAgain: /agree/i.test(text) && /again|updated/i.test(text),
      hrefs: hrefs.every((h) => !h?.includes("?") && !h?.includes("/api/")),
      noAmount: !hasAmount(scrub(text)),
      noSsn: SSN_FORMS.slice(0, 2).every((s) => !(mail?.bodyHtml ?? "").includes(s)),
    }).toEqual({
      eventDefined: true,
      outdated: 1,
      withdrawn: 0,
      terminated: 0,
      current: 0,
      none: 0,
      total: 1,
      agreeAgain: true,
      hrefs: true,
      noAmount: true,
      noSsn: true,
    });
  });

  it("DD2 idempotent: a second tick, the next day's tick and a direct call send nothing more", async () => {
    await annualTick(deps(env));
    env.setNow("2026-10-21T10:00:00Z");
    await annualTick(deps(env));
    const direct = await need(await consentModule(), "sendW2TermsUpdateNotices")(deps(env));
    expect({
      direct: (direct as { sent: number }).sent,
      total: (await allOutbox(env, ev)).length,
    }).toEqual({
      direct: 0,
      total: 1,
    });
  });

  it("DD3 after the employee agrees to 2026-10 nothing more is sent to them", async () => {
    await relogin(env, e.outdated!);
    // The default postConsent reads a fresh code from the test PDF (D-B).
    const res = await postConsent(env, e.outdated!);
    await annualTick(deps(env));
    expect({ consent: res.statusCode, total: (await allOutbox(env, ev)).length }).toEqual({
      consent: 200,
      total: 1,
    });
  });
});
