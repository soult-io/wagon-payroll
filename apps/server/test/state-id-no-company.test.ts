/**
 * Spec 24 (PAY-116) PR-1 — with no company row, GET, PUT and DELETE of the
 * state-ID routes all answer 404 { error: "no_company" }. (The L5 404
 * not_found is only for a missing state-ID row.)
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { company, seedDatabase, type SeedDb } from "@payroll/db";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard, login, sessionHeader, TEST_PASSWORD } from "./flow-helpers.js";

let t: TestContext;
let cookie: string;

beforeAll(async () => {
  t = await createTestApp();
  await seedDatabase(t.db as unknown as SeedDb);
  await inviteAndOnboard(t, { email: "sid-nc-admin@example.com", role: "admin" });
  cookie = (await login(t, "sid-nc-admin@example.com", TEST_PASSWORD)).sessionCookie;
  // Admins are not employees; with no employee rows the company row can go.
  await t.pglite.exec("DELETE FROM employees");
  await t.db.delete(company);
});

afterAll(async () => {
  await t.close();
});

describe("no company row", () => {
  it("GET, PUT and DELETE answer 404 no_company", async () => {
    const headers = sessionHeader(cookie);
    const get = await t.app.inject({ method: "GET", url: "/api/admin/company/state-ids", headers });
    const put = await t.app.inject({
      method: "PUT",
      url: "/api/admin/company/state-ids/CA",
      headers,
      payload: { stateId: "00000001" },
    });
    const del = await t.app.inject({
      method: "DELETE",
      url: "/api/admin/company/state-ids/CA/2026",
      headers,
    });
    for (const res of [get, put, del]) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "no_company" });
    }
  });
});
