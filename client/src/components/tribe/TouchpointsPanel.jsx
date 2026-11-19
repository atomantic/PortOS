import { useCallback } from 'react';
import { Calendar, MessageCircle, UserRound, Users } from 'lucide-react';
import * as api from '../../services/api';
import ListLoadError from '../ui/ListLoadError';
import useListResource from '../../hooks/useListResource';

// Icon + label per touchpoint source so an auto-logged calendar/message
// touchpoint is visually distinct from a hand-logged one (#2033).
const SOURCE_BADGES = {
  calendar: { Icon: Calendar, label: 'Calendar' },
  message: { Icon: MessageCircle, label: 'Message' },
  imessage: { Icon: MessageCircle, label: 'iMessage' },
  import: { Icon: Users, label: 'Import' },
  user: { Icon: UserRound, label: 'Manual' },
};

function TouchpointSource({ source }) {
  const badge = SOURCE_BADGES[source] || SOURCE_BADGES.user;
  const { Icon, label } = badge;
  return (
    <span className="inline-flex items-center gap-1" title={`Source: ${label}`}>
      <Icon size={12} aria-hidden="true" />
      {label}
    </span>
  );
}

export default function TouchpointsPanel({ personId }) {
  const fetchTouchpoints = useCallback(
    () => api.getTribeTouchpoints(personId, 8, { silent: true }).then((result) => result?.touchpoints || []),
    [personId],
  );
  const { items: touchpoints, state, error, retry } = useListResource(fetchTouchpoints, { enabled: !!personId });

  if (!personId) return null;

  return (
    <section className="mt-4 border border-port-border bg-port-card rounded p-4">
      <h2 className="text-sm font-semibold text-white">Touchpoints</h2>
      <div className="mt-3 grid gap-2">
        {state === 'error' ? (
          <ListLoadError what="touchpoints" error={error} onRetry={retry} />
        ) : touchpoints.length ? touchpoints.map((touchpoint) => (
          <div key={touchpoint.id} className="rounded border border-port-border bg-port-bg p-3">
            <div className="flex items-center justify-between gap-3 text-xs text-gray-500">
              <span>{touchpoint.happenedAt?.slice(0, 10)}</span>
              <TouchpointSource source={touchpoint.source} />
            </div>
            <p className="mt-1 text-sm text-gray-300">{touchpoint.summary || touchpoint.channel || 'Touchpoint'}</p>
          </div>
        )) : state === 'ready' ? (
          <p className="text-sm text-gray-500">No touchpoints logged yet.</p>
        ) : null}
      </div>
    </section>
  );
}
