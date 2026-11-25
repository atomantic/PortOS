/**
 * Refresh the model lists of the provider presets fronted by a PM2-managed local runtime (llama.cpp, MTPLX,
 * Slotstream, Splash, mkserve) right after the user's own start / checkpoint download / removal, so a picker
 * offers the checkpoint that is now served without a trip to AI Providers -> "Refresh Models".
 *
 * Callers are POST lifecycle handlers and the one-click readiness setup only; never boot, a timer or a GET. It
 * lists models (`GET /v1/models`) and never generates or spawns, the same statement `syncLocalProviderModels`
 * makes for Ollama/LM Studio. It never rejects: the start it follows must not fail or wait on it.
 */

import { refreshProviderModelsBatch, listProviders } from './provider/providers.js';
import { localRuntimeForProvider } from '../lib/localProviderRuntime.js';

// kind -> { running, again }. Single-flight with a trailing run: a notification arriving mid-refresh may follow a change
// (a removal after a download) the running refresh already read past, so it schedules one more pass instead of joining it.
const slots = new Map();

/**
 * @param {{ kind: string, io?: {emit: Function}|null, waitForReady?: (() => Promise<{ready?: boolean, reason?: string|null}>)|null }} opts
 *   `waitForReady`: pass it when the start returned before the endpoint answered; the refresh runs only once it
 *   resolves `ready`. A dead or never-answering runtime is not evidence the model set changed.
 * @returns {Promise<boolean>} true when a catalog was rewritten
 */
export async function syncRuntimeProviderModels({ kind, io = null, waitForReady = null }) {
  const slot = slots.get(kind);
  if (slot) {
    // Every queued caller shares the one trailing pass, which uses the latest caller's readiness wait.
    slot.pending = { io, waitForReady };
    slot.trailing ??= new Promise((resolve) => { slot.release = resolve; });
    return slot.trailing;
  }
  const mine = { pending: null, trailing: null, release: null };
  slots.set(kind, mine);
  let changed = await runGuarded({ kind, io, waitForReady });
  while (mine.pending) {
    const next = mine.pending;
    const release = mine.release;
    mine.pending = mine.trailing = mine.release = null;
    changed = await runGuarded({ kind, ...next });
    release(changed);
  }
  slots.delete(kind);
  return changed;
}

async function runGuarded(args) {
  return syncOnce(args).catch((err) => {
    console.error(`⚠️ Failed to refresh ${args.kind} provider models: ${err?.message ?? err}`);
    return false;
  });
}

async function syncOnce({ kind, io, waitForReady }) {
  if (waitForReady) {
    const ready = await waitForReady();
    if (!ready?.ready) {
      console.log(`⏭️ ${kind} provider model refresh skipped: ${ready?.reason || 'the runtime is not answering yet'}; use Refresh Models once it is up`);
      return false;
    }
  }
  // Writers read the unfiltered list: the entitlement-narrowed variants would persist a truncated catalog.
  const targets = (await listProviders())
    .filter((p) => p.enabled !== false && localRuntimeForProvider(p)?.kind === kind)
    .map((p) => p.id);
  if (targets.length === 0) return false;

  const groups = await refreshProviderModelsBatch(targets);
  for (const group of groups) {
    if (group.status === 'failed') {
      console.log(`⏭️ ${kind} provider model refresh skipped for ${group.ids.length} provider(s) via ${group.leadId}: ${group.error?.message}`);
    } else if (group.status === 'missing') {
      console.log(`⏭️ ${kind} provider model refresh skipped for ${group.ids.length} provider(s): ${group.leadId} no longer exists or did not answer`);
    }
  }
  const changed = groups.some((group) => group.status === 'updated');
  if (changed) io?.emit('providers:changed');
  return changed;
}
