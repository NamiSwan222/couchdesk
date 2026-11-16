'use strict';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PORT = 47800;
let me = { id: '', name: '' };

/* ------------------------------------------------------------------ little helpers */
const hue = (s) => { let h = 7; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; };
const initials = (n) => {
  const w = String(n).replace(/'s (pc|computer|laptop)$/i, '').trim().split(/\s+/).filter(Boolean);
  return ((w[0]?.[0] || '?') + (w[1]?.[0] || '')).toUpperCase();
};
const avHTML = (key, name, cls = '') => `<div class="av ${cls}" style="--h:${hue(key)}">${esc(initials(name))}</div>`;
const ICON = {
  focus: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="12" rx="2"/><path d="M3 20h4M10 20h4M17 20h4"/></svg>',
  fs: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};
function toast(html) {
  const t = document.createElement('div');
  t.className = 'toast'; t.innerHTML = html;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 4500);
}

/* ------------------------------------------------------------------ tabs */
function showPane(p) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.pane === p));
  $('#computers').classList.toggle('hidden', p !== 'computers');
  $('#sessions').classList.toggle('hidden', p !== 'sessions');
  $('#compTools').classList.toggle('hidden', p !== 'computers');
  $('#sessTools').classList.toggle('hidden', p !== 'sessions');
}
document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => showPane(t.dataset.pane)));

/* ------------------------------------------------------------------ computers: discovered friends + saved addresses */
let friends = [];
let saved = [];
try { saved = JSON.parse(localStorage.getItem('saved') || localStorage.getItem('machines') || '[]').map(({ id, name, host }) => ({ id, name, host })); } catch (_) {}
const saveSaved = () => { try { localStorage.setItem('saved', JSON.stringify(saved)); } catch (_) {} };
let editing = null;

function targets() {
  const out = [], ips = new Set();
  for (const f of friends) {
    out.push({ key: 'f:' + f.id, name: f.name, host: f.ip, port: f.port, kind: 'friend', sharing: f.sharing, radmin: f.radmin });
    ips.add(f.ip);
  }
  for (const m of saved) if (!ips.has(m.host)) out.push({ key: m.id, name: m.name, host: m.host, port: PORT, kind: 'saved', ref: m });
  return out;
}

