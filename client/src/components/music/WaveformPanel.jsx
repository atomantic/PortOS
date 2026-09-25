/**
 * WaveformPanel — the Music Designer's "Drawn waveform" engine.
 *
 * Instead of prompting an audio model (MusicGenPanel) or writing a score, the
 * chosen AI provider PAINTS the music on a stereo spectrogram canvas (#8464,
 * server/lib/paintedCanvas.js): strokes of pitch, level, overtones, noise
 * bands and pan over time. The panel shows the painting as a spectrogram and
 * the resulting waveform, and plays it straight from the browser with the
 * same deterministic synth the server uses to save it as a take, so what you
 * hear is exactly what gets saved. Tracks drawn before #8464 hold a v1 sketch
 * (single-cycle shapes played as strokes, server/lib/waveSketch.js), which
 * still shows, plays and saves as before but is repainted rather than revised.
 *
 * The LLM call fires only from the Paint/Revise buttons (no cold-bootstrap LLM
 * calls). Every painting is stored on the track (`waveSketch`, #8376), so it
 * survives reloads, syncs to the user's other machines, and reopens for
 * revision from either host: the Music Designer's drawn engine (which passes
 * only `trackId`, so the panel loads the track) or the Tracks editor's "Drawn
 * waveform" mode (which passes the loaded `track`). Saving renders the stored
 * drawing into the track's render history.
 */

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Brush, Loader2, Play, Save, Square, Wand2 } from 'lucide-react';
import toast from '../ui/Toast';
import useMounted from '../../hooks/useMounted';
import useAudioSessionClaim from '../../hooks/useAudioSessionClaim';
import { createWaveSketchPlayer } from '../../lib/waveSketchPlayback.js';
import { safeRemoveStorage } from '../../lib/safeStorage.js';
import { clamp, formatTimecode } from '../../utils/formatters';
import { FIELD_CLASS, GHOST_BTN, LABEL_CLASS, PRIMARY_BTN } from './designerStyles';
import { drawTrackWaveform, getTrack, renderTrackWaveform } from '../../services/api';
import {
  isPaintedCanvas, normalizeWaveSketch, pcmPeaks, synthesizeSketchChannels,
} from '../../../../server/lib/waveSketch.js';
import { PAINTED_CANVAS_LIMITS, paintedCanvasStats } from '../../../../server/lib/paintedCanvas.js';

// Before #8376 the latest drawing lived only in this per-viewer key; the track
// is now the store, so the stale key is just cleared.
const LEGACY_SKETCH_KEY = 'portos.musicDesigner.waveSketch';
const DEFAULT_LENGTH_SEC = 20;
const MIN_LENGTH_SEC = 4;
const PEAK_COLUMNS = 600;
const LANE_HEIGHT = 14;
const CANVAS_HEIGHT = 224;
const LOG_SPAN = Math.log(PAINTED_CANVAS_LIMITS.HZ_MAX / PAINTED_CANVAS_LIMITS.HZ_MIN);
const FREQ_GUIDES = [100, 1000, 10000];
// Theme tokens (RGB triplets), so the drawing follows the active PortOS theme.
const VOICE_COLORS = ['rgb(var(--port-accent))', 'rgb(var(--port-accent-2))', 'rgb(var(--port-success))', 'rgb(var(--port-warning))', 'rgb(var(--port-error))', 'rgb(var(--port-text-muted))'];
const voiceColor = (index) => VOICE_COLORS[index % VOICE_COLORS.length];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One drawn cycle, shown twice so the loop seam is visible. */
function ShapeDrawing({ name, points, color, usedBy }) {
  const cycle = [...points, points[0]];
  const coords = [...cycle, ...cycle.slice(1)].map((p, i, all) => `${((i / (all.length - 1)) * 100).toFixed(2)},${(20 - p * 17).toFixed(2)}`).join(' ');
  return (
    <figure className="rounded border border-port-border bg-port-bg p-2">
      <svg viewBox="0 0 100 40" className="h-16 w-full" preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" y1="20" x2="100" y2="20" stroke="rgb(var(--port-border))" strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
        <line x1="50" y1="0" x2="50" y2="40" stroke="rgb(var(--port-border))" vectorEffect="non-scaling-stroke" />
        <polyline points={coords} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption className="mt-1 truncate text-xs text-gray-400">
        <span className="text-gray-200">{name}</span>
        {' · '}{points.length} pts{usedBy.length ? ` · ${usedBy.join(', ')}` : ''}
      </figcaption>
    </figure>
  );
}

const themeColor = (name, alpha) => {
  const rgb = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '128 128 128';
  return `rgb(${rgb} / ${alpha})`;
};

