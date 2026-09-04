/**
 * Slotstream weights — the one step of the runtime PortOS did not manage.
 *
 * `slotstreamServerManager.js` owns the process (install / start / stop / logs)
 * and it deliberately refuses to start without a cached checkpoint. Until this
 * module existed, the only answer it could offer was "place a checkpoint
 * directory in ~/.slotstream/models yourself" — a hand-assembled 100 GB+
 * directory, which is a dead end inside an app that manages everything else
 * about the runtime.
 *
 * A download still never happens implicitly. It moves tens of gigabytes and
 * only ever runs from a button the user pressed that names what it will fetch,
 * and a START still never fetches anything — this is its own explicit action.
 *
 * The transfer is PortOS's own resumable HTTP path (`streamResumableDownload`),
 * not a Python helper: Slotstream is a single native binary, and requiring an
 * image-gen venv for a text runtime's weights would be a strange dependency to
 * take on. Each file lands under the checkpoint directory the cache walk reads,
 * so a completed download is servable with no restart.
 */

import { rm, stat } from 'fs/promises';
import { join, resolve, sep } from 'path';
import { ServerError } from '../lib/errorHandler.js';
import {
  assessDownloadPreflight,
  assertDownloadFits,
  createDownloadSlot,
  partialPathFor,
  siblingDownloadMeta,
  streamResumableDownload,
} from '../lib/downloadPreflight.js';
import { buildHfAuthHeaders, buildHfResolveUrl, fetchHuggingfaceModel } from '../lib/huggingfaceLora.js';
import {
  SLOTSTREAM_CATALOG,
  resolveSlotstreamRepo,
  selectSlotstreamRepoFiles,
  slotstreamCatalogEntry,
  slotstreamModelDirName,
} from '../lib/slotstreamCatalog.js';
import { slotstreamCacheDir } from '../lib/slotstreamModels.js';
import { getHfToken } from './hfToken.js';

export { SLOTSTREAM_CATALOG };

/** A metadata lookup that only blocks the confirm modal needs its own bound. */
const METADATA_FETCH_TIMEOUT_MS = 15_000;

/**
 * The one download slot, keyed by checkpoint directory.
 *
 * `exclusive`: these are 100 GB+ reads of the same disk, and the card renders a
 * single progress bar fed by a single `slotstream:download` event — two
 * concurrent transfers would interleave frames on it and the first terminal
 * frame would tear down the other's bar. `matchNested`: the orphaned-partial
 * sweep asks about a SHARD one level below the checkpoint directory, so the
 * predicate has to match a path under a claimed key, not only the key itself.
 *
 * The stall watchdog is generous — a checkpoint this size legitimately runs for
 * hours while it IS receiving bytes — and env-overridable.
 */
const downloadSlot = createDownloadSlot({
  codePrefix: 'SLOTSTREAM',
  idleStallEnvVar: 'SLOTSTREAM_IDLE_STALL_MS',
  exclusive: true,
  matchNested: true,
  // A cancel here abandons a 100 GB+ multi-shard transfer, not one file: the
  // whole point of stopping a slow-but-alive download is to pick it back up, so
  // the shard in flight keeps its `.partial` the way a stall already does.
  // (Spec-decode deliberately discards instead — one GGUF the user gave up on.)
  keepPartialOnCancel: true,
  cancelledMessage: 'Download cancelled. Its progress is kept: pressing download again resumes from where it stopped.',
});

const cacheDirFor = (cacheDir) => cacheDir || slotstreamCacheDir();

/** The absolute checkpoint directory a repo occupies in the cache. */
export const slotstreamModelPath = (repo, { cacheDir } = {}) =>
  join(cacheDirFor(cacheDir), slotstreamModelDirName(repo));

function requireRepo(model) {
  const repo = resolveSlotstreamRepo(model);
  if (!repo) {
    throw new ServerError(
      `"${model}" is not a Slotstream checkpoint. Pick one from the catalog, or name a Hugging Face repo as owner/name.`,
      { status: 400, code: 'SLOTSTREAM_INVALID_MODEL' },
    );
  }
  return repo;
}

