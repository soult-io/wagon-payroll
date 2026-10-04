/**
 * Spec 24 (PAY-116): the W-2/W-3 field maps and page layout of each bundled
 * tax year. Every renderer looks its year up here, so a template year without
 * an entry fails loudly instead of inheriting another year's field names or
 * CORRECTED coordinates. Adding a year = a field-map module and one entry in
 * each table below (plus the templates.ts registry entry).
 */

import {
  W2_LAYOUT_2025,
  W3_FIELD_MAP,
  w2FieldMap,
  type W2Copy,
  type W2FieldMap,
} from "./field-map-2025.js";
import {
  W2_LAYOUT_2026,
  W3_FIELD_MAP_2026,
  w2FieldMap2026,
  type W2FieldMap2026,
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

const W2_LAYOUTS: Readonly<Record<number, W2Layout>> = {
  2025: W2_LAYOUT_2025,
  2026: W2_LAYOUT_2026,
};

const W2_MAPS: Readonly<Record<number, (copy: W2Copy) => W2FieldMap | W2FieldMap2026>> = {
  2025: w2FieldMap,
  2026: w2FieldMap2026,
};

const W3_MAPS: Readonly<Record<number, W3FieldMap>> = {
  2025: W3_FIELD_MAP,
  2026: W3_FIELD_MAP_2026,
};

/** The fw2 page layout of `year`. Throws for a year without one. */
export function w2LayoutFor(year: number): W2Layout {
  const layout = W2_LAYOUTS[year];
  if (!layout) throw new Error(`no W-2 page layout for tax year ${year}`);
  return layout;
}

/** The W-2 field map of one copy for `year`. Throws for a year without one. */
export function w2FieldMapFor(year: number, copy: W2Copy): W2FieldMap | W2FieldMap2026 {
  const map = W2_MAPS[year];
  if (!map) throw new Error(`no W-2 field map for tax year ${year}`);
  return map(copy);
}

/** The W-3 field map of `year`. Throws for a year without one. */
export function w3FieldMapFor(year: number): W3FieldMap {
  const map = W3_MAPS[year];
  if (!map) throw new Error(`no W-3 field map for tax year ${year}`);
  return map;
}

/** True when the map has the state and local rows (boxes 15–20). */
export function hasStateRows(map: W2FieldMap | W2FieldMap2026): map is W2FieldMap2026 {
  return "stateRows" in map;
}

/** True when the W-3 map has boxes 15–19. */
export function hasW3StateBoxes(map: W3FieldMap): map is typeof W3_FIELD_MAP_2026 {
  return "box15State" in map;
}
