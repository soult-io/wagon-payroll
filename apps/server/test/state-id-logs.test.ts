/**
 * Spec 24 (PAY-116) PR-1, security review S1 — state IDs never reach the
 * server log. The app is built with a pino destination stream at trace
 * level; PUT, GET, DELETE and a refused PUT run; the captured log output
 * must not contain any of the synthetic IDs.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { company, seedDatabase, type SeedDb } from "@payroll/db";
import { encryptField } from "../src/crypto/field-encryption.js";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";

const lines: string[] = [];
const stream = {
  write(msg: string) {
    lines.push(msg);
  },
};

let t: TestContext;
let cookie: string;

beforeAll(async () => {
  t = await createTestApp({ logLevel: "trace" }, { logStream: stream });
  await seedDatabase(t.db as unknown as SeedDb);
  await t.db.update(company).set({ ein: encryptField("98-7654321", t.config.encryptionKey) });
  await inviteAndOnboard(t, { email: "sid-log-admin@example.com", role: "admin" });
  cookie = (await login(t, "sid-log-admin@example.com", TEST_PASSWORD)).sessionCookie;
});

afterAll(async () => {
  await t.close();
});

describe("S1 no state ID in logs", () => {
  it("PUT, GET, DELETE and a refused PUT log no ID", async () => {
    const headers = sessionHeader(cookie);
    const before = lines.length;
    const put = await t.app.inject({
      method: "PUT",
      url: "/api/admin/company/state-ids/CA",
      headers,
      payload: { stateId: "0045-1739" },
    });
    expect(put.statusCode).toBe(200);
    const bad = await t.app.inject({
      method: "PUT",
      url: "/api/admin/company/state-ids/NC",
      headers,
      payload: { stateId: "APPLIED-7731" },
    });
    expect(bad.statusCode).toBe(400);
    const get = await t.app.inject({ method: "GET", url: "/api/admin/company/state-ids", headers });
    expect(get.statusCode).toBe(200);
    const del = await t.app.inject({
      method: "DELETE",
      url: "/api/admin/company/state-ids/CA/2026",
      headers,
    });
    expect(del.statusCode).toBe(204);

    const captured = lines.slice(before).join("");
    // The stream really captured the requests (guards against a silent logger).
    expect(captured).toContain("/api/admin/company/state-ids");
    for (const secret of ["0045-1739", "00451739", "APPLIED-7731", "APPLIED7731", "7654321"]) {
      expect(captured).not.toContain(secret);
    }
  });
});
