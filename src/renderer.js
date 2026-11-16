'use strict';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PORT = 47800;
let me = { host: 'a PC' };

/* ------------------------------------------------------------------ saved PCs */
let machines = [];
try { machines = JSON.parse(localStorage.getItem('machines') || '[]'); } catch (_) {}
const saveMachines = () => localStorage.setItem('machines', JSON.stringify(machines));
let editing = null;

function renderMachines() {
  const ul = $('#machines');
  $('#noMachines').classList.toggle('hidden', machines.length > 0);
  ul.innerHTML = '';
  for (const m of machines) {
    const live = sessions.has(m.id);
    const li = document.createElement('li');
    li.className = 'machine' + (live ? ' live' : '');
    li.innerHTML = `<span class="dot"></span><div class="info"><div class="nm">${esc(m.name)}</div><div class="ad">${esc(m.host)}</div></div>
      <div class="acts"><button class="icon" data-a="edit" title="Edit">&#9998;</button><button class="icon" data-a="del" title="Remove">&#10005;</button>
      <button class="chip ${live ? '' : 'primary'}" data-a="go">${live ? 'Open' : 'Connect'}</button></div>`;
    li.onclick = (e) => {
      const a = e.target.closest('button')?.dataset.a;
      if (a === 'go') live ? focusSession(m.id) : connect(m);
      else if (a === 'edit') openDialog(m);
      else if (a === 'del') {
        if (confirm(`Remove "${m.name}" from your list?`)) { sessions.get(m.id)?.close(); machines = machines.filter((x) => x.id !== m.id); saveMachines(); renderMachines(); }
      }
    };
    ul.appendChild(li);
  }
}

function openDialog(m) {
  editing = m || null;
  $('#dlgTitle').textContent = m ? 'Edit PC' : 'Add a PC';
  $('#fName').value = m?.name || ''; $('#fHost').value = m?.host || ''; $('#fPin').value = m?.pin || '';
  $('#dlg').showModal();
}
$('#addBtn').onclick = () => openDialog(null);
$('#dlgCancel').onclick = () => $('#dlg').close();
$('#addForm').addEventListener('submit', () => {
  const name = $('#fName').value.trim(), host = $('#fHost').value.trim(), pin = $('#fPin').value.trim();
  if (!/^\d{6}$/.test(pin) || !host) return;
  if (editing) Object.assign(editing, { name, host, pin });
  else machines.push({ id: 'm' + Date.now(), name, host, pin });
  saveMachines(); renderMachines();
});

