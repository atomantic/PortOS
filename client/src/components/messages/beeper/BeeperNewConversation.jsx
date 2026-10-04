import { useRef, useState } from 'react';
import { createBeeperConversation } from '../../../services/apiBeeper';
import useMounted from '../../../hooks/useMounted';

export default function BeeperNewConversation({ accounts, onCreated, onCancel }) {
  const [accountId, setAccountId] = useState(accounts[0]?.accountId || '');
  const [participantId, setParticipantId] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const inFlight = useRef(false);
  const mounted = useMounted();
  const accountExists = accounts.some((account) => account.accountId === accountId);

  const submit = async (event) => {
    event.preventDefault();
    if (inFlight.current || !accountExists || !participantId.trim()) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    const result = await createBeeperConversation(
      { accountId, participantId: participantId.trim() }, { silent: true },
    ).catch((err) => {
      if (mounted.current) setError(err?.message || 'Could not create conversation');
      return null;
    });
    inFlight.current = false;
    if (!mounted.current) return;
    setPending(false);
    if (result?.id) onCreated(result.id);
    else if (result) setError('Beeper did not return a conversation. Sync before trying again.');
  };

  return (
    <form onSubmit={submit} className="space-y-2 border-b border-port-border p-3">
      <h3 className="text-sm font-medium">New conversation</h3>
      <label htmlFor="beeper-new-account" className="block text-xs">Account</label>
      <select id="beeper-new-account" value={accountId} disabled={pending}
        onChange={(event) => setAccountId(event.target.value)}
        className="w-full rounded border border-port-border bg-port-bg p-2 text-sm">
        {accounts.map((account) => (
          <option key={account.accountId} value={account.accountId}>
            {account.displayName || account.network || account.accountId}
          </option>
        ))}
      </select>
      <label htmlFor="beeper-new-recipient" className="block text-xs">Recipient ID</label>
      <input id="beeper-new-recipient" value={participantId} required maxLength={500} disabled={pending}
        onChange={(event) => setParticipantId(event.target.value)}
        className="w-full rounded border border-port-border bg-port-bg p-2 text-sm" />
      <p className="text-xs text-gray-400">
        Use the recipient’s user ID for this network. Opens a direct chat without sending a message.
        Networks requiring a first message may reject creation.
      </p>
      {error && <p role="alert" className="text-xs text-port-error">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending || !accountExists || !participantId.trim()}
          className="min-h-[44px] rounded border border-port-border px-3 text-sm">
          {pending ? 'Opening…' : 'Open conversation'}
        </button>
        <button type="button" disabled={pending} onClick={onCancel} className="min-h-[44px] px-3 text-sm">Cancel</button>
      </div>
    </form>
  );
}