function renderCards() {
  const list = targets(), box = $('#cards');
  $('#looking').classList.toggle('hidden', list.length > 0);
  box.innerHTML = '';
  for (const t of list) {
    const live = sessions.has(t.key);
    const [dot, status] = live ? ['busy', 'In session']
      : t.kind === 'saved' ? ['', 'Saved address']
      : t.sharing ? ['on', 'Ready to connect'] : ['', 'Not accepting connections'];
    const tag = t.kind === 'friend' ? `<span class="tag">${t.radmin ? 'RADMIN VPN' : 'LOCAL NETWORK'}</span>` : '<span class="tag">SAVED</span>';
    const tools = t.kind === 'saved' ? '<div class="tools"><button class="icon" data-a="edit" title="Edit">&#9998;</button><button class="icon" data-a="del" title="Remove">&#10005;</button></div>' : '';
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<div class="thumb" style="--h:${hue(t.key)}">${avHTML(t.key, t.name, 'lg')}${tag}${tools}</div>
      <div class="meta"><div class="info"><div class="nm">${esc(t.name)}</div><div class="st"><span class="dot ${dot}"></span>${status}</div></div>
      <button class="btn sm primary" data-a="go" ${!live && t.kind === 'friend' && !t.sharing ? 'disabled' : ''}>${live ? 'Open' : 'Connect'}</button></div>`;
    card.onclick = (e) => {
      const a = e.target.closest('button')?.dataset.a;
      if (a === 'go') { if (live) { showPane('sessions'); focusSession(t.key); } else connect(t); }
      else if (a === 'edit') openDialog(t.ref);
      else if (a === 'del' && confirm(`Remove "${t.name}"?`)) { saved = saved.filter((x) => x !== t.ref); saveSaved(); renderCards(); }
    };
    box.appendChild(card);
  }
}

function openDialog(m) {
  editing = m || null;
  $('#dlgTitle').textContent = m ? 'Edit saved PC' : 'Add by address';
  $('#fName').value = m?.name || ''; $('#fHost').value = m?.host || '';
  $('#dlg').showModal();
}
$('#addBtn').onclick = () => openDialog(null);
$('#dlgCancel').onclick = () => $('#dlg').close();
$('#addForm').addEventListener('submit', () => {
  const name = $('#fName').value.trim(), host = $('#fHost').value.trim();
  if (!name || !host) return;
  if (editing) Object.assign(editing, { name, host });
  else saved.push({ id: 'm' + Date.now(), name, host });
  saveSaved(); renderCards();
});

/* ------------------------------------------------------------------ viewer sessions */
// Bitrate hints for the sender's encoder (kbps): start moderate and let congestion control adapt.
function boostBitrate(sdp) {
  const hint = 'x-google-start-bitrate=6000;x-google-min-bitrate=500;x-google-max-bitrate=20000';
  const lines = sdp.split('\r\n');
  const mi = lines.findIndex((l) => l.startsWith('m=video'));
  if (mi < 0) return sdp;
  for (const pt of lines[mi].split(' ').slice(3)) {
    const ri = lines.findIndex((l) => l.startsWith('a=rtpmap:' + pt + ' '));
    if (ri < 0 || /^(rtx|red|ulpfec|flexfec-03)\//i.test(lines[ri].split(' ')[1])) continue;
    const fi = lines.findIndex((l) => l.startsWith('a=fmtp:' + pt + ' '));
    if (fi >= 0) lines[fi] += ';' + hint;
    else lines.splice(ri + 1, 0, 'a=fmtp:' + pt + ' ' + hint);
  }
  return lines.join('\r\n');
}

const sessions = new Map(); // key -> Session
let focusId = null, controlId = null, layout = localStorage.getItem('layout') || 'grid';

const FAIL = {
  declined: (n) => ['Request declined', `${n} said not right now.`],
  timeout: (n) => ['No answer', `${n} didn't respond in time.`],
  busy: (n) => ['Already asking', `There's already a request waiting on ${n}.`],
  off: (n) => [`${n} stopped sharing`, 'They switched off connections.'],
  unreachable: (n) => [`Couldn't reach ${n}`, 'Make sure CouchDesk is open there and Radmin VPN is connected.'],
  dropped: (n) => ['Connection lost', `The connection to ${n} dropped.`],
};

class Session {
  constructor(t) {
    this.t = t; this.key = t.key; this.alive = true; this.down = new Set(); this.lastMove = 0;
    const el = document.createElement('div');
    el.className = 'tile';
    el.style.setProperty('--h', hue(t.key));
    el.innerHTML = `<div class="screen"><video autoplay playsinline muted></video></div>
      <div class="ntag">${avHTML(t.key, t.name, 'sm')}<span>${esc(t.name)}</span></div>
      <div class="ovl"><div class="handle"></div><div class="pill">${avHTML(t.key, t.name, 'sm')}<span class="tn">${esc(t.name)}</span>
        <span class="ms"></span><span class="ctl hidden">CONTROLLING</span>
        <button data-a="focus" title="Make this one big">${ICON.focus}</button>
        <button data-a="fs" title="Full screen">${ICON.fs}</button>
        <button data-a="close" class="x" title="Disconnect">${ICON.close}</button></div></div>
      <div class="conn"></div>`;
    this.el = el; this.video = el.querySelector('video'); this.conn = el.querySelector('.conn');
    this.ms = el.querySelector('.ms'); this.ctl = el.querySelector('.ctl');
    el.querySelector('.pill').onclick = (e) => {
      const a = e.target.closest('button')?.dataset.a;
      if (a === 'close') this.close();
      else if (a === 'focus') focusSession(this.key);
      else if (a === 'fs') this.fullscreen();
    };
    this.wireInput();
    $('#stage').appendChild(el);
    this.open();
  }

  card(o) {
    if (!o) { this.conn.classList.add('hidden'); this.el.classList.add('is-live'); return; }
    this.el.classList.remove('is-live'); this.conn.classList.remove('hidden');
    this.conn.innerHTML = `<div class="conn-box">${avHTML(this.key, this.t.name, 'xl' + (o.pulse ? ' pulse' : ''))}
      <h3><span>${esc(o.title)}</span><span class="${o.dots ? 'dots' : ''}"></span></h3><p>${esc(o.text || '')}</p><div class="row"></div></div>`;
    const row = this.conn.querySelector('.row');
    for (const b of o.buttons || []) {
      const x = document.createElement('button');
      x.className = 'btn sm ' + (b.primary ? 'primary' : 'ghost');
      x.textContent = b.label;
      x.onclick = (e) => { e.stopPropagation(); b.fn(); };
      row.appendChild(x);
    }
  }
  timer(ms, fn) { clearTimeout(this.tmo); this.tmo = setTimeout(fn, ms); }

  open() {
    this.failed = false; this.connected = false; this.phase = 'reach'; this.pending = null;
    const n = this.t.name, cancel = { label: 'Cancel', fn: () => this.close() };
    this.card({ title: `Reaching ${n}`, text: 'Saying hello to their PC.', pulse: true, dots: true, buttons: [cancel] });
    let ws;
    try { ws = new WebSocket(`ws://${this.t.host}:${this.t.port || PORT}`); } catch (_) { return this.fail('unreachable'); }
    this.ws = ws;
    this.timer(10000, () => this.fail('unreachable'));
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', name: me.name, id: me.id }));
    ws.onerror = () => {};
    ws.onclose = () => { if (ws === this.ws && this.alive && !this.failed) this.fail(this.phase === 'reach' ? 'unreachable' : 'dropped'); };
    ws.onmessage = async (ev) => {
      if (ws !== this.ws) return;
      let msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.type === 'pending') {
        this.phase = 'wait';
        this.timer(40000, () => this.fail('timeout'));
        this.card({ title: `Waiting for ${n}`, text: 'They need to accept your request on their PC.', pulse: true, dots: true, buttons: [cancel] });
      } else if (msg.type === 'denied') {
        this.fail(msg.reason);
      } else if (msg.type === 'welcome') {
        this.phase = 'start';
        this.timer(15000, () => this.fail('dropped'));
        this.card({ title: 'Starting the stream', text: `${n} accepted.`, pulse: true, dots: true });
        this.startRtc().catch(() => this.fail('dropped'));
      } else if (msg.type === 'answer' && this.pc) {
        await this.pc.setRemoteDescription(msg.sdp);
        for (const c of this.pending || []) { try { await this.pc.addIceCandidate(c); } catch (_) {} }
        this.pending = null;
      } else if (msg.type === 'ice' && msg.c) {
        if (this.pc && this.pc.remoteDescription) { try { await this.pc.addIceCandidate(msg.c); } catch (_) {} }
        else (this.pending = this.pending || []).push(msg.c);
      }
    };
  }

  async startRtc() {
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
    this.video.onplaying = () => {
      if (this.connected) return;
      this.connected = true; clearTimeout(this.tmo); this.card(null);
      clearInterval(this.statTimer); this.statTimer = setInterval(() => this.stats(), 2000);
      toast(`${avHTML(this.key, this.t.name, 'sm')}<span>Connected to <b>${esc(this.t.name)}</b></span>`);
    };
    pc.onconnectionstatechange = () => { if (pc === this.pc && ['failed', 'closed'].includes(pc.connectionState) && this.alive) this.fail('dropped'); };
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

  teardown() {
    clearTimeout(this.tmo); clearInterval(this.statTimer);
    const ws = this.ws, pc = this.pc;
    this.ws = null; this.pc = null; this.dcKeys = null; this.dcMove = null;
    try { ws && ws.close(); } catch (_) {}
    try { pc && pc.close(); } catch (_) {}
    this.setControl(false);
    if (document.fullscreenElement === this.el) document.exitFullscreen().catch(() => {});
  }
  fail(reason) {
    if (this.failed || !this.alive) return;
    this.failed = true;
    this.teardown();
    const [title, text] = (FAIL[reason] || FAIL.dropped)(this.t.name);
    this.card({ title, text, buttons: [{ label: 'Close', fn: () => this.close() }, { label: 'Try again', primary: true, fn: () => this.open() }] });
  }
  close() {
    this.alive = false;
    this.teardown();
    this.el.remove(); sessions.delete(this.key);
    if (focusId === this.key) focusId = null;
    updateStage();
  }
  fullscreen() {
    if (document.fullscreenElement) return document.exitFullscreen().catch(() => {});
    this.el.requestFullscreen().then(() => {
      try { navigator.keyboard?.lock?.().catch(() => {}); } catch (_) {}
      if (this.connected) this.setControl(true);
    }).catch(() => {});
  }

  /* --- remote control --- */
  setControl(on) {
    if (on && controlId && controlId !== this.key) sessions.get(controlId)?.setControl(false);
    if (!on && this.down.size) { for (const c of this.down) this.sendKey('ku', c); this.down.clear(); }
    this.el.classList.toggle('control', on); this.ctl.classList.toggle('hidden', !on);
    if (on) controlId = this.key; else if (controlId === this.key) controlId = null;
  }
  get controlling() { return controlId === this.key; }
  send(ch, o) { if (ch && ch.readyState === 'open') ch.send(JSON.stringify(o)); }
  sendKey(t, code) { this.send(this.dcKeys, { t, code }); }
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
      if ($('#stage').classList.contains('focus') && focusId !== this.key) return;
      if (!this.controlling) { this.setControl(true); return; }
      e.preventDefault();
      const p = this.pos(e); if (p) this.send(this.dcKeys, { t: 'mm', ...p });
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
  const s = sessions.get(controlId); if (!s || reqCur) return;
  e.preventDefault(); s.down.add(e.code); s.sendKey('kd', e.code);
}, true);
window.addEventListener('keyup', (e) => {
  const s = sessions.get(controlId); if (!s) return;
  e.preventDefault(); s.down.delete(e.code); s.sendKey('ku', e.code);
}, true);
window.addEventListener('blur', () => sessions.get(controlId)?.setControl(false));
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) { try { navigator.keyboard?.unlock?.(); } catch (_) {} }
});

