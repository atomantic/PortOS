import { documentCameraView } from '../../../../server/lib/musicVideoDocumentCamera.js';
import { narrativeFrameState } from '../../../../server/lib/musicVideoNarrativeEvents.js';
import { imageEffectState, IMAGE_EFFECT_FOG_COLOR } from '../../lib/musicVideoImageEffects.js';

// The template's inline canvas painters have no importable module. Keep their
// drawing order and pixels pinned against the unchanged shipped engine in
// documentTemplateParity.browser.test.js. Paths, timing and effect curves use
// the engine's shared modules rather than a second implementation.
export function createDocumentTemplateDrawing(canvas, data, rig) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height, FPS = data.render.fps;
  const U = Math.min(W, H) / 1080;
  const MV = data;
  const style = data.composition?.style || {};
  const C = { ink: '#07090a', paper: style.color || '#eef1ea', dim: 'rgba(238,241,234,.62)', faint: 'rgba(238,241,234,.28)', accent: '#ff5a1f', ok: '#b8d63a', alert: '#ff2a2a' };
  const F = { stencil: px => `900 ${px}px "MV Stencil", Impact, sans-serif`, mono: (px, w = 400) => `${w} ${px}px "MV Mono", Menlo, monospace` };
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, k) => a + (b - a) * k;
  const seg = (t, a, b) => b > a ? clamp((t - a) / (b - a)) : t >= b ? 1 : 0;
  const easeOut = k => 1 - Math.pow(1 - k, 3);
  const easeInOut = k => k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
  const hash = n => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  const frameOf = t => Math.floor(t * FPS + 1e-6);
  const beats = (data.song.beats || []).filter(Number.isFinite);
  const downs = (data.song.downbeats || []).filter(Number.isFinite);
  const sections = data.song.sections || [];
  const pulse = (t, list, k) => {
    let lo = 0, hi = list.length - 1, last = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (list[m] <= t) { last = m; lo = m + 1; } else hi = m - 1; }
    return Math.exp(-k * (last < 0 ? 99 : t - list[last]));
  };
  const isHighEnergy = t => /chorus|hook|drop|final|climax/i.test(sections.filter(s => s.startSec <= t).at(-1)?.label || '');
  const state = t => narrativeFrameState({ ...data.song, sections: data.song.narrativeSections || sections }, t, FPS);
  function drawCover(src, view, punch) {
    const sw = src.videoWidth || src.naturalWidth || src.width, sh = src.videoHeight || src.naturalHeight || src.height;
    if (!sw || !sh) return;
    const base = Math.max(W / sw, H / sh) * view.scale * punch;
    const dw = sw * base, dh = sh * base;
    if (!view.rotation) { ctx.drawImage(src, (W - dw) / 2 + view.x * W, (H - dh) / 2 + view.y * H, dw, dh); return; }
    ctx.save(); ctx.translate(W / 2 + view.x * W, H / 2 + view.y * H); ctx.rotate(view.rotation);
    ctx.drawImage(src, -dw / 2, -dh / 2, dw, dh); ctx.restore();
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


  const CARDS = {
    // A title card from the scene's card text on its card colour.
    title(t, lt, d, scene, _source, state) {
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


  buildGrain();
  return {
    state,
    scene(t, scene, source, { index = 0, footage = false, effect = null, end = null, filter = null } = {}) {
      const s = state(t); t = s.t;
      ctx.fillStyle = C.ink; ctx.fillRect(0, 0, W, H);
      if (!scene) return null;
      const card = cardFor(scene);
      const fx = !footage && source && effect ? imageEffectState(effect, (frameOf(t) - Math.round(scene.startSec * FPS)) / FPS, { fps: FPS }) : null;
      if (card) card(t, t - scene.startSec, scene.endSec - scene.startSec, scene, source, s);
      else if (source) {
        const energetic = isHighEnergy(t) || scene.shotMode === 'performance';
        const punch = 1 + 0.018 * pulse(t, energetic ? beats : downs, 8) * s.reactiveGain;
        const view = documentCameraView(rig, scene, t, { footage, index, aspect: W / H, beats, downbeats: downs });
        ctx.save();
        const filters = [filter, fx ? `contrast(${fx.contrast}) saturate(${fx.saturation})` : null].filter(Boolean);
        if (filters.length) ctx.filter = filters.join(' ');
        drawCover(source, view, punch);
        if (fx?.end > 0 && end) { ctx.globalAlpha = fx.end; drawCover(end, view, punch); }
        ctx.restore();
        if (fx) _flash(fx.fog, IMAGE_EFFECT_FOG_COLOR);
      }
      if (isHighEnergy(t)) glitch(t, pulse(t, downs, 8) * s.reactiveGain);
      return fx;
    },
    finish(t, effect) { vignette(0.5); grain(t, 0.09); if (effect) _flash(effect.flash); },
    hud: drawHud,
  };
}
