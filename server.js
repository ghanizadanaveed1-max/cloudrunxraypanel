'use strict';
/**
 * Cloud Run Xray Panel
 * - Public port ($PORT) serves the web panel and forwards WebSocket upgrades
 *   on /vless, /vmess, /trojan to Xray listening on localhost.
 * - Cloud Run terminates TLS, so clients connect with TLS on port 443.
 */
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

let QRCode = null;
try { QRCode = require('qrcode'); } catch (e) { console.warn('qrcode module missing:', e.message); }

// ---------- Settings (override with environment variables) ----------
const PORT = parseInt(process.env.PORT || '8080', 10);
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || 'Ghanizada';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Stable UUID across instances/restarts: env value, or derived from the password.
function uuidFrom(seed) {
  const h = sha(seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const UUID = process.env.UUID || uuidFrom('ghanizada-uuid:' + PANEL_PASSWORD);
const TROJAN_PASSWORD = process.env.TROJAN_PASSWORD || sha('ghanizada-trojan:' + PANEL_PASSWORD).slice(0, 24);
const PUBLIC_HOST = process.env.PUBLIC_HOST || '';       // optional fixed host
const ADDRESS = process.env.ADDRESS || '';               // optional connect address (clean IP / domain)
const REMARK = process.env.REMARK || 'CloudRun';
const SECRET = sha('session:' + PANEL_PASSWORD + UUID);
const DATA_DIR = process.env.DATA_DIR || path.join(os.tmpdir(), 'panel-data');
const GCS_BUCKET = process.env.GCS_BUCKET || '';          // optional: persist users in a Cloud Storage bucket
const GCS_OBJECT = process.env.GCS_OBJECT || 'users.json';
const XRAY_API_PORT = 10085;

const PROTOCOLS = {
  vless:  { path: '/vless',  port: 10001 },
  vmess:  { path: '/vmess',  port: 10002 },
  trojan: { path: '/trojan', port: 10003 },
};
const ROUTES = {};
for (const k of Object.keys(PROTOCOLS)) ROUTES[PROTOCOLS[k].path] = PROTOCOLS[k].port;

// ---------- Users database ----------
// Stored as JSON in DATA_DIR. Cloud Run disk is wiped when an instance stops, so
// set GCS_BUCKET to also keep a copy in Cloud Storage (uses the service account, no extra packages).
const DATA_FILE = path.join(DATA_DIR, 'users.json');
let db = { users: [] };
let saveTimer = null, saving = false, dirty = false;

const newId = () => crypto.randomBytes(4).toString('hex');
const newPassword = () => crypto.randomBytes(12).toString('hex');
const newToken = () => crypto.randomBytes(16).toString('hex');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const emailOf = (u) => `${u.id}@panel`;

function userStatus(u) {
  if (!u.enabled) return 'disabled';
  if (u.expireAt && u.expireAt <= Date.now()) return 'expired';
  if (u.limitBytes && u.up + u.down >= u.limitBytes) return 'limited';
  return 'active';
}
const publicUser = (u) => ({ ...u, status: userStatus(u), used: u.up + u.down });

function request(urlStr, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method, headers, timeout: 10000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

let gcsTok = { v: '', exp: 0 };
async function gcsToken() {
  if (gcsTok.v && gcsTok.exp > Date.now() + 60000) return gcsTok.v;
  const r = await request('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' } });
  if (r.status !== 200) throw new Error('metadata token ' + r.status);
  const j = JSON.parse(r.body);
  gcsTok = { v: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return gcsTok.v;
}

function normalizeUser(raw, existing = []) {
  const taken = new Set(existing.map((x) => x.id));
  const takenUuid = new Set(existing.map((x) => x.uuid));
  let id = /^[0-9a-f]{8}$/.test(raw.id || '') && !taken.has(raw.id) ? raw.id : newId();
  while (taken.has(id)) id = newId();
  let uuid = UUID_RE.test(raw.uuid || '') && !takenUuid.has(String(raw.uuid).toLowerCase()) && raw.uuid.toLowerCase() !== UUID.toLowerCase()
    ? String(raw.uuid).toLowerCase() : crypto.randomUUID();
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);
  return {
    id,
    name: String(raw.name || 'user').trim().slice(0, 40) || 'user',
    uuid,
    trojan: typeof raw.trojan === 'string' && /^[\w-]{8,64}$/.test(raw.trojan) ? raw.trojan : newPassword(),
    subToken: typeof raw.subToken === 'string' && /^[0-9a-f]{32}$/.test(raw.subToken) ? raw.subToken : newToken(),
    enabled: raw.enabled !== false,
    limitBytes: num(raw.limitBytes),
    expireAt: num(raw.expireAt),
    up: num(raw.up), down: num(raw.down),
    note: String(raw.note || '').slice(0, 200),
    createdAt: num(raw.createdAt) || Date.now(),
  };
}

async function loadDb() {
  let text = null;
  if (GCS_BUCKET) {
    try {
      const tok = await gcsToken();
      const r = await request(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(GCS_BUCKET)}/o/${encodeURIComponent(GCS_OBJECT)}?alt=media`,
        { headers: { Authorization: 'Bearer ' + tok } });
      if (r.status === 200) text = r.body;
      else if (r.status !== 404) console.warn('GCS load failed:', r.status, r.body.slice(0, 200));
    } catch (e) { console.warn('GCS load error:', e.message); }
  }
  if (text === null) { try { text = fs.readFileSync(DATA_FILE, 'utf8'); } catch (_) {} }
  if (text) {
    try {
      const j = JSON.parse(text);
      const users = [];
      for (const raw of Array.isArray(j.users) ? j.users : []) users.push(normalizeUser(raw, users));
      db.users = users;
    } catch (e) { console.warn('users.json is invalid:', e.message); }
  }
  console.log(`Loaded ${db.users.length} user(s)${GCS_BUCKET ? ' (Cloud Storage: ' + GCS_BUCKET + ')' : ''}`);
}

async function saveDb() {
  if (saving) { dirty = true; return; }
  saving = true; dirty = false;
  const text = JSON.stringify({ version: 1, users: db.users }, null, 2);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE + '.tmp', text);
    fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
  } catch (e) { console.warn('Local save failed:', e.message); }
  if (GCS_BUCKET) {
    try {
      const tok = await gcsToken();
      const r = await request(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(GCS_BUCKET)}/o?uploadType=media&name=${encodeURIComponent(GCS_OBJECT)}`,
        { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) }, body: text });
      if (r.status >= 300) console.warn('GCS save failed:', r.status, r.body.slice(0, 200));
    } catch (e) { console.warn('GCS save error:', e.message); }
  }
  saving = false;
  if (dirty) markDirty();
}
function markDirty() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveDb(); }, 1500);
}

