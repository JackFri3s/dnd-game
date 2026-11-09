// Turns a place into drawing instructions in a hand-drawn, painted map style.
// Everything of one kind is merged into one SVG path (a village has thousands of
// trees and roof planks), so maps stay fast to draw and to pan on phones.
// Decoration (hatching, contour lines, roof planks...) is worked out here from
// the place's seed, so every screen draws exactly the same map.

import type { Point } from '../../../shared/geometry.ts';
import type { Feature, FloorMaterial, Place } from '../../../shared/places.ts';
import { makeNoise, makeRng } from '../../../shared/random.ts';

export interface Layer {
  d: string;
  className: string;
  fill?: string;
  /** Stroke width in map units (roads, rivers). */
  width?: number;
}

export interface Drawing {
  /** Painted layers, bottom to top. */
  layers: Layer[];
  /** Low-resolution terrain shading (villages), as a data URL. */
  shading?: string;
  /** Things drawn one by one (furniture, labels...): few, but each different. */
  items: Item[];
}

export type Item =
  | { k: 'furniture'; f: Extract<Feature, { t: 'furniture' }> }
  | { k: 'rug'; f: Extract<Feature, { t: 'rug' }> }
  | { k: 'stall'; f: Extract<Feature, { t: 'stall' }> }
  | { k: 'label'; f: Extract<Feature, { t: 'label' }>; big: boolean }
  | { k: 'buildingLabel'; x: number; y: number; text: string };

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const n2 = (v: number) => Math.round(v * 100) / 100;
const P = (p: Point) => `${n2(p.x)},${n2(p.y)}`;
const polyD = (pts: Point[], close = true) => (pts.length ? `M${pts.map(P).join('L')}${close ? 'Z' : ''}` : '');
const lineD = (a: Point, b: Point) => `M${P(a)}L${P(b)}`;
const circleD = (x: number, y: number, r: number) => `M${n2(x - r)},${n2(y)}a${n2(r)},${n2(r)} 0 1 0 ${n2(2 * r)},0a${n2(r)},${n2(r)} 0 1 0 ${n2(-2 * r)},0Z`;
const add = (a: Point, b: Point, k = 1) => ({ x: a.x + b.x * k, y: a.y + b.y * k });
const sub = (a: Point, b: Point) => ({ x: a.x - b.x, y: a.y - b.y });
const len = (v: Point) => Math.hypot(v.x, v.y);
const norm = (v: Point) => {
  const l = len(v) || 1;
  return { x: v.x / l, y: v.y / l };
};
const centroid = (pts: Point[]) => pts.reduce((a, p) => ({ x: a.x + p.x / pts.length, y: a.y + p.y / pts.length }), { x: 0, y: 0 });
const rectPts = (cx: number, cy: number, w: number, h: number, a: number): Point[] => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ].map(([x, y]) => ({ x: cx + x * c - y * s, y: cy + x * s + y * c }));
};

/** A tree crown: a circle with a bumpy edge. */
function crown(cx: number, cy: number, r: number, bumps: number, rot: number) {
  const pts = Array.from({ length: bumps }, (_, i) => {
    const a = rot + (i / bumps) * Math.PI * 2;
    return { x: cx + Math.cos(a) * r * 0.84, y: cy + Math.sin(a) * r * 0.84 };
  });
  const chord = len(sub(pts[1], pts[0]));
  const br = n2(chord * 0.62);
  return `M${P(pts[0])}${pts.map((_, i) => `A${br},${br} 0 0 1 ${P(pts[(i + 1) % bumps])}`).join('')}Z`;
}

/** Parallel lines at `angle`, `spacing` apart, clipped to a convex polygon. */
function hatchConvex(poly: Point[], angle: number, spacing: number, inset = 0): [Point, Point][] {
  const u = { x: Math.cos(angle), y: Math.sin(angle) };
  const n = { x: -u.y, y: u.x };
  const proj = poly.map((p) => p.x * n.x + p.y * n.y);
  const lo = Math.min(...proj);
  const hi = Math.max(...proj);
  const out: [Point, Point][] = [];
  for (let k = lo + spacing / 2; k < hi; k += spacing) {
    let tMin = Infinity;
    let tMax = -Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const da = a.x * n.x + a.y * n.y - k;
      const db = b.x * n.x + b.y * n.y - k;
      if ((da < 0) === (db < 0)) continue;
      const t = da / (da - db);
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      const along = p.x * u.x + p.y * u.y;
      tMin = Math.min(tMin, along);
      tMax = Math.max(tMax, along);
    }
    if (tMax - tMin <= inset * 2) continue;
    const base = { x: n.x * k, y: n.y * k };
    out.push([add(base, u, tMin + inset), add(base, u, tMax - inset)]);
  }
  return out;
}

