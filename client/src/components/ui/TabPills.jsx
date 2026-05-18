// Shared tab-nav primitive. Two visual families: `underline` (default — flat
// bottom border with port-accent marker; used across page-level tabs) and
// `pills` (rounded card with internal pill rows; used by UniverseBuilder).
// Knobs cover the call-site quirks: `runningKind` swaps a per-tab icon for a
// spinner; `stretch` makes each tab `flex-1` (StoryboardPanel); `mobileDropdown`
// collapses to a `<select>` below `sm` (UniverseBuilder); `controlsIdPrefix`
// wires `aria-controls` (and `id="tab-<id>"`) to matching tabpanels — pass
// `'tabpanel'` to mirror ChiefOfStaff's wiring.
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
  ariaLabel,
  controlsIdPrefix,
  hideLabelOnMobile = false,
  className = '',
  listRef,
  onScroll,
}) {
  const sz = SIZE[size] || SIZE.md;
  const visibleTabs = tabs.filter(Boolean);

  if (variant === 'pills') {
    return (
      <>
        {mobileDropdown && (
          <div className="sm:hidden">
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
        )}
        <div
          ref={listRef}
          onScroll={onScroll}
          className={`${mobileDropdown ? 'hidden sm:flex' : 'flex'} items-center gap-1 bg-port-card border border-port-border rounded p-1 overflow-x-auto ${className}`}
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
              </button>
            );
          })}
        </div>
      </>
    );
  }

  // underline variant
  return (
    <div
      ref={listRef}
      onScroll={onScroll}
      className={`flex border-b border-port-border ${stretch ? 'items-stretch bg-port-bg/40 shrink-0' : 'gap-1'} overflow-x-auto scrollbar-hide ${className}`}
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
          </button>
        );
      })}
    </div>
  );
}
