#!/usr/bin/env node
/**
 * Generate the two shipped provider samples —
 * `server/lib/aiToolkit/defaults/providers.sample.json` and
 * `data.reference/providers.json` — from one table of
 * `(harnessId, method, serviceDefinition)` tuples (#7576, deferred from #7565,
 * part of epic #7561).
 *
 * Why: before this generator, both files were hand-maintained. A new
 * `SERVICE_DEFINITIONS` row got no shipped presets until someone hand-wrote
 * them, and a recipe edit (`providerHarnesses.js`) could drift from the
 * sample it was lifted from — only `providerRouteRecipes.sampleParity.test.js`
 * pinned the argv half, and only for the toolkit sample, never the reference
 * seed a fresh install actually gets (`scripts/setup-data.js`).
 *
 * #7565 asked for a generator that reproduces `data.reference/providers.json`
 * byte-for-byte on the assumption that it mirrors the toolkit sample. It did
 * not (see the normalization commit this generator's own commit follows):
 * the two disagreed on `timeout`, `headlessArgs`, `numCtx`,
 * `temperature`/`thinking`, `contextWindow`, and whether an empty
 * `secretEnvVars`/`apiKey` field was written at all — none of it a
 * deliberate design choice, all of it drift. That commit reconciled every
 * field (see its body for the per-field decision) so the two files are, as
 * of this generator, IDENTICAL. The per-file override layer below
 * (`SAMPLE_OVERRIDES` / `REFERENCE_OVERRIDES`) exists for the day that stops
 * being true, so a deliberate future divergence is an explicit row here
 * rather than an accident nobody can explain.
 *
 * Most records are `materializeRoute({ harness, method, serviceInstance })`
 * (`server/lib/providerRouteRecipes.js`) — the same writer a live composite
 * provider id resolves through — plus a per-record `overrides` layer for the
 * things a shipped sample pins that a fresh materialization would not know
 * (display name, model catalog/tiers, `enabled`, timeouts, generation
 * params). A handful of records have no recipe or no service definition at
 * all (Kilo, OpenChamber, Pi's two generic un-configured samples) and stay
 * LITERAL — `providerHarnesses.js` already says why each one cannot be
 * composed (`connectionBlocker`).
 *
 * Deliberately NOT stamped: the `harnessId`/`method`/`serviceId` structural
 * keys #7565 added to a LIVE materialized record. Those three keys mark a
 * record as a DERIVED PRESET (`isDerivedPreset`,
 * `server/lib/providerGraphRecords.js`) — on every save, `materializeStoredPreset`
 * (`server/services/providerPresets.js`) re-resolves them through the
 * PROVIDER GRAPH's own connection graph (`presetInputs` →
 * `resolveCompositeParts`), which needs a graph `connection` row whose slug
 * equals `serviceId`. A shipped sample was never created through the
 * connection/graph flow, so it has no such row; stamping the three keys
 * would make a from-fresh-install record "look" like a derived preset while
 * the very first save (even just flipping `enabled`) 400s with
 * `service-unknown` once the provider-graph feature is on. That is a worse
 * outcome than today's plain hand-editable record, so this generator leaves
 * every shipped sample a LEGACY preset. Revisit only alongside a graph-side
 * seed for these connections.
 *
 * Usage:  node scripts/generate-provider-samples.js
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { materializeRoute } from '../server/lib/providerRouteRecipes.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');

export const SAMPLE_PATH = join(REPO_ROOT, 'server/lib/aiToolkit/defaults/providers.sample.json');
export const REFERENCE_PATH = join(REPO_ROOT, 'data.reference/providers.json');

/** The `activeProvider` both shipped files select on a fresh install. */
const ACTIVE_PROVIDER = 'claude-code-tui';

/**
 * Per-record key order every serialized record follows, so the file is
 * stable regardless of the order fields were computed or overridden in.
 * Keys a record does not carry are simply skipped; a key not listed here
 * (there should never be one — `providerSampleShape.test.js`-style coverage
 * is the drift test below) is appended, sorted, so nothing is silently lost.
 */
const KEY_ORDER = [
  'id', 'name', 'type', 'harnessId', 'method', 'serviceId', 'servicePlan',
  'command', 'args', 'endpoint', 'apiKey',
  'ollamaBacked', 'lmstudioBacked', 'mtplxBacked', 'llamaBacked', 'vllmBacked', 'sglangBacked', 'gatewayBacked', 'orcarouterBacked',
  'models', 'defaultModel', 'lightModel', 'mediumModel', 'heavyModel', 'ultraModel', 'memoryClassifierModel', 'fallbackProvider',
  'contextWindow', 'numCtx', 'temperature', 'thinking',
  'textTransport', 'ignoreUserConfig',
  'timeout', 'enabled',
  'envVars', 'secretEnvVars',
  'headlessArgs', 'tuiPromptDelayMs', 'tuiIdleTimeoutMs',
  'credentialBootstrap', 'credentialBootstrapId', 'catalogNarrowing',
];

/** Reorder one record's own keys into {@link KEY_ORDER}. */
function orderRecord(record) {
  const out = {};
  for (const key of KEY_ORDER) if (Object.hasOwn(record, key)) out[key] = record[key];
  for (const key of Object.keys(record).sort()) if (!Object.hasOwn(out, key)) out[key] = record[key];
  return out;
}

/** A key present in an `overrides.envVars` (or top-level `overrides`) whose value is this sentinel is DELETED rather than set. */
export const OMIT = Symbol('omit');

/**
 * Apply a per-record override layer on top of a materialized record.
 * Shallow-replaces every top-level key EXCEPT `envVars`, which is
 * shallow-MERGED key by key (a wrapper composition writes its transport/
 * credential env vars; an override only adds or corrects one beside them,
 * and replacing the whole map would drop the rest). `OMIT` deletes a key
 * (top-level or inside `envVars`) that the composition wrote but the shipped
 * sample does not carry.
 */