const hfDownloadHttpError = (res) => {
  if (res.status === 401 || res.status === 403) {
    throw new ServerError(
      `Hugging Face rejected the download (${res.status}) — this repo is gated. Accept its license on Hugging Face and add your HF token in Image Gen settings, then retry.`,
      { status: res.status, code: 'HF_AUTH' },
    );
  }
  throw new ServerError(`Hugging Face download failed: ${res.status} ${res.statusText}`, { status: 502, code: 'HF_DOWNLOAD_FAILED' });
};

const fileSize = async (path) => stat(path).then((s) => (s.isFile() ? s.size : 0), () => 0);

/**
 * Whether a file already at `destPath` can be trusted as finished.
 *
 * Only a length matching what the Hub advertises counts. A file of any other
 * length is a dead mid-file write — appending to it would corrupt the shard —
 * and a file whose size the Hub never reported cannot be checked at all, so
 * both are re-fetched rather than assumed complete. The plan and the download
 * loop ask this same question, so what is credited and what is skipped cannot
 * disagree.
 */
const isFinishedOnDisk = async (destPath, expectedBytes) =>
  expectedBytes > 0 && (await fileSize(destPath)) === expectedBytes;

/**
 * What this download would transfer, and what is already here.
 *
 * Two counts, deliberately kept apart. `finishedBytes` is files whose length
 * MATCHES what the Hub advertises — the only evidence a file is done, since a
 * leftover of any other length is a write that died mid-file and gets re-fetched
 * from scratch. `partialBytes` is what a `.partial` can resume from. Both credit
 * against the disk a run still needs (reserving the full repo again would make a
 * nearly-full volume refuse a resume it can actually finish), but only
 * `finishedBytes` may say a checkpoint is already downloaded: a full-size
 * `.partial` is a crash between the last byte and the rename, and calling that
 * "already on disk" would disable the very button that completes it.
 */
async function planRepoDownload({ repo, token, signal, cacheDir }) {
  const model = await fetchHuggingfaceModel(repo, { token, signal, blobs: true });
  const siblings = Array.isArray(model?.siblings) ? model.siblings : [];
  const files = selectSlotstreamRepoFiles(siblings);
  // A repo whose only surviving files are config/tokenizer would otherwise
  // produce a checkpoint directory with no weights in it — which the cache walk
  // would then report as servable, and a start would fail on.
  if (!files.some((file) => file.endsWith('.safetensors'))) {
    throw new ServerError(
      `Hugging Face repo ${repo} publishes no weights PortOS can stream — Slotstream reads .safetensors checkpoints.`,
      { status: 422, code: 'SLOTSTREAM_NO_WEIGHTS' },
    );
  }

  const metaByFile = new Map(
    siblings
      .filter((row) => typeof row?.rfilename === 'string')
      .map((row) => [row.rfilename, siblingDownloadMeta(row)]),
  );
  const modelDir = slotstreamModelPath(repo, { cacheDir });

  let totalBytes = 0;
  let finishedBytes = 0;
  let partialBytes = 0;
  const plan = [];
  for (const file of files) {
    const meta = metaByFile.get(file) || { bytes: 0, sha256: null };
    const destPath = join(modelDir, file);
    // Belt to the name filter's braces: whatever the Hub called this file, the
    // path it resolves to has to stay inside the checkpoint directory.
    if (!resolve(destPath).startsWith(`${resolve(modelDir)}${sep}`)) {
      throw new ServerError(
        `Hugging Face repo ${repo} lists a file whose path escapes the checkpoint directory.`,
        { status: 422, code: 'SLOTSTREAM_UNSAFE_FILENAME' },
      );
    }
    totalBytes += meta.bytes;
    if (await isFinishedOnDisk(destPath, meta.bytes)) finishedBytes += meta.bytes;
    else partialBytes += Math.min(await fileSize(partialPathFor(destPath)), meta.bytes);
    plan.push({ file, destPath, url: buildHfResolveUrl(repo, 'main', file), ...meta });
  }

  return { modelDir, files: plan, totalBytes, finishedBytes, partialBytes };
}

