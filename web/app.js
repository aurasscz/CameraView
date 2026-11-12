import { StreamPlayer, lnaOptions } from './player.js';

// ---------- Storage ----------
const STORE_KEY = 'cameraview.v1';
const DEFAULT_GATEWAY = 'http://localhost:1984';
const STREAM_PREFIX = 'cameraview_';

const PRESETS = [
  { id: 'generic', label: 'Generic RTSP', port: 554, path: '' },
  { id: 'hikvision', label: 'Hikvision (main stream)', port: 554, path: '/Streaming/Channels/101' },
  { id: 'hikvision-sub', label: 'Hikvision (sub stream)', port: 554, path: '/Streaming/Channels/102' },
  { id: 'dahua', label: 'Dahua / Amcrest / Lorex (main)', port: 554, path: '/cam/realmonitor?channel=1&subtype=0' },
  { id: 'dahua-sub', label: 'Dahua / Amcrest / Lorex (sub)', port: 554, path: '/cam/realmonitor?channel=1&subtype=1' },
  { id: 'reolink', label: 'Reolink (main)', port: 554, path: '/h264Preview_01_main' },
  { id: 'reolink-sub', label: 'Reolink (sub)', port: 554, path: '/h264Preview_01_sub' },
  { id: 'tapo', label: 'TP-Link Tapo / VIGI (HD)', port: 554, path: '/stream1' },
  { id: 'tapo-sub', label: 'TP-Link Tapo / VIGI (SD)', port: 554, path: '/stream2' },
  { id: 'axis', label: 'Axis', port: 554, path: '/axis-media/media.amp' },
  { id: 'uniview', label: 'Uniview', port: 554, path: '/media/video1' },
  { id: 'foscam', label: 'Foscam', port: 88, path: '/videoMain' },
  { id: 'wyze', label: 'Wyze (RTSP firmware)', port: 554, path: '/live' },
];

function loadState() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {};
  } catch { /* ignore */ }
  return {
    gateway: saved.gateway || '',
    mode: saved.mode || 'auto',
    layout: saved.layout || 'auto',
    pauseHidden: saved.pauseHidden ?? true,
    cameras: Array.isArray(saved.cameras) ? saved.cameras : [],
  };
}

const state = loadState();

function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch { /* ignore */ }
}

// ---------- Helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function gw() {
  return (state.gateway || DEFAULT_GATEWAY).replace(/\/+$/, '');
}

function streamName(cam) {
  return STREAM_PREFIX + cam.id;
}

function isLoopback(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
}

function maskUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '•••';
    return u.toString().replace('%E2%80%A2%E2%80%A2%E2%80%A2', '•••');
  } catch {
    return url;
  }
}

async function api(path, { method = 'GET', body, timeout = 8000 } = {}) {
  const url = gw() + path;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { method, body, signal: ctrl.signal, cache: 'no-store', ...lnaOptions(url) });
    const text = await res.text();
    if (!res.ok) throw new Error(text.trim() || `${res.status} ${res.statusText}`);
    try { return JSON.parse(text); } catch { return text; }
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Gateway did not respond in time');
    if (err instanceof TypeError) throw new Error('Cannot reach the gateway');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

let toastTimer = 0;
function toast(msg, ms = 3500) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function playerModes() {
  if (state.mode === 'webrtc') return ['webrtc'];
  if (state.mode === 'mse') return ['mse'];
  return ['webrtc', 'mse'];
}

// ---------- Gateway status ----------
const gateway = { online: null, info: null, streams: {} };

async function checkGateway() {
  const pill = $('#gatewayPill');
  const text = $('#gatewayText');
  try {
    const info = await api('/api', { timeout: 4000 });
    const wasOnline = gateway.online;
    gateway.online = true;
    gateway.info = info;
    pill.className = 'pill ok';
    text.textContent = `Gateway connected${info && info.version ? ` · go2rtc ${info.version}` : ''}`;
    pill.title = `Gateway: ${gw()}`;
    if (wasOnline !== true) {
      await syncStreams();
      startAll(true);
    }
  } catch (err) {
    const wasOnline = gateway.online;
    gateway.online = false;
    pill.className = 'pill bad';
    text.textContent = 'Gateway offline';
    pill.title = `${gw()} — ${err.message}`;
    if (wasOnline !== false) stopAll('Gateway offline');
  }
  updateBanner();
}

