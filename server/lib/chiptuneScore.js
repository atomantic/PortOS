/**
 * Chiptune score contract (#2911) — the versioned JSON shape an LLM emits for
 * a looping 8-bit background-music score, plus the pure math that turns it
 * into absolute-time note events.
 *
 * One score = NES-style channels (two pulse waves, a triangle bass, a noise
 * drum lane), a bank of named patterns, and an `order` list that sequences
 * patterns into one seamless loop. Loop length is whole-pattern by
 * construction: total steps = sum of the ordered patterns' steps, so the
 * render/preview can loop sample-exactly with no tail math.
 *
 * Consumed by:
 *   - server/lib/chiptuneRender.js  — offline PCM/WAV render (deterministic)
 *   - server/services/chiptune.js   — LLM generation (responseSchema) + publish
 *   - server/services/tracks/logic.js — track sanitizer (sanitizeChiptuneScore)
 *   - client/src/lib/chiptunePlayback.js — WebAudio preview (MIRRORS
 *     buildScoreEvents' timing semantics; keep the two in lockstep)
 */

import { z } from 'zod';

export const CHIPTUNE_SCORE_VERSION = 1;

// Bounds — shared by the Zod schema, the LLM prompt contract, and the tests.
export const CHIPTUNE_LIMITS = Object.freeze({
  BPM_MIN: 40,
  BPM_MAX: 240,
  STEPS_PER_BEAT_MAX: 8,
  BEATS_PER_BAR_MAX: 12,
  BARS_PER_PATTERN_MAX: 16,
  PATTERNS_MAX: 8,
  ORDER_MAX: 32,
  NOTES_PER_CHANNEL_MAX: 512,
  TOTAL_STEPS_MAX: 8192,
  // Wall-clock cap on the loop. Steps alone don't bound duration (40 BPM at
  // 1 step/beat = 1.5s per step), and the offline renderer allocates
  // ~176 KB/sec of PCM — an unbounded schema-valid score could demand
  // gigabytes from one errant LLM response. 3 minutes is far beyond any
  // sane background loop.
  MAX_LOOP_SEC: 180,
  // Aggregate cap on VOICED time (sum of every note's clamped length across
  // the order walk). The loop-duration cap bounds the output buffer but not
  // the render work: hundreds of full-loop overlapping notes would each spin
  // the per-sample synth loop for the whole piece (billions of iterations
  // from one errant response). 4 channels × MAX_LOOP_SEC fully voiced = 720s
  // is the physical ceiling of distinct-channel audio; anything past it is
  // pure overdraw.
  NOTE_SECONDS_MAX: 720,
  // Event-density ceiling (notes per second across the whole loop). The
  // browser preview creates 1-2 AudioNodes per note per loop pass — a
  // schema-valid quarter-second loop stuffed with 2 000 notes would mint
  // thousands of nodes per second and freeze the Music studio. Real chiptune
  // rarely exceeds ~20 notes/sec across four channels.
  EVENTS_PER_SEC_MAX: 64,
  TITLE_MAX: 120,
});

// The fixed channel palette. `wave` is constrained per id so the LLM can't
// put a noise lane on a pulse channel (the renderer keys drum presets off it).
export const CHIPTUNE_CHANNEL_IDS = Object.freeze(['pulse1', 'pulse2', 'triangle', 'noise']);
export const CHIPTUNE_NOISE_PRESETS = Object.freeze(['kick', 'snare', 'hat', 'open-hat']);

const patternNameField = z.string().regex(/^[A-Za-z0-9_-]{1,16}$/);

const noteSchema = z.object({
  step: z.number().int().min(0).max(CHIPTUNE_LIMITS.TOTAL_STEPS_MAX),
  // Tonal channels: scientific pitch ("C4", "F#3", "Bb2"). Noise channel: a
  // drum preset name (kick/snare/hat/open-hat). Validated leniently here (the
  // event builder drops what it can't resolve) so one odd note can't reject a
  // whole otherwise-good generation.
  pitch: z.string().trim().min(1).max(12),
  len: z.number().int().min(1).max(CHIPTUNE_LIMITS.TOTAL_STEPS_MAX),
  vel: z.number().min(0).max(1).optional(),
});

const channelSchema = z.object({
  id: z.enum(CHIPTUNE_CHANNEL_IDS),
  wave: z.enum(['square', 'triangle', 'noise']),
  duty: z.number().min(0.05).max(0.95).optional(),
  gain: z.number().min(0).max(1).optional(),
});

const patternSchema = z.object({
  bars: z.number().int().min(1).max(CHIPTUNE_LIMITS.BARS_PER_PATTERN_MAX),
  // Keys are plain strings here (zod 4 treats enum-keyed records as
  // exhaustive); the superRefine below rejects keys that aren't declared
  // channel ids, which also gives a better error message.
  notes: z.record(
    z.string().max(16),
    z.array(noteSchema).max(CHIPTUNE_LIMITS.NOTES_PER_CHANNEL_MAX),
  ),
});

