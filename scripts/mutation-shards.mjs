// PAY-255: pure helpers for the mutation workflow. No I/O; the callers
// (apps/server/stryker.targets.mjs, scripts/mutation-plan.mjs,
// scripts/merge-mutation-reports.mjs) read files and the environment.
//
// A full server run no longer fits one job (filings alone ~6 h at 2026-10),
// so each target is split into shards that run as parallel jobs, and a merge
// job scores the module from all shard reports. A PR run mutates only the
// lines it changed.

/**
 * Cut a large file into line-range units at top-level statement boundaries.
 * Stryker only creates a mutant whose whole node lies inside one range, so an
 * arbitrary cut would silently drop every mutant spanning it; no mutant spans
 * two top-level statements, so these cuts drop nothing. The ranges cover the
 * whole file with no gap. One file can need more than a 6-hour job
 * (annual.ts, ~8 h at 2026-10), so whole files are not enough.
 * @param {{ path: string, bytes: number, lines: number, statements: { startLine: number, endLine: number, bytes: number }[] }} file
 * @param {number} maxBytes
 * @returns {{ path: string, bytes: number, lines: number }[]}
 */
export function splitFile(file, maxBytes) {
  if (!(maxBytes > 0)) throw new Error(`maxBytes must be > 0, got ${maxBytes}`);
  const whole = [{ path: file.path, bytes: file.bytes, lines: file.lines }];
  if (file.bytes <= maxBytes || file.statements.length < 2) return whole;
  /** @type {{ startLine: number, endLine: number, bytes: number }[][]} */
  const chunks = [[]];
  let load = 0;
  for (const [i, s] of file.statements.entries()) {
    const chunk = chunks[chunks.length - 1];
    const prev = file.statements[i - 1];
    if (chunk.length > 0 && load + s.bytes > maxBytes && prev.endLine < s.startLine) {
      chunks.push([s]);
      load = s.bytes;
    } else {
      chunk.push(s);
      load += s.bytes;
    }
  }
  if (chunks.length === 1) return whole;
  let start = 1;
  return chunks.map((chunk, i) => {
    const end = i === chunks.length - 1 ? file.lines : chunk[chunk.length - 1].endLine;
    const unit = {
      path: `${file.path}:${start}-${end}`,
      bytes: chunk.reduce((sum, s) => sum + s.bytes, 0),
      lines: end - start + 1,
    };
    start = end + 1;
    return unit;
  });
}

/**
 * Split a module's units (whole files or splitFile ranges) into `count`
 * shards of similar size, by bytes as a proxy for test time. A unit's path
 * is opaque here. A shard can be empty when there are fewer units than
 * shards; callers reject that.
 * @param {{ path: string, bytes: number, lines: number }[]} units
 * @param {number} count
 * @returns {string[][]}
 */
export function planShards(units, count) {
  if (!Number.isInteger(count) || count < 1)
    throw new Error(`shard count must be an integer >= 1, got ${count}`);
  if (!Array.isArray(units) || units.length === 0) throw new Error("no files to mutate");
  const sorted = [...units].sort(
    (a, b) => b.bytes - a.bytes || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  const shards = Array.from({ length: count }, () => /** @type {string[]} */ ([]));
  const loads = new Array(count).fill(0);
  for (const u of sorted) {
    const best = loads.indexOf(Math.min(...loads));
    shards[best].push(u.path);
    loads[best] += u.bytes;
  }
  return shards;
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
  const lines = String(diffText).split("\n");
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("+++ ") && i > 0 && lines[i - 1].startsWith("--- ")) {
      const target = lines[i].slice(4).trim();
      current = target.startsWith("b/") ? target.slice(2) : null;
      continue;
    }
    const hunk = hunkHeader(lines[i]);
    if (hunk === null) continue;
    // Skip the hunk body by its counts: a body line is never a header, even
    // when its text makes it look like "--- x" / "+++ y".
    i += hunk.oldLen + hunk.newLen;
    if (current === null || hunk.newLen === 0) continue;
    const ranges = raw.get(current) ?? [];
    ranges.push([hunk.newStart, hunk.newStart + hunk.newLen - 1]);
    raw.set(current, ranges);
  }
  return new Map([...raw].map(([path, ranges]) => [path, mergeRanges(ranges)]));
}

/**
 * The counts of a `@@ -a,b +c,d @@` hunk header (b and d default to 1); null
 * for any other line.
 * @param {string} line
 */
function hunkHeader(line) {
  const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!m) return null;
  return {
    oldLen: m[1] === undefined ? 1 : Number(m[1]),
    newStart: Number(m[2]),
    newLen: m[3] === undefined ? 1 : Number(m[3]),
  };
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

/**
 * A shard's report cut down to what the shard owns: `owned` is its mutate
 * entries ("path" or "path:a-b"). Stryker's incremental mode carries mutants
 * of files and ranges the shard tested on an earlier run into the report.
 * @param {{ files?: Record<string, { mutants?: { location: { start: { line: number }, end: { line: number } } }[] }> }} report
 * @param {string[]} owned
 */
export function filterReport(report, owned) {
  /** @type {Map<string, [number, number][] | "all">} */
  const byPath = new Map();
  for (const entry of owned) {
    const m = /^(.*):(\d+)-(\d+)$/.exec(entry);
    if (!m) {
      byPath.set(entry, "all");
      continue;
    }
    const ranges = byPath.get(m[1]) ?? [];
    if (ranges !== "all") byPath.set(m[1], [...ranges, [Number(m[2]), Number(m[3])]]);
  }
  const files = {};
  for (const [path, file] of Object.entries(report.files ?? {})) {
    const ranges = byPath.get(path);
    if (ranges === undefined) continue;
    const mutants = (file.mutants ?? []).filter(
      (m) =>
        ranges === "all" ||
        ranges.some(([a, b]) => m.location.start.line >= a && m.location.end.line <= b),
    );
    if (mutants.length > 0) files[path] = { ...file, mutants };
  }
  return { ...report, files };
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
 * Module mutation score across shard reports (Stryker JSON reports), each
 * already limited to the files its shard owns. The same mutant in two reports
 * means the shards overlapped.
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