function updateBanner() {
  const banner = $('#banner');
  let html = '';
  let gwUrl = null;
  try { gwUrl = new URL(gw()); } catch { /* ignore */ }

  if (!gwUrl) {
    html = 'The gateway URL in Settings is not valid.';
  } else if (location.protocol === 'https:' && gwUrl.protocol === 'http:' && !isLoopback(gwUrl.hostname)) {
    html = `This page is served over HTTPS, so your browser may block the plain-HTTP gateway at <code>${gwUrl.host}</code>.
      Open CameraView directly from the gateway instead: <a href="${gwUrl.origin}/">${gwUrl.origin}/</a>`;
    if (gateway.online) html = '';
  } else if (gateway.online === false) {
    html = `Can't reach the gateway at <code>${gwUrl.origin}</code>. Make sure it is running
      (<code>./gateway/start.sh</code>) — see <a href="https://github.com/aurasscz/CameraView#quick-start" target="_blank" rel="noopener">setup instructions</a>.`;
    if (/Chrome/.test(navigator.userAgent) && location.protocol === 'https:') {
      html += ' If Chrome asks for permission to access devices on your local network, choose <em>Allow</em>.';
    }
  }
  banner.innerHTML = html;
  banner.hidden = !html;
}

async function syncStreams() {
  try {
    gateway.streams = (await api('/api/streams')) || {};
  } catch {
    gateway.streams = {};
  }
  for (const cam of state.cameras) {
    await ensureStream(cam).catch((err) => console.warn('register', cam.name, err));
  }
}

async function ensureStream(cam, force = false) {
  const name = streamName(cam);
  const existing = gateway.streams && gateway.streams[name];
  if (!force && existing && Array.isArray(existing.producers) &&
      existing.producers.some((p) => p.url === cam.url)) {
    return;
  }
  await api(`/api/streams?name=${encodeURIComponent(name)}&src=${encodeURIComponent(cam.url)}`, { method: 'PUT' });
  gateway.streams[name] = { producers: [{ url: cam.url }] };
}

async function removeStream(name) {
  try {
    await api(`/api/streams?src=${encodeURIComponent(name)}`, { method: 'DELETE' });
  } catch { /* ignore */ }
  if (gateway.streams) delete gateway.streams[name];
}

// ---------- Tiles ----------
const tiles = new Map(); // id -> {el, player}

function render() {
  const grid = $('#grid');
  grid.dataset.cols = state.layout === 'auto' ? '' : state.layout;
  if (state.layout === 'auto') delete grid.dataset.cols;

  // Remove tiles for deleted cameras
  for (const [id, t] of tiles) {
    if (!state.cameras.find((c) => c.id === id)) {
      t.player.stop();
      t.el.remove();
      tiles.delete(id);
    }
  }
  // Add / reorder
  for (const cam of state.cameras) {
    let t = tiles.get(cam.id);
    if (!t) {
      t = createTile(cam);
      tiles.set(cam.id, t);
    }
    $('.name', t.el).textContent = cam.name;
    t.el.title = maskUrl(cam.url);
    grid.appendChild(t.el);
  }

  $('#empty').hidden = state.cameras.length > 0;
  if (!state.cameras.length) document.body.classList.remove('focus-mode');
}

