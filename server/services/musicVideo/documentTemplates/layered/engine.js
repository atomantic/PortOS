/* Layered music-video composition — the PortOS starting template.
 *
 * Every frame is a pure function of song time t: portosComposition.seek(t)
 * draws the scene under t (its selected take, with a gentle camera move and a
 * beat punch-in), film grain and a vignette, an optional HUD, and the words
 * (subtitle lyrics, or kinetic hero words for text cues flagged "hero").
 *
 * Data: window.PORTOS_MV, written by PortOS as portos-mv.js at render time —
 * { project, render, song, lyrics, lyricMarkers, scenes, textCues, composition }.
 * scenes[].media.src names a file PortOS copied into media/ (the selected take).
 * In the in-app preview window.PORTOS_MV_ASSETS resolves to { src: blob URL }.
 *
 * This file is yours once copied into a project: add project-specific cards
 * (title cards, diagrams, outros) in CARDS below and key them from scene labels.
 */
(() => {
  'use strict';
  const MV = window.PORTOS_MV;
  const GENERATED = window.PORTOS_MV_GENERATED || null;
  if (!MV || !MV.render) throw new Error('PORTOS_MV is missing — PortOS writes portos-mv.js next to index.html when it renders');

  // ---------- frame ----------
  let W = MV.render.width;
  let H = MV.render.height;
  const FPS = MV.render.fps || 24;
  const DURATION = MV.render.durationSec;
  const eventSong = { ...MV.song, sections: GENERATED?.song?.sections || MV.song.narrativeSections || MV.song.sections,
    narrativeEvents: GENERATED?.song?.narrativeEvents || MV.song.narrativeEvents,
    reactiveSections: GENERATED?.song?.reactiveSections || MV.song.reactiveSections };
  const eventState = (t) => window.PORTOS_MV_EVENT_STATE
    ? window.PORTOS_MV_EVENT_STATE(eventSong, t, FPS)
    : { t, frame: Math.floor(t * FPS + 1e-6), reactiveGain: 0, activeEvents: [], hold: false };
  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d');
  let U = 1; // type/HUD unit: 1 at 1080px on the short side
  function resize(width, height) {
    W = width; H = height;
    canvas.width = W; canvas.height = H;
    U = Math.min(W, H) / 1080;
  }
  resize(W, H);

  // ---------- palette & type (edit freely) ----------
  const style = MV.composition?.style || {};
  const C = {
    ink: '#07090a', paper: style.color || '#eef1ea', dim: 'rgba(238,241,234,.62)', faint: 'rgba(238,241,234,.28)',
    accent: '#ff5a1f', ok: '#b8d63a', alert: '#ff2a2a',
  };
  const F = {
    stencil: (px) => `900 ${px}px "MV Stencil", Impact, sans-serif`,
    cond: (px, w = 500) => `${w} ${px}px "MV Cond", "Arial Narrow", sans-serif`,
    mono: (px, w = 400) => `${w} ${px}px "MV Mono", Menlo, monospace`,
  };

  // ---------- math ----------
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, k) => a + (b - a) * k;
  const seg = (t, a, b) => (b > a ? clamp((t - a) / (b - a)) : (t >= b ? 1 : 0));
  const easeOut = (k) => 1 - Math.pow(1 - k, 3);
  const easeInOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
  const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  const frameOf = (t) => Math.floor(t * FPS + 1e-6);

  // ---------- song ----------
  const beats = (MV.song?.beats || []).filter(Number.isFinite);
  const downs = (MV.song?.downbeats || []).filter(Number.isFinite);
  const sections = (MV.song?.sections || []).filter((s) => Number.isFinite(s?.startSec));
  function lastIndex(list, t) {
    let lo = 0; let hi = list.length - 1; let r = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (list[m] <= t) { r = m; lo = m + 1; } else hi = m - 1; }
    return r;
  }
  const sinceBeat = (t, list = beats) => { const i = lastIndex(list, t); return i < 0 ? 99 : t - list[i]; };
  const pulse = (t, list = beats, k = 7) => Math.exp(-k * sinceBeat(t, list));
  const sectionAt = (t) => sections.filter((s) => s.startSec <= t).pop() || null;
  const isHighEnergy = (t) => /chorus|hook|drop|final|climax/i.test(sectionAt(t)?.label || '');

  // ---------- scenes ----------
  const SCENES = (MV.scenes || [])
    .filter((s) => Number.isFinite(s.startSec) && Number.isFinite(s.endSec) && s.endSec > s.startSec)
    .sort((a, b) => a.startSec - b.startSec)
    .map((s, i) => ({ ...s, index: i }));
  function sceneAt(t) {
    let lo = 0; let hi = SCENES.length - 1; let r = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (SCENES[m].startSec <= t) { r = m; lo = m + 1; } else hi = m - 1; }
    const scene = r >= 0 ? SCENES[r] : null;
    return scene && t < scene.endSec ? scene : null;
  }
  // Gentle camera moves (scale, offsets in frame fractions), picked per scene.
  const MOVES = [
    { s0: 1.04, s1: 1.12, x0: 0, x1: 0, y0: 0, y1: 0 },
    { s0: 1.13, s1: 1.05, x0: 0, x1: 0, y0: 0, y1: 0 },
    { s0: 1.09, s1: 1.09, x0: 0.022, x1: -0.022, y0: 0, y1: 0 },
    { s0: 1.09, s1: 1.09, x0: -0.022, x1: 0.022, y0: 0, y1: 0 },
    { s0: 1.05, s1: 1.11, x0: 0, x1: 0, y0: 0.018, y1: -0.01 },
  ];
  function moveFor(scene) {
    if (scene.media?.kind === 'video') return { s0: 1.02, s1: 1.06, x0: 0, x1: 0, y0: 0, y1: 0 };
    if (scene.stillMove === 'hold') return { s0: 1.03, s1: 1.04, x0: 0, x1: 0, y0: 0, y1: 0 };
    if (scene.stillMove === 'push') return MOVES[0];
    if (scene.stillMove === 'pan') return MOVES[2 + (scene.index % 2)];
    return MOVES[scene.index % MOVES.length];
  }

  // ---------- media (lazy, a few decoders at a time) ----------
  let assetUrls = null;
  const urlOf = (src) => (assetUrls && assetUrls[src]) || src;
  const images = new Map();
  const videos = new Map();
  const MAX_VIDEOS = 4;
  const MAX_IMAGES = 16;
  function touch(map, key) { const v = map.get(key); map.delete(key); map.set(key, v); return v; }
  function evict(map, max, release) {
    while (map.size > max) { const [key, value] = map.entries().next().value; map.delete(key); release(value); }
  }
  function loadImage(src) {
    if (images.has(src)) return touch(images, src).ready;
    const im = new Image();
    im.crossOrigin = 'anonymous';
    const entry = { el: im, ready: new Promise((resolve, reject) => {
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error(`image failed to load: ${src}`));
    }) };
    im.src = urlOf(src);
    images.set(src, entry);
    evict(images, MAX_IMAGES, () => {});
    return entry.ready;
  }
  function loadVideo(src) {
    if (videos.has(src)) return touch(videos, src).ready;
    const v = document.createElement('video');
    // The sandbox has an opaque origin. CORS keeps local footage readable for
    // pixel evidence without granting same-origin or network authority.
    v.crossOrigin = 'anonymous';
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    const entry = { el: v, ready: new Promise((resolve, reject) => {
      v.addEventListener('loadeddata', () => resolve(v), { once: true });
      v.addEventListener('error', () => reject(new Error(`video failed to load: ${src} (${v.error?.code ?? '?'})`)), { once: true });
    }) };
    v.src = urlOf(src);
    videos.set(src, entry);
    evict(videos, MAX_VIDEOS, (old) => { old.el.pause(); old.el.removeAttribute('src'); old.el.load(); });
    return entry.ready;
  }
  // Seek to the middle of the source frame under `local` so a frame boundary
  // can never round to the previous frame. 'seeked' only says the decoder
  // reached the time; drawImage reads the frame the compositor has PRESENTED,
  // which can trail it and paints nothing (a black capture) when read too soon.
  // So resolve on 'seeked' AND the presented-frame callback, which is armed
  // before the seek so a fast presentation is never missed. Where the browser
  // never presents a detached element, FRAME_GRACE_MS after 'seeked' stands in.
  // A frame presented from BEFORE the seek (the clip's time-0 frame, painted
  // once it loaded) fires the same callback, so a callback only counts when its
  // mediaTime is within a frame of the target; otherwise it re-arms.
  const FRAME_GRACE_MS = 1000;
  function seekVideo(v, media, local) {
    const fps = media.fps || FPS;
    const last = Math.max(0, (Number.isFinite(media.outSec) ? media.outSec : v.duration) - 0.5 / fps);
    const clamped = Math.min(Math.max(local, media.inSec || 0), last);
    const target = Math.min((Math.floor(clamped * fps + 1e-6) + 0.5) / fps, Math.max(0, v.duration - 1e-3));
    if (Math.abs(v.currentTime - target) < 1e-6 && v.readyState >= 2 && !v.seeking) return Promise.resolve(v);
    return new Promise((resolve, reject) => {
      let seeked = false;
      let presented = typeof v.requestVideoFrameCallback !== 'function';
      let grace = null;
      let settled = false;
      const timer = setTimeout(() => { cleanup(); reject(new Error(`video seek timed out: ${media.src} @ ${target.toFixed(3)}s`)); }, 15000);
      const finish = () => { if (seeked && presented) { cleanup(); resolve(v); } };
      const onSeeked = () => {
        seeked = true;
        if (!presented) grace = setTimeout(() => { presented = true; finish(); }, FRAME_GRACE_MS);
        finish();
      };
      const fail = () => { cleanup(); reject(new Error(`video seek failed: ${media.src} (${v.error?.code ?? '?'})`)); };
      function cleanup() { settled = true; clearTimeout(timer); clearTimeout(grace); v.removeEventListener('seeked', onSeeked); v.removeEventListener('error', fail); }
      v.addEventListener('seeked', onSeeked);
      v.addEventListener('error', fail);
      const armPresented = () => v.requestVideoFrameCallback((_now, meta) => {
        if (Number.isFinite(meta?.mediaTime) && Math.abs(meta.mediaTime - target) > 1 / fps) { if (!settled) armPresented(); return; }
        presented = true; finish();
      });
      if (!presented) armPresented();
      v.currentTime = target;
    });
  }
  // Resolve the drawable for a scene at song time t (and warm the next scene).
  async function sourceFor(scene, t) {
    const media = scene?.media;
    if (!media?.src) return null;
    const next = SCENES[scene.index + 1];
    if (next?.media?.src) (next.media.kind === 'video' ? loadVideo(next.media.src) : loadImage(next.media.src)).catch(() => {});
    if (media.kind === 'video') {
      const v = await loadVideo(media.src);
      return seekVideo(v, media, (media.inSec || 0) + (t - scene.startSec));
    }
    return loadImage(media.src);
  }

  // ---------- drawing helpers ----------
  function drawCover(src, k, move, extraScale = 1) {
    const sw = src.videoWidth || src.naturalWidth || src.width;
    const sh = src.videoHeight || src.naturalHeight || src.height;
    if (!sw || !sh) return;
    const s = lerp(move.s0, move.s1, easeInOut(k)) * extraScale;
    const base = Math.max(W / sw, H / sh) * s;
    const dw = sw * base; const dh = sh * base;
    const ox = lerp(move.x0, move.x1, easeInOut(k)) * W;
    const oy = lerp(move.y0, move.y1, easeInOut(k)) * H;
    ctx.drawImage(src, (W - dw) / 2 + ox, (H - dh) / 2 + oy, dw, dh);
  }
  const grainTiles = [];
  function buildGrain() {
    for (let n = 0; n < 6; n++) {
      const c = document.createElement('canvas'); c.width = 256; c.height = 256;
      const g = c.getContext('2d'); const d = g.createImageData(256, 256);
      for (let i = 0; i < d.data.length; i += 4) {
        const v = 128 + (hash(i * 0.37 + n * 1013.3) - 0.5) * 255;
        d.data[i] = v; d.data[i + 1] = v; d.data[i + 2] = v; d.data[i + 3] = 255;
      }
      g.putImageData(d, 0, 0); grainTiles.push(c);
    }
  }
  function grain(t, amount = 0.09) {
    const f = frameOf(t);
    ctx.save(); ctx.globalAlpha = amount; ctx.globalCompositeOperation = 'overlay';
    ctx.fillStyle = ctx.createPattern(grainTiles[f % grainTiles.length], 'repeat');
    const off = hash(f) * 256;
    ctx.translate(-off, -off * 0.7); ctx.fillRect(0, 0, W + 512, H + 512);
    ctx.restore();
  }
  function vignette(strength = 0.5) {
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.62);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${strength})`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }
  function _flash(k, color = '#fff') { if (k <= 0.001) return; ctx.save(); ctx.globalAlpha = clamp(k); ctx.fillStyle = color; ctx.fillRect(0, 0, W, H); ctx.restore(); }
  function glitch(t, strength) {
    if (strength <= 0.02) return;
    const f = frameOf(t);
    const n = 3 + Math.floor(hash(f) * 5);
    for (let i = 0; i < n; i++) {
      const y = Math.floor(hash(f * 3 + i) * H); const h = 6 + Math.floor(hash(f * 7 + i) * 80 * U * strength);
      const dx = (hash(f * 11 + i) - 0.5) * 200 * U * strength;
      ctx.drawImage(canvas, 0, y, W, h, dx, y, W, h);
    }
  }
  function text(str, x, y, font, color, align = 'left') {
    ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'alphabetic'; ctx.fillText(str, x, y);
  }
  function wrap(words, maxW, measure) {
    const lines = [[]]; let width = 0;
    for (const w of words) {
      const ww = measure(w);
      if (width + ww > maxW && lines[lines.length - 1].length) { lines.push([]); width = 0; }
      lines[lines.length - 1].push(w); width += ww;
    }
    return lines;
  }

  // ---------- words ----------
  const norm = (s) => String(s).toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9']/g, '');
  const songWords = (MV.song?.words || []).filter((w) => Number.isFinite(w?.startSec));
  // Kinetic hero words for a text cue: each word lands on its sung time when
  // the aligned lyric words match, else spread across the cue.
  function heroWordsFor(cue) {
    const tokens = String(cue.text).split(/\s+/).filter(Boolean);
    const pool = songWords.filter((w) => w.startSec >= cue.startSec - 0.35 && w.startSec <= cue.endSec + 0.2);
    const out = []; let j = 0;
    for (const token of tokens) {
      const key = norm(token);
      let hit = null;
      for (let k = j; k < pool.length; k++) {
        const p = norm(pool[k].w);
        if (p === key || (key.length > 3 && p.startsWith(key.slice(0, 4)))) { hit = pool[k]; j = k + 1; break; }
      }
      out.push({ w: token.toUpperCase(), t0: hit ? hit.startSec : null });
    }
    if (out.some((w) => w.t0 == null)) {
      const span = Math.max(0.2, (cue.endSec - cue.startSec) * 0.8);
      out.forEach((w, i) => { w.t0 = cue.startSec + (i * span) / Math.max(1, out.length); });
    }
    return out;
  }
  const CUES = (MV.textCues || []).filter((c) => Number.isFinite(c.startSec) && Number.isFinite(c.endSec) && c.endSec > c.startSec);
  const HERO = CUES.filter((c) => c.emphasis === 'hero').map((c) => ({ ...c, words: heroWordsFor(c) }));
  const SUBTITLE_CUES = CUES.filter((c) => c.emphasis !== 'hero');
  // Subtitles: the director's subtitle cues when there are any, else the lyrics.
  const SUBTITLES = (SUBTITLE_CUES.length ? SUBTITLE_CUES : (MV.lyrics || []))
    .filter((l) => l?.text && Number.isFinite(l.startSec))
    .map((l) => ({ text: l.text, startSec: l.startSec, endSec: Number.isFinite(l.endSec) ? l.endSec : l.startSec + 2.5 }));

  function heroWords(t, cue) {
    const shown = cue.words.filter((w) => t >= w.t0 - 0.02);
    if (!shown.length) return;
    const maxW = W - 180 * U;
    let px = Math.round((W > H ? 150 : 120) * U);
    ctx.font = F.stencil(px);
    const measure = (w) => ctx.measureText(`${w.w} `).width;
    let lines = wrap(cue.words, maxW, measure);
    while (lines.length > 3 && px > 40) { px = Math.round(px * 0.88); ctx.font = F.stencil(px); lines = wrap(cue.words, maxW, measure); }
    const lineH = px * 0.92;
    const baseY = cue.placement === 'upper' ? 220 * U + lineH : cue.placement === 'center' ? H / 2 + lineH / 2 : H - 150 * U;
    const topY = baseY - (lines.length - 1) * lineH;
    const out = seg(t, cue.endSec - 0.12, cue.endSec);
    lines.forEach((line, li) => {
      let x = W > H ? 96 * U : (W - line.reduce((s, w) => s + measure(w), 0)) / 2;
      for (const w of line) {
        const ww = measure(w);
        if (t >= w.t0 - 0.02) {
          const k = seg(t, w.t0 - 0.02, w.t0 + 0.09);
          const sc = lerp(1.35, 1, easeOut(k));
          ctx.save(); ctx.globalAlpha = 1 - out;
          ctx.translate(x, topY + li * lineH); ctx.scale(sc, sc);
          ctx.font = F.stencil(px); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
          if (k < 1) { ctx.fillStyle = C.accent; ctx.fillText(w.w, 6 * U, 0); }
          ctx.fillStyle = C.paper; ctx.fillText(w.w, 0, 0);
          ctx.restore();
        }
        x += ww;
      }
    });
  }
  function subtitle(t, line) {
    const a = Math.min(seg(t, line.startSec, line.startSec + 0.08), 1 - seg(t, line.endSec - 0.08, line.endSec));
    if (a <= 0) return;
    const px = Math.round(44 * U);
    ctx.save(); ctx.globalAlpha = a; ctx.font = F.cond(px, 500);
    const lines = wrap(line.text.split(/\s+/), W - 240 * U, (w) => ctx.measureText(`${w} `).width).map((l) => l.join(' '));
    const lineH = px * 1.3;
    const bottom = H - (W > H ? 150 : 260) * U;
    lines.forEach((str, i) => {
      const y = bottom - (lines.length - 1 - i) * lineH;
      const w = ctx.measureText(str).width;
      ctx.fillStyle = 'rgba(7,9,10,.55)'; ctx.fillRect(W / 2 - w / 2 - 18 * U, y - px, w + 36 * U, px * 1.35);
      text(str, W / 2, y, F.cond(px, 500), C.paper, 'center');
    });
    ctx.restore();
  }

  // ---------- HUD (composition.overlay) ----------
  const HUD = MV.composition?.overlay && MV.composition.overlay.enabled !== false ? MV.composition.overlay : null;
  function interp(keys, t) {
    if (!keys?.length) return null;
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      if (t < keys[i][0]) { const [a, va] = keys[i - 1]; const [b, vb] = keys[i]; return lerp(va, vb, easeInOut(seg(t, a, b))); }
    }
    return keys[keys.length - 1][1];
  }
  function drawHud(t) {
    if (!HUD) return;
    const f = frameOf(t);
    const m = 40 * U; const L = 34 * U; const pad = 64 * U;
    ctx.save();
    ctx.globalAlpha = 0.92 * seg(t, 0.2, 1.2);
    ctx.strokeStyle = C.dim; ctx.lineWidth = Math.max(1, 2 * U);
    [[m, m, 1, 1], [W - m, m, -1, 1], [m, H - m, 1, -1], [W - m, H - m, -1, -1]].forEach(([x, y, sx, sy]) => {
      ctx.beginPath(); ctx.moveTo(x, y + sy * L); ctx.lineTo(x, y); ctx.lineTo(x + sx * L, y); ctx.stroke();
    });
    (HUD.titleLines || []).forEach((line, i) => text(line, pad, pad + 22 * U + i * 26 * U, F.mono(Math.round(19 * U), i === 0 ? 600 : 400), i === 0 ? C.paper : C.dim));
    const recY = pad + 22 * U + (HUD.titleLines?.length || 0) * 26 * U + 8 * U;
    if (f % 24 < 14) { ctx.fillStyle = C.alert; ctx.beginPath(); ctx.arc(pad + 8 * U, recY, 7 * U, 0, Math.PI * 2); ctx.fill(); }
    text('REC', pad + 24 * U, recY + 7 * U, F.mono(Math.round(18 * U), 600), C.paper);
    const pct = interp(HUD.meter?.keyframes, t);
    if (pct != null) {
      const bw = Math.min(360 * U, W * 0.36); const bx = W - pad - bw; const by = pad + 8 * U;
      const color = pct < 25 ? C.alert : pct < 60 ? C.accent : C.ok;
      text(HUD.meter.label || 'LEVEL', bx, by + 14 * U, F.mono(Math.round(18 * U), 600), C.paper);
      text(`${pct.toFixed(0)}%`, W - pad, by + 14 * U, F.mono(Math.round(26 * U), 600), color, 'right');
      ctx.strokeStyle = C.dim; ctx.strokeRect(bx, by + 28 * U, bw, 14 * U);
      ctx.fillStyle = color;
      const segs = 30; const sw = (bw - 6 * U) / segs;
      for (let i = 0; i < segs; i++) if (i / segs < pct / 100) ctx.fillRect(bx + 3 * U + i * sw, by + 31 * U, sw * 0.75, 8 * U);
    }
    if (HUD.timecode !== false) {
      const sec = (HUD.timecodeStartSec || 0) + t;
      const pad2 = (n) => String(n).padStart(2, '0');
      const tc = `${pad2(Math.floor(sec / 3600))}:${pad2(Math.floor(sec / 60) % 60)}:${pad2(Math.floor(sec) % 60)}:${pad2(f % FPS)}`;
      text(tc, W - pad, H - pad, F.mono(Math.round(19 * U)), C.dim, 'right');
    }
    ctx.fillStyle = C.faint;
    for (let i = 0; i < 18; i++) ctx.fillRect(m, H * 0.2 + i * 36 * U, i % 4 === 0 ? 22 * U : 11 * U, Math.max(1, 2 * U));
    const ticker = HUD.ticker || [];
    if (ticker.length) {
      const sep = '   ◆   ';
      const str = ticker.join(sep);
      ctx.font = F.mono(Math.round(17 * U));
      const full = ctx.measureText(str + sep).width;
      const off = (t * 120 * U) % full;
      const width = W - 2 * pad - (HUD.timecode !== false ? 340 * U : 0);
      ctx.save(); ctx.beginPath(); ctx.rect(pad, H - pad - 32 * U, width, 30 * U); ctx.clip();
      ctx.fillStyle = C.dim; ctx.textAlign = 'left'; ctx.fillText(str + sep + str, pad - off, H - pad - 8 * U);
      ctx.restore();
      ctx.fillStyle = C.faint; ctx.fillRect(pad, H - pad - 36 * U, W - 2 * pad, 1);
    }
    ctx.restore();
  }

  // ---------- cards (add project-specific ones here) ----------
  // A card draws the whole scene layer: (t, localT, durationSec, scene, source).
  const CARDS = {
    // A title card from the scene's card text on its card colour.
    title(t, lt, d, scene, source, state) {
      ctx.fillStyle = scene.cardColor || C.ink; ctx.fillRect(0, 0, W, H);
      const str = (scene.cardText || scene.label || '').toUpperCase();
      if (!str) return;
      let px = Math.round(220 * U);
      ctx.font = F.stencil(px);
      while (ctx.measureText(str).width > W - 160 * U && px > 40) { px = Math.round(px * 0.9); ctx.font = F.stencil(px); }
      const k = easeOut(seg(lt, 0, 0.25));
      ctx.save(); ctx.globalAlpha = k * (1 - seg(lt, d - 0.2, d));
      ctx.translate(W / 2, H / 2 + px * 0.36); ctx.scale(lerp(1.2, 1, k), lerp(1.2, 1, k));
      text(str, 0, 0, F.stencil(px), C.paper, 'center');
      ctx.restore();
      glitch(t, pulse(t, downs, 9) * state.reactiveGain);
    },
  };
  const cardFor = (scene) => (scene?.visualLayer === 'card' ? CARDS.title : null);

  function sectionFunction(t) {
    const section = GENERATED?.song?.sections?.find((item) => t >= item.startSec && t < item.endSec);
    return section ? { section, fn: GENERATED.sections?.[section.id] } : null;
  }

  // ---------- frame ----------
  function drawNarrativeEvents(state) {
    for (const event of state.activeEvents) {
      const k = event.progress;
      const label = event.kind === 'counter-change' ? `${event.text || event.name} ${Math.round(event.value)}`
        : event.kind === 'motif-transformation' ? `${event.motif || event.name}: ${k < 0.5 ? event.before || 'Before' : event.after || 'After'}`
          : event.text || event.name;
      let px = Math.round(96 * U);
      ctx.font = F.cond(px, 700);
      while (ctx.measureText(label).width > W * 0.8 && px > 12 * U) { px *= 0.9; ctx.font = F.cond(px, 700); }
      ctx.save();
      ctx.globalAlpha = event.kind === 'reveal' ? easeOut(clamp(k * 4)) : 1;
      ctx.translate(W / 2, H / 2);
      const scale = event.kind === 'impact' ? 1 + 0.2 * (1 - easeOut(clamp(k * 4))) : 1;
      ctx.scale(scale, scale);
      text(label, 0, px * 0.3, F.cond(px, 700), C.paper, 'center');
      ctx.restore();
    }
  }

  // A view of ctx for authored code drawn over footage: a fillRect or clearRect whose
  // on-canvas area (after the current transform, clipped to the frame) covers most of it is
  // limited to a translucent wash (clears are dropped), and the 'copy' composite mode, which
  // replaces every pixel, is refused. Path fills, drawImage and combined small shapes are checked separately by
  // the pixel visibility evidence; this fast guard only handles rectangles.
  const FOOTAGE_WASH_ALPHA = 0.25;
  function footageOverlayContext(target) {
    const covers = (x, y, w, h) => {
      const m = typeof target.getTransform === 'function' ? target.getTransform() : null;
      const map = (px, py) => (m ? [m.a * px + m.c * py + m.e, m.b * px + m.d * py + m.f] : [px, py]);
      const pts = [map(x, y), map(x + w, y), map(x, y + h), map(x + w, y + h)];
      const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
      const cw = Math.max(0, Math.min(W, Math.max(...xs)) - Math.max(0, Math.min(...xs)));
      const ch = Math.max(0, Math.min(H, Math.max(...ys)) - Math.max(0, Math.min(...ys)));
      return cw * ch >= W * H * 0.45;
    };
    return new Proxy(target, {
      get(obj, prop) {
        if (prop === 'fillRect') {
          return (x, y, w, h) => {
            if (!covers(x, y, w, h)) return obj.fillRect(x, y, w, h);
            const alpha = obj.globalAlpha;
            obj.globalAlpha = Math.min(alpha, FOOTAGE_WASH_ALPHA);
            obj.fillRect(x, y, w, h);
            obj.globalAlpha = alpha;
          };
        }
        if (prop === 'clearRect') return (x, y, w, h) => { if (!covers(x, y, w, h)) obj.clearRect(x, y, w, h); };
        const value = Reflect.get(obj, prop, obj);
        return typeof value === 'function' ? value.bind(obj) : value;
      },
      set(obj, prop, value) {
        if (prop === 'globalCompositeOperation' && value === 'copy') return true;
        return Reflect.set(obj, prop, value, obj);
      },
    });
  }

  // Compare the same camera-transformed footage before and after composition.
  // Local covariance tolerates color offsets/translucent washes; an opaque panel
  // loses the source's local variation. Flat source tiles are unknown, never hidden.
  function compareFootagePixels(before, after, width, height) {
    let visible = 0; let hidden = 0; let total = 0;
    for (let y = 0; y < height; y += 8) for (let x = 0; x < width; x += 8) {
      let count = 0; let sumA = 0; let sumB = 0; let sumAA = 0; let sumAB = 0;
      // Separate channel means so a flat colored clip doesn't masquerade as texture.
      let variance = 0; let covariance = 0;
      for (let channel = 0; channel < 3; channel++) {
        count = 0; sumA = 0; sumB = 0; sumAA = 0; sumAB = 0;
        for (let py = y; py < Math.min(height, y + 8); py++) for (let px = x; px < Math.min(width, x + 8); px++) {
          const offset = (py * width + px) * 4 + channel;
          const a = before[offset]; const b = after[offset];
          count++; sumA += a; sumB += b; sumAA += a * a; sumAB += a * b;
        }
        variance += sumAA - sumA * sumA / count;
        covariance += sumAB - sumA * sumB / count;
      }
      const pixels = count;
      total += pixels;
      if (variance / (pixels * 3) < 16) continue;
      if (covariance / variance >= 0.5) visible += pixels;
      else hidden += pixels;
    }
    return { visibleFraction: visible / total, hiddenFraction: hidden / total, measuredFraction: (visible + hidden) / total };
  }
  const visibilityCanvas = document.createElement('canvas');
  visibilityCanvas.width = 160; visibilityCanvas.height = 96;
  const visibilityContext = visibilityCanvas.getContext('2d', { willReadFrequently: true });
  const footagePixels = () => {
    visibilityContext.drawImage(canvas, 0, 0, 160, 96);
    return visibilityContext.getImageData(0, 0, 160, 96).data;
  };
  let footageVisibility = null;

  function render(t, scene, source, state, reviewFootage = false) {
    ctx.fillStyle = C.ink; ctx.fillRect(0, 0, W, H);
    const authored = sectionFunction(t);
    if (scene) {
      const lt = t - scene.startSec; const d = scene.endSec - scene.startSec;
      const card = authored?.fn ? null : cardFor(scene);
      if (card) card(t, lt, d, scene, source, state);
      else if (source) {
        const energetic = isHighEnergy(t) || scene.shotMode === 'performance';
        const punch = 1 + 0.018 * pulse(t, energetic ? beats : downs, 8) * state.reactiveGain;
        drawCover(source, seg(t, scene.startSec, scene.endSec), moveFor(scene), punch);
      }
      if (isHighEnergy(t)) glitch(t, pulse(t, downs, 8) * state.reactiveGain);
    }
    const before = reviewFootage && source ? footagePixels() : null;
    if (authored?.fn) {
      const inset = 0.1;
      ctx.save();
      try {
        // Over footage or a still, the authored code is an overlay: a full-canvas fill
        // becomes a translucent wash so the selected media stays visible.
        authored.fn(source ? footageOverlayContext(ctx) : ctx, {
          t, localT: t - authored.section.startSec, frame: frameOf(t), width: W, height: H,
          song: GENERATED.song, palette: GENERATED.palette, section: authored.section,
          safe: { x: W * inset, y: H * inset, w: W * (1 - 2 * inset), h: H * (1 - 2 * inset) },
          karaoke: [], mediaKind: scene?.media?.kind || null, visualLayer: scene?.visualLayer || null,
          events: state.activeEvents, reactiveGain: state.reactiveGain, hold: state.hold,
        });
      } finally { ctx.restore(); }
    }
    vignette(0.5);
    grain(t, 0.09);
    drawHud(t);
    drawNarrativeEvents(state);
    const hero = HERO.find((c) => t >= c.startSec && t < c.endSec);
    if (hero) heroWords(t, hero);
    else {
      const line = SUBTITLES.find((l) => t >= l.startSec && t < l.endSec);
      if (line) subtitle(t, line);
    }
    footageVisibility = before ? { sceneId: scene.sceneId, ...compareFootagePixels(before, footagePixels(), 160, 96) } : null;
  }

  // ---------- contract ----------
  const ready = (async () => {
    if (window.PORTOS_MV_ASSETS) assetUrls = await window.PORTOS_MV_ASSETS;
    await Promise.all([F.stencil(40), F.mono(20), F.mono(20, 600), F.cond(20), F.cond(20, 700)].map((font) => document.fonts.load(font)));
    buildGrain();
  })();
  globalThis.portosComposition = {
    durationSec: DURATION,
    fps: FPS,
    width: W,
    height: H,
    // One timeline, every aspect: the layout hook reframes before capture.
    formats: ['1920x1080', '1080x1920', '1080x1080'],
    layout({ width, height }) { resize(width, height); },
    get footageVisibility() { return footageVisibility; },
    async seek(t, { reviewFootage = false } = {}) {
      await ready;
      const state = eventState(t);
      t = state.t;
      const scene = sceneAt(t);
      const source = scene && !cardFor(scene) ? await sourceFor(scene, t) : null;
      render(t, scene, source, state, reviewFootage);
      return true;
    },
  };
})();
