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
  type Combat,
  type RollOutcome,
  type TokenStats,
  type StoredPlace,
} from '../shared/protocol.ts';
import { crossesWall, publicPlace, summarize, type Npc, type PlaceContext, type PlaceKind } from '../shared/places.ts';
import { generateFor, generatePlace } from '../shared/generate.ts';
import type { CampaignExport, SnapshotWorld } from './campaign.ts';
import { checkHomebrew, emptyHomebrew, DAMAGE_TYPES, WEAPON_PROPERTIES, SCHOOLS, type Homebrew, type HomebrewKind } from '../shared/homebrew.ts';
import { MIN_TOKEN_GAP, clampToBoard, dist, freeSpotNear, fromHex, onBoard, type Point } from '../shared/geometry.ts';

const MAX_PLACES = 300;

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
  homebrew: Homebrew;
  combat: Combat | null;
  places: Record<string, StoredPlace>;
  placeId: string;
  /** Goes up whenever the current place changes, so devices know to fetch it again. */
  placeRev: number;
}

const KEY_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const KEY_LENGTH = 10;

function emptyWorld(): World {
  const board = DEFAULT_BOARD;
  const first = blankPlace('p1', board);
  return { board, tokens: {}, view: { x: board.w / 2, y: board.h / 2 }, highlight: null, nextTokenId: 1, characters: {}, areas: [], homebrew: emptyHomebrew(), combat: null, places: { [first.id]: first }, placeId: first.id };
}

