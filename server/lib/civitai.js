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
import { RUNNER_FAMILIES } from './runners.js';
import { readResponseJson } from './readResponseJson.js';

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
  if (b.startsWith('flux.1') || b.startsWith('flux 1') || b === 'flux1') return RUNNER_FAMILIES.MFLUX;
  if (b.startsWith('flux.2') || b.startsWith('flux 2') || b === 'flux2') return RUNNER_FAMILIES.FLUX2;
  if (b.startsWith('z-image') || b.startsWith('zimage') || b.startsWith('z image')) return RUNNER_FAMILIES.Z_IMAGE;
  if (b.startsWith('ernie-image') || b.startsWith('ernie image') || b.startsWith('ernieimage') || b === 'ernie') return RUNNER_FAMILIES.ERNIE;
  if (b.startsWith('hidream') || b.startsWith('hi-dream') || b.startsWith('hi dream')) return RUNNER_FAMILIES.HIDREAM;
  if (b === 'qwen' || b.startsWith('qwen-image') || b.startsWith('qwen image') || b.startsWith('qwenimage')) return RUNNER_FAMILIES.QWEN;
  // SDXL / SD1.5 / Pony / Illustrious / etc. — none currently supported by
  // any PortOS runner. Surfacing them in the UI as "incompatible" is more
  // useful than hiding them entirely.
  return null;
};

