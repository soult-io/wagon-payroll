/**
 * PAY-259 PR 4: manage passkeys in My settings (spec §9, journeys J1 + J3).
 *
 * One sign-in for the whole file: the credential endpoints are rate-limited
 * (10/min/IP) and a password + TOTP login costs two requests. Changing a
 * passkey also needs the server's 5-minute step-up window (passkey-policy.ts),
 * so every test shares the one fresh session and runs straight after it.
 *
 * Runs in both modes. Ephemeral boot and live QA (E2E_BASE_URL) both carry the
 * seeded QA employee. The file cleans up after itself: before adding, it
 * removes passkeys an earlier crashed run left behind ("CI key*"), and
 * afterAll removes every passkey this run added, inside the same session.
 *
 * The Passkeys card is hidden when /api/runtime-config says
 * `passkeysAvailable: false`. That is a FAILURE here, never a skip: the e2e
 * boot serves on http://localhost:9898 precisely so passkeys are available.
 *
 * Spec S11: no credential material (ids, keys) is logged or attached. Ids
 * only travel between the API and the delete call; assertions compare counts.
 */

import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { loginAs, QA_EMPLOYEE } from "./qa.js";
import { step } from "./support/journey.js";
import { newContext } from "./support/walkthrough.js";
import { addVirtualAuthenticator, type VirtualAuthenticator } from "./support/webauthn.js";

test.describe.configure({ mode: "serial" });

const KEY_NAME = "CI key";
const RENAMED = "CI key renamed";
/** Names this file gives its passkeys; leftovers with these come from an earlier run. */
const OWN_NAME_PREFIX = "CI key";
/** Server step-up window (PASSKEY_STEP_UP_MS) minus headroom for the last request. */
const STEP_UP_BUDGET_MS = 4.5 * 60 * 1000;

interface PasskeyRecord {
  id: string;
  name?: string | null;
}

let context: BrowserContext | undefined;
let page: Page;
let authenticator: VirtualAuthenticator | undefined;
/** When the shared session signed in (runner clock), for the step-up budget. */
let signedInAt = 0;
/** Passkey ids present before this run added any; null until known. */
let baseline: Set<string> | null = null;

async function listPasskeys(p: Page): Promise<PasskeyRecord[]> {
  const res = await p.request.get("/api/auth/passkey/list-user-passkeys");
  expect(res.status(), "GET /api/auth/passkey/list-user-passkeys").toBe(200);
  return (await res.json()) as PasskeyRecord[];
}

/** Delete one passkey from inside the page, so the browser sends its Origin. */
async function deletePasskey(p: Page, id: string): Promise<number> {
  return p.evaluate(async (passkeyId) => {
    const res = await fetch("/api/auth/passkey/delete-passkey", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: passkeyId }),
    });
    return res.status;
  }, id);
}

/** Delete each passkey; returns how many deletes the server refused. */
async function deleteAll(p: Page, records: PasskeyRecord[]): Promise<number> {
  let refused = 0;
  for (const record of records) {
    if ((await deletePasskey(p, record.id)) !== 200) refused++;
  }
  return refused;
}

function passkeyRows(p: Page) {
  return p.getByTestId("passkey-row");
}

/** The row whose name is exactly `name` (so "CI key" never matches "CI key renamed"). */
function rowNamed(p: Page, name: string) {
  return passkeyRows(p).filter({ has: p.getByText(name, { exact: true }) });
}

function expectWithinStepUp(): void {
  expect(
    Date.now() - signedInAt,
    "passkey changes must run within the server's 5-minute step-up window after sign-in",
  ).toBeLessThan(STEP_UP_BUDGET_MS);
}

test.beforeAll(async ({ browser }) => {
  context = await newContext(browser);
  page = await context.newPage();
  authenticator = await addVirtualAuthenticator(page);
});

test.afterAll(async () => {
  try {
    if (baseline !== null) {
      const known = baseline;
      const created = (await listPasskeys(page)).filter((r) => !known.has(r.id));
      const refused = await deleteAll(page, created);
      expect(refused, "afterAll: passkeys this run added are all deleted").toBe(0);
    }
  } finally {
    await authenticator?.remove();
    await context?.close();
  }
});

