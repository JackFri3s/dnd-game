// Procedural generators: villages, building interiors and caves.
// Everything comes from a seed (same seed + same context = same place), in map
// units (1 = 5 ft), in a hand-drawn, gridless style.

import type { Point } from './geometry.ts';
import { LOOK, PERSONALITY, SECRET, innName, makeRng, personName, placeName, type Rng } from './random.ts';
import type { BuildingType, Entrance, Feature, Npc, Place, PlaceContext, PlaceKind } from './places.ts';

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
    river: has('river', 'fishing', 'fisher', 'lake', 'mill', 'bridge', 'water', 'boat') || rng.chance(0.3),
    walled: has('wall', 'fort', 'war', 'palisade', 'border', 'besieged', 'guard'),
    ruined: has('haunted', 'abandoned', 'ruin', 'cursed', 'plague', 'burned', 'deserted', 'war-torn'),
    market: has('market', 'trade', 'merchant', 'rich', 'festival', 'fair', 'festive'),
    farming: has('farm', 'harvest', 'field', 'crop', 'sheep', 'cattle') || rng.chance(0.4),
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

function distToPolyline(p: Point, pts: Point[]) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / (vx * vx + vy * vy || 1)));
    best = Math.min(best, Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy)));
  }
  return best;
}

/** A wobbly path from a to b (roads, rivers). */
function wobblyPath(rng: Rng, a: Point, b: Point, wobble: number, step = 6): Point[] {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
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

/** Points along a polyline every `spacing` units, with the local direction. */
function samplePath(pts: Point[], spacing: number) {
  const out: { p: Point; dir: number }[] = [];
  let carry = spacing / 2;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const dir = Math.atan2(b.y - a.y, b.x - a.x);
    for (let d = carry; d < len; d += spacing) {
      out.push({ p: { x: a.x + Math.cos(dir) * d, y: a.y + Math.sin(dir) * d }, dir });
      carry = d + spacing - len;
    }
    if (carry < 0) carry = spacing;
  }
  return out;
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

const SIZE = { small: { w: 70, h: 48, buildings: 10 }, medium: { w: 90, h: 60, buildings: 18 }, large: { w: 120, h: 80, buildings: 32 } };

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

const ROLE: Partial<Record<BuildingType, string>> = {
  inn: 'innkeeper',
  smithy: 'blacksmith',
  temple: 'priest',
  shop: 'merchant',
  hall: 'village elder',
  farm: 'farmer',
};

// ---------------------------------------------------------------------------
// Village
// ---------------------------------------------------------------------------

export function generateVillage(seed: number, ctx: PlaceContext, name?: string): GeneratedPlace {
  const rng = makeRng(seed);
  const f = readContext(ctx, rng);
  const { w, h, buildings: target } = SIZE[ctx.size];
  const features: Feature[] = [];
  const walls: Wall[] = [];
  const entrances: Entrance[] = [];
  const npcs: Npc[] = [];
  const villageName = name || placeName(rng);

  // Roads: a main road across, and a branch for bigger places.
  const main = wobblyPath(rng, { x: 0, y: h * rng.range(0.38, 0.62) }, { x: w, y: h * rng.range(0.38, 0.62) }, 4);
  const roads = [main];
  const mid = main[Math.floor(main.length / 2)];
  if (ctx.size !== 'small' || rng.chance(0.5)) {
    const down = rng.chance(0.5);
    roads.push(wobblyPath(rng, mid, { x: mid.x + rng.range(-w * 0.2, w * 0.2), y: down ? h : 0 }, 3));
  }
  if (ctx.size === 'large') roads.push(wobblyPath(rng, main[Math.floor(main.length / 4)], { x: rng.range(0, w * 0.4), y: rng.chance(0.5) ? 0 : h }, 3));
  for (const r of roads) features.push({ t: 'road', pts: r, w: 2.4 });

  // The square with a well, where the roads meet.
  const sq: Point[] = Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * Math.PI * 2;
    const rad = rng.range(4.5, 6);
    return { x: mid.x + Math.cos(a) * rad, y: mid.y + Math.sin(a) * rad * 0.8 };
  });
  features.push({ t: 'square', poly: sq });
  features.push({ t: 'well', x: mid.x, y: mid.y });

  // A river crossing the main road, with a bridge.
  let river: Point[] | null = null;
  if (f.river) {
    const rx = w * rng.range(0.2, 0.8);
    river = wobblyPath(rng, { x: rx + rng.range(-8, 8), y: 0 }, { x: rx + rng.range(-8, 8), y: h }, 5, 5);
    features.push({ t: 'water', pts: river, w: 3.5 });
    // where the main road crosses
    let best = { d: Infinity, p: main[0], i: 0 };
    main.forEach((p, i) => {
      const d = distToPolyline(p, river!);
      if (d < best.d) best = { d, p, i };
    });
    const dir = Math.atan2(main[Math.min(main.length - 1, best.i + 1)].y - main[Math.max(0, best.i - 1)].y, main[Math.min(main.length - 1, best.i + 1)].x - main[Math.max(0, best.i - 1)].x);
    features.push({ t: 'bridge', a: { x: best.p.x - Math.cos(dir) * 3.5, y: best.p.y - Math.sin(dir) * 3.5 }, b: { x: best.p.x + Math.cos(dir) * 3.5, y: best.p.y + Math.sin(dir) * 3.5 }, w: 2.8 });
  }

  // Buildings along the roads; the important ones nearest the square.
  const types: BuildingType[] = ['inn', 'smithy', ...(f.holy || rng.chance(0.6) ? (['temple'] as const) : []), ...(f.market ? (['shop', 'shop', 'shop'] as const) : (['shop'] as const)), ...(ctx.size !== 'small' ? (['hall'] as const) : [])];
  const placed: { c: Point; r: number; poly: Point[] }[] = [];
  const spots = roads
    .flatMap((r) => samplePath(r, 5.5).flatMap((s) => [1, -1].map((side) => ({ ...s, side }))))
    .sort((a, b) => Math.hypot(a.p.x - mid.x, a.p.y - mid.y) - Math.hypot(b.p.x - mid.x, b.p.y - mid.y));
  let count = 0;
  for (const s of spots) {
    if (count >= target) break;
    const type: BuildingType = types[count] ?? (f.ruined && rng.chance(0.35) ? 'ruin' : f.farming && rng.chance(0.25) ? 'farm' : 'house');
    const [bw, bd] = BUILDING_SIZE[type].map((v) => v * rng.range(0.9, 1.15));
    const off = 1.2 + bd / 2 + rng.range(0.4, 1.4);
    const nx = -Math.sin(s.dir) * s.side;
    const ny = Math.cos(s.dir) * s.side;
    const c = { x: s.p.x + nx * off, y: s.p.y + ny * off };
    const r = Math.hypot(bw, bd) / 2;
    if (c.x < r + 1 || c.y < r + 1 || c.x > w - r - 1 || c.y > h - r - 1) continue;
    if (placed.some((b) => Math.hypot(b.c.x - c.x, b.c.y - c.y) < b.r + r - 0.6)) continue;
    if (roads.some((rd) => distToPolyline(c, rd) < bd / 2 + 1.2)) continue;
    if (river && distToPolyline(c, river) < r + 2.2) continue;
    if (Math.hypot(c.x - mid.x, c.y - mid.y) < 6 + r) continue;
    const poly = rect(c.x, c.y, bw, bd, s.dir);
    placed.push({ c, r, poly });
    const ruined = type === 'ruin' || (f.ruined && rng.chance(0.25));
    const label = type === 'inn' ? innName(rng) : type === 'temple' ? `Shrine of ${rng.pick(['the Dawn', 'the Harvest', 'Saint ' + personName(rng).split(' ')[0], 'the Quiet Moon', 'the Old Oak'])}` : undefined;
    features.push({ t: 'building', poly, type, ...(ruined ? { ruined } : {}), ...(label ? { label } : {}) });
    walls.push(...edges(poly));
    // The door faces the road.
    const door = { x: c.x - nx * (bd / 2 + 0.55), y: c.y - ny * (bd / 2 + 0.55) };
    const id = `e${count}`;
    const owner = ROLE[type] ? makeNpc(rng, ROLE[type]!, f, id) : null;
    const entranceName =
      label ??
      (type === 'smithy'
        ? `${owner?.name.split(' ')[0]}'s Smithy`
        : type === 'shop'
          ? `${owner?.name.split(' ')[0]}'s ${rng.pick(['General Store', 'Bakery', 'Apothecary', 'Tailor', 'Trading Post'])}`
          : type === 'hall'
            ? 'Village Hall'
            : type === 'farm'
              ? `${owner?.name.split(' ')[1]} Farm`
              : type === 'ruin'
                ? 'Burned-out house'
                : `${personName(rng).split(' ')[1]} house`);
    entrances.push({ id, name: entranceName, kind: 'building', building: type, x: door.x, y: door.y, targetId: null });
    if (owner) npcs.push(owner);
    count++;
  }

  // Fields on the outskirts, and trees.
  if (f.farming) {
    for (let i = 0; i < rng.int(3, 7); i++) {
      const c = { x: rng.range(6, w - 6), y: rng.chance(0.5) ? rng.range(4, h * 0.25) : rng.range(h * 0.75, h - 4) };
      const fw = rng.range(8, 16);
      const fh = rng.range(5, 9);
      if (placed.some((b) => Math.hypot(b.c.x - c.x, b.c.y - c.y) < b.r + fw / 2)) continue;
      if (roads.some((rd) => distToPolyline(c, rd) < fh / 2 + 1.5)) continue;
      if (river && distToPolyline(c, river) < fw / 2 + 2) continue;
      const poly = rect(c.x, c.y, fw, fh, rng.range(-0.3, 0.3));
      features.push({ t: 'field', poly });
      if (rng.chance(0.5)) features.push({ t: 'fence', pts: [...poly, poly[0]] });
    }
  }
  const treeCount = Math.round((w * h) / (f.ruined ? 18 : 26));
  for (let i = 0; i < treeCount; i++) {
    const p = { x: rng.range(1, w - 1), y: rng.range(1, h - 1) };
    // trees cluster towards the edges
    const edge = Math.min(p.x, p.y, w - p.x, h - p.y) / Math.min(w, h);
    if (rng() < edge * 2.2) continue;
    if (placed.some((b) => Math.hypot(b.c.x - p.x, b.c.y - p.y) < b.r + 1.2)) continue;
    if (roads.some((rd) => distToPolyline(p, rd) < 2.4)) continue;
    if (river && distToPolyline(p, river) < 2.6) continue;
    if (features.some((ft) => ft.t === 'field' && pointInPoly(p, ft.poly))) continue;
    features.push({ t: 'tree', x: p.x, y: p.y, r: rng.range(0.7, 1.5) });
  }

  // A palisade for walled places.
  if (f.walled) {
    const ring = Array.from({ length: 40 }, (_, i) => {
      const a = (i / 40) * Math.PI * 2;
      return { x: w / 2 + Math.cos(a) * w * 0.44, y: h / 2 + Math.sin(a) * h * 0.44 };
    });
    features.push({ t: 'fence', pts: [...ring, ring[0]] });
  }

  // A cave or an old mine nearby.
  if (f.mining || rng.chance(0.5)) {
    const corner = { x: rng.chance(0.5) ? rng.range(5, 10) : rng.range(w - 10, w - 5), y: rng.chance(0.5) ? rng.range(4, 9) : rng.range(h - 9, h - 4) };
    const rock: Point[] = Array.from({ length: 9 }, (_, i) => {
      const a = (i / 9) * Math.PI * 2;
      const rad = rng.range(3, 4.5);
      return { x: corner.x + Math.cos(a) * rad, y: corner.y + Math.sin(a) * rad };
    });
    features.push({ t: 'rock', poly: rock });
    walls.push(...edges(rock));
    const towardsCentre = Math.atan2(h / 2 - corner.y, w / 2 - corner.x);
    entrances.push({
      id: 'cave',
      name: f.mining ? 'Old mine' : 'Cave mouth',
      kind: 'cave',
      x: corner.x + Math.cos(towardsCentre) * 4.8,
      y: corner.y + Math.sin(towardsCentre) * 4.8,
      targetId: null,
    });
  }

  // Villagers without a building of their own.
  const extra = f.dark ? rng.int(1, 2) : rng.int(2, 4);
  const roles = ['guard', 'farmhand', 'hunter', 'child who knows everything', 'old storyteller', 'traveller passing through', ...(river ? ['fisher', 'ferry keeper'] : []), ...(f.mining ? ['miner'] : [])];
  for (let i = 0; i < extra; i++) npcs.push(makeNpc(rng, rng.pick(roles), f));

  features.push({ t: 'label', x: w / 2, y: 2.5, text: villageName });
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
    start: { x: 2.5, y: main[0].y },
    context: ctx,
  };
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

