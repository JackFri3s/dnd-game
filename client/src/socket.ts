import { io, type Socket } from 'socket.io-client';
import type { ClientToServer, Role, ServerToClient } from '../../shared/protocol.ts';

export const socket: Socket<ServerToClient, ClientToServer> = io({
  transports: ['websocket', 'polling'],
});

// ---- small, failure-proof browser storage helpers ----
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null) {
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
  role: Role;
}

export function loadSession(role: Role): SavedSession | null {
  const raw = read(`dnd.session.${role}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SavedSession;
  } catch {
    return null;
  }
}

export function saveSession(session: SavedSession | null, role: Role) {
  write(`dnd.session.${role}`, session ? JSON.stringify(session) : null);
}

/** Sends a request and waits for the server's answer. Throws with a friendly message on failure. */
export function request<E extends keyof ClientToServer>(
  event: E,
  ...args: Parameters<ClientToServer[E]> extends [...infer A, infer _Ack] ? A : never
): Promise<
  Parameters<ClientToServer[E]> extends [...unknown[], infer AckFn]
    ? AckFn extends (res: infer R) => void
      ? R extends { ok: true; data: infer D }
        ? D
        : never
      : never
    : never
> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The server did not answer. Check your connection.')), 8000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (socket.emit as any)(event, ...args, (res: { ok: boolean; data?: unknown; error?: string }) => {
      clearTimeout(timer);
      if (res.ok) resolve(res.data as never);
      else reject(new Error(res.error));
    });
  });
}