test("J1: add a passkey from My settings; it is listed", async () => {
  await step(page, "Sign in with password + TOTP", async () => {
    await loginAs(page, QA_EMPLOYEE);
    signedInAt = Date.now();
  });

  await step(page, "Start with no passkeys (clear an earlier run's leftovers)", async () => {
    const leftovers = (await listPasskeys(page)).filter((r) =>
      (r.name ?? "").startsWith(OWN_NAME_PREFIX),
    );
    expect(await deleteAll(page, leftovers), "leftover CI passkeys deleted").toBe(0);
    const remaining = await listPasskeys(page);
    baseline = new Set(remaining.map((r) => r.id));
    expect(remaining.length, "the QA employee starts with no passkeys").toBe(0);
  });

  await step(page, "Passkeys are available on this address", async () => {
    const res = await page.request.get("/api/runtime-config");
    expect(res.status(), "GET /api/runtime-config").toBe(200);
    const config = (await res.json()) as { passkeysAvailable?: unknown };
    expect(config.passkeysAvailable, "runtime-config passkeysAvailable").toBe(true);
  });

  await step(page, "Open My settings: Sign-in and security, Passkeys", async () => {
    await page.goto("/my/settings");
    await expect(page.getByRole("heading", { name: "Sign-in and security" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Passkeys", exact: true })).toBeVisible();
  });

  await step(page, `Add a passkey named "${KEY_NAME}"`, async () => {
    await page.getByRole("button", { name: "Add a passkey", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add a passkey" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Name (optional)").fill(KEY_NAME);
    await dialog.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(dialog).toBeHidden();
  });

  await step(page, `"${KEY_NAME}" is listed; the authenticator holds one passkey`, async () => {
    await expect(rowNamed(page, KEY_NAME)).toHaveCount(1);
    await expect(passkeyRows(page)).toHaveCount(1);
    // Count only: printing the credentials would log key material (S11).
    const held = await authenticator?.credentials();
    expect(held?.length, "virtual authenticator credential count").toBe(1);
    const listed = await listPasskeys(page);
    expect(listed.map((r) => r.name)).toEqual([KEY_NAME]);
  });
});

test("J3: rename the passkey, then remove it; the list is empty", async () => {
  await step(page, `Rename "${KEY_NAME}" to "${RENAMED}"`, async () => {
    expectWithinStepUp();
    await page.getByRole("button", { name: `Rename ${KEY_NAME}`, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Rename passkey" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Name", { exact: true }).fill(RENAMED);
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(rowNamed(page, RENAMED)).toHaveCount(1);
    await expect(rowNamed(page, KEY_NAME)).toHaveCount(0);
  });

  await step(page, "Remove it, leaving other devices signed in", async () => {
    expectWithinStepUp();
    await page.getByRole("button", { name: `Remove ${RENAMED}`, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Remove passkey" });
    await expect(dialog).toBeVisible();
    const signOutOthers = dialog.getByLabel("Also sign me out on all other devices");
    await expect(signOutOthers).not.toBeChecked();
    await dialog.getByRole("button", { name: "Remove passkey", exact: true }).click();
    await expect(dialog).toBeHidden();
  });

  await step(page, "Empty state shows; the server lists no passkeys", async () => {
    await expect(page.getByText("You have no passkeys yet.")).toBeVisible();
    await expect(passkeyRows(page)).toHaveCount(0);
    expect(await listPasskeys(page)).toEqual([]);
  });
});

test("Active sessions: 'Signed in with' shows Password + code for this session", async () => {
  await step(page, "Sessions table has a 'Signed in with' column", async () => {
    await page.goto("/my/settings");
    await expect(page.getByRole("columnheader", { name: "Signed in with" })).toBeVisible();
  });

  await step(page, "This session was signed in with Password + code", async () => {
    const current = await page.request.get("/api/auth/get-session");
    expect(current.status(), "GET /api/auth/get-session").toBe(200);
    const { session } = (await current.json()) as { session: { id: string } };
    const list = await page.request.get("/api/auth/list-sessions");
    expect(list.status(), "GET /api/auth/list-sessions").toBe(200);
    const sessions = (await list.json()) as { id: string; authMethod?: unknown }[];
    const mine = sessions.find((s) => s.id === session.id);
    expect(mine?.authMethod, "current session authMethod").toBe("password_totp");
    await expect(
      page.getByRole("row").filter({ hasText: "Password + code" }).first(),
    ).toBeVisible();
  });
});
