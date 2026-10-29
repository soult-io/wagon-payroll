/**
 * PAY-251 — web: the "Recompute worksheet" dialog shows plain line labels
 * ("Line 5c — Taxable Medicare wages") and formatted values instead of raw
 * worksheet keys ("line5cTaxableMedicareWages", "line16.month1"), and names
 * the filing it changes. Tested from the server suite (the web app has no
 * test runner; same method as pay-217-web.test.ts): a pure label module
 * plus source checks of the wiring.
 * Test author: independent of the coder, fail-first; the coder may not edit
 * this file. Synthetic round figures only (public repo).
 *
 * Contract assumed — apps/web/src/lib/worksheet-labels.ts (pure, no Vue):
 *  - WORKSHEET_941_FIELDS / WORKSHEET_940_FIELDS / WORKSHEET_W3_FIELDS
 *    (W-3 excludes `states`) / WORKSHEET_W3_STATE_FIELDS:
 *    Record<flattenedKey, { line: string | null; label: string; kind } | null>;
 *    null = hidden. Hidden: form, year, 941 quarter, 941 line7Computed.
 *  - filingName(formType, year, quarter): "Form 941, Q3 2026" |
 *    "Form 940, 2026" | "Forms W-2/W-3, 2026" (quarter 0 = annual).
 *  - recomputeDiffRows(before | null, after): { key, title, before, after }[]
 *    — changed visible fields only, in map declaration order. Title
 *    "<Line|Box> <line> — <label>" (label alone when line is null). Values
 *    formatted by kind (money "$1,234.50", count, Yes/No, percent "5.4%",
 *    quarter "Q2"/"None", date "31 Jul 2026", W-3 box 15 text). Missing
 *    before -> "—". Unknown key -> title "Other figure", raw value. W-3
 *    states keyed states.<CODE>.<field>, title "<CODE> — <label>", matched
 *    by code. No title holds a camelCase token or a dot-path.
 * Wiring (source): AdminFilingDetailView.vue imports recomputeDiffRows and
 * filingName, drops flattenWs, binds the recompute Dialog header with
 * filingName(...), names the filing at the confirm button, and references
 * WORKSHEET_941_FIELDS / WORKSHEET_940_FIELDS; w3WorksheetLines in
 * lib/w2-filing.ts references WORKSHEET_W3_FIELDS.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./annual-w2-corrected-harness.js";

// biome-ignore lint/suspicious/noExplicitAny: contract-shaped dynamic import
type Any = any;
type Row = { key: string; title: string; before: string; after: string };
const LIB = "apps/web/src/lib/worksheet-labels.ts";
async function lib(): Promise<Record<string, Any>> {
  return (await import(/* @vite-ignore */ resolve(ROOT, LIB))) as Record<string, Any>;
}
function need(mod: Record<string, Any>, name: string): Any {
  const v = mod[name];
  if (v === undefined) throw new Error(`${LIB} has no export "${name}"`);
  return v;
}
const src = (p: string) =>
  existsSync(resolve(ROOT, p)) ? readFileSync(resolve(ROOT, p), "utf8") : "";

/** Nested objects -> dotted keys; arrays are skipped (W-3 states are checked apart). */
function flatten(obj: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v)) continue;
    if (v !== null && typeof v === "object")
      out.push(...flatten(v as Record<string, unknown>, key));
    else out.push(key);
  }
  return out;
}
const hiddenKeys = (map: Record<string, unknown>) =>
  Object.keys(map)
    .filter((k) => map[k] === null)
    .sort();

// ---------------------------------------------------------------- fixtures

function ws941(base: number, quarter = 3) {
  const m = (n: number) => `${base + n}.00`;
  return {
    form: "941",
    year: 2026,
    quarter,
    line1Employees: base / 1000,
    line2Wages: m(2),
    line3FederalWithheld: m(3),
    line5aTaxableSsWages: m(4),
    line5aTax: m(5),
    line5cTaxableMedicareWages: m(6),
    line5cTax: m(7),
    line5dAdditionalMedicare: m(8),
    line5eTotal: m(9),
    line6TotalTaxes: m(10),
    line7FractionsOfCents: m(11),
    line7Computed: m(12),
    line10TotalAfterAdjustments: m(13),
    line11ResearchCredit: m(14),
    line12TotalAfterCredits: m(15),
    line13Deposits: m(16),
    line14BalanceDue: m(17),
    line15Overpayment: m(18),
    line16: { month1: m(19), month2: m(20), month3: m(21), deMinimis: base % 2000 === 0 },
  };
}