// ---------- Xray ----------
const adminEmail = 'admin@panel';
const activeUsers = () => db.users.filter((u) => userStatus(u) === 'active');

function xrayConfig() {
  const ws = (p) => ({ network: 'ws', security: 'none', wsSettings: { path: p } });
  const users = activeUsers();
  return {
    log: { loglevel: 'warning' },
    stats: {},
    api: { tag: 'api', services: ['StatsService'] },
    policy: { levels: { '0': { statsUserUplink: true, statsUserDownlink: true } } },
    inbounds: [
      {
        tag: 'api-in', listen: '127.0.0.1', port: XRAY_API_PORT, protocol: 'dokodemo-door',
        settings: { address: '127.0.0.1' },
      },
      {
        tag: 'vless-in', listen: '127.0.0.1', port: PROTOCOLS.vless.port, protocol: 'vless',
        settings: { clients: [{ id: UUID, email: adminEmail, level: 0 }, ...users.map((u) => ({ id: u.uuid, email: emailOf(u), level: 0 }))], decryption: 'none' },
        streamSettings: ws(PROTOCOLS.vless.path),
      },
      {
        tag: 'vmess-in', listen: '127.0.0.1', port: PROTOCOLS.vmess.port, protocol: 'vmess',
        settings: { clients: [{ id: UUID, alterId: 0, email: adminEmail, level: 0 }, ...users.map((u) => ({ id: u.uuid, alterId: 0, email: emailOf(u), level: 0 }))] },
        streamSettings: ws(PROTOCOLS.vmess.path),
      },
      {
        tag: 'trojan-in', listen: '127.0.0.1', port: PROTOCOLS.trojan.port, protocol: 'trojan',
        settings: { clients: [{ password: TROJAN_PASSWORD, email: adminEmail, level: 0 }, ...users.map((u) => ({ password: u.trojan, email: emailOf(u), level: 0 }))] },
        streamSettings: ws(PROTOCOLS.trojan.path),
      },
    ],
    outbounds: [
      { protocol: 'freedom', tag: 'direct' },
      { protocol: 'blackhole', tag: 'block' },
    ],
    routing: { rules: [{ type: 'field', inboundTag: ['api-in'], outboundTag: 'api' }] },
  };
}