/** The plain map every campaign starts with (and older campaigns get). */
function blankPlace(id: string, board: { w: number; h: number }): StoredPlace {
  return {
    id,
    name: 'Open ground',
    kind: 'blank',
    seed: 0,
    parentId: null,
    parentEntranceId: null,
    size: { w: board.w, h: board.h },
    ground: 'paper',
    features: [],
    walls: [],
    entrances: [],
    npcs: [],
    start: { x: board.w / 2, y: board.h / 2 },
    context: { description: '', mood: 'peaceful', size: 'medium', level: 1 },
  };
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
  // Worlds from before places existed: their board becomes the first place.
  if (!w.places || !Object.keys(w.places).length || !w.placeId || !w.places[w.placeId]) {
    const first = blankPlace(w.placeId ?? 'p1', w.board ?? DEFAULT_BOARD);
    w.places = { ...(w.places ?? {}), [first.id]: first };
    w.placeId = first.id;
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
    homebrew: room.homebrew,
    combat: room.combat,
    places: room.places,
    placeId: room.placeId,
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
  room.homebrew = { ...emptyHomebrew(), ...(world.homebrew ?? {}) };
  room.combat = world.combat ?? null;
  room.places = world.places;
  room.placeId = world.placeId;
  room.placeRev = (room.placeRev ?? 0) + 1;
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
    combat: null,
    places: {},
    placeId: 'p1',
    placeRev: 1,
    ...room,
    homebrew: { ...emptyHomebrew(), ...(room.homebrew ?? {}) },
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
  placeRev?: number; // the version of the current place this device has
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
    for (const id of Object.keys(this.room.places)) this.changedPlaces.add(id);
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
        ws.serializeAttachment({ clientId } satisfies Attachment);
        this.broadcast(room);
        await this.scheduleCleanup();
        return { member: this.toMember(me) } satisfies Requests['rejoin']['result'];
      }

      case 'join': {
        const member = this.join(room, clientId, msg);
        ws.serializeAttachment({ clientId } satisfies Attachment);
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
        // Walls block players (the DM can put tokens anywhere).
        if (me.role === 'player' && crossesWall(room.places[room.placeId], token, spot)) throw new GameError('A wall is in the way.');
        // In combat, movement is counted per turn; players may only move on their own turn.
        const combat = room.combat;
        if (combat && combat.round > 0) {
          const current = combat.order[combat.turn]?.tokenId;
          if (me.role === 'player' && current !== token.id) throw new GameError("It's not your turn.");
          if (current === token.id) {
            if (me.role === 'player' && hasCondition(token, 'grappled', 'restrained', 'paralyzed', 'stunned', 'unconscious', 'petrified', 'dead')) {
              throw new GameError(`${token.name} can't move right now (${(token.conditions ?? []).join(', ')}).`);
            }
            // Standing up from Prone costs half your speed.
            if (hasCondition(token, 'prone')) {
              combat.moved[token.id] = (combat.moved[token.id] ?? 0) + Math.floor(speedOf(room, token) / 2);
              token.conditions = (token.conditions ?? []).filter((c) => c !== 'prone');
            }
            const moved = (combat.moved[token.id] ?? 0) + dist(token, spot) * 5;
            const limit = Math.max(0, speedOf(room, token) - 5 * (token.exhaustion ?? 0)) * (combat.used[token.id]?.dash ? 2 : 1);
            if (me.role === 'player' && moved > limit + 0.5) {
              throw new GameError(`Only ${Math.max(0, Math.floor(limit - (combat.moved[token.id] ?? 0)))} ft of movement left this turn.`);
            }
            combat.moved[token.id] = moved;
          }
        }
        if (combat && combat.round > 0 && !combat.used[token.id]?.disengage) this.opportunityAlerts(room, token, spot);
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
        if (msg.stats) token.stats = sanitizeStats(msg.stats);
        if (msg.speedFt !== undefined) token.speedFt = num(msg.speedFt, 0, 300);
        this.commit(room);
        return { tokenId: token.id };
      }

      case 'token:remove': {
        requireRole(me, 'dm');
        const token = room.tokens[msg.tokenId];
        if (!token) throw new GameError('Token not found.');
        if (token.concentration) endConcentration(room, token);
        delete room.tokens[token.id];
        if (room.highlight?.tokenId === token.id) room.highlight = null;
        if (room.combat) removeFromCombat(room.combat, token.id);
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

      // ---------- hit points and conditions ----------

      case 'token:hp': {
        const token = room.tokens[msg.tokenId];
        if (!token) throw new GameError('Token not found.');
        if (me?.role !== 'dm' && !(me?.role === 'player' && token.ownerId === me.id)) throw new GameError('Not allowed.');
        const change = Math.round(num(msg.change, -9999, 9999));
        if (change < 0) applyDamage(room, token, -change, '');
        else if (change > 0) heal(room, token, change);
        if (msg.temp !== undefined) {
          const hp = hpOf(room, token);
          if (hp) hp.temp = Math.max(hp.temp, Math.round(num(msg.temp, 0, 999)));
        }
        return this.commit(room);
      }

      case 'token:conditions': {
        const token = room.tokens[msg.tokenId];
        if (!token) throw new GameError('Token not found.');
        if (me?.role !== 'dm' && !(me?.role === 'player' && token.ownerId === me.id)) throw new GameError('Not allowed.');
        token.conditions = (Array.isArray(msg.conditions) ? msg.conditions : []).filter((c) => typeof c === 'string').slice(0, 20).map((c) => c.slice(0, 30));
        return this.commit(room);
      }

      // ---------- combat ----------

      case 'combat:start': {
        requireRole(me, 'dm');
        const ids = (Array.isArray(msg.tokenIds) ? msg.tokenIds : []).filter((id) => room.tokens[id]);
        if (!ids.length) throw new GameError('Choose who is in the fight.');
        room.combat = { round: 0, turn: 0, order: ids.map((tokenId) => ({ tokenId, init: null })), moved: {}, used: {} };
        // Monsters and NPCs roll straight away; players roll on their phones.
        for (const entry of room.combat.order) {
          const t = room.tokens[entry.tokenId];
          if (t.kind !== 'player') this.recordRoll(room, rollInitiative(room, t, me!), entry);
        }
        return this.commit(room);
      }

      case 'combat:initiative': {
        const combat = room.combat;
        const entry = combat?.order.find((e) => e.tokenId === msg.tokenId);
        const token = room.tokens[msg.tokenId];
        if (!combat || !entry || !token) throw new GameError('Not in this fight.');
        if (me?.role !== 'dm' && !(me?.role === 'player' && token.ownerId === me.id)) throw new GameError('Not allowed.');
        if (msg.value !== undefined) entry.init = Math.round(num(msg.value, -10, 50));
        else this.recordRoll(room, rollInitiative(room, token, me!), entry);
        if (combat.round > 0) sortOrder(room, combat);
        await this.commit(room);
        return { init: entry.init! } satisfies Requests['combat:initiative']['result'];
      }

      case 'combat:begin': {
        requireRole(me, 'dm');
        const combat = room.combat;
        if (!combat) throw new GameError('No fight to begin.');
        for (const entry of combat.order) {
          if (entry.init === null) this.recordRoll(room, rollInitiative(room, room.tokens[entry.tokenId], me!), entry);
        }
        sortOrder(room, combat);
        Object.assign(combat, { round: 1, turn: 0, moved: {}, used: {} });
        return this.commit(room);
      }

      case 'combat:next': {
        const combat = room.combat;
        if (!combat || combat.round === 0) throw new GameError('The fight has not begun.');
        const current = room.tokens[combat.order[combat.turn]?.tokenId];
        if (me?.role !== 'dm' && !(me?.role === 'player' && current?.ownerId === me.id)) throw new GameError("It's not your turn.");
        // Next in line; defeated monsters and NPCs are skipped (players at 0 HP still roll death saves).
        for (let i = 0; i < combat.order.length; i++) {
          combat.turn += 1;
          if (combat.turn >= combat.order.length) {
            combat.turn = 0;
            combat.round += 1;
          }
          const t = room.tokens[combat.order[combat.turn].tokenId];
          if (t && !(t.kind !== 'player' && (t.conditions ?? []).includes('unconscious'))) break;
        }
        const next = combat.order[combat.turn]?.tokenId;
        if (next) {
          delete combat.moved[next];
          delete combat.used[next];
        }
        return this.commit(room);
      }

      case 'combat:end': {
        requireRole(me, 'dm');
        room.combat = null;
        return this.commit(room);
      }

      case 'combat:use': {
        const combat = room.combat;
        const token = room.tokens[msg.tokenId];
        if (!combat || !token) throw new GameError('Not in a fight.');
        if (me?.role !== 'dm' && !(me?.role === 'player' && token.ownerId === me.id)) throw new GameError('Not allowed.');
        if (!['action', 'bonus', 'reaction', 'dash', 'disengage', 'dodge', 'sneak'].includes(msg.what)) throw new GameError('Unknown.');
        combat.used[token.id] = { ...(combat.used[token.id] ?? {}), [msg.what]: !!msg.value };
        return this.commit(room);
      }

      case 'combat:rage': {
        const token = room.tokens[msg.tokenId];
        if (!token) throw new GameError('Token not found.');
        if (me?.role !== 'dm' && !(me?.role === 'player' && token.ownerId === me.id)) throw new GameError('Not allowed.');
        token.raging = !!msg.on;
        return this.commit(room);
      }

      case 'token:exhaustion': {
        const token = room.tokens[msg.tokenId];
        if (!token) throw new GameError('Token not found.');
        if (me?.role !== 'dm' && !(me?.role === 'player' && token.ownerId === me.id)) throw new GameError('Not allowed.');
        token.exhaustion = Math.round(num(msg.level, 0, 6));
        token.conditions = (token.conditions ?? []).filter((c) => c !== 'exhaustion');
        if (token.exhaustion > 0) addCondition(token, 'exhaustion');
        if (token.exhaustion >= 6) addCondition(token, 'dead');
        return this.commit(room);
      }

      case 'combat:concentrate': {
        const token = room.tokens[msg.tokenId];
        if (!token) throw new GameError('Token not found.');
        if (me?.role !== 'dm' && !(me?.role === 'player' && token.ownerId === me.id)) throw new GameError('Not allowed.');
        const old = token.concentration;
        if (old) endConcentration(room, token);
        if (msg.spell) token.concentration = { spell: cleanTitle(msg.spell), ...(msg.areaId ? { areaId: String(msg.areaId) } : {}) };
        if (old && msg.spell) this.notify(room, `${token.name} stops concentrating on ${old.spell}.`);
        return this.commit(room);
      }

      case 'combat:deathsave': {
        const token = room.tokens[msg.tokenId];
        const c = token?.characterId ? room.characters[token.characterId] : undefined;
        if (!token || !c) throw new GameError('Only characters roll death saves.');
        if (me?.role !== 'dm' && !(me?.role === 'player' && token.ownerId === me.id)) throw new GameError('Not allowed.');
        if (c.hp.current > 0) throw new GameError('Only at 0 hit points.');
        const d20 = randomInt(20);
        let note: string;
        if (d20 === 20) {
          c.hp.current = 1;
          c.deathSaves = { successes: 0, failures: 0 };
          token.conditions = (token.conditions ?? []).filter((x) => x !== 'unconscious' && x !== 'stable');
          note = 'natural 20: back up with 1 HP!';
        } else if (d20 === 1) {
          c.deathSaves.failures = Math.min(3, c.deathSaves.failures + 2);
          note = 'natural 1: two failures';
        } else if (d20 >= 10) {
          c.deathSaves.successes = Math.min(3, c.deathSaves.successes + 1);
          note = 'success';
        } else {
          c.deathSaves.failures = Math.min(3, c.deathSaves.failures + 1);
          note = 'failure';
        }
        if (c.deathSaves.successes >= 3) {
          addCondition(token, 'stable');
          note += ' · stable';
        }
        if (c.deathSaves.failures >= 3) {
          addCondition(token, 'dead');
          note += ' · dead';
        }
        const roll = this.recordRoll(room, {
          id: crypto.randomUUID(), byId: token.ownerId ?? me!.id, byName: token.name, label: `${token.name}: Death saving throw`,
          groups: [{ sides: 20, rolls: [d20], kept: [d20], total: d20 }], modifier: 0, total: d20, at: Date.now(),
          outcomes: [{ target: token.name, result: d20 >= 10 ? 'saved' : 'failed', damage: 0, note: `${note} (${c.deathSaves.successes}✓ ${c.deathSaves.failures}✗)` }],
        });
        await this.commit(room);
        return { roll } satisfies Requests['combat:deathsave']['result'];
      }

      case 'combat:heal': {
        const target = room.tokens[msg.targetId];
        const healer = msg.healerId ? room.tokens[msg.healerId] : null;
        if (!target) throw new GameError('Token not found.');
        if (me?.role !== 'dm' && !(me?.role === 'player' && healer?.ownerId === me.id)) throw new GameError('Not allowed.');
        const dice = diceList(msg.dice);
        const rolls = dice.flatMap((g) => Array.from({ length: g.count }, () => randomInt(g.sides)));
        const total = Math.max(0, rolls.reduce((a, b) => a + b, 0) + Math.round(num(msg.bonus, -10, 50)));
        heal(room, target, total);
        const roll = this.recordRoll(room, {
          id: crypto.randomUUID(), byId: me!.id, byName: healer?.name ?? me!.name,
          label: `${healer ? `${healer.name} → ` : ''}${target.name}: ${cleanTitle(msg.label) || 'Healing'}`,
          groups: dice.length ? [{ sides: dice[0].sides, rolls, kept: rolls, total }] : [], modifier: 0, total, at: Date.now(),
          outcomes: [{ target: target.name, result: 'hit', damage: 0, note: `healed ${total} HP` }],
        });
        await this.commit(room);
        return { roll } satisfies Requests['combat:heal']['result'];
      }

      case 'combat:attack': {
        const attacker = room.tokens[msg.attackerId];
        const target = room.tokens[msg.targetId];
        if (!attacker || !target) throw new GameError('Token not found.');
        if (me?.role !== 'dm' && !(me?.role === 'player' && attacker.ownerId === me.id)) throw new GameError('You can only attack with your own character.');
        const melee = !!msg.melee;
        const adv = attackAdvantage(room, attacker, target, melee, msg.advantage ?? null);
        const toHit = Math.round(num(msg.toHit, -10, 40)) - exhaustionPenalty(attacker);
        const d1 = randomInt(20);
        const d2 = adv.mode ? randomInt(20) : d1;
        const d20 = adv.mode === 'adv' ? Math.max(d1, d2) : adv.mode === 'dis' ? Math.min(d1, d2) : d1;
        const ac = acOf(room, target);
        const hit = d20 === 20 || (d20 !== 1 && d20 + toHit >= ac);
        // Hits on a paralyzed or unconscious creature from within 5 ft are critical.
        const crit = hit && (d20 === 20 || (melee && hasCondition(target, 'paralyzed', 'unconscious')));
        const outcome: RollOutcome = { target: target.name, result: crit ? 'crit' : hit ? 'hit' : 'miss', damage: 0 };
        const groups = [{ sides: 20, rolls: adv.mode ? [d1, d2] : [d1], kept: [d20], total: d20 }];
        const notes: string[] = adv.reasons.length ? [`${adv.mode === 'adv' ? 'advantage' : adv.mode === 'dis' ? 'disadvantage' : 'cancelled out'}: ${adv.reasons.join(', ')}`] : [];
        if (hit) {
          const combat = room.combat;
          const sneak = msg.sneakAttack && !(combat?.used[attacker.id]?.sneak) ? diceList([msg.sneakAttack]) : [];
          if (sneak.length && combat) combat.used[attacker.id] = { ...(combat.used[attacker.id] ?? {}), sneak: true };
          const parts = [
            { dice: diceList(msg.damage), bonus: Math.round(num(msg.damageBonus, -20, 50)), type: String(msg.damageType ?? '') },
            ...(Array.isArray(msg.extra) ? msg.extra.slice(0, 4) : []).map((x) => ({ dice: diceList([x]), bonus: 0, type: String(x?.type ?? '') })),
            ...(sneak.length ? [{ dice: sneak, bonus: 0, type: String(msg.damageType ?? '') }] : []),
          ];
          if (sneak.length) notes.push('Sneak Attack');
          for (const p of parts) {
            const rolls = p.dice.flatMap((g) => Array.from({ length: g.count * (crit ? 2 : 1) }, () => randomInt(g.sides)));
            const amount = Math.max(0, rolls.reduce((a, b) => a + b, 0) + p.bonus);
            const dealt = this.damage(room, target, amount, p.type, crit);
            outcome.damage += dealt.dealt;
            if (dealt.note) notes.push(dealt.note);
          }
          if (msg.concentration) this.concentrate(room, attacker, cleanTitle(msg.concentration));
        }
        if (notes.length) outcome.note = [...new Set(notes)].join(', ');
        const roll = this.recordRoll(room, {
          id: crypto.randomUUID(), byId: me!.id, byName: attacker.name,
          label: `${attacker.name} → ${target.name}: ${cleanTitle(msg.label) || 'attack'} (AC ${ac})`,
          groups, modifier: toHit, total: d20 + toHit, at: Date.now(), outcomes: [outcome],
        });
        await this.commit(room);
        return { roll } satisfies Requests['combat:attack']['result'];
      }

      case 'combat:save': {
        if (!me || me.role === 'table') throw new GameError('Not allowed.');
        const attacker = msg.attackerId ? room.tokens[msg.attackerId] : null;
        if (me.role === 'player' && attacker?.ownerId !== me.id) throw new GameError('You can only do this for your own character.');
        const ability = (ABILITY_KEYS as readonly string[]).includes(msg.ability) ? msg.ability : 'dex';
        const dc = Math.round(num(msg.dc, 1, 40));
        const dice = diceList(msg.damage);
        const damageRolls = dice.flatMap((g) => Array.from({ length: g.count }, () => randomInt(g.sides)));
        const total = Math.max(0, damageRolls.reduce((a, b) => a + b, 0) + Math.round(num(msg.damageBonus, -20, 50)));
        const condition = typeof msg.condition === 'string' ? msg.condition.slice(0, 30) : '';
        const applied: { tokenId: string; condition: string }[] = [];
        const outcomes: RollOutcome[] = [];
        for (const id of (Array.isArray(msg.targetIds) ? msg.targetIds : []).slice(0, 30)) {
          const target = room.tokens[id];
          if (!target) continue;
          const r = rollSave(room, target, ability);
          const saved = r.total >= dc && !r.autoFail;
          const amount = saved ? (msg.half ? Math.floor(total / 2) : 0) : total;
          const dealt = amount > 0 ? this.damage(room, target, amount, String(msg.damageType ?? ''), false) : { dealt: 0, note: '' };
          if (!saved && condition) {
            addCondition(target, condition);
            applied.push({ tokenId: target.id, condition });
          }
          outcomes.push({
            target: target.name,
            result: saved ? 'saved' : 'failed',
            damage: dealt.dealt,
            note: [r.autoFail ? 'fails automatically' : `rolled ${r.total}${r.mode ? ` (${r.mode === 'adv' ? 'advantage' : 'disadvantage'})` : ''}`, !saved && condition ? condition : '', dealt.note].filter(Boolean).join(', '),
          });
        }
        if (attacker && msg.concentration) this.concentrate(room, attacker, cleanTitle(msg.concentration), msg.areaId ? String(msg.areaId) : undefined, applied);
        const rollRecord = this.recordRoll(room, {
          id: crypto.randomUUID(), byId: me.id, byName: attacker?.name ?? me.name,
          label: `${attacker ? `${attacker.name}: ` : ''}${cleanTitle(msg.label) || 'Saving throw'} (DC ${dc} ${ability.toUpperCase()})`,
          groups: dice.length ? [{ sides: dice[0].sides, rolls: damageRolls, kept: damageRolls, total }] : [],
          modifier: 0, total, at: Date.now(), outcomes,
        });
        await this.commit(room);
        return { roll: rollRecord } satisfies Requests['combat:save']['result'];
      }

      // ---------- custom content ----------

      case 'homebrew:save': {
        if (!me || me.role === 'table') throw new GameError('Not allowed.');
        requireCampaign(room);
        const kind = msg.kind;
        if (!['species', 'classes', 'spells', 'items'].includes(kind)) throw new GameError('Unknown kind of content.');
        const list = room.homebrew[kind] as { id: string; byId: string }[];
        const existing = list.find((x) => x.id === msg.entry?.id);
        if (existing && me.role !== 'dm' && existing.byId !== me.id) throw new GameError('Only the Dungeon Master or its maker can change this.');
        const entry = sanitizeHomebrew(kind, msg.entry);
        const problem = checkHomebrew(kind, entry);
        if (problem) throw new GameError(problem);
        entry.id = existing?.id ?? crypto.randomUUID().slice(0, 8);
        entry.by = existing ? (existing as unknown as { by: string }).by : me.name;
        entry.byId = existing?.byId ?? me.id;
        (room.homebrew[kind] as unknown[]) = existing ? list.map((x) => (x.id === existing.id ? entry : x)) : [...list, entry].slice(-100);
        await this.commit(room);
        return { entryId: entry.id as string } satisfies Requests['homebrew:save']['result'];
      }

      case 'homebrew:delete': {
        const list = (room.homebrew[msg.kind] ?? []) as { id: string; byId: string }[];
        const entry = list.find((x) => x.id === msg.entryId);
        if (!entry) return null;
        if (me?.role !== 'dm' && entry.byId !== me?.id) throw new GameError('Only the Dungeon Master or its maker can delete this.');
        (room.homebrew[msg.kind] as unknown[]) = list.filter((x) => x.id !== entry.id);
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
        for (const t of Object.values(room.tokens)) if (t.concentration?.areaId === area.id) endConcentration(room, t);
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
        const oldIds = Object.keys(room.places);
        applyWorld(room, world);
        this.replacedWorld(room, oldIds);
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
          await stub.snapshot(snap.info.name, snap.world as World, snap.info.auto, snap.info.at);
        }
        await this.dmIndex(clientId).add(campaign.key);
        await this.loadCampaign(room, campaign.key);
        return { campaign } satisfies Requests['campaign:import']['result'];
      }

      // ---------- places ----------

      case 'place:generate': {
        requireRole(me, 'dm');
        if (Object.keys(room.places).length >= MAX_PLACES) throw new GameError(`A campaign can have up to ${MAX_PLACES} places. Delete some first.`);
        const context = sanitizeContext(msg.context);
        const seed = Math.floor(num(msg.seed, 0, 2 ** 31));
        const name = cleanTitle(msg.name);
        const id = newPlaceId(room);
        let place: StoredPlace;
        if (msg.entranceId) {
          const here = room.places[room.placeId];
          const entrance = here.entrances.find((e) => e.id === msg.entranceId);
          if (!entrance) throw new GameError('Entrance not found.');
          if (entrance.kind === 'exit') throw new GameError('That is the way back out.');
          if (entrance.targetId && room.places[entrance.targetId]) throw new GameError('That place has been made already.');
          const made = generateFor(entrance, here, seed, context);
          place = { ...made, ...(name ? { name } : {}), id, parentId: here.id, parentEntranceId: entrance.id };
          for (const e of place.entrances) if (e.kind === 'exit') e.targetId = here.id;
          // The people who live or work there are found inside.
          if (entrance.kind === 'building') {
            place.npcs = here.npcs.filter((n) => n.entranceId === entrance.id).map(({ entranceId: _, ...n }) => n);
            here.npcs = here.npcs.filter((n) => n.entranceId !== entrance.id);
          }
          entrance.targetId = id;
          this.touchPlace(room, here.id);
        } else {
          const kind: PlaceKind = (['village', 'building', 'cave', 'dungeon', 'blank'] as const).find((k) => k === msg.kind) ?? 'blank';
          const building = BUILDING_KINDS.find((b) => b === msg.building) ?? 'house';
          place = { ...generatePlace(kind, seed, context, name || undefined, building), id, parentId: null, parentEntranceId: null };
        }
        room.places[id] = roundNumbers(place);
        this.touchPlace(room, id);
        if (msg.go) this.goTo(room, id);
        await this.commit(room);
        return { placeId: id } satisfies Requests['place:generate']['result'];
      }

      case 'place:go': {
        requireRole(me, 'dm');
        if (!room.places[msg.placeId]) throw new GameError('Place not found.');
        this.goTo(room, msg.placeId);
        return this.commit(room);
      }

      case 'place:enter': {
        if (!me || me.role === 'table') throw new GameError('Not allowed.');
        const here = room.places[room.placeId];
        const entrance = here.entrances.find((e) => e.id === msg.entranceId && (me.role === 'dm' || !e.hidden));
        if (!entrance) throw new GameError('Entrance not found.');
        if (me.role === 'player') {
          const who = Object.values(room.characters).find((c) => c.ownerId === me.id)?.name || me.name;
          const text = entrance.kind === 'exit' ? `${who} wants to leave (${entrance.name}).` : `${who} wants to go into ${entrance.name}.`;
          this.notifyRole(room, 'dm', text);
          return null;
        }
        const target = entrance.kind === 'exit' ? (entrance.targetId ?? here.parentId) : entrance.targetId;
        if (!target || !room.places[target]) throw new GameError(entrance.kind === 'exit' ? 'This place has nothing outside it yet.' : 'Nothing has been made behind this yet.');
        this.goTo(room, target);
        return this.commit(room);
      }

      case 'place:update': {
        requireRole(me, 'dm');
        const place = room.places[msg.placeId];
        if (!place) throw new GameError('Place not found.');
        if (msg.name !== undefined) {
          const name = cleanTitle(msg.name);
          if (name) {
            for (const f of place.features) if (f.t === 'label' && f.text === place.name) f.text = name;
            // the entrance that leads here takes the new name too
            const parent = place.parentId ? room.places[place.parentId] : undefined;
            const door = parent?.entrances.find((e) => e.id === place.parentEntranceId);
            if (parent && door) {
              for (const f of parent.features) if (f.t === 'building' && f.label === door.name) f.label = name;
              door.name = name;
              this.touchPlace(room, parent.id);
            }
            place.name = name;
          }
        }
        if (msg.description !== undefined) place.context.description = String(msg.description).slice(0, 500);
        if (msg.npcs !== undefined) place.npcs = sanitizeNpcs(msg.npcs);
        if (msg.encounters !== undefined) {
          place.encounters = (Array.isArray(msg.encounters) ? msg.encounters : []).slice(0, 30).flatMap((e) =>
            typeof e?.monster === 'string' && /^[a-z0-9-]{1,60}$/.test(e.monster)
              ? [{ monster: e.monster, count: Math.round(num(e.count, 1, 20)), x: num(e.x, 0, place.size.w), y: num(e.y, 0, place.size.h) }]
              : [],
          );
        }
        if (msg.entrance) {
          const e = place.entrances.find((x) => x.id === msg.entrance!.entranceId);
          if (!e) throw new GameError('Entrance not found.');
          if (msg.entrance.name !== undefined) e.name = cleanTitle(msg.entrance.name) || e.name;
          if (msg.entrance.hidden !== undefined) e.hidden = !!msg.entrance.hidden || undefined;
        }
        this.touchPlace(room, place.id);
        return this.commit(room);
      }

      case 'place:map': {
        requireRole(me, 'dm');
        const place = room.places[msg.placeId];
        if (!place) throw new GameError('Place not found.');
        const bound = { w: place.size.w, h: place.size.h };
        place.features = sanitizeFeatures(msg.features, bound);
        place.walls = (Array.isArray(msg.walls) ? msg.walls : []).slice(0, 12000).flatMap((w) =>
          Array.isArray(w) && w.length === 4 && w.every((n) => Number.isFinite(n)) ? [w.map((n, i) => Math.round(clampTo(n, i % 2 ? bound.h : bound.w) * 100) / 100)] : [],
        );
        // Entrances keep where they lead to; new ones lead nowhere yet.
        const before = new Map(place.entrances.map((e) => [e.id, e]));
        const seen = new Set<string>();
        place.entrances = (Array.isArray(msg.entrances) ? msg.entrances : []).slice(0, 400).flatMap((e) => {
          if (!e || typeof e.id !== 'string' || seen.has(e.id) || !['building', 'cave', 'deeper', 'exit'].includes(e.kind)) return [];
          seen.add(e.id);
          const old = before.get(e.id);
          return [
            {
              id: e.id.slice(0, 40),
              name: cleanTitle(e.name) || 'Door',
              kind: e.kind,
              ...(e.kind === 'building' ? { building: BUILDING_KINDS.find((b) => b === e.building) ?? 'house' } : {}),
              x: clampTo(num(e.x, -1e6, 1e6), bound.w),
              y: clampTo(num(e.y, -1e6, 1e6), bound.h),
              targetId: old?.targetId ?? (e.kind === 'exit' ? place.parentId : null),
              ...(e.hidden ? { hidden: true } : {}),
            },
          ];
        });
        this.touchPlace(room, place.id);
        return this.commit(room);
      }

      case 'place:delete': {
        requireRole(me, 'dm');
        if (!room.places[msg.placeId]) throw new GameError('Place not found.');
        // The place and everything inside it (its buildings, cellars, deeper caves...).
        const doomed = new Set([msg.placeId]);
        for (let grew = true; grew; ) {
          grew = false;
          for (const p of Object.values(room.places)) {
            if (p.parentId && doomed.has(p.parentId) && !doomed.has(p.id)) {
              doomed.add(p.id);
              grew = true;
            }
          }
        }
        if (doomed.has(room.placeId)) throw new GameError('The party is there right now. Take them somewhere else first.');
        for (const id of doomed) {
          delete room.places[id];
          this.removedPlaces.add(id);
          this.changedPlaces.delete(id);
        }
        for (const p of Object.values(room.places)) {
          let changed = false;
          for (const e of p.entrances) {
            if (e.targetId && doomed.has(e.targetId)) {
              e.targetId = null;
              changed = true;
            }
          }
          if (changed) this.touchPlace(room, p.id);
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

  // ---------- places ----------

  /** Places saved since the last save (each place is stored under its own key). */
  private changedPlaces = new Set<string>();
  private removedPlaces = new Set<string>();

  private touchPlace(room: StoredRoom, id: string) {
    this.changedPlaces.add(id);
    if (id === room.placeId) room.placeRev++;
  }

  /** The party moves to another place; monsters and NPCs stay behind in theirs. */
  private goTo(room: StoredRoom, destId: string) {
    if (destId === room.placeId) return;
    if (room.combat) throw new GameError('End the fight before moving on.');
    const here = room.places[room.placeId];
    const dest = room.places[destId];
    // Arrive by the way you came: going back out puts you at the door you went in by.
    const door = here.parentId === dest.id ? dest.entrances.find((e) => e.id === here.parentEntranceId) : undefined;
    const at: Point = door ? { x: door.x, y: door.y } : dest.start;
    const party = Object.values(room.tokens).filter((t) => t.kind === 'player');
    here.parked = {
      tokens: Object.fromEntries(Object.values(room.tokens).filter((t) => t.kind !== 'player').map((t) => [t.id, t])),
      areas: room.areas,
    };
    room.tokens = { ...(dest.parked?.tokens ?? {}) };
    room.areas = dest.parked?.areas ?? [];
    delete dest.parked;
    room.placeId = dest.id;
    room.board = { ...dest.size };
    room.highlight = null;
    for (const t of party) {
      const spot = freeSpotNear(at, Object.values(room.tokens), room.board, (p) => crossesWall(dest, at, p));
      Object.assign(t, spot);
      room.tokens[t.id] = t;
    }
    room.view = clampToBoard(at, room.board);
    this.touchPlace(room, here.id);
    this.touchPlace(room, dest.id);
    room.placeRev++;
  }

  private notifyRole(room: StoredRoom, role: Member['role'], text: string) {
    for (const s of this.ctx.getWebSockets()) {
      const { clientId } = s.deserializeAttachment() as Attachment;
      if (room.members[clientId]?.role === role) send(s, { type: 'notice', text });
    }
  }

  // ---------- helpers ----------

  private async load(): Promise<StoredRoom | null> {
    if (this.room === undefined) {
      const stored = await this.ctx.storage.get<StoredRoom>('room');
      if (stored) {
        const places = await this.ctx.storage.list<StoredPlace>({ prefix: 'place:' });
        stored.places = Object.fromEntries([...places.values()].map((p) => [p.id, p]));
        const before = new Set(Object.keys(stored.places));
        this.room = withDefaults(stored);
        // Places made by the migration of an older game still need saving.
        for (const id of Object.keys(this.room.places)) if (!before.has(id)) this.changedPlaces.add(id);
      } else this.room = null;
    }
    return this.room;
  }

  private async save() {
    const room = this.room;
    if (!room) return;
    const { places, ...rest } = room;
    const entries: Record<string, unknown> = { room: { ...rest, places: {} } };
    for (const id of this.changedPlaces) if (places[id]) entries[`place:${id}`] = places[id];
    const keys = Object.keys(entries);
    for (let i = 0; i < keys.length; i += 100) await this.ctx.storage.put(Object.fromEntries(keys.slice(i, i + 100).map((k) => [k, entries[k]])));
    if (this.removedPlaces.size) await this.ctx.storage.delete([...this.removedPlaces].map((id) => `place:${id}`));
    this.changedPlaces.clear();
    this.removedPlaces.clear();
    await this.scheduleCleanup();
  }

  /** A whole new world was loaded (campaign opened, save point restored...): every place is saved again. */
  private replacedWorld(room: StoredRoom, oldIds: string[]) {
    for (const id of oldIds) if (!room.places[id]) this.removedPlaces.add(id);
    for (const id of Object.keys(room.places)) this.changedPlaces.add(id);
  }

  /** Saves the game (and its campaign) and sends the new state to everyone. */
  private async commit(room: StoredRoom, except?: WebSocket): Promise<null> {
    if (room.campaign) {
      const changed = [...this.changedPlaces].map((id) => room.places[id]).filter(Boolean);
      const saved = await this.campaignStub(room.campaign.key).saveWorld(room.code, { ...worldOf(room), places: {} }, changed, [...this.removedPlaces]);
      if (!saved) {
        // The campaign was opened in another game since: this game must stop using it.
        const name = room.campaign.name;
        room.campaign = null;
        room.phase = 'lobby';
        const oldIds = Object.keys(room.places);
        applyWorld(room, emptyWorld());
        this.replacedWorld(room, oldIds);
        this.notify(room, `"${name}" was opened in another game, so it was closed here.`);
      }
    }
    await this.save();
    this.broadcast(room, except);
    return null;
  }

  /** Damage plus what follows from it: concentration saves, and death save failures at 0 HP. */
  private damage(room: StoredRoom, t: Token, amount: number, type: string, crit: boolean) {
    const c = t.characterId ? room.characters[t.characterId] : undefined;
    const wasDown = (c?.hp.current ?? t.stats?.hp.current ?? 1) <= 0;
    const dealt = applyDamage(room, t, amount, type);
    const notes = [dealt.note];
    if (wasDown && c && dealt.dealt > 0) {
      c.deathSaves.failures = Math.min(3, c.deathSaves.failures + (crit ? 2 : 1));
      notes.push(`death save failure${crit ? 's' : ''}`);
      if (c.deathSaves.failures >= 3) addCondition(t, 'dead');
    }
    if (t.concentration && dealt.dealt > 0) {
      const hp = hpOf(room, t);
      const dc = Math.min(30, Math.max(10, Math.floor(dealt.dealt / 2)));
      const r = rollSave(room, t, 'con');
      if ((hp && hp.current <= 0) || r.autoFail || r.total < dc) {
        notes.push(`lost concentration on ${t.concentration.spell}`);
        endConcentration(room, t);
      } else notes.push(`kept concentration (${r.total} vs DC ${dc})`);
    }
    return { dealt: dealt.dealt, note: notes.filter(Boolean).join(', ') };
  }

  private concentrate(room: StoredRoom, t: Token, spell: string, areaId?: string, conditions?: { tokenId: string; condition: string }[]) {
    if (t.concentration) endConcentration(room, t);
    t.concentration = { spell, ...(areaId ? { areaId } : {}), ...(conditions?.length ? { conditions } : {}) };
  }

  /** Someone left an enemy's reach without Disengaging: tell whoever controls the enemy. */
  private opportunityAlerts(room: StoredRoom, mover: Token, to: Point) {
    const reachUnits = 1 + 0.9; // 5 ft reach, edge to edge
    for (const other of Object.values(room.tokens)) {
      if (other.id === mover.id || hasCondition(other, 'unconscious', 'dead', 'incapacitated', 'paralyzed', 'stunned')) continue;
      const enemies = (mover.kind === 'player') !== (other.kind === 'player') && other.kind !== 'npc' && mover.kind !== 'npc';
      if (!enemies || room.combat?.used[other.id]?.reaction) continue;
      if (dist(other, mover) <= reachUnits && dist(other, to) > reachUnits) {
        const text = `${mover.name} left ${other.name}'s reach: ${other.name} can make an opportunity attack (uses its reaction).`;
        const controllers = other.ownerId ? [other.ownerId] : Object.values(room.members).filter((m) => m.role === 'dm').map((m) => m.id);
        for (const s of this.ctx.getWebSockets()) {
          const { clientId } = s.deserializeAttachment() as Attachment;
          if (controllers.includes(clientId)) send(s, { type: 'notice', text });
        }
      }
    }
  }

  /** Keeps a roll in the game's roll history and shows it on every screen. */
  private recordRoll(room: StoredRoom, roll: DiceRoll, initiativeEntry?: { init: number | null }): DiceRoll {
    if (initiativeEntry) initiativeEntry.init = roll.total;
    room.rolls = [roll, ...room.rolls].slice(0, 20);
    for (const s of this.ctx.getWebSockets()) {
      const { clientId } = s.deserializeAttachment() as Attachment;
      if (room.members[clientId]) send(s, { type: 'dice', roll });
    }
    return roll;
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
    const oldIds = Object.keys(room.places);
    applyWorld(room, opened.world);
    this.replacedWorld(room, oldIds);
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
      homebrew: room.homebrew,
      combat: room.combat,
      placeId: room.placeId,
      placeRev: room.placeRev,
      places: [],
    };
  }

  /**
   * Sends the latest game state to every connected device (except a closing one).
   * The map of the current place is only sent to devices that don't have this version yet,
   * and players and the Main Screen get it without the DM's secrets.
   */
  private broadcast(room: StoredRoom, except?: WebSocket) {
    const base = this.state(room, except);
    const { parked: _, ...current } = room.places[room.placeId];
    const forDm = { ...base, places: Object.values(room.places).map(summarize) };
    const cache = new Map<string, string>();
    const message = (dm: boolean, withPlace: boolean) => {
      const key = `${dm}-${withPlace}`;
      if (!cache.has(key)) {
        const state: RoomState = { ...(dm ? forDm : base), ...(withPlace ? { place: dm ? current : publicPlace(current) } : {}) };
        cache.set(key, JSON.stringify({ type: 'room:state', state } satisfies ServerMessage));
      }
      return cache.get(key)!;
    };
    for (const s of this.ctx.getWebSockets()) {
      if (s === except) continue;
      const att = s.deserializeAttachment() as Attachment;
      const member = room.members[att.clientId];
      if (!member) continue; // only devices that joined see the game
      const withPlace = att.placeRev !== room.placeRev;
      try {
        s.send(message(member.role === 'dm', withPlace));
        if (withPlace) s.serializeAttachment({ ...att, placeRev: room.placeRev } satisfies Attachment);
      } catch {
        // socket already closed
      }
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

// ---------- places ----------

const BUILDING_KINDS = ['house', 'inn', 'smithy', 'temple', 'shop', 'farm', 'hall', 'ruin'] as const;

function newPlaceId(room: StoredRoom) {
  for (let n = Object.keys(room.places).length + 1; ; n++) if (!room.places[`p${n}`]) return `p${n}`;
}

function sanitizeContext(raw: unknown): PlaceContext {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Partial<PlaceContext>;
  return {
    description: typeof c.description === 'string' ? c.description.slice(0, 500) : '',
    mood: typeof c.mood === 'string' ? c.mood.slice(0, 40) : 'peaceful',
    size: c.size === 'small' || c.size === 'large' ? c.size : 'medium',
    level: Math.round(num(c.level ?? 1, 1, 20)),
  };
}

function sanitizeNpcs(raw: unknown): Npc[] {
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  return (Array.isArray(raw) ? raw : []).slice(0, 80).map((n, i) => ({
    id: str(n?.id, 40) || `n${Date.now().toString(36)}${i}`,
    name: str(n?.name, 60) || 'Someone',
    role: str(n?.role, 60),
    personality: str(n?.personality, 200),
    look: str(n?.look, 200),
    secret: str(n?.secret, 300),
    ...(typeof n?.entranceId === 'string' ? { entranceId: n.entranceId.slice(0, 40) } : {}),
  }));
}

const clampTo = (n: number, max: number) => Math.min(max + 5, Math.max(-5, n));

/** A hand-edited map from the DM: only well-formed features, with sensible numbers. */
function sanitizeFeatures(raw: unknown, bound: { w: number; h: number }): StoredPlace['features'] {
  const list = Array.isArray(raw) ? raw.slice(0, 12000) : [];
  const n = (v: unknown, max: number) => {
    const x = Number(v);
    if (!Number.isFinite(x)) throw new GameError('The map has a broken number in it.');
    return Math.round(clampTo(x, max) * 100) / 100;
  };
  const size = (v: unknown) => Math.round(num(v, 0.05, 200) * 100) / 100;
  const angle = (v: unknown) => Math.round(num(v ?? 0, -100, 100) * 1000) / 1000;
  const pt = (p: { x: unknown; y: unknown }) => ({ x: n(p?.x, bound.w), y: n(p?.y, bound.h) });
  const pts = (v: unknown, min: number) => {
    if (!Array.isArray(v) || v.length < min || v.length > 4000) throw new GameError('The map has a broken shape in it.');
    return v.map(pt);
  };
  const color = (v: unknown) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : '#888888');
  const text = (v: unknown, max = 60) => (typeof v === 'string' ? v.slice(0, max) : '');
  const one = <T,>(v: unknown, options: readonly T[], fallback: T) => options.find((o) => o === v) ?? fallback;
  const out: StoredPlace['features'] = [];
  for (const f of list as Record<string, unknown>[]) {
    if (!f || typeof f !== 'object') continue;
    switch (f.t) {
      case 'road':
      case 'water':
      case 'fence':
        out.push({ t: f.t, pts: pts(f.pts, 2), ...(f.t === 'fence' ? {} : { w: size(f.w) }) } as StoredPlace['features'][number]);
        break;
      case 'square':
      case 'rock':
        out.push({ t: f.t, poly: pts(f.poly, 3) });
        break;
      case 'field':
        out.push({ t: 'field', poly: pts(f.poly, 3), a: angle(f.a), crop: one(f.crop, ['soil', 'green', 'gold'] as const, 'soil') });
        break;
      case 'puddle':
        out.push({ t: 'puddle', poly: pts(f.poly, 3), kind: one(f.kind, ['water', 'mud', 'blood'] as const, 'water') });
        break;
      case 'floor':
        out.push({ t: 'floor', poly: pts(f.poly, 3), ...(f.room ? { room: text(f.room) } : {}), material: one(f.material, ['wood', 'stone', 'flag', 'earth', 'tile', 'cave'] as const, 'wood') });
        break;
      case 'building':
        out.push({ t: 'building', poly: pts(f.poly, 3), type: one(f.type, BUILDING_KINDS, 'house'), roof: one(f.roof, ['wood', 'slate', 'thatch'] as const, 'wood'), ...(f.ruined ? { ruined: true } : {}), ...(f.label ? { label: text(f.label) } : {}) });
        break;
      case 'bridge':
        out.push({ t: 'bridge', a: pt(f.a as Point), b: pt(f.b as Point), w: size(f.w) });
        break;
      case 'tree':
      case 'column':
      case 'debris':
        out.push({ t: f.t, x: n(f.x, bound.w), y: n(f.y, bound.h), r: size(f.r), ...(f.t === 'column' && f.round ? { round: true } : {}) } as StoredPlace['features'][number]);
        break;
      case 'well':
        out.push({ t: 'well', x: n(f.x, bound.w), y: n(f.y, bound.h) });
        break;
      case 'stall':
      case 'rug':
        out.push({ t: f.t, x: n(f.x, bound.w), y: n(f.y, bound.h), w: size(f.w), h: size(f.h), a: angle(f.a), color: color(f.color) });
        break;
      case 'furniture':
        out.push({ t: 'furniture', kind: text(f.kind, 30) || 'table', x: n(f.x, bound.w), y: n(f.y, bound.h), w: size(f.w), h: size(f.h), a: angle(f.a) });
        break;
      case 'stairs':
        out.push({ t: 'stairs', x: n(f.x, bound.w), y: n(f.y, bound.h), w: size(f.w), h: size(f.h), a: angle(f.a) });
        break;
      case 'door':
      case 'window':
        out.push({ t: f.t, x: n(f.x, bound.w), y: n(f.y, bound.h), a: angle(f.a), w: size(f.w) });
        break;
      case 'cells':
        if (typeof f.d === 'string' && f.d.length < 400000 && /^[MLZHVQAmlzhvqa0-9.,\- ]*$/.test(f.d)) out.push({ t: 'cells', d: f.d, material: one(f.material, ['wood', 'stone', 'flag', 'earth', 'tile', 'cave'] as const, 'cave') });
        break;
      case 'label':
        out.push({ t: 'label', x: n(f.x, bound.w), y: n(f.y, bound.h), text: text(f.text) });
        break;
    }
  }
  return out;
}

/** Generated maps have long decimals; two places are plenty (and keep saves small). */
function roundNumbers<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 100) / 100 : v)));
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
    autoUsed: Object.fromEntries(
      Object.entries(c.autoUsed && typeof c.autoUsed === 'object' ? c.autoUsed : {})
        .slice(0, 40)
        .map(([k, v]) => [str(k, 40), n(v, 0, 500, 0)]),
    ),
    choices: sanitizeChoices(c.choices),
    customFeatures: (Array.isArray(c.customFeatures) ? c.customFeatures : []).slice(0, 40).map((f) => ({
      name: str(f?.name, 80) || 'Feature',
      description: str(f?.description, 4000),
    })),
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
      saves: Object.fromEntries(ABILITY_KEYS.map((a) => [a, n(c.summary?.saves?.[a], -10, 30, 0)])) as Record<(typeof ABILITY_KEYS)[number], number>,
      resistances: (Array.isArray(c.summary?.resistances) ? c.summary.resistances : []).filter((r) => typeof r === 'string').slice(0, 15).map((r) => r.slice(0, 20)),
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
  if (!d || d.format !== 'dnd-campaign' || (d.version !== 1 && d.version !== 2) || !validWorld(d.world)) {
    throw new GameError('This file is not a campaign backup from this app.');
  }
  // Version 2 files keep each place once; put the places back into each save point.
  const versions = d.placeVersions && typeof d.placeVersions === 'object' ? d.placeVersions : {};
  const full = (w: World | SnapshotWorld): World => {
    if (!('placeRefs' in w) || !w.placeRefs) return w as World;
    const { placeRefs, ...rest } = w;
    const places = Object.fromEntries(Object.entries(placeRefs).flatMap(([id, hash]) => (versions[hash] ? [[id, versions[hash]]] : [])));
    return { ...rest, places } as World;
  };
  for (const p of [d.world, ...(Array.isArray(d.snapshots) ? d.snapshots.map((x) => x?.world) : [])]) {
    if (p && typeof p === 'object' && 'places' in p && p.places) for (const place of Object.values(p.places)) checkPlace(place);
  }
  return {
    ...d,
    version: 1,
    placeVersions: undefined,
    name: cleanTitle(d.name) || 'Imported campaign',
    snapshots: Array.isArray(d.snapshots) ? d.snapshots.filter((s) => s?.info && s.world).map((s) => ({ ...s, world: full(s.world) })).filter((s) => validWorld(s.world as World)).slice(0, 200) : [],
  };
}

