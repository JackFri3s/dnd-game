// Messages and data shared between the game server and every screen.

import type { Ability, AreaShape, Character } from './rules.ts';
import type { Homebrew, HomebrewKind } from './homebrew.ts';
export type { Character };

export type Role = 'table' | 'player' | 'dm';

/**
 * Seats around the Main Screen, clockwise, starting top-left.
 * Two seats per side. The side tells the Main Screen which way to rotate
 * text so it faces that player.
 */
export const SEATS = [
  { id: 'top-left', side: 'top' },
  { id: 'top-right', side: 'top' },
  { id: 'right-top', side: 'right' },
  { id: 'right-bottom', side: 'right' },
  { id: 'bottom-right', side: 'bottom' },
  { id: 'bottom-left', side: 'bottom' },
  { id: 'left-bottom', side: 'left' },
  { id: 'left-top', side: 'left' },
] as const;

export type SeatId = (typeof SEATS)[number]['id'];
export type Side = (typeof SEATS)[number]['side'];

export interface Member {
  id: string; // stable id kept in the device's browser, so it can reconnect
  role: Role;
  name: string;
  seat: SeatId | null; // players only
  color: string; // players only
  connected: boolean;
}

export type Phase = 'lobby' | 'playing';

/** How the Main Screen is drawn at real-world size. Set by the DM during calibration. */
export interface TableSettings {
  pxPerMm: number; // screen pixels (CSS) per millimetre on the Main Screen
  hexMm: number; // how long 5 feet is on the table, in mm (1 inch = 25.4; the name is from the old hex grid)
  calibrated: boolean;
  calibrating: boolean; // the Main Screen is showing the calibration card right now
  viewport: { w: number; h: number } | null; // Main Screen size in CSS pixels
}

export type TokenKind = 'player' | 'npc' | 'monster';

export interface Token {
  id: string;
  x: number; // map units (1 unit = 5 ft)
  y: number;
  name: string;
  label: string; // 1-2 letters shown on the token
  color: string;
  kind: TokenKind;
  ownerId: string | null; // the player who controls it (null = DM only)
  speedFt: number;
  characterId?: string; // the character this token stands for
  /** Monsters and NPCs: their own numbers (player tokens use their character). */
  stats?: TokenStats;
  conditions?: string[]; // condition indexes, e.g. "prone", "poisoned"
}

export interface TokenStats {
  hp: { current: number; max: number; temp: number };
  ac: number;
  saves: Record<Ability, number>; // total saving throw bonus per ability
  initiative: number; // initiative bonus
  resistances: string[];
  immunities: string[];
  vulnerabilities: string[];
  monster?: string; // SRD monster index
}

/** A running fight: initiative order, whose turn it is, and what they've used. */
export interface Combat {
  round: number; // 0 while initiative is being rolled
  turn: number; // index into order
  order: { tokenId: string; init: number | null }[];
  moved: Record<string, number>; // feet moved this turn
  used: Record<string, { action?: boolean; bonus?: boolean; reaction?: boolean; dash?: boolean }>;
}

/** What an attack or saving throw did, shown with its roll on every screen. */
export interface RollOutcome {
  target: string;
  result: 'hit' | 'crit' | 'miss' | 'saved' | 'failed';
  damage: number;
  note?: string; // e.g. "resisted", "down!"
}

/** A movement or range area shown around a token on every screen. */
export interface Highlight {
  tokenId: string;
  kind: 'move' | 'range' | 'spell';
  feet: number;
  longFeet?: number; // ranged weapons: long range (attacks at disadvantage)
  label?: string; // e.g. "Longbow" or "Fire Bolt"
}

/** A spell or effect area placed on the map (e.g. a Fireball), seen on every screen. */
export interface Area {
  id: string;
  tokenId: string | null; // who cast it
  placedBy: string; // member id
  label: string;
  shape: AreaShape;
  sizeFt: number;
  widthFt?: number;
  rangeFt: number | null;
  origin: { x: number; y: number };
  target: { x: number; y: number };
  at: number;
}

/** The part of a game that belongs to the campaign and is saved with it. */
export interface World {
  board: { w: number; h: number }; // map units (1 unit = 5 ft)
  tokens: Record<string, Token>;
  view: { x: number; y: number };
  highlight: Highlight | null;
  nextTokenId: number;
  characters: Record<string, Character>;
  areas: Area[];
  homebrew: Homebrew;
  combat: Combat | null;
}

