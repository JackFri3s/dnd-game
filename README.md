# dnd

A digital tabletop role-playing game (5th Edition, 2024 rules) for a group around a real table:

- **Main Screen**: a tablet or TV in the middle of the table showing the shared map.
- **Players**: each uses their own phone for their character.
- **Dungeon Master**: controls everything from their own device.

See [DESIGN.md](DESIGN.md) for the full plan.

## Status

Steps 1–5 of the build order are done: **connecting the screens**, **the map board**, **saving**, **rules and characters** and **movement and ranges**.

- Open `/table` on the Main Screen: it shows a game code and QR code. It needs no touch screen.
- Players scan the QR code (or open `/join`), choose **Player** or **Dungeon Master**, enter their name and pick their seat.
- The **DM** picks or creates a **campaign**, then starts it. The DM calibrates the Main Screen with a bank card so distances fit miniatures (5 ft = 1 inch); each Main Screen remembers its calibration.
- The Main Screen shows the map at true size; the DM chooses which part it shows.
- Players drag their own token; the DM and the Main Screen (if it has touch) can move any token. The DM adds monster and NPC tokens.
- Movement and range areas can be shown around a token on every screen.
- **Saving:** everything is saved to the campaign after every change. Next session, open a new game on the Main Screen, the DM opens the campaign, and everyone is back in the same situation (players on the same phone get their own token back; the DM can hand a token to someone on a new phone).
- **Save points:** the DM can make save points and go back to any of them (one is made automatically at the start of every session, and before going back).
- **Backups:** the DM can download a campaign as a file and upload it again. A **campaign key** lets the DM open the campaign from another device.
- **Settings** (home menu): distances in feet or metres, and light/dark appearance.
- **Characters** (step 4): players create their character on their phone, either **step by step** (class, background and species, ability scores by rolling 4d6-drop-lowest, the standard array or point buy, skills, equipment, spells, details) or by **entering an existing character** (the app works out the numbers and warns about anything that doesn't add up). The DM can make pre-made characters and hand characters to players.
- **Character sheet**, laid out like the official 2024 sheet: name, level, XP, background, class, species and subclass; armour class, hit points (damage/heal/temp), hit dice and death saves; proficiency, heroic inspiration, initiative, speed, size and passive perception; each ability with its saving throw and skills; a weapons, cantrips & damage table; limited-use features; spellcasting with slots; class features, species traits, feats, equipment training and equipment. Tap any number to roll it (attacks and damage too); **dice are rolled by the server** and shown on the Main Screen at the roller's seat.
- **Roll me a character**: pick a class, species and background (or let chance decide), roll the dice, and keep the ready level-1 character or roll again.


- **Gridless map with true ranges** (step 5): tokens move freely; dragging shows the distance in feet or metres. Each weapon shows its reach or normal/long range, each spell its range (measured from the edge of the creature's space), and spells with an area (sphere, cone, line, cube, cylinder, emanation; 73 spells) can be aimed on the map and cast as true shapes, using a spell slot. Areas stay on every screen until removed.
- **Controls position**: during play the controls can sit at the bottom, top, left or right of the map (automatic: at the side on wide screens).
- **Two looks** (Settings): **Minimal** (greyscale) or **Parchment** (the fantasy paper-and-ink look), each in light or dark. In both, movement is green, attacks are red and spells are purple.

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
| `worker/` | The game server on Cloudflare: `index.ts` is the front door, `room.ts` is one game, `campaign.ts` stores campaigns and save points (all Durable Objects). |
| `shared/` | Definitions used by both, like the messages and the seats. |
| `wrangler.jsonc` | Cloudflare settings. |

## Rules content

The rules come from the **System Reference Document 5.2.1** (the free 2024 rules), via the open-source [5e-database](https://github.com/5e-bits/5e-database) project. `scripts/build-rules.mjs` turns it into `client/src/rules/srd-2024.json`.

> This work includes material from the System Reference Document 5.2.1 ("SRD 5.2.1") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.
