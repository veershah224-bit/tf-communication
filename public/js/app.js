/* TF Communication — browser client.
   REST for login + admin; Socket.IO for everything real-time.
   All dynamic text uses textContent, so user input can never inject HTML. */

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const PALETTE = ['#0a7cff', '#00a884', '#e542a3', '#f5a623', '#7b61ff', '#ef5350', '#26a69a', '#5c6bc0'];
const colorFor = (id) => PALETTE[(Number(id) || 0) % PALETTE.length];
const initials = (name) =>
  (name || '?').trim().split(/\s+/).slice(0, 2).map((w) => (w[0] || '').toUpperCase()).join('') || '?';
const fmtTime = (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

// ------------------------------------------------------------------ state ---
let token = localStorage.getItem('tf_token') || '';
let me = null;
let socket = null;

const state = {
  users: new Map(),     // userId -> { id, email, displayName }
  presence: new Set(),
  conversations: [],
  active: null,
  messages: new Map(),
};
const typingByConv = new Map();
let uploadsEnabled = false;
let pendingAttachment = null;

// -------------------------------------------------------------- REST calls --
async function api(path, { method = 'GET', body, auth = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error('Cannot reach the app. Make sure the "Start TF Communication" window is still open, then try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}). Please try again.`);
  return data;
}

const showErr = (sel, msg) => { const e = $(sel); e.textContent = msg; e.classList.remove('hidden'); };
const hideErr = (sel) => $(sel).classList.add('hidden');

// ------------------------------------------------------- auth: email + code -
let pendingEmail = '';
let pendingName = '';

const emailForm = $('#email-form');
const codeForm = $('#code-form');
const showStep = (step) => {
  emailForm.classList.toggle('hidden', step !== 'email');
  codeForm.classList.toggle('hidden', step !== 'code');
};

emailForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  hideErr('#email-error');
  const email = $('#f-email').value.trim();
  const name = $('#f-name').value.trim();
  if (!email) return showErr('#email-error', 'Please enter your email address.');

  const btn = $('#send-code-btn');
  btn.disabled = true;
  try {
    const r = await api('/api/auth/request-code', { method: 'POST', body: { email, displayName: name } });
    if (r.needName) {
      $('#row-name').classList.remove('hidden');
      $('#f-name').focus();
      showErr('#email-error', "You're new here — please add your name, then tap the button again.");
      return;
    }
    pendingEmail = email;
    pendingName = name;
    $('#code-email').textContent = email;
    showTestCode(r.devCode);
    showStep('code');
    $('#f-code').focus();
  } catch (err) {
    showErr('#email-error', err.message);
  } finally {
    btn.disabled = false;
  }
});

function showTestCode(devCode) {
  const tc = $('#test-code');
  if (!devCode) { tc.classList.add('hidden'); tc.textContent = ''; return; }
  tc.textContent = 'No email is set up yet (test mode). Your code is: ';
  tc.appendChild(el('b', null, devCode));
  tc.classList.remove('hidden');
  $('#f-code').value = devCode; // prefill so testing is one click
}

codeForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  hideErr('#code-error');
  const code = $('#f-code').value.trim();
  if (!code) return showErr('#code-error', 'Enter the 6-digit code.');
  try {
    const r = await api('/api/auth/verify-code', { method: 'POST', body: { email: pendingEmail, code } });
    token = r.token;
    localStorage.setItem('tf_token', token);
    me = r.user;
    startApp();
  } catch (err) {
    showErr('#code-error', err.message);
  }
});

$('#resend-code').onclick = async () => {
  hideErr('#code-error');
  const btn = $('#resend-code');
  try {
    const r = await api('/api/auth/request-code', { method: 'POST', body: { email: pendingEmail, displayName: pendingName } });
    showTestCode(r.devCode);
    btn.textContent = 'Code sent ✓';
    setTimeout(() => { btn.textContent = 'Resend code'; }, 2500);
  } catch (err) {
    showErr('#code-error', err.message);
  }
};

$('#change-email').onclick = () => { showStep('email'); hideErr('#code-error'); $('#f-email').focus(); };

function logout() {
  if (socket) socket.disconnect();
  localStorage.removeItem('tf_token');
  location.reload();
}

// --------------------------------------------------------------- bootstrap --
async function bootstrap() {
  showStep('email');
  if (token) {
    try {
      const d = await api('/api/me', { auth: true });
      me = d.user;
      startApp();
      return;
    } catch {
      localStorage.removeItem('tf_token');
      token = '';
    }
  }
}

