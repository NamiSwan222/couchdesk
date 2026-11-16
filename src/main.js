const { app, BrowserWindow, ipcMain, session, desktopCapturer, screen, Menu, clipboard, Notification } = require('electron');
const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto'), dgram = require('dgram');
const { WebSocketServer } = require('ws');
const input = require('./input');

// Let WebRTC use the real VPN/LAN address instead of an mDNS name (Radmin VPN has no mDNS).
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
app.setAppUserModelId('com.namiswan.couchdesk');

const DISC_PORT = 47801;          // UDP: friends announce themselves here
const ASK_TIMEOUT = 30000;        // how long the host has to accept a request
let win, wss = null, cfg;
const clients = new Map();        // sid -> ws (accepted viewers)
const pending = new Map();        // rid -> { ws, ip, name, timer, accept }
const cooldown = new Map();       // ip -> time until which new requests are refused (after a decline)
let nextSid = 1, nextRid = 1;

/* ---------------------------------------------------------------- config */
const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
function defaultName() {
  let u = '';
  try { u = os.userInfo().username || ''; } catch (_) {}
  return u ? u.charAt(0).toUpperCase() + u.slice(1) + "'s PC" : os.hostname();
}
function loadCfg() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(cfgFile(), 'utf8')); } catch (_) {}
  if (!c.id) c.id = crypto.randomUUID();
  if (!c.name) c.name = defaultName();
  if (typeof c.sharing !== 'boolean') c.sharing = true;
  c.port = c.port || 47800;
  delete c.pin;
  return c;
}
const saveCfg = () => { try { fs.writeFileSync(cfgFile(), JSON.stringify(cfg)); } catch (_) {} };
const tell = (ch, d) => { if (win && !win.isDestroyed()) win.webContents.send(ch, d); };
const clean = (s, n = 40) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);

function addresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces()))
    for (const a of list || [])
      if (a.family === 'IPv4' && !a.internal)
        out.push({ ip: a.address, name, mask: a.netmask, radmin: a.address.startsWith('26.') || /radmin/i.test(name) });
  return out.sort((a, b) => b.radmin - a.radmin);
}

/* ---------------------------------------------------------------- hosting */
function startHost() {
  if (wss) return { ok: true };
  try {
    wss = new WebSocketServer({ port: cfg.port, maxPayload: 256 * 1024 });
  } catch (e) { wss = null; return { ok: false, error: e.message }; }
  wss.on('error', (e) => {
    try { wss.close(); } catch (_) {}
    wss = null;
    tell('host:error', e.code === 'EADDRINUSE' ? 'Another program is using port ' + cfg.port + ', so friends cannot connect.' : e.message);
    announce();
  });
  wss.on('connection', onViewerSocket);
  return { ok: true };
}

function onViewerSocket(ws, req) {
  const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
  const send = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  let sid = null, rid = null, stage = 'hello';
  const helloTimer = setTimeout(() => ws.close(), 8000);

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
    if (stage === 'hello') {
      if (m.type !== 'hello') return ws.close();
      clearTimeout(helloTimer);
      const name = clean(m.name) || 'Someone';
      if ((cooldown.get(ip) || 0) > Date.now()) { send({ type: 'denied', reason: 'declined' }); return ws.close(); }
      if ([...pending.values()].some((p) => p.ip === ip)) { send({ type: 'denied', reason: 'busy' }); return ws.close(); }
      stage = 'waiting';
      rid = nextRid++;
      const expires = Date.now() + ASK_TIMEOUT;
      pending.set(rid, {
        ws, ip, name,
        timer: setTimeout(() => decide(rid, false, 'timeout'), ASK_TIMEOUT),
        accept: () => {
          stage = 'live'; sid = nextSid++; clients.set(sid, ws);
          send({ type: 'welcome', name: cfg.name });
          tell('host:viewer', { sid, joined: true, ip, label: name });
        },
      });
      send({ type: 'pending', name: cfg.name });
      tell('host:request', { rid, name, ip, expires });
      nudge(name);
      return;
    }
    if (stage === 'live') tell('host:signal', { sid, msg: m });
  });

  ws.on('close', () => {
    clearTimeout(helloTimer);
    if (rid && pending.has(rid)) { clearTimeout(pending.get(rid).timer); pending.delete(rid); tell('host:request-gone', { rid }); }
    if (sid) { clients.delete(sid); tell('host:viewer', { sid, joined: false }); }
  });
}

