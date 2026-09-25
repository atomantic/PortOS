/**
 * Painted-spectrogram music — the Music Designer's "Drawn waveform" engine.
 *
 *   drawWaveSketch()          musical description → a painted canvas
 *                             (lib/paintedCanvas.js, sketch v2, #8464).
 *                             Stateless (POST /api/music/waveform).
 *   drawWaveSketchForTrack()  the same, persisted on the track as
 *                             `waveSketch`/`waveSketchPrompt` (#8376) so the
 *                             painting survives reloads, syncs to the user's
 *                             other machines, and can be revised later.
 *   renderWaveSketchToTrack() the track's STORED sketch (v2 painting, or a v1
 *                             drawing from before #8464) → WAV in the shared
 *                             music library, appended to the track's render
 *                             history as an `engine: 'waveform'` take.
 *
 * A piece longer than one passage is painted SECTION BY SECTION: each call
 * paints one passage of the shared canvas and sees a compact summary of the
 * painted neighbours plus the tempo grid, so no reply has to hold a whole song.
 * With `review`, the model then sees a spectrogram image of each rendered
 * passage and repaints it once — still within the same button press.
 *
 * The prompt describes the canvas physics and numeric limits ONLY — never an
 * arrangement, instrument, or recipe — so a stronger model paints better with
 * no prompt edits.
 *
 * The browser previews the same sketch with the same deterministic synth, so
 * the saved take is exactly what was auditioned. Nothing here runs on its own:
 * every call is driven by an explicit button press in the same request (AI
 * Provider Usage Policy — no cold bootstrap).
 */

import { randomUUID } from 'crypto';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ServerError } from '../lib/errorHandler.js';
import { PATHS } from '../lib/fileUtils.js';
import { trimTo } from '../lib/textUtils.js';
import { pcmToWavBuffer } from '../lib/chiptuneRender.js';
import { writeWavAudioFile } from '../lib/wavAudioFile.js';
import { WAVE_SKETCH_SAMPLE_RATE, synthesizeSketchChannels } from '../lib/waveSketch.js';
import {
  PAINTED_CANVAS_DECLICK_SEC, PAINTED_CANVAS_LIMITS, PAINTED_CANVAS_MASTER_GAIN, PAINTED_CANVAS_SAMPLE_RATE,
  normalizePaintedCanvas, paintedCanvasStats, synthesizePaintedCanvas,
} from '../lib/paintedCanvas.js';
import { spectrogramPixels } from '../lib/spectrogramImage.js';
import { assertProvider, resolveProviderAndModel, runPromptThroughProvider } from './promptRunner.js';
import * as tracks from './tracks/index.js';

const WAVEFORM_ENGINE = 'waveform';
const DEFAULT_CANVAS_SEC = 20;
// One reply paints at most this much of the canvas.
const PASSAGE_MAX_SEC = 30;
const SUMMARY_LINES_MAX = 120;
const REVIEW_IMAGE = { width: 1024, height: 384 };

const MAX_DESCRIPTION = 8000;
const MAX_LYRICS = 20000;
const MAX_GUIDANCE = 4000;
const L = PAINTED_CANVAS_LIMITS;
const NYQUIST = PAINTED_CANVAS_SAMPLE_RATE / 2;

const section = (label, body) => (body ? `\n\n${label}:\n${body}` : '');
const fmt = (n, places = 2) => String(Math.round(n * 10 ** places) / 10 ** places);
// Passage boundaries are stated at their stored precision, so a stroke placed
// exactly on one lands inside the passage it was meant for.
const fmtT = (n) => fmt(n, 3);
const strokeStart = (stroke) => stroke.path[0].t;
const strokeEnd = (stroke) => stroke.path[stroke.path.length - 1].t;
const inPassage = (stroke, passage, isLast) => {
  const t = strokeStart(stroke);
  return t >= passage.start && (t < passage.end || (isLast && t <= passage.end));
};