/**
 * Size / destination / free-disk numbers for the confirm step. Starts nothing.
 *
 * `expectedBytes` is the WHOLE checkpoint (what the user is committing to)
 * while the verdict is computed on what is actually left to move, so a resume
 * reads as "Size 123 GB / Still needed 4 GB" rather than being refused on a
 * disk that can finish it.
 */
export async function previewSlotstreamDownload({ model = null, cacheDir } = {}) {
  const repo = requireRepo(model);
  const token = await getHfToken();
  const plan = await planRepoDownload({
    repo,
    token,
    signal: AbortSignal.timeout(METADATA_FETCH_TIMEOUT_MS),
    cacheDir,
  });
  const remaining = Math.max(0, plan.totalBytes - plan.finishedBytes - plan.partialBytes);
  const assessment = await assessDownloadPreflight({ destPath: plan.modelDir, expectedBytes: remaining });

  return {
    kind: 'slotstream',
    ...assessment,
    // The confirm modal reads `expectedBytes` as "Size" and derives "Still
    // needed" from `requiredBytes`; reporting the remainder as the size would
    // hide how large the checkpoint actually is.
    expectedBytes: plan.totalBytes,
    destPath: plan.modelDir,
    repo,
    files: plan.files.length,
    // Finished files only — see planRepoDownload. This flag DISABLES Confirm,
    // so counting a `.partial` here would strand a resumable download.
    alreadyDownloaded: plan.totalBytes > 0 && plan.finishedBytes === plan.totalBytes,
  };
}

/**
 * Download one checkpoint into Slotstream's cache.
 *
 * Never throws for a transfer failure the caller has already streamed progress
 * for: the outcome is a value the route reports. An invalid request (unknown
 * model, a second press while one is running) still throws, because nothing has
 * been streamed yet.
 *
 * @param {{ model?: string|null, cacheDir?: string, onProgress?: (frame: object) => void }} [options]
 */
