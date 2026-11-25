/**
 * A minted route must run the command line PortOS already ships (#6369).
 *
 * `PROVIDER_HARNESSES[].recipe` is not an invented configuration: each one is
 * the shipped `defaults/providers.sample.json` entry for that program, which is
 * the argv PortOS is known to drive it with. Nothing else in the system checks
 * that, so a recipe edited without its sample (or a sample updated without its
 * recipe) would silently start minting routes that do not run — a failure the
 * user only meets at spawn time, on a route they just created.
 *
 * This pins the FUNCTIONAL half only: the binary, its per-mode argv, the
 * headless/TUI mode fields, and the transport/credential materialization.
 * Display names, model pins and timeouts a user is expected to tune are not
 * part of the contract and are deliberately not compared.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDER_HARNESSES } from './providerHarnesses.js';
import { materializeRoute } from './providerRouteRecipes.js';

const SAMPLES = JSON.parse(readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../aiToolkit/defaults/providers.sample.json'),
  'utf8',
)).providers;

const OLLAMA = {
  definitionId: 'ollama',
  transports: {
    anthropic: { baseUrl: 'http://localhost:11434' },
    openai: { baseUrl: 'http://localhost:11434/v1' },
  },
  credentials: { apiKey: 'ollama' },
};

const CASES = [
  { harnessId: 'claude', mode: 'cli', sample: 'claude-ollama', service: OLLAMA },
  { harnessId: 'claude', mode: 'tui', sample: 'claude-ollama-tui', service: OLLAMA },
  { harnessId: 'opencode', mode: 'cli', sample: 'opencode-ollama', service: OLLAMA },
  { harnessId: 'opencode', mode: 'tui', sample: 'opencode-ollama-tui', service: OLLAMA },
  { harnessId: 'codex', mode: 'cli', sample: 'codex-ollama', service: OLLAMA },
  { harnessId: 'hermes', mode: 'cli', sample: 'hermes-cli', service: OLLAMA },
  { harnessId: 'hermes', mode: 'tui', sample: 'hermes-tui', service: OLLAMA },
];

const COMPOSED_CASES = [
  { harnessId: 'antigravity', mode: 'cli', sample: 'antigravity-cli', service: 'antigravity' },
  { harnessId: 'antigravity', mode: 'tui', sample: 'antigravity-tui', service: 'antigravity' },
  { harnessId: 'cursor', mode: 'cli', sample: 'cursor-cli', service: 'cursor' },
  { harnessId: 'cursor', mode: 'tui', sample: 'cursor-tui', service: 'cursor' },
  { harnessId: 'grok', mode: 'cli', sample: 'grok-cli', service: 'grok-build' },
  { harnessId: 'grok', mode: 'tui', sample: 'grok-tui', service: 'grok-build' },
  { harnessId: 'kimi', mode: 'cli', sample: 'kimi-cli', service: 'kimi' },
  { harnessId: 'kimi', mode: 'tui', sample: 'kimi-tui', service: 'kimi' },
  { harnessId: 'pi', mode: 'cli', sample: 'pi-cli', service: { definitionId: 'nvidia-nim', credentials: { apiKey: 'example-key' } }, suffix: ['--provider', 'nvidia'] },
  { harnessId: 'pi', mode: 'tui', sample: 'pi-tui', service: { definitionId: 'nvidia-nim', credentials: { apiKey: 'example-key' } }, suffix: ['--provider', 'nvidia'] },
];

describe('service composition matches shipped provider command lines', () => {
  it('covers every recipe-bearing harness', () => {
    const recipeHarnesses = PROVIDER_HARNESSES.filter((h) => h.recipe).map((h) => h.id);
    expect([...new Set([...CASES, ...COMPOSED_CASES].map((entry) => entry.harnessId))].sort()).toEqual(recipeHarnesses.sort());
  });

  it.each([...CASES, ...COMPOSED_CASES])('composes $harnessId $mode like $sample', ({ harnessId, mode, sample, service, suffix = [] }) => {
    const shipped = SAMPLES[sample];
    expect(shipped, `${sample} is missing from providers.sample.json`).toBeDefined();
    const minted = materializeRoute({ harness: harnessId, method: mode, serviceInstance: service });

    expect(minted.command).toBe(shipped.command);
    expect(minted.args).toEqual([...shipped.args, ...suffix]);
    expect(minted.type).toBe(shipped.type);
    if (mode === 'cli') expect(minted.headlessArgs).toEqual(shipped.headlessArgs ?? []);
    if (mode === 'tui') expect(minted.tuiPromptDelayMs).toBe(shipped.tuiPromptDelayMs);
  });
});
