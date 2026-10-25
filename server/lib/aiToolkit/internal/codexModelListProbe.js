/**
 * Codex publishes no plain `models` subcommand — its catalog lives behind the
 * `app-server` JSON-RPC handshake (`initialize` → `initialized` →
 * `model/list`), so listing it means driving that long-lived process
 * directly rather than treating it as a single `commandOutput` stdout capture
 * the way every other harness's `<cli> models` answer is read.
 *
 * A LEAF module (no imports out of this directory) so a host caller — the
 * Harnesses page refresh in `services/harnesses.js`, which has no Codex
 * `provider` record to resolve a spawn from — can drive the same probe
 * `_fetchCodexModels` in `providerCatalogService.js` uses, with an
 * already-resolved `command`/`args`/`env` rather than a toolkit provider
 * shape (#8497).
 */
import { spawn } from 'child_process';
import { withCodexShippedModels } from './codexShippedModels.js';

const DEFAULT_TIMEOUT_MS = 15000;

/**
 * @param {string} command - the resolved (Windows-safe) executable.
 * @param {string[]} args - argv, expected to end in `app-server`.
 * @param {{ envVars?: NodeJS.ProcessEnv }|null} provider - only `envVars` is
 *   read (a toolkit provider record, or `null` for a bare harness probe with
 *   no per-record overrides — `services/providerRuntimeInstaller.js`).
 * @param {{ timeoutMs?: number, label?: string }} [options]
 * @returns {Promise<string[]>} de-duplicated, non-hidden model ids, followed by
 *   any shipped preset id the CLI's (lagging) catalog does not list yet.
 */
export function probeCodexModelsViaAppServer(command, args, provider, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const label = options.label ?? `'${command} ${args.join(' ')}'`;
  const childEnv = { ...process.env, ...provider?.envVars };
  return new Promise((resolve, reject) => {
    let settled = false;
    let child;
    const settle = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child?.kill('SIGTERM'); } catch { /* already exited */ }
      if (err) reject(err);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      settle(new Error(`${label} timed out waiting for model catalog`));
    }, timeoutMs);
    timer.unref?.();
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv, windowsHide: true, ...(options.cwd ? { cwd: options.cwd } : {}) });
    } catch (err) {
      settle(new Error(`${label} failed to spawn: ${err?.message || err}`));
      return;
    }
    child.on('error', (err) => settle(new Error(`${label} failed: ${err?.message || err}`)));
    child.stdin?.on('error', () => {});
    child.on('exit', (code, signal) => settle(new Error(`${label} exited prematurely with code ${code ?? signal}`)));

    let buffer = '';
    let accountType = null;
    let requirements = null;
    let config = null;
    let modelRequestId = options.includeDetails ? 10 : 2;
    let pages = 0;
    const collected = [];
    const send = (id, method, params = {}) => child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    child.stdout?.on('data', (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 4 * 1024 * 1024) { settle(new Error(`${label} model catalog frame exceeded its bound`)); return; }
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (msg.id === 1) {
            if (msg.error) { settle(new Error(`${label} initialize failed`)); return; }
            child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n');
            if (options.includeDetails) send(3, 'account/read');
            else send(modelRequestId, 'model/list');
          } else if (options.includeDetails && msg.id === 3) {
            if (msg.error) { settle(new Error('Execution capabilities require account/read support')); return; }
            accountType = msg.result?.account?.type || msg.result?.account?.authMethod || null;
            send(4, 'configRequirements/read');
          } else if (options.includeDetails && msg.id === 4) {
            if (msg.error || !Object.hasOwn(msg.result || {}, 'requirements')) {
              settle(new Error('Execution capabilities require configRequirements/read support')); return;
            }
            requirements = msg.result.requirements;
            send(5, 'config/read', { includeLayers: false, ...(options.cwd ? { cwd: options.cwd } : {}) });
          } else if (options.includeDetails && msg.id === 5) {
            if (msg.error || !msg.result?.config) { settle(new Error('Execution capabilities require config/read support')); return; }
            config = msg.result.config;
            send(modelRequestId, 'model/list');
          } else if (msg.id === modelRequestId) {
            if (msg.error) { settle(new Error(`${label} model/list error: ${msg.error.message || 'unknown failure'}`)); return; }
            const page = msg.result?.data || msg.result?.models;
            if (!Array.isArray(page)) { settle(new Error(`${label} returned no model array`)); return; }
            collected.push(...page);
            pages++;
            if (msg.result.nextCursor) {
              if (pages >= 32) { settle(new Error(`${label} model catalog pagination did not settle`)); return; }
              modelRequestId += options.includeDetails ? 1 : 100;
              send(modelRequestId, 'model/list', { cursor: msg.result.nextCursor });
              continue;
            }
            const rawModels = collected;
            const ids = rawModels
              .filter((m) => !m.hidden)
              .map((m) => (typeof m === 'string' ? m : m?.id || m?.model))
              .filter(Boolean);
            if (ids.length === 0) {
              settle(new Error(`${label} returned no model ids`));
              return;
            }
            settle(null, options.includeDetails ? { models: rawModels.filter((m) => !m.hidden), accountType, requirements, config } : withCodexShippedModels(ids));
            return;
          }
        } catch { /* not JSON, or not a message we're waiting on — ignore */ }
      }
    });
    child.stdin?.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'portos', version: '1.0.0' } },
    }) + '\n');
  });
}
