/**
 * LoRA service — install/list/delete + sidecar metadata management.
 *
 * Files live in `data/loras/<filename>.safetensors`; metadata lives next to
 * them in `<filename>.metadata.json`. The sidecar is the source of truth for
 * Civitai-derived info (trigger words, base model, recommended weight,
 * preview image URL) — the .safetensors file alone has no such surface.
 *
 * Install flow: parse Civitai URL → fetch model metadata → pick version +
 * primary .safetensors → stream-download to disk → write sidecar. The whole
 * thing is one POST; progress is reported through the existing image-gen
 * SSE channel (TBD — for v1 the client polls).
 *
 * No try/catch — errors bubble. `downloadToFile` Range-resumes a leftover
 * `.partial` after a transport drop; a user-cancelled SSE disconnect still
 * discards it. listLoras() filters `.partial` files out by extension.
 */

import { existsSync } from 'fs';
import { link, readFile, rename, rm, stat, unlink } from 'fs/promises';
import { basename, join } from 'path';
import { ServerError } from '../lib/errorHandler.js';
import {
  assessDownloadPreflight,
  assertDownloadFits,
  etagPathFor,
  probeRemoteSize,
  siblingDownloadMeta,
  streamResumableDownload,
} from '../lib/downloadPreflight.js';
import { atomicWrite, assertSafeFilename, ensureDir, listDirectoryByExtension, sha256File, PATHS } from '../lib/fileUtils.js';
import { verifySafetensorsStructure } from '../lib/hfCache.js';
import { isPlainObject } from '../lib/objects.js';
import { readCachedLoraEffectReport } from '../lib/loraEffect.js';
import { createKeyedFileWriteQueue } from '../lib/fileWriteQueue.js';
import { createSingleFlight } from '../lib/singleFlight.js';
import {
  applyDownloadToken,
  baseModelToRunner,
  buildSidecar,
  detectEarlyAccess,
  fetchCivitaiModel,
  flux2VariantFromBaseModel,
  normalizeCivitaiImageUrl,
  parseCivitaiUrl,
  pickPrimaryFile,
  pickVersion,
  slugifyForFilename,
  stillPreviewUrl,
} from '../lib/civitai.js';
import {
  buildHfAuthHeaders,
  buildHfLoraSidecar,
  buildHfResolveUrl,
  detectHfLoraFamily,
  fetchHuggingfaceModel,
  HF_LORA_FAMILIES,
  parseHuggingfaceLoraRef,
  pickHfLoraFile,
} from '../lib/huggingfaceLora.js';
import { RUNNER_FAMILIES, composeCompatKey } from '../lib/runners.js';
import {
  classifyLoraKeyLayout,
  classifyLoraKeyLayoutFromHeader,
  detectFlux2VariantFromHeader,
  isKnownLoraKeyLayout,
  readSafetensorsHeader,
} from '../lib/safetensors.js';
import { getHfToken } from './hfToken.js';
import { getSettings } from './settings.js';

const SIDECAR_SUFFIX = '.metadata.json';

// listLoras() is called from several picker/setup paths. Cache the fully
// normalized public entry by the weight file's path plus weight/sidecar mtimes
// so repeated reads only pay the directory/stat pass, not one sidecar read (and
// potentially one safetensors header parse) per installed LoRA.
const loraMetadataCache = new Map();

// One install attempt per requested Civitai model version at a time. A duplicate
// submit shares the original result instead of racing it to the same destination
// files, while two explicitly different versions remain independent.
const civitaiInstalls = createSingleFlight();

const sidecarPath = (loraFilename) => join(PATHS.loras, `${loraFilename}${SIDECAR_SUFFIX}`);
const invalidateLoraMetadataCache = (filename) => {
  loraMetadataCache.delete(join(PATHS.loras, filename));
};

// Reads the sidecar JSON next to a LoRA file. Returns `null` when the
// sidecar is absent — calling code can fall back to filename inference for
// legacy LoRAs the user dropped in manually pre-Civitai. Permissions /
// I/O / parse errors get logged so an unreadable sidecar doesn't masquerade
// as a "legacy LoRA" in the manager UI.
export const readSidecar = async (filename) => {
  const path = sidecarPath(filename);
  const raw = await readFile(path, 'utf-8').catch((err) => {
    if (err?.code === 'ENOENT') return null;
    console.log(`⚠️ LoRA sidecar unreadable [${filename}]: ${err?.code || err?.message || err}`);
    return null;
  });
  if (raw == null) return null;
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (err) {
    console.log(`⚠️ LoRA sidecar malformed JSON [${filename}]: ${err?.message || err}`);
    return null;
  }
  return isPlainObject(parsed) ? parsed : null;
};

// Read the `triggerWords` of several LoRAs at once, keyed by basename — the
// input to the render-time trigger weave (`lib/loraTriggers.js`, #4665).
// `filenames` may mix bare basenames (the current client surface) and absolute
// paths (legacy sidecar replays); both collapse to the basename key. A LoRA
// with no sidecar, or a legacy sidecar predating `triggerWords`, simply gets no
// entry, so the weave is a no-op for it rather than an error.
export const readTriggerWordsByFilename = async (filenames) => {
  const names = [...new Set(
    (Array.isArray(filenames) ? filenames : [])
      .filter((f) => typeof f === 'string' && f)
      .map((f) => basename(f)),
  )];
  if (!names.length) return {};
  const sidecars = await Promise.all(names.map((n) => readSidecar(n)));
  return Object.fromEntries(
    names.map((n, i) => [n, sidecars[i]?.triggerWords]).filter(([, words]) => Array.isArray(words)),
  );
};

