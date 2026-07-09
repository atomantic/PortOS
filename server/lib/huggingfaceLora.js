/**
 * HuggingFace LoRA import — pure helpers for parsing HF refs, fetching repo
 * metadata, picking the .safetensors to download, and building the PortOS
 * sidecar for a video LoRA.
 *
 * Video LoRAs (e.g. fal/ltx2.3-audio-reactive-lora) live on HuggingFace, not
 * Civitai, so the Civitai installer in services/loras.js can't reach them.
 * This module is the HF analogue of server/lib/civitai.js: it parses the ref,
 * hits the public `/api/models/{repo}` endpoint for the file list + card data,
 * picks the LoRA weights file, and shapes a sidecar that listLoras() can read.
 *
 * The download itself reuses services/loras.js#downloadToFile against the HF
 * `resolve` URL (with the user's HF token as a bearer header) — no Python
 * subprocess, mirroring the Civitai path.
 *
 * No try/catch — errors bubble to centralized middleware; domain errors throw
 * ServerError.
 */

import { ServerError } from './errorHandler.js';
import { VIDEO_LORA_FAMILIES } from './runners.js';
import { readResponseJson } from './readResponseJson.js';

export const HF_API = 'https://huggingface.co/api/models';
const HF_HOSTS = new Set(['huggingface.co', 'www.huggingface.co']);

// Parse any HuggingFace ref shape into `{ repo, revision }`:
//   https://huggingface.co/fal/ltx2.3-audio-reactive-lora
//   https://huggingface.co/fal/ltx2.3-audio-reactive-lora/tree/main
//   fal/ltx2.3-audio-reactive-lora
//   fal/ltx2.3-audio-reactive-lora@v1.0   (or `:v1.0`)
// `repo` is the `org/name` id; `revision` is a branch/tag/sha or null.
// Throws ServerError on garbage.
export const parseHuggingfaceLoraRef = (raw) => {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new ServerError('Empty HuggingFace URL', { status: 400, code: 'HF_BAD_URL' });
  }
  const trimmed = raw.trim();

  // Bare `org/name` (optionally `@rev` / `:rev`) — no scheme.
  if (!/^https?:\/\//i.test(trimmed)) {
    const m = trimmed.match(/^([^/\s]+\/[^/\s@:]+)(?:[@:]([\w.\-/]+))?$/);
    if (!m) {
      throw new ServerError(
        `HuggingFace ref must be a URL or "org/name" — got "${trimmed.slice(0, 60)}"`,
        { status: 400, code: 'HF_BAD_URL' },
      );
    }
    return { repo: m[1], revision: m[2] || null };
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ServerError(`Malformed URL: "${trimmed.slice(0, 60)}"`, { status: 400, code: 'HF_BAD_URL' });
  }
  if (!HF_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new ServerError(`Not a HuggingFace URL: ${parsed.hostname}`, { status: 400, code: 'HF_BAD_URL' });
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 2) {
    throw new ServerError(
      `HuggingFace URL must point at /<org>/<name> — got "${parsed.pathname}"`,
      { status: 400, code: 'HF_BAD_URL' },
    );
  }
  const repo = `${segments[0]}/${segments[1]}`;
  // Recover a revision from `/tree/<rev>/…` or `/blob/<rev>/…` URLs. The URL
  // shape is `…/<tree|blob>/<rev>/<optional subpath>`, and the subpath itself
  // can contain slashes (`/blob/main/weights/lora.safetensors`), so only the
  // FIRST segment after the marker is the revision — joining the rest would
  // mis-read a subdirectory as part of the ref and 404 the metadata fetch. This
  // means a slash-containing branch/ref pasted as a /tree/ URL isn't recovered
  // (genuinely ambiguous from the URL alone) — use the `org/name@refs/pr/123`
  // form for those (the bare-ref parser above keeps the full ref).
  let revision = null;
  const treeIdx = segments.findIndex((s) => s === 'tree' || s === 'blob');
  if (treeIdx >= 0 && segments[treeIdx + 1]) revision = segments[treeIdx + 1];
  return { repo, revision };
};

