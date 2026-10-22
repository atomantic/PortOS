/**
 * Replace OpenCode Zen model ids that `opencode models` no longer lists.
 *
 * Migration 336 seeded `opencode-zen-cli` / `opencode-zen-tui` with free-tier
 * ids the CLI has since retired. A job pinned to one dies with
 * `model-not-found` before any prompt is sent. This rewrites every reference —
 * the providers' `models` list and tier pointers, and the `model` override on
 * autonomous jobs — to the nearest id the CLI still lists. The retired ids no
 * longer resolve anywhere, so a curated list is rewritten too (deduped, order
 * kept); only the retired entries change.
 *
 * Kept in lockstep with data.reference/providers.json,
 * server/lib/aiToolkit/defaults/providers.sample.json and
 * scripts/generate-provider-samples.js.
 */

import { join } from 'path';
import { readProvidersDoc, readJsonOrNull, writeJsonAtomic } from './_lib.js';

const TARGET_PROVIDER_IDS = ['opencode-zen-cli', 'opencode-zen-tui'];
const MODEL_POINTER_KEYS = ['defaultModel', 'lightModel', 'mediumModel', 'heavyModel', 'ultraModel'];
const JOBS_REL_PATH = join('data', 'cos', 'autonomous-jobs.json');

const RETIRED_TO_CURRENT = {
  'opencode/ling-3.0-flash-fin-free': 'opencode/deepseek-v4.1-flash-free',
  'opencode/mimo-v2.5-free': 'opencode/mimo-v2.6-flash-free',
  'opencode/muse-spark-1.2-contributor-free': 'opencode/glm-5.3-flash-free',
  'opencode/muse-spark-1.3-contributor-free': 'opencode/minimax-m3.1-flash-free',
  'opencode/space-bunny-free': 'opencode/big-pickle',
};

const replacement = (id) => (Object.hasOwn(RETIRED_TO_CURRENT, id) ? RETIRED_TO_CURRENT[id] : null);

async function migrateProviders(rootDir) {
  const doc = await readProvidersDoc({ rootDir });
  if (!doc.ok) return [];
  const touched = [];
  for (const id of TARGET_PROVIDER_IDS) {
    const provider = Object.hasOwn(doc.providers, id) ? doc.providers[id] : null;
    if (!provider || typeof provider !== 'object') continue;
    let changed = false;
    if (Array.isArray(provider.models) && provider.models.some((m) => replacement(m))) {
      provider.models = [...new Set(provider.models.map((m) => replacement(m) ?? m))];
      changed = true;
    }
    for (const key of MODEL_POINTER_KEYS) {
      const next = replacement(provider[key]);
      if (next) { provider[key] = next; changed = true; }
    }
    if (changed) touched.push(id);
  }
  if (touched.length) await writeJsonAtomic(doc.path, doc.config);
  return touched;
}

async function migrateJobs(rootDir) {
  const path = join(rootDir, JOBS_REL_PATH);
  const doc = await readJsonOrNull(path);
  if (!Array.isArray(doc?.jobs)) return [];
  const touched = [];
  for (const job of doc.jobs) {
    const next = TARGET_PROVIDER_IDS.includes(job?.providerId) ? replacement(job.model) : null;
    if (next) { job.model = next; touched.push(job.id); }
  }
  if (touched.length) await writeJsonAtomic(path, doc);
  return touched;
}

export default {
  async up({ rootDir }) {
    const providers = await migrateProviders(rootDir);
    const jobs = await migrateJobs(rootDir);
    if (providers.length || jobs.length) {
      console.log(`🔧 Retired OpenCode Zen model ids replaced: ${providers.length} provider(s), ${jobs.length} job(s)`);
    }
    return { ok: true, providers, jobs };
  },
};