const XRAY_BIN = process.env.XRAY_BIN || '/opt/xray/xray';
const XRAY_CFG = path.join(os.tmpdir(), 'xray-config.json');
let xrayState = 'starting', xrayChild = null, xrayCfgStr = '', syncTimer = null;

function startXray() {
  xrayCfgStr = JSON.stringify(xrayConfig(), null, 2);
  fs.writeFileSync(XRAY_CFG, xrayCfgStr);
  if (!fs.existsSync(XRAY_BIN)) {
    xrayState = 'missing';
    console.warn('Xray binary not found at', XRAY_BIN);
    return;
  }
  const child = spawn(XRAY_BIN, ['run', '-config', XRAY_CFG], { stdio: 'inherit' });
  xrayChild = child;
  xrayState = 'running';
  child.on('exit', (code) => {
    if (xrayChild === child) xrayChild = null;
    xrayState = 'restarting';
    console.error('Xray exited with code', code, '- restarting');
    setTimeout(startXray, 800);
  });
}

// Per-user traffic: read and reset Xray's counters, add them to each user's total.
let polling = false;
function pollStats() {
  if (polling || !xrayChild) return Promise.resolve();
  polling = true;
  return new Promise((resolve) => {
    execFile(XRAY_BIN, ['api', 'statsquery', '-s', `127.0.0.1:${XRAY_API_PORT}`, '-reset'],
      { timeout: 8000, maxBuffer: 4 << 20 }, (err, out) => {
        polling = false;
        if (err) return resolve();
        try {
          const byEmail = new Map(db.users.map((u) => [emailOf(u), u]));
          let changed = false;
          for (const s of JSON.parse(out).stat || []) {
            const m = /^user>>>(.+)>>>traffic>>>(uplink|downlink)$/.exec(s.name || '');
            const u = m && byEmail.get(m[1]);
            const v = Number(s.value) || 0;
            if (!u || !v) continue;
            if (m[2] === 'uplink') u.up += v; else u.down += v;
            changed = true;
          }
          if (changed) markDirty();
        } catch (_) {}
        resolve();
      });
  });
}

// If the set of allowed users changed (added, removed, expired, over quota), restart Xray with the new list.
async function syncXray() {
  if (!xrayChild || JSON.stringify(xrayConfig(), null, 2) === xrayCfgStr) return;
  await pollStats();
  if (xrayChild) xrayChild.kill();
}
function scheduleSync(ms = 800) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncXray, ms);
}
setInterval(async () => { await pollStats(); scheduleSync(0); }, 20000).unref();

