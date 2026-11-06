import { analyze, buildCuts } from './beats.js';

const $ = (id) => document.getElementById(id);
const cv = $('cv'), ctx2 = cv.getContext('2d');
const TRANSITIONS = ['cut', 'fade', 'slide', 'zoom', 'wipe', 'flash', 'glitch'];
const RATIOS = { '9:16': 16 / 9, '4:5': 5 / 4, '1:1': 1 };

const S = {
  buffer: null, analysis: null, start: 0, len: 30,
  segs: [], media: [], sel: -1,
  ac: null, playing: false, t0: 0, raf: 0, srcNode: null, exporting: false,
};

if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});

TRANSITIONS.forEach((t) => $('trans').add(new Option(t, t)));
const setStatus = (m) => ($('status').textContent = m);

/* ---------- canvas size ---------- */
function sizeCanvas(width) {
  const r = RATIOS[$('ratio').value];
  cv.width = width;
  cv.height = Math.round(width * r);
}
sizeCanvas(540);
$('ratio').onchange = () => { sizeCanvas(540); draw(S.start); };

/* ---------- song ---------- */
$('song').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  S.ac ??= new (window.AudioContext || window.webkitAudioContext)();
  $('info').textContent = 'Decoding…';
  try {
    S.buffer = await S.ac.decodeAudioData(await f.arrayBuffer());
  } catch {
    $('info').textContent = 'Could not decode this audio file.';
    return;
  }
  S.analysis = await analyze(S.buffer, (p) => ($('info').textContent = `Analysing beats… ${Math.round(p * 100)}%`));
  const a = S.analysis;
  $('info').textContent = `${a.bpm.toFixed(1)} BPM · ${a.beats.length} beats · ${a.drops.length} drops detected`;
  updateWindow();
};

function updateWindow() {
  if (!S.buffer) return;
  S.len = Math.min(Number($('len').value), S.buffer.duration);
  const max = Math.max(0, S.buffer.duration - S.len);
  $('start').max = max;
  S.start = Math.min(S.start, max);
  $('start').value = S.start;
  $('startv').textContent = S.start.toFixed(1) + 's';
  $('nudgev').textContent = $('nudge').value + 'ms';
  rebuild();
}
$('len').onchange = updateWindow;
$('start').oninput = () => { S.start = Number($('start').value); updateWindow(); };
$('nudge').oninput = updateWindow;
$('mode').onchange = rebuild;

/* ---------- cuts -> segments ---------- */
function rebuild() {
  if (!S.analysis) return;
  const cuts = buildCuts(S.analysis, S.start, S.len, $('mode').value, Number($('nudge').value) / 1000);
  const old = S.segs;
  S.segs = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const o = old[i] || {};
    S.segs.push({ a: cuts[i], b: cuts[i + 1], media: o.media ?? -1, trans: o.trans || (i ? 'fade' : 'cut'), inpt: o.inpt || 0 });
  }
  if (S.sel >= S.segs.length) S.sel = -1;
  drawWave();
  renderTimeline();
  $('play').disabled = false;
  $('auto').disabled = S.media.length === 0;
  $('export').disabled = false;
  $('clock').textContent = `0.0 / ${S.len.toFixed(1)}s`;
  draw(S.start);
}

function drawWave() {
  const w = $('wave'); w.width = w.clientWidth * devicePixelRatio || 600;
  const c = w.getContext('2d'), H = w.height, W = w.width;
  c.clearRect(0, 0, W, H);
  const d = S.buffer.getChannelData(0), step = Math.floor(d.length / W);
  c.fillStyle = '#5a5a78';
  for (let x = 0; x < W; x++) {
    let m = 0;
    for (let i = x * step; i < (x + 1) * step; i += 16) m = Math.max(m, Math.abs(d[i]));
    c.fillRect(x, H / 2 - m * H / 2, 1, Math.max(1, m * H));
  }
  const px = (t) => (t / S.buffer.duration) * W;
  c.fillStyle = '#ff3d7f33'; c.fillRect(px(S.start), 0, px(S.len) , H);
  c.strokeStyle = '#ff3d7f';
  for (const s of S.segs) { c.beginPath(); c.moveTo(px(s.a), 0); c.lineTo(px(s.a), H); c.stroke(); }
  c.strokeStyle = '#fff';
  for (const t of S.analysis.drops) { c.beginPath(); c.moveTo(px(t), 0); c.lineTo(px(t), H); c.setLineDash([4, 4]); c.stroke(); c.setLineDash([]); }
}
$('wave').addEventListener('pointerdown', (e) => {
  if (!S.buffer) return;
  const r = $('wave').getBoundingClientRect();
  S.start = Math.max(0, ((e.clientX - r.left) / r.width) * S.buffer.duration - S.len / 2);
  updateWindow();
});