/** A polyline moved sideways (river highlights). */
function offsetLine(pts: Point[], d: number): Point[] {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const t = norm(sub(b, a));
    return { x: p.x - t.y * d, y: p.y + t.x * d };
  });
}

// ---------------------------------------------------------------------------
// Villages: painted, seen from above
// ---------------------------------------------------------------------------

const LIGHT = norm({ x: -1, y: -1.3 }); // light comes from the top left

function villageDrawing(place: Place): Drawing {
  const rng = makeRng(place.seed ^ 0x2f6b);
  const noise = makeNoise(place.seed + 7);
  const { w, h } = place.size;
  const by = <T extends Feature['t']>(t: T) => place.features.filter((f): f is Extract<Feature, { t: T }> => f.t === t);
  const layers: Layer[] = [];
  const items: Item[] = [];

  layers.push({ d: polyD([{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]), className: 'v-grass' });

  // Contour lines, from the same kind of noise as the shading.
  const step = 2;
  const gw = Math.ceil(w / step) + 1;
  const gh = Math.ceil(h / step) + 1;
  const height = (x: number, y: number) => noise(x, y, 45);
  const vals: number[] = [];
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) vals.push(height(i * step, j * step));
  let contours = '';
  for (let level = 0.3; level < 0.75; level += 0.045) {
    for (let j = 0; j < gh - 1; j++)
      for (let i = 0; i < gw - 1; i++) {
        const v = [vals[j * gw + i], vals[j * gw + i + 1], vals[(j + 1) * gw + i + 1], vals[(j + 1) * gw + i]];
        const corners = [
          { x: i * step, y: j * step },
          { x: (i + 1) * step, y: j * step },
          { x: (i + 1) * step, y: (j + 1) * step },
          { x: i * step, y: (j + 1) * step },
        ];
        const cross: Point[] = [];
        for (let e = 0; e < 4; e++) {
          const a = v[e];
          const b = v[(e + 1) % 4];
          if ((a < level) !== (b < level)) {
            const t = (level - a) / (b - a);
            cross.push({ x: corners[e].x + (corners[(e + 1) % 4].x - corners[e].x) * t, y: corners[e].y + (corners[(e + 1) % 4].y - corners[e].y) * t });
          }
        }
        if (cross.length >= 2) contours += lineD(cross[0], cross[1]);
        if (cross.length === 4) contours += lineD(cross[2], cross[3]);
      }
  }
  layers.push({ d: contours, className: 'v-contour' });

  // Fields: soil, young crops or ripe grain, with furrows.
  const fieldFill: Record<string, string> = { soil: '', green: '', gold: '' };
  let furrows = '';
  for (const f of by('field')) {
    const crop = f.crop ?? 'soil';
    fieldFill[crop] += polyD(f.poly);
    for (const [a, b] of hatchConvex(f.poly, f.a ?? 0, crop === 'gold' ? 0.38 : 0.5, 0.25)) furrows += lineD(a, b);
  }
  for (const crop of ['soil', 'green', 'gold']) if (fieldFill[crop]) layers.push({ d: fieldFill[crop], className: `v-field v-field-${crop}` });
  layers.push({ d: furrows, className: 'v-furrows' });

  // Rivers: a sandy shore, the banks, the water, and light on the water.
  for (const f of by('water')) {
    const d = polyD(f.pts, false);
    layers.push({ d, className: 'v-shore', width: f.w + 3.5 }, { d, className: 'v-bank', width: f.w + 0.6 }, { d, className: 'v-water', width: f.w });
    layers.push({ d: polyD(offsetLine(f.pts, f.w * 0.22), false) + polyD(offsetLine(f.pts, -f.w * 0.28), false), className: 'v-water-light' });
  }

  // Roads: edges first, then the surfaces, so crossings join up.
  const roads = by('road');
  layers.push(...roads.map((r) => ({ d: polyD(r.pts, false), className: 'v-road-edge', width: r.w + 0.5 })));
  layers.push(...roads.map((r) => ({ d: polyD(r.pts, false), className: 'v-road', width: r.w })));
  for (const s of by('square')) layers.push({ d: polyD(s.poly), className: 'v-square' });

  // Bridges: a deck of planks with railings.
  for (const b of by('bridge')) {
    const dir = norm(sub(b.b, b.a));
    const side = { x: -dir.y, y: dir.x };
    const deck = [add(b.a, side, b.w / 2), add(b.b, side, b.w / 2), add(b.b, side, -b.w / 2), add(b.a, side, -b.w / 2)];
    layers.push({ d: polyD(deck), className: 'v-bridge' });
    let planks = '';
    const L = len(sub(b.b, b.a));
    for (let t = 0.3; t < L; t += 0.45) planks += lineD(add(add(b.a, dir, t), side, b.w / 2), add(add(b.a, dir, t), side, -b.w / 2));
    layers.push({ d: planks, className: 'v-bridge-planks' });
    layers.push({ d: lineD(deck[0], deck[1]) + lineD(deck[3], deck[2]), className: 'v-bridge-rail' });
  }

  // Shadows of buildings and trees, cast to the bottom right.
  const shadowOff = { x: -LIGHT.x * 0.55, y: -LIGHT.y * 0.55 };
  let shadows = '';
  for (const b of by('building')) if (!b.ruined) shadows += polyD(b.poly.map((p) => add(p, shadowOff)));
  for (const t of by('tree')) shadows += circleD(t.x + shadowOff.x * 1.2, t.y + shadowOff.y * 1.2, t.r * 0.95);
  for (const r of by('rock')) shadows += polyD(r.poly.map((p) => add(p, shadowOff, 0.6)));
  layers.push({ d: shadows, className: 'v-shadow' });

  // Rocks.
  for (const r of by('rock')) layers.push({ d: polyD(r.poly), className: 'v-rock' });
  let rockLight = '';
  for (const r of by('rock')) {
    const c = centroid(r.poly);
    rockLight += polyD(r.poly.map((p) => add(add(c, sub(p, c), 0.55), LIGHT, 0.25)));
  }
  layers.push({ d: rockLight, className: 'v-rock-light' });

  // Trees: one outline under all crowns (woods merge into one mass), crowns, light.
  const trees = by('tree');
  let outline = '';
  const crowns = ['', ''];
  let light = '';
  for (const t of trees) {
    const bumps = Math.max(6, Math.round(5 + t.r * 3));
    const rot = rng() * Math.PI;
    const d = crown(t.x, t.y, t.r, bumps, rot);
    outline += d;
    crowns[rng() < 0.35 ? 1 : 0] += d;
    light += crown(t.x + LIGHT.x * t.r * 0.25, t.y + LIGHT.y * t.r * 0.25, t.r * 0.55, Math.max(5, bumps - 2), rot + 0.4);
  }
  layers.push({ d: outline, className: 'v-tree-outline' }, { d: crowns[0], className: 'v-tree' }, { d: crowns[1], className: 'v-tree v-tree-2' }, { d: light, className: 'v-tree-light' });

  // Buildings: hipped roofs, lit on one side, with planks and ridges.
  const roofs: Record<string, string> = {};
  let roofLines = '';
  let ridges = '';
  let outlines = '';
  let ruins = '';
  for (const b of by('building')) {
    if (b.ruined) {
      ruins += polyD(b.poly);
      continue;
    }
    outlines += polyD(b.poly);
    const roof = b.roof ?? 'wood';
    if (b.poly.length !== 4) {
      roofs[`${roof}-1`] = (roofs[`${roof}-1`] ?? '') + polyD(b.poly);
      continue;
    }
    const [p0, p1, p2, p3] = len(sub(b.poly[1], b.poly[0])) >= len(sub(b.poly[2], b.poly[1])) ? b.poly : [b.poly[1], b.poly[2], b.poly[3], b.poly[0]];
    const c = centroid(b.poly);
    const L = len(sub(p1, p0));
    const W = len(sub(p2, p1));
    const u = norm(sub(p1, p0));
    const rl = Math.max(0, (L - W) / 2);
    const r1 = add(c, u, -rl);
    const r2 = add(c, u, rl);
    const facets: Point[][] = [
      [p0, p1, r2, r1],
      [p2, p3, r1, r2],
      [p1, p2, r2],
      [p3, p0, r1],
    ];
    for (const facet of facets) {
      const eaveMid = { x: (facet[0].x + facet[1].x) / 2, y: (facet[0].y + facet[1].y) / 2 };
      const facing = norm(sub(eaveMid, c));
      const lit = facing.x * LIGHT.x + facing.y * LIGHT.y;
      const shade = lit > 0.35 ? 0 : lit < -0.35 ? 2 : 1;
      roofs[`${roof}-${shade}`] = (roofs[`${roof}-${shade}`] ?? '') + polyD(facet);
      // Planks (or thatch strokes) running down the slope.
      const inward = norm(sub(c, eaveMid));
      const eave = sub(facet[1], facet[0]);
      const el = len(eave);
      for (let t = 0.3; t < el - 0.15; t += roof === 'slate' ? 0.55 : 0.36) {
        const e = add(facet[0], eave, t / el);
        const tip = add(e, inward, W / 2);
        const seg = clipToConvex(e, tip, facet);
        if (seg) roofLines += lineD(seg[0], seg[1]);
      }
    }
    ridges += lineD(r1, r2) + lineD(p0, r1) + lineD(p3, r1) + lineD(p1, r2) + lineD(p2, r2);
    if (b.label) items.push({ k: 'buildingLabel', x: c.x, y: c.y, text: b.label });
  }
  for (const roof of ['wood', 'slate', 'thatch'])
    for (const shade of [0, 1, 2]) if (roofs[`${roof}-${shade}`]) layers.push({ d: roofs[`${roof}-${shade}`], className: `v-roof v-roof-${roof} shade-${shade}` });
  layers.push({ d: roofLines, className: 'v-roof-lines' }, { d: ridges, className: 'v-ridge' }, { d: outlines, className: 'v-building-outline' }, { d: ruins, className: 'v-ruin' });

  // Doors, wells, fences.
  let doors = '';
  for (const d of by('door')) doors += polyD(rectPts(d.x, d.y, d.w, 0.35, d.a));
  layers.push({ d: doors, className: 'v-door' });
  let wells = '';
  let wellWater = '';
  for (const wl of by('well')) {
    wells += circleD(wl.x, wl.y, 0.75);
    wellWater += circleD(wl.x, wl.y, 0.42);
  }
  layers.push({ d: wells, className: 'v-well' }, { d: wellWater, className: 'v-well-water' });
  for (const s of by('stall')) items.push({ k: 'stall', f: s });
  let fences = '';
  for (const f of by('fence')) fences += polyD(f.pts, false);
  layers.push({ d: fences, className: 'v-fence' });
  for (const l of by('label')) items.push({ k: 'label', f: l, big: true });

  return { layers, items, shading: shadingImage(place) };
}

