import {
  CLOSE_KICKED,
  CLOSE_NO_ROOM,
  CLOSE_REPLACED,
  type RequestName,
  type Requests,
  type Role,
  type RoomState,
  type ServerMessage,
} from '../../shared/protocol.ts';

// ---- small, failure-proof browser storage helpers ----
export function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage unavailable (private mode): the app still works, it just can't auto-rejoin
  }
}

/** A random id for this device, kept so it can rejoin the same game after a reload. */
export const clientId: string = (() => {
  let id = read('dnd.clientId');
  if (!id) {
    id = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    write('dnd.clientId', id);
  }
  return id;
})();

export interface SavedSession {
  code: string;
}
export function loadSession(role: Role): SavedSession | null {
  try {
    return JSON.parse(read(`dnd.session.${role}`) ?? 'null');
  } catch {
    return null;
  }
}
export function saveSession(session: SavedSession | null, role: Role) {
  write(`dnd.session.${role}`, session ? JSON.stringify(session) : null);
}

// ---- HTTP ----
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { 'content-type': 'application/json' } });
  } catch {
    throw new Error('Could not reach the server. Check your connection.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? 'Something went wrong.');
  return body as T;
}

export const createRoom = () =>
  api<{ code: string }>('/api/rooms', { method: 'POST', body: JSON.stringify({ clientId }) });
export const peekRoom = (code: string) => api<RoomState>(`/api/rooms/${code}`);

// ---- live connection to one game ----

export type ConnectionStatus = 'connecting' | 'open' | 'closed';
export type EndReason = 'kicked' | 'replaced' | 'no-room';

interface Handlers {
  onOpen: () => void; // connected (again): a good moment to rejoin
  onState: (state: RoomState) => void;
  onStatus: (status: ConnectionStatus) => void;
  onEnd: (reason: EndReason) => void; // the game won't reconnect by itself
}

/**
 * Keeps one WebSocket open to a game and reconnects automatically
 * (phone locked, Wi-Fi dropped, server update), with growing pauses.
 */
export class GameConnection {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private retry = 0;
  private retryTimer: number | undefined;
  private stopped = false;
  private waiters: { resolve: () => void; reject: (e: Error) => void }[] = [];

  constructor(
    readonly code: string,
    private handlers: Handlers,
  ) {}

  start() {
    this.connect();
    window.addEventListener('online', this.reconnectNow);
    document.addEventListener('visibilitychange', this.onVisible);
  }

  /** Resolves once the connection is open (or rejects if the game ends first). */
  ready(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.stopped) return Promise.reject(new Error('Not connected.'));
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  request<K extends RequestName>(type: K, args: Requests[K]['args']): Promise<Requests[K]['result']> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        reject(new Error('Not connected to the game right now. Trying again…'));
        return;
      }
      const id = this.nextId++;
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('The server did not answer. Check your connection.'));
      }, 8000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as Requests[K]['result']);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, type, ...args }));
    });
  }

  close() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    window.removeEventListener('online', this.reconnectNow);
    document.removeEventListener('visibilitychange', this.onVisible);
    this.ws?.close(1000);
    this.ws = null;
    for (const w of this.waiters.splice(0)) w.reject(new Error('Not connected.'));
  }

  private connect() {
    if (this.stopped) return;
    this.handlers.onStatus('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/${this.code}?clientId=${encodeURIComponent(clientId)}`);
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.handlers.onStatus('open');
      for (const w of this.waiters.splice(0)) w.resolve();
      this.handlers.onOpen();
    };
    ws.onmessage = (e) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === 'reply') {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.ok) p?.resolve(msg.data);
        else p?.reject(new Error(msg.error));
      } else if (msg.type === 'room:state') this.handlers.onState(msg.state);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      for (const p of this.pending.values()) p.reject(new Error('Connection lost.'));
      this.pending.clear();
      this.handlers.onStatus('closed');
      const end: EndReason | null =
        e.code === CLOSE_KICKED ? 'kicked' : e.code === CLOSE_REPLACED ? 'replaced' : e.code === CLOSE_NO_ROOM ? 'no-room' : null;
      if (end) {
        const message =
          end === 'no-room' ? (e.reason || 'No game found with this code.') : end === 'kicked' ? 'You were removed from the game.' : 'Opened somewhere else.';
        for (const w of this.waiters.splice(0)) w.reject(new Error(message));
        this.close();
        this.handlers.onEnd(end);
        return;
      }
      // Try again after 0.5s, 1s, 2s, 4s ... up to 15s.
      const delay = Math.min(15000, 500 * 2 ** this.retry++);
      this.retryTimer = window.setTimeout(() => this.connect(), delay);
    };
  }

  private reconnectNow = () => {
    if (this.stopped || this.ws) return;
    clearTimeout(this.retryTimer);
    this.connect();
  };

  private onVisible = () => {
    if (document.visibilityState === 'visible') this.reconnectNow();
  };
}