/**
 * Split the piece into passages of at most PASSAGE_MAX_SEC. With a tempo grid,
 * interior boundaries land on bar lines (measured from t=0) where that keeps
 * every passage non-empty. `from` fixes the first boundary (for re-planning
 * the rest of a piece once its tempo is known).
 */
function planPassages(durationSec, { bpm, beatsPerBar, from = 0 } = {}) {
  const span = durationSec - from;
  const count = Math.max(1, Math.ceil(span / PASSAGE_MAX_SEC - 1e-9));
  const bar = bpm ? ((beatsPerBar || 4) * 60) / bpm : null;
  const bounds = [from];
  for (let i = 1; i < count; i += 1) {
    const nominal = from + (span * i) / count;
    const snapped = bar ? Math.round(nominal / bar) * bar : nominal;
    const prev = bounds[bounds.length - 1];
    bounds.push(snapped > prev && snapped < durationSec && snapped - prev <= PASSAGE_MAX_SEC ? snapped : nominal);
  }
  bounds.push(durationSec);
  return bounds.slice(0, -1).map((start, i) => ({ start: Math.round(start * 1000) / 1000, end: Math.round(bounds[i + 1] * 1000) / 1000 }));
}

/** Each passage's share of the canvas-wide budgets, by its length. */
function passageLimits(passage, durationSec) {
  const share = (passage.end - passage.start) / durationSec;
  return {
    strokes: Math.max(1, Math.floor(L.STROKES_MAX * share)),
    keyframes: Math.max(2, Math.floor(L.KEYFRAMES_MAX * share)),
    work: Math.floor(L.WORK_MAX_PARTIAL_SEC * share),
  };
}

/** One summary line per stroke: span, pitch range, peak level, brush. */
function strokeLine(stroke) {
  const hz = stroke.path.map((k) => k.hz);
  const peak = Math.max(...stroke.path.map((k) => k.a));
  const brush = [
    stroke.width ? `noise band ${fmt(stroke.width, 0)} Hz` : null,
    stroke.overtones?.length || stroke.path.some((k) => k.overtones?.length) ? 'overtones' : null,
    stroke.pan ? `pan ${stroke.pan}` : null,
  ].filter(Boolean).join(', ');
  return `- ${stroke.name || 'unnamed'}: t ${fmt(strokeStart(stroke))}-${fmt(strokeEnd(stroke))}s, ${fmt(Math.min(...hz), 1)}-${fmt(Math.max(...hz), 1)} Hz, peak a ${fmt(peak)}${brush ? `, ${brush}` : ''}`;
}

/** Up to SUMMARY_LINES_MAX lines, keeping the most prominent strokes. */
function summarizeStrokes(strokes) {
  const weight = (s) => Math.max(...s.path.map((k) => k.a)) * (strokeEnd(s) - strokeStart(s));
  const kept = strokes.length > SUMMARY_LINES_MAX
    ? [...strokes].sort((a, b) => weight(b) - weight(a)).slice(0, SUMMARY_LINES_MAX).sort((a, b) => strokeStart(a) - strokeStart(b))
    : strokes;
  const more = strokes.length - kept.length;
  return [...kept.map(strokeLine), ...(more > 0 ? [`- (+${more} quieter or shorter strokes not listed)`] : [])].join('\n');
}

/** Pitch/level of a stroke at time t (for strokes crossing a boundary). */
function strokeAt(stroke, t) {
  const { path } = stroke;
  let i = 0;
  while (i < path.length - 2 && t > path[i + 1].t) i += 1;
  const u = Math.min(1, Math.max(0, (t - path[i].t) / (path[i + 1].t - path[i].t)));
  return { hz: path[i].hz * (path[i + 1].hz / path[i].hz) ** u, a: path[i].a + (path[i + 1].a - path[i].a) * u };
}

