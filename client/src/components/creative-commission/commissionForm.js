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
    generation: {
      quality: c.generation?.quality || 'standard',
      aspectRatio: c.generation?.aspectRatio || '16:9',
      targetDurationSeconds: c.generation?.targetDurationSeconds || 10,
    },
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
    generation: {
      quality: form.generation.quality,
      aspectRatio: form.generation.aspectRatio,
      targetDurationSeconds: Number(form.generation.targetDurationSeconds),
    },
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
  return null;
}