function connect(t) {
  showPane('sessions');
  if (sessions.has(t.key)) return focusSession(t.key);
  sessions.set(t.key, new Session(t));
  focusId = t.key;
  updateStage();
}
function focusSession(key, keepLayout) {
  focusId = key;
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
  for (const [key, s] of sessions) {
    s.el.classList.toggle('is-focus', focus && key === focusId);
    s.el.onclick = focus && key !== focusId ? (e) => { if (!e.target.closest('button')) focusSession(key, true); } : null;
  }
  $('#empty').classList.toggle('hidden', n > 0);
  $('#sessCount').textContent = n; $('#sessCount').classList.toggle('hidden', n === 0);
  $('#layoutBtn').textContent = focus ? 'Show all in a grid' : 'One big, rest small';
  $('#layoutBtn').disabled = n < 2;
  $('#endAll').disabled = n === 0;
  renderCards();
}
$('#layoutBtn').onclick = () => setLayout(layout === 'grid' ? 'focus' : 'grid');
$('#endAll').onclick = () => [...sessions.values()].forEach((s) => s.close());

/* ------------------------------------------------------------------ host: sharing this PC */
const peers = new Map(); // sid -> RTCPeerConnection
let screenStream = null;

async function getScreen() {
  if (screenStream && screenStream.getVideoTracks().some((t) => t.readyState === 'live')) return screenStream;
  screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 60, max: 60 }, cursor: 'never' }, audio: false });
  return screenStream;
}
// Encode at most ~1080p: a 3440x1440 frame needs far more bandwidth than a VPN link can carry without queueing.
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
    row.innerHTML = `${avHTML(ip + label, label, 'sm')}<span class="vn" title="${esc(ip)}">${esc(label)}</span><button class="chip danger">Disconnect</button>`;
    row.querySelector('button').onclick = () => desk.hostKick(sid);
    row.dataset.label = label;
    viewerRows.set(sid, row); $('#viewers').appendChild(row);
    toast(`${avHTML(ip + label, label, 'sm')}<span><b>${esc(label)}</b> is now connected to you</span>`);
  } else {
    const row = viewerRows.get(sid);
    if (row) { toast(`<span><b>${esc(row.dataset.label)}</b> disconnected</span>`); row.remove(); }
    viewerRows.delete(sid);
    peers.get(sid)?.close(); peers.delete(sid); dropScreenIfIdle();
  }
  $('#noViewers').classList.toggle('hidden', viewerRows.size > 0);
});