/** What the model is told about the rest of the canvas while painting one passage. */
function neighbourContext(strokes, passages, index) {
  const passage = passages[index];
  const byPassage = passages.map((p, i) => strokes.filter((s) => inPassage(s, p, i === passages.length - 1)));
  const parts = [];
  passages.forEach((p, i) => {
    if (i === index || !byPassage[i].length) return;
    const label = `Passage ${i + 1} (t ${fmtT(p.start)}-${fmtT(p.end)}s)`;
    if (Math.abs(i - index) === 1) parts.push(`${label}, ${byPassage[i].length} strokes:\n${summarizeStrokes(byPassage[i])}`);
    else {
      const hz = byPassage[i].flatMap((s) => s.path.map((k) => k.hz));
      parts.push(`${label}: ${byPassage[i].length} strokes, ${fmt(Math.min(...hz), 0)}-${fmt(Math.max(...hz), 0)} Hz`);
    }
  });
  const crossing = strokes
    .filter((s) => strokeStart(s) < passage.start && strokeEnd(s) > passage.start)
    .map((s) => {
      const at = strokeAt(s, passage.start);
      return `- ${s.name || 'unnamed'}: sounding at t=${fmtT(passage.start)}s with hz ${fmt(at.hz, 1)}, a ${fmt(at.a)}; ends at t=${fmt(strokeEnd(s))}s`;
    });
  return { painted: parts.join('\n\n'), crossing: crossing.join('\n') };
}

function tempoLine(grid, passage) {
  if (!grid.bpm) {
    return `No tempo grid is set. You may set one with "bpm" (${L.BPM_MIN}-${L.BPM_MAX}) and "beatsPerBar" (1-${L.BEATS_PER_BAR_MAX}); later passages receive it.`;
  }
  const beatsPerBar = grid.beatsPerBar || 4;
  const beat = 60 / grid.bpm;
  const bar = beat * beatsPerBar;
  return `Tempo grid: ${fmt(grid.bpm)} BPM, ${beatsPerBar} beats per bar — a beat is ${fmt(beat, 4)}s and a bar ${fmt(bar, 4)}s, counted from t=0. This passage spans bars ${fmt(passage.start / bar + 1, 2)} to ${fmt(passage.end / bar + 1, 2)}.`;
}

/**
 * The painting contract for one passage: the brief, the canvas physics, the
 * numeric limits, and the painted context. Physics and limits only — no
 * instruments, arrangement, or recipe (asserted by musicWaveform.test.js).
 */
