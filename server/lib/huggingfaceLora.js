/**
 * HuggingFace LoRA import — pure helpers for parsing HF refs, fetching repo
 * metadata, picking the .safetensors to download, and building the PortOS
 * sidecar for an image or video LoRA.
 *
 * Image LoRAs (Flux.2 Klein, Z-Image, …) and video LoRAs (fal/LTX, MiniMax H3)
 * both live on HuggingFace. Civitai's installer can't reach them. This module
 * is the HF analogue of server/lib/civitai.js: it parses the ref, hits the
 * public `/api/models/{repo}` endpoint for the file list + card data, picks
 * the LoRA weights file, classifies the runner family, and shapes a sidecar
 * that listLoras() can read.
 *
 * The download itself reuses services/loras.js#downloadToFile against the HF
 * `resolve` URL (with the user's HF token as a bearer header) — no Python
 * subprocess, mirroring the Civitai path.
 *
 * No try/catch — errors bubble to centralized middleware; domain errors throw
 * ServerError.
 */

import { ServerError } from './errorHandler.js';
import { RUNNER_FAMILIES, VIDEO_LORA_FAMILIES } from './runners.js';
import { readResponseJson } from './readResponseJson.js';
import { licenseFromHuggingFaceModel } from './assetProvenance.js';

// Families the HF installer may stamp. Image runners plus video families —
// the route schema and the family-override validator share this list.
export const HF_LORA_FAMILIES = Object.freeze([
  ...Object.values(RUNNER_FAMILIES),
  ...Object.values(VIDEO_LORA_FAMILIES),
]);

export const HF_API = 'https://huggingface.co/api/models';

/**
 * `owner/name` — the only shape PortOS hands to an HF download or an argv slot.
 *
 * Each segment must START alphanumeric, so neither `owner/..` (which a path
 * walk would follow out of a cache directory) nor a leading `-` (which an
 * argument parser would read as a flag) can get through. One definition because
 * two copies of a security rule drift: the MTPLX pull/remove schema and the
 * Slotstream checkpoint catalog both validate against this.
 */
export const HF_REPO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HF_HOSTS = new Set(['huggingface.co', 'www.huggingface.co']);

