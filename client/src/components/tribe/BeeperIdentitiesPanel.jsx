import { useCallback } from 'react';
import { Link } from 'react-router';
import { MessageCircle, X } from 'lucide-react';
import { getTribePerson, unlinkBeeperIdentity } from '../../services/apiTribe.js';
import toast from '../ui/Toast';
import ListLoadError from '../ui/ListLoadError';
import useListResource from '../../hooks/useListResource';

// One "Linked on Beeper" chip per identity claim (#99). The network shown is
// the CONVERSATION's network for a beeper-user claim (the claim's own
// `network` column is a Beeper ACCOUNT id, not a network name — see #96), the
// claim's own `network` for a handle claim, and the literal 'phone' for a
// phone claim (phones are network-less by design). The label is the
// participant's display name for a beeper-user claim (its `handle` is an
// opaque source_user_id, not human-readable) and the durable handle itself
// for a handle/phone claim. Every conversation the identity appears in gets
// its own thread link, ordered most-recent-first by the server.
function BeeperIdentityChip({ identity, onUnlink }) {
  const conversations = identity.conversations || [];
  const isBeeperUser = identity.kind === 'beeper-user';
  const network = identity.kind === 'phone'
    ? 'phone'
    : isBeeperUser
      ? (conversations[0]?.network || identity.network || 'beeper')
      : (identity.network || 'beeper');
  const label = isBeeperUser ? (conversations[0]?.displayName || identity.handle) : identity.handle;

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-full border border-port-border bg-port-bg px-3 py-1.5 text-xs text-gray-300">
      <span className="font-medium text-white">{network}</span>
      <span className="text-gray-600">&middot;</span>
      <span className="max-w-[10rem] truncate" title={label}>{label}</span>
      {conversations.map((conversation) => (
        <Link
          key={conversation.conversationId}
          to={`/messages/beeper/${conversation.conversationId}`}
          title={conversation.title ? `Open "${conversation.title}"` : 'Open Beeper thread'}
          aria-label={conversation.title ? `Open "${conversation.title}"` : 'Open Beeper thread'}
          className="text-port-accent hover:underline"
        >
          <MessageCircle size={13} aria-hidden="true" />
        </Link>
      ))}
      <button
        type="button"
        onClick={onUnlink}
        title="Unlink"
        aria-label={`Unlink ${label}`}
        className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 text-gray-500 hover:text-rose-300"
      >
        <X size={12} aria-hidden="true" />
      </button>
    </div>
  );
}

// The Tribe person form's "Linked on Beeper" block (#99). The roster row from
// `getTribePeople` never carries `identities` — that join only runs on the
// single-person read (`GET /tribe/people/:id`) — so this fetches the full
// person on mount/personId change, the same pattern `MemoryLinksPanel` and
// `TouchpointsPanel` already use. Renders nothing when the person has no
// Beeper claims (no empty heading).
export default function BeeperIdentitiesPanel({ personId }) {
  const fetchIdentities = useCallback(
    () => getTribePerson(personId, { silent: true }).then((person) => person?.identities || []),
    [personId],
  );
  const { items: identities, state, error, retry, setItems: setIdentities } = useListResource(fetchIdentities, { enabled: !!personId });

  const unlink = async (identityId) => {
    const result = await unlinkBeeperIdentity(identityId, { silent: true }).catch((err) => {
      toast.error(err.message || 'Failed to unlink Beeper identity');
      return null;
    });
    if (!result?.success) return;
    setIdentities((current) => current.filter((identity) => identity.id !== identityId));
  };

  if (state === 'error') return <ListLoadError what="Beeper links" error={error} onRetry={retry} className="mt-4" />;
  if (identities.length === 0) return null;

  return (
    <section className="mt-4 border border-port-border bg-port-card rounded p-4">
      <h2 className="text-sm font-semibold text-white">Linked on Beeper</h2>
      <div className="mt-3 flex flex-wrap gap-2">
        {identities.map((identity) => (
          <BeeperIdentityChip key={identity.id} identity={identity} onUnlink={() => unlink(identity.id)} />
        ))}
      </div>
    </section>
  );
}
