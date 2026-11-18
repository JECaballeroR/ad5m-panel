// Adventurer 5M Pro panel — talks to the printer's local HTTP API (port 8898).

const $ = (id) => document.getElementById(id);

// Same page serves the full tab and the side panel (?view=side).
const IS_SIDE = new URLSearchParams(location.search).get('view') === 'side';
document.documentElement.classList.toggle('side', IS_SIDE);

// Camera elements are cached because they move into the floating window,
// where document.getElementById no longer finds them.
const CAM = {
  box: $('camera'),
  img: $('camImg'),
  canvas: $('camCanvas'),
  msg: $('camMsg'),
  toggle: $('camToggle'),
  float: $('camFloat'),
  hud: $('camHud'),
  hudPct: $('hudPct'),
  hudTemps: $('hudTemps'),
};
let pipWin = null;
const inBackground = () => document.hidden && !pipWin;

const STORAGE_KEY = 'printer';
const API_PORT = 8898;

const STATUS = {
  ready: ['Ready', 'good'],
  busy: ['Busy', 'work'],
  calibrate_doing: ['Calibrating', 'work'],
  error: ['Error', 'bad'],
  heating: ['Heating', 'heat'],
  printing: ['Printing', 'work'],
  working: ['Printing', 'work'],
  pausing: ['Pausing', 'warn'],
  paused: ['Paused', 'warn'],
  canceling: ['Canceling', 'warn'],
  cancel: ['Canceled', 'bad'],
  completed: ['Finished', 'good'],
};
const RUNNING = ['printing', 'working', 'heating'];
const ACTIVE = [...RUNNING, 'pausing', 'paused', 'busy', 'calibrate_doing', 'canceling'];

const API_ERRORS = {
  1: 'The printer returned an error.',
  2: 'The printer rejected the parameters.',
  3: 'Wrong serial number or check code.',
  4: 'The printer couldn’t find that file.',
  5: 'The printer is busy. Try again in a few seconds.',
};

let cfg = null;
let detail = null;
let product = null;
let pollTimer = null;
let failures = 0;
const holdUntil = {}; // keeps polling from overwriting a control the user just touched

// ---------- API ----------

