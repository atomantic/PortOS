/**
 * POST Morse Trainer Progress Service
 *
 * Server-side, cross-device home for Morse (CW) mastery — the authoritative Koch
 * level plus every completed drill round (per-item sent→guessed pairs). This
 * replaces the browser-localStorage-only model that silently wiped all Morse
 * progress on a browser-data clear or a device switch (PortOS is reached from
 * several devices over Tailscale).
 *
 * Data file: data/meatspace/post-morse-progress.json (file-backed, like its
 * post-training-log.json sibling — created on first write, no seed needed).
 *
 *   {
 *     kochLevel: 12 | null,   // null = never set (adopt-once sentinel)
 *     settings: { wpm, farnsworthWpm, toneHz } | null,
 *     rounds: [{
 *       id, date, timestamp, mode: 'copy'|'head-copy'|'send',
 *       kochLevel, wpm, farnsworthWpm,
 *       items: [{ sent, guessed, correct, responseMs }],
 *       accuracy, durationMs
 *     }]
 *   }
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { atomicWrite, PATHS, ensureDir, readJSONFile } from '../lib/fileUtils.js';
import { userLocalToday } from '../lib/timezone.js';
import { ymdShift } from '../lib/postStreak.js';

const MEATSPACE_DIR = PATHS.meatspace;
const MORSE_FILE = join(MEATSPACE_DIR, 'post-morse-progress.json');

export const MORSE_MODES = ['copy', 'head-copy', 'send'];

// The client's Koch pool starts at K, M (2 characters) and pickKochPrompt clamps
// to a floor of 2, so the resolved default matches the existing client default —
// a fresh install is unchanged. Storage keeps kochLevel = null ("never set") so
// the adopt-once path can tell "brand new" apart from "legitimately set to 2".
export const DEFAULT_KOCH_LEVEL = 2;
// KOCH_ORDER in MorseTrainer.jsx has 41 entries — the ceiling for any level.
export const MAX_KOCH_LEVEL = 41;

// Cap retained rounds so the file can't grow without bound over years of daily
// practice; trends/confusion over a rolling window never need the full history.
const MAX_ROUNDS = 2000;

function clampLevel(level) {
  if (typeof level !== 'number' || Number.isNaN(level)) return DEFAULT_KOCH_LEVEL;
  return Math.max(1, Math.min(Math.round(level), MAX_KOCH_LEVEL));
}

async function loadMorseProgress() {
  const data = await readJSONFile(
    MORSE_FILE,
    { kochLevel: null, settings: null, rounds: [] },
    { allowArray: false },
  );
  if (!Array.isArray(data.rounds)) data.rounds = [];
  // Preserve the "never set" sentinel: anything that isn't a real number stays
  // null so adopt-once keeps working across older/partial files.
  if (typeof data.kochLevel !== 'number') data.kochLevel = null;
  if (typeof data.settings !== 'object' || data.settings === null) data.settings = null;
  return data;
}

async function saveMorseProgress(data) {
  await ensureDir(MEATSPACE_DIR);
  await atomicWrite(MORSE_FILE, data);
}

// Serialize every read-modify-write against the single shared progress file so
// the two mutating paths can't clobber each other. A round that advances the
// Koch level fires BOTH a level PUT (updatePrefs) and a round POST from the
// client at once; without this tail their load→mutate→save cycles interleave
// and whichever saves last drops the other's change (the just-earned level, or
// the just-finished round). atomicWrite makes each file write atomic but not the
// surrounding read-modify-write — see CLAUDE.md "serialize writes server-side".
let morseWriteTail = Promise.resolve();
function withMorseWriteTail(fn) {
  const run = morseWriteTail.then(fn, fn);
  // The tail must never stay rejected (that would reject every future write);
  // callers still receive the real result/rejection via `run`.
  morseWriteTail = run.then(() => {}, () => {});
  return run;
}

function normalizeItems(items) {
  return (Array.isArray(items) ? items : []).map((it) => {
    const sent = String(it?.sent ?? '').toUpperCase();
    // Absent/null guess (a miss) normalizes to '' — distinct from a wrong guess.
    const guessed = it?.guessed == null ? '' : String(it.guessed).toUpperCase();
    // correct is recomputed from the normalized pair (not trusted from the
    // client) so the stored accuracy can't drift from the sent/guessed record.
    return {
      sent,
      guessed,
      correct: sent === guessed,
      responseMs: Number.isFinite(it?.responseMs) ? Math.max(0, Math.round(it.responseMs)) : 0,
    };
  });
}

/**
 * Append a completed Morse round (client sends the per-item results it already
 * has). Accuracy is recomputed server-side from the items so the stored value
 * can't drift from the recorded sent/guessed pairs.
 */
export async function appendMorseRound(round) {
  return withMorseWriteTail(async () => {
    const data = await loadMorseProgress();
    const nowDate = new Date();
    const now = nowDate.toISOString();
    // Stamp the round's day in the user's local timezone (issue #2681): a Morse
    // drill completion also writes a training-log entry (submitTrainingEntry, now
    // local), and Morse trends window on `date` — a UTC-day stamp here would date
    // the same completion differently and skew the trend window. Derive from the
    // SAME nowDate used for `timestamp` so a midnight boundary can't split them.
    const todayLocal = await userLocalToday(nowDate);
    const items = normalizeItems(round.items);
    const correctCount = items.filter((i) => i.correct).length;
    const accuracy = items.length > 0 ? Math.round((correctCount / items.length) * 100) : 0;

    const record = {
      id: randomUUID(),
      date: todayLocal,
      timestamp: now,
      mode: MORSE_MODES.includes(round.mode) ? round.mode : 'copy',
      kochLevel: typeof round.kochLevel === 'number' ? clampLevel(round.kochLevel) : (data.kochLevel ?? DEFAULT_KOCH_LEVEL),
      wpm: Number.isFinite(round.wpm) ? round.wpm : null,
      farnsworthWpm: Number.isFinite(round.farnsworthWpm) ? round.farnsworthWpm : null,
      items,
      accuracy,
      durationMs: Number.isFinite(round.durationMs) ? Math.max(0, Math.round(round.durationMs)) : 0,
    };

    data.rounds.push(record);
    if (data.rounds.length > MAX_ROUNDS) data.rounds = data.rounds.slice(-MAX_ROUNDS);
    await saveMorseProgress(data);
    console.log(`📻 Morse round logged: ${record.mode} ${correctCount}/${items.length} (${accuracy}%) @ Koch ${record.kochLevel}`);
    return record;
  });
}

