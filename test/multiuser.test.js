// End-to-end test: starts the real server on a temp database, connects several
// socket clients, and checks every requirement from the brief, including a server restart.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert/strict');
const { io } = require('socket.io-client');

const PORT = 3999;
const URL = `http://localhost:${PORT}`;
const DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'collab-')), 'test.db');
let server;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function startServer() {
  return new Promise((resolve) => {
    server = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT, DB_PATH }, stdio: ['ignore', 'pipe', 'inherit'],
    });
    server.stdout.on('data', (d) => d.toString().includes('listening') && resolve());
  });
}
function stopServer() {
  return new Promise((resolve) => { server.once('exit', resolve); server.kill('SIGTERM'); });
}
function client() {
  return io(URL, { transports: ['websocket'], forceNew: true, reconnection: false });
}
const emit = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));
const next = (s, ev, pred = () => true, ms = 2000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => { s.off(ev, h); reject(new Error(`timeout waiting for ${ev}`)); }, ms);
  function h(d) { if (pred(d)) { clearTimeout(t); s.off(ev, h); resolve(d); } }
  s.on(ev, h);
});
async function connectAndJoin(roomId, name) {
  const s = client();
  await next(s, 'connect');
  const res = await emit(s, 'join', { roomId, name });
  return { s, res };
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log('  ✓', name);
}

