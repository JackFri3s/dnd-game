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
  type World,
  type CampaignSummary,
  type Character,
  type DiceRoll,
  type Area,
} from '../shared/protocol.ts';
import type { CampaignExport } from './campaign.ts';
import { MIN_TOKEN_GAP, clampToBoard, dist, freeSpotNear, fromHex, onBoard, type Point } from '../shared/geometry.ts';

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
  board: { w: number; h: number };
  tokens: Record<string, Token>;
  highlight: Highlight | null;
  nextTokenId: number;
  /** The campaign loaded in this game; its world is saved to it after every change. */
  campaign: { key: string; name: string } | null;
  characters: Record<string, Character>;
  rolls: DiceRoll[];
  areas: Area[];
}

const KEY_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const KEY_LENGTH = 10;

function emptyWorld(): World {
  const board = DEFAULT_BOARD;
  return { board, tokens: {}, view: { x: board.w / 2, y: board.h / 2 }, highlight: null, nextTokenId: 1, characters: {}, areas: [] };
}

/**
 * Worlds saved before the map went gridless used hexes (q, r) and a board of
 * columns and rows: convert them to free positions.
 */
function migrateWorld<T extends Partial<World>>(w: T): T {
  const board = w.board as unknown as { cols?: number; rows?: number; w?: number; h?: number } | undefined;
  if (board && board.cols !== undefined) {
    w.board = { w: board.cols + 1, h: (board.rows ?? 28) * (Math.sqrt(3) / 2) + 0.6 };
    if (w.view) w.view = { x: w.view.x + 0.5, y: w.view.y + 0.6 };
  }
  for (const t of Object.values(w.tokens ?? {})) {
    const old = t as unknown as { q?: number; r?: number };
    if (old.q !== undefined && old.r !== undefined) {
      Object.assign(t, fromHex(old.q, old.r));
      delete old.q;
      delete old.r;
    }
  }
  for (const a of w.areas ?? []) {
    const o = a.origin as unknown as { q?: number; r?: number };
    const t = a.target as unknown as { q?: number; r?: number };
    if (o.q !== undefined) a.origin = fromHex(o.q, o.r!);
    if (t.q !== undefined) a.target = fromHex(t.q, t.r!);
  }
  return w;
}

function worldOf(room: StoredRoom): World {
  return {
    board: room.board,
    tokens: room.tokens,
    view: room.view,
    highlight: room.highlight,
    nextTokenId: room.nextTokenId,
    characters: room.characters,
    areas: room.areas,
  };
}

function applyWorld(room: StoredRoom, world: World) {
  migrateWorld(world);
  room.board = world.board;
  room.tokens = world.tokens;
  room.view = world.view;
  room.highlight = world.highlight;
  room.nextTokenId = world.nextTokenId;
  room.characters = world.characters ?? {};
  room.areas = world.areas ?? [];
}

const DEFAULT_BOARD = { w: 40, h: 25 };