export const chiptuneScoreSchema = z.object({
  version: z.literal(CHIPTUNE_SCORE_VERSION),
  title: z.string().trim().max(CHIPTUNE_LIMITS.TITLE_MAX).optional(),
  bpm: z.number().min(CHIPTUNE_LIMITS.BPM_MIN).max(CHIPTUNE_LIMITS.BPM_MAX),
  stepsPerBeat: z.number().int().min(1).max(CHIPTUNE_LIMITS.STEPS_PER_BEAT_MAX),
  beatsPerBar: z.number().int().min(1).max(CHIPTUNE_LIMITS.BEATS_PER_BAR_MAX),
  channels: z.array(channelSchema).min(1).max(CHIPTUNE_CHANNEL_IDS.length),
  patterns: z.record(patternNameField, patternSchema)
    .refine((p) => {
      const n = Object.keys(p).length;
      return n >= 1 && n <= CHIPTUNE_LIMITS.PATTERNS_MAX;
    }, { message: `patterns must contain 1–${CHIPTUNE_LIMITS.PATTERNS_MAX} entries` }),
  order: z.array(patternNameField).min(1).max(CHIPTUNE_LIMITS.ORDER_MAX),
}).superRefine((score, ctx) => {
  const channelIds = new Set(score.channels.map((c) => c.id));
  if (channelIds.size !== score.channels.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['channels'], message: 'channel ids must be unique' });
  }
  // The channel palette is fixed NES-style: the id determines the waveform.
  // Left unbound, `{ id: 'pulse1', wave: 'noise' }` validates and then every
  // melody note on that channel silently drops (pitches aren't drum presets) —
  // persisting a broken score instead of triggering the runner's schema retry.
  for (const [i, c] of score.channels.entries()) {
    const expected = c.id === 'noise' ? 'noise' : c.id === 'triangle' ? 'triangle' : 'square';
    if (c.wave !== expected) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['channels', i, 'wave'], message: `channel "${c.id}" must use wave "${expected}"` });
    }
  }
  for (const name of score.order) {
    // Object.hasOwn, not truthiness: an order entry like "toString" or
    // "constructor" resolves through the prototype chain to a function
    // (truthy), then every downstream `.bars` read is undefined → NaN math.
    if (!Object.hasOwn(score.patterns, name)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['order'], message: `order references unknown pattern "${name}"` });
      return;
    }
  }
  for (const [name, pattern] of Object.entries(score.patterns)) {
    for (const channelId of Object.keys(pattern.notes || {})) {
      if (!channelIds.has(channelId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['patterns', name, 'notes'],
          message: `pattern "${name}" writes to undeclared channel "${channelId}"`,
        });
      }
    }
  }
  // The order loop above already returned on any unknown pattern, so the
  // shared step math is safe to reuse here (one formula, not two).
  const totalSteps = scoreTotalSteps(score);
  if (totalSteps > CHIPTUNE_LIMITS.TOTAL_STEPS_MAX) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['order'], message: `loop is too long (${totalSteps} steps > ${CHIPTUNE_LIMITS.TOTAL_STEPS_MAX})` });
  }
  const stepSec = 60 / (score.bpm * score.stepsPerBeat);
  const totalSec = totalSteps * stepSec;
  if (totalSec > CHIPTUNE_LIMITS.MAX_LOOP_SEC) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['order'], message: `loop is too long (${Math.round(totalSec)}s > ${CHIPTUNE_LIMITS.MAX_LOOP_SEC}s)` });
  }
  // Bound the aggregate VOICED time the renderer will synthesize (see
  // NOTE_SECONDS_MAX) — the duration cap alone doesn't bound overlapping-note
  // render work — plus event density (see EVENTS_PER_SEC_MAX, the browser
  // preview's AudioNode budget) and require at least one AUDIBLE event, so an
  // all-rests / all-unparseable / all-muted response triggers the runner's
  // schema retry instead of persisting a silent "successful" composition.
  // Mirrors buildScoreEvents' semantics (len clamped to the pattern end;
  // out-of-pattern notes contribute nothing; a tonal pitch must parse, a
  // noise pitch must be a known preset).
  const channelById = new Map(score.channels.map((c) => [c.id, c]));
  let voicedSteps = 0;
  let eventCount = 0;
  let audible = 0;
  for (const name of score.order) {
    const pattern = score.patterns[name];
    const steps = pattern.bars * score.beatsPerBar * score.stepsPerBeat;
    for (const [channelId, notes] of Object.entries(pattern.notes || {})) {
      const channel = channelById.get(channelId);
      for (const note of notes) {
        if (note.step >= steps) continue;
        voicedSteps += Math.min(note.len, steps - note.step);
        eventCount += 1;
        if (!channel || (channel.gain ?? 0.5) === 0 || (note.vel ?? 0.8) === 0) continue;
        const sounds = channel.wave === 'noise'
          ? CHIPTUNE_NOISE_PRESETS.includes(note.pitch)
          : pitchToMidi(note.pitch) != null;
        if (sounds) audible += 1;
      }
    }
  }
  if (voicedSteps * stepSec > CHIPTUNE_LIMITS.NOTE_SECONDS_MAX) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['patterns'], message: `too much voiced audio (${Math.round(voicedSteps * stepSec)}s of notes > ${CHIPTUNE_LIMITS.NOTE_SECONDS_MAX}s)` });
  }
  if (totalSec > 0 && eventCount / totalSec > CHIPTUNE_LIMITS.EVENTS_PER_SEC_MAX) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['patterns'], message: `too many notes for the loop length (${Math.round(eventCount / totalSec)}/s > ${CHIPTUNE_LIMITS.EVENTS_PER_SEC_MAX}/s)` });
  }
  if (audible === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['patterns'], message: 'score has no audible notes (every note is out of range, unparseable, or muted)' });
  }
});