/* ---------- media ---------- */
$('media').onchange = async (e) => {
  for (const f of e.target.files) {
    const url = URL.createObjectURL(f);
    const m = { url, type: f.type.startsWith('video') ? 'video' : 'image', thumb: '' };
    if (m.type === 'video') {
      const v = document.createElement('video');
      Object.assign(v, { muted: true, playsInline: true, loop: true, preload: 'auto', src: url });
      v.setAttribute('playsinline', ''); v.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none';
      document.body.appendChild(v);
      m.el = v;
      await new Promise((r) => { v.onloadeddata = r; v.onerror = r; });
      await new Promise((r) => { v.onseeked = r; v.currentTime = Math.min(0.1, v.duration || 0); setTimeout(r, 1500); });
      m.dur = v.duration || 1;
    } else {
      m.el = new Image(); m.el.src = url;
      await m.el.decode().catch(() => {});
    }
    m.thumb = makeThumb(m);
    S.media.push(m);
  }
  e.target.value = '';
  renderBin();
  $('auto').disabled = S.segs.length === 0;
};
function makeThumb(m) {
  const c = document.createElement('canvas'); c.width = 96; c.height = 96;
  try { coverDraw(c.getContext('2d'), m.el, 96, 96, 1); } catch {}
  return c.toDataURL('image/jpeg', 0.7);
}
let selMedia = -1;
function renderBin() {
  const bin = $('bin'); bin.innerHTML = '';
  S.media.forEach((m, i) => {
    const im = new Image(); im.src = m.thumb; im.className = 'm' + (i === selMedia ? ' sel' : '');
    im.draggable = true;
    im.ondragstart = (e) => e.dataTransfer.setData('text/plain', String(i));
    im.onclick = () => {
      selMedia = i;
      if (S.sel >= 0) assign(S.sel, i);
      renderBin();
    };
    bin.appendChild(im);
  });
}
function assign(slot, mi) {
  S.segs[slot].media = mi; S.segs[slot].inpt = 0;
  renderTimeline(); draw(S.segs[slot].a);
}
$('auto').onclick = () => {
  if (!S.media.length) return;
  S.segs.forEach((s, i) => { s.media = i % S.media.length; s.inpt = 0; });
  renderTimeline(); draw(S.start);
};

/* ---------- timeline ---------- */
function renderTimeline() {
  const tl = $('timeline'); tl.innerHTML = '';
  S.segs.forEach((s, i) => {
    const d = document.createElement('div');
    d.className = 'slot' + (i === S.sel ? ' sel' : '');
    d.style.width = Math.max(70, (s.b - s.a) * 28) + 'px';
    if (s.media >= 0) { const im = new Image(); im.src = S.media[s.media].thumb; d.appendChild(im); }
    d.insertAdjacentHTML('beforeend', `<span class="l">${i + 1} · ${(s.b - s.a).toFixed(2)}s</span>` + (i ? `<span class="t">${s.trans}</span>` : ''));
    d.onclick = () => { S.sel = i; if (selMedia >= 0 && s.media < 0) assign(i, selMedia); renderTimeline(); showPanel(); draw(s.a); };
    d.ondragover = (e) => { e.preventDefault(); d.classList.add('over'); };
    d.ondragleave = () => d.classList.remove('over');
    d.ondrop = (e) => { e.preventDefault(); const mi = Number(e.dataTransfer.getData('text/plain')); if (!isNaN(mi)) assign(i, mi); };
    tl.appendChild(d);
  });
  showPanel();
}
function showPanel() {
  const p = $('slotpanel'), s = S.segs[S.sel];
  p.hidden = !s;
  if (!s) return;
  $('trans').value = s.trans; $('trans').disabled = S.sel === 0;
  const m = S.media[s.media];
  $('inrow').hidden = !(m && m.type === 'video');
  if (m && m.type === 'video') { $('inpt').max = Math.max(0, m.dur - 0.5); $('inpt').value = s.inpt; $('inv').textContent = s.inpt.toFixed(1) + 's'; }
}
$('trans').onchange = () => { S.segs[S.sel].trans = $('trans').value; renderTimeline(); };
$('applyall').onclick = () => { S.segs.forEach((s, i) => { if (i) s.trans = $('trans').value; }); renderTimeline(); };
$('inpt').oninput = () => { S.segs[S.sel].inpt = Number($('inpt').value); $('inv').textContent = $('inpt').value + 's'; draw(S.segs[S.sel].a); };

