// Procedural generators: villages, building interiors, dungeons and caves.
// Everything comes from a seed (same seed + same context = same place), in map
// units (1 = 5 ft), gridless. The generators only make the data; how it looks is
// up to the map renderer (client/src/map/).

import type { Point } from './geometry.ts';
import { LOOK, PERSONALITY, SECRET, innName, makeNoise, makeRng, personName, placeName, type Rng } from './random.ts';
import type { BuildingType, Entrance, Feature, FloorMaterial, Npc, Place, PlaceContext, PlaceKind, Roof } from './places.ts';

export type GeneratedPlace = Omit<Place, 'id' | 'parentId' | 'parentEntranceId'>;
type Wall = number[]; // [x1, y1, x2, y2]

// ---------------------------------------------------------------------------
// The DM's description steers the generator
// ---------------------------------------------------------------------------

export interface Flavour {
  river: boolean;
  walled: boolean;
  ruined: boolean; // haunted / abandoned
  market: boolean;
  farming: boolean;
  mining: boolean;
  holy: boolean;
  dark: boolean; // fewer, more nervous people
}

export function readContext(ctx: PlaceContext, rng: Rng): Flavour {
  const text = `${ctx.description} ${ctx.mood}`.toLowerCase();
  const has = (...words: string[]) => words.some((w) => text.includes(w));
  return {
    river: has('river', 'fishing', 'fisher', 'lake', 'mill', 'bridge', 'water', 'boat') || rng.chance(0.35),
    walled: has('wall', 'fort', 'war', 'palisade', 'border', 'besieged', 'guard'),
    ruined: has('haunted', 'abandoned', 'ruin', 'cursed', 'plague', 'burned', 'deserted', 'war-torn'),
    market: has('market', 'trade', 'merchant', 'rich', 'festival', 'fair', 'festive'),
    farming: has('farm', 'harvest', 'field', 'crop', 'sheep', 'cattle') || rng.chance(0.6),
    mining: has('mine', 'miner', 'cave', 'mountain', 'ore', 'dwar'),
    holy: has('temple', 'holy', 'church', 'shrine', 'pilgrim', 'priest', 'cult'),
    dark: has('haunted', 'fear', 'dark', 'cursed', 'dread', 'plague', 'abandoned', 'war'),
  };
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const rect = (cx: number, cy: number, w: number, h: number, a: number): Point[] => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ].map(([x, y]) => ({ x: cx + x * c - y * s, y: cy + x * s + y * c }));
};

const edges = (poly: Point[]): Wall[] => poly.map((p, i) => [p.x, p.y, poly[(i + 1) % poly.length].x, poly[(i + 1) % poly.length].y]);
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

function distToSegment(p: Point, a: Point, b: Point) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / (vx * vx + vy * vy || 1)));
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

function distToPolyline(p: Point, pts: Point[]) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) best = Math.min(best, distToSegment(p, pts[i], pts[i + 1]));
  return best;
}

export function pointInPoly(p: Point, poly: Point[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Whether two convex polygons come closer than `margin` (separating axis test). */
function polysOverlap(a: Point[], b: Point[], margin: number) {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const nx = -(q.y - p.y);
      const ny = q.x - p.x;
      const len = Math.hypot(nx, ny) || 1;
      const proj = (pts: Point[]) => pts.map((v) => (v.x * nx + v.y * ny) / len);
      const pa = proj(a);
      const pb = proj(b);
      if (Math.min(...pa) - Math.max(...pb) > margin || Math.min(...pb) - Math.max(...pa) > margin) return false;
    }
  }
  return true;
}

function segmentIntersection(a: Point, b: Point, c: Point, d: Point): Point | null {
  const den = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / den;
  const u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t } : null;
}

/** A wobbly path from a to b (roads, rivers). */
function wobblyPath(rng: Rng, a: Point, b: Point, wobble: number, step = 6): Point[] {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const n = Math.max(2, Math.round(len / step));
  const px = -(b.y - a.y) / len;
  const py = (b.x - a.x) / len;
  let off = 0;
  const pts: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    if (i > 0 && i < n) off = Math.max(-wobble, Math.min(wobble, off + rng.range(-wobble / 2, wobble / 2)));
    else off = 0;
    pts.push({ x: a.x + (b.x - a.x) * t + px * off, y: a.y + (b.y - a.y) * t + py * off });
  }
  return pts;
}

/** Rounds a polyline's corners (keeps its two ends). */
function chaikin(pts: Point[], iterations: number): Point[] {
  let out = pts;
  for (let k = 0; k < iterations; k++) {
    const next: Point[] = [out[0]];
    for (let i = 0; i < out.length - 1; i++) {
      const a = out[i];
      const b = out[i + 1];
      next.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 }, { x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    next.push(out[out.length - 1]);
    out = next;
  }
  return out;
}

/** Walks along a polyline: the point and direction at a distance from its start. */
function walker(pts: Point[]) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  const length = cum[cum.length - 1];
  const at = (d: number) => {
    let i = 1;
    while (i < pts.length - 1 && cum[i] < d) i++;
    const a = pts[i - 1];
    const b = pts[i];
    const t = Math.max(0, Math.min(1, (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1)));
    return { p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, dir: Math.atan2(b.y - a.y, b.x - a.x) };
  };
  return { length, at };
}

/** Where a ray from p (angle a) leaves a w × h map. */
function toEdge(p: Point, a: number, w: number, h: number): Point {
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  const ts = [dx > 1e-6 ? (w - p.x) / dx : Infinity, dx < -1e-6 ? -p.x / dx : Infinity, dy > 1e-6 ? (h - p.y) / dy : Infinity, dy < -1e-6 ? -p.y / dy : Infinity];
  const t = Math.min(...ts);
  return { x: p.x + dx * t, y: p.y + dy * t };
}

const angleDiff = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

/** A rough blob (puddles, rock outcrops). */
function blob(rng: Rng, c: Point, r: number, n = 9): Point[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    const rad = r * rng.range(0.65, 1.15);
    return { x: c.x + Math.cos(a) * rad, y: c.y + Math.sin(a) * rad * rng.range(0.75, 1) };
  });
}

/** A coarse map of what's already used, for placing things quickly. */
class Occupancy {
  readonly cells: Uint8Array;
  private readonly cw: number;
  private readonly ch: number;
  constructor(w: number, h: number) {
    this.cw = Math.ceil(w);
    this.ch = Math.ceil(h);
    this.cells = new Uint8Array(this.cw * this.ch);
  }
  get(x: number, y: number) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    if (ix < 0 || iy < 0 || ix >= this.cw || iy >= this.ch) return 255;
    return this.cells[iy * this.cw + ix];
  }
  private set(ix: number, iy: number, v: number) {
    if (ix < 0 || iy < 0 || ix >= this.cw || iy >= this.ch) return;
    this.cells[iy * this.cw + ix] = v;
  }
  markPoly(poly: Point[], v: number, margin = 0) {
    const xs = poly.map((p) => p.x);
    const ys = poly.map((p) => p.y);
    for (let y = Math.floor(Math.min(...ys) - margin); y <= Math.max(...ys) + margin; y++)
      for (let x = Math.floor(Math.min(...xs) - margin); x <= Math.max(...xs) + margin; x++) {
        const c = { x: x + 0.5, y: y + 0.5 };
        if (pointInPoly(c, poly) || (margin > 0 && poly.some((p, i) => distToSegment(c, p, poly[(i + 1) % poly.length]) < margin))) this.set(x, y, v);
      }
  }
  markLine(pts: Point[], radius: number, v: number) {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      for (let y = Math.floor(Math.min(a.y, b.y) - radius); y <= Math.max(a.y, b.y) + radius; y++)
        for (let x = Math.floor(Math.min(a.x, b.x) - radius); x <= Math.max(a.x, b.x) + radius; x++) {
          if (distToSegment({ x: x + 0.5, y: y + 0.5 }, a, b) < radius) this.set(x, y, v);
        }
    }
  }
  free(pts: Point[]) {
    return pts.every((p) => this.get(p.x, p.y) === 0);
  }
}

function makeNpc(rng: Rng, role: string, flavour: Flavour, entranceId?: string): Npc {
  const personality = flavour.dark && rng.chance(0.5) ? rng.pick(['frightened of the dark', 'nervous, keeps looking over their shoulder', 'grieving someone recently lost', 'suspicious of strangers']) : rng.pick(PERSONALITY);
  return {
    id: `n${Math.floor(rng() * 1e9).toString(36)}`,
    name: personName(rng),
    role,
    personality,
    look: rng.pick(LOOK),
    secret: rng.pick(SECRET),
    ...(entranceId ? { entranceId } : {}),
  };
}

const ROLE: Partial<Record<BuildingType, string>> = {
  inn: 'innkeeper',
  smithy: 'blacksmith',
  temple: 'priest',
  shop: 'merchant',
  hall: 'village elder',
  farm: 'farmer',
};

/** Footprint in the village (along the road × depth). */
const BIG: Partial<Record<BuildingType, [number, number]>> = {
  inn: [10, 7.5],
  smithy: [7, 5.5],
  temple: [8, 12],
  shop: [6.5, 5],
  hall: [10, 8],
};

// ---------------------------------------------------------------------------
// Village
// ---------------------------------------------------------------------------

const VILLAGE = {
  small: { w: 110, h: 76, R: 19, max: 60 },
  medium: { w: 150, h: 104, R: 26, max: 120 },
  large: { w: 200, h: 140, R: 35, max: 220 },
};