function buildPaintPrompt({
  description, lyrics, guidance, durationSec, grid = {}, passages, index, context = {}, current, withImage = false,
}) {
  const passage = passages[index];
  const limits = passageLimits(passage, durationSec);
  const isLast = index === passages.length - 1;
  return `You are painting sound on a spectrogram canvas. A deterministic renderer turns the painting into audio exactly as described below; what you paint is everything that is heard.${
    section('THE BRIEF', trimTo(description, MAX_DESCRIPTION) || '(none given)')
  }${
    section('LYRICS / TEXT', trimTo(lyrics, MAX_LYRICS))
  }${
    section('ADDITIONAL GUIDANCE FROM THE USER', trimTo(guidance, MAX_GUIDANCE))
  }

THE CANVAS
- Stereo, ${PAINTED_CANVAS_SAMPLE_RATE} samples per second, ${fmt(durationSec)} seconds long. Time is in seconds from 0; frequency runs on a logarithmic axis from ${L.HZ_MIN} Hz to ${L.HZ_MAX} Hz.
- Strokes add: overlapping strokes sum sample by sample. The renderer adds nothing of its own — no reverberation, filtering, compression, or effect of any kind.
- The summed mix is output at ${PAINTED_CANVAS_MASTER_GAIN}× amplitude; if it would still clip, the whole piece is scaled down uniformly (never up).

THE BRUSH — one stroke
- "path": [{"t": <seconds>, "hz": <${L.HZ_MIN}-${L.HZ_MAX}>, "a": <0-1>}, …] — keyframes in increasing time, at least 2 and at most ${L.KEYFRAMES_PER_STROKE_MAX}. Between keyframes, pitch moves in a straight line on the log-frequency axis (equal pitch intervals per second) and amplitude moves linearly. A stroke sounds from its first keyframe to its last and is silent outside them; a ${PAINTED_CANVAS_DECLICK_SEC * 1000} ms fade at each end prevents clicks.
- Without "width" a stroke is tonal: a sine at "hz" with peak amplitude "a".
- "overtones": [r2, r3, …] — up to ${L.OVERTONES_MAX} levels 0-1 for extra sines at 2×, 3×, … the stroke's hz, each at r × a. On the stroke it is the default for every keyframe; on a keyframe it applies from that keyframe on. Between two keyframes each level moves linearly, so the balance of partials can change along one stroke. Partials at or above ${fmt(NYQUIST * 0.98, 0)} Hz are silent.
- "width": <${L.WIDTH_MIN_HZ}-${L.WIDTH_MAX_HZ} Hz> — makes the stroke noise instead: seeded white noise through a band-pass filter centred on "hz" with that bandwidth, at roughly the loudness of a sine of amplitude "a". "overtones" are ignored on a noise stroke.
- "pan": -1 (left) to 1 (right), equal-power, fixed for the stroke; default 0.
- "name": optional label, up to ${L.NAME_MAX} characters, shown again in the summaries of neighbouring passages.

THIS PASSAGE
- You are painting passage ${index + 1} of ${passages.length}: t=${fmtT(passage.start)}s to t=${fmtT(passage.end)}s of the ${fmtT(durationSec)}-second piece. Every stroke's first keyframe must be at or after t=${fmtT(passage.start)} and ${isLast ? 'at or before' : 'before'} t=${fmtT(passage.end)}${isLast ? '.' : `; a stroke may continue past t=${fmtT(passage.end)} up to t=${fmtT(durationSec)}.`} Strokes starting outside the passage are discarded.
- ${tempoLine(grid, passage)}
- Limits for this passage: at most ${limits.strokes} strokes, ${limits.keyframes} keyframes in total, and ${limits.work} units of render work — a tonal stroke costs its length in seconds × (1 + its overtone count), a noise stroke its length × ${L.NOISE_STROKE_COST}. Strokes beyond a limit are discarded in the order you list them.${
    section('ALREADY PAINTED ELSEWHERE ON THE CANVAS (summary)', context.painted)
  }${
    section('STROKES FROM EARLIER PASSAGES STILL SOUNDING WHEN THIS ONE BEGINS', context.crossing)
  }${
    current ? section('CURRENT PAINTING OF THIS PASSAGE (revise it per the request above — keep what works, change what is asked)', JSON.stringify(current)) : ''
  }${
    withImage ? `\n\nATTACHED IMAGE: a spectrogram of this passage as it renders — time left to right from t=${fmtT(passage.start)}s to t=${fmtT(passage.end)}s, log frequency from ${L.HZ_MIN} Hz (bottom) to ${L.HZ_MAX} Hz (top), brightness = level over an 80 dB range. Compare it with what you meant to paint and return the passage repainted.` : ''
  }

Return ONLY a JSON object (no prose, no code fence) in this shape:
{"title": "<short title>", "bpm": <optional>, "beatsPerBar": <optional>, "strokes": [{"name": "<optional>", "pan": <optional>, "width": <optional>, "overtones": [<optional>], "path": [{"t": <seconds>, "hz": <Hz>, "a": <0-1>, "overtones": [<optional>]}]}]}`;
}

/** The passage's strokes from a reply, or null when none are playable. */
function passageStrokes(reply, { durationSec, passages, index }) {
  const passage = passages[index];
  const canvas = normalizePaintedCanvas(reply, { durationSec, limits: passageLimits(passage, durationSec) });
  const strokes = canvas?.strokes.filter((s) => inPassage(s, passage, index === passages.length - 1)) ?? [];
  return strokes.length ? { canvas, strokes } : null;
}

