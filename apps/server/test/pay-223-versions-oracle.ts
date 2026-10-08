/**
 * PAY-223 PR-2 — payroll-calc-auditor oracle for the employee list's
 * `versions` (brief D-4, Product Lead decisions 2026-10-06), used by the
 * pre-PAY-223 suites that pin the exact /api/my/w2 item shape. Independent
 * of the code under test: it reads the furnishing rows (the input data) and
 * applies the rule itself. Imports nothing from src/.
 *
 * Rule: a version = a distinct (hash_version, boxes_hash) among the
 * employee-year's portal_notice / employee_download rows, numbered 1..k by
 * its first online row (id order); kind "original" when that row has
 * corrected = false, else "corrected"; postedOn = that row's furnished_at
 * as a company-local date. `current` and `downloadable` are given by the
 * test (the current figures and the window are the test's own facts).
 */

interface Pg {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface ExpVersion {
  version: number;
  kind: "original" | "corrected";
  postedOn: string;
  current: boolean;
  downloadable: boolean;
}

function localDate(at: Date, appTz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: appTz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/**
 * Expected `versions` of one employee-year. `current`: the current figures'
 * hash, or "first" / "last" (the version that carries them), or null.
 */
export async function expMyVersions(
  t: { pglite: Pg; config: { appTz: string } },
  employeeId: number,
  year: number,
  o: { current: string | "first" | "last" | null; downloadable: boolean },
): Promise<ExpVersion[]> {
  const r = await t.pglite.query<{
    hash_version: number;
    boxes_hash: string;
    corrected: boolean;
    furnished_at: Date | string;
  }>(
    `SELECT hash_version, boxes_hash, corrected, furnished_at FROM w2_furnishings
      WHERE employee_id = $1 AND tax_year = $2
        AND method IN ('portal_notice', 'employee_download')
      ORDER BY id`,
    [employeeId, year],
  );
  const seen = new Set<string>();
  const firsts: { hash: string; corrected: boolean; at: Date }[] = [];
  for (const row of r.rows) {
    const key = `${row.hash_version}:${row.boxes_hash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    firsts.push({ hash: row.boxes_hash, corrected: row.corrected, at: new Date(row.furnished_at) });
  }
  return firsts.map((f, i) => ({
    version: i + 1,
    kind: f.corrected ? "corrected" : "original",
    postedOn: localDate(f.at, t.config.appTz),
    current:
      o.current === "first"
        ? i === 0
        : o.current === "last"
          ? i === firsts.length - 1
          : o.current !== null && f.hash === o.current,
    downloadable: o.downloadable,
  }));
}
