// PAY-255: self-test for scripts/mutation-shards.mjs (pure helpers for sharded Stryker runs).
// Run: node --test scripts/mutation-shards.test.mjs
// Every expected value below was worked out by hand from the PAY-255 contract.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  changedRanges,
  filterReport,
  mergeScore,
  parseMutateList,
  parseShard,
  planShards,
  splitFile,
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

// ---------------------------------------------------------------- splitFile

const stmt = (startLine, endLine, bytes) => ({ startLine, endLine, bytes });

test("splitFile: file within maxBytes is one bare whole-file unit with only path/bytes/lines", () => {
  const file = {
    path: "src/a.ts",
    bytes: 100,
    lines: 10,
    statements: [stmt(1, 4, 50), stmt(6, 10, 50)],
  };
  // bytes == maxBytes -> whole file.
  assert.deepEqual(splitFile(file, 100), [{ path: "src/a.ts", bytes: 100, lines: 10 }]);
  assert.deepEqual(splitFile(file, 1000), [{ path: "src/a.ts", bytes: 100, lines: 10 }]);
});

test("splitFile: fewer than 2 statements is one bare whole-file unit, however large", () => {
  const one = { path: "src/big.ts", bytes: 5000, lines: 300, statements: [stmt(1, 300, 5000)] };
  assert.deepEqual(splitFile(one, 100), [{ path: "src/big.ts", bytes: 5000, lines: 300 }]);
  const none = { path: "src/empty.ts", bytes: 400, lines: 20, statements: [] };
  assert.deepEqual(splitFile(none, 100), [{ path: "src/empty.ts", bytes: 400, lines: 20 }]);
});

test("splitFile: cuts when the chunk would exceed maxBytes; ranges cover 1..lines", () => {
  // Leading lines 1-2 and trailing lines 21-22 hold no statement.
  // chunk1 = s1 (40) + s2 (90 <= 100); s3: 90 + 30 > 100, 8 < 10 -> cut.
  // chunk2 = s3 (30) + s4 (90). chunk1 = 1-8, chunk2 = 9-22 (last chunk ends at file.lines).
  const file = {
    path: "src/x.ts",
    bytes: 250,
    lines: 22,
    statements: [stmt(3, 4, 40), stmt(5, 8, 50), stmt(10, 12, 30), stmt(14, 20, 60)],
  };
  assert.deepEqual(splitFile(file, 100), [
    { path: "src/x.ts:1-8", bytes: 90, lines: 8 },
    { path: "src/x.ts:9-22", bytes: 90, lines: 14 },
  ]);
});

test("splitFile: reaching exactly maxBytes does not cut (strictly greater cuts)", () => {
  // chunk1 = 60 + 40 = 100 (not > 100); s3: 100 + 10 > 100 -> cut.
  const file = {
    path: "src/x.ts",
    bytes: 110,
    lines: 9,
    statements: [stmt(1, 3, 60), stmt(4, 6, 40), stmt(7, 9, 10)],
  };
  assert.deepEqual(splitFile(file, 100), [
    { path: "src/x.ts:1-6", bytes: 100, lines: 6 },
    { path: "src/x.ts:7-9", bytes: 10, lines: 3 },
  ]);
});

test("splitFile: never cuts between two statements that share a line", () => {
  // s2 starts on s1's last line (3): no cut even though 60 + 60 > 100.
  // s3: 120 + 60 > 100, 5 < 7 -> cut. chunk1 = 1-5 (120), chunk2 = 6-10 (60).
  const file = {
    path: "src/s.ts",
    bytes: 180,
    lines: 10,
    statements: [stmt(1, 3, 60), stmt(3, 5, 60), stmt(7, 9, 60)],
  };
  assert.deepEqual(splitFile(file, 100), [
    { path: "src/s.ts:1-5", bytes: 120, lines: 5 },
    { path: "src/s.ts:6-10", bytes: 60, lines: 5 },
  ]);
});

test("splitFile: a walk that yields one chunk returns the bare whole-file unit", () => {
  // Every statement shares a line with the previous one: no cut is allowed.
  const file = {
    path: "src/one.ts",
    bytes: 300,
    lines: 4,
    statements: [stmt(1, 1, 100), stmt(1, 2, 100), stmt(2, 4, 100)],
  };
  assert.deepEqual(splitFile(file, 50), [{ path: "src/one.ts", bytes: 300, lines: 4 }]);
});

