/**
 * Shared request-parsing helpers for admin routes (Spec 25 (PAY-120) §12).
 *
 * - `parseEmployeeId`: `:employeeId` as a positive int4. Anything else
 *   (letters, 0, negatives, decimals, out-of-range) is reported by the caller
 *   exactly like an unknown id — the same 404 body — so ids cannot be probed.
 * - `safeIssues`: Zod issues for a 400 body WITHOUT the submitted values.
 *   Zod messages can quote input (an unrecognized key's name, for one), so
 *   only the path and issue code go back, plus the message of our own
 *   `custom` checks, which is fixed text.
 */

import { z } from "zod";

const employeeIdParam = z.object({
  employeeId: z.coerce.number().int().positive().max(2_147_483_647),
});

/** The route's `:employeeId`, or null when it is not a valid id. */
export function parseEmployeeId(params: unknown): number | null {
  const parsed = employeeIdParam.safeParse(params);
  return parsed.success ? parsed.data.employeeId : null;
}

export interface SafeIssue {
  path: (string | number)[];
  code: string;
  message?: string;
}

export function safeIssues(error: z.ZodError): SafeIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.filter((p): p is string | number => typeof p !== "symbol"),
    code: issue.code,
    ...(issue.code === "custom" ? { message: issue.message } : {}),
  }));
}

export const NOT_FOUND = { error: "not_found" } as const;
