# Collab Board

A real-time, multi-user sticky-note board. Create a room, share the link or 6-character code, and everyone in the room sees each other's presence and cursors and can add, move, edit, and delete notes live. Everything is saved to a database, so the board is still there after everyone leaves or the server restarts.

## Run locally

Requires Node.js 22.5 or newer (uses the built-in `node:sqlite` module, so there is no native build step).

```bash
npm install
npm start            # http://localhost:3000
npm test             # end-to-end multi-user test (15 checks, includes a server restart)
```

Open the app in two different browsers (or one normal + one private window), create a room in one, and join with the link or code in the other.

## Architecture

```
Browser (HTML + vanilla JS)          Node.js server                      SQLite
┌──────────────────────────┐  WS   ┌──────────────────────────────┐   ┌──────────┐
│ board, notes, cursors,   │◄────► │ Express (rooms API, static)  │   │ rooms    │
│ participant list,        │       │ Socket.IO (one channel/room) │──►│ items    │
│ conflict dialog          │ HTTP  │ in-memory presence map       │   └──────────┘
└──────────────────────────┘◄────► └──────────────────────────────┘
```

- **Stack:** Node.js, Express, Socket.IO, SQLite (WAL mode). The frontend is plain HTML/CSS/JS with no build step.
- **Files:** `server.js` (HTTP + real-time handlers), `db.js` (schema and queries), `public/` (landing page, room page, client logic), `test/multiuser.test.js`.

### Rooms and access
`POST /api/rooms` creates a room with a random 6-character code (an alphabet without look-alike characters such as 0/O and 1/I). The shareable link is `/room/<CODE>`, and the code can also be typed on the home page. Each room maps to its own Socket.IO room, and every database query is scoped by `room_id`. A socket can only act on the room it joined: the server stores the room on the socket after `join` and ignores any room id sent with later events. The test suite checks that a user in another room cannot read, edit, or delete notes in this room.

### Real-time synchronization
The client sends intents (`item:create`, `item:move`, `item:edit`, `item:delete`). The server validates them, writes to SQLite, replies to the sender with the saved row (an acknowledgement), and broadcasts the saved row to everyone else in the room. The database is the source of truth: clients render what the server saved, not what they guessed.

### Presence
Presence is kept in server memory and comes only from live socket connections. A user is added on `join` and removed on the socket's `disconnect` event, which also fires when a tab closes or the network drops (detected by Socket.IO heartbeats within about 20 seconds). After every change the server broadcasts the full participant list, so clients never maintain their own list. Presence also carries which note each person is typing in, shown as a colored "Alice is editing" border on that note (a soft lock).

### Live cursors
Clients send their pointer position in board coordinates (not screen coordinates, so people with different window sizes and scroll positions still line up), throttled to about 30 updates per second. The server relays them as volatile messages: cursors are not stored, and a dropped packet is simply replaced by the next one.

### Persistence
Rooms and notes are stored in SQLite (`rooms`, `items` tables). On every join and every reconnect, the client receives a full snapshot from the database, so someone who closes the browser or loses connection sees the latest saved state when they come back. Content does not depend on anyone being connected. The test suite stops and restarts the server and checks that notes are still there.

### Concurrent editing
Different kinds of change are handled differently, on purpose:

| Change | Strategy | Why |
|---|---|---|
| Move | Last writer wins | Position is easy to see and fix; a move never destroys content. |
| Text edit | Optimistic concurrency with a version number | Text is real work and must not be silently overwritten. |
| Delete while someone is editing | The editor is told and can restore their text as a new note | Their unsaved text is not lost. |

For text, each note has a `text_version`. When a user starts editing, the client remembers the version it started from. Saves run as a single compare-and-swap SQL statement:

```sql
UPDATE items SET text = ?, text_version = text_version + 1 ...
WHERE id = ? AND room_id = ? AND text_version = ?   -- the version the client started from
```

If someone else saved first, zero rows change and the server returns a conflict with the current saved text. The client then shows both versions and lets the user choose **Keep mine**, **Use theirs**, or **Keep both**. Because the check runs inside the database statement, two saves that arrive at the same moment cannot both succeed. Moving a note does not change `text_version`, so drags never cause false text conflicts. The "is editing" indicator makes conflicts less likely in the first place, and the version check catches the cases it doesn't prevent.

If the connection drops while someone is typing, their draft stays in the note. When the connection comes back, the client rejoins, reloads the snapshot, and sends the draft through the same version check.

### Trade-offs and limits
- Presence lives in a single server's memory. Running several server instances would need a shared adapter (for example the Socket.IO Redis adapter) and a shared database such as Postgres.
- Conflicts are resolved per note, not merged character by character. A CRDT library (such as Yjs) would allow live co-typing in one note, at the cost of more complexity than this brief calls for.
- There are no accounts: names are self-chosen and anyone with the link can join.

## Deploy

The app needs a host that supports WebSockets and a **persistent disk** for the SQLite file. Set `DB_PATH` to a path on that disk.

**Railway (one option):**
1. Push this repo to GitHub, then create a new Railway project from the repo.
2. Add a Volume to the service, mounted at `/data`.
3. Set the variable `DB_PATH=/data/board.db`. Railway sets `PORT` automatically.
4. Generate a public domain in the service's networking settings.

Fly.io (with a volume) or any VPS also work. A host with no persistent disk will start each deploy with an empty database, which would fail the persistence requirement.

## Demo script (2 users)
1. Browser A: create a room, then click **Copy link**.
2. Browser B (another device or a private window): open the link and enter a different name. Both participant lists update.
3. Move the mouse in A; B sees a labeled cursor.
4. Add a note in A and type in it; B sees the text appear and an "A is editing" border.
5. Drag the note in B; it moves in A.
6. Type in the same note in both browsers at once; one person gets the conflict dialog. Pick **Keep both**.
7. Delete a note in one browser; it disappears in the other.
8. Close both browsers, open the link again: everything is still there.
