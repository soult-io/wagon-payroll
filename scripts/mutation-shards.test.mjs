// PAY-255: self-test for scripts/mutation-shards.mjs (pure helpers for sharded Stryker runs).
// Run: node --test scripts/mutation-shards.test.mjs
// Every expected value below was worked out by hand from the PAY-255 contract.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  changedRanges,
  mergeScore,
  parseMutateList,
  parseShard,
  planShards,
} from "./mutation-shards.mjs";

/** Parse one mutate entry into { path, start, end } (null start/end = whole file). */
function parseEntry(entry) {
  const m = /^(.+):(\d+)-(\d+)$/.exec(entry);
  if (!m) return { path: entry, start: null, end: null };
  return { path: m[1], start: Number(m[2]), end: Number(m[3]) };
}

/**
 * Expand every entry of every shard over the synthetic units and assert each line of each
 * unit is covered exactly once, ranges stay inside the file, and a file is either one bare
 * path or only ranges.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one walk that checks coverage, bounds and entry form together
function assertFullCoverage(units, shards) {
  const byPath = new Map(units.map((u) => [u.path, u]));
  const seen = new Map(units.map((u) => [u.path, new Array(u.lines + 1).fill(0)]));
  const forms = new Map();
  for (const shard of shards) {
    for (const entry of shard) {
      const { path, start, end } = parseEntry(entry);
      const unit = byPath.get(path);
      assert.ok(unit, `entry ${entry} names a known unit`);
      const form = start === null ? "bare" : "range";
      const prev = forms.get(path);
      if (form === "bare") {
        assert.equal(prev, undefined, `${path} bare path appears once and alone`);
      } else {
        assert.notEqual(prev, "bare", `${path} is not both bare and ranged`);
      }
      forms.set(path, form);
      const lo = start ?? 1;
      const hi = end ?? unit.lines;
      if (start !== null) {
        assert.ok(lo >= 1 && lo <= hi && hi <= unit.lines, `${entry} lies inside 1-${unit.lines}`);
      }
      const counts = seen.get(path);
      for (let line = lo; line <= hi; line++) counts[line] += 1;
    }
  }
  for (const unit of units) {
    assert.ok(forms.has(unit.path), `${unit.path} appears in some shard`);
    const counts = seen.get(unit.path);
    for (let line = 1; line <= unit.lines; line++) {
      assert.equal(counts[line], 1, `${unit.path} line ${line} covered exactly once`);
    }
  }
}

/** Estimated load of one shard: whole files at their bytes, chunks at bytes * chunkLines / lines. */
function shardLoad(units, shard) {
  const byPath = new Map(units.map((u) => [u.path, u]));
  let load = 0;
  for (const entry of shard) {
    const { path, start, end } = parseEntry(entry);
    const unit = byPath.get(path);
    load += start === null ? unit.bytes : (unit.bytes * (end - start + 1)) / unit.lines;
  }
  return load;
}

// ---------------------------------------------------------------- planShards

test("planShards: splits the oversize file, keeps the rest whole, greedy placement", () => {
  // total 150, count 3 -> target 50. a.ts (100 > 50) -> k = 2 chunks of 5 lines, 50 bytes each.
  // Pieces sorted: a.ts:1-5 (50), a.ts:6-10 (50), b.ts (30), c.ts (20).
  // Greedy: s0 = a:1-5, s1 = a:6-10, s2 = b (30), c -> s2 (smallest load 30).
  const units = [
    { path: "a.ts", bytes: 100, lines: 10 },
    { path: "b.ts", bytes: 30, lines: 3 },
    { path: "c.ts", bytes: 20, lines: 2 },
  ];
  const shards = planShards(units, 3);
  assert.deepEqual(shards, [["a.ts:1-5"], ["a.ts:6-10"], ["b.ts", "c.ts"]]);
  assertFullCoverage(units, shards);
});

