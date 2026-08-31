// Shared tab-nav primitive. Three visual families: `underline` (default — flat
// bottom border with port-accent marker; used across page-level tabs),
// `pills` (rounded card with internal pill rows; used by UniverseBuilder), and
// `filter` (pills' markup, toggle-button semantics). `filter` exists because a
// faceted count chip row (Settings > AI Assignments) narrows rows in place
// rather than swapping panels: a tab promises a panel it never shows, so those
// chips are a `role="group"` of `aria-pressed` buttons — the same semantics the
// app's other toggle filters use — while sharing this component's styling.
// Knobs cover the call-site quirks: `runningKind` swaps a per-tab icon for a
// spinner; `stretch` makes each tab `flex-1` (StoryboardPanel); `mobileDropdown`
// collapses to a `<select>` below `sm` (UniverseBuilder), whose wrapper is
// `sm:hidden` unless `mobileSelectClassName` replaces it wholesale — a caller
// passes that to make the select a flex sibling sharing one row with other
// controls (`sm:hidden min-w-0 flex-1` in FableLoomStory's episode row), and the
// replacement must carry its own `sm:hidden` or the select shows on desktop;
// `controlsIdPrefix` wires `aria-controls` (and `id="tab-<id>"`) to matching tabpanels — pass
// `'tabpanel'` to mirror ChiefOfStaff's wiring. `t.trailing` is an optional
// ReactNode rendered after the count (e.g. PipelineIssue's per-stage status dot).
import { Loader2 } from 'lucide-react';

const SIZE = {
  xs: { text: 'text-[11px]', icon: 11, padding: 'px-2 py-2', gap: 'gap-1' },
  sm: { text: 'text-sm', icon: 14, padding: 'px-3 py-1.5', gap: 'gap-1.5' },
  md: { text: 'text-sm', icon: 16, padding: 'px-3 sm:px-4 py-3', gap: 'gap-2' },
};

export default function TabPills({
  tabs,
  activeTab,
  onChange,
  variant = 'underline',
  size = 'md',
  stretch = false,
  runningKind = null,
  mobileDropdown = false,
  mobileSelectId,
  mobileSelectClassName = '',
  ariaLabel,
  controlsIdPrefix,
  hideLabelOnMobile = false,
  className = '',
  listRef,
  onScroll,
}) {
  const sz = SIZE[size] || SIZE.md;
  const visibleTabs = tabs.filter(Boolean);

  // Mobile `<select>` collapse, shared by both variants so `mobileDropdown` works
  // regardless of `variant` (the underline tab bar just overflow-scrolls without it).
  const mobileSelect = mobileDropdown ? (
    <div className={mobileSelectClassName || 'sm:hidden'}>
      {mobileSelectId && <label htmlFor={mobileSelectId} className="sr-only">{ariaLabel || 'Section'}</label>}
      <select
        id={mobileSelectId}
        value={activeTab}
        onChange={(e) => onChange(e.target.value)}
        aria-label={mobileSelectId ? undefined : (ariaLabel || 'Section')}
        className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-port-accent min-h-[40px]"
      >
        {visibleTabs.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}{t.count != null && t.count > 0 ? ` (${t.count})` : ''}
          </option>
        ))}
      </select>
    </div>
  ) : null;

  if (variant === 'pills' || variant === 'filter') {
    const isFilter = variant === 'filter';
    return (
      <>
        {mobileSelect}
        <div
          ref={listRef}
          onScroll={onScroll}
          className={`${mobileDropdown ? 'hidden sm:flex' : 'flex'} shrink-0 items-center gap-1 bg-port-card border border-port-border rounded p-1 overflow-x-auto scrollbar-hide touch-pan-x ${className}`}
          role={isFilter ? 'group' : 'tablist'}
          aria-label={ariaLabel}
        >
          {visibleTabs.map((t) => {
            const Icon = t.icon;
            const active = t.id === activeTab;
            const running = runningKind && t.runningKind === runningKind;
            return (
              <button
                key={t.id}
                type="button"
                role={isFilter ? undefined : 'tab'}
                aria-selected={isFilter ? undefined : active}
                aria-pressed={isFilter ? active : undefined}
                aria-controls={!isFilter && controlsIdPrefix ? `${controlsIdPrefix}-${t.id}` : undefined}
                id={!isFilter && controlsIdPrefix ? `tab-${t.id}` : undefined}
                disabled={t.disabled}
                onClick={() => onChange(t.id)}
                className={`flex items-center ${sz.gap} ${sz.padding} rounded ${sz.text} transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-port-accent/20 text-port-accent border border-port-accent/40'
                    : 'text-gray-300 hover:bg-port-bg border border-transparent'
                } ${t.disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {running
                  ? <Loader2 size={sz.icon} className="animate-spin shrink-0" />
                  : (Icon && <Icon size={sz.icon} aria-hidden="true" />)}
                {t.label}
                {t.count != null && t.count > 0 && (
                  <span className={`text-[10px] ${active ? 'text-port-accent/70' : 'text-gray-500'}`}>
                    {t.count}
                  </span>
                )}
                {t.trailing}
              </button>
            );
          })}
        </div>
      </>
    );
  }

  // underline variant
  return (
    <>
      {mobileSelect}
      <div
        ref={listRef}
        onScroll={onScroll}
        className={`${mobileDropdown ? 'hidden sm:flex' : 'flex'} shrink-0 border-b border-port-border ${stretch ? 'items-stretch bg-port-bg/40' : 'gap-1'} overflow-x-auto scrollbar-hide touch-pan-x ${className}`}
        role="tablist"
        aria-label={ariaLabel}
      >
      {visibleTabs.map((t) => {
        const Icon = t.icon;
        const active = t.id === activeTab;
        const running = runningKind && t.runningKind === runningKind;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={controlsIdPrefix ? `${controlsIdPrefix}-${t.id}` : undefined}
            id={controlsIdPrefix ? `tab-${t.id}` : undefined}
            disabled={t.disabled}
            onClick={() => onChange(t.id)}
            title={hideLabelOnMobile ? t.label : undefined}
            className={`flex items-center ${stretch ? 'flex-1 min-w-0 justify-center' : 'shrink-0 justify-center'} ${sz.gap} ${sz.padding} ${sz.text} font-medium transition-colors whitespace-nowrap min-h-[44px] sm:min-h-[40px] border-b-2 -mb-px ${
              active
                ? 'text-port-accent border-port-accent bg-port-accent/5'
                : 'text-gray-400 border-transparent hover:text-white hover:bg-port-card'
            } ${t.disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            {running
              ? <Loader2 size={sz.icon} className="animate-spin shrink-0" />
              : (Icon && <Icon size={sz.icon} aria-hidden="true" className="shrink-0" />)}
            {t.label && (stretch ? (
              <span className="truncate">{t.label}</span>
            ) : hideLabelOnMobile ? (
              <>
                <span className="hidden sm:inline">{t.label}</span>
                <span className="sr-only sm:hidden">{t.label}</span>
              </>
            ) : (
              <span>{t.label}</span>
            ))}
            {t.count != null && t.count > 0 && (
              <span className={`text-[10px] ${active ? 'text-port-accent/70' : 'text-gray-500'}`}>
                {t.count}
              </span>
            )}
            {t.trailing}
          </button>
        );
      })}
      </div>
    </>
  );
}