async function api(path, extra = {}, c = cfg, timeout = 6000) {
  let res;
  try {
    res = await fetch(`http://${c.ip}:${API_PORT}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serialNumber: c.serial, checkCode: c.checkCode, ...extra }),
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw new Error(`No response from ${c.ip}:${API_PORT}. Make sure the printer is on, on your network, and in LAN only mode.`);
  }
  if (!res.ok) throw new Error(`The printer answered HTTP ${res.status}.`);
  let data;
  try { data = await res.json(); } catch { throw new Error('The printer sent a response that couldn’t be read.'); }
  if (data.code !== 0) throw new Error(API_ERRORS[data.code] || data.message || `Error ${data.code}.`);
  return data;
}

const control = (cmd, args) => api('/control', { payload: { cmd, args } });

// ---------- UI helpers ----------

let toastTimer;
function toast(msg, tone = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast show ${tone}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 3800);
}

function setBanner(msg) {
  const b = $('banner');
  b.hidden = !msg;
  b.textContent = msg || '';
}

function setChip(text, tone) {
  const chip = $('statusChip');
  chip.textContent = text;
  chip.dataset.tone = tone;
}

function fmtTime(sec) {
  if (sec == null || !isFinite(sec) || sec <= 0) return '—';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m) return `${m} min`;
  return `${sec} s`;
}

const fmtTemp = (v) => (typeof v === 'number' ? `${Math.round(v)} °C` : '—');
const held = (key) => (holdUntil[key] || 0) > Date.now();
const hold = (key, ms = 4000) => { holdUntil[key] = Date.now() + ms; };
const isOn = (id) => $(id).getAttribute('aria-checked') === 'true';

function sameHost(url) {
  // The printer sometimes reports URLs with a different IP; force the configured one.
  try { const u = new URL(url); u.hostname = cfg.ip; return u.toString(); } catch { return null; }
}

async function runAction(btn, fn, okMsg) {
  if (btn) btn.disabled = true;
  try {
    await fn();
    if (okMsg) toast(okMsg);
  } catch (e) {
    toast(e.message, 'bad');
  } finally {
    if (btn) btn.disabled = false;
    setTimeout(poll, 600);
  }
}

// ---------- Render ----------

function setTemp(key, cur, target, max) {
  $(`t${key}`).textContent = fmtTemp(cur);
  $(`bar${key}`).style.width = `${Math.max(0, Math.min(100, ((cur || 0) / max) * 100))}%`;
  $(`t${key}Target`).textContent = target > 0 ? `/ ${Math.round(target)} °C` : '';
  const mark = $(`mark${key}`);
  mark.style.display = target > 0 ? 'block' : 'none';
  mark.style.left = `${Math.min(100, (target / max) * 100)}%`;
}

function setSwitch(id, on, key) {
  if (held(key)) return;
  $(id).setAttribute('aria-checked', on ? 'true' : 'false');
}

function setSlider(id, outId, value, key, suffix = '%') {
  if (held(key) || typeof value !== 'number') return;
  $(id).value = value;
  $(outId).textContent = `${Math.round(value)}${suffix}`;
}

function setInfo(rows) {
  const dl = $('info');
  dl.replaceChildren();
  for (const [k, v] of rows) {
    if (v === undefined || v === null || v === '') continue;
    const wrap = document.createElement('div');
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = k;
    dd.textContent = v;
    wrap.append(dt, dd);
    dl.append(wrap);
  }
}

function render(d) {
  const status = d.status || 'ready';
  const [label, tone] = STATUS[status] || [status, 'idle'];
  const name = d.name || 'Adventurer 5M Pro';
  setChip(label, tone);
  $('printerName').textContent = name;
  document.title = `${label} – ${name}`;

  // Job
  const hasJob = !!d.printFileName && status !== 'ready';
  const pct = hasJob ? Math.max(0, Math.min(100, (d.printProgress || 0) * 100)) : 0;
  const counting = RUNNING.includes(status) || status === 'paused';
  $('fileName').textContent = hasJob ? d.printFileName : 'No active job';
  $('jobMeta').textContent = [d.rightFilamentType, d.nozzleModel ? `${d.nozzleModel} nozzle` : ''].filter(Boolean).join(', ');
  $('pct').textContent = hasJob ? `${pct.toFixed(pct < 10 ? 1 : 0)}%` : '—';
  $('progressFill').style.width = `${pct}%`;
  $('progressBar').setAttribute('aria-valuenow', String(Math.round(pct)));
  $('layer').textContent = hasJob && d.targetPrintLayer ? `${d.printLayer || 0} / ${d.targetPrintLayer}` : '—';
  $('elapsed').textContent = hasJob ? fmtTime(d.printDuration) : '—';
  $('remaining').textContent = hasJob && counting ? fmtTime(d.estimatedTime) : '—';
  $('eta').textContent = hasJob && counting && d.estimatedTime > 0
    ? new Date(Date.now() + d.estimatedTime * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : '—';
  const grams = d.estimatedRightWeight;
  const meters = d.estimatedRightLen ? d.estimatedRightLen / 1000 : 0;
  $('filament').textContent = hasJob && (grams || meters)
    ? [grams ? `${grams.toFixed(1)} g` : '', meters ? `${meters.toFixed(1)} m` : ''].filter(Boolean).join(', ')
    : '—';
  $('speedNow').textContent = hasJob && d.currentPrintSpeed ? `${d.currentPrintSpeed} mm/s` : '—';

  const thumb = $('thumb');
  const thumbUrl = hasJob && d.printFileThumbUrl ? sameHost(d.printFileThumbUrl) : null;
  if (thumbUrl && thumb.dataset.src !== thumbUrl) {
    thumb.dataset.src = thumbUrl;
    thumb.onload = () => { thumb.hidden = false; };
    thumb.onerror = () => { thumb.hidden = true; };
    thumb.src = thumbUrl;
  } else if (!thumbUrl) {
    thumb.hidden = true;
    delete thumb.dataset.src;
  }

  $('btnPause').disabled = !RUNNING.includes(status);
  $('btnResume').disabled = status !== 'paused';
  $('btnCancel').disabled = !['printing', 'working', 'heating', 'paused', 'pausing'].includes(status);
  $('btnClear').hidden = !['completed', 'cancel'].includes(status);

  // Tuning
  for (const el of document.querySelectorAll('#rngSpeed, #rngCooling, #rngChamberFan, [data-z]')) el.disabled = !counting;
  $('printOnlyHint').hidden = counting;
  setSlider('rngSpeed', 'outSpeed', d.printSpeedAdjust, 'speed');
  setSlider('rngCooling', 'outCooling', d.coolingFanSpeed, 'cooling');
  setSlider('rngChamberFan', 'outChamberFan', d.chamberFanSpeed, 'chamberFan');
  if (!held('z') && typeof d.zAxisCompensation === 'number') {
    zOffset = d.zAxisCompensation;
    $('outZ').textContent = `${zOffset >= 0 ? '+' : ''}${zOffset.toFixed(2)} mm`;
  }

  // Temperatures
  setTemp('Nozzle', d.rightTemp, d.rightTargetTemp, 280);
  setTemp('Bed', d.platTemp, d.platTargetTemp, 110);
  setTemp('Chamber', d.chamberTemp, d.chamberTargetTemp, 60);

  // Floating-window overlay
  const hudParts = [];
  if (hasJob) {
    hudParts.push($('pct').textContent);
    if (d.targetPrintLayer) hudParts.push(`layer ${d.printLayer || 0}/${d.targetPrintLayer}`);
    if (counting && d.estimatedTime > 0) hudParts.push(`${fmtTime(d.estimatedTime)} left`);
  } else {
    hudParts.push(label);
  }
  CAM.hudPct.textContent = hudParts.join('   ');
  CAM.hudTemps.textContent = `Nozzle ${fmtTemp(d.rightTemp)}   Bed ${fmtTemp(d.platTemp)}`;

  // Light and air
  setSwitch('swLight', d.lightStatus === 'open', 'light');
  setSwitch('swInternal', d.internalFanStatus === 'open', 'internal');
  setSwitch('swExternal', d.externalFanStatus === 'open', 'external');
  $('tvoc').textContent = typeof d.tvoc === 'number' ? String(d.tvoc) : '—';
  $('door').textContent = d.doorStatus === 'open' ? 'Open' : d.doorStatus === 'close' ? 'Closed' : '—';

  // Machine
  $('btnCalibrate').disabled = ACTIVE.includes(status);
  setSwitch('swShutdown', d.autoShutdown === 'open', 'shutdown');
  if (!held('shutdownMin') && document.activeElement !== $('shutdownMin') && d.autoShutdownTime) {
    $('shutdownMin').value = d.autoShutdownTime;
  }
  if (document.activeElement !== $('renameInput') && !held('rename')) $('renameInput').value = d.name || '';

  setInfo([
    ['Firmware', d.firmwareVersion],
    ['Nozzle', d.nozzleModel],
    ['Loaded filament', d.rightFilamentType],
    ['Lifetime filament', typeof d.cumulativeFilament === 'number' ? `${d.cumulativeFilament.toFixed(1)} m` : null],
    ['IP address', d.ipAddr],
    ['MAC address', d.macAddr],
    ['Error code', d.errorCode],
  ]);

  // File list: don't start another job while busy
  for (const b of document.querySelectorAll('.files button')) b.disabled = ACTIVE.includes(status);
}

// ---------- Polling ----------

async function poll() {
  clearTimeout(pollTimer);
  if (!cfg) return;
  try {
    const data = await api('/detail');
    detail = data.detail || {};
    failures = 0;
    setBanner(null);
    render(detail);
  } catch (e) {
    failures++;
    if (failures >= 2 || !detail) {
      setBanner(e.message);
      setChip('Offline', 'bad');
    }
  }
  const delay = inBackground() ? 10000 : failures ? 5000 : 2000;
  pollTimer = setTimeout(poll, delay);
}

async function loadProduct() {
  try {
    product = (await api('/product')).product || null;
  } catch { product = null; }
  // Chamber heating only exists on some models.
  $('chamberSet').hidden = !(product && product.chamberTempCtrlState === 1);
}

// ---------- Camera ----------

const cam = { paused: false, abort: null, watch: null, url: null, refresh: null, stall: null, lastFrame: 0 };

// The printer's camera stream can stop sending frames after a while, so the feed
// reconnects on a timer while it's showing. Can be turned off under Machine.
const CAM_REFRESH_MS = 4 * 60 * 1000;
const CAM_STALL_MS = 15 * 1000;
let camAutoRefresh = true;

function scheduleCamRefresh() {
  clearTimeout(cam.refresh);
  cam.refresh = null;
  if (!camAutoRefresh) return;
  cam.refresh = setTimeout(() => {
    if (cfg && !cam.paused && !inBackground()) startCamera({ quiet: true });
  }, CAM_REFRESH_MS);
}

function camMsg(text) {
  const m = CAM.msg;
  m.hidden = !text;
  m.textContent = text || '';
}

function cameraUrl() {
  const fromPrinter = detail?.cameraStreamUrl ? sameHost(detail.cameraStreamUrl) : null;
  return fromPrinter || `http://${cfg.ip}:8080/?action=stream`;
}

function stopCamera() {
  clearInterval(cam.watch);
  cam.watch = null;
  clearTimeout(cam.refresh);
  cam.refresh = null;
  clearInterval(cam.stall);
  cam.stall = null;
  if (cam.abort) { cam.abort.abort(); cam.abort = null; }
  const img = CAM.img;
  img.onerror = null;
  img.removeAttribute('src');
  img.hidden = true;
  CAM.canvas.hidden = true;
}

async function startCamera({ quiet = false } = {}) {
  stopCamera();
  if (!cfg || cam.paused || inBackground()) return;
  if (!quiet) camMsg('Connecting to the camera…');
  control('streamCtrl_cmd', { action: 'open' }).catch(() => {});

  // Briefly wait for the first /detail so we can use the URL the printer reports.
  for (let i = 0; i < 20 && !detail; i++) await new Promise((r) => setTimeout(r, 200));
  if (cam.paused || inBackground()) return;

  cam.url = cameraUrl();
  const img = CAM.img;
  img.onerror = () => { clearInterval(cam.watch); startCanvasStream(); };
  img.src = cam.url;
  scheduleCamRefresh();

  const started = Date.now();
  cam.watch = setInterval(() => {
    if (img.naturalWidth > 0) {
      clearInterval(cam.watch);
      img.hidden = false;
      camMsg(null);
    } else if (Date.now() - started > 8000) {
      clearInterval(cam.watch);
      img.onerror = null;
      img.removeAttribute('src');
      startCanvasStream();
    }
  }, 400);
}

// Fallback: read the MJPEG stream with fetch and paint each JPEG on a canvas.
async function startCanvasStream() {
  const canvas = CAM.canvas;
  const ctx = canvas.getContext('2d');
  cam.abort = new AbortController();
  // Watchdog: if no frame arrives for a while, reconnect.
  cam.lastFrame = Date.now();
  clearInterval(cam.stall);
  cam.stall = setInterval(() => {
    if (Date.now() - cam.lastFrame > CAM_STALL_MS && !cam.paused && !inBackground()) startCamera({ quiet: true });
  }, 5000);
  try {
    const res = await fetch(cam.url, { signal: cam.abort.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    let buf = new Uint8Array(0);
    let drawing = false;
    let shown = false;

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const merged = new Uint8Array(buf.length + value.length);
      merged.set(buf);
      merged.set(value, buf.length);
      buf = merged;

      let start = findMarker(buf, 0xd8, 0);
      while (start >= 0) {
        const end = findMarker(buf, 0xd9, start + 2);
        if (end < 0) break;
        const frame = buf.slice(start, end + 2);
        buf = buf.slice(end + 2);
        if (!drawing) {
          drawing = true;
          createImageBitmap(new Blob([frame], { type: 'image/jpeg' }))
            .then((bmp) => {
              if (canvas.width !== bmp.width) canvas.width = bmp.width;
              if (canvas.height !== bmp.height) canvas.height = bmp.height;
              ctx.drawImage(bmp, 0, 0);
              cam.lastFrame = Date.now();
              bmp.close();
              if (!shown) { shown = true; canvas.hidden = false; camMsg(null); }
            })
            .catch(() => {})
            .finally(() => { drawing = false; });
        }
        start = findMarker(buf, 0xd8, 0);
      }
      if (buf.length > 8 * 1024 * 1024) buf = new Uint8Array(0);
    }
    throw new Error('Stream ended');
  } catch (e) {
    if (e.name === 'AbortError') return;
    clearInterval(cam.stall);
    cam.stall = null;
    canvas.hidden = true;
    camMsg('Couldn’t open the camera. Check that it’s enabled on the printer, or try “Pop out”.');
  }
}

function findMarker(buf, second, from) {
  for (let i = from; i < buf.length - 1; i++) {
    if (buf[i] === 0xff && buf[i + 1] === second) return i;
  }
  return -1;
}

// ---------- Files ----------

const thumbCache = new Map();

async function loadThumb(name, img) {
  if (thumbCache.has(name)) {
    const src = thumbCache.get(name);
    if (src) { img.src = src; img.hidden = false; }
    return;
  }
  try {
    const data = await api('/gcodeThumb', { fileName: name }, cfg, 8000);
    const src = data.imageData ? `data:image/png;base64,${data.imageData}` : null;
    thumbCache.set(name, src);
    if (src) { img.src = src; img.hidden = false; }
  } catch {
    thumbCache.set(name, null);
  }
}

function emptyItem(text) {
  const li = document.createElement('li');
  li.className = 'empty';
  li.textContent = text;
  return li;
}

async function loadFiles() {
  const list = $('fileList');
  try {
    const data = await api('/gcodeList');
    const names = data.gcodeList || (data.gcodeListDetail || []).map((f) => f.gcodeFileName);
    list.replaceChildren();
    if (!names.length) {
      list.append(emptyItem('No recent files on the printer.'));
      return;
    }
    for (const name of names) {
      const li = document.createElement('li');
      const img = document.createElement('img');
      img.alt = '';
      img.hidden = true;
      const span = document.createElement('span');
      span.textContent = name;
      const btn = document.createElement('button');
      btn.className = 'btn small';
      btn.textContent = 'Print';
      btn.disabled = ACTIVE.includes(detail?.status);
      btn.addEventListener('click', () => {
        if (!confirm(`Print “${name}”?`)) return;
        runAction(btn, () => api('/printGcode', { fileName: name, levelingBeforePrint: $('optLevel').checked }), `Started printing “${name}”.`);
      });
      li.append(img, span, btn);
      list.append(li);
      loadThumb(name, img);
    }
  } catch (e) {
    list.replaceChildren(emptyItem(`Couldn’t load the file list: ${e.message}`));
  }
}

function uploadFile(file, printNow, level, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `http://${cfg.ip}:${API_PORT}/uploadGcode`);
    xhr.setRequestHeader('serialNumber', cfg.serial);
    xhr.setRequestHeader('checkCode', cfg.checkCode);
    xhr.setRequestHeader('fileSize', String(file.size));
    xhr.setRequestHeader('printNow', printNow ? '1' : '0');
    xhr.setRequestHeader('levelingBeforePrint', level ? '1' : '0');
    xhr.setRequestHeader('flowCalibration', '0');
    xhr.setRequestHeader('useMatlStation', '0');
    xhr.setRequestHeader('gcodeToolCnt', '0');
    xhr.setRequestHeader('materialMappings', '[]');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* non-JSON response */ }
      if (data && data.code !== 0) return reject(new Error(API_ERRORS[data.code] || data.message || `Error ${data.code}.`));
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      reject(new Error(`The printer answered HTTP ${xhr.status}.`));
    };
    xhr.onerror = () => reject(new Error('Lost the connection to the printer during the upload.'));
    const form = new FormData();
    form.append('gcodeFile', file, file.name);
    xhr.send(form);
  });
}