/** A place from an uploaded file: just enough checking that it can't break the game. */
function checkPlace(p: StoredPlace) {
  const ok =
    p && typeof p.id === 'string' && typeof p.name === 'string' && p.size && Number.isFinite(p.size.w) && Number.isFinite(p.size.h) &&
    p.size.w > 0 && p.size.w <= 2000 && p.size.h > 0 && p.size.h <= 2000 &&
    Array.isArray(p.features) && Array.isArray(p.walls) && Array.isArray(p.entrances) && Array.isArray(p.npcs) && p.start && p.context;
  if (!ok) throw new GameError('This backup has a damaged map in it.');
}

const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;

/** Keeps only well-formed rule choices (see CharacterChoices). */
function sanitizeChoices(raw: unknown): Character['choices'] {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Character['choices'];
  const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 60) : undefined);
  const strs = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, max).map((x) => x.slice(0, 60)) : undefined);
  const ability = (v: unknown) => (ABILITY_KEYS as readonly string[]).includes(v as string) ? (v as (typeof ABILITY_KEYS)[number]) : undefined;
  const out: Character['choices'] = {};
  if (str(c.fightingStyle)) out.fightingStyle = str(c.fightingStyle);
  if (strs(c.expertise, 12)) out.expertise = strs(c.expertise, 12);
  if (str(c.speciesSkill)) out.speciesSkill = str(c.speciesSkill);
  if (str(c.originFeat)) out.originFeat = str(c.originFeat);
  if (strs(c.skilled, 3)) out.skilled = strs(c.skilled, 3);
  if (ability(c.lineageAbility)) out.lineageAbility = ability(c.lineageAbility);
  if (str(c.size)) out.size = str(c.size);
  if (Array.isArray(c.magicInitiate)) {
    out.magicInitiate = c.magicInitiate.slice(0, 3).map((m) => ({
      list: str(m?.list) ?? 'wizard',
      ability: ability(m?.ability) ?? 'int',
      cantrips: strs(m?.cantrips, 2) ?? [],
      spell: str(m?.spell) ?? '',
    }));
  }
  if (Array.isArray(c.levelUps)) {
    out.levelUps = c.levelUps.slice(0, 20).map((l) => ({
      level: Math.min(20, Math.max(2, Math.round(Number(l?.level) || 2))),
      hp: Math.min(30, Math.max(0, Math.round(Number(l?.hp) || 0))),
      ...(l?.asi ? { asi: Object.fromEntries(Object.entries(l.asi).filter(([k]) => ability(k)).map(([k, v]) => [k, Math.min(2, Math.max(0, Math.round(Number(v) || 0)))])) } : {}),
      ...(str(l?.feat) ? { feat: str(l?.feat) } : {}),
    }));
  }
  return out;
}