function decide(rid, accept, reason = 'declined') {
  const p = pending.get(rid);
  if (!p) return;
  pending.delete(rid); clearTimeout(p.timer);
  tell('host:request-gone', { rid });
  if (p.ws.readyState !== 1) return;
  if (accept) return p.accept();
  if (reason === 'declined') cooldown.set(p.ip, Date.now() + 10000);
  p.ws.send(JSON.stringify({ type: 'denied', reason }));
  p.ws.close();
}

function stopHost() {
  for (const rid of [...pending.keys()]) decide(rid, false, 'off');
  for (const ws of clients.values()) { try { ws.close(); } catch (_) {} }
  clients.clear();
  if (wss) { wss.close(); wss = null; }
}

// Make sure the person sitting at this PC notices a request, even if the window is in the background.
function nudge(name) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (!win.isFocused()) {
    win.flashFrame(true);
    if (Notification.isSupported()) {
      const n = new Notification({ title: name + ' wants to connect', body: 'Open CouchDesk to accept or decline.', icon: path.join(__dirname, '..', 'build', 'icon.png') });
      n.on('click', () => { win.show(); win.focus(); });
      n.show();
    }
  }
}

/* ---------------------------------------------------------------- friend discovery (LAN / Radmin VPN broadcast) */
let disc = null;
const found = new Map(); // id -> { id, name, port, sharing, ips: Map(ip -> lastSeen), seen }

function broadcastTargets() {
  const out = new Set(['255.255.255.255']);
  for (const a of addresses()) {
    if (!a.mask) continue;
    const ip = a.ip.split('.').map(Number), mk = a.mask.split('.').map(Number);
    out.add(ip.map((o, i) => (o | (~mk[i] & 255)) & 255).join('.'));
  }
  return [...out];
}
function announce(to, ask) {
  if (!disc) return;
  const msg = Buffer.from(JSON.stringify({ app: 'couchdesk', v: 1, id: cfg.id, name: cfg.name, port: cfg.port, sharing: !!wss, ask: !!ask }));
  for (const a of to ? [to] : broadcastTargets()) { try { disc.send(msg, DISC_PORT, a, () => {}); } catch (_) {} }
}
const isLan = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
function bestIp(f) {
  const fresh = [...f.ips].filter(([, t]) => Date.now() - t < 10000).map(([ip]) => ip);
  return fresh.find(isLan) || fresh.find((ip) => ip.startsWith('26.')) || fresh[0] || [...f.ips.keys()][0];
}
function friendList() {
  return [...found.values()].map((f) => ({ id: f.id, name: f.name, port: f.port, sharing: f.sharing, ip: bestIp(f), radmin: bestIp(f).startsWith('26.') }));
}
let lastSent = '';
function pushFriends() {
  const list = friendList(), key = JSON.stringify(list);
  if (key !== lastSent) { lastSent = key; tell('friends', list); }
}
function startDiscovery() {
  try {
    disc = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  } catch (_) { disc = null; return; }
  disc.on('error', () => { try { disc.close(); } catch (_) {} disc = null; });
  disc.on('message', (buf, rinfo) => {
    let m; try { m = JSON.parse(buf.toString()); } catch (_) { return; }
    if (!m || m.app !== 'couchdesk' || !m.id || m.id === cfg.id) return;
    const id = clean(m.id, 64);
    const f = found.get(id) || { id, ips: new Map() };
    f.name = clean(m.name) || 'A PC';
    f.port = Number(m.port) > 0 && Number(m.port) < 65536 ? Number(m.port) : 47800;
    f.sharing = !!m.sharing;
    f.ips.set(rinfo.address, Date.now());
    f.seen = Date.now();
    found.set(id, f);
    pushFriends();
    if (m.ask) announce(rinfo.address);
  });
  disc.bind(DISC_PORT, () => {
    try { disc.setBroadcast(true); } catch (_) {}
    announce(null, true);
  });
  setInterval(() => {
    announce();
    for (const [id, f] of found) if (Date.now() - f.seen > 10000) found.delete(id);
    pushFriends();
  }, 3000);
}