async function handleFile(file) {
  if (!file || !cfg) return;
  if (!/\.(gcode|gx|3mf)$/i.test(file.name)) {
    toast('Only .gcode and .3mf files can be uploaded.', 'bad');
    return;
  }
  const printNow = $('optPrintNow').checked;
  if (printNow && ACTIVE.includes(detail?.status)) {
    toast('The printer is busy. Uncheck “Print after upload” to just store the file.', 'bad');
    return;
  }
  const fill = $('uploadFill');
  const text = $('uploadText');
  $('uploadBox').hidden = false;
  fill.style.width = '0%';
  text.textContent = `Uploading “${file.name}”…`;
  $('fileInput').disabled = true;
  try {
    await uploadFile(file, printNow, $('optLevel').checked, (p) => {
      fill.style.width = `${p * 100}%`;
      text.textContent = `Uploading “${file.name}”: ${Math.round(p * 100)}%`;
    });
    text.textContent = printNow ? `Uploaded “${file.name}”. The print will start shortly.` : `Saved “${file.name}” on the printer.`;
    loadFiles();
    setTimeout(poll, 800);
  } catch (e) {
    text.textContent = e.message;
    toast(e.message, 'bad');
  } finally {
    $('fileInput').disabled = false;
    $('fileInput').value = '';
  }
}

