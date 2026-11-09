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

Games are kept in the server's memory for now; saving to a database is step 3.

## Run it on your computer

Requires [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm run dev
```

Then open <http://localhost:5173>. Phones on the same Wi-Fi can open the "Network" address that the command prints.

## Put it online (free, on Render)

1. Create an account at <https://render.com> and connect your GitHub account.
2. Choose **New → Blueprint** and pick this repository. Render reads `render.yaml` and sets everything up.
3. After a few minutes you get a web address like `https://dnd-xxxx.onrender.com`. Open `/table` on that address on the Main Screen.

The free plan sleeps after 15 minutes without visitors; the first visit after that takes about a minute to wake it up.

## Project layout

| Folder | What's in it |
|---|---|
| `client/` | The web app all screens use (React). |
| `server/` | The game server that connects the screens (Node.js, Socket.IO). |
| `shared/` | Definitions used by both, like the list of messages and seats. |
