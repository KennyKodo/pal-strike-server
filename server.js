// Pal Strike co-op relay server (Node.js + ws, Render free tier).
// No database, no auth, no accounts. Rooms are keyed by a 4-letter code.
// Design: host-authoritative. The HOST client simulates enemies, bosses,
// stage rebuilds, wave state, weather and time-of-day and broadcasts
// compact world snapshots (~10Hz). Every client sends its own player state
// (~15-20Hz). Game events (hits, Pal casts, Ult casts, pickups, ...) are
// relayed to the room; the host applies the game-logic ones, every client
// renders the visual ones. Friendly fire is OFF (enforced client-side:
// damage events only ever target enemies or the event sender's own team
// state via the host).
'use strict';

const http = require('http');
const WebSocket = require('ws');

const MAX_PLAYERS = 8;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I / O (confusable)

const rooms = new Map(); // code -> { code, players: Map<ws, player>, order: [ws], host: ws, started: bool, createdAt }

function makeCode() {
  let code = '';
  for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return rooms.has(code) ? makeCode() : code;
}

function publicPlayer(p) { return { id: p.id, name: p.name, host: p.host }; }

function broadcast(room, msg, exceptWs) {
  const data = JSON.stringify(msg);
  for (const ws of room.players.keys()) {
    if (ws !== exceptWs && ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function cleanupRoom(room) {
  if (room.players.size === 0) {
    rooms.delete(room.code);
    return;
  }
  // Host migration: promote the next-joined player.
  if (!room.players.has(room.host)) {
    const next = room.order.find((w) => room.players.has(w));
    if (next) {
      room.host = next;
      const p = room.players.get(next);
      p.host = true;
      broadcast(room, { t: 'hostChange', newHostId: p.id, newHostName: p.name });
    }
  }
}

function removeFromRoom(ws) {
  const room = ws._room;
  if (!room) return;
  const p = room.players.get(ws);
  room.players.delete(ws);
  room.order = room.order.filter((w) => w !== ws);
  ws._room = null;
  if (p) broadcast(room, { t: 'playerLeft', id: p.id, name: p.name });
  cleanupRoom(room);
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Pal Strike co-op relay\n');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  ws._room = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg.t !== 'string') return;

    if (msg.t === 'create') {
      if (ws._room) return;
      const code = makeCode();
      const room = { code, players: new Map(), order: [], host: ws, started: false, createdAt: Date.now() };
      rooms.set(code, room);
      const p = { id: 'p' + Math.random().toString(36).slice(2, 8), name: String(msg.name || 'Player').slice(0, 16) || 'Player', host: true };
      room.players.set(ws, p);
      room.order.push(ws);
      ws._room = room;
      send(ws, { t: 'created', code, playerId: p.id, host: true });
      return;
    }

    if (msg.t === 'join') {
      if (ws._room) return;
      const code = String(msg.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) { send(ws, { t: 'error', msg: 'Room not found. Check the code.' }); return; }
      if (room.started) { send(ws, { t: 'error', msg: 'That game already started.' }); return; }
      if (room.players.size >= MAX_PLAYERS) { send(ws, { t: 'error', msg: 'Room is full (8 players).' }); return; }
      const p = { id: 'p' + Math.random().toString(36).slice(2, 8), name: String(msg.name || 'Player').slice(0, 16) || 'Player', host: false };
      room.players.set(ws, p);
      room.order.push(ws);
      ws._room = room;
      send(ws, {
        t: 'joined', code, playerId: p.id, host: false,
        players: [...room.players.values()].map(publicPlayer)
      });
      broadcast(room, { t: 'playerJoined', player: publicPlayer(p) }, ws);
      return;
    }

    const room = ws._room;
    if (!room) return;

    if (msg.t === 'start') {
      if (ws !== room.host || room.started) return;
      room.started = true;
      broadcast(room, { t: 'gameStart', players: [...room.players.values()].map(publicPlayer) });
      return;
    }

    if (msg.t === 'leave') { removeFromRoom(ws); return; }

    // Relay: player state + snapshots + game events go to the rest of the room.
    // Snapshots are only forwarded from the current host (a stale host's
    // snapshots must never overwrite the new host's world).
    if (msg.t === 'snap' && ws !== room.host) return;
    if (msg.t === 'player' || msg.t === 'snap' || msg.t === 'ev') {
      broadcast(room, msg, ws);
      return;
    }
  });

  ws.on('close', () => removeFromRoom(ws));
  ws.on('error', () => { try { ws.close(); } catch (e) { /* noop */ } });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Pal Strike co-op relay listening on port ' + PORT);
});