/* incoming requests: the person at this PC must accept */
const reqQ = [];
let reqCur = null;
desk.onRequest((r) => { reqQ.push(r); nextReq(); });
desk.onRequestGone(({ rid }) => {
  const i = reqQ.findIndex((r) => r.rid === rid);
  if (i >= 0) reqQ.splice(i, 1);
  if (reqCur && reqCur.rid === rid) { reqCur = null; $('#reqLayer').classList.add('hidden'); nextReq(); }
  else updMore();
});
function updMore() { $('#reqMore').textContent = reqQ.length ? `${reqQ.length} more waiting` : ''; }
function nextReq() {
  if (reqCur || !reqQ.length) return updMore();
  reqCur = reqQ.shift();
  sessions.get(controlId)?.setControl(false);
  const av = $('#reqAv');
  av.style.setProperty('--h', hue(reqCur.ip + reqCur.name)); av.textContent = initials(reqCur.name);
  $('#reqTitle').textContent = `${reqCur.name} wants to connect`;
  $('#reqSub').textContent = `From ${reqCur.ip}. If you accept, they'll see your screen and can use your mouse and keyboard.`;
  const bar = $('#reqBar'), left = Math.max(0, reqCur.expires - Date.now());
  bar.style.transition = 'none'; bar.style.width = Math.min(100, (left / 30000) * 100) + '%';
  void bar.offsetWidth;
  bar.style.transition = `width ${left}ms linear`; bar.style.width = '0%';
  $('#reqLayer').classList.remove('hidden');
  $('#reqYes').focus();
  updMore();
}
function answerReq(ok) {
  if (!reqCur) return;
  desk.decide(reqCur.rid, ok);
  if (!ok) toast(`<span>You declined <b>${esc(reqCur.name)}</b></span>`);
  reqCur = null; $('#reqLayer').classList.add('hidden');
  nextReq();
}
$('#reqYes').onclick = () => answerReq(true);
$('#reqNo').onclick = () => answerReq(false);