function createTile(cam) {
  const el = $('#tileTemplate').content.firstElementChild.cloneNode(true);
  el.dataset.id = cam.id;
  const video = $('video', el);
  const badge = $('.badge', el);
  const msg = $('.status-msg', el);

  const player = new StreamPlayer(video, {
    gateway: gw(),
    stream: streamName(cam),
    modes: playerModes(),
    audio: !!cam.audio,
    onStatus: ({ state: s, mode, detail }) => {
      el.classList.toggle('playing', s === 'playing');
      badge.className = `badge ${s}`;
      badge.textContent = s === 'playing' ? (mode === 'webrtc' ? 'WebRTC' : 'MSE') : s;
      msg.textContent = s === 'error' ? `${detail || 'Error'} — retrying…`
        : s === 'connecting' ? 'Connecting…'
          : s === 'stopped' ? (detail || 'Paused') : '';
    },
  });

  el.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    ev.stopPropagation();
    const c = state.cameras.find((x) => x.id === cam.id);
    if (!c) return;
    switch (btn.dataset.act) {
      case 'mute':
        video.muted = !video.muted;
        btn.textContent = video.muted ? '🔇' : '🔊';
        if (!video.muted && !c.audio) toast('Audio is off for this camera — enable it in Edit.');
        break;
      case 'snapshot': snapshot(c, video); break;
      case 'reload': player.restart(); break;
      case 'focus': toggleFocus(el); break;
      case 'edit': openCameraDialog(c); break;
      case 'delete': deleteCamera(c); break;
      default: break;
    }
  });
  el.addEventListener('dblclick', () => toggleFullscreen(el));
  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') toggleFocus(el);
    if (ev.key === 'f') toggleFullscreen(el);
  });
  el.addEventListener('touchstart', () => {
    el.classList.add('touch');
    clearTimeout(el._touchTimer);
    el._touchTimer = setTimeout(() => el.classList.remove('touch'), 4000);
  }, { passive: true });

  const t = { el, player };
  if (gateway.online && !(state.pauseHidden && document.hidden)) {
    ensureStream(cam).then(() => player.start()).catch((err) => player.onStatus({ state: 'error', detail: err.message }));
  } else {
    player.onStatus({ state: 'stopped', detail: gateway.online === false ? 'Gateway offline' : 'Waiting for gateway…' });
  }
  return t;
}

function startAll(rebuild = false) {
  if (state.pauseHidden && document.hidden) return;
  for (const cam of state.cameras) {
    const t = tiles.get(cam.id);
    if (!t) continue;
    if (rebuild) {
      t.player.stop();
      t.player.gateway = gw();
      t.player.modes = playerModes();
    }
    if (t.player.stopped) t.player.start();
  }
}

function stopAll(reason) {
  for (const t of tiles.values()) {
    t.player.stop();
    t.player.onStatus({ state: 'stopped', detail: reason });
  }
}

function toggleFocus(el) {
  const focused = el.classList.contains('focused');
  document.querySelectorAll('.tile.focused').forEach((x) => x.classList.remove('focused'));
  if (focused) {
    document.body.classList.remove('focus-mode');
  } else {
    el.classList.add('focused');
    document.body.classList.add('focus-mode');
    el.scrollIntoView({ block: 'start' });
  }
}

function toggleFullscreen(el) {
  if (document.fullscreenElement) document.exitFullscreen();
  else if (el.requestFullscreen) el.requestFullscreen().catch(() => toggleFocus(el));
  else toggleFocus(el);
}

function snapshot(cam, video) {
  if (!video.videoWidth) {
    toast('No video frame yet.');
    return;
  }
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  canvas.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = URL.createObjectURL(blob);
    a.download = `${cam.name.replace(/[^\w-]+/g, '_')}_${ts}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }, 'image/png');
}

async function deleteCamera(cam) {
  if (!confirm(`Remove camera “${cam.name}”?`)) return;
  state.cameras = state.cameras.filter((c) => c.id !== cam.id);
  saveState();
  render();
  if (gateway.online) await removeStream(streamName(cam));
}

// ---------- Camera dialog ----------
const camDialog = $('#cameraDialog');
const camForm = $('#cameraForm');
let editingId = null;
let testPlayer = null;

function presetById(id) {
  return PRESETS.find((p) => p.id === id) || PRESETS[0];
}

function buildUrl() {
  const f = camForm.elements;
  const host = f.host.value.trim();
  if (!host) return '';
  const user = f.user.value;
  const pass = f.pass.value;
  const auth = user ? `${encodeURIComponent(user)}${pass ? `:${encodeURIComponent(pass)}` : ''}@` : '';
  const port = f.port.value && f.port.value !== '554' ? `:${f.port.value}` : '';
  let path = f.path.value.trim();
  if (path && !path.startsWith('/')) path = `/${path}`;
  return `rtsp://${auth}${host}${port}${path}`;
}