export function generateVillage(seed: number, ctx: PlaceContext, name?: string): GeneratedPlace {
  const rng = makeRng(seed);
  const f = readContext(ctx, rng);
  const noise = makeNoise(seed);
  const { w, h, R, max } = VILLAGE[ctx.size];
  const villageName = name || placeName(rng);
  const c = { x: w * rng.range(0.42, 0.58), y: h * rng.range(0.42, 0.58) };
  const grid = new Occupancy(w, h);
  const features: Feature[] = [];
  const walls: Wall[] = [];
  const entrances: Entrance[] = [];
  const npcs: Npc[] = [];
  const clampIn = (p: Point, m: number) => ({ x: Math.min(w - m, Math.max(m, p.x)), y: Math.min(h - m, Math.max(m, p.y)) });

  // ---- roads: a main road through the village, branches, and lanes ----
  const roads: { pts: Point[]; w: number }[] = [];
  const mainA = rng.range(-0.4, 0.4);
  const mainPts = [...wobblyPath(rng, toEdge(c, mainA + Math.PI, w, h), c, 5, 9), ...wobblyPath(rng, c, toEdge(c, mainA, w, h), 5, 9).slice(1)];
  roads.push({ pts: chaikin(mainPts, 3), w: 3 });
  const branches = ctx.size === 'small' ? rng.int(1, 2) : ctx.size === 'medium' ? rng.int(2, 3) : rng.int(3, 4);
  const usedAngles = [mainA, mainA + Math.PI];
  for (let i = 0; i < branches; i++) {
    let a = rng.range(0, Math.PI * 2);
    for (let tries = 0; tries < 30 && !usedAngles.every((u) => angleDiff(a, u) > 0.75); tries++) a = rng.range(0, Math.PI * 2);
    usedAngles.push(a);
    const end = rng.chance(0.7) ? toEdge(c, a, w, h) : clampIn({ x: c.x + Math.cos(a) * R * rng.range(1.8, 2.6), y: c.y + Math.sin(a) * R * rng.range(1.8, 2.6) }, 4);
    roads.push({ pts: chaikin(wobblyPath(rng, c, end, 4, 8), 3), w: 2.3 });
  }
  const laneTarget = { small: 4, medium: 8, large: 13 }[ctx.size];
  for (let tries = 0, lanes = 0; lanes < laneTarget && tries < 80; tries++) {
    const r = rng.pick(roads);
    const walk = walker(r.pts);
    const s = walk.at(rng.range(0, walk.length));
    const dc = dist(s.p, c);
    if (dc > R * 1.4 || dc < R * 0.35) continue;
    const a = s.dir + (rng.chance(0.5) ? 1 : -1) * (Math.PI / 2 + rng.range(-0.45, 0.45));
    const len = rng.range(R * 0.6, R * 1.3);
    const end = clampIn({ x: s.p.x + Math.cos(a) * len, y: s.p.y + Math.sin(a) * len }, 3);
    roads.push({ pts: chaikin(wobblyPath(rng, s.p, end, 2.5, 5), 3), w: 1.6 });
    lanes++;
  }

  // ---- a river, with bridges where roads cross it ----
  let river: Point[] | null = null;
  let riverW = 0;
  if (f.river) {
    riverW = rng.range(4.5, 6.5);
    const rx = c.x + (rng.chance(0.5) ? 1 : -1) * R * rng.range(0.45, 1.1);
    river = chaikin(wobblyPath(rng, { x: rx + rng.range(-12, 12), y: -2 }, { x: rx + rng.range(-12, 12), y: h + 2 }, 9, 11), 3);
    features.push({ t: 'water', pts: river, w: riverW });
    grid.markLine(river, riverW / 2 + 1.6, 3);
  }
  for (const r of roads) features.push({ t: 'road', pts: r.pts, w: r.w });
  if (river) {
    for (const r of roads) {
      for (let i = 0; i < r.pts.length - 1; i++) {
        for (let j = 0; j < river.length - 1; j++) {
          const x = segmentIntersection(r.pts[i], r.pts[i + 1], river[j], river[j + 1]);
          if (!x) continue;
          const dir = Math.atan2(r.pts[i + 1].y - r.pts[i].y, r.pts[i + 1].x - r.pts[i].x);
          const half = riverW / 2 + 1.6;
          features.push({ t: 'bridge', a: { x: x.x - Math.cos(dir) * half, y: x.y - Math.sin(dir) * half }, b: { x: x.x + Math.cos(dir) * half, y: x.y + Math.sin(dir) * half }, w: r.w + 0.8 });
        }
      }
    }
  }
  for (const r of roads) grid.markLine(r.pts, r.w / 2 + 0.5, 1);

  // ---- the square, with a well (and market stalls) ----
  const sqR = Math.max(5, R * 0.3);
  const square: Point[] = Array.from({ length: 12 }, (_, i) => {
    const a = (i / 12) * Math.PI * 2;
    const rad = sqR * rng.range(0.85, 1.1);
    return { x: c.x + Math.cos(a) * rad, y: c.y + Math.sin(a) * rad * 0.85 };
  });
  features.push({ t: 'square', poly: square });
  grid.markPoly(square, 4, 0.5);
  const wellAt = { x: c.x + rng.range(-1.5, 1.5), y: c.y + rng.range(-1.5, 1.5) };
  features.push({ t: 'well', x: wellAt.x, y: wellAt.y });
  walls.push(...edges(rect(wellAt.x, wellAt.y, 1.2, 1.2, 0)));
  if (f.market) {
    const colors = ['#b5523b', '#3f6fa0', '#c9a23a', '#5d8a4e', '#8b4f8f'];
    for (let i = 0; i < rng.int(4, 8); i++) {
      const a = rng.range(0, Math.PI * 2);
      const at = { x: c.x + Math.cos(a) * sqR * 0.6, y: c.y + Math.sin(a) * sqR * 0.5 };
      if (dist(at, wellAt) < 2.5) continue;
      features.push({ t: 'stall', x: at.x, y: at.y, w: 2.2, h: 1.6, a: a + Math.PI / 2, color: rng.pick(colors) });
    }
  }

  // ---- buildings along the roads ----
  type Placed = { poly: Point[]; c: Point; r: number };
  const placed: Placed[] = [];
  const bucket = new Map<string, Placed[]>();
  const keyOf = (p: Point) => `${Math.floor(p.x / 12)},${Math.floor(p.y / 12)}`;
  const near = (p: Point) => {
    const out: Placed[] = [];
    const bx = Math.floor(p.x / 12);
    const by = Math.floor(p.y / 12);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) out.push(...(bucket.get(`${bx + dx},${by + dy}`) ?? []));
    return out;
  };
  const fits = (poly: Point[], cc: Point, rad: number, except?: Placed) => {
    if (poly.some((p) => p.x < 2 || p.y < 2 || p.x > w - 2 || p.y > h - 2)) return false;
    if (near(cc).some((b) => b !== except && dist(b.c, cc) < b.r + rad + 0.5 && polysOverlap(b.poly, poly, 0.45))) return false;
    const probes = [...poly, cc, ...poly.map((p, i) => ({ x: (p.x + poly[(i + 1) % 4].x) / 2, y: (p.y + poly[(i + 1) % 4].y) / 2 }))];
    if (roads.some((r) => probes.some((p) => distToPolyline(p, r.pts) < r.w / 2 + 0.25))) return false;
    if (river && probes.some((p) => distToPolyline(p, river!) < riverW / 2 + 1.2)) return false;
    if (probes.some((p) => pointInPoly(p, square))) return false;
    return true;
  };
  const roofFor = (type: BuildingType): Roof =>
    type === 'temple' || type === 'hall' ? 'slate' : type === 'farm' ? (rng.chance(0.6) ? 'thatch' : 'wood') : type === 'inn' ? 'wood' : rng.chance(0.62) ? 'wood' : rng.chance(0.6) ? 'slate' : 'thatch';
  const gardenTrees: Point[] = [];
  let farms = 0;
  const addBuilding = (poly: Point[], cc: Point, n: Point, dir: number, depth: number, type: BuildingType) => {
    const rad = Math.hypot(dist(poly[0], poly[1]), dist(poly[1], poly[2])) / 2;
    const b = { poly, c: cc, r: rad };
    placed.push(b);
    bucket.set(keyOf(cc), [...(bucket.get(keyOf(cc)) ?? []), b]);
    grid.markPoly(poly, 2, 0.6);
    const ruined = type === 'ruin' || (f.ruined && rng.chance(0.2));
    const label = type === 'inn' ? innName(rng) : type === 'temple' ? `Shrine of ${rng.pick(['the Dawn', 'the Harvest', 'Saint ' + personName(rng).split(' ')[0], 'the Quiet Moon', 'the Old Oak'])}` : undefined;
    features.push({ t: 'building', poly, type, roof: roofFor(type), ...(ruined ? { ruined } : {}), ...(label ? { label } : {}) });
    walls.push(...edges(poly));
    // The door faces the road.
    const wallMid = { x: cc.x - n.x * (depth / 2), y: cc.y - n.y * (depth / 2) };
    features.push({ t: 'door', x: wallMid.x, y: wallMid.y, a: dir, w: type === 'inn' || type === 'hall' || type === 'temple' ? 1.6 : 1 });
    const id = `e${entrances.length}`;
    const owner = ROLE[type] && (type !== 'farm' || farms++ < 3) ? makeNpc(rng, ROLE[type]!, f, id) : null;
    const entranceName =
      label ??
      (type === 'smithy'
        ? `${owner?.name.split(' ')[0]}'s Smithy`
        : type === 'shop'
          ? `${owner?.name.split(' ')[0]}'s ${rng.pick(['General Store', 'Bakery', 'Apothecary', 'Tailor', 'Trading Post', 'Butcher', 'Cobbler'])}`
          : type === 'hall'
            ? 'Village Hall'
            : type === 'farm'
              ? `${(owner?.name ?? personName(rng)).split(' ')[1]} Farm`
              : type === 'ruin'
                ? 'Burned-out house'
                : `${personName(rng).split(' ')[1]} house`);
    entrances.push({ id, name: entranceName, kind: 'building', building: type, x: wallMid.x - n.x * 0.6, y: wallMid.y - n.y * 0.6, targetId: null });
    if (owner) npcs.push(owner);
    return b;
  };
  const tryAt = (s: { p: Point; dir: number }, side: number, roadW: number, bw: number, bd: number, type: BuildingType) => {
    const n = { x: -Math.sin(s.dir) * side, y: Math.cos(s.dir) * side };
    const setback = roadW / 2 + 0.5 + rng.range(0, 0.8);
    const cc = { x: s.p.x + n.x * (setback + bd / 2), y: s.p.y + n.y * (setback + bd / 2) };
    const poly = rect(cc.x, cc.y, bw, bd, s.dir);
    if (!fits(poly, cc, Math.hypot(bw, bd) / 2)) return null;
    const b = addBuilding(poly, cc, n, s.dir, bd, type);
    // Some houses have an extension at the back.
    if ((type === 'house' || type === 'farm' || type === 'inn') && rng.chance(0.32)) {
      const aw = bw * rng.range(0.45, 0.7);
      const ad = bd * rng.range(0.5, 0.8);
      const t = { x: Math.cos(s.dir), y: Math.sin(s.dir) };
      const along = rng.range(-bw / 4, bw / 4);
      const ac = { x: cc.x + n.x * (bd / 2 + ad / 2 - 0.15) + t.x * along, y: cc.y + n.y * (bd / 2 + ad / 2 - 0.15) + t.y * along };
      const apoly = rect(ac.x, ac.y, aw, ad, s.dir);
      if (fits(apoly, ac, Math.hypot(aw, ad) / 2, b) && !placed.some((o) => o !== b && polysOverlap(o.poly, apoly, 0.3))) {
        const ab = { poly: apoly, c: ac, r: Math.hypot(aw, ad) / 2 };
        placed.push(ab);
        bucket.set(keyOf(ac), [...(bucket.get(keyOf(ac)) ?? []), ab]);
        grid.markPoly(apoly, 2, 0.6);
        features.push({ t: 'building', poly: apoly, type: type === 'inn' ? 'house' : type, roof: roofFor(type) });
        walls.push(...edges(apoly));
      }
    }
    // A tree in the garden.
    if (rng.chance(0.3)) gardenTrees.push({ x: cc.x + n.x * (bd / 2 + 2.2) + rng.range(-1.5, 1.5), y: cc.y + n.y * (bd / 2 + 2.2) + rng.range(-1.5, 1.5) });
    return b;
  };
  const spots = roads.flatMap((r) => {
    const walk = walker(r.pts);
    const out: { p: Point; dir: number; side: number; w: number }[] = [];
    for (let d = 2; d < walk.length - 2; d += 1.5) for (const side of [1, -1]) out.push({ ...walk.at(d), side, w: r.w });
    return out;
  });
  // The important buildings first, as close to the square as they fit.
  const important: BuildingType[] = ['inn', 'smithy', ...(f.holy || rng.chance(0.65) ? (['temple'] as const) : []), ...(f.market ? (['shop', 'shop', 'shop'] as const) : (['shop', 'shop'] as const)), ...(ctx.size !== 'small' ? (['hall'] as const) : [])];
  const byCentre = [...spots].sort((a, b) => dist(a.p, c) - dist(b.p, c));
  for (const type of important) {
    const [bw, bd] = BIG[type]!.map((v) => v * rng.range(0.92, 1.1));
    for (const s of byCentre.slice(0, 400)) if (tryAt(s, s.side, s.w, bw, bd, type)) break;
  }
  // Then houses along every road: dense in the middle, farms further out.
  for (const r of roads) {
    const walk = walker(r.pts);
    for (const side of [1, -1]) {
      for (let d = 1.5; d < walk.length - 2 && placed.length < max; ) {
        const s = walk.at(d);
        const dc = dist(s.p, c);
        const density = dc < R ? 0.97 : dc < R * 2 ? 0.97 - ((dc - R) / R) * 0.8 : f.farming ? 0.12 : 0.05;
        if (!rng.chance(f.dark ? density * 0.8 : density)) {
          d += 2;
          continue;
        }
        const farm = dc > R * 1.4 && f.farming && rng.chance(0.45);
        const type: BuildingType = farm ? 'farm' : f.ruined && rng.chance(0.3) ? 'ruin' : 'house';
        const bw = farm ? rng.range(6.5, 8.5) : rng.range(3.8, 6.4);
        const bd = farm ? rng.range(4.5, 6) : rng.range(3.2, 4.8);
        d += tryAt(s, side, r.w, bw, bd, type) ? bw + rng.range(0.5, 1.6) : 1;
      }
    }
  }

  // ---- a palisade around walled villages (gates where roads go through) ----
  if (f.walled) {
    const ring = Array.from({ length: 72 }, (_, i) => {
      const a = (i / 72) * Math.PI * 2;
      return clampIn({ x: c.x + Math.cos(a) * R * 1.45, y: c.y + Math.sin(a) * R * 1.3 }, 2);
    });
    let run: Point[] = [];
    const flush = () => {
      if (run.length > 1) {
        features.push({ t: 'fence', pts: run });
        for (let i = 0; i < run.length - 1; i++) walls.push([run[i].x, run[i].y, run[i + 1].x, run[i + 1].y]);
      }
      run = [];
    };
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const gate = [...roads.map((r) => r.pts), ...(river ? [river] : [])].some((pts) => pts.some((p, j) => j < pts.length - 1 && segmentIntersection(a, b, p, pts[j + 1])));
      if (gate) {
        run.push(a);
        flush();
      } else {
        if (!run.length) run.push(a);
        run.push(b);
      }
    }
    flush();
  }

  // ---- fields in patchworks on the outskirts ----
  if (f.farming || rng.chance(0.6)) {
    const blocks = { small: 4, medium: 7, large: 11 }[ctx.size];
    for (let b = 0; b < blocks; b++) {
      const a = rng.range(0, Math.PI * 2);
      const at = { x: c.x + Math.cos(a) * R * rng.range(1.1, 1.9), y: c.y + Math.sin(a) * R * rng.range(1.1, 1.9) };
      if (at.x < 8 || at.y < 8 || at.x > w - 8 || at.y > h - 8) continue;
      // Line the fields up with the nearest road.
      let o = rng.range(0, Math.PI);
      let best = Infinity;
      for (const r of roads)
        for (let i = 0; i < r.pts.length - 1; i++) {
          const d = distToSegment(at, r.pts[i], r.pts[i + 1]);
          if (d < best) {
            best = d;
            o = Math.atan2(r.pts[i + 1].y - r.pts[i].y, r.pts[i + 1].x - r.pts[i].x);
          }
        }
      const cw = rng.range(7, 12);
      const ch = rng.range(5, 9);
      const gap = rng.range(1, 1.7);
      const u = { x: Math.cos(o), y: Math.sin(o) };
      const v = { x: -Math.sin(o), y: Math.cos(o) };
      for (let i = -3; i <= 3; i++)
        for (let j = -2; j <= 2; j++) {
          if (rng.chance(0.12)) continue;
          const fc = { x: at.x + u.x * i * (cw + gap) + v.x * j * (ch + gap), y: at.y + u.y * i * (cw + gap) + v.y * j * (ch + gap) };
          if (dist(fc, c) < R * 1.05) continue;
          const poly = rect(fc.x, fc.y, cw, ch, o).map((p) => ({ x: p.x + rng.range(-0.7, 0.7), y: p.y + rng.range(-0.7, 0.7) }));
          const probes = [...poly, fc, ...poly.map((p, k) => ({ x: (p.x + poly[(k + 1) % 4].x) / 2, y: (p.y + poly[(k + 1) % 4].y) / 2 }))];
          if (probes.some((p) => p.x < 1.5 || p.y < 1.5 || p.x > w - 1.5 || p.y > h - 1.5)) continue;
          if (!grid.free(probes)) continue;
          const roll = rng();
          features.push({ t: 'field', poly, a: o + (rng.chance(0.5) ? 0 : Math.PI / 2) + rng.range(-0.08, 0.08), crop: roll < 0.6 ? 'soil' : roll < 0.85 ? 'green' : 'gold' });
          grid.markPoly(poly, 5);
          // Hedgerows along some field edges.
          if (rng.chance(0.18)) {
            const k = rng.int(0, 3);
            const p = poly[k];
            const q = poly[(k + 1) % 4];
            const len = dist(p, q);
            const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
            const md = dist(fc, mid) || 1;
            const nx = (fc.x - mid.x) / md;
            const ny = (fc.y - mid.y) / md;
            for (let s = 0.8; s < len; s += 1.5) gardenTrees.push({ x: p.x + ((q.x - p.x) * s) / len - nx * 1.1, y: p.y + ((q.y - p.y) * s) / len - ny * 1.1 });
          }
        }
    }
  }

  // ---- a cave or an old mine in a corner, among rocks ----
  if (f.mining || rng.chance(0.5)) {
    for (let tries = 0; tries < 20; tries++) {
      const corner = { x: rng.chance(0.5) ? rng.range(7, 16) : rng.range(w - 16, w - 7), y: rng.chance(0.5) ? rng.range(7, 14) : rng.range(h - 14, h - 7) };
      if (!grid.free([corner, { x: corner.x + 4, y: corner.y }, { x: corner.x - 4, y: corner.y }, { x: corner.x, y: corner.y + 4 }, { x: corner.x, y: corner.y - 4 }])) continue;
      const rock = blob(rng, corner, rng.range(4, 5.5), 11);
      features.push({ t: 'rock', poly: rock });
      walls.push(...edges(rock));
      grid.markPoly(rock, 6, 1);
      for (let k = 0; k < 3; k++) {
        const small = blob(rng, { x: corner.x + rng.range(-7, 7), y: corner.y + rng.range(-7, 7) }, rng.range(1, 2), 7);
        if (grid.free(small)) {
          features.push({ t: 'rock', poly: small });
          walls.push(...edges(small));
          grid.markPoly(small, 6);
        }
      }
      const towardsCentre = Math.atan2(c.y - corner.y, c.x - corner.x);
      entrances.push({ id: 'cave', name: f.mining ? 'Old mine' : 'Cave mouth', kind: 'cave', x: corner.x + Math.cos(towardsCentre) * 6, y: corner.y + Math.sin(towardsCentre) * 6, targetId: null });
      break;
    }
  }

  // ---- trees: woods towards the edges, a few on their own, and in gardens ----
  const trees: Feature[] = [];
  const tryTree = (p: Point, r: number) => {
    if (!grid.free([p, { x: p.x + r * 0.6, y: p.y }, { x: p.x - r * 0.6, y: p.y }, { x: p.x, y: p.y + r * 0.6 }, { x: p.x, y: p.y - r * 0.6 }])) return;
    trees.push({ t: 'tree', x: p.x, y: p.y, r });
  };
  for (const g of gardenTrees) tryTree(g, rng.range(0.9, 1.4));
  const woods = f.ruined ? 0.5 : 0.56;
  for (let y = 1.5; y < h - 1; y += 2.5)
    for (let x = 1.5; x < w - 1; x += 2.5) {
      const p = { x: x + rng.range(-1.1, 1.1), y: y + rng.range(-1.1, 1.1) };
      const edge = Math.min(p.x, p.y, w - p.x, h - p.y);
      const dc = dist(p, c);
      const forest = noise(p.x, p.y, 34) + (edge < 14 ? (14 - edge) / 45 : 0) - (dc < R * 1.3 ? 0.25 : 0);
      if (forest > woods) tryTree(p, rng.range(1.3, 2.1));
      else if (rng.chance(dc > R * 0.7 ? 0.035 : 0.015)) tryTree(p, rng.range(0.9, 1.5));
    }
  features.push(...trees);
  // A few boulders.
  for (let i = 0; i < rng.int(2, 6); i++) {
    const p = { x: rng.range(5, w - 5), y: rng.range(5, h - 5) };
    const poly = blob(rng, p, rng.range(0.6, 1.2), 6);
    if (dist(p, c) > R && grid.free(poly)) {
      features.push({ t: 'rock', poly });
      walls.push(...edges(poly));
    }
  }

  // ---- villagers without a building of their own ----
  const extra = f.dark ? rng.int(1, 2) : rng.int(2, 4);
  const roles = ['guard', 'farmhand', 'hunter', 'child who knows everything', 'old storyteller', 'traveller passing through', ...(river ? ['fisher', 'ferry keeper'] : []), ...(f.mining ? ['miner'] : [])];
  for (let i = 0; i < extra; i++) npcs.push(makeNpc(rng, rng.pick(roles), f));

  features.push({ t: 'label', x: w / 2, y: 4, text: villageName });
  const startAt = walker(roads[0].pts).at(4).p;
  return {
    name: villageName,
    kind: 'village',
    seed,
    size: { w, h },
    ground: 'grass',
    features,
    walls,
    entrances,
    npcs,
    start: clampIn(startAt, 2.5),
    context: ctx,
  };
}

