import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useScrollLock } from '../hooks/useScrollLock';
import TabPills from './ui/TabPills';

// Right-side slide-in panel for the "settings over a feature page" pattern.
// Mobile (<sm): full width. Desktop: a `size` bracket (see SIZE below). Backdrop
// click + Esc close it. Caller controls open state — typically driven by a URL
// search param so the view stays deep-linkable per the project convention.
// Long-lived forms (e.g. the app-edit drawer) can opt out of accidental
// dismissal via closeOnEsc / closeOnBackdrop so an Esc keystroke mid-edit
// doesn't discard the form.
//
// Large config surfaces should group their fields into `tabs` instead of one
// page-length scroll: pass `tabs={[{ id, label, icon?, count? }]}` plus
// `activeTab` / `onTabChange` (drive them from a URL param via `useDrawerTab`
// for deep-linkability) and render only the active tab's fields as `children`.
// The drawer then renders a sticky TabPills bar under the header (collapsing to
// a <select> on mobile) and gives each tab its own scroll region that resets on
// switch — so no single tab is ever page-length. Omit `tabs` and it stays the
// original flat-scroll drawer. `bodyClassName` opts a tab into a multi-column
// layout on wide sizes (e.g. `lg:grid lg:grid-cols-2 lg:gap-x-6`).

// Desktop width brackets. Mobile is always `w-full`. `lg`/`xl` intentionally use
// more of the viewport (via extra breakpoints) so wide config forms can lay out
// in columns instead of a cramped single column inside a wide panel.
const SIZE = {
  sm: 'sm:w-[520px]',
  md: 'sm:w-[640px]',
  lg: 'sm:w-[720px] lg:w-[880px]',
  xl: 'sm:w-[720px] lg:w-[960px] xl:w-[1100px]',
};

export default function Drawer({
  open,
  onClose,
  title,
  children,
  size = 'sm',
  widthClass,           // escape hatch: overrides `size` when provided (back-compat)
  tabs = null,          // [{ id, label, icon?, count? }] enables the tabbed layout
  activeTab,            // controlled active tab id (falls back to uncontrolled)
  onTabChange,          // (id) => void — required for the controlled form
  bodyClassName = '',   // extra classes on the scroll region (e.g. multi-column grid)
  closeOnEsc = true,
  closeOnBackdrop = true,
  closeLabel = 'Close settings',
}) {
  useScrollLock(open);

  const tabList = Array.isArray(tabs) ? tabs.filter(Boolean) : null;
  const hasTabs = !!(tabList && tabList.length);

  // Support both controlled (activeTab + onTabChange) and uncontrolled tabs, so a
  // caller that doesn't care about deep-linking still gets working tab switching.
  const [internalTab, setInternalTab] = useState(hasTabs ? tabList[0].id : undefined);
  const currentTab = hasTabs ? (activeTab ?? internalTab) : undefined;
  const changeTab = onTabChange || setInternalTab;

  useEffect(() => {
    if (!open || !closeOnEsc) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, closeOnEsc]);

  if (!open) return null;

  const resolvedWidth = widthClass || SIZE[size] || SIZE.sm;
  const bodyClasses = `flex-1 overflow-y-auto p-4 ${bodyClassName}`.trim();

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/60"
        onClick={closeOnBackdrop ? onClose : undefined}
        aria-hidden="true"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`fixed inset-y-0 right-0 z-50 w-full ${resolvedWidth} bg-port-card border-l border-port-border shadow-2xl flex flex-col`}
      >
        <header className="flex items-center justify-between px-4 py-3 border-b border-port-border">
          <h2 className="text-base font-medium text-white truncate min-w-0 pr-2">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-port-border/50 min-h-[44px] min-w-[44px] flex items-center justify-center shrink-0"
            aria-label={closeLabel}
          >
            <X className="w-5 h-5" />
          </button>
        </header>
        {hasTabs && (
          // Element ids below assume one drawer is open at a time — true by the
          // modal contract (backdrop + scroll-lock), and a closed drawer renders
          // nothing (`if (!open) return null`). Two drawers on one page use
          // distinct URL params (useDrawerTab) for their persisted tab state, but
          // never share the DOM open simultaneously, so the ids can't collide.
          <div className="px-4 pt-3 shrink-0 border-b border-port-border">
            <TabPills
              tabs={tabList}
              activeTab={currentTab}
              onChange={changeTab}
              mobileDropdown
              mobileSelectId="drawer-tab-select"
              ariaLabel={title ? `${title} sections` : 'Sections'}
              controlsIdPrefix="drawer-tabpanel"
            />
          </div>
        )}
        {/* One body element for both modes. When tabbed, `key={currentTab}`
            remounts the panel on switch so each tab's scroll resets — no single
            accumulated page-length scroll. */}
        <div
          key={hasTabs ? currentTab : undefined}
          {...(hasTabs && {
            id: `drawer-tabpanel-${currentTab}`,
            role: 'tabpanel',
            'aria-labelledby': `tab-${currentTab}`,
          })}
          className={bodyClasses}
        >
          {children}
        </div>
      </aside>
    </>
  );
}