/**
 * Explicit Koch level change (advance/reset) — or a one-time localStorage→server
 * adoption. When `adopt` is true the level is only applied if the server has
 * never had one (data.kochLevel === null): the sentinel guards against a second
 * device clobbering a real server level with its own stale localStorage value.
 */
export async function setKochLevel({ kochLevel, adopt = false, settings } = {}) {
  return withMorseWriteTail(async () => {
    const data = await loadMorseProgress();
    const alreadySet = data.kochLevel != null;

    let adopted = false;
    if (adopt) {
      if (!alreadySet) {
        data.kochLevel = clampLevel(kochLevel);
        adopted = true;
      }
      // else: keep the server's authoritative level; adoption is a no-op.
    } else {
      data.kochLevel = clampLevel(kochLevel);
    }

    if (settings && typeof settings === 'object') {
      data.settings = { ...(data.settings || {}), ...settings };
    }

    await saveMorseProgress(data);
    return { kochLevel: data.kochLevel ?? DEFAULT_KOCH_LEVEL, kochLevelSet: data.kochLevel != null, adopted, settings: data.settings };
  });
}

/**
 * Aggregate progress over a rolling window:
 *  - resolved kochLevel + kochLevelSet sentinel (so the client knows whether to
 *    run the one-time localStorage adoption).
 *  - per-mode accuracy & effective-WPM series (one point per round, chronological).
 *  - confusion matrix { sent -> { guessed -> count } } plus a worst-first list of
 *    confused pairs (sent !== guessed) for the heatmap.
 *  - per-character accuracy list sorted worst-first — "which character to drill next".
 */
export async function getMorseProgress(days = 30) {
  const data = await loadMorseProgress();
  let rounds = data.rounds;

  if (days > 0) {
    // Window off the user's local today (DST-safe day math) so the cutoff matches
    // the local-day round dates now stamped above (issue #2681).
    const cutoffStr = ymdShift(await userLocalToday(), -days);
    rounds = rounds.filter((r) => (r.date || '') >= cutoffStr);
  }

  // Per-mode trend series (chronological — rounds are appended in order).
  const series = {};
  for (const mode of MORSE_MODES) series[mode] = [];
  for (const r of rounds) {
    if (!series[r.mode]) series[r.mode] = [];
    // Effective WPM is Farnsworth speed when set, else the raw character WPM.
    const effectiveWpm = Number.isFinite(r.farnsworthWpm) ? r.farnsworthWpm : (Number.isFinite(r.wpm) ? r.wpm : null);
    series[r.mode].push({
      id: r.id,
      date: r.date,
      timestamp: r.timestamp,
      accuracy: r.accuracy,
      wpm: Number.isFinite(r.wpm) ? r.wpm : null,
      effectiveWpm,
      kochLevel: r.kochLevel,
    });
  }

  // Confusion matrix + per-character accuracy over the window.
  const confusionMatrix = {};
  const charStats = {}; // sent -> { correct, attempts }
  for (const r of rounds) {
    for (const it of (r.items || [])) {
      const sent = it.sent;
      // Empty sent = an insertion (an extra typed char with no transmitted
      // counterpart): it counted against the round's accuracy on append, but has
      // no character to attribute a confusion / mastery entry to, so skip it here.
      if (!sent) continue;
      const guessed = it.guessed || '∅'; // '∅' = a miss / empty guess (a real bucket)
      confusionMatrix[sent] ||= {};
      confusionMatrix[sent][guessed] = (confusionMatrix[sent][guessed] || 0) + 1;
      charStats[sent] ||= { correct: 0, attempts: 0 };
      charStats[sent].attempts += 1;
      if (it.correct) charStats[sent].correct += 1;
    }
  }

  const charAccuracy = Object.entries(charStats)
    .map(([char, s]) => ({
      char,
      correct: s.correct,
      attempts: s.attempts,
      accuracy: s.attempts > 0 ? Math.round((s.correct / s.attempts) * 100) : 0,
    }))
    // Worst-first: lowest accuracy first; break ties by most-attempted so a
    // heavily-drilled weak character outranks a barely-seen one.
    .sort((a, b) => a.accuracy - b.accuracy || b.attempts - a.attempts);

  // Worst-first list of actual confusions (sent !== guessed), for the heatmap.
  const confusionPairs = [];
  for (const [sent, guesses] of Object.entries(confusionMatrix)) {
    for (const [guessed, count] of Object.entries(guesses)) {
      if (guessed === sent) continue;
      confusionPairs.push({ sent, guessed, count });
    }
  }
  confusionPairs.sort((a, b) => b.count - a.count);

  return {
    days,
    kochLevel: data.kochLevel ?? DEFAULT_KOCH_LEVEL,
    kochLevelSet: data.kochLevel != null,
    settings: data.settings,
    totalRounds: rounds.length,
    series,
    confusionMatrix,
    confusionPairs,
    charAccuracy,
  };
}