// ---------------------------------------------------------------------------
// Building interiors
// ---------------------------------------------------------------------------

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

const FURNITURE: Record<string, [string, number, number][]> = {
  'common room': [['table', 2, 1.4], ['table', 2, 1.4], ['table', 2, 1.4], ['bar', 4, 1], ['hearth', 2, 1]],
  kitchen: [['oven', 1.5, 1.2], ['table', 2, 1], ['barrel', 0.8, 0.8], ['barrel', 0.8, 0.8]],
  bedroom: [['bed', 1.2, 2], ['chest', 1, 0.6]],
  storeroom: [['crate', 1, 1], ['crate', 1, 1], ['barrel', 0.8, 0.8], ['barrel', 0.8, 0.8], ['shelf', 2, 0.6]],
  'main room': [['table', 1.6, 1.2], ['hearth', 1.6, 0.8], ['chair', 0.6, 0.6]],
  barn: [['hay', 2, 1.4], ['hay', 2, 1.4], ['stall', 2, 2]],
  forge: [['forge', 2, 1.6], ['anvil', 1, 0.6], ['barrel', 0.8, 0.8]],
  workshop: [['workbench', 2.4, 1], ['rack', 2, 0.6]],
  'living room': [['table', 1.6, 1.2], ['bed', 1.2, 2]],
  nave: [['altar', 2.4, 1.2], ['pew', 3, 0.8], ['pew', 3, 0.8], ['pew', 3, 0.8], ['pew', 3, 0.8]],
  vestry: [['chest', 1, 0.6], ['shelf', 2, 0.6]],
  'shop floor': [['counter', 3, 1], ['shelf', 2.4, 0.6], ['shelf', 2.4, 0.6]],
  'great hall': [['long table', 5, 1.4], ['throne', 1.2, 1.2], ['hearth', 2, 1]],
  office: [['desk', 1.8, 1], ['shelf', 2, 0.6]],
  'ruined room': [['rubble', 2, 1.6], ['rubble', 1.5, 1.2]],
  'collapsed room': [['rubble', 2.4, 2], ['rubble', 1.5, 1.2]],
};

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

  // Split the floor into rooms (the first, biggest room has the front door).
  type Box = { x: number; y: number; w: number; h: number };
  const rooms: Box[] = [{ x: x0, y: y0, w: W, h: H }];
  const wanted = ROOMS[type].length;
  while (rooms.length < wanted) {
    rooms.sort((a, b) => b.w * b.h - a.w * a.h);
    const r = rooms.shift()!;
    const vertical = r.w > r.h;
    const cut = rng.range(0.35, 0.65);
    if (vertical) {
      const a = Math.round(r.w * cut);
      if (a < 3 || r.w - a < 3) {
        rooms.push(r);
        break;
      }
      rooms.push({ ...r, w: a }, { ...r, x: r.x + a, w: r.w - a });
    } else {
      const a = Math.round(r.h * cut);
      if (a < 3 || r.h - a < 3) {
        rooms.push(r);
        break;
      }
      rooms.push({ ...r, h: a }, { ...r, y: r.y + a, h: r.h - a });
    }
  }
  // The room touching the bottom (front) wall and biggest is the main room.
  rooms.sort((a, b) => Number(b.y + b.h >= y0 + H - 0.01) - Number(a.y + a.h >= y0 + H - 0.01) || b.w * b.h - a.w * a.h);
  const names = ROOMS[type];

  // Outer walls with the front door in the main room's bottom wall.
  const main = rooms[0];
  const doorX = main.x + main.w / 2;
  walls.push([x0, y0, x0 + W, y0], [x0 + W, y0, x0 + W, y0 + H], [x0, y0, x0, y0 + H]);
  walls.push([x0, y0 + H, doorX - 0.6, y0 + H], [doorX + 0.6, y0 + H, x0 + W, y0 + H]);

  // Inner walls between rooms, each with a doorway.
  const inner = new Set<string>();
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
    }
  }

  rooms.forEach((r, i) => {
    const room = names[i] ?? 'room';
    features.push({ t: 'floor', poly: [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }], room });
    // Furniture inside, away from the walls and from each other.
    const placedF: { x: number; y: number; r: number }[] = [];
    for (const [kind, fw, fh] of FURNITURE[room] ?? []) {
      for (let tries = 0; tries < 20; tries++) {
        const x = rng.range(r.x + fw / 2 + 0.6, r.x + r.w - fw / 2 - 0.6);
        const y = rng.range(r.y + fh / 2 + 0.6, r.y + r.h - fh / 2 - 0.6);
        const rad = Math.hypot(fw, fh) / 2;
        if (placedF.some((p) => Math.hypot(p.x - x, p.y - y) < p.r + rad + 0.4)) continue;
        if (Math.hypot(x - doorX, y - (y0 + H)) < 2.5) continue;
        placedF.push({ x, y, r: rad });
        features.push({ t: 'furniture', kind, x, y, w: fw, h: fh, a: 0 });
        break;
      }
    }
    features.push({ t: 'label', x: r.x + r.w / 2, y: r.y + 0.9, text: room });
  });

  const exit: Entrance = { id: 'exit', name: 'Outside', kind: 'exit', x: doorX, y: y0 + H + 1, targetId: null };
  const entrances: Entrance[] = [exit];
  // Some buildings have a cellar.
  if ((type === 'inn' || type === 'hall' || type === 'ruin' || type === 'temple') && rng.chance(0.5)) {
    const store = rooms[rooms.length - 1];
    entrances.push({ id: 'cellar', name: type === 'temple' ? 'Crypt stairs' : 'Cellar trapdoor', kind: 'deeper', x: store.x + store.w / 2, y: store.y + store.h / 2, targetId: null, hidden: true });
  }
  return {
    name,
    kind: 'building',
    seed,
    size: { w: W + margin * 2, h: H + margin * 2 + 1 },
    ground: 'floor',
    features,
    walls,
    entrances,
    npcs: [],
    start: { x: doorX, y: y0 + H - 1.2 },
    context: ctx,
  };
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
    grid[my][x] = false;
    region[my * W + x] = best.id;
    if (my + 1 < H) {
      grid[my + 1][x] = false;
      region[(my + 1) * W + x] = best.id;
    }
  }

  // Trace the outline of the open area, then round off the cell corners so it
  // reads as natural rock. The same outline is drawn and used as the walls.
  const loops = smoothLoops(traceOutlines(W, H, open));
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const d = loops.map((l) => `M${l.map((p) => `${r2(p.x)},${r2(p.y)}`).join('L')}Z`).join('');
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
  const wallsFiltered = walls;

  const features: Feature[] = [{ t: 'cells', d }];
  // Openness for placing things: cells far from walls.
  const cells: Point[] = [];
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) if (open(x, y) && open(x + 1, y) && open(x - 1, y) && open(x, y + 1) && open(x, y - 1)) cells.push({ x: x + 0.5, y: y + 0.5 });
  const entry = { x: 1, y: my + 1 };
  const far = cells.reduce((a, b) => (Math.hypot(b.x - entry.x, b.y - entry.y) > Math.hypot(a.x - entry.x, a.y - entry.y) ? b : a), entry);
  for (let i = 0; i < Math.round(cells.length / 60); i++) {
    const c = rng.pick(cells);
    features.push({ t: 'rock', poly: Array.from({ length: 6 }, (_, k) => ({ x: c.x + Math.cos((k / 6) * Math.PI * 2) * rng.range(0.3, 0.7), y: c.y + Math.sin((k / 6) * Math.PI * 2) * rng.range(0.3, 0.7) })) });
  }

  // Encounters suited to the party's level and the mood.
  const table = CAVE_MONSTERS.find((m) => (f.dark && m.mood === 'haunted') || (f.holy && m.mood === 'cult'))?.list ?? CAVE_MONSTERS[0].list;
  const suitable = table.filter(([, cr]) => cr <= Math.max(0.25, ctx.level / 2) && cr >= ctx.level / 8);
  const encounters: NonNullable<Place['encounters']> = [];
  const groups = ctx.size === 'small' ? 1 : ctx.size === 'large' ? 3 : 2;
  for (let g = 0; g < groups; g++) {
    const [monster, cr] = rng.pick(suitable.length ? suitable : table.slice(0, 2));
    const spot = rng.pick(cells.filter((c) => Math.hypot(c.x - entry.x, c.y - entry.y) > W / 3));
    if (!spot) continue;
    encounters.push({ monster, count: Math.max(1, Math.min(6, Math.round(ctx.level / Math.max(cr, 0.25) / 3))), x: spot.x, y: spot.y });
  }

  return {
    name,
    kind: 'cave',
    seed,
    size: { w: W, h: H },
    ground: 'rock',
    features,
    walls: wallsFiltered,
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

/** Outlines (closed loops of cell corners) around the open cells of a grid. */
function traceOutlines(W: number, H: number, open: (x: number, y: number) => boolean): Point[][] {
  // Boundary edges, directed so the open cell is always on the same side.
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
      // Keep only the corners.
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

/** Cuts every corner twice (Chaikin-style), turning cell staircases into slopes and curves. */
function smoothLoops(loops: Point[][]): Point[][] {
  const cut = (l: Point[], amount: number) =>
    l.flatMap((p, i) => {
      const a = l[(i + l.length - 1) % l.length];
      const b = l[(i + 1) % l.length];
      const la = Math.hypot(a.x - p.x, a.y - p.y) || 1;
      const lb = Math.hypot(b.x - p.x, b.y - p.y) || 1;
      const ta = Math.min(amount, la / 2) / la;
      const tb = Math.min(amount, lb / 2) / lb;
      return [
        { x: p.x + (a.x - p.x) * ta, y: p.y + (a.y - p.y) * ta },
        { x: p.x + (b.x - p.x) * tb, y: p.y + (b.y - p.y) * tb },
      ];
    });
  return loops.map((l) => simplify(cut(cut(l, 0.5), 0.2), 0.04));
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
    if (off > tolerance) out.push(p);
  }
  return out.length >= 3 ? out : l;
}

/** The right generator for an entrance (a building, a cave, a cellar...). */
export function generateFor(entrance: Entrance, parent: Pick<Place, 'kind' | 'context' | 'name'>, seed: number, ctx?: Partial<PlaceContext>) {
  const context: PlaceContext = { ...parent.context, ...ctx };
  if (entrance.kind === 'building') return generateBuilding(seed, entrance.building ?? 'house', entrance.name, context);
  const name = entrance.kind === 'deeper' ? `${parent.name}: ${entrance.name.toLowerCase().includes('cellar') ? 'cellar' : entrance.name.toLowerCase().includes('crypt') ? 'crypt' : 'lower level'}` : entrance.name;
  return generateCave(seed, name, { ...context, size: parent.kind === 'building' ? 'small' : context.size });
}

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
  return generateBlank(seed, name || 'Open ground', ctx);
}

/** One more villager, for the DM's "add a person" button. */
export function randomNpc(seed: number, role: string, ctx: PlaceContext): Npc {
  const rng = makeRng(seed);
  return makeNpc(rng, role, readContext(ctx, rng));
}

export const NPC_ROLES = ['villager', 'guard', 'farmer', 'merchant', 'priest', 'hunter', 'traveller', 'child', 'old storyteller', 'thief', 'noble', 'healer', 'bard', 'miner', 'fisher'];