// ---------------------------------------------------------------------------
// Building interiors
// ---------------------------------------------------------------------------

const BUILDING_SIZE: Record<BuildingType, [number, number]> = {
  house: [5, 4],
  farm: [6, 4.5],
  inn: [9, 7],
  smithy: [6, 5],
  temple: [7, 10],
  shop: [6, 4.5],
  hall: [9, 7],
  ruin: [5, 4],
};

const ROOMS: Record<BuildingType, string[]> = {
  inn: ['common room', 'kitchen', 'bedroom', 'bedroom', 'storeroom'],
  house: ['main room', 'bedroom'],
  farm: ['main room', 'bedroom', 'barn'],
  smithy: ['forge', 'workshop', 'living room'],
  temple: ['nave', 'vestry'],
  shop: ['shop floor', 'storeroom', 'living room'],
  hall: ['great hall', 'office', 'storeroom'],
  ruin: ['ruined room', 'collapsed room'],
};

const MATERIAL: Record<string, FloorMaterial> = {
  'common room': 'wood',
  kitchen: 'tile',
  bedroom: 'wood',
  storeroom: 'earth',
  'main room': 'wood',
  barn: 'earth',
  forge: 'stone',
  workshop: 'earth',
  'living room': 'wood',
  nave: 'flag',
  vestry: 'wood',
  'shop floor': 'wood',
  'great hall': 'flag',
  office: 'wood',
  'ruined room': 'stone',
  'collapsed room': 'earth',
};

