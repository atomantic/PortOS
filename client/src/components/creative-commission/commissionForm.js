/**
 * Shared, pure helpers for the Creative Commission config form (#2657).
 *
 * These are the editable projection of a commission record — used by BOTH the
 * index page's "New Commission" create drawer (client/src/pages/CreativeCommissions.jsx)
 * and the routed detail page's editable config (client/src/pages/CreativeCommissionDetail.jsx).
 * Kept side-effect-free so both surfaces map record ↔ form identically.
 */

import { describeRecurrence } from '../../utils/cronHelpers.js';

// The brief field caps are the server's own (server/lib/creativeBriefLimits.js),
// used here as the inputs' `maxLength`.
export {
  COMMISSION_BRIEF_TAG_MAX, COMMISSION_INTENT_MAX, COMMISSION_NAME_MAX, COMMISSION_STYLE_SPEC_MAX,
} from '../../../../server/lib/creativeBriefLimits.js';
// The generation-key spec (type/bounds/values/default) is the server's own too
// (server/lib/creativeCommissionSpec.js, #6816) — a zod-free leaf, like the brief
// caps above, so this form derives every bound/default/option value from it
// instead of hand-copying (the drift that left durationMode's default and the
// video/image backend enums disagreeing with the server for months).
import {
  GENERATION_KEY_DEFS, ABILITY_GENERATION_SPEC,
} from '../../../../server/lib/creativeCommissionSpec.js';
// The NODE-SAFE half of imageGenBackends.js (no lucide-react import) — this
// module is imported from a server-workspace parity test
// (creativeCommissionSpec.parity.test.js), which fails with ERR_MODULE_NOT_FOUND
// if anything here pulls in a browser-only package.
import { RENDER_TARGET_BACKEND_AUTO as RENDER_BACKEND_AUTO, modeLabel } from '../../lib/imageGenModes.js';

// Pause and Delete are real STOPS, not just "skip the next tick": the server also
// tears down the Creative Director projects the commission already spawned
// (server/services/creativeCommissions/projectControl.js). Both surfaces must say
// so — a user watching a retry loop has no other way to know it just ended — and
// both must say it the same way, which is why the strings live here.
export const COMMISSION_STOP_COPY = Object.freeze({
  pausedToast: 'Commission paused — stopping any generation still in flight',
  resumedToast: 'Schedule resumed',
  deletedToast: 'Commission deleted — stopping any generation still in flight',
  pauseTitle: 'Pause — stops the schedule and any generation still in flight',
  resumeTitle: 'Resume the schedule',
  deleteTitle: 'Delete commission — also stops any generation still in flight',
});

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const inputCls = 'w-full bg-port-bg border border-port-border rounded px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-port-accent';
export const labelCls = 'block text-xs font-medium text-gray-400 mb-1';

// Creative-output types the commission can produce (#2769). Mirrors the server
// enum CREATIVE_COMMISSION_ABILITIES; `video` stays first (the default).
export const ABILITY_OPTIONS = [
  { id: 'video', label: 'Video' },
  { id: 'image', label: 'Image' },
  { id: 'music', label: 'Music' },
  { id: 'music-video', label: 'Music video' },
  { id: 'series', label: 'Series' },
];

// Re-exported so the commission form and the Settings Defaults tab (#3231)
// can never disagree on the "no pin" protocol value.
export { RENDER_BACKEND_AUTO };