/**
 * Paint the canvas onto a <canvas> as a spectrogram: time → x, log frequency
 * → y. Tonal strokes draw every partial segment by segment (so a colour
 * change along a stroke shows), noise strokes fill their band, and passage
 * boundaries are dashed.
 */
function paintSpectrogram(el, canvas) {
  const ctx = el.getContext?.('2d');
  if (!ctx) return;
  const ratio = window.devicePixelRatio || 1;
  const width = el.clientWidth || 600;
  const height = CANVAS_HEIGHT;
  el.width = Math.round(width * ratio);
  el.height = Math.round(height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const x = (t) => (t / canvas.durationSec) * width;
  const y = (hz) => height * (1 - Math.log(Math.max(PAINTED_CANVAS_LIMITS.HZ_MIN, hz) / PAINTED_CANVAS_LIMITS.HZ_MIN) / LOG_SPAN);

  ctx.lineWidth = 1;
  ctx.strokeStyle = themeColor('--port-border', 0.8);
  ctx.fillStyle = themeColor('--port-text-muted', 0.9);
  ctx.font = '10px sans-serif';
  for (const hz of FREQ_GUIDES) {
    ctx.beginPath(); ctx.moveTo(0, y(hz)); ctx.lineTo(width, y(hz)); ctx.stroke();
    ctx.fillText(hz >= 1000 ? `${hz / 1000}k` : String(hz), 2, y(hz) - 2);
  }
  ctx.setLineDash([3, 3]);
  for (const section of canvas.sections?.slice(1) ?? []) {
    ctx.beginPath(); ctx.moveTo(x(section.start), 0); ctx.lineTo(x(section.start), height); ctx.stroke();
  }
  ctx.setLineDash([]);

  const tone = themeColor('--port-accent', 1);
  const noise = themeColor('--port-accent-2', 1);
  for (const stroke of canvas.strokes) {
    const { path } = stroke;
    if (stroke.width) {
      ctx.fillStyle = noise;
      for (let k = 0; k < path.length - 1; k += 1) {
        const [a, b] = [path[k], path[k + 1]];
        const half = stroke.width / 2;
        ctx.globalAlpha = Math.min(0.7, 0.08 + Math.max(a.a, b.a) * 0.5);
        ctx.beginPath();
        ctx.moveTo(x(a.t), y(a.hz + half)); ctx.lineTo(x(b.t), y(b.hz + half));
        ctx.lineTo(x(b.t), y(b.hz - half)); ctx.lineTo(x(a.t), y(a.hz - half));
        ctx.closePath(); ctx.fill();
      }
      continue;
    }
    ctx.strokeStyle = tone;
    let colour = stroke.overtones ?? [];
    for (let k = 0; k < path.length - 1; k += 1) {
      const [a, b] = [path[k], path[k + 1]];
      if (a.overtones) colour = a.overtones;
      const next = b.overtones ?? colour;
      const partials = 1 + Math.max(colour.length, next.length);
      for (let p = 0; p < partials; p += 1) {
        const level = Math.max(a.a * (p ? colour[p - 1] ?? 0 : 1), b.a * (p ? next[p - 1] ?? 0 : 1));
        if (level <= 0 || a.hz * (p + 1) > PAINTED_CANVAS_LIMITS.HZ_MAX) continue;
        ctx.globalAlpha = Math.min(1, 0.15 + level);
        ctx.lineWidth = 0.75 + level * 2.5;
        ctx.beginPath(); ctx.moveTo(x(a.t), y(a.hz * (p + 1))); ctx.lineTo(x(b.t), y(b.hz * (p + 1))); ctx.stroke();
      }
    }
  }
  ctx.globalAlpha = 1;
}

/**
 * A v2 painting: the canvas as a spectrogram, the rendered waveform, and a
 * one-line summary. Memoized on the canvas like SketchDrawing.
 */
const CanvasPainting = memo(function CanvasPainting({ canvas, peaksPath, playheadRef }) {
  const canvasRef = useRef(null);
  const stats = useMemo(() => paintedCanvasStats(canvas), [canvas]);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return undefined;
    paintSpectrogram(el, canvas);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => paintSpectrogram(el, canvas)) : null;
    observer?.observe(el);
    return () => observer?.disconnect();
  }, [canvas]);
  const passages = canvas.sections?.length || 1;
  return (
    <>
      <div className="text-xs text-gray-400" data-testid="waveform-canvas-summary">
        <span className="text-white">{canvas.title || 'Untitled painting'}</span>
        {' — '}{canvas.durationSec}s · {plural(stats.strokes, 'stroke')}
        {stats.noise ? ` (${stats.noise} noise)` : ''} · {plural(stats.keyframes, 'keyframe')} · {plural(passages, 'passage')}
        {canvas.bpm ? ` · ${canvas.bpm} BPM` : ''}
      </div>
      <div className="rounded border border-port-border bg-port-bg p-2">
        <div className="relative">
          <canvas ref={canvasRef} className="block w-full" style={{ height: `${CANVAS_HEIGHT}px` }} role="img" aria-label={`Spectrogram of the painting: ${plural(stats.strokes, 'stroke')} over ${canvas.durationSec} seconds`} />
          <svg viewBox={`0 0 ${PEAK_COLUMNS} 100`} className="mt-2 h-16 w-full" preserveAspectRatio="none" aria-hidden="true">
            <line x1="0" y1="50" x2={PEAK_COLUMNS} y2="50" stroke="rgb(var(--port-border))" vectorEffect="non-scaling-stroke" />
            <path d={peaksPath} stroke="rgb(var(--port-accent))" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          </svg>
          <div ref={playheadRef} className="pointer-events-none absolute inset-y-0 w-0.5 bg-port-text" style={{ left: '0%' }} aria-hidden="true" />
        </div>
      </div>
    </>
  );
});