export async function downloadSlotstreamModel({ model = null, cacheDir, onProgress = () => {} } = {}) {
  const repo = requireRepo(model);
  const modelDir = slotstreamModelPath(repo, { cacheDir });
  // ONE checkpoint at a time, not one per checkpoint: these are 100 GB+ reads of
  // the same disk, and the card renders a single progress bar fed by a single
  // `slotstream:download` event — two concurrent transfers would interleave
  // frames on it and the first terminal frame would tear down the other's bar.
  // Claim the slot BEFORE the first await: resolving the repo is a round trip,
  // and a second press landing inside that window would clear the in-flight
  // check and start a parallel copy of the same 100 GB+ transfer.
  const slot = downloadSlot.claim(modelDir, {
    busyMessage: `${repo} is already downloading.`,
    otherBusyMessage: 'Another Slotstream checkpoint is already downloading — PortOS fetches one at a time.',
    meta: { repo },
  });

  const label = slotstreamCatalogEntry(repo)?.label || repo;
  const emitProgress = slot.throttle(onProgress);
  try {
    const token = await getHfToken();
    const headers = buildHfAuthHeaders(token);
    onProgress({ event: 'start', model: repo, message: `Resolving ${repo} on Hugging Face…` });
    slot.throwIfAborted();
    const plan = await planRepoDownload({ repo, token, signal: slot.signal, cacheDir });
    slot.throwIfAborted();
    const carried = plan.finishedBytes + plan.partialBytes;
    assertDownloadFits(await assessDownloadPreflight({
      destPath: plan.modelDir,
      expectedBytes: Math.max(0, plan.totalBytes - carried),
    }));

    console.log(`⬇️  Slotstream checkpoint download started: ${repo} (${plan.files.length} files, ${plan.totalBytes} bytes)`);
    onProgress({
      event: 'progress',
      model: repo,
      received: carried,
      total: plan.totalBytes,
      message: `Downloading ${label} — ${plan.files.length} files. This is a multi-gigabyte download and can take a while.`,
    });

    // Bytes already accounted for, so the bar reports progress through the whole
    // checkpoint rather than restarting at each file.
    let completedBytes = carried;
    for (const entry of plan.files) {
      if (await isFinishedOnDisk(entry.destPath, entry.bytes)) continue;
      // Anything else at the destination is a dead mid-file write (or a file
      // whose size the Hub never reported, so completeness is unknowable) —
      // a resume would append to the wrong prefix, so start that one over.
      // `force` makes this a no-op when nothing is there.
      await rm(entry.destPath, { force: true }).catch(() => {});

      const resumedFrom = await fileSize(partialPathFor(entry.destPath));
      const { bytes } = await streamResumableDownload({
        url: entry.url,
        headers,
        destPath: entry.destPath,
        expectedSha256: entry.sha256,
        onHttpError: hfDownloadHttpError,
        ...slot.downloadOptions(),
        onBytes: (received) => {
          // Clamped: a file whose size the Hub never reported contributes
          // nothing to `total` but real bytes as it lands, which would
          // otherwise walk the bar past 100%.
          const done = Math.min(plan.totalBytes, completedBytes + Math.max(0, received - resumedFrom));
          slot.track(done, plan.totalBytes);
          emitProgress({
            event: 'progress',
            model: repo,
            received: done,
            total: plan.totalBytes,
            message: `Downloading ${entry.file}`,
          });
        },
      });
      completedBytes += Math.max(0, bytes - resumedFrom);
    }

    console.log(`✅ Slotstream checkpoint ready: ${repo} → ${plan.modelDir}`);
    onProgress({
      event: 'complete',
      model: repo,
      received: plan.totalBytes,
      total: plan.totalBytes,
      message: `${label} downloaded`,
    });
    return {
      success: true,
      model: slotstreamModelDirName(repo),
      repo,
      path: plan.modelDir,
      files: plan.files.length,
      sizeBytes: plan.totalBytes,
    };
  } catch (err) {
    const error = slot.wrapError(err);
    if (slot.cancelled) {
      console.log(`⏹️ Slotstream checkpoint download cancelled: ${repo}`);
    } else {
      console.error(`❌ Slotstream checkpoint download failed for ${repo}: ${error.message}`);
    }
    // A cancel is not a failure the user needs a red toast for, but the bar
    // still has to come down — the card clears on any terminal frame, and
    // 'cancelled' is what tells it which happened.
    onProgress({
      event: slot.cancelled ? 'cancelled' : 'error',
      model: repo,
      message: error.message,
    });
    return { success: false, model: repo, cancelled: slot.cancelled, error: error.message, code: error.code || null };
  } finally {
    slot.release();
  }
}

/**
 * Stop the checkpoint download in progress. Returns false when none is running.
 *
 * A 100 GB+ transfer that is merely SLOW rather than silent never trips the idle
 * watchdog, so without this the only way out was to wait it out. The partial
 * files are kept — `streamResumableDownload` discards only the shard it was
 * mid-write on — so pressing download again resumes.
 *
 * `model` is optional: the slot holds one transfer at a time, so an omitted
 * model cancels whatever is running. A named model that is NOT the running one
 * cancels nothing rather than stopping someone else's transfer.
 */
export function cancelSlotstreamModelDownload({ model = null, cacheDir } = {}) {
  if (model == null) return downloadSlot.entries().some(([key]) => downloadSlot.cancel(key));
  return downloadSlot.cancel(slotstreamModelPath(requireRepo(model), { cacheDir }));
}

/** True while a checkpoint download is writing under `path` (or its `.partial`). */
export const isSlotstreamDownloadInFlight = (path) => downloadSlot.isInFlight(path);

/** Clears in-flight download bookkeeping (used by test suites). */
export const _resetSlotstreamDownloadsForTests = () => downloadSlot.reset();
