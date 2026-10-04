/**
 * Spec 24 (PAY-116) PR-4 round 4 — two web guards, pinned by reading the
 * Vue sources (the web app has no test runner; same style as
 * w2-state-pr4-web.test.ts). payroll-calc-auditor, fail-first; the coder may
 * not edit this file.
 *
 * R4-1 (code-reviewer MEDIUM, carry-over f / D-PL2): in
 *   StateTaxAccountNumbers.vue, Save must be impossible until the state-ID
 *   list has loaded: `canSave` (directly, or through computeds it reads)
 *   requires `list.value` to be non-null and `loadError.value` to be false.
 *   Otherwise affected() reads `list.value?.furnished ?? []` as 0 and the
 *   "W-2s already given out" confirmation is skipped. The Save button stays
 *   bound to canSave, and save() still returns early on !canSave.
 * R4-2 (code-reviewer LOW): in AdminFilingDetailView.vue, `warnOnlyCount`
 *   (directly or through computeds it reads) counts the year-level warn
 *   issues (`yearAttention` / `w2YearIssues`), not only `attentionRows`, so
 *   the "worth a second look" banner shows when the only warnings are
 *   year-level.
 *
 * The checks resolve computeds transitively (a helper such as
 * `const listReady = computed(...)` is fine) and ignore formatting. For
 * R4-2 the `anyW2Blocked` subtree is excluded: it reads w2YearIssues for
 * the hold decision, which is not counting the warnings.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./annual-w2-corrected-harness.js";

function src(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8").replace(/\/\/[^\n]*/g, "");
}

/** The body of `const <name> = computed(...)` (balanced parentheses), or null. */
function computedBody(text: string, name: string): string | null {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*computed(?:<[^>]*>)?\\(`).exec(text);
  if (!m) return null;
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  while (i < text.length && depth > 0) {
    const c = text[i];
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    i += 1;
  }
  return text.slice(start, i - 1);
}

/** The computed's body plus the bodies of every computed it reads (transitively). */
function resolvedBody(text: string, name: string, seen = new Set<string>()): string {
  if (seen.has(name)) return "";
  seen.add(name);
  const body = computedBody(text, name);
  if (body === null) return "";
  let out = body;
  for (const m of body.matchAll(/\b([A-Za-z_$][\w$]*)\.value\b/g)) {
    const dep = m[1] as string;
    if (computedBody(text, dep) !== null) out += `\n${resolvedBody(text, dep, seen)}`;
  }
  return out;
}

const STATE_IDS = "apps/web/src/components/StateTaxAccountNumbers.vue";
const FILING = "apps/web/src/views/admin/AdminFilingDetailView.vue";

describe("R4-1 StateTaxAccountNumbers: no Save until the state-ID list has loaded", () => {
  it("canSave requires list.value non-null and loadError.value false (directly or via computeds)", () => {
    const text = src(STATE_IDS);
    const body = resolvedBody(text, "canSave");
    const listLoaded =
      /\blist\.value\s*!==?\s*null\b/.test(body) ||
      /\bnull\s*!==?\s*list\.value\b/.test(body) ||
      /!!\s*list\.value\b/.test(body) ||
      /\blist\.value\s*&&/.test(body) ||
      /\blist\.value\s*!==?\s*undefined\b/.test(body);
    const notLoadError =
      /!\s*loadError\.value\b/.test(body) || /\bloadError\.value\s*===?\s*false\b/.test(body);
    expect({ found: body.length > 0, listLoaded, notLoadError }).toEqual({
      found: true,
      listLoaded: true,
      notLoadError: true,
    });
  });

  it("guard: the Save button is disabled by !canSave and save() returns early on !canSave", () => {
    const text = src(STATE_IDS);
    const saveFn = /function\s+save\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/.exec(text)?.[1] ?? "";
    expect({
      button: /:disabled="[^"]*!\s*canSave\b[^"]*"/.test(text),
      early: /if\s*\(\s*!\s*canSave\.value\b[^)]*\)\s*return/.test(saveFn),
    }).toEqual({ button: true, early: true });
  });
});

describe("R4-2 AdminFilingDetailView: the warnings-only banner counts year-level warn issues", () => {
  it("warnOnlyCount reads yearAttention or w2YearIssues (directly or via computeds), as well as attentionRows", () => {
    const text = src(FILING);
    const body = resolvedBody(text, "warnOnlyCount");
    // anyW2Blocked reads w2YearIssues for the hold itself; that does not
    // count the warnings, so its subtree is left out of the year-level check.
    const counted = resolvedBody(text, "warnOnlyCount", new Set(["anyW2Blocked"]));
    expect({
      found: body.length > 0,
      yearLevel: /\b(yearAttention|w2YearIssues)\.value\b/.test(counted),
      rows: /\battentionRows\.value\b/.test(body),
      heldIsZero: /\banyW2Blocked\.value\b/.test(body),
    }).toEqual({ found: true, yearLevel: true, rows: true, heldIsZero: true });
  });
});