// License + source URL as recorded on the sidecar at install time (#5638).
// Missing/legacy sidecars contribute `{ license: null, sourceUrl: null }` so
// a render still stamps the LoRA id with unknown terms rather than skipping it.
export const readLoraLicensesByFilename = async (filenames) => {
  const names = [...new Set(
    (Array.isArray(filenames) ? filenames : [])
      .filter((f) => typeof f === 'string' && f)
      .map((f) => basename(f)),
  )];
  if (!names.length) return {};
  const sidecars = await Promise.all(names.map((n) => readSidecar(n)));
  return Object.fromEntries(names.map((n, i) => {
    const sc = sidecars[i] || {};
    const sourceUrl = sc.civitai?.url || sc.huggingface?.url || null;
    const license = typeof sc.license === 'string' && sc.license.trim() ? sc.license.trim() : null;
    return [n, { license, sourceUrl, name: sc.name || null }];
  }));
};

// Validate a basename so it can't escape PATHS.loras. Delegates to the
// shared `assertSafeFilename` helper in fileUtils.js (which also handles
// gallery .png assertions). Substring `..` is allowed because
// slugifyForFilename can produce names like `foo..bar` from non-ASCII input.
// `requiredMessage` preserves the historical "Filename required" wording
// (instead of the subject-derived "LoRA filename required") so any client
// or test that pattern-matches on the missing-input message keeps working.
export const assertSafeLoraFilename = (filename) => {
  assertSafeFilename(filename, {
    extensions: ['.safetensors'],
    subject: 'LoRA filename',
    requiredMessage: 'Filename required',
  });
};