/* ---------- rendering ---------- */
function coverDraw(c, el, W, H, zoom = 1) {
  const sw = el.videoWidth || el.naturalWidth || el.width, sh = el.videoHeight || el.naturalHeight || el.height;
  if (!sw || !sh) return;
  const sc = Math.max(W / sw, H / sh) * zoom;
  c.drawImage(el, (W - sw * sc) / 2, (H - sh * sc) / 2, sw * sc, sh * sc);
}
function drawSeg(c, seg, t) {
  const W = cv.width, H = cv.height;
  c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
  const m = S.media[seg.media];
  if (!m) return;
  const local = Math.max(0, t - seg.a);
  if (m.type === 'video') {
    const want = m.dur > 0 ? (seg.inpt + local) % m.dur : 0;
    if (!S.playing && Math.abs(m.el.currentTime - want) > 0.05) m.el.currentTime = want;
    coverDraw(c, m.el, W, H);
  } else {
    coverDraw(c, m.el, W, H, 1 + 0.08 * Math.min(1, local / Math.max(0.1, seg.b - seg.a)));
  }
}
function syncVideos(t, i, prev) {
  const active = new Set();
  [S.segs[i], prev].forEach((s) => {
    const m = s && S.media[s.media];
    if (!m || m.type !== 'video') return;
    active.add(m);
    const want = (s.inpt + Math.max(0, t - s.a)) % m.dur;
    if (m.el.paused || Math.abs(m.el.currentTime - want) > 0.4) {
      try { m.el.currentTime = want; } catch {}
      m.el.play().catch(() => {});
    }
  });
  S.media.forEach((m) => { if (m.type === 'video' && !active.has(m) && !m.el.paused) m.el.pause(); });
}

function draw(t) {
  if (!S.segs.length) { ctx2.fillStyle = '#000'; ctx2.fillRect(0, 0, cv.width, cv.height); return; }
  let i = S.segs.findIndex((s) => t >= s.a && t < s.b);
  if (i < 0) i = S.segs.length - 1;
  const seg = S.segs[i], prev = S.segs[i - 1];
  if (S.playing) syncVideos(t, i, prev);
  const td = Math.min(0.3, (seg.b - seg.a) * 0.4);
  const p = prev && seg.trans !== 'cut' ? (t - seg.a) / td : 1;
  if (p >= 1 || !prev) return void drawSeg(ctx2, seg, t), flash(0);
  const W = cv.width, H = cv.height, c = ctx2;
  const A = () => drawSeg(c, prev, t), B = () => drawSeg(c, seg, t);
  const tr = seg.trans;
  if (tr === 'fade') { A(); c.globalAlpha = p; B(); c.globalAlpha = 1; }
  else if (tr === 'slide') {
    c.save(); c.translate(-p * W, 0); A(); c.restore();
    c.save(); c.translate((1 - p) * W, 0); B(); c.restore();
  } else if (tr === 'zoom') {
    A(); c.save(); c.globalAlpha = p; c.translate(W / 2, H / 2); const z = 1.4 - 0.4 * p; c.scale(z, z); c.translate(-W / 2, -H / 2); B(); c.restore();
  } else if (tr === 'wipe') {
    A(); c.save(); c.beginPath(); c.rect(0, 0, W * p, H); c.clip(); B(); c.restore();
  } else if (tr === 'flash') {
    p < 0.5 ? A() : B(); flash(1 - Math.abs(2 * p - 1));
  } else if (tr === 'glitch') {
    B(); c.save();
    const n = 10, sh = H / n;
    for (let k = 0; k < n; k++) {
      const r = Math.sin(k * 12.9898 + Math.floor(p * 8) * 78.233) * 43758.5453; const f = r - Math.floor(r);
      if (f < 1 - p) {
        c.save(); c.beginPath(); c.rect(0, k * sh, W, sh); c.clip();
        c.translate((f - 0.5) * W * 0.3 * (1 - p), 0); A(); c.restore();
      }
    }
    c.restore();
  } else B();
}
function flash(a) {
  if (a <= 0) return;
  ctx2.fillStyle = `rgba(255,255,255,${a})`; ctx2.fillRect(0, 0, cv.width, cv.height);
}

