(() => {
  const roomId = decodeURIComponent(location.pathname.split('/').pop()).toUpperCase();
  const $ = (id) => document.getElementById(id);
  const board = $('board'), viewport = $('viewport');

  const items = new Map();   // id -> latest known item from server
  const els = new Map();     // id -> note DOM element
  const cursors = new Map(); // socketId -> cursor DOM element
  let users = [];
  let me = null;
  let myName = null;
  let editing = null;  // { id, baseVersion, dirty, saving, closing, timer }
  let dragging = null; // { id, el, offX, offY, x, y, lastSent, first }
  let modalOpen = false;

  const socket = io({ autoConnect: false });

  // ---------- helpers ----------
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  function boardPoint(e) {
    const r = board.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }
  function modal(title, bodyNodes, buttons) {
    modalOpen = true;
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    const box = document.createElement('div');
    box.className = 'modal';
    const h = document.createElement('h3');
    h.textContent = title;
    box.appendChild(h);
    bodyNodes.forEach((n) => box.appendChild(n));
    const actions = document.createElement('div');
    actions.className = 'actions';
    buttons.forEach(({ label, primary, onClick }) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (primary) b.className = 'primary';
      b.onclick = () => { bg.remove(); modalOpen = false; onClick(); };
      actions.appendChild(b);
    });
    box.appendChild(actions);
    bg.appendChild(box);
    document.body.appendChild(bg);
    return box;
  }
  function textBlock(label, text) {
    const wrap = document.createElement('div');
    const l = document.createElement('strong');
    l.textContent = label;
    const pre = document.createElement('pre');
    pre.textContent = text || '(empty)';
    wrap.append(l, pre);
    return wrap;
  }
  function para(text) {
    const p = document.createElement('p');
    p.textContent = text;
    return p;
  }

  // ---------- name + connect ----------
  function askName(done) {
    const saved = localStorage.getItem('collab:name');
    if (saved) return done(saved);
    const input = document.createElement('input');
    input.placeholder = 'Your name';
    input.maxLength = 30;
    input.style.width = '100%';
    const box = modal('Enter your name to join', [input], [{
      label: 'Join room', primary: true,
      onClick: () => {
        const name = input.value.trim() || 'Guest';
        localStorage.setItem('collab:name', name);
        done(name);
      },
    }]);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') box.querySelector('button').click(); });
    setTimeout(() => input.focus(), 0);
  }

  askName((name) => { myName = name; socket.connect(); });

  socket.on('connect', () => {
    socket.emit('join', { roomId, name: myName }, (res) => {
      if (!res || !res.ok) {
        socket.disconnect();
        document.body.innerHTML = '<main class="landing"><h1>Room not found</h1><p>Check the code or link.</p><a href="/">Back home</a></main>';
        return;
      }
      me = res.you;
      $('roomName').textContent = res.room.name;
      $('roomCode').textContent = res.room.id;
      document.title = `${res.room.name} · Collab Board`;
      loadSnapshot(res.items);
      setUsers(res.users);
      setOnline(true);
      // If the user kept typing while the connection was down, push that draft now.
      // It still goes through the version check, so it can't silently overwrite newer work.
      if (editing) {
        socket.emit('item:focus', { id: editing.id });
        if (editing.dirty) saveEdit();
      }
    });
  });
  socket.on('disconnect', () => setOnline(false));

  function setOnline(on) {
    $('room').classList.toggle('offline', !on);
    $('status').className = 'status ' + (on ? 'online' : 'offline');
    $('status').textContent = on ? 'Live' : 'Reconnecting…';
    $('addNote').disabled = !on;
    if (!on) { cursors.forEach((c) => c.remove()); cursors.clear(); }
  }

  // ---------- presence ----------
  socket.on('presence', setUsers);
  function setUsers(list) {
    users = list;
    $('count').textContent = list.length;
    const ul = $('users');
    ul.innerHTML = '';
    for (const u of list) {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = u.color;
      const txt = document.createElement('div');
      txt.textContent = u.name + (me && u.id === me.id ? ' (you)' : '');
      if (u.editing) {
        const s = document.createElement('div');
        s.className = 'sub';
        s.textContent = 'editing a note';
        txt.appendChild(s);
      }
      li.append(dot, txt);
      ul.appendChild(li);
    }
    const present = new Set(list.map((u) => u.id));
    for (const [id, c] of cursors) if (!present.has(id)) { c.remove(); cursors.delete(id); }
    updateLocks();
  }
  function updateLocks() {
    for (const [id, el] of els) {
      const other = users.find((u) => u.editing === id && (!me || u.id !== me.id));
      el.classList.toggle('locked', !!other);
      el.style.setProperty('--lock-color', other ? other.color : 'transparent');
      el.querySelector('.label').textContent = other ? `${other.name} is editing` : '';
    }
  }

  // ---------- cursors ----------
  let lastCursor = 0;
  viewport.addEventListener('pointermove', (e) => {
    const now = Date.now();
    if (now - lastCursor < 30 || !socket.connected) return;
    lastCursor = now;
    const p = boardPoint(e);
    socket.emit('cursor', { x: p.x, y: p.y });
  });
  viewport.addEventListener('pointerleave', () => socket.connected && socket.emit('cursor', { x: null }));

  socket.on('cursor', (c) => {
    let el = cursors.get(c.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'cursor';
      el.innerHTML = '<svg width="16" height="20" viewBox="0 0 16 20"><path d="M1 1 L1 16 L5 12 L8 19 L11 18 L8 11 L14 11 Z" stroke="#fff" stroke-width="1.2"/></svg><span></span>';
      board.appendChild(el);
      cursors.set(c.id, el);
    }
    el.querySelector('path').setAttribute('fill', c.color);
    const label = el.querySelector('span');
    label.textContent = c.name;
    label.style.background = c.color;
    el.style.left = c.x + 'px';
    el.style.top = c.y + 'px';
  });
  socket.on('cursor:leave', ({ id }) => { cursors.get(id)?.remove(); cursors.delete(id); });

  // ---------- notes: rendering ----------
  function loadSnapshot(list) {
    const ids = new Set(list.map((i) => i.id));
    for (const id of [...els.keys()]) {
      if (!ids.has(id)) removeNote(id, 'Someone');
    }
    for (const item of list) upsert(item);
  }

  function upsert(item) {
    items.set(item.id, item);
    let el = els.get(item.id);
    if (!el) {
      el = createNoteEl(item.id);
      board.appendChild(el);
      els.set(item.id, el);
    }
    if (!dragging || dragging.id !== item.id) {
      el.style.left = item.x + 'px';
      el.style.top = item.y + 'px';
    }
    el.style.zIndex = item.z;
    el.style.background = item.color;

    const ta = el.querySelector('textarea');
    const warn = el.querySelector('.warn');
    if (editing && editing.id === item.id) {
      if (item.text_version !== editing.baseVersion) {
        if (!editing.dirty && !editing.saving) {
          // I haven't typed anything yet, so just take their latest text.
          ta.value = item.text;
          editing.baseVersion = item.text_version;
          warn.hidden = true;
        } else {
          warn.textContent = `${item.updated_by || 'Someone'} also changed this note. You'll choose what to keep when it saves.`;
          warn.hidden = false;
        }
      }
    } else if (ta.value !== item.text) {
      ta.value = item.text;
    }
    updateLocks();
  }

  function createNoteEl(id) {
    const el = document.createElement('div');
    el.className = 'note';
    el.dataset.id = id;
    el.innerHTML = '<div class="note-bar"><span class="label"></span><button class="del" title="Delete note">×</button></div><div class="warn" hidden></div><textarea placeholder="Type here…" maxlength="2000"></textarea>';
    const bar = el.querySelector('.note-bar');
    const ta = el.querySelector('textarea');
    bar.addEventListener('pointerdown', (e) => startDrag(e, id, el));
    el.querySelector('.del').addEventListener('pointerdown', (e) => e.stopPropagation());
    el.querySelector('.del').addEventListener('click', () => deleteNote(id));
    ta.addEventListener('focus', () => beginEdit(id));
    ta.addEventListener('input', () => onInput(id));
    ta.addEventListener('blur', () => endEdit(id));
    return el;
  }

  function removeNote(id, by) {
    const el = els.get(id);
    if (editing && editing.id === id) {
      const ed = editing;
      const mine = el ? el.querySelector('textarea').value : '';
      const last = items.get(id);
      stopEditing(ed);
      if (last && mine !== last.text) showDeleted(by, mine, last);
      else toast(`${by} deleted a note you had open`);
    }
    el?.remove();
    els.delete(id);
    items.delete(id);
  }

  socket.on('item:upsert', upsert);
  socket.on('item:deleted', ({ id, by }) => removeNote(id, by));

  // ---------- notes: create / delete ----------
  function createNote(x, y, text = '', color) {
    socket.emit('item:create', { x, y, text, color }, (res) => {
      if (!res || !res.ok) return toast('Could not create note');
      upsert(res.item);
      els.get(res.item.id).querySelector('textarea').focus();
    });
  }
  $('addNote').onclick = () => {
    createNote(viewport.scrollLeft + viewport.clientWidth / 2 - 100, viewport.scrollTop + viewport.clientHeight / 2 - 75);
  };
  board.addEventListener('dblclick', (e) => {
    if (e.target !== board || !socket.connected) return;
    const p = boardPoint(e);
    createNote(clamp(p.x - 100, 0, 3800), clamp(p.y - 20, 0, 2840));
  });
  function deleteNote(id) {
    socket.emit('item:delete', { id }, (res) => {
      if (editing && editing.id === id) stopEditing(editing);
      if (res && res.ok) { els.get(id)?.remove(); els.delete(id); items.delete(id); }
    });
  }

  // ---------- notes: dragging (position is last-writer-wins) ----------
  function startDrag(e, id, el) {
    if (!socket.connected) return;
    const it = items.get(id);
    if (!it) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = boardPoint(e);
    dragging = { id, el, offX: p.x - it.x, offY: p.y - it.y, x: it.x, y: it.y, lastSent: 0, first: true };
    el.style.zIndex = 99999;
  }
  window.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const p = boardPoint(e);
    dragging.x = clamp(p.x - dragging.offX, 0, 3800);
    dragging.y = clamp(p.y - dragging.offY, 0, 2840);
    dragging.el.style.left = dragging.x + 'px';
    dragging.el.style.top = dragging.y + 'px';
    if (Date.now() - dragging.lastSent > 40) sendMove();
  });
  window.addEventListener('pointerup', () => {
    if (!dragging) return;
    sendMove();
    dragging = null;
  });
  function sendMove() {
    const d = dragging;
    d.lastSent = Date.now();
    socket.emit('item:move', { id: d.id, x: d.x, y: d.y, front: d.first }, (res) => {
      if (res && res.ok) upsert(res.item);
    });
    d.first = false;
  }

  // ---------- notes: text editing with optimistic concurrency ----------
  function beginEdit(id) {
    if (editing && editing.id === id) { editing.closing = false; return; }
    const it = items.get(id);
    if (!it) return;
    editing = { id, baseVersion: it.text_version, dirty: false, saving: false, closing: false, timer: null };
    if (socket.connected) socket.emit('item:focus', { id });
  }
  function onInput(id) {
    if (!editing || editing.id !== id) beginEdit(id);
    editing.dirty = true;
    clearTimeout(editing.timer);
    editing.timer = setTimeout(saveEdit, 600);
  }
  function endEdit(id) {
    if (!editing || editing.id !== id) return;
    editing.closing = true;
    clearTimeout(editing.timer);
    if (editing.dirty) saveEdit();
    else if (!editing.saving) stopEditing(editing);
  }
  function stopEditing(ed) {
    clearTimeout(ed.timer);
    if (editing !== ed) return;
    editing = null;
    els.get(ed.id)?.querySelector('.warn')?.setAttribute('hidden', '');
    if (socket.connected) socket.emit('item:focus', { id: null });
    const latest = items.get(ed.id);
    if (latest) upsert(latest);
  }

  function saveEdit() {
    const ed = editing;
    if (!ed || !ed.dirty || ed.saving || modalOpen || !socket.connected) return;
    const el = els.get(ed.id);
    if (!el) return;
    const text = el.querySelector('textarea').value;
    ed.saving = true;
    ed.dirty = false;
    socket.timeout(5000).emit('item:edit', { id: ed.id, text, baseVersion: ed.baseVersion }, (err, res) => {
      ed.saving = false;
      if (err) { ed.dirty = true; return; } // connection trouble: retried on reconnect
      if (res.ok) {
        ed.baseVersion = res.item.text_version;
        items.set(res.item.id, res.item);
        el.querySelector('.warn').hidden = true;
        if (ed.dirty) saveEdit();
        else if (ed.closing) stopEditing(ed);
      } else if (res.conflict) {
        ed.dirty = true;
        resolveConflict(ed, res.item);
      } else if (res.deleted) {
        const mine = el.querySelector('textarea').value;
        const last = items.get(ed.id);
        stopEditing(ed);
        el.remove(); els.delete(ed.id); items.delete(ed.id);
        showDeleted('Another user', mine, last);
      } else {
        ed.dirty = true;
        setTimeout(saveEdit, 1000);
      }
    });
  }

  // Someone saved a newer version of this note's text after I started editing.
  // Nothing is overwritten automatically: the user sees both versions and decides.
  function resolveConflict(ed, theirs) {
    const el = els.get(ed.id);
    const ta = el.querySelector('textarea');
    const mine = ta.value;
    items.set(theirs.id, theirs);
    if (mine === theirs.text) { // same result (e.g. our own retried save), nothing to resolve
      ed.baseVersion = theirs.text_version;
      ed.dirty = false;
      if (ed.closing) stopEditing(ed);
      return;
    }
    const cols = document.createElement('div');
    cols.className = 'cols';
    cols.append(textBlock(`${theirs.updated_by || 'Someone'}'s version (saved)`, theirs.text), textBlock('Your version (not saved yet)', mine));
    const refocus = () => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); };
    modal('This note was changed while you were editing', [
      para(`${theirs.updated_by || 'Someone'} saved a change to this note before your edit reached the server. Choose what to keep.`),
      cols,
    ], [
      { label: 'Use theirs', onClick: () => { ta.value = theirs.text; ed.baseVersion = theirs.text_version; ed.dirty = false; el.querySelector('.warn').hidden = true; refocus(); } },
      { label: 'Keep both', onClick: () => { ta.value = theirs.text + '\n\n' + mine; ed.baseVersion = theirs.text_version; ed.dirty = true; refocus(); saveEdit(); } },
      { label: 'Keep mine', primary: true, onClick: () => { ed.baseVersion = theirs.text_version; ed.dirty = true; refocus(); saveEdit(); } },
    ]);
  }

  function showDeleted(by, mine, last) {
    modal('This note was deleted', [
      para(`${by} deleted a note while you were editing it. Your unsaved text is below.`),
      textBlock('Your text', mine),
    ], [
      { label: 'Discard', onClick: () => {} },
      { label: 'Restore as a new note', primary: true, onClick: () => createNote(last?.x ?? 100, last?.y ?? 100, mine, last?.color) },
    ]);
  }

  // ---------- share ----------
  $('copyLink').onclick = async () => {
    const url = `${location.origin}/room/${roomId}`;
    try { await navigator.clipboard.writeText(url); toast('Link copied'); }
    catch { toast(url); }
  };
})();