/** Furniture per room: kind, width, depth, and whether it stands against a wall. */
const FURNITURE: Record<string, [string, number, number, boolean?][]> = {
  'common room': [['bar', 4, 1, true], ['hearth', 2, 0.9, true], ['table', 2, 1.4], ['table', 2, 1.4], ['table', 2, 1.4], ['table', 1.6, 1.2], ['barrel', 0.9, 0.9, true], ['barrel', 0.9, 0.9, true]],
  kitchen: [['oven', 1.6, 1.2, true], ['counter', 2.4, 0.8, true], ['table', 2, 1], ['barrel', 0.8, 0.8, true], ['sack', 0.8, 0.7, true]],
  bedroom: [['bed', 1.2, 2, true], ['chest', 1, 0.6, true], ['bed', 1.2, 2, true]],
  storeroom: [['crate', 1, 1, true], ['crate', 1, 1, true], ['barrel', 0.9, 0.9, true], ['barrel', 0.9, 0.9, true], ['shelf', 2, 0.6, true], ['sack', 0.8, 0.7, true]],
  'main room': [['hearth', 1.6, 0.8, true], ['table', 1.6, 1.2], ['shelf', 1.6, 0.5, true], ['chest', 1, 0.6, true]],
  barn: [['hay', 2, 1.4], ['hay', 2, 1.4], ['stall', 2, 2.4, true], ['stall', 2, 2.4, true], ['barrel', 0.9, 0.9, true]],
  forge: [['forge', 2, 1.6, true], ['anvil', 1, 0.6], ['barrel', 0.8, 0.8, true], ['rack', 2, 0.5, true]],
  workshop: [['workbench', 2.4, 1, true], ['rack', 2, 0.5, true], ['crate', 1, 1, true]],
  'living room': [['table', 1.6, 1.2], ['bed', 1.2, 2, true], ['hearth', 1.4, 0.7, true]],
  nave: [['altar', 2.4, 1.2, true]],
  vestry: [['chest', 1, 0.6, true], ['shelf', 2, 0.5, true], ['desk', 1.6, 0.9]],
  'shop floor': [['counter', 3, 0.9], ['shelf', 2.4, 0.5, true], ['shelf', 2.4, 0.5, true], ['barrel', 0.8, 0.8, true]],
  'great hall': [['long table', 5, 1.4], ['throne', 1.3, 1.2, true], ['hearth', 2, 1, true]],
  office: [['desk', 1.8, 1], ['shelf', 2, 0.5, true], ['chest', 1, 0.6, true]],
  'ruined room': [['rubble', 2, 1.6], ['rubble', 1.5, 1.2], ['table', 1.6, 1.1]],
  'collapsed room': [['rubble', 2.4, 2], ['rubble', 1.5, 1.2]],
};

const RUG_COLORS = ['#8b3a3a', '#3a5a8b', '#6b4f2a', '#4f6b3a', '#7a4a7a'];

