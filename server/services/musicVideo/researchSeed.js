/**
 * Research and seed (#14822): a research agent the director picks (provider,
 * model, effort) searches the web for real photos of a shot's subject; PortOS
 * downloads the image files itself and puts them on the shot as research
 * references (`scene.researchReferences`), which lead its frame conditioning.
 *
 * Containment: the agent prompt carries only the director's subject text. Its
 * answer is reduced to http(s) URLs; nothing it read or wrote (titles,
 * captions, page text) reaches an image or video model, and the reference label
 * is the director's own subject. Downloads go through the SSRF-guarded public
 * fetch with private hosts blocked, and only decodable images are kept.
 * `researchSubjectImages` is the reusable core, for the cameo roster (#14821) to export when it adds research.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerError } from '../../lib/errorHandler.js';
import { extractJson } from '../../lib/jsonExtract.js';
import { PROVIDER_TYPES } from '../../lib/aiToolkit/constants.js';
import { MUSIC_VIDEO_RESEARCH_REFERENCE_LIMIT } from '../../lib/musicVideoConditioning.js';
import { musicVideoEvents } from './events.js';
import { mutateProjectRecord } from './projects.js';
import { requireProject } from './requireProject.js';

export const RESEARCH_SEED_DEFAULT_COUNT = 3;
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 20000;
const DOWNLOAD_MAX_BYTES = 15 * 1024 * 1024;
const MIN_EDGE_PX = 256;
const MAX_EDGE_PX = 1536;
const MAX_CANDIDATES = 12;
// Wikimedia and other hosts refuse requests without a descriptive agent.
const DOWNLOAD_HEADERS = { 'User-Agent': 'PortOS-research-seed/1.0 (reference photo import)', Accept: 'image/*' };

export const deps = {
  resolve: async (args) => (await import('../promptRunner.js')).resolveProviderAndModel(args),
  run: async (args) => (await import('../promptRunner.js')).runPromptThroughProvider(args),
  fetchImage: async (url, options) => (await import('../../lib/safeUrlFetch.js')).fetchPublicBinary(url, options),
  saveImage: async (buffer) => (await import('../imageGen/local.js')).saveUploadedGalleryImage(buffer.toString('base64')),
  sharp: async () => (await import('sharp')).default,
};

const running = new Set();
const runKey = (projectId, sceneId) => `${projectId}:${sceneId}`;

/** The exact prompt the research agent receives: fixed instructions plus the director's subject. */
function researchSeedPrompt(subject, count) {
  return [
    `Search the web for real photographs of: ${subject}`,
    '',
    `Find ${count} photos that show this subject accurately, best first, plus a few spares in case a download fails.`,
    '- Each must be a genuine photograph: no illustration, drawing, AI-generated image, 3D render, collage or meme.',
    '- The subject is clearly visible, large in frame and not cropped off; one subject per photo; no text or watermark over it.',
    '- Vary the angle between photos when you can (side, three-quarter, front).',
    '- Prefer openly licensed sources such as Wikimedia Commons, then reputable references (breed clubs, museums, manufacturers).',
    '- Give the direct URL of the image file itself (ending in .jpg, .jpeg, .png or .webp where possible) that downloads without a login, ideally 800 to 2000 pixels on the long side, and the URL of the page it appears on.',
    '',
    `Reply with only this JSON, at most ${MAX_CANDIDATES} entries: {"images":[{"imageUrl":"<direct image file URL>","pageUrl":"<page URL>"}]}`,
  ].join('\n');
}

const httpUrl = (value) => {
  if (typeof value !== 'string' || value.length > 2000) return null;
  let url;
  try { url = new URL(value.trim()); } catch { return null; }
  return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
};

