/**
 * Parity test for the two shipped provider seeds:
 *   data.reference/providers.json                        (PortOS's own install seed)
 *   server/lib/aiToolkit/defaults/providers.sample.json   (the toolkit's fallback seed)
 *
 * Both files describe the same 21 providers, and `loadProviders()` falls
 * through to the toolkit sample when the install seed is absent — so a model
 * bump that updates one and not the other silently gives some fresh installs a
 * stale tier. That failure then compounds: the provider-bump migrations
 * (058/153/206) only rewrite a `models` list that matches the *prior seeded*
 * shape EXACTLY, so a stale-sample install is classified "customized" and
 * deliberately left alone — the very migration meant to repair it refuses to.
 *
 * Only the model-selection fields are compared. Everything else (timeouts,
 * `enabled`, env vars) legitimately differs: the toolkit sample is a generic
 * default, PortOS's seed is tuned for this install.
 *
 * This reads both files as JSON — it does NOT import out of the vendored
 * aiToolkit directory into PortOS (see server/lib/aiToolkit/CLAUDE.md), so the
 * self-contained rule is preserved. If an upstream toolkit sync ever diverges
 * the sample, this test makes that visible instead of silent.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const REFERENCE_PATH = resolve(__dirname, '../../../../data.reference/providers.json');
const SAMPLE_PATH = resolve(__dirname, 'providers.sample.json');

const MODEL_FIELDS = ['models', 'defaultModel', 'lightModel', 'mediumModel', 'heavyModel'];

// `lmstudio` is the one documented divergence: PortOS's seed names a concrete
// local model it ships guidance for, while the toolkit sample ships an empty
// list because a generic install has no way to know what the user has pulled.
const EXEMPT_IDS = new Set(['lmstudio']);

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

describe('provider seed parity — data.reference ↔ aiToolkit sample', () => {
  const reference = readJson(REFERENCE_PATH);
  const sample = readJson(SAMPLE_PATH);

  it('both seeds describe the same provider ids', () => {
    expect(Object.keys(sample.providers).sort()).toEqual(Object.keys(reference.providers).sort());
  });

  for (const id of Object.keys(reference.providers)) {
    if (EXEMPT_IDS.has(id)) continue;
    it(`${id} declares the same models and tier pointers in both seeds`, () => {
      for (const field of MODEL_FIELDS) {
        expect(
          sample.providers[id]?.[field],
          `${id}.${field} diverged — update data.reference/providers.json and providers.sample.json together`,
        ).toEqual(reference.providers[id]?.[field]);
      }
    });
  }
});
