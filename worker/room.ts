import { DurableObject } from 'cloudflare:workers';
import {
  CLOSE_KICKED,
  CLOSE_NO_ROOM,
  CLOSE_REPLACED,
  DEFAULT_HEX_MM,
  DEFAULT_PX_PER_MM,
  MAX_NAME_LENGTH,
  PLAYER_COLORS,
  SEATS,
  type ClientMessage,
  type Member,
  type Requests,
  type RoomState,
  type SeatId,
  type ServerMessage,
  type Highlight,
  type Phase,
  type TableSettings,
  type Token,
} from '../shared/protocol.ts';
import { boardBounds, cellToHex, hexToPoint, hexesInRange, hexKey, onBoard, pointToHex } from '../shared/hex.ts';

/** A game nobody has connected to for this long is deleted. */
const INACTIVE_GAME_TTL_MS = 180 * 24 * 60 * 60 * 1000; // ~6 months

type StoredMember = Omit<Member, 'connected'>;
interface StoredRoom {
  code: string;
  tableId: string; // device id of the Main Screen that created the game
  members: Record<string, StoredMember>;
  createdAt: number;
  phase: Phase;
  table: TableSettings;
  view: { x: number; y: number };
  board: { cols: number; rows: number };
  tokens: Record<string, Token>;
  highlight: Highlight | null;
  nextTokenId: number;
}

const DEFAULT_BOARD = { cols: 40, rows: 28 };

/** Fills in anything missing, e.g. for games saved by an older version of the app. */
function withDefaults(room: Partial<StoredRoom> & Pick<StoredRoom, 'code' | 'tableId' | 'members' | 'createdAt'>): StoredRoom {
  const board = room.board ?? DEFAULT_BOARD;
  const b = boardBounds(board);
  return {
    phase: 'lobby',
    view: { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 },
    tokens: {},
    highlight: null,
    nextTokenId: 1,
    ...room,
    board,
    table: {
      pxPerMm: DEFAULT_PX_PER_MM,
      hexMm: DEFAULT_HEX_MM,
      calibrated: false,
      calibrating: false,
      viewport: null,
      ...room.table,
    },
  };
}
interface Attachment {
  clientId: string;
}

/** Mistakes caused by the user (shown to them as a friendly message). */
class GameError extends Error {}

/**
 * One game. Every device in the game holds a WebSocket to the same GameRoom,
 * which keeps the game's state and saves it in its own storage, so a game
 * survives restarts and can be resumed later.
 */
export class GameRoom extends DurableObject<Env> {
  private room: StoredRoom | null | undefined; // undefined = not loaded from storage yet

  // ---------- called by the Worker ----------

  /** Creates the game. Returns false if this code is already used. */
  async init(code: string, tableId: string): Promise<boolean> {
    if (await this.load()) return false;
    this.room = withDefaults({
      code,
      tableId,
      createdAt: Date.now(),
      members: {
        [tableId]: { id: tableId, role: 'table', name: 'Main Screen', seat: null, color: '' },
      },
    });
    await this.save();
    return true;
  }

  async getState(): Promise<RoomState | null> {
    const room = await this.load();
    return room ? this.state(room) : null;
  }