/** Fills in anything missing, e.g. for games saved by an older version of the app. */
function withDefaults(room: Partial<StoredRoom> & Pick<StoredRoom, 'code' | 'tableId' | 'members' | 'createdAt'>): StoredRoom {
  migrateWorld(room);
  const board = room.board ?? DEFAULT_BOARD;
  return {
    phase: 'lobby',
    view: { x: board.w / 2, y: board.h / 2 },
    tokens: {},
    highlight: null,
    nextTokenId: 1,
    campaign: null,
    characters: {},
    rolls: [],
    areas: [],
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
        await this.commit(room);
        return { member: this.toMember(member) } satisfies Requests['join']['result'];
      }

      case 'leave': {
        // The Main Screen stays a member so it can come back; others are removed.
        // Their token stays on the map (it belongs to the campaign); they get it back when they rejoin.
        if (me && me.role !== 'table') delete room.members[clientId];
        await this.commit(room, ws);
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

      case 'game:phase': {
        requireRole(me, 'dm');
        if (msg.phase !== 'lobby' && msg.phase !== 'playing') throw new GameError('Unknown phase.');
        if (msg.phase === 'playing' && !room.campaign) throw new GameError('Choose or create a campaign first.');
        const starting = msg.phase === 'playing' && room.phase !== 'playing';
        room.phase = msg.phase;
        if (msg.phase === 'playing') {
          for (const m of Object.values(room.members)) if (m.role === 'player') ensurePlayerToken(room, m);
        }
        await this.commit(room);
        if (starting) {
          const date = new Date().toISOString().slice(0, 10);
          await this.campaignStub(room.campaign!.key).snapshot(`Session started ${date}`, worldOf(room), true);
        }
        return null;
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
        room.view = { x: num(msg.x, 0, room.board.w), y: num(msg.y, 0, room.board.h) };
        return this.commit(room);
      }

      case 'token:move': {
        const token = room.tokens[msg.tokenId];
        if (!token) throw new GameError('Token not found.');
        if (!me) throw new GameError('You are not in this game.');
        if (me.role === 'player' && token.ownerId !== me.id) throw new GameError('You can only move your own token.');
        const to = { x: num(msg.x, -1e6, 1e6), y: num(msg.y, -1e6, 1e6) };
        if (!onBoard(to, room.board)) throw new GameError('That is off the map.');
        const spot = clampToBoard(to, room.board);
        const blocker = Object.values(room.tokens).find((t) => t.id !== token.id && dist(t, spot) < MIN_TOKEN_GAP);
        if (blocker) throw new GameError(`${blocker.name} is in the way.`);
        token.x = spot.x;
        token.y = spot.y;
        return this.commit(room);
      }

      case 'token:add': {
        requireRole(me, 'dm');
        const kind = msg.kind === 'npc' || msg.kind === 'monster' ? msg.kind : 'monster';
        const name = cleanName(msg.name) || (kind === 'npc' ? 'NPC' : 'Monster');
        const wanted = msg.x !== undefined && msg.y !== undefined ? { x: num(msg.x, 0, room.board.w), y: num(msg.y, 0, room.board.h) } : room.view;
        const hex = freeSpot(room, wanted);
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
          room.highlight = {
            tokenId: token.id,
            kind: h.kind === 'range' || h.kind === 'spell' ? h.kind : 'move',
            feet: num(h.feet, 0, 6000),
            ...(h.longFeet ? { longFeet: num(h.longFeet, 0, 6000) } : {}),
            ...(h.label ? { label: cleanTitle(h.label) } : {}),
          };
        }
        return this.commit(room);
      }

      case 'token:assign': {
        requireRole(me, 'dm');
        const token = room.tokens[msg.tokenId];
        if (!token || token.kind !== 'player') throw new GameError('Player token not found.');
        const target = msg.memberId ? room.members[msg.memberId] : null;
        if (msg.memberId && target?.role !== 'player') throw new GameError('Player not found.');
        if (target) {
          // The player's other (e.g. brand new, empty) token is removed: they take over this one.
          for (const t of Object.values(room.tokens)) {
            if (t.ownerId === target.id && t.id !== token.id) delete room.tokens[t.id];
          }
          Object.assign(token, { ownerId: target.id, color: target.color });
        } else {
          token.ownerId = null;
        }
        return this.commit(room);
      }

      // ---------- characters ----------

      case 'character:save': {
        if (!me || me.role === 'table') throw new GameError('Not allowed.');
        const incoming = sanitizeCharacter(msg.character);
        const existing = incoming.id ? room.characters[incoming.id] : undefined;
        if (me.role === 'player') {
          if (existing && existing.ownerId !== me.id) throw new GameError('You can only change your own character.');
          incoming.ownerId = me.id;
        } else {
          // The DM keeps the current player, or makes an unplayed (pre-made) character.
          incoming.ownerId = existing ? existing.ownerId : null;
        }
        if (!existing) incoming.id = `c${crypto.randomUUID().slice(0, 8)}`;
        incoming.updatedAt = Date.now();
        room.characters[incoming.id] = incoming;
        syncCharacterToken(room, incoming);
        await this.commit(room);
        return { id: incoming.id } satisfies Requests['character:save']['result'];
      }

      case 'character:delete': {
        const c = room.characters[String(msg.characterId)];
        if (!c) throw new GameError('Character not found.');
        if (me?.role !== 'dm' && !(me?.role === 'player' && c.ownerId === me.id)) throw new GameError('Not allowed.');
        delete room.characters[c.id];
        for (const t of Object.values(room.tokens)) if (t.characterId === c.id) delete t.characterId;
        return this.commit(room);
      }

      case 'character:assign': {
        requireRole(me, 'dm');
        const c = room.characters[String(msg.characterId)];
        if (!c) throw new GameError('Character not found.');
        const target = msg.memberId ? room.members[msg.memberId] : null;
        if (msg.memberId && target?.role !== 'player') throw new GameError('Player not found.');
        // A player plays one character: hand any other one back.
        if (target) for (const other of Object.values(room.characters)) if (other.ownerId === target.id && other.id !== c.id) other.ownerId = null;
        c.ownerId = target?.id ?? null;
        const token = Object.values(room.tokens).find((t) => t.characterId === c.id);
        if (token && target) {
          for (const t of Object.values(room.tokens)) if (t.ownerId === target.id && t.id !== token.id) delete room.tokens[t.id];
          Object.assign(token, { ownerId: target.id, color: target.color });
        } else if (token) token.ownerId = null;
        else if (target && room.phase === 'playing') syncCharacterToken(room, c);
        return this.commit(room);
      }

      // ---------- areas ----------

      case 'area:add': {
        if (!me || me.role === 'table') throw new GameError('Not allowed.');
        const a = msg.area;
        const token = a?.tokenId ? room.tokens[a.tokenId] : undefined;
        if (me.role === 'player' && token?.ownerId !== me.id) throw new GameError('You can only cast from your own token.');
        const shapes = ['sphere', 'cone', 'cube', 'cylinder', 'emanation', 'line'] as const;
        if (!shapes.includes(a?.shape)) throw new GameError('Unknown area shape.');
        const area: Area = {
          id: `a${crypto.randomUUID().slice(0, 8)}`,
          tokenId: token?.id ?? null,
          placedBy: me.id,
          label: cleanTitle(a.label) || 'Area',
          shape: a.shape,
          sizeFt: num(a.sizeFt, 5, 500),
          ...(a.widthFt ? { widthFt: num(a.widthFt, 5, 100) } : {}),
          rangeFt: a.rangeFt === null ? null : num(a.rangeFt, 0, 30000),
          origin: { x: num(a.origin?.x, -1e4, 1e4), y: num(a.origin?.y, -1e4, 1e4) },
          target: { x: num(a.target?.x, -1e4, 1e4), y: num(a.target?.y, -1e4, 1e4) },
          at: Date.now(),
        };
        room.areas = [...room.areas, area].slice(-30);
        await this.commit(room);
        return { id: area.id } satisfies Requests['area:add']['result'];
      }

      case 'area:remove': {
        const area = room.areas.find((x) => x.id === msg.areaId);
        if (!area) return null;
        if (me?.role !== 'dm' && area.placedBy !== me?.id) throw new GameError('Only the Dungeon Master or the caster can remove this.');
        room.areas = room.areas.filter((x) => x.id !== area.id);
        return this.commit(room);
      }

      // ---------- dice ----------

      case 'dice:roll': {
        if (!me || me.role === 'table') throw new GameError('Not allowed.');
        const roll = rollDice(msg, me);
        room.rolls = [roll, ...room.rolls].slice(0, 20);
        await this.save();
        for (const s of this.ctx.getWebSockets()) {
          const { clientId: id } = s.deserializeAttachment() as Attachment;
          if (room.members[id]) send(s, { type: 'dice', roll });
        }
        this.broadcast(room);
        return { roll } satisfies Requests['dice:roll']['result'];
      }

      // ---------- campaigns ----------

      case 'campaign:list': {
        requireRole(me, 'dm');
        const keys = await this.dmIndex(clientId).list();
        const summaries = await Promise.all(keys.map((k) => this.campaignStub(k).summary()));
        const campaigns = summaries.filter((c): c is CampaignSummary => !!c).sort((a, b) => b.updatedAt - a.updatedAt);
        return { campaigns, current: room.campaign?.key ?? null } satisfies Requests['campaign:list']['result'];
      }

      case 'campaign:create': {
        requireRole(me, 'dm');
        const name = cleanTitle(msg.name) || 'New campaign';
        const campaign = await this.createCampaign(name, emptyWorld());
        await this.dmIndex(clientId).add(campaign.key);
        await this.loadCampaign(room, campaign.key);
        return { campaign } satisfies Requests['campaign:create']['result'];
      }

      case 'campaign:load': {
        requireRole(me, 'dm');
        await this.loadCampaign(room, cleanKey(msg.key));
        await this.dmIndex(clientId).add(cleanKey(msg.key));
        return null;
      }

      case 'campaign:add': {
        requireRole(me, 'dm');
        const key = cleanKey(msg.key);
        const campaign = await this.campaignStub(key).summary();
        if (!campaign) throw new GameError('No campaign found with that key.');
        await this.dmIndex(clientId).add(key);
        return { campaign } satisfies Requests['campaign:add']['result'];
      }

      case 'campaign:forget': {
        requireRole(me, 'dm');
        await this.dmIndex(clientId).remove(cleanKey(msg.key));
        return null;
      }

      case 'campaign:rename': {
        requireRole(me, 'dm');
        const campaign = requireCampaign(room);
        campaign.name = cleanTitle(msg.name) || campaign.name;
        await this.campaignStub(campaign.key).rename(campaign.name);
        return this.commit(room);
      }

      case 'campaign:snapshots': {
        requireRole(me, 'dm');
        const snapshots = await this.campaignStub(requireCampaign(room).key).listSnapshots();
        return { snapshots } satisfies Requests['campaign:snapshots']['result'];
      }

      case 'campaign:snapshot': {
        requireRole(me, 'dm');
        const name = cleanTitle(msg.name) || `Save point ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
        const snapshot = await this.campaignStub(requireCampaign(room).key).snapshot(name, worldOf(room), false);
        return { snapshot } satisfies Requests['campaign:snapshot']['result'];
      }

      case 'campaign:restore': {
        requireRole(me, 'dm');
        const stub = this.campaignStub(requireCampaign(room).key);
        const world = await stub.getSnapshot(String(msg.snapshotId));
        if (!world) throw new GameError('Save point not found.');
        // Keep a safety copy of the current situation first, so a restore can be undone.
        await stub.snapshot('Before restoring a save point', worldOf(room), true);
        applyWorld(room, world);
        if (room.phase === 'playing') {
          for (const m of Object.values(room.members)) if (m.role === 'player') ensurePlayerToken(room, m);
        }
        return this.commit(room);
      }

      case 'campaign:delete-snapshot': {
        requireRole(me, 'dm');
        await this.campaignStub(requireCampaign(room).key).deleteSnapshot(String(msg.snapshotId));
        return null;
      }

      case 'campaign:export': {
        requireRole(me, 'dm');
        const data = await this.campaignStub(requireCampaign(room).key).exportAll();
        if (!data) throw new GameError('Campaign not found.');
        return { data, name: data.name } satisfies Requests['campaign:export']['result'];
      }

      case 'campaign:import': {
        requireRole(me, 'dm');
        const data = parseExport(msg.data);
        const campaign = await this.createCampaign(data.name, data.world);
        const stub = this.campaignStub(campaign.key);
        for (const snap of data.snapshots.slice().reverse()) {
          await stub.snapshot(snap.info.name, snap.world, snap.info.auto, snap.info.at);
        }
        await this.dmIndex(clientId).add(campaign.key);
        await this.loadCampaign(room, campaign.key);
        return { campaign } satisfies Requests['campaign:import']['result'];
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

  /** Saves the game (and its campaign) and sends the new state to everyone. */
  private async commit(room: StoredRoom, except?: WebSocket): Promise<null> {
    if (room.campaign) {
      const saved = await this.campaignStub(room.campaign.key).saveWorld(room.code, worldOf(room));
      if (!saved) {
        // The campaign was opened in another game since: this game must stop using it.
        const name = room.campaign.name;
        room.campaign = null;
        room.phase = 'lobby';
        applyWorld(room, emptyWorld());
        this.notify(room, `"${name}" was opened in another game, so it was closed here.`);
      }
    }
    await this.save();
    this.broadcast(room, except);
    return null;
  }

  private notify(room: StoredRoom, text: string) {
    for (const s of this.ctx.getWebSockets()) {
      const { clientId } = s.deserializeAttachment() as Attachment;
      if (room.members[clientId]) send(s, { type: 'notice', text });
    }
  }

  private campaignStub(key: string) {
    return this.env.CAMPAIGN.get(this.env.CAMPAIGN.idFromName(key));
  }

  private dmIndex(clientId: string) {
    return this.env.DM_INDEX.get(this.env.DM_INDEX.idFromName(`dm:${clientId}`));
  }

  private async createCampaign(name: string, world: World): Promise<CampaignSummary> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const bytes = crypto.getRandomValues(new Uint8Array(KEY_LENGTH));
      const key = Array.from(bytes, (b) => KEY_LETTERS[b % KEY_LETTERS.length]).join('');
      const stub = this.campaignStub(key);
      if (await stub.create(key, name, world)) return (await stub.summary())!;
    }
    throw new GameError('Could not create a campaign. Please try again.');
  }

  /** Opens a campaign in this game: its world replaces what's on the board. */
  private async loadCampaign(room: StoredRoom, key: string) {
    const opened = await this.campaignStub(key).open(room.code);
    if (!opened) throw new GameError('No campaign found with that key.');
    room.campaign = { key, name: opened.summary.name };
    applyWorld(room, opened.world);
    if (room.phase === 'playing') {
      for (const m of Object.values(room.members)) if (m.role === 'player') ensurePlayerToken(room, m);
    }
    await this.commit(room);
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
      campaign: room.campaign && { name: room.campaign.name },
      table: room.table,
      view: room.view,
      board: room.board,
      tokens: Object.values(room.tokens),
      highlight: room.highlight,
      characters: Object.values(room.characters),
      rolls: room.rolls,
      areas: room.areas,
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

/** The nearest spot to `start` where a token fits. */
function freeSpot(room: StoredRoom, start: Point, exceptId?: string) {
  return freeSpotNear(start, Object.values(room.tokens).filter((t) => t.id !== exceptId), room.board);
}

function addToken(
  room: StoredRoom,
  t: Pick<Token, 'name' | 'kind' | 'color' | 'ownerId' | 'x' | 'y'>,
): Token {
  const id = `t${room.nextTokenId++}`;
  const token: Token = { id, label: initials(t.name), speedFt: 30, ...t };
  room.tokens[id] = token;
  return token;
}

function ensurePlayerToken(room: StoredRoom, member: StoredMember) {
  if (Object.values(room.tokens).some((t) => t.ownerId === member.id)) return;
  const character = Object.values(room.characters).find((c) => c.ownerId === member.id);
  const token = addToken(room, {
    name: character?.name || member.name,
    kind: 'player',
    color: member.color,
    ownerId: member.id,
    ...freeSpot(room, room.view),
  });
  if (character) Object.assign(token, { characterId: character.id, speedFt: character.summary.speedFt });
}

/** Keeps the token of a character in step with it: name, initials, speed. */
function syncCharacterToken(room: StoredRoom, c: Character) {
  let token =
    Object.values(room.tokens).find((t) => t.characterId === c.id) ??
    (c.ownerId ? Object.values(room.tokens).find((t) => t.ownerId === c.ownerId && t.kind === 'player') : undefined);
  if (!token && c.ownerId && room.phase === 'playing' && room.members[c.ownerId]) {
    ensurePlayerToken(room, room.members[c.ownerId]);
    token = Object.values(room.tokens).find((t) => t.ownerId === c.ownerId && t.kind === 'player');
  }
  if (!token) return;
  Object.assign(token, { characterId: c.id, name: c.name, label: initials(c.name), speedFt: c.summary.speedFt });
}

const DICE = new Set([2, 4, 6, 8, 10, 12, 20, 100]);

function rollDice(req: { label?: unknown; groups?: unknown; modifier?: unknown }, me: StoredMember): DiceRoll {
  const groups = Array.isArray(req.groups) ? req.groups.slice(0, 10) : [];
  if (!groups.length) throw new GameError('Nothing to roll.');
  const modifier = Math.round(num(req.modifier ?? 0, -50, 50));
  const rolled = groups.map((g) => {
      const count = Math.round(num(g?.count, 1, 20));
      const sides = Number(g?.sides);
      if (!DICE.has(sides)) throw new GameError('Unknown die.');
      const drop = Math.round(num(g?.dropLowest ?? 0, 0, count - 1));
      const rolls = Array.from({ length: count }, () => randomInt(sides));
      const sorted = rolls.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
      const dropped = new Set(sorted.slice(0, drop).map((x) => x.i));
      const kept = rolls.filter((_, i) => !dropped.has(i));
      return { sides, rolls, kept, total: kept.reduce((a, b) => a + b, 0) };
  });
  return {
    id: crypto.randomUUID(),
    byId: me.id,
    byName: me.name,
    label: cleanTitle(req.label) || 'Roll',
    at: Date.now(),
    groups: rolled,
    modifier,
    total: rolled.reduce((a, g) => a + g.total, 0) + modifier,
  };
}

/** A fair random number from 1 to `sides`. */
function randomInt(sides: number) {
  const limit = Math.floor(0x100000000 / sides) * sides;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return (buf[0] % sides) + 1;
}

/** Checks a character sent by a device, keeping only known fields with sensible values. */
function sanitizeCharacter(raw: unknown): Character {
  const c = raw as Character;
  if (!c || typeof c !== 'object') throw new GameError('Invalid character.');
  if (JSON.stringify(c).length > 100_000) throw new GameError('This character is too large to save.');
  const str = (v: unknown, max = 60) => (typeof v === 'string' ? v.slice(0, max) : '');
  const strs = (v: unknown, max = 100) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, max).map((x) => x.slice(0, 80)) : []);
  const n = (v: unknown, min: number, max: number, dflt = min) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Math.round(Number(v)))) : dflt);
  const name = str(c.name).trim();
  if (!name) throw new GameError('Your character needs a name.');
  const abilities = {} as Character['abilities'];
  for (const a of ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const) abilities[a] = n(c.abilities?.[a], 1, 30, 10);
  const maxHp = n(c.hp?.max, 1, 999, 1);
  return {
    id: str(c.id, 40),
    ownerId: null,
    name,
    level: n(c.level, 1, 20, 1),
    classIndex: str(c.classIndex),
    subclassIndex: c.subclassIndex ? str(c.subclassIndex) : null,
    speciesIndex: str(c.speciesIndex),
    subspeciesIndex: c.subspeciesIndex ? str(c.subspeciesIndex) : null,
    backgroundIndex: str(c.backgroundIndex),
    alignment: str(c.alignment),
    abilities,
    abilityMethod: (['roll', 'array', 'pointbuy', 'manual'] as const).includes(c.abilityMethod) ? c.abilityMethod : 'manual',
    skills: strs(c.skills, 30),
    languages: strs(c.languages, 30),
    feats: strs(c.feats, 30),
    items: (Array.isArray(c.items) ? c.items : []).slice(0, 200).map((i) => ({
      index: i?.index ? str(i.index) : null,
      name: str(i?.name, 80) || 'Item',
      qty: n(i?.qty, 0, 9999, 1),
      ...(i?.equipped ? { equipped: true } : {}),
    })),
    gold: n(c.gold, 0, 10_000_000, 0),
    cantrips: strs(c.cantrips, 40),
    spells: strs(c.spells, 100),
    hp: { max: maxHp, current: n(c.hp?.current, -999, 999, maxHp), temp: n(c.hp?.temp, 0, 999, 0) },
    xp: n(c.xp, 0, 10_000_000, 0),
    inspiration: !!c.inspiration,
    hitDiceSpent: n(c.hitDiceSpent, 0, 20, 0),
    deathSaves: { successes: n(c.deathSaves?.successes, 0, 3, 0), failures: n(c.deathSaves?.failures, 0, 3, 0) },
    trackers: (Array.isArray(c.trackers) ? c.trackers : []).slice(0, 30).map((t) => ({
      name: str(t?.name, 60) || 'Feature',
      max: n(t?.max, 1, 99, 1),
      used: n(t?.used, 0, 99, 0),
    })),
    spellSlotsUsed: Array.from({ length: 9 }, (_, i) => n(c.spellSlotsUsed?.[i], 0, 9, 0)),
    overrides: {
      ...(c.overrides?.ac !== undefined ? { ac: n(c.overrides.ac, 0, 40) } : {}),
      ...(c.overrides?.speed !== undefined ? { speed: n(c.overrides.speed, 0, 300) } : {}),
    },
    details: {
      appearance: str(c.details?.appearance, 2000),
      personality: str(c.details?.personality, 2000),
      ideals: str(c.details?.ideals, 2000),
      bonds: str(c.details?.bonds, 2000),
      flaws: str(c.details?.flaws, 2000),
      backstory: str(c.details?.backstory, 10000),
    },
    summary: {
      ac: n(c.summary?.ac, 0, 40, 10),
      speedFt: n(c.summary?.speedFt, 0, 300, 30),
      initiative: n(c.summary?.initiative, -10, 30, 0),
      passivePerception: n(c.summary?.passivePerception, 0, 40, 10),
      classLine: str(c.summary?.classLine, 120),
    },
    createdWith: c.createdWith === 'manual' ? 'manual' : 'builder',
    updatedAt: 0,
  };
}

function requireCampaign(room: StoredRoom) {
  if (!room.campaign) throw new GameError('No campaign is loaded.');
  return room.campaign;
}

function cleanTitle(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 60) : '';
}

function cleanKey(value: unknown): string {
  const key = typeof value === 'string' ? value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
  if (key.length !== KEY_LENGTH) throw new GameError('A campaign key has 10 letters and numbers.');
  return key;
}

/** Checks an uploaded backup file before importing it. */
function parseExport(data: unknown): CampaignExport {
  const d = data as CampaignExport;
  const validWorld = (w: World) =>
    w && typeof w === 'object' && migrateWorld(w) && w.board && Number.isFinite(w.board.w) && Number.isFinite(w.board.h) &&
    w.board.w > 0 && w.board.w <= 2000 && w.board.h > 0 && w.board.h <= 2000 &&
    w.tokens && typeof w.tokens === 'object' && w.view && Number.isFinite(w.view.x) && Number.isFinite(w.view.y) &&
    Number.isInteger(w.nextTokenId);
  if (!d || d.format !== 'dnd-campaign' || d.version !== 1 || !validWorld(d.world)) {
    throw new GameError('This file is not a campaign backup from this app.');
  }
  return {
    ...d,
    name: cleanTitle(d.name) || 'Imported campaign',
    snapshots: Array.isArray(d.snapshots) ? d.snapshots.filter((s) => s?.info && validWorld(s.world)).slice(0, 200) : [],
  };
}
