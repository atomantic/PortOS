import { Lock } from 'lucide-react';
import SignalManager from './SignalManager';
import LocalMessageSyncSettings from './LocalMessageSyncSettings';
import { getSignalStatus, checkSignalSetup, syncSignal } from '../../services/apiSignal.js';
import { pluralize } from '../../lib/textUtils';

const SIGNAL_DISABLED_MESSAGE = 'Enable Signal sync and save before checking setup or syncing.';

// Comms → Messages → Signal (#2154). Opt-in, machine-local ingestion of Signal Desktop's
// SQLCipher-encrypted chat database into the Tribe touchpoint log + activity
// timeline. OFF by default — reading the DB needs Signal's keychain-wrapped key.
// Highest-fragility source: everything degrades gracefully to an actionable error.
export function SignalTab() {
  return <LocalMessageSyncSettings
    domain="signal"
    defaultInterval={60}
    getStatus={getSignalStatus}
    icon={Lock}
    heading="Signal Desktop ingestion"
    description={<p>
      Reads your local Signal Desktop chat database
      (<code className="text-gray-300">~/Library/Application Support/Signal</code>) through a read-only
      SQLCipher snapshot, so committed messages still in the write-ahead log are included, and feeds both
      Tribe touchpoints and the activity timeline. Machine-local; nothing federates to peers. PortOS does
      not write or checkpoint the live database. The snapshot uses the bundled SQLCipher driver; if that
      driver cannot load, sync stops with a setup error and leaves the previous cursor in place.
      This is the most fragile source: if a Signal update changes its key or storage format, ingestion
      degrades to an actionable error rather than failing hard.
    </p>}
    checkSetup={checkSignalSetup}
    syncNow={syncSignal}
    checkSuccessMessage={(report) => `Signal DB reachable — ${pluralize(report.messageCount ?? 0, 'message')}`}
    checkErrorMessage={(report) => report?.enabled === false ? SIGNAL_DISABLED_MESSAGE : report?.error || 'Signal DB not reachable'}
    syncSuccessMessage={(result) => `Synced: ${pluralize(result.recorded, 'event')}, ${pluralize(result.touchpointsCreated, 'touchpoint')}${result.hasMore ? ' — more history remains, run again' : ''}`}
    syncErrorMessage={(result) => result?.error || 'Sync failed'}
    setupSuccess={(setup) => <p className="text-sm text-gray-300">Signal DB reachable — {pluralize(setup.messageCount ?? 0, 'message')}{setup.keySource ? ` (key via ${setup.keySource})` : ''}.</p>}
    setupError={(setup) => setup.enabled === false ? SIGNAL_DISABLED_MESSAGE : setup.error}
    afterSetup={<SignalManager />}
    metrics={({ status, lastResult }) => [
      { label: 'Cursor rowid', value: status?.state?.cursorRowid ?? 0 },
      { label: 'Events recorded', value: lastResult?.recorded ?? '—' },
      { label: 'Touchpoints', value: lastResult?.touchpointsCreated ?? '—' },
      { label: 'Scanned', value: lastResult?.scanned ?? '—' },
      { label: 'Key source', value: lastResult?.keySource ?? '—' },
    ]}
    syncDisabled
  />;
}

export default SignalTab;
