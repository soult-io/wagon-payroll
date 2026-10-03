/**
 * PAY-206 review round D10 (security LOW-2/LOW-3): the W-2 PDF routes serve
 * a full SSN. A browser marks every request with Sec-Fetch-Site; a PDF asked
 * for by another site ("cross-site") or a sibling subdomain ("same-site") is
 * refused. "same-origin" (the SPA), "none" (the user opened the link: typed,
 * bookmark, new tab) and no header (a non-browser client) are allowed — the
 * session guard still applies.
 */

import type { FastifyReply, FastifyRequest } from "fastify";

const REFUSED = new Set(["cross-site", "same-site"]);

/**
 * preHandler: 403 { error: "cross_site" } for a cross-site or same-site
 * fetch. Runs before the session guard. Returns the reply when it refuses,
 * so Fastify stops the chain and sends exactly one response.
 */
export async function refuseCrossSite(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | undefined> {
  const site = req.headers["sec-fetch-site"];
  const value = Array.isArray(site) ? site[0] : site;
  if (value !== undefined && REFUSED.has(value.toLowerCase())) {
    return reply.code(403).send({ error: "cross_site" });
  }
  return undefined;
}

/** Per-route limit for the PDF routes (D10): 20 per minute per client. */
export const PDF_RATE_LIMIT = { max: 20, timeWindow: "1 minute" } as const;