/** Keeps only known fields with the right types (the rule limits are checked by checkHomebrew). */
function sanitizeHomebrew(kind: HomebrewKind, raw: unknown): Record<string, unknown> {
  const e = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (JSON.stringify(e).length > 30_000) throw new GameError('This is too large to save.');
  const str = (v: unknown, max = 60) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const n = (v: unknown, min: number, max: number, d = min) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Math.round(Number(v)))) : d);
  const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);
  const ability = (v: unknown) => oneOf(v, ABILITY_KEYS, 'str');
  const texts = (v: unknown, max: number) =>
    (Array.isArray(v) ? v : []).slice(0, max).map((t) => ({ name: str(t?.name, 80) || 'Trait', description: str(t?.description, 3000) }));
  const base = { id: str(e.id, 40), name: str(e.name), by: '', byId: '' };
  if (kind === 'species') {
    return {
      ...base,
      size: oneOf(e.size, ['Small', 'Medium'] as const, 'Medium'),
      speed: n(e.speed, 0, 100, 30),
      darkvision: n(e.darkvision, 0, 200, 0),
      resistances: (Array.isArray(e.resistances) ? e.resistances : []).filter((r: unknown) => DAMAGE_TYPES.includes(r as string)).slice(0, 5),
      traits: texts(e.traits, 10),
    };
  }
  if (kind === 'classes') {
    return {
      ...base,
      hitDie: n(e.hitDie, 4, 20, 8),
      primary: ability(e.primary),
      saves: (Array.isArray(e.saves) ? e.saves : []).slice(0, 2).map(ability),
      skillCount: n(e.skillCount, 0, 10, 2),
      skills: (Array.isArray(e.skills) ? e.skills : []).filter((s: unknown) => typeof s === 'string').slice(0, 18).map((s: string) => s.slice(0, 40)),
      armor: (Array.isArray(e.armor) ? e.armor : []).filter((a: unknown) => ['Light', 'Medium', 'Heavy', 'Shields'].includes(a as string)),
      weapons: (Array.isArray(e.weapons) ? e.weapons : []).filter((w: unknown) => ['Simple', 'Martial'].includes(w as string)),
      caster: oneOf(e.caster, ['none', 'full', 'half', 'pact'] as const, 'none'),
      spellAbility: ability(e.spellAbility ?? 'int'),
      spellList: str(e.spellList, 40) || 'wizard',
      features: (Array.isArray(e.features) ? e.features : []).slice(0, 60).map((f: { level?: unknown; name?: unknown; description?: unknown }) => ({
        level: n(f?.level, 1, 20, 1),
        name: str(f?.name, 80) || 'Feature',
        description: str(f?.description, 3000),
      })),
      subclasses: (Array.isArray(e.subclasses) ? e.subclasses : []).filter((s: unknown) => typeof s === 'string').slice(0, 6).map((s: string) => s.slice(0, 60)),
    };
  }
  if (kind === 'spells') {
    const shapes = ['sphere', 'cone', 'cube', 'cylinder', 'emanation', 'line'] as const;
    return {
      ...base,
      level: n(e.level, 0, 9, 0),
      school: oneOf(e.school, SCHOOLS, 'Evocation'),
      classes: (Array.isArray(e.classes) ? e.classes : []).filter((c: unknown) => typeof c === 'string').slice(0, 20).map((c: string) => c.slice(0, 40)),
      castingTime: str(e.castingTime, 40) || 'Action',
      rangeFt: n(e.rangeFt, 0, 10_000, 60),
      duration: str(e.duration, 40) || 'Instantaneous',
      concentration: !!e.concentration,
      ritual: !!e.ritual,
      damage: str(e.damage, 30),
      save: e.save ? ability(e.save) : '',
      attack: oneOf(e.attack, ['', 'melee', 'ranged'] as const, ''),
      area: e.area ? { shape: oneOf(e.area.shape, shapes, 'sphere'), size: n(e.area.size, 0, 1000, 20) } : null,
      description: str(e.description, 4000),
    };
  }
  const kinds = ['weapon', 'armor', 'shield', 'gear'] as const;
  const itemKind = oneOf(e.kind, kinds, 'gear');
  return {
    ...base,
    kind: itemKind,
    description: str(e.description, 2000),
    ...(itemKind === 'weapon'
      ? {
          weapon: {
            category: oneOf(e.weapon?.category, ['simple', 'martial'] as const, 'simple'),
            damage: str(e.weapon?.damage, 10),
            type: oneOf(e.weapon?.type, DAMAGE_TYPES, 'Slashing'),
            properties: (Array.isArray(e.weapon?.properties) ? e.weapon.properties : []).filter((p: unknown) => WEAPON_PROPERTIES.includes(p as string)),
            ranged: !!e.weapon?.ranged,
            ...(e.weapon?.normal ? { normal: n(e.weapon.normal, 5, 600, 80) } : {}),
            ...(e.weapon?.long ? { long: n(e.weapon.long, 5, 1000, 320) } : {}),
          },
        }
      : {}),
    ...(itemKind === 'armor' ? { armor: { category: oneOf(e.armor?.category, ['light', 'medium', 'heavy'] as const, 'light'), base: n(e.armor?.base, 0, 30, 11) } } : {}),
  };
}

