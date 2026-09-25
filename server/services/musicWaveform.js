/**
 * Drawn-waveform music — the Music Designer's "Drawn waveform" engine.
 *
 *   drawWaveSketch()          musical description → a wave sketch the LLM drew
 *                             point by point (lib/waveSketch.js contract).
 *   renderWaveSketchToTrack() a (client round-tripped) sketch → WAV/OGG in the
 *                             shared music library, appended to the track's
 *                             render history as an `engine: 'waveform'` take.
 *
 * The browser previews the same sketch with the same deterministic synth
 * (`synthesizeWaveSketch`), so the saved take is exactly what was auditioned.
 *
 * Nothing here runs on its own: every call is driven by an explicit button
 * press in the same request (AI Provider Usage Policy — no cold bootstrap).
 */

import { randomUUID } from 'crypto';
import { ServerError } from '../lib/errorHandler.js';
import { PATHS } from '../lib/fileUtils.js';
import { trimTo } from '../lib/textUtils.js';
import { pcmToWavBuffer } from '../lib/chiptuneRender.js';
import { writeWavAudioFile } from '../lib/wavAudioFile.js';
import {
  WAVE_SKETCH_LIMITS, WAVE_SKETCH_SAMPLE_RATE, normalizeWaveSketch, synthesizeWaveSketch,
} from '../lib/waveSketch.js';
import { assertProvider, resolveProviderAndModel, runPromptThroughProvider } from './promptRunner.js';
import * as tracks from './tracks/index.js';

const WAVEFORM_ENGINE = 'waveform';
const DEFAULT_SKETCH_SEC = 20;

const MAX_DESCRIPTION = 8000;
const MAX_LYRICS = 20000;
const MAX_GUIDANCE = 4000;
const L = WAVE_SKETCH_LIMITS;

const section = (label, body) => (body ? `\n\n${label}:\n${body}` : '');

/** The drawing contract sent to the LLM. */
function buildWaveSketchPrompt({ description, lyrics, guidance, durationSec = DEFAULT_SKETCH_SEC, current } = {}) {
  const target = Math.min(L.DURATION_MAX_SEC, Math.max(L.DURATION_MIN_SEC, Math.round(durationSec)));
  return `You are a sound designer and composer who makes music by DRAWING WAVEFORMS. There are no instruments, samples, synth presets, or code: every sound in the piece comes from single-cycle waveforms you draw point by point, played back as timed strokes.${
    section('MUSIC TO DRAW', trimTo(description, MAX_DESCRIPTION) || '(none given)')
  }${
    section('LYRICS / THEME (mood only — nothing is sung; drawn sounds carry the melody)', trimTo(lyrics, MAX_LYRICS))
  }${
    section('ADDITIONAL GUIDANCE FROM THE USER', trimTo(guidance, MAX_GUIDANCE))
  }${
    current ? section('CURRENT SKETCH (revise it per the request above — keep what works, change what is asked)', JSON.stringify(current)) : ''
  }

TARGET LENGTH: about ${target} seconds.

Return ONLY a JSON object (no prose, no code fence) in exactly this shape:
{
  "version": 1,
  "title": "<short title>",
  "durationSec": <number ${L.DURATION_MIN_SEC}-${L.DURATION_MAX_SEC}>,
  "shapes": {
    "<shapeName>": [<${L.SHAPE_POINTS_MIN}-${L.SHAPE_POINTS_MAX} numbers in -1..1 — ONE cycle of the waveform, evenly spaced left to right; it loops, so the last point flows back into the first>]
  },
  "voices": [
    {"name": "<lane name>", "shape": "<a shapeName, or \\"noise\\">", "gain": <0-1>,
     "notes": [{"t": <start seconds>, "d": <length seconds>, "pitch": "<scientific pitch like A3 or F#4 — or use \\"hz\\": <number> instead>",
                "glideTo": "<optional pitch the note slides to across its length>",
                "morphTo": "<optional shapeName the timbre crossfades into across the note>",
                "env": [<optional ${L.ENV_POINTS_MIN}-${L.ENV_POINTS_MAX} numbers 0..1 — the note's loudness drawn left to right>],
                "v": <0-1 velocity>}]}
  ],
  "contour": [<optional 2-${L.CONTOUR_POINTS_MAX} numbers 0..1 — the whole piece's loudness drawn left to right>]
}

How your drawing becomes sound:
- A shape's outline IS its timbre. Smooth round curves sound pure and soft (a sine drawn in 16 points: 0, 0.38, 0.71, 0.92, 1, 0.92, 0.71, 0.38, 0, -0.38, -0.71, -0.92, -1, -0.92, -0.71, -0.38). Straight ramps (saw) sound bright and buzzy; flat tops with sharp jumps (square) sound hollow and reedy; small ripples riding on a curve add upper harmonics — glassy, bell-like, stringy, or gritty. Most shapes need 16-64 points; spend more only on fine detail.
- Draw a distinct shape for each role (bass, lead, pad, percussion body). Up to ${L.SHAPES_MAX} shapes and ${L.VOICES_MAX} voices; a voice plays one shape.
- "noise" voices are unpitched: without "hz" they hiss (snares, breath, wind); with "hz" the noise is resampled at that rate (6000-16000 for crisp hats, 200-1500 for rumble and crunch).
- Percussion is drawable too: a kick is a round shape gliding down fast ("hz": 150, "glideTo": "B0") over ~0.25s with "env": [1, 0.6, 0.2, 0]; a snare is a short noise stroke with "env": [1, 0.4, 0.1, 0]; hats are 0.03-0.08s high-hz noise strokes.
- Without "env" a note holds full level with a quick fade in and out. Draw "env" for plucks [1, 0.5, 0.2, 0.05, 0], swells [0, 0.4, 1, 0.8], or tremolo [1, 0.4, 1, 0.4, 1, 0.4].
- Times are absolute seconds. Choose a tempo and place notes on its grid (at 120 BPM a beat is 0.5s, a sixteenth 0.125s) so the rhythm grooves. Every note must end by durationSec. At most ${L.NOTES_MAX} notes in total.

Compose real music: a memorable melody on a lead voice, a bassline that moves, harmony (pads or arpeggios), and percussion that grooves unless the description asks otherwise. Stay in key, repeat and vary motifs, and shape an arc with "contour" and velocity.`;
}