/**
 * Validate an untrusted value into a canonical score, or null. Used by the
 * track sanitizer (absent/invalid → null = "no score", per the sentinel rule).
 */
export function sanitizeChiptuneScore(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const parsed = chiptuneScoreSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// --- Pitch → frequency (mirrors client/src/lib/scorePlayback.js math) -------
const PITCH_CLASS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const PITCH_RE = /^([A-Ga-g])(#{1,2}|b{1,2})?(-?\d)$/;

/** MIDI number for a scientific-pitch string ("C4" = 60, "A4" = 69), or null. */
export function pitchToMidi(pitch) {
  const m = PITCH_RE.exec(String(pitch || '').trim());
  if (!m) return null;
  const pc = PITCH_CLASS[m[1].toUpperCase()];
  const shift = m[2] ? (m[2][0] === '#' ? m[2].length : -m[2].length) : 0;
  const octave = Number(m[3]);
  return (octave + 1) * 12 + pc + shift;
}

/** Frequency (Hz) for a MIDI note number, A4 (69) = 440. */
export const midiToFreq = (midi) => (Number.isFinite(midi) ? 440 * Math.pow(2, (midi - 69) / 12) : null);

/** Seconds per sequencer step. */
export const scoreStepSec = (score) => 60 / (score.bpm * score.stepsPerBeat);

/** Steps in one pattern. */
export const patternSteps = (score, pattern) => pattern.bars * score.beatsPerBar * score.stepsPerBeat;

/** Total loop length in steps (the order walk). */
export function scoreTotalSteps(score) {
  return score.order.reduce((sum, name) => sum + patternSteps(score, score.patterns[name]), 0);
}

/** Total loop length in seconds — whole-step exact, so loops are seamless. */
export const scoreDurationSec = (score) => scoreTotalSteps(score) * scoreStepSec(score);

/**
 * Flatten a validated score into absolute-time events, one per sounding note:
 *   { channelId, wave, duty, gain, freq|null, noise|null, startSec, durSec, vel }
 *
 * Timing semantics (MIRRORED by client/src/lib/chiptunePlayback.js — keep in
 * lockstep): the order walk lays patterns back to back; a note sounds at
 * (patternBase + step) · stepSec for len · stepSec seconds. Notes that start
 * past their pattern's end are dropped; notes that overhang it are clamped so
 * nothing bleeds past the loop boundary (loop-safe by construction). A tonal
 * pitch that doesn't parse (or an unknown noise preset) drops just that note.
 */
export function buildScoreEvents(score) {
  const stepSec = scoreStepSec(score);
  const channelsById = new Map(score.channels.map((c) => [c.id, c]));
  const events = [];
  let baseStep = 0;
  for (const name of score.order) {
    const pattern = score.patterns[name];
    const steps = patternSteps(score, pattern);
    for (const [channelId, notes] of Object.entries(pattern.notes || {})) {
      const channel = channelsById.get(channelId);
      if (!channel) continue;
      for (const note of notes) {
        if (note.step >= steps) continue;
        const lenSteps = Math.min(note.len, steps - note.step);
        const isNoise = channel.wave === 'noise';
        const noise = isNoise
          ? (CHIPTUNE_NOISE_PRESETS.includes(note.pitch) ? note.pitch : null)
          : null;
        const freq = isNoise ? null : midiToFreq(pitchToMidi(note.pitch));
        if (isNoise ? !noise : !freq) continue;
        events.push({
          channelId,
          wave: channel.wave,
          duty: channel.duty ?? 0.5,
          gain: channel.gain ?? 0.5,
          freq,
          noise,
          startSec: (baseStep + note.step) * stepSec,
          durSec: lenSteps * stepSec,
          vel: note.vel ?? 0.8,
        });
      }
    }
    baseStep += steps;
  }
  events.sort((a, b) => a.startSec - b.startSec);
  return { events, stepSec, totalSteps: baseStep, totalSec: baseStep * stepSec };
}
