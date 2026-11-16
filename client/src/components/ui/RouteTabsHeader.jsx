import { useNavigate } from 'react-router';
import TabPills from './TabPills';

// Above this many tabs, the bar collapses to TabPills' compact treatment. Six
// labelled tabs do not reliably fit 375px, so below this count the header's
// own scroller (TabPills overflow-x-auto with edge chevrons) is the safety net
// for a phone-width row.
const MOBILE_COMPACT_THRESHOLD = 6;

const selectIdFor = (ariaLabel) => `${String(ariaLabel || 'section').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-select`;

/**
 * A `TabPills` bar whose tabs are ROUTES rather than local state: each tab is deep-linkable and reachable from ⌘K and voice because selecting one navigates instead of swapping state (the URL is the source of truth; `client/src/AGENTS.md`).
 * Each section passes a `{ id, label, to }` tab list (wrappers may derive it from the shared nav manifest); a tab whose `to` lives outside the route prefix (Models → Playground) is still selected by id, so the host passes its own `activeTab`.
 * Past `MOBILE_COMPACT_THRESHOLD` tabs the bar collapses under `sm`, to an icon-only row or a `<select>` when tabs have no icons. Decided HERE, not per section (every caller has the same phone width and pill sizes; leaving it to each left Settings' 19 tabs scrolling while Models' 9 collapsed). The select's id is derived from `ariaLabel` because a caller that passed the flag but forgot the id silently downgraded from a real `<label htmlFor>` to a bare aria-label.
 * @param {{ tabs: Array<{id:string,label:string,to:string}>, activeTab: string, ariaLabel: string }} props
 */
export default function RouteTabsHeader({ tabs, activeTab, ariaLabel }) {
  const navigate = useNavigate();
  const mobileCompact = tabs.length > MOBILE_COMPACT_THRESHOLD;

  const handleChange = (tabId) => {
    const target = tabs.find((t) => t.id === tabId);
    if (target) navigate(target.to);
  };

  return (
    <TabPills
      tabs={tabs}
      activeTab={activeTab}
      onChange={handleChange}
      ariaLabel={ariaLabel}
      mobileCompact={mobileCompact}
      mobileSelectId={selectIdFor(ariaLabel)}
      className="w-full min-w-0 shrink-0"
    />
  );
}