function ws940(base: number, q: number | null, due: string | null, suta: string) {
  const m = (n: number) => `${base + n}.00`;
  return {
    form: "940",
    year: 2026,
    sutaCreditRate: suta,
    futaRate: base === 1000 ? "0.006" : "0.012",
    line3TotalPayments: m(3),
    line7FutaTaxableWages: m(7),
    line8FutaTax: m(8),
    line12TotalFutaTax: m(12),
    futaTaxPerFrozenEntries: m(13),
    roundingDelta: m(14),
    depositThresholdCrossedQuarter: q,
    depositDueBy: due,
    balanceDue: m(15),
  };
}

function st(state: string, base: number, reconciled: boolean) {
  return {
    state,
    w2Lines: base / 1000,
    box16: `${base + 1}.00`,
    box17: `${base + 2}.00`,
    runWithholding: `${base + 3}.00`,
    attributedLegacy: `${base + 4}.00`,
    reconciled,
  };
}

function wsW3(base: number, box15: string | null, states: ReturnType<typeof st>[]) {
  const m = (n: number) => `${base + n}.00`;
  return {
    form: "w2_w3",
    year: 2026,
    employeeCount: base / 1000,
    box1Wages: m(1),
    box2FederalWithheld: m(2),
    box3SsWages: m(3),
    box4SsTax: m(4),
    box5MedicareWages: m(5),
    box6MedicareTax: m(6),
    w2FormCount: base / 1000 + 1,
    box15State: box15,
    box16StateWages: m(16),
    box17StateTax: m(17),
    states,
    blockedEmployees: base / 1000 + 2,
  };
}

const B941 = ws941(3000);
const A941 = ws941(4000);
const B940 = ws940(1000, null, null, "0.054");
const A940 = ws940(2000, 2, "2026-07-31", "0.045");
const BW3 = wsW3(5000, null, [st("NY", 1000, false), st("CA", 2000, false)]);
const AW3 = wsW3(6000, "X", [st("NY", 3000, true), st("CA", 4000, true)]);

const byKey = (rows: Row[]) => Object.fromEntries(rows.map((r) => [r.key, r]));

/** The recompute Dialog: its source, opening tag, whether the header names the filing, and the text from the diff table to the confirm button. */
function recomputeDialogParts(view: string) {
  const open = view.indexOf('v-model:visible="recomputeDialog"');
  const dlgStart = open >= 0 ? view.lastIndexOf("<Dialog", open) : -1;
  const dlgEnd = dlgStart >= 0 ? view.indexOf("</Dialog>", dlgStart) : -1;
  const dialog = dlgStart >= 0 && dlgEnd > 0 ? view.slice(dlgStart, dlgEnd) : "";
  const openTag = dialog.slice(0, dialog.indexOf(">") + 1);
  const headerSlot = dialog.match(/<template\s+#header[^>]*>([\s\S]*?)<\/template>/);
  const headerExpr = openTag.match(/:header="([^"]*)"/)?.[1] ?? headerSlot?.[1] ?? "";
  const headerBound = namesFiling(headerExpr, view);
  const submit = dialog.indexOf("submitRecompute");
  const tableEnd = dialog.lastIndexOf("</DataTable>", submit);
  const nearConfirm = submit > 0 ? dialog.slice(tableEnd >= 0 ? tableEnd : 0, submit) : "";
  return { dialog, openTag, headerBound, confirmNamesFiling: namesFiling(nearConfirm, view) };
}

/**
 * True when template text calls filingName( directly, or uses a computed
 * whose body calls it (one level of indirection, e.g. a `thisFilingName`).
 */
