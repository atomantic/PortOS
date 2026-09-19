/**
 * Live-signal gathering for the Persistent Mind continuous-play playbook
 * phase (issue #7458). The pure picker lives in
 * `../lib/persistentMindPlaybookPhase.js`; this module owns the I/O that
 * feeds it — the bounded Eidoverse world-signal projection the World Design
 * recipe renders into districts, plus the observation report that says what
 * arrived from a peer since this mind last looked.
 *
 * Both collaborators are dynamically imported so a mind running in `default`
 * playbook mode (the common case) never pays for the ~20 parallel service
 * reads they perform; only an active `continuous-play` wake reaches this
 * module at all. The projection is collected once and handed to the
 * observation so the wake does not fan out across those reads twice.
 */

import {
  derivePersistentMindPlaybookPhaseSignals,
  selectPersistentMindPlaybookPhase,
} from '../lib/persistentMindPlaybookPhase.js';

/**
 * Degrade one signal read to `null` ("unknown") rather than parking the wake.
 * An abort is NOT a signal failure — the turn was interrupted, and swallowing
 * it here would let the wake continue against a world nobody read.
 */
const orNull = (what, signal) => (error) => {
  if (signal?.aborted) throw error;
  console.error(`❌ Persistent mind playbook phase ${what} unavailable: ${error.message}`);
  return null;
};

/**
 * Resolve the current continuous-play phase from live PortOS/Eidoverse world
 * signals. Never throws (except on abort): a signal read failure degrades to
 * the picker's `explore` default rather than parking the wake.
 *
 * `commit: false` on the observation is load-bearing. Observing normally
 * advances the visit marker, and the picker must not consume the "what is new
 * since I last looked" trail that the mind's own `eidoverse.observe` call —
 * and the very `coordinate` phase this resolves — depends on.
 */
export async function resolvePersistentMindPlaybookPhase({ signal } = {}) {
  const worldSignals = await import('./eidoverseWorldSources.js')
    .then(({ collectEidoverseWorldSources }) => collectEidoverseWorldSources({ signal }))
    .catch(orNull('signals', signal));
  const observation = await import('./eidoverseObservationLedger.js')
    .then(({ observeEidoverseWorld }) => observeEidoverseWorld({
      signal,
      commit: false,
      source: worldSignals ?? {},
    }))
    .catch(orNull('observation', signal));
  const signals = derivePersistentMindPlaybookPhaseSignals(worldSignals, observation);
  return { ...selectPersistentMindPlaybookPhase(signals), signals };
}