const badResponse = () => new ServerError('The AI did not return a playable painting. Try rerunning or picking a stronger model.', {
  status: 502, code: 'WAVEFORM_BAD_RESPONSE',
});

/** Write a PNG spectrogram of one passage of the rendered canvas; returns its path. */
async function writePassageSpectrogram(mono, passage, dir, index) {
  const { default: sharp } = await import('sharp');
  const from = Math.floor(passage.start * PAINTED_CANVAS_SAMPLE_RATE);
  const to = Math.min(mono.length, Math.ceil(passage.end * PAINTED_CANVAS_SAMPLE_RATE));
  const { width, height, pixels } = spectrogramPixels(mono.subarray(from, to), {
    sampleRate: PAINTED_CANVAS_SAMPLE_RATE, ...REVIEW_IMAGE, minHz: L.HZ_MIN, maxHz: L.HZ_MAX,
  });
  const file = join(dir, `passage-${index + 1}.png`);
  await sharp(Buffer.from(pixels), { raw: { width, height, channels: 3 } }).png().toFile(file);
  return file;
}

/**
 * Ask the chosen provider to paint the piece. `current` (a v2 painting) turns
 * the call into a revision of it; a v1 drawing is not revisable and paints
 * fresh. `review` adds one look-and-repaint pass per passage.
 */
