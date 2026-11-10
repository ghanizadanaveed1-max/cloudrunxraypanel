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
const crypto = require('crypto');
const { spawn } = require('child_process');

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

const PROTOCOLS = {
  vless:  { path: '/vless',  port: 10001 },
  vmess:  { path: '/vmess',  port: 10002 },
  trojan: { path: '/trojan', port: 10003 },
};
const ROUTES = {};
for (const k of Object.keys(PROTOCOLS)) ROUTES[PROTOCOLS[k].path] = PROTOCOLS[k].port;

// ---------- Xray ----------
function xrayConfig() {
  const ws = (p) => ({ network: 'ws', security: 'none', wsSettings: { path: p } });
  return {
    log: { loglevel: 'warning' },
    inbounds: [
      {
        tag: 'vless-in', listen: '127.0.0.1', port: PROTOCOLS.vless.port, protocol: 'vless',
        settings: { clients: [{ id: UUID }], decryption: 'none' },
        streamSettings: ws(PROTOCOLS.vless.path),
      },
      {
        tag: 'vmess-in', listen: '127.0.0.1', port: PROTOCOLS.vmess.port, protocol: 'vmess',
        settings: { clients: [{ id: UUID, alterId: 0 }] },
        streamSettings: ws(PROTOCOLS.vmess.path),
      },
      {
        tag: 'trojan-in', listen: '127.0.0.1', port: PROTOCOLS.trojan.port, protocol: 'trojan',
        settings: { clients: [{ password: TROJAN_PASSWORD }] },
        streamSettings: ws(PROTOCOLS.trojan.path),
      },
    ],
    outbounds: [
      { protocol: 'freedom', tag: 'direct' },
      { protocol: 'blackhole', tag: 'block' },
    ],
  };
}

let xrayState = 'starting';
function startXray() {
  const bin = process.env.XRAY_BIN || '/opt/xray/xray';
  const cfgPath = path.join(require('os').tmpdir(), 'xray-config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(xrayConfig(), null, 2));
  if (!fs.existsSync(bin)) {
    xrayState = 'missing';
    console.warn('Xray binary not found at', bin);
    return;
  }
  const child = spawn(bin, ['run', '-config', cfgPath], { stdio: 'inherit' });
  xrayState = 'running';
  child.on('exit', (code) => {
    xrayState = 'restarting';
    console.error('Xray exited with code', code, '- restarting in 2s');
    setTimeout(startXray, 2000);
  });
}

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
function buildConfigs(req) {
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
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Panel listening on :${PORT}`);
  startXray();
});
