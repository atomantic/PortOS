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
 * No try/catch — errors bubble. Stream-failure cleanup is handled inline by
 * downloadToFile's pipeline().catch (the .partial gets unlinked on network
 * drops, disk full, etc.); only a process crash or power loss can leave a
 * .partial behind, and listLoras() filters those out by extension.
 */

import { existsSync } from 'fs';
import { link, readFile, rename, rm, stat, unlink } from 'fs/promises';
import { createWriteStream } from 'fs';
import { randomBytes } from 'crypto';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { basename, join } from 'path';
import { ServerError } from '../lib/errorHandler.js';
import { atomicWrite, assertSafeFilename, ensureDir, listDirectoryByExtension, PATHS } from '../lib/fileUtils.js';
import { isPlainObject } from '../lib/objects.js';
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
} from '../lib/civitai.js';
import {
  buildHfAuthHeaders,
  buildHfLoraSidecar,
  buildHfResolveUrl,
  detectVideoLoraFamily,
  fetchHuggingfaceModel,
  parseHuggingfaceLoraRef,
  pickHfLoraFile,
} from '../lib/huggingfaceLora.js';
import { RUNNER_FAMILIES, VIDEO_LORA_FAMILIES, composeCompatKey } from '../lib/runners.js';
import { detectFlux2Variant } from '../lib/safetensors.js';
import { getHfToken } from '../lib/hfToken.js';
import { getSettings } from './settings.js';

const SIDECAR_SUFFIX = '.metadata.json';

const sidecarPath = (loraFilename) => join(PATHS.loras, `${loraFilename}${SIDECAR_SUFFIX}`);

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
  if (!existsSync(PATHS.loras)) return [];
  const lorasStat = await stat(PATHS.loras).catch(() => null);
  if (!lorasStat || !lorasStat.isDirectory()) {
    console.log(`⚠️ PATHS.loras exists but is not a directory: ${PATHS.loras}`);
    return [];
  }
  // listDirectoryByExtension handles the readdir + extension filter + per-
  // entry stat + isFile check (so directories named `foo.safetensors` are
  // dropped before deleteLora would later trip on EISDIR).
  const out = await listDirectoryByExtension(PATHS.loras, {
    extensions: ['.safetensors'],
    mapEntry: async (filename, _fullPath, s) => {
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
      let fluxVariant = null;
      if (runnerFamily === RUNNER_FAMILIES.FLUX2) {
        fluxVariant = sidecar?.fluxVariant || flux2VariantFromBaseModel(baseModel);
        if (!fluxVariant) {
          fluxVariant = await detectFlux2Variant(_fullPath);
          if (fluxVariant) {
            // Best-effort cache — never block or fail the list on a write error.
            patchLoraSidecar(filename, { fluxVariant }).catch(() => {});
          }
        }
      }
      // The picker matches this against the selected model's `loraCompatKey`.
      // FLUX.2 → size-specific (or bare 'flux2' when size is unknown, so it
      // still shows for both sizes); every other family → its runner id.
      const loraCompatKey = composeCompatKey(runnerFamily, fluxVariant);
      return {
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
        loraCompatKey,
        triggerWords: sidecar?.triggerWords || [],
        // Coerce non-finite values (NaN, Infinity, missing/malformed sidecar
        // fields) to the default — `?? 1.0` alone wouldn't catch NaN.
        recommendedScale: Number.isFinite(sidecar?.recommendedScale) ? sidecar.recommendedScale : 1.0,
        // Normalize on read so already-installed LoRAs (sidecars written
        // before the URL-normalize fix) also benefit without a reinstall.
        previewImageUrl: normalizeCivitaiImageUrl(sidecar?.previewImageUrl) || null,
        description: sidecar?.description || '',
        // Trained-LoRA surfacing (sidecars written by services/loraTraining):
        // 'trained' source + the character identity block let the library UI
        // badge them and characterLoraResolver match them. Null for Civitai
        // installs and legacy drops.
        source: sidecar?.source || null,
        character: sidecar?.character || null,
        trainedFromDatasetId: sidecar?.datasetId || null,
      };
    },
  });
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
  await rm(filePath, { force: true });
  await rm(sidecarPath(filename), { force: true });
  console.log(`🗑️ Deleted LoRA: ${filename}`);
  return { ok: true, filename };
};

