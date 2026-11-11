/**
 * PAY-259: passkeys end to end (spec §9, journeys J1–J5).
 * PR 4: manage passkeys in My settings (J1 add, J3 rename + remove, the
 * sessions label). PR 5: sign in with a passkey on /login (J2 button, J4 user
 * verification refused, J3 removed passkey, J5 autofill).
 *
 * Order (serial, one browser page, one virtual authenticator):
 *   J1 password + TOTP sign-in, add "CI key" → sessions label "Password + code"
 *   → J2 sign out, passkey button → J4 UV off, refused → J5 autofill sign-in
 *   → J3 rename + remove → J3 removed passkey refused.
 * Credential endpoints allow 10 requests/min/IP: a password + TOTP login costs
 * two, a passkey sign-in one verify (its options call is in a separate
 * 30/min bucket). This order costs at most five. Removing a passkey needs the
 * server's 5-minute step-up window (passkey-policy.ts); a passkey sign-in
 * counts, so J3 runs right after the J5 (or a fallback button) sign-in.
 *
 * Runs in both modes. Ephemeral boot and live QA (E2E_BASE_URL) both carry the
 * seeded QA employee. The file cleans up after itself: right after sign-in
 * (inside the step-up window) it removes passkeys an earlier run left behind
 * (named "CI key*", or unnamed: an add that succeeded before its rename), and
 * afterAll removes every passkey this run added, inside the same session.
 * Any other passkey on the account is kept and recorded as the baseline;
 * assertions compare against it rather than requiring an empty account. When
 * a failure leaves the page signed out with the passkey still on the account,
 * afterAll warns and the next run's leftover step deletes it.
 *
 * The Passkeys card and the sign-in button are hidden when
 * /api/runtime-config says `passkeysAvailable: false`. That is a FAILURE
 * here, never a skip: the e2e boot serves on http://localhost:9898 precisely
 * so passkeys are available. The hidden state itself is not tested here: the
 * server flag cannot be flipped from e2e, and faking the response would test
 * nothing real.
 *
 * Passkey autofill on /login is held for the whole file (holdPasskeyAutofill
 * in support/webauthn.ts): the virtual authenticator would otherwise answer
 * it at once and sign in before any button is clicked. J5 releases it.
 *
 * Spec S11: no credential material (ids, keys) is logged or attached. Ids
 * only travel between the API and the delete call; assertions compare counts.
 *
 * PAY-267 (the prompt after a password + TOTP sign-in) adds J6, J7 and the
 * admin "Sign-in" column after J3, ephemeral boot only: "Not now" persists 30
 * days on the shared QA account, and J7 needs a second seeded user. They add
 * up to eight credential requests (J6 two sign-ins, J7 one, admin one when no
 * saved session), so a run can cross the 10/min budget; loginAs waits it out.
 * CI retries once and the in-memory database survives the retry: J6 skips on a
 * retry that finds the first attempt's "Not now" still in force.
 */

import { existsSync } from "node:fs";
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
  ADMIN_SESSION_PATH,
  LIVE_QA,
  loadEphemeralState,
  loginAs,
  nextPost,
  QA_CONTRACTOR,
  QA_EMPLOYEE,
  retryOnRateLimit,
  VERIFY_TOTP_PATH,
} from "./qa.js";
import { step } from "./support/journey.js";
import { newContext } from "./support/walkthrough.js";
import {
  addVirtualAuthenticator,
  autofillRequests,
  holdPasskeyAutofill,
  releaseAutofill,
  resetAutofillRequests,
  type VirtualAuthenticator,
} from "./support/webauthn.js";

test.describe.configure({ mode: "serial" });
// S11: a retry trace would carry the attestation and credential data (request
// bodies) into a public CI artifact. No traces for this file.
test.use({ trace: "off" });

/** Names this file gives its passkeys; leftovers with these come from an earlier run. */
const OWN_NAME_PREFIX = "CI key";
const KEY_NAME = OWN_NAME_PREFIX;
const RENAMED = `${OWN_NAME_PREFIX} renamed`;
/** Server step-up window (PASSKEY_STEP_UP_MS in apps/server/src/auth/passkey-policy.ts). */
const STEP_UP_WINDOW_MS = 5 * 60 * 1000;
/** The window minus headroom for the last request. */
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
/** True once J3 has removed this run's passkey and the server list equals the baseline. */
let ownRemoved = false;

