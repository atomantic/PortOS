// Quality-tab summary of an app's hand-written audit path priorities: counts per tier, expandable to the paths.
// Renders nothing for an app with no entries, so the tab is unchanged for apps that never set any.
const TIERS = [
  { tier: 'P0', hint: 'audited first' },
  { tier: 'P2', hint: 'real defects only' },
  { tier: 'P3', hint: 'left out of audits' },
];

export default function AppAuditScopeSummary({ featurePriorities }) {
  const entries = Array.isArray(featurePriorities)
    ? featurePriorities.filter((entry) => entry && typeof entry.label === 'string' && Array.isArray(entry.paths))
    : [];
  if (!entries.length) return null;
  const groups = TIERS
    .map(({ tier, hint }) => ({ tier, hint, items: entries.filter((entry) => entry.priority === tier) }))
    .filter((group) => group.items.length > 0);
  if (!groups.length) return null;
  return (
    <details className="bg-port-card border border-port-border rounded-lg p-4">
      <summary className="cursor-pointer text-sm font-medium text-white">
        Audit scope
        <span className="ml-2 text-xs font-normal text-gray-400">
          {groups.map(({ tier, items }) => `${tier} ${items.length}`).join(' · ')}
        </span>
      </summary>
      <div className="mt-3 space-y-3">
        {groups.map(({ tier, hint, items }) => (
          <section key={tier} aria-label={`${tier} audit paths`}>
            <h5 className="text-xs font-medium text-gray-300">{tier} <span className="font-normal text-gray-500">· {hint}</span></h5>
            <ul className="mt-1 space-y-1">
              {items.map((entry) => (
                <li key={entry.id ?? entry.label} className="text-xs text-gray-400 break-words">
                  <span className="text-gray-200">{entry.label}</span>: <code>{entry.paths.join(', ')}</code>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <p className="text-xs text-gray-500">Security, privacy and data-integrity audits still cover every path. Edit these in the app's Workflow settings.</p>
      </div>
    </details>
  );
}
