// Gridless map geometry. Positions are free points in map units:
// 1 unit = 5 feet = 1 inch on a calibrated Main Screen (by default).
// Ranges follow the classic gridless rules: measured from the edge of a
// creature's space, spell areas are true shapes (circle, cone, line, square).

import type { AreaShape } from './rules.ts';

export interface Point {
  x: number;
  y: number;
}

export const FEET_PER_UNIT = 5;
/** A Medium creature takes a 5-foot space: its token is about one unit across. */
export const TOKEN_RADIUS = 0.45;
/** Tokens closer than this would overlap on the table. */
export const MIN_TOKEN_GAP = 0.85;

export interface BoardSize {
  w: number; // map units
  h: number;
}

export const toUnits = (feet: number) => feet / FEET_PER_UNIT;
export const toFeet = (units: number) => units * FEET_PER_UNIT;
export const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

export function clampToBoard(p: Point, board: BoardSize): Point {
  return {
    x: Math.min(board.w - TOKEN_RADIUS, Math.max(TOKEN_RADIUS, p.x)),
    y: Math.min(board.h - TOKEN_RADIUS, Math.max(TOKEN_RADIUS, p.y)),
  };
}

export const onBoard = (p: Point, board: BoardSize) => p.x >= 0 && p.y >= 0 && p.x <= board.w && p.y <= board.h;

/** Feet between the edges of two creatures' spaces (0 when they touch). */
export function edgeDistanceFt(a: Point, b: Point) {
  return Math.max(0, toFeet(dist(a, b) - 2 * TOKEN_RADIUS));
}

/** Whether `target` is within `rangeFt` of `from` (edge to edge, like on the table). */
export function inRange(from: Point, target: Point, rangeFt: number) {
  return edgeDistanceFt(from, target) <= rangeFt + 0.01;
}

/** The nearest free spot to `start` where a token fits without overlapping others. */
export function freeSpotNear(start: Point, taken: Point[], board: BoardSize): Point {
  const ok = (p: Point) => onBoard(p, board) && taken.every((t) => dist(t, p) >= MIN_TOKEN_GAP + 0.05);
  const s = clampToBoard(start, board);
  if (ok(s)) return s;
  for (let ring = 1; ring < 40; ring++) {
    const steps = ring * 6;
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const p = clampToBoard({ x: s.x + Math.cos(a) * ring, y: s.y + Math.sin(a) * ring }, board);
      if (ok(p)) return p;
    }
  }
  return s;
}

// ---------------------------------------------------------------------------
// Spell areas
// ---------------------------------------------------------------------------

export interface AreaSpec {
  shape: AreaShape;
  sizeFt: number; // radius, length or side
  widthFt?: number; // lines
}

/** Whether the area starts at the caster (cone, line, emanation, "Self" cubes) or at a chosen point. */
export function fromCaster(spec: AreaSpec, rangeFt: number | null) {
  return spec.shape === 'cone' || spec.shape === 'line' || spec.shape === 'emanation' || (spec.shape === 'cube' && rangeFt === 0);
}

export type AreaGeometry =
  | { kind: 'circle'; cx: number; cy: number; r: number }
  | { kind: 'polygon'; points: Point[] };

/**
 * The shape an area covers on the map. `origin` is the caster's position,
 * `target` the point aimed at (the centre for spheres, the direction for cones and lines).
 */
export function areaGeometry(spec: AreaSpec, origin: Point, target: Point, rangeFt: number | null): AreaGeometry {
  const size = toUnits(spec.sizeFt);
  if (spec.shape === 'sphere' || spec.shape === 'cylinder') return { kind: 'circle', cx: target.x, cy: target.y, r: size };
  if (spec.shape === 'emanation') return { kind: 'circle', cx: origin.x, cy: origin.y, r: size + TOKEN_RADIUS };

  let dx = target.x - origin.x;
  let dy = target.y - origin.y;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  const px = -dy; // perpendicular
  const py = dx;
  const at = (along: number, across: number, from: Point): Point => ({ x: from.x + dx * along + px * across, y: from.y + dy * along + py * across });

  if (spec.shape === 'cube' && !fromCaster(spec, rangeFt)) {
    // Centred on the aimed point, turned to face the caster.
    const h = size / 2;
    return { kind: 'polygon', points: [at(-h, -h, target), at(h, -h, target), at(h, h, target), at(-h, h, target)] };
  }
  // Starts at the edge of the caster's space.
  const edge = at(TOKEN_RADIUS, 0, origin);
  if (spec.shape === 'cone') {
    // A cone is as wide at its end as it is long.
    return { kind: 'polygon', points: [edge, at(size, -size / 2, edge), at(size, size / 2, edge)] };
  }
  const half = spec.shape === 'line' ? toUnits(spec.widthFt ?? 5) / 2 : size / 2;
  return { kind: 'polygon', points: [at(0, -half, edge), at(size, -half, edge), at(size, half, edge), at(0, half, edge)] };
}

/** SVG path data for an area shape. */
export function geometryPath(g: AreaGeometry): string {
  if (g.kind === 'circle') {
    return `M${g.cx - g.r},${g.cy}a${g.r},${g.r} 0 1,0 ${2 * g.r},0a${g.r},${g.r} 0 1,0 ${-2 * g.r},0Z`;
  }
  return `M${g.points.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join('L')}Z`;
}

/** Whether a creature at `p` is (at least partly) inside the area. */
export function touchesArea(g: AreaGeometry, p: Point): boolean {
  if (g.kind === 'circle') return dist(p, { x: g.cx, y: g.cy }) <= g.r + TOKEN_RADIUS;
  // Inside the polygon, or closer to an edge than the token's radius.
  let inside = false;
  const pts = g.points;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  if (inside) return true;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    if (segmentDistance(p, pts[i], pts[j]) <= TOKEN_RADIUS) return true;
  }
  return false;
}

function segmentDistance(p: Point, a: Point, b: Point) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / (vx * vx + vy * vy || 1)));
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

/** "20 ft radius", "15 ft cone", "100 ft line". */
export function describeArea(spec: AreaSpec, format: (ft: number) => string) {
  const names: Record<AreaShape, string> = {
    sphere: 'radius',
    cylinder: 'radius',
    emanation: 'around you',
    cone: 'cone',
    cube: 'cube',
    line: 'line',
  };
  return `${format(spec.sizeFt)} ${names[spec.shape]}`;
}

// ---------------------------------------------------------------------------
// Old saved games used a hex grid: convert their positions.
// ---------------------------------------------------------------------------

/** Centre of an old hex (axial q, r; pointy-top, 1 unit wide). */
export function fromHex(q: number, r: number): Point {
  return { x: q + r / 2 + 0.5, y: r * (Math.sqrt(3) / 2) + 0.6 };
}