/**
 * A v1 drawing: every shape, the rendered waveform (with the drawn
 * contour), the per-voice stroke map, and a legend. Memoized on the sketch so
 * typing in the panel's inputs doesn't rebuild hundreds of SVG nodes.
 */
const SketchDrawing = memo(function SketchDrawing({ sketch, peaksPath, playheadRef }) {
  const noteCount = sketch.voices.reduce((sum, v) => sum + v.notes.length, 0);
  // Each shape is coloured after the first voice that plays it.
  const shapes = Object.entries(sketch.shapes).map(([name, points]) => {
    const users = sketch.voices.filter((v) => v.shape === name);
    return {
      name,
      points,
      color: voiceColor(Math.max(0, sketch.voices.indexOf(users[0]))),
      usedBy: users.map((v) => v.name),
    };
  });
  return (
    <>
      <div className="text-xs text-gray-400">
        <span className="text-white">{sketch.title || 'Untitled drawing'}</span>
        {' — '}{sketch.durationSec}s · {plural(shapes.length, 'drawn shape')} · {plural(sketch.voices.length, 'voice')} · {plural(noteCount, 'stroke')}
      </div>

      {shapes.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4" data-testid="waveform-shapes">
          {shapes.map((shape) => <ShapeDrawing key={shape.name} {...shape} />)}
        </div>
      )}

      <div className="rounded border border-port-border bg-port-bg p-2">
        <div className="relative">
          <svg viewBox={`0 0 ${PEAK_COLUMNS} 100`} className="h-28 w-full" preserveAspectRatio="none" aria-hidden="true">
            <line x1="0" y1="50" x2={PEAK_COLUMNS} y2="50" stroke="rgb(var(--port-border))" vectorEffect="non-scaling-stroke" />
            <path d={peaksPath} stroke="rgb(var(--port-accent))" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            {sketch.contour && (
              <polyline
                points={sketch.contour.map((c, i, all) => `${(i / (all.length - 1)) * PEAK_COLUMNS},${100 - c * 96}`).join(' ')}
                fill="none"
                stroke="rgb(var(--port-text-muted))"
                strokeDasharray="4 3"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
          <svg
            viewBox={`0 0 1000 ${sketch.voices.length * LANE_HEIGHT}`}
            className="mt-2 w-full"
            style={{ height: `${sketch.voices.length * 12}px` }}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {sketch.voices.map((voice, lane) => voice.notes.map((note, i) => (
              <rect
                key={`${lane}-${i}`}
                x={(note.t / sketch.durationSec) * 1000}
                y={lane * LANE_HEIGHT + 2}
                width={Math.max(1.5, (note.d / sketch.durationSec) * 1000)}
                height={LANE_HEIGHT - 4}
                fill={voiceColor(lane)}
                opacity={0.35 + note.v * 0.65}
              />
            )))}
          </svg>
          <div ref={playheadRef} className="pointer-events-none absolute inset-y-0 w-0.5 bg-port-text" style={{ left: '0%' }} aria-hidden="true" />
        </div>
      </div>

      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-400">
        {sketch.voices.map((voice, lane) => (
          <li key={`${voice.name}-${lane}`} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: voiceColor(lane) }} aria-hidden="true" />
            {voice.name} <span className="text-gray-500">({voice.shape}, {voice.notes.length})</span>
          </li>
        ))}
      </ul>
    </>
  );
});