function applyOverrides(record, overrides = {}) {
  const out = { ...record };
  for (const [key, value] of Object.entries(overrides)) {
    if (key === 'envVars' && value && typeof value === 'object') {
      out.envVars = { ...out.envVars };
      for (const [envKey, envValue] of Object.entries(value)) {
        if (envValue === OMIT) delete out.envVars[envKey];
        else out.envVars[envKey] = envValue;
      }
      continue;
    }
    if (value === OMIT) { delete out[key]; continue; }
    out[key] = value;
  }
  return out;
}

/** OpenCode's inline provider config, with the FRIENDLY label a shipped wrapper sample shows (`providerRouteRecipes.js` writes the bare service-definition label instead — a per-record override is the one place that friendlier string lives). */
const opencodeConfigContent = (namespace, label, baseUrl) => JSON.stringify({
  permission: 'allow',
  provider: { [namespace]: { npm: '@ai-sdk/openai-compatible', name: label, options: { baseURL: baseUrl } } },
});

/**
 * The (harness, method, service) tuple table. Each entry composes its record
 * with `materializeRoute`, then applies `overrides` — the display name,
 * enabled/models/tiers a shipped sample pins, and any correction a bare
 * composition cannot express (a friendlier OpenCode label, an extra
 * generation-tuning env var, a credential-required service with no live
 * credential to compose with).
 */