/** The part of segment a→b inside a convex polygon. */
function clipToConvex(a: Point, b: Point, poly: Point[]): [Point, Point] | null {
  let t0 = 0;
  let t1 = 1;
  const d = sub(b, a);
  const c = centroid(poly);
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    let nx = -(q.y - p.y);
    let ny = q.x - p.x;
    // Make the normal point inwards.
    if ((c.x - p.x) * nx + (c.y - p.y) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    const num = (a.x - p.x) * nx + (a.y - p.y) * ny;
    const den = d.x * nx + d.y * ny;
    if (Math.abs(den) < 1e-9) {
      if (num < 0) return null;
      continue;
    }
    const t = -num / den;
    if (den > 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  return t1 - t0 > 0.02 ? [add(a, d, t0), add(a, d, t1)] : null;
}

/** Soft light and shade over the land, drawn tiny and stretched (the browser smooths it). */
function shadingImage(place: Place): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const { w, h } = place.size;
  const cw = Math.ceil(w / 2);
  const ch = Math.ceil(h / 2);
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  const noise = makeNoise(place.seed + 7);
  const img = ctx.createImageData(cw, ch);
  const square = place.features.find((f) => f.t === 'square');
  const mid = square && square.t === 'square' ? centroid(square.poly) : { x: w / 2, y: h / 2 };
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      const px = x * 2;
      const py = y * 2;
      const v = noise(px, py, 45);
      const near = Math.max(0, 1 - Math.hypot(px - mid.x, py - mid.y) / (Math.min(w, h) * 0.45));
      const shade = Math.max(0, (0.55 - v) * 1.6) * (1 - near);
      const i = (y * cw + x) * 4;
      if (near > 0.25 && v > 0.4) {
        // Sunlit ground around the middle of the village.
        img.data.set([255, 252, 220, Math.round(near * 70)], i);
      } else {
        img.data.set([20, 50, 30, Math.round(Math.min(1, shade) * 150)], i);
      }
    }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL();
}