// LoRAs without sidecars get a minimal "legacy" entry with sensible defaults
// so the manager UI can still render LoRAs the user dropped in pre-Civitai.
export const listLoras = async () => {
  if (!existsSync(PATHS.loras)) {
    loraMetadataCache.clear();
    return [];
  }
  const lorasStat = await stat(PATHS.loras).catch(() => null);
  if (!lorasStat || !lorasStat.isDirectory()) {
    loraMetadataCache.clear();
    console.log(`⚠️ PATHS.loras exists but is not a directory: ${PATHS.loras}`);
    return [];
  }
  // listDirectoryByExtension handles the readdir + extension filter + per-
  // entry stat + isFile check (so directories named `foo.safetensors` are
  // dropped before deleteLora would later trip on EISDIR).
  const out = await listDirectoryByExtension(PATHS.loras, {
    extensions: ['.safetensors'],
    mapEntry: async (filename, _fullPath, s) => {
      const sidecarStat = await stat(sidecarPath(filename)).catch(() => null);
      const cached = loraMetadataCache.get(_fullPath);
      if (cached?.mtimeMs === s.mtimeMs && cached?.sidecarMtimeMs === sidecarStat?.mtimeMs) {
        return cached.entry;
      }

      const sidecar = await readSidecar(filename);
      const fallbackName = filename.replace(/^lora-/, '').replace(/\.safetensors$/, '');
      // Re-derive runnerFamily from civitai.baseModel at read time so
      // sidecars written before a baseModelToRunner() mapping update (e.g.
      // an install before 'Ernie' was a recognized base) don't permanently
      // show as runnerFamily=null and leak across compat filters. Falls
      // back to the stored value for legacy LoRAs without civitai metadata.
      const baseModel = sidecar?.civitai?.baseModel;
      const runnerFamily = baseModel
        ? baseModelToRunner(baseModel)
        : (sidecar?.runnerFamily || null);
      // Fine-grained FLUX.2 size variant ('4b'/'9b'). Resolve in order:
      // stored sidecar value → Civitai baseModel string → the safetensors
      // header (ground truth for self-trained / hand-dropped LoRAs with no
      // Civitai metadata). Persist a header-detected value back so the header
      // is read at most once per LoRA. Mirrors the "re-derive runnerFamily on
      // read" healing above.
      //
      // Both header-derived fields below share ONE lazy header read (a LoRA
      // whose sidecar already answers never opens the file), and they heal the
      // sidecar through a SINGLE patch — two fire-and-forget patches would
      // read-modify-write the same sidecar concurrently and drop one field.
      let headerPromise = null;
      const readHeaderOnce = () => {
        if (!headerPromise) headerPromise = readSafetensorsHeader(_fullPath);
        return headerPromise;
      };
      const backfill = {};
      let fluxVariant = null;
      if (runnerFamily === RUNNER_FAMILIES.FLUX2) {
        fluxVariant = sidecar?.fluxVariant || flux2VariantFromBaseModel(baseModel);
        if (!fluxVariant) {
          fluxVariant = detectFlux2VariantFromHeader(await readHeaderOnce());
          if (fluxVariant) backfill.fluxVariant = fluxVariant;
        }
      }
      // Safetensors key layout ('bare'/'comfyui'/'diffusers'/'kohya'/
      // 'not_a_lora'). Backfilled for LoRAs installed before installs recorded
      // it. `null` means "couldn't read the header", which we deliberately
      // don't persist: it's not a classification, and a later read may succeed.
      // Validate the stored value: a sidecar hand-edited (or written by a
      // future version that knows a layout this one doesn't) must fall back to
      // re-classifying, not propagate a string nothing downstream understands.
      let keyLayout = isKnownLoraKeyLayout(sidecar?.keyLayout) ? sidecar.keyLayout : null;
      if (!keyLayout) {
        keyLayout = classifyLoraKeyLayoutFromHeader(await readHeaderOnce());
        if (keyLayout) backfill.keyLayout = keyLayout;
      }
      // Best-effort cache — never block or fail the list on a write error.
      if (Object.keys(backfill).length > 0) patchLoraSidecar(filename, backfill).catch(() => {});
      // The picker matches this against the selected model's `loraCompatKey`.
      // FLUX.2 → size-specific (or bare 'flux2' when size is unknown, so it
      // still shows for both sizes); every other family → its runner id.
      const loraCompatKey = composeCompatKey(runnerFamily, fluxVariant);
      const entry = {
        filename,
        name: sidecar?.name || fallbackName,
        sizeBytes: s.size,
        installedAt: sidecar?.installedAt || s.birthtime?.toISOString?.() || null,
        // sidecar fields surfaced for the picker / manager UI:
        civitai: sidecar?.civitai || null,
        // HF-installed video LoRAs carry this instead of `civitai` — the
        // manager matches curated video suggestions to installs by repo and
        // links the card out to HuggingFace.
        huggingface: sidecar?.huggingface || null,
        runnerFamily,
        fluxVariant,
        keyLayout,
        loraCompatKey,
        triggerWords: sidecar?.triggerWords || [],
        // Coerce non-finite values (NaN, Infinity, missing/malformed sidecar
        // fields) to the default — `?? 1.0` alone wouldn't catch NaN.
        recommendedScale: Number.isFinite(sidecar?.recommendedScale) ? sidecar.recommendedScale : 1.0,
        // Normalize on read so already-installed LoRAs (sidecars written
        // before the URL-normalize fix) also benefit without a reinstall.
        // stillPreviewUrl drops a video URL for the same reason: Civitai's
        // media list mixes clips in, and the card renders this in an <img>.
        previewImageUrl: normalizeCivitaiImageUrl(stillPreviewUrl(sidecar?.previewImageUrl)) || null,
        description: sidecar?.description || '',
        license: typeof sidecar?.license === 'string' && sidecar.license.trim() ? sidecar.license.trim() : null,
        // Trained-LoRA surfacing (sidecars written by services/loraTraining):
        // 'trained' source + the character identity block let the library UI
        // badge them and characterLoraResolver match them. Null for Civitai
        // installs and legacy drops.
        source: sidecar?.source || null,
        character: sidecar?.character || null,
        trainedFromDatasetId: sidecar?.datasetId || null,
        // Adapter-effect diagnostic (#4872). CACHED ONLY — listing the library
        // must never fan out into one Python child per installed LoRA, so this
        // surfaces whatever the explicit probe last measured and drops it when
        // the file has changed size underneath it. `null` = never measured (or
        // measured against a different file), which the UI shows as an offer to
        // run the check, not as a verdict.
        effectReport: readCachedLoraEffectReport(sidecar?.effectReport, { sizeBytes: s.size, mtimeMs: s.mtimeMs }),
      };
      loraMetadataCache.set(_fullPath, {
        mtimeMs: s.mtimeMs,
        sidecarMtimeMs: sidecarStat?.mtimeMs,
        entry,
      });
      return entry;
    },
  });
  const listedPaths = new Set(out.map(({ filename }) => join(PATHS.loras, filename)));
  for (const cachedPath of loraMetadataCache.keys()) {
    if (!listedPaths.has(cachedPath)) loraMetadataCache.delete(cachedPath);
  }
  return out.sort((a, b) => (b.installedAt || '').localeCompare(a.installedAt || ''));
};

export const getLora = async (filename) => {
  assertSafeLoraFilename(filename);
  const fullPath = join(PATHS.loras, filename);
  if (!existsSync(fullPath)) {
    throw new ServerError(`LoRA not found: ${filename}`, { status: 404, code: 'NOT_FOUND' });
  }
  const list = await listLoras();
  const lora = list.find((l) => l.filename === filename);
  if (!lora) {
    // File exists on disk but listLoras filtered it out — most likely because
    // it's not a regular .safetensors file (directory, symlink, etc.).
    throw new ServerError(
      `LoRA "${filename}" exists but is not a valid regular .safetensors file`,
      { status: 404, code: 'NOT_FOUND' },
    );
  }
  return lora;
};

