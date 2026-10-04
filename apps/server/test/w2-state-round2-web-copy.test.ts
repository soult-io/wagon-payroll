/**
 * Spec 24 (PAY-116) PR-3 fix round 2 (R1, R4, R5) — web issue copy
 * coverage (payroll-calc-auditor, fail-first). The web app has no test
 * runner, so this server-suite test reads the web sources:
 *  - the web W2IssueCode union (apps/web/src/lib/api.ts) lists exactly the
 *    server's codes (apps/server/src/filings/w2-boxes.ts);
 *  - w2IssueLabel / w2IssueText (apps/web/src/lib/w2-issues.ts) give a
 *    non-empty, amount-free label and sentence for the three new codes
 *    (the form names "W-2" / "W-3" are allowed; any other digit or "$" is not).
 * Copy per the round-2 spec: state_id_unreadable label "State ID can't be
 * read"; state_id_too_long label "State ID too long for the form". The UX
 * draft may replace the state_id_unreadable / ein_unreadable wording, so only
 * the settings pointer is pinned. PR-4: the UX gate renamed the
 * state_id_too_long label ("State number too long"), so it is checked by
 * keyword ("too long"); the tax year may now appear in the text.
 *
 * Spec 24 (PAY-116) PR-4 C-a1 (carry-over a): "Company settings" is not a
 * label in the app. The pointer must name the real path: nav "Config", tab
 * "Company", then the section "State tax account numbers" (state IDs) or
 * "Company profile" (EIN), in that order. No issue text or label for any
 * code may say "Company settings", and no file under apps/web/src may
 * contain it.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./annual-w2-corrected-harness.js";

const NEW_CODES = ["state_id_unreadable", "ein_unreadable", "state_id_too_long"] as const;

/** PR-4 C-a1: "Config" (nav), then "Company" (tab), then the section, in that order. */
const STATE_PATH = /\bConfig\b[\s\S]*?\bCompany\b[\s\S]*?State tax account numbers/;
const PROFILE_PATH = /\bConfig\b[\s\S]*?\bCompany\b[\s\S]*?Company profile/;
const REAL_PATH: Record<string, RegExp> = {
  missing_state_id: STATE_PATH,
  missing_state_id_zero_tax: STATE_PATH,
  state_id_unreadable: STATE_PATH,
  state_id_too_long: STATE_PATH,
  ein_unreadable: PROFILE_PATH,
};

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

  it("w2IssueLabel / w2IssueText: non-empty, no amount, no digits except W-2/W-3; Config -> Company -> section pointer; state_id_too_long label pinned", async () => {
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
        // Form names "W-2" / "W-3" are allowed; any other digit or "$" is not.
        // PR-4: the tax year (2026) and a box number ("box 15") may appear; any other digit or "$" may not.
        noAmount: !/\$|\d/.test(
          `${label ?? ""} ${text ?? ""}`
            .replace(/\bW-[23]\b/g, "")
            .replace(/\b2026\b/g, "")
            .replace(/\bbox(?:es)? \d+(?:[–-]\d+)?\b/g, ""),
        ),
        settings: typeof text === "string" && REAL_PATH[code].test(text),
      };
    }
    // PR-4 UX final: "State number too long" (was "State ID too long for the form").
    out.tooLongLabel = /too long/i.test(
      mod.w2IssueLabel({ code: "state_id_too_long", severity: "block" }),
    );
    const ok = { label: true, text: true, noAmount: true, settings: true };
    expect(out).toEqual({
      state_id_unreadable: ok,
      ein_unreadable: ok,
      state_id_too_long: ok,
      tooLongLabel: true,
    });
  });

  it("C-a1 missing_state_id and missing_state_id_zero_tax point to Config -> Company -> State tax account numbers", async () => {
    const mod = (await import(resolve(ROOT, "apps/web/src/lib/w2-issues.ts"))) as {
      w2IssueText(
        i: { code: string; severity: string; state?: string },
        ctx: { legalName: string; year: number },
      ): string;
    };
    const out: Record<string, boolean> = {};
    for (const code of ["missing_state_id", "missing_state_id_zero_tax"] as const) {
      const text = mod.w2IssueText(
        { code, severity: code === "missing_state_id" ? "block" : "warn", state: "CA" },
        { legalName: "Ana Synthetic", year: 2026 },
      );
      out[code] = (REAL_PATH[code] as RegExp).test(text);
    }
    expect(out).toEqual({ missing_state_id: true, missing_state_id_zero_tax: true });
  });

  it('C-a1 no w2IssueText / w2IssueLabel for any code says "Company settings"; no file under apps/web/src does', async () => {
    const mod = (await import(resolve(ROOT, "apps/web/src/lib/w2-issues.ts"))) as {
      w2IssueLabel(i: { code: string; severity: string; state?: string }): string;
      w2IssueText(
        i: { code: string; severity: string; state?: string },
        ctx: { legalName: string; year: number },
      ): string;
    };
    const offenders: string[] = [];
    for (const code of unionMembers("apps/web/src/lib/api.ts")) {
      for (const severity of ["block", "warn", "info"]) {
        const issue = { code, severity, state: "CA", date: "2026-06-10" };
        const text = `${mod.w2IssueLabel(issue)} ${mod.w2IssueText(issue, {
          legalName: "Ana Synthetic",
          year: 2026,
        })}`;
        if (/Company settings/.test(text)) offenders.push(`${code}/${severity}`);
      }
    }
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/Company settings/.test(readFileSync(p, "utf8"))) files.push(p.slice(ROOT.length));
      }
    };
    walk(resolve(ROOT, "apps/web/src"));
    expect({ offenders: [...new Set(offenders)], files }).toEqual({ offenders: [], files: [] });
  });
});
