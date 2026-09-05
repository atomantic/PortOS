import { useNavigate } from 'react-router';
import TabPills from './TabPills';

// Above this many tabs, a phone-width pill row is a horizontal scroll nobody
// finds the far end of. Six fits 375px; larger sections such as Models do not.
const MOBILE_DROPDOWN_THRESHOLD = 6;

const selectIdFor = (ariaLabel) => `${String(ariaLabel || 'section').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-select`;

/**
 * A `TabPills` bar whose tabs are ROUTES rather than local state.
 *
 * Several top-level sections are one page per tab, hosted at their own URLs, so
 * the "tab bar" is really a navigation control: selecting one navigates instead
 * of swapping state. That is what makes each tab deep-linkable and reachable
 * from ⌘K and voice — the URL is the source of truth for what is open
 * (`client/src/AGENTS.md`).
 *
 * Each section passes a `{ id, label, to }` tab list; section wrappers may
 * derive that list from the shared nav manifest. Sections may include a tab
 * whose `to` lives outside their route prefix (Models → Playground) — the id
 * still selects it, so the host page passes its own `activeTab`.
 *
 * Past `MOBILE_DROPDOWN_THRESHOLD` tabs the bar collapses to a `<select>` under
 * `sm`. That is decided HERE rather than per section: every caller has the same
 * phone width and the same pill sizes, so leaving it to each one meant Settings
 * (19 tabs) kept scrolling horizontally while Models (9) collapsed. The select's
 * id is derived from `ariaLabel` for the same reason — a caller that passed
 * `mobileDropdown` but forgot the id silently downgraded from a real
 * `<label htmlFor>` to a bare aria-label, and nothing failed.
 *
 * @param {{ tabs: Array<{id:string,label:string,to:string}>, activeTab: string, ariaLabel: string }} props
 */
export default function RouteTabsHeader({ tabs, activeTab, ariaLabel }) {
  const navigate = useNavigate();
  const mobileDropdown = tabs.length > MOBILE_DROPDOWN_THRESHOLD;

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
      mobileDropdown={mobileDropdown}
      mobileSelectId={mobileDropdown ? selectIdFor(ariaLabel) : undefined}
      className="w-full min-w-0 shrink-0"
    />
  );
}
