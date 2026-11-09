// Editing a place by hand: picking things on the map, and moving, resizing and
// rotating them. Everything editable is seen as a box (centre, width, height,
// angle), so one set of handles works for buildings, furniture, trees and rocks.

import type { Point } from '../../../shared/geometry.ts';
import type { Entrance, Feature, Place } from '../../../shared/places.ts';

export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
  a: number;
}

export type MapData = Pick<Place, 'features' | 'walls' | 'entrances'>;

const rot = (p: Point, a: number) => ({ x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) });
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Features that can be picked and changed (labels, roads, rivers and cave floors can't). */
export const EDITABLE = new Set<Feature['t']>(['building', 'furniture', 'tree', 'rock', 'column', 'rug', 'stall', 'door', 'window', 'puddle', 'stairs', 'debris', 'well', 'field', 'floor']);

const polyOf = (f: Feature): Point[] | null => ('poly' in f ? f.poly : null);

export function frameOf(f: Feature): Frame | null {
  const poly = polyOf(f);
  if (poly) {
    if (poly.length === 4 && Math.abs((poly[1].x - poly[0].x) * (poly[2].x - poly[1].x) + (poly[1].y - poly[0].y) * (poly[2].y - poly[1].y)) < 0.05 * dist(poly[0], poly[1]) * dist(poly[1], poly[2])) {
      const c = { x: (poly[0].x + poly[2].x) / 2, y: (poly[0].y + poly[2].y) / 2 };
      return { ...c, w: dist(poly[0], poly[1]), h: dist(poly[1], poly[2]), a: Math.atan2(poly[1].y - poly[0].y, poly[1].x - poly[0].x) };
    }
    const xs = poly.map((p) => p.x);
    const ys = poly.map((p) => p.y);
    return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2, w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), a: 0 };
  }
  switch (f.t) {
    case 'furniture':
    case 'rug':
    case 'stall':
    case 'stairs':
      return { x: f.x, y: f.y, w: f.w, h: f.h, a: f.a };
    case 'door':
    case 'window':
      return { x: f.x, y: f.y, w: f.w, h: 0.4, a: f.a };
    case 'tree':
    case 'column':
    case 'debris':
      return { x: f.x, y: f.y, w: f.r * 2, h: f.r * 2, a: 0 };
    case 'well':
      return { x: f.x, y: f.y, w: 1.5, h: 1.5, a: 0 };
    default:
      return null;
  }
}

/** Maps a point from one frame to another (move, stretch and turn with the box). */
export function mapPoint(p: Point, from: Frame, to: Frame): Point {
  const local = rot({ x: p.x - from.x, y: p.y - from.y }, -from.a);
  const scaled = { x: from.w > 0.01 ? (local.x / from.w) * to.w : local.x, y: from.h > 0.01 ? (local.y / from.h) * to.h : local.y };
  const back = rot(scaled, to.a);
  return { x: back.x + to.x, y: back.y + to.y };
}

export function applyFrame(f: Feature, from: Frame, to: Frame): Feature {
  if ('poly' in f) return { ...f, poly: f.poly.map((p) => mapPoint(p, from, to)) } as Feature;
  switch (f.t) {
    case 'furniture':
    case 'rug':
    case 'stall':
    case 'stairs':
      return { ...f, x: to.x, y: to.y, w: to.w, h: to.h, a: to.a };
    case 'door':
    case 'window':
      return { ...f, x: to.x, y: to.y, w: to.w, a: to.a };
    case 'tree':
    case 'column':
    case 'debris':
      return { ...f, x: to.x, y: to.y, r: Math.max(0.15, Math.max(to.w, to.h) / 2) };
    case 'well':
      return { ...f, x: to.x, y: to.y };
    default:
      return f;
  }
}

function pointInPoly(p: Point, poly: Point[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function distToSegment(p: Point, a: Point, b: Point) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / (vx * vx + vy * vy || 1)));
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

/** Whether `at` is on a feature (with some slack for small things). */
export function hits(f: Feature, at: Point, slack: number): boolean {
  const poly = polyOf(f);
  if (poly) return pointInPoly(at, poly) || poly.some((p, i) => distToSegment(at, p, poly[(i + 1) % poly.length]) < slack);
  const fr = frameOf(f);
  if (!fr) return false;
  if (f.t === 'tree' || f.t === 'column' || f.t === 'debris' || f.t === 'well') return dist(at, fr) < fr.w / 2 + slack;
  const local = rot({ x: at.x - fr.x, y: at.y - fr.y }, -fr.a);
  return Math.abs(local.x) < fr.w / 2 + slack && Math.abs(local.y) < fr.h / 2 + slack;
}

/** The feature under `at`: small things before big ones, the top one first. */
export function pick(features: Feature[], at: Point, slack: number): number | null {
  // Top to bottom, as they're drawn.
  const order: Feature['t'][][] = [['door', 'window'], ['column', 'furniture', 'stall', 'well'], ['building'], ['tree', 'rock'], ['stairs', 'debris', 'puddle', 'rug'], ['floor', 'field']];
  for (const group of order) {
    for (let i = features.length - 1; i >= 0; i--) {
      const f = features[i];
      if (group.includes(f.t) && hits(f, at, slack)) return i;
    }
  }
  return null;
}

