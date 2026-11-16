/**
 * Render timing: the wall-clock a media render actually took.
 *
 * `renderTimingFields(startedAtMs, nowMs?)` → the `{ renderMs, renderStartedAt, renderCompletedAt }` spread every image/video backend stamps on its persisted record (image sidecar, video-history row) so history/preview cards show "how long did this take" without re-deriving it. The window is INGESTION → finished artifact: it starts when the media-job queue handed the job to the generator (not at submission, so a render behind five others reports its own cost) and ends once the deliverable is on disk, including the thumbnail/faststart tail. Absence is the explicit "unknown" sentinel: no `renderMs` means a path that never observed a start (or a build predating this), and consumers (the card, `services/videoGen/eta.js`'s cost model) skip it; every failure mode returns `{}`, never a defaulted `renderMs: 0` that would drag estimates toward "instant". `omitRenderTiming(record)` is the inverse. `HOSTED_PROVIDER_ID_FIELDS` lists the provider request ids (Runway task, fal.ai/Topaz request, Gemini chat). A DERIVED record built by spreading its source (an image variant, an upscale/trim) spreads `omitDerivedRenderFields(source)`, which strips both, so it inherits neither a duration it never took nor the source's provider request.
 */

/**
 * Build the render-timing spread for a completed render.
 *
 * @param {number|null|undefined} startedAtMs - Epoch ms captured when the render began (typically `job.renderStartedAtMs`); coerced, so a missing or junk value reports "unknown" rather than throwing.
 * @param {number} [nowMs=Date.now()] - Completion instant; injectable for tests.
 * @returns {{renderMs?: number, renderStartedAt?: string, renderCompletedAt?: string}} The fields to spread, or `{}` when the start instant is missing/unusable (including a clock that moved backwards).
 */
export function renderTimingFields(startedAtMs, nowMs = Date.now()) {
  const startMs = Number(startedAtMs);
  if (!Number.isFinite(startMs) || startMs <= 0) return {};
  // Negated `>= 0` so a NaN span (unusable `nowMs`) and a negative one (clock moved backwards) both report "unknown", not a measurement the estimator would ingest.
  const renderMs = nowMs - startMs;
  if (!(renderMs >= 0)) return {};
  return {
    renderMs,
    renderStartedAt: new Date(startMs).toISOString(),
    renderCompletedAt: new Date(nowMs).toISOString(),
  };
}

/** Strip the render-timing fields off a record. A DERIVED record (an image variant, any post-process spreading its source) would inherit the source's timing and claim a duration it never took; this lives beside `renderTimingFields` so the field names have one owner (hand-copying them means a new field silently leaks into derived records). */
export function omitRenderTiming(record) {
  const { renderMs, renderStartedAt, renderCompletedAt, ...rest } = record;
  return rest;
}

// Whether THIS machine deleted the provider-hosted copy: machine-local like `hidden` (depends on this machine's provider account), so it never crosses the federation wire or merges from a peer.
export const HOSTED_DELETED_AT_FIELDS = Object.freeze(['runwayDeletedAt', 'falDeletedAt']);

/** A copy of `record` without the machine-local hosted-deleted stamps. */
export function omitHostedDeletedStamps(record) {
  const rest = { ...record };
  for (const field of HOSTED_DELETED_AT_FIELDS) delete rest[field];
  return rest;
}

// Provider-side identity of ONE render (Runway task, fal.ai/Topaz request, Gemini chat) and the stamp that its hosted copy was deleted; never shared by a derived record.
export const HOSTED_PROVIDER_ID_FIELDS = [
  'runwayTaskId', 'runwayDeletedAt', 'falRequestId', 'falDeletedAt', 'topazRequestId', 'geminiChatUrl',
];

function omitHostedProviderIds(record) {
  const rest = { ...record };
  for (const field of HOSTED_PROVIDER_ID_FIELDS) delete rest[field];
  return rest;
}

/**
 * Everything a record DERIVED from a source render (upscale, trim, cut, image variant) must not
 * inherit from it: the source's timing and its provider request ids. Spread this, not the source.
 */
export const omitDerivedRenderFields = (record) => omitRenderTiming(omitHostedProviderIds(record));
