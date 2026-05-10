/**
 * Civitai integration — pure helpers for parsing Civitai URLs, fetching
 * model metadata, and picking the right file/version to download.
 *
 * All metadata calls go to civitai.com regardless of which mirror frontend
 * the user pasted (civitai.com / civitai.red / civitai.green) — the API is
 * only published on civitai.com, and going through the mirrors' frontends
 * would mean parsing HTML.
 *
 * Auth: optional API key (`settings.civitai.apiKey` or env CIVITAI_API_KEY).
 * Some restricted/adult LoRAs require a token to download; metadata for
 * public models is always anonymous-readable.
 *
 * No try/catch — errors bubble to the centralized middleware via the
 * project convention. Domain-specific errors throw ServerError.
 */

import { ServerError } from './errorHandler.js';

const CIVITAI_API = 'https://civitai.com/api/v1';
const CIVITAI_HOSTS = new Set(['civitai.com', 'civitai.red', 'civitai.green', 'www.civitai.com']);

// Maps a Civitai `baseModel` string (e.g. "Flux.1 D", "Flux.2 Klein", "SDXL 1.0",
// "Z-Image") to a PortOS runner family. The runner family is what the LoRA
// picker filters on so users only see compatible LoRAs for their selected
// model. Unknown base models map to `null` (incompatible with current runners).
export const baseModelToRunner = (baseModel) => {
  if (typeof baseModel !== 'string') return null;
  const b = baseModel.trim().toLowerCase();
  if (!b) return null;
  // Match Flux.1 *, Flux 1 *, FLUX.1 D, FLUX.1 S
  if (b.startsWith('flux.1') || b.startsWith('flux 1') || b === 'flux1') return 'mflux';
  if (b.startsWith('flux.2') || b.startsWith('flux 2') || b === 'flux2') return 'flux2';
  if (b.startsWith('z-image') || b.startsWith('zimage') || b.startsWith('z image')) return 'z-image';
  // SDXL / SD1.5 / Pony / Illustrious / etc. — none currently supported by
  // any PortOS runner. Surfacing them in the UI as "incompatible" is more
  // useful than hiding them entirely.
  return null;
};

// Extracts model id and optional modelVersionId from any Civitai URL shape:
//   https://civitai.com/models/123456
//   https://civitai.com/models/123456/some-slug
//   https://civitai.com/models/123456?modelVersionId=789
//   https://civitai.red/models/123456/realstagram
// Returns { modelId: string, versionId: string | null }. Throws on garbage.
export const parseCivitaiUrl = (raw) => {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new ServerError('Empty Civitai URL', { status: 400, code: 'CIVITAI_BAD_URL' });
  }
  const trimmed = raw.trim();
  // Accept bare model ids too — `123456` and `civitai:123456` shortcuts.
  const bareId = trimmed.match(/^(?:civitai:)?(\d{1,12})$/);
  if (bareId) return { modelId: bareId[1], versionId: null };

  if (!/^https?:\/\//i.test(trimmed)) {
    throw new ServerError(
      `Civitai URL must start with http(s):// — got "${trimmed.slice(0, 60)}"`,
      { status: 400, code: 'CIVITAI_BAD_URL' },
    );
  }
  // The regex above accepts the http(s) prefix shape, but malformed
  // hostnames / brackets / encoded segments still throw `TypeError: Invalid
  // URL` from the constructor. Convert to a 400 ServerError so callers get
  // the expected error contract instead of a 500.
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ServerError(
      `Malformed URL: "${trimmed.slice(0, 60)}"`,
      { status: 400, code: 'CIVITAI_BAD_URL' },
    );
  }
  if (!CIVITAI_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new ServerError(
      `Not a Civitai URL: ${parsed.hostname}`,
      { status: 400, code: 'CIVITAI_BAD_URL' },
    );
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  // Expected shape: ['models', '<id>', '<optional slug>']
  if (segments[0] !== 'models' || !segments[1] || !/^\d+$/.test(segments[1])) {
    throw new ServerError(
      `Civitai URL must point at /models/<id> — got "${parsed.pathname}"`,
      { status: 400, code: 'CIVITAI_BAD_URL' },
    );
  }
  const modelId = segments[1];
  const versionId = parsed.searchParams.get('modelVersionId');
  if (versionId && !/^\d+$/.test(versionId)) {
    throw new ServerError(
      `Civitai modelVersionId must be numeric — got "${versionId}"`,
      { status: 400, code: 'CIVITAI_BAD_URL' },
    );
  }
  return { modelId, versionId: versionId || null };
};