/* ------------------------------------------------------------------ viewer sessions */
// Ask the sender's encoder to start high and not collapse resolution (values in kbps).
function boostBitrate(sdp) {
  const hint = 'x-google-start-bitrate=6000;x-google-min-bitrate=500;x-google-max-bitrate=20000';
  const lines = sdp.split('\r\n');
  const mi = lines.findIndex((l) => l.startsWith('m=video'));
  if (mi < 0) return sdp;
  const pts = lines[mi].split(' ').slice(3);
  for (const pt of pts) {
    const ri = lines.findIndex((l) => l.startsWith('a=rtpmap:' + pt + ' '));
    if (ri < 0 || /^(rtx|red|ulpfec|flexfec-03)\//i.test(lines[ri].split(' ')[1])) continue;
    const fi = lines.findIndex((l) => l.startsWith('a=fmtp:' + pt + ' '));
    if (fi >= 0) lines[fi] += ';' + hint;
    else lines.splice(ri + 1, 0, 'a=fmtp:' + pt + ' ' + hint);
  }
  return lines.join('\r\n');
}

const sessions = new Map(); // machine id -> Session
let focusId = null, controlId = null, layout = localStorage.getItem('layout') || 'grid';

class Session {
  constructor(m) {
    this.m = m; this.alive = true; this.down = new Set(); this.lastMove = 0;
    const t = document.createElement('div');
    t.className = 'tile';
    t.innerHTML = `<div class="tbar"><span class="tn">${esc(m.name)}</span><span class="ms"></span><span class="badge hidden">CONTROLLING</span>
      <span class="ctl"><button class="icon" data-a="focus" title="Make this one big">&#9974;</button></span>
      <button class="icon" data-a="close" title="Disconnect">&#10005;</button></div>
      <div class="view"><video autoplay playsinline muted></video><div class="status"></div></div>`;
    this.el = t; this.video = t.querySelector('video'); this.status = t.querySelector('.status');
    this.ms = t.querySelector('.ms'); this.badge = t.querySelector('.badge');
    t.querySelector('.tbar').onclick = (e) => {
      const a = e.target.closest('button')?.dataset.a;
      if (a === 'close') this.close(); else if (a === 'focus') focusSession(m.id);
    };
    this.wireInput();
    $('#stage').appendChild(t);
    this.open();
  }
  say(html) { this.status.innerHTML = html; this.status.classList.toggle('hidden', !html); }
  open() {
    this.say('Knocking on ' + esc(this.m.name) + '&hellip;');
    let ws;
    try { ws = new WebSocket(`ws://${this.m.host}:${PORT}`); } catch (_) { return this.fail("That address doesn't look right."); }
    this.ws = ws;
    const giveUp = setTimeout(() => { if (!this.connected) this.fail("Couldn't reach it. Is CouchDesk running there with sharing switched on, and is Radmin VPN connected?"); }, 15000);
    this.giveUp = giveUp;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', pin: this.m.pin, name: me.host }));
    ws.onerror = () => {};
    ws.onclose = () => { clearTimeout(giveUp); if (this.alive && !this.failed) this.fail(this.connected ? 'The connection dropped.' : "Couldn't reach it. Is CouchDesk running there with sharing switched on?"); };
    ws.onmessage = async (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'denied') return this.fail(msg.reason === 'locked' ? 'Too many wrong PINs. Wait a minute and try again.' : 'That PIN was not accepted. Check it on the other PC.');
      if (msg.type === 'welcome') return this.startRtc();
      if (msg.type === 'answer') {
        await this.pc.setRemoteDescription(msg.sdp);
        for (const c of this.pending || []) { try { await this.pc.addIceCandidate(c); } catch (_) {} }
        this.pending = null;
      }
      if (msg.type === 'ice' && msg.c) {
        if (this.pc && this.pc.remoteDescription) { try { await this.pc.addIceCandidate(msg.c); } catch (_) {} }
        else (this.pending = this.pending || []).push(msg.c);
      }
    };
  }
  async startRtc() {
    this.say('Setting up the picture&hellip;');
    const pc = this.pc = new RTCPeerConnection({ iceServers: [] });
    pc.addTransceiver('video', { direction: 'recvonly' });
    this.dcKeys = pc.createDataChannel('keys', { ordered: true });
    this.dcMove = pc.createDataChannel('move', { ordered: false, maxRetransmits: 0 });
    pc.onicecandidate = (e) => e.candidate && this.ws.readyState === 1 && this.ws.send(JSON.stringify({ type: 'ice', c: e.candidate }));
    pc.ontrack = (e) => {
      try { e.receiver.jitterBufferTarget = 0; } catch (_) {}
      try { e.receiver.playoutDelayHint = 0; } catch (_) {}
      this.video.srcObject = e.streams[0] || new MediaStream([e.track]);
    };
    this.video.onplaying = () => { this.connected = true; clearTimeout(this.giveUp); this.say(''); this.statTimer = setInterval(() => this.stats(), 2000); };
    pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState) && this.alive) this.fail('Lost the connection.'); };
    const offer = await pc.createOffer();
    offer.sdp = boostBitrate(offer.sdp);
    await pc.setLocalDescription(offer);
    this.ws.send(JSON.stringify({ type: 'offer', sdp: pc.localDescription }));
  }
  async stats() {
    try {
      const r = await this.pc.getStats();
      r.forEach((s) => { if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated && s.currentRoundTripTime != null) this.ms.textContent = Math.round(s.currentRoundTripTime * 1000) + ' ms'; });
    } catch (_) {}
  }
  fail(text) {
    if (this.failed || !this.alive) return;
    this.failed = true; clearInterval(this.statTimer); clearTimeout(this.giveUp);
    try { this.ws.close(); } catch (_) {} try { this.pc?.close(); } catch (_) {}
    this.setControl(false);
    this.say(`${esc(text)}<br><button class="chip retry">Try again</button>`);
    this.status.querySelector('.retry').onclick = () => { this.failed = false; this.connected = false; this.open(); };
  }
  close() {
    this.alive = false; clearInterval(this.statTimer); clearTimeout(this.giveUp);
    try { this.ws.close(); } catch (_) {} try { this.pc?.close(); } catch (_) {}
    this.setControl(false);
    this.el.remove(); sessions.delete(this.m.id);
    if (focusId === this.m.id) focusId = null;
    updateStage(); renderMachines();
  }
  /* --- remote control --- */
  setControl(on) {
    if (on && controlId && controlId !== this.m.id) sessions.get(controlId)?.setControl(false);
    if (!on && this.down.size) { for (const c of this.down) this.sendKey('ku', c); this.down.clear(); }
    this.el.classList.toggle('control', on); this.badge.classList.toggle('hidden', !on);
    if (on) controlId = this.m.id; else if (controlId === this.m.id) controlId = null;
  }
  get controlling() { return controlId === this.m.id; }
  send(ch, o) { if (ch.readyState === 'open') ch.send(JSON.stringify(o)); }
  sendKey(t, code) { if (this.dcKeys) this.send(this.dcKeys, { t, code }); }
  pos(e) {
    const v = this.video, r = v.getBoundingClientRect();
    if (!v.videoWidth) return null;
    const s = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
    const w = v.videoWidth * s, h = v.videoHeight * s, ox = r.left + (r.width - w) / 2, oy = r.top + (r.height - h) / 2;
    return { x: Math.min(1, Math.max(0, (e.clientX - ox) / w)), y: Math.min(1, Math.max(0, (e.clientY - oy) / h)) };
  }
  wireInput() {
    const v = this.video;
    v.addEventListener('mousedown', (e) => {
      if (!this.connected) return;
      if (!this.controlling) { this.setControl(true); focusSession(this.m.id, true); return; }
      e.preventDefault(); const p = this.pos(e); if (p) this.send(this.dcKeys, { t: 'mm', ...p });
      this.send(this.dcKeys, { t: 'md', b: e.button });
    });
    window.addEventListener('mouseup', (e) => { if (this.controlling) this.send(this.dcKeys, { t: 'mu', b: e.button }); });
    v.addEventListener('mousemove', (e) => {
      if (!this.controlling) return;
      const now = performance.now(); if (now - this.lastMove < 8) return; this.lastMove = now;
      const p = this.pos(e); if (p) this.send(this.dcMove, { t: 'mm', ...p });
    });
    v.addEventListener('wheel', (e) => { if (this.controlling) { e.preventDefault(); this.send(this.dcKeys, { t: 'wh', dx: e.deltaX, dy: e.deltaY }); } }, { passive: false });
    v.addEventListener('contextmenu', (e) => e.preventDefault());
  }
}

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.altKey && e.code === 'KeyG') { sessions.get(controlId)?.setControl(false); e.preventDefault(); return; }
  const s = sessions.get(controlId); if (!s) return;
  e.preventDefault(); s.down.add(e.code); s.sendKey('kd', e.code);
}, true);
window.addEventListener('keyup', (e) => {
  const s = sessions.get(controlId); if (!s) return;
  e.preventDefault(); s.down.delete(e.code); s.sendKey('ku', e.code);
}, true);
window.addEventListener('blur', () => sessions.get(controlId)?.setControl(false));