// ---------- Connection settings ----------

function normalizeHost(raw) {
  const v = raw.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
  return /^[a-z0-9.-]+$/i.test(v) ? v : null;
}

function openSettings(firstRun = false) {
  $('fIp').value = cfg?.ip || '';
  $('fSerial').value = cfg?.serial || '';
  $('fCode').value = cfg?.checkCode || '';
  $('btnCloseSettings').hidden = firstRun;
  $('btnForget').hidden = !cfg;
  setFormStatus('');
  $('settings').showModal();
  $('fIp').focus();
}

function setFormStatus(msg, bad = false) {
  const s = $('formStatus');
  s.textContent = msg;
  s.className = `form-status${bad ? ' bad' : ''}`;
}

$('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ip = normalizeHost($('fIp').value);
  const serial = $('fSerial').value.trim();
  const checkCode = $('fCode').value.trim();
  if (!ip) return setFormStatus('Enter a valid IP address, like 192.168.1.50.', true);
  if (!serial) return setFormStatus('Enter the serial number.', true);
  if (!checkCode) return setFormStatus('Enter the check code.', true);

  // Must come first after the click: Chrome only grants permissions on a user gesture.
  const granted = await chrome.permissions.request({ origins: [`http://${ip}/*`] });
  if (!granted) return setFormStatus('Without access to that IP the extension can’t reach the printer.', true);

  const next = { ip, serial, checkCode };
  const btn = $('btnConnect');
  btn.disabled = true;
  setFormStatus('Testing the connection…');
  try {
    await api('/detail', {}, next);
  } catch (err) {
    btn.disabled = false;
    return setFormStatus(err.message, true);
  }
  btn.disabled = false;

  if (cfg && cfg.ip !== ip) chrome.permissions.remove({ origins: [`http://${cfg.ip}/*`] }).catch(() => {});
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  cfg = next;
  $('settings').close();
  toast('Printer connected.');
  start();
});

