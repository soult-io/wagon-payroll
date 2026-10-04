/**
 * Spec 24 (PAY-116) PR-4 round 5 — year-level-hold copy (UX round 4) and
 * the null-worksheet fallback (payroll-calc-auditor; the coder may not edit
 * this file). The web app has no test runner: pure functions are imported
 * from apps/web/src/lib, the view is read as source.
 *
 * R5-1..R5-4 (guards; they pass on 4f6840a): the round-4 strings of
 * /private/tmp/wagon-pay116-pr4-copy.md "Round 4", pinned exactly —
 *  - w2BlockedText(year, notified, yearOnlyStates): body + notice line for
 *    notified false / true;
 *  - yearIssueStatesText(issues, capital?): state names sorted by code,
 *    joined " and ", deduplicated; "state" / "State" when no issue names a
 *    state (block issues, as the view passes them);
 *  - W3_STATE_CHECK_HOLD_TEXT;
 *  - reconciliation_mismatch text with a state (full name) and without one
 *    ("state").
 * R5-5 (fail-first): AdminFilingDetailView.vue's null-worksheet paragraph
 *  may say "W-2s on hold" only when a W-2 row is held (rowHold), never on
 *  anyW2Blocked alone (a year-level hold holds no W-2).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./annual-w2-corrected-harness.js";

// biome-ignore lint/suspicious/noExplicitAny: contract-shaped dynamic import
type Any = any;

const issues = async () =>
  (await import(resolve(ROOT, "apps/web/src/lib/w2-issues.ts"))) as Record<string, Any>;
const filing = async () =>
  (await import(resolve(ROOT, "apps/web/src/lib/w2-filing.ts"))) as Record<string, Any>;

describe("R5-1 w2BlockedText, year-level hold only (UX round 4, exact)", () => {
  const BODY =
    "The Illinois and New York tax on your 2026 W-2s doesn't match your issued pay runs. Until that's fixed, you can't download the W-3 or record this filing. Each W-2 can still be downloaded, but don't file or hand out 2026 W-2s yet. You'll find the details under \"W-2s that need attention\" below.";

  it("notified false", async () => {
    const m = await issues();
    expect(m.w2BlockedText(2026, false, "Illinois and New York")).toBe(
      `${BODY} Employees haven't been told their 2026 W-2s are ready. We'll email the employees who get their W-2 online once this is fixed.`,
    );
  });

  it("notified true", async () => {
    const m = await issues();
    expect(m.w2BlockedText(2026, true, "Illinois and New York")).toBe(
      `${BODY} Employees already got the "your W-2 is ready" email for 2026 and can still download their W-2s, so contact support soon.`,
    );
  });

  it("no state named: the {States} slot takes the fallback text", async () => {
    const m = await issues();
    const states = m.yearIssueStatesText([{ code: "reconciliation_mismatch", severity: "block" }]);
    expect(
      String(m.w2BlockedText(2026, false, states)).startsWith(
        "The state tax on your 2026 W-2s doesn't match",
      ),
    ).toBe(true);
  });
});

describe("R5-2 yearIssueStatesText (block issues)", () => {
  const rm = (state?: string) => ({
    code: "reconciliation_mismatch",
    severity: "block",
    ...(state ? { state } : {}),
  });

  it('sorted by code (NY after IL, CA first), deduplicated, joined with " and "', async () => {
    const m = await issues();
    expect({
      one: m.yearIssueStatesText([rm("IL")]),
      two: m.yearIssueStatesText([rm("NY"), rm("IL")]),
      three: m.yearIssueStatesText([rm("NY"), rm("CA"), rm("IL"), rm("NY")]),
    }).toEqual({
      one: "Illinois",
      two: "Illinois and New York",
      three: "California and Illinois and New York",
    });
  });

  it('no state on any issue: "state", or "State" with capital', async () => {
    const m = await issues();
    expect({
      lower: m.yearIssueStatesText([rm()]),
      upper: m.yearIssueStatesText([rm()], true),
      empty: m.yearIssueStatesText([]),
      stateGivenCapital: m.yearIssueStatesText([rm("IL")], true),
    }).toEqual({ lower: "state", upper: "State", empty: "state", stateGivenCapital: "Illinois" });
  });
});

describe("R5-3 W3_STATE_CHECK_HOLD_TEXT", () => {
  it("exact round-4 string", async () => {
    const m = await filing();
    expect(m.W3_STATE_CHECK_HOLD_TEXT).toBe(
      "Your W-3 can be made once the state tax check below matches.",
    );
  });
});

describe("R5-4 reconciliation_mismatch issue text", () => {
  it('with a state: the full state name; without: "state"', async () => {
    const m = await issues();
    const ctx = { legalName: "", year: 2026 };
    expect({
      il: m.w2IssueText({ code: "reconciliation_mismatch", severity: "block", state: "IL" }, ctx),
      none: m.w2IssueText({ code: "reconciliation_mismatch", severity: "block" }, ctx),
    }).toEqual({
      il: "The Illinois tax on your W-2s doesn't match the Illinois tax on your issued pay runs. Don't send these forms yet. Contact support.",
      none: "The state tax on your W-2s doesn't match the state tax on your issued pay runs. Don't send these forms yet. Contact support.",
    });
  });
});

// ------------------------------------------------------------------- R5-5

const VIEW = "apps/web/src/views/admin/AdminFilingDetailView.vue";

/**
 * The condition text that governs a template position: the enclosing
 * `{{ … }}` expression (the part before the position) when there is one,
 * else the v-if / v-else-if / v-show of the enclosing opening tag.
 */
function governingCondition(tpl: string, pos: number): string {
  const open = tpl.lastIndexOf("{{", pos);
  const close = tpl.lastIndexOf("}}", pos);
  if (open > close) return tpl.slice(open + 2, pos);
  const tagStart = tpl.lastIndexOf("<", pos);
  const tag = tpl.slice(tagStart, tpl.indexOf(">", tagStart) + 1);
  const cond = /\bv-(?:else-if|if|show)="([^"]*)"/.exec(tag)?.[1];
  return cond ?? (/\bv-else\b/.test(tag) ? "<v-else>" : "");
}

describe('R5-5 null-worksheet fallback: "W-2s on hold" only on a row hold', () => {
  it('every "W-2s on hold" (or a *NotCalculated* helper call) in the template is governed by rowHold, not anyW2Blocked alone', () => {
    const text = readFileSync(resolve(ROOT, VIEW), "utf8");
    const start = text.indexOf("<template>");
    const tpl = text.slice(start);
    const anchors = [
      ...[...tpl.matchAll(/W-2s on hold/g)].map((m) => m.index ?? 0),
      ...[...tpl.matchAll(/\b\w*[Nn]otCalculated\w*\s*\(/g)].map((m) => m.index ?? 0),
    ];
    const conditions = anchors.map((a) => governingCondition(tpl, a).replace(/\s+/g, " ").trim());
    expect({
      found: anchors.length > 0,
      allRowHold: conditions.every((c) => /\browHold\b/.test(c)),
      conditions: conditions.filter((c) => !/\browHold\b/.test(c)),
    }).toEqual({ found: true, allRowHold: true, conditions: [] });
  });
});
