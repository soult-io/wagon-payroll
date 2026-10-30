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

/** Assert every unit path appears exactly once, bare, across all shards, and nothing else does. */
function assertEachPathOnce(units, shards) {
  const all = shards.flat();
  assert.deepEqual([...all].sort(), units.map((u) => u.path).sort());
}

/** Load of one shard in bytes. */
function shardLoad(units, shard) {
  const byPath = new Map(units.map((u) => [u.path, u.bytes]));
  return shard.reduce((sum, path) => sum + byPath.get(path), 0);
}

// ---------------------------------------------------------------- planShards

test("planShards: greedy placement by bytes desc onto the lightest shard", () => {
  // Sorted: a (50), b (30), c (25), d (20).
  // s0 = a (50), s1 = b (30); c -> s1 (55); d -> s0 (50 < 55) = 70.
  const units = [
    { path: "c.ts", bytes: 25, lines: 3 },
    { path: "a.ts", bytes: 50, lines: 10 },
    { path: "d.ts", bytes: 20, lines: 2 },
    { path: "b.ts", bytes: 30, lines: 3 },
  ];
  const shards = planShards(units, 2);
  assert.deepEqual(shards, [
    ["a.ts", "d.ts"],
    ["b.ts", "c.ts"],
  ]);
  assertEachPathOnce(units, shards);
});

test("planShards: never splits a file, however large", () => {
  // One file far bigger than total/count: it stays whole, the other shards are empty.
  const big = [{ path: "src/filings/annual.ts", bytes: 90000, lines: 2000 }];
  assert.deepEqual(planShards(big, 3), [["src/filings/annual.ts"], [], []]);

  // An oversize file next to small ones: still one bare path, no ":<start>-<end>" anywhere.
  const units = [
    { path: "a.ts", bytes: 100, lines: 10 },
    { path: "b.ts", bytes: 30, lines: 3 },
    { path: "c.ts", bytes: 20, lines: 2 },
  ];
  // s0 = a (100), s1 = b (30), s2 = c (20).
  const shards = planShards(units, 3);
  assert.deepEqual(shards, [["a.ts"], ["b.ts"], ["c.ts"]]);
  for (const entry of shards.flat()) assert.doesNotMatch(entry, /:\d+-\d+$/);
});

test("planShards: ties sort by path, ties in load go to the lowest index", () => {
  // Equal bytes; input order z, a, m. Sorted by path asc: a, m, z.
  // s0 = a, s1 = m, z -> loads 10/10 tie -> s0.
  const units = [
    { path: "z.ts", bytes: 10, lines: 5 },
    { path: "a.ts", bytes: 10, lines: 5 },
    { path: "m.ts", bytes: 10, lines: 5 },
  ];
  assert.deepEqual(planShards(units, 2), [["a.ts", "z.ts"], ["m.ts"]]);
});

test("planShards: path tie-break is plain string comparison, not locale order", () => {
  // Code-unit order: "B" (66) < "a" (97). localeCompare would put "a.ts" first.
  const units = [
    { path: "a.ts", bytes: 10, lines: 1 },
    { path: "B.ts", bytes: 10, lines: 1 },
  ];
  assert.deepEqual(planShards(units, 2), [["B.ts"], ["a.ts"]]);
});

test("planShards: deterministic, and independent of input order", () => {
  const units = [
    { path: "src/a.ts", bytes: 900, lines: 90 },
    { path: "src/b.ts", bytes: 300, lines: 30 },
    { path: "src/c.ts", bytes: 300, lines: 31 },
    { path: "src/d.ts", bytes: 120, lines: 12 },
    { path: "src/e.ts", bytes: 80, lines: 8 },
  ];
  // Sorted: a 900, b 300, c 300, d 120, e 80.
  // s0 = a, s1 = b, s2 = c; d -> s1 (300 tie s2, lowest) = 420; e -> s2 (300) = 380.
  const expected = [["src/a.ts"], ["src/b.ts", "src/d.ts"], ["src/c.ts", "src/e.ts"]];
  assert.deepEqual(planShards(units, 3), expected);
  assert.deepEqual(planShards(units, 3), expected);
  assert.deepEqual(planShards([...units].reverse(), 3), expected);
  assert.deepEqual(planShards([units[3], units[0], units[4], units[2], units[1]], 3), expected);
});

test("planShards: count = 1 is one shard of every path in assignment order", () => {
  // Assignment order = sorted order: bytes desc, then path asc.
  const units = [
    { path: "a.ts", bytes: 10, lines: 4 },
    { path: "b.ts", bytes: 300, lines: 40 },
    { path: "c.ts", bytes: 10, lines: 4 },
  ];
  assert.deepEqual(planShards(units, 1), [["b.ts", "a.ts", "c.ts"]]);
});