// ---------------------------------------------------------------------------
// Interiors, caves and dungeons: ink on paper, with coloured floors
// ---------------------------------------------------------------------------

export const FLOOR_PATTERN: Record<FloorMaterial, string> = {
  wood: 'url(#mat-wood)',
  stone: 'url(#mat-stone)',
  flag: 'url(#mat-flag)',
  earth: 'url(#mat-earth)',
  tile: 'url(#mat-tile)',
  cave: 'url(#mat-cave)',
};

function insideDrawing(place: Place): Drawing {
  const rng = makeRng(place.seed ^ 0x51ed);
  const by = <T extends Feature['t']>(t: T) => place.features.filter((f): f is Extract<Feature, { t: T }> => f.t === t);
  const layers: Layer[] = [];
  const items: Item[] = [];
  const walls = place.walls;
  const wallD = walls.map(([x1, y1, x2, y2]) => `M${n2(x1)},${n2(y1)}L${n2(x2)},${n2(y2)}`).join('');

  // A soft grey band around the walls, then cross-hatching in the rock.
  layers.push({ d: wallD, className: 'i-halo' });
  layers.push({ d: hatching(place, rng), className: 'i-hatch' });

  // Floors.
  for (const f of by('floor')) layers.push({ d: polyD(f.poly), className: 'i-floor', fill: FLOOR_PATTERN[f.material ?? 'wood'] });
  for (const f of by('cells')) layers.push({ d: f.d, className: 'i-floor i-cells', fill: FLOOR_PATTERN[f.material ?? (place.kind === 'cave' ? 'cave' : 'flag')] });
  // Old caves (before materials) had no floor pattern: draw them as cave.

  for (const r of by('rug')) items.push({ k: 'rug', f: r });
  const puddles: Record<string, string> = { water: '', mud: '', blood: '' };
  for (const p of by('puddle')) puddles[p.kind ?? 'water'] += smoothBlob(p.poly);
  for (const k of ['water', 'mud', 'blood']) if (puddles[k]) layers.push({ d: puddles[k], className: `i-puddle i-puddle-${k}` });
  let debris = '';
  for (const d of by('debris')) {
    for (let i = 0; i < 4; i++) {
      const c = { x: d.x + (rng() - 0.5) * d.r * 1.6, y: d.y + (rng() - 0.5) * d.r * 1.6 };
      const s = d.r * (0.25 + rng() * 0.3);
      const a = rng() * Math.PI;
      debris += polyD([0, 1, 2, 3, 4].map((k) => ({ x: c.x + Math.cos(a + k * 1.26) * s * (0.7 + rng() * 0.5), y: c.y + Math.sin(a + k * 1.26) * s * (0.7 + rng() * 0.5) })));
    }
  }
  layers.push({ d: debris, className: 'i-debris' });

  // Stairs: steps across, darker as they go down.
  for (const s of by('stairs')) {
    const box = rectPts(s.x, s.y, s.w, s.h, 0);
    layers.push({ d: polyD(box), className: 'i-stairs' });
    const dir = { x: Math.cos(s.a), y: Math.sin(s.a) };
    const across = { x: -dir.y, y: dir.x };
    const depth = Math.abs(dir.x) > 0.5 ? s.w : s.h;
    const width = Math.abs(dir.x) > 0.5 ? s.h : s.w;
    let steps = '';
    let dark = '';
    const start = add({ x: s.x, y: s.y }, dir, -depth / 2);
    const n = 6;
    for (let i = 1; i < n; i++) {
      const p = add(start, dir, (depth * i) / n);
      steps += lineD(add(p, across, width / 2), add(p, across, -width / 2));
    }
    for (let i = Math.floor(n / 2); i < n; i++) {
      const p = add(start, dir, (depth * i) / n);
      const q = add(start, dir, (depth * (i + 1)) / n);
      dark += polyD([add(p, across, width / 2), add(p, across, -width / 2), add(q, across, -width / 2), add(q, across, width / 2)]);
    }
    layers.push({ d: dark, className: 'i-stairs-dark' }, { d: steps, className: 'i-stairs-steps' });
  }

  // Rocks in caves (and their outline).
  let rocks = '';
  for (const r of by('rock')) rocks += polyD(r.poly);
  layers.push({ d: rocks, className: 'i-rock' });

  for (const f of by('furniture')) items.push({ k: 'furniture', f });

  // Columns, with a shadow.
  let columnShadow = '';
  let columns = '';
  for (const c of by('column')) {
    if (c.round) {
      columnShadow += circleD(c.x + 0.15, c.y + 0.2, c.r);
      columns += circleD(c.x, c.y, c.r);
    } else {
      columnShadow += polyD(rectPts(c.x + 0.15, c.y + 0.2, c.r * 2, c.r * 2, 0));
      columns += polyD(rectPts(c.x, c.y, c.r * 2, c.r * 2, 0));
    }
  }
  layers.push({ d: columnShadow, className: 'i-column-shadow' }, { d: columns, className: 'i-column' });

  // The walls themselves, in thick ink.
  layers.push({ d: wallD, className: 'i-wall' });

  // Doors and windows sit in the walls.
  let doors = '';
  for (const d of by('door')) doors += polyD(rectPts(d.x, d.y, d.w, 0.32, d.a));
  layers.push({ d: doors, className: 'i-door' });
  let windows = '';
  for (const wi of by('window')) windows += polyD(rectPts(wi.x, wi.y, wi.w, 0.2, wi.a));
  layers.push({ d: windows, className: 'i-window' });

  for (const l of by('label')) items.push({ k: 'label', f: l, big: false });
  return { layers, items };
}

