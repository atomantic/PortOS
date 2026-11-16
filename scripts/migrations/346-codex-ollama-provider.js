/**
 * Ship the disabled Codex-against-Ollama provider preset to existing installs.
 *
 * PortOS already runs Claude Code and OpenCode against a local model (`claude-ollama`, migration 146; `opencode-ollama`); Codex had no local-backed variant for lack of an `ANTHROPIC_BASE_URL`-style lever. Codex 0.153.0 ships `--oss` / `--local-provider <lmstudio|ollama>`,
 * so PortOS emits PER-INVOCATION flags from the record's `ollamaBacked` marker (`buildCodexOssArgs` in server/lib/codex.js), deliberately NOT rewriting the user's `~/.codex/config.toml` (that would re-route every `codex` run on the machine).
 *
 * Load-bearing: (1) `ollamaBacked: true`, the axis the Claude/OpenCode wrappers ride, so `isOllamaBackedProvider`, `localRuntimeNamespace` and `ensureOllamaAgentContext` pick the row up (see `providerGateways.js`'s header); (2) `numCtx` is pinned, as #6191 did for the Claude Ollama pair (an unpinned local
 * prefill at Codex's 262K window reloads the daemon into a context it can't serve at usable speed); (3) no `textTransport`: the app-server transport is the ChatGPT subscription path, while a local-backed record runs ordinary `codex exec`, which carries the `--oss` flags.
 *
 * The preset is DISABLED and installs nothing until the user enables it (AGENTS.md, "No cold-bootstrap LLM calls"); on a Codex older than 0.153.0 it fails closed with a named prerequisite (server/services/codexOssSupport.js).
 * LM Studio (codex's other `--local-provider`) is deliberately NOT seeded: PortOS has no LM Studio backing marker (#6309).
 *
 * Kept in lockstep with data.reference/providers.json and server/lib/aiToolkit/defaults/providers.sample.json; this frozen literal is the historical upgrade payload, later default changes require a new migration.
 */

import { makeProviderSeedMigration } from './_lib.js';

const CODEX_OLLAMA = {
  id: 'codex-ollama',
  name: 'Codex Ollama (local model)',
  type: 'cli',
  command: 'codex',
  args: [],
  // The daemon the readiness probe and the model refresh hit. Codex resolves
  // its OWN connection from `--local-provider ollama`; this is PortOS's copy of
  // the same fact, and it is what `ollamaBaseFromProvider` reads to decide
  // whether the local daemon is the one to reload.
  endpoint: 'http://localhost:11434',
  // Filled by the Ollama model refresh — a seeded list would name models this
  // install has never pulled.
  models: [],
  defaultModel: null,
  ollamaBacked: true,
  numCtx: 131072,
  timeout: 600000,
  enabled: false,
  envVars: {},
  secretEnvVars: [],
  headlessArgs: [],
};

export default makeProviderSeedMigration({
  label: 'Codex Ollama (local model)',
  defs: [CODEX_OLLAMA],
});
