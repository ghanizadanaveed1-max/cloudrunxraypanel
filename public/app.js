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
    data = null; clearTimeout(retryTimer); retries = 0; showLogin();
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

  load().catch((e) => { if (login.hidden && app.hidden) showLogin(); toast('Cannot reach panel. Refresh the page.'); });
})();
