// Places: the world is a set of maps (a village, a building's interior, a cave...)
// linked by entrances. Each is generated from a seed and can be edited by the DM.

import type { Point } from './geometry.ts';

export type PlaceKind = 'blank' | 'village' | 'building' | 'cave' | 'dungeon';
export type BuildingType = 'house' | 'inn' | 'smithy' | 'temple' | 'shop' | 'farm' | 'hall' | 'ruin';
/** What a floor is made of (interiors, caves and dungeons). */
export type FloorMaterial = 'wood' | 'stone' | 'flag' | 'earth' | 'tile' | 'cave';
export type Roof = 'wood' | 'slate' | 'thatch';

/** Things drawn on the map (map units: 1 = 5 ft). Angles `a` are in radians. */
export type Feature =
  | { t: 'road'; pts: Point[]; w: number }
  | { t: 'square'; poly: Point[] }
  | { t: 'field'; poly: Point[]; a?: number; crop?: 'soil' | 'green' | 'gold' } // a: furrow direction
  | { t: 'water'; pts: Point[]; w: number } // a river
  | { t: 'bridge'; a: Point; b: Point; w: number }
  | { t: 'building'; poly: Point[]; type: BuildingType; ruined?: boolean; label?: string; roof?: Roof }
  | { t: 'tree'; x: number; y: number; r: number }
  | { t: 'rock'; poly: Point[] }
  | { t: 'fence'; pts: Point[] }
  | { t: 'well'; x: number; y: number }
  | { t: 'stall'; x: number; y: number; w: number; h: number; a: number; color: string } // market stall
  | { t: 'floor'; poly: Point[]; room?: string; material?: FloorMaterial } // building interiors
  | { t: 'cells'; d: string; material?: FloorMaterial } // cave and dungeon floor, as SVG path data
  | { t: 'furniture'; kind: string; x: number; y: number; w: number; h: number; a: number }
  | { t: 'door'; x: number; y: number; a: number; w: number } // across a doorway, a = direction of the wall
  | { t: 'window'; x: number; y: number; a: number; w: number }
  | { t: 'column'; x: number; y: number; r: number; round?: boolean }
  | { t: 'puddle'; poly: Point[]; kind?: 'water' | 'mud' | 'blood' }
  | { t: 'rug'; x: number; y: number; w: number; h: number; a: number; color: string }
  | { t: 'stairs'; x: number; y: number; w: number; h: number; a: number } // steps go down towards angle a
  | { t: 'debris'; x: number; y: number; r: number }
  | { t: 'label'; x: number; y: number; text: string };

export interface Entrance {
  id: string;
  name: string;
  kind: 'building' | 'cave' | 'deeper' | 'exit';
  building?: BuildingType;
  x: number;
  y: number;
  /** Where its place is, once generated. */
  targetId: string | null;
  /** Only the DM sees it (e.g. a trapdoor nobody has found yet). */
  hidden?: boolean;
}

export interface Npc {
  id: string;
  name: string;
  role: string;
  personality: string;
  look: string;
  secret: string;
  entranceId?: string; // the building they're usually found in
}

export interface PlaceContext {
  description: string;
  mood: string; // peaceful, haunted, war-torn, festive, abandoned...
  size: 'small' | 'medium' | 'large';
  level: number; // party level, for encounters
}

export interface Place {
  id: string;
  name: string;
  kind: PlaceKind;
  seed: number;
  parentId: string | null;
  parentEntranceId: string | null; // the entrance in the parent that leads here
  size: { w: number; h: number };
  ground: 'grass' | 'floor' | 'rock' | 'paper';
  features: Feature[];
  /** Lines that block movement (and later, sight): [x1, y1, x2, y2]. */
  walls: number[][];
  entrances: Entrance[];
  npcs: Npc[];
  start: Point; // where the party arrives
  context: PlaceContext;
  /** Suggested monsters (SRD indexes) for the DM to place. */
  encounters?: { monster: string; count: number; x: number; y: number }[];
}

export interface PlaceSummary {
  id: string;
  name: string;
  kind: PlaceKind;
  parentId: string | null;
}

export const PLACE_KINDS: { kind: PlaceKind; label: string }[] = [
  { kind: 'village', label: 'Village' },
  { kind: 'building', label: 'Building' },
  { kind: 'cave', label: 'Cave' },
  { kind: 'dungeon', label: 'Dungeon' },
  { kind: 'blank', label: 'Empty map' },
];

export const BUILDING_TYPES: { type: BuildingType; label: string }[] = [
  { type: 'house', label: 'House' },
  { type: 'inn', label: 'Inn' },
  { type: 'smithy', label: 'Smithy' },
  { type: 'temple', label: 'Temple' },
  { type: 'shop', label: 'Shop' },
  { type: 'farm', label: 'Farm' },
  { type: 'hall', label: 'Hall' },
  { type: 'ruin', label: 'Ruin' },
];

export const MOODS = ['peaceful', 'festive', 'busy', 'haunted', 'abandoned', 'war-torn', 'mysterious', 'dangerous'];

export const summarize = (p: Place): PlaceSummary => ({ id: p.id, name: p.name, kind: p.kind, parentId: p.parentId });

/** What players and the Main Screen may see of a place: no secrets, no hidden doors, no planned monsters. */
export function publicPlace(p: Place): Place {
  const { encounters: _, ...rest } = p;
  // Room names are the DM's notes; only a village's name is written on the map itself.
  const features = p.kind === 'village' ? p.features : p.features.filter((f) => f.t !== 'label');
  return { ...rest, features, npcs: [], entrances: p.entrances.filter((e) => !e.hidden) };
}

/** Whether moving from a to b crosses a wall. */
export function crossesWall(place: Pick<Place, 'walls'> | undefined, a: Point, b: Point): boolean {
  if (!place) return false;
  for (const [x1, y1, x2, y2] of place.walls) {
    if (segmentsIntersect(a.x, a.y, b.x, b.y, x1, y1, x2, y2)) return true;
  }
  return false;
}

function segmentsIntersect(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number) {
  const d = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
  if (Math.abs(d) < 1e-9) return false;
  const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / d;
  const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / d;
  return t > 0.001 && t < 0.999 && u >= 0 && u <= 1;
}