const PASSKEY_VERIFY_PATH = "/api/auth/passkey/verify-authentication";
const PASSKEY_OPTIONS_PATH = "/api/auth/passkey/generate-authenticate-options";
const SIGN_IN_BUTTON = "Sign in with a passkey";

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

/** A passkey an earlier run of this file left behind: its own name, or no name. */
function isOwnLeftover(record: PasskeyRecord): boolean {
  const name = (record.name ?? "").trim();
  return name === "" || name.startsWith(OWN_NAME_PREFIX);
}

/** Row ids, sorted. Compare these, never whole records: a record also carries credentialID and publicKey (S11). */
function sortedIds(records: PasskeyRecord[]): string[] {
  return records.map((r) => r.id).sort();
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

/** The signed-in session's id, or null when signed out. */
async function currentSessionId(p: Page): Promise<string | null> {
  const res = await p.request.get("/api/auth/get-session");
  if (res.status() === 401) return null;
  expect(res.status(), "GET /api/auth/get-session").toBe(200);
  const body = (await res.json()) as { session?: { id?: string } } | null;
  return body?.session?.id ?? null;
}

/** How the current session signed in, from list-sessions (the column's source). */
async function currentAuthMethod(p: Page): Promise<unknown> {
  const id = await currentSessionId(p);
  expect(id, "signed in").not.toBeNull();
  const list = await p.request.get("/api/auth/list-sessions");
  expect(list.status(), "GET /api/auth/list-sessions").toBe(200);
  const sessions = (await list.json()) as { id: string; authMethod?: unknown }[];
  return sessions.find((s) => s.id === id)?.authMethod;
}

/** Counts requests to `path` (pathname match) from now until `stop()`. */
function countRequests(p: Page, path: string): { count: () => number; stop: () => void } {
  let seen = 0;
  const listener = (req: { url(): string }) => {
    if (new URL(req.url()).pathname === path) seen++;
  };
  p.on("request", listener);
  return { count: () => seen, stop: () => p.off("request", listener) };
}

/**
 * Wait until the login page has made its autofill request for this mount.
 * The request first fetches its own sign-in options, which set the challenge
 * cookie; clicking the button before then lets the two challenges cross.
 * Count from a page load or from {@link resetAutofillRequests}. Browsers
 * without conditional mediation never start autofill, so there is no wait.
 */
async function waitForAutofill(p: Page, why: string): Promise<void> {
  const available = await p.evaluate(
    async () => (await window.PublicKeyCredential?.isConditionalMediationAvailable?.()) === true,
  );
  if (!available) return;
  await expect
    .poll(() => autofillRequests(p), {
      message: `passkey autofill started ${why}`,
      timeout: 10_000,
    })
    .toBeGreaterThan(0);
}

/** Sign out from the app header; the app returns to /login and starts autofill. */
async function signOut(p: Page): Promise<void> {
  await resetAutofillRequests(p);
  await p.getByRole("button", { name: "Sign out", exact: true }).click();
  await p.waitForURL("**/login");
  expect(await currentSessionId(p), "no session after sign-out").toBeNull();
  await waitForAutofill(p, "after sign-out");
}

/** Open /login fresh and wait for its autofill request. */
async function openLogin(p: Page): Promise<void> {
  await p.goto("/login");
  await waitForAutofill(p, "on load");
}

/**
 * Click "Sign in with a passkey" once; the verify response's HTTP status.
 * A refused attempt makes the page restart autofill; this waits for that, so
 * a retry (or the next click) cannot cross challenges with it either.
 */
async function clickPasskeySignIn(p: Page): Promise<{ status: number }> {
  await resetAutofillRequests(p);
  const response = nextPost(p, PASSKEY_VERIFY_PATH);
  await p.getByRole("button", { name: SIGN_IN_BUTTON, exact: true }).click();
  const status = (await response).status();
  if (status !== 200) await waitForAutofill(p, "again after the refused attempt");
  return { status };
}

/** The PrimeVue Message on /login that contains `text`. */
function loginMessage(p: Page, text: string) {
  return p.getByRole("alert").filter({ hasText: text });
}

/** Signed out on /login, the password step showing the passkey button. */
async function expectLoginWithPasskeyButton(p: Page): Promise<void> {
  await expect(p).toHaveURL(/\/login/);
  await expect(p.getByText("or", { exact: true })).toBeVisible();
  await expect(p.getByRole("button", { name: SIGN_IN_BUTTON, exact: true })).toBeVisible();
}

/**
 * A passkey sign-in completed: verify answered 200, the employee dashboard
 * shows, the session method is "passkey". Restarts the step-up clock.
 */
async function expectPasskeySignedIn(p: Page, verifyStatus: number): Promise<void> {
  expect(verifyStatus, `POST ${PASSKEY_VERIFY_PATH}`).toBe(200);
  await p.waitForURL(/\/my\/dashboard/, { timeout: 10_000 });
  await expect(p.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  expect(await currentAuthMethod(p), "current session authMethod").toBe("passkey");
  signedInAt = Date.now();
}

test.beforeAll(async ({ browser }) => {
  context = await newContext(browser);
  page = await context.newPage();
  authenticator = await addVirtualAuthenticator(page);
  await holdPasskeyAutofill(page);
});

/**
 * Delete what this run added. Past the step-up window the server refuses, and
 * that is reported (count only, S11) without failing: the next run's leftover
 * step removes them in its own fresh session. A refusal inside the window is a
 * real failure and throws.
 */
async function cleanUpCreated(): Promise<void> {
  if (baseline === null) return;
  if ((await currentSessionId(page)) === null) {
    if (!ownRemoved) {
      console.warn(
        "passkey.spec cleanup: signed out before this run's passkey was removed; the next run's leftover step deletes it",
      );
    }
    return;
  }
  const known = baseline;
  const created = (await listPasskeys(page)).filter((r) => !known.has(r.id));
  const refused = await deleteAll(page, created);
  if (refused === 0) return;
  const message = `passkey.spec cleanup: the server refused ${refused} of ${created.length} delete(s)`;
  if (Date.now() - signedInAt > STEP_UP_WINDOW_MS) {
    console.warn(
      `${message}; the 5-minute step-up window had expired, so the next run's leftover step deletes them`,
    );
    return;
  }
  throw new Error(`${message} inside the step-up window`);
}

test.afterAll(async () => {
  try {
    await cleanUpCreated();
  } finally {
    await authenticator?.remove();
    await context?.close();
  }
});

const PROMPT_PATH = "/api/my/passkey-prompt";
const PASSKEY_REGISTER_PATH = "/api/auth/passkey/verify-registration";
const LIVE_QA_SKIP =
  "ephemeral only: the prompt choice persists 30 days on the shared QA account, and this test needs seeded users with no passkeys";

/** J7's own browser, so its user and virtual authenticator stay apart from `page`. */
let enrollContext: BrowserContext | undefined;
let enrollPage: Page | undefined;
let enrollAuthenticator: VirtualAuthenticator | undefined;
let enrollSignedInAt = 0;

/** Delete J7's passkey in its still-fresh session, then drop its browser. */
async function cleanUpEnrollment(p: Page): Promise<void> {
  if ((await currentSessionId(p)) === null) return;
  const held = await listPasskeys(p);
  const refused = await deleteAll(p, held);
  if (refused === 0) return;
  const message = `passkey.spec J7 cleanup: the server refused ${refused} of ${held.length} delete(s)`;
  if (Date.now() - enrollSignedInAt > STEP_UP_WINDOW_MS) {
    console.warn(`${message}; the 5-minute step-up window had expired`);
    return;
  }
  throw new Error(`${message} inside the step-up window`);
}

test.afterAll(async () => {
  try {
    if (enrollPage) await cleanUpEnrollment(enrollPage);
  } finally {
    await enrollAuthenticator?.remove();
    await enrollContext?.close();
  }
});

function promptCard(p: Page) {
  return p.getByTestId("passkey-prompt");
}

function promptButton(p: Page, name: string) {
  return promptCard(p).getByRole("button", { name, exact: true });
}

/** The server's prompt flag for the signed-in user. */
async function promptDue(p: Page): Promise<unknown> {
  const res = await p.request.get("/api/my/security");
  expect(res.status(), "GET /api/my/security").toBe(200);
  return ((await res.json()) as { passkeyPromptDue?: unknown }).passkeyPromptDue;
}

/** The virtual authenticator makes the browser report a platform authenticator; the card needs one. */
async function expectPlatformAuthenticator(p: Page): Promise<void> {
  const available = await p.evaluate(
    async () =>
      (await window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable?.()) ===
      true,
  );
  expect(available, "isUserVerifyingPlatformAuthenticatorAvailable()").toBe(true);
}

/** Every gate of the card except the user's own choice: 0 passkeys, password + TOTP, a platform authenticator. */
async function expectPromptGatesOpen(p: Page): Promise<void> {
  expect((await listPasskeys(p)).length, "passkeys on the account").toBe(0);
  expect(await currentAuthMethod(p), "current session authMethod").toBe("password_totp");
  await expectPlatformAuthenticator(p);
}

async function expectPromptShown(p: Page): Promise<void> {
  await expect(promptCard(p)).toBeVisible();
  await expect(
    promptCard(p).getByRole("heading", { name: "Sign in faster with a passkey" }),
  ).toBeVisible();
  await expect(promptButton(p, "Add a passkey")).toBeVisible();
  await expect(promptButton(p, "Not now")).toBeVisible();
  await expect(promptButton(p, "Don't ask again")).toBeVisible();
  // Inline on the dashboard, never a dialog.
  await expect(p.getByRole("dialog")).toHaveCount(0);
}

/** The dashboard has finished its requests and still shows no card. */
async function expectPromptAbsentOnceSettled(p: Page): Promise<void> {
  await p.waitForLoadState("networkidle");
  await expect(promptCard(p)).toHaveCount(0);
}

/** A page signed in as the boot's admin: journeys.spec's saved session if it still works. */
async function adminPage(browser: Browser): Promise<{ admin: Page; email: string }> {
  const state = loadEphemeralState();
  if (!state) throw new Error("ephemeral state missing: e2e:serve writes it");
  if (existsSync(ADMIN_SESSION_PATH)) {
    const saved = await newContext(browser, { storageState: ADMIN_SESSION_PATH });
    const admin = await saved.newPage();
    if ((await currentSessionId(admin)) !== null) return { admin, email: state.admin.email };
    await saved.close();
  }
  const fresh = await newContext(browser);
  const admin = await fresh.newPage();
  await loginAs(admin, state.admin);
  return { admin, email: state.admin.email };
}

test("J1: add a passkey from My settings; it is listed", async () => {
  await step(page, "Sign in with password + TOTP", async () => {
    await loginAs(page, QA_EMPLOYEE);
    signedInAt = Date.now();
  });

  await step(page, "Clear an earlier run's leftovers; record the baseline", async () => {
    const leftovers = (await listPasskeys(page)).filter(isOwnLeftover);
    expect(await deleteAll(page, leftovers), "leftover CI passkeys deleted").toBe(0);
    baseline = new Set((await listPasskeys(page)).map((r) => r.id));
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
    const known = baseline ?? new Set<string>();
    await expect(rowNamed(page, KEY_NAME)).toHaveCount(1);
    await expect(passkeyRows(page)).toHaveCount(known.size + 1);
    // Count only: printing the credentials would log key material (S11).
    const held = await authenticator?.credentials();
    expect(held?.length, "virtual authenticator credential count").toBe(1);
    const added = (await listPasskeys(page)).filter((r) => !known.has(r.id));
    expect(added.map((r) => r.name)).toEqual([KEY_NAME]);
  });
});

test("Active sessions: 'Signed in with' shows Password + code for this session", async () => {
  await step(page, "Sessions table has a 'Signed in with' column", async () => {
    await page.goto("/my/settings");
    await expect(page.getByRole("columnheader", { name: "Signed in with" })).toBeVisible();
  });

  await step(page, "This session was signed in with Password + code", async () => {
    expect(await currentAuthMethod(page), "current session authMethod").toBe("password_totp");
    await expect(
      page.getByRole("row").filter({ hasText: "Password + code" }).first(),
    ).toBeVisible();
  });
});

test("J2: sign out, then sign in with the passkey button; no code prompt", async () => {
  await step(page, "Sign out", async () => {
    await signOut(page);
    await expectLoginWithPasskeyButton(page);
  });

  await step(page, `Click "${SIGN_IN_BUTTON}"`, async () => {
    const totpCalls = countRequests(page, VERIFY_TOTP_PATH);
    try {
      const { status } = await retryOnRateLimit(page, () => clickPasskeySignIn(page));
      await expectPasskeySignedIn(page, status);
      expect(totpCalls.count(), "no authenticator-code step").toBe(0);
    } finally {
      totpCalls.stop();
    }
    await expect(page.locator("#totp")).toHaveCount(0);
  });

  await step(page, "The dashboard shows no passkey prompt", async () => {
    // Two gates are closed here, and this cannot tell them apart: the session
    // is "passkey" (not password + TOTP), and the account holds a passkey, so
    // the server already answers due=false. This proves a user signing in with
    // a passkey sees no card, not that the session-method gate alone hides it.
    expect(await promptDue(page), "passkeyPromptDue with a passkey").toBe(false);
    await expectPromptAbsentOnceSettled(page);
  });

  await step(page, "Active sessions: this session reads Passkey", async () => {
    await page.goto("/my/settings");
    await expect(page.getByRole("columnheader", { name: "Signed in with" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Passkey", exact: true }).first()).toBeVisible();
  });
});

/*
 * J4, probed 2026-11-03 on Playwright's chromium 1243: with the virtual
 * authenticator's user verification set to fail, Chrome refuses the ceremony
 * itself. navigator.credentials.get rejects with NotAllowedError within a few
 * milliseconds, for userVerification "required" and "preferred" alike, and no
 * assertion (UV=0) is ever produced. So the browser never calls
 * verify-authentication, and the login page shows its calm "cancelled" info.
 * The server's own refusal of a UV=0 assertion (PASSKEY_USER_VERIFICATION_
 * REQUIRED, the "fingerprint, face, or device PIN" message) cannot be reached
 * from a real browser here; apps/server/test/passkey.test.ts (T4) covers it
 * with a soft authenticator.
 */
test("J4: user verification fails; the browser refuses, still signed out on /login", async () => {
  await step(page, "Sign out", async () => {
    await signOut(page);
    await expectLoginWithPasskeyButton(page);
  });

  await step(
    page,
    "Device check fails: calm cancelled info, no verify call, no session",
    async () => {
      const verifyCalls = countRequests(page, PASSKEY_VERIFY_PATH);
      await authenticator?.setUserVerified(false);
      try {
        const options = page.waitForResponse(
          (res) => new URL(res.url()).pathname === PASSKEY_OPTIONS_PATH,
        );
        await page.getByRole("button", { name: SIGN_IN_BUTTON, exact: true }).click();
        expect((await options).status(), `GET ${PASSKEY_OPTIONS_PATH}`).toBe(200);
        const info = loginMessage(page, "cancelled");
        await expect(info).toBeVisible();
        await expect(info).toHaveClass(/p-message-info/);
        await expect(loginMessage(page, "fingerprint, face, or device PIN")).toHaveCount(0);
        expect(verifyCalls.count(), "the browser sent no assertion").toBe(0);
      } finally {
        verifyCalls.stop();
        await authenticator?.setUserVerified(true);
      }
      await expect(page).toHaveURL(/\/login/);
      expect(await currentSessionId(page), "no session").toBeNull();
    },
  );
});

test("J5: the email field offers passkey autofill; picking the passkey signs in", async () => {
  await step(page, 'Email field has autocomplete "username webauthn"', async () => {
    await page.goto("/login");
    await expect(page.locator("#email")).toHaveAttribute("autocomplete", "username webauthn");
  });

  const conditional = await page.evaluate(
    async () => (await window.PublicKeyCredential?.isConditionalMediationAvailable?.()) === true,
  );
  test.skip(
    !conditional,
    "PublicKeyCredential.isConditionalMediationAvailable() is false in this browser: the autofill ceremony cannot run (a test item, not a blocker)",
  );

  await step(page, "The page asked for autofill on load", async () => {
    await expect.poll(() => autofillRequests(page), { timeout: 10_000 }).toBeGreaterThan(0);
  });

  await step(page, "Pick the passkey from the email suggestions", async () => {
    // The suggestion list is browser UI, out of the page's reach; releasing
    // the held request is the stand-in for the pick (support/webauthn.ts).
    const verify = nextPost(page, PASSKEY_VERIFY_PATH);
    expect(await releaseAutofill(page), "held autofill requests").toBe(1);
    await expectPasskeySignedIn(page, (await verify).status());
  });
});

test("J3: rename the passkey, then remove it; the list is empty", async () => {
  await step(page, "Signed in with the passkey (fresh step-up)", async () => {
    if ((await currentSessionId(page)) === null) {
      // J5 skipped: sign in with the button instead.
      await openLogin(page);
      const { status } = await retryOnRateLimit(page, () => clickPasskeySignIn(page));
      await expectPasskeySignedIn(page, status);
    }
    await page.goto("/my/settings");
    await expect(rowNamed(page, KEY_NAME)).toHaveCount(1);
  });

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

  await step(page, "Back to the baseline (empty state when it was empty)", async () => {
    const known = [...(baseline ?? [])].sort();
    if (known.length === 0) {
      await expect(page.getByText("You have no passkeys yet.")).toBeVisible();
    }
    await expect(passkeyRows(page)).toHaveCount(known.length);
    // On the ephemeral boot and a clean QA account the baseline is empty: [].
    expect(sortedIds(await listPasskeys(page)), "server list equals the baseline").toEqual(known);
    ownRemoved = true;
  });
});

test("J3: the removed passkey no longer signs in", async () => {
  await step(page, "Sign out; the authenticator still holds the credential", async () => {
    await signOut(page);
    await expectLoginWithPasskeyButton(page);
    // Count only (S11).
    expect(
      (await authenticator?.credentials())?.length,
      "virtual authenticator credential count",
    ).toBe(1);
  });

  await step(page, `Click "${SIGN_IN_BUTTON}": "no longer linked", still on /login`, async () => {
    const { status } = await retryOnRateLimit(page, () => clickPasskeySignIn(page));
    expect(status, `POST ${PASSKEY_VERIFY_PATH} refuses the removed passkey`).not.toBe(200);
    await expect(loginMessage(page, "no longer linked")).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
    expect(await currentSessionId(page), "no session").toBeNull();
  });
});

test('J6: the prompt shows after a password + TOTP sign-in; "Not now" keeps it away next time', async () => {
  test.skip(LIVE_QA, LIVE_QA_SKIP);

  await step(page, "Sign in with password + TOTP, 0 passkeys on the account", async () => {
    await loginAs(page, QA_EMPLOYEE);
    signedInAt = Date.now();
    await expectPromptGatesOpen(page);
  });

  const due = await promptDue(page);
  test.skip(
    test.info().retry > 0 && due !== true,
    "this boot already holds the first attempt's Not now (30 days); the database survives a CI retry",
  );
  expect(due, "passkeyPromptDue").toBe(true);

  await step(page, "The dashboard shows the prompt card", async () => {
    await expectPromptShown(page);
  });

  await step(page, 'Click "Not now"; the card goes and the choice is stored', async () => {
    const saved = nextPost(page, PROMPT_PATH);
    await promptButton(page, "Not now").click();
    const response = await saved;
    expect(response.status(), `POST ${PROMPT_PATH}`).toBe(200);
    expect(response.request().postDataJSON()).toEqual({ choice: "not_now" });
    await expect(promptCard(page)).toHaveCount(0);
    // "Don't ask again" confirms with a toast; "Not now" stays quiet.
    await expect(page.locator(".p-toast-message")).toHaveCount(0);
    expect(await promptDue(page), "passkeyPromptDue after Not now").toBe(false);
  });

  await step(page, "Sign out, sign in with password + TOTP: no card", async () => {
    await signOut(page);
    await loginAs(page, QA_EMPLOYEE);
    signedInAt = Date.now();
    await expectPromptGatesOpen(page);
    expect(await promptDue(page), "passkeyPromptDue").toBe(false);
    await expectPromptAbsentOnceSettled(page);
  });
});

test("J7: Add a passkey from the prompt card, no dialog; the card goes", async ({ browser }) => {
  test.skip(LIVE_QA, LIVE_QA_SKIP);
  enrollContext = await newContext(browser);
  const p = await enrollContext.newPage();
  enrollPage = p;
  enrollAuthenticator = await addVirtualAuthenticator(p);
  await holdPasskeyAutofill(p);

  await step(p, "Second user signs in with password + TOTP", async () => {
    await loginAs(p, QA_CONTRACTOR);
    enrollSignedInAt = Date.now();
    // A failed earlier attempt in this boot may have left its passkey.
    const leftovers = await listPasskeys(p);
    expect(await deleteAll(p, leftovers), "leftover passkeys deleted").toBe(0);
    if (leftovers.length > 0) await p.goto("/my/dashboard");
    await expectPromptGatesOpen(p);
    expect(await promptDue(p), "passkeyPromptDue").toBe(true);
  });

  await step(p, "The dashboard shows the prompt card", async () => {
    await expectPromptShown(p);
  });

  await step(p, 'Click "Add a passkey": registers with no dialog; the card goes', async () => {
    // A name dialog would stop the ceremony before this response ever comes.
    const registered = p.waitForResponse(
      (res) =>
        res.request().method() === "POST" && new URL(res.url()).pathname === PASSKEY_REGISTER_PATH,
      { timeout: 15_000 },
    );
    await promptButton(p, "Add a passkey").click();
    expect((await registered).status(), `POST ${PASSKEY_REGISTER_PATH}`).toBe(200);
    await expect(p.getByRole("dialog")).toHaveCount(0);
    await expect(promptCard(p)).toHaveCount(0);
  });

  await step(p, "The account holds one unnamed passkey", async () => {
    const records = await listPasskeys(p);
    expect(records.length, "passkeys on the account").toBe(1);
    expect((records[0]?.name ?? "").trim(), "added without a name").toBe("");
    // Count only (S11).
    const held = await enrollAuthenticator?.credentials();
    expect(held?.length, "virtual authenticator credential count").toBe(1);
    expect(await promptDue(p), "passkeyPromptDue with a passkey").toBe(false);
  });
});

test('Admin users table: "Sign-in" column reads Password + code for a TOTP user', async ({
  browser,
}) => {
  test.skip(LIVE_QA, LIVE_QA_SKIP);
  const { admin, email } = await adminPage(browser);
  try {
    await step(admin, "Open Settings, Users tab", async () => {
      await admin.goto("/admin/settings");
      await admin.getByRole("tab", { name: "Users", exact: true }).click();
      await expect(admin.getByRole("columnheader", { name: "Sign-in", exact: true })).toBeVisible();
    });

    await step(admin, "The admin's own row (TOTP on) starts with Password + code", async () => {
      const row = admin.getByRole("row").filter({ hasText: email });
      await expect(row).toHaveCount(1);
      await expect(row.getByRole("cell", { name: /^Password \+ code/ })).toBeVisible();
    });

    // J7's passkey is still on the account: its cleanup runs in afterAll.
    await step(admin, "J7's user (one passkey) reads Password + code, 1 passkey", async () => {
      const row = admin.getByRole("row").filter({ hasText: QA_CONTRACTOR.email });
      await expect(row).toHaveCount(1);
      await expect(
        row.getByRole("cell", { name: "Password + code, 1 passkey", exact: true }),
      ).toBeVisible();
    });
  } finally {
    await admin.context().close();
  }
});