// Pick the modelVersion to install. If the URL specified a versionId, use it.
// Otherwise fall back to the first published version (Civitai sorts these by
// recency in the API response). Throws if the requested version isn't on the
// model — usually means the user pasted a stale link after the creator
// removed a version.
export const pickVersion = (model, versionId) => {
  const versions = Array.isArray(model?.modelVersions) ? model.modelVersions : [];
  if (!versions.length) {
    throw new ServerError(
      `Civitai model "${model?.name || model?.id}" has no published versions`,
      { status: 422, code: 'CIVITAI_NO_VERSIONS' },
    );
  }
  if (versionId) {
    const match = versions.find((v) => String(v.id) === String(versionId));
    if (!match) {
      throw new ServerError(
        `Civitai version ${versionId} not found on model ${model?.id}`,
        { status: 404, code: 'CIVITAI_VERSION_NOT_FOUND' },
      );
    }
    return match;
  }
  return versions[0];
};

// Pick the .safetensors file to download from a version. Civitai hosts
// occasional `.bin` / `.ckpt` siblings (older formats) and sometimes a
// thumbnail or training-config JSON — we only want .safetensors. Prefers
// the file marked `primary: true`; falls back to the first .safetensors.
export const pickPrimaryFile = (version) => {
  const files = Array.isArray(version?.files) ? version.files : [];
  const safetensors = files.filter((f) => /\.safetensors$/i.test(f?.name || ''));
  if (!safetensors.length) {
    throw new ServerError(
      `Civitai version ${version?.id} has no .safetensors file`,
      { status: 422, code: 'CIVITAI_NO_SAFETENSORS' },
    );
  }
  return safetensors.find((f) => f.primary) || safetensors[0];
};

// Pick a representative preview image URL for a version (for the LoRA card
// thumbnail). Civitai returns nsfwLevel as a numeric flag — 1 is "None", 2
// is "Soft", 4 is "Mature", 8 is "X". We prefer the lowest-rated image so
// the manager UI thumbnail isn't unexpectedly explicit; users who want the
// full preview can click through to civitai.com.
export const pickPreviewImage = (version) => {
  const images = Array.isArray(version?.images) ? version.images : [];
  if (!images.length) return null;
  const sorted = [...images].sort((a, b) => (a.nsfwLevel ?? 0) - (b.nsfwLevel ?? 0));
  return sorted[0] || null;
};

// Build the auth header for HTTP requests when an API key is set.
// Civitai's API also accepts the token as a `?token=` query param on
// download URLs, but Authorization: Bearer is documented for /api/v1 calls.
export const buildAuthHeaders = (apiKey) => {
  if (typeof apiKey !== 'string' || !apiKey.trim()) return {};
  return { Authorization: `Bearer ${apiKey.trim()}` };
};

