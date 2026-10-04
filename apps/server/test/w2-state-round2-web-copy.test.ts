/**
 * Spec 24 (PAY-116) PR-3 fix round 2 (R1, R4, R5) — web issue copy
 * coverage (payroll-calc-auditor, fail-first). The web app has no test
 * runner, so this server-suite test reads the web sources:
 *  - the web W2IssueCode union (apps/web/src/lib/api.ts) lists exactly the
 *    server's codes (apps/server/src/filings/w2-boxes.ts);
 *  - w2IssueLabel / w2IssueText (apps/web/src/lib/w2-issues.ts) give a
 *    non-empty, amount-free label and sentence for the three new codes.
 * Copy per the round-2 spec: state_id_unreadable label "State ID can't be
 * read"; state_id_too_long label "State ID too long for the form". The UX
 * draft may replace the state_id_unreadable / ein_unreadable wording, so only
 * the state_id_too_long label and the "Company settings" pointer are pinned.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./annual-w2-corrected-harness.js";

const NEW_CODES = ["state_id_unreadable", "ein_unreadable", "state_id_too_long"] as const;

/** The string members of `export type W2IssueCode = | "a" | "b" …;` in a source file. */
function unionMembers(path: string): string[] {
  // Line comments may contain ";" — drop them before matching the union.
  const src = readFileSync(resolve(ROOT, path), "utf8").replace(/\/\/[^\n]*/g, "");
  const m = /export type W2IssueCode =([\s\S]*?);/.exec(src);
  if (!m) throw new Error(`no W2IssueCode union in ${path}`);
  return [...(m[1] ?? "").matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1] as string).sort();
}

describe("web W2IssueCode union and copy cover the round-2 codes", () => {
  it("server union includes state_id_unreadable, ein_unreadable, state_id_too_long; the web union equals the server union", () => {
    const server = unionMembers("apps/server/src/filings/w2-boxes.ts");
    const web = unionMembers("apps/web/src/lib/api.ts");
    expect({
      serverHasNew: NEW_CODES.filter((c) => !server.includes(c)),
      webEqualsServer: web,
    }).toEqual({ serverHasNew: [], webEqualsServer: server });
  });

  it("w2IssueLabel / w2IssueText: non-empty, no amount, no digits; settings pointer; state_id_too_long label pinned", async () => {
    const mod = (await import(resolve(ROOT, "apps/web/src/lib/w2-issues.ts"))) as {
      w2IssueLabel(i: { code: string; severity: string; state?: string }): string;
      w2IssueText(
        i: { code: string; severity: string; state?: string },
        ctx: { legalName: string; year: number },
      ): string;
    };
    const out: Record<string, unknown> = {};
    for (const code of NEW_CODES) {
      const issue = { code, severity: "block", state: "CA" };
      const label = mod.w2IssueLabel(issue);
      const text = mod.w2IssueText(issue, { legalName: "Ana Synthetic", year: 2026 });
      out[code] = {
        label: typeof label === "string" && label.length > 0,
        text: typeof text === "string" && text.length > 0,
        noAmount: !/\$|\d/.test(`${label ?? ""}${text ?? ""}`),
        settings: typeof text === "string" && /Company settings/.test(text),
      };
    }
    out.tooLongLabel = mod.w2IssueLabel({ code: "state_id_too_long", severity: "block" });
    const ok = { label: true, text: true, noAmount: true, settings: true };
    expect(out).toEqual({
      state_id_unreadable: ok,
      ein_unreadable: ok,
      state_id_too_long: ok,
      tooLongLabel: "State ID too long for the form",
    });
  });
});
