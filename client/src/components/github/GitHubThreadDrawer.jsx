import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { ExternalLink } from 'lucide-react';
import Drawer from '../Drawer';
import Pill from '../ui/Pill';
import { formatDateTime } from '../../utils/formatters';
import { getGitHubNotification } from '../../services/api';
import socket from '../../services/socket';
import { DECISION_VIEW, RULE_LABELS, SIGNAL_LABELS, TRUST_VIEW } from './githubTriageLabels';

const EVENT_LABELS = {
  triaged: 'Triaged',
  read: 'Marked read',
  done: 'Done',
  reopen: 'Back to inbox',
  mute: 'Muted',
  unsubscribe: 'Unsubscribed',
  resubscribe: 'Resubscribed',
};

function describeEvent(event) {
  const label = EVENT_LABELS[event.kind] || event.kind;
  if (event.kind !== 'triaged') return label;
  const decision = DECISION_VIEW[event.detail?.decision]?.label || 'Needs you';
  return `${label}: ${decision}${event.detail?.mode ? ` (${event.detail.mode})` : ''}`;
}

/** One thread's triage evidence and action log, opened from the Inbox at /devtools/github/inbox/:accountId/:threadId. */
export default function GitHubThreadDrawer({ accountId, threadId }) {
  const navigate = useNavigate();
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let active = true;
    getGitHubNotification(accountId, threadId, { silent: true })
      .then((result) => { if (active) { setDetail(result); setError(null); } })
      .catch((err) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [accountId, threadId, version]);

  useEffect(() => {
    const changed = (event) => { if (event?.accountId === accountId) setVersion((value) => value + 1); };
    socket.on('github:notifications:changed', changed);
    return () => socket.off('github:notifications:changed', changed);
  }, [accountId]);

  const close = () => navigate('/devtools/github/inbox');
  const current = detail && detail.accountId === accountId && detail.threadId === threadId ? detail : null;
  const decision = DECISION_VIEW[current?.decision];
  const trust = TRUST_VIEW[current?.trust];
  const evidence = current?.evidence || {};

  return (
    <Drawer open onClose={close} title="Notification" subtitle={current?.repoFullName}>
      {error && !current && <p role="alert" className="text-sm text-port-error">{error}</p>}
      {!error && !current && <p className="text-sm text-gray-400">Loading…</p>}
      {current && (
        <div className="space-y-4 text-sm">
          <section className="space-y-2">
            <p className="break-words text-white">{current.title}</p>
            <div className="flex flex-wrap gap-2">
              {decision ? <Pill tone={decision.tone}>{decision.label}</Pill> : <Pill tone="muted">{current.decision ? 'Needs you' : 'Not triaged yet'}</Pill>}
              {trust && <Pill tone={trust.tone}>{trust.label}</Pill>}
              {current.yourRepo && <Pill tone="accent">Your repo</Pill>}
            </div>
            {current.htmlUrl && (
              <a href={current.htmlUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-port-accent">
                <ExternalLink size={12} aria-hidden="true" /> Open on GitHub
              </a>
            )}
          </section>

          {current.decision && (
            <section className="space-y-1">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Why</h3>
              <p className="text-gray-300">{RULE_LABELS[evidence.rule] || evidence.rule}</p>
              {evidence.actor && <p className="text-xs text-gray-400">Actor <span className="font-mono">@{evidence.actor}</span></p>}
              {evidence.subjectState && <p className="text-xs text-gray-400">Thread is {evidence.subjectState}</p>}
              {evidence.foldedInto && <p className="text-xs text-gray-400">Same failure as a newer notice</p>}
              {evidence.metadataMissing && <p className="text-xs text-port-warning">GitHub did not return the thread's details; decided from the notification alone.</p>}
              {current.signals.length > 0 && (
                <ul className="list-disc space-y-0.5 pl-5 text-xs text-port-error">
                  {current.signals.map((signal) => <li key={signal}>{SIGNAL_LABELS[signal] || signal}</li>)}
                </ul>
              )}
            </section>
          )}

          <section className="space-y-1">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">History</h3>
            {current.events.length === 0 ? (
              <p className="text-xs text-gray-500">Nothing yet.</p>
            ) : (
              <ul className="space-y-1">
                {current.events.map((event, index) => (
                  <li key={`${event.at}-${index}`} className="flex flex-wrap justify-between gap-x-3 text-xs">
                    <span className="text-gray-300">{describeEvent(event)}{event.actor === 'automation' ? '' : ' by you'}</span>
                    <span className="text-gray-500">{formatDateTime(event.at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </Drawer>
  );
}
