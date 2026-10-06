/**
 * PAY-223 PR-1 — T14: an admin re-enters the box 15 state ID between the
 * furnishing transaction's figures read and its ciphertext read (brief
 * §5.1). The freeze must see that sha256(ciphertext) no longer equals the
 * figures' stateIdDigest, throw FrozenFiguresRaceError, and roll the whole
 * furnishing back: no w2_furnishings row, no frozen row, no mail. The next
 * tick succeeds. payroll-calc-auditor, fail-first against f74b51b; the
 * coder may not edit this file. Synthetic data only.
 *
 * Interleaving: storedEnteredStateIds (company/state-ids.ts, contract in
 * pay-223-harness.ts) is wrapped by vi.mock. While `armed`, the wrapper
 * returns the ciphertext of a THIRD value (CA_ID_NEW) — exactly what the
 * read returns when the admin's write commits between the two reads. The
 * real write then commits before the next tick.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { encryptField } from "../src/crypto/field-encryption.js";
import {
  boot217,
  CA_ID,
  CA_ID_MID,
  CA_ID_NEW,
  caCiphertext,
  caRuns,
  deps,
  emp,
  type Emp,
  type Env,
  errorOf,
  expBox15,
  expFrozen,
  expHash,
  frozenRows,
  furnRows,
  furnishModule,
  type Ids,
  keyOf,
  myPdf,
  outbox,
  setCaId,
  sha256,
  yearNotice,
} from "./pay-223-harness.js";
import type { FxRun } from "./w2-state-oracle.js";

const race = vi.hoisted(() => ({ armed: false, ct: "", calls: 0 }));

vi.mock("../src/company/state-ids.js", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  const real = orig.storedEnteredStateIds as ((...a: unknown[]) => Promise<unknown>) | undefined;
  return {
    ...orig,
    storedEnteredStateIds: async (...args: unknown[]) => {
      if (!real) throw new Error("storedEnteredStateIds is not exported");
      const out = await real(...args);
      if (!race.armed) return out;
      race.armed = false;
      race.calls += 1;
      if (out instanceof Map) {
        const m = new Map(out as Map<string, unknown>);
        if (m.has("CA")) m.set("CA", race.ct);
        return m;
      }
      const o = { ...(out as Record<string, unknown>) };
      if ("CA" in o) o.CA = race.ct;
      return o;
    },
  };
});

const JAN_4_2027 = "2027-01-04T16:00:00Z";
const TODAY = "2027-01-04";

type E = Emp & { runs: FxRun[] };

describe("T14 race: the state ID is re-entered between the figures read and the ciphertext read", () => {
  let env: Env;
  const e: Record<string, E> = {};
  let ct0 = "";
  beforeAll(async () => {
    env = await boot217(JAN_4_2027);
    ct0 = await setCaId(env, CA_ID);
    e.rec = await emp(env, "Racer", caRuns(), { login: true, consent: true });
    await yearNotice(env, TODAY); // portal_notice A (CA_ID)
    e.dl = await emp(env, "RaceDl", caRuns(), { login: true, consent: true });
  }, 300_000);
  afterAll(async () => env.close());

  it("daily reconcile: tick 1 rolls back (failed 1, logged by class only, nothing written, no mail); tick 2 posts the correction and freezes it with the committed ciphertext", async () => {
    const { reconcileW2Furnishings } = await furnishModule();
    const ctMid = await setCaId(env, CA_ID_MID); // committed before tick 1: figures now differ from A
    race.ct = encryptField(CA_ID_NEW, env.t.config.encryptionKey);
    race.armed = true;
    race.calls = 0;
    const furnBefore = await furnRows(env, e.rec!.id);
    const frozenBefore = await frozenRows(env, e.rec!.id).catch(() => null);
    const mailsBefore = (await outbox(env, e.rec!.userId, "w2_changed")).length;
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(" "));
    });
    let tick1: { checked: number; followUps: number; failed: number };
    try {
      tick1 = await reconcileW2Furnishings(deps(env), { today: TODAY });
    } finally {
      spy.mockRestore();
    }
    const afterTick1 = {
      result: { followUps: tick1.followUps, failed: tick1.failed },
      intercepted: race.calls,
      furnishings: (await furnRows(env, e.rec!.id)).length - furnBefore.length,
      frozen: (await frozenRows(env, e.rec!.id)).length - (frozenBefore?.length ?? -99),
      mails: (await outbox(env, e.rec!.userId, "w2_changed")).length - mailsBefore,
      logged: errors.some((l) => l.includes("FrozenFiguresRaceError")),
      logClean: errors.every(
        (l) =>
          !l.includes(CA_ID_MID) &&
          !l.includes(CA_ID_NEW) &&
          !l.includes("enc:v1") &&
          !/[0-9a-f]{64}/.test(l),
      ),
    };
    race.armed = false;
    // The admin's write commits; the next tick reads the new value end to end.
    const ctNew = await setCaId(env, CA_ID_NEW);
    const tick2 = await reconcileW2Furnishings(deps(env), { today: TODAY });
    const ids: Ids = { CA: { source: "entered", ct: ctNew } };
    const hashNew = expHash(e.rec!.id, e.rec!.runs, 2026, ids);
    const rows = await frozenRows(env, e.rec!.id);
    const posted = rows.find((r) => r.boxes_hash === hashNew);
    const exp = expFrozen(e.rec!.runs, 2026, ids);
    expect({
      afterTick1,
      tick2: { followUps: tick2.followUps, failed: tick2.failed },
      furnishings: (await furnRows(env, e.rec!.id)).map((r) => [
        r.method,
        r.corrected,
        r.boxes_hash,
      ]),
      frozenKeys: rows.map(keyOf),
      posted: posted && {
        figures: posted.figures,
        box15: posted.box15_ciphertexts,
        digest: posted.figures.stateLines[0]?.stateIdDigest === sha256(ctNew),
      },
      mails: (await outbox(env, e.rec!.userId, "w2_changed")).length - mailsBefore,
      neverMid: rows.every((r) => !JSON.stringify(r).includes(ctMid)),
    }).toEqual({
      afterTick1: {
        result: { followUps: 0, failed: 1 },
        intercepted: 1,
        furnishings: 0,
        frozen: 0,
        mails: 0,
        logged: true,
        logClean: true,
      },
      tick2: { followUps: 1, failed: 0 },
      furnishings: [
        [
          "portal_notice",
          false,
          expHash(e.rec!.id, e.rec!.runs, 2026, { CA: { source: "entered", ct: ct0 } }),
        ],
        ["portal_notice", true, hashNew],
      ],
      frozenKeys: [
        `2026:2:${expHash(e.rec!.id, e.rec!.runs, 2026, { CA: { source: "entered", ct: ct0 } })}`,
        `2026:2:${hashNew}`,
      ],
      posted: { figures: exp, box15: expBox15(exp, ids), digest: true },
      mails: 1,
      neverMid: true,
    });
  });

  it("employee download: the race answers 409 w2_not_ready and writes nothing; the retry is 200 with one frozen row of the current ciphertext", async () => {
    race.ct = encryptField("77665547", env.t.config.encryptionKey);
    race.armed = true;
    race.calls = 0;
    const raced = await myPdf(env, e.dl!, 2026);
    const afterRace = {
      status: raced.statusCode,
      error: errorOf(raced),
      intercepted: race.calls,
      furnishings: (await furnRows(env, e.dl!.id)).length,
      frozen: (await frozenRows(env, e.dl!.id).catch(() => [{}])).length,
    };
    race.armed = false;
    const retry = await myPdf(env, e.dl!, 2026);
    const ct = await caCiphertext(env);
    const ids: Ids = { CA: { source: "entered", ct } };
    expect({
      afterRace,
      retry: retry.statusCode,
      frozen: (await frozenRows(env, e.dl!.id)).map((r) => [keyOf(r), r.box15_ciphertexts]),
    }).toEqual({
      afterRace: { status: 409, error: "w2_not_ready", intercepted: 1, furnishings: 0, frozen: 0 },
      retry: 200,
      frozen: [[`2026:2:${expHash(e.dl!.id, e.dl!.runs, 2026, ids)}`, { CA: ct }]],
    });
  });
});
