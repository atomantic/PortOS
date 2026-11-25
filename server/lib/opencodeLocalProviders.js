/**
 * Base OpenCode provider entries for local OpenAI-compatible daemons and hosted gateways, and the base URL PortOS declares for each.
 *
 * A leaf beside `opencodeConfig.js` so `localProviderRuntime.js` (reached by readiness checks, pickers and browser suites) can read a
 * runtime's default base URL without pulling the config builder's closure (`zod`, execution options, agent profiles). Readiness and
 * spawn agree because both read this one table; `opencodeConfig.js` adds the per-run models map on top of these rows.
 */

import { PROVIDER_GATEWAYS } from './provider/providerGateways.js';
import { PORTS } from './ports.js';
import { SPLASH_ORIGIN } from './splashRuntime.js';

const LLAMA_SERVER_BASE_URL = `http://127.0.0.1:${PORTS.LLAMA_SERVER}/v1`;
const VLLM_QWEN_BASE_URL = `http://127.0.0.1:${PORTS.VLLM_QWEN}/v1`;
const SGLANG_QWEN_BASE_URL = `http://127.0.0.1:${PORTS.SGLANG_QWEN}/v1`;

/** Base provider entries for local OpenAI-compatible daemons; `buildOpencodeConfig` adds the per-run models map. */
export const OPENCODE_LOCAL_BASE_PROVIDERS = {
  ollama: {
    npm: '@ai-sdk/openai-compatible',
    name: 'Ollama (local)',
    options: { baseURL: 'http://localhost:11434/v1' },
  },
  lmstudio: {
    npm: '@ai-sdk/openai-compatible',
    name: 'LM Studio (local)',
    // LM Studio's own app default, not a PortOS port (like Ollama's 11434).
    options: { baseURL: 'http://localhost:1234/v1' },
  },
  mtplx: {
    npm: '@ai-sdk/openai-compatible',
    name: 'MTPLX (local MTP)',
    options: { baseURL: 'http://127.0.0.1:8000/v1' },
  },
  splash: {
    npm: '@ai-sdk/openai-compatible',
    name: 'Splash (local)',
    options: { baseURL: `${SPLASH_ORIGIN}/v1` },
  },
  llama: {
    npm: '@ai-sdk/openai-compatible',
    name: 'llama.cpp (local)',
    options: { baseURL: LLAMA_SERVER_BASE_URL },
  },
  vllm: {
    npm: '@ai-sdk/openai-compatible',
    name: 'vLLM Qwen3.8-27B (local)',
    options: { baseURL: VLLM_QWEN_BASE_URL },
  },
  sglang: {
    npm: '@ai-sdk/openai-compatible',
    name: 'SGLang Qwen3.8-27B (local)',
    options: { baseURL: SGLANG_QWEN_BASE_URL },
  },
  // Hosted gateways share the OpenAI-compatible shape; rows are generated from the registry.
  ...Object.fromEntries(PROVIDER_GATEWAYS.map((gateway) => [gateway.id, {
    npm: '@ai-sdk/openai-compatible',
    name: gateway.label,
    options: { baseURL: gateway.baseURL },
  }])),
};

/**
 * The canonical base URL PortOS declares for one local OpenCode provider entry;
 * read by `lib/localProviderRuntime.js` so readiness and spawn agree.
 * @param {'ollama'|'lmstudio'|'mtplx'|'llama'|'vllm'|'sglang'|string} providerKey
 * @returns {string|null}
 */
export const opencodeLocalBaseUrl = (providerKey) =>
  OPENCODE_LOCAL_BASE_PROVIDERS[providerKey]?.options?.baseURL || null;