function currentMode() {
  return camForm.elements.inputMode.value;
}

function setMode(mode) {
  camForm.elements.inputMode.value = mode;
  camForm.querySelectorAll('[data-mode]').forEach((el) => { el.hidden = el.dataset.mode !== mode; });
  if (mode === 'url') {
    const built = buildUrl();
    if (built && !camForm.elements.url.value) camForm.elements.url.value = built;
  } else {
    // Try to parse the URL into the builder fields.
    const raw = camForm.elements.url.value.trim();
    if (raw) {
      try {
        const u = new URL(raw);
        if (u.protocol === 'rtsp:') {
          camForm.elements.host.value = u.hostname;
          camForm.elements.port.value = u.port || '554';
          camForm.elements.user.value = decodeURIComponent(u.username);
          camForm.elements.pass.value = decodeURIComponent(u.password);
          camForm.elements.path.value = u.pathname + u.search;
        }
      } catch { /* ignore */ }
    }
    updateBuilt();
  }
}

function updateBuilt() {
  const url = buildUrl();
  $('#builtUrl').textContent = url ? maskUrl(url) : '—';
}

function formUrl() {
  return currentMode() === 'builder' ? buildUrl() : camForm.elements.url.value.trim();
}

function validateUrl(url) {
  if (!url) return 'Enter the camera stream URL.';
  let u;
  try { u = new URL(url); } catch { return 'That does not look like a valid URL.'; }
  if (!['rtsp:', 'rtsps:', 'rtspx:', 'onvif:'].includes(u.protocol)) {
    return 'The URL should start with rtsp://, rtsps:// or onvif://';
  }
  if (!u.hostname) return 'The URL is missing the camera address.';
  return '';
}

function showCamError(msg) {
  const el = $('#cameraError');
  el.textContent = msg || '';
  el.hidden = !msg;
}

function openCameraDialog(cam = null, prefill = null) {
  editingId = cam ? cam.id : null;
  camForm.reset();
  showCamError('');
  stopTest();
  $('#cameraDialogTitle').textContent = cam ? 'Edit camera' : 'Add camera';
  const src = cam || prefill || {};
  camForm.elements.name.value = src.name || '';
  camForm.elements.url.value = src.url || '';
  camForm.elements.audio.checked = !!src.audio;
  camForm.elements.preset.value = 'generic';
  setMode('url');
  camDialog.showModal();
  (src.name ? camForm.elements.url : camForm.elements.name).focus();
}

function stopTest() {
  if (testPlayer) {
    testPlayer.stop();
    testPlayer = null;
    if (gateway.online) removeStream(`${STREAM_PREFIX}test`);
  }
  $('#testPreview').hidden = true;
}

async function runTest() {
  const url = formUrl();
  const err = validateUrl(url);
  showCamError(err);
  if (err) return;
  if (!gateway.online) {
    showCamError('The gateway is offline — start it first, then try again.');
    return;
  }
  stopTest();
  const preview = $('#testPreview');
  const status = $('.test-status', preview);
  preview.hidden = false;
  status.textContent = 'Registering stream…';
  const name = `${STREAM_PREFIX}test`;
  try {
    await api(`/api/streams?name=${name}&src=${encodeURIComponent(url)}`, { method: 'PUT' });
  } catch (e) {
    status.textContent = `Gateway rejected the URL: ${e.message}`;
    return;
  }
  testPlayer = new StreamPlayer($('video', preview), {
    gateway: gw(),
    stream: name,
    modes: playerModes(),
    audio: camForm.elements.audio.checked,
    onStatus: ({ state: s, mode, detail }) => {
      status.textContent = s === 'playing' ? `✓ Working (${mode === 'webrtc' ? 'WebRTC' : 'MSE'})`
        : s === 'error' ? `✗ ${detail}` : s === 'connecting' ? 'Connecting…' : s;
    },
  });
  testPlayer.start();
}

for (const p of PRESETS) camForm.elements.preset.add(new Option(p.label, p.id));

