/**
 * Read-only `grok models` catalog for Grok Build speed.
 *
 * The spawn lives here, not in `grok.js`, so the autofixer can keep importing
 * the argv helpers without pulling a child process. The probe never sends a
 * prompt and never writes Grok config.
 */

import { commandOutput } from './commandExists.js';
import { parseHarnessModels } from './harnessOutput.js';

/**
 * Model ids plus the `Default model:` line from `grok models` stdout.
 * Ids reuse the harness bullet parser, which drops the sign-in banner.
 * @param {string|null|undefined} stdout
 * @returns {{ ids: string[], defaultModel: string|null }}
 */
function parseGrokModelCatalog(stdout) {
  const text = typeof stdout === 'string' ? stdout : '';
  const ids = parseHarnessModels('grok', text);
  const defaultModel = text.match(/^Default model:\s*(\S+)\s*$/m)?.[1] || null;
  return { ids, defaultModel };
}

/**
 * Run `grok models` and parse it. Null when the command cannot run — distinct
 * from a listing that ran and advertised nothing.
 * @param {{ command?: string, envVars?: Record<string, string|undefined> }|null|undefined} provider
 * @param {{ cwd?: string, timeoutMs?: number }} [options]
 * @returns {Promise<{ ids: string[], defaultModel: string|null }|null>}
 */
export async function probeGrokModelCatalog(provider, { cwd, timeoutMs = 15_000 } = {}) {
  const stdout = await commandOutput(provider?.command || 'grok', ['models'], {
    timeoutMs,
    env: { ...process.env, ...(provider?.envVars || {}) },
    cwd,
  });
  if (stdout == null) return null;
  return parseGrokModelCatalog(stdout);
}