// ---------- combat helpers ----------

function speedOf(room: StoredRoom, t: Token) {
  const c = t.characterId ? room.characters[t.characterId] : undefined;
  return c?.summary.speedFt ?? t.speedFt ?? 30;
}

function acOf(room: StoredRoom, t: Token) {
  const c = t.characterId ? room.characters[t.characterId] : undefined;
  return c?.summary.ac ?? t.stats?.ac ?? 10;
}

function saveOf(room: StoredRoom, t: Token, ability: (typeof ABILITY_KEYS)[number]) {
  const c = t.characterId ? room.characters[t.characterId] : undefined;
  return c?.summary.saves?.[ability] ?? t.stats?.saves?.[ability] ?? 0;
}

function hpOf(room: StoredRoom, t: Token) {
  const c = t.characterId ? room.characters[t.characterId] : undefined;
  return c?.hp ?? t.stats?.hp ?? null;
}

function addCondition(t: Token, c: string) {
  t.conditions = [...new Set([...(t.conditions ?? []), c])];
}

/** Applies damage (resistance halves, immunity stops, vulnerability doubles; temp HP first). */
function applyDamage(room: StoredRoom, t: Token, amount: number, type: string): { dealt: number; note: string } {
  const c = t.characterId ? room.characters[t.characterId] : undefined;
  const lower = type.toLowerCase();
  const has = (list: string[] | undefined) => !!lower && (list ?? []).some((x) => x.toLowerCase().includes(lower));
  let dealt = amount;
  let note = '';
  if (has(t.stats?.immunities)) {
    dealt = 0;
    note = 'immune';
  } else if (has(c?.summary.resistances) || has(t.stats?.resistances) || (t.raging && ['bludgeoning', 'piercing', 'slashing'].includes(lower))) {
    dealt = Math.floor(amount / 2);
    note = 'resisted';
  } else if (has(t.stats?.vulnerabilities)) {
    dealt = amount * 2;
    note = 'vulnerable';
  }
  const hp = hpOf(room, t);
  if (!hp || dealt <= 0) return { dealt, note };
  const fromTemp = Math.min(hp.temp, dealt);
  hp.temp -= fromTemp;
  hp.current = Math.max(0, hp.current - (dealt - fromTemp));
  if (hp.current === 0) {
    addCondition(t, 'unconscious');
    t.raging = false;
    note = [note, 'down!'].filter(Boolean).join(', ');
  }
  return { dealt, note };
}