// Presentation-only metadata for each generation key: the server spec
// (server/lib/creativeCommissionSpec.js, GENERATION_KEY_DEFS) owns every
// enumerable VALUE, bound, and default — this map adds only the display label
// and, for the two render-backend-pin keys, the conditional-model-picker
// wiring. `type: 'backend'` fields render as a mode picker plus a conditional
// model picker (see CommissionConfigForm's RenderBackendSection), mirroring
// the pipeline's VisualGenSettings UX; the generic field renderer in
// GenerationSection skips them. `modelKind` names which media-model catalog
// the conditional picker reads, and `modelModes` lists the modes that HAVE a
// model knob — the cloud CLIs pick their own model, so the picker only
// appears for local.
const FIELD_LABELS = {
  quality: 'Quality',
  aspectRatio: 'Aspect ratio',
  targetDurationSeconds: 'Duration (sec)',
  durationMode: 'Video length',
  imageCount: 'Image count',
  lengthSeconds: 'Length (sec)',
  episodeCount: 'Episodes',
  imageMode: 'Image backend',
  videoMode: 'Video backend',
};
const OPTION_LABELS = {
  quality: { draft: 'Draft', standard: 'Standard', high: 'High' },
  durationMode: { auto: 'Creative Director chooses', manual: 'Set a specific length' },
};
const BACKEND_FIELD_META = {
  imageMode: { modelKey: 'imageModelId', modelKind: 'image', modelModes: ['local'], modelLabel: 'Local image model' },
  videoMode: { modelKey: 'videoModelId', modelKind: 'video', modelModes: ['local'], modelLabel: 'Local video model' },
};

// A render-backend mode's display label. Every real backend reads from the
// shared `modeLabel` (client/src/lib/imageGenModes.js) so a backend added
// there (fal, reactor, agy, …) is labeled here automatically — the drift that
// left the video/image backend pickers behind generationModes.js for months.
const backendOptionLabel = (mode) => (mode === RENDER_BACKEND_AUTO ? 'Auto (install default)' : modeLabel(mode));

// Build one field descriptor from a generation key's spec descriptor
// (type/bounds/values) plus its presentation metadata above. `type: 'id'` keys
// (imageModelId/videoModelId) never build their own field — they're the
// model-id half of their backend field's `modelKey` — so callers only ever
// list an ability's non-id keys below.
function buildGenerationField(key) {
  const def = GENERATION_KEY_DEFS[key];
  const label = FIELD_LABELS[key] || key;
  if (def.type === 'int') return { key, label, type: 'number', min: def.min, max: def.max };
  const backend = BACKEND_FIELD_META[key];
  if (backend) {
    return {
      key, label, type: 'backend', options: def.values.map((v) => [v, backendOptionLabel(v)]), ...backend,
    };
  }
  return { key, label, type: 'select', options: def.values.map((v) => [v, OPTION_LABELS[key]?.[v] || v]) };
}

// Per-ability generation field descriptors, built from the server's
// per-key spec (server/lib/creativeCommissionSpec.js) so a new backend enum
// member or a bound change needs no edit here. The per-ability KEY LIST and
// its display ORDER stay hand-declared — `durationMode` before
// `targetDurationSeconds` so "how the length is chosen" reads before "the
// length itself" (GenerationSection hides the latter in auto mode) — and the
// required parity test (creativeCommissionSpec.parity.test.js) fails if this
// ever drops a key the server ability actually carries.
export const GENERATION_FIELDS_BY_ABILITY = {
  video: ['quality', 'aspectRatio', 'durationMode', 'targetDurationSeconds', 'videoMode'].map(buildGenerationField),
  image: ['quality', 'aspectRatio', 'imageCount', 'imageMode'].map(buildGenerationField),
  music: ['lengthSeconds'].map(buildGenerationField),
  'music-video': ['quality', 'aspectRatio', 'durationMode', 'targetDurationSeconds', 'videoMode', 'imageMode'].map(buildGenerationField),
  series: ['episodeCount'].map(buildGenerationField),
};

export const IMAGE_BACKEND_OPTIONS = GENERATION_FIELDS_BY_ABILITY.image.find((f) => f.key === 'imageMode').options;
export const VIDEO_BACKEND_OPTIONS = GENERATION_FIELDS_BY_ABILITY.video.find((f) => f.key === 'videoMode').options;

// Per-ability generation defaults for seeding a BRAND-NEW commission/form —
// each key's spec `default` (#4494's `durationMode: 'auto'` product choice,
// now declared once in GENERATION_KEY_DEFS instead of hand-copied here).
// Projecting a REAL fetched record's own gaps is a different reading — see
// generationToForm below, which prefers a key's `legacyAbsent` when the spec
// declares one.
export const GENERATION_DEFAULTS_BY_ABILITY = Object.fromEntries(
  Object.entries(ABILITY_GENERATION_SPEC).map(([ability, spec]) => [
    ability,
    Object.fromEntries(spec.keys.map((k) => [k, GENERATION_KEY_DEFS[k].default])),
  ]),
);