export const deleteLora = async (filename) => {
  assertSafeLoraFilename(filename);
  const filePath = join(PATHS.loras, filename);
  await queueSidecarWrite(filename, async () => {
    if (!existsSync(filePath)) {
      throw new ServerError(`LoRA not found: ${filename}`, { status: 404, code: 'NOT_FOUND' });
    }
    const s = await stat(filePath).catch(() => null);
    if (!s || !s.isFile()) {
      throw new ServerError(
        `Cannot delete "${filename}": not a regular file`,
        { status: 400, code: 'INVALID_LORA_FILE' },
      );
    }

    // Capture metadata before removing it so a later model-unlink failure can
    // restore the usable pair. readFile also fails before model removal when a
    // malformed sidecar is a directory or otherwise unreadable.
    const metadataPath = sidecarPath(filename);
    const metadata = await readFile(metadataPath).then(
      (contents) => contents,
      (err) => (err.code === 'ENOENT' ? null : Promise.reject(err)),
    );
    if (metadata !== null) await rm(metadataPath);
    const modelRemovalError = await rm(filePath).then(() => null, (err) => err);
    if (modelRemovalError) {
      if (metadata !== null) await atomicWrite(metadataPath, metadata);
      throw modelRemovalError;
    }
    invalidateLoraMetadataCache(filename);
  });
  console.log(`🗑️ Deleted LoRA: ${filename}`);
  return { ok: true, filename };
};

// Patch the sidecar with user-editable fields (name, recommendedScale, notes).
// Civitai-derived fields are passed through but the route layer scopes the
// patch so callers can't trample those.
// One sidecar write at a time per LoRA. A patch is a read-modify-write of a
// whole JSON document, and there are several writers: the user renaming a LoRA
// in the manager, listLoras() healing keyLayout/fluxVariant on read, the effect
// probe caching its measurement when it finishes, and the two installers
// replacing the sidecar wholesale. Interleaved, the last write wins the whole
// file and silently drops the other's field — a re-install over an existing
// filename could have its fresh civitai block overwritten by a patch that read
// the pre-install sidecar. EVERY writer goes through here, not just patches, or
// the serialization is a half-measure. Keyed, so different LoRAs still run in
// parallel.
const queueSidecarWrite = createKeyedFileWriteQueue();

// Replace a sidecar wholesale (the install paths), serialized against patches.
export const writeLoraSidecar = (filename, sidecar) => queueSidecarWrite(filename, async () => {
  if (!existsSync(join(PATHS.loras, filename))) {
    throw new ServerError(`LoRA not found: ${filename}`, { status: 404, code: 'NOT_FOUND' });
  }
  await atomicWrite(sidecarPath(filename), JSON.stringify(sidecar, null, 2) + '\n');
  invalidateLoraMetadataCache(filename);
});

export const patchLoraSidecar = async (filename, patch) => {
  assertSafeLoraFilename(filename);
  const filePath = join(PATHS.loras, filename);
  // The read has to be INSIDE the queued cycle — reading before joining the
  // queue would merge against a snapshot the previous write already superseded.
  return queueSidecarWrite(filename, async () => {
    if (!existsSync(filePath)) {
      throw new ServerError(`LoRA not found: ${filename}`, { status: 404, code: 'NOT_FOUND' });
    }
    // Match getLora/deleteLora: refuse non-regular files (directory named
    // foo.safetensors, dangling symlink, etc.) so we don't quietly create a
    // sidecar for an entry that listLoras() will then filter out.
    const s = await stat(filePath).catch(() => null);
    if (!s || !s.isFile()) {
      throw new ServerError(
        `Cannot patch "${filename}": not a regular file`,
        { status: 400, code: 'INVALID_LORA_FILE' },
      );
    }
    const current = (await readSidecar(filename)) || { filename };
    const next = { ...current, ...patch, filename };
    await atomicWrite(sidecarPath(filename), JSON.stringify(next, null, 2) + '\n');
    invalidateLoraMetadataCache(filename);
    return next;
  });
};

// Stamp the classified safetensors key layout onto a freshly-built sidecar so
// consumers (the video-LoRA fusion gate) never have to re-read the header.
// Omits the field entirely when classification fails — a `null` there would be
// indistinguishable from "already classified as nothing" and would defeat the
// heal-on-read backfill in listLoras().
const withKeyLayout = async (sidecar, destPath) => {
  const keyLayout = await classifyLoraKeyLayout(destPath);
  return keyLayout ? { ...sidecar, keyLayout } : sidecar;
};

/**
 * Resolve one LoRA's safetensors key layout: the sidecar value when present,
 * else classified from the file header. Returns `null` when the header can't
 * be read (the "couldn't determine" sentinel — NOT `'not_a_lora'`).
 *
 * Deliberately does not persist a header-derived value: the callers are render
 * hot paths, and listLoras() already owns the backfill-and-cache duty.
 */
export const getLoraKeyLayout = async (filename) => {
  const sidecar = await readSidecar(filename);
  if (isKnownLoraKeyLayout(sidecar?.keyLayout)) return sidecar.keyLayout;
  return classifyLoraKeyLayout(join(PATHS.loras, filename));
};

// Resolve the active Civitai API key — either from settings (`civitai.apiKey`)
// or the CIVITAI_API_KEY env var. Settings wins so a user can override the
// env without restarting. Returns empty string for "no key", which the
// downstream helpers treat as anonymous.
export const resolveCivitaiKey = async () => {
  const env = (process.env.CIVITAI_API_KEY || '').trim();
  // getSettings reads the JSON every call; cheap and avoids stale-cache bugs.
  const s = await getSettings();
  const fromSettings = (s?.civitai?.apiKey || '').trim();
  return fromSettings || env || '';
};