function startApp() {
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#me-name').textContent = me.displayName;
  $('#me-email').textContent = me.email;
  const a = $('#me-avatar');
  a.textContent = initials(me.displayName);
  a.style.background = colorFor(me.id);
  $('#menu-admin').classList.toggle('hidden', !me.isAdmin);
  api('/api/config')
    .then((c) => { uploadsEnabled = !!c.uploadsEnabled; $('#attach-btn').classList.toggle('hidden', !uploadsEnabled); })
    .catch(() => {});
  connectSocket();
}

// --------------------------------------------------------------- account menu
const accountMenu = $('#account-menu');
const toggleAccountMenu = (e) => { e.stopPropagation(); accountMenu.classList.toggle('hidden'); };
$('#btn-menu').onclick = toggleAccountMenu;
$('#me-button').onclick = toggleAccountMenu;
document.addEventListener('click', (e) => {
  if (accountMenu.classList.contains('hidden')) return;
  if (!accountMenu.contains(e.target) && e.target !== $('#btn-menu') && !$('#me-button').contains(e.target)) {
    accountMenu.classList.add('hidden');
  }
});
$('#menu-logout').onclick = logout;
$('#menu-logout-all').onclick = async () => {
  try { await api('/api/logout-everywhere', { method: 'POST', auth: true }); } catch {}
  logout();
};
$('#menu-admin').onclick = () => { accountMenu.classList.add('hidden'); openAdminPanel(); };

// --------------------------------------------------------------- admin panel
async function openAdminPanel() {
  const body = openModal('Manage staff');
  body.innerHTML = '<div class="loading">Loading…</div>';
  await renderAdmin(body);
}

async function renderAdmin(body) {
  let data;
  try {
    data = await api('/api/admin/users', { auth: true });
  } catch (err) {
    body.innerHTML = '';
    body.appendChild(el('div', 'error', err.message));
    return;
  }
  body.innerHTML = '';

  // Add-staff form
  const add = el('div', 'admin-add');
  add.appendChild(el('div', 'muted', 'Add a staff member. They sign in with their email — no password needed.'));
  const nameI = el('input'); nameI.placeholder = 'Name (e.g. Sara Khan)';
  const emailI = el('input'); emailI.type = 'email'; emailI.placeholder = 'email@example.com';
  const addBtn = el('button', null, 'Add');
  const row = el('div', 'row'); row.appendChild(emailI); row.appendChild(addBtn);
  add.appendChild(nameI); add.appendChild(row);
  const addErr = el('div', 'error hidden'); add.appendChild(addErr);
  addBtn.onclick = async () => {
    addErr.classList.add('hidden');
    try {
      await api('/api/admin/users', { method: 'POST', auth: true, body: { email: emailI.value.trim(), displayName: nameI.value.trim() } });
      renderAdmin(body);
    } catch (err) {
      addErr.textContent = err.message;
      addErr.classList.remove('hidden');
    }
  };
  body.appendChild(add);

  // Staff list
  for (const u of data.users) {
    const r = el('div', 'staff-row');
    const av = el('div', 'avatar'); av.textContent = initials(u.displayName); av.style.background = colorFor(u.id);
    const meta = el('div', 'staff-meta');
    const nameLine = el('strong', null, u.displayName);
    if (u.isAdmin) nameLine.appendChild(el('span', 'tag admin', 'ADMIN'));
    if (!u.isActive) nameLine.appendChild(el('span', 'tag off', 'DISABLED'));
    meta.appendChild(nameLine);
    meta.appendChild(el('div', 'e', u.email));
    const actions = el('div', 'staff-actions');
    if (u.id === me.id) {
      actions.appendChild(el('span', 'muted', '(you)'));
    } else {
      const act = el('button', null, u.isActive ? 'Disable' : 'Enable');
      act.onclick = () => adminSet(body, u.id, { isActive: !u.isActive });
      const adm = el('button', null, u.isAdmin ? 'Remove admin' : 'Make admin');
      adm.onclick = () => adminSet(body, u.id, { isAdmin: !u.isAdmin });
      actions.appendChild(act);
      actions.appendChild(adm);
    }
    r.appendChild(av); r.appendChild(meta); r.appendChild(actions);
    body.appendChild(r);
  }
}

async function adminSet(body, id, change) {
  try {
    await api(`/api/admin/users/${id}`, { method: 'POST', auth: true, body: change });
    renderAdmin(body);
  } catch (err) {
    alert(err.message);
  }
}