test("splitFile: a statement larger than maxBytes gets its own chunk; first chunk never empty", () => {
  // s1 (30); s2: 530 > 100 -> cut; chunk2 = s2 (500); s3: 530 > 100 -> cut.
  const file = {
    path: "src/f.ts",
    bytes: 560,
    lines: 12,
    statements: [stmt(1, 2, 30), stmt(3, 10, 500), stmt(11, 12, 30)],
  };
  assert.deepEqual(splitFile(file, 100), [
    { path: "src/f.ts:1-2", bytes: 30, lines: 2 },
    { path: "src/f.ts:3-10", bytes: 500, lines: 8 },
    { path: "src/f.ts:11-12", bytes: 30, lines: 2 },
  ]);
  // The first statement alone exceeds maxBytes: it still starts chunk 1 (no empty chunk).
  const first = {
    path: "src/g.ts",
    bytes: 510,
    lines: 8,
    statements: [stmt(1, 5, 500), stmt(6, 7, 10)],
  };
  assert.deepEqual(splitFile(first, 100), [
    { path: "src/g.ts:1-5", bytes: 500, lines: 5 },
    { path: "src/g.ts:6-8", bytes: 10, lines: 3 },
  ]);
});

test("splitFile: maxBytes <= 0 (or not a number > 0) throws", () => {
  const small = { path: "src/a.ts", bytes: 10, lines: 2, statements: [stmt(1, 1, 5), stmt(2, 2, 5)] };
  const big = { path: "src/b.ts", bytes: 500, lines: 4, statements: [stmt(1, 2, 250), stmt(3, 4, 250)] };
  for (const file of [small, big]) {
    assert.throws(() => splitFile(file, 0), Error);
    assert.throws(() => splitFile(file, -1), Error);
    assert.throws(() => splitFile(file, Number.NaN), Error);
  }
});

/** Deterministic LCG so the generated inputs are the same on every run. */
function lcg(seed) {
  let s = seed >>> 0;
  return (n) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s % n;
  };
}

function genFile(seed) {
  const rnd = lcg(seed);
  const statements = [];
  let end = rnd(4); // leading non-statement lines
  const count = 2 + rnd(25);
  for (let i = 0; i < count; i++) {
    const gap = rnd(3); // 0 = starts on the previous statement's last line
    const startLine = i === 0 ? end + 1 : end + gap;
    const endLine = startLine + rnd(6);
    statements.push(stmt(startLine, endLine, 1 + rnd(80)));
    end = endLine;
  }
  const sum = statements.reduce((t, s) => t + s.bytes, 0);
  return { path: "src/gen.ts", bytes: sum + rnd(50), lines: end + rnd(4), statements };
}

test("splitFile: generated inputs obey every rule of the contract", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const file = genFile(seed);
    for (const maxBytes of [1, 40, 100, 250, 100000]) {
      const label = `seed ${seed}, maxBytes ${maxBytes}`;
      const units = splitFile(file, maxBytes);
      if (file.bytes <= maxBytes) {
        assert.deepEqual(units, [{ path: file.path, bytes: file.bytes, lines: file.lines }], label);
        continue;
      }
      // Rebuild the expected chunks by the greedy rule, independent of the output.
      const chunks = [[file.statements[0]]];
      let load = file.statements[0].bytes;
      for (let i = 1; i < file.statements.length; i++) {
        const s = file.statements[i];
        const prev = file.statements[i - 1];
        if (load + s.bytes > maxBytes && prev.endLine < s.startLine) {
          chunks.push([s]);
          load = s.bytes;
        } else {
          chunks.at(-1).push(s);
          load += s.bytes;
        }
      }
      if (chunks.length === 1) {
        assert.deepEqual(units, [{ path: file.path, bytes: file.bytes, lines: file.lines }], label);
        continue;
      }
      assert.equal(units.length, chunks.length, label);
      // Contiguous coverage 1..lines; unit shape; bytes = its statements' bytes.
      let nextStart = 1;
      const ranges = units.map((u, k) => {
        assert.deepEqual(Object.keys(u).sort(), ["bytes", "lines", "path"], label);
        const m = /^src\/gen\.ts:(\d+)-(\d+)$/.exec(u.path);
        assert.ok(m, `${label}: path ${u.path}`);
        const a = Number(m[1]);
        const b = Number(m[2]);
        assert.equal(a, nextStart, `${label}: chunk ${k} starts after the previous`);
        assert.ok(b >= a, label);
        assert.equal(u.lines, b - a + 1, label);
        const last = chunks[k].at(-1);
        assert.equal(b, k === units.length - 1 ? file.lines : last.endLine, label);
        assert.equal(
          u.bytes,
          chunks[k].reduce((t, s) => t + s.bytes, 0),
          label,
        );
        nextStart = b + 1;
        return [a, b];
      });
      assert.equal(nextStart, file.lines + 1, `${label}: ends at file.lines`);
      // Every statement lies wholly inside exactly one chunk.
      for (const s of file.statements) {
        const inside = ranges.filter(([a, b]) => s.startLine >= a && s.endLine <= b);
        assert.equal(inside.length, 1, `${label}: statement ${s.startLine}-${s.endLine}`);
      }
    }
  }
});