// Stream-download a URL to `${destPath}.partial` then link/rename into place.
// A leftover `.partial` is Range-resumed on retry; a user-cancelled SSE
// disconnect still discards it. The `.partial` suffix keeps listLoras from
// picking up a half-written file. fetchImpl is injectable for tests.
// `onProgress({ received, total })` (optional) fires with byte counts during
// the stream download — the manager's streaming install endpoint forwards these
// as SSE `progress` frames so the UI can show a percentage. `total` is 0 when
// the response carries no Content-Length (chunked / some CDN redirects), in
// which case the client renders an indeterminate bar.
const downloadToFile = async (url, destPath, { fetchImpl = fetch, headers = {} , hasApiKey = false, source = 'civitai', onProgress = null, signal = null } = {}) => {
  const onHttpError = (res) => {
    if (res.status === 401 || res.status === 403) {
      if (source === 'huggingface') {
        const message = hasApiKey
          ? `HuggingFace rejected the download (${res.status}) even with your saved token — accept the model's license on its HF page, or the token may be expired/scoped.`
          : `HuggingFace download rejected (${res.status}) — this LoRA's repo is gated. Accept its license on HuggingFace and add your HF token in Image Gen settings, then retry.`;
        throw new ServerError(message, { status: res.status, code: 'HF_AUTH' });
      }
      const message = hasApiKey
        ? `Civitai rejected the download (${res.status}) even with your saved API key. The LoRA is likely in early-access (Civitai supporters only) or your key has expired/been revoked.`
        : `Civitai download rejected (${res.status}) — this LoRA may require an API key. Configure a Civitai API key in PortOS Settings (or set the CIVITAI_API_KEY env var) and retry.`;
      throw new ServerError(message, { status: res.status, code: 'CIVITAI_AUTH' });
    }
    const label = source === 'huggingface' ? 'HuggingFace' : 'Civitai';
    const code = source === 'huggingface' ? 'HF_DOWNLOAD_FAILED' : 'CIVITAI_DOWNLOAD_FAILED';
    throw new ServerError(`${label} download failed: ${res.status} ${res.statusText}`, { status: 502, code });
  };

  let lastEmit = 0;
  let lastTick = { received: 0, total: 0 };
  const { tmpPath } = await streamResumableDownload({
    url,
    destPath,
    headers,
    fetchImpl,
    signal,
    finalize: false,
    isCancelled: () => Boolean(signal?.aborted),
    onHttpError,
    onBytes: onProgress
      ? (received, total) => {
        lastTick = { received, total };
        const now = Date.now();
        if (now - lastEmit < 150) return;
        lastEmit = now;
        onProgress({ received, total });
      }
      : undefined,
  });
  // `finalize: false` means streamResumableDownload never had a chance to
  // clean up its own etag sidecar (that only happens on ITS finalize path).
  // Reaching here means the stream completed successfully — every branch
  // below either moves or deletes tmpPath outright, never leaves it for a
  // future resume, so the sidecar describing it is equally done.
  await rm(etagPathFor(destPath), { force: true }).catch(() => {});
  if (onProgress) onProgress(lastTick);
  // Atomic no-clobber finalize: `link` is POSIX-atomic and fails with EEXIST
  // when destPath already exists (concurrent install that snuck past our
  // pre-check). On success we unlink the tmp; on EEXIST we clean up and
  // throw CIVITAI_ALREADY_INSTALLED. For other link errors (cross-device
  // EXDEV, read-only fs, etc.) fall back to rename, which is the only
  // portable option on those platforms.
  const linkErr = await link(tmpPath, destPath).catch((e) => e);
  if (!linkErr) {
    await unlink(tmpPath).catch(() => {});
    return;
  }
  if (linkErr.code === 'EEXIST') {
    await rm(tmpPath, { force: true }).catch(() => {});
    const basename_ = basename(destPath);
    throw new ServerError(
      `Already installed: ${basename_}. Delete it first or pick a different version.`,
      { status: 409, code: 'CIVITAI_ALREADY_INSTALLED' },
    );
  }
  // EXDEV or similar — fall back to rename. Re-check destPath right before
  // the rename so a concurrent install that landed between our link attempt
  // and now can't be silently clobbered (POSIX rename overwrites). Treat
  // late-arriving dest as CIVITAI_ALREADY_INSTALLED, matching the EEXIST
  // path above.
  if (existsSync(destPath)) {
    await rm(tmpPath, { force: true }).catch(() => {});
    const basename_ = basename(destPath);
    throw new ServerError(
      `Already installed: ${basename_}. Delete it first or pick a different version.`,
      { status: 409, code: 'CIVITAI_ALREADY_INSTALLED' },
    );
  }
  await rename(tmpPath, destPath).catch(async (err) => {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  });
};

