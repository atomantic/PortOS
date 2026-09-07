/** Non-destructive 2x upscaling for video-history items. */

import { existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS, UUID_RE, copyFileGuarded, unlinkGuarded } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import {
  safeUnder, generateThumbnail, upscaleVideo2x,
  probeVideoStreamInfo, probeFrameCount, probeVideoDuration, hasAudioStream,
} from '../../lib/ffmpeg.js';
import { loadHistory, mutateVideoHistory } from './history.js';
import { omitRenderTiming, renderTimingFields } from '../../lib/renderTiming.js';
import { resolveIcLoraWeightByKey, icLoraSpecByKey, icLoraWeightKey } from '../../lib/icLoraWeights.js';
import { BYOV_RUNTIME_INFO, isByovRuntimeInstalled } from './runtimes.js';
import {
  UPSCALE_METHODS, DEFAULT_UPSCALE_METHOD, UPSCALE_SCALE, LANCZOS_RUNTIME_ID,
  LTX_UPSCALE_WEIGHT_KEY, ltxUpscaleRuntimeId, planLtxAlignment, planTargetDimensions,
} from './upscalePlan.js';

export * from './upscalePlan.js';

const UPLOADED_HISTORY_ID_RE = /^upload-[a-f0-9]{8}$/i;

// Normalize the options bag. Every pre-#6509 caller passes a bare id, so an
// absent bag and an absent `method` both mean Lanczos — the historical
// behavior — rather than an error.
const resolveMethod = (options) => {
  const method = options?.method ?? DEFAULT_UPSCALE_METHOD;
  if (!UPSCALE_METHODS.includes(method)) {
    throw new ServerError(
      `Unknown upscale method '${method}' (expected one of: ${UPSCALE_METHODS.join(', ')})`,
      { status: 400, code: 'VALIDATION_ERROR' },
    );
  }
  return method;
};