$('btnCloseSettings').addEventListener('click', () => $('settings').close());
$('settings').addEventListener('cancel', (e) => { if (!cfg) e.preventDefault(); });

$('btnForget').addEventListener('click', async () => {
  if (!confirm('Forget this printer? The saved IP, serial number and check code will be deleted.')) return;
  const old = cfg;
  stopAll();
  cfg = null;
  detail = null;
  await chrome.storage.local.remove(STORAGE_KEY);
  if (old) chrome.permissions.remove({ origins: [`http://${old.ip}/*`] }).catch(() => {});
  $('ipLabel').textContent = '';
  setChip('Offline', 'idle');
  camMsg('Connect a printer to see the camera.');
  openSettings(true);
});

// ---------- View switching ----------

$('openSettings').addEventListener('click', () => openSettings(false));

$('openFull').hidden = !IS_SIDE;
$('openFull').addEventListener('click', async () => {
  try { await chrome.runtime.sendMessage({ type: 'open-full' }); } catch { /* opened anyway */ }
  window.close(); // closes the side panel
});

let myWindowId = null;
chrome.windows.getCurrent().then((w) => { myWindowId = w.id; });
$('openSide').hidden = IS_SIDE || !chrome.sidePanel?.open;
$('openSide').addEventListener('click', () => {
  // sidePanel.open needs the user gesture: no awaits before calling it.
  if (myWindowId != null) chrome.sidePanel.open({ windowId: myWindowId }).catch((e) => toast(e.message, 'bad'));
});