function connect(m) {
  if (sessions.has(m.id)) return focusSession(m.id);
  sessions.set(m.id, new Session(m));
  updateStage(); renderMachines();
}
function focusSession(id, keepLayout) {
  focusId = id;
  if (!keepLayout && layout === 'grid' && sessions.size > 1) setLayout('focus');
  updateStage();
}
function setLayout(l) { layout = l; try { localStorage.setItem('layout', l); } catch (_) {} updateStage(); }
function updateStage() {
  const st = $('#stage'), n = sessions.size;
  if (!sessions.has(focusId)) focusId = [...sessions.keys()][0] || null;
  const focus = layout === 'focus' && n > 1;
  st.classList.toggle('focus', focus);
  st.style.setProperty('--n', Math.max(1, n - 1));
  for (const [id, s] of sessions) s.el.classList.toggle('is-focus', focus && id === focusId);
  $('#empty').classList.toggle('hidden', n > 0);
  $('#barTitle').textContent = n ? `${n} PC${n > 1 ? 's' : ''} open` : 'Sessions';
  $('#layoutBtn').textContent = focus ? 'Show all in a grid' : 'One big, rest small';
  $('#layoutBtn').disabled = n < 2;
  $('#endAll').classList.toggle('hidden', n === 0);
  // click on a small tile's header promotes it
  for (const [id, s] of sessions) s.el.onclick = focus && id !== focusId ? (e) => { if (!e.target.closest('button')) focusSession(id, true); } : null;
}
$('#layoutBtn').onclick = () => setLayout(layout === 'grid' ? 'focus' : 'grid');
$('#endAll').onclick = () => [...sessions.values()].forEach((s) => s.close());
$('#fsBtn').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
document.addEventListener('fullscreenchange', () => { $('#fsBtn').textContent = document.fullscreenElement ? 'Leave full screen' : 'Full screen'; });