export const MUSIC_TASTE_DEFAULTS = Object.freeze({
  enabled: false,
  source: 'digital-twin',
  window: 'month',
  anchorCount: 3,
  explorationPercent: 20,
  musicEngineId: '',
  musicModelId: '',
});

// The render-backend descriptors for an ability, in field order. Drives the
// dedicated backend section; the generic field grid skips `type: 'backend'`.
export function backendFieldsForAbility(ability) {
  return (GENERATION_FIELDS_BY_ABILITY[abilityOr(ability)] || []).filter((f) => f.type === 'backend');
}

function abilityOr(ability) {
  return GENERATION_DEFAULTS_BY_ABILITY[ability] ? ability : 'video';
}

// Project a stored generation object into the form for a given ability: fill
// each of the ability's fields from the record, falling back to the LEGACY-AWARE
// default (ABILITY_GENERATION_SPEC's `defaults`, not GENERATION_DEFAULTS_BY_ABILITY)
// — a key absent from a REAL record prefers its spec `legacyAbsent` reading over
// the fresh-commission `default` (only `durationMode` differs today: an existing
// record with no key means 'manual', matching abilityAdapters.js). Only the
// ability's own keys appear, so switching types never carries a stale key.
export function generationToForm(ability, generation) {
  const a = abilityOr(ability);
  const legacyDefaults = ABILITY_GENERATION_SPEC[a].defaults;
  const out = {};
  for (const key of Object.keys(legacyDefaults)) {
    const v = generation?.[key];
    out[key] = v === undefined || v === null ? legacyDefaults[key] : v;
  }
  return out;
}

// When the user switches output type, seed the new type's fields with the type's
// defaults but carry over any overlapping value the user already set (e.g. keep
// their quality/aspectRatio when going video → image). This is exactly the
// project-a-record projection — carrying over an overlapping key IS falling back
// to the default only when absent — so it delegates to generationToForm.
export const mergeGenerationForAbility = generationToForm;

// Build the API generation payload for the current ability: emit only that
// ability's keys, coercing number fields (form <input type=number> values are
// strings). Mirrors the server superRefine, which rejects off-type keys.
export function generationToPayload(ability, generation) {
  const a = abilityOr(ability);
  const fields = GENERATION_FIELDS_BY_ABILITY[a];
  const out = {};
  for (const field of fields) {
    const v = generation?.[field.key];
    if (field.type === 'backend') {
      // A backend descriptor owns TWO record keys. The model id only travels when
      // the pinned mode actually has a model knob — otherwise a stale id left over
      // from a previous local pin would ride along on a cloud pin and confuse the
      // stored record. Send `null` (not omit) so clearing a pin clears the id too:
      // the server merges `generation` shallowly, and an omitted key would preserve
      // the stale value (the absent-vs-empty rule).
      const mode = v || RENDER_BACKEND_AUTO;
      const model = generation?.[field.modelKey];
      out[field.key] = mode;
      out[field.modelKey] = field.modelModes.includes(mode) && model ? model : null;
      continue;
    }
    out[field.key] = field.type === 'number' ? Number(v) : v;
  }
  if (out.durationMode === 'auto') delete out.targetDurationSeconds;
  return out;
}

// Human-readable cadence summary for the list card + detail header.
export function describeSchedule(schedule) {
  if (!schedule) return 'No schedule';
  const { kind, atLocalTime, weekday, weekdaysOnly, cron } = schedule;
  if (kind === 'CUSTOM') return `Custom · ${cron || '—'}`;
  if (kind === 'RECURRENCE') return describeRecurrence(schedule.recurrence) || 'Custom recurrence';
  if (kind === 'WEEKLY') return `Weekly · ${WEEKDAYS[weekday] ?? '—'} at ${atLocalTime || '—'}`;
  if (kind === 'DAILY') return `Daily${weekdaysOnly ? ' (weekdays)' : ''} at ${atLocalTime || '—'}`;
  return kind || 'No schedule';
}