/** The agent's answer reduced to unique `{ imageUrl, pageUrl }` http(s) pairs, in its order. */
function parseResearchCandidates(text) {
  const { value } = extractJson(String(text || ''), { shapePredicate: (v) => Array.isArray(v?.images) });
  if (!Array.isArray(value?.images)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of value.images) {
    const imageUrl = httpUrl(entry?.imageUrl);
    if (!imageUrl || seen.has(imageUrl)) continue;
    seen.add(imageUrl);
    out.push({ imageUrl, pageUrl: httpUrl(entry?.pageUrl) });
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

/** Download one candidate into the gallery, or null when it is not a usable photo. */
async function importCandidate({ imageUrl, pageUrl }) {
  const fetched = await deps.fetchImage(imageUrl, { timeoutMs: DOWNLOAD_TIMEOUT_MS, maxBytes: DOWNLOAD_MAX_BYTES, blockPrivate: true, throwOnUnsafe: false, headers: DOWNLOAD_HEADERS })
    .catch(() => null);
  if (!fetched?.buffer?.length || /^(text|application\/(json|xml|xhtml))/i.test(fetched.contentType || '')) return null;
  const sharp = await deps.sharp();
  const meta = await sharp(fetched.buffer, { limitInputPixels: 96e6 }).metadata().catch(() => null);
  if (!meta?.width || !meta?.height || Math.min(meta.width, meta.height) < MIN_EDGE_PX) return null;
  const png = await sharp(fetched.buffer, { limitInputPixels: 96e6 }).rotate()
    .resize({ width: MAX_EDGE_PX, height: MAX_EDGE_PX, fit: 'inside', withoutEnlargement: true }).png().toBuffer().catch(() => null);
  if (!png) return null;
  const saved = await deps.saveImage(png).catch(() => null);
  return saved?.filename ? { imageId: saved.filename, sourceUrl: imageUrl, pageUrl, addedAt: new Date().toISOString() } : null;
}

async function resolveResearchProvider({ providerId, model }, hasHostControl) {
  const { provider, selectedModel } = await deps.resolve({ providerId, model: model || undefined });
  if (!provider || provider.id !== providerId || provider.enabled === false) {
    throw new ServerError('The selected provider is unavailable.', { status: 400, code: 'NO_PROVIDER' });
  }
  // The agent runs with its tools (web search), so a CLI agent needs host control.
  if (provider.type !== PROVIDER_TYPES.API && hasHostControl !== true) {
    throw new ServerError(`Provider '${provider.id}' searches the web with its tools, so research needs host control: an operator session, or a local connection when no password is set.`, { status: 403, code: 'HOST_CONTROL_FORBIDDEN' });
  }
  return { provider, selectedModel };
}

/**
 * Run the research agent for `subject` and import up to `count` photos into the
 * gallery. Resolves to `{ images: [{ imageId, sourceUrl, pageUrl, addedAt }], runId, providerId, model }`.
 * Pass `resolved` when the caller already checked the provider.
 */
async function researchSubjectImages({ subject, count = RESEARCH_SEED_DEFAULT_COUNT, providerId, model, effort, executionOptions, hasHostControl = false, resolved = null }) {
  const { provider, selectedModel } = resolved || await resolveResearchProvider({ providerId, model }, hasHostControl);
  const cwd = await mkdtemp(join(tmpdir(), 'portos-research-'));
  const result = await deps.run({ provider, model: selectedModel, effort: effort || undefined, executionOptions,
    prompt: researchSeedPrompt(subject, count), source: 'music-video-research-seed', allowFallback: false, cwd, timeout: RUN_TIMEOUT_MS })
    .finally(() => rm(cwd, { recursive: true, force: true }).catch(() => {}));
  const candidates = parseResearchCandidates(result?.text);
  const images = [];
  for (const candidate of candidates) {
    if (images.length >= count) break;
    const image = await importCandidate(candidate);
    if (image) images.push(image);
  }
  return { images, candidates: candidates.length, runId: result?.runId || null, providerId: provider.id, model: result?.model || selectedModel || null };
}

/** Put imported photos on the shot; a shot with its own reference picks sends them too, first. */
function addResearchReferences(project, sceneId, subject, images) {
  const scene = (project.scenes || []).find((s) => s.sceneId === sceneId);
  if (!scene) throw new ServerError('Scene not found', { status: 404, code: 'NOT_FOUND' });
  const existing = Array.isArray(scene.researchReferences) ? scene.researchReferences : [];
  const added = images.slice(0, Math.max(0, MUSIC_VIDEO_RESEARCH_REFERENCE_LIMIT - existing.length))
    .map((image) => ({ id: `mvr-research-${randomUUID().slice(0, 8)}`, subject, ...image }));
  const patch = { researchReferences: [...existing, ...added] };
  if (Array.isArray(scene.frameReferenceIds)) patch.frameReferenceIds = [...added.map((ref) => ref.id), ...scene.frameReferenceIds];
  return { patch, added };
}

const emit = (payload) => musicVideoEvents.emit('scene-research', payload);

/**
 * Start Research and seed for one shot. `preview` answers with the prompt the
 * agent would get. Otherwise the run continues in the background and settles
 * as a `scene-research` event carrying the saved project; answers `{ status: 'running' }`.
 */
export async function startSceneResearch(projectId, sceneId, input, { hasHostControl = false } = {}) {
  const project = await requireProject(projectId);
  const scene = (project.scenes || []).find((s) => s.sceneId === sceneId);
  if (!scene) throw new ServerError('Scene not found', { status: 404, code: 'NOT_FOUND' });
  const subject = input.subject.trim();
  const room = MUSIC_VIDEO_RESEARCH_REFERENCE_LIMIT - (scene.researchReferences?.length || 0);
  const count = Math.min(input.count || RESEARCH_SEED_DEFAULT_COUNT, Math.max(room, 0));
  const sentPrompt = researchSeedPrompt(subject, count || RESEARCH_SEED_DEFAULT_COUNT);
  // Everything after the subject line is PortOS's own instruction block (#11317).
  const promptAdditions = [{ id: 'research-seed-instructions', label: 'Research instructions', text: sentPrompt.split('\n').slice(2).join('\n') }];
  if (input.preview) return { status: 'preview', sentPrompt, promptAdditions };
  if (count < 1) throw new ServerError(`This shot already has ${MUSIC_VIDEO_RESEARCH_REFERENCE_LIMIT} research photos. Drop one first.`, { status: 409, code: 'RESEARCH_FULL' });
  const key = runKey(projectId, sceneId);
  if (running.has(key)) throw new ServerError('Research is already running for this shot.', { status: 409, code: 'RESEARCH_RUNNING' });
  const resolved = await resolveResearchProvider(input, hasHostControl);
  running.add(key);
  emit({ projectId, sceneId, status: 'running', subject });
  (async () => {
    const found = await researchSubjectImages({ ...input, subject, count, resolved });
    if (!found.images.length) {
      throw new ServerError(found.candidates ? `None of the ${found.candidates} photos the agent found could be downloaded as images.` : 'The agent found no photo links.', { code: 'RESEARCH_EMPTY' });
    }
    const { applySceneUpdate } = await import('./projectsLogic.js');
    let added = [];
    const outcome = await mutateProjectRecord(projectId, (current) => {
      const next = addResearchReferences(current, sceneId, subject, found.images);
      added = next.added;
      return applySceneUpdate(current, sceneId, next.patch);
    });
    console.log(`🔎 Research and seed: ${added.length} photo(s) for shot ${sceneId} of ${projectId}`);
    emit({ projectId, sceneId, status: 'done', subject, added: added.length, project: outcome.project });
  })().catch((err) => {
    if (err?.code === 'RESEARCH_EMPTY') console.log(`⏭️ Research and seed found nothing usable for shot ${sceneId} of ${projectId}: ${err.message}`);
    else console.error(`❌ Research and seed failed for shot ${sceneId} of ${projectId}: ${err?.message}`);
    emit({ projectId, sceneId, status: 'failed', subject, error: String(err.message || 'Research failed').slice(0, 300) });
  }).finally(() => running.delete(key));
  return { status: 'running', sentPrompt, promptAdditions };
}
