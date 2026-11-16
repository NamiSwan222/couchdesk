const { app, BrowserWindow, ipcMain, session, desktopCapturer, screen, Menu, clipboard } = require('electron');
const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const input = require('./input');

// Let WebRTC use the real VPN/LAN address instead of an mDNS name (Radmin VPN has no mDNS).
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

let win, wss = null, cfg;
const clients = new Map(); // sid -> ws
let nextSid = 1;
const fails = new Map();   // ip -> {n, until}

const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
function loadCfg() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(cfgFile(), 'utf8')); } catch (_) {}
  if (!/^\d{6}$/.test(c.pin || '')) c.pin = String(crypto.randomInt(100000, 1000000));
  c.port = c.port || 47800;
  return c;
}
const saveCfg = () => { try { fs.writeFileSync(cfgFile(), JSON.stringify(cfg)); } catch (_) {} };
const tell = (ch, d) => { if (win && !win.isDestroyed()) win.webContents.send(ch, d); };

function addresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces()))
    for (const a of list || [])
      if (a.family === 'IPv4' && !a.internal)
        out.push({ ip: a.address, name, radmin: a.address.startsWith('26.') || /radmin/i.test(name) });
  return out.sort((a, b) => b.radmin - a.radmin);
}

function startHost() {
  if (wss) return { ok: true };
  try {
    wss = new WebSocketServer({ port: cfg.port, maxPayload: 256 * 1024 });
  } catch (e) { wss = null; return { ok: false, error: e.message }; }
  wss.on('error', (e) => {
    tell('host:error', e.code === 'EADDRINUSE' ? 'Port ' + cfg.port + ' is already in use.' : e.message);
  });
  wss.on('connection', (ws, req) => {
    const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
    let sid = null, authed = false;
    const timer = setTimeout(() => ws.close(), 8000);
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
      if (!authed) {
        const f = fails.get(ip);
        if (f && f.until > Date.now()) { ws.send(JSON.stringify({ type: 'denied', reason: 'locked' })); return ws.close(); }
        const a = Buffer.from(String(m.pin || '')), b = Buffer.from(cfg.pin);
        if (m.type === 'hello' && a.length === b.length && crypto.timingSafeEqual(a, b)) {
          authed = true; clearTimeout(timer); fails.delete(ip);
          sid = nextSid++; clients.set(sid, ws);
          ws.send(JSON.stringify({ type: 'welcome', name: os.hostname() }));
          tell('host:viewer', { sid, joined: true, ip, label: String(m.name || 'Someone').slice(0, 40) });
        } else {
          const n = (f ? f.n : 0) + 1;
          fails.set(ip, { n, until: n >= 5 ? Date.now() + 60000 : 0 });
          ws.send(JSON.stringify({ type: 'denied', reason: 'pin' }));
          ws.close();
        }
        return;
      }
      tell('host:signal', { sid, msg: m });
    });
    ws.on('close', () => {
      clearTimeout(timer);
      if (sid) { clients.delete(sid); tell('host:viewer', { sid, joined: false }); }
    });
  });
  return { ok: true };
}

function stopHost() {
  for (const ws of clients.values()) { try { ws.close(); } catch (_) {} }
  clients.clear();
  if (wss) { wss.close(); wss = null; }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 600, backgroundColor: '#15120e',
    title: 'CouchDesk', autoHideMenuBar: true, icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
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
  session.defaultSession.setPermissionRequestHandler((_w, p, cb) => cb(p === 'display-capture' || p === 'media'));

  ipcMain.handle('info', () => ({ pin: cfg.pin, port: cfg.port, host: os.hostname(), addrs: addresses(), canInject: input.available() }));
  ipcMain.handle('host:start', () => startHost());
  ipcMain.handle('host:stop', () => { stopHost(); return true; });
  ipcMain.handle('host:newpin', () => { cfg.pin = String(crypto.randomInt(100000, 1000000)); saveCfg(); return cfg.pin; });
  ipcMain.handle('copy', (_e, t) => { clipboard.writeText(String(t)); });
  ipcMain.on('host:send', (_e, { sid, msg }) => { const ws = clients.get(sid); if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); });
  ipcMain.on('host:kick', (_e, sid) => { const ws = clients.get(sid); if (ws) ws.close(); });
  ipcMain.on('input', (_e, ev) => input.inject(ev));
  ipcMain.handle('version', () => app.getVersion());
  ipcMain.handle('update:check', () => checkForUpdates());
  ipcMain.on('update:install', () => { stopHost(); autoUpdater && autoUpdater.quitAndInstall(); });
  createWindow();
  setupUpdater();
});

/* ---- in-app updates (GitHub Releases) ---- */
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