export function generateBuilding(seed: number, type: BuildingType, name: string, ctx: PlaceContext): GeneratedPlace {
  const rng = makeRng(seed);
  // Interiors are drawn bigger than the outline seen in the village, so they're comfortable to play in.
  const [bw, bd] = BUILDING_SIZE[type];
  const W = Math.round(bw * 1.6 * rng.range(0.95, 1.1));
  const H = Math.round(bd * 1.6 * rng.range(0.95, 1.1));
  const margin = 3;
  const x0 = margin;
  const y0 = margin;
  const features: Feature[] = [];
  const walls: Wall[] = [];
  const doors: Point[] = [];

  // Split the floor into rooms (the first, biggest room has the front door).
  type Box = { x: number; y: number; w: number; h: number };
  const rooms: Box[] = [{ x: x0, y: y0, w: W, h: H }];
  const wanted = ROOMS[type].length;
  while (rooms.length < wanted) {
    rooms.sort((a, b) => b.w * b.h - a.w * a.h);
    const r = rooms.shift()!;
    const vertical = r.w > r.h;
    const cut = rng.range(0.35, 0.65);
    const size = vertical ? r.w : r.h;
    const a = Math.round(size * cut);
    if (a < 3 || size - a < 3) {
      rooms.push(r);
      break;
    }
    rooms.push(...(vertical ? [{ ...r, w: a }, { ...r, x: r.x + a, w: r.w - a }] : [{ ...r, h: a }, { ...r, y: r.y + a, h: r.h - a }]));
  }
  // The biggest room touching the front (bottom) wall is the main room.
  rooms.sort((a, b) => Number(b.y + b.h >= y0 + H - 0.01) - Number(a.y + a.h >= y0 + H - 0.01) || b.w * b.h - a.w * a.h);
  const names = ROOMS[type];

  // Outer walls with the front door in the main room's bottom wall.
  const main = rooms[0];
  const doorX = main.x + main.w / 2;
  walls.push([x0, y0, x0 + W, y0], [x0 + W, y0, x0 + W, y0 + H], [x0, y0, x0, y0 + H]);
  walls.push([x0, y0 + H, doorX - 0.7, y0 + H], [doorX + 0.7, y0 + H, x0 + W, y0 + H]);
  features.push({ t: 'door', x: doorX, y: y0 + H, a: 0, w: 1.4 });
  doors.push({ x: doorX, y: y0 + H });

  // Inner walls between rooms, each with a doorway and a door.
  const inner = new Set<string>();
  const innerEnds: Point[] = [];
  for (const r of rooms) {
    for (const [ax, ay, bx, by] of [
      [r.x + r.w, r.y, r.x + r.w, r.y + r.h],
      [r.x, r.y + r.h, r.x + r.w, r.y + r.h],
    ] as const) {
      const onOuter = (ax === x0 + W && bx === x0 + W) || (ay === y0 + H && by === y0 + H);
      if (onOuter) continue;
      const key = `${ax},${ay},${bx},${by}`;
      if (inner.has(key)) continue;
      inner.add(key);
      const len = Math.hypot(bx - ax, by - ay);
      const t = rng.range(0.3, 0.7);
      const gap = 0.6 / len;
      walls.push([ax, ay, ax + (bx - ax) * (t - gap), ay + (by - ay) * (t - gap)], [ax + (bx - ax) * (t + gap), ay + (by - ay) * (t + gap), bx, by]);
      const d = { x: ax + (bx - ax) * t, y: ay + (by - ay) * t };
      features.push({ t: 'door', x: d.x, y: d.y, a: Math.atan2(by - ay, bx - ax), w: 1.2 });
      doors.push(d);
      innerEnds.push({ x: ax, y: ay }, { x: bx, y: by });
    }
  }

  // Windows in the outer walls.
  const sides: [Point, Point][] = [
    [{ x: x0, y: y0 }, { x: x0 + W, y: y0 }],
    [{ x: x0 + W, y: y0 }, { x: x0 + W, y: y0 + H }],
    [{ x: x0, y: y0 + H }, { x: x0 + W, y: y0 + H }],
    [{ x: x0, y: y0 }, { x: x0, y: y0 + H }],
  ];
  if (type !== 'ruin' && type !== 'farm') {
    for (const [a, b] of sides) {
      const len = dist(a, b);
      for (let s = 2.2; s < len - 1.5; s += rng.range(3.2, 4.5)) {
        const p = { x: a.x + ((b.x - a.x) * s) / len, y: a.y + ((b.y - a.y) * s) / len };
        if (doors.some((d) => dist(d, p) < 1.8) || innerEnds.some((e) => dist(e, p) < 1)) continue;
        features.push({ t: 'window', x: p.x, y: p.y, a: Math.atan2(b.y - a.y, b.x - a.x), w: 1 });
      }
    }
  }

  // Rooms: floors, columns, furniture, rugs.
  rooms.forEach((r, i) => {
    const room = names[i] ?? 'room';
    features.push({ t: 'floor', poly: [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }], room, material: MATERIAL[room] ?? 'wood' });
    const taken: { x: number; y: number; r: number }[] = doors.map((d) => ({ ...d, r: 1.1 }));
    const free = (x: number, y: number, rad: number) => !taken.some((p) => Math.hypot(p.x - x, p.y - y) < p.r + rad + 0.25);

    // Pillars in big halls (they block movement).
    if ((room === 'nave' || room === 'great hall') && r.w >= 7) {
      for (let x = r.x + 2; x <= r.x + r.w - 2; x += 3) {
        for (const y of [r.y + 1.6, r.y + r.h - 1.6]) {
          if (!free(x, y, 0.4)) continue;
          features.push({ t: 'column', x, y, r: 0.4 });
          walls.push(...edges(rect(x, y, 0.8, 0.8, 0)));
          taken.push({ x, y, r: 0.6 });
        }
      }
    }
    // Pews in rows facing the altar (top wall), with an aisle in the middle.
    if (room === 'nave') {
      for (let y = r.y + 3; y < r.y + r.h - 1.6; y += 1.5) {
        for (const x of [r.x + r.w * 0.28, r.x + r.w * 0.72]) {
          if (free(x, y, 0.5)) {
            features.push({ t: 'furniture', kind: 'pew', x, y, w: Math.min(3, r.w * 0.32), h: 0.6, a: 0 });
            taken.push({ x, y, r: 0.9 });
          }
        }
      }
    }
    if (rng.chance(room.includes('bedroom') || room === 'main room' || room === 'great hall' || room === 'nave' ? 0.6 : 0.15) && r.w > 4 && r.h > 4) {
      const rw = Math.min(r.w - 2.2, rng.range(2.4, 4));
      const rh = Math.min(r.h - 2.2, rng.range(1.8, 3));
      features.push({ t: 'rug', x: r.x + r.w / 2 + rng.range(-0.5, 0.5), y: r.y + r.h / 2 + rng.range(-0.5, 0.5), w: rw, h: rh, a: 0, color: rng.pick(RUG_COLORS) });
    }

    for (const [kind, fw, fh, atWall] of FURNITURE[room] ?? []) {
      for (let tries = 0; tries < 30; tries++) {
        let x: number;
        let y: number;
        let a = 0;
        if (atWall) {
          // Against a wall, facing into the room.
          const side = rng.int(0, 3);
          if (side === 0) [x, y, a] = [rng.range(r.x + fw / 2 + 0.3, r.x + r.w - fw / 2 - 0.3), r.y + fh / 2 + 0.2, 0];
          else if (side === 2) [x, y, a] = [rng.range(r.x + fw / 2 + 0.3, r.x + r.w - fw / 2 - 0.3), r.y + r.h - fh / 2 - 0.2, Math.PI];
          else if (side === 1) [x, y, a] = [r.x + r.w - fh / 2 - 0.2, rng.range(r.y + fw / 2 + 0.3, r.y + r.h - fw / 2 - 0.3), Math.PI / 2];
          else [x, y, a] = [r.x + fh / 2 + 0.2, rng.range(r.y + fw / 2 + 0.3, r.y + r.h - fw / 2 - 0.3), -Math.PI / 2];
          // Too big for this wall.
          if ((side % 2 === 0 ? fw + 0.6 > r.w : fw + 0.6 > r.h) || fh + 0.4 > (side % 2 === 0 ? r.h : r.w)) continue;
        } else {
          if (fw + 1.6 > r.w || fh + 1.6 > r.h) break;
          x = rng.range(r.x + fw / 2 + 0.8, r.x + r.w - fw / 2 - 0.8);
          y = rng.range(r.y + fh / 2 + 0.8, r.y + r.h - fh / 2 - 0.8);
        }
        const rad = Math.hypot(fw, fh) / 2;
        if (!free(x, y, rad * 0.8)) continue;
        taken.push({ x, y, r: rad });
        features.push({ t: 'furniture', kind, x, y, w: fw, h: fh, a });
        // Chairs around tables.
        if (kind === 'table' || kind === 'long table' || kind === 'desk') {
          const seats: Point[] =
            kind === 'desk' ? [{ x, y: y + fh / 2 + 0.4 }] : [{ x: x - fw / 2 - 0.4, y }, { x: x + fw / 2 + 0.4, y }, ...(fw > 1.8 ? [{ x: x - fw / 4, y: y - fh / 2 - 0.4 }, { x: x + fw / 4, y: y + fh / 2 + 0.4 }] : [{ x, y: y + fh / 2 + 0.4 }])];
          for (const s of seats) {
            if (s.x > r.x + 0.4 && s.x < r.x + r.w - 0.4 && s.y > r.y + 0.4 && s.y < r.y + r.h - 0.4 && rng.chance(0.85)) features.push({ t: 'furniture', kind: 'chair', x: s.x, y: s.y, w: 0.55, h: 0.55, a: rng.range(-0.3, 0.3) });
          }
        }
        break;
      }
    }
    features.push({ t: 'label', x: r.x + r.w / 2, y: r.y + 0.9, text: room });
  });
  if (type === 'ruin') {
    for (let i = 0; i < 8; i++) features.push({ t: 'debris', x: rng.range(x0 + 1, x0 + W - 1), y: rng.range(y0 + 1, y0 + H - 1), r: rng.range(0.3, 0.8) });
    for (let i = 0; i < 2; i++) features.push({ t: 'puddle', poly: blob(rng, { x: rng.range(x0 + 2, x0 + W - 2), y: rng.range(y0 + 2, y0 + H - 2) }, rng.range(0.8, 1.6)), kind: rng.chance(0.5) ? 'water' : 'mud' });
  }

  const exit: Entrance = { id: 'exit', name: 'Outside', kind: 'exit', x: doorX, y: y0 + H + 1, targetId: null };
  const entrances: Entrance[] = [exit];
  // Some buildings have a cellar (or a crypt), down a hidden trapdoor or stairs.
  if ((type === 'inn' || type === 'hall' || type === 'ruin' || type === 'temple' || type === 'house') && rng.chance(type === 'house' ? 0.25 : 0.6)) {
    const store = rooms[rooms.length - 1];
    const s = { x: store.x + 1.3, y: store.y + 1.4 };
    features.push({ t: 'stairs', x: s.x, y: s.y, w: 1.6, h: 2, a: Math.PI / 2 });
    entrances.push({ id: 'cellar', name: type === 'temple' ? 'Crypt stairs' : 'Cellar trapdoor', kind: 'deeper', x: s.x, y: s.y, targetId: null, hidden: true });
  }
  return {
    name,
    kind: 'building',
    seed,
    size: { w: W + margin * 2, h: H + margin * 2 + 1 },
    ground: 'paper',
    features,
    walls,
    entrances,
    npcs: [],
    start: { x: doorX, y: y0 + H - 1.2 },
    context: ctx,
  };
}