// ------------------------------------------------------------------ socket --
function connectSocket() {
  if (socket) socket.disconnect();
  socket = io({ auth: { token } });
  socket.on('connect_error', (e) => { if (e.message === 'unauthorized') logout(); });
  socket.on('users:list', (list) => {
    state.users = new Map(list.map((u) => [u.id, u]));
    renderConversations();
    if (state.active) updateChatHeader();
  });
  socket.on('presence:list', (ids) => {
    state.presence = new Set(ids);
    renderConversations();
    if (state.active) updateChatHeader();
  });
  socket.on('conversations:list', (list) => {
    state.conversations = list;
    renderConversations();
    if (state.active) updateChatHeader();
  });
  socket.on('message:new', onMessageNew);
  socket.on('typing', onTyping);
}

// --------------------------------------------------------- conversation list
$('#search').addEventListener('input', renderConversations);

function renderConversations() {
  const list = $('#conversation-list');
  list.innerHTML = '';
  const q = ($('#search').value || '').toLowerCase();
  const items = state.conversations.filter((c) => (c.name || '').toLowerCase().includes(q));

  if (!items.length) {
    list.appendChild(el('div', 'empty-list', 'No chats yet. Use the ✎ or 👥 buttons above to start one.'));
    return;
  }

  for (const c of items) {
    const row = el('div', 'conv' + (c.id === state.active ? ' active' : ''));
    const av = el('div', 'avatar');
    av.textContent = initials(c.name);
    av.style.background = colorFor(c.type === 'direct' ? c.otherUserId : c.id);
    if (c.type === 'direct' && state.presence.has(c.otherUserId)) av.appendChild(el('span', 'dot'));

    const main = el('div', 'conv-main');
    const top = el('div', 'conv-top');
    top.appendChild(el('span', 'conv-name', c.name));
    top.appendChild(el('span', 'conv-time', c.lastMessage ? fmtTime(c.lastMessage.createdAt) : ''));
    const bottom = el('div', 'conv-bottom');
    const previewText = c.lastMessage
      ? (c.lastMessage.senderId === me.id ? 'You: ' : '') + c.lastMessage.text
      : 'No messages yet';
    bottom.appendChild(el('span', 'conv-preview', previewText));
    if (c.unread > 0) bottom.appendChild(el('span', 'badge', String(c.unread)));
    main.appendChild(top); main.appendChild(bottom);
    row.appendChild(av); row.appendChild(main);
    row.onclick = () => openConversation(c.id);
    list.appendChild(row);
  }
}

// ---------------------------------------------------------------- open chat -
function openConversation(id) {
  state.active = id;
  document.body.classList.add('chat-open');
  $('#chat-empty').classList.add('hidden');
  $('#chat-view').classList.remove('hidden');
  renderConversations();
  updateChatHeader();
  renderTyping();

  $('#messages').innerHTML = '<div class="loading">Loading…</div>';
  socket.emit('conversation:open', { conversationId: id }, (resp) => {
    if (!resp || resp.error) { $('#messages').innerHTML = ''; return; }
    if (state.active !== id) return;
    state.messages.set(id, resp.messages);
    renderMessages();
  });
  $('#composer-input').focus();
}

$('#chat-back').onclick = () => {
  state.active = null;
  document.body.classList.remove('chat-open');
  $('#chat-view').classList.add('hidden');
  $('#chat-empty').classList.remove('hidden');
  renderConversations();
};

function updateChatHeader() {
  const c = state.conversations.find((x) => x.id === state.active);
  if (!c) return;
  const a = $('#chat-avatar');
  a.textContent = initials(c.name);
  a.style.background = colorFor(c.type === 'direct' ? c.otherUserId : c.id);
  $('#chat-title').textContent = c.name;
  if (c.type === 'direct') {
    $('#chat-subtitle').textContent = state.presence.has(c.otherUserId) ? 'online' : 'offline';
  } else {
    const onlineCount = c.memberIds.filter((id) => state.presence.has(id)).length;
    $('#chat-subtitle').textContent = `${c.memberIds.length} members · ${onlineCount} online`;
  }
}

function renderMessages() {
  const box = $('#messages');
  box.innerHTML = '';
  const msgs = state.messages.get(state.active) || [];
  const conv = state.conversations.find((c) => c.id === state.active);
  const isGroup = conv && conv.type === 'group';

  for (const m of msgs) {
    const mine = m.senderId === me.id;
    const wrap = el('div', 'msg' + (mine ? ' mine' : ''));
    const bubble = el('div', 'bubble');
    if (!mine && isGroup) {
      const sender = state.users.get(m.senderId);
      const nm = el('div', 'sender', sender ? sender.displayName : 'Unknown');
      nm.style.color = colorFor(m.senderId);
      bubble.appendChild(nm);
    }
    if (m.attachment) bubble.appendChild(renderAttachment(m.attachment));
    if (m.text) bubble.appendChild(el('div', 'text', m.text));
    bubble.appendChild(el('div', 'time', fmtTime(m.createdAt)));
    wrap.appendChild(bubble);
    box.appendChild(wrap);
  }
  box.scrollTop = box.scrollHeight;
}