  /** WebSocket connections arrive here. */
  async fetch(request: Request): Promise<Response> {
    const clientId = new URL(request.url).searchParams.get('clientId') ?? '';
    const { 0: client, 1: server } = new WebSocketPair();
    // Hibernation API: the game can sleep between messages without dropping connections.
    this.ctx.acceptWebSocket(server, [clientId]);
    server.serializeAttachment({ clientId } satisfies Attachment);

    if (!clientId || clientId.length > 100 || !(await this.load())) {
      server.close(CLOSE_NO_ROOM, 'No game found with this code.');
    } else {
      // The same device opened the game again (e.g. a second tab): the old one stops.
      for (const old of this.ctx.getWebSockets(clientId)) {
        if (old !== server) old.close(CLOSE_REPLACED, 'Opened on another tab or device.');
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------- WebSocket events ----------

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    if (typeof msg?.id !== 'number') return;
    const { clientId } = ws.deserializeAttachment() as Attachment;
    try {
      const data = await this.handle(ws, clientId, msg);
      send(ws, { type: 'reply', id: msg.id, ok: true, data });
    } catch (err) {
      if (!(err instanceof GameError)) console.error(err);
      const error = err instanceof GameError ? err.message : 'Something went wrong on the server.';
      send(ws, { type: 'reply', id: msg.id, ok: false, error });
    }
  }

  async webSocketClose(ws: WebSocket) {
    const room = await this.load();
    if (room) this.broadcast(room, ws);
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws);
  }

  async alarm() {
    if (this.ctx.getWebSockets().length > 0) {
      await this.scheduleCleanup();
      return;
    }
    await this.ctx.storage.deleteAll();
    this.room = null;
  }

  // ---------- game logic ----------

  private async handle(ws: WebSocket, clientId: string, msg: ClientMessage): Promise<unknown> {
    const room = await this.load();
    if (!room) throw new GameError('This game no longer exists.');
    const me = room.members[clientId];

    switch (msg.type) {
      case 'rejoin': {
        if (!me) throw new GameError('You are no longer in this game.');
        this.broadcast(room);
        await this.scheduleCleanup();
        return { member: this.toMember(me) } satisfies Requests['rejoin']['result'];
      }

      case 'join': {
        const member = this.join(room, clientId, msg);
        await this.save();
        this.broadcast(room);
        return { member: this.toMember(member) } satisfies Requests['join']['result'];
      }

      case 'leave': {
        // The Main Screen stays a member so it can come back; others are removed.
        if (me && me.role !== 'table') {
          delete room.members[clientId];
          removeTokensOf(room, clientId);
        }
        await this.save();
        this.broadcast(room, ws);
        return null;
      }

      case 'seat:change': {
        if (me?.role !== 'player') throw new GameError('Only players have seats.');
        assertSeatFree(room, msg.seat, clientId);
        me.seat = msg.seat;
        await this.save();
        this.broadcast(room);
        return null;
      }

      case 'dm:kick': {
        if (me?.role !== 'dm') throw new GameError('Only the Dungeon Master can do that.');
        const target = room.members[msg.memberId];
        if (!target || target.role !== 'player') throw new GameError('Player not found.');
        delete room.members[target.id];
        removeTokensOf(room, target.id);
        await this.save();
        for (const s of this.ctx.getWebSockets(target.id)) {
          send(s, { type: 'room:kicked' });
          s.close(CLOSE_KICKED, 'Removed by the Dungeon Master.');
        }
        this.broadcast(room);
        return null;
      }

      case 'game:phase': {
        requireRole(me, 'dm');
        if (msg.phase !== 'lobby' && msg.phase !== 'playing') throw new GameError('Unknown phase.');
        room.phase = msg.phase;
        if (msg.phase === 'playing') {
          for (const m of Object.values(room.members)) if (m.role === 'player') ensurePlayerToken(room, m);
        }
        return this.commit(room);
      }

      case 'table:calibrate': {
        requireRole(me, 'dm', 'table');
        const t = room.table;
        if (msg.pxPerMm !== undefined) t.pxPerMm = num(msg.pxPerMm, 0.5, 40);
        if (msg.hexMm !== undefined) t.hexMm = num(msg.hexMm, 10, 80);
        if (msg.calibrating !== undefined) t.calibrating = !!msg.calibrating;
        if (msg.done) {
          t.calibrating = false;
          t.calibrated = true;
        }
        return this.commit(room);
      }

      case 'table:viewport': {
        requireRole(me, 'table');
        room.table.viewport = { w: num(msg.w, 100, 20000), h: num(msg.h, 100, 20000) };
        return this.commit(room);
      }

      case 'view:set': {
        requireRole(me, 'dm', 'table');
        const b = boardBounds(room.board);
        room.view = { x: num(msg.x, b.minX, b.maxX), y: num(msg.y, b.minY, b.maxY) };
        return this.commit(room);
      }

      case 'token:move': {
        const token = room.tokens[msg.tokenId];
        if (!token) throw new GameError('Token not found.');
        if (!me) throw new GameError('You are not in this game.');
        if (me.role === 'player' && token.ownerId !== me.id) throw new GameError('You can only move your own token.');
        const hex = { q: int(msg.q), r: int(msg.r) };
        if (!onBoard(hex, room.board)) throw new GameError('That is off the map.');
        const blocker = Object.values(room.tokens).find((t) => t.id !== token.id && t.q === hex.q && t.r === hex.r);
        if (blocker) throw new GameError(`${blocker.name} is already there.`);
        token.q = hex.q;
        token.r = hex.r;
        return this.commit(room);
      }

      case 'token:add': {
        requireRole(me, 'dm');
        const kind = msg.kind === 'npc' || msg.kind === 'monster' ? msg.kind : 'monster';
        const name = cleanName(msg.name) || (kind === 'npc' ? 'NPC' : 'Monster');
        const wanted = msg.q !== undefined && msg.r !== undefined ? { q: int(msg.q), r: int(msg.r) } : null;
        const hex = wanted && onBoard(wanted, room.board) && !occupied(room, wanted) ? wanted : freeHexNear(room, viewHex(room));
        const token = addToken(room, {
          name,
          kind,
          color: typeof msg.color === 'string' && /^#[0-9a-f]{6}$/i.test(msg.color) ? msg.color : '#555555',
          ownerId: null,
          ...hex,
        });
        this.commit(room);
        return { tokenId: token.id };
      }

      case 'token:remove': {
        requireRole(me, 'dm');
        const token = room.tokens[msg.tokenId];
        if (!token) throw new GameError('Token not found.');
        if (token.kind === 'player') throw new GameError('Player tokens are removed by removing the player.');
        delete room.tokens[token.id];
        if (room.highlight?.tokenId === token.id) room.highlight = null;
        return this.commit(room);
      }

      case 'highlight:set': {
        if (!me || me.role === 'table') throw new GameError('Not allowed.');
        const h = msg.highlight;
        if (h === null) {
          const current = room.highlight && room.tokens[room.highlight.tokenId];
          if (me.role === 'player' && current && current.ownerId !== me.id) throw new GameError('Not your highlight.');
          room.highlight = null;
        } else {
          const token = room.tokens[h?.tokenId];
          if (!token) throw new GameError('Token not found.');
          if (me.role === 'player' && token.ownerId !== me.id) throw new GameError('You can only do that for your own token.');
          room.highlight = { tokenId: token.id, kind: h.kind === 'range' ? 'range' : 'move', feet: num(h.feet, 5, 1000) };
        }
        return this.commit(room);
      }

      default:
        throw new GameError('Unknown request.');
    }
  }

  private join(room: StoredRoom, clientId: string, req: Requests['join']['args']): StoredMember {
    if (req.role !== 'player' && req.role !== 'dm') throw new GameError('Invalid role.');
    const name = typeof req.name === 'string' ? req.name.trim().slice(0, MAX_NAME_LENGTH) : '';
    if (!name) throw new GameError('Please enter a name.');

    const existing = room.members[clientId];
    if (existing && existing.role !== req.role) {
      throw new GameError(`This device is already in the game as ${existing.role === 'table' ? 'the Main Screen' : existing.role}.`);
    }
    const others = Object.values(room.members).filter((m) => m.id !== clientId);

    if (req.role === 'dm') {
      const otherDm = others.find((m) => m.role === 'dm');
      if (otherDm) throw new GameError(`${otherDm.name} is already the Dungeon Master.`);
      return (room.members[clientId] = { id: clientId, role: 'dm', name, seat: null, color: '' });
    }

    const players = others.filter((m) => m.role === 'player');
    if (!existing && players.length >= SEATS.length) throw new GameError('This game is full.');
    const seat = req.seat ?? existing?.seat ?? firstFreeSeat(room, clientId);
    if (seat) assertSeatFree(room, seat, clientId);
    const used = new Set(players.map((p) => p.color));
    const color = existing?.color ?? PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[0];
    const member: StoredMember = { id: clientId, role: 'player', name, seat, color };
    room.members[clientId] = member;
    for (const t of Object.values(room.tokens)) {
      if (t.ownerId === clientId) Object.assign(t, { name, label: initials(name) });
    }
    if (room.phase === 'playing') ensurePlayerToken(room, member);
    return member;
  }

  // ---------- helpers ----------

  private async load(): Promise<StoredRoom | null> {
    if (this.room === undefined) {
      const stored = await this.ctx.storage.get<StoredRoom>('room');
      this.room = stored ? withDefaults(stored) : null;
    }
    return this.room;
  }

  private async save() {
    await this.ctx.storage.put('room', this.room);
    await this.scheduleCleanup();
  }

  /** Saves the game and sends the new state to everyone. */
  private async commit(room: StoredRoom): Promise<null> {
    await this.save();
    this.broadcast(room);
    return null;
  }

  private async scheduleCleanup() {
    await this.ctx.storage.setAlarm(Date.now() + INACTIVE_GAME_TTL_MS);
  }

  private isConnected(clientId: string, except?: WebSocket) {
    return this.ctx
      .getWebSockets(clientId)
      .some((s) => s !== except && s.readyState === WebSocket.OPEN);
  }

  private toMember(m: StoredMember, except?: WebSocket): Member {
    return { ...m, connected: this.isConnected(m.id, except) };
  }

  private state(room: StoredRoom, except?: WebSocket): RoomState {
    return {
      code: room.code,
      members: Object.values(room.members).map((m) => this.toMember(m, except)),
      phase: room.phase,
      table: room.table,
      view: room.view,
      board: room.board,
      tokens: Object.values(room.tokens),
      highlight: room.highlight,
    };
  }

  /** Sends the latest game state to every connected device (except a closing one). */
  private broadcast(room: StoredRoom, except?: WebSocket) {
    const msg: ServerMessage = { type: 'room:state', state: this.state(room, except) };
    for (const s of this.ctx.getWebSockets()) {
      if (s === except) continue;
      const { clientId } = s.deserializeAttachment() as Attachment;
      if (room.members[clientId]) send(s, msg); // only devices that joined see the game
    }
  }
}

function send(ws: WebSocket, msg: ServerMessage) {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // socket already closed
  }
}

