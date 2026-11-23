/**
 * Speculative-decoding weights: on-disk state + one-click Hugging Face download.
 *
 * The llama-server launcher names GGUF files it cannot produce — the weights are
 * a separate multi-gigabyte download — so before this module the only way to
 * learn a preset's file was missing was to press Start and read the 400. This
 * reports per-preset "downloaded / not downloaded" from disk and fetches the
 * missing file straight into the path the launcher will hand llama.cpp.
 *
 * A shipped preset path (`models/<file>`, no `..`) is downloaded into the
 * shared Hugging Face hub cache, and the returned path is that snapshot file.
 * An existing `models/<file>` is still the path status and launch report, so
 * an install that already points there keeps working. Any other path — an
 * absolute file, a hand-entered location — is read and written exactly as given.
 *
 * Path resolution is shared with llamaServerManager (`resolveSpecModelPath`) so
 * the download target and the launcher's existence check can never disagree
 * about which file a relative or `~`-prefixed path means.
 */

import { readdir, stat, unlink } from 'fs/promises';
import { join } from 'path';
import { getHfCacheRoot, repoToDirName } from '../lib/hfCache.js';
import { isProjectorName, isShardedGguf } from '../lib/localLlmDisk.js';
import { ServerError } from '../lib/errorHandler.js';
import { withAbortTimeout } from '../lib/abortTimeout.js';
import { anyAbortSignal } from '../lib/requestAbort.js';
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
import { getLlamaServerStatus } from './llamaServerManager.js';
import {
  SPEC_DECODE_PRESETS,
  SPEC_MODEL_ROLES,
  SPEC_ROLE_LABELS,
  findSpecDecodePreset,
  hfSearchUrl,
  resolveSpecModelPath,
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
 * True for a shipped preset path (`models/<file>`). Those are the downloads
 * that belong in the hub cache. Anything else is a path the user or a test
 * named explicitly, and is left alone.
 */
export const isShippedPresetModelsPath = (path) => {
  if (typeof path !== 'string') return false;
  const normalized = path.trim().replace(/\\/g, '/');
  if (!normalized.startsWith('models/')) return false;
  return !normalized.split('/').includes('..');
};

const fileStat = async (path) => {
  const stats = await stat(resolveSpecModelPath(path)).catch(() => null);
  return stats?.isFile() ? stats : null;
};

/** Revision directory PortOS writes when it downloads a preset GGUF itself. */
const PORTOS_SNAPSHOT = 'portos';

const hubPresetFile = (repo, filename) => join(
  getHfCacheRoot(),
  repoToDirName(repo),
  'snapshots',
  PORTOS_SNAPSHOT,
  filename,
);

/**
 * A GGUF already in some snapshot of `repo` that this role would select.
 * Directory reads only — status listing must not call Hugging Face.
 */
async function cachedPresetWeight(repo, { file, quant, role }) {
  if (!repo) return null;
  const snapshotsRoot = join(getHfCacheRoot(), repoToDirName(repo), 'snapshots');
  const entries = await readdir(snapshotsRoot, { withFileTypes: true }).catch((err) => (
    err?.code === 'ENOENT' || err?.code === 'ENOTDIR' ? [] : Promise.reject(err)
  ));
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = join(snapshotsRoot, entry.name);
    const info = await stat(full).catch(() => null);
    if (info?.isDirectory()) dirs.push({ full, mtimeMs: info.mtimeMs });
  }
  dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const dir of dirs) {
    const names = await readdir(dir.full).catch(() => []);
    let picked;
    try {
      picked = pickGgufSibling(
        { siblings: names.filter((name) => /\.gguf$/i.test(name)).map((rfilename) => ({ rfilename })) },
        { file, quant, repo, role },
      );
    } catch {
      continue;
    }
    const candidate = join(dir.full, picked);
    const info = await stat(candidate).catch(() => null);
    if (info?.isFile() && info.size > 0) return { path: candidate, sizeBytes: info.size, file: picked };
  }
  return null;
}

/**
 * Where this preset role's weight actually is.
 *
 * A file at the configured path wins, including a legacy `models/<file>`, so
 * an installed preset keeps launching the file it already points at. Otherwise
 * a matching hub snapshot is the weight. The download slot stays keyed by the
 * configured path either way, so cancel and the in-flight flag still match.
 */
