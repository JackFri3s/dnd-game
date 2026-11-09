import { DurableObject } from 'cloudflare:workers';
import type { CampaignSummary, SnapshotInfo, World } from '../shared/protocol.ts';

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

export interface CampaignExport {
  format: 'dnd-campaign';
  version: 1;
  name: string;
  exportedAt: number;
  world: World;
  snapshots: { info: SnapshotInfo; world: World }[];
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
    await this.ctx.storage.put('world', world);
    return true;
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
    const world = (await this.ctx.storage.get<World>('world'))!;
    return { summary: (await this.summary())!, world };
  }

  /** Saves the world. Returns false if another game has opened the campaign since. */
  async saveWorld(roomCode: string, world: World): Promise<boolean> {
    const meta = await this.meta();
    if (!meta || meta.activeRoom !== roomCode) return false;
    meta.updatedAt = Date.now();
    await this.ctx.storage.put({ meta, world });
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
    await this.ctx.storage.put({ snapshots: list, [`snap:${info.id}`]: world });
    if (drop.size) await this.ctx.storage.delete([...drop].map((id) => `snap:${id}`));
    return info;
  }

  async getSnapshot(id: string): Promise<World | null> {
    return (await this.ctx.storage.get<World>(`snap:${id}`)) ?? null;
  }

  async deleteSnapshot(id: string) {
    const list = (await this.listSnapshots()).filter((s) => s.id !== id);
    await this.ctx.storage.put('snapshots', list);
    await this.ctx.storage.delete(`snap:${id}`);
  }

  async exportAll(): Promise<CampaignExport | null> {
    const meta = await this.meta();
    if (!meta) return null;
    const infos = await this.listSnapshots();
    const snapshots = [];
    for (const info of infos) {
      const world = await this.getSnapshot(info.id);
      if (world) snapshots.push({ info, world });
    }
    return {
      format: 'dnd-campaign',
      version: 1,
      name: meta.name,
      exportedAt: Date.now(),
      world: (await this.ctx.storage.get<World>('world'))!,
      snapshots,
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