// ---------- Job controls ----------

$('btnPause').addEventListener('click', (e) =>
  runAction(e.currentTarget, () => control('jobCtl_cmd', { jobID: '', action: 'pause' }), 'Print paused.'));
$('btnResume').addEventListener('click', (e) =>
  runAction(e.currentTarget, () => control('jobCtl_cmd', { jobID: '', action: 'continue' }), 'Print resumed.'));
$('btnCancel').addEventListener('click', (e) => {
  if (!confirm('Cancel the current print? This can’t be undone.')) return;
  runAction(e.currentTarget, () => control('jobCtl_cmd', { jobID: '', action: 'cancel' }), 'Print canceled.');
});
$('btnClear').addEventListener('click', (e) =>
  runAction(e.currentTarget, () => control('stateCtrl_cmd', { action: 'setClearPlatform' }), 'Printer ready for the next job.'));

// ---------- Switches ----------

function bindSwitch(id, key, send, okMsg) {
  $(id).addEventListener('click', (e) => {
    const sw = e.currentTarget;
    const on = !isOn(id);
    sw.setAttribute('aria-checked', String(on));
    hold(key);
    runAction(sw, () => send(on), okMsg?.(on));
  });
}
bindSwitch('swLight', 'light', (on) => control('lightControl_cmd', { status: on ? 'open' : 'close' }));
bindSwitch('swInternal', 'internal', (on) => control('circulateCtl_cmd', {
  internal: on ? 'open' : 'close',
  external: isOn('swExternal') ? 'open' : 'close',
}));
bindSwitch('swExternal', 'external', (on) => control('circulateCtl_cmd', {
  internal: isOn('swInternal') ? 'open' : 'close',
  external: on ? 'open' : 'close',
}));
bindSwitch('swShutdown', 'shutdown', (on) => control('delayClose_cmd', {
  automaticShutdown: on ? 'open' : 'close',
  shutdownAfterTime: Number($('shutdownMin').value) || 30,
}), (on) => (on ? 'Auto shutdown on.' : 'Auto shutdown off.'));

