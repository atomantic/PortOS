/** Reads and updates POST configuration and emits changes after durable writes. */

import { join } from 'path';
import { EventEmitter } from 'events';
import {
  atomicWrite,
  PATHS,
  ensureDir,
  readJSONFile,
} from '../../lib/fileUtils.js';
import { deepMerge } from '../../lib/objects.js';
import { createFileWriteQueue } from '../../lib/fileWriteQueue.js';
import { ServerError } from '../../lib/errorHandler.js';
import { validateCognitivePair } from '../../lib/postCognitiveConfig.js';

const MEATSPACE_DIR = PATHS.meatspace;
const CONFIG_FILE = join(MEATSPACE_DIR, 'post-config.json');
const queueConfigWrite = createFileWriteQueue();

// Tiny pub/sub (mirrors settingsEvents in server/services/settings.js) so
// features that react to a specific config slice — e.g. meatspacePostReminder.js
// rescheduling its cron when `reminder` changes — can subscribe without
// postConfig.js importing back into them (which would create a service
// cycle). This is what makes updatePostConfig() the single place ANY current
// or future caller gets slice-specific side effects "for free", instead of
// each route handler having to remember to bolt one on (#2015).
export const postConfigEvents = new EventEmitter();

const DEFAULT_CONFIG = {
  mentalMath: {
    enabled: true,
    drillTypes: {
      'doubling-chain': { enabled: true, steps: 8, timeLimitSec: 60 },
      'serial-subtraction': { enabled: true, steps: 10, subtrahend: 7, startRange: [100, 200], timeLimitSec: 90 },
      // `progressive` (default ON) makes multiplication ramp up a mastery-gated
      // difficulty ladder (server/lib/postMultiplicationLadder.js) starting at
      // single-digit × single-digit, instead of jumping straight to the fixed
      // `maxDigits` difficulty. `maxDigits` is retained as the fallback for when
      // a user turns the progressive ladder off.
      'multiplication': { enabled: true, count: 10, maxDigits: 2, progressive: true, timeLimitSec: 120 },
      'powers': { enabled: true, bases: [2, 3, 5], maxExponent: 10, count: 8, progressive: true, timeLimitSec: 90 },
      'estimation': { enabled: true, count: 5, tolerancePct: 10, timeLimitSec: 120 },
      // Pure, seeded everyday numeracy scenarios. No provider call or
      // high-stakes domain is involved; the returned seed is stored with each
      // session so the server can rebuild answer keys on submit.
      'applied-numeracy': { enabled: true, count: 5, difficulty: 1, timeLimitSec: 150 }
    }
  },
  llmDrills: {
    enabled: true,
    providerId: null,
    model: null,
    drillTypes: {
      'word-association': { enabled: true, count: 5, timeLimitSec: 120 },
      'story-recall': { enabled: true, count: 3, timeLimitSec: 180 },
      'verbal-fluency': { enabled: true, count: 3, timeLimitSec: 60 },
      'wit-comeback': { enabled: true, count: 5, timeLimitSec: 120 },
      'pun-wordplay': { enabled: true, count: 5, timeLimitSec: 120 }
    }
  },
  // Optional AI judging for the standalone rhetoric trainer. It is explicitly
  // off by default so loading POST or opening the practice page never queues a
  // provider call without a user opting in and saving this block.
  rhetoricEvaluator: {
    enabled: false,
    providerId: null,
    model: null,
    effort: null,
  },
  // Deterministic cognitive drills (working-memory / attention / inhibition).
  // No provider calls — enabled by default since they're free to run. No
  // timeLimitSec — these drills are self-paced/stimulus-driven and never
  // enforce a countdown (see client PostCognitiveDrillRunner.jsx / issue #2008).
  // `progressive` (default ON for laddered drills) ramps difficulty via the
  // per-skill ladders in server/lib/postProgression.js instead of a fixed knob;
  // the manual knobs (incl. stimulusMs/showMs) are the fallback when it's off.
  // reaction-time is a measurement baseline (no ladder, no progressive).
  cognitive: {
    enabled: true,
    drillTypes: {
      'n-back': { enabled: true, progressive: true, n: 2, length: 20, stimulusMs: 2500 },
      'digit-span': { enabled: true, progressive: true, direction: 'forward', startLength: 3, maxLength: 8, showMs: 1000 },
      'stroop': { enabled: true, progressive: true, count: 15, incongruentPct: 75 },
      'schulte-table': { enabled: true, progressive: true, size: 5 },
      'mental-rotation': { enabled: true, progressive: true, count: 8, rotationComplexity: 3, optionCount: 4 },
      'reaction-time': { enabled: true, mode: 'simple', count: 15, minDelayMs: 1000, maxDelayMs: 3000, choices: 3 },
      // Executive-control pack is opt-in for existing installs: additive config
      // must not silently lengthen a user's established composed session.
      'task-switching': { enabled: false, progressive: true, count: 18, ruleCount: 2, switchRatePct: 50, cueStimulusIntervalMs: 700, incongruentPct: 50, responseDeadlineMs: 2200 },
      'go-no-go': { enabled: false, progressive: true, count: 20, noGoPct: 25, stimulusMs: 600, lureSimilarity: 'low', responseDeadlineMs: 1400 },
      'flanker': { enabled: false, progressive: true, count: 20, congruentPct: 60, flankerDistance: 2, flankerStrength: 2, responseDeadlineMs: 1600 }
    }
  },
  // Memory practice (issue #3252). Present so the block's shape is discoverable
  // in the saved config; `items` is deliberately ABSENT — a per-item entry is
  // only written when the user actually switches an item off, and absent =
  // enabled, so a fresh or legacy install rotates every memory item as before.
  memory: {
    enabled: true,
    drillTypes: {
      'memory-fill-blank': { enabled: true },
      'memory-sequence': { enabled: true },
      'memory-element-flash': { enabled: true }
    }
  },
  // Morse participation (issue #3252) — on by default so existing installs keep
  // seeing Koch-progression recommendations; a user not learning CW turns it off
  // from the Practice Plan.
  morse: { enabled: true },
  // Default session composition is a balanced, interleaved mix of the free
  // (no-provider) modules the launcher can actually compose — mental math and
  // deterministic cognitive drills (issue #2100). LLM drills are deliberately
  // excluded: auto-enabling them would queue provider calls the user hasn't
  // consented to (see AGENTS.md's AI Provider Usage Policy) — a user who wants
  // wit/verbal drills in every session adds `llm-drills` here explicitly.
  // `memory` is intentionally NOT a default: composed memory practice is opt-in,
  // so existing installs keep exactly their prior daily session mix. Legacy
  // installs that persisted the old
  // `['mental-math']` default are upgraded to this by migration 159.
  sessionModules: ['mental-math', 'cognitive'],
  // Quick-session target presets are persisted so a user's chosen budget is
  // stable across launcher visits and refreshes. The client mirrors these
  // four values; validation rejects anything outside the supported presets.
  quickDurationMin: 5,
  // Optional practice goals (issue #2100). All fields absent by default so a
  // fresh/legacy install shows no goal UI until the user sets one. Bounds are
  // enforced by postGoalsSchema (server/lib/postValidation.js).
  //   dailyMinutes?   — minutes trained today target
  //   weeklySessions? — scored sessions per rolling 7 days target
  //   streakTarget?   — unified activity-streak (days) target
  //   morseWpmTarget? — Morse effective-WPM target
  goals: {},
  // Per-module weight applied to a session's blended score (issue #2099).
  // Uniform 1.0 defaults reproduce the old unweighted-mean behavior exactly —
  // a user only sees a change once they actually adjust a weight.
  scoring: { weights: { 'mental-math': 1.0, 'llm-drills': 1.0, 'cognitive': 1.0, 'memory': 1.0 } },
  // Opt-in adaptive difficulty (default OFF). When enabled, math drills are
  // nudged harder/easier at generation time from recent scored performance.
  adaptive: { enabled: false },
  // Opt-in daily reminder (default OFF, off-by-default per AGENTS.md's
  // single-user/no-surprise-background-behavior convention). When enabled,
  // meatspacePostReminder.js fires a deterministic (no-LLM) in-app notification
  // at `time` (HH:MM, user's configured timezone) if today's POST is incomplete.
  reminder: { enabled: false, time: '09:00' }
};