/** A dice roll made through the app; shown on the Main Screen at the roller's seat. */
export interface DiceRoll {
  id: string;
  byId: string;
  byName: string;
  label: string; // e.g. "Strength (4d6, drop lowest)"
  groups: { sides: number; rolls: number[]; kept: number[]; total: number }[];
  modifier: number; // added once to the whole roll (e.g. +5 for a skill check)
  total: number; // all kept dice + modifier
  at: number;
  outcomes?: RollOutcome[]; // attacks and saves: what happened to each target
}
export interface DiceRequest {
  label: string;
  groups: { count: number; sides: number; dropLowest?: number }[];
  modifier?: number;
}

export interface CampaignSummary {
  key: string; // secret: whoever has it can open the campaign
  name: string;
  createdAt: number;
  updatedAt: number;
}

/** A save point the DM can go back to. */
export interface SnapshotInfo {
  id: string;
  name: string;
  at: number;
  auto: boolean; // made automatically (e.g. at the start of a session)
}

export interface RoomState {
  code: string;
  members: Member[];
  phase: Phase;
  /** The campaign loaded in this game (needed before the DM can start). */
  campaign: { name: string } | null;
  table: TableSettings;
  /** Centre of what the Main Screen shows, in map units (see shared/geometry.ts). */
  view: { x: number; y: number };
  board: { w: number; h: number };
  tokens: Token[];
  highlight: Highlight | null;
  characters: Character[];
  rolls: DiceRoll[]; // the latest rolls, newest first
  areas: Area[];
  homebrew: Homebrew;
  combat: Combat | null;
}

/** Standard CSS pixels per mm (96 per inch): used until the Main Screen is calibrated. */
export const DEFAULT_PX_PER_MM = 96 / 25.4;
export const DEFAULT_HEX_MM = 25.4;
export const CARD_MM = { w: 85.6, h: 53.98 }; // bank/credit card (ISO/IEC 7810 ID-1)

/** Muted colours so players can tell their tokens apart on an otherwise greyscale screen. */
export const PLAYER_COLORS = [
  '#a8574f', '#4f6fa8', '#5a8a63', '#a8894f',
  '#7d5fa0', '#4f9494', '#a05f82', '#6b6b6b',
];

export const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O: easy to read off a screen
export const CODE_LENGTH = 4;
export const MAX_NAME_LENGTH = 24;

// ---------------------------------------------------------------------------
// HTTP
//   POST /api/rooms            { clientId }  -> { code }        (Main Screen creates a game)
//   GET  /api/rooms/:code                    -> RoomState       (look at a game before joining)
// WebSocket
//   /ws/:code?clientId=...     one connection per device per game
// ---------------------------------------------------------------------------

/** Requests a device can send over the WebSocket, and what each one answers. */
export interface Requests {
  join: { args: { role: 'player' | 'dm'; name: string; seat: SeatId | null }; result: { member: Member } };
  rejoin: { args: Record<string, never>; result: { member: Member } };
  leave: { args: Record<string, never>; result: null };
  'seat:change': { args: { seat: SeatId }; result: null };
  'dm:kick': { args: { memberId: string }; result: null };
  // DM: start the campaign, or go back to the lobby (e.g. to show the join code again)
  'game:phase': { args: { phase: Phase }; result: null };
  // DM (or the Main Screen itself): calibration
  'table:calibrate': {
    args: { pxPerMm?: number; hexMm?: number; calibrating?: boolean; done?: boolean };
    result: null;
  };
  // Main Screen reports its size so the DM can see what it shows
  'table:viewport': { args: { w: number; h: number }; result: null };
  // DM: move what the Main Screen shows
  'view:set': { args: { x: number; y: number }; result: null };
  'token:move': { args: { tokenId: string; x: number; y: number }; result: null };
  // DM: add or remove NPC/monster tokens
  'token:add': { args: { name: string; color: string; kind: TokenKind; x?: number; y?: number; stats?: TokenStats; speedFt?: number }; result: { tokenId: string } };
  // DM (any token) or the token's player: hit points and conditions
  'token:hp': { args: { tokenId: string; change: number; temp?: number }; result: null }; // negative = damage
  'token:conditions': { args: { tokenId: string; conditions: string[] }; result: null };