/* ---------- playback ---------- */
function stopPlayback() {
  S.playing = false; cancelAnimationFrame(S.raf);
  try { S.srcNode?.stop(); } catch {}
  S.srcNode = null;
  S.media.forEach((m) => m.type === 'video' && m.el.pause());
  $('play').textContent = '▶ Play';
}
function startPlayback(dest) {
  S.ac.resume();
  const src = S.ac.createBufferSource(); src.buffer = S.buffer;
  src.connect(S.ac.destination); if (dest) src.connect(dest);
  S.t0 = S.ac.currentTime + 0.05;
  src.start(S.t0, S.start, S.len);
  S.srcNode = src; S.playing = true;
  $('play').textContent = '⏸ Stop';
  const tick = () => {
    const t = S.start + Math.max(0, S.ac.currentTime - S.t0);
    draw(Math.min(t, S.start + S.len - 0.001));
    $('clock').textContent = `${(t - S.start).toFixed(1)} / ${S.len.toFixed(1)}s`;
    if (t >= S.start + S.len) { stopPlayback(); S.onEnd?.(); return; }
    S.raf = requestAnimationFrame(tick);
  };
  tick();
}
$('play').onclick = () => {
  if (S.exporting) return;
  S.ac ??= new (window.AudioContext || window.webkitAudioContext)();
  S.playing ? stopPlayback() : startPlayback();
};

/* ---------- export ---------- */
$('export').onclick = async () => {
  if (S.exporting || !S.segs.length) return;
  if (typeof MediaRecorder === 'undefined') { setStatus('MediaRecorder not supported in this browser.'); return; }
  S.ac ??= new (window.AudioContext || window.webkitAudioContext)();
  stopPlayback();
  S.exporting = true; $('dl').hidden = true;
  $('export').disabled = $('play').disabled = true;
  sizeCanvas(Number($('quality').value));
  const dest = S.ac.createMediaStreamDestination();
  const stream = new MediaStream([...cv.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const mime = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm']
    .find((m) => MediaRecorder.isTypeSupported(m)) || '';
  const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: 8_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    const type = rec.mimeType || 'video/mp4';
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type });
    const file = new File([blob], `reel.${ext}`, { type });
    const a = $('dl');
    a.href = URL.createObjectURL(blob); a.download = file.name;
    a.textContent = `Save reel.${ext} (${(blob.size / 1e6).toFixed(1)} MB)`;
    a.hidden = false;
    a.onclick = (e) => {
      if (navigator.canShare?.({ files: [file] })) { e.preventDefault(); navigator.share({ files: [file] }).catch(() => {}); }
    };
    setStatus('Export finished.');
    S.exporting = false; sizeCanvas(540); $('export').disabled = $('play').disabled = false; draw(S.start);
  };
  S.onEnd = () => { S.onEnd = null; setTimeout(() => rec.stop(), 150); };
  setStatus('Exporting in real time — keep this tab open…');
  rec.start(500);
  startPlayback(dest);
};

window.addEventListener('resize', () => S.buffer && drawWave());
