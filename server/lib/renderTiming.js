/**
 * Render timing — the wall-clock a media render actually took.
 *
 * Every image/video backend stamps the same three fields on the record it
 * persists (an image sidecar, a video-history row) so the Create section's
 * history/preview cards can show "how long did this take" without re-deriving
 * it from unrelated timestamps.
 *
 * The window measured is INGESTION → finished artifact: it starts when the
 * media-job queue handed the job to the generator (not when the user submitted
 * it), so a render that sat behind five others in the queue still reports its
 * own cost. It ends once the deliverable is on disk, including the
 * thumbnail/faststart tail the user waits through.
 *
 * Absence is the explicit "unknown" sentinel: a record with no `renderMs` was
 * produced by a path that never observed a start instant (or by a build that
 * predates this), and consumers — the card, videoGen/eta.js's cost model —
 * skip it rather than treating it as zero. That is why every failure mode here
 * returns `{}` instead of a defaulted `renderMs: 0`, which would drag every
 * estimate toward "instant".
 */

/**
 * Build the render-timing spread for a completed render.
 *
 * @param {number|null|undefined} startedAtMs - Epoch ms captured when the
 *   render began, typically `job.renderStartedAtMs`. Coerced, so a missing or
 *   junk value reports "unknown" rather than throwing.
 * @param {number} [nowMs=Date.now()] - Completion instant; injectable for tests.
 * @returns {{renderMs?: number, renderStartedAt?: string, renderCompletedAt?: string}}
 *   The fields to spread into the persisted record, or `{}` when the start
 *   instant is missing/unusable (including a clock that moved backwards).
 */
export function renderTimingFields(startedAtMs, nowMs = Date.now()) {
  const startMs = Number(startedAtMs);
  if (!Number.isFinite(startMs) || startMs <= 0) return {};
  // Negated `>= 0` so a NaN span (an unusable `nowMs`) and a negative one — the
  // clock moved backwards mid-render — both report "unknown" rather than a
  // measurement the estimator would ingest.
  const renderMs = nowMs - startMs;
  if (!(renderMs >= 0)) return {};
  return {
    renderMs,
    renderStartedAt: new Date(startMs).toISOString(),
    renderCompletedAt: new Date(nowMs).toISOString(),
  };
}

/**
 * Strip the render-timing fields off a record.
 *
 * A DERIVED record — an image variant, any post-process built by spreading its
 * source — inherits the source render's timing, which would make its card claim
 * a duration it never took. This lives beside `renderTimingFields` so the field
 * names have one owner: hand-copying them at the strip site means a fourth
 * field added here silently starts leaking into every derived record.
 *
 * @param {object} record
 * @returns {object} A copy without `renderMs`/`renderStartedAt`/`renderCompletedAt`.
 */
export function omitRenderTiming(record) {
  const { renderMs, renderStartedAt, renderCompletedAt, ...rest } = record;
  return rest;
}