// Build the bearer header for an optional HF token. Public LoRAs need no auth;
// gated repos (rare for LoRAs) require the user's token.
export const buildHfAuthHeaders = (token) => {
  if (typeof token !== 'string' || !token.trim()) return {};
  return { Authorization: `Bearer ${token.trim()}` };
};

// HF `resolve` URL for a single file — survives the CDN redirect with the
// bearer header (HF, unlike Civitai, keeps the Authorization header across the
// 302 to its LFS CDN, so no `?token=` query param dance is needed).
export const buildHfResolveUrl = (repo, revision, file) =>
  `https://huggingface.co/${repo}/resolve/${encodeURIComponent(revision || 'main')}/${file.split('/').map(encodeURIComponent).join('/')}`;

// Fetch model metadata from the public HF API. Returns the parsed JSON with
// `siblings` (file list), `tags`, and `cardData` (carries `base_model`).
// fetchImpl is injectable for tests.
export const fetchHuggingfaceModel = async (repo, { token, revision, fetchImpl = fetch } = {}) => {
  if (!/^[^/\s]+\/[^/\s]+$/.test(String(repo))) {
    throw new ServerError(`Invalid HuggingFace repo id: ${repo}`, { status: 400, code: 'HF_BAD_URL' });
  }
  // The `blobs=true` expand isn't needed — siblings carry rfilename, and we
  // size-rank via the resolve HEAD only if multiple LoRA files tie.
  const url = revision
    ? `${HF_API}/${repo}/revision/${encodeURIComponent(revision)}`
    : `${HF_API}/${repo}`;
  const res = await fetchImpl(url, { headers: { Accept: 'application/json', ...buildHfAuthHeaders(token) } });
  if (!res.ok) {
    if (res.status === 404) {
      throw new ServerError(`HuggingFace repo ${repo} not found`, { status: 404, code: 'HF_NOT_FOUND' });
    }
    if (res.status === 401 || res.status === 403) {
      throw new ServerError(
        `HuggingFace rejected the request (${res.status}) — this repo may be gated. Accept its license at https://huggingface.co/${repo} and add your HF token in Image Gen settings.`,
        { status: res.status, code: 'HF_AUTH' },
      );
    }
    throw new ServerError(`HuggingFace metadata fetch failed: ${res.status}`, { status: 502, code: 'HF_FETCH_FAILED' });
  }
  return readResponseJson(res);
};

// All sibling rfilenames of an HF model response (any extension). Shared by the
// LoRA picker and the base-model classifier (huggingfaceModel.js).
export const modelSiblingFilenames = (model) => {
  const siblings = Array.isArray(model?.siblings) ? model.siblings : [];
  return siblings
    .map((s) => (typeof s?.rfilename === 'string' ? s.rfilename : null))
    .filter(Boolean);
};

// List the `.safetensors` siblings of an HF model response.
const safetensorsSiblings = (model) =>
  modelSiblingFilenames(model).filter((f) => /\.safetensors$/i.test(f));