camForm.addEventListener('input', (ev) => {
  if (['host', 'port', 'user', 'pass', 'path'].includes(ev.target.name)) updateBuilt();
});
camForm.addEventListener('change', (ev) => {
  if (ev.target.name === 'inputMode') setMode(ev.target.value);
  if (ev.target.name === 'preset') {
    const p = presetById(ev.target.value);
    camForm.elements.port.value = p.port;
    camForm.elements.path.value = p.path;
    updateBuilt();
  }
});
$('#testBtn').addEventListener('click', runTest);
camDialog.addEventListener('close', stopTest);

camForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const name = camForm.elements.name.value.trim();
  const url = formUrl();
  const err = !name ? 'Give the camera a name.' : validateUrl(url);
  showCamError(err);
  if (err) return;

  const audio = camForm.elements.audio.checked;
  let cam;
  if (editingId) {
    cam = state.cameras.find((c) => c.id === editingId);
    const changed = cam.url !== url || cam.audio !== audio;
    Object.assign(cam, { name, url, audio });
    if (changed) {
      const t = tiles.get(cam.id);
      if (t) {
        t.player.stop();
        t.el.remove();
        tiles.delete(cam.id);
      }
    }
  } else {
    cam = { id: uid(), name, url, audio };
    state.cameras.push(cam);
  }
  saveState();
  camDialog.close();
  if (gateway.online) {
    try {
      await ensureStream(cam, true);
    } catch (e) {
      toast(`Gateway: ${e.message}`);
    }
  }
  render();
});

// ---------- Settings dialog ----------
const setDialog = $('#settingsDialog');
const setForm = $('#settingsForm');

function openSettings() {
  setForm.elements.gateway.value = state.gateway || DEFAULT_GATEWAY;
  setForm.elements.mode.value = state.mode;
  setForm.elements.pauseHidden.checked = state.pauseHidden;
  $('#gatewayHint').textContent = location.protocol === 'https:'
    ? 'On this HTTPS page, use http://localhost:1984 (gateway on this computer). For a gateway on another machine, open http://<that-ip>:1984/ instead.'
    : 'Usually http://<gateway-ip>:1984';
  setDialog.showModal();
}

setForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  let g = setForm.elements.gateway.value.trim() || DEFAULT_GATEWAY;
  if (!/^https?:\/\//i.test(g)) g = `http://${g}`;
  const changed = g !== gw() || setForm.elements.mode.value !== state.mode;
  state.gateway = g.replace(/\/+$/, '');
  state.mode = setForm.elements.mode.value;
  state.pauseHidden = setForm.elements.pauseHidden.checked;
  saveState();
  setDialog.close();
  if (changed) {
    gateway.online = null;
    stopAll('Reconnecting…');
    checkGateway();
  }
});

$('#exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ cameras: state.cameras }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'cameraview-cameras.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});

$('#importInput').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const list = Array.isArray(data) ? data : data.cameras;
    if (!Array.isArray(list)) throw new Error('No cameras found in file');
    let added = 0;
    for (const c of list) {
      if (!c || typeof c.url !== 'string' || validateUrl(c.url)) continue;
      if (state.cameras.some((x) => x.url === c.url)) continue;
      state.cameras.push({ id: uid(), name: String(c.name || 'Camera').slice(0, 60), url: c.url, audio: !!c.audio });
      added += 1;
    }
    saveState();
    if (gateway.online) await syncStreams();
    render();
    toast(`Imported ${added} camera${added === 1 ? '' : 's'}.`);
  } catch (e) {
    toast(`Import failed: ${e.message}`);
  }
});

// ---------- Scan dialog (ONVIF discovery via go2rtc) ----------
const scanDialog = $('#scanDialog');

