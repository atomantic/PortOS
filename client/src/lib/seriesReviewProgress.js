/**
 * Pure helpers for the "Review this series" SSE progress stream
 * (`server/services/pipeline/seriesReview.js#runSeriesReview`).
 *
 * Since #4108 the review runs the foundation judge and canon readiness
 * CONCURRENTLY with the editorial-checks pass, so the frame stream interleaves:
 * a `step:complete` for `foundation`/`canon` can land in the middle of a run of
 * `check:start`/`check:complete` frames. Labelling the single newest frame (the
 * pre-#4108 behaviour) therefore made the headline flip between "Judging
 * foundation done" and the current editorial check.
 *
 * `summarizeReviewProgress` fixes that by folding the whole frame list into the
 * set of steps still in flight plus the newest check frame, and picking ONE
 * stable headline (the editorial-checks pass while it runs — it is the noisiest
 * and longest-lived step) with the other in-flight steps reported alongside it.
 *
 * No React/window — the panel and its tests share these.
 */

// One-line label per review step kind.
export const REVIEW_STEP_LABELS = {
  foundation: 'Judging foundation',
  feedback: 'Routing your feedback',
  editorialChecks: 'Running editorial checks',
  canon: 'Checking canon descriptions',
  health: 'Scoring editorial health',
};

const stepLabel = (kind) => REVIEW_STEP_LABELS[kind] || kind;

// The frames that end a run — once one lands it is always the headline.
const TERMINAL_TYPES = new Set(['complete', 'canceled', 'error']);

/** One-line label for a single review SSE frame. */
export function reviewFrameLabel(f) {
  if (!f) return null;
  switch (f.type) {
    case 'start': return 'Starting review…';
    case 'step:start': return `${stepLabel(f.kind)}…`;
    case 'step:complete': return `${stepLabel(f.kind)} done`;
    case 'check:start': return `Editorial check: ${f.label || f.checkId}…`;
    case 'check:complete': return `Editorial check: ${f.label || f.checkId} — ${f.count ?? 0} finding(s)`;
    case 'complete': return 'Review complete';
    case 'canceled': return 'Review canceled';
    case 'error': return `Review failed — ${f.error}`;
    default: return f.type;
  }
}

/**
 * Fold the review frame stream into a coherent progress summary.
 *
 * @param {Array<object>} frames  every frame received so far, in arrival order
 * @returns {{ headline: string|null, alsoRunning: string[] }}
 *   `headline` — the single line to show as the current activity (null when no
 *   frame has arrived yet, so the caller can fall back to its own placeholder).
 *   `alsoRunning` — labels of the OTHER steps still in flight, so a concurrent
 *   foundation judge stays visible while the checks pass owns the headline.
 */
export function summarizeReviewProgress(frames) {
  const list = Array.isArray(frames) ? frames.filter((f) => f && typeof f === 'object') : [];
  if (!list.length) return { headline: null, alsoRunning: [] };

  const terminal = [...list].reverse().find((f) => TERMINAL_TYPES.has(f.type));
  if (terminal) return { headline: reviewFrameLabel(terminal), alsoRunning: [] };

  // In-flight steps, in the order they started (a Map keeps insertion order and
  // re-adding after a delete moves the kind to the end, which is what we want).
  const active = new Map();
  let latestCheck = null;
  for (const f of list) {
    if (f.type === 'step:start' && f.kind) active.set(f.kind, true);
    else if (f.type === 'step:complete' && f.kind) active.delete(f.kind);
    else if (f.type === 'check:start' || f.type === 'check:complete') latestCheck = f;
  }

  // The editorial-checks pass owns the headline while it runs — it emits its own
  // per-check frames, so surfacing those keeps the line moving with real work
  // instead of flickering to a background step that just settled.
  if (active.has('editorialChecks') && latestCheck) {
    return { headline: reviewFrameLabel(latestCheck), alsoRunning: otherLabels(active, 'editorialChecks') };
  }
  const kinds = [...active.keys()];
  if (kinds.length) {
    // No checks pass in flight — the most recently started step is the headline.
    const primary = kinds[kinds.length - 1];
    return { headline: `${stepLabel(primary)}…`, alsoRunning: otherLabels(active, primary) };
  }
  // Nothing in flight and no terminal frame yet (e.g. between two steps) — fall
  // back to the newest frame so the line never goes blank mid-run.
  return { headline: reviewFrameLabel(list[list.length - 1]), alsoRunning: [] };
}

function otherLabels(active, primary) {
  return [...active.keys()].filter((k) => k !== primary).map(stepLabel);
}
