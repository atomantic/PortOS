/**
 * Make `claude-opus-5-5` the Claude Code CLI/TUI default and heavy tier.
 *
 * `setup-data.js` merges missing provider entries but never updates existing
 * ones, so an install keeps its seeded `claude-opus-5` pointers until this runs.
 *
 * Conservative, matching migration 206's policy:
 *   - Offer `claude-opus-5-5` (spliced in right before `claude-opus-5`) on any
 *     record that lists `claude-opus-5` but not `claude-opus-5-5`. Opus 5 stays
 *     selectable.
 *   - Move `defaultModel` / `heavyModel` from `claude-opus-5` to
 *     `claude-opus-5-5` only when the record's `models` still matches the
 *     shipped list EXACTLY (before or after the insert). A curated list means
 *     the user owns the pins, so they are left as found.
 *
 * Bedrock records are out of scope: Opus 5.5's Bedrock model id is not
 * confirmed, and offering an id the region can't resolve breaks every run.
 */

import { readProvidersDoc, writeJsonAtomic } from './_lib.js';

const OLD = 'claude-opus-5';
const NEW = 'claude-opus-5-5';
const TARGET_IDS = ['claude-code', 'claude-code-tui'];
const SHIPPED_MODELS = ['claude-fable-5-1', 'claude-haiku-4-5', 'claude-sonnet-5', OLD];
const SHIPPED_MODELS_WITH_NEW = ['claude-fable-5-1', 'claude-haiku-4-5', 'claude-sonnet-5', NEW, OLD];
const REPOINTED_KEYS = ['defaultModel', 'heavyModel'];

const sameArray = (a, b) => Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);

export default {
  async up({ rootDir }) {
    const doc = await readProvidersDoc({ rootDir });
    if (!doc.ok) {
      if (doc.reason === 'no-file') console.log('📄 data/providers.json not present — skipping (fresh install seeds Opus 5.5 from data.reference)');
      else console.warn(`⚠️ data/providers.json: ${doc.reason}, skipping Opus 5.5 default`);
      return { ok: false, reason: doc.reason, updated: 0 };
    }

    const { config, providers, path } = doc;
    const touched = [];
    for (const id of TARGET_IDS) {
      const provider = providers[id];
      if (!provider || !Array.isArray(provider.models)) continue;
      const shipped = sameArray(provider.models, SHIPPED_MODELS) || sameArray(provider.models, SHIPPED_MODELS_WITH_NEW);
      let changed = false;

      const at = provider.models.indexOf(OLD);
      if (at !== -1 && !provider.models.includes(NEW)) {
        provider.models = [...provider.models.slice(0, at), NEW, ...provider.models.slice(at)];
        changed = true;
      }
      if (shipped) {
        for (const key of REPOINTED_KEYS) {
          if (provider[key] === OLD) {
            provider[key] = NEW;
            changed = true;
          }
        }
      }
      if (changed) touched.push(`${id} (default: ${provider.defaultModel})`);
    }

    if (touched.length === 0) {
      console.log('✅ data/providers.json: Claude Code Opus 5.5 default already current — no change');
      return { ok: true, reason: 'already-current', updated: 0 };
    }
    await writeJsonAtomic(path, config);
    console.log(`📝 data/providers.json: updated ${touched.join(', ')} → Opus 5.5`);
    return { ok: true, reason: 'updated', updated: touched.length };
  },
};