const TUPLES = [
  // --- Claude Code -----------------------------------------------------------
  {
    id: 'claude-code', harnessId: 'claude', method: 'cli', service: 'claude-subscription',
    overrides: {
      name: 'Claude Code CLI',
      models: ['claude-fable-5-1', 'claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5'],
      defaultModel: 'claude-opus-5', lightModel: 'claude-haiku-4-5', mediumModel: 'claude-sonnet-5', heavyModel: 'claude-opus-5', ultraModel: 'claude-fable-5-1',
      timeout: 900000, enabled: true,
    },
  },
  {
    id: 'claude-code-bedrock', harnessId: 'claude', method: 'cli', service: { definitionId: 'bedrock', credentials: { apiKey: 'placeholder' } },
    overrides: {
      name: 'Claude Code CLI: Bedrock',
      models: ['us.anthropic.claude-haiku-4-5', 'us.anthropic.claude-sonnet-5', 'global.anthropic.claude-opus-5', 'global.anthropic.claude-opus-5[1m]'],
      defaultModel: 'global.anthropic.claude-opus-5[1m]', lightModel: 'us.anthropic.claude-haiku-4-5', mediumModel: 'us.anthropic.claude-sonnet-5', heavyModel: 'global.anthropic.claude-opus-5[1m]',
      timeout: 900000, enabled: false,
      envVars: { AWS_BEARER_TOKEN_BEDROCK: '' },
    },
  },
  {
    id: 'claude-ollama', harnessId: 'claude', method: 'cli',
    service: { definitionId: 'ollama', credentials: { apiKey: 'ollama' }, transports: { anthropic: { baseUrl: 'http://localhost:11434' } } },
    overrides: {
      name: 'Claude Ollama (local model)', enabled: false, numCtx: 131072, temperature: 0.6, thinking: true,
      envVars: { ANTHROPIC_SMALL_FAST_MODEL: 'qwen2.5:7b' },
    },
  },
  {
    id: 'claude-ollama-tui', harnessId: 'claude', method: 'tui',
    service: { definitionId: 'ollama', credentials: { apiKey: 'ollama' }, transports: { anthropic: { baseUrl: 'http://localhost:11434' } } },
    overrides: {
      name: 'Claude Ollama TUI (local model)', enabled: false, numCtx: 131072, temperature: 0.6, thinking: true,
      envVars: { ANTHROPIC_SMALL_FAST_MODEL: 'qwen2.5:7b' },
    },
  },
  {
    id: 'claude-code-tui', harnessId: 'claude', method: 'tui', service: 'claude-subscription',
    overrides: {
      name: 'Claude Code TUI',
      models: ['claude-fable-5-1', 'claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5'],
      defaultModel: 'claude-opus-5', lightModel: 'claude-haiku-4-5', mediumModel: 'claude-sonnet-5', heavyModel: 'claude-opus-5', ultraModel: 'claude-fable-5-1',
      timeout: 900000, enabled: true,
    },
  },
  {
    id: 'claude-code-tui-bedrock', harnessId: 'claude', method: 'tui', service: { definitionId: 'bedrock', credentials: { apiKey: 'placeholder' } },
    overrides: {
      name: 'Claude Code TUI: Bedrock',
      models: ['us.anthropic.claude-haiku-4-5', 'us.anthropic.claude-sonnet-5', 'global.anthropic.claude-opus-5', 'global.anthropic.claude-opus-5[1m]'],
      defaultModel: 'global.anthropic.claude-opus-5[1m]', lightModel: 'us.anthropic.claude-haiku-4-5', mediumModel: 'us.anthropic.claude-sonnet-5', heavyModel: 'global.anthropic.claude-opus-5[1m]',
      timeout: 900000, enabled: false,
      envVars: { AWS_BEARER_TOKEN_BEDROCK: '' },
    },
  },

  // --- OpenCode on local runtimes ---------------------------------------------
  {
    id: 'opencode-ollama', harnessId: 'opencode', method: 'cli',
    service: { definitionId: 'ollama', transports: { openai: { baseUrl: 'http://localhost:11434/v1' } } },
    overrides: {
      name: 'OpenCode Ollama (local model)', enabled: false, temperature: 0.6, thinking: true,
      apiKey: OMIT,
      envVars: { OPENCODE_CONFIG_CONTENT: opencodeConfigContent('ollama', 'Ollama (local)', 'http://localhost:11434/v1') },
    },
  },
  {
    id: 'opencode-ollama-tui', harnessId: 'opencode', method: 'tui',
    service: { definitionId: 'ollama', transports: { openai: { baseUrl: 'http://localhost:11434/v1' } } },
    overrides: {
      name: 'OpenCode Ollama TUI (local model)', enabled: false, temperature: 0.6, thinking: true,
      apiKey: OMIT,
      envVars: { OPENCODE_CONFIG_CONTENT: opencodeConfigContent('ollama', 'Ollama (local)', 'http://localhost:11434/v1') },
    },
  },
  {
    id: 'opencode-lmstudio', harnessId: 'opencode', method: 'cli',
    service: { definitionId: 'lmstudio', transports: { openai: { baseUrl: 'http://localhost:1234/v1' } } },
    overrides: {
      name: 'OpenCode LM Studio (local model)', enabled: false, numCtx: 32768,
      apiKey: OMIT,
      envVars: { OPENCODE_CONFIG_CONTENT: opencodeConfigContent('lmstudio', 'LM Studio (local)', 'http://localhost:1234/v1') },
    },
  },
  {
    id: 'opencode-lmstudio-tui', harnessId: 'opencode', method: 'tui',
    service: { definitionId: 'lmstudio', transports: { openai: { baseUrl: 'http://localhost:1234/v1' } } },
    overrides: {
      name: 'OpenCode LM Studio TUI (local model)', enabled: false, numCtx: 32768,
      apiKey: OMIT,
      envVars: { OPENCODE_CONFIG_CONTENT: opencodeConfigContent('lmstudio', 'LM Studio (local)', 'http://localhost:1234/v1') },
    },
  },
  {
    id: 'opencode-mtplx', harnessId: 'opencode', method: 'cli',
    service: { definitionId: 'mtplx', transports: { openai: { baseUrl: 'http://127.0.0.1:8000/v1' } } },
    overrides: {
      name: 'OpenCode MTPLX (local MTP)', enabled: false,
      endpoint: 'http://127.0.0.1:8000/v1', models: ['mtplx-qwen38-27b-optimized-speed'], defaultModel: 'mtplx-qwen38-27b-optimized-speed',
      apiKey: OMIT,
      envVars: { OPENCODE_CONFIG_CONTENT: opencodeConfigContent('mtplx', 'MTPLX (local MTP)', 'http://127.0.0.1:8000/v1') },
    },
  },
  {
    id: 'opencode-mtplx-tui', harnessId: 'opencode', method: 'tui',
    service: { definitionId: 'mtplx', transports: { openai: { baseUrl: 'http://127.0.0.1:8000/v1' } } },
    overrides: {
      name: 'OpenCode MTPLX TUI (local MTP)', enabled: false,
      endpoint: 'http://127.0.0.1:8000/v1', models: ['mtplx-qwen38-27b-optimized-speed'], defaultModel: 'mtplx-qwen38-27b-optimized-speed',
      apiKey: OMIT,
      envVars: { OPENCODE_CONFIG_CONTENT: opencodeConfigContent('mtplx', 'MTPLX (local MTP)', 'http://127.0.0.1:8000/v1') },
    },
  },
  {
    id: 'opencode-llama-tui', harnessId: 'opencode', method: 'tui',
    service: { definitionId: 'llama', transports: { openai: { baseUrl: 'http://127.0.0.1:5568/v1' } } },
    overrides: {
      name: 'OpenCode llama TUI', enabled: true,
      endpoint: 'http://127.0.0.1:5568/v1', models: ['dflash', 'qwen3.8-27b-dflash2', 'Muse-Glimmer-30B-DFlash2'], defaultModel: 'dflash',
      tuiIdleTimeoutMs: 180000,
      apiKey: OMIT,
      envVars: { OPENCODE_CONFIG_CONTENT: opencodeConfigContent('llama', 'llama.cpp (local)', 'http://127.0.0.1:5568/v1') },
    },
  },
  {
    id: 'opencode-vllm', harnessId: 'opencode', method: 'cli',
    service: { definitionId: 'vllm', transports: { openai: { baseUrl: 'http://127.0.0.1:18020/v1' } } },
    overrides: {
      name: 'OpenCode vLLM (Qwen3.8-27B)', enabled: false, thinking: false,
      endpoint: 'http://127.0.0.1:18020/v1', apiKey: '', models: ['qwen3.8-27b'], defaultModel: 'qwen3.8-27b',
      envVars: { OPENCODE_CONFIG_CONTENT: opencodeConfigContent('vllm', 'vLLM Qwen3.8-27B (local)', 'http://127.0.0.1:18020/v1') },
    },
  },
  {
    id: 'opencode-vllm-tui', harnessId: 'opencode', method: 'tui',
    service: { definitionId: 'vllm', transports: { openai: { baseUrl: 'http://127.0.0.1:18020/v1' } } },
    overrides: {
      name: 'OpenCode vLLM TUI (Qwen3.8-27B)', enabled: false, thinking: false,
      endpoint: 'http://127.0.0.1:18020/v1', apiKey: '', models: ['qwen3.8-27b'], defaultModel: 'qwen3.8-27b',
      tuiIdleTimeoutMs: 180000,
      envVars: { OPENCODE_CONFIG_CONTENT: opencodeConfigContent('vllm', 'vLLM Qwen3.8-27B (local)', 'http://127.0.0.1:18020/v1') },
    },
  },
  {
    id: 'opencode-sglang', harnessId: 'opencode', method: 'cli',
    service: { definitionId: 'sglang', transports: { openai: { baseUrl: 'http://127.0.0.1:18021/v1' } } },
    overrides: {
      name: 'OpenCode SGLang (Qwen3.8-27B)', enabled: false,
      endpoint: 'http://127.0.0.1:18021/v1', apiKey: '', models: ['qwen3.8-27b'], defaultModel: 'qwen3.8-27b',
      envVars: { OPENCODE_CONFIG_CONTENT: opencodeConfigContent('sglang', 'SGLang Qwen3.8-27B (local)', 'http://127.0.0.1:18021/v1') },
    },
  },
  {
    id: 'opencode-sglang-tui', harnessId: 'opencode', method: 'tui',
    service: { definitionId: 'sglang', transports: { openai: { baseUrl: 'http://127.0.0.1:18021/v1' } } },
    overrides: {
      name: 'OpenCode SGLang TUI (Qwen3.8-27B)', enabled: false,
      endpoint: 'http://127.0.0.1:18021/v1', apiKey: '', models: ['qwen3.8-27b'], defaultModel: 'qwen3.8-27b',
      tuiIdleTimeoutMs: 180000,
      envVars: { OPENCODE_CONFIG_CONTENT: opencodeConfigContent('sglang', 'SGLang Qwen3.8-27B (local)', 'http://127.0.0.1:18021/v1') },
    },
  },

  // --- Claude on SGLang (Anthropic-compatible local runtime) ------------------
  {
    id: 'claude-sglang', harnessId: 'claude', method: 'cli',
    service: {
      definitionId: 'sglang', credentials: { apiKey: 'sglang' },
      transports: { anthropic: { baseUrl: 'http://127.0.0.1:18021' }, openai: { baseUrl: 'http://127.0.0.1:18021/v1' } },
    },
    overrides: {
      name: 'Claude SGLang (Qwen3.8-27B)', enabled: false,
      apiKey: '', models: ['qwen3.8-27b'], defaultModel: 'qwen3.8-27b',
      envVars: {
        API_TIMEOUT_MS: '3000000',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3.8-27b',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen3.8-27b',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen3.8-27b',
        ANTHROPIC_SMALL_FAST_MODEL: 'qwen3.8-27b',
      },
    },
  },
  {
    id: 'claude-sglang-tui', harnessId: 'claude', method: 'tui',
    service: {
      definitionId: 'sglang', credentials: { apiKey: 'sglang' },
      transports: { anthropic: { baseUrl: 'http://127.0.0.1:18021' }, openai: { baseUrl: 'http://127.0.0.1:18021/v1' } },
    },
    overrides: {
      name: 'Claude SGLang TUI (Qwen3.8-27B)', enabled: false,
      apiKey: '', models: ['qwen3.8-27b'], defaultModel: 'qwen3.8-27b',
      tuiIdleTimeoutMs: 180000,
      envVars: {
        API_TIMEOUT_MS: '3000000',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3.8-27b',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen3.8-27b',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen3.8-27b',
        ANTHROPIC_SMALL_FAST_MODEL: 'qwen3.8-27b',
      },
    },
  },

  // --- Hosted gateways ---------------------------------------------------------
  {
    id: 'orcarouter', harnessId: 'direct', method: 'api', service: { definitionId: 'orcarouter', credentials: { apiKey: '' } },
    overrides: {
      name: 'OrcaRouter', enabled: false,
      models: ['orcarouter/auto'], defaultModel: 'orcarouter/auto', lightModel: 'orcarouter/auto', mediumModel: 'orcarouter/auto', heavyModel: 'orcarouter/auto',
      timeout: 300000,
      envVars: {}, apiKey: '',
    },
  },
  {
    id: 'opencode-orcarouter', harnessId: 'opencode', method: 'cli', service: { definitionId: 'orcarouter' },
    overrides: {
      name: 'OpenCode OrcaRouter', enabled: false,
      models: ['orcarouter/auto'], defaultModel: 'orcarouter/auto',
      envVars: { OPENCODE_CONFIG_CONTENT: opencodeConfigContent('orcarouter', 'OrcaRouter', 'https://api.orcarouter.ai/v1') },
      // Kept on the OLD per-gateway boolean rather than modernized to
      // `gatewayBacked` (what materialization would write): this is the one
      // shipped sample `providerPresets.test.js`'s
      // "planPresetBackfill over the shipped samples" suite exercises to prove
      // a legacy marker DRIFTS from a service-derived one rather than being
      // silently backfilled — see `reasons['opencode-orcarouter']` there.
      gatewayBacked: OMIT, orcarouterBacked: true,
    },
  },
  {
    id: 'opencode-orcarouter-tui', harnessId: 'opencode', method: 'tui', service: { definitionId: 'orcarouter' },
    overrides: {
      name: 'OpenCode OrcaRouter TUI', enabled: false,
      models: ['orcarouter/auto'], defaultModel: 'orcarouter/auto',
      tuiIdleTimeoutMs: 180000,
      envVars: { OPENCODE_CONFIG_CONTENT: opencodeConfigContent('orcarouter', 'OrcaRouter', 'https://api.orcarouter.ai/v1') },
      gatewayBacked: OMIT, orcarouterBacked: true,
    },
  },
  {
    id: 'openrouter', harnessId: 'direct', method: 'api', service: { definitionId: 'openrouter', credentials: { apiKey: '' } },
    overrides: {
      name: 'OpenRouter', enabled: false,
      models: ['openrouter/auto', 'stealth/ox-alpha'], defaultModel: 'stealth/ox-alpha', lightModel: 'openrouter/auto', mediumModel: 'stealth/ox-alpha', heavyModel: 'stealth/ox-alpha',
      timeout: 300000,
      envVars: {}, apiKey: '',
    },
  },
  {
    id: 'opencode-openrouter', harnessId: 'opencode', method: 'cli', service: { definitionId: 'openrouter' },
    overrides: {
      name: 'OpenCode OpenRouter', enabled: false,
      models: ['openrouter/auto', 'stealth/ox-alpha'], defaultModel: 'stealth/ox-alpha',
      envVars: { OPENCODE_CONFIG_CONTENT: opencodeConfigContent('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1') },
    },
  },
  {
    id: 'opencode-openrouter-tui', harnessId: 'opencode', method: 'tui', service: { definitionId: 'openrouter' },
    overrides: {
      name: 'OpenCode OpenRouter TUI', enabled: false,
      models: ['openrouter/auto', 'stealth/ox-alpha'], defaultModel: 'stealth/ox-alpha',
      tuiIdleTimeoutMs: 180000,
      envVars: { OPENCODE_CONFIG_CONTENT: opencodeConfigContent('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1') },
    },
  },
  {
    id: 'nvidia-nim', harnessId: 'direct', method: 'api', service: { definitionId: 'nvidia-nim', credentials: { apiKey: '' } },
    overrides: {
      name: 'NVIDIA NIM', enabled: false,
      models: ['google/gemma-4-31b-it', 'poolside/laguna-xs-2.1'], defaultModel: 'poolside/laguna-xs-2.1', lightModel: 'google/gemma-4-31b-it', mediumModel: 'poolside/laguna-xs-2.1', heavyModel: 'poolside/laguna-xs-2.1',
      timeout: 300000,
      envVars: {}, apiKey: '',
    },
  },
  {
    id: 'opencode-nvidia-nim', harnessId: 'opencode', method: 'cli', service: { definitionId: 'nvidia-nim' },
    overrides: {
      name: 'OpenCode NVIDIA NIM', enabled: false,
      models: ['google/gemma-4-31b-it', 'poolside/laguna-xs-2.1'], defaultModel: 'poolside/laguna-xs-2.1',
      envVars: { OPENCODE_CONFIG_CONTENT: opencodeConfigContent('nvidia-nim', 'NVIDIA NIM', 'https://integrate.api.nvidia.com/v1') },
    },
  },
  {
    id: 'opencode-nvidia-nim-tui', harnessId: 'opencode', method: 'tui', service: { definitionId: 'nvidia-nim' },
    overrides: {
      name: 'OpenCode NVIDIA NIM TUI', enabled: false,
      models: ['google/gemma-4-31b-it', 'poolside/laguna-xs-2.1'], defaultModel: 'poolside/laguna-xs-2.1',
      tuiIdleTimeoutMs: 180000,
      envVars: { OPENCODE_CONFIG_CONTENT: opencodeConfigContent('nvidia-nim', 'NVIDIA NIM', 'https://integrate.api.nvidia.com/v1') },
    },
  },
  {
    id: 'opencode-zen', harnessId: 'direct', method: 'api', service: { definitionId: 'opencode-zen', credentials: { apiKey: '' } },
    overrides: {
      name: 'OpenCode Zen', enabled: false,
      models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'gpt-5.6-sol', 'gpt-5.5', 'grok-4.6', 'kimi-k3', 'qwen3.6-plus', 'big-pickle', 'deepseek-v4-flash-free'],
      defaultModel: 'claude-sonnet-5', lightModel: 'claude-haiku-4-5', mediumModel: 'claude-sonnet-5', heavyModel: 'claude-opus-5',
      timeout: 300000, envVars: {}, apiKey: '',
    },
  },
  {
    id: 'opencode-zen-cli', harnessId: 'opencode', method: 'cli', service: { definitionId: 'opencode-zen', credentials: { apiKey: 'placeholder' } },
    overrides: {
      name: 'OpenCode Zen CLI', enabled: false,
      models: ['opencode/big-pickle', 'opencode/ling-3.0-flash-fin-free', 'opencode/mimo-v2.5-free', 'opencode/muse-spark-1.2-contributor-free', 'opencode/muse-spark-1.3-contributor-free', 'opencode/nemotron-3-ultra-free', 'opencode/nemotron-3.5-lightning-free'],
      defaultModel: 'opencode/big-pickle',
      apiKey: OMIT,
      envVars: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: 'allow' }), OPENCODE_API_KEY: OMIT },
    },
  },
  {
    id: 'opencode-zen-tui', harnessId: 'opencode', method: 'tui', service: { definitionId: 'opencode-zen', credentials: { apiKey: 'placeholder' } },
    overrides: {
      name: 'OpenCode Zen TUI', enabled: false,
      models: ['opencode/big-pickle', 'opencode/ling-3.0-flash-fin-free', 'opencode/mimo-v2.5-free', 'opencode/muse-spark-1.2-contributor-free', 'opencode/muse-spark-1.3-contributor-free', 'opencode/nemotron-3-ultra-free', 'opencode/nemotron-3.5-lightning-free'],
      defaultModel: 'opencode/big-pickle',
      tuiIdleTimeoutMs: 180000,
      apiKey: OMIT,
      envVars: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: 'allow' }), OPENCODE_API_KEY: OMIT },
    },
  },

  // --- Codex -------------------------------------------------------------------
  {
    id: 'codex', harnessId: 'codex', method: 'cli', service: 'codex-subscription',
    overrides: {
      name: 'Codex CLI',
      models: ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark'],
      defaultModel: 'gpt-5.6-terra', lightModel: 'gpt-5.6-luna', mediumModel: 'gpt-5.6-terra', heavyModel: 'gpt-5.6-sol', ultraModel: 'gpt-6-astra',
      contextWindow: 1000000, timeout: 300000, enabled: true,
      textTransport: 'codex-app-server', ignoreUserConfig: false,
      // Every pure-subscription CLI record (this one, antigravity-cli, grok-cli,
      // kimi-cli, cursor-cli) ships with no headlessArgs at all; only a
      // local-runtime WRAPPER record (codex-ollama, every opencode-* sample)
      // carries the recipe's empty default. Kept consistent with that split
      // rather than adding a no-op field the recipe would otherwise default in.
      headlessArgs: OMIT,
    },
  },
  {
    id: 'codex-tui', harnessId: 'codex', method: 'tui', service: 'codex-subscription',
    overrides: {
      name: 'Codex TUI',
      models: ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark'],
      defaultModel: 'gpt-5.6-terra', lightModel: 'gpt-5.6-luna', mediumModel: 'gpt-5.6-terra', heavyModel: 'gpt-5.6-sol', ultraModel: 'gpt-6-astra',
      contextWindow: 1000000, enabled: false,
      textTransport: 'codex-app-server', ignoreUserConfig: false,
      // Codex TUI's real invocation carries a sandbox-bypass flag the harness
      // recipe (`providerHarnesses.js`) does not declare for `tui` — the recipe
      // is the ARGV CONTRACT for the connection-mint path
      // (`providerRouteRecipes.sampleParity.test.js`), which never exercises
      // codex TUI, so this is a deliberate, pinned addition, not drift to erase.
      args: ['--dangerously-bypass-approvals-and-sandbox'],
    },
  },
  {
    id: 'codex-ollama', harnessId: 'codex', method: 'cli',
    service: { definitionId: 'ollama', transports: { openai: { baseUrl: 'http://localhost:11434' } } },
    overrides: { name: 'Codex Ollama (local model)', enabled: false, numCtx: 131072, endpoint: 'http://localhost:11434', apiKey: OMIT },
  },
  {
    id: 'codex-lmstudio', harnessId: 'codex', method: 'cli',
    service: { definitionId: 'lmstudio', transports: { openai: { baseUrl: 'http://localhost:1234/v1' } } },
    overrides: { name: 'Codex LM Studio (local model)', enabled: false, numCtx: 32768, endpoint: 'http://localhost:1234/v1', apiKey: OMIT },
  },

  // --- Subscription-only harnesses ---------------------------------------------
  {
    id: 'antigravity-tui', harnessId: 'antigravity', method: 'tui', service: 'antigravity',
    overrides: {
      name: 'Antigravity TUI',
      models: ['antigravity-configured-default', 'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low', 'gemini-3.7-flash-high', 'gemini-3.7-flash-medium', 'gemini-3.7-flash-low', 'gemini-3.6-flash-high', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-low', 'gemini-3.1-pro-high', 'gemini-3.1-pro-low', 'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium'],
      defaultModel: 'antigravity-configured-default', lightModel: 'antigravity-configured-default', mediumModel: 'antigravity-configured-default', heavyModel: 'antigravity-configured-default',
      contextWindow: 1048576, enabled: false,
    },
  },
  {
    id: 'antigravity-cli', harnessId: 'antigravity', method: 'cli', service: 'antigravity',
    overrides: {
      name: 'Antigravity CLI',
      models: ['antigravity-configured-default', 'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low', 'gemini-3.7-flash-high', 'gemini-3.7-flash-medium', 'gemini-3.7-flash-low', 'gemini-3.6-flash-high', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-low', 'gemini-3.1-pro-high', 'gemini-3.1-pro-low', 'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium'],
      defaultModel: 'antigravity-configured-default', lightModel: 'antigravity-configured-default', mediumModel: 'antigravity-configured-default', heavyModel: 'antigravity-configured-default',
      contextWindow: 1048576, timeout: 300000, enabled: true,
      headlessArgs: OMIT,
    },
  },
  {
    id: 'grok-cli', harnessId: 'grok', method: 'cli', service: 'grok-build',
    overrides: {
      name: 'Grok Build CLI', models: ['grok-4.7', 'grok-4.6', 'grok-4.5'], defaultModel: 'grok-4.7', lightModel: 'grok-4.7', mediumModel: 'grok-4.7', heavyModel: 'grok-4.7',
      contextWindow: 256000, timeout: 300000, enabled: false,
      headlessArgs: OMIT,
    },
  },
  {
    id: 'grok-tui', harnessId: 'grok', method: 'tui', service: 'grok-build',
    overrides: {
      name: 'Grok Build TUI', models: ['grok-4.7', 'grok-4.6', 'grok-4.5'], defaultModel: 'grok-4.7', lightModel: 'grok-4.7', mediumModel: 'grok-4.7', heavyModel: 'grok-4.7',
      contextWindow: 256000, enabled: false,
    },
  },
  {
    id: 'kimi-cli', harnessId: 'kimi', method: 'cli', service: 'kimi',
    overrides: {
      name: 'Kimi Code CLI', models: ['kimi-configured-default'], defaultModel: 'kimi-configured-default', lightModel: 'kimi-configured-default', mediumModel: 'kimi-configured-default', heavyModel: 'kimi-configured-default',
      contextWindow: 256000, timeout: 300000, enabled: false,
      headlessArgs: OMIT,
    },
  },
  {
    id: 'kimi-tui', harnessId: 'kimi', method: 'tui', service: 'kimi',
    overrides: {
      name: 'Kimi Code TUI', models: ['kimi-configured-default'], defaultModel: 'kimi-configured-default', lightModel: 'kimi-configured-default', mediumModel: 'kimi-configured-default', heavyModel: 'kimi-configured-default',
      contextWindow: 256000, enabled: false,
    },
  },
  {
    id: 'cursor-cli', harnessId: 'cursor', method: 'cli', service: 'cursor',
    overrides: {
      name: 'Cursor Agent CLI',
      models: ['auto', 'composer-2.5', 'claude-opus-5-high', 'claude-opus-5-thinking-high', 'claude-opus-5-thinking-xhigh', 'claude-opus-5-thinking-max', 'claude-sonnet-5-high', 'claude-sonnet-5-thinking-high', 'claude-sonnet-5-thinking-xhigh', 'claude-fable-5-high', 'claude-fable-5-thinking-high', 'claude-opus-4-8-high', 'claude-opus-4-8-thinking-high', 'claude-4.6-sonnet-medium', 'gpt-5.6-sol-high', 'gpt-5.6-sol-xhigh', 'gpt-5.6-luna-high', 'gpt-5.6-terra-high', 'gpt-5.5-high', 'gpt-5.4-high', 'gpt-5.4-mini-high', 'gpt-5.3-codex', 'gpt-5.3-codex-high', 'gpt-5.3-codex-xhigh', 'gpt-5.2-high', 'gemini-3.1-pro', 'gemini-3.5-flash'],
      defaultModel: 'auto', lightModel: 'composer-2.5', mediumModel: 'claude-sonnet-5-thinking-high', heavyModel: 'claude-opus-5-thinking-high',
      timeout: 300000, enabled: false,
      headlessArgs: OMIT,
    },
  },
  {
    id: 'cursor-tui', harnessId: 'cursor', method: 'tui', service: 'cursor',
    overrides: {
      name: 'Cursor Agent TUI',
      models: ['auto', 'composer-2.5', 'claude-opus-5-high', 'claude-opus-5-thinking-high', 'claude-opus-5-thinking-xhigh', 'claude-opus-5-thinking-max', 'claude-sonnet-5-high', 'claude-sonnet-5-thinking-high', 'claude-sonnet-5-thinking-xhigh', 'claude-fable-5-high', 'claude-fable-5-thinking-high', 'claude-opus-4-8-high', 'claude-opus-4-8-thinking-high', 'claude-4.6-sonnet-medium', 'gpt-5.6-sol-high', 'gpt-5.6-sol-xhigh', 'gpt-5.6-luna-high', 'gpt-5.6-terra-high', 'gpt-5.5-high', 'gpt-5.4-high', 'gpt-5.4-mini-high', 'gpt-5.3-codex', 'gpt-5.3-codex-high', 'gpt-5.3-codex-xhigh', 'gpt-5.2-high', 'gemini-3.1-pro', 'gemini-3.5-flash'],
      defaultModel: 'auto', lightModel: 'composer-2.5', mediumModel: 'claude-sonnet-5-thinking-high', heavyModel: 'claude-opus-5-thinking-high',
      enabled: false,
    },
  },

  {
    id: 'cerebras', harnessId: 'direct', method: 'api', service: { definitionId: 'cerebras', credentials: { apiKey: '' } },
    overrides: {
      name: 'Cerebras', enabled: false,
      models: ['gpt-oss-120b'], defaultModel: 'gpt-oss-120b', lightModel: 'gpt-oss-120b', mediumModel: 'gpt-oss-120b', heavyModel: 'gpt-oss-120b',
      fallbackProvider: null, timeout: 300000,
      envVars: {}, apiKey: '',
    },
  },
  {
    id: 'lmstudio', harnessId: 'direct', method: 'api', service: { definitionId: 'lmstudio', slug: 'lmstudio', credentials: { apiKey: 'lm-studio' }, transports: { openai: { baseUrl: 'http://localhost:1234/v1' } } },
    overrides: { name: 'LM Studio', enabled: false, timeout: 300000, endpoint: 'http://localhost:1234/v1', apiKey: 'lm-studio', envVars: {}, lmstudioBacked: OMIT },
  },
  {
    id: 'ollama', harnessId: 'direct', method: 'api', service: { definitionId: 'ollama', slug: 'ollama', credentials: { apiKey: '' }, transports: { openai: { baseUrl: 'http://localhost:11434/v1' } } },
    overrides: { name: 'Ollama', enabled: false, timeout: 300000, temperature: 0.6, thinking: true, endpoint: 'http://localhost:11434/v1', apiKey: '', envVars: {}, ollamaBacked: OMIT },
  },
  {
    id: 'mtplx', harnessId: 'direct', method: 'api', service: { definitionId: 'mtplx', slug: 'mtplx', credentials: { apiKey: '' }, transports: { openai: { baseUrl: 'http://127.0.0.1:8000/v1' } } },
    overrides: {
      name: 'MTPLX (local MTP)', enabled: false, timeout: 300000, endpoint: 'http://127.0.0.1:8000/v1', apiKey: '',
      models: ['mtplx-qwen38-27b-optimized-speed'], defaultModel: 'mtplx-qwen38-27b-optimized-speed', envVars: {}, mtplxBacked: OMIT,
    },
  },
  {
    id: 'slotstream', harnessId: 'direct', method: 'api', service: { definitionId: 'slotstream', slug: 'slotstream', credentials: { apiKey: '' }, transports: { openai: { baseUrl: 'http://127.0.0.1:5564/v1' } } },
    overrides: {
      name: 'Slotstream (SSD-streaming MoE)', enabled: false, timeout: 300000, endpoint: 'http://127.0.0.1:5564/v1', apiKey: '',
      models: ['qwen3-235b-a22b-4bit', 'gpt-oss-120b-mxfp4', 'qwen3-30b-a3b-4bit'], defaultModel: 'qwen3-235b-a22b-4bit', envVars: {},
    },
  },
  {
    id: 'grok', harnessId: 'direct', method: 'api', service: { definitionId: 'xai', slug: 'grok', credentials: { apiKey: '' } },
    overrides: {
      name: 'xAI Grok', enabled: false,
      models: ['grok-4.7', 'grok-4', 'grok-3', 'grok-3-mini', 'grok-code-fast-1'], defaultModel: 'grok-4.7', lightModel: 'grok-3-mini', mediumModel: 'grok-3', heavyModel: 'grok-4.7',
      contextWindow: 500000,
      fallbackProvider: null, timeout: 300000, envVars: {}, apiKey: '',
    },
  },
];

/** Records no recipe or no service definition can compose (`connectionBlocker` on the harness row says why) — kept as data, not derived. */
const LITERALS = {
  'kilo-cli': {
    id: 'kilo-cli', name: 'Kilo Code CLI', type: 'cli', command: 'kilo', args: ['run', '--auto'],
    models: [], defaultModel: null, timeout: 600000, enabled: false, envVars: {}, secretEnvVars: [],
  },
  'kilo-tui': {
    id: 'kilo-tui', name: 'Kilo Code TUI', type: 'tui', command: 'kilo', args: ['--auto'],
    models: [], defaultModel: null, timeout: 600000, enabled: false, envVars: {}, secretEnvVars: [], tuiPromptDelayMs: 2500,
  },
  'openchamber-cli': {
    id: 'openchamber-cli', name: 'OpenChamber', type: 'cli', command: 'openchamber',
    args: ['session', 'create', '--wait', '--last-assistant', '--quiet'],
    models: [], defaultModel: null, timeout: 600000, enabled: false, envVars: {}, secretEnvVars: [],
  },
  'pi-cli': {
    id: 'pi-cli', name: 'Pi Coding Agent CLI', type: 'cli', command: 'pi', args: ['--print', '--approve'],
    models: [], defaultModel: null, timeout: 600000, enabled: false, envVars: {}, secretEnvVars: [],
  },
  'pi-tui': {
    id: 'pi-tui', name: 'Pi Coding Agent TUI', type: 'tui', command: 'pi', args: ['--approve'],
    models: [], defaultModel: null, timeout: 600000, enabled: false, envVars: {}, secretEnvVars: [],
  },
};

/** The canonical order every provider id is emitted in — shared by both files. */
export const PROVIDER_ORDER = [
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

/**
 * Per-file overrides applied on top of the shared composition. Empty for
 * every id except one documented, tested divergence: PortOS's own install
 * seed pins LM Studio to the local classifier model the brain/memory
 * features already document and reach for everywhere else in this codebase
 * (`server/services/memoryClassifier.js`, `server/lib/localLlmCatalog.js`,
 * `docs/features/brain-system.md`) — a concrete recommendation a fresh
 * PortOS install can act on. The vendored toolkit's own fallback sample has
 * no such opinion (a generic install has no way to know what the user has
 * pulled), so it stays the empty, disabled default.
 * `server/lib/aiToolkit/defaults/providersSeedParity.test.js` already pins
 * `lmstudio` as the one exempt id for exactly this reason — this generator
 * keeps that contract rather than erasing it.
 */
export const SAMPLE_OVERRIDES = {};
export const REFERENCE_OVERRIDES = {
  lmstudio: {
    models: ['gptoss-20b'], defaultModel: 'gptoss-20b', memoryClassifierModel: 'gptoss-20b', enabled: true,
  },
};

/** Compose one tuple's record. */
/**
 * Structural keys `materializeRoute` stamps on a LIVE composition (#7565) —
 * `harnessId`/`method`/`serviceId`/`servicePlan`. Deliberately dropped from
 * every shipped sample: those three keys mark a record `isDerivedPreset`
 * (`server/lib/providerGraphRecords.js`), and a derived preset re-resolves
 * itself through the provider GRAPH's own connection graph on every save
 * (`materializeStoredPreset` → `presetInputs` → `resolveCompositeParts`,
 * `server/services/providerPresets.js`). A shipped sample has no graph
 * connection behind it, so stamping these would make a fresh install's very
 * first save of the record (even flipping `enabled`) 400 with
 * `service-unknown` the moment the provider-graph feature is on — worse than
 * today's plain, hand-editable LEGACY record. See the module docstring.
 */
const DROP_STRUCTURAL_KEYS = ['harnessId', 'method', 'serviceId', 'servicePlan'];

function composeTuple({ id, harnessId, method, service, overrides = {} }) {
  const materialized = materializeRoute({ harness: harnessId, method, serviceInstance: service, providerId: id, name: overrides.name ?? id });
  for (const key of DROP_STRUCTURAL_KEYS) delete materialized[key];
  return applyOverrides(materialized, overrides);
}

/** Build the full `providers` map for one file variant (`sample` | `reference`). */
export function buildProviders(variant) {
  const perFile = variant === 'reference' ? REFERENCE_OVERRIDES : SAMPLE_OVERRIDES;
  const providers = {};
  for (const tuple of TUPLES) {
    const record = composeTuple(tuple);
    providers[tuple.id] = orderRecord(applyOverrides(record, perFile[tuple.id] || {}));
  }
  for (const [id, record] of Object.entries(LITERALS)) {
    providers[id] = orderRecord(applyOverrides(record, perFile[id] || {}));
  }
  const missing = PROVIDER_ORDER.filter((id) => !providers[id]);
  const extra = Object.keys(providers).filter((id) => !PROVIDER_ORDER.includes(id));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`PROVIDER_ORDER out of sync with the tuple/literal tables — missing: ${missing.join(', ') || 'none'}, extra: ${extra.join(', ') || 'none'}`);
  }
  const ordered = {};
  for (const id of PROVIDER_ORDER) ordered[id] = providers[id];
  return ordered;
}

/** The full shipped document for one file variant. */
export function buildDocument(variant) {
  return { activeProvider: ACTIVE_PROVIDER, providers: buildProviders(variant) };
}

/** Serialized form — one place so the writer and the drift test agree. */
export const serializeDocument = (doc) => `${JSON.stringify(doc, null, 2)}\n`;

function main() {
  writeFileSync(SAMPLE_PATH, serializeDocument(buildDocument('sample')), 'utf8');
  writeFileSync(REFERENCE_PATH, serializeDocument(buildDocument('reference')), 'utf8');
  console.log(`📜 Wrote ${Object.keys(buildProviders('sample')).length} providers to providers.sample.json and data.reference/providers.json`);
}

if (isDirectlyInvoked(import.meta.url)) main();