function namesFiling(text: string, view: string): boolean {
  if (text.includes("filingName(")) return true;
  const ids = new Set(text.match(/[A-Za-z_$][\w$]*/g) ?? []);
  for (const id of ids) {
    const at = view.indexOf(`const ${id} = computed(`);
    if (at < 0) continue;
    const end = view.indexOf("\n});", at);
    if (view.slice(at, end < 0 ? undefined : end).includes("filingName(")) return true;
  }
  return false;
}

/** The body of w3WorksheetLines references the W-3 map imported from worksheet-labels (alias allowed). */
function w3UsesMap(w2: string): boolean {
  const imp = w2.match(/import\s*\{([^}]*)\}\s*from\s*["']\.\/worksheet-labels["']/)?.[1] ?? "";
  const spec = imp.match(/\bWORKSHEET_W3_FIELDS(?:\s+as\s+([A-Za-z_$][\w$]*))?/);
  if (!spec) return false;
  const name = spec[1] ?? "WORKSHEET_W3_FIELDS";
  const fn = w2.slice(Math.max(0, w2.indexOf("function w3WorksheetLines")));
  const body = fn.slice(0, fn.search(/\n}\n/) + 2);
  return (
    w2.includes("function w3WorksheetLines") &&
    new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`).test(body)
  );
}

// ------------------------------------------------------------------- tests

describe("PAY-251 recompute dialog labels", () => {
  it("1 every worksheet field is labelled or explicitly hidden; hidden sets are exact", async () => {
    const m = await lib();
    const f941 = need(m, "WORKSHEET_941_FIELDS");
    const f940 = need(m, "WORKSHEET_940_FIELDS");
    const fW3 = need(m, "WORKSHEET_W3_FIELDS");
    const fSt = need(m, "WORKSHEET_W3_STATE_FIELDS");
    const missing = (keys: string[], map: Record<string, unknown>) =>
      keys.filter((k) => !Object.hasOwn(map, k));
    const stateKeys = Object.keys(BW3.states[0]).filter((k) => k !== "state");
    expect({
      m941: missing(flatten(A941), f941),
      m940: missing(flatten(A940), f940),
      mW3: missing(flatten(AW3), fW3),
      mState: missing(stateKeys, fSt),
      h941: hiddenKeys(f941),
      h940: hiddenKeys(f940),
      hW3: hiddenKeys(fW3),
      stateHidden: !Object.hasOwn(fSt, "state") || fSt.state === null,
      stHiddenOther: hiddenKeys(fSt).filter((k) => k !== "state"),
      w3HasNoStatesEntry: !Object.hasOwn(fW3, "states") || fW3.states === null,
    }).toEqual({
      m941: [],
      m940: [],
      mW3: [],
      mState: [],
      h941: ["form", "line7Computed", "quarter", "year"],
      h940: ["form", "year"],
      hW3: ["form", "year"],
      stateHidden: true,
      stHiddenOther: [],
      w3HasNoStatesEntry: true,
    });
  });

  it("2 no visible title has a camelCase token or a dot-path; every visible field yields a row when all differ", async () => {
    const rows = need(await lib(), "recomputeDiffRows");
    const r941: Row[] = rows(B941, A941);
    const r940: Row[] = rows(B940, A940);
    const rW3: Row[] = rows(BW3, AW3);
    const all = [...r941, ...r940, ...rW3];
    expect({
      camel: all.filter((r) => /[a-z][A-Z]/.test(r.title)).map((r) => r.title),
      dotPath: all.filter((r) => /\w\.\w/.test(r.title)).map((r) => r.title),
      empty: all.filter((r) => !r.title.trim()).map((r) => r.key),
      other: all.filter((r) => r.title === "Other figure").map((r) => r.key),
      n941: r941.length,
      n940: r940.length,
      nW3: rW3.length,
      w3StateRows: rW3.filter((r) => r.key.startsWith("states.")).length,
    }).toEqual({
      camel: [],
      dotPath: [],
      empty: [],
      other: [],
      n941: 21,
      n940: 11,
      nW3: 24,
      w3StateRows: 12,
    });
  });

  it("3 exact titles from the contract examples", async () => {
    const rows = need(await lib(), "recomputeDiffRows");
    const t941 = byKey(rows(B941, A941));
    const tW3 = byKey(rows(BW3, AW3));
    expect({
      l5c: t941.line5cTaxableMedicareWages?.title,
      l7: t941.line7FractionsOfCents?.title,
      m1: t941["line16.month1"]?.title,
      m2: t941["line16.month2"]?.title,
      m3: t941["line16.month3"]?.title,
      deMinimisLine16: t941["line16.deMinimis"]?.title.startsWith("Line 16 — "),
      box1: tW3.box1Wages?.title,
    }).toEqual({
      l5c: "Line 5c — Taxable Medicare wages",
      l7: "Line 7 — Fractions of cents",
      m1: "Line 16 — Month 1 liability",
      m2: "Line 16 — Month 2 liability",
      m3: "Line 16 — Month 3 liability",
      deMinimisLine16: true,
      box1: "Box 1 — Wages, tips, other compensation",
    });
  });

  it("4 values are formatted by kind", async () => {
    const rows = need(await lib(), "recomputeDiffRows");
    const money941 = byKey(
      rows({ ...B941, line2Wages: "1234.5" }, { ...B941, line2Wages: "2000" }),
    );
    const k941 = byKey(rows(B941, A941));
    const k940 = byKey(rows(B940, A940));
    const kW3 = byKey(rows(BW3, AW3));
    const w3Single = byKey(rows(BW3, { ...BW3, box15State: "NY" }));
    const pick = (r: Row | undefined) => (r ? [r.before, r.after] : undefined);
    expect({
      money: pick(money941.line2Wages),
      count: pick(k941.line1Employees),
      deMinimis: pick(k941["line16.deMinimis"]),
      quarter: pick(k940.depositThresholdCrossedQuarter),
      date: pick(k940.depositDueBy),
      percent: pick(k940.sutaCreditRate),
      box15: pick(kW3.box15State),
      box15Single: pick(w3Single.box15State),
    }).toEqual({
      money: ["$1,234.50", "$2,000.00"],
      count: ["3", "4"],
      deMinimis: ["No", "Yes"],
      quarter: ["None", "Q2"],
      date: ["—", "31 Jul 2026"],
      percent: ["5.4%", "4.5%"],
      box15: ["—", "X (more than one state)"],
      box15Single: ["—", "NY"],
    });
  });

  it("5 hidden line7Computed alone -> no rows; unchanged -> no rows; before null -> '—' before", async () => {
    const rows = need(await lib(), "recomputeDiffRows");
    const fromNull: Row[] = rows(null, A941);
    expect({
      hiddenOnly: rows(B941, { ...B941, line7Computed: "9.00" }),
      quarterOnly: rows(B941, { ...B941, quarter: 4 }),
      unchanged941: rows(B941, structuredClone(B941)),
      unchanged940: rows(B940, structuredClone(B940)),
      unchangedW3: rows(BW3, structuredClone(BW3)),
      oneChange: rows(B941, { ...B941, line13Deposits: "2000.00" }).map((r: Row) => r.key),
      nullCount: fromNull.length,
      nullBefore: [...new Set(fromNull.map((r) => r.before))],
      nullHasHidden: fromNull.some((r) =>
        ["line7Computed", "form", "year", "quarter"].includes(r.key),
      ),
    }).toEqual({
      hiddenOnly: [],
      quarterOnly: [],
      unchanged941: [],
      unchanged940: [],
      unchangedW3: [],
      oneChange: ["line13Deposits"],
      nullCount: 21,
      nullBefore: ["—"],
      nullHasHidden: false,
    });
  });

  it("6 an unknown future key is still shown as 'Other figure' with the raw value", async () => {
    const rows = need(await lib(), "recomputeDiffRows");
    const out: Row[] = rows(B941, { ...B941, line99Future: "5.00" });
    expect(out).toEqual([
      { key: "line99Future", title: "Other figure", before: "—", after: "5.00" },
    ]);
  });

  it("7 W-3 states are matched by code, not array index", async () => {
    const rows = need(await lib(), "recomputeDiffRows");
    const reordered: Row[] = rows(BW3, { ...BW3, states: [BW3.states[1], BW3.states[0]] });
    const added = byKey(rows(BW3, { ...BW3, states: [...BW3.states, st("TX", 7000, true)] }));
    const changed = byKey(
      rows(BW3, { ...BW3, states: [BW3.states[0], { ...BW3.states[1], box16: "2500.00" }] }),
    );
    const txKeys = Object.keys(added).filter((k) => k.startsWith("states.TX."));
    expect({
      reordered,
      txRows: txKeys.length > 0,
      txOnlyRows: Object.keys(added).every((k) => k.startsWith("states.TX.")),
      txBefore: [...new Set(txKeys.map((k) => added[k].before))],
      txBox16: added["states.TX.box16"]
        ? [added["states.TX.box16"].before, added["states.TX.box16"].after]
        : undefined,
      caKeys: Object.keys(changed),
      caTitleStart: changed["states.CA.box16"]?.title.startsWith("CA — "),
      caValues: changed["states.CA.box16"]
        ? [changed["states.CA.box16"].before, changed["states.CA.box16"].after]
        : undefined,
    }).toEqual({
      reordered: [],
      txRows: true,
      txOnlyRows: true,
      txBefore: ["—"],
      txBox16: ["—", "$7,001.00"],
      caKeys: ["states.CA.box16"],
      caTitleStart: true,
      caValues: ["$2,001.00", "$2,500.00"],
    });
    const ny = byKey(
      rows(BW3, { ...BW3, states: [{ ...BW3.states[0], box17: "1500.00" }, BW3.states[1]] }),
    );
    expect(ny["states.NY.box17"]?.title).toMatch(/^NY — \S/);
  });

  it("8 rows follow map declaration order", async () => {
    const m = await lib();
    const rows = need(m, "recomputeDiffRows");
    const f941 = need(m, "WORKSHEET_941_FIELDS");
    const f940 = need(m, "WORKSHEET_940_FIELDS");
    const keys941 = (rows(B941, A941) as Row[]).map((r) => r.key);
    const keys940 = (rows(B940, A940) as Row[]).map((r) => r.key);
    const declared = (map: Record<string, unknown>, keys: string[]) =>
      Object.keys(map).filter((k) => keys.includes(k));
    expect({
      wagesBeforeBalance: keys941.indexOf("line2Wages") < keys941.indexOf("line14BalanceDue"),
      wagesFound: keys941.indexOf("line2Wages") >= 0,
      order941: keys941,
      order940: keys940,
    }).toEqual({
      wagesBeforeBalance: true,
      wagesFound: true,
      order941: declared(f941, keys941),
      order940: declared(f940, keys940),
    });
  });

  it("9 filingName names the filing", async () => {
    const f = need(await lib(), "filingName");
    expect([f("941", 2026, 3), f("940", 2026, 0), f("w2_w3", 2026, 0)]).toEqual([
      "Form 941, Q3 2026",
      "Form 940, 2026",
      "Forms W-2/W-3, 2026",
    ]);
  });

  it("10 wiring: the view uses the label module, names the filing in the dialog header and at the confirm button; tables use the maps", () => {
    const view = src("apps/web/src/views/admin/AdminFilingDetailView.vue");
    const w2 = src("apps/web/src/lib/w2-filing.ts");
    const imp = view.match(
      /import\s*\{([^}]*)\}\s*from\s*["']\.\.\/\.\.\/lib\/worksheet-labels["']/,
    );
    const names = imp ? imp[1] : "";
    const { dialog, openTag, headerBound, confirmNamesFiling } = recomputeDialogParts(view);
    expect({
      importsRows: /\brecomputeDiffRows\b/.test(names),
      importsName: /\bfilingName\b/.test(names),
      noFlattenWs: !view.includes("flattenWs"),
      dialogFound: dialog.length > 0,
      staticHeaderGone: !/\sheader="Recompute worksheet"/.test(openTag),
      headerBound,
      confirmNamesFiling,
      uses941Map: view.includes("WORKSHEET_941_FIELDS"),
      uses940Map: view.includes("WORKSHEET_940_FIELDS"),
      w3UsesMap: w3UsesMap(w2),
    }).toEqual({
      importsRows: true,
      importsName: true,
      noFlattenWs: true,
      dialogFound: true,
      staticHeaderGone: true,
      headerBound: true,
      confirmNamesFiling: true,
      uses941Map: true,
      uses940Map: true,
      w3UsesMap: true,
    });
  });
});