function onMessageNew(msg) {
  const arr = state.messages.get(msg.conversationId);
  if (arr) arr.push(msg);
  if (msg.conversationId === state.active) {
    renderMessages();
    socket.emit('conversation:read', { conversationId: msg.conversationId });
  }
}

// ----------------------------------------------------------------- compose --
$('#composer').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const input = $('#composer-input');
  const text = input.value.trim();
  if ((!text && !pendingAttachment) || !state.active) return;
  const attachment = pendingAttachment;
  input.value = '';
  pendingAttachment = null;
  hideAttachPreview();
  socket.emit('message:send', { conversationId: state.active, text, attachment }, (resp) => {
    if (resp && resp.error) alert(resp.error);
  });
  stopTyping();
});

let typingTimer = null;
let typingActive = false;
$('#composer-input').addEventListener('input', () => {
  if (!state.active) return;
  if (!typingActive) {
    typingActive = true;
    socket.emit('typing', { conversationId: state.active, isTyping: true });
  }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(stopTyping, 1500);
});
function stopTyping() {
  if (typingActive && state.active) socket.emit('typing', { conversationId: state.active, isTyping: false });
  typingActive = false;
  clearTimeout(typingTimer);
}

function onTyping(t) {
  if (!typingByConv.has(t.conversationId)) typingByConv.set(t.conversationId, new Map());
  const m = typingByConv.get(t.conversationId);
  if (t.isTyping) m.set(t.userId, t.displayName); else m.delete(t.userId);
  renderTyping();
}
function renderTyping() {
  const ind = $('#typing-indicator');
  const m = typingByConv.get(state.active);
  if (!m || m.size === 0) { ind.classList.add('hidden'); ind.textContent = ''; return; }
  const names = [...m.values()];
  ind.textContent = names.length === 1 ? `${names[0]} is typing…` : `${names.join(', ')} are typing…`;
  ind.classList.remove('hidden');
}

// ------------------------------------------------------------- attachments --
$('#attach-btn').onclick = () => $('#file-input').click();
$('#file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !state.active) return;
  if (file.size > 50 * 1024 * 1024) { alert('That file is too big (max 50 MB).'); return; }
  showAttachPreview(file.name, true);
  try {
    pendingAttachment = await uploadFile(file);
    showAttachPreview(file.name, false);
    $('#composer-input').focus();
  } catch {
    pendingAttachment = null;
    hideAttachPreview();
    alert('Upload failed. Please try again.');
  }
});

async function uploadFile(file) {
  const sig = await api('/api/upload-signature', { method: 'POST', auth: true });
  const form = new FormData();
  form.append('file', file);
  form.append('api_key', sig.apiKey);
  form.append('timestamp', sig.timestamp);
  form.append('signature', sig.signature);
  form.append('folder', sig.folder);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `https://api.cloudinary.com/v1_1/${sig.cloudName}/auto/upload`);
    xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) setAttachProgress(Math.round((ev.loaded / ev.total) * 100)); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const r = JSON.parse(xhr.responseText);
        resolve({ url: r.secure_url, type: r.resource_type, name: file.name, size: r.bytes, format: r.format });
      } else reject(new Error('upload failed'));
    };
    xhr.onerror = () => reject(new Error('upload failed'));
    xhr.send(form);
  });
}

function showAttachPreview(name, uploading) {
  const p = $('#attach-preview');
  p.innerHTML = '';
  p.classList.remove('hidden');
  const row = el('div', 'attach-row');
  row.appendChild(el('span', 'attach-name', (uploading ? 'Uploading: ' : 'Ready to send: ') + name));
  if (uploading) {
    const bar = el('div', 'attach-bar');
    const fill = el('div', 'attach-bar-fill');
    fill.id = 'attach-progress-bar';
    bar.appendChild(fill);
    row.appendChild(bar);
  } else {
    const x = el('button', 'attach-remove', '✕');
    x.type = 'button';
    x.onclick = () => { pendingAttachment = null; hideAttachPreview(); };
    row.appendChild(x);
  }
  p.appendChild(row);
}
const hideAttachPreview = () => { const p = $('#attach-preview'); p.classList.add('hidden'); p.innerHTML = ''; };
const setAttachProgress = (pct) => { const b = $('#attach-progress-bar'); if (b) b.style.width = pct + '%'; };