async function ensureMeatspaceDir() {
  await ensureDir(MEATSPACE_DIR);
}

export async function getPostConfig() {
  const baseDefaults = structuredClone(DEFAULT_CONFIG);
  const config = await readJSONFile(CONFIG_FILE, baseDefaults, { strict: true });
  return deepMerge(baseDefaults, config);
}

export function updatePostConfig(updates) {
  return queueConfigWrite(() => applyPostConfigUpdate(updates));
}

async function applyPostConfigUpdate(updates) {
  const config = await getPostConfig();
  const merged = deepMerge(config, updates);
  // A partial patch (one field of a pair) is judged against the merged record
  // so it can't evade a relation with an already-stored partner. Only drill
  // types in the patch are checked: unrelated saves never trip on legacy values.
  const pairErrors = Object.keys(updates?.cognitive?.drillTypes || {}).flatMap(type =>
    validateCognitivePair(type, merged.cognitive?.drillTypes?.[type])
      .map(e => ({ path: `cognitive.drillTypes.${type}.${e.field}`, message: e.message })));
  if (pairErrors.length) {
    throw new ServerError('Validation failed', { status: 400, code: 'VALIDATION_ERROR', context: { details: pairErrors } });
  }
  if (updates?.reminder) {
    // Stamp WHEN the reminder's enabled/time settings last changed. Read by
    // meatspacePostReminder.js's missed-slot catch-up: a cron occurrence
    // that fell before this timestamp happened under a DIFFERENT (possibly
    // disabled) configuration, so replaying it after a restart would nag for
    // a slot the current settings never actually owned — e.g. enabling the
    // reminder for an already-past time today, then restarting later that
    // same day, would otherwise catch up a slot the reminder wasn't even
    // active for.
    merged.reminder = { ...merged.reminder, updatedAt: new Date().toISOString() };
  }
  // `goals` is REPLACED wholesale when present in the patch, not deep-merged
  // (issue #2100). deepMerge would otherwise make a set goal impossible to
  // clear: JSON can't send `undefined`, `0` is out of the schema's range, and
  // `{}` would merge into the existing object rather than replace it. Sending
  // the full desired goals object — including `{}` to clear every goal — now
  // takes effect and the launcher/widget goal rows hide again.
  if (updates?.goals !== undefined) {
    merged.goals = { ...updates.goals };
  }
  await ensureMeatspaceDir();
  await atomicWrite(CONFIG_FILE, merged);
  console.log(`🧪 POST config updated`);
  // Emit AFTER the write succeeds so a subscriber (reminder rescheduler, etc.)
  // never reacts to a config change that didn't actually persist. `updates` is
  // included (not just `merged`) so subscribers can gate on which slice was
  // touched rather than re-evaluating on every unrelated save.
  postConfigEvents.emit('post-config:updated', { config: merged, updates });
  return merged;
}
