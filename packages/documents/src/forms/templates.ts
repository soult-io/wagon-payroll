/**
 * Bundled IRS form templates (PAY-19, D2): the official AcroForm PDFs live in
 * the repo per tax year under assets/forms/<year>/ — no runtime fetch. Each
 * registry entry pins the SHA-256 of the vetted file so a swapped/corrupted
 * asset fails loudly instead of silently filling the wrong form.
 *
 * Adding a new tax year = drop the year's PDFs (fw2.pdf / fw3.pdf / f940.pdf
 * / f941.pdf) into assets/forms/<year>/, add a registry entry with its
 * checksums, and (if the IRS moved fields) a new field-map module next to
 * field-map-2025.ts / field-map-2026.ts / f941-field-map.ts /
 * f940-field-map.ts. A year may bundle only the forms that exist for it.
 *
 * The bundled PDFs are official IRS forms: works of the U.S. Government,
 * public domain (17 U.S.C. §105).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const ASSETS_ROOT = new URL("../../assets/forms/", import.meta.url);

/** Bundled official forms. Form 941 is quarterly; the others are annual. */
export type FormKind = "fw2" | "fw3" | "f940" | "f941";

interface TemplateEntry {
  fw2Sha256?: string;
  fw3Sha256?: string;
  f940Sha256?: string;
  f941Sha256?: string;
}

const TEMPLATES: Record<number, TemplateEntry> = {
  // Official 2025 revisions (irs.gov/pub/irs-prior/fw2--2025.pdf,
  // fw3--2025.pdf, f941--2025.pdf — Form 941 Rev. March 2025; irs-pdf/
  // f940.pdf — Form 940 for 2025).
  2025: {
    fw2Sha256: "6a52ad63693de54220a3326b22c4d0fb34f4c25084366537087312975a55ae96",
    fw3Sha256: "3e2bbe8e8654acdbc3249b36991f41ec841e9c132cf1ea45bbce5034ed12eb13",
    f940Sha256: "575bb0d645ff613574c9b58506c6e0f7cbdc757c85ebc3e766ffc59fd5709d7c",
    f941Sha256: "efe78a2db0487f66ab233aae0d63b1179c36d15505bc1ed053682320a2a76b62",
  },
  // Form 941 Rev. March 2026 (irs.gov/pub/irs-pdf/f941.pdf).
  // Spec 24 (PAY-116): "2026 Form W-2" from irs.gov/pub/irs-prior/fw2--2026.pdf
  // (file metadata CreationDate 2026-08-12) and "2026 Form W-3" from
  // irs.gov/pub/irs-prior/fw3--2026.pdf (CreationDate 2025-10-27), both
  // downloaded 2026-10-04. Pinned from irs-prior, not irs-pdf: irs-pdf/fw2.pdf
  // switches to the 2027 form once it is final. No Form 940 for 2026 yet.
  2026: {
    fw2Sha256: "61eca7c81f16d3965819fe1f31be4fe68c1b2887a81f51172f1d2ed2b2b9f087",
    fw3Sha256: "2df15f40431bd52814cbac85d9843102b09a640b6fe558f201e5214ff1890656",
    f941Sha256: "38a3d8cf7a455101d52543c8c48e66202bc25c189ead878627e35c797c88e2ad",
  },
};

/** Tax years with at least one bundled official template. */
export function templateYears(): number[] {
  return Object.keys(TEMPLATES).map(Number);
}

/** True when `year` bundles an official template for `form` (no file read). */
export function hasTemplate(year: number, form: FormKind): boolean {
  return TEMPLATES[year]?.[`${form}Sha256` as const] !== undefined;
}

/**
 * Load + verify a bundled template. Throws when the year has no bundled
 * template for the form or the file's checksum does not match the vetted
 * bytes.
 */
export function templateBytes(year: number, form: FormKind): Buffer {
  const entry = TEMPLATES[year];
  const expected = entry?.[`${form}Sha256` as const];
  if (!entry || !expected) {
    throw new Error(
      `no bundled IRS ${form} template for tax year ${year} (bundled: ${templateYears().join(", ")})`,
    );
  }
  const bytes = readFileSync(new URL(`${year}/${form}.pdf`, ASSETS_ROOT));
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== expected) {
    throw new Error(`bundled ${form}.pdf for ${year} failed checksum (got ${sha})`);
  }
  return bytes;
}