function takenSeats(room: StoredRoom, exceptId: string) {
  return new Set(
    Object.values(room.members)
      .filter((m) => m.role === 'player' && m.id !== exceptId && m.seat)
      .map((m) => m.seat!),
  );
}

function firstFreeSeat(room: StoredRoom, clientId: string): SeatId | null {
  const taken = takenSeats(room, clientId);
  return SEATS.find((s) => !taken.has(s.id))?.id ?? null;
}

function assertSeatFree(room: StoredRoom, seat: SeatId, clientId: string) {
  if (!SEATS.some((s) => s.id === seat)) throw new GameError('Unknown seat.');
  if (takenSeats(room, clientId).has(seat)) throw new GameError('That seat is taken.');
}

// ---------- tokens ----------

function requireRole(me: StoredMember | undefined, ...roles: StoredMember['role'][]) {
  if (!me || !roles.includes(me.role)) {
    throw new GameError(roles.includes('dm') ? 'Only the Dungeon Master can do that.' : 'Not allowed.');
  }
}

function num(value: unknown, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new GameError('Invalid number.');
  return Math.min(max, Math.max(min, n));
}

function int(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new GameError('Invalid position.');
  return n;
}

function cleanName(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_NAME_LENGTH) : '';
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : name.trim().slice(0, 2);
  return letters.toUpperCase() || '?';
}

