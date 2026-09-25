/**
 * Prune memory-classifier-config.json and browser-config.json to remove keys
 * that match the shipped seed values.
 *
 * Both seeds duplicated their service's DEFAULT_CONFIG key for key. Services
 * merge the stored file over the in-code defaults (`{ ...DEFAULT_CONFIG, ...parsed }`),
 * so on every install that `npm run setup:data` seeded, the copied values
 * permanently won over the code. That includes values the code derives from
 * the environment:
 *
 * - memory-classifier-config.json: `endpoint` was hard-coded to
 *   `http://localhost:1234/v1/chat/completions`, but the code derives it from
 *   `LM_STUDIO_URL`. `minConfidence` was `0.6` in the seed but `0.7` in code.
 * - browser-config.json: `cdpHost` was hard-coded to `127.0.0.1`, but the code
 *   reads `CDP_HOST`.
 *
 * Both files are now migration-owned (declared in migrationOwnedPaths.js), so
 * their seeds will not re-appear on future setups. This migration cleans up
 * existing installs by removing every key whose value equals the retired seed,
 * keeping any key the user changed. The file is deleted if nothing is left.
 */

import { readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { writeJsonAtomic } from './_lib.js';

/**
 * Values from the retired data.reference/memory-classifier-config.json seed.
 * These keys should be removed from the installed file if they match.
 */
const RETIRED_MEMORY_CLASSIFIER_SEED = {
  enabled: true,
  provider: 'lmstudio',
  endpoint: 'http://localhost:1234/v1/chat/completions',
  model: 'gptoss-20b',
  timeout: 60000,
  maxOutputLength: 10000,
  minConfidence: 0.6,
  fallbackToPatterns: true,
};

/**
 * Values from the retired data.reference/browser-config.json seed.
 * These keys should be removed from the installed file if they match.
 */
const RETIRED_BROWSER_SEED = {
  cdpPort: 5556,
  cdpHost: '127.0.0.1',
  healthPort: 5557,
  autoConnect: true,
  headless: false,
  userDataDir: '',
};

async function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    const content = await readFile(path, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Prune a config object by removing keys that equal the retired seed values.
 * Returns the pruned object or null if all keys were removed.
 */
function pruneConfig(config, retiredSeed) {
  if (!config || typeof config !== 'object') return null;

  const pruned = {};
  for (const [key, value] of Object.entries(config)) {
    // Keep the key if it's not in the seed or if the value differs
    if (!(key in retiredSeed) || retiredSeed[key] !== value) {
      pruned[key] = value;
    }
  }

  return Object.keys(pruned).length > 0 ? pruned : null;
}

export default {
  async up({ rootDir }) {
    const results = {
      memoryClassifier: null,
      browser: null,
    };

    // Process memory-classifier-config.json
    const memoryConfigPath = join(rootDir, 'data', 'memory-classifier-config.json');
    const memoryConfig = await readJson(memoryConfigPath);
    if (memoryConfig) {
      const pruned = pruneConfig(memoryConfig, RETIRED_MEMORY_CLASSIFIER_SEED);
      if (pruned === null) {
        // File was entirely seed values, remove it
        await rm(memoryConfigPath, { force: true });
        results.memoryClassifier = 'removed';
        console.log('🧹 Removed data/memory-classifier-config.json (contained only seed defaults)');
      } else if (Object.keys(pruned).length < Object.keys(memoryConfig).length) {
        // File had some user changes, keep only those
        await writeJsonAtomic(memoryConfigPath, pruned);
        const removed = Object.keys(memoryConfig).length - Object.keys(pruned).length;
        results.memoryClassifier = `pruned (${removed} keys removed)`;
        console.log(`✂️  data/memory-classifier-config.json: removed ${removed} seed-default keys, kept ${Object.keys(pruned).length}`);
      } else {
        results.memoryClassifier = 'unchanged';
      }
    }

    // Process browser-config.json
    const browserConfigPath = join(rootDir, 'data', 'browser-config.json');
    const browserConfig = await readJson(browserConfigPath);
    if (browserConfig) {
      const pruned = pruneConfig(browserConfig, RETIRED_BROWSER_SEED);
      if (pruned === null) {
        // File was entirely seed values, remove it
        await rm(browserConfigPath, { force: true });
        results.browser = 'removed';
        console.log('🧹 Removed data/browser-config.json (contained only seed defaults)');
      } else if (Object.keys(pruned).length < Object.keys(browserConfig).length) {
        // File had some user changes, keep only those
        await writeJsonAtomic(browserConfigPath, pruned);
        const removed = Object.keys(browserConfig).length - Object.keys(pruned).length;
        results.browser = `pruned (${removed} keys removed)`;
        console.log(`✂️  data/browser-config.json: removed ${removed} seed-default keys, kept ${Object.keys(pruned).length}`);
      } else {
        results.browser = 'unchanged';
      }
    }

    return results;
  },
};