/* ---------------------------------------------------------------- window + IPC */
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 940, minHeight: 600, backgroundColor: '#15120e',
    title: 'CouchDesk', autoHideMenuBar: true, icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.on('focus', () => win.flashFrame(false));
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  cfg = loadCfg(); saveCfg();
  Menu.setApplicationMenu(null);
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    const srcs = await desktopCapturer.getSources({ types: ['screen'] });
    const pid = String(screen.getPrimaryDisplay().id);
    cb({ video: srcs.find((s) => s.display_id === pid) || srcs[0] });
  });
  session.defaultSession.setPermissionRequestHandler((_w, p, cb) => cb(p === 'display-capture' || p === 'media' || p === 'fullscreen' || p === 'keyboardLock'));

  ipcMain.handle('info', () => ({ id: cfg.id, name: cfg.name, port: cfg.port, sharing: !!wss, addrs: addresses(), canInject: input.available() }));
  ipcMain.handle('set-name', (_e, n) => { const v = clean(n, 30); if (v) { cfg.name = v; saveCfg(); announce(); } return cfg.name; });
  ipcMain.handle('host:start', () => { const r = startHost(); cfg.sharing = !!wss; saveCfg(); announce(); return r; });
  ipcMain.handle('host:stop', () => { stopHost(); cfg.sharing = false; saveCfg(); announce(); return true; });
  ipcMain.on('host:decide', (_e, { rid, accept }) => decide(rid, !!accept));
  ipcMain.handle('friends', () => friendList());
  ipcMain.handle('copy', (_e, t) => { clipboard.writeText(String(t)); });
  ipcMain.on('host:send', (_e, { sid, msg }) => { const ws = clients.get(sid); if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); });
  ipcMain.on('host:kick', (_e, sid) => { const ws = clients.get(sid); if (ws) ws.close(); });
  ipcMain.on('input', (_e, ev) => input.inject(ev));
  ipcMain.handle('version', () => app.getVersion());
  ipcMain.handle('update:check', () => checkForUpdates());
  ipcMain.on('update:install', () => { stopHost(); autoUpdater && autoUpdater.quitAndInstall(); });

  if (cfg.sharing) startHost();
  createWindow();
  startDiscovery();
  setupUpdater();
});

/* ---------------------------------------------------------------- in-app updates (GitHub Releases) */
let autoUpdater = null;
const upd = (s) => tell('update', s);
function setupUpdater() {
  if (!app.isPackaged) return;
  try { ({ autoUpdater } = require('electron-updater')); } catch (_) { return; }
  autoUpdater.autoDownload = true;
  autoUpdater.on('checking-for-update', () => upd({ state: 'checking' }));
  autoUpdater.on('update-available', (i) => upd({ state: 'downloading', version: i.version, percent: 0 }));
  autoUpdater.on('update-not-available', () => upd({ state: 'current' }));
  autoUpdater.on('download-progress', (p) => upd({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => upd({ state: 'ready', version: i.version }));
  autoUpdater.on('error', (e) => upd({ state: 'error', message: String(e && e.message || e).split('\n')[0].slice(0, 120) }));
  setTimeout(checkForUpdates, 4000);
  setInterval(checkForUpdates, 6 * 3600 * 1000);
}
function checkForUpdates() {
  if (!autoUpdater) { upd({ state: 'dev' }); return false; }
  autoUpdater.checkForUpdates().catch(() => {});
  return true;
}
app.on('window-all-closed', () => { stopHost(); app.quit(); });
