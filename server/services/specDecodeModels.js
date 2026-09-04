/**
 * Speculative-decoding weights: on-disk state + one-click Hugging Face download.
 *
 * The llama-server launcher names GGUF files it cannot produce — the weights are
 * a separate multi-gigabyte download — so before this module the only way to
 * learn a preset's file was missing was to press Start and read the 400. This
 * reports per-preset "downloaded / not downloaded" from disk and fetches the
 * missing file straight into the path the launcher will hand llama.cpp.
 *
 * Path resolution is shared with llamaServerManager (`resolveSpecModelPath`) so
 * the download target and the launcher's existence check can never disagree
 * about which file a relative or `~`-prefixed path means.
 */

import { stat } from 'fs/promises';
import { resolve } from 'path';
import { expandHome } from '../lib/fileUtils.js';
import { isProjectorName, isShardedGguf } from '../lib/localLlmDisk.js';
import { ServerError } from '../lib/errorHandler.js';
import {
  assessDownloadPreflight,
  assertDownloadFits,
  createDownloadSlot,
  probeRemoteSize,
  siblingDownloadMeta,
  streamResumableDownload,
} from '../lib/downloadPreflight.js';
import { buildHfAuthHeaders, buildHfResolveUrl, fetchHuggingfaceModel, modelSiblingFilenames } from '../lib/huggingfaceLora.js';
import { getHfToken } from './hfToken.js';
import {
  SPEC_DECODE_PRESETS,
  SPEC_MODEL_ROLES,
  findSpecDecodePreset,
  hfSearchUrl,
  specDecodeSource,
} from '../lib/specDecodePresets.js';

// Downloads in flight, keyed by RESOLVED destination path (two presets can name
// the same base model, and both must show the one transfer rather than starting
// a second copy of it). The stall timeout stays intentionally generous and
// env-configurable for slow Hugging Face/CDN handshakes.
const downloadSlot = createDownloadSlot({
  codePrefix: 'SPEC',
  idleStallEnvVar: 'SPEC_DECODE_IDLE_STALL_MS',
  stalledMessage: (minutes) => (
    `Download stalled — no bytes received for ${minutes} minute${minutes === 1 ? '' : 's'}; cancelled so another model can download`
  ),
});

/**
 * Absolute path a launcher field refers to. Relative paths resolve against the
 * server's cwd — the cwd llama-server inherits — and `~` is expanded here
 * because `spawn` performs no shell expansion.
 */
export const resolveSpecModelPath = (path) => resolve(expandHome(String(path || '').trim()));

const fileStat = async (path) => {
  const stats = await stat(resolveSpecModelPath(path)).catch(() => null);
  return stats?.isFile() ? stats : null;
};

/** State of one preset role (base or drafter) for the UI. */
const describeEntry = async (presetId, role) => {
  const entry = findSpecDecodePreset(presetId)?.[role];
  if (!entry?.path) return null;
  const destPath = resolveSpecModelPath(entry.path);
  const stats = await stat(destPath).catch(() => null);
  const active = downloadSlot.get(destPath);
  return {
    role,
    path: entry.path,
    exists: Boolean(stats?.isFile()),
    sizeBytes: stats?.isFile() ? stats.size : null,
    repo: entry.repo || null,
    repoUrl: entry.repo ? `https://huggingface.co/${entry.repo}` : hfSearchUrl(entry.path),
    downloadable: Boolean(entry.repo),
    downloading: Boolean(active),
    received: active?.received ?? null,
    total: active?.total ?? null,
  };
};

/**
 * Every preset with its weights' on-disk state. Disk + in-memory only — listing
 * the launcher must never reach out to Hugging Face (or any provider) on its own.
 */
export async function getSpecDecodePresetStatus() {
  return Promise.all(SPEC_DECODE_PRESETS.map(async (preset) => ({
    id: preset.id,
    label: preset.label,
    specType: preset.specType,
    model: await describeEntry(preset.id, 'model'),
    draftModel: await describeEntry(preset.id, 'draftModel'),
  })));
}

// A quant hint matches loosely: repos publish `…-Q4_K_M.gguf`, `….q4_k_m.gguf`
// and `…-Q4_K_M-00001-of-00002.gguf` for the same build.
const normalize = (text) => String(text).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Choose which `.gguf` sibling of the repo to fetch.
 *
 * Sharded (multi-part) builds are refused rather than half-downloaded: llama.cpp
 * wants every part, and a lone `-00001-of-00003.gguf` on disk would satisfy the
 * launcher's existence check and then fail at load time — the exact confusion
 * this whole module exists to remove.
 */