// ---------- Auth ----------
const hmac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
function makeToken() {
  const exp = Date.now() + 1000 * 60 * 60 * 12;
  return `${exp}.${hmac(String(exp))}`;
}
function validToken(tok) {
  if (!tok) return false;
  const [exp, sig] = tok.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = hmac(exp);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
const isAuthed = (req) => validToken(cookies(req).panel_session);

const attempts = new Map(); // ip -> {n, until}
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

// ---------- Helpers ----------
function hostOf(req) {
  const h = PUBLIC_HOST || req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  return String(h).split(':')[0];
}
const ADMIN_ID = { uuid: UUID, trojan: TROJAN_PASSWORD, remark: REMARK };
function buildConfigs(req, who = ADMIN_ID) {
  const UUID = who.uuid, TROJAN_PASSWORD = who.trojan, REMARK = who.remark;
  const host = hostOf(req);
  const address = ADDRESS || host;
  const port = 443;
  const enc = encodeURIComponent;

  const vlessLink = `vless://${UUID}@${address}:${port}?encryption=none&security=tls&sni=${host}&fp=chrome&type=ws&host=${host}&path=${enc(PROTOCOLS.vless.path)}#${enc(REMARK + '-VLESS')}`;

  const vmessObj = {
    v: '2', ps: `${REMARK}-VMess`, add: address, port: String(port), id: UUID, aid: '0',
    scy: 'auto', net: 'ws', type: 'none', host, path: PROTOCOLS.vmess.path,
    tls: 'tls', sni: host, alpn: '', fp: 'chrome',
  };
  const vmessLink = 'vmess://' + Buffer.from(JSON.stringify(vmessObj)).toString('base64');

  const trojanLink = `trojan://${enc(TROJAN_PASSWORD)}@${address}:${port}?security=tls&sni=${host}&fp=chrome&type=ws&host=${host}&path=${enc(PROTOCOLS.trojan.path)}#${enc(REMARK + '-Trojan')}`;

  const common = { address, port, host, sni: host, tls: 'TLS', network: 'WebSocket', fingerprint: 'chrome' };
  return {
    host, address, port, xray: xrayState,
    protocols: [
      { id: 'vless', name: 'VLESS', link: vlessLink,
        fields: { Protocol: 'VLESS', Address: common.address, Port: port, 'User ID (UUID)': UUID, Encryption: 'none',
          Network: common.network, Security: common.tls, SNI: common.sni, 'Host header': common.host, Path: PROTOCOLS.vless.path, Fingerprint: common.fingerprint } },
      { id: 'vmess', name: 'VMess', link: vmessLink,
        fields: { Protocol: 'VMess', Address: common.address, Port: port, 'User ID (UUID)': UUID, 'Alter ID': 0, Security: 'auto',
          Network: common.network, TLS: common.tls, SNI: common.sni, 'Host header': common.host, Path: PROTOCOLS.vmess.path, Fingerprint: common.fingerprint } },
      { id: 'trojan', name: 'Trojan', link: trojanLink,
        fields: { Protocol: 'Trojan', Address: common.address, Port: port, Password: TROJAN_PASSWORD,
          Network: common.network, Security: common.tls, SNI: common.sni, 'Host header': common.host, Path: PROTOCOLS.trojan.path, Fingerprint: common.fingerprint } },
    ],
  };
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > limit) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
function send(res, code, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};
const PUBLIC_DIR = path.join(__dirname, 'public');
function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(buf);
  });
}