// Pick the LoRA weights file to download. Most LoRA repos ship a single
// .safetensors; when several are present we prefer the canonical diffusers
// filename, then anything with "lora" in the name, then the first. Throws when
// the repo has none (it's not a LoRA weights repo, or weights are split into a
// subdir we don't recognize).
export const pickHfLoraFile = (model) => {
  const files = safetensorsSiblings(model);
  if (!files.length) {
    throw new ServerError(
      `HuggingFace repo ${model?.id || model?.modelId || ''} has no .safetensors file`,
      { status: 422, code: 'HF_NO_SAFETENSORS' },
    );
  }
  if (files.length === 1) return files[0];
  const canonical = files.find((f) => /(^|\/)pytorch_lora_weights\.safetensors$/i.test(f))
    || files.find((f) => /(^|\/)lora\.safetensors$/i.test(f))
    || files.find((f) => /lora/i.test(f) && !/\//.test(f)) // top-level "*lora*"
    || files.find((f) => /lora/i.test(f));
  return canonical || files[0];
};

// Lowercased signal blob for classifying an HF repo: repo id + tags +
// cardData.base_model (string or array). Shared by the LoRA family detector and
// the base-model classifier (huggingfaceModel.js extends it with pipeline_tag /
// library_name). Kept in one place so the two classifiers read the same fields.
export const modelClassificationBlob = ({ repo, model } = {}) => {
  const parts = [String(repo || '').toLowerCase()];
  const tags = Array.isArray(model?.tags) ? model.tags : [];
  for (const t of tags) parts.push(String(t).toLowerCase());
  const baseModel = model?.cardData?.base_model;
  if (typeof baseModel === 'string') parts.push(baseModel.toLowerCase());
  else if (Array.isArray(baseModel)) for (const b of baseModel) parts.push(String(b).toLowerCase());
  return parts.join(' ');
};

// `ltxv` / `ltx-video` / `ltx2` / `ltx-2` / `ltx 2.3` all collapse to ltx.
// Exported so the base-model classifier reuses the exact same LTX detection.
export const LTX_VIDEO_RE = /\bltx[\s._-]?v?(?:ideo)?\b|\bltx[\s._-]?2/;
export const looksLikeLtxVideo = (blob) => LTX_VIDEO_RE.test(blob) || /ltxvideo/.test(blob);

// Detect the PortOS video-LoRA family for an HF repo. LTX-2 / LTX-Video LoRAs
// (fal, Lightricks) map to the `ltx-video` family — the only video family with
// a working runtime today. Looks at the repo id, HF tags, and the card's
// `base_model`. Returns a VIDEO_LORA_FAMILIES value or null (unrecognized →
// the installer surfaces a clear error rather than mis-tagging it).
export const detectVideoLoraFamily = ({ repo, model } = {}) => {
  if (looksLikeLtxVideo(modelClassificationBlob({ repo, model }))) {
    return VIDEO_LORA_FAMILIES.LTX_VIDEO;
  }
  return null;
};

const DESCRIPTION_MAX_CHARS = 2000;

// Read the HF model-card description, clamped to `maxChars`. Shared by the
// sidecar builder (long, persisted) and the video-suggestion card builder
// (short, display-only) — both read the same `cardData.description` but clamp
// to different lengths, so the field-extraction lives in one place.
export const extractHfCardDescription = (model, maxChars) => {
  const raw = typeof model?.cardData?.description === 'string' ? model.cardData.description : '';
  return raw.length > maxChars ? raw.slice(0, maxChars) : raw;
};

// Build the canonical sidecar for an HF-installed video LoRA. Shape mirrors the
// Civitai sidecar (services builds the same fields) but carries a `huggingface`
// block instead of `civitai`, sets `source: 'huggingface'`, and stamps
// `runnerFamily` directly (HF has no Civitai baseModel string for listLoras()
// to re-derive from, so the stored family is authoritative).
export const buildHfLoraSidecar = ({ repo, revision, file, model, family, filename }) => {
  const tags = Array.isArray(model?.tags) ? model.tags : [];
  const baseModelRaw = model?.cardData?.base_model;
  const baseModel = typeof baseModelRaw === 'string'
    ? baseModelRaw
    : (Array.isArray(baseModelRaw) ? baseModelRaw[0] || null : null);
  // HF widget/card sometimes carries trigger words under cardData.instance_prompt
  // or a `widgetData` prompt; keep it best-effort and tolerant of absence.
  const instancePrompt = typeof model?.cardData?.instance_prompt === 'string'
    ? model.cardData.instance_prompt.trim()
    : '';
  const description = extractHfCardDescription(model, DESCRIPTION_MAX_CHARS);
  return {
    filename,
    name: repo.split('/')[1] || repo,
    description,
    huggingface: {
      repo,
      revision: revision || 'main',
      file,
      url: `https://huggingface.co/${repo}`,
      baseModel,
      tags,
    },
    runnerFamily: family,
    fluxVariant: null,
    triggerWords: instancePrompt ? [instancePrompt] : [],
    recommendedScale: 1.0,
    file: {
      sizeKB: null,
      hashes: {},
      downloadUrl: buildHfResolveUrl(repo, revision, file),
    },
    previewImageUrl: null,
    source: 'huggingface',
    installedAt: new Date().toISOString(),
  };
};
