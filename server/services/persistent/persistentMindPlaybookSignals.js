/**
 * Live-signal gathering for the Persistent Mind continuous-play playbook phase
 * (issue #7458). The pure picker lives in `../../lib/persistent/persistentMindPlaybookPhase.js`;
 * this module owns the I/O: the bounded Eidoverse world-signal projection plus the
 * observation report of what arrived from a peer since the mind last looked.
 *
 * Both collaborators are dynamically imported so `default`-mode minds never pay for
 * their ~20 service reads; the projection is collected once.
 */

import {
  derivePersistentMindPlaybookPhaseSignals,
  selectPersistentMindPlaybookPhase,
} from '../../lib/persistent/persistentMindPlaybookPhase.js';

/**
 * Degrade one signal read to `null` ("unknown") rather than parking the wake. An
 * abort is NOT a signal failure: swallowing it would let the wake continue
 * against a world nobody read.
 */
const orNull = (what, signal) => (error) => {
  if (signal?.aborted) throw error;
  console.error(`❌ Persistent mind playbook phase ${what} unavailable: ${error.message}`);
  return null;
};

/**
 * Resolve the current continuous-play phase from live PortOS/Eidoverse world
 * signals. Never throws except on abort: a failed read degrades to the picker's
 * `explore` default.
 *
 * `commit: false` on the observation is load-bearing: observing advances the visit
 * marker, and the picker must not consume the "what is new since I last looked"
 * trail the mind's own `eidoverse.observe` call (and the `coordinate` phase) needs.
 */
export async function resolvePersistentMindPlaybookPhase({ signal } = {}) {
  const worldSignals = await import('../eidoverseWorldSources.js')
    .then(({ collectEidoverseWorldSources }) => collectEidoverseWorldSources({ signal }))
    .catch(orNull('signals', signal));
  const observation = await import('../eidoverseObservationLedger.js')
    .then(({ observeEidoverseWorld }) => observeEidoverseWorld({
      signal,
      commit: false,
      source: worldSignals ?? {},
    }))
    .catch(orNull('observation', signal));
  const signals = derivePersistentMindPlaybookPhaseSignals(worldSignals, observation);
  return { ...selectPersistentMindPlaybookPhase(signals), signals };
}
