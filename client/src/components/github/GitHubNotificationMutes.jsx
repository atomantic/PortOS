import { useState } from 'react';
import { setGitHubNotificationMute } from '../../services/apiGithub.js';
import { REASON_LABELS } from './githubTriageLabels';

export default function GitHubNotificationMutes({ mutes, onChanged }) {
  const [pending, setPending] = useState(null);
  const unmute = async (mute, key) => {
    setPending(key);
    try {
      const result = await setGitHubNotificationMute({ ...mute, muted: false }).catch(() => null);
      if (result) await onChanged();
    } finally {
      setPending(null);
    }
  };
  return (
    <details className="rounded-lg border border-port-border bg-port-card p-2.5 text-xs text-gray-300">
      <summary className="cursor-pointer">Muted notification types ({mutes.length})</summary>
      <p className="mt-2 text-gray-400">Muted types are hidden from Inbox and Actions. They are still in All. GitHub subscriptions and automation rules are unchanged.</p>
      <ul className="mt-2 space-y-1">
        {mutes.map((mute) => {
          const key = `${mute.accountId}:${mute.repoFullName}:${mute.reason}`;
          const label = `${REASON_LABELS[mute.reason] || mute.reason} for ${mute.repoFullName} (${mute.accountLabel})`;
          return (
            <li key={key} className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 break-words">{label}</span>
              <button
                type="button"
                aria-label={`Unmute ${label}`}
                className="min-h-9 rounded-lg border border-port-border px-2 disabled:opacity-60"
                disabled={pending !== null}
                onClick={() => unmute(mute, key)}
              >
                {pending === key ? 'Unmuting…' : 'Unmute'}
              </button>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