// After a LoRA finishes downloading, verify the on-disk `.safetensors` before
// we commit to it by writing the sidecar. A truncated (short download) or
// right-size-but-wrong-bytes file otherwise installs silently and renders
// garbage ("mosaic" output) at generate time — the leading non-Metal cause of
// corrupt output (issue #2199; mirrors the HF-cache integrity check in
// hfCache.js / #1324). Always runs the cheap structural header/size check
// (reads only the header region, never the multi-GB payload); adds a deep
// sha256 compare only when the source metadata carried a digest (Civitai
// `file.hashes.SHA256`). On any failure the file is deleted so the next install
// re-downloads instead of training/rendering against corrupt weights.
const verifyDownloadedLora = async (destPath, { expectedSha256 = null, source = 'civitai' } = {}) => {
  const label = source === 'huggingface' ? 'HuggingFace' : 'Civitai';
  const code = source === 'huggingface' ? 'HF_LORA_CORRUPT' : 'CIVITAI_LORA_CORRUPT';
  const st = await stat(destPath).catch(() => null);
  const structural = await verifySafetensorsStructure(destPath, st?.size ?? 0);
  if (!structural.ok) {
    await rm(destPath, { force: true }).catch(() => {});
    throw new ServerError(
      `${label} LoRA download is corrupt (${structural.reason}) — the partial file was deleted. Retry the install.`,
      { status: 502, code },
    );
  }
  // Civitai hashes are uppercase hex; sha256File returns lowercase — compare
  // case-insensitively and only when the digest is a well-formed sha256.
  const want = typeof expectedSha256 === 'string' ? expectedSha256.trim().toLowerCase() : '';
  if (/^[0-9a-f]{64}$/.test(want)) {
    const actual = await sha256File(destPath).catch(() => null);
    if (actual && actual.toLowerCase() !== want) {
      await rm(destPath, { force: true }).catch(() => {});
      throw new ServerError(
        `${label} LoRA failed SHA-256 verification (expected ${want.slice(0, 12)}…, got ${actual.slice(0, 12)}…) — the file was deleted. Retry the install.`,
        { status: 502, code },
      );
    }
  }
};

// Install a LoRA from a Civitai URL. Returns the new sidecar JSON so the
// client can render it immediately without a second list round-trip.
// Civitai's `type` casing varies in the wild (LORA / Lora / lora) and the
// family includes LoCon / LyCORIS / DoRA / LoHA — all of which load through
// diffusers' lora pipeline. Refuse only true non-LoRA checkpoints.
const ALLOWED_CIVITAI_LORA_TYPES = new Set(['lora', 'locon', 'lycoris', 'dora', 'loha']);

// Shared by performCivitaiInstall and previewCivitaiInstall so a preview can
// never promise a download the install would actually refuse — early-access
// gating, the LoRA-type check, and the missing-downloadUrl guard all throw
// from here now, instead of only guarding the real transfer.
const resolveCivitaiInstallPlan = async (input, { modelId, versionId, fetchImpl }) => {
  const apiKey = (typeof input?.apiKey === 'string' && input.apiKey.trim()) || (await resolveCivitaiKey());
  const model = await fetchCivitaiModel(modelId, { apiKey, fetchImpl });
  const version = pickVersion(model, versionId);
  // Refuse early-access versions up front. The download endpoint would
  // 401 even with a valid API key (only Civitai supporters can download
  // during the early-access window), and routing the user into the
  // "set API key" modal is misleading because their key isn't the issue.
  const ea = detectEarlyAccess(version);
  if (ea.early) {
    const when = ea.hoursRemaining != null
      ? (ea.hoursRemaining < 24
        ? `~${ea.hoursRemaining}h`
        : `~${Math.round(ea.hoursRemaining / 24)}d`)
      : 'soon';
    throw new ServerError(
      `"${model.name}" v${version.id} is in Civitai early-access — only Civitai supporters can download it for ${when} more${ea.endsAt ? ` (until ${ea.endsAt})` : ''}. Try again once it goes public.`,
      { status: 403, code: 'CIVITAI_EARLY_ACCESS' },
    );
  }
  const file = pickPrimaryFile(version);
  if (!file?.downloadUrl) {
    throw new ServerError(
      `Civitai version ${version?.id} has no downloadUrl — try selecting a different version`,
      { status: 422, code: 'CIVITAI_NO_DOWNLOAD' },
    );
  }
  if (model?.type && !ALLOWED_CIVITAI_LORA_TYPES.has(String(model.type).toLowerCase())) {
    throw new ServerError(
      `Civitai model "${model.name}" is type "${model.type}", not a LoRA — refusing to install`,
      { status: 400, code: 'CIVITAI_NOT_A_LORA' },
    );
  }

  // Build a stable filename: `lora-<slug>-<versionId>.safetensors`. The
  // versionId suffix prevents collisions if a user installs two versions of
  // the same model. The `lora-` prefix keeps it distinguishable from base
  // model weights if they ever coexist in the same dir.
  const slug = slugifyForFilename(model.name || file.name?.replace(/\.safetensors$/i, ''));
  const filename = `lora-${slug}-v${version.id}.safetensors`;
  const destPath = join(PATHS.loras, filename);
  const expectedBytes = Number(file.sizeKB) > 0 ? Number(file.sizeKB) * 1024 : 0;

  return { apiKey, model, version, file, filename, destPath, expectedBytes };
};

