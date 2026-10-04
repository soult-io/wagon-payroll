/**
 * Spec 24 (PAY-116): the W-2/W-3 field maps and page layout of each bundled
 * tax year. Every renderer looks its year up here, so a template year without
 * an entry fails loudly instead of inheriting another year's field names or
 * CORRECTED coordinates. Adding a year = a field-map module and one entry in
 * the table below (plus the templates.ts registry entry).
 */

import {
  W2_COPY_PAGES_2025,
  W2_LAYOUT_2025,
  W3_FIELD_MAP,
  w2FieldMap,
  type W2Copy,
  type W2FieldMap,
} from "./field-map-2025.js";
import {
  W2_COPY_PAGES_2026,
  W2_LAYOUT_2026,
  W2_STATE_ID_WIDTH_2026,
  W3_FIELD_MAP_2026,
  W3_STATE_ID_WIDTH_2026,
  w2FieldMap2026,
  type W2FieldMapWithStateRows,
} from "./field-map-2026.js";

/** 0-indexed fw2 template pages a renderer keeps or marks for one tax year. */
export interface W2Layout {
  /** Employee packet: Copies B, C, 2 and the IRS notice/instruction pages. */
  employeePages: readonly number[];
  /** Admin Copy D. */
  adminCopyDPages: readonly number[];
  /** Pages that carry CORRECTED (Copies B, C and 2; PAY-206). */
  correctedMarkPages: readonly number[];
  /** The CORRECTED mark: Helvetica-Bold text, size and baseline origin (pt). */
  correctedMark: {
    readonly text: string;
    readonly size: number;
    readonly x: number;
    readonly y: number;
  };
}

/** A W-3 map; years with boxes 15–19 add their fields. */
export type W3FieldMap = typeof W3_FIELD_MAP | typeof W3_FIELD_MAP_2026;

interface W2YearBase {
  layout: W2Layout;
  /** 0-indexed fw2 page of each filled copy. */
  copyPages: Readonly<Record<W2Copy, number>>;
}

/**
 * Everything a renderer needs for one fw2/fw3 year. `twoUp` is the one
 * branch: single-up years (2025) fill one template load and prune; two-up
 * years (2026 on) fill the upper W-2 of each copy page, one template load per
 * form (S24-D4), and carry state/local rows and W-3 boxes 15–19.
 */
export type W2Year =
  | (W2YearBase & {
      twoUp: false;
      w2Map: (copy: W2Copy) => W2FieldMap;
      w3Map: typeof W3_FIELD_MAP;
    })
  | (W2YearBase & {
      twoUp: true;
      w2Map: (copy: W2Copy) => W2FieldMapWithStateRows;
      w3Map: typeof W3_FIELD_MAP_2026;
      /** Box 15 state ID field widths (pt). */
      stateIdWidth: { w2: number; w3: number };
    });

const W2_YEARS: Readonly<Record<number, W2Year>> = {
  2025: {
    twoUp: false,
    layout: W2_LAYOUT_2025,
    copyPages: W2_COPY_PAGES_2025,
    w2Map: w2FieldMap,
    w3Map: W3_FIELD_MAP,
  },
  2026: {
    twoUp: true,
    layout: W2_LAYOUT_2026,
    copyPages: W2_COPY_PAGES_2026,
    w2Map: w2FieldMap2026,
    w3Map: W3_FIELD_MAP_2026,
    stateIdWidth: { w2: W2_STATE_ID_WIDTH_2026, w3: W3_STATE_ID_WIDTH_2026 },
  },
};

/** The W-2/W-3 setup of `year`. Throws for a year without one. */
export function w2YearFor(year: number): W2Year {
  const entry = W2_YEARS[year];
  if (!entry) throw new Error(`no W-2/W-3 field map or layout for tax year ${year}`);
  return entry;
}

/** The fw2 page layout of `year`. Throws for a year without one. */
export function w2LayoutFor(year: number): W2Layout {
  return w2YearFor(year).layout;
}

/** The W-2 field map of one copy for `year`. Throws for a year without one. */
export function w2FieldMapFor(year: number, copy: W2Copy): W2FieldMap | W2FieldMapWithStateRows {
  return w2YearFor(year).w2Map(copy);
}

/** The W-3 field map of `year`. Throws for a year without one. */
export function w3FieldMapFor(year: number): W3FieldMap {
  return w2YearFor(year).w3Map;
}