export default function WaveformPanel({
  trackId, track, disabled = false, description = '', lyrics = '', title = '',
  providerId, model, effort, providerPicker, onRendered, onTrackUpdate,
}) {
  const mountedRef = useMounted();
  // Seeded from the host's track once; hosts key the panel by track id.
  const [sketch, setSketch] = useState(() => normalizeWaveSketch(track?.waveSketch));
  const [guidance, setGuidance] = useState('');
  // Raw field text — clamped only when used, so typing "12" isn't snapped to
  // the minimum after its first digit.
  const [lengthInput, setLengthInput] = useState(String(DEFAULT_LENGTH_SEC));
  const [review, setReview] = useState(false);
  const [drawing, setDrawing] = useState(null); // 'fresh' | 'revise' | null
  const [saving, setSaving] = useState(false);
  const [playing, setPlaying] = useState(false);
  const { claim, release } = useAudioSessionClaim('playback');
  const playerRef = useRef(null);
  const playheadRef = useRef(null);
  const elapsedRef = useRef(null);

  const painted = isPaintedCanvas(sketch);
  // Channels: [mono] for a v1 drawing, [left, right] for a painting.
  const pcm = useMemo(() => (sketch ? synthesizeSketchChannels(sketch) : null), [sketch]);
  const peaksPath = useMemo(() => (pcm
    ? pcmPeaks(pcm.length === 1 ? pcm[0] : pcm[0].map((v, i) => (v + pcm[1][i]) / 2), PEAK_COLUMNS).map(([min, max], x) => `M${x + 0.5} ${(50 - max * 48).toFixed(1)}V${(50 - min * 48 + 0.5).toFixed(1)}`).join('')
    : ''), [pcm]);

  // The Music Designer passes only the draft's id: load its stored drawing
  // (unless a draw already landed first).
  useEffect(() => {
    safeRemoveStorage(LEGACY_SKETCH_KEY);
    if (track || !trackId) return undefined;
    let cancelled = false;
    getTrack(trackId, { silent: true }).then((loaded) => {
      const stored = normalizeWaveSketch(loaded?.waveSketch);
      if (stored && !cancelled) setSketch((current) => current ?? stored);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [trackId, track]);

  const stop = () => {
    playerRef.current?.stop();
    release();
    if (mountedRef.current) setPlaying(false);
  };

  // Stop the previous drawing before the new Play button can be used. A
  // deferred passive cleanup can otherwise cancel a play clicked immediately
  // after drawing finishes.
  useLayoutEffect(() => stop, [sketch]);

  const play = async () => {
    if (!pcm) return;
    stop();
    playerRef.current ??= createWaveSketchPlayer({
      onEnded: () => { release(); if (mountedRef.current) setPlaying(false); },
    });
    claim();
    const started = await playerRef.current.play(pcm).catch((err) => {
      console.error(`〰️ Waveform preview failed to start: ${err.message}`);
      return false;
    });
    if (!started || !mountedRef.current) { playerRef.current.stop(); release(); return; }
    setPlaying(true);
  };

  // Playhead painted straight into the DOM at frame rate (ChiptunePanel's
  // pattern) rather than re-rendering the drawing 60x a second.
  useEffect(() => {
    const paint = (sec) => {
      const fraction = sketch ? Math.min(1, sec / sketch.durationSec) : 0;
      if (playheadRef.current) playheadRef.current.style.left = `${fraction * 100}%`;
      if (elapsedRef.current) elapsedRef.current.textContent = formatTimecode(sec);
    };
    if (!playing) { paint(0); return undefined; }
    let raf = 0;
    const loop = () => {
      paint(playerRef.current?.position() ?? 0);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, sketch]);

  const draw = async (mode) => {
    if (!description.trim()) { toast.error('Write the musical description first'); return; }
    if (!trackId) return;
    setDrawing(mode);
    const res = await drawTrackWaveform(trackId, {
      description: description.trim(),
      lyrics: lyrics.trim() || undefined,
      guidance: guidance.trim() || undefined,
      durationSec: clamp(Number(lengthInput) || DEFAULT_LENGTH_SEC, MIN_LENGTH_SEC, PAINTED_CANVAS_LIMITS.DURATION_MAX_SEC),
      ...(mode === 'revise' ? { revise: true } : {}),
      ...(review ? { review: true } : {}),
      providerId: providerId || undefined,
      model: model || undefined,
      effort: effort || undefined,
    }, { silent: true }).catch((err) => { toast.error(err?.message || 'Could not paint the music'); return null; });
    if (!mountedRef.current) return;
    setDrawing(null);
    if (!res?.sketch) return;
    setSketch(res.sketch);
    if (res.track) onTrackUpdate?.(res.track);
  };

  const save = async () => {
    if (!sketch || !trackId) return;
    setSaving(true);
    const res = await renderTrackWaveform(trackId, {
      prompt: description.trim() || undefined,
      title: title.trim() || sketch.title || undefined,
    }, { silent: true }).catch((err) => { toast.error(err?.message || 'Could not save the take'); return null; });
    if (!mountedRef.current) return;
    setSaving(false);
    if (!res?.track) return;
    toast.success(`Saved the ${painted ? 'painted' : 'drawn'} take (${res.durationSec}s)`);
    onRendered?.(res.track);
  };

  const busy = !!drawing || saving;

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-400">
        No audio model — the AI paints the sound itself on a stereo spectrogram: every stroke is a pitch, a level, a set of overtones or a band of noise moving through time. Long pieces are painted passage by passage. Preview it here, then save it as a take.
      </p>

      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <label htmlFor="music-waveform-guidance" className="block">
          <span className={LABEL_CLASS}>Painting guidance (optional)</span>
          <input
            id="music-waveform-guidance"
            value={guidance}
            onChange={(event) => setGuidance(event.target.value)}
            disabled={disabled}
            maxLength={4000}
            placeholder={painted ? 'More air in the chorus, a wider stereo field…' : 'Anything the brief leaves out — texture, space, motion…'}
            className={FIELD_CLASS}
          />
        </label>
        <label htmlFor="music-waveform-length" className="block">
          <span className={LABEL_CLASS}>Length (sec)</span>
          <input
            id="music-waveform-length"
            type="number"
            min={MIN_LENGTH_SEC}
            max={PAINTED_CANVAS_LIMITS.DURATION_MAX_SEC}
            value={lengthInput}
            onChange={(event) => setLengthInput(event.target.value)}
            disabled={disabled}
            className={`${FIELD_CLASS} sm:w-28`}
          />
        </label>
      </div>

      <div className="rounded border border-port-border bg-port-bg/60 p-3">
        <span className={LABEL_CLASS}>AI provider</span>
        {providerPicker}
      </div>

      <label htmlFor="music-waveform-review" className="flex items-start gap-2 text-sm text-gray-300">
        <input
          id="music-waveform-review"
          type="checkbox"
          checked={review}
          onChange={(event) => setReview(event.target.checked)}
          disabled={disabled}
          className="mt-0.5"
        />
        <span>
          Look and repaint
          <span className="block text-xs text-gray-500">Shows the AI a spectrogram of each painted passage for one more pass. Needs a provider that reads images; roughly doubles the calls.</span>
        </span>
      </label>

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => draw('fresh')} disabled={disabled || busy || !trackId || !description.trim()} className={sketch ? GHOST_BTN : PRIMARY_BTN}>
          {drawing === 'fresh' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Brush className="h-4 w-4" />}
          <span>{drawing === 'fresh' ? 'Painting…' : sketch ? 'Paint from scratch' : 'Paint it'}</span>
        </button>
        {painted && (
          <button type="button" onClick={() => draw('revise')} disabled={disabled || busy || !trackId || !description.trim()} className={PRIMARY_BTN}>
            {drawing === 'revise' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
            <span>{drawing === 'revise' ? 'Revising…' : 'Revise painting'}</span>
          </button>
        )}
      </div>

      {sketch ? (
        <div className="space-y-3 border-t border-port-border pt-3">
          {painted
            ? <CanvasPainting canvas={sketch} peaksPath={peaksPath} playheadRef={playheadRef} />
            : <SketchDrawing sketch={sketch} peaksPath={peaksPath} playheadRef={playheadRef} />}

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={playing ? stop : play} className={GHOST_BTN}>
              {playing ? <Square className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              <span>{playing ? 'Stop' : painted ? 'Play painting' : 'Play drawing'}</span>
            </button>
            <button type="button" onClick={save} disabled={disabled || busy || !trackId} className={PRIMARY_BTN}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              <span>{saving ? 'Saving…' : 'Save as take'}</span>
            </button>
            <span className="text-xs font-mono tabular-nums text-gray-500">
              <span ref={elapsedRef}>{formatTimecode(0)}</span>{' / '}{formatTimecode(sketch.durationSec)}
            </span>
          </div>
        </div>
      ) : (
        <p className="text-xs text-gray-500">
          Nothing painted yet. The painting uses the description and lyrics from the earlier steps.
        </p>
      )}
    </div>
  );
}
