/**
 * Shared, pure helpers for the Creative Commission config form (#2657).
 *
 * These are the editable projection of a commission record — used by BOTH the
 * index page's "New Commission" create drawer (client/src/pages/CreativeCommissions.jsx)
 * and the routed detail page's editable config (client/src/pages/CreativeCommissionDetail.jsx).
 * Kept side-effect-free so both surfaces map record ↔ form identically.
 */

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

const QUALITY_FIELD = { key: 'quality', label: 'Quality', type: 'select', options: [['draft', 'Draft'], ['standard', 'Standard'], ['high', 'High']] };
const ASPECT_FIELD = { key: 'aspectRatio', label: 'Aspect ratio', type: 'select', options: [['16:9', '16:9'], ['9:16', '9:16'], ['1:1', '1:1']] };
const DURATION_FIELD = { key: 'targetDurationSeconds', label: 'Duration (sec)', type: 'number', min: 5, max: 600 };

// Per-ability generation field descriptors — the client mirror of the server's
// ABILITY_GENERATION_SPEC (server/lib/creativeCommissionValidation.js). The
// config form renders exactly these fields for the selected type; keep the two in
// sync (the mirror is asserted in commissionForm.test.js).
export const GENERATION_FIELDS_BY_ABILITY = {
  video: [QUALITY_FIELD, ASPECT_FIELD, DURATION_FIELD],
  image: [QUALITY_FIELD, ASPECT_FIELD, { key: 'imageCount', label: 'Image count', type: 'number', min: 1, max: 6 }],
  music: [{ key: 'lengthSeconds', label: 'Length (sec)', type: 'number', min: 5, max: 600 }],
  'music-video': [QUALITY_FIELD, ASPECT_FIELD, DURATION_FIELD],
  series: [{ key: 'episodeCount', label: 'Episodes', type: 'number', min: 1, max: 6 }],
};

// Per-ability generation defaults (mirror of the server spec defaults). Used to
// project a stored record into the form and to seed the fields when the user
// switches output type.
export const GENERATION_DEFAULTS_BY_ABILITY = {
  video: { quality: 'standard', aspectRatio: '16:9', targetDurationSeconds: 10 },
  image: { quality: 'standard', aspectRatio: '16:9', imageCount: 1 },
  music: { lengthSeconds: 30 },
  'music-video': { quality: 'standard', aspectRatio: '16:9', targetDurationSeconds: 10 },
  series: { episodeCount: 1 },
};

function abilityOr(ability) {
  return GENERATION_DEFAULTS_BY_ABILITY[ability] ? ability : 'video';
}

// Project a stored generation object into the form for a given ability: fill each
// of the ability's fields from the record, falling back to the default. Only the
// ability's own keys appear, so switching types never carries a stale key.
export function generationToForm(ability, generation) {
  const a = abilityOr(ability);
  const defaults = GENERATION_DEFAULTS_BY_ABILITY[a];
  const out = {};
  for (const key of Object.keys(defaults)) {
    const v = generation?.[key];
    out[key] = v === undefined || v === null ? defaults[key] : v;
  }
  return out;
}

// When the user switches output type, seed the new type's fields with the type's
// defaults but carry over any overlapping value the user already set (e.g. keep
// their quality/aspectRatio when going video → image).
export function mergeGenerationForAbility(nextAbility, currentGeneration) {
  const a = abilityOr(nextAbility);
  const defaults = GENERATION_DEFAULTS_BY_ABILITY[a];
  const out = {};
  for (const key of Object.keys(defaults)) {
    const v = currentGeneration?.[key];
    out[key] = v === undefined || v === null ? defaults[key] : v;
  }
  return out;
}

// Build the API generation payload for the current ability: emit only that
// ability's keys, coercing number fields (form <input type=number> values are
// strings). Mirrors the server superRefine, which rejects off-type keys.
export function generationToPayload(ability, generation) {
  const a = abilityOr(ability);
  const fields = GENERATION_FIELDS_BY_ABILITY[a];
  const out = {};
  for (const field of fields) {
    const v = generation?.[field.key];
    out[field.key] = field.type === 'number' ? Number(v) : v;
  }
  return out;
}

// Human-readable cadence summary for the list card + detail header.
export function describeSchedule(schedule) {
  if (!schedule) return 'No schedule';
  const { kind, atLocalTime, weekday, weekdaysOnly, cron } = schedule;
  if (kind === 'CUSTOM') return `Custom · ${cron || '—'}`;
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
    schedule: {
      kind: c.schedule?.kind || 'DAILY',
      atLocalTime: c.schedule?.atLocalTime || '02:00',
      weekday: Number.isInteger(c.schedule?.weekday) ? c.schedule.weekday : 0,
      weekdaysOnly: c.schedule?.weekdaysOnly === true,
      cron: c.schedule?.cron || '',
    },
    // Per-ability generation (#2769): only the selected type's fields, filled
    // from the record or the type's defaults.
    generation: generationToForm(c.targetAbility || 'video', c.generation),
    // Which AI provider/model processes the commission's CD stages. Empty
    // providerId → the install's default AI Assignment.
    assignment: {
      providerId: c.assignment?.providerId || '',
      model: c.assignment?.model || '',
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
  if (form.schedule.kind === 'CUSTOM') {
    s.cron = form.schedule.cron.trim();
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
  return null;
}