function heal(room: StoredRoom, t: Token, amount: number) {
  const hp = hpOf(room, t);
  if (!hp) return;
  const wasDown = hp.current <= 0;
  hp.current = Math.min(hp.max, Math.max(0, hp.current) + amount);
  if (wasDown && hp.current > 0) {
    t.conditions = (t.conditions ?? []).filter((c) => c !== 'unconscious');
    const c = t.characterId ? room.characters[t.characterId] : undefined;
    if (c) c.deathSaves = { successes: 0, failures: 0 };
  }
}

function rollInitiative(room: StoredRoom, t: Token, me: StoredMember): DiceRoll {
  const c = t.characterId ? room.characters[t.characterId] : undefined;
  const bonus = c?.summary.initiative ?? t.stats?.initiative ?? 0;
  const d20 = randomInt(20);
  return {
    id: crypto.randomUUID(), byId: t.ownerId ?? me.id, byName: t.name, label: `${t.name}: Initiative`,
    groups: [{ sides: 20, rolls: [d20], kept: [d20], total: d20 }], modifier: bonus, total: d20 + bonus, at: Date.now(),
  };
}

/** Highest initiative first; ties go to the higher bonus (players before monsters). */
function sortOrder(room: StoredRoom, combat: Combat) {
  const current = combat.order[combat.turn]?.tokenId;
  combat.order = combat.order.filter((e) => room.tokens[e.tokenId]);
  combat.order.sort((a, b) => (b.init ?? -99) - (a.init ?? -99) || Number(room.tokens[b.tokenId].kind === 'player') - Number(room.tokens[a.tokenId].kind === 'player'));
  if (combat.round > 0 && current) combat.turn = Math.max(0, combat.order.findIndex((e) => e.tokenId === current));
}