// ---------- Tuning ----------

function bindSlider(id, outId, key, toArgs) {
  const el = $(id);
  el.addEventListener('input', () => { hold(key, 6000); $(outId).textContent = `${el.value}%`; });
  el.addEventListener('change', () => {
    hold(key, 6000);
    runAction(null, () => control('printerCtl_cmd', toArgs(Number(el.value))));
  });
}
// The API takes 0–255 for fans; the UI shows a percentage.
bindSlider('rngSpeed', 'outSpeed', 'speed', (v) => ({ speed: v }));
bindSlider('rngCooling', 'outCooling', 'cooling', (v) => ({ coolingFan: Math.round(v * 2.55) }));
bindSlider('rngChamberFan', 'outChamberFan', 'chamberFan', (v) => ({ chamberFan: Math.round(v * 2.55) }));

let zOffset = 0;
for (const b of document.querySelectorAll('[data-z]')) {
  b.addEventListener('click', () => {
    zOffset = Math.max(-5, Math.min(5, Math.round((zOffset + Number(b.dataset.z)) * 100) / 100));
    $('outZ').textContent = `${zOffset >= 0 ? '+' : ''}${zOffset.toFixed(2)} mm`;
    hold('z', 5000);
    runAction(null, () => control('printerCtl_cmd', { zAxisCompensation: zOffset }));
  });
}

// ---------- Temperatures ----------

// -200 leaves a heater unchanged; 0 turns it off.
function setTemps(changes, okMsg, btn) {
  const args = { rightNozzle: -200, platform: -200, ...changes };
  if (product?.chamberTempCtrlState === 1 && !('chamber' in changes)) args.chamber = -200;
  runAction(btn, () => control('temperatureCtl_cmd', args), okMsg);
}

for (const form of document.querySelectorAll('.temp-set')) {
  const key = form.dataset.target;
  const max = Number(form.dataset.max);
  const input = form.querySelector('input');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = Math.round(Number(input.value));
    if (!input.value || !isFinite(v) || v < 0 || v > max) {
      toast(`Enter a temperature between 0 and ${max} °C.`, 'bad');
      return;
    }
    setTemps({ [key]: v }, `Target set to ${v} °C.`, form.querySelector('[type=submit]'));
    input.value = '';
  });
  form.querySelector('[data-off]').addEventListener('click', (e) =>
    setTemps({ [key]: 0 }, 'Heater off.', e.currentTarget));
}

for (const b of document.querySelectorAll('[data-preset]')) {
  b.addEventListener('click', () => {
    const [nozzle, bed] = b.dataset.preset.split(',').map(Number);
    const msg = nozzle ? `Preheating to ${nozzle} °C / ${bed} °C.` : 'Heaters off.';
    setTemps({ rightNozzle: nozzle, platform: bed }, msg, b);
  });
}

// ---------- Machine ----------

$('optCamRefresh').addEventListener('change', (e) => {
  camAutoRefresh = e.target.checked;
  chrome.storage.local.set({ camAutoRefresh });
  if (camAutoRefresh) { if (CAM.img.src || !CAM.canvas.hidden) scheduleCamRefresh(); }
  else { clearTimeout(cam.refresh); cam.refresh = null; }
});