// Compact "who processes this" summary. Unset → the install default assignment;
// set → the pinned provider (and model, when chosen).
export function describeAssignment(assignment) {
  const providerId = assignment?.providerId;
  if (!providerId) return 'Install default AI';
  return assignment.model ? `${providerId} · ${assignment.model}` : providerId;
}

// Map a stored record → editable form state (fills gaps so inputs stay controlled).
export function toForm(c) {
  return {
    name: c.name || '',
    enabled: c.enabled !== false,
    targetAbility: c.targetAbility || 'video',
    brief: {
      intent: c.brief?.intent || '',
      genre: c.brief?.genre || '',
      styleSpec: c.brief?.styleSpec || '',
    },
    musicTaste: c.brief?.musicTaste ? {
      enabled: true,
      source: 'digital-twin',
      window: c.brief.musicTaste.window || MUSIC_TASTE_DEFAULTS.window,
      anchorCount: c.brief.musicTaste.anchorCount ?? MUSIC_TASTE_DEFAULTS.anchorCount,
      explorationPercent: c.brief.musicTaste.explorationPercent ?? MUSIC_TASTE_DEFAULTS.explorationPercent,
      musicEngineId: c.brief.musicTaste.musicEngineId || '',
      musicModelId: c.brief.musicTaste.musicModelId || '',
    } : { ...MUSIC_TASTE_DEFAULTS },
    schedule: {
      kind: c.schedule?.kind || 'DAILY',
      atLocalTime: c.schedule?.atLocalTime || '02:00',
      weekday: Number.isInteger(c.schedule?.weekday) ? c.schedule.weekday : 0,
      weekdaysOnly: c.schedule?.weekdaysOnly === true,
      cron: c.schedule?.cron || '',
      recurrence: c.schedule?.recurrence || null,
      timezone: c.schedule?.timezone || null,
    },
    // Per-ability generation (#2769): only the selected type's fields, filled
    // from the record or the type's defaults. NOT YET PERSISTED (no `id` —
    // `blankForm()`'s `toForm({})`, or a create-drawer harness that pre-seeds
    // just a brief before the user has touched generation at all) with no
    // `generation` opinion either seeds every key's fresh-commission default;
    // anything else — any record that HAS an id, or that already carries a
    // `generation` object of its own — projects through generationToForm,
    // which resolves an absent key to its spec `legacyAbsent` reading when
    // the key has one. durationMode's is 'manual', so an existing record
    // with no key still projects as a fixed length (matching
    // abilityAdapters.js) while a genuinely brand-new commission seeds 'auto'
    // (the #4494 product choice). Gating on `c.generation == null` alone
    // would treat a saved record whose generation object is missing/null the
    // same as a fresh one; requiring `!c.id` too keeps that record on the
    // legacy-aware path (ids are always minted server-side, never present on
    // an unsaved commission).
    generation: c.generation == null && !c.id
      ? { ...GENERATION_DEFAULTS_BY_ABILITY[abilityOr(c.targetAbility)] }
      : generationToForm(c.targetAbility, c.generation),
    // Which AI provider/model processes the commission's CD stages. Empty
    // providerId → the install's default AI Assignment.
    assignment: {
      providerId: c.assignment?.providerId || '',
      model: c.assignment?.model || '',
      effort: c.assignment?.effort || '',
    },
    // How many recent reactions steer the next run (0 disables conditioning).
    feedbackWindow: Number.isInteger(c.feedbackWindow) ? c.feedbackWindow : 5,
  };
}

// A blank form is just the editable projection of an empty record.
export const blankForm = () => toForm({});