function removeFromCombat(combat: Combat, tokenId: string) {
  const i = combat.order.findIndex((e) => e.tokenId === tokenId);
  if (i < 0) return;
  combat.order.splice(i, 1);
  if (i < combat.turn) combat.turn -= 1;
  if (combat.turn >= combat.order.length) combat.turn = 0;
}

function diceList(raw: unknown): { count: number; sides: number }[] {
  return (Array.isArray(raw) ? raw : [])
    .slice(0, 6)
    .map((g) => ({ count: Math.round(num(g?.count, 0, 40)), sides: Number(g?.sides) }))
    .filter((g) => g.count > 0 && DICE.has(g.sides));
}

function sanitizeStats(raw: TokenStats): TokenStats {
  const n = (v: unknown, min: number, max: number, d: number) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Math.round(Number(v)))) : d);
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 15).map((x) => x.slice(0, 40)) : []);
  const max = n(raw?.hp?.max, 1, 9999, 1);
  return {
    hp: { max, current: n(raw?.hp?.current, 0, 9999, max), temp: n(raw?.hp?.temp, 0, 999, 0) },
    ac: n(raw?.ac, 0, 40, 10),
    saves: Object.fromEntries(ABILITY_KEYS.map((a) => [a, n(raw?.saves?.[a], -10, 30, 0)])) as TokenStats['saves'],
    initiative: n(raw?.initiative, -10, 30, 0),
    resistances: list(raw?.resistances),
    immunities: list(raw?.immunities),
    vulnerabilities: list(raw?.vulnerabilities),
    ...(typeof raw?.monster === 'string' ? { monster: raw.monster.slice(0, 60) } : {}),
  };
}

