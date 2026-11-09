# dnd

A digital tabletop role-playing game (5th Edition, 2024 rules) for a group around a real table:

- **Main Screen**: a tablet or TV in the middle of the table showing the shared map.
- **Players**: each uses their own phone for their character.
- **Dungeon Master**: controls everything from their own device.

See [DESIGN.md](DESIGN.md) for the full plan.

## Status

Step 1 of the build order is done: **connecting the screens.**

- Open `/table` on the Main Screen: it creates a game and shows a game code and QR code.
- Players scan the QR code (or open `/join` and type the code), enter their name and choose their seat around the table.
- The DM opens `/dm` and types the code. Only one DM per game.
- The Main Screen shows each player's name at their seat, turned to face them.
- Phones that reload or lose connection rejoin automatically. The DM can remove players.

Games are stored by Cloudflare, so they survive server restarts and updates. (Saving the full game, such as map, characters and combat, comes with those features.)

## Run it on your computer

Requires [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm run dev
```

Then open <http://localhost:5173>. Phones on the same Wi-Fi can open the "Network" address that the command prints. This runs a local copy of Cloudflare, so it behaves like the real thing.

## Hosting: Cloudflare Workers

The game runs on **Cloudflare Workers**. Each game gets its own **Durable Object**: a small server on Cloudflare that every device in that game connects to, and that stores the game.

**One-time setup (in the Cloudflare dashboard):**
1. Go to **Workers & Pages → Create → Import a repository** and pick `dnd-game` (connect GitHub if asked).
2. Use these settings: project name **`dnd`**, build command **`npm run build`**, deploy command **`npx wrangler deploy`**. Leave the rest as is.
3. Click **Deploy**. When it's done, the game is at `https://dnd.<your-account>.workers.dev`.
4. Optional: to use your own address, open the Worker → **Settings → Domains & Routes → Add → Custom domain** and enter e.g. `dnd.chasingthemoon.org`.

After that, every change pushed to the `main` branch goes live automatically.

You can also deploy from your own computer with `npm run deploy` (it asks you to log in to Cloudflare the first time).

## Project layout

| Folder | What's in it |
|---|---|
| `client/` | The web app all screens use (React). |
| `worker/` | The game server on Cloudflare: `index.ts` is the front door, `room.ts` is one game (a Durable Object). |
| `shared/` | Definitions used by both, like the messages and the seats. |
| `wrangler.jsonc` | Cloudflare settings. |
