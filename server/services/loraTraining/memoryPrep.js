/**
 * Memory preparation for LoRA training runs.
 *
 * Training shares the Apple-Silicon unified-memory pool with every other
 * resident model server (ollama, LM Studio) and with PortOS itself. A run that
 * oversubscribes the pool swap-thrashes — ~21 GB of swap was live during the
 * GPU watchdog-timeout reboots documented in
 * docs/research/2026-06-13-mflux-training-watchdog-panic.md. Before spawning a
 * trainer we (1) unload resident LLMs to reclaim their memory and (2) measure
 * the real available headroom so the caller can size the run config to what's
 * actually free and refuse to start (rather than crash mid-run) when the pool
 * is too tight.
 *
 * Everything here is best-effort and never throws — a failed unload or an
 * unreadable vm_stat must not block training; it just yields a more
 * conservative (smaller) memory budget.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { platform, freemem, totalmem } from 'os';
import { getLoadedModels as ollamaLoadedModels, unloadModel as ollamaUnload, getBaseUrl as ollamaBaseUrl } from '../ollamaManager.js';
import { getLoadedModels as lmStudioLoadedModels, unloadModel as lmStudioUnload, getBaseUrl as lmStudioBaseUrl } from '../lmStudioManager.js';

const execFileAsync = promisify(execFile);
const GB = 2 ** 30;

// Headroom floor: below this even a 4-bit 4B run risks swap-thrash, so refuse
// to start rather than reboot the box. Tuned for the smallest supported run;
// larger variants are protected by the budget-derived quantize/low_ram tiers.
export const TRAINING_MIN_HEADROOM_GB = 24;

// Loopback hosts, plus `0.0.0.0` — a backend URL of `0.0.0.0` targets the local
// machine (the all-interfaces bind, which clients reach via loopback), so it is
// "local" for the purpose of deciding whether an unload frees local memory.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

/**
 * True only when `url` points at this machine (loopback, or the `0.0.0.0`
 * local-bind sentinel). Unloading a
 * model frees memory on the box the backend RUNS on, not the box that issued
 * the request — and PortOS supports pointing `OLLAMA_URL` / `LM_STUDIO_URL` at a
 * remote LAN peer (a common federated-machines setup). Evicting a *remote*
 * backend would free no local unified memory and would destroy another box's
 * loaded model for nothing, so we only unload when the backend is local.
 * Unparseable or non-loopback → treated as remote (skip the unload). All of
 * 127.0.0.0/8 is loopback, so any `127.*` host counts.
 */
export function isLocalBackendUrl(url) {
  if (!url || !URL.canParse(url)) return false;
  // URL.hostname keeps the [...] brackets on IPv6 literals; strip them so the
  // `::1` loopback compares against LOOPBACK_HOSTS.
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  return LOOPBACK_HOSTS.has(host) || host.startsWith('127.');
}

/**
 * Best-effort: unload every model currently resident in ollama and LM Studio so
 * its unified memory returns to the pool before a training run. Each unload is
 * independent — failures (server down, model already expired) are swallowed.
 * Skips a backend whose configured URL is NOT loopback-local: a remote backend
 * doesn't share this machine's memory, so evicting it would free nothing here
 * and needlessly drop a peer's loaded model. Returns the freed model labels for
 * logging. Never throws.
 */
export async function unloadResidentModels() {
  const unloaded = [];

  if (isLocalBackendUrl(ollamaBaseUrl())) {
    const ollamaLoaded = await ollamaLoadedModels().catch(() => []);
    for (const m of ollamaLoaded) {
      const name = m?.name || m?.id;
      if (!name) continue;
      const res = await ollamaUnload(name).catch(() => null);
      if (res?.unloaded) unloaded.push(`ollama:${name}`);
    }
  }

  if (isLocalBackendUrl(lmStudioBaseUrl())) {
    const lmLoaded = await lmStudioLoadedModels(true).catch(() => []);
    for (const m of lmLoaded) {
      if (!m?.id) continue;
      const res = await lmStudioUnload(m.id).catch(() => null);
      if (res?.success) unloaded.push(`lmstudio:${m.id}`);
    }
  }

  return unloaded;
}

const parsePageSize = (out) => {
  const m = out.match(/page size of (\d+) bytes/i); // case-insensitive for robustness
  return m ? Number(m[1]) : 4096;
};

/**
 * Parse `vm_stat` for the memory macOS can actually hand to a new process —
 * free + inactive + speculative + purgeable pages (the same buckets Activity
 * Monitor reclaims under pressure). Node's freemem() counts only truly-free
 * pages and so wildly understates available unified memory on macOS, which
 * keeps most RAM as reclaimable cache. Returns GB, or null if unparseable.
 */
async function darwinAvailableGb() {
  const { stdout } = await execFileAsync('vm_stat');
  const pageSize = parsePageSize(stdout);
  const pages = (label) => {
    const m = stdout.match(new RegExp(`${label}:\\s+(\\d+)\\.`));
    return m ? Number(m[1]) : 0;
  };
  const available = pages('Pages free') + pages('Pages inactive')
    + pages('Pages speculative') + pages('Pages purgeable');
  if (!available) return null;
  return (available * pageSize) / GB;
}

/**
 * Memory the OS can realistically give a training run right now, in GB. Uses
 * vm_stat on darwin (unified-memory-aware), falling back to freemem() on other
 * platforms or any failure. Never throws.
 */
export async function getAvailableMemoryGb() {
  if (platform() === 'darwin') {
    const v = await darwinAvailableGb().catch(() => null);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return freemem() / GB;
}

/**
 * Reclaim memory and report the budget for sizing/gating a training run:
 *   - unloaded: labels of resident models freed
 *   - availableGb: memory free after unloading
 *   - totalGb: physical RAM
 *   - budgetGb: what training may use (available, clamped to physical) — feed
 *     this to deriveMfluxMemoryConfig so the quantize/low_ram tier reflects
 *     real headroom, not raw RAM. Never throws.
 */
export async function prepareMemoryForTraining() {
  const unloaded = await unloadResidentModels().catch(() => []);
  const availableGb = await getAvailableMemoryGb().catch(() => 0);
  const totalGb = totalmem() / GB;
  const budgetGb = Math.min(totalGb, availableGb);
  return { unloaded, availableGb, totalGb, budgetGb };
}