async function runScan() {
  const box = $('#scanResults');
  if (!gateway.online) {
    box.innerHTML = '<p class="error">The gateway is offline — start it first.</p>';
    return;
  }
  box.innerHTML = '<p class="hint">Scanning… (this takes a few seconds)</p>';
  let sources = [];
  try {
    const res = await api('/api/onvif', { timeout: 20000 });
    sources = (res && res.sources) || [];
  } catch (e) {
    box.innerHTML = /no sources/i.test(e.message)
      ? '<p class="hint">No ONVIF cameras found. Add your camera manually with its RTSP URL.</p>'
      : `<p class="error">Scan failed: ${escapeHtml(e.message)}</p>`;
    return;
  }
  box.innerHTML = '';
  for (const s of sources) box.appendChild(scanItem(s));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function scanItem(source) {
  const item = document.createElement('div');
  item.className = 'scan-item';
  let host = source.name;
  try { host = new URL(source.url).host; } catch { /* ignore */ }
  item.innerHTML = `<div class="meta"><div>${escapeHtml(source.info || 'ONVIF camera')}</div><div>${escapeHtml(host)}</div></div>
    <button type="button" class="btn">Add…</button>`;
  $('button', item).addEventListener('click', () => {
    item.innerHTML = `<div class="meta" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <strong>${escapeHtml(host)}</strong>
        <input placeholder="Username" class="u" style="width:130px" autocomplete="off">
        <input placeholder="Password" type="password" class="p" style="width:130px" autocomplete="new-password">
      </div>
      <button type="button" class="btn primary">Get streams</button>`;
    $('.u', item).focus();
    $('button', item).addEventListener('click', async () => {
      const u = $('.u', item).value;
      const p = $('.p', item).value;
      const onvifUrl = `onvif://${encodeURIComponent(u)}:${encodeURIComponent(p)}@${host}`;
      const btn = $('button', item);
      btn.disabled = true;
      btn.textContent = 'Loading…';
      try {
        const res = await api(`/api/onvif?src=${encodeURIComponent(onvifUrl)}`, { timeout: 15000 });
        const profiles = ((res && res.sources) || []).filter((x) => !/snapshot/.test(x.url));
        item.replaceWith(...profiles.map((pr, i) => {
          const row = document.createElement('div');
          row.className = 'scan-item';
          row.innerHTML = `<div class="meta"><div>${escapeHtml(pr.name)}</div><div>${escapeHtml(host)} · ${i === 0 ? 'main stream' : 'sub stream'}</div></div>
            <button type="button" class="btn primary">Add</button>`;
          $('button', row).addEventListener('click', () => {
            scanDialog.close();
            openCameraDialog(null, { name: pr.name.replace(/ stream0$/, '').replace(/ stream(\d+)$/, ' ($1)'), url: pr.url });
          });
          return row;
        }));
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Get streams';
        toast(`Could not read camera: ${e.message}`);
      }
    });
  });
  return item;
}

// ---------- Wiring ----------
function bindDialogClose(dlg) {
  dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dlg.close()));
  dlg.addEventListener('click', (ev) => { if (ev.target === dlg) dlg.close(); });
}
[camDialog, setDialog, scanDialog].forEach(bindDialogClose);

$('#addBtn').addEventListener('click', () => openCameraDialog());
$('#emptyAddBtn').addEventListener('click', () => openCameraDialog());
$('#settingsBtn').addEventListener('click', openSettings);
$('#gatewayPill').addEventListener('click', openSettings);
$('#scanBtn').addEventListener('click', () => { scanDialog.showModal(); runScan(); });
$('#rescanBtn').addEventListener('click', runScan);

const layoutSelect = $('#layoutSelect');
layoutSelect.value = state.layout;
layoutSelect.addEventListener('change', () => {
  state.layout = layoutSelect.value;
  saveState();
  render();
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && document.body.classList.contains('focus-mode') && !document.querySelector('dialog[open]')) {
    const el = document.querySelector('.tile.focused');
    if (el) toggleFocus(el);
  }
});

document.addEventListener('visibilitychange', () => {
  if (!state.pauseHidden || !gateway.online) return;
  if (document.hidden) stopAll('Paused (tab hidden)');
  else startAll();
});

// Pick a sensible default gateway: if this page is served by go2rtc itself, use same origin.
async function detectGateway() {
  if (state.gateway) return;
  if (location.protocol.startsWith('http') && !location.hostname.endsWith('github.io')) {
    try {
      const res = await fetch(`${location.origin}/api`, { cache: 'no-store' });
      const info = await res.json();
      if (info && (info.version || info.host)) {
        state.gateway = location.origin;
        saveState();
      }
    } catch { /* not served by the gateway */ }
  }
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

(async () => {
  await detectGateway();
  render();
  await checkGateway();
  setInterval(checkGateway, 10000);
})();