function occupied(room: StoredRoom, hex: { q: number; r: number }) {
  return Object.values(room.tokens).some((t) => t.q === hex.q && t.r === hex.r);
}

function viewHex(room: StoredRoom) {
  const hex = pointToHex(room.view);
  return onBoard(hex, room.board) ? hex : cellToHex(Math.floor(room.board.cols / 2), Math.floor(room.board.rows / 2));
}

/** The closest empty hex on the board to `start`. */
function freeHexNear(room: StoredRoom, start: { q: number; r: number }) {
  const taken = new Set(Object.values(room.tokens).map(hexKey));
  for (let range = 0; range < 50; range++) {
    const candidates = hexesInRange(start, range)
      .filter((h) => onBoard(h, room.board) && !taken.has(hexKey(h)))
      .sort((a, b) => {
        const pa = hexToPoint(a);
        const pb = hexToPoint(b);
        const ps = hexToPoint(start);
        return Math.hypot(pa.x - ps.x, pa.y - ps.y) - Math.hypot(pb.x - ps.x, pb.y - ps.y);
      });
    if (candidates.length) return candidates[0];
  }
  return start;
}

function addToken(
  room: StoredRoom,
  t: Pick<Token, 'name' | 'kind' | 'color' | 'ownerId' | 'q' | 'r'>,
): Token {
  const id = `t${room.nextTokenId++}`;
  const token: Token = { id, label: initials(t.name), speedFt: 30, ...t };
  room.tokens[id] = token;
  return token;
}

function ensurePlayerToken(room: StoredRoom, member: StoredMember) {
  if (Object.values(room.tokens).some((t) => t.ownerId === member.id)) return;
  addToken(room, { name: member.name, kind: 'player', color: member.color, ownerId: member.id, ...freeHexNear(room, viewHex(room)) });
}

function removeTokensOf(room: StoredRoom, memberId: string) {
  for (const t of Object.values(room.tokens)) {
    if (t.ownerId === memberId) {
      delete room.tokens[t.id];
      if (room.highlight?.tokenId === t.id) room.highlight = null;
    }
  }
}
