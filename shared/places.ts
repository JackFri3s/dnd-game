// Places: the world is a set of maps (a village, a building's interior, a cave...)
// linked by entrances. Each is generated from a seed and can be edited by the DM.

import type { Point } from './geometry.ts';

export type PlaceKind = 'blank' | 'village' | 'building' | 'cave';
export type BuildingType = 'house' | 'inn' | 'smithy' | 'temple' | 'shop' | 'farm' | 'hall' | 'ruin';

/** Things drawn on the map (map units: 1 = 5 ft). */
export type Feature =
  | { t: 'road'; pts: Point[]; w: number }
  | { t: 'square'; poly: Point[] }
  | { t: 'field'; poly: Point[] }
  | { t: 'water'; pts: Point[]; w: number } // a river
  | { t: 'bridge'; a: Point; b: Point; w: number }
  | { t: 'building'; poly: Point[]; type: BuildingType; ruined?: boolean; label?: string }
  | { t: 'tree'; x: number; y: number; r: number }
  | { t: 'rock'; poly: Point[] }
  | { t: 'fence'; pts: Point[] }
  | { t: 'well'; x: number; y: number }
  | { t: 'floor'; poly: Point[]; room?: string } // building interiors
  | { t: 'cells'; d: string } // cave floor, as SVG path data
  | { t: 'furniture'; kind: string; x: number; y: number; w: number; h: number; a: number }
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
  return { ...rest, npcs: [], entrances: p.entrances.filter((e) => !e.hidden) };
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
