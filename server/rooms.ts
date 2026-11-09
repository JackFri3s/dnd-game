import {
  PLAYER_COLORS,
  SEATS,
  type JoinRequest,
  type Member,
  type RoomState,
  type SeatId,
} from '../shared/protocol.ts';

// Letters that are hard to mix up when read off a screen (no I/O/0/1).
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 4;
/** Empty rooms (nobody connected) are removed after this long. */
const EMPTY_ROOM_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_NAME_LENGTH = 24;

export interface Room {
  code: string;
  tableId: string; // clientId of the Main Screen that created it
  members: Map<string, Member>;
  emptySince: number | null;
}

export class RoomError extends Error {}

export class Rooms {
  private rooms = new Map<string, Room>();

  create(tableId: string): Room {
    let code: string;
    do {
      code = Array.from(
        { length: CODE_LENGTH },
        () => CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)],
      ).join('');
    } while (this.rooms.has(code));

    const room: Room = { code, tableId, members: new Map(), emptySince: null };
    room.members.set(tableId, {
      id: tableId,
      role: 'table',
      name: 'Main Screen',
      seat: null,
      color: '',
      connected: true,
    });
    this.rooms.set(code, room);
    return room;
  }

  get(code: string): Room {
    const room = this.rooms.get(normalizeCode(code));
    if (!room) throw new RoomError(`No game found with code "${code.toUpperCase()}".`);
    return room;
  }

  join(req: JoinRequest): { room: Room; member: Member } {
    const room = this.get(req.code);
    const name = req.name.trim().slice(0, MAX_NAME_LENGTH);
    if (!name) throw new RoomError('Please enter a name.');

    const existing = room.members.get(req.clientId);
    if (existing && existing.role !== req.role) {
      throw new RoomError(`This device is already in the game as ${existing.role}.`);
    }

    if (req.role === 'dm') {
      const otherDm = [...room.members.values()].find(
        (m) => m.role === 'dm' && m.id !== req.clientId,
      );
      if (otherDm) throw new RoomError(`${otherDm.name} is already the Dungeon Master.`);
      const member: Member = {
        id: req.clientId,
        role: 'dm',
        name,
        seat: null,
        color: '',
        connected: true,
      };
      room.members.set(member.id, member);
      return { room, member };
    }

    const players = [...room.members.values()].filter(
      (m) => m.role === 'player' && m.id !== req.clientId,
    );
    if (!existing && players.length >= SEATS.length) {
      throw new RoomError('This game is full.');
    }
    const seat = req.seat ?? existing?.seat ?? firstFreeSeat(room, req.clientId);
    if (seat) assertSeatFree(room, seat, req.clientId);

    const usedColors = new Set(players.map((p) => p.color));
    const color =
      existing?.color ?? PLAYER_COLORS.find((c) => !usedColors.has(c)) ?? PLAYER_COLORS[0];

    const member: Member = {
      id: req.clientId,
      role: 'player',
      name,
      seat,
      color,
      connected: true,
    };
    room.members.set(member.id, member);
    return { room, member };
  }

  /** A device that was already in the room comes back (page reload, phone woke up). */
  rejoin(code: string, clientId: string): { room: Room; member: Member } {
    const room = this.get(code);
    const member = room.members.get(clientId);
    if (!member) throw new RoomError('You are no longer in this game.');
    member.connected = true;
    room.emptySince = null;
    return { room, member };
  }

  changeSeat(room: Room, clientId: string, seat: SeatId) {
    const member = room.members.get(clientId);
    if (!member || member.role !== 'player') throw new RoomError('Only players have seats.');
    assertSeatFree(room, seat, clientId);
    member.seat = seat;
  }

  setConnected(room: Room, clientId: string, connected: boolean) {
    const member = room.members.get(clientId);
    if (member) member.connected = connected;
    const anyoneConnected = [...room.members.values()].some((m) => m.connected);
    room.emptySince = anyoneConnected ? null : Date.now();
  }

  remove(room: Room, clientId: string) {
    room.members.delete(clientId);
  }

  state(room: Room): RoomState {
    return { code: room.code, members: [...room.members.values()] };
  }

  /** Remove rooms nobody has been connected to for a long time. */
  cleanup(now = Date.now()) {
    for (const [code, room] of this.rooms) {
      if (room.emptySince !== null && now - room.emptySince > EMPTY_ROOM_TTL_MS) {
        this.rooms.delete(code);
      }
    }
  }
}

export function normalizeCode(code: string) {
  return code.trim().toUpperCase();
}

function firstFreeSeat(room: Room, clientId: string): SeatId | null {
  const taken = takenSeats(room, clientId);
  return SEATS.find((s) => !taken.has(s.id))?.id ?? null;
}

function assertSeatFree(room: Room, seat: SeatId, clientId: string) {
  if (!SEATS.some((s) => s.id === seat)) throw new RoomError('Unknown seat.');
  if (takenSeats(room, clientId).has(seat)) throw new RoomError('That seat is taken.');
}

function takenSeats(room: Room, exceptId: string) {
  return new Set(
    [...room.members.values()]
      .filter((m) => m.role === 'player' && m.id !== exceptId && m.seat)
      .map((m) => m.seat!),
  );
}
