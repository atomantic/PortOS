/**
 * Drift + position-invariance coverage for `scripts/generate-provider-samples.js`
 * (#7576, deferred from #7565, part of epic #7561).
 *
 * "Drift" here means: what's checked in at
 * `server/lib/aiToolkit/defaults/providers.sample.json` and
 * `data.reference/providers.json` must be exactly what the generator emits
 * from its `(harnessId, method, serviceDefinition)` tuple table right now —
 * so a `SERVICE_DEFINITIONS` / `providerHarnesses.js` edit that silently
 * changes a shipped preset is caught here rather than discovered by a user's
 * fresh install.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { POSITION_INVARIANCE_FAILURE, shiftSourceText } from './lib/positionInvariance.js';
import {
  REPO_ROOT, SAMPLE_PATH, REFERENCE_PATH, PROVIDER_ORDER,
  buildDocument, buildProviders, serializeDocument,
} from './generate-provider-samples.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATOR_PATH = join(HERE, 'generate-provider-samples.js');
const REGENERATE_COMMAND = 'node scripts/generate-provider-samples.js';

describe('provider sample generator', () => {
  it('offers Grok 4.7 on new installs while retaining selectable older generations', () => {
    const providers = buildProviders('reference');
    for (const id of ['grok', 'grok-cli', 'grok-tui']) {
      expect(providers[id].defaultModel).toBe('grok-4.7');
      expect(providers[id].models).toContain('grok-4.7');
      expect(providers[id].enabled).toBe(false);
    }
    expect(providers['grok-cli'].models).toContain('grok-4.6');
    expect(providers.grok.models).toContain('grok-4');
    expect(providers.grok.contextWindow).toBe(500000);
  });
  it('matches the committed toolkit sample byte-for-byte', () => {
    const committed = readFileSync(SAMPLE_PATH, 'utf8');
    const fresh = serializeDocument(buildDocument('sample'));
    expect(fresh, `${SAMPLE_PATH.replace(REPO_ROOT, '.')} is stale — run \`${REGENERATE_COMMAND}\` and commit the result.`).toBe(committed);
  });

  it('matches the committed data.reference seed byte-for-byte', () => {
    const committed = readFileSync(REFERENCE_PATH, 'utf8');
    const fresh = serializeDocument(buildDocument('reference'));
    expect(fresh, `${REFERENCE_PATH.replace(REPO_ROOT, '.')} is stale — run \`${REGENERATE_COMMAND}\` and commit the result.`).toBe(committed);
  });

  it('emits the same provider ids in both files, in the one canonical order', () => {
    const sample = buildProviders('sample');
    const reference = buildProviders('reference');
    expect(Object.keys(sample)).toEqual(PROVIDER_ORDER);
    expect(Object.keys(reference)).toEqual(PROVIDER_ORDER);
  });

  it('never renames or drops a shipped sample id', () => {
    // Pinned literally (not derived from the generator's own table) so a
    // change to PROVIDER_ORDER that quietly loses or renames an id fails here
    // rather than only showing up as a smaller diff on the JSON files.
    const SHIPPED_IDS = [
      'kilo-cli', 'kilo-tui', 'openchamber-cli', 'pi-cli', 'pi-tui',
      'claude-code', 'claude-code-bedrock', 'claude-ollama', 'claude-ollama-tui',
      'opencode-ollama', 'opencode-ollama-tui', 'opencode-lmstudio', 'opencode-lmstudio-tui',
      'opencode-mtplx', 'opencode-mtplx-tui', 'opencode-llama-tui',
      'opencode-vllm', 'opencode-vllm-tui', 'opencode-sglang', 'opencode-sglang-tui',
      'claude-sglang', 'claude-sglang-tui',
      'orcarouter', 'opencode-orcarouter', 'openrouter', 'opencode-openrouter', 'opencode-openrouter-tui',
      'nvidia-nim', 'opencode-nvidia-nim', 'opencode-nvidia-nim-tui', 'opencode-orcarouter-tui',
      'opencode-zen', 'opencode-zen-cli', 'opencode-zen-tui',
      'codex', 'codex-tui', 'codex-ollama', 'codex-lmstudio',
      'claude-code-tui', 'claude-code-tui-bedrock',
      'antigravity-tui', 'antigravity-cli',
      'cerebras', 'lmstudio', 'ollama', 'mtplx', 'slotstream',
      'grok', 'grok-cli', 'grok-tui', 'kimi-cli', 'kimi-tui', 'cursor-cli', 'cursor-tui',
    ];
    expect([...PROVIDER_ORDER].sort()).toEqual([...SHIPPED_IDS].sort());
  });

  it('does not ship the retired NVIDIA Kimi preset', () => {
    for (const variant of ['sample', 'reference']) {
      expect(buildProviders(variant)).not.toHaveProperty('nvidia-kimi');
    }
  });

  it('deliberately leaves every structural key (harnessId/method/serviceId) off a shipped sample', () => {
    // See the generator's module docstring and DROP_STRUCTURAL_KEYS: a shipped
    // sample carries no graph connection, so stamping these would make a fresh
    // install's first save 400 once the provider-graph feature is on.
    for (const variant of ['sample', 'reference']) {
      const providers = buildProviders(variant);
      for (const [id, record] of Object.entries(providers)) {
        for (const key of ['harnessId', 'method', 'serviceId', 'servicePlan']) {
          expect(record, `${variant}.${id} unexpectedly carries "${key}"`).not.toHaveProperty(key);
        }
      }
    }
  });

  // Position invariance: THIS generator carries no line/offset/positional
  // reference at all — everything is keyed by provider id — so shifting every
  // line in its own source (the one place its tuple/literal/override tables
  // live) must reproduce byte-identical output. See
  // `scripts/lib/positionInvariance.js` and `server/lib/generatedManifests.test.js`.
  it('builds byte-identical output after every line in the generator shifts', { timeout: 20000 }, async () => {
    const original = readFileSync(GENERATOR_PATH, 'utf8');
    // Drop the shebang before shifting: a hashbang is only legal as the very
    // first line, and this file is imported as a module here, never executed
    // directly, so dropping it changes nothing this test observes.
    const withoutShebang = original.replace(/^#!.*\n/, '');
    const shiftedSource = shiftSourceText(withoutShebang);
    const shiftedPath = join(HERE, `generate-provider-samples.shifted.${process.pid}.${Date.now()}.tmp.js`);
    writeFileSync(shiftedPath, shiftedSource, 'utf8');
    try {
      const shifted = await import(pathToFileURL(shiftedPath).href);
      const before = serializeDocument(buildDocument('sample'));
      const after = serializeDocument(shifted.buildDocument('sample'));
      expect(after, POSITION_INVARIANCE_FAILURE).toBe(before);
    } finally {
      unlinkSync(shiftedPath);
    }
  });
});
