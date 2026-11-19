// SQLite persistence layer (uses Node's built-in node:sqlite, no native build step).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'board.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS rooms (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS items (
    id           TEXT PRIMARY KEY,
    room_id      TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    text         TEXT NOT NULL DEFAULT '',
    x            REAL NOT NULL,
    y            REAL NOT NULL,
    z            INTEGER NOT NULL DEFAULT 0,
    color        TEXT NOT NULL,
    text_version INTEGER NOT NULL DEFAULT 1,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    updated_by   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_items_room ON items(room_id);
`);

// Room codes avoid look-alike characters (0/O, 1/I/L) so they are easy to read aloud.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newRoomCode() {
  const bytes = crypto.randomBytes(6);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

const q = {
  insertRoom: db.prepare('INSERT INTO rooms (id, name, created_at) VALUES (?, ?, ?)'),
  getRoom: db.prepare('SELECT id, name, created_at FROM rooms WHERE id = ?'),
  listItems: db.prepare('SELECT * FROM items WHERE room_id = ? ORDER BY z ASC'),
  getItem: db.prepare('SELECT * FROM items WHERE id = ? AND room_id = ?'),
  maxZ: db.prepare('SELECT COALESCE(MAX(z), 0) AS z FROM items WHERE room_id = ?'),
  insertItem: db.prepare(`INSERT INTO items
    (id, room_id, text, x, y, z, color, text_version, created_at, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`),
  moveItem: db.prepare('UPDATE items SET x = ?, y = ?, z = ?, updated_at = ? WHERE id = ? AND room_id = ?'),
  // Compare-and-swap: only succeeds if nobody else changed the text since the client read it.
  editItem: db.prepare(`UPDATE items
    SET text = ?, text_version = text_version + 1, updated_at = ?, updated_by = ?
    WHERE id = ? AND room_id = ? AND text_version = ?`),
  deleteItem: db.prepare('DELETE FROM items WHERE id = ? AND room_id = ?'),
};

module.exports = {
  createRoom(name) {
    for (let i = 0; i < 10; i++) {
      const id = newRoomCode();
      try {
        q.insertRoom.run(id, name, Date.now());
        return q.getRoom.get(id);
      } catch (e) {
        if (!String(e.message).includes('UNIQUE')) throw e; // retry only on code collision
      }
    }
    throw new Error('Could not allocate a room code');
  },
  getRoom: (id) => q.getRoom.get(id),
  listItems: (roomId) => q.listItems.all(roomId),
  getItem: (roomId, id) => q.getItem.get(id, roomId),

  createItem(roomId, { text, x, y, color }, userName) {
    const id = crypto.randomUUID();
    const now = Date.now();
    const z = q.maxZ.get(roomId).z + 1;
    q.insertItem.run(id, roomId, text, x, y, z, color, now, now, userName);
    return q.getItem.get(id, roomId);
  },

  // Position is last-writer-wins: a move never destroys anyone's content.
  moveItem(roomId, id, x, y, bringToFront) {
    const item = q.getItem.get(id, roomId);
    if (!item) return null;
    const z = bringToFront ? q.maxZ.get(roomId).z + 1 : item.z;
    q.moveItem.run(x, y, z, Date.now(), id, roomId);
    return q.getItem.get(id, roomId);
  },

  // Returns { ok, item } on success, { ok:false, conflict, item } or { ok:false, deleted }.
  editItem(roomId, id, text, baseVersion, userName) {
    const res = q.editItem.run(text, Date.now(), userName, id, roomId, baseVersion);
    const item = q.getItem.get(id, roomId);
    if (!item) return { ok: false, deleted: true };
    if (res.changes === 1) return { ok: true, item };
    return { ok: false, conflict: true, item };
  },

  deleteItem: (roomId, id) => q.deleteItem.run(id, roomId).changes === 1,
  close: () => db.close(),
};
