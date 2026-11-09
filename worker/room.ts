import { DurableObject } from 'cloudflare:workers';
import {
  CLOSE_KICKED,
  CLOSE_NO_ROOM,
  CLOSE_REPLACED,
  MAX_NAME_LENGTH,
  PLAYER_COLORS,
  SEATS,
  type ClientMessage,
  type Member,
  type Requests,
  type RoomState,
  type SeatId,
  type ServerMessage,
} from '../shared/protocol.ts';

/** A game nobody has connected to for this long is deleted. */
const INACTIVE_GAME_TTL_MS = 180 * 24 * 60 * 60 * 1000; // ~6 months

type StoredMember = Omit<Member, 'connected'>;
interface StoredRoom {
  code: string;
  tableId: string; // device id of the Main Screen that created the game
  members: Record<string, StoredMember>;
  createdAt: number;
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
    this.room = {
      code,
      tableId,
      createdAt: Date.now(),
      members: {
        [tableId]: { id: tableId, role: 'table', name: 'Main Screen', seat: null, color: '' },
      },
    };
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
        if (me && me.role !== 'table') delete room.members[clientId];
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
        await this.save();
        for (const s of this.ctx.getWebSockets(target.id)) {
          send(s, { type: 'room:kicked' });
          s.close(CLOSE_KICKED, 'Removed by the Dungeon Master.');
        }
        this.broadcast(room);
        return null;
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
    return (room.members[clientId] = { id: clientId, role: 'player', name, seat, color });
  }

  // ---------- helpers ----------

  private async load(): Promise<StoredRoom | null> {
    if (this.room === undefined) this.room = (await this.ctx.storage.get<StoredRoom>('room')) ?? null;
    return this.room;
  }

  private async save() {
    await this.ctx.storage.put('room', this.room);
    await this.scheduleCleanup();
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
    return { code: room.code, members: Object.values(room.members).map((m) => this.toMember(m, except)) };
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