/** A closed blob with rounded edges (puddles). */
function smoothBlob(pts: Point[]) {
  const mids = pts.map((p, i) => ({ x: (p.x + pts[(i + 1) % pts.length].x) / 2, y: (p.y + pts[(i + 1) % pts.length].y) / 2 }));
  return `M${P(mids[mids.length - 1])}${pts.map((p, i) => `Q${P(p)} ${P(mids[i])}`).join('')}Z`;
}

/** Short ink strokes in little bundles, everywhere near a wall (floors are drawn over them). */
function hatching(place: Place, rng: () => number) {
  const walls = place.walls;
  if (!walls.length) return '';
  const B = 2;
  const grid = new Map<string, number[][]>();
  for (const wl of walls) {
    const [x1, y1, x2, y2] = wl;
    for (let gy = Math.floor(Math.min(y1, y2) / B) - 1; gy <= Math.floor(Math.max(y1, y2) / B) + 1; gy++)
      for (let gx = Math.floor(Math.min(x1, x2) / B) - 1; gx <= Math.floor(Math.max(x1, x2) / B) + 1; gx++) {
        const k = `${gx},${gy}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k)!.push(wl);
      }
  }
  const nearest = (p: Point) => {
    let best = Infinity;
    for (const [x1, y1, x2, y2] of grid.get(`${Math.floor(p.x / B)},${Math.floor(p.y / B)}`) ?? []) {
      const vx = x2 - x1;
      const vy = y2 - y1;
      const t = Math.max(0, Math.min(1, ((p.x - x1) * vx + (p.y - y1) * vy) / (vx * vx + vy * vy || 1)));
      best = Math.min(best, Math.hypot(p.x - (x1 + t * vx), p.y - (y1 + t * vy)));
    }
    return best;
  };
  const { w, h } = place.size;
  let d = '';
  const S = 0.62;
  for (let y = S / 2; y < h; y += S)
    for (let x = S / 2; x < w; x += S) {
      const p = { x: x + (rng() - 0.5) * S * 0.8, y: y + (rng() - 0.5) * S * 0.8 };
      const dist = nearest(p);
      if (dist > 1.05 + rng() * 0.45 || dist < 0.12) continue;
      const a = rng() * Math.PI;
      const u = { x: Math.cos(a), y: Math.sin(a) };
      const v = { x: -u.y, y: u.x };
      const l = 0.26 + rng() * 0.12;
      for (let k = -1; k <= 1; k++) {
        const c = add(p, v, k * 0.11);
        d += lineD(add(c, u, -l), add(c, u, l));
      }
    }
  return d;
}

// ---------------------------------------------------------------------------

const cache = new WeakMap<Place, Drawing>();

/** How a place looks (worked out once per version of the place). */
export function drawPlace(place: Place): Drawing {
  let drawing = cache.get(place);
  if (!drawing) {
    drawing = place.kind === 'village' ? villageDrawing(place) : place.kind === 'blank' ? { layers: [], items: [] } : insideDrawing(place);
    cache.set(place, drawing);
  }
  return drawing;
}