// Patch the sidecar with user-editable fields (name, recommendedScale, notes).
// Civitai-derived fields are passed through but the route layer scopes the
// patch so callers can't trample those.
export const patchLoraSidecar = async (filename, patch) => {
  assertSafeLoraFilename(filename);
  const filePath = join(PATHS.loras, filename);
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
  return next;
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

// Stream-download a URL to a temp file in PATHS.loras then rename into place.
// The temp suffix prevents the listLoras endpoint from picking up a
// half-downloaded file. The random suffix avoids clobbering a leftover
// `.partial` from a previous crashed install (and prevents two concurrent
// installs of the same target from racing on the same temp path).
// fetchImpl is injectable for tests.
const downloadToFile = async (url, destPath, { fetchImpl = fetch, headers = {} , hasApiKey = false, source = 'civitai' } = {}) => {
  const tmpPath = `${destPath}.${randomBytes(6).toString('hex')}.partial`;
  const res = await fetchImpl(url, { headers, redirect: 'follow' });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      // HuggingFace LoRAs: a 401/403 means the repo is gated and the token is
      // missing/insufficient — point the user at the license + HF token UI.
      if (source === 'huggingface') {
        const message = hasApiKey
          ? `HuggingFace rejected the download (${res.status}) even with your saved token — accept the model's license on its HF page, or the token may be expired/scoped.`
          : `HuggingFace download rejected (${res.status}) — this LoRA's repo is gated. Accept its license on HuggingFace and add your HF token in Image Gen settings, then retry.`;
        throw new ServerError(message, { status: res.status, code: 'HF_AUTH' });
      }
      // When a key was supplied and Civitai still rejects, the cause is
      // almost always early-access content or a deactivated/scoped key —
      // not a missing key. Don't tell the user to set a key they've
      // already set; surface both possibilities instead.
      const message = hasApiKey
        ? `Civitai rejected the download (${res.status}) even with your saved API key. The LoRA is likely in early-access (Civitai supporters only) or your key has expired/been revoked.`
        : `Civitai download rejected (${res.status}) — this LoRA may require an API key. Configure a Civitai API key in PortOS Settings (or set the CIVITAI_API_KEY env var) and retry.`;
      throw new ServerError(message, { status: res.status, code: 'CIVITAI_AUTH' });
    }
    const label = source === 'huggingface' ? 'HuggingFace' : 'Civitai';
    const code = source === 'huggingface' ? 'HF_DOWNLOAD_FAILED' : 'CIVITAI_DOWNLOAD_FAILED';
    throw new ServerError(`${label} download failed: ${res.status} ${res.statusText}`, { status: 502, code });
  }
  if (!res.body) {
    throw new ServerError('Civitai download returned no body', { status: 502, code: 'CIVITAI_DOWNLOAD_FAILED' });
  }
  // Node 18+ fetch returns a web ReadableStream; pipeline accepts it directly
  // when wrapped in Readable.fromWeb (also handles backpressure correctly).
  // On stream failure (network drop, disk full) the .partial would otherwise
  // accumulate in PATHS.loras across retries.
  const writer = createWriteStream(tmpPath);
  await pipeline(Readable.fromWeb(res.body), writer).catch(async (err) => {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  });
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