export function pickGgufSibling(model, { file, quant, repo }) {
  const all = modelSiblingFilenames(model).filter((name) => /\.gguf$/i.test(name));
  if (!all.length) {
    throw new ServerError(`Hugging Face repo ${repo} publishes no .gguf file`, { status: 422, code: 'SPEC_NO_GGUF' });
  }
  if (file) {
    const exact = all.find((name) => name === file);
    if (exact) return exact;
    // A pin is authoritative, never a preference: a preset carries `file` only
    // because its repo's quant tag CANNOT discriminate the target (Muse-Glimmer
    // tags the projector and the drafter Q4_K_M too). Falling through to the
    // quant hint there would reinstate the very ambiguity the pin removes — and
    // land a 1.6 GB drafter in the base model's path. Fail with something the
    // user can act on instead.
    throw new ServerError(
      `Hugging Face repo ${repo} no longer publishes the pinned file ${file} — pick the replacement at https://huggingface.co/${repo} and set the path by hand.`,
      { status: 422, code: 'SPEC_FILE_MISSING' },
    );
  }
  // A projector ships under the target's own quant tag
  // (`mmproj-Muse-Glimmer-30B-Q4_K_M.gguf`, 1.4 GB) right beside the 17 GB target,
  // so shortest-name-wins below would hand one back — and it would then satisfy
  // the launcher's existence check and fail at load. Only an explicit `file` may
  // name one, which is why this filter sits after the exact-match branch.
  const ggufs = all.filter((name) => !isProjectorName(name));
  if (!ggufs.length) {
    throw new ServerError(
      `Hugging Face repo ${repo} publishes only projector (mmproj) sidecars, not a loadable model`,
      { status: 422, code: 'SPEC_NO_GGUF' },
    );
  }
  const whole = ggufs.filter((name) => !isShardedGguf(name));
  const wanted = quant ? normalize(quant) : null;
  const matches = wanted ? whole.filter((name) => normalize(name).includes(wanted)) : whole;
  if (matches.length) {
    // Shortest name wins among equals: `Qwen3.8-27B-Q4_K_M.gguf` over a
    // `…-Q4_K_M-abliterated.gguf` variant that also carries the quant.
    return [...matches].sort((a, b) => a.length - b.length)[0];
  }
  if (whole.length) {
    throw new ServerError(
      `Hugging Face repo ${repo} has no ${quant} build — available: ${whole.slice(0, 6).join(', ')}`,
      { status: 422, code: 'SPEC_QUANT_MISSING' },
    );
  }
  throw new ServerError(
    `Hugging Face repo ${repo} publishes only sharded (multi-part) GGUFs, which PortOS can't assemble. Download it manually from https://huggingface.co/${repo}.`,
    { status: 422, code: 'SPEC_SHARDED_GGUF' },
  );
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

const streamToFile = async ({ url, headers, destPath, onBytes, expectedSha256, slot }) => (
  streamResumableDownload({
    url,
    headers,
    destPath,
    onBytes,
    expectedSha256,
    onHttpError: hfDownloadHttpError,
    ...slot.downloadOptions(),
  })
);

const siblingFor = (model, filename) => {
  const siblings = Array.isArray(model?.siblings) ? model.siblings : [];
  return siblings.find((row) => row?.rfilename === filename) || null;
};

// The preview path (previewSpecDecodeDownload) calls this with no signal —
// a real download's own abort chain covers the actual transfer, but a
// metadata/size lookup that just blocks the confirm modal needs its own
// bound, or a stalled-but-reachable HF hangs the preview indefinitely.
const METADATA_FETCH_TIMEOUT_MS = 10_000;

const resolveSpecDownloadPlan = async ({ source, destPath, token, signal }) => {
  const boundedSignal = signal || AbortSignal.timeout(METADATA_FETCH_TIMEOUT_MS);
  const headers = buildHfAuthHeaders(token);
  const model = await fetchHuggingfaceModel(source.repo, { token, signal: boundedSignal });
  const file = pickGgufSibling(model, { file: source.file, quant: source.quant, repo: source.repo });
  const url = buildHfResolveUrl(source.repo, 'main', file);
  let meta = siblingDownloadMeta(siblingFor(model, file));
  if (!meta.bytes) {
    const probed = await probeRemoteSize(url, { headers, signal: boundedSignal });
    meta = { bytes: probed.bytes || meta.bytes, sha256: meta.sha256 || probed.sha256 };
  }
  const preflight = await assessDownloadPreflight({ destPath, expectedBytes: meta.bytes });
  return { file, url, headers, meta, preflight };
};

/**
 * Download one preset role's GGUF into the path the launcher expects.
 *
 * @param {{ presetId: string, role: string, onProgress?: (frame: object) => void }} params
 */
export async function downloadSpecDecodeModel({ presetId, role, onProgress = () => {} }) {
  if (!SPEC_MODEL_ROLES.includes(role)) {
    throw new ServerError(`Unknown model role "${role}"`, { status: 400 });
  }
  const source = specDecodeSource(presetId, role);
  if (!source) {
    throw new ServerError(
      `No Hugging Face source is registered for that preset's ${role === 'model' ? 'base model' : 'drafter'} — download it manually and point the field at the file.`,
      { status: 400, code: 'SPEC_NO_SOURCE' },
    );
  }

  const destPath = resolveSpecModelPath(source.path);
  const existing = await fileStat(source.path);
  if (existing) {
    return { success: true, alreadyDownloaded: true, path: source.path, sizeBytes: existing.size };
  }
  // Claim the slot BEFORE the first await. Resolving the repo on Hugging Face
  // takes a round trip, and a second click (or a second tab) landing inside that
  // window would clear the in-flight check and start a parallel multi-gigabyte
  // transfer of the same file. Everything after this point runs inside the
  // try/finally so the claim is always released.
  const slot = downloadSlot.claim(destPath, {
    busyMessage: `${source.path} is already downloading`,
    meta: { presetId, role },
  });

  const emitProgress = slot.throttle((received, total) => {
    onProgress({ event: 'progress', presetId, role, path: source.path, received, total });
  });
  try {
    const token = await getHfToken();
    slot.throwIfAborted();
    onProgress({ event: 'start', presetId, role, path: source.path, message: `Resolving ${source.repo} on Hugging Face…` });
    const plan = await resolveSpecDownloadPlan({
      source,
      destPath,
      token,
      signal: slot.signal,
    });
    slot.throwIfAborted();
    assertDownloadFits(plan.preflight);
    console.log(`⬇️  Downloading speculative-decoding weights ${source.repo}/${plan.file} → ${source.path}`);
    const { bytes } = await streamToFile({
      url: plan.url,
      headers: plan.headers,
      destPath,
      expectedSha256: plan.meta.sha256,
      slot,
      onBytes: (received, total) => {
        slot.track(received, total);
        emitProgress(received, total);
      },
    });
    onProgress({ event: 'complete', presetId, role, path: source.path, received: bytes, total: bytes, message: `${source.path} downloaded` });
    console.log(`✅ Speculative-decoding weights ready: ${source.path} (${bytes} bytes)`);
    return { success: true, path: source.path, repo: source.repo, file: plan.file, sizeBytes: bytes };
  } catch (err) {
    const error = slot.wrapError(err);
    const event = slot.cancelled ? 'cancelled' : 'error';
    onProgress({ event, presetId, role, path: source.path, message: error.message });
    if (slot.cancelled) {
      console.log(`⏹️ Speculative-decoding download cancelled: ${source.path}`);
    } else {
      console.error(`❌ Speculative-decoding download failed for ${source.path}: ${error.message}`);
    }
    throw error;
  } finally {
    slot.release();
  }
}

/**
 * Size / dest / free-disk numbers for the confirm step — no transfer starts.
 * `alreadyDownloaded` short-circuits the confirm; `verdict: insufficient`
 * is returned rather than thrown so the UI can disable Confirm instead of
 * toasting a failure the user hasn't committed to yet.
 */
export async function previewSpecDecodeDownload({ presetId, role }) {
  if (!SPEC_MODEL_ROLES.includes(role)) {
    throw new ServerError(`Unknown model role "${role}"`, { status: 400 });
  }
  const source = specDecodeSource(presetId, role);
  if (!source) {
    throw new ServerError(
      `No Hugging Face source is registered for that preset's ${role === 'model' ? 'base model' : 'drafter'} — download it manually and point the field at the file.`,
      { status: 400, code: 'SPEC_NO_SOURCE' },
    );
  }
  const destPath = resolveSpecModelPath(source.path);
  const existing = await fileStat(source.path);
  if (existing) {
    return {
      kind: 'spec-decode',
      destPath: source.path,
      expectedBytes: existing.size,
      requiredBytes: 0,
      headroomBytes: 0,
      freeBytes: null,
      verdict: 'ok',
      alreadyDownloaded: true,
      file: null,
    };
  }
  const token = await getHfToken();
  const plan = await resolveSpecDownloadPlan({ source, destPath, token });
  return {
    kind: 'spec-decode',
    file: plan.file,
    alreadyDownloaded: false,
    ...plan.preflight,
    destPath: source.path,
  };
}

/** Cancel one active curated GGUF download. Returns false when none is active. */
export function cancelSpecDecodeModelDownload({ presetId, role }) {
  if (!SPEC_MODEL_ROLES.includes(role)) {
    throw new ServerError(`Unknown model role "${role}"`, { status: 400 });
  }
  const source = specDecodeSource(presetId, role);
  if (!source) return false;
  return downloadSlot.cancel(resolveSpecModelPath(source.path));
}

/** True while a curated GGUF download is writing `destPath` (or its `.partial`). */
export const isSpecDecodeDownloadInFlight = (destPath) => downloadSlot.isInFlight(destPath);

/** Clears in-flight download bookkeeping (used by test suites). */
export const _resetSpecDecodeDownloadsForTests = () => downloadSlot.reset();
