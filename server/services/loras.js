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
 * No try/catch — errors bubble. Network errors during download leave a
 * partial file on disk; the cleanup happens via a finalizer below.
 */

import { existsSync } from 'fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import { createWriteStream } from 'fs';
import { randomBytes } from 'crypto';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { basename, join } from 'path';
import { ServerError } from '../lib/errorHandler.js';
import { PATHS } from '../lib/fileUtils.js';
import {
  applyDownloadToken,
  baseModelToRunner,
  buildSidecar,
  fetchCivitaiModel,
  normalizeCivitaiImageUrl,
  parseCivitaiUrl,
  pickPrimaryFile,
  pickVersion,
  slugifyForFilename,
} from '../lib/civitai.js';
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
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
};

// Validate a basename so it can't escape PATHS.loras. We require the input
// equals its own basename (no path separators, no parent traversal) and ends
// in `.safetensors`. Substring `..` is allowed because slugifyForFilename can
// produce names like `foo..bar` from non-ASCII input.
export const assertSafeLoraFilename = (filename) => {
  if (!filename || typeof filename !== 'string') {
    throw new ServerError('Filename required', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const isExactTraversal = filename === '.' || filename === '..';
  const hasSeparator = filename.includes('/') || filename.includes('\\');
  const isPureBasename = basename(filename) === filename;
  if (!filename.endsWith('.safetensors') || hasSeparator || isExactTraversal || !isPureBasename) {
    throw new ServerError('Invalid LoRA filename', { status: 400, code: 'VALIDATION_ERROR' });
  }
};

// LoRAs without sidecars get a minimal "legacy" entry with sensible defaults
// so the manager UI can still render LoRAs the user dropped in pre-Civitai.
export const listLoras = async () => {
  if (!existsSync(PATHS.loras)) return [];
  const files = await readdir(PATHS.loras);
  const safetensors = files.filter((f) => f.endsWith('.safetensors'));
  const out = await Promise.all(safetensors.map(async (filename) => {
    const fullPath = join(PATHS.loras, filename);
    const s = await stat(fullPath).catch(() => null);
    // Skip directories or other non-regular entries that happen to end in
    // `.safetensors` — otherwise listLoras would surface them and deleteLora
    // would later fail with EISDIR.
    if (!s || !s.isFile()) return null;
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
    return {
      filename,
      name: sidecar?.name || fallbackName,
      sizeBytes: s.size,
      installedAt: sidecar?.installedAt || s.birthtime?.toISOString?.() || null,
      // sidecar fields surfaced for the picker / manager UI:
      civitai: sidecar?.civitai || null,
      runnerFamily,
      triggerWords: sidecar?.triggerWords || [],
      // Coerce non-finite values (NaN, Infinity, missing/malformed sidecar
      // fields) to the default — `?? 1.0` alone wouldn't catch NaN.
      recommendedScale: Number.isFinite(sidecar?.recommendedScale) ? sidecar.recommendedScale : 1.0,
      // Normalize on read so already-installed LoRAs (sidecars written
      // before the URL-normalize fix) also benefit without a reinstall.
      previewImageUrl: normalizeCivitaiImageUrl(sidecar?.previewImageUrl) || null,
      description: sidecar?.description || '',
    };
  }));
  return out.filter(Boolean).sort((a, b) => (b.installedAt || '').localeCompare(a.installedAt || ''));
};

export const getLora = async (filename) => {
  assertSafeLoraFilename(filename);
  const fullPath = join(PATHS.loras, filename);
  if (!existsSync(fullPath)) {
    throw new ServerError(`LoRA not found: ${filename}`, { status: 404, code: 'NOT_FOUND' });
  }
  const list = await listLoras();
  return list.find((l) => l.filename === filename) || null;
};

export const deleteLora = async (filename) => {
  assertSafeLoraFilename(filename);
  const filePath = join(PATHS.loras, filename);
  if (!existsSync(filePath)) {
    throw new ServerError(`LoRA not found: ${filename}`, { status: 404, code: 'NOT_FOUND' });
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
  if (!existsSync(join(PATHS.loras, filename))) {
    throw new ServerError(`LoRA not found: ${filename}`, { status: 404, code: 'NOT_FOUND' });
  }
  const current = (await readSidecar(filename)) || { filename };
  const next = { ...current, ...patch, filename };
  await writeFile(sidecarPath(filename), JSON.stringify(next, null, 2) + '\n');
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
const downloadToFile = async (url, destPath, { fetchImpl = fetch, headers = {} } = {}) => {
  const tmpPath = `${destPath}.${randomBytes(6).toString('hex')}.partial`;
  const res = await fetchImpl(url, { headers, redirect: 'follow' });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new ServerError(
        `Civitai download rejected (${res.status}) — this LoRA may require an API key. Set CIVITAI_API_KEY in Settings and retry.`,
        { status: res.status, code: 'CIVITAI_AUTH' },
      );
    }
    throw new ServerError(`Civitai download failed: ${res.status} ${res.statusText}`, { status: 502, code: 'CIVITAI_DOWNLOAD_FAILED' });
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
  // rename can also fail (cross-device, locked dest, AV scan, low disk) —
  // wrap separately so the .partial doesn't leak in any failure mode.
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

  await mkdir(PATHS.loras, { recursive: true });

  console.log(`📥 Installing Civitai LoRA: ${model.name} v${version.id} → ${filename} (${file.sizeKB ? Math.round(file.sizeKB / 1024) + ' MB' : 'size unknown'})`);
  // Authenticate downloads via `?token=` only — the Authorization header
  // doesn't survive the 302 to CDN, AND sending both means the token also
  // ends up in CDN access logs. The metadata fetch (fetchCivitaiModel)
  // still uses the header since /api/v1/* doesn't redirect.
  const tokenized = applyDownloadToken(file.downloadUrl, apiKey);
  await downloadToFile(tokenized, destPath, {
    fetchImpl,
    headers: { 'User-Agent': 'PortOS/civitai-installer' },
  });

  const sidecar = buildSidecar({ model, version, file, filename });
  await writeFile(sidecarPath(filename), JSON.stringify(sidecar, null, 2) + '\n');
  console.log(`✅ Installed Civitai LoRA: ${filename}`);
  return sidecar;
};