// ---------------------------------------------------------------------------
// Outlines of open cells (caves and dungeons)
// ---------------------------------------------------------------------------

/** Outlines (closed loops of cell corners) around the open cells of a grid. */
function traceOutlines(W: number, H: number, open: (x: number, y: number) => boolean): Point[][] {
  const next = new Map<string, [number, number][]>();
  const add = (ax: number, ay: number, bx: number, by: number) => {
    const k = `${ax},${ay}`;
    if (!next.has(k)) next.set(k, []);
    next.get(k)!.push([bx, by]);
  };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (!open(x, y)) continue;
      if (!open(x, y - 1)) add(x, y, x + 1, y);
      if (!open(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!open(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!open(x - 1, y)) add(x, y + 1, x, y);
    }
  const loops: Point[][] = [];
  for (const [k, outs] of next) {
    while (outs.length) {
      const [sx, sy] = k.split(',').map(Number);
      const loop: Point[] = [{ x: sx, y: sy }];
      let [cx, cy] = outs.pop()!;
      let guard = 0;
      while ((cx !== sx || cy !== sy) && guard++ < 100000) {
        loop.push({ x: cx, y: cy });
        const o = next.get(`${cx},${cy}`);
        if (!o?.length) break;
        [cx, cy] = o.pop()!;
      }
      const corners = loop.filter((p, i) => {
        const a = loop[(i + loop.length - 1) % loop.length];
        const b = loop[(i + 1) % loop.length];
        return (b.x - p.x) * (p.y - a.y) !== (b.y - p.y) * (p.x - a.x);
      });
      if (corners.length >= 3) loops.push(corners);
    }
  }
  return loops;
}

/** Cuts corners (Chaikin-style). With `onlySteps`, only staircase corners are cut, so square rooms stay square. */
function cutCorners(l: Point[], amount: number, onlySteps?: number): Point[] {
  return l.flatMap((p, i) => {
    const a = l[(i + l.length - 1) % l.length];
    const b = l[(i + 1) % l.length];
    const la = Math.hypot(a.x - p.x, a.y - p.y) || 1;
    const lb = Math.hypot(b.x - p.x, b.y - p.y) || 1;
    if (onlySteps !== undefined && Math.min(la, lb) > onlySteps * 1.01) return [p];
    const cut = onlySteps !== undefined ? Math.min(la, lb) / 2 : amount;
    const ta = Math.min(cut, la / 2) / la;
    const tb = Math.min(cut, lb / 2) / lb;
    return [
      { x: p.x + (a.x - p.x) * ta, y: p.y + (a.y - p.y) * ta },
      { x: p.x + (b.x - p.x) * tb, y: p.y + (b.y - p.y) * tb },
    ];
  });
}

/** Drops points that barely change the shape (keeps saves small). */
function simplify(l: Point[], tolerance: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < l.length; i++) {
    const a = out.length ? out[out.length - 1] : l[l.length - 1];
    const p = l[i];
    const b = l[(i + 1) % l.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const off = Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len;
    if (off > tolerance && Math.hypot(p.x - a.x, p.y - a.y) > 1e-6) out.push(p);
  }
  return out.length >= 3 ? out : l;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const loopsToPath = (loops: Point[][]) => loops.map((l) => `M${l.map((p) => `${r2(p.x)},${r2(p.y)}`).join('L')}Z`).join('');

function pickEncounters(rng: Rng, table: [string, number][], level: number, groups: number, spots: Point[]): NonNullable<Place['encounters']> {
  const suitable = table.filter(([, cr]) => cr <= Math.max(0.25, level / 2) && cr >= level / 8);
  const out: NonNullable<Place['encounters']> = [];
  for (let g = 0; g < groups && spots.length; g++) {
    const [monster, cr] = rng.pick(suitable.length ? suitable : table.slice(0, 2));
    const spot = spots.splice(rng.int(0, spots.length - 1), 1)[0];
    out.push({ monster, count: Math.max(1, Math.min(6, Math.round(level / Math.max(cr, 0.25) / 3))), x: spot.x, y: spot.y });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Caves
// ---------------------------------------------------------------------------

const CAVE_MONSTERS: { mood: string; list: [string, number][] }[] = [
  { mood: 'default', list: [['goblin-warrior', 0.25], ['giant-rat', 0.125], ['wolf', 0.25], ['giant-spider', 1], ['swarm-of-bats', 0.25], ['bugbear-warrior', 1], ['ogre', 2], ['owlbear', 3], ['troll', 5]] },
  { mood: 'haunted', list: [['skeleton', 0.25], ['zombie', 0.25], ['ghoul', 1], ['specter', 1], ['wight', 3], ['ghost', 4]] },
  { mood: 'cult', list: [['cultist', 0.125], ['priest', 2], ['animated-armor', 1]] },
];

export function generateCave(seed: number, name: string, ctx: PlaceContext): GeneratedPlace {
  const rng = makeRng(seed);
  const f = readContext(ctx, rng);
  const W = ctx.size === 'small' ? 40 : ctx.size === 'large' ? 70 : 54;
  const H = Math.round(W * 0.68);
  let grid = Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => x === 0 || y === 0 || x === W - 1 || y === H - 1 || rng() < 0.46));
  // Cellular automaton: smooth the noise into caverns.
  for (let it = 0; it < 5; it++) {
    grid = grid.map((row, y) =>
      row.map((_, x) => {
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1) return true;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && grid[y + dy][x + dx]) n++;
        return n >= 5 || (n <= 1 && it < 2);
      }),
    );
  }
  // Keep only the biggest open area.
  const region = new Int32Array(W * H).fill(-1);
  let best = { id: -1, size: 0 };
  let id = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (grid[y][x] || region[y * W + x] >= 0) continue;
      let size = 0;
      const stack = [[x, y]];
      region[y * W + x] = id;
      while (stack.length) {
        const [cx, cy] = stack.pop()!;
        size++;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (!grid[ny]?.[nx] && region[ny * W + nx] < 0) {
            region[ny * W + nx] = id;
            stack.push([nx, ny]);
          }
        }
      }
      if (size > best.size) best = { id, size };
      id++;
    }
  const open = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && region[y * W + x] === best.id && !grid[y][x];

  // The entrance: carve a tunnel from the left edge to the nearest open cell.
  const my = Math.floor(H / 2);
  let ex = 1;
  while (ex < W - 1 && !open(ex, my)) ex++;
  for (let x = 0; x < ex; x++) {
    for (const yy of [my, my + 1]) {
      grid[yy][x] = false;
      region[yy * W + x] = best.id;
    }
  }

  // Trace the outline of the open area, then round off the cell corners so it
  // reads as natural rock. The same outline is drawn and used as the walls.
  const loops = traceOutlines(W, H, open).map((l) => simplify(cutCorners(cutCorners(cutCorners(l, 0.5), 0.25), 0.12), 0.05));
  const walls: Wall[] = [];
  for (const l of loops) {
    for (let i = 0; i < l.length; i++) {
      const a = l[i];
      const b = l[(i + 1) % l.length];
      // Leave the tunnel mouth at the map's left edge open.
      if (a.x < 0.01 && b.x < 0.01 && a.y >= my - 0.01 && b.y >= my - 0.01 && a.y <= my + 2.01 && b.y <= my + 2.01) continue;
      walls.push([r2(a.x), r2(a.y), r2(b.x), r2(b.y)]);
    }
  }
  const features: Feature[] = [{ t: 'cells', d: loopsToPath(loops), material: 'cave' }];
  // Roomy spots: open cells away from the walls.
  const cells: Point[] = [];
  for (let y = 2; y < H - 2; y++)
    for (let x = 2; x < W - 2; x++) {
      let ok = true;
      for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1 && ok; dx++) ok = open(x + dx, y + dy);
      if (ok) cells.push({ x: x + 0.5, y: y + 0.5 });
    }
  const entry = { x: 1, y: my + 1 };
  const far = cells.reduce((a, b) => (dist(b, entry) > dist(a, entry) ? b : a), cells[0] ?? entry);
  const pick = () => (cells.length ? cells[rng.int(0, cells.length - 1)] : entry);
  // Rocks and stalagmites (which block movement), rubble, and pools of water.
  for (let i = 0; i < Math.round(cells.length / 70); i++) {
    const c = pick();
    if (dist(c, entry) < 4) continue;
    const poly = blob(rng, c, rng.range(0.35, 0.7), 6);
    features.push({ t: 'rock', poly });
    walls.push(...edges(poly).map((e) => e.map(r2)));
  }
  for (let i = 0; i < Math.round(cells.length / 45); i++) {
    const c = pick();
    features.push({ t: 'debris', x: c.x + rng.range(-0.4, 0.4), y: c.y + rng.range(-0.4, 0.4), r: rng.range(0.25, 0.6) });
  }
  for (let i = 0; i < rng.int(1, 4); i++) {
    const c = pick();
    if (dist(c, entry) < 5) continue;
    features.push({ t: 'puddle', poly: blob(rng, c, rng.range(0.9, 2), 10), kind: 'water' });
  }

  // Encounters suited to the party's level and the mood.
  const table = CAVE_MONSTERS.find((m) => (f.dark && m.mood === 'haunted') || (f.holy && m.mood === 'cult'))?.list ?? CAVE_MONSTERS[0].list;
  const groups = ctx.size === 'small' ? 1 : ctx.size === 'large' ? 3 : 2;
  const encounters = pickEncounters(rng, table, ctx.level, groups, cells.filter((c) => dist(c, entry) > W / 3));

  return {
    name,
    kind: 'cave',
    seed,
    size: { w: W, h: H },
    ground: 'paper',
    features,
    walls,
    entrances: [
      { id: 'exit', name: 'Way out', kind: 'exit', x: 0.6, y: my + 1, targetId: null },
      { id: 'deeper', name: 'Tunnel deeper', kind: 'deeper', x: far.x, y: far.y, targetId: null },
    ],
    npcs: [],
    start: { x: 2, y: my + 1 },
    context: ctx,
    encounters,
  };
}

