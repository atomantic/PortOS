/**
 * Does the installed Codex CLI accept `--oss` / `--local-provider`?
 *
 * PortOS ships a `codex-ollama` provider — the Codex harness (sandbox ladder,
 * `apply_patch`, approvals, session lifecycle) generating its tokens from a
 * local Ollama model. That swap is a pair of per-invocation flags Codex added
 * in 0.153.0, and PortOS does NOT rewrite `~/.codex/config.toml` to fake them
 * on an older binary: a config rewrite would re-point every `codex` run on the
 * machine, not just PortOS's.
 *
 * So on an older CLI the row must fail CLOSED and legibly — a prerequisite
 * finding naming the required version — rather than spawning and dying mid-run
 * on an unknown flag, or, worse, silently running the OpenAI cloud model the
 * user thought they had replaced.
 *
 * `codex exec --help` is the source of truth, not the `--version` string: the
 * help text IS the contract, and a fork or a repackaged build can carry either
 * one without the other.
 *
 * **SENTINEL DISCIPLINE** (AGENTS.md), the same three-way split
 * `providerPrerequisites.js` runs on:
 *
 *   - `null` — NOT PROBED (cold cache, expired entry, or the probe itself could
 *     not run). Never reads as unsupported; an unprobed CLI must not take a
 *     working provider out of the fallback chain.
 *   - `{ supported: true }` — the help text names both flags.
 *   - `{ supported: false }` — the help text was read and does NOT name them.
 *
 * A probe that fails to spawn returns `null`, not `false`: "codex isn't here"
 * is the runtime table's finding, not this one's.
 *
 * No LLM call is made here — `--help` is a local process, safe under the
 * no-cold-bootstrap policy in AGENTS.md.
 */

import { commandOutput } from '../lib/commandExists.js';
import { CODEX_COMMAND } from '../lib/codex.js';

// Same window as the runtime `--version` sweep in providerRuntimeInstaller.js:
// an expiry is "we no longer know", so a user who upgrades Codex from a
// terminal stops being blocked within the TTL rather than until a restart.
const SUPPORT_TTL_MS = 60_000;

/** Both flags must be named — one without the other is not the contract. */
const OSS_FLAGS = ['--oss', '--local-provider'];

// Keyed by the command STRING the provider is configured with, so a wrapper
// pinned to `/opt/tools/codex` is judged on the binary it will actually spawn
// rather than on whatever `codex` resolves to on PATH.
const supportCache = new Map();

let refreshInFlight = new Map();

const readHelp = (command) => commandOutput(command, ['exec', '--help'], { timeoutMs: 10_000 });

const resolveCommand = (command) => (typeof command === 'string' && command.trim()) || CODEX_COMMAND;

/**
 * The cached verdict for `command`, or `null` when nothing current is cached.
 * Synchronous — no spawn, no promise. This is what the `GET /api/providers`
 * peek path reads.
 * @param {string} [command]
 * @returns {{supported: boolean}|null}
 */
export function peekCodexOssSupport(command) {
  const cached = supportCache.get(resolveCommand(command));
  if (!cached || Date.now() - cached.at >= SUPPORT_TTL_MS) return null;
  return cached.support;
}

/**
 * The verdict for `command`, probing when nothing current is cached.
 *
 * Coalesced per command: a failure storm picking a fallback per failed run must
 * not fan out one `--help` spawn per run.
 *
 * @param {string} [command]
 * @param {{fresh?: boolean, run?: (command: string) => Promise<string|null>}} [options]
 * @returns {Promise<{supported: boolean}|null>}
 */
export async function getCodexOssSupport(command, { fresh = false, run = readHelp } = {}) {
  const resolved = resolveCommand(command);
  if (!fresh) {
    const cached = peekCodexOssSupport(resolved);
    if (cached) return cached;
    const pending = refreshInFlight.get(resolved);
    if (pending) return pending;
  }
  const probe = (async () => {
    const help = await run(resolved).catch(() => null);
    // Could not run it at all — NOT PROBED, and deliberately not cached: the
    // next call should try again rather than sit on a non-answer for the TTL.
    if (help === null) return null;
    const support = { supported: OSS_FLAGS.every((flag) => help.includes(flag)) };
    supportCache.set(resolved, { at: Date.now(), support });
    return support;
  })().finally(() => { refreshInFlight.delete(resolved); });
  refreshInFlight.set(resolved, probe);
  return probe;
}

/**
 * Kick a probe in the background and swallow the result — for the synchronous
 * peek path, which cannot await but can make the NEXT read accurate. Errors are
 * logged, never thrown: this runs outside the request lifecycle, where an
 * unhandled rejection kills the process.
 * @param {string} [command]
 */
export function refreshCodexOssSupportInBackground(command) {
  const resolved = resolveCommand(command);
  if (refreshInFlight.has(resolved)) return;
  getCodexOssSupport(resolved).catch((err) => console.error(`❌ Codex --oss probe failed: ${err.message}`));
}

/** Test-only: drop the cache and any in-flight probe so a suite starts clean. */
export function __resetCodexOssSupport() {
  supportCache.clear();
  refreshInFlight = new Map();
}