/* ------------------------------------------------------------------ host (share this PC) */
const peers = new Map(); // sid -> {pc}
let screenStream = null;

async function getScreen() {
  if (screenStream && screenStream.getVideoTracks().some((t) => t.readyState === 'live')) return screenStream;
  screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 60, max: 60 }, cursor: 'never' }, audio: false });
  return screenStream;
}
// Encode at most ~1080p: a 3440x1440 frame takes far more bandwidth than a VPN link can carry without queueing.
function downscale(track) {
  const { width = 1920, height = 1080 } = track.getSettings();
  return Math.max(1, width / 1920, height / 1080);
}
function dropScreenIfIdle() {
  if (peers.size === 0 && screenStream) { screenStream.getTracks().forEach((t) => t.stop()); screenStream = null; }
}

desk.onSignal(async ({ sid, msg }) => {
  try {
    if (msg.type === 'offer') {
      const old = peers.get(sid); if (old) old.close();
      const pc = new RTCPeerConnection({ iceServers: [] });
      peers.set(sid, pc);
      pc.onicecandidate = (e) => e.candidate && desk.hostSend(sid, { type: 'ice', c: e.candidate.toJSON() });
      pc.ondatachannel = (e) => { e.channel.onmessage = (m) => { try { desk.sendInput(JSON.parse(m.data)); } catch (_) {} }; };
      await pc.setRemoteDescription(msg.sdp);
      for (const c of pc._pending || []) { try { await pc.addIceCandidate(c); } catch (_) {} }
      pc._pending = null;
      const stream = await getScreen();
      for (const t of stream.getVideoTracks()) {
        t.contentHint = 'motion';
        const sender = pc.addTrack(t, stream);
        try {
          const tr = pc.getTransceivers().find((x) => x.sender === sender);
          const caps = RTCRtpSender.getCapabilities('video').codecs;
          const h264 = caps.filter((c) => /h264/i.test(c.mimeType)), rest = caps.filter((c) => !/h264/i.test(c.mimeType));
          if (h264.length) tr.setCodecPreferences([...h264, ...rest]);
        } catch (_) {}
        try {
          const p = sender.getParameters();
          p.encodings = [{ ...(p.encodings?.[0] || {}), maxBitrate: 20_000_000, maxFramerate: 60, scaleResolutionDownBy: downscale(t), networkPriority: 'high' }];
          p.degradationPreference = 'maintain-framerate';
          await sender.setParameters(p);
        } catch (_) {}
      }
      await pc.setLocalDescription(await pc.createAnswer());
      desk.hostSend(sid, { type: 'answer', sdp: pc.localDescription.toJSON() });
    } else if (msg.type === 'ice' && msg.c) {
      const hp = peers.get(sid);
      if (hp && hp.remoteDescription) { try { await hp.addIceCandidate(msg.c); } catch (_) {} }
      else if (hp) (hp._pending = hp._pending || []).push(msg.c);
    }
  } catch (err) { console.error(err); showHostErr('Could not start screen sharing: ' + err.message); }
});