// Build the API payload from form state, dropping fields the schedule kind doesn't use.
export function toPayload(form) {
  const s = { kind: form.schedule.kind };
  if (form.schedule.timezone) s.timezone = form.schedule.timezone;
  if (form.schedule.kind === 'CUSTOM') {
    s.cron = form.schedule.cron.trim();
  } else if (form.schedule.kind === 'RECURRENCE') {
    s.recurrence = form.schedule.recurrence;
  } else {
    s.atLocalTime = form.schedule.atLocalTime;
    if (form.schedule.kind === 'WEEKLY') s.weekday = Number(form.schedule.weekday);
    if (form.schedule.kind === 'DAILY') s.weekdaysOnly = !!form.schedule.weekdaysOnly;
  }
  return {
    name: form.name.trim(),
    enabled: !!form.enabled,
    targetAbility: form.targetAbility,
    brief: {
      intent: form.brief.intent.trim(),
      genre: form.brief.genre.trim() || null,
      styleSpec: form.brief.styleSpec,
      musicTaste: form.targetAbility === 'music' && form.musicTaste.enabled ? {
        source: 'digital-twin',
        window: form.musicTaste.window,
        anchorCount: Number(form.musicTaste.anchorCount),
        explorationPercent: Number(form.musicTaste.explorationPercent),
        musicEngineId: form.musicTaste.musicEngineId || null,
        musicModelId: form.musicTaste.musicModelId || null,
      } : null,
    },
    schedule: s,
    // Emit only the selected type's generation keys (#2769), coercing numbers.
    generation: generationToPayload(form.targetAbility, form.generation),
    // Send the full pin every save; a provider-less choice clears the model too
    // (the server drops a dangling model, but keeping the payload clean avoids a
    // pointless round-trip through the sanitizer's normalization).
    assignment: {
      providerId: form.assignment.providerId || null,
      model: form.assignment.providerId ? (form.assignment.model || null) : null,
      ...(form.assignment.providerId && form.assignment.effort ? { effort: form.assignment.effort } : {}),
    },
    feedbackWindow: Number(form.feedbackWindow),
  };
}

// A patch helper for one/two-level form paths, shared by both editors.
export function patchFormState(prev, path, value) {
  const next = { ...prev };
  if (path.length === 1) next[path[0]] = value;
  else next[path[0]] = { ...prev[path[0]], [path[1]]: value };
  return next;
}

// Validate the form before save. Returns an error string, or null when valid.
// A cleared feedbackWindow is '', which Number() coerces to 0 — and 0 is the
// valid "disable conditioning" value, so a blank field would silently turn
// feedback off. Reject it instead of guessing intent.
export function validateForm(form) {
  if (!form.name.trim()) return 'Name is required';
  if (!form.brief.intent.trim()) return 'Brief intent is required';
  const fw = Number(form.feedbackWindow);
  if (form.feedbackWindow === '' || !Number.isInteger(fw) || fw < 0 || fw > 50) {
    return 'Feedback window must be a whole number from 0 to 50';
  }
  // Per-ability numeric fields (#2769): a cleared/out-of-range number would coerce
  // to NaN/0 in the payload and 400 at the server — reject it here with a clear
  // message rather than guessing intent.
  const fields = GENERATION_FIELDS_BY_ABILITY[abilityOr(form.targetAbility)] || [];
  for (const field of fields) {
    if (field.type !== 'number') continue;
    const raw = form.generation?.[field.key];
    const n = Number(raw);
    if (raw === '' || raw === null || raw === undefined || !Number.isInteger(n) || n < field.min || n > field.max) {
      return `${field.label} must be a whole number from ${field.min} to ${field.max}`;
    }
  }
  if (form.targetAbility === 'music' && form.musicTaste?.enabled) {
    const anchorCount = Number(form.musicTaste.anchorCount);
    if (form.musicTaste.anchorCount === '' || !Number.isInteger(anchorCount) || anchorCount < 1 || anchorCount > 5) {
      return 'Taste anchor count must be a whole number from 1 to 5';
    }
    const exploration = Number(form.musicTaste.explorationPercent);
    if (form.musicTaste.explorationPercent === '' || !Number.isInteger(exploration) || exploration < 0 || exploration > 100) {
      return 'Taste exploration must be a whole percentage from 0 to 100';
    }
  }
  return null;
}