  // ---- combat ----
  'combat:start': { args: { tokenIds: string[] }; result: null }; // DM
  'combat:initiative': { args: { tokenId: string; value?: number }; result: { init: number } }; // value omitted = roll
  'combat:begin': { args: Record<string, never>; result: null }; // DM: rolls anyone missing, round 1
  'combat:next': { args: Record<string, never>; result: null }; // DM or whoever's turn it is
  'combat:end': { args: Record<string, never>; result: null }; // DM
  'combat:use': { args: { tokenId: string; what: 'action' | 'bonus' | 'reaction' | 'dash'; value: boolean }; result: null };
  /** An attack roll against a target's AC; on a hit the damage is rolled and applied. */
  'combat:attack': {
    args: {
      attackerId: string;
      targetId: string;
      label: string;
      toHit: number;
      damage: { count: number; sides: number }[];
      damageBonus: number;
      damageType: string;
      extra?: { count: number; sides: number; type: string }[]; // more damage on a hit (e.g. "plus 2d4 Fire")
    };
    result: { roll: DiceRoll };
  };
  /** A saving throw for one or more targets; damage on a failure (half on a success if `half`). */
  'combat:save': {
    args: {
      attackerId: string | null;
      targetIds: string[];
      label: string;
      ability: Ability;
      dc: number;
      damage: { count: number; sides: number }[];
      damageBonus: number;
      damageType: string;
      half: boolean;
    };
    result: { roll: DiceRoll };
  };
  'token:remove': { args: { tokenId: string }; result: null };
  'highlight:set': { args: { highlight: Highlight | null }; result: null };
  // DM: hand a player token to another player (e.g. they use a different phone this time)
  'token:assign': { args: { tokenId: string; memberId: string | null }; result: null };

  // ---- characters ----
  // Players save their own character; the DM can save any (e.g. pre-made ones).
  'character:save': { args: { character: Character }; result: { id: string } };
  'character:delete': { args: { characterId: string }; result: null };
  'character:assign': { args: { characterId: string; memberId: string | null }; result: null }; // DM
  // ---- custom content (anyone can add; the DM or the maker can change or delete) ----
  'homebrew:save': { args: { kind: HomebrewKind; entry: Record<string, unknown> }; result: { entryId: string } };
  'homebrew:delete': { args: { kind: HomebrewKind; entryId: string }; result: null };
  // ---- spell and effect areas on the map ----
  'area:add': { args: { area: Omit<Area, 'id' | 'placedBy' | 'at'> }; result: { id: string } };
  'area:remove': { args: { areaId: string }; result: null };
  // ---- dice (rolled by the server, so everyone can trust them) ----
  'dice:roll': { args: DiceRequest; result: { roll: DiceRoll } };

  // ---- campaigns (DM only) ----
  'campaign:list': { args: Record<string, never>; result: { campaigns: CampaignSummary[]; current: string | null } };
  'campaign:create': { args: { name: string }; result: { campaign: CampaignSummary } };
  'campaign:load': { args: { key: string }; result: null };
  'campaign:add': { args: { key: string }; result: { campaign: CampaignSummary } }; // open on another DM device
  'campaign:forget': { args: { key: string }; result: null }; // remove from this device's list
  'campaign:rename': { args: { name: string }; result: null };
  'campaign:snapshots': { args: Record<string, never>; result: { snapshots: SnapshotInfo[] } };
  'campaign:snapshot': { args: { name: string }; result: { snapshot: SnapshotInfo } };
  'campaign:restore': { args: { snapshotId: string }; result: null };
  'campaign:delete-snapshot': { args: { snapshotId: string }; result: null };
  'campaign:export': { args: Record<string, never>; result: { data: unknown; name: string } };
  'campaign:import': { args: { data: unknown }; result: { campaign: CampaignSummary } };
}
export type RequestName = keyof Requests;

// Note: request arguments must not use the field names "id" or "type": those belong to the message.
export type ClientMessage = {
  [K in RequestName]: { id: number; type: K } & Requests[K]['args'];
}[RequestName];

export type ServerMessage =
  | { type: 'reply'; id: number; ok: true; data: unknown }
  | { type: 'reply'; id: number; ok: false; error: string }
  | { type: 'room:state'; state: RoomState }
  | { type: 'notice'; text: string }
  | { type: 'dice'; roll: DiceRoll }
  | { type: 'room:kicked' };

/** WebSocket close codes with a special meaning (the client should not reconnect). */
export const CLOSE_REPLACED = 4000; // the same device opened the game somewhere else
export const CLOSE_KICKED = 4001; // the DM removed this player
export const CLOSE_NO_ROOM = 4004; // this game doesn't exist

// Compile-time check: no request may use "id" or "type" as an argument name
// (they would overwrite the message's own fields). A clash names the request here.
type ClashingRequest = { [K in RequestName]: Extract<keyof Requests[K]['args'], 'id' | 'type'> extends never ? never : K }[RequestName];
export const NO_CLASHING_ARGS: [ClashingRequest] extends [never] ? true : ClashingRequest = true;
