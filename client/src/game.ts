import { useSyncExternalStore } from 'react';
import type { Member, RequestName, Requests, Role, RoomState } from '../../shared/protocol.ts';
import {
  GameConnection,
  clientId,
  createRoom,
  loadSession,
  saveSession,
  type ConnectionStatus,
  type EndReason,
} from './socket.ts';

export interface GameSnapshot {
  code: string | null; // the game this device is connected to
  me: Member | null; // set once this device has joined
  state: RoomState | null;
  status: ConnectionStatus;
  ended: EndReason | null;
  notice: string | null;
}

const EMPTY: GameSnapshot = { code: null, me: null, state: null, status: 'closed', ended: null, notice: null };

/**
 * Everything one screen knows about its game, plus the actions it can take.
 * Screens read it with `useGame(store)`.
 */
export class GameStore {
  private snap: GameSnapshot = EMPTY;
  private listeners = new Set<() => void>();
  private conn: GameConnection | null = null;

  constructor(readonly role: Role) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snap;

  private set(patch: Partial<GameSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    if (patch.state) {
      this.snap.me = patch.state.members.find((m) => m.id === clientId) ?? null;
    }
    this.listeners.forEach((fn) => fn());
  }

  /** Goes back into the game this device was in last time (if any). Returns whether it tried. */
  resume(): boolean {
    const saved = loadSession(this.role);
    if (!saved || this.conn) return false;
    this.open(saved.code);
    return true;
  }

  /** Main Screen only: start a brand new game. */
  async create() {
    const { code } = await createRoom();
    saveSession({ code }, this.role);
    this.open(code);
  }

  async join(code: string, args: Requests['join']['args']) {
    if (this.conn?.code !== code) this.open(code);
    await this.conn!.ready();
    const { member } = await this.conn!.request('join', args);
    saveSession({ code }, this.role);
    this.set({ me: member, notice: null });
  }

  async leave() {
    await this.conn?.request('leave', {}).catch(() => {});
    saveSession(null, this.role);
    this.disconnect();
    this.set({ ...EMPTY });
  }

  request<K extends RequestName>(type: K, args: Requests[K]['args']) {
    if (!this.conn) return Promise.reject(new Error('Not in a game.'));
    return this.conn.request(type, args);
  }

  dismissNotice() {
    this.set({ notice: null });
  }

  /** Connects to a game without joining it (used to look at it while joining). */
  open(code: string) {
    this.disconnect();
    this.set({ ...EMPTY, code, status: 'connecting' });
    const conn = new GameConnection(code, {
      onOpen: () => {
        // Every time the connection (re)opens, tell the game we're back.
        if (loadSession(this.role)?.code !== code) return;
        conn.request('rejoin', {}).then(
          ({ member }) => this.set({ me: member, notice: null }),
          (e: Error) => {
            if (conn !== this.conn) return;
            saveSession(null, this.role);
            this.disconnect();
            this.set({ ...EMPTY, notice: e.message });
          },
        );
      },
      onState: (state) => {
        if (conn !== this.conn) return;
        // The map of the current place is only sent when it changes: keep the one we have.
        const prev = this.snap.state;
        if (!state.place && prev?.place && prev.placeId === state.placeId) state = { ...state, place: prev.place };
        this.set({ state });
      },
      onNotice: (text) => conn === this.conn && this.set({ notice: text }),
      onStatus: (status) => conn === this.conn && this.set({ status }),
      onEnd: (reason) => {
        if (conn !== this.conn) return;
        this.conn = null;
        if (reason !== 'replaced') saveSession(null, this.role);
        const notice =
          reason === 'kicked'
            ? 'The Dungeon Master removed you from the game.'
            : reason === 'replaced'
              ? 'This game was opened in another tab or on another device.'
              : 'That game no longer exists.';
        this.set({ ...EMPTY, code: reason === 'replaced' ? code : null, ended: reason, notice });
      },
    });
    this.conn = conn;
    conn.start();
  }

  private disconnect() {
    this.conn?.close();
    this.conn = null;
  }
}

export function useGame(store: GameStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