// FLUX.2 Klein ships in two sizes (4B/9B) with incompatible transformer dims.
// Civitai distinguishes them in the baseModel string ("Flux.2 Klein 4B" /
// "Flux.2 Klein 9B"), so a Civitai-installed LoRA can be tagged without
// reading its safetensors header. Returns '4b' | '9b' | null.
export const flux2VariantFromBaseModel = (baseModel) => {
  if (typeof baseModel !== 'string') return null;
  if (baseModelToRunner(baseModel) !== RUNNER_FAMILIES.FLUX2) return null;
  const m = baseModel.match(/\b([49])b\b/i);
  return m ? `${m[1].toLowerCase()}b` : null;
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

// Normalize a Civitai CDN image URL so it's bounded-width and reliably
// served. Civitai's CDN encodes its image transform as a path segment:
//   https://image.civitai.com/<hash>/<uuid>/<transform>/<filename>.<ext>
// Common transforms are `original=true`, `width=450`, `fit=crop,width=...`.
// The `original=true` variant occasionally returns 401/403 (auth-gated for
// NSFW or simply blocked by hotlink protection) where smaller width-bounded
// variants are public. Replacing the transform with `width=512` gives a
// snappier, more-likely-to-render thumbnail. Non-Civitai URLs and URLs
// without a recognizable transform segment pass through unchanged.
export const normalizeCivitaiImageUrl = (url, width = 512) => {
  if (typeof url !== 'string' || !url) return url;
  if (!/^https?:\/\/(image\.civitai\.com|civitai\.com)\//i.test(url)) return url;
  // Find the path segment immediately before the trailing /<filename>.<ext>
  // and replace it with `width=N` if it looks like a transform spec
  // (contains `=`). Doesn't touch the filename or query string.
  const match = url.match(/^(.*\/)([^/]+)(\/[^/]+\.(?:jpeg|jpg|png|webp|gif|avif))(\?.*)?$/i);
  if (!match) return url;
  const [, prefix, transform, file, query = ''] = match;
  if (!transform.includes('=')) return url; // not a Civitai transform segment
  return `${prefix}width=${width}${file}${query}`;
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
export const fetchCivitaiModel = async (modelId, { apiKey, fetchImpl = fetch, signal = AbortSignal.timeout(10000) } = {}) => {
  if (!/^\d+$/.test(String(modelId))) {
    throw new ServerError(`Invalid Civitai model id: ${modelId}`, { status: 400, code: 'CIVITAI_BAD_URL' });
  }
  const url = `${CIVITAI_API}/models/${modelId}`;
  const res = await fetchImpl(url, { headers: { Accept: 'application/json', ...buildAuthHeaders(apiKey) }, signal });
  if (!res.ok) {
    if (res.status === 404) {
      throw new ServerError(`Civitai model ${modelId} not found`, { status: 404, code: 'CIVITAI_NOT_FOUND' });
    }
    if (res.status === 401 || res.status === 403) {
      throw new ServerError(
        `Civitai rejected the request (${res.status}) — add a Civitai API key in PortOS Settings (or set the CIVITAI_API_KEY env var) if this model is gated`,
        { status: res.status, code: 'CIVITAI_AUTH' },
      );
    }
    throw new ServerError(`Civitai metadata fetch failed: ${res.status}`, { status: 502, code: 'CIVITAI_FETCH_FAILED' });
  }
  return readResponseJson(res);
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

// Detect early-access status from a Civitai modelVersion. New uploads on
// Civitai can be flagged as "Early Access" — only paid Civitai supporters
// can download them for a window (typically 1-14 days). The download
// endpoint returns 401 in this case even with a valid API key, which would
// otherwise route the user into the "set CIVITAI_API_KEY" modal where their
// key is already saved. Detect ahead of the download attempt and surface a
// distinct error so the UI can explain it without prompting for a key.
//
// Returns { early: false } for public versions, or
// { early: true, endsAt: ISO|null, hoursRemaining: number|null } when
// early-access. Field shapes vary across Civitai API versions, so we check
// both `earlyAccessConfig.endsAt` and a `publishedAt + period` fallback.
export const detectEarlyAccess = (version) => {
  const availability = String(version?.availability || '').toLowerCase();
  const config = version?.earlyAccessConfig;
  const flagged = availability === 'earlyaccess' || (config && (config.period > 0 || config.endsAt));
  if (!flagged) return { early: false };

  let endsAt = null;
  if (typeof config?.endsAt === 'string') {
    endsAt = config.endsAt;
  } else if (typeof version?.earlyAccessEndsAt === 'string') {
    endsAt = version.earlyAccessEndsAt;
  } else if (typeof version?.publishedAt === 'string' && Number.isFinite(config?.period)) {
    const t = Date.parse(version.publishedAt);
    if (Number.isFinite(t)) endsAt = new Date(t + config.period * 24 * 3600 * 1000).toISOString();
  }
  let hoursRemaining = null;
  if (endsAt) {
    const t = Date.parse(endsAt);
    if (Number.isFinite(t)) hoursRemaining = Math.max(0, Math.round((t - Date.now()) / 3600_000));
  }
  return { early: true, endsAt, hoursRemaining };
};

// Build the canonical sidecar shape. Stored next to the .safetensors file as
// `<filename>.metadata.json`. Decoupled from fetchCivitaiModel so callers can
// build it from a known model+version pair without a second API hit (the
// install path already has both in hand).
// Maximum characters to persist for model description. Civitai descriptions
// can be several KB of markdown/HTML — truncating keeps sidecars lean without
// losing the first-glance summary text that the manager UI shows.
const DESCRIPTION_MAX_CHARS = 2000;

export const buildSidecar = ({ model, version, file, filename }) => {
  const previewImage = pickPreviewImage(version);
  const baseModel = version?.baseModel || null;
  const rawDesc = typeof model?.description === 'string' ? model.description : '';
  const description = rawDesc.length > DESCRIPTION_MAX_CHARS
    ? rawDesc.slice(0, DESCRIPTION_MAX_CHARS)
    : rawDesc;
  return {
    filename,
    name: model?.name || filename,
    description,
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
    // '4b' | '9b' | null — only meaningful for the flux2 family. Lets the LoRA
    // picker tell a Klein-4B LoRA apart from a Klein-9B one (incompatible dims).
    fluxVariant: flux2VariantFromBaseModel(baseModel),
    triggerWords: Array.isArray(version?.trainedWords) ? version.trainedWords : [],
    recommendedScale: Number.isFinite(version?.settings?.strength) ? version.settings.strength : 1.0,
    file: {
      sizeKB: file?.sizeKB ?? null,
      hashes: file?.hashes || {},
      downloadUrl: file?.downloadUrl || null,
    },
    previewImageUrl: normalizeCivitaiImageUrl(previewImage?.url) || null,
    installedAt: new Date().toISOString(),
  };
};

// Map a PortOS runner family back to the `baseModels` query param values
// Civitai's search endpoint expects. Civitai uses %20-encoded display names
// (`Flux.1 D`, `Flux.1 S`, `Flux.2`, etc.). The Z-Image ecosystem on Civitai
// is nascent — searches there often return zero; the UI handles that.
// Civitai's `baseModels` display names — these are the literal strings the
// search endpoint accepts; sending anything else returns zero results.
// Discovered by inspecting modelVersions[].baseModel on multi-base-model
// LoRAs (e.g. model 1155749). Civitai is inconsistent about hyphens and
// per-variant naming, so each runner family lists every accepted alias.
const RUNNER_TO_BASE_MODELS = {
  [RUNNER_FAMILIES.MFLUX]: ['Flux.1 D', 'Flux.1 S'],
  [RUNNER_FAMILIES.FLUX2]: ['Flux.2 Klein 4B', 'Flux.2 Klein 9B'],
  [RUNNER_FAMILIES.Z_IMAGE]: ['ZImageBase', 'ZImageTurbo'],
  [RUNNER_FAMILIES.ERNIE]: ['Ernie'],
  [RUNNER_FAMILIES.HIDREAM]: ['HiDream'],
  [RUNNER_FAMILIES.QWEN]: ['Qwen'],
};

// Search Civitai for LoRA-family models targeting the given runner family.
// Returns `{ items, nextCursor }` — `items` is the raw array from
// `/api/v1/models` (each entry has its own `modelVersions[]` etc — let the
// suggestion service shape them); `nextCursor` is Civitai's cursor token for
// the next page (null when exhausted). Pass `query` to filter by keyword and
// `cursor` to page forward. fetchImpl is injectable for tests.
export const searchCivitaiLoras = async ({ runnerFamily, limit = 12, sort = 'Most Downloaded', nsfw = false, query, cursor, apiKey, fetchImpl = fetch, signal = AbortSignal.timeout(10000) } = {}) => {
  const baseModels = RUNNER_TO_BASE_MODELS[runnerFamily];
  if (!baseModels) {
    throw new ServerError(`Unknown runner family for Civitai search: ${runnerFamily}`, { status: 400, code: 'CIVITAI_BAD_RUNNER' });
  }
  // Civitai accepts repeated `baseModels` query params for OR semantics.
  // URLSearchParams handles the repeated-key + display-name URL-encoding.
  const params = new URLSearchParams();
  params.set('types', 'LORA');
  params.set('limit', String(Math.max(1, Math.min(100, limit))));
  params.set('sort', sort);
  params.set('nsfw', String(!!nsfw));
  for (const bm of baseModels) params.append('baseModels', bm);
  // `query` is Civitai's keyword search over model name/description. Trim and
  // skip when blank so an empty box falls back to the plain "top" ranking.
  const trimmedQuery = typeof query === 'string' ? query.trim() : '';
  if (trimmedQuery) params.set('query', trimmedQuery);
  // Cursor-based pagination — Civitai returns `metadata.nextCursor`; feed it
  // back here to fetch the next page. Cursor is opaque (string or number).
  if (cursor != null && cursor !== '') params.set('cursor', String(cursor));
  const url = `${CIVITAI_API}/models?${params.toString()}`;
  const res = await fetchImpl(url, { headers: { Accept: 'application/json', ...buildAuthHeaders(apiKey) }, signal });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new ServerError(
        `Civitai search rejected (${res.status}) — set CIVITAI_API_KEY in PortOS Settings if NSFW content is enabled`,
        { status: res.status, code: 'CIVITAI_AUTH' },
      );
    }
    throw new ServerError(`Civitai search failed: ${res.status}`, { status: 502, code: 'CIVITAI_SEARCH_FAILED' });
  }
  const body = await readResponseJson(res);
  return {
    items: Array.isArray(body?.items) ? body.items : [],
    nextCursor: body?.metadata?.nextCursor ?? null,
  };
};

// Pull a sample prompt from Civitai's preview image metadata. The `meta`
// field's shape varies wildly — sometimes `{ prompt: '...' }`, sometimes a
// stringified JSON, sometimes absent. Returns the first usable prompt or
// null. Skips images flagged at NSFW level > 1 to keep suggestions safe.
export const extractSamplePrompt = (version) => {
  const images = Array.isArray(version?.images) ? version.images : [];
  for (const img of images) {
    if ((img?.nsfwLevel ?? 0) > 1) continue;
    const meta = img?.meta;
    if (meta && typeof meta === 'object' && typeof meta.prompt === 'string' && meta.prompt.trim()) {
      return meta.prompt.trim();
    }
    if (typeof meta === 'string') {
      // Some entries serialize meta as a JSON string. Defensive parse.
      let parsed = null;
      try { parsed = JSON.parse(meta); } catch { /* ignore */ }
      if (parsed && typeof parsed === 'object' && typeof parsed.prompt === 'string' && parsed.prompt.trim()) {
        return parsed.prompt.trim();
      }
    }
  }
  return null;
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
