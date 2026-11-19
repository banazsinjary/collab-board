const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- HTTP: room creation and lookup ----------
app.post('/api/rooms', (req, res) => {
  const name = cleanText(req.body?.name, 80) || 'Untitled room';
  res.status(201).json(db.createRoom(name));
});

app.get('/api/rooms/:id', (req, res) => {
  const room = db.getRoom(String(req.params.id).toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json(room);
});

app.get('/room/:id', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'room.html')));
app.get('/healthz', (_req, res) => res.send('ok'));

// ---------- Real time ----------
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 8000 });

// Presence lives in memory and is derived from live socket connections only.
// roomId -> Map(socketId -> { id, name, color, editing })
const presence = new Map();
const USER_COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#0f9fa8', '#d6338a', '#6b8e23', '#9a6324', '#000075'];
const NOTE_COLORS = ['#fff59d', '#ffcc80', '#a5d6a7', '#90caf9', '#f48fb1', '#ce93d8'];

function cleanText(v, max) {
  return typeof v === 'string' ? v.slice(0, max).trim() : '';
}
function num(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}
const BOARD_W = 4000, BOARD_H = 3000;

function roomUsers(roomId) {
  return [...(presence.get(roomId)?.values() || [])];
}
function broadcastPresence(roomId) {
  io.to(roomId).emit('presence', roomUsers(roomId));
}
function pickUserColor(roomId) {
  const used = new Set(roomUsers(roomId).map((u) => u.color));
  return USER_COLORS.find((c) => !used.has(c)) || USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)];
}

function leaveRoom(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return;
  const users = presence.get(roomId);
  users?.delete(socket.id);
  if (users && users.size === 0) presence.delete(roomId);
  socket.leave(roomId);
  socket.data.roomId = null;
  socket.to(roomId).emit('cursor:leave', { id: socket.id });
  broadcastPresence(roomId);
}

io.on('connection', (socket) => {
  // Every mutating handler goes through this guard so a socket can only touch the room it joined.
  const inRoom = (handler) => (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!socket.data.roomId) return reply({ ok: false, error: 'Not in a room' });
    try {
      handler(payload || {}, reply, socket.data.roomId, socket.data.user);
    } catch (err) {
      console.error(err);
      reply({ ok: false, error: 'Server error' });
    }
  };

  socket.on('join', ({ roomId, name } = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const id = String(roomId || '').toUpperCase();
    const room = db.getRoom(id);
    if (!room) return reply({ ok: false, error: 'Room not found' });
    if (socket.data.roomId) leaveRoom(socket);

    const user = { id: socket.id, name: cleanText(name, 30) || 'Guest', color: pickUserColor(id), editing: null };
    socket.data.roomId = id;
    socket.data.user = user;
    socket.join(id);
    if (!presence.has(id)) presence.set(id, new Map());
    presence.get(id).set(socket.id, user);

    // Full snapshot from the database: this is what makes reconnect/rejoin always show the latest state.
    reply({ ok: true, room, you: user, items: db.listItems(id), users: roomUsers(id) });
    broadcastPresence(id);
  });

  socket.on('cursor', inRoom(({ x, y }, _reply, roomId, user) => {
    if (x === null) return socket.to(roomId).emit('cursor:leave', { id: user.id });
    const cx = num(x, 0, BOARD_W), cy = num(y, 0, BOARD_H);
    if (cx === null || cy === null) return;
    // volatile: if a cursor packet is dropped, the next one supersedes it anyway
    socket.volatile.to(roomId).emit('cursor', { id: user.id, name: user.name, color: user.color, x: cx, y: cy });
  }));

  socket.on('item:create', inRoom((p, reply, roomId, user) => {
    const x = num(p.x, 0, BOARD_W - 200) ?? 100;
    const y = num(p.y, 0, BOARD_H - 160) ?? 100;
    const color = NOTE_COLORS.includes(p.color) ? p.color : NOTE_COLORS[Math.floor(Math.random() * NOTE_COLORS.length)];
    const item = db.createItem(roomId, { text: cleanText(p.text, 2000), x, y, color }, user.name);
    reply({ ok: true, item });
    socket.to(roomId).emit('item:upsert', item);
  }));

  socket.on('item:move', inRoom((p, reply, roomId) => {
    const x = num(p.x, 0, BOARD_W - 200), y = num(p.y, 0, BOARD_H - 160);
    if (x === null || y === null) return reply({ ok: false, error: 'Bad position' });
    const item = db.moveItem(roomId, String(p.id), x, y, !!p.front);
    if (!item) return reply({ ok: false, deleted: true });
    reply({ ok: true, item });
    socket.to(roomId).emit('item:upsert', item);
  }));

  socket.on('item:edit', inRoom((p, reply, roomId, user) => {
    const text = typeof p.text === 'string' ? p.text.slice(0, 2000) : '';
    const result = db.editItem(roomId, String(p.id), text, Number(p.baseVersion), user.name);
    reply(result);
    if (result.ok) socket.to(roomId).emit('item:upsert', result.item);
  }));

  socket.on('item:delete', inRoom((p, reply, roomId, user) => {
    const deleted = db.deleteItem(roomId, String(p.id));
    reply({ ok: deleted });
    if (deleted) socket.to(roomId).emit('item:deleted', { id: String(p.id), by: user.name });
  }));

  // Soft lock: tells everyone who is currently typing in which note.
  socket.on('item:focus', inRoom((p, _reply, roomId, user) => {
    user.editing = p.id ? String(p.id) : null;
    broadcastPresence(roomId);
  }));

  socket.on('disconnect', () => leaveRoom(socket));
});

server.listen(PORT, () => console.log(`Collab board listening on http://localhost:${PORT}`));

function shutdown() {
  io.close();
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