// ---------- User management API ----------
function userIdentity(u) {
  return { uuid: u.uuid, trojan: u.trojan, remark: `${REMARK}-${u.name.replace(/[^\w.\- ]+/g, '').trim() || u.id}` };
}
function applyFields(u, b) {
  if ('name' in b) { const n = String(b.name).trim().slice(0, 40); if (!n) throw new Error('Name is required.'); u.name = n; }
  if ('note' in b) u.note = String(b.note).slice(0, 200);
  if ('enabled' in b) u.enabled = !!b.enabled;
  if ('limitGB' in b) {
    const g = Number(b.limitGB);
    if (!Number.isFinite(g) || g < 0 || g > 1e6) throw new Error('Traffic limit must be 0 or more (GB).');
    u.limitBytes = Math.round(g * 1024 ** 3);
  }
  if ('expireAt' in b) {
    const t = Number(b.expireAt || 0);
    if (!Number.isFinite(t) || t < 0) throw new Error('Bad expiry date.');
    u.expireAt = Math.floor(t);
  }
}
async function userApi(req, res, p) {
  const method = req.method;
  const readJson = async (limit) => { try { return JSON.parse((await readBody(req, limit)) || '{}'); } catch (_) { throw new Error('Bad request body.'); } };
  const list = () => ({
    users: db.users.map(publicUser),
    summary: {
      total: db.users.length,
      active: db.users.filter((u) => userStatus(u) === 'active').length,
      traffic: db.users.reduce((a, u) => a + u.up + u.down, 0),
      persistent: !!GCS_BUCKET,
    },
  });

  try {
    if (p === '/api/users' && method === 'GET') return send(res, 200, list());

    if (p === '/api/users' && method === 'POST') {
      const b = await readJson();
      if (!String(b.name || '').trim()) throw new Error('Name is required.');
      const u = normalizeUser({ name: 'user' }, db.users);
      applyFields(u, b);
      u.up = u.down = 0;
      db.users.push(u);
      markDirty(); scheduleSync();
      return send(res, 201, { user: publicUser(u), ...list() });
    }

    if (p === '/api/export' && method === 'GET') {
      return send(res, 200, JSON.stringify({ version: 1, users: db.users }, null, 2), {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="panel-users.json"',
      });
    }
    if (p === '/api/import' && method === 'POST') {
      const j = await readJson(2 * 1024 * 1024);
      if (!Array.isArray(j.users) || j.users.length > 5000) throw new Error('File has no users list.');
      const users = [];
      for (const raw of j.users) users.push(normalizeUser(raw, users));
      db.users = users;
      markDirty(); scheduleSync();
      return send(res, 200, list());
    }

    const m = /^\/api\/users\/([0-9a-f]{8})(?:\/(reset|regen|config))?$/.exec(p);
    if (!m) return send(res, 404, { error: 'Not found.' });
    const u = db.users.find((x) => x.id === m[1]);
    if (!u) return send(res, 404, { error: 'User not found.' });

    if (m[2] === 'config' && method === 'GET') return send(res, 200, { ...buildConfigs(req, userIdentity(u)), user: publicUser(u), sub: `https://${hostOf(req)}/sub/${u.subToken}` });
    if (m[2] === 'reset' && method === 'POST') { await pollStats(); u.up = u.down = 0; markDirty(); scheduleSync(); return send(res, 200, { user: publicUser(u), ...list() }); }
    if (m[2] === 'regen' && method === 'POST') {
      u.uuid = crypto.randomUUID(); u.trojan = newPassword(); u.subToken = newToken();
      markDirty(); scheduleSync();
      return send(res, 200, { user: publicUser(u), ...list() });
    }
    if (!m[2] && method === 'PATCH') {
      applyFields(u, await readJson());
      markDirty(); scheduleSync();
      return send(res, 200, { user: publicUser(u), ...list() });
    }
    if (!m[2] && method === 'DELETE') {
      db.users = db.users.filter((x) => x !== u);
      markDirty(); scheduleSync();
      return send(res, 200, list());
    }
    return send(res, 405, { error: 'Method not allowed.' });
  } catch (e) {
    return send(res, 400, { error: e.message || 'Bad request.' });
  }
}

