import { Link } from 'react-router';
import { MessageSquare } from 'lucide-react';
import FullDiskAccessSteps from './FullDiskAccessSteps';
import LocalMessageSyncSettings from './LocalMessageSyncSettings';
import { getImessageStatus, checkImessageSetup, syncImessage } from '../../services/apiMessages.js';
import { pluralize } from '../../lib/textUtils';

// iMessage ingestion settings (#2151). Opt-in, machine-local ingestion of the
// macOS Messages database (chat.db) into the Tribe touchpoint log + activity
// timeline. OFF by default — reading chat.db needs macOS Full Disk Access.
export function IMessageSettingsPanel({ onSynced }) {
  return <LocalMessageSyncSettings
    domain="imessage"
    defaultInterval={30}
    getStatus={getImessageStatus}
    icon={MessageSquare}
    heading="iMessage ingestion"
    description={<p>
      Reads your local macOS Messages database (<code className="text-gray-300">~/Library/Messages/chat.db</code>) read-only
      and feeds both Tribe touchpoints and the activity timeline. Machine-local — nothing federates to peers.
      Requires macOS <strong>Full Disk Access</strong> for the process running PortOS.
      Browse, purge spam, and manage ingested events on the page behind this panel
      — deletes there remove PortOS copies only, never Apple Messages.
      For names instead of phone numbers, sync{' '}
      <Link to="/messages/contacts" className="text-port-accent hover:underline">Comms → Contacts</Link>
      {' '}(and optionally fill Tribe phones/emails).
    </p>}
    checkSetup={checkImessageSetup}
    syncNow={async (options) => {
      const result = await syncImessage(options);
      if (result?.ok) onSynced?.();
      return result;
    }}
    checkSuccessMessage={(report) => `Apple Messages reachable — ${pluralize(report.messageCount ?? 0, 'message')}`}
    checkErrorMessage={(report) => report?.fullDiskAccessRequired ? 'Full Disk Access required' : 'Apple Messages not reachable'}
    syncSuccessMessage={(result) => `Synced: ${pluralize(result.recorded, 'event')}, ${pluralize(result.touchpointsCreated, 'touchpoint')}${result.hasMore ? ' — more history remains, run again' : ''}`}
    syncErrorMessage={(result) => result?.fullDiskAccessRequired ? 'Full Disk Access required' : result?.error || 'Sync failed'}
    setupSuccess={(setup) => <p className="text-sm text-gray-300">Apple Messages reachable at <code className="text-gray-400">{setup.dbPath}</code> — {pluralize(setup.messageCount ?? 0, 'message')}.</p>}
    setupError={(setup) => setup.error}
    remediation={(setup, handleCheck, checking) => setup.fullDiskAccess
      ? <FullDiskAccessSteps target={setup.fullDiskAccess} onRecheck={handleCheck} rechecking={checking} />
      : setup.remediation && <p className="text-gray-400">{setup.remediation}</p>}
    metrics={({ status, lastResult }) => [
      { label: 'Cursor ROWID', value: status?.state?.cursorRowid ?? 0 },
      { label: 'Events recorded', value: lastResult?.recorded ?? '—' },
      { label: 'Touchpoints', value: lastResult?.touchpointsCreated ?? '—' },
      { label: 'Scanned', value: lastResult?.scanned ?? '—' },
      { label: 'Decode skips', value: lastResult?.decodeFailures ?? '—' },
    ]}
    afterSetup={null}
    syncDisabled={false}
  />;
}

export default IMessageSettingsPanel;