export function nearestWall(walls: number[][], at: Point, within: number): number | null {
  let best: number | null = null;
  let bestD = within;
  walls.forEach(([x1, y1, x2, y2], i) => {
    const d = distToSegment(at, { x: x1, y: y1 }, { x: x2, y: y2 });
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

const sameWall = (w: number[], a: Point, b: Point) =>
  (Math.abs(w[0] - a.x) < 0.03 && Math.abs(w[1] - a.y) < 0.03 && Math.abs(w[2] - b.x) < 0.03 && Math.abs(w[3] - b.y) < 0.03) ||
  (Math.abs(w[0] - b.x) < 0.03 && Math.abs(w[1] - b.y) < 0.03 && Math.abs(w[2] - a.x) < 0.03 && Math.abs(w[3] - a.y) < 0.03);

export const edgesOf = (poly: Point[]) => poly.map((p, i) => [p.x, p.y, poly[(i + 1) % poly.length].x, poly[(i + 1) % poly.length].y]);

/** Things that belong to a building outline: the walls along its sides, its doors, its entrance. */
function attached(data: MapData, poly: Point[]) {
  const near = (p: Point) => poly.some((q, i) => distToSegment(p, q, poly[(i + 1) % poly.length]) < 0.8);
  return {
    walls: data.walls.map((w, i) => (poly.some((q, k) => sameWall(w, q, poly[(k + 1) % poly.length])) ? i : -1)).filter((i) => i >= 0),
    doors: data.features.map((f, i) => ((f.t === 'door' || f.t === 'window') && near(f) ? i : -1)).filter((i) => i >= 0),
    entrances: data.entrances.map((e, i) => (e.kind !== 'exit' && near(e) ? i : -1)).filter((i) => i >= 0),
  };
}

/** Moves, stretches or turns feature `index` (a building takes its walls, doors and entrance along). */
export function transformFeature(data: MapData, index: number, from: Frame, to: Frame): MapData {
  const f = data.features[index];
  const features = data.features.slice();
  features[index] = applyFrame(f, from, to);
  if (f.t !== 'building') return { ...data, features };
  const link = attached(data, f.poly);
  const turn = to.a - from.a;
  for (const i of link.doors) {
    const d = data.features[i] as Extract<Feature, { t: 'door' | 'window' }>;
    features[i] = { ...d, ...mapPoint(d, from, to), a: d.a + turn };
  }
  const entrances = data.entrances.map((e, i) => (link.entrances.includes(i) ? { ...e, ...mapPoint(e, from, to) } : e));
  const walls = data.walls.filter((_, i) => !link.walls.includes(i)).concat(edgesOf((features[index] as Extract<Feature, { t: 'building' }>).poly));
  return { features, walls, entrances };
}

/** Removes feature `index` (a building goes with its walls, doors and entrance). */
export function removeFeature(data: MapData, index: number): MapData {
  const f = data.features[index];
  if (f.t !== 'building') {
    // Columns and rocks also have little walls around them.
    const box = f.t === 'column' || f.t === 'rock' ? frameOf(f) : null;
    const walls = box ? data.walls.filter(([x1, y1, x2, y2]) => !(dist({ x: x1, y: y1 }, box) < box.w && dist({ x: x2, y: y2 }, box) < box.w)) : data.walls;
    return { ...data, walls, features: data.features.filter((_, i) => i !== index) };
  }
  const link = attached(data, f.poly);
  return {
    features: data.features.filter((_, i) => i !== index && !link.doors.includes(i)),
    walls: data.walls.filter((_, i) => !link.walls.includes(i)),
    entrances: data.entrances.filter((_, i) => !link.entrances.includes(i)),
  };
}

/** Cuts a doorway into wall `index` at `at`, with a door in it. */
export function cutDoor(data: MapData, index: number, at: Point, width = 1.2): MapData {
  const [x1, y1, x2, y2] = data.walls[index];
  const len = Math.hypot(x2 - x1, y2 - y1);
  const t = Math.max(0, Math.min(1, ((at.x - x1) * (x2 - x1) + (at.y - y1) * (y2 - y1)) / (len * len || 1)));
  const half = Math.min(width / 2, len / 2) / len;
  const p = { x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t };
  const pieces: number[][] = [];
  if (t - half > 0.01) pieces.push([x1, y1, x1 + (x2 - x1) * (t - half), y1 + (y2 - y1) * (t - half)]);
  if (t + half < 0.99) pieces.push([x1 + (x2 - x1) * (t + half), y1 + (y2 - y1) * (t + half), x2, y2]);
  return {
    ...data,
    walls: [...data.walls.slice(0, index), ...pieces, ...data.walls.slice(index + 1)],
    features: [...data.features, { t: 'door', x: p.x, y: p.y, a: Math.atan2(y2 - y1, x2 - x1), w: Math.min(width, len) }],
  };
}

/** Snaps a point to the nearest wall end (so new walls join up neatly). */
export function snapToWalls(walls: number[][], p: Point, within: number): Point {
  let best = p;
  let bestD = within;
  for (const [x1, y1, x2, y2] of walls) {
    for (const q of [
      { x: x1, y: y1 },
      { x: x2, y: y2 },
    ]) {
      const d = dist(p, q);
      if (d < bestD) {
        bestD = d;
        best = q;
      }
    }
  }
  return best;
}

export const rectPoly = (a: Point, b: Point): Point[] => [
  { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) },
  { x: Math.max(a.x, b.x), y: Math.min(a.y, b.y) },
  { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) },
  { x: Math.min(a.x, b.x), y: Math.max(a.y, b.y) },
];

export const newEntranceId = (entrances: Entrance[]) => {
  for (let n = entrances.length + 1; ; n++) if (!entrances.some((e) => e.id === `d${n}`)) return `d${n}`;
};
