// Messages and data shared between the game server and every screen.

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
}

/** A movement or range area shown around a token on every screen. */
export interface Highlight {
  tokenId: string;
  kind: 'move' | 'range';
  feet: number;
}

export interface RoomState {
  code: string;
  members: Member[];
  phase: Phase;
  table: TableSettings;
  /** Centre of what the Main Screen shows, in map units (see shared/hex.ts). */
  view: { x: number; y: number };
  board: { cols: number; rows: number };
  tokens: Token[];
  highlight: Highlight | null;
}

/** Standard CSS pixels per mm (96 per inch): used until the Main Screen is calibrated. */
export const DEFAULT_PX_PER_MM = 96 / 25.4;
export const DEFAULT_HEX_MM = 25.4;
export const CARD_MM = { w: 85.6, h: 53.98 }; // bank/credit card (ISO/IEC 7810 ID-1)

export const PLAYER_COLORS = [
  '#d94f3d', '#3d7bd9', '#3da35d', '#d9a13d',
  '#8f4fd9', '#2fb3b3', '#d94f9b', '#7a7a7a',
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
}
export type RequestName = keyof Requests;

export type ClientMessage = {
  [K in RequestName]: { id: number; type: K } & Requests[K]['args'];
}[RequestName];

export type ServerMessage =
  | { type: 'reply'; id: number; ok: true; data: unknown }
  | { type: 'reply'; id: number; ok: false; error: string }
  | { type: 'room:state'; state: RoomState }
  | { type: 'room:kicked' };

/** WebSocket close codes with a special meaning (the client should not reconnect). */
export const CLOSE_REPLACED = 4000; // the same device opened the game somewhere else
export const CLOSE_KICKED = 4001; // the DM removed this player
export const CLOSE_NO_ROOM = 4004; // this game doesn't exist
