/**
 * User-installed audio model registry — augments the shipped music-gen engine
 * model lists (server/services/pipeline/musicGen.js `ENGINES[id].models`) with
 * extra HuggingFace checkpoints the user downloads via the Music studio.
 *
 * The SHIPPED models live in code (musicGen.js); this registry holds only the
 * user's ADDITIONS, persisted to `data/audio-models.json` keyed by engine id:
 *
 *   { "musicgen": [ { "id": "facebook/musicgen-large", "repo": "facebook/musicgen-large", "name": "MusicGen Large" } ],
 *     "audioldm2": [], "acestep": [] }
 *
 * `listEngineModels(engineId)` merges shipped + user models (shipped first,
 * deduped by id) so the route/UI present one combined list. A user model's `id`
 * IS its HF repo id, which the sidecar passes straight to `--model`, so a
 * downloaded checkpoint is selectable for generation immediately (no restart —
 * the JSON is read on each list call, unlike the code-level defaults).
 *
 * Install flow: the route downloads the HF repo via `downloadHfRepo` (shared
 * with the image/video model installer) into the local HF cache, then calls
 * `addAudioModel` here to register it. Removing a model only de-registers it
 * (the cached weights are managed by the HF cache, not deleted here).
 */

import { join } from 'path';
import { readJSONFile, atomicWrite, ensureDir } from '../lib/fileUtils.js';
import { PATHS } from '../lib/fileUtils.js';
import { getEngine, ENGINES } from './pipeline/musicGen.js';

const REGISTRY_FILE = join(PATHS.data, 'audio-models.json');

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
// HF repo ids look like `org/name` (optionally with extra path segments). Keep
// the guard permissive but reject path-traversal / whitespace / control chars.
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._\/-]+$/;

export function isValidRepoId(repo) {
  return isStr(repo) && REPO_RE.test(repo.trim()) && !repo.includes('..');
}

// One sanitized user-model entry, or null to drop. `id` defaults to the repo id
// (what the sidecar's --model wants); `name` defaults to the repo's basename.
function sanitizeUserModel(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const repo = isStr(raw.repo) ? raw.repo.trim() : '';
  if (!isValidRepoId(repo)) return null;
  const id = isStr(raw.id) ? raw.id.trim() : repo;
  const name = isStr(raw.name) ? raw.name.trim().slice(0, 200) : repo.split('/').pop();
  return { id, repo, name };
}

async function loadRegistry() {
  const raw = await readJSONFile(REGISTRY_FILE, {});
  const out = {};
  if (raw && typeof raw === 'object') {
    for (const engineId of Object.keys(ENGINES)) {
      const list = Array.isArray(raw[engineId]) ? raw[engineId] : [];
      out[engineId] = list.map(sanitizeUserModel).filter(Boolean);
    }
  } else {
    for (const engineId of Object.keys(ENGINES)) out[engineId] = [];
  }
  return out;
}

async function saveRegistry(registry) {
  await ensureDir(PATHS.data);
  await atomicWrite(REGISTRY_FILE, registry);
}

/** User-added models for one engine (sanitized). */
export async function listUserModels(engineId) {
  const reg = await loadRegistry();
  return reg[engineId] || [];
}

/**
 * The combined model list for an engine: shipped defaults (from musicGen.js)
 * first, then user-added, deduped by id. Returned shape is `{ id, name, repo? }`
 * matching the shipped models so the route/UI treat them uniformly. `userAdded`
 * marks the entries this registry contributed (so the UI can offer "remove").
 */
export async function listEngineModels(engineId) {
  const engine = getEngine(engineId);
  const shipped = engine.models.map((m) => ({ id: m.id, name: m.name, repo: m.repo, userAdded: false }));
  const seen = new Set(shipped.map((m) => m.id));
  const user = (await listUserModels(engine.id))
    .filter((m) => !seen.has(m.id))
    .map((m) => ({ id: m.id, name: m.name, repo: m.repo, userAdded: true }));
  return [...shipped, ...user];
}

/**
 * Register a downloaded HF checkpoint for an engine. Idempotent: re-adding the
 * same repo updates its display name rather than duplicating. Rejects an unknown
 * engine or an invalid repo id. Returns the sanitized entry.
 */
export async function addAudioModel({ engine: engineId, repo, name }) {
  if (!ENGINES[engineId]) {
    throw Object.assign(new Error(`Unknown audio engine: ${engineId}`), { status: 400, code: 'AUDIO_MODEL_UNKNOWN_ENGINE' });
  }
  const entry = sanitizeUserModel({ repo, name, id: repo });
  if (!entry) {
    throw Object.assign(new Error('Invalid HuggingFace repo id'), { status: 400, code: 'AUDIO_MODEL_INVALID_REPO' });
  }
  const reg = await loadRegistry();
  const list = reg[engineId] || [];
  const idx = list.findIndex((m) => m.id === entry.id);
  if (idx >= 0) list[idx] = entry;
  else list.push(entry);
  reg[engineId] = list;
  await saveRegistry(reg);
  console.log(`🎚️ Registered audio model for ${engineId}: ${entry.repo}`);
  return entry;
}

/**
 * De-register a user-added model (does NOT touch the cached weights — the HF
 * cache owns those). Returns true if an entry was removed. A shipped default id
 * is a no-op (not in the user registry) — shipped models can't be removed here.
 */
export async function removeAudioModel({ engine: engineId, id }) {
  const reg = await loadRegistry();
  const list = reg[engineId] || [];
  const next = list.filter((m) => m.id !== id);
  if (next.length === list.length) return false;
  reg[engineId] = next;
  await saveRegistry(reg);
  console.log(`🎚️ De-registered audio model for ${engineId}: ${id}`);
  return true;
}
