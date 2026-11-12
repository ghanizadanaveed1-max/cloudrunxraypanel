(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const login = $('#login'), app = $('#app');
  let data = null, current = 'vless';
  const qrCache = {};

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 1800);
  }
  async function copy(text, msg = 'Copied') {
    try { await navigator.clipboard.writeText(text); }
    catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    toast(msg);
  }

  const ENGINE_TEXT = { running: 'Online', starting: 'Starting…', restarting: 'Restarting…', missing: 'Xray not installed' };
  const MAX_RETRIES = 10;
  let retryTimer = null, retries = 0;

  function download(blob, name) {
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Convert the QR SVG into a PNG (white background, 1024 px square)
  function svgToPng(svg, size = 1024) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, size, size);
        ctx.drawImage(img, 0, 0, size, size);
        URL.revokeObjectURL(url);
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG failed'))), 'image/png');
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('SVG failed')); };
      img.src = url;
    });
  }

  /* ---------- auth ---------- */
  function showLogin() { app.hidden = true; login.hidden = false; $('#pw').focus(); }
  function showApp() { login.hidden = true; app.hidden = false; }

  $('#togglePw').addEventListener('click', () => {
    const i = $('#pw'); i.type = i.type === 'password' ? 'text' : 'password';
  });

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#loginError'); err.hidden = true;
    try {
      const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: $('#pw').value }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Could not sign in.');
      $('#pw').value = '';
      await load();
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false;
      const card = $('.login-card'); card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
    }
  });

  $('#logout').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    data = null; clearTimeout(retryTimer); retries = 0; clearInterval(usersTimer); window.__counted = false; setView('configs'); showLogin();
  });

  /* ---------- data ---------- */
  function setEngine(state) {
    const chip = $('#chipStatus');
    const ok = state === 'running';
    chip.className = ok ? 'chip-ok' : 'chip-bad';
    chip.innerHTML = `<i class="dot"></i><span>${esc(ENGINE_TEXT[state] || state)}</span>`;
    $('#recheck').hidden = ok;
  }

  async function load() {
    clearTimeout(retryTimer);
    const r = await fetch('/api/config');
    if (r.status === 401) return showLogin();
    if (!r.ok) throw new Error('Could not load config');
    data = await r.json();
    showApp();
    if (!window.__counted) { window.__counted = true; api('/api/users').then((j) => { users = j.users; $('#userCount').textContent = j.summary.total; }).catch(() => {}); }
    $('#hostText').textContent = data.host;
    $('#chipPort').textContent = data.port;
    setEngine(data.xray);
    // While the engine is not up yet, check again every 3 seconds (up to MAX_RETRIES)
    if (data.xray === 'running') retries = 0;
    else if (retries < MAX_RETRIES) { retries++; retryTimer = setTimeout(load, 3000); }
    render();
  }

  const proto = () => data.protocols.find((p) => p.id === current);

  async function drawQr(p) {
    const box = $('#qr');
    if (qrCache[p.id]) { box.innerHTML = qrCache[p.id]; return; }
    box.innerHTML = '<p class="qr-msg">Making QR…</p>';
    try {
      const r = await fetch('/api/qr?text=' + encodeURIComponent(p.link));
      if (!r.ok) throw new Error();
      qrCache[p.id] = await r.text();
      if (current === p.id) box.innerHTML = qrCache[p.id];
    } catch (_) {
      box.innerHTML = '<p class="qr-msg">QR could not load. Copy the link instead.</p>';
    }
  }

  function render() {
    const p = proto();
    document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.id === current)));
    $('#protoTitle').textContent = p.name + ' over WebSocket';
    $('#fields').innerHTML = Object.entries(p.fields).map(([k, v]) =>
      `<div class="row"><dt>${esc(k)}</dt><dd>${esc(v)}</dd><button class="copy" data-v="${esc(v)}" aria-label="Copy ${esc(k)}">Copy</button></div>`).join('');
    $('#linkBox').value = p.link;
    drawQr(p);
  }

  /* ---------- events ---------- */
  document.querySelector('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]'); if (!b) return;
    current = b.dataset.id; render();
  });
  $('#fields').addEventListener('click', (e) => {
    const b = e.target.closest('.copy'); if (!b) return;
    copy(b.dataset.v);
    b.textContent = 'Copied'; b.classList.add('done');
    setTimeout(() => { b.textContent = 'Copy'; b.classList.remove('done'); }, 1200);
  });
  $('#copyLink').addEventListener('click', () => copy(proto().link, proto().name + ' link copied'));
  $('#copyAll').addEventListener('click', () => copy(data.protocols.map((p) => p.link).join('\n'), 'All links copied'));
  $('#hostBtn').addEventListener('click', () => copy(data.host, 'Host copied'));
  $('#linkBox').addEventListener('focus', (e) => e.target.select());

  $('#savePng').addEventListener('click', async () => {
    const svg = qrCache[current]; if (!svg) return toast('QR not ready yet');
    try { download(await svgToPng(svg), `${current}-qr.png`); toast('PNG saved'); }
    catch (_) { toast('Could not make PNG'); }
  });
  $('#saveSvg').addEventListener('click', () => {
    const svg = qrCache[current]; if (!svg) return toast('QR not ready yet');
    download(new Blob([svg], { type: 'image/svg+xml' }), `${current}-qr.svg`);
  });
  $('#recheck').addEventListener('click', () => { retries = 0; load().catch(() => toast('Cannot reach panel')); });

  /* ================= user management ================= */
  const fmtBytes = (n) => {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = Math.min(4, Math.floor(Math.log(n) / Math.log(1024)));
    const v = n / 1024 ** i; return (v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(v >= 10 ? 1 : 2)) + ' ' + u[i];
  };
  const dayMs = 86400000;
  const dateInput = (ms) => { if (!ms) return ''; const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const endOfDay = (s) => (s ? new Date(s + 'T23:59:59').getTime() : 0);
  const STATUS_TEXT = { active: 'Active', disabled: 'Disabled', expired: 'Expired', limited: 'Out of traffic' };

  let users = [], usersTimer = null, editing = null, view = 'configs';

  async function api(url, method = 'GET', body) {
    const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401) { showLogin(); throw new Error('Signed out. Please sign in again.'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Request failed');
    return j;
  }

  function setView(v) {
    view = v;
    document.querySelectorAll('.views button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === v)));
    $('#viewConfigs').hidden = v !== 'configs';
    $('#viewUsers').hidden = v !== 'users';
    clearInterval(usersTimer);
    if (v === 'users') { loadUsers(); usersTimer = setInterval(() => { if (!document.querySelector('dialog[open]')) loadUsers(); }, 15000); }
  }
  document.querySelector('.views').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]'); if (b) setView(b.dataset.view);
  });

  function applyList(j) {
    users = j.users;
    $('#userCount').textContent = j.summary.total;
    $('#stTotal').textContent = j.summary.total;
    $('#stActive').textContent = j.summary.active;
    $('#stTraffic').textContent = fmtBytes(j.summary.traffic);
    $('#persistNote').hidden = j.summary.persistent || j.summary.total === 0;
    renderUsers();
  }
  async function loadUsers() { try { applyList(await api('/api/users')); } catch (e) { toast(e.message); } }

  function expText(u) {
    if (!u.expireAt) return '<div class="exp">Never<small>No expiry</small></div>';
    const left = Math.ceil((u.expireAt - Date.now()) / dayMs);
    const d = new Date(u.expireAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    return `<div class="exp">${esc(d)}<small>${left > 0 ? left + ' day' + (left === 1 ? '' : 's') + ' left' : 'Expired'}</small></div>`;
  }

  function renderUsers() {
    const q = $('#userSearch').value.trim().toLowerCase(), f = $('#userFilter').value;
    const rows = users.filter((u) => (f === 'all' || u.status === f) && (!q || (u.name + ' ' + u.note).toLowerCase().includes(q)));
    const box = $('#userList');
    if (!rows.length) {
      box.innerHTML = `<div class="empty">${users.length ? 'No users match your search.' : 'No users yet. Press “Add user” to create the first one.'}</div>`;
      return;
    }
    box.innerHTML = rows.map((u) => {
      const pct = u.limitBytes ? Math.min(100, (u.used / u.limitBytes) * 100) : 0;
      const cls = pct >= 100 ? 'full' : pct >= 80 ? 'warn' : '';
      return `<article class="user" data-id="${u.id}">
        <div><div class="nm">${esc(u.name)} <span class="badge b-${u.status}">${STATUS_TEXT[u.status]}</span></div>
          <div class="sub">${u.note ? esc(u.note) : 'Created ' + new Date(u.createdAt).toLocaleDateString()}</div></div>
        <div class="usage"><div class="txt"><span>${fmtBytes(u.used)}</span><span>${u.limitBytes ? fmtBytes(u.limitBytes) : 'Unlimited'}</span></div>
          ${u.limitBytes ? `<div class="bar"><i class="${cls}" style="width:${pct.toFixed(1)}%"></i></div>` : '<div class="bar"><i style="width:0"></i></div>'}</div>
        ${expText(u)}
        <div class="acts">
          <button class="primary" data-act="cfg">Configs</button>
          <button class="ghost" data-act="sub">Sub link</button>
          <button class="ghost" data-act="toggle">${u.enabled ? 'Disable' : 'Enable'}</button>
          <button class="ghost" data-act="edit">Edit</button>
        </div></article>`;
    }).join('');
  }
  $('#userSearch').addEventListener('input', renderUsers);
  $('#userFilter').addEventListener('change', renderUsers);

  $('#userList').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const u = users.find((x) => x.id === b.closest('.user').dataset.id); if (!u) return;
    try {
      if (b.dataset.act === 'edit') openUserDlg(u);
      else if (b.dataset.act === 'cfg') openCfg(u);
      else if (b.dataset.act === 'sub') { const c = await api(`/api/users/${u.id}/config`); copy(c.sub, 'Subscription link copied'); }
      else if (b.dataset.act === 'toggle') { applyList(await api(`/api/users/${u.id}`, 'PATCH', { enabled: !u.enabled })); toast(u.enabled ? 'User disabled' : 'User enabled'); }
    } catch (ex) { toast(ex.message); }
  });

  /* ----- add / edit dialog ----- */
  const userDlg = $('#userDlg');
  function openUserDlg(u) {
    editing = u || null;
    $('#userDlgTitle').textContent = u ? 'Edit ' + u.name : 'Add user';
    $('#fName').value = u ? u.name : '';
    $('#fLimit').value = u ? +(u.limitBytes / 1024 ** 3).toFixed(3) : 0;
    $('#fExpire').value = u ? dateInput(u.expireAt) : '';
    $('#fNote').value = u ? u.note : '';
    $('#fEnabled').checked = u ? u.enabled : true;
    $('#editExtras').hidden = !u;
    $('#userErr').hidden = true;
    userDlg.showModal();
    if (!u) $('#fName').focus();
  }
  $('#addUser').addEventListener('click', () => openUserDlg(null));
  document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  document.querySelectorAll('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

  $('.quick').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-days]'); if (!b) return;
    const days = Number(b.dataset.days);
    // extend from the current expiry if it is still in the future, otherwise from today
    const cur = endOfDay($('#fExpire').value);
    $('#fExpire').value = days ? dateInput(Math.max(cur, Date.now()) + days * dayMs) : '';
  });

  $('#userForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#userErr'); err.hidden = true;
    const body = { name: $('#fName').value, limitGB: Number($('#fLimit').value || 0), expireAt: endOfDay($('#fExpire').value),
      note: $('#fNote').value, enabled: $('#fEnabled').checked };
    const save = $('#userSave'); save.disabled = true;
    try {
      applyList(await api(editing ? `/api/users/${editing.id}` : '/api/users', editing ? 'PATCH' : 'POST', body));
      userDlg.close(); toast(editing ? 'User saved' : 'User added');
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    save.disabled = false;
  });

  async function extra(label, fn) {
    try { applyList(await fn()); userDlg.close(); toast(label); } catch (ex) { toast(ex.message); }
  }
  $('#btnReset').addEventListener('click', () => confirm('Reset used traffic to 0?') &&
    extra('Traffic reset', () => api(`/api/users/${editing.id}/reset`, 'POST')));
  $('#btnRegen').addEventListener('click', () => confirm('Create new keys and subscription link? The old ones stop working immediately.') &&
    extra('New keys created', () => api(`/api/users/${editing.id}/regen`, 'POST')));
  $('#btnDelete').addEventListener('click', () => confirm(`Delete ${editing.name}? This cannot be undone.`) &&
    extra('User deleted', () => api(`/api/users/${editing.id}`, 'DELETE')));

  /* ----- user configs dialog ----- */
  const cfgDlg = $('#cfgDlg'); let cfg = null, cfgTab = 'sub';
  async function openCfg(u) {
    $('#cfgTitle').textContent = u.name;
    $('#cfgQr').innerHTML = '<p class="qr-msg">Loading…</p>'; $('#cfgLink').value = '';
    cfgDlg.showModal();
    try { cfg = await api(`/api/users/${u.id}/config`); cfgTab = 'sub'; drawCfg(); }
    catch (ex) { cfgDlg.close(); toast(ex.message); }
  }
  async function drawCfg() {
    const tabs = [{ id: 'sub', name: 'Subscription' }, ...cfg.protocols.map((p) => ({ id: p.id, name: p.name }))];
    $('#cfgTabs').innerHTML = tabs.map((t) => `<button role="tab" data-t="${t.id}" aria-selected="${t.id === cfgTab}">${esc(t.name)}</button>`).join('');
    const text = cfgTab === 'sub' ? cfg.sub : cfg.protocols.find((p) => p.id === cfgTab).link;
    $('#cfgLink').value = text;
    $('#cfgHint').textContent = cfgTab === 'sub'
      ? 'One link for all three protocols. Add it as a subscription in v2rayNG, Hiddify, NekoBox or Streisand; usage and expiry show in the app.'
      : 'Scan or copy this single link into your client.';
    $('#cfgCopy').textContent = cfgTab === 'sub' ? 'Copy subscription link' : 'Copy link';
    const box = $('#cfgQr'); const mine = cfgTab;
    try {
      const r = await fetch('/api/qr?text=' + encodeURIComponent(text)); if (!r.ok) throw 0;
      const svg = await r.text(); if (mine === cfgTab) box.innerHTML = svg;
    } catch (_) { box.innerHTML = '<p class="qr-msg">QR could not load. Copy the link instead.</p>'; }
  }
  $('#cfgTabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-t]'); if (b) { cfgTab = b.dataset.t; drawCfg(); } });
  $('#cfgCopy').addEventListener('click', () => copy($('#cfgLink').value, 'Copied'));
  $('#cfgLink').addEventListener('focus', (e) => e.target.select());

  /* ----- backup ----- */
  $('#exportUsers').addEventListener('click', async () => {
    try { const r = await fetch('/api/export'); if (!r.ok) throw 0; download(await r.blob(), 'panel-users.json'); toast('Backup saved'); }
    catch (_) { toast('Could not export'); }
  });
  $('#importUsers').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    if (!confirm('Replace ALL current users with the ones in this file?')) return;
    try { applyList(await api('/api/import', 'POST', JSON.parse(await f.text()))); toast('Users imported'); }
    catch (ex) { toast(ex.message.includes('JSON') ? 'Not a valid backup file' : ex.message); }
  });

  load().catch((e) => { if (login.hidden && app.hidden) showLogin(); toast('Cannot reach panel. Refresh the page.'); });
})();