// Parse any HuggingFace ref shape into `{ repo, revision, file }`:
//   https://huggingface.co/fal/ltx2.3-audio-reactive-lora
//   https://huggingface.co/fal/ltx2.3-audio-reactive-lora/tree/main
//   https://huggingface.co/org/name/blob/main/weights.safetensors
//   fal/ltx2.3-audio-reactive-lora
//   fal/ltx2.3-audio-reactive-lora@v1.0   (or `:v1.0`)
// `repo` is the `org/name` id; `revision` is a branch/tag/sha or null;
// `file` is a `.safetensors` path recovered from /blob/ or /resolve/ URLs.
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
    return { repo: m[1], revision: m[2] || null, file: null };
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
  // Recover a revision from `/tree/<rev>/…`, `/blob/<rev>/…`, or
  // `/resolve/<rev>/…` URLs. The URL shape is `…/<marker>/<rev>/<optional
  // subpath>`, and the subpath itself can contain slashes
  // (`/blob/main/weights/lora.safetensors`), so only the FIRST segment after
  // the marker is the revision — joining the rest would mis-read a
  // subdirectory as part of the ref and 404 the metadata fetch. This means a
  // slash-containing branch/ref pasted as a /tree/ URL isn't recovered
  // (genuinely ambiguous from the URL alone) — use the `org/name@refs/pr/123`
  // form for those (the bare-ref parser above keeps the full ref).
  //
  // When the leftover subpath ends in `.safetensors`, surface it as `file` so
  // pasting a specific weight URL (CharacterSheet/blob/main/TripleView_*.safetensors)
  // installs that artifact instead of the repo's auto-picked sibling.
  let revision = null;
  let file = null;
  const treeIdx = segments.findIndex((s) => s === 'tree' || s === 'blob' || s === 'resolve');
  if (treeIdx >= 0 && segments[treeIdx + 1]) {
    revision = segments[treeIdx + 1];
    const rest = segments.slice(treeIdx + 2);
    if (rest.length && /\.safetensors$/i.test(rest[rest.length - 1])) {
      file = rest.join('/');
    }
  }
  return { repo, revision, file };
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
// The LoRA picker doesn't need `blobs=true` — siblings carry rfilename, and it
// size-ranks via the resolve HEAD only if multiple LoRA files tie. Pass
// `blobs: true` when the caller needs per-file SIZES up front instead: a
// whole-repo download has to total them before it can preflight the disk, and
// one HEAD per file across a 30-shard checkpoint is 30 round trips for numbers
// this expand already carries.
export const fetchHuggingfaceModel = async (repo, { token, revision, fetchImpl = fetch, signal, blobs = false } = {}) => {
  if (!/^[^/\s]+\/[^/\s]+$/.test(String(repo))) {
    throw new ServerError(`Invalid HuggingFace repo id: ${repo}`, { status: 400, code: 'HF_BAD_URL' });
  }
  const path = revision
    ? `${HF_API}/${repo}/revision/${encodeURIComponent(revision)}`
    : `${HF_API}/${repo}`;
  const url = blobs ? `${path}?blobs=true` : path;
  const res = await fetchImpl(url, { headers: { Accept: 'application/json', ...buildHfAuthHeaders(token) }, signal });
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

// A weight file trained for Krea 2 (not a PortOS runner). Repos like
// Alissonerdx/CharacterSheet ship Klein-9B *and* Krea siblings; the Krea
// artifact must not be auto-picked (or inherit the repo's flux.2 tags).
const KREA_FILE_RE = /(?:^|[-_/\s.])krea(?:[\s._-]?2)?(?:[-_/\s.]|$)/i;
const FLUX2_LORA_RE = /flux[\s._-]?2|flux\.2|klein[\s._-]?[49]b/i;

// '4b' | '9b' | null from a classification blob or filename. `klein9b` /
// `klein-9b` / `flux.2-klein-9b` all resolve; a bare "4bit" does not.
export const flux2VariantFromBlob = (blob) => {
  if (typeof blob !== 'string' || !blob) return null;
  const m = blob.match(/(?:^|[-_/\s.])(?:klein[\s._-]?)?([49])b(?:[-_/\s.]|$)/i);
  return m ? `${m[1].toLowerCase()}b` : null;
};

const fileLooksLikeKrea = (filename) =>
  KREA_FILE_RE.test(filename) && !FLUX2_LORA_RE.test(filename);

const fileMatchesFlux2Variant = (filename, variant) => {
  if (fileLooksLikeKrea(filename)) return false;
  if (variant === '9b') return /klein[\s._-]?9b|(?:^|[-_/])9b(?:[-_./]|$)/i.test(filename);
  if (variant === '4b') return /klein[\s._-]?4b|(?:^|[-_/])4b(?:[-_./]|$)/i.test(filename);
  return FLUX2_LORA_RE.test(filename);
};

// Pick the LoRA weights file to download. An explicit file must exactly match a
// .safetensors sibling — this lets curated cards select a versioned artifact
// from repos that publish several LoRAs without accepting an arbitrary path.
// Without an explicit file, prefer a sibling matching `familyHint` (so a
// Flux.2 Klein 9B card isn't installed as its Krea sibling), then the legacy
// canonical-name preference.
export const pickHfLoraFile = (model, preferredFile = null, familyHint = null) => {
  const files = safetensorsSiblings(model);
  if (!files.length) {
    throw new ServerError(
      `HuggingFace repo ${model?.id || model?.modelId || ''} has no .safetensors file`,
      { status: 422, code: 'HF_NO_SAFETENSORS' },
    );
  }
  if (preferredFile) {
    const exact = files.find((file) => file === preferredFile);
    if (!exact) {
      throw new ServerError(
        `HuggingFace repo ${model?.id || model?.modelId || ''} does not contain ${preferredFile}`,
        { status: 422, code: 'HF_FILE_NOT_FOUND' },
      );
    }
    return exact;
  }
  if (files.length === 1) return files[0];
  if (familyHint?.family === RUNNER_FAMILIES.FLUX2) {
    const match = files.find((f) => fileMatchesFlux2Variant(f, familyHint.fluxVariant || null));
    if (match) return match;
  }
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

// `minimax h3` / `minimax-h3` / `MiniMaxAI/MiniMax-H3` all collapse to H3.
// Requires the `minimax` maker token so a bare "h3" (a common version suffix)
// can't mis-tag an unrelated adapter into a family whose runtime would reject
// its key layout at render time.
export const MINIMAX_H3_RE = /\bminimax[\s._-]?h[\s._-]?3\b/;
export const looksLikeMiniMaxH3 = (blob) => MINIMAX_H3_RE.test(blob);

// Detect the PortOS video-LoRA family for an HF repo. LTX-2 / LTX-Video LoRAs
// (fal, Lightricks) map to `ltx-video`; MiniMax H3 LoRAs map to `minimax-h3`,
// which only renders once the installed H3 runtime plus PortOS's adapter proves
// it can apply LoRAs to its quantized DiT (see services/videoGen/runtimes.js).
// Looks at the repo id,
// HF tags, and the card's `base_model`. Returns a VIDEO_LORA_FAMILIES value or
// null (unrecognized → the installer surfaces a clear error rather than
// mis-tagging it).
export const detectVideoLoraFamily = ({ repo, model } = {}) => {
  const blob = modelClassificationBlob({ repo, model });
  // H3 first: an H3 adapter card can name LTX among comparison models, and the
  // LTX pattern is the looser of the two.
  if (looksLikeMiniMaxH3(blob)) return VIDEO_LORA_FAMILIES.MINIMAX_H3;
  if (looksLikeLtxVideo(blob)) return VIDEO_LORA_FAMILIES.LTX_VIDEO;
  return null;
};

// Image-runner detection for an HF LoRA. Looks at the repo id, tags,
// cardData.base_model, sibling filenames, and an optional picked file.
// A picked Krea-2 file does not inherit sibling/repo flux.2 tags — those
// describe a different artifact in the same collection.
export const detectImageLoraFamily = ({ repo, model, file } = {}) => {
  const fileName = typeof file === 'string' ? file : '';
  if (fileName && fileLooksLikeKrea(fileName)) return null;
  const siblings = modelSiblingFilenames(model).join(' ');
  const blob = `${modelClassificationBlob({ repo, model })} ${siblings} ${fileName}`.toLowerCase();
  // FLUX.2 before FLUX.1 — "flux.2" contains "flux". klein9b is a Flux.2
  // Klein size marker even when the card omits the word "flux".
  if (FLUX2_LORA_RE.test(blob)) {
    return { family: RUNNER_FAMILIES.FLUX2, fluxVariant: flux2VariantFromBlob(blob) };
  }
  if (/z[\s._-]?image/.test(blob)) return { family: RUNNER_FAMILIES.Z_IMAGE, fluxVariant: null };
  if (/ernie/.test(blob)) return { family: RUNNER_FAMILIES.ERNIE, fluxVariant: null };
  if (/hidream/.test(blob)) return { family: RUNNER_FAMILIES.HIDREAM, fluxVariant: null };
  if (/qwen[\s._-]?image/.test(blob)) return { family: RUNNER_FAMILIES.QWEN, fluxVariant: null };
  if (/flux[\s._-]?1|flux\.1|\bflux\b/.test(blob)) {
    return { family: RUNNER_FAMILIES.MFLUX, fluxVariant: null };
  }
  return null;
};

// Combined image+video classifier. Image wins when both signals exist: cards
// like Alissonerdx/CharacterSheet tag flux.2-klein-9b and mention LTX only as
// a downstream identity-reference use case. Returns `{ family, fluxVariant }`
// or null (unrecognized → the installer surfaces HF_UNKNOWN_FAMILY).
export const detectHfLoraFamily = ({ repo, model, file } = {}) => {
  const image = detectImageLoraFamily({ repo, model, file });
  if (image) return image;
  const video = detectVideoLoraFamily({ repo, model });
  if (video) return { family: video, fluxVariant: null };
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
export const buildHfLoraSidecar = ({ repo, revision, file, model, family, filename, fluxVariant = null }) => {
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
  const isV2 = /(?:^|[-_.])v2(?:[-_.]|$)/i.test(file);
  // Multi-file collections (CharacterSheet ships TripleView + QuadView + Krea)
  // need the file stem in the display name so two installs from the same repo
  // don't show up as identical cards. Canonical single-file names
  // (pytorch_lora_weights / lora) stay as the repo name.
  const repoName = repo.split('/')[1] || repo;
  const fileStem = typeof file === 'string'
    ? file.replace(/\.safetensors$/i, '').split('/').pop()
    : '';
  const useFileStem = fileStem && !/^(pytorch_lora_weights|lora)$/i.test(fileStem);
  const baseName = useFileStem ? `${repoName} · ${fileStem}` : repoName;
  const alreadyV2 = /(?:^|[-_.])v2(?:[-_.]|$)/i.test(baseName);
  return {
    filename,
    name: `${baseName}${isV2 && !alreadyV2 ? ' V2' : ''}`,
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
    fluxVariant: family === RUNNER_FAMILIES.FLUX2 ? (fluxVariant || null) : null,
    triggerWords: instancePrompt ? [instancePrompt] : [],
    recommendedScale: isV2 ? 1.2 : 1.0,
    file: {
      sizeKB: null,
      hashes: {},
      downloadUrl: buildHfResolveUrl(repo, revision, file),
    },
    previewImageUrl: null,
    source: 'huggingface',
    license: licenseFromHuggingFaceModel(model),
    installedAt: new Date().toISOString(),
  };
};