(async () => {
  await startServer();
  try {
    // 1. Room creation and access
    const room = await (await fetch(`${URL}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Demo' }) })).json();
    const other = await (await fetch(`${URL}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Other' }) })).json();
    await check('rooms get unique 6-char codes', () => {
      assert.match(room.id, /^[A-Z0-9]{6}$/);
      assert.notEqual(room.id, other.id);
    });
    await check('room link serves the app; unknown code is rejected', async () => {
      assert.equal((await fetch(`${URL}/room/${room.id}`)).status, 200);
      assert.equal((await fetch(`${URL}/api/rooms/NOPE99`)).status, 404);
      const { s, res } = await connectAndJoin('NOPE99', 'X');
      assert.equal(res.ok, false);
      s.close();
    });

    // 2. Presence
    const a = await connectAndJoin(room.id, 'Alice');
    const bPresence = next(a.s, 'presence', (list) => list.length === 2);
    const b = await connectAndJoin(room.id.toLowerCase(), 'Bob'); // codes are case-insensitive
    await check('presence updates for everyone when someone joins', async () => {
      const list = await bPresence;
      assert.deepEqual(list.map((u) => u.name).sort(), ['Alice', 'Bob']);
      assert.equal(b.res.users.length, 2);
    });

    // Room isolation: a user in another room sees nothing from this room
    const c = await connectAndJoin(other.id, 'Carol');
    let leaked = false;
    c.s.onAny((ev) => { if (ev !== 'presence') leaked = true; });

    // 3. Cursors
    await check('cursor moves reach the other user with name attached', async () => {
      const got = next(b.s, 'cursor');
      a.s.emit('cursor', { x: 120, y: 340 });
      const cur = await got;
      assert.equal(cur.name, 'Alice');
      assert.equal(cur.x, 120);
      assert.equal(cur.y, 340);
    });

    // 4. Shared workspace: add, move, edit, delete
    let item;
    await check('create is broadcast to the other user', async () => {
      const got = next(b.s, 'item:upsert');
      const res = await emit(a.s, 'item:create', { x: 50, y: 60, text: 'hello' });
      item = res.item;
      assert.equal((await got).id, item.id);
    });
    await check('move is broadcast and persisted', async () => {
      const got = next(a.s, 'item:upsert', (i) => i.x === 300);
      await emit(b.s, 'item:move', { id: item.id, x: 300, y: 200, front: true });
      assert.equal((await got).y, 200);
    });
    await check('edit is broadcast with a bumped version', async () => {
      const got = next(b.s, 'item:upsert', (i) => i.text === 'hello world');
      const res = await emit(a.s, 'item:edit', { id: item.id, text: 'hello world', baseVersion: item.text_version });
      assert.equal(res.ok, true);
      assert.equal((await got).text_version, item.text_version + 1);
      item = res.item;
    });

    // 5. Concurrent edits to the same note
    await check('simultaneous edits: one wins, the other gets a conflict (no silent overwrite)', async () => {
      const base = item.text_version;
      const [ra, rb] = await Promise.all([
        emit(a.s, 'item:edit', { id: item.id, text: 'Alice version', baseVersion: base }),
        emit(b.s, 'item:edit', { id: item.id, text: 'Bob version', baseVersion: base }),
      ]);
      const winner = ra.ok ? ra : rb, loser = ra.ok ? rb : ra;
      assert.equal(winner.ok, true);
      assert.equal(loser.conflict, true);
      assert.equal(loser.item.text, winner.item.text, 'loser receives the winning text to resolve against');
      // loser resolves by explicitly choosing to keep their text on top of the latest version
      const resolved = await emit(ra.ok ? b.s : a.s, 'item:edit', { id: item.id, text: 'merged', baseVersion: loser.item.text_version });
      assert.equal(resolved.ok, true);
      item = resolved.item;
    });
    await check('moving a note does not cause a text conflict', async () => {
      await emit(b.s, 'item:move', { id: item.id, x: 10, y: 10 });
      const res = await emit(a.s, 'item:edit', { id: item.id, text: 'still fine', baseVersion: item.text_version });
      assert.equal(res.ok, true);
      item = res.item;
    });
    await check('editing a note someone deleted reports deletion', async () => {
      const tmp = (await emit(a.s, 'item:create', { x: 0, y: 0, text: 'temp' })).item;
      const got = next(a.s, 'item:deleted');
      await emit(b.s, 'item:delete', { id: tmp.id });
      assert.equal((await got).by, 'Bob');
      const res = await emit(a.s, 'item:edit', { id: tmp.id, text: 'x', baseVersion: tmp.text_version });
      assert.equal(res.deleted, true);
    });
    await check('editing-indicator (soft lock) is shared through presence', async () => {
      const got = next(b.s, 'presence', (l) => l.some((u) => u.name === 'Alice' && u.editing === item.id));
      a.s.emit('item:focus', { id: item.id });
      await got;
    });

    await check('rooms are isolated', async () => {
      assert.equal(leaked, false);
      const res = await emit(c.s, 'item:edit', { id: item.id, text: 'hijack', baseVersion: item.text_version });
      assert.equal(res.ok, false);
      const res2 = await emit(c.s, 'item:delete', { id: item.id });
      assert.equal(res2.ok, false);
      assert.equal(c.res.items.length, 0);
    });

    await check('presence updates when someone leaves', async () => {
      const got = next(a.s, 'presence', (l) => l.length === 1);
      b.s.close();
      assert.equal((await got)[0].name, 'Alice');
    });

    // Rejoin after disconnect sees the latest state
    await check('rejoining shows the latest saved state', async () => {
      const b2 = await connectAndJoin(room.id, 'Bob');
      const it = b2.res.items.find((i) => i.id === item.id);
      assert.equal(it.text, 'still fine');
      assert.equal(it.x, 10);
      b2.s.close();
    });

    a.s.close(); c.s.close();
    await sleep(100);

    // Everyone gone + server restart: content must survive
    await stopServer();
    await startServer();
    await check('content survives all users leaving and a server restart', async () => {
      const d = await connectAndJoin(room.id, 'Dana');
      assert.equal(d.res.ok, true);
      assert.equal(d.res.users.length, 1, 'presence is not stale after restart');
      const it = d.res.items.find((i) => i.id === item.id);
      assert.equal(it.text, 'still fine');
      d.s.close();
    });

    console.log(`\nAll ${passed} checks passed.`);
  } catch (err) {
    console.error('\nFAILED:', err);
    process.exitCode = 1;
  } finally {
    await stopServer();
  }
})();
