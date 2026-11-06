// Beat / drop analysis (no dependencies). Returns {bpm, beats[], drops[], duration}.
export async function analyze(buffer, onProgress = () => {}) {
  const sr = buffer.sampleRate;
  const ch = buffer.getChannelData(0);
  const other = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const hop = 512;
  const frames = Math.floor(ch.length / hop);
  const full = new Float32Array(frames);
  const low = new Float32Array(frames);
  const alpha = 1 - Math.exp((-2 * Math.PI * 150) / sr); // ~150 Hz low-pass
  let lp = 0;
  for (let f = 0; f < frames; f++) {
    let e = 0, el = 0;
    for (let i = f * hop, end = i + hop; i < end; i++) {
      const s = other ? (ch[i] + other[i]) / 2 : ch[i];
      lp += alpha * (s - lp);
      e += s * s;
      el += lp * lp;
    }
    full[f] = Math.sqrt(e / hop);
    low[f] = Math.sqrt(el / hop);
    if (f % 4000 === 0) {
      onProgress(f / frames);
      await new Promise((r) => setTimeout(r));
    }
  }
  const fps = sr / hop;

  // Onset strength: positive log-energy flux, blended full + low band.
  const onset = new Float32Array(frames);
  for (let f = 1; f < frames; f++) {
    const a = Math.log(1 + 100 * full[f]) - Math.log(1 + 100 * full[f - 1]);
    const b = Math.log(1 + 100 * low[f]) - Math.log(1 + 100 * low[f - 1]);
    onset[f] = Math.max(0, a) + Math.max(0, b);
  }
  const mean = onset.reduce((s, v) => s + v, 0) / frames;
  for (let f = 0; f < frames; f++) onset[f] = Math.max(0, onset[f] - mean);

  // Tempo by autocorrelation, 70-180 BPM, with mild preference for ~120.
  let bestLag = 0, bestScore = -1;
  const minLag = Math.floor((fps * 60) / 180), maxLag = Math.ceil((fps * 60) / 70);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let f = lag; f < frames; f++) s += onset[f] * onset[f - lag];
    const bpm = (fps * 60) / lag;
    s *= 1 - 0.1 * Math.abs(Math.log2(bpm / 120));
    if (s > bestScore) { bestScore = s; bestLag = lag; }
  }
  // Refine tempo/phase with a fractional-period comb search.
  let period = bestLag, bestPhase = 0, bestPS = -1;
  const at = (x) => onset[Math.round(x)] || 0;
  for (let P = bestLag * 0.97; P <= bestLag * 1.03; P += bestLag * 0.0005) {
    for (let p = 0; p < P; p += 0.5) {
      let s = 0;
      for (let x = p; x < frames; x += P) s += at(x);
      if (s > bestPS) { bestPS = s; bestPhase = p; period = P; }
    }
  }
  const bpm = (fps * 60) / period;
  const beats = [];
  const dur = buffer.duration;
  for (let t = bestPhase / fps; t < dur; t += period / fps) beats.push(t);

  // Drops: sustained low-band energy jumping vs. the previous couple of seconds.
  const win = Math.round(fps * 1);
  const prefix = new Float64Array(frames + 1);
  for (let f = 0; f < frames; f++) prefix[f + 1] = prefix[f] + low[f];
  const avg = (a, b) => (prefix[Math.min(frames, b)] - prefix[Math.max(0, a)]) / Math.max(1, Math.min(frames, b) - Math.max(0, a));
  const gMean = prefix[frames] / frames;
  const drops = [];
  let last = -99;
  for (let f = win * 2; f < frames - win; f += 4) {
    const before = avg(f - win * 2, f), after = avg(f, f + win);
    if (after > gMean * 1.1 && after > before * 1.8) {
      // snap to nearest beat
      const t = f / fps;
      const nb = beats.reduce((b, x) => (Math.abs(x - t) < Math.abs(b - t) ? x : b), beats[0] ?? t);
      if (nb - last > 4) { drops.push(nb); last = nb; }
    }
  }
  onProgress(1);
  return { bpm, beats, drops, duration: dur };
}

// Build cut points inside [start, start+length] for the chosen mode.
export function buildCuts(analysis, start, length, mode, offsetSec = 0) {
  const end = start + length;
  let pts;
  if (mode === 'drops') {
    pts = analysis.drops.map((t) => t + offsetSec);
  } else {
    const n = Number(mode) || 1;
    // keep every n-th beat, phased so the first beat in the window is used
    const inWin = analysis.beats.map((t) => t + offsetSec).filter((t) => t > start && t < end);
    pts = inWin.filter((_, i) => i % n === 0);
  }
  pts = pts.filter((t) => t > start + 0.3 && t < end - 0.3);
  return [start, ...pts, end];
}
