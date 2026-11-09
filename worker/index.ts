import { CODE_LENGTH, CODE_LETTERS } from '../shared/protocol.ts';
export { GameRoom } from './room.ts';
export { Campaign, DmIndex } from './campaign.ts';

// The Worker is the front door: it serves the game API and sends each
// game's connections to that game's own GameRoom (a Durable Object).
// Everything else (the web app's files) is served by Cloudflare directly.

const CODE = `[A-Za-z]{${CODE_LENGTH}}`;
const ROOM_PATH = new RegExp(`^/api/rooms/(${CODE})$`);
const WS_PATH = new RegExp(`^/ws/(${CODE})$`);

function room(env: Env, code: string) {
  return env.GAME_ROOM.get(env.GAME_ROOM.idFromName(code.toUpperCase()));
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
}

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes, (b) => CODE_LETTERS[b % CODE_LETTERS.length]).join('');
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    // Main Screen creates a new game.
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as { clientId?: unknown } | null;
      const clientId = body?.clientId;
      if (typeof clientId !== 'string' || !clientId || clientId.length > 100) {
        return json({ error: 'Invalid device id.' }, 400);
      }
      for (let attempt = 0; attempt < 20; attempt++) {
        const code = randomCode();
        if (await room(env, code).init(code, clientId)) return json({ code });
      }
      return json({ error: 'Could not create a game. Please try again.' }, 503);
    }

    // Look at a game before joining (to see free seats and whether there's a DM).
    const peek = url.pathname.match(ROOM_PATH);
    if (peek && request.method === 'GET') {
      const state = await room(env, peek[1]).getState();
      return state
        ? json(state)
        : json({ error: `No game found with code "${peek[1].toUpperCase()}".` }, 404);
    }

    // A device connects to a game.
    const ws = url.pathname.match(WS_PATH);
    if (ws) {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return json({ error: 'Expected a WebSocket connection.' }, 426);
      }
      return room(env, ws[1]).fetch(request);
    }

    return json({ error: 'Not found.' }, 404);
  },
} satisfies ExportedHandler<Env>;