// ---------------------------------------------------------------- filterReport

const fm = (id, startLine, endLine, status = "Killed") => ({
  id: String(id),
  mutatorName: "ArithmeticOperator",
  replacement: "a - b",
  location: { start: { line: startLine, column: 3 }, end: { line: endLine, column: 9 } },
  status,
});

function sampleReport() {
  return {
    schemaVersion: "1.0",
    thresholds: { high: 80, low: 60 },
    projectRoot: "/repo/packages/engine",
    files: {
      "src/a.ts": {
        language: "typescript",
        source: "// a",
        mutants: [
          fm(1, 1, 1),
          fm(2, 4, 6), // starts before 5
          fm(3, 5, 6), // starts on the range's first line
          fm(4, 9, 11), // straddles the range end
          fm(5, 10, 10), // on the range's last line
          fm(6, 11, 11),
          fm(7, 20, 25),
        ],
      },
      "src/ab.ts": { language: "typescript", source: "// ab", mutants: [fm(8, 5, 5)] },
      "src/b.ts": {
        language: "typescript",
        source: "// b",
        mutants: [fm(9, 1, 1), fm(10, 300, 301, "Survived")],
      },
      "src/c.ts": { language: "typescript", source: "// c", mutants: [fm(11, 2, 2)] },
    },
  };
}

test("filterReport: bare path keeps all; range keeps mutants inside, boundaries inclusive", () => {
  const report = sampleReport();
  const out = filterReport(report, ["src/a.ts:5-10", "src/b.ts"]);
  const src = sampleReport();
  assert.deepEqual(out, {
    schemaVersion: "1.0",
    thresholds: { high: 80, low: 60 },
    projectRoot: "/repo/packages/engine",
    files: {
      "src/a.ts": {
        language: "typescript",
        source: "// a",
        mutants: [src.files["src/a.ts"].mutants[2], src.files["src/a.ts"].mutants[4]],
      },
      "src/b.ts": src.files["src/b.ts"],
    },
  });
});

test("filterReport: several ranges for one path keep the union", () => {
  const out = filterReport(sampleReport(), ["src/a.ts:1-1", "src/a.ts:20-25"]);
  assert.deepEqual(Object.keys(out.files), ["src/a.ts"]);
  assert.deepEqual(
    out.files["src/a.ts"].mutants.map((m) => m.id),
    ["1", "7"],
  );
});

test("filterReport: a mutant must lie inside one range, not across two adjacent ranges", () => {
  // Mutant 4 spans 9-11: neither 1-10 nor 11-30 contains it whole.
  const out = filterReport(sampleReport(), ["src/a.ts:1-10", "src/a.ts:11-30"]);
  assert.deepEqual(
    out.files["src/a.ts"].mutants.map((m) => m.id),
    ["1", "2", "3", "5", "6", "7"],
  );
});

test("filterReport: a bare entry wins over ranges for the same path", () => {
  const out = filterReport(sampleReport(), ["src/a.ts:5-5", "src/a.ts"]);
  assert.deepEqual(out.files, { "src/a.ts": sampleReport().files["src/a.ts"] });
});

test("filterReport: unowned files are dropped; path match is exact", () => {
  // "src/a.ts" must not select "src/ab.ts"; an owned path absent from the report adds nothing.
  const out = filterReport(sampleReport(), ["src/a.ts", "src/missing.ts", "src/missing2.ts:1-9"]);
  assert.deepEqual(Object.keys(out.files), ["src/a.ts"]);
  assert.equal(out.schemaVersion, "1.0");
  assert.deepEqual(out.thresholds, { high: 80, low: 60 });
  assert.equal(out.projectRoot, "/repo/packages/engine");
});

test("filterReport: files left with zero mutants are dropped", () => {
  // a.ts has nothing in 30-40; c.ts has nothing in 5-9.
  assert.deepEqual(filterReport(sampleReport(), ["src/a.ts:30-40", "src/c.ts:5-9"]).files, {});
  // A file that has no mutants at all is dropped even when owned bare.
  const report = sampleReport();
  report.files["src/empty.ts"] = { language: "typescript", source: "", mutants: [] };
  const out = filterReport(report, ["src/empty.ts", "src/c.ts"]);
  assert.deepEqual(Object.keys(out.files), ["src/c.ts"]);
});

test("filterReport: returns a new report and does not modify the input", () => {
  const report = sampleReport();
  const before = structuredClone(report);
  const out = filterReport(report, ["src/a.ts:5-10", "src/b.ts"]);
  assert.deepEqual(report, before);
  assert.notEqual(out, report);
  assert.notEqual(out.files, report.files);
  assert.notEqual(out.files["src/a.ts"], report.files["src/a.ts"]);
  // Dropping everything still leaves the input intact.
  filterReport(report, []);
  assert.deepEqual(report, before);
});