export async function drawWaveSketch({
  description, lyrics, guidance, durationSec, current, review = false, providerId, model, effort,
} = {}) {
  const { provider, selectedModel } = await resolveProviderAndModel({ providerId, model });
  assertProvider(provider, { message: 'No AI provider available to paint the music', code: 'NO_PROVIDER' });

  const revising = current?.version === 2 ? normalizePaintedCanvas(current) : null;
  const pieceSec = Math.round(Math.min(L.DURATION_MAX_SEC, Math.max(L.DURATION_MIN_SEC,
    Number(durationSec) || revising?.durationSec || DEFAULT_CANVAS_SEC)) * 1000) / 1000;
  const grid = revising?.bpm ? { bpm: revising.bpm, beatsPerBar: revising.beatsPerBar } : {};
  let passages = revising?.sections && revising.durationSec === pieceSec
    ? revising.sections.map(({ start, end }) => ({ start, end }))
    : planPassages(pieceSec, grid);
  let title = revising?.title || '';
  let strokes = revising ? revising.strokes.filter((s) => strokeStart(s) < pieceSec) : [];
  let lastRun = null;

  const paintPassage = async (index, { withImage = null } = {}) => {
    const isLast = index === passages.length - 1;
    const mine = strokes.filter((s) => inPassage(s, passages[index], isLast));
    const others = strokes.filter((s) => !mine.includes(s));
    const opts = { durationSec: pieceSec, passages, index };
    const run = await runPromptThroughProvider({
      provider,
      model: selectedModel ?? undefined,
      effort,
      prompt: buildPaintPrompt({
        description, lyrics, guidance, durationSec: pieceSec, grid, passages, index,
        context: neighbourContext(others, passages, index),
        current: mine.length ? mine : null,
        withImage: !!withImage,
      }),
      source: 'music-waveform',
      // The runner coerces/re-requests an off-shape reply against this.
      responseSchema: (value) => passageStrokes(value, opts) !== null,
      ...(withImage ? { screenshots: [withImage] } : {}),
    });
    let parsed = null;
    try { parsed = JSON.parse(run.text); } catch { /* handled below */ }
    const painted = passageStrokes(parsed, opts);
    if (!painted) throw badResponse();
    lastRun = run;
    strokes = [...others, ...painted.strokes];
    if (!title && painted.canvas.title) title = painted.canvas.title;
    if (!grid.bpm && painted.canvas.bpm) {
      grid.bpm = painted.canvas.bpm;
      grid.beatsPerBar = painted.canvas.beatsPerBar;
      // The rest of a fresh piece can now fall on bar lines.
      if (!isLast) passages = [...passages.slice(0, index + 1), ...planPassages(pieceSec, { ...grid, from: passages[index].end })];
    }
  };

  for (let i = 0; i < passages.length; i += 1) await paintPassage(i);

  let reviewed = 0;
  if (review) {
    const dir = await mkdtemp(join(tmpdir(), 'portos-painting-'));
    const canvas = normalizePaintedCanvas({ durationSec: pieceSec, strokes });
    const [left, right] = synthesizePaintedCanvas(canvas);
    const mono = left.map((v, i) => (v + right[i]) / 2);
    // The review is optional polish on work already paid for: if the provider
    // can't take an image (or the pass fails), keep the painting as it stands.
    try {
      for (let i = 0; i < passages.length; i += 1) {
        const image = await writePassageSpectrogram(mono, passages[i], dir, i);
        const ok = await paintPassage(i, { withImage: image }).then(() => true, (err) => {
          console.warn(`⚠️ Painting review stopped at passage ${i + 1}: ${err.message}`);
          return false;
        });
        if (!ok) break;
        reviewed += 1;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const sketch = normalizePaintedCanvas({ title, durationSec: pieceSec, ...grid, sections: passages, strokes });
  if (!sketch) throw badResponse();
  const ranModel = lastRun?.model ?? selectedModel ?? null;
  const stats = paintedCanvasStats(sketch);
  console.log(`🎨 Painted canvas via ${provider.id}/${ranModel || 'default'} (${stats.strokes} strokes, ${stats.keyframes} keyframes, ${sketch.durationSec}s, ${passages.length} passages, ${reviewed} reviewed)`);
  return { sketch, llm: { provider: lastRun?.provider?.id || provider.id, model: ranModel }, passages: passages.length, reviewed };
}

const requireTrack = async (trackId) => {
  const track = await tracks.getTrack(trackId);
  if (!track) throw new ServerError('Track not found', { status: 404, code: 'NOT_FOUND' });
  return track;
};

/**
 * Paint (or, with `revise`, repaint the track's stored painting) and persist
 * the result on the track. The description it was painted from is kept
 * alongside as `waveSketchPrompt` so a remix reopens with the same brief.
 */
export async function drawWaveSketchForTrack({ trackId, revise = false, ...params }) {
  const track = await requireTrack(trackId);
  const current = revise ? track.waveSketch : null;
  const result = await drawWaveSketch({ ...params, current });
  const updated = await tracks.updateTrack(trackId, { waveSketch: result.sketch, waveSketchPrompt: trimTo(params.description, MAX_DESCRIPTION) });
  return { ...result, sketch: updated.waveSketch, track: updated };
}

/**
 * Render the track's stored sketch into the shared music library and make it
 * the track's active take (same render-history contract as the chiptune and
 * diffusion engines). The server renders what it stored, never a
 * client-supplied sketch, so the take always matches the persisted one. A v2
 * painting renders stereo; a v1 drawing renders mono, byte-identical to before.
 */
export async function renderWaveSketchToTrack({ trackId, prompt, title }) {
  const track = await requireTrack(trackId);
  const normalized = track.waveSketch;
  if (!normalized) {
    throw new ServerError('This track has no painting to render yet — paint one first', { status: 400, code: 'WAVEFORM_EMPTY' });
  }

  const wav = pcmToWavBuffer(synthesizeSketchChannels(normalized), { sampleRate: WAVE_SKETCH_SAMPLE_RATE });
  const filename = await writeWavAudioFile(wav, PATHS.music, `music-${randomUUID()}`);
  const durationSec = Math.max(1, Math.round(normalized.durationSec));
  const updated = await tracks.appendActiveTake(trackId, {
    audioFilename: filename, prompt: prompt || track.waveSketchPrompt || track.prompt, engine: WAVEFORM_ENGINE, durationSec,
  }, title ? { title } : {});
  if (!updated) throw new ServerError('Track not found', { status: 404, code: 'NOT_FOUND' });
  console.log(`🎨 Rendered painted take (${durationSec}s)`);
  return { track: updated, filename, durationSec };
}