// ---------------------------------------------------------------------------
// Dungeons: cellars, crypts and deeper halls (rooms and corridors)
// ---------------------------------------------------------------------------

export type DungeonTheme = 'cellar' | 'crypt' | 'dungeon';

const DUNGEON_MONSTERS: Record<DungeonTheme, [string, number][]> = {
  cellar: [['rat', 0], ['giant-rat', 0.125], ['swarm-of-rats', 0.25], ['giant-spider', 1], ['ghoul', 1]],
  crypt: [['skeleton', 0.25], ['zombie', 0.25], ['ghoul', 1], ['shadow', 0.5], ['specter', 1], ['ghast', 2], ['mummy', 3], ['wight', 3]],
  dungeon: [['kobold-warrior', 0.125], ['goblin-warrior', 0.25], ['bandit', 0.125], ['hobgoblin-warrior', 0.5], ['gnoll-warrior', 0.5], ['bugbear-warrior', 1], ['gargoyle', 2], ['minotaur-of-baphomet', 3], ['cultist', 0.125]],
};

export function generateDungeon(seed: number, name: string, ctx: PlaceContext, theme: DungeonTheme = 'dungeon'): GeneratedPlace {
  const rng = makeRng(seed);
  type Box = { x: number; y: number; w: number; h: number; round?: boolean };
  const target = theme === 'cellar' ? rng.int(3, 5) : ctx.size === 'small' ? 5 : ctx.size === 'large' ? 12 : 8;
  const rooms: Box[] = [{ x: 0, y: 0, w: rng.int(6, 8), h: rng.int(6, 8) }];
  const corridors: (Box & { horizontal: boolean })[] = [];
  const overlaps = (a: Box, b: Box, m: number) => a.x < b.x + b.w + m && b.x < a.x + a.w + m && a.y < b.y + b.h + m && b.y < a.y + a.h + m;
  for (let tries = 0; tries < 500 && rooms.length < target; tries++) {
    const fromIndex = rng.int(0, rooms.length - 1);
    const from = rooms[fromIndex];
    const side = rng.int(0, 3);
    const len = rng.int(2, 6);
    const cw = 2;
    const round = rng.chance(0.3);
    const rw = round ? rng.pick([6, 7, 8]) : rng.int(4, 9);
    const rh = round ? rw : rng.int(4, 9);
    // Where the corridor leaves the room (centred on round rooms).
    const slideX = from.round ? 0 : rng.int(-Math.floor(from.w / 2 - 1.5), Math.floor(from.w / 2 - 1.5));
    const slideY = from.round ? 0 : rng.int(-Math.floor(from.h / 2 - 1.5), Math.floor(from.h / 2 - 1.5));
    const cx = from.x + from.w / 2 + slideX;
    const cy = from.y + from.h / 2 + slideY;
    const off = round ? 0 : rng.int(-Math.floor(rh / 2 - 1.5), Math.floor(rh / 2 - 1.5));
    const offX = round ? 0 : rng.int(-Math.floor(rw / 2 - 1.5), Math.floor(rw / 2 - 1.5));
    let corr: Box;
    let room: Box;
    if (side === 0) {
      corr = { x: from.x + from.w, y: cy - cw / 2, w: len, h: cw };
      room = { x: corr.x + len, y: cy - rh / 2 + off, w: rw, h: rh };
    } else if (side === 1) {
      corr = { x: from.x - len, y: cy - cw / 2, w: len, h: cw };
      room = { x: corr.x - rw, y: cy - rh / 2 + off, w: rw, h: rh };
    } else if (side === 2) {
      corr = { x: cx - cw / 2, y: from.y + from.h, w: cw, h: len };
      room = { x: cx - rw / 2 + offX, y: corr.y + len, w: rw, h: rh };
    } else {
      corr = { x: cx - cw / 2, y: from.y - len, w: cw, h: len };
      room = { x: cx - rw / 2 + offX, y: corr.y - rh, w: rw, h: rh };
    }
    room.round = round;
    // Corridors into round rooms must meet them in the middle of a side.
    if (from.round && (side < 2 ? Math.abs(cy - (from.y + from.h / 2)) > 0.01 : Math.abs(cx - (from.x + from.w / 2)) > 0.01)) continue;
    if (rooms.some((r) => overlaps(r, room, 1))) continue;
    if (rooms.some((r, i) => i !== fromIndex && overlaps(r, corr, 0.5))) continue;
    if (corridors.some((c) => overlaps(c, corr, 0.5) || overlaps(c, room, 0.5))) continue;
    rooms.push(room);
    corridors.push({ ...corr, horizontal: side < 2 });
  }
  // Round rooms reach their corridors by the extra bit of floor the corridor gets.
  for (const c of corridors) {
    if (c.horizontal) {
      c.x -= 0.6;
      c.w += 1.2;
    } else {
      c.y -= 0.6;
      c.h += 1.2;
    }
  }
  // Move everything so the map starts at (3, 3).
  const all: Box[] = [...rooms, ...corridors];
  const minX = Math.min(...all.map((b) => b.x)) - 3;
  const minY = Math.min(...all.map((b) => b.y)) - 3;
  for (const b of all) {
    b.x -= minX;
    b.y -= minY;
  }
  const W = Math.ceil(Math.max(...all.map((b) => b.x + b.w)) + 3);
  const H = Math.ceil(Math.max(...all.map((b) => b.y + b.h)) + 3);

  // Rasterise at half a unit, then trace the outline (round rooms come out round).
  const RES = 0.5;
  const GW = Math.ceil(W / RES);
  const GH = Math.ceil(H / RES);
  const cellsOpen = new Uint8Array(GW * GH);
  for (let gy = 0; gy < GH; gy++)
    for (let gx = 0; gx < GW; gx++) {
      const p = { x: (gx + 0.5) * RES, y: (gy + 0.5) * RES };
      const inside = all.some((b) => (b.round ? Math.hypot(p.x - (b.x + b.w / 2), p.y - (b.y + b.h / 2)) < b.w / 2 : p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h));
      if (inside) cellsOpen[gy * GW + gx] = 1;
    }
  const open = (x: number, y: number) => x >= 0 && y >= 0 && x < GW && y < GH && cellsOpen[y * GW + x] === 1;
  const loops = traceOutlines(GW, GH, open).map((l) => simplify(cutCorners(l.map((p) => ({ x: p.x * RES, y: p.y * RES })), 0, RES), 0.02));
  const walls: Wall[] = [];
  for (const l of loops) for (let i = 0; i < l.length; i++) walls.push([r2(l[i].x), r2(l[i].y), r2(l[(i + 1) % l.length].x), r2(l[(i + 1) % l.length].y)]);
  const features: Feature[] = [{ t: 'cells', d: loopsToPath(loops), material: theme === 'cellar' ? 'stone' : 'flag' }];

  // Doors where corridors meet square rooms.
  for (const c of corridors) {
    if (!rng.chance(0.55)) continue;
    const atStart = rng.chance(0.5);
    const d = c.horizontal ? { x: atStart ? c.x + 0.6 : c.x + c.w - 0.6, y: c.y + c.h / 2, a: Math.PI / 2 } : { x: c.x + c.w / 2, y: atStart ? c.y + 0.6 : c.y + c.h - 0.6, a: 0 };
    const p = { x: d.x, y: d.y };
    if (rooms.some((r) => r.round && Math.hypot(p.x - (r.x + r.w / 2), p.y - (r.y + r.h / 2)) < r.w / 2 + 1)) continue;
    features.push({ t: 'door', x: d.x, y: d.y, a: d.a, w: 2 });
  }

  // Decoration per room.
  const centres = rooms.map((r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 }));
  const spots: Point[] = [];
  rooms.forEach((r, i) => {
    const c = centres[i];
    if (i > 0) spots.push(c);
    if (r.round && r.w >= 7 && rng.chance(0.6)) {
      const n = r.w >= 8 ? 8 : 6;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + Math.PI / n;
        const p = { x: c.x + Math.cos(a) * (r.w / 2 - 1.6), y: c.y + Math.sin(a) * (r.w / 2 - 1.6) };
        features.push({ t: 'column', x: p.x, y: p.y, r: 0.35 });
        walls.push(...edges(rect(p.x, p.y, 0.7, 0.7, 0)).map((e) => e.map(r2)));
      }
    } else if (r.round && rng.chance(0.5)) {
      features.push({ t: 'column', x: c.x, y: c.y, r: 0.7, round: true }); // a statue or a well
      const ring = Array.from({ length: 10 }, (_, k) => ({ x: c.x + Math.cos((k / 10) * Math.PI * 2) * 0.7, y: c.y + Math.sin((k / 10) * Math.PI * 2) * 0.7 }));
      walls.push(...edges(ring).map((e) => e.map(r2)));
    } else if (!r.round && r.w >= 7 && r.h >= 7 && rng.chance(0.4)) {
      for (const dx of [-1, 1])
        for (const dy of [-1, 1]) {
          const p = { x: c.x + dx * (r.w / 2 - 2), y: c.y + dy * (r.h / 2 - 2) };
          features.push({ t: 'column', x: p.x, y: p.y, r: 0.4 });
          walls.push(...edges(rect(p.x, p.y, 0.8, 0.8, 0)).map((e) => e.map(r2)));
        }
    }
    if (!r.round) {
      const stuff: [string, number, number][] =
        theme === 'crypt'
          ? [['sarcophagus', 1.2, 2.4], ['sarcophagus', 1.2, 2.4], ['urn', 0.6, 0.6]]
          : theme === 'cellar'
            ? [['barrel', 0.9, 0.9], ['barrel', 0.9, 0.9], ['crate', 1, 1], ['rack', 0.6, 2], ['sack', 0.8, 0.7]]
            : [['crate', 1, 1], ['chest', 1, 0.6], ['table', 1.6, 1], ['bones', 1, 0.7]];
      for (const [kind, fw, fh] of stuff) {
        if (!rng.chance(0.6) || fh + 1 > r.h) continue;
        const left = rng.chance(0.5);
        const x = left ? r.x + fw / 2 + 0.3 : r.x + r.w - fw / 2 - 0.3;
        const y = rng.range(r.y + fh / 2 + 0.4, r.y + r.h - fh / 2 - 0.4);
        features.push({ t: 'furniture', kind, x, y, w: fw, h: fh, a: 0 });
      }
    }
    if (rng.chance(0.4)) {
      // A puddle (or mud, or blood) seeping from a wall.
      const edge = { x: r.x + (rng.chance(0.5) ? 1 : r.w - 1), y: rng.range(r.y + 1, r.y + r.h - 1) };
      features.push({ t: 'puddle', poly: blob(rng, edge, rng.range(0.8, 1.6), 10), kind: theme === 'crypt' && rng.chance(0.25) ? 'blood' : rng.chance(0.7) ? 'water' : 'mud' });
    }
    for (let k = 0; k < rng.int(0, 3); k++) features.push({ t: 'debris', x: rng.range(r.x + 0.8, r.x + r.w - 0.8), y: rng.range(r.y + 0.8, r.y + r.h - 0.8), r: rng.range(0.2, 0.45) });
    features.push({ t: 'label', x: c.x, y: c.y, text: String(i + 1) });
  });

  // Stairs up (the way out) in the first room; stairs down in the furthest one.
  const first = rooms[0];
  const up = { x: first.x + first.w / 2, y: first.y + 1.3 };
  features.push({ t: 'stairs', x: up.x, y: up.y, w: 2, h: 2, a: -Math.PI / 2 });
  const lastIndex = rooms.reduce((bi, _, i) => (dist(centres[i], centres[0]) > dist(centres[bi], centres[0]) ? i : bi), 0);
  const last = rooms[lastIndex];
  const down = { x: last.x + last.w / 2, y: last.round ? last.y + last.h / 2 + last.h / 4 : last.y + last.h - 1.3 };
  if (lastIndex > 0 && theme !== 'cellar') features.push({ t: 'stairs', x: down.x, y: down.y, w: 2, h: 2, a: Math.PI / 2 });

  const encounters = pickEncounters(rng, DUNGEON_MONSTERS[theme], ctx.level, Math.min(rooms.length - 1, theme === 'cellar' ? 1 : ctx.size === 'small' ? 2 : ctx.size === 'large' ? 4 : 3), spots);
  const entrances: Entrance[] = [{ id: 'exit', name: 'Stairs up', kind: 'exit', x: up.x, y: up.y, targetId: null }];
  if (lastIndex > 0 && theme !== 'cellar') entrances.push({ id: 'deeper', name: 'Stairs down', kind: 'deeper', x: down.x, y: down.y, targetId: null });
  return {
    name,
    kind: 'dungeon',
    seed,
    size: { w: W, h: H },
    ground: 'paper',
    features,
    walls,
    entrances,
    npcs: [],
    start: { x: up.x, y: up.y + 2 },
    context: ctx,
    encounters,
  };
}

