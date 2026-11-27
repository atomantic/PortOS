/** Preset targets shared by the Agent Check picker, request validation, and execution. */

import { MKSERVE_MODEL } from './mkserveRuntime.js';
import { SPLASH_MODEL } from './splashRuntime.js';

export const LOCAL_TUI_AGENT_BENCHMARK_TARGETS = Object.freeze({
  llama: Object.freeze({
    providerId: 'opencode-llama-tui',
    label: 'OpenCode llama TUI (Qwen3.8-27B served as dflash)',
    command: 'opencode',
    modelId: 'dflash',
    aliases: Object.freeze(['qwen3.8-27b-dflash2']),
  }),
  mtplx: Object.freeze({
    providerId: 'opencode-mtplx-tui',
    label: 'OpenCode MTPLX TUI',
    command: 'opencode',
    modelId: 'mtplx-qwen38-27b-optimized-speed',
    aliases: Object.freeze([]),
  }),
  splash: Object.freeze({
    providerId: 'opencode-splash-tui',
    label: 'OpenCode Splash TUI',
    command: 'opencode',
    modelId: SPLASH_MODEL,
    aliases: Object.freeze([]),
  }),
  mkserve: Object.freeze({
    providerId: 'opencode-mkserve-tui',
    label: 'OpenCode mkserve TUI',
    command: 'opencode',
    modelId: MKSERVE_MODEL,
    aliases: Object.freeze([]),
  }),
  ollama: Object.freeze({
    providerId: 'opencode-ollama-tui',
    label: 'OpenCode Ollama TUI',
    command: 'opencode',
    modelId: 'qwen3.8:27b-mlx',
    aliases: Object.freeze([]),
  }),
  'ollama-coder': Object.freeze({
    providerId: 'opencode-ollama-tui',
    label: 'OpenCode Ollama TUI (Qwen3-Coder 30B)',
    command: 'opencode',
    modelId: 'qwen3-coder:30b',
    aliases: Object.freeze([]),
  }),
  'claude-ollama': Object.freeze({
    providerId: 'claude-ollama-tui',
    label: 'Claude Ollama TUI',
    command: 'claude',
    modelId: 'qwen3.8:27b-mlx',
    aliases: Object.freeze([]),
  }),
});
