// Movement paths and spell areas on the hex grid.

import type { AreaShape } from './rules.ts';
import { FEET_PER_HEX, hexDistance, hexKey, hexToPoint, hexesInRange, onBoard, pointToHex, type BoardSize, type Hex } from './hex.ts';

const DIRECTIONS: Hex[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

export const neighbors = (h: Hex): Hex[] => DIRECTIONS.map((d) => ({ q: h.q + d.q, r: h.r + d.r }));

export interface MoveRules {
  board: BoardSize;
  /** Hexes that can't be entered at all (e.g. enemies). */
  blocked: Set<string>;
  /** Hexes that can be passed through but not stopped on (e.g. allies). */
  noStop: Set<string>;
}

/**
 * Every hex a creature can reach in `steps` moves, walking around obstacles,
 * with the number of steps needed. (Difficult terrain comes with the generated maps.)
 */
export function reachable(start: Hex, steps: number, rules: MoveRules): Map<string, number> {
  const dist = new Map<string, number>([[hexKey(start), 0]]);
  let frontier = [start];
  for (let d = 1; d <= steps && frontier.length; d++) {
    const next: Hex[] = [];
    for (const h of frontier) {
      for (const n of neighbors(h)) {
        const k = hexKey(n);
        if (dist.has(k) || !onBoard(n, rules.board) || rules.blocked.has(k)) continue;
        dist.set(k, d);
        next.push(n);
      }
    }
    frontier = next;
  }
  for (const k of rules.noStop) dist.delete(k);
  dist.delete(hexKey(start));
  return dist;
}

/** The shortest walkable path from `start` to `goal` (both included), or null if there is none. */
export function findPath(start: Hex, goal: Hex, rules: MoveRules, limit = 200): Hex[] | null {
  const startKey = hexKey(start);
  const goalKey = hexKey(goal);
  if (startKey === goalKey) return [start];
  const came = new Map<string, Hex | null>([[startKey, null]]);
  let frontier = [start];
  for (let d = 0; d < limit && frontier.length; d++) {
    const next: Hex[] = [];
    for (const h of frontier) {
      for (const n of neighbors(h)) {
        const k = hexKey(n);
        if (came.has(k) || !onBoard(n, rules.board) || (rules.blocked.has(k) && k !== goalKey)) continue;
        came.set(k, h);
        if (k === goalKey) {
          const path: Hex[] = [n];
          let cur: Hex | null = h;
          while (cur) {
            path.unshift(cur);
            cur = came.get(hexKey(cur)) ?? null;
          }
          return path;
        }
        next.push(n);
      }
    }
    frontier = next;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Areas of effect
// ---------------------------------------------------------------------------

export interface AreaSpec {
  shape: AreaShape;
  sizeFt: number; // radius, length or side
  widthFt?: number; // lines
}

/** Whether the area starts at the caster (cone, line, emanation, and "Self" cubes) or at a chosen point. */
export function fromCaster(spec: AreaSpec, rangeFt: number | null) {
  return spec.shape === 'cone' || spec.shape === 'line' || spec.shape === 'emanation' || (spec.shape === 'cube' && rangeFt === 0);
}

/**
 * The hexes an area covers. `origin` is the caster's hex, `target` the hex they
 * aimed at (the centre for spheres, the direction for cones and lines).
 * A hex is covered when its centre is inside the shape (1 hex = 1 unit = 5 ft).
 */
export function areaHexes(spec: AreaSpec, origin: Hex, target: Hex, rangeFt: number | null, board: BoardSize): Hex[] {
  const size = spec.sizeFt / FEET_PER_HEX;
  const o = hexToPoint(origin);
  const t = hexToPoint(target);
  const eps = 0.01;
  let candidates: Hex[];
  let inside: (h: Hex) => boolean;

  if (spec.shape === 'sphere' || spec.shape === 'cylinder') {
    candidates = hexesInRange(target, Math.floor(size));
    inside = () => true;
  } else if (spec.shape === 'emanation') {
    candidates = hexesInRange(origin, Math.floor(size));
    inside = (h) => hexDistance(h, origin) > 0;
  } else if (spec.shape === 'cube' && !fromCaster(spec, rangeFt)) {
    candidates = hexesInRange(target, Math.ceil(size));
    inside = (h) => {
      const p = hexToPoint(h);
      return Math.abs(p.x - t.x) <= size / 2 + eps && Math.abs(p.y - t.y) <= size / 2 + eps;
    };
  } else if (spec.shape === 'line' && (spec.widthFt ?? FEET_PER_HEX) <= FEET_PER_HEX) {
    // A 5-foot-wide line: one hex per 5 feet, in a straight hex line towards the target.
    const len = Math.hypot(t.x - o.x, t.y - o.y) || 1;
    const dx = (t.x - o.x) / len;
    const dy = (t.y - o.y) / len;
    const seen = new Set<string>([hexKey(origin)]);
    candidates = [];
    for (let i = 1; candidates.length < Math.round(size) && i < size * 4; i++) {
      const h = pointToHex({ x: o.x + (dx * i) / 2 + 1e-6, y: o.y + (dy * i) / 2 + 1e-6 });
      if (seen.has(hexKey(h))) continue;
      seen.add(hexKey(h));
      candidates.push(h);
    }
    inside = () => true;
  } else {
    // Shapes that start at the caster and point towards the target.
    let dx = t.x - o.x;
    let dy = t.y - o.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const width = (spec.widthFt ?? FEET_PER_HEX) / FEET_PER_HEX;
    candidates = hexesInRange(origin, Math.ceil(size) + 1);
    inside = (h) => {
      if (hexDistance(h, origin) === 0) return false;
      const p = hexToPoint(h);
      const along = (p.x - o.x) * dx + (p.y - o.y) * dy;
      const across = Math.abs(-(p.x - o.x) * dy + (p.y - o.y) * dx);
      if (along <= 0 || along > size + eps) return false;
      if (spec.shape === 'cone') {
        // On a hex grid a cone is a 60° wedge: 1, 2, 3 ... hexes wide (a 15 ft cone covers 6 hexes).
        return hexDistance(h, origin) <= Math.round(size) && Math.atan2(across, along) <= Math.PI / 6 + 0.02;
      }
      if (spec.shape === 'line') return across < width / 2;
      return across <= size / 2 + eps; // cube in front of the caster
    };
  }
  return candidates.filter((h) => onBoard(h, board) && inside(h));
}

/** "20 ft sphere", "15 ft cone", "100 ft × 5 ft line" in the chosen unit's words. */
export function describeArea(spec: AreaSpec, format: (ft: number) => string) {
  const names: Record<AreaShape, string> = {
    sphere: 'radius',
    cylinder: 'radius',
    emanation: 'around you',
    cone: 'cone',
    cube: 'cube',
    line: 'line',
  };
  if (spec.shape === 'line') return `${format(spec.sizeFt)} line`;
  return `${format(spec.sizeFt)} ${names[spec.shape]}`;
}