// ---------------------------------------------------------------------------
// Everything else
// ---------------------------------------------------------------------------

/** An empty map to draw on with tokens (like the plain board before step 7). */
export function generateBlank(seed: number, name: string, ctx: PlaceContext): GeneratedPlace {
  const [w, h] = ctx.size === 'small' ? [40, 25] : ctx.size === 'large' ? [90, 60] : [60, 40];
  return { name, kind: 'blank', seed, size: { w, h }, ground: 'paper', features: [], walls: [], entrances: [], npcs: [], start: { x: w / 2, y: h / 2 }, context: ctx };
}

/** A new place of its own (not behind an entrance). */
export function generatePlace(kind: PlaceKind, seed: number, ctx: PlaceContext, name?: string, building: BuildingType = 'house'): GeneratedPlace {
  const rng = makeRng(seed ^ 0x5bd1e995);
  if (kind === 'village') return generateVillage(seed, ctx, name);
  if (kind === 'building') return generateBuilding(seed, building, name || (building === 'inn' ? innName(rng) : `The ${building}`), ctx);
  if (kind === 'cave') return generateCave(seed, name || rng.pick(['The Hollow Deep', 'Whispering Caves', 'The Old Mine', 'Darkwater Grotto', 'Goblin Warren', 'The Sunken Halls']), ctx);
  if (kind === 'dungeon') {
    const theme: DungeonTheme = /crypt|tomb|grave|undead|haunted/.test(`${ctx.description} ${ctx.mood}`.toLowerCase()) ? 'crypt' : 'dungeon';
    return generateDungeon(seed, name || rng.pick(theme === 'crypt' ? ['The Forgotten Crypt', 'Tomb of the Last King', 'The Bone Vaults'] : ['The Sunken Keep', 'Halls of the Iron Gate', 'The Lost Undercroft', 'The Black Cellars']), ctx, theme);
  }
  return generateBlank(seed, name || 'Open ground', ctx);
}

/** The right generator for an entrance (a building, a cave, a cellar...). */
export function generateFor(entrance: Entrance, parent: Pick<Place, 'kind' | 'context' | 'name' | 'features'>, seed: number, ctx?: Partial<PlaceContext>) {
  const context: PlaceContext = { ...parent.context, ...ctx };
  if (entrance.kind === 'building') return generateBuilding(seed, entrance.building ?? 'house', entrance.name, context);
  if (entrance.kind === 'deeper' && (parent.kind === 'building' || parent.kind === 'dungeon')) {
    const crypt = /crypt/i.test(entrance.name) || parent.features.some((f) => f.t === 'floor' && f.room === 'nave');
    const theme: DungeonTheme = parent.kind === 'dungeon' ? 'dungeon' : crypt ? 'crypt' : 'cellar';
    const name = parent.kind === 'dungeon' ? `${parent.name}: lower level` : `${parent.name}: ${theme}`;
    return generateDungeon(seed, name, { ...context, size: theme === 'cellar' ? 'small' : context.size }, theme);
  }
  const name = entrance.kind === 'deeper' ? `${parent.name}: lower level` : entrance.name;
  return generateCave(seed, name, context);
}

/** One more villager, for the DM's "add a person" button. */
export function randomNpc(seed: number, role: string, ctx: PlaceContext): Npc {
  const rng = makeRng(seed);
  return makeNpc(rng, role, readContext(ctx, rng));
}

export const NPC_ROLES = ['villager', 'guard', 'farmer', 'merchant', 'priest', 'hunter', 'traveller', 'child', 'old storyteller', 'thief', 'noble', 'healer', 'bard', 'miner', 'fisher'];