function renderAttachment(att) {
  const wrap = el('div', 'attachment');
  if (att.type === 'image') {
    const img = el('img', 'att-image');
    img.src = att.url;
    img.loading = 'lazy';
    img.onclick = () => window.open(att.url, '_blank', 'noopener');
    wrap.appendChild(img);
  } else if (att.type === 'video') {
    const v = el('video', 'att-video');
    v.src = att.url;
    v.controls = true;
    wrap.appendChild(v);
  } else {
    const a = el('a', 'att-file');
    a.href = att.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.appendChild(el('span', 'att-file-icon', '📎'));
    const info = el('div', 'att-file-info');
    info.appendChild(el('span', 'att-file-name', att.name || 'File'));
    info.appendChild(el('span', 'att-file-size', formatSize(att.size)));
    a.appendChild(info);
    wrap.appendChild(a);
  }
  return wrap;
}
function formatSize(b) {
  if (!b) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let n = b; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(i > 0 && n < 10 ? 1 : 0)} ${u[i]}`;
}

// ----------------------------------------------------------------- modals ---
function openModal(title) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = '';
  $('#modal').classList.remove('hidden');
  return $('#modal-body');
}
function closeModal() {
  $('#modal').classList.add('hidden');
  $('#modal-body').innerHTML = '';
}
$('#modal-close').onclick = closeModal;
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

const otherUsers = () => [...state.users.values()].filter((u) => u.id !== me.id);
function userRow(u, { checkbox = false } = {}) {
  const row = el(checkbox ? 'label' : 'div', 'user-row');
  let cb = null;
  if (checkbox) { cb = el('input'); cb.type = 'checkbox'; row.appendChild(cb); }
  const av = el('div', 'avatar'); av.textContent = initials(u.displayName); av.style.background = colorFor(u.id);
  if (state.presence.has(u.id)) av.appendChild(el('span', 'dot'));
  const info = el('div', 'user-info');
  info.appendChild(el('strong', null, u.displayName));
  info.appendChild(el('span', 'muted', u.email));
  row.appendChild(av); row.appendChild(info);
  return { row, cb };
}

$('#btn-new-direct').onclick = () => {
  const body = openModal('Start a chat');
  const others = otherUsers();
  if (!others.length) {
    body.appendChild(el('p', 'muted', 'No other staff yet. Use "Manage staff" to add people, or ask them to sign in.'));
    return;
  }
  const ul = el('div', 'user-list');
  for (const u of others) {
    const { row } = userRow(u);
    row.onclick = () =>
      socket.emit('direct:open', { userId: u.id }, (resp) => {
        if (resp && resp.conversationId) { closeModal(); openConversation(resp.conversationId); }
        else if (resp && resp.error) alert(resp.error);
      });
    ul.appendChild(row);
  }
  body.appendChild(ul);
};

$('#btn-new-group').onclick = () => {
  const body = openModal('New group');
  const nameInput = el('input', 'modal-input');
  nameInput.placeholder = 'Group name (e.g. Sales team)';
  body.appendChild(nameInput);
  body.appendChild(el('p', 'muted', 'Add members:'));

  const others = otherUsers();
  const chosen = new Set();
  if (!others.length) {
    body.appendChild(el('p', 'muted', 'No other staff yet.'));
  } else {
    const ul = el('div', 'user-list');
    for (const u of others) {
      const { row, cb } = userRow(u, { checkbox: true });
      cb.onchange = () => { cb.checked ? chosen.add(u.id) : chosen.delete(u.id); };
      ul.appendChild(row);
    }
    body.appendChild(ul);
  }

  const err = el('div', 'error hidden');
  body.appendChild(err);
  const create = el('button', 'btn-primary', 'Create group');
  create.onclick = () => {
    const name = nameInput.value.trim();
    if (!name) return showModalErr(err, 'Please enter a group name.');
    if (chosen.size < 1) return showModalErr(err, 'Pick at least one member.');
    socket.emit('group:create', { name, memberIds: [...chosen] }, (resp) => {
      if (resp && resp.error) return showModalErr(err, resp.error);
      closeModal();
      if (resp && resp.conversationId) openConversation(resp.conversationId);
    });
  };
  body.appendChild(create);
};
const showModalErr = (err, msg) => { err.textContent = msg; err.classList.remove('hidden'); };

// ------------------------------------------------------------------- start --
bootstrap();
