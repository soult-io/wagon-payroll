// PAY-255: pure helpers for the mutation workflow. No I/O; the callers
// (apps/server/stryker.targets.mjs, scripts/mutation-plan.mjs,
// scripts/merge-mutation-reports.mjs) read files and the environment.
//
// A full server run no longer fits one job (filings alone ~6 h at 2026-10),
// so each target is split into shards that run as parallel jobs, and a merge
// job scores the module from all shard reports. A PR run mutates only the
// lines it changed.

/**
 * Split mutate units into `count` shards of similar size, by bytes as a proxy
 * for mutant count. A file bigger than one shard's share is cut into line
 * ranges. Returns Stryker mutate entries: "path" or "path:start-end".
 * @param {{ path: string, bytes: number, lines: number }[]} units
 * @param {number} count
 * @returns {string[][]}
 */
export function planShards(units, count) {
  if (!Number.isInteger(count) || count < 1)
    throw new Error(`shard count must be an integer >= 1, got ${count}`);
  if (!Array.isArray(units) || units.length === 0) throw new Error("no files to mutate");
  const total = units.reduce((sum, u) => sum + u.bytes, 0);
  const target = Math.ceil(total / count);
  const pieces = units.flatMap((u) => splitUnit(u, count > 1 ? target : Infinity));
  pieces.sort((a, b) => b.bytes - a.bytes || (a.entry < b.entry ? -1 : a.entry > b.entry ? 1 : 0));
  const shards = Array.from({ length: count }, () => /** @type {string[]} */ ([]));
  const loads = new Array(count).fill(0);
  for (const p of pieces) {
    const best = loads.indexOf(Math.min(...loads));
    shards[best].push(p.entry);
    loads[best] += p.bytes;
  }
  return shards;
}

/**
 * One file as a whole piece, or as near-equal line ranges when it is bigger
 * than `target` bytes. Earlier ranges take the extra lines.
 * @param {{ path: string, bytes: number, lines: number }} u
 * @param {number} target
 * @returns {{ entry: string, bytes: number }[]}
 */
function splitUnit(u, target) {
  if (u.lines <= 1 || u.bytes <= target) return [{ entry: u.path, bytes: u.bytes }];
  const k = Math.min(Math.ceil(u.bytes / target), u.lines);
  const base = Math.floor(u.lines / k);
  const extra = u.lines % k;
  const pieces = [];
  let start = 1;
  for (let i = 0; i < k; i++) {
    const n = base + (i < extra ? 1 : 0);
    pieces.push({ entry: `${u.path}:${start}-${start + n - 1}`, bytes: (u.bytes * n) / u.lines });
    start += n;
  }
  return pieces;
}

/**
 * "2/5" -> { index: 2, count: 5 } (1-based).
 * @param {string} str
 */
export function parseShard(str) {
  const m = /^([1-9]\d*)\/([1-9]\d*)$/.exec(String(str));
  if (!m) throw new Error(`shard must look like "2/5", got "${str}"`);
  const index = Number(m[1]);
  const count = Number(m[2]);
  if (index > count) throw new Error(`shard index ${index} is above the count ${count}`);
  return { index, count };
}

const MUTATE_ENTRY = /^([^\s:]+\.ts)(?::([1-9]\d*)-([1-9]\d*))?$/;

/**
 * Comma-separated Stryker mutate entries, validated.
 * @param {string} str
 * @returns {string[]}
 */
export function parseMutateList(str) {
  const entries = String(str ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (entries.length === 0) throw new Error("mutate list is empty");
  for (const e of entries) {
    const m = MUTATE_ENTRY.exec(e);
    if (!m || m[1].startsWith("/") || m[1].split("/").includes("..")) {
      throw new Error(`invalid mutate entry "${e}" (want path.ts or path.ts:start-end)`);
    }
    if (m[2] !== undefined && Number(m[2]) > Number(m[3])) {
      throw new Error(`invalid mutate entry "${e}": start line is after end line`);
    }
  }
  return entries;
}

/**
 * New-side changed line ranges per file from `git diff --unified=0`.
 * @param {string} diffText
 * @returns {Map<string, [number, number][]>}
 */
export function changedRanges(diffText) {
  /** @type {Map<string, [number, number][]>} */
  const raw = new Map();
  let current = null;
  for (const line of String(diffText).split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      current = target.startsWith("b/") ? target.slice(2) : null;
      continue;
    }
    const range = current === null ? null : hunkRange(line);
    if (current === null || range === null) continue;
    if (!raw.has(current)) raw.set(current, []);
    raw.get(current)?.push(range);
  }
  return new Map([...raw].map(([path, ranges]) => [path, mergeRanges(ranges)]));
}

/**
 * The new-side line range of a `@@ -a,b +c,d @@` hunk header; null for any
 * other line or a pure deletion (d = 0).
 * @param {string} line
 * @returns {[number, number] | null}
 */
function hunkRange(line) {
  const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!m) return null;
  const start = Number(m[1]);
  const len = m[2] === undefined ? 1 : Number(m[2]);
  return len === 0 ? null : [start, start + len - 1];
}

/**
 * Sort ranges and join overlapping or adjacent ones.
 * @param {[number, number][]} ranges
 * @returns {[number, number][]}
 */
function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  /** @type {[number, number][]} */
  const merged = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && last[1] + 1 >= start) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

const STATUS_KEY = {
  Killed: "killed",
  Timeout: "timeout",
  Survived: "survived",
  NoCoverage: "noCoverage",
  Ignored: "ignored",
  CompileError: "errors",
  RuntimeError: "errors",
};

/**
 * Module mutation score across shard reports (Stryker JSON reports). A file
 * split into line ranges appears in several reports, each with only its own
 * mutants; the same mutant in two reports means the shards overlapped.
 * @param {{ files: Record<string, { mutants: { status: string, mutatorName: string, replacement?: string, location: { start: { line: number, column: number }, end: { line: number, column: number } } }[] }> }[]} reports
 */
export function mergeScore(reports) {
  const counts = { killed: 0, timeout: 0, survived: 0, noCoverage: 0, ignored: 0, errors: 0 };
  const seen = new Set();
  const all = reports.flatMap((report) =>
    Object.entries(report.files ?? {}).flatMap(([path, file]) =>
      (file.mutants ?? []).map((mutant) => ({ path, mutant })),
    ),
  );
  for (const { path, mutant } of all) {
    const id = mutantKey(path, mutant);
    if (seen.has(id))
      throw new Error(`${path}: ${mutant.mutatorName} mutant is in more than one shard report`);
    seen.add(id);
    if (!Object.hasOwn(STATUS_KEY, mutant.status)) {
      throw new Error(`${path}: unexpected mutant status "${mutant.status}"`);
    }
    counts[STATUS_KEY[mutant.status]] += 1;
  }
  const valid = counts.killed + counts.timeout + counts.survived + counts.noCoverage;
  const score = valid === 0 ? null : ((counts.killed + counts.timeout) / valid) * 100;
  return { ...counts, valid, score };
}

/**
 * Identity of a mutant across shard reports. Stryker's `id` is per run, so it
 * is not used; file, mutator, replacement and exact location are.
 * @param {string} path
 * @param {{ mutatorName: string, replacement?: string, location: { start: { line: number, column: number }, end: { line: number, column: number } } }} m
 */
function mutantKey(path, m) {
  const { start, end } = m.location;
  return [
    path,
    m.mutatorName,
    m.replacement ?? "",
    start.line,
    start.column,
    end.line,
    end.column,
  ].join("\0");
}
