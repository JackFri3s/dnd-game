import express from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Server, type Socket } from 'socket.io';
import type { Ack, ClientToServer, ServerToClient } from '../shared/protocol.ts';
import { RoomError, Rooms, type Room } from './rooms.ts';

const PORT = Number(process.env.PORT ?? 3001);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clientDist = path.join(rootDir, 'dist');

interface SocketData {
  clientId?: string;
  roomCode?: string;
}
type GameSocket = Socket<ClientToServer, ServerToClient, Record<string, never>, SocketData>;

const app = express();
const httpServer = createServer(app);
const io = new Server<ClientToServer, ServerToClient, Record<string, never>, SocketData>(
  httpServer,
  { cors: process.env.NODE_ENV === 'production' ? undefined : { origin: true } },
);

const rooms = new Rooms();
/** Which socket currently speaks for each device: `${code}:${clientId}` -> socket id. */
const activeSocket = new Map<string, string>();
setInterval(() => rooms.cleanup(), 10 * 60 * 1000).unref();

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// In production the server also serves the built web app.
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

function broadcast(room: Room) {
  io.to(room.code).emit('room:state', rooms.state(room));
}

/** Runs a handler and turns errors into a friendly ack instead of crashing. */
function handle<T>(ack: Ack<T> | undefined, fn: () => T) {
  const reply: Ack<T> = typeof ack === 'function' ? ack : () => {};
  try {
    reply({ ok: true, data: fn() });
  } catch (err) {
    if (err instanceof RoomError) reply({ ok: false, error: err.message });
    else {
      console.error(err);
      reply({ ok: false, error: 'Something went wrong on the server.' });
    }
  }
}

function str(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100) {
    throw new RoomError(`Invalid ${field}.`);
  }
  return value;
}

function attach(socket: GameSocket, room: Room, clientId: string) {
  // Leave any previous room this socket was in.
  if (socket.data.roomCode && socket.data.roomCode !== room.code) detach(socket);

  const key = `${room.code}:${clientId}`;
  const previous = activeSocket.get(key);
  if (previous && previous !== socket.id) {
    // The same device opened the game again (e.g. a second tab): the old one stops.
    io.sockets.sockets.get(previous)?.disconnect(true);
  }
  activeSocket.set(key, socket.id);
  socket.data.clientId = clientId;
  socket.data.roomCode = room.code;
  socket.join(room.code);
}

function detach(socket: GameSocket) {
  const { roomCode, clientId } = socket.data;
  if (!roomCode || !clientId) return;
  socket.leave(roomCode);
  socket.data.roomCode = undefined;
  const key = `${roomCode}:${clientId}`;
  if (activeSocket.get(key) !== socket.id) return; // another socket took over
  activeSocket.delete(key);
  try {
    const room = rooms.get(roomCode);
    rooms.setConnected(room, clientId, false);
    broadcast(room);
  } catch {
    // room already gone
  }
}

function currentRoom(socket: GameSocket): Room {
  if (!socket.data.roomCode) throw new RoomError('You are not in a game.');
  return rooms.get(socket.data.roomCode);
}

io.on('connection', (socket: GameSocket) => {
  socket.on('room:create', (req, ack) =>
    handle(ack, () => {
      const clientId = str(req?.clientId, 'device id');
      const room = rooms.create(clientId);
      attach(socket, room, clientId);
      broadcast(room);
      return { code: room.code };
    }),
  );

  socket.on('room:peek', (code, ack) =>
    handle(ack, () => rooms.state(rooms.get(str(code, 'code')))),
  );

  socket.on('room:join', (req, ack) =>
    handle(ack, () => {
      const role = req?.role;
      if (role !== 'player' && role !== 'dm') throw new RoomError('Invalid role.');
      const clientId = str(req.clientId, 'device id');
      const { room, member } = rooms.join({
        clientId,
        code: str(req.code, 'code'),
        role,
        name: str(req.name, 'name'),
        seat: req.seat ?? null,
      });
      attach(socket, room, clientId);
      broadcast(room);
      return { member };
    }),
  );

  socket.on('room:rejoin', (req, ack) =>
    handle(ack, () => {
      const clientId = str(req?.clientId, 'device id');
      const { room, member } = rooms.rejoin(str(req.code, 'code'), clientId);
      attach(socket, room, clientId);
      broadcast(room);
      return { member };
    }),
  );

  socket.on('room:leave', () => {
    const { roomCode, clientId } = socket.data;
    if (!roomCode || !clientId) return;
    try {
      const room = rooms.get(roomCode);
      detach(socket);
      // The Main Screen stays a member so it can reconnect; others are removed.
      if (room.tableId !== clientId) rooms.remove(room, clientId);
      broadcast(room);
    } catch {
      // room already gone
    }
  });

  socket.on('seat:change', (seat, ack) =>
    handle(ack, () => {
      const room = currentRoom(socket);
      rooms.changeSeat(room, socket.data.clientId!, seat);
      broadcast(room);
      return null;
    }),
  );

  socket.on('dm:kick', (memberId, ack) =>
    handle(ack, () => {
      const room = currentRoom(socket);
      const me = room.members.get(socket.data.clientId!);
      if (me?.role !== 'dm') throw new RoomError('Only the Dungeon Master can do that.');
      const target = room.members.get(str(memberId, 'member'));
      if (!target || target.role !== 'player') throw new RoomError('Player not found.');
      const key = `${room.code}:${target.id}`;
      const targetSocketId = activeSocket.get(key);
      rooms.remove(room, target.id);
      activeSocket.delete(key);
      if (targetSocketId) {
        const targetSocket = io.sockets.sockets.get(targetSocketId);
        targetSocket?.emit('room:kicked');
        targetSocket?.leave(room.code);
        if (targetSocket) targetSocket.data.roomCode = undefined;
      }
      broadcast(room);
      return null;
    }),
  );

  socket.on('disconnect', () => detach(socket));
});

httpServer.listen(PORT, () => {
  console.log(`dnd server listening on http://localhost:${PORT}`);
});