// ---------- conditions in combat ----------

function hasCondition(t: Token, ...names: string[]) {
  return (t.conditions ?? []).some((c) => names.includes(c));
}

function exhaustionPenalty(t: Token) {
  return 2 * (t.exhaustion ?? (hasCondition(t, 'exhaustion') ? 1 : 0));
}

/** Advantage or disadvantage on an attack, from the choice made and both creatures' conditions. */
function attackAdvantage(room: StoredRoom, attacker: Token, target: Token, melee: boolean, chosen: 'adv' | 'dis' | null) {
  const adv: string[] = [];
  const dis: string[] = [];
  if (chosen === 'adv') adv.push('chosen');
  if (chosen === 'dis') dis.push('chosen');
  if (hasCondition(attacker, 'blinded')) dis.push('blinded');
  if (hasCondition(attacker, 'poisoned')) dis.push('poisoned');
  if (hasCondition(attacker, 'prone')) dis.push('prone');
  if (hasCondition(attacker, 'restrained')) dis.push('restrained');
  if (hasCondition(attacker, 'frightened')) dis.push('frightened');
  if (hasCondition(attacker, 'invisible')) adv.push('unseen attacker');
  if (hasCondition(target, 'blinded')) adv.push('target blinded');
  if (hasCondition(target, 'paralyzed', 'stunned', 'unconscious', 'petrified', 'restrained')) adv.push(`target ${(target.conditions ?? []).find((c) => ['paralyzed', 'stunned', 'unconscious', 'petrified', 'restrained'].includes(c))}`);
  if (hasCondition(target, 'prone')) (melee ? adv : dis).push(melee ? 'target prone' : 'target prone (ranged)');
  if (hasCondition(target, 'invisible')) dis.push('target invisible');
  if (room.combat?.used[target.id]?.dodge) dis.push('target dodging');
  const mode: 'adv' | 'dis' | null = adv.length && !dis.length ? 'adv' : dis.length && !adv.length ? 'dis' : null;
  return { mode, reasons: [...adv, ...dis] };
}

/** A saving throw with its conditions: Paralyzed etc. fail STR/DEX saves; Restrained has disadvantage on DEX. */
function rollSave(room: StoredRoom, t: Token, ability: (typeof ABILITY_KEYS)[number]) {
  const autoFail = (ability === 'str' || ability === 'dex') && hasCondition(t, 'paralyzed', 'stunned', 'unconscious', 'petrified');
  const mode: 'adv' | 'dis' | null = ability === 'dex' && hasCondition(t, 'restrained') ? 'dis' : room.combat?.used[t.id]?.dodge && ability === 'dex' ? 'adv' : null;
  const d1 = randomInt(20);
  const d2 = mode ? randomInt(20) : d1;
  const d20 = mode === 'adv' ? Math.max(d1, d2) : mode === 'dis' ? Math.min(d1, d2) : d1;
  return { total: d20 + saveOf(room, t, ability) - exhaustionPenalty(t), autoFail, mode };
}

/** Ends a creature's concentration: its spell area disappears and the conditions it caused end. */
function endConcentration(room: StoredRoom, t: Token) {
  const conc = t.concentration;
  if (!conc) return;
  if (conc.areaId) room.areas = room.areas.filter((a) => a.id !== conc.areaId);
  for (const { tokenId, condition } of conc.conditions ?? []) {
    const other = room.tokens[tokenId];
    if (other) other.conditions = (other.conditions ?? []).filter((c) => c !== condition);
  }
  delete t.concentration;
}