/* this PC: name + sharing switch */
function showHostErr(t) { const e = $('#hostErr'); e.textContent = t; e.classList.toggle('hidden', !t); }
function renderMe() {
  const av = $('#meAv');
  av.style.setProperty('--h', hue('f:' + me.id)); av.textContent = initials(me.name);
  if (document.activeElement !== $('#meName')) $('#meName').value = me.name;
  const on = $('#hostToggle').checked;
  $('#meDot').className = 'dot' + (on ? ' on' : '');
  $('#meStatus').textContent = on ? 'Friends can find you and ask to connect' : 'Hidden, nobody can connect';
}
desk.onHostError((t) => { $('#hostToggle').checked = false; showHostErr(t); renderMe(); });
$('#hostToggle').onchange = async (e) => {
  showHostErr('');
  if (e.target.checked) {
    const r = await desk.hostStart();
    if (!r.ok) { e.target.checked = false; showHostErr('Could not turn on sharing: ' + r.error); }
  } else {
    await desk.hostStop(); peers.forEach((p) => p.close()); peers.clear(); dropScreenIfIdle();
    $('#viewers').innerHTML = ''; viewerRows.clear(); $('#noViewers').classList.remove('hidden');
  }
  renderMe();
};
$('#meName').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { e.target.value = me.name; e.target.blur(); } });
$('#meName').addEventListener('change', async (e) => {
  const v = e.target.value.trim();
  if (!v) { e.target.value = me.name; return; }
  me.name = await desk.setName(v); renderMe();
});

desk.onFriends((list) => { friends = list; renderCards(); });

(async () => {
  me = await desk.info();
  $('#hostToggle').checked = me.sharing;
  $('#noInject').classList.toggle('hidden', me.canInject);
  renderMe();
  friends = await desk.friends();
  updateStage();
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