// Fetch model metadata. `fetchImpl` is injectable for tests — defaults to
// global fetch which is available in Node 18+. Returns the parsed JSON
// body; throws ServerError on HTTP failures with a helpful message.
export const fetchCivitaiModel = async (modelId, { apiKey, fetchImpl = fetch } = {}) => {
  if (!/^\d+$/.test(String(modelId))) {
    throw new ServerError(`Invalid Civitai model id: ${modelId}`, { status: 400, code: 'CIVITAI_BAD_URL' });
  }
  const url = `${CIVITAI_API}/models/${modelId}`;
  const res = await fetchImpl(url, { headers: { Accept: 'application/json', ...buildAuthHeaders(apiKey) } });
  if (!res.ok) {
    if (res.status === 404) {
      throw new ServerError(`Civitai model ${modelId} not found`, { status: 404, code: 'CIVITAI_NOT_FOUND' });
    }
    if (res.status === 401 || res.status === 403) {
      throw new ServerError(
        `Civitai rejected the request (${res.status}) — set CIVITAI_API_KEY in PortOS Settings if this model is gated`,
        { status: res.status, code: 'CIVITAI_AUTH' },
      );
    }
    throw new ServerError(`Civitai metadata fetch failed: ${res.status}`, { status: 502, code: 'CIVITAI_FETCH_FAILED' });
  }
  return res.json();
};

// Apply the auth token to a Civitai download URL. The download endpoint
// accepts either Authorization header or `?token=` query param; the query
// form survives 302-redirects to the CDN whereas the header doesn't, so we
// use the query param for download URLs.
export const applyDownloadToken = (downloadUrl, apiKey) => {
  if (typeof apiKey !== 'string' || !apiKey.trim()) return downloadUrl;
  if (typeof downloadUrl !== 'string') return downloadUrl;
  const sep = downloadUrl.includes('?') ? '&' : '?';
  return `${downloadUrl}${sep}token=${encodeURIComponent(apiKey.trim())}`;
};

// Build the canonical sidecar shape. Stored next to the .safetensors file as
// `<filename>.metadata.json`. Decoupled from fetchCivitaiModel so callers can
// build it from a known model+version pair without a second API hit (the
// install path already has both in hand).
export const buildSidecar = ({ model, version, file, filename }) => {
  const previewImage = pickPreviewImage(version);
  const baseModel = version?.baseModel || null;
  return {
    filename,
    name: model?.name || filename,
    description: model?.description || '',
    civitai: {
      modelId: model?.id ?? null,
      versionId: version?.id ?? null,
      url: model?.id ? `https://civitai.com/models/${model.id}?modelVersionId=${version?.id}` : null,
      baseModel,
      type: model?.type || null,                 // "LORA" / "Checkpoint" / etc.
      tags: Array.isArray(model?.tags) ? model.tags : [],
      creator: model?.creator?.username || null,
      nsfw: !!model?.nsfw,
    },
    runnerFamily: baseModelToRunner(baseModel),  // 'mflux' | 'flux2' | 'z-image' | null
    triggerWords: Array.isArray(version?.trainedWords) ? version.trainedWords : [],
    recommendedScale: Number.isFinite(version?.settings?.strength) ? version.settings.strength : 1.0,
    file: {
      sizeKB: file?.sizeKB ?? null,
      hashes: file?.hashes || {},
      downloadUrl: file?.downloadUrl || null,
    },
    previewImageUrl: previewImage?.url || null,
    installedAt: new Date().toISOString(),
  };
};

// Sanitize a model name into a safe filename slug. Civitai model names can
// contain `/`, `\`, weird unicode, mixed case, etc. — we want a portable
// filename that also keeps the .safetensors extension predictable. Limits
// length to keep the path well under most filesystems' 255-byte cap (the
// sidecar adds `.metadata.json` and the project may add prefixes).
// Lowercased so the same model installed on macOS/Windows (case-insensitive)
// and Linux (case-sensitive) collides identically — `existsSync()` then
// reliably catches "already installed."
export const slugifyForFilename = (name) => {
  const safe = String(name || 'lora')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\w\-.]+/g, '-')   // anything that isn't a word char, dash, or dot → dash
    .replace(/-+/g, '-')           // collapse runs
    .replace(/^[-.]+|[-.]+$/g, '') // trim leading/trailing dashes/dots
    .slice(0, 80);
  return safe || 'lora';
};