// ---------- HTTP server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  try {
    if (p === '/healthz') return send(res, 200, 'ok');

    if (p === '/api/login' && req.method === 'POST') {
      const ip = clientIp(req);
      const rec = attempts.get(ip) || { n: 0, until: 0 };
      if (rec.until > Date.now()) return send(res, 429, { error: 'Too many attempts. Try again in a minute.' });
      let pw = '';
      try { pw = String(JSON.parse(await readBody(req)).password || ''); } catch (_) {}
      const a = Buffer.from(sha(pw)), b = Buffer.from(sha(PANEL_PASSWORD));
      if (crypto.timingSafeEqual(a, b)) {
        attempts.delete(ip);
        const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
        return send(res, 200, { ok: true }, {
          'Set-Cookie': `panel_session=${encodeURIComponent(makeToken())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${secure}`,
        });
      }
      rec.n += 1;
      if (rec.n >= 6) { rec.until = Date.now() + 60000; rec.n = 0; }
      attempts.set(ip, rec);
      return send(res, 401, { error: 'Wrong password.' });
    }

    if (p === '/api/logout' && req.method === 'POST') {
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'panel_session=; Path=/; HttpOnly; Max-Age=0' });
    }

    if (p === '/api/config') {
      if (!isAuthed(req)) return send(res, 401, { error: 'Not signed in.' });
      return send(res, 200, buildConfigs(req));
    }


    // ----- Subscription (public, token protected) -----
    let m = /^\/sub\/([0-9a-f]{32})$/.exec(p);
    if (m && (req.method === 'GET' || req.method === 'HEAD')) {
      const u = db.users.find((x) => x.subToken === m[1]);
      if (!u) return send(res, 404, 'Not found');
      if (userStatus(u) !== 'active') return send(res, 403, 'Subscription is ' + userStatus(u) + '.');
      const cfg = buildConfigs(req, userIdentity(u));
      const body = Buffer.from(cfg.protocols.map((x) => x.link).join('\n')).toString('base64');
      return send(res, 200, body, {
        'Subscription-Userinfo': `upload=${u.up}; download=${u.down}; total=${u.limitBytes}; expire=${u.expireAt ? Math.floor(u.expireAt / 1000) : 0}`,
        'Profile-Update-Interval': '6',
        'Profile-Title': 'base64:' + Buffer.from(REMARK + ' ' + u.name).toString('base64'),
      });
    }

    // ----- User management (admin only) -----
    if (p === '/api/users' || p.startsWith('/api/users/') || p === '/api/export' || p === '/api/import') {
      if (!isAuthed(req)) return send(res, 401, { error: 'Not signed in.' });
      return await userApi(req, res, p);
    }

    if (p === '/api/qr') {
      if (!isAuthed(req)) return send(res, 401, { error: 'Not signed in.' });
      const text = url.searchParams.get('text') || '';
      if (!text || text.length > 2500) return send(res, 400, { error: 'Bad text.' });
      if (!QRCode) return send(res, 500, { error: 'QR module unavailable.' });
      const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'L',
        color: { dark: '#07141c', light: '#ffffff' } });
      return send(res, 200, svg, { 'Content-Type': 'image/svg+xml; charset=utf-8' });
    }

    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p);
    return send(res, 405, 'Method not allowed');
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: 'Server error.' });
  }
});

// ---------- WebSocket passthrough to Xray ----------
server.on('upgrade', (req, socket, head) => {
  const p = (req.url || '').split('?')[0];
  const target = ROUTES[p];
  if (!target) return socket.destroy();

  const up = net.connect(target, '127.0.0.1');
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 30000);
  up.setNoDelay(true);

  up.on('connect', () => {
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    raw += '\r\n';
    up.write(raw);
    if (head && head.length) up.write(head);
    socket.pipe(up);
    up.pipe(socket);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
  socket.on('close', () => up.destroy());
  up.on('close', () => socket.destroy());
});

server.keepAliveTimeout = 620000;
server.headersTimeout = 625000;
loadDb().catch((e) => console.warn('Load failed:', e.message)).then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Panel listening on :${PORT}`);
    startXray();
  });
});

// Cloud Run sends SIGTERM before stopping an instance: save traffic counters first.
let stopping = false;
process.on('SIGTERM', async () => {
  if (stopping) return; stopping = true;
  try { await pollStats(); await saveDb(); } catch (_) {}
  process.exit(0);
});