// Shared id-validate → load → find. Rendered clips use UUIDs; shared-gallery
// uploads use their `upload-<uuid8>` filename stem as the id. Keep the strict
// UUID check for render ids while allowing the upload producer's documented id
// shape. Validating the arg first surfaces a clean 400 even if the history file
// happens to contain a record with a malformed id, and it short-circuits the
// loadHistory I/O for obviously-bogus requests.
const resolveHistoryItem = async (historyId) => {
  if (typeof historyId !== 'string' || (!UUID_RE.test(historyId) && !UPLOADED_HISTORY_ID_RE.test(historyId))) {
    throw new ServerError('Invalid history id', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const history = await loadHistory();
  const item = history.find((h) => h.id === historyId);
  if (!item) throw new ServerError('Video not found', { status: 404, code: 'NOT_FOUND' });
  return item;
};

const resolveSourcePath = (item) => {
  const sourcePath = safeUnder(PATHS.videos, item.filename);
  if (!sourcePath) throw new ServerError('Invalid video filename', { status: 400, code: 'VALIDATION_ERROR' });
  if (!existsSync(sourcePath)) throw new ServerError('Video file not found on disk', { status: 404, code: 'NOT_FOUND' });
  return sourcePath;
};

// The BYOV runtime that would carry a generative upscale on this host, plus
// whether it is actually present. `isByovRuntimeInstalled` is a filesystem
// check, NOT the import probe — the plan endpoint must stay read-only and cheap,
// and "the venv exists" is the honest answer to "does this machine have a
// supported backend" at disclosure time.
const describeLtxRuntime = () => {
  const id = ltxUpscaleRuntimeId();
  if (!id) {
    return { id: null, label: null, supported: false, installed: false, reason: `No generative upscale backend exists for ${process.platform}.` };
  }
  const installed = isByovRuntimeInstalled(id);
  const label = BYOV_RUNTIME_INFO[id]?.label || id;
  return {
    id,
    label,
    supported: true,
    installed,
    reason: installed ? null : `The ${label} runtime is not installed on this machine.`,
  };
};

// Cache-only adapter lookup (#6508). `resolveIcLoraWeightByKey` reads the local
// HF cache and, for this `requiresPreDownload` spec, returns `path: null`
// instead of falling back to a repo id — so this never triggers a download,
// which #6502 forbids anywhere outside the explicit action.
const describeLtxAdapter = async () => {
  const spec = icLoraSpecByKey(LTX_UPSCALE_WEIGHT_KEY);
  const resolved = await resolveIcLoraWeightByKey(LTX_UPSCALE_WEIGHT_KEY);
  return {
    key: icLoraWeightKey(spec),
    label: spec?.label ?? null,
    repo: spec?.repo ?? null,
    filename: spec?.filename ?? null,
    sizeBytes: spec?.sizeBytes ?? null,
    gated: spec?.gated === true,
    cached: resolved?.cached === true,
  };
};

/**
 * Everything the user must see BEFORE submitting an upscale (#6509).
 *
 * Read-only by construction: it probes the source with ffprobe, reads the HF
 * cache, and stats a venv path. It queues no job and downloads nothing — the
 * explicit upscale action is the only thing allowed to do either.
 */
export async function planUpscaleHistoryItem(historyId, options = {}) {
  const method = resolveMethod(options);
  const item = await resolveHistoryItem(historyId);
  const alreadyUpscaled = !!item.upscaledFrom;
  const sourcePath = resolveSourcePath(item);

  const [stream, durationSeconds, audio] = await Promise.all([
    probeVideoStreamInfo(sourcePath),
    probeVideoDuration(sourcePath),
    hasAudioStream(sourcePath),
  ]);
  // The header frame count is absent on plenty of containers; fall back to the
  // decode-counting probe rather than reporting "unknown" for a file we can
  // measure. Kept out of the parallel batch above because that fallback can pay
  // for a full decode pass, and most sources never need it. Still nullable when
  // both paths fail.
  const frameCount = stream.frameCount ?? await probeFrameCount(sourcePath);
  const source = {
    width: stream.width,
    height: stream.height,
    fps: stream.fps,
    frameCount,
    durationSeconds,
    hasAudio: audio,
  };

  const alignment = method === 'ltx' ? planLtxAlignment(source) : null;
  const target = planTargetDimensions({ method, ...source, alignment });
  const runtime = method === 'ltx'
    ? describeLtxRuntime()
    : { id: LANCZOS_RUNTIME_ID, label: 'ffmpeg (Lanczos)', supported: true, installed: true, reason: null };
  const adapter = method === 'ltx' ? await describeLtxAdapter() : null;

  return {
    id: item.id,
    method,
    scale: UPSCALE_SCALE,
    alreadyUpscaled,
    source,
    target,
    alignment,
    runtime,
    adapter,
  };
}

// 2× upscale of an existing history item. Writes the upscaled clip to a new
// file (never overwrites the original) and inserts a new history entry pointing
// at it, so the user gets both versions side-by-side in the gallery. Doubles
// width and height; aspect-ratio is preserved exactly.
//
// `options.method` selects the pass: `'lanczos'` (the default, and what every
// pre-#6509 caller gets by omitting the bag) runs the historical ffmpeg filter
// inline. `'ltx'` is accepted by the contract but has no dispatch path until
// #6511 lands, so it fails fast with a capability error naming the runtime it
// would need rather than silently falling back to Lanczos.
//
// Returns the new history entry on success; throws ServerError on any
// missing-input / ffmpeg / file-system failure so the route can map it to
// a clean HTTP status.
export async function upscaleHistoryItem(historyId, options = {}) {
  const method = resolveMethod(options);
  const item = await resolveHistoryItem(historyId);
  if (item.upscaledFrom) {
    throw new ServerError('Cannot upscale an already-upscaled video', { status: 400, code: 'ALREADY_UPSCALED' });
  }
  if (method === 'ltx') {
    const runtime = describeLtxRuntime();
    const named = runtime.id ? `${runtime.label} (${runtime.id})` : `no runtime for ${process.platform}`;
    throw new ServerError(
      `Generative upscale is not available on this install: it needs ${named}, which has no upscale dispatch path yet.`,
      { status: 501, code: 'UNSUPPORTED_RUNTIME' },
    );
  }
  const sourcePath = resolveSourcePath(item);

  const newId = randomUUID();
  const newFilename = `${newId}.mp4`;
  const newPath = join(PATHS.videos, newFilename);
  // Wall-clock timing (#5878) for the pass the user actually waits through. An
  // upscale gets its own gallery card, so the ffmpeg pass is a real cost worth
  // reporting rather than leaving blank.
  const renderStartedAtMs = Date.now();
  // Copy first, then upscale-in-place — keeps the upscaler's atomic-rename
  // contract intact and means a mid-process kill leaves the source clip
  // untouched.
  await copyFileGuarded(sourcePath, newPath);
  console.log(`🔍 Upscaling video [${historyId.slice(0, 8)} → ${newId.slice(0, 8)}]: 2× ${method}`);
  const result = await upscaleVideo2x(newPath);
  if (!result.ok) {
    await unlinkGuarded(newPath).catch(() => {});
    throw new ServerError(`Upscale failed: ${result.reason}`, { status: 500, code: 'FFMPEG_FAILED' });
  }
  const thumbnail = await generateThumbnail(newPath, newId);
  // Build the new history entry from the original, but bump dimensions and
  // tag with `upscaledFrom: <id>` + a reusable suffix on the prompt so the
  // gallery row reads as "<original prompt> (2×)".
  const newEntry = {
    // Strip before the spread rather than relying on the override below to win:
    // `renderTimingFields` reports `{}` when it can't measure the span, and an
    // override that contributes no keys would silently leave the SOURCE render's
    // duration on a row that only ran an ffmpeg pass.
    ...omitRenderTiming(item),
    id: newId,
    filename: newFilename,
    width: (Number(item.width) || 0) * UPSCALE_SCALE,
    height: (Number(item.height) || 0) * UPSCALE_SCALE,
    thumbnail,
    createdAt: new Date().toISOString(),
    upscaledFrom: item.id,
    // Provenance (#6509): Lanczos is deterministic and seedless, and runs as an
    // ffmpeg filter rather than on a BYOV runtime. Recording both explicitly
    // keeps `upscaleMethod`/`upscaleRuntime` non-null on every upscaled row, so
    // a reader never has to infer "the old one" from an absent key once the
    // generative method starts writing its own.
    upscaleMethod: method,
    upscaleRuntime: LANCZOS_RUNTIME_ID,
    prompt: item.prompt ? `${item.prompt} (2×)` : '(upscaled 2×)',
    // Drop hidden so the upscaled version surfaces in the visible gallery
    // even when the source clip was hidden.
    hidden: false,
    ...renderTimingFields(renderStartedAtMs),
  };
  // Serialized append (re-reads inside the mutator) so a concurrent
  // download/render write can't drop the upscaled entry.
  await mutateVideoHistory((history) => { history.unshift(newEntry); return history; });
  console.log(`✅ Upscaled [${newId.slice(0, 8)}]: ${newFilename} (${newEntry.width}×${newEntry.height})`);
  return newEntry;
}
