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

const rooms = new Map(); // code -> { id, code, players: Map<ws, player>, order: [ws], host: ws, started: bool, wave: number, createdAt }
const roomsById = new Map(); // room id -> room (2.5 lobby browser)

function makeCode() {
  let code = '';
  for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return rooms.has(code) ? makeCode() : code;
}

function publicPlayer(p) { return { id: p.id, name: p.name, host: p.host }; }

// 2.5: public lobby listing — no codes, no private data. The host's name,
// player count, started state, and current wave (tracked from host
// snapshots) are all a joining player needs to pick a lobby.
function publicRoom(room) {
  const host = room.players.get(room.host);
  return {
    id: room.id,
    hostName: host ? host.name : 'Host',
    players: room.players.size,
    started: room.started,
    wave: room.wave || 0
  };
}

function makeRoomId() {
  let id = '';
  for (let i = 0; i < 8; i++) id += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return roomsById.has(id) ? makeRoomId() : id;
}

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
    roomsById.delete(room.id);
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
      const room = { id: makeRoomId(), code, players: new Map(), order: [], host: ws, started: false, wave: 0, createdAt: Date.now() };
      rooms.set(code, room);
      roomsById.set(room.id, room);
      const p = { id: 'p' + Math.random().toString(36).slice(2, 8), name: String(msg.name || 'Player').slice(0, 16) || 'Player', host: true };
      room.players.set(ws, p);
      room.order.push(ws);
      ws._room = room;
      send(ws, { t: 'created', code, roomId: room.id, playerId: p.id, host: true });
      return;
    }

    if (msg.t === 'join') {
      if (ws._room) return;
      // 2.5: join by lobby room id; older versions still join by code.
      const room = msg.roomId ? roomsById.get(String(msg.roomId)) : rooms.get(String(msg.code || '').toUpperCase().trim());
      const code = room ? room.code : String(msg.code || '').toUpperCase().trim();
      if (!room) { send(ws, { t: 'error', msg: 'Room not found. Check the code.' }); return; }
      // Pal Strike 2.1: rooms stay joinable after the game started
      // (drop-in joins). Full rooms still reject.
      if (room.players.size >= MAX_PLAYERS) { send(ws, { t: 'error', msg: 'Room is full (8 players).' }); return; }
      const p = { id: 'p' + Math.random().toString(36).slice(2, 8), name: String(msg.name || 'Player').slice(0, 16) || 'Player', host: false };
      room.players.set(ws, p);
      room.order.push(ws);
      ws._room = room;
      send(ws, {
        t: 'joined', code, roomId: room.id, playerId: p.id, host: false,
        started: room.started,
        players: [...room.players.values()].map(publicPlayer)
      });
      broadcast(room, { t: 'playerJoined', player: publicPlayer(p) }, ws);
      return;
    }

    // 2.5: public lobby list — every open room, no code needed to browse.
    if (msg.t === 'listLobbies') {
      send(ws, { t: 'lobbies', lobbies: [...rooms.values()].map(publicRoom) });
      return;
    }

    if (msg.t === 'regenCode') {
      const room = ws._room;
      if (!room) return;
      const p = room.players.get(ws);
      if (!p || !p.host || ws !== room.host) {
        send(ws, { t: 'error', msg: 'Only the host can change the room code.' });
        return;
      }
      const oldCode = room.code;
      let newCode = makeCode();
      while (newCode === oldCode) { newCode = makeCode(); } // never re-issue the old code
      rooms.delete(oldCode);
      room.code = newCode;
      rooms.set(newCode, room);
      // The room id never changes on a code refresh (2.5 lobby joins keep working).
      broadcast(room, { t: 'codeChanged', code: newCode });
      return;
    }

    const room = ws._room;
    if (!room) return;

    if (msg.t === 'start') {
      if (ws !== room.host || room.started) return;
      room.started = true;
      broadcast(room, { t: 'gameStart', roomId: room.id, players: [...room.players.values()].map(publicPlayer) });
      return;
    }

    if (msg.t === 'leave') { removeFromRoom(ws); return; }

    // Relay: player state + snapshots + game events go to the rest of the room.
    // Snapshots are only forwarded from the current host (a stale host's
    // snapshots must never overwrite the new host's world).
    if (msg.t === 'snap' && ws !== room.host) return;
    // 2.5: track the room's current wave from host snapshots for the lobby list.
    if (msg.t === 'snap' && ws === room.host && typeof msg.wave === 'number') { room.wave = msg.wave; }
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
