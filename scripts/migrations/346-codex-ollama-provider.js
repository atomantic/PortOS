/**
 * Ship the disabled Codex-against-Ollama provider preset to existing installs.
 *
 * PortOS already runs Claude Code and OpenCode against a local model
 * (`claude-ollama`, migration 146; `opencode-ollama`) — the harness is the
 * value, and the model behind it is swappable. Codex was the one vendor with no
 * local-backed variant, because it has no `ANTHROPIC_BASE_URL`-style env lever.
 *
 * It no longer needs one: Codex 0.153.0 ships `--oss` / `--local-provider
 * <lmstudio|ollama>` natively, so PortOS emits a pair of PER-INVOCATION flags
 * from the record's own `ollamaBacked` marker (`buildCodexOssArgs` in
 * server/lib/codex.js). Deliberately NOT a rewrite of `~/.codex/config.toml`:
 * that file is the user's, and re-pointing it would re-route every `codex` run
 * on the machine rather than only PortOS's.
 *
 * Three things about this record are load-bearing:
 *
 *   1. **`ollamaBacked: true`, not a codex-specific flag.** It is the same axis
 *      the Claude/OpenCode wrappers ride, so `isOllamaBackedProvider`,
 *      `localRuntimeNamespace` and `ensureOllamaAgentContext` pick the row up
 *      with no new call site. A hand-copied second instance of that axis is
 *      exactly what `providerGateways.js`'s header warns about.
 *   2. **`numCtx` is pinned.** Same trap #6191 fixed for the Claude Ollama
 *      pair: an unpinned local prefill at Codex's 262K window reloads the daemon
 *      into a context it cannot serve at usable speed.
 *   3. **No `textTransport`.** The codex app-server transport is the ChatGPT
 *      subscription path; a local-backed record runs the ordinary `codex exec`
 *      argv, which is what carries the `--oss` flags.
 *
 * The preset is DISABLED and this migration installs nothing — no model pull,
 * no request to the daemon, nothing until the user enables it (AGENTS.md, "No
 * cold-bootstrap LLM calls"). On a Codex older than 0.153.0 the row fails
 * closed with a named prerequisite rather than spawning (see
 * server/services/codexOssSupport.js).
 *
 * LM Studio is codex's other `--local-provider` value and is deliberately NOT
 * seeded here: PortOS has no LM Studio backing marker, and inventing a second
 * daemon-prep path is its own change. See #6309.
 *
 * Kept in lockstep with data.reference/providers.json and
 * server/lib/aiToolkit/defaults/providers.sample.json. This frozen literal is
 * the historical upgrade payload; later default changes require a new migration
 * rather than rewriting this record.
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