test("planShards: splits only when bytes > target (equal to target stays whole)", () => {
  // total 100, count 2 -> target 50. 50 is not > 50: both whole.
  const equal = [
    { path: "a.ts", bytes: 50, lines: 10 },
    { path: "b.ts", bytes: 50, lines: 10 },
  ];
  assert.deepEqual(planShards(equal, 2), [["a.ts"], ["b.ts"]]);

  // total 100 -> target 50. a.ts 51 > 50 -> k = ceil(51/50) = 2: a.ts:1-5, a.ts:6-10 at 25.5 each.
  // Sorted: b.ts (49), a.ts:1-5 (25.5), a.ts:6-10 (25.5).
  // s0 = b (49), s1 = a:1-5 (25.5), a:6-10 -> s1 (25.5 < 49).
  const over = [
    { path: "a.ts", bytes: 51, lines: 10 },
    { path: "b.ts", bytes: 49, lines: 10 },
  ];
  const shards = planShards(over, 2);
  assert.deepEqual(shards, [["b.ts"], ["a.ts:1-5", "a.ts:6-10"]]);
  assertFullCoverage(over, shards);
});

test("planShards: near-equal chunks, the extra lines go to the first chunks", () => {
  // One file, count 3: total 70 -> target ceil(70/3) = 24; k = ceil(70/24) = 3.
  // 10 lines / 3 -> 4, 3, 3: 1-4 (28), 5-7 (21), 8-10 (21).
  const ten = [{ path: "x.ts", bytes: 70, lines: 10 }];
  assert.deepEqual(planShards(ten, 3), [["x.ts:1-4"], ["x.ts:5-7"], ["x.ts:8-10"]]);
  assertFullCoverage(ten, planShards(ten, 3));

  // 11 lines / 3 -> 4, 4, 3: 1-4 (28), 5-8 (28), 9-11 (21).
  const eleven = [{ path: "x.ts", bytes: 77, lines: 11 }];
  // total 77 -> target 26; k = ceil(77/26) = 3.
  assert.deepEqual(planShards(eleven, 3), [["x.ts:1-4"], ["x.ts:5-8"], ["x.ts:9-11"]]);

  // Even split: 12 lines / 4 -> 3 each, 30 bytes each. total 120 -> target 30; k = 4.
  // Equal bytes tie-break on the entry STRING: "x.ts:10-12" sorts before "x.ts:4-6".
  const twelve = [{ path: "x.ts", bytes: 120, lines: 12 }];
  assert.deepEqual(planShards(twelve, 4), [
    ["x.ts:1-3"],
    ["x.ts:10-12"],
    ["x.ts:4-6"],
    ["x.ts:7-9"],
  ]);
});

test("planShards: ties sort by entry string, ties in load go to the lowest index", () => {
  // Equal bytes; input order z, a, m. Sorted by entry asc: a, m, z.
  // s0 = a, s1 = m, z -> loads 10/10 tie -> s0.
  const units = [
    { path: "z.ts", bytes: 10, lines: 5 },
    { path: "a.ts", bytes: 10, lines: 5 },
    { path: "m.ts", bytes: 10, lines: 5 },
  ];
  assert.deepEqual(planShards(units, 2), [["a.ts", "z.ts"], ["m.ts"]]);
});

test("planShards: deterministic, and independent of input order", () => {
  const units = [
    { path: "src/a.ts", bytes: 900, lines: 90 },
    { path: "src/b.ts", bytes: 300, lines: 30 },
    { path: "src/c.ts", bytes: 300, lines: 31 },
    { path: "src/d.ts", bytes: 120, lines: 12 },
    { path: "src/e.ts", bytes: 80, lines: 8 },
  ];
  const first = planShards(units, 3);
  assert.deepEqual(planShards(units, 3), first);
  assert.deepEqual(planShards([...units].reverse(), 3), first);
  assertFullCoverage(units, first);
});

test("planShards: count = 1 is one shard of bare paths, no splitting", () => {
  // Assignment order = sorted order: bytes desc, then path asc.
  const units = [
    { path: "a.ts", bytes: 10, lines: 4 },
    { path: "b.ts", bytes: 300, lines: 40 },
    { path: "c.ts", bytes: 10, lines: 4 },
  ];
  assert.deepEqual(planShards(units, 1), [["b.ts", "a.ts", "c.ts"]]);
});

