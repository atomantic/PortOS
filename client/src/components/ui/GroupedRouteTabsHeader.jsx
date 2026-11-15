import { useNavigate } from 'react-router';
import TabPills from './TabPills';

const selectIdFor = (ariaLabel) => `${String(ariaLabel || 'section').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-select`;

/**
 * Route tabs split into labeled groups (the manifest's `navGroup`).
 *
 * Desktop renders one labeled pill row per group; below `sm` the same
 * destinations collapse into one `<select>` with an `<optgroup>` per group, so
 * a long section never becomes a horizontally scrolled strip on a phone.
 * `groups` is `[{ label, tabs: [{ id, label, to, icon }] }]`; empty groups are
 * the caller's to drop (a feature-gated tab can empty one).
 */
export default function GroupedRouteTabsHeader({ groups, activeTab, ariaLabel }) {
  const navigate = useNavigate();
  const goTo = (tabId) => {
    const target = groups.flatMap((group) => group.tabs).find((tab) => tab.id === tabId);
    if (target) navigate(target.to);
  };
  const selectId = selectIdFor(ariaLabel);

  return (
    <nav aria-label={ariaLabel} className="w-full min-w-0 shrink-0">
      <div className="sm:hidden">
        <label htmlFor={selectId} className="sr-only">{ariaLabel}</label>
        <select
          id={selectId}
          value={activeTab}
          onChange={(e) => goTo(e.target.value)}
          className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-port-accent min-h-[44px]"
        >
          {groups.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.tabs.map((tab) => <option key={tab.id} value={tab.id}>{tab.label}</option>)}
            </optgroup>
          ))}
        </select>
      </div>
      <div className="hidden sm:flex flex-wrap items-start gap-x-4 gap-y-2 border-b border-port-border pb-2">
        {groups.map((group) => (
          <div key={group.label} className="min-w-0">
            <div className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-gray-500">{group.label}</div>
            <TabPills
              tabs={group.tabs}
              activeTab={activeTab}
              onChange={goTo}
              variant="pills"
              size="sm"
              ariaLabel={`${group.label} ${ariaLabel}`}
            />
          </div>
        ))}
      </div>
    </nav>
  );
}
