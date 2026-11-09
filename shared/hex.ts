// Hex-grid maths. "Pointy-top" hexes with axial coordinates (q, r),
// following the approach from https://www.redblobgames.com/grids/hexagons/
//
// Map units: one hex is exactly 1 unit wide (flat side to flat side).
// On the Main Screen 1 unit = the calibrated hex size in millimetres (default 1 inch),
// and in the rules 1 hex = 5 feet.

export interface Hex {
  q: number;
  r: number;
}
export interface Point {
  x: number;
  y: number;
}

export const SQRT3 = Math.sqrt(3);
/** Distance from a hex's centre to one of its corners, in map units. */
export const HEX_RADIUS = 1 / SQRT3;
export const ROW_HEIGHT = SQRT3 / 2; // vertical distance between rows
export const FEET_PER_HEX = 5;

export function hexToPoint({ q, r }: Hex): Point {
  return { x: q + r / 2, y: r * ROW_HEIGHT };
}

export function pointToHex({ x, y }: Point): Hex {
  const r = y / ROW_HEIGHT;
  const q = x - r / 2;
  return roundHex(q, r);
}

export function roundHex(q: number, r: number): Hex {
  const s = -q - r;
  let rq = Math.round(q);
  let rr = Math.round(r);
  const rs = Math.round(s);
  const dq = Math.abs(rq - q);
  const dr = Math.abs(rr - r);
  const ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return { q: rq + 0, r: rr + 0 }; // "+ 0" turns -0 into 0
}

export function hexDistance(a: Hex, b: Hex): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

/** The 6 corners of a hex, for drawing. */
export function hexCorners(center: Point, radius = HEX_RADIUS): Point[] {
  return Array.from({ length: 6 }, (_, i) => {
    const angle = (Math.PI / 180) * (60 * i - 30);
    return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) };
  });
}

/** All hexes within `range` steps of `center`. */
export function hexesInRange(center: Hex, range: number): Hex[] {
  const out: Hex[] = [];
  for (let dq = -range; dq <= range; dq++) {
    for (let dr = Math.max(-range, -dq - range); dr <= Math.min(range, -dq + range); dr++) {
      out.push({ q: center.q + dq, r: center.r + dr });
    }
  }
  return out;
}

// ---- the board: a rectangle of hexes (rows shifted every other row) ----

export interface BoardSize {
  cols: number;
  rows: number;
}

/** Axial coordinates of the hex at a column/row on a rectangular board. */
export function cellToHex(col: number, row: number): Hex {
  return { q: col - Math.floor(row / 2), r: row };
}

export function hexToCell({ q, r }: Hex): { col: number; row: number } {
  return { col: q + Math.floor(r / 2), row: r };
}

export function onBoard(hex: Hex, board: BoardSize): boolean {
  const { col, row } = hexToCell(hex);
  return row >= 0 && row < board.rows && col >= 0 && col < board.cols;
}

export function boardHexes(board: BoardSize): Hex[] {
  const out: Hex[] = [];
  for (let row = 0; row < board.rows; row++) {
    for (let col = 0; col < board.cols; col++) out.push(cellToHex(col, row));
  }
  return out;
}

/** The board's size in map units, with its top-left at (0,0) when drawn from hex centres. */
export function boardBounds(board: BoardSize) {
  return {
    minX: -0.5,
    minY: -HEX_RADIUS,
    maxX: board.cols, // odd rows stick out half a hex to the right
    maxY: (board.rows - 1) * ROW_HEIGHT + HEX_RADIUS,
  };
}

export const hexKey = ({ q, r }: Hex) => `${q},${r}`;
