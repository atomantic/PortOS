import { useState } from 'react';
import { Globe } from 'lucide-react';
import { PUBLISH_TARGETS } from './PublishPostingPanel.jsx';

function historyLine(h) {
  if (!h?.posts) return 'No posts yet';
  const rated = ['good', 'mixed', 'poor'].filter((k) => h[k]).map((k) => `${h[k]} ${k}`);
  return `${h.posts} post${h.posts === 1 ? '' : 's'}${rated.length ? ` · ${rated.join(' · ')}` : ''}`;
}

function AccountInput({ id, label, initial, onSave, disabled }) {
  const [value, setValue] = useState(initial || '');
  return (
    <input id={id} value={value} disabled={disabled} aria-label={`${label} account`} placeholder="@handle (optional)"
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => { if (value.trim() !== (initial || '')) onSave(value.trim() || null); }}
      className="w-full sm:w-40 bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs min-h-[44px] sm:min-h-0 disabled:opacity-50" />
  );
}

/**
 * Where you post (#9287): every platform is opt-in. Turn on only the ones you
 * use; name the account you post as (a dedicated account for this content,
 * say) and a draft filled while signed in as someone else is refused where
 * the platform shows who is signed in. Each row shows how your posts there
 * were received, across every project, so you can learn what is worth it.
 */
export default function PublishPlatformsPanel({ publishing }) {
  const { platforms, history, setPlatform } = publishing;
  if (!platforms) return null;
  const enabledCount = Object.values(platforms).filter((p) => p?.enabled).length;
  return (
    <section aria-label="Where you post" className="rounded-lg border border-port-border bg-port-card p-3 space-y-2 text-xs">
      <h3 className="text-sm font-medium flex items-center gap-1.5"><Globe size={14} /> Where you post</h3>
      <p className="text-port-text-muted">
        {enabledCount ? 'Copy is drafted and posts are offered only for the platforms turned on here.' : 'No platforms yet. Turn on the ones you use; copy and posting cover only those.'}
      </p>
      <ul className="divide-y divide-port-border">
        {PUBLISH_TARGETS.map(({ target, label }) => {
          const p = platforms[target] || {};
          const h = history?.[target];
          const latest = h?.notes?.[0];
          return (
            <li key={target} className="py-1.5 flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 min-w-[9rem] min-h-[44px] sm:min-h-0">
                <input type="checkbox" checked={!!p.enabled} onChange={(e) => setPlatform(target, { enabled: e.target.checked })} />
                <span className="font-medium">{label}</span>
              </label>
              <AccountInput key={`${target}-${p.account || ''}`} id={`mv-platform-${target}-account`} label={label} initial={p.account}
                disabled={!p.enabled} onSave={(account) => setPlatform(target, { account })} />
              <div className="min-w-0 flex-1 text-[11px] text-port-text-muted">
                <span>{historyLine(h)}</span>
                {latest?.notes && <span className="block truncate" title={latest.notes}>Last note: {latest.notes}</span>}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