const performCivitaiInstall = async (input, { modelId, versionId, fetchImpl }) => {
  const plan = await resolveCivitaiInstallPlan(input, { modelId, versionId, fetchImpl });
  if (existsSync(plan.destPath)) {
    throw new ServerError(
      `Already installed: ${plan.filename}. Delete it first or pick a different version.`,
      { status: 409, code: 'CIVITAI_ALREADY_INSTALLED' },
    );
  }

  await ensureDir(PATHS.loras);
  assertDownloadFits(await assessDownloadPreflight({ destPath: plan.destPath, expectedBytes: plan.expectedBytes }));

  console.log(`📥 Installing Civitai LoRA: ${plan.model.name} v${plan.version.id} → ${plan.filename} (${plan.file.sizeKB ? Math.round(plan.file.sizeKB / 1024) + ' MB' : 'size unknown'})`);
  // Authenticate downloads via `?token=` only — the Authorization header
  // doesn't survive the 302 to CDN, AND sending both means the token also
  // ends up in CDN access logs. The metadata fetch (fetchCivitaiModel)
  // still uses the header since /api/v1/* doesn't redirect.
  const tokenized = applyDownloadToken(plan.file.downloadUrl, plan.apiKey);
  await downloadToFile(tokenized, plan.destPath, {
    fetchImpl,
    headers: { 'User-Agent': 'PortOS/civitai-installer' },
    hasApiKey: !!plan.apiKey,
  });
  await verifyDownloadedLora(plan.destPath, { expectedSha256: plan.file?.hashes?.SHA256 || null, source: 'civitai' });

  const sidecar = await withKeyLayout(
    buildSidecar({ model: plan.model, version: plan.version, file: plan.file, filename: plan.filename }),
    plan.destPath,
  );
  await writeLoraSidecar(plan.filename, sidecar);
  console.log(`✅ Installed Civitai LoRA: ${plan.filename} [layout=${sidecar.keyLayout || 'unknown'}]`);
  return sidecar;
};

export const installFromCivitai = async (input, { fetchImpl = fetch } = {}) => {
  const { modelId, versionId } = parseCivitaiUrl(input?.url);
  const installKey = `${modelId}:${versionId ?? 'latest'}`;
  return civitaiInstalls.run(
    installKey,
    () => performCivitaiInstall(input, { modelId, versionId, fetchImpl }),
  );
};

/** Size / dest / free-disk numbers for the LoRA confirm step — no transfer. */
export const previewCivitaiInstall = async (input, { fetchImpl = fetch } = {}) => {
  const { modelId, versionId } = parseCivitaiUrl(input?.url);
  const plan = await resolveCivitaiInstallPlan(input, { modelId, versionId, fetchImpl });
  const preflight = await assessDownloadPreflight({ destPath: plan.destPath, expectedBytes: plan.expectedBytes });
  return {
    kind: 'civitai',
    ...preflight,
    destPath: plan.filename,
    alreadyDownloaded: existsSync(plan.destPath),
  };
};

// Set of recognized LoRA families an HF import may target (image runners +
// video families). Used to validate a user-supplied `family` override.
const HF_LORA_FAMILY_VALUES = new Set(HF_LORA_FAMILIES);

// Shared by installFromHuggingface and previewHuggingfaceInstall so a preview
// can never show a different file/filename than the install it precedes.
// `family` is resolved (override → autodetection → null) but NOT required —
// it only narrows `pickHfLoraFile`'s pick among flux2 variant files; the
// generated filename depends only on `repo` + the picked `file`. Preview
// therefore never throws HF_UNKNOWN_FAMILY: that check belongs to the actual
// install, which needs a concrete family for the sidecar metadata.
// Neither caller threads a cancellation signal into this metadata lookup
// (only the actual byte-stream download gets one) — a stalled-but-reachable
// HF would otherwise hang a preview, or an install, indefinitely on this
// call alone.
const METADATA_FETCH_TIMEOUT_MS = 10_000;

const resolveHfLoraInstallPlan = async (input, { fetchImpl = fetch } = {}) => {
  const { repo, revision, file: parsedFile } = parseHuggingfaceLoraRef(input?.url);
  // Stored/env/CLI HF token — only needed for gated repos, but harmless to
  // send on public ones (HF ignores a bearer it doesn't require).
  const token = (typeof input?.token === 'string' && input.token.trim()) || (await getHfToken()) || '';
  const model = await fetchHuggingfaceModel(repo, {
    token, revision, fetchImpl, signal: AbortSignal.timeout(METADATA_FETCH_TIMEOUT_MS),
  });
  const preferredFile = input?.file || parsedFile || null;
  const detected = detectHfLoraFamily({ repo, model, file: preferredFile });

  // Family: explicit override (validated by the caller) wins over autodetection.
  const family = input?.family || detected?.family || null;

  const file = pickHfLoraFile(
    model,
    preferredFile,
    { family, fluxVariant: family === RUNNER_FAMILIES.FLUX2 ? (detected?.fluxVariant || null) : null },
  );
  const refined = preferredFile ? detected : detectHfLoraFamily({ repo, model, file });
  const fluxVariant = family === RUNNER_FAMILIES.FLUX2
    ? (refined?.fluxVariant || detected?.fluxVariant || null)
    : null;

  // Stable filename: `lora-<org>-<name>[-<file-variant>]-hf.safetensors`.
  // Canonical single-file names (pytorch_lora_weights / lora) keep the original
  // repo-only contract. Any other stem (CharacterSheet's QuadView_klein9b_v1,
  // a `_v2` artifact) gets a distinct suffix so siblings can coexist.
  const slug = slugifyForFilename(repo.replace('/', '-'));
  const repoNameSlug = slugifyForFilename((repo.split('/')[1] || repo).replace(/_/g, '-'));
  const pickedStem = file.replace(/\.safetensors$/i, '').split('/').pop();
  const fileStemSlug = slugifyForFilename(pickedStem.replace(/_/g, '-'));
  const isCanonicalStem = /^(pytorch_lora_weights|lora)$/i.test(pickedStem);
  const explicitVariant = isCanonicalStem
    ? ''
    : (fileStemSlug.startsWith(`${repoNameSlug}-`)
      ? fileStemSlug.slice(repoNameSlug.length + 1)
      : (fileStemSlug === repoNameSlug ? '' : fileStemSlug));
  const filename = `lora-${slug}${explicitVariant ? `-${explicitVariant}` : ''}-hf.safetensors`;
  const destPath = join(PATHS.loras, filename);
  const hfSibling = (Array.isArray(model?.siblings) ? model.siblings : []).find((row) => row?.rfilename === file);
  // The model-metadata response never carries per-sibling sizes without the
  // `blobs=true` expand we deliberately skip (see fetchHuggingfaceModel) —
  // siblingDownloadMeta is ~always 0 here. Without a real number the preflight
  // can never refuse an oversized LoRA, so probe the resolved file directly
  // (same fallback specDecodeModels.js already uses for GGUF weights).
  let expectedBytes = siblingDownloadMeta(hfSibling).bytes;
  if (!expectedBytes) {
    const probed = await probeRemoteSize(buildHfResolveUrl(repo, revision, file), {
      headers: buildHfAuthHeaders(token),
      fetchImpl,
      signal: AbortSignal.timeout(METADATA_FETCH_TIMEOUT_MS),
    });
    expectedBytes = probed.bytes;
  }

  return { repo, revision, token, model, family, fluxVariant, file, filename, destPath, expectedBytes };
};

