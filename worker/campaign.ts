import { DurableObject } from 'cloudflare:workers';
import type { CampaignSummary, SnapshotInfo, StoredPlace, World } from '../shared/protocol.ts';

/** How many automatic save points to keep (manual ones are always kept). */
const MAX_AUTO_SNAPSHOTS = 20;

interface Meta {
  key: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** The game (room code) that currently has this campaign open. Only it may save. */
  activeRoom: string | null;
}

/**
 * A backup file. Version 2 keeps each version of a place once (`placeVersions`);
 * save points refer to them with `placeRefs` instead of carrying every map again.
 */
export interface CampaignExport {
  format: 'dnd-campaign';
  version: 1 | 2;
  name: string;
  exportedAt: number;
  world: World;
  snapshots: { info: SnapshotInfo; world: World | SnapshotWorld }[];
  placeVersions?: Record<string, StoredPlace>;
}

/** A save point as stored: its places by content hash (most places never change, so they're stored once). */
export type SnapshotWorld = Omit<World, 'places'> & { places?: undefined; placeRefs: Record<string, string> };

/** The world without its places (they're stored under their own keys). */
const bare = (w: World): Omit<World, 'places'> & { places: Record<string, never> } => ({ ...w, places: {} });

async function hashOf(place: StoredPlace) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(place)));
  return [...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * One campaign: the saved world (map, tokens, ...) plus its save points.
 * A campaign is addressed by its secret key; anyone with the key can open it.
 * While being played, the game (GameRoom) writes every change here.
 */
export class Campaign extends DurableObject<Env> {
  private async meta(): Promise<Meta | null> {
    return (await this.ctx.storage.get<Meta>('meta')) ?? null;
  }

  async create(key: string, name: string, world: World): Promise<boolean> {
    if (await this.meta()) return false;
    const now = Date.now();
    await this.ctx.storage.put<Meta>('meta', { key, name, createdAt: now, updatedAt: now, activeRoom: null });
    await this.writeWorld(world, Object.values(world.places ?? {}), []);
    return true;
  }

  private async writeWorld(world: World, changed: StoredPlace[], removed: string[]) {
    const entries: Record<string, unknown> = { world: bare(world) };
    for (const p of changed) entries[`place:${p.id}`] = p;
    // put() takes at most 128 keys at once
    const keys = Object.keys(entries);
    for (let i = 0; i < keys.length; i += 100) await this.ctx.storage.put(Object.fromEntries(keys.slice(i, i + 100).map((k) => [k, entries[k]])));
    if (removed.length) await this.ctx.storage.delete(removed.map((id) => `place:${id}`));
  }

  private async readWorld(): Promise<World> {
    const world = (await this.ctx.storage.get<World>('world'))!;
    const places = await this.ctx.storage.list<StoredPlace>({ prefix: 'place:' });
    // Campaigns from before places existed kept nothing here; the game adds a first place.
    const loaded = Object.fromEntries([...places.values()].map((p) => [p.id, p]));
    return { ...world, places: Object.keys(loaded).length ? loaded : (world.places ?? {}) };
  }

  async summary(): Promise<CampaignSummary | null> {
    const meta = await this.meta();
    if (!meta) return null;
    return { key: meta.key, name: meta.name, createdAt: meta.createdAt, updatedAt: meta.updatedAt };
  }

  /** A game opens the campaign. Any game that had it open before loses the right to save. */
  async open(roomCode: string): Promise<{ summary: CampaignSummary; world: World } | null> {
    const meta = await this.meta();
    if (!meta) return null;
    meta.activeRoom = roomCode;
    await this.ctx.storage.put('meta', meta);
    return { summary: (await this.summary())!, world: await this.readWorld() };
  }

  /**
   * Saves the world. Only the places that changed are passed (`world.places` is ignored).
   * Returns false if another game has opened the campaign since.
   */
  async saveWorld(roomCode: string, world: World, changed: StoredPlace[] = [], removed: string[] = []): Promise<boolean> {
    const meta = await this.meta();
    if (!meta || meta.activeRoom !== roomCode) return false;
    meta.updatedAt = Date.now();
    await this.ctx.storage.put('meta', meta);
    await this.writeWorld(world, changed, removed);
    return true;
  }

  async rename(name: string) {
    const meta = await this.meta();
    if (!meta) return;
    meta.name = name;
    await this.ctx.storage.put('meta', meta);
  }

  async listSnapshots(): Promise<SnapshotInfo[]> {
    return (await this.ctx.storage.get<SnapshotInfo[]>('snapshots')) ?? [];
  }

  async snapshot(name: string, world: World, auto: boolean, at = Date.now()): Promise<SnapshotInfo> {
    const info: SnapshotInfo = { id: crypto.randomUUID(), name, at, auto };
    let list = [info, ...(await this.listSnapshots())];
    // Drop the oldest automatic save points beyond the limit.
    const autos = list.filter((s) => s.auto);
    const drop = new Set(autos.slice(MAX_AUTO_SNAPSHOTS).map((s) => s.id));
    list = list.filter((s) => !drop.has(s.id));
    const placeRefs: Record<string, string> = {};
    for (const p of Object.values(world.places ?? {})) {
      const hash = await hashOf(p);
      placeRefs[p.id] = hash;
      if (!(await this.ctx.storage.get(`pv:${hash}`))) await this.ctx.storage.put(`pv:${hash}`, p);
    }
    const stored: SnapshotWorld = { ...world, places: undefined, placeRefs };
    await this.ctx.storage.put({ snapshots: list, [`snap:${info.id}`]: stored });
    if (drop.size) {
      await this.ctx.storage.delete([...drop].map((id) => `snap:${id}`));
      await this.collectPlaceVersions();
    }
    return info;
  }

  async getSnapshot(id: string): Promise<World | null> {
    const snap = await this.ctx.storage.get<World | SnapshotWorld>(`snap:${id}`);
    if (!snap) return null;
    if (!('placeRefs' in snap) || !snap.placeRefs) return snap as World; // saved before places existed
    const { placeRefs, ...world } = snap;
    const places: Record<string, StoredPlace> = {};
    for (const [placeId, hash] of Object.entries(placeRefs)) {
      const p = await this.ctx.storage.get<StoredPlace>(`pv:${hash}`);
      if (p) places[placeId] = p;
    }
    return { ...world, places } as World;
  }

  async deleteSnapshot(id: string) {
    const list = (await this.listSnapshots()).filter((s) => s.id !== id);
    await this.ctx.storage.put('snapshots', list);
    await this.ctx.storage.delete(`snap:${id}`);
    await this.collectPlaceVersions();
  }

  /** Deletes stored place versions no save point refers to any more. */
  private async collectPlaceVersions() {
    const used = new Set<string>();
    for (const info of await this.listSnapshots()) {
      const snap = await this.ctx.storage.get<SnapshotWorld>(`snap:${info.id}`);
      for (const h of Object.values(snap?.placeRefs ?? {})) used.add(h);
    }
    const unused = [...(await this.ctx.storage.list({ prefix: 'pv:' })).keys()].filter((k) => !used.has(k.slice(3)));
    for (let i = 0; i < unused.length; i += 100) await this.ctx.storage.delete(unused.slice(i, i + 100));
  }

  async exportAll(): Promise<CampaignExport | null> {
    const meta = await this.meta();
    if (!meta) return null;
    const infos = await this.listSnapshots();
    const snapshots: CampaignExport['snapshots'] = [];
    const placeVersions: Record<string, StoredPlace> = {};
    for (const info of infos) {
      const snap = await this.ctx.storage.get<World | SnapshotWorld>(`snap:${info.id}`);
      if (!snap) continue;
      if ('placeRefs' in snap && snap.placeRefs) {
        for (const hash of Object.values(snap.placeRefs)) {
          placeVersions[hash] ??= (await this.ctx.storage.get<StoredPlace>(`pv:${hash}`))!;
        }
      }
      snapshots.push({ info, world: snap });
    }
    return {
      format: 'dnd-campaign',
      version: 2,
      name: meta.name,
      exportedAt: Date.now(),
      world: await this.readWorld(),
      snapshots,
      placeVersions,
    };
  }
}

/** The list of campaigns one DM device knows about. */
export class DmIndex extends DurableObject<Env> {
  async list(): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>('keys')) ?? [];
  }
  async add(key: string) {
    const keys = await this.list();
    if (!keys.includes(key)) await this.ctx.storage.put('keys', [key, ...keys]);
  }
  async remove(key: string) {
    await this.ctx.storage.put('keys', (await this.list()).filter((k) => k !== key));
  }
}
