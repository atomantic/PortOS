/**
 * Live-signal gathering for the Persistent Mind continuous-play playbook
 * phase (issue #7458). The pure picker lives in
 * `../lib/persistentMindPlaybookPhase.js`; this module owns the I/O that
 * feeds it — reading the same bounded Eidoverse world-signal projection the
 * World Design V2 recipe renders into districts.
 *
 * `collectEidoverseWorldSources` is dynamically imported so a mind running
 * in `default` playbook mode (the common case) never pays for the ~20
 * parallel service reads it performs; only an active `continuous-play` wake
 * reaches this module at all.
 */

import {
  derivePersistentMindPlaybookPhaseSignals,
  selectPersistentMindPlaybookPhase,
} from '../lib/persistentMindPlaybookPhase.js';

/**
 * Resolve the current continuous-play phase from live PortOS/Eidoverse world
 * signals. Never throws: a signal read failure degrades to the picker's
 * `explore` default rather than parking the wake.
 */
export async function resolvePersistentMindPlaybookPhase({ signal } = {}) {
  const worldSignals = await import('./eidoverseWorldSources.js')
    .then(({ collectEidoverseWorldSources }) => collectEidoverseWorldSources({ signal }))
    .catch((error) => {
      if (signal?.aborted) throw error;
      console.error(`❌ Persistent mind playbook phase signals unavailable: ${error.message}`);
      return null;
    });
  const signals = derivePersistentMindPlaybookPhaseSignals(worldSignals);
  return { ...selectPersistentMindPlaybookPhase(signals), signals };
}
