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
    data = null; showLogin();
  });

  /* ---------- data ---------- */
  async function load() {
    const r = await fetch('/api/config');
    if (r.status === 401) return showLogin();
    data = await r.json();
    showApp();
    $('#hostText').textContent = data.host;
    $('#chipPort').textContent = data.port;
    const chip = $('#chipStatus');
    const ok = data.xray === 'running';
    chip.className = ok ? 'chip-ok' : 'chip-bad';
    chip.innerHTML = `<i class="dot"></i><span>${ok ? 'Online' : 'Engine ' + esc(data.xray)}</span>`;
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

  $('#saveQr').addEventListener('click', () => {
    const svg = qrCache[current]; if (!svg) return toast('QR not ready yet');
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `${current}-qr.svg`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  load().catch(showLogin);
})();
