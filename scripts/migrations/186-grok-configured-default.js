/**
 * Rewrite Grok Build CLI/TUI model fields from the short-lived `grok-build`
 * pseudo-model to the `grok-configured-default` sentinel (Antigravity/Codex
 * pattern). PortOS never selects a Grok Build model — the local `grok` binary
 * uses its own latest default, so the model picker should stay hidden.
 *
 * Migration 185 shipped the CLI/TUI with `models: ['grok-build']` (a real-looking
 * id that still appeared in model dropdowns). This migration rewrites only the
 * shipped `grok-build` value on model fields; any other custom model id is left
 * alone so a user who intentionally pinned a concrete model keeps it.
 *
 * Kept in lockstep with data.reference/providers.json and
 * server/lib/aiToolkit/defaults/providers.sample.json.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const PROVIDERS_REL_PATH = 'data/providers.json';
const TARGET_IDS = ['grok-cli', 'grok-tui'];
const OLD = 'grok-build';
const NEW = 'grok-configured-default';
const MODEL_FIELDS = ['defaultModel', 'lightModel', 'mediumModel', 'heavyModel', 'fallbackModel'];

const rewriteModelsList = (models) => {
  if (!Array.isArray(models)) return { models, changed: false };
  let changed = false;
  const next = models.map((m) => {
    if (m === OLD) {
      changed = true;
      return NEW;
    }
    return m;
  });
  return { models: next, changed };
};

const rewriteProvider = (provider) => {
  if (!provider || typeof provider !== 'object') return false;
  let changed = false;

  const list = rewriteModelsList(provider.models);
  if (list.changed) {
    provider.models = list.models;
    changed = true;
  }

  for (const field of MODEL_FIELDS) {
    if (provider[field] === OLD) {
      provider[field] = NEW;
      changed = true;
    }
  }

  return changed;
};

export default {
  async up({ rootDir }) {
    const providersPath = join(rootDir, PROVIDERS_REL_PATH);
    const raw = await readFile(providersPath, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw == null) {
      console.log(`📄 ${PROVIDERS_REL_PATH} not present — skipping (fresh install seeds Grok Build from data.reference)`);
      return;
    }

    let config;
    try {
      config = JSON.parse(raw);
    } catch (err) {
      console.log(`⚠️ ${PROVIDERS_REL_PATH}: invalid JSON, skipping (${err.message})`);
      return;
    }

    if (!config || typeof config !== 'object' || !config.providers || typeof config.providers !== 'object') {
      console.log(`⚠️ ${PROVIDERS_REL_PATH}: unexpected shape, skipping`);
      return;
    }

    let changed = false;
    for (const id of TARGET_IDS) {
      if (rewriteProvider(config.providers[id])) {
        changed = true;
        console.log(`📝 ${PROVIDERS_REL_PATH}: ${id} model fields ${OLD} → ${NEW}`);
      }
    }

    if (changed) {
      await writeFile(providersPath, `${JSON.stringify(config, null, 2)}\n`);
    } else {
      console.log(`✅ ${PROVIDERS_REL_PATH}: Grok Build CLI/TUI already on configured-default sentinel — no change`);
    }
  },
};