test("planShards: fewer files than shards leaves empty shards; always exactly count", () => {
  const two = [
    { path: "a.ts", bytes: 10, lines: 1 },
    { path: "b.ts", bytes: 20, lines: 0 },
  ];
  assert.deepEqual(planShards(two, 4), [["b.ts"], ["a.ts"], [], []]);
});

test("planShards: rejects bad count and empty units", () => {
  const units = [{ path: "a.ts", bytes: 10, lines: 2 }];
  assert.throws(() => planShards(units, 0), Error);
  assert.throws(() => planShards(units, -1), Error);
  assert.throws(() => planShards(units, 1.5), Error);
  assert.throws(() => planShards(units, Number.NaN), Error);
  assert.throws(() => planShards([], 2), Error);
});

test("planShards: 16 mixed files into 5 shards, hand-computed greedy result", () => {
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
  assertEachPathOnce(units, shards);
  // Greedy by hand (total 206000, average 41200):
  //   60000 s0 | 32000 s1 | 24000 s2 | 18000 s3 | 15000 s4
  //   11000 s4=26000 | 9000 s3=27000 | 8000 s2=32000 | 7000 s4=33000 | 6000 s3=33000
  //   5000 s1=37000 (tie s1/s2) | 4000 s2=36000 | 3000 s3=36000 (tie s3/s4)
  //   2500 s4=35500 | 1200 s4=36700 | 300 s2=36300 (tie s2/s3)
  assert.deepEqual(shards, [
    ["src/filings/annual.ts"],
    ["src/filings/quarterly.ts", "src/pay/issue.ts"],
    ["src/engine/federal.ts", "src/forms/nec.ts", "src/forms/w3.ts", "src/util/one.ts"],
    ["src/engine/state.ts", "src/engine/fica.ts", "src/engine/futa.ts", "src/money.ts"],
    ["src/pay/run.ts", "src/forms/w2.ts", "src/pay/approve.ts", "src/dates.ts", "src/rounding.ts"],
  ]);
  const loads = shards.map((s) => shardLoad(units, s));
  assert.deepEqual(loads, [60000, 37000, 36300, 36000, 36700]);
  // The largest file sets the floor; the max stays within 1.5x of the average.
  assert.ok(Math.max(...loads) <= 1.5 * 41200);
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
-  r50();
-  r51();
+  s50();
+  s51();
@@ -1 +1 @@
-import { a } from "./a.ts";
+import { b } from "./b.ts";
@@ -20,5 +20,5 @@
-  o20();
-  o21();
-  o22();
-  o23();
-  o24();
+  n20();
+  n21();
+  n22();
+  n23();
+  n24();
@@ -22,1 +25,1 @@
-  o25();
+  n25();
@@ -3 +2 @@
-  o3();
+  n2();
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

test('changedRanges: an added line starting with "++ " is content, not a file header', () => {
  // The source lines "++ b/src/q.ts" and "++ counter;" appear in the diff as "+++ ...".
  // Neither follows a "--- " line, so neither resets the file; the later hunk still counts.
  const diff = `diff --git a/src/p.ts b/src/p.ts
index 1111111..2222222 100644
--- a/src/p.ts
+++ b/src/p.ts
@@ -4,0 +5,3 @@ export function p() {
+++ b/src/q.ts
+++ counter;
+const z = 1;
@@ -20 +23 @@ export function p() {
-  a();
+  b();
diff --git a/src/r.ts b/src/r.ts
index 3333333..4444444 100644
--- a/src/r.ts
+++ b/src/r.ts
@@ -1 +1 @@
-x
+y
`;
  // p.ts: [5,7] and [23,23]. r.ts: [1,1]. No src/q.ts or "counter;" key.
  assert.deepEqual(
    changedRanges(diff),
    new Map([
      [
        "src/p.ts",
        [
          [5, 7],
          [23, 23],
        ],
      ],
      ["src/r.ts", [[1, 1]]],
    ]),
  );
});

test('changedRanges: a replaced "-- " / "++ " line pair inside a hunk is body, not a header', () => {
  // Source line "-- old" replaced by "++ b/src/x.ts": the diff shows "--- old" then
  // "+++ b/src/x.ts". Both are within the b + d = 2 body lines of "@@ -8 +8 @@", so they
  // must not switch the file; the next hunk of src/w.ts still counts.
  const diff = `diff --git a/src/w.ts b/src/w.ts
index 1111111..2222222 100644
--- a/src/w.ts
+++ b/src/w.ts
@@ -8 +8 @@ export const doc = \`
--- old
+++ b/src/x.ts
@@ -30,2 +30,3 @@ export function w() {
-  a();
-  b();
+  c();
+  d();
+  e();
`;
  // w.ts: [8,8] and [30,32]. No src/x.ts key.
  assert.deepEqual(
    changedRanges(diff),
    new Map([
      [
        "src/w.ts",
        [
          [8, 8],
          [30, 32],
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