test("planShards: a unit with lines <= 1 is never split; always exactly count shards", () => {
  // total 1010, count 2 -> target 505. big.ts 1000 > 505 but has 1 line: stays whole.
  const oneLine = [
    { path: "big.ts", bytes: 1000, lines: 1 },
    { path: "s.ts", bytes: 10, lines: 5 },
  ];
  assert.deepEqual(planShards(oneLine, 2), [["big.ts"], ["s.ts"]]);

  // lines = 0 also stays whole.
  const zero = [
    { path: "empty.ts", bytes: 1000, lines: 0 },
    { path: "s.ts", bytes: 10, lines: 5 },
  ];
  assert.deepEqual(planShards(zero, 2), [["empty.ts"], ["s.ts"]]);

  // Fewer pieces than shards: the extra shard is an empty array.
  const two = [
    { path: "a.ts", bytes: 10, lines: 1 },
    { path: "b.ts", bytes: 10, lines: 1 },
  ];
  assert.deepEqual(planShards(two, 3), [["a.ts"], ["b.ts"], []]);
});

test("planShards: rejects bad count and empty units", () => {
  const units = [{ path: "a.ts", bytes: 10, lines: 2 }];
  assert.throws(() => planShards(units, 0), Error);
  assert.throws(() => planShards(units, -1), Error);
  assert.throws(() => planShards(units, 1.5), Error);
  assert.throws(() => planShards(units, Number.NaN), Error);
  assert.throws(() => planShards([], 2), Error);
});

test("planShards: 16 mixed files into 5 shards cover every line and balance load", () => {
  const units = [
    { path: "src/filings/annual.ts", bytes: 60000, lines: 1500 },
    { path: "src/filings/quarterly.ts", bytes: 32000, lines: 800 },
    { path: "src/engine/federal.ts", bytes: 24000, lines: 600 },
    { path: "src/engine/state.ts", bytes: 18000, lines: 450 },
    { path: "src/engine/fica.ts", bytes: 9000, lines: 220 },
    { path: "src/engine/futa.ts", bytes: 6000, lines: 150 },
    { path: "src/pay/run.ts", bytes: 15000, lines: 380 },
    { path: "src/pay/approve.ts", bytes: 7000, lines: 175 },
    { path: "src/pay/issue.ts", bytes: 5000, lines: 120 },
    { path: "src/money.ts", bytes: 3000, lines: 80 },
    { path: "src/dates.ts", bytes: 2500, lines: 60 },
    { path: "src/rounding.ts", bytes: 1200, lines: 30 },
    { path: "src/forms/w2.ts", bytes: 11000, lines: 270 },
    { path: "src/forms/w3.ts", bytes: 4000, lines: 100 },
    { path: "src/forms/nec.ts", bytes: 8000, lines: 200 },
    { path: "src/util/one.ts", bytes: 300, lines: 1 },
  ];
  const shards = planShards(units, 5);
  assert.equal(shards.length, 5);
  assertFullCoverage(units, shards);

  // total 206000 -> target 41200. Only annual.ts (60000) is over: k = 2, 750 + 750 lines.
  const entries = shards.flat();
  assert.ok(entries.includes("src/filings/annual.ts:1-750"));
  assert.ok(entries.includes("src/filings/annual.ts:751-1500"));
  for (const u of units.slice(1)) assert.ok(entries.includes(u.path), `${u.path} stays whole`);
  assert.equal(entries.length, 17);

  const loads = shards.map((s) => shardLoad(units, s));
  const avg = loads.reduce((a, b) => a + b, 0) / loads.length;
  assert.ok(Math.abs(avg - 41200) < 1e-6);
  assert.ok(Math.max(...loads) <= 1.5 * avg, `max ${Math.max(...loads)} within 1.5x of ${avg}`);
  // Hand-run greedy: loads 42000, 41500, 42000, 40300, 40200; max 42000.
  assert.deepEqual(
    [...loads].sort((a, b) => a - b),
    [40200, 40300, 41500, 42000, 42000],
  );
});

// ---------------------------------------------------------------- parseShard

