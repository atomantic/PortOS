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
import { CREATABLE_HARNESS_IDS } from './providerHarnesses.js';
import { buildRouteRecord } from './providerRouteRecipes.js';

const SAMPLES = JSON.parse(readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'aiToolkit/defaults/providers.sample.json'),
  'utf8',
)).providers;

/** The local Ollama daemon the samples below are all configured against. */
const ANTHROPIC_CONNECTION = {
  kind: 'ollama',
  transports: { anthropic: { baseUrl: 'http://localhost:11434' } },
  credentials: { ANTHROPIC_AUTH_TOKEN: 'ollama' },
};
const OPENAI_CONNECTION = {
  kind: 'ollama',
  transports: { openai: { baseUrl: 'http://localhost:11434/v1' } },
  credentials: {},
};

const CASES = [
  { harnessId: 'claude', mode: 'cli', sample: 'claude-ollama', connection: ANTHROPIC_CONNECTION },
  { harnessId: 'claude', mode: 'tui', sample: 'claude-ollama-tui', connection: ANTHROPIC_CONNECTION },
  { harnessId: 'opencode', mode: 'cli', sample: 'opencode-ollama', connection: OPENAI_CONNECTION },
  { harnessId: 'opencode', mode: 'tui', sample: 'opencode-ollama-tui', connection: OPENAI_CONNECTION },
  { harnessId: 'codex', mode: 'cli', sample: 'codex-ollama', connection: OPENAI_CONNECTION },
];

const mint = ({ harnessId, mode, connection, sample }) =>
  buildRouteRecord({ harnessId, mode, providerId: sample, name: 'Example', connection });

describe('harness command recipes match the shipped provider samples', () => {
  it('covers every creatable harness, so a new one cannot ship unpinned', () => {
    expect([...new Set(CASES.map((entry) => entry.harnessId))].sort())
      .toEqual([...CREATABLE_HARNESS_IDS].sort());
  });

  it.each(CASES)('mints $harnessId $mode like $sample', ({ sample, ...input }) => {
    const shipped = SAMPLES[sample];
    expect(shipped, `${sample} is missing from providers.sample.json`).toBeDefined();
    const minted = mint({ ...input, sample });

    expect(minted.command).toBe(shipped.command);
    expect(minted.args).toEqual(shipped.args);
    expect(minted.type).toBe(shipped.type);
    if (input.mode === 'cli') expect(minted.headlessArgs).toEqual(shipped.headlessArgs);
    if (input.mode === 'tui') expect(minted.tuiPromptDelayMs).toBe(shipped.tuiPromptDelayMs);
    expect(minted.secretEnvVars).toEqual(shipped.secretEnvVars);
  });

  it('materializes the backend the same way the Claude sample does', () => {
    const minted = mint(CASES[0]);
    const shipped = SAMPLES['claude-ollama'];
    expect(minted.envVars.ANTHROPIC_BASE_URL).toBe(shipped.envVars.ANTHROPIC_BASE_URL);
    expect(minted.envVars.ANTHROPIC_AUTH_TOKEN).toBe(shipped.envVars.ANTHROPIC_AUTH_TOKEN);
    expect(minted.ollamaBacked).toBe(true);
  });

  it('declares the OpenCode provider the same way its sample does, name aside', () => {
    const minted = JSON.parse(mint(CASES[2]).envVars.OPENCODE_CONFIG_CONTENT);
    const shipped = JSON.parse(SAMPLES['opencode-ollama'].envVars.OPENCODE_CONFIG_CONTENT);
    expect(minted.permission).toBe(shipped.permission);
    // `name` is the label OpenCode shows; everything else is what makes the
    // provider resolve, so only those are the contract.
    expect(minted.provider.ollama.npm).toBe(shipped.provider.ollama.npm);
    expect(minted.provider.ollama.options.baseURL).toBe(shipped.provider.ollama.options.baseURL);
  });

  it('mints nothing enabled, pinned or consented, whatever the recipe', () => {
    for (const entry of CASES) {
      const minted = mint(entry);
      expect(minted.enabled).toBe(false);
      expect(minted.models).toEqual([]);
      expect(minted.defaultModel).toBeNull();
      expect(minted).not.toHaveProperty('textTransportEnabled');
      expect(minted).not.toHaveProperty('allowCustomEndpoint');
    }
  });
});
