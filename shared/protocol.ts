// Messages and data shared between the game server and every screen.

import type { Character } from './rules.ts';
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
  hexMm: number; // width of one hex on the table, in mm (1 inch = 25.4)
  calibrated: boolean;
  calibrating: boolean; // the Main Screen is showing the calibration card right now
  viewport: { w: number; h: number } | null; // Main Screen size in CSS pixels
}

export type TokenKind = 'player' | 'npc' | 'monster';

export interface Token {
  id: string;
  q: number;
  r: number;
  name: string;
  label: string; // 1-2 letters shown on the token
  color: string;
  kind: TokenKind;
  ownerId: string | null; // the player who controls it (null = DM only)
  speedFt: number;
  characterId?: string; // the character this token stands for
}

/** A movement or range area shown around a token on every screen. */
export interface Highlight {
  tokenId: string;
  kind: 'move' | 'range';
  feet: number;
}

/** The part of a game that belongs to the campaign and is saved with it. */
export interface World {
  board: { cols: number; rows: number };
  tokens: Record<string, Token>;
  view: { x: number; y: number };
  highlight: Highlight | null;
  nextTokenId: number;
  characters: Record<string, Character>;
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
  /** Centre of what the Main Screen shows, in map units (see shared/hex.ts). */
  view: { x: number; y: number };
  board: { cols: number; rows: number };
  tokens: Token[];
  highlight: Highlight | null;
  characters: Character[];
  rolls: DiceRoll[]; // the latest rolls, newest first
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
  'token:move': { args: { tokenId: string; q: number; r: number }; result: null };
  // DM: add or remove NPC/monster tokens
  'token:add': { args: { name: string; color: string; kind: TokenKind; q?: number; r?: number }; result: { tokenId: string } };
  'token:remove': { args: { tokenId: string }; result: null };
  'highlight:set': { args: { highlight: Highlight | null }; result: null };
  // DM: hand a player token to another player (e.g. they use a different phone this time)
  'token:assign': { args: { tokenId: string; memberId: string | null }; result: null };

  // ---- characters ----
  // Players save their own character; the DM can save any (e.g. pre-made ones).
  'character:save': { args: { character: Character }; result: { id: string } };
  'character:delete': { args: { id: string }; result: null };
  'character:assign': { args: { id: string; memberId: string | null }; result: null }; // DM
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
