/**
 * Source guard for the install-level local image model pin: only its resolver
 * and the settings writers may read it directly. Split from
 * prepareParams.test.js, which covers the resolver's behaviour.
 */
import { describe, it, expect } from 'vitest';

import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readText, REPO_ROOT } from '../../../../scripts/lib/guardCorpus.js';

const SERVER_ROOT = join(REPO_ROOT, 'server');
const MODEL_PIN_READ = /\bimageGen\s*\??\.\s*local\s*\??\.\s*modelId\b/;
const ALLOWED_PIN_READERS = new Set([
  'services/imageGen/prepareParams.js',
  'routes/settings.js',
]);

function findDirectLocalModelPinReads(root = SERVER_ROOT) {
  const violations = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && ['.git', 'build', 'data', 'dist', 'node_modules'].includes(entry.name)) continue;
      if (entry.isSymbolicLink()) continue;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!entry.isFile() || !/\.(?:js|mjs)$/.test(entry.name) || /\.test\.(?:js|mjs)$/.test(entry.name)) continue;
      const file = relative(SERVER_ROOT, absolutePath).replaceAll('\\', '/');
      if (ALLOWED_PIN_READERS.has(file)) continue;
      const source = readText(absolutePath)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      if (MODEL_PIN_READ.test(source)) violations.push(file);
    }
  };
  walk(root);
  return violations.sort();
}

describe('local model pin ownership', () => {
  it('allows direct install-pin reads only in its resolver and settings writers', () => {
    expect(findDirectLocalModelPinReads()).toEqual([]);
  });
});
