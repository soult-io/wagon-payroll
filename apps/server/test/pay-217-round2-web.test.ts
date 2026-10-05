/**
 * PAY-217 fix round 2 — web source checks (the web app has no test
 * runner). payroll-calc-auditor, fail-first against bd69ff1; the coder may
 * not edit this file.
 *  - F2 (federal SME): MyW2AccessView.vue has no "will also give you a
 *    paper copy" line (the IMPORTANT mail carries it; the footer offers paper).
 *  - C3 (code-reviewer): the former-employee "Mark handed on paper" action
 *    asks for confirmation with confirm.require, like the PAY-206 action.
 *    The e2e (pay-217-former.spec.ts) clicks the dialog's accept button.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./annual-w2-corrected-harness.js";

const src = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Body of the function whose declaration matches `decl` (brace-matched). */
function fnBody(text: string, decl: RegExp): string | null {
  const m = decl.exec(text);
  if (!m) return null;
  const open = text.indexOf("{", m.index + m[0].length - 1);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth += 1;
    if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return null;
}

describe("PAY-217 R2 web", () => {
  it("F2 the former-employee W-2 screen has no 'will also give you a paper copy' line", () => {
    const view = src("apps/web/src/views/my/MyW2AccessView.vue");
    expect(/will also give you a paper copy/i.test(view)).toBe(false);
  });

  it("C3 the former-employee 'Mark handed on paper' handler confirms with confirm.require before it records", () => {
    const view = src("apps/web/src/views/admin/AdminFilingDetailView.vue");
    const button = /label="Mark handed on paper"[\s\S]*?@click="(?:void )?(\w+)\(/.exec(view);
    const handler = button?.[1] ?? null;
    const body = handler ? fnBody(view, new RegExp(`function ${handler}\\s*\\(`)) : null;
    const confirmAt = body?.indexOf("confirm.require(") ?? -1;
    const callAt = body?.indexOf("w2MarkGivenOnPaper(") ?? -1;
    expect({
      handlerFound: body !== null,
      confirms: confirmAt >= 0,
      recordsInsideAccept:
        confirmAt >= 0 && callAt > confirmAt && /accept\s*:/.test(body!.slice(confirmAt, callAt)),
    }).toEqual({ handlerFound: true, confirms: true, recordsInsideAccept: true });
  });
});