// Install a LoRA from a Civitai URL. Returns the new sidecar JSON so the
// client can render it immediately without a second list round-trip.
export const installFromCivitai = async (input, { fetchImpl = fetch } = {}) => {
  const { modelId, versionId } = parseCivitaiUrl(input?.url);
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
  // Civitai's `type` casing varies in the wild (LORA / Lora / lora) and the
  // family includes LoCon / LyCORIS / DoRA / LoHA — all of which load
  // through diffusers' lora pipeline. Refuse only true non-LoRA checkpoints.
  const ALLOWED_LORA_TYPES = new Set(['lora', 'locon', 'lycoris', 'dora', 'loha']);
  if (model?.type && !ALLOWED_LORA_TYPES.has(String(model.type).toLowerCase())) {
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
  if (existsSync(destPath)) {
    throw new ServerError(
      `Already installed: ${filename}. Delete it first or pick a different version.`,
      { status: 409, code: 'CIVITAI_ALREADY_INSTALLED' },
    );
  }

  await ensureDir(PATHS.loras);

  console.log(`📥 Installing Civitai LoRA: ${model.name} v${version.id} → ${filename} (${file.sizeKB ? Math.round(file.sizeKB / 1024) + ' MB' : 'size unknown'})`);
  // Authenticate downloads via `?token=` only — the Authorization header
  // doesn't survive the 302 to CDN, AND sending both means the token also
  // ends up in CDN access logs. The metadata fetch (fetchCivitaiModel)
  // still uses the header since /api/v1/* doesn't redirect.
  const tokenized = applyDownloadToken(file.downloadUrl, apiKey);
  await downloadToFile(tokenized, destPath, {
    fetchImpl,
    headers: { 'User-Agent': 'PortOS/civitai-installer' },
    hasApiKey: !!apiKey,
  });

  const sidecar = buildSidecar({ model, version, file, filename });
  await atomicWrite(sidecarPath(filename), JSON.stringify(sidecar, null, 2) + '\n');
  console.log(`✅ Installed Civitai LoRA: ${filename}`);
  return sidecar;
};

// Set of recognized video-LoRA families an HF import may target. Used to
// validate a user-supplied `family` override before trusting it.
const VIDEO_LORA_FAMILY_VALUES = new Set(Object.values(VIDEO_LORA_FAMILIES));

// Install a video LoRA from a HuggingFace repo (e.g.
// fal/ltx2.3-audio-reactive-lora). Mirrors installFromCivitai: parse the ref →
// fetch repo metadata → pick the .safetensors → stream-download → write the
// sidecar. The family is auto-detected from the repo id / tags / base_model,
// or taken from an explicit `input.family` override (validated against the
// known video families). Returns the new sidecar JSON.
export const installFromHuggingface = async (input, { fetchImpl = fetch } = {}) => {
  const { repo, revision } = parseHuggingfaceLoraRef(input?.url);
  // Stored/env/CLI HF token — only needed for gated repos, but harmless to
  // send on public ones (HF ignores a bearer it doesn't require).
  const token = (typeof input?.token === 'string' && input.token.trim()) || (await getHfToken()) || '';
  const model = await fetchHuggingfaceModel(repo, { token, revision, fetchImpl });
  const file = pickHfLoraFile(model);

  // Family: explicit override (validated) wins over autodetection so a user
  // can correct a mis-detected repo from the UI. An unrecognized repo with no
  // override is refused rather than silently tagged — a wrongly-tagged LoRA
  // would surface under a model it can't actually load against.
  let family = null;
  if (input?.family) {
    if (!VIDEO_LORA_FAMILY_VALUES.has(input.family)) {
      throw new ServerError(
        `Unknown video LoRA family "${input.family}" — expected one of ${[...VIDEO_LORA_FAMILY_VALUES].join(', ')}`,
        { status: 400, code: 'HF_BAD_FAMILY' },
      );
    }
    family = input.family;
  } else {
    family = detectVideoLoraFamily({ repo, model });
  }
  if (!family) {
    throw new ServerError(
      `Couldn't determine a supported video model for HuggingFace repo "${repo}". Only LTX-Video LoRAs are supported today — pass an explicit family if you know this LoRA targets LTX-2.`,
      { status: 422, code: 'HF_UNKNOWN_FAMILY' },
    );
  }

  // Stable filename: `lora-<org>-<name>-hf.safetensors`. The org+name slug
  // disambiguates same-named LoRAs from different authors; the `-hf` suffix
  // keeps it distinct from a Civitai install of the same model.
  const slug = slugifyForFilename(repo.replace('/', '-'));
  const filename = `lora-${slug}-hf.safetensors`;
  const destPath = join(PATHS.loras, filename);
  if (existsSync(destPath)) {
    throw new ServerError(
      `Already installed: ${filename}. Delete it first to reinstall.`,
      { status: 409, code: 'HF_ALREADY_INSTALLED' },
    );
  }

  await ensureDir(PATHS.loras);
  console.log(`📥 Installing HuggingFace LoRA: ${repo} (${file}) → ${filename} [family=${family}]`);
  await downloadToFile(buildHfResolveUrl(repo, revision, file), destPath, {
    fetchImpl,
    headers: { 'User-Agent': 'PortOS/hf-lora-installer', ...buildHfAuthHeaders(token) },
    hasApiKey: !!token,
    source: 'huggingface',
  });

  const sidecar = buildHfLoraSidecar({ repo, revision, file, model, family, filename });
  await atomicWrite(sidecarPath(filename), JSON.stringify(sidecar, null, 2) + '\n');
  console.log(`✅ Installed HuggingFace LoRA: ${filename}`);
  return sidecar;
};