$('btnCalibrate').addEventListener('click', (e) => {
  const level = $('calLevel').checked;
  const vib = $('calVibration').checked;
  if (!level && !vib) { toast('Choose at least one calibration.', 'bad'); return; }
  if (!confirm('Start calibration? Keep the build plate clear.')) return;
  runAction(e.currentTarget, () => control('calibration_cmd', {
    levelingDetection: level ? 'open' : 'close',
    vibrationCompensation: vib ? 'open' : 'close',
  }), 'Calibration sent.');
});

$('shutdownForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const min = Math.round(Number($('shutdownMin').value));
  if (!min || min < 1) { toast('Enter how many minutes to wait.', 'bad'); return; }
  hold('shutdownMin', 5000);
  runAction(e.submitter, () => control('delayClose_cmd', {
    automaticShutdown: isOn('swShutdown') ? 'open' : 'close',
    shutdownAfterTime: min,
  }), `Shutdown delay saved: ${min} min.`);
});

$('renameForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('renameInput').value.trim();
  if (!name) { toast('Enter a name.', 'bad'); return; }
  hold('rename', 5000);
  runAction(e.submitter, () => control('reName_cmd', { name }), `Renamed to “${name}”.`);
});

// ---------- Camera and files ----------

CAM.toggle.addEventListener('click', () => {
  cam.paused = !cam.paused;
  CAM.toggle.textContent = cam.paused ? 'Resume feed' : 'Pause feed';
  if (cam.paused) { stopCamera(); camMsg('Feed paused.'); } else startCamera();
});

// Separate browser window with the raw stream. Stays open even if this panel closes.
function openCameraWindow() {
  if (!cfg) return;
  chrome.windows.create({ url: cam.url || cameraUrl(), type: 'popup', width: 800, height: 470 });
}
$('camPopout').addEventListener('click', openCameraWindow);

// Always-on-top floating window (Document Picture-in-Picture).
async function floatCamera() {
  if (pipWin) { pipWin.close(); return; }
  if (!('documentPictureInPicture' in window)) { openCameraWindow(); return; }
  let win;
  try {
    win = await documentPictureInPicture.requestWindow({ width: 480, height: 300 });
  } catch {
    openCameraWindow();
    return;
  }
  pipWin = win;
  for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
    const l = win.document.createElement('link');
    l.rel = 'stylesheet';
    l.href = link.href;
    win.document.head.append(l);
  }
  win.document.title = 'Camera – Adventurer 5M Pro';
  win.document.documentElement.className = 'pip';
  win.document.body.append(CAM.box);
  CAM.hud.hidden = false;
  CAM.float.textContent = 'Dock';
  $('camDocked').hidden = false;
  if (!cam.paused) startCamera(); // moving the image restarts its stream

  win.addEventListener('pagehide', () => {
    pipWin = null;
    $('camDocked').after(CAM.box);
    $('camDocked').hidden = true;
    CAM.hud.hidden = true;
    CAM.float.textContent = 'Float';
    if (document.hidden) stopCamera();
    else if (!cam.paused) startCamera();
  });
}
CAM.float.addEventListener('click', floatCamera);
$('camBack').addEventListener('click', () => pipWin?.close());

$('btnRefreshFiles').addEventListener('click', () => { thumbCache.clear(); loadFiles(); });

const drop = $('drop');
$('fileInput').addEventListener('change', (e) => handleFile(e.target.files[0]));
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  handleFile(e.dataTransfer.files[0]);
});

document.addEventListener('visibilitychange', () => {
  if (!cfg) return;
  if (document.hidden) {
    if (!pipWin) stopCamera(); // the floating window keeps the camera running
  } else {
    poll();
    if (!cam.paused) startCamera();
  }
});

// ---------- Startup ----------

function stopAll() {
  clearTimeout(pollTimer);
  stopCamera();
}

function start() {
  stopAll();
  failures = 0;
  detail = null;
  $('ipLabel').textContent = cfg.ip;
  poll();
  loadProduct();
  loadFiles();
  startCamera();
}

(async () => {
  const prefs = await chrome.storage.local.get('camAutoRefresh');
  camAutoRefresh = prefs.camAutoRefresh !== false;
  $('optCamRefresh').checked = camAutoRefresh;
  const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  if (stored?.ip && stored.serial && stored.checkCode) {
    const ok = await chrome.permissions.contains({ origins: [`http://${stored.ip}/*`] });
    cfg = stored;
    if (ok) start();
    else openSettings(false); // permission was removed: reconnecting asks again
  } else {
    camMsg('Connect a printer to see the camera.');
    openSettings(true);
  }
})();
