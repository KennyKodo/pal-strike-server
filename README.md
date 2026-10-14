# Pal Strike — Co-op Relay Server

Host-authoritative relay for the Pal Strike 8-player CO-OP mode. No database,
no auth, no accounts. The HOST player's game simulates enemies, bosses,
stage rebuilds, waves, weather and time-of-day; this server just forwards
player state, world snapshots and game events between the players in a room.

## Deploy it yourself (free, Render)

1. Put this folder in a GitHub repo (e.g. `pal-strike-coop-server`).
   Only these files are needed: `server.js`, `package.json`, `render.yaml`.
2. Create a free account at render.com (or sign in).
3. Dashboard → **New → Web Service** → connect your repo.
   Render reads `render.yaml` automatically: Node, free plan,
   start command `node server.js`, health check `/health`.
4. Wait for the deploy to finish. Copy your service URL, e.g.
   `https://pal-strike-coop.onrender.com`.
5. In the game client (`pal-strike/game.js`), set the constant near the top:
   `COOP_SERVER_URL = 'wss://pal-strike-coop.onrender.com';`
   (same host as the Render URL, but with the `wss://` scheme).
   Re-zip the client folder and re-upload the zip to itch.io.
6. In-game: menu → **CO-OP** → type your name → **CREATE ROOM** (you are the
   host) or **JOIN ROOM** (enter the host's 4-letter code). The lobby lists
   everyone; the host presses **START** when everyone is in.

## Free-tier behaviour (Render)

- The server **sleeps after 15 minutes with no players**. The first person
  to open CO-OP after a quiet stretch sees "Waking server…" for ~30–60
  seconds while Render wakes it up. The game retries automatically.
- Free tier: 512 MB RAM, shared CPU — plenty for 8 players (the server only
  relays small messages; it renders nothing).
- If the host disconnects mid-game, the next-joined player is promoted to
  host automatically ("You are now host") and the game continues.
- Rooms are in-memory only: restarting the server clears all rooms (players
  just create a new room). No scores or names are stored on the server.
- **Pal Strike 2.1:** rooms stay joinable after the game started
  (drop-in joins; the join reply carries `started: true`). The host —
  and ONLY the host — can regenerate the room code (`regenCode`
  message): the server broadcasts `codeChanged` to the room and the old
  code stops working immediately. Non-host refresh attempts get an
  error. The code otherwise NEVER changes: not on joins, leaves, game
  start, or host migration (the new host inherits the same code).

## Protocol (for reference)

JSON over WebSocket. Client → server: `create`, `join`, `start`, `leave`,
`player` (own state ~15Hz), `snap` (host world snapshot ~10Hz, host only),
`ev` (game events), `regenCode` (host-only room-code refresh).
Server → clients: `created`, `joined`, `playerJoined`, `codeChanged`,
`playerLeft`, `hostChange`, `gameStart`, `error`, plus relayed `player` /
`snap` / `ev` messages (never echoed back to the sender).

Run locally: `npm install && node server.js` (listens on `PORT`, default 3000;
`GET /health` returns `{"ok":true}`).
