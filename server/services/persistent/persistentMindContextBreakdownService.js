/**
 * Live context-window breakdown for the Persistent Mind panel.
 *
 * Gathers the read-only inputs (tool-schema cost, resolved window, latest completed turn receipt) and hands them to the pure calculator in lib/persistent/persistentMindContextBreakdown.js. Zero LLM calls.
 */
import {
  buildPersistentMindContextBreakdown,
  resolvePersistentMindWindowProvenance,
} from '../../lib/persistent/persistentMindContextBreakdown.js';
import { PERSISTENT_MIND_ID, publicPersistentMindCallReceipt } from '../../lib/persistent/persistentMindTrajectory.js';
import { readPersistentMindHistory } from '../agent/agentRunEventLog.js';

const warnedPins = new Set();

// One line per (provider, model, numCtx): a pin that disagrees with the advertised window is worth knowing once, not on every panel load.
function warnPinOnce(providerId, model, window) {
  if (!window.pinDisagreesWithAdvertised) return;
  const key = `${providerId}|${model}|${window.pinnedWindow}`;
  if (warnedPins.has(key)) return;
  warnedPins.add(key);
  console.log(`ℹ️ Mind context pin differs from advertised window: provider=${providerId} model=${model || 'default'} numCtx=${window.pinnedWindow} advertised=${window.advertisedWindow}`);
}

export const __resetContextPinWarningsForTests = () => warnedPins.clear();

export async function readPersistentMindContextBreakdown({ preview, provider, profile, capabilities }) {
  const model = profile?.model || provider?.defaultModel || null;
  const [{ describePersistentMindToolCost, readPersistentMindRecipeCatalog }, history] = await Promise.all([
    import('../cos/cosToolRegistry.js'),
    readPersistentMindHistory(PERSISTENT_MIND_ID),
  ]);
  const toolCost = await describePersistentMindToolCost(capabilities, await readPersistentMindRecipeCatalog(capabilities));
  let effectiveWindow = null;
  if (provider) {
    const { effectiveContextWindow } = await import('../stageRunner.js');
    effectiveWindow = effectiveContextWindow(provider, model);
  }
  const window = resolvePersistentMindWindowProvenance({ provider, model, effectiveWindow });
  warnPinOnce(provider?.id ?? profile?.providerId, model, window);
  const latest = history.findLast((event) => event.kind === 'mind.model.call'
    && event.data?.purpose === 'turn' && event.data?.outcome === 'completed');
  return buildPersistentMindContextBreakdown({
    preview,
    toolCost,
    window,
    lastCall: latest ? publicPersistentMindCallReceipt(latest) : null,
  });
}