test("parseShard: valid index/count", () => {
  assert.deepEqual(parseShard("2/5"), { index: 2, count: 5 });
  assert.deepEqual(parseShard("1/1"), { index: 1, count: 1 });
  assert.deepEqual(parseShard("5/5"), { index: 5, count: 5 });
  assert.deepEqual(parseShard("10/12"), { index: 10, count: 12 });
});

test("parseShard: rejects everything else", () => {
  for (const bad of [
    "0/5",
    "6/5",
    "a/b",
    "2",
    "",
    "2/0",
    " 2/5",
    "2/5 ",
    "2.5/5",
    "-1/5",
    "2/-5",
    "2/5/7",
    "/5",
    "2/",
  ]) {
    assert.throws(() => parseShard(bad), Error, `rejects ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------- parseMutateList

test("parseMutateList: valid paths and ranges, trimmed, empty entries dropped", () => {
  assert.deepEqual(parseMutateList("src/a.ts"), ["src/a.ts"]);
  assert.deepEqual(parseMutateList("src/a.ts, src/b.ts:10-20 ,,src/c.ts:5-5"), [
    "src/a.ts",
    "src/b.ts:10-20",
    "src/c.ts:5-5",
  ]);
  assert.deepEqual(parseMutateList("src/a.ts,"), ["src/a.ts"]);
  assert.deepEqual(parseMutateList("  src/filings/annual.ts:1-750  "), [
    "src/filings/annual.ts:1-750",
  ]);
});

test("parseMutateList: rejects invalid entries and an empty result", () => {
  for (const bad of [
    "",
    " , ,",
    "/abs/a.ts",
    "../a.ts",
    "src/../a.ts",
    "src/a b.ts",
    "src/a.js",
    "src/a.tsx",
    "src/a.ts:0-3",
    "src/a.ts:5-3",
    "src/a.ts:1.5-3",
    "src/a.ts:3",
    "src/a.ts:-3",
    "src/a.ts:a-b",
    "src/a.ts:1-",
    "src/a.ts,src/a.js",
    "src/a.ts,/etc/b.ts",
  ]) {
    assert.throws(() => parseMutateList(bad), Error, `rejects ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------- changedRanges

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -3 +3 @@ export function a() {
-  return 1;
+  return 2;
@@ -10,0 +11,2 @@ export function b() {
+  const x = 1;
+  const y = 2;
@@ -12,2 +13,3 @@ export function b() {
-  old();
-  older();
+  one();
+  two();
+  three();
@@ -20,3 +22,0 @@ export function c() {
-  gone1();
-  gone2();
-  gone3();
@@ -30 +40,4 @@ export function d() {
-  x;
+  a;
+  b;
+  c;
+  d;
@@ -33 +42,5 @@ export function d() {
-  y;
+  e;
+  f;
+  g;
+  h;
+  i;
diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index 3333333..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-export const a = 1;
-export const b = 2;
-export const c = 3;
diff --git a/src/del-only.ts b/src/del-only.ts
index 4444444..5555555 100644
--- a/src/del-only.ts
+++ b/src/del-only.ts
@@ -5,2 +4,0 @@ export function e() {
-  drop1();
-  drop2();
diff --git a/src/before.ts b/src/after.ts
similarity index 90%
rename from src/before.ts
rename to src/after.ts
index 6666666..7777777 100644
--- a/src/before.ts
+++ b/src/after.ts
@@ -7 +7,2 @@ export function f() {
-  f();
+  f1();
+  f2();
diff --git a/src/moved.ts b/src/moved2.ts
similarity index 100%
rename from src/moved.ts
rename to src/moved2.ts
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..8888888
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+export const n1 = 1;
+export const n2 = 2;
+export const n3 = 3;
`;

test("changedRanges: realistic multi-file diff", () => {
  // a.ts: [3,3]; [11,12] + [13,15] adjacent -> [11,15]; d=0 skipped; [40,43] + [42,46] -> [40,46].
  // old.ts deleted (+++ /dev/null), del-only.ts has only d=0 hunks, moved2.ts has no hunks.
  // Rename uses the new path: after.ts [7,8]. New file: [1,3].
  assert.deepEqual(
    changedRanges(DIFF),
    new Map([
      [
        "src/a.ts",
        [
          [3, 3],
          [11, 15],
          [40, 46],
        ],
      ],
      ["src/after.ts", [[7, 8]]],
      ["src/new.ts", [[1, 3]]],
    ]),
  );
});

test("changedRanges: ranges are sorted before merging", () => {
  const diff = `diff --git a/src/z.ts b/src/z.ts
--- a/src/z.ts
+++ b/src/z.ts
@@ -50,2 +50,2 @@
@@ -1 +1 @@
@@ -20,5 +20,5 @@
@@ -22,1 +25,1 @@
@@ -3 +2 @@
`;
  // Raw: [50,51], [1,1], [20,24], [25,25], [2,2]. Sorted + merged: [1,2], [20,25], [50,51].
  assert.deepEqual(
    changedRanges(diff),
    new Map([
      [
        "src/z.ts",
        [
          [1, 2],
          [20, 25],
          [50, 51],
        ],
      ],
    ]),
  );
});

test("changedRanges: empty diff is an empty map", () => {
  assert.deepEqual(changedRanges(""), new Map());
});

// ---------------------------------------------------------------- mergeScore

// Every generated mutant gets a fresh line, so no two are "the same mutant" unless built so.
let nextLine = 1;
const mutant = (status, over = {}) => {
  const line = nextLine++;
  return {
    id: String(line),
    mutatorName: "ArithmeticOperator",
    replacement: "a - b",
    location: { start: { line, column: 10 }, end: { line, column: 15 } },
    status,
    ...over,
  };
};
const mutants = (...statuses) => ({ mutants: statuses.map((status) => mutant(status)) });
/** A fixed mutant shape for the duplicate-detection tests. */
const fixed = (over = {}) => ({
  id: "1",
  mutatorName: "EqualityOperator",
  replacement: "a !== b",
  location: { start: { line: 40, column: 7 }, end: { line: 40, column: 14 } },
  status: "Killed",
  ...over,
});

test("mergeScore: counts statuses across files and reports", () => {
  const r1 = {
    files: {
      "src/a.ts": mutants("Killed", "Killed", "Survived", "Timeout", "NoCoverage"),
      "src/b.ts": mutants("Ignored", "CompileError", "Killed"),
    },
  };
  const r2 = {
    files: {
      "src/c.ts": mutants("RuntimeError", "Survived", "Killed", "Timeout"),
      "src/d.ts": mutants(),
    },
  };
  // killed 4, timeout 2, survived 2, noCoverage 1, ignored 1, errors 2; valid 9; score 6/9*100.
  const { score, ...counts } = mergeScore([r1, r2]);
  assert.deepEqual(counts, {
    killed: 4,
    timeout: 2,
    survived: 2,
    noCoverage: 1,
    ignored: 1,
    errors: 2,
    valid: 9,
  });
  assert.ok(Math.abs(score - 200 / 3) < 1e-9, `score ${score} is 66.67`);
});

test("mergeScore: exact score math", () => {
  const report = { files: { "src/a.ts": mutants("Killed", "Killed", "Timeout", "Survived") } };
  assert.deepEqual(mergeScore([report]), {
    killed: 2,
    timeout: 1,
    survived: 1,
    noCoverage: 0,
    ignored: 0,
    errors: 0,
    valid: 4,
    score: 75,
  });

  const perfect = { files: { "src/a.ts": mutants("Killed", "Timeout") } };
  assert.equal(mergeScore([perfect]).score, 100);

  const none = { files: { "src/a.ts": mutants("Survived", "NoCoverage") } };
  assert.equal(mergeScore([none]).score, 0);
});

test("mergeScore: no valid mutants gives a null score", () => {
  const ignoredOnly = { files: { "src/a.ts": mutants("Ignored", "Ignored") } };
  assert.deepEqual(mergeScore([ignoredOnly]), {
    killed: 0,
    timeout: 0,
    survived: 0,
    noCoverage: 0,
    ignored: 2,
    errors: 0,
    valid: 0,
    score: null,
  });

  const errorsOnly = { files: { "src/a.ts": mutants("CompileError", "RuntimeError", "Ignored") } };
  const result = mergeScore([errorsOnly]);
  assert.equal(result.errors, 2);
  assert.equal(result.valid, 0);
  assert.equal(result.score, null);
});

test("mergeScore: a split file in several reports is counted from every report", () => {
  // annual.ts split across two shards: each report holds the mutants of its own line range.
  const r1 = { files: { "src/filings/annual.ts": mutants("Killed", "Survived") } };
  const r2 = {
    files: {
      "src/filings/annual.ts": mutants("Killed", "Timeout", "NoCoverage"),
      "src/money.ts": mutants("Killed"),
    },
  };
  // killed 3, timeout 1, survived 1, noCoverage 1; valid 6; score 4/6*100.
  const { score, ...counts } = mergeScore([r1, r2]);
  assert.deepEqual(counts, {
    killed: 3,
    timeout: 1,
    survived: 1,
    noCoverage: 1,
    ignored: 0,
    errors: 0,
    valid: 6,
  });
  assert.ok(Math.abs(score - 200 / 3) < 1e-9, `score ${score} is 66.67`);
});

test("mergeScore: the same mutant in two reports throws; the id is ignored", () => {
  const path = "src/filings/annual.ts";
  const one = (m) => ({ files: { [path]: { mutants: [m] } } });
  // Identical apart from id and status -> same mutant.
  assert.throws(
    () => mergeScore([one(fixed({ id: "1" })), one(fixed({ id: "99", status: "Survived" }))]),
    Error,
  );
  // Same id in both, same everything -> same mutant.
  assert.throws(() => mergeScore([one(fixed()), one(fixed())]), Error);
  // Missing replacement counts as "".
  const { replacement: _r, ...noReplacement } = fixed();
  assert.throws(() => mergeScore([one(noReplacement), one(fixed({ replacement: "" }))]), Error);
  // The duplicate is found among other mutants and other files too.
  const r1 = { files: { [path]: { mutants: [mutant("Killed"), fixed()] } } };
  const r2 = {
    files: {
      "src/money.ts": mutants("Killed"),
      [path]: { mutants: [mutant("Survived"), fixed({ id: "7" })] },
    },
  };
  assert.throws(() => mergeScore([r1, r2]), Error);
});

test("mergeScore: mutants differing in any identity field are distinct", () => {
  const path = "src/filings/annual.ts";
  const one = (m, p = path) => ({ files: { [p]: { mutants: [m] } } });
  const base = fixed();
  const loc = (startLine, startCol, endLine, endCol) => ({
    start: { line: startLine, column: startCol },
    end: { line: endLine, column: endCol },
  });
  const variants = [
    ["path", one(base, "src/filings/quarterly.ts")],
    ["mutatorName", one(fixed({ mutatorName: "ConditionalExpression" }))],
    ["replacement", one(fixed({ replacement: "a === b" }))],
    ["missing vs non-empty replacement", one((({ replacement: _x, ...m }) => m)(base))],
    ["start line", one(fixed({ location: loc(41, 7, 41, 14) }))],
    ["start column", one(fixed({ location: loc(40, 8, 40, 14) }))],
    ["end line", one(fixed({ location: loc(40, 7, 41, 14) }))],
    ["end column", one(fixed({ location: loc(40, 7, 40, 15) }))],
  ];
  for (const [field, other] of variants) {
    const result = mergeScore([one(base), other]);
    assert.equal(result.killed, 2, `differs by ${field}: both counted`);
    assert.equal(result.valid, 2);
    assert.equal(result.score, 100);
  }
});

test("mergeScore: Pending or unknown status throws", () => {
  const pending = { files: { "src/a.ts": mutants("Killed", "Pending") } };
  assert.throws(() => mergeScore([pending]), Error);
  const unknown = { files: { "src/a.ts": mutants("Bogus") } };
  assert.throws(() => mergeScore([unknown]), Error);
  const lowercase = { files: { "src/a.ts": mutants("killed") } };
  assert.throws(() => mergeScore([lowercase]), Error);
});
