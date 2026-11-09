// Messages and data shared between the server and every screen.

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
  id: string; // stable id, kept in the device's browser so it can reconnect
  role: Role;
  name: string;
  seat: SeatId | null; // players only
  color: string; // players only
  connected: boolean;
}

export interface RoomState {
  code: string;
  members: Member[];
}

export const PLAYER_COLORS = [
  '#d94f3d', '#3d7bd9', '#3da35d', '#d9a13d',
  '#8f4fd9', '#2fb3b3', '#d94f9b', '#7a7a7a',
];

// ---- client -> server ----
export interface CreateRoomRequest {
  clientId: string;
}
export interface JoinRequest {
  clientId: string;
  code: string;
  role: 'player' | 'dm';
  name: string;
  seat?: SeatId | null;
}
export interface RejoinRequest {
  clientId: string;
  code: string;
}

export type Ack<T> = (res: { ok: true; data: T } | { ok: false; error: string }) => void;

export interface ClientToServer {
  'room:create': (req: CreateRoomRequest, ack: Ack<{ code: string }>) => void;
  'room:join': (req: JoinRequest, ack: Ack<{ member: Member }>) => void;
  'room:rejoin': (req: RejoinRequest, ack: Ack<{ member: Member }>) => void;
  'room:peek': (code: string, ack: Ack<RoomState>) => void;
  'room:leave': () => void;
  'seat:change': (seat: SeatId, ack: Ack<null>) => void;
  'dm:kick': (memberId: string, ack: Ack<null>) => void;
}

// ---- server -> client ----
export interface ServerToClient {
  'room:state': (state: RoomState) => void;
  'room:kicked': () => void;
  'room:closed': () => void;
}