// The runner validates/coerces the response against this predicate (it strips
// fences/prose and re-requests on an off-shape reply), so "parses into a
// playable sketch" is the schema.
const isPlayableSketch = (value) => normalizeWaveSketch(value) !== null;

/**
 * Ask the chosen provider to draw a wave sketch for the description. `current`
 * (a normalized sketch) turns the call into a revision of that drawing.
 */
export async function drawWaveSketch({ description, lyrics, guidance, durationSec, current, providerId, model, effort } = {}) {
  const { provider, selectedModel } = await resolveProviderAndModel({ providerId, model });
  assertProvider(provider, { message: 'No AI provider available to draw the waveform', code: 'NO_PROVIDER' });

  const revising = normalizeWaveSketch(current);
  const run = await runPromptThroughProvider({
    provider,
    model: selectedModel ?? undefined,
    effort,
    prompt: buildWaveSketchPrompt({ description, lyrics, guidance, durationSec, current: revising }),
    source: 'music-waveform',
    responseSchema: isPlayableSketch,
  });

  let parsed = null;
  try { parsed = JSON.parse(run.text); } catch { /* handled below */ }
  const sketch = normalizeWaveSketch(parsed);
  if (!sketch) {
    throw new ServerError('The AI did not return a playable waveform drawing. Try rerunning or picking a stronger model.', {
      status: 502, code: 'WAVEFORM_BAD_RESPONSE',
    });
  }
  const ranModel = run.model ?? selectedModel ?? null;
  const noteCount = sketch.voices.reduce((sum, v) => sum + v.notes.length, 0);
  console.log(`〰️ Drew waveform via ${provider.id}/${ranModel || 'default'} (${Object.keys(sketch.shapes).length} shapes, ${noteCount} notes, ${sketch.durationSec}s)`);
  return { sketch, llm: { provider: run.provider?.id || provider.id, model: ranModel } };
}

/**
 * Render a sketch into the shared music library and make it the track's active
 * take (same render-history contract as the chiptune and diffusion engines).
 */
export async function renderWaveSketchToTrack({ trackId, sketch, prompt, title }) {
  const normalized = normalizeWaveSketch(sketch);
  if (!normalized) {
    throw new ServerError('That waveform drawing has nothing playable in it', { status: 400, code: 'WAVEFORM_EMPTY' });
  }
  const track = await tracks.getTrack(trackId);
  if (!track) throw new ServerError('Track not found', { status: 404, code: 'NOT_FOUND' });

  const wav = pcmToWavBuffer(synthesizeWaveSketch(normalized), { sampleRate: WAVE_SKETCH_SAMPLE_RATE });
  const filename = await writeWavAudioFile(wav, PATHS.music, `music-${randomUUID()}`);
  const durationSec = Math.max(1, Math.round(normalized.durationSec));
  const updated = await tracks.appendActiveTake(trackId, {
    audioFilename: filename, prompt: prompt || track.prompt, engine: WAVEFORM_ENGINE, durationSec,
  }, title ? { title } : {});
  if (!updated) throw new ServerError('Track not found', { status: 404, code: 'NOT_FOUND' });
  console.log(`〰️ Rendered drawn waveform take (${durationSec}s)`);
  return { track: updated, filename, durationSec };
}
