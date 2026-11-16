/**
 * Pin a 128K context window on the Ollama-backed Claude harness records (#6191).
 *
 * `claude-ollama` / `claude-ollama-tui` shipped with no `numCtx`, so `ensureOllamaAgentContext` (server/services/ollamaAgentContext.js) never reloaded the daemon and Ollama's VRAM-based auto-pick stood: on a large-VRAM
 * machine 262144 tokens, where prefill throughput decays as the KV cache grows (a ~98K-token pr-reviewer Stage 3 prompt measured 88 tok/s early, 48 tok/s late). Halving the window halves the KV bandwidth while still clearing
 * the ~100K-token Stage 3 envelope; 32768 (the `ollama` api-type default) is SMALLER than that envelope and would turn a slow run into a refused one.
 *
 * Deliberately NOT done:
 *   - **Never overwrites a window the user picked.** Only a record with no usable `numCtx` is stamped, and the migration stands down when `OLLAMA_CONTEXT_LENGTH` is set (`resolveOllamaContextLength` ranks a
 *     record's `numCtx` ABOVE that env var), since stamping over a deliberately small machine-wide window could make an install worse (past what VRAM allows, Ollama offloads layers to CPU).
 *   - **Never touches a record repointed at another binary.** Keyed on the `ollamaBacked` marker plus the `claude` command (as `isOllamaBackedProvider` + the harness), so a renamed clone is covered and a wrapper is not.
 *
 * `numCtx: null` counts as UNSET: `createProvider` (server/lib/aiToolkit/providers.js) normalizes every absent value to `null` on write, so treating it as user intent would make this a no-op exactly where needed.
 * Kept in lockstep with data.reference/providers.json; later default changes require a new migration.
 */

import { readProvidersDoc, writeJsonAtomic } from './_lib.js';

const NUM_CTX = 131072;
const CLAUDE_COMMAND = 'claude';
// Ollama's own machine-wide knob, spelled out rather than imported: a migration
// is a frozen snapshot and must not drift when `lib/ollamaContext.js` changes.
const OLLAMA_CONTEXT_ENV_VAR = 'OLLAMA_CONTEXT_LENGTH';

// Logged relative, never as `doc.path` — that is an absolute path carrying the
// operator's home directory, and a boot line is the wrong place to print it.
const PROVIDERS_REL_PATH = 'data/providers.json';

// `readProvidersDoc` is deliberately silent so each caller can say what ITS skip
// costs the user; this is 339's copy of that message.
const SKIP_REASONS = {
  'no-file': 'not present (a fresh install seeds these from data.reference)',
  unreadable: 'is not valid JSON',
  'bad-shape': 'has no providers map',
};

/** A positive integer window, or null when the field carries no usable value. */
const usableNumCtx = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
};

/**
 * Is this record still an Ollama-backed Claude harness with no window pinned?
 *
 * Command matching is byte-for-byte the rule `lib/providerModels.commandBasename`
 * applies (inlined because a migration is a frozen snapshot and must not drift
 * when that helper changes): case-INSENSITIVE basename, only `.exe` stripped.
 */
const needsNumCtx = (provider) => {
  if (provider?.type !== 'cli' && provider?.type !== 'tui') return false;
  if (provider.ollamaBacked !== true) return false;
  if (usableNumCtx(provider.numCtx)) return false;
  const command = typeof provider.command === 'string' ? provider.command.trim() : '';
  if (command === '') return false;
  return command.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '') === CLAUDE_COMMAND;
};

export default {
  async up({ rootDir, env = process.env }) {
    // A set env var is the user having already chosen this machine's window.
    // Checked before the read so the file is never touched in that case.
    const ambient = usableNumCtx(env?.[OLLAMA_CONTEXT_ENV_VAR]);
    if (ambient) {
      console.log(`🪟 ${OLLAMA_CONTEXT_ENV_VAR}=${ambient} is already set — leaving the Claude Ollama records on that window`);
      return { ok: true, reason: 'ambient-context-length', updated: 0 };
    }

    const doc = await readProvidersDoc({ rootDir });
    if (!doc.ok) {
      const why = SKIP_REASONS[doc.reason] ?? 'could not be read';
      console.log(`📄 ${PROVIDERS_REL_PATH} ${why} — skipping the Claude Ollama context-window pin`);
      return { ok: false, reason: doc.reason, updated: 0 };
    }

    const targets = Object.values(doc.providers).filter(needsNumCtx);
    if (targets.length === 0) return { ok: true, reason: 'already-current-or-custom', updated: 0 };

    for (const provider of targets) provider.numCtx = NUM_CTX;
    await writeJsonAtomic(doc.path, doc.config);
    console.log(`📝 ${PROVIDERS_REL_PATH}: ${targets.length} Claude Ollama provider record${targets.length === 1 ? '' : 's'} pinned to a ${NUM_CTX}-token context window`);
    return { ok: true, reason: 'updated', updated: targets.length };
  },
};