const viewerRows = new Map();
desk.onViewer(({ sid, joined, label, ip }) => {
  if (joined) {
    const row = document.createElement('div'); row.className = 'viewer';
    row.innerHTML = `<span><b>${esc(label)}</b> <span class="muted small">${esc(ip)}</span></span><button class="chip danger">Disconnect</button>`;
    row.querySelector('button').onclick = () => desk.hostKick(sid);
    viewerRows.set(sid, row); $('#viewers').appendChild(row);
  } else {
    viewerRows.get(sid)?.remove(); viewerRows.delete(sid);
    peers.get(sid)?.close(); peers.delete(sid); dropScreenIfIdle();
  }
});
function showHostErr(t) { const e = $('#hostErr'); e.textContent = t; e.classList.remove('hidden'); }
desk.onHostError(showHostErr);

$('#hostToggle').onchange = async (e) => {
  if (e.target.checked) {
    const r = await desk.hostStart();
    if (!r.ok) { e.target.checked = false; return alert('Could not start sharing: ' + r.error); }
    $('#hostBody').classList.remove('hidden'); $('#hostLabel').textContent = 'Sharing is on';
    $('#hostErr').classList.add('hidden');
  } else {
    await desk.hostStop(); peers.forEach((p) => p.close()); peers.clear(); dropScreenIfIdle();
    $('#viewers').innerHTML = ''; viewerRows.clear();
    $('#hostBody').classList.add('hidden'); $('#hostLabel').textContent = 'Let my other PCs connect';
  }
};
$('#copyPin').onclick = () => { desk.copy($('#pin').textContent); $('#copyPin').textContent = 'Copied'; setTimeout(() => ($('#copyPin').textContent = 'Copy'), 1200); };
$('#newPin').onclick = async () => { $('#pin').textContent = await desk.newPin(); };

(async () => {
  me = await desk.info();
  $('#pin').textContent = me.pin;
  $('#noInject').classList.toggle('hidden', me.canInject);
  const ul = $('#addrs');
  if (!me.addrs.length) ul.innerHTML = '<li><span class="muted">No network found</span></li>';
  for (const a of me.addrs) {
    const li = document.createElement('li');
    li.title = 'Click to copy';
    li.innerHTML = `<span>${esc(a.ip)}</span>${a.radmin ? '<span class="badge">Radmin VPN</span>' : ''}`;
    li.onclick = () => desk.copy(a.ip);
    ul.appendChild(li);
  }
  renderMachines(); updateStage();
})();

/* ------------------------------------------------------------------ updates */
(() => {
  const box = document.querySelector('.updater'), txt = $('#updText'), btn = $('#updBtn');
  let ready = false;
  desk.version().then((v) => { $('#ver').textContent = 'v' + v; });
  btn.onclick = () => { if (ready) return desk.installUpdate(); txt.textContent = 'Looking for updates…'; desk.checkUpdate(); };
  desk.onUpdate((u) => {
    box.classList.toggle('ready', u.state === 'ready'); ready = u.state === 'ready';
    btn.disabled = u.state === 'checking' || u.state === 'downloading';
    if (u.state === 'checking') txt.textContent = 'Looking for updates…';
    else if (u.state === 'current') { txt.textContent = "You're up to date."; btn.textContent = 'Check for updates'; }
    else if (u.state === 'downloading') txt.textContent = 'Downloading the new version' + (u.percent ? ' (' + u.percent + '%)' : '…');
    else if (u.state === 'ready') { txt.textContent = 'Version ' + u.version + ' is ready.'; btn.textContent = 'Restart to update'; }
    else if (u.state === 'dev') txt.textContent = 'Updates only work in the installed app.';
    else if (u.state === 'error') { txt.textContent = "Couldn't check for updates. Will try again later."; btn.textContent = 'Check for updates'; }
  });
})();