async function locatePresetWeight(entry, role) {
  const configured = resolveSpecModelPath(entry.path);
  const legacy = await fileStat(entry.path);
  if (legacy) return { abs: configured, display: entry.path, size: legacy.size, inHub: false };
  if (isShippedPresetModelsPath(entry.path) && entry.repo) {
    const cached = await cachedPresetWeight(entry.repo, {
      file: entry.file, quant: entry.quant, role,
    }).catch(() => null);
    if (cached) return { abs: cached.path, display: cached.path, size: cached.sizeBytes, inHub: true, file: cached.file };
  }
  return { abs: configured, display: entry.path, size: null, inHub: false };
}

/** State of one preset role (base, drafter or vision projector) for the UI. */
const describeEntry = async (presetId, role) => {
  const entry = findSpecDecodePreset(presetId)?.[role];
  if (!entry?.path) return null;
  const slotKey = resolveSpecModelPath(entry.path);
  const located = await locatePresetWeight(entry, role);
  const active = downloadSlot.get(slotKey);
  return {
    role,
    path: located.size != null ? located.display : entry.path,
    exists: located.size != null,
    sizeBytes: located.size,
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
    // Keyed off the role list so a role added to the vocabulary is reported
    // without a fourth hand-written line here — `describeEntry` already returns
    // null for a preset that declares no weight for it.
    ...Object.fromEntries(await Promise.all(
      SPEC_MODEL_ROLES.map(async (role) => [role, await describeEntry(preset.id, role)]),
    )),
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
export function pickGgufSibling(model, { file, quant, repo, role = 'model' }) {
  const all = modelSiblingFilenames(model).filter((name) => /\.gguf$/i.test(name));
  if (!all.length) {
    throw new ServerError(`Hugging Face repo ${repo} publishes no .gguf file`, { status: 422, code: 'SPEC_NO_GGUF' });
  }
  const wantsProjector = role === 'projector';
  if (file) {
    const exact = all.find((name) => name === file);
    // A pin disambiguates WITHIN a role; it does not reassign the role. Before
    // the projector role existed, naming an `mmproj-` file by hand was the only
    // way to fetch one, so the pin was allowed to escape the filter below —
    // which now means a `model`-role pin could land a 629 MB vision sidecar in
    // the path the launcher hands `-m`, and llama-server would fail at load with
    // the file sitting there satisfying every existence check. The role has its
    // own entry now, so the escape hatch is closed rather than kept.
    if (exact && isProjectorName(exact) === wantsProjector) return exact;
    if (exact) {
      throw new ServerError(
        `The ${SPEC_ROLE_LABELS[role] || role} for this preset pins ${file}, which is ${wantsProjector ? 'not a projector (mmproj) sidecar' : 'a projector (mmproj) sidecar, not loadable weights'} — fix the preset entry rather than downloading it into that path.`,
        { status: 422, code: 'SPEC_FILE_ROLE_MISMATCH' },
      );
    }
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
  // The projector role and every other role want DISJOINT halves of the repo.
  // A projector ships under the target's own quant tag
  // (`mmproj-Muse-Glimmer-30B-Q4_K_M.gguf`, 1.4 GB) right beside the 17 GB target,
  // so for a language-weight role shortest-name-wins below would hand one back —
  // and it would then satisfy the launcher's existence check and fail at load.
  // For the `projector` role the same test inverts: the language packs are the
  // files that must not be selected. An explicit `file` still outranks the quant
  // hint — that is why the pin branch sits above — but it is held to this same
  // partition, so neither path can cross roles.
  const ggufs = all.filter((name) => isProjectorName(name) === wantsProjector);
  if (!ggufs.length) {
    throw new ServerError(
      wantsProjector
        ? `Hugging Face repo ${repo} publishes no projector (mmproj) sidecar — this model has no vision tower to load`
        : `Hugging Face repo ${repo} publishes only projector (mmproj) sidecars, not a loadable model`,
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

// Planning is short-lived whether it serves the preview or a confirmed download.
// Its deadline is separate from the transfer watchdog: multi-gigabyte weights may
// stream for hours, while metadata headers/body and the size fallback must settle.
const METADATA_FETCH_TIMEOUT_MS = 10_000;

const resolveSpecDownloadPlan = async ({ source, role, destPath, token, signal }) => {
  const headers = buildHfAuthHeaders(token);
  const { file, url, meta } = await withAbortTimeout(METADATA_FETCH_TIMEOUT_MS, async (deadline) => {
    const boundedSignal = anyAbortSignal([signal, deadline]);
    try {
      const model = await fetchHuggingfaceModel(source.repo, { token, signal: boundedSignal });
      const selectedFile = pickGgufSibling(model, { file: source.file, quant: source.quant, repo: source.repo, role });
      const selectedUrl = buildHfResolveUrl(source.repo, 'main', selectedFile);
      let selectedMeta = siblingDownloadMeta(siblingFor(model, selectedFile));
      if (!selectedMeta.bytes) {
        const probed = await probeRemoteSize(selectedUrl, { headers, signal: boundedSignal });
        boundedSignal.throwIfAborted();
        selectedMeta = { bytes: probed.bytes || selectedMeta.bytes, sha256: selectedMeta.sha256 || probed.sha256 };
      }
      return { file: selectedFile, url: selectedUrl, meta: selectedMeta };
    } catch (err) {
      if (deadline.aborted && !signal?.aborted) {
        throw new ServerError(
          `Hugging Face metadata lookup for ${source.repo} timed out — retry the download.`,
          { status: 504, code: 'SPEC_METADATA_TIMEOUT' },
        );
      }
      throw err;
    }
  });
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
      `No Hugging Face source is registered for that preset's ${SPEC_ROLE_LABELS[role]} — download it manually and point the field at the file.`,
      { status: 400, code: 'SPEC_NO_SOURCE' },
    );
  }

  const slotKey = resolveSpecModelPath(source.path);
  const existing = await locatePresetWeight(source, role);
  if (existing.size != null) {
    return { success: true, alreadyDownloaded: true, path: existing.display, sizeBytes: existing.size, file: existing.file || null };
  }
  // Claim the slot BEFORE the first await. Resolving the repo on Hugging Face
  // takes a round trip, and a second click (or a second tab) landing inside that
  // window would clear the in-flight check and start a parallel multi-gigabyte
  // transfer of the same file. The slot stays keyed by the configured path even
  // when the bytes land in the hub cache, so cancel and the downloading flag
  // still match. Everything after this point runs inside the try/finally so the
  // claim is always released.
  const slot = downloadSlot.claim(slotKey, {
    busyMessage: `${source.path} is already downloading`,
    meta: { presetId, role },
  });

  const emitProgress = slot.throttle((received, total) => {
    onProgress({ event: 'progress', presetId, role, path: source.path, received, total });
  });
  try {
    const token = await getHfToken();
    slot.throwIfAborted();
    const raced = await locatePresetWeight(source, role);
    if (raced.size != null) {
      return { success: true, alreadyDownloaded: true, path: raced.display, sizeBytes: raced.size, file: raced.file || null };
    }
    onProgress({ event: 'start', presetId, role, path: source.path, message: `Resolving ${source.repo} on Hugging Face…` });
    const plan = await resolveSpecDownloadPlan({
      source,
      role,
      destPath: slotKey,
      token,
      signal: slot.signal,
    });
    slot.throwIfAborted();
    // Shipped `models/<file>` presets land in the hub cache. The preflight
    // above measured the configured path; remeasure the directory that will
    // actually receive the file.
    const writePath = isShippedPresetModelsPath(source.path)
      ? hubPresetFile(source.repo, plan.file)
      : slotKey;
    const preflight = writePath === slotKey
      ? plan.preflight
      : await assessDownloadPreflight({ destPath: writePath, expectedBytes: plan.meta.bytes });
    assertDownloadFits(preflight);
    const storedPath = writePath === slotKey ? source.path : writePath;
    console.log(`⬇️  Downloading speculative-decoding weights ${source.repo}/${plan.file}${writePath === slotKey ? ` → ${source.path}` : ' into the hub cache'}`);
    const { bytes } = await streamToFile({
      url: plan.url,
      headers: plan.headers,
      destPath: writePath,
      expectedSha256: plan.meta.sha256,
      slot,
      onBytes: (received, total) => {
        slot.track(received, total);
        emitProgress(received, total);
      },
    });
    onProgress({ event: 'complete', presetId, role, path: storedPath, received: bytes, total: bytes, message: `${plan.file} downloaded` });
    console.log(`✅ Speculative-decoding weights ready: ${source.repo}/${plan.file} (${bytes} bytes)`);
    return { success: true, path: storedPath, repo: source.repo, file: plan.file, sizeBytes: bytes };
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
      `No Hugging Face source is registered for that preset's ${SPEC_ROLE_LABELS[role]} — download it manually and point the field at the file.`,
      { status: 400, code: 'SPEC_NO_SOURCE' },
    );
  }
  const slotKey = resolveSpecModelPath(source.path);
  const existing = await locatePresetWeight(source, role);
  if (existing.size != null) {
    return {
      kind: 'spec-decode',
      destPath: existing.display,
      expectedBytes: existing.size,
      requiredBytes: 0,
      headroomBytes: 0,
      freeBytes: null,
      verdict: 'ok',
      alreadyDownloaded: true,
      provider: 'Hugging Face',
      model: source.repo,
      file: existing.file || null,
    };
  }
  const token = await getHfToken();
  const plan = await resolveSpecDownloadPlan({ source, role, destPath: slotKey, token });
  const destPath = isShippedPresetModelsPath(source.path)
    ? hubPresetFile(source.repo, plan.file)
    : source.path;
  const preflight = destPath === source.path
    ? plan.preflight
    : await assessDownloadPreflight({ destPath, expectedBytes: plan.meta.bytes });
  return {
    kind: 'spec-decode',
    file: plan.file,
    alreadyDownloaded: false,
    provider: 'Hugging Face',
    model: source.repo,
    ...preflight,
    destPath,
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


/**
 * Delete one preset role's on-disk GGUF — the "unload this method" cleanup
 * counterpart to `downloadSpecDecodeModel`. Refuses while that same file is
 * mid-download (cancel it first) or while llama-server is running it (stop it
 * first) — both guards belong here rather than at the route, so any other
 * caller of this function inherits them too.
 *
 * `llamaServerManager.js` imports `resolveSpecModelPath` from this module at
 * the top level, so a static import back would be circular; importing it
 * lazily inside the function reaches the same module once both are loaded
 * without introducing that cycle (server/AGENTS.md "Import scoping").
 */
export async function removeSpecDecodeModel({ presetId, role }) {
  if (!SPEC_MODEL_ROLES.includes(role)) {
    throw new ServerError(`Unknown model role "${role}"`, { status: 400 });
  }
  const entry = findSpecDecodePreset(presetId)?.[role];
  if (!entry?.path) {
    throw new ServerError('No weight is configured for that preset role', { status: 400 });
  }
  const slotKey = resolveSpecModelPath(entry.path);
  if (downloadSlot.get(slotKey)) {
    throw new ServerError(
      `${entry.path} is still downloading — cancel the download before deleting it`,
      { status: 409, code: 'SPEC_DOWNLOAD_ACTIVE' },
    );
  }
  const located = await locatePresetWeight(entry, role);
  const status = await getLlamaServerStatus();
  const runningPath = status?.config?.[role];
  if (status?.running && runningPath && resolveSpecModelPath(runningPath) === located.abs) {
    throw new ServerError(
      'Stop llama-server before deleting the weights it is currently running',
      { status: 409, code: 'SPEC_MODEL_IN_USE' },
    );
  }
  if (located.size == null) {
    return { success: true, deleted: false, path: entry.path };
  }
  await unlink(located.abs);
  console.log(`🗑️  Deleted speculative-decoding weights: ${entry.repo || entry.path}`);
  return { success: true, deleted: true, path: located.display };
}

/** Clears in-flight download bookkeeping (used by test suites). */
export const _resetSpecDecodeDownloadsForTests = () => downloadSlot.reset();