// Install a LoRA from a HuggingFace repo (Flux.2 Klein image adapters, fal /
// Lightricks LTX video LoRAs, MiniMax H3). Mirrors installFromCivitai: parse
// the ref → fetch repo metadata → pick the .safetensors → stream-download →
// write the sidecar. The family is auto-detected from the repo id / tags /
// base_model / filenames, or taken from an explicit `input.family` override
// (validated against the known image + video families). Returns the new sidecar.
export const installFromHuggingface = async (input, { fetchImpl = fetch, onProgress = null, signal = null } = {}) => {
  // An unrecognized override is refused before the network round trip — a
  // wrongly-tagged LoRA would surface under a model it can't actually load.
  if (input?.family && !HF_LORA_FAMILY_VALUES.has(input.family)) {
    throw new ServerError(
      `Unknown LoRA family "${input.family}" — expected one of ${[...HF_LORA_FAMILY_VALUES].join(', ')}`,
      { status: 400, code: 'HF_BAD_FAMILY' },
    );
  }
  const plan = await resolveHfLoraInstallPlan(input, { fetchImpl });
  if (!plan.family) {
    throw new ServerError(
      `Couldn't determine a supported model for HuggingFace repo "${plan.repo}". PortOS can install Flux 2, Flux 1, Z-Image, ERNIE, HiDream, Qwen, LTX-Video, and MiniMax H3 LoRAs — pass an explicit family if you know which one this targets.`,
      { status: 422, code: 'HF_UNKNOWN_FAMILY' },
    );
  }
  if (existsSync(plan.destPath)) {
    throw new ServerError(
      `Already installed: ${plan.filename}. Delete it first to reinstall.`,
      { status: 409, code: 'HF_ALREADY_INSTALLED' },
    );
  }

  await ensureDir(PATHS.loras);
  assertDownloadFits(await assessDownloadPreflight({ destPath: plan.destPath, expectedBytes: plan.expectedBytes }));
  console.log(`📥 Installing HuggingFace LoRA: ${plan.repo} (${plan.file}) → ${plan.filename} [family=${plan.family}]`);
  await downloadToFile(buildHfResolveUrl(plan.repo, plan.revision, plan.file), plan.destPath, {
    fetchImpl,
    headers: { 'User-Agent': 'PortOS/hf-lora-installer', ...buildHfAuthHeaders(plan.token) },
    hasApiKey: !!plan.token,
    source: 'huggingface',
    onProgress,
    signal,
  });
  // HF's model metadata doesn't expose a per-file digest through pickHfLoraFile,
  // so the structural header/size check is the integrity guard here (no deep
  // sha256 compare available for this path).
  await verifyDownloadedLora(plan.destPath, { source: 'huggingface' });

  const sidecar = await withKeyLayout(
    buildHfLoraSidecar({ repo: plan.repo, revision: plan.revision, file: plan.file, model: plan.model, family: plan.family, filename: plan.filename, fluxVariant: plan.fluxVariant }),
    plan.destPath,
  );
  await writeLoraSidecar(plan.filename, sidecar);
  console.log(`✅ Installed HuggingFace LoRA: ${plan.filename} [layout=${sidecar.keyLayout || 'unknown'}]`);
  return sidecar;
};

/** Size / dest / free-disk numbers for the HF LoRA confirm step — mirrors the
 * exact file/filename installFromHuggingface will write, so the number shown
 * never disagrees with what installs. No transfer starts. */
export const previewHuggingfaceInstall = async (input, { fetchImpl = fetch } = {}) => {
  const plan = await resolveHfLoraInstallPlan(input, { fetchImpl });
  const preflight = await assessDownloadPreflight({ destPath: plan.destPath, expectedBytes: plan.expectedBytes });
  return {
    kind: 'huggingface',
    ...preflight,
    destPath: plan.filename,
    alreadyDownloaded: existsSync(plan.destPath),
  };
};
