import { ServerError } from '../lib/errorHandler.js';
import { NATIVE_USAGE_ACCOUNT_SELECTIONS_KEY, nativeUsageAccountSelectionsSchema, nativeUsageParticipantKey, nativeUsageSelectionRevision } from '../lib/nativeUsageSelections.js';
import { loadData } from './instanceIdentity.js';
import { readSettingsStrict, updateSettingsWith } from './settings.js';

const MAX_PEERS = 64;
const unavailable = () => new ServerError('Native account settings are unavailable. Existing settings are unchanged.', {
  status: 503, code: 'NATIVE_USAGE_ACCOUNTS_UNAVAILABLE',
});

function selectionsFrom(settings) {
  const parsed = nativeUsageAccountSelectionsSchema.safeParse(settings[NATIVE_USAGE_ACCOUNT_SELECTIONS_KEY] === undefined ? [] : settings[NATIVE_USAGE_ACCOUNT_SELECTIONS_KEY]);
  if (!parsed.success) throw unavailable();
  return parsed.data;
}

// Configured identities only. No source files, credentials, peer names/addresses,
// reachability probes or report requests belong in this configuration response.
async function readInventory() {
  const data = await loadData().catch(() => null);
  if (!data || !Array.isArray(data.peers)) return { participants: [], inventory: { status: 'unavailable', maxPeers: MAX_PEERS } };
  const participants = new Map();
  const local = nativeUsageParticipantKey(data.self?.instanceId);
  const identities = new Map(local ? [[local, 1]] : []);
  for (const peer of data.peers) {
    const key = nativeUsageParticipantKey(peer?.instanceId);
    if (key) identities.set(key, (identities.get(key) ?? 0) + 1);
  }
  if (local && identities.get(local) === 1) participants.set(local, { participantKey: local, kind: 'local', status: 'configured' });
  for (const peer of data.peers.slice(0, MAX_PEERS)) {
    const participantKey = nativeUsageParticipantKey(peer?.instanceId);
    if (participantKey && identities.get(participantKey) === 1 && !participants.has(participantKey)) participants.set(participantKey, { participantKey, kind: 'peer', status: 'configured' });
  }
  return { participants: [...participants.values()], inventory: {
    status: data.peers.length > MAX_PEERS ? 'truncated' : 'complete', maxPeers: MAX_PEERS,
  } };
}

function present(selections, inventory) {
  const participants = new Map(inventory.participants.map(row => [row.participantKey, row]));
  // The schema bounds selections and membership. Preserve every selected member,
  // even if its peer disappeared or lies outside the configured inventory cap.
  for (const member of selections.flatMap(selection => selection.members)) {
    if (!participants.has(member)) participants.set(member, { participantKey: member, kind: 'unavailable', status: 'not-configured' });
  }
  return { revision: nativeUsageSelectionRevision(selections), selections, inventory: inventory.inventory,
    participants: [...participants.values()] };
}

export async function getNativeUsageAccounts() {
  const { settings, corrupt } = await readSettingsStrict().catch(() => { throw unavailable(); });
  if (corrupt) throw unavailable();
  return present(selectionsFrom(settings), await readInventory());
}

/** Compare inside the existing settings write queue, including generic settings
 * writers. Only this key changes; failed/corrupt reads never supply an empty base.
 */
export async function saveNativeUsageAccounts({ expectedRevision, selections }, options) {
  let inventory;
  const next = await updateSettingsWith(async current => {
    const previous = selectionsFrom(current);
    if (nativeUsageSelectionRevision(previous) !== expectedRevision) {
      throw new ServerError('Native account selections changed. Reopen the editor before saving.', {
        status: 409, code: 'NATIVE_USAGE_ACCOUNTS_CONFLICT',
      });
    }
    inventory = await readInventory();
    if (inventory.inventory.status === 'unavailable') throw unavailable();
    const configured = new Set(inventory.participants.map(row => row.participantKey));
    const retained = new Set(previous.flatMap(selection => selection.members.map(member => `${selection.family}:${member}`)));
    for (const selection of selections) {
      if (selection.members.some(member => !configured.has(member) && !retained.has(`${selection.family}:${member}`))) {
        throw new ServerError('A selected participant is no longer configured. Reopen the editor before saving.', {
          status: 409, code: 'NATIVE_USAGE_ACCOUNTS_PARTICIPANT_UNAVAILABLE',
        });
      }
    }
    return { ...current, [NATIVE_USAGE_ACCOUNT_SELECTIONS_KEY]: selections };
  }, options).catch(error => {
    if (error instanceof ServerError) throw error;
    throw unavailable();
  });
  return present(selectionsFrom(next), inventory);
}
