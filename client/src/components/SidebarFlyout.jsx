import { useLayoutEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { NavLink, useLocation } from 'react-router';

export default function SidebarFlyout({ item, anchor, close, scheduleCloseFlyout, cancelCloseFlyout, isActive }) {
  const location = useLocation();
  const ref = useRef(null);
  const [top, setTop] = useState(anchor.top);
  useLayoutEffect(() => {
    const clamp = () => {
      const height = ref.current?.offsetHeight;
      if (height != null) setTop(Math.max(8, Math.min(anchor.top, window.innerHeight - height - 8)));
    };
    clamp();
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, [anchor, item]);
  const flyoutChildren = item.groups?.length
    ? item.groups.flatMap(group => [{ groupLabel: group.label }, ...group.children])
    : item.children;

  // A list of navigation links, not a command menu — so <nav> + <ul>/<li>,
  // NOT role="menu"/"menuitem": those roles promise arrow-key roving
  // focus between items that this flyout doesn't implement (#7265).
  // Native Tab order reaches every link.
  return (
    <nav
      ref={ref}
      aria-label={`${item.label} pages`}
      onMouseEnter={cancelCloseFlyout}
      onMouseLeave={scheduleCloseFlyout}
      onFocus={cancelCloseFlyout}
      onBlur={scheduleCloseFlyout}
      style={{ top, left: anchor.left, position: 'fixed', '--dvh-inset': '16px' }}
      className="hidden lg:block z-[60] min-w-[220px] max-w-[min(320px,calc(100vw-5rem))] max-h-dvh-cap overflow-y-auto bg-port-card border border-port-border rounded-lg shadow-2xl py-1"
    >
      <div className="px-3 py-1.5 text-[10px] uppercase text-gray-500 tracking-wider border-b border-port-border mb-1">
        {item.label}
      </div>
      <ul>
        {flyoutChildren.map((child, childIndex) => {
          if (child.groupLabel) {
            return (
              <li key={`flyout-group-${child.groupLabel}`} role="presentation">
                <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500" role="heading" aria-level="3">
                  {child.groupLabel}
                </div>
              </li>
            );
          }
          if (child.separator) {
            // Decorative rule, not an item — hidden so it doesn't pad the
            // list's "N items" count for screen readers.
            return <li key={`flyout-sep-${childIndex}`} aria-hidden="true" className="mx-3 my-1 border-t border-port-border" />;
          }
          const ChildIcon = child.icon;
          if (child.external) {
            const childHref = child.dynamicHost
              ? `${window.location.protocol}//${window.location.hostname}${child.href.replace('//', '')}`
              : child.href;
            return (
              <li key={`flyout-${child.href}`}>
                <a
                  href={childHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={close}
                  title={child.label}
                  className="flex items-center min-h-[44px] lg:min-h-0 pointer-coarse:min-h-11 justify-between gap-3 px-3 py-2 text-sm text-gray-300 hover:text-white hover:bg-port-border/50 min-w-0"
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <ChildIcon size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
                    <span className="min-w-0 break-words leading-snug">{child.label}</span>
                  </div>
                  <ExternalLink size={12} className="text-gray-500 shrink-0 mt-0.5" />
                </a>
              </li>
            );
          }
          const childActive = child.end
            ? location.pathname === child.to
            : isActive(child.to);
          return (
            <li key={`flyout-${child.to}`}>
              <NavLink
                to={child.to}
                end={child.end}
                onClick={close}
                title={child.label}
                className={`flex items-start gap-3 px-3 py-2 text-sm min-w-0 ${
                  childActive
                    ? 'bg-port-accent/10 text-port-accent'
                    : 'text-gray-300 hover:text-white hover:bg-port-border/50'
                }`}
              >
                <ChildIcon size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
                <span className="min-w-0 break-words leading-snug">{child.label}</span>
              </NavLink>
              {child.grandChildren && child.grandChildren.length > 0 && (
                <ul className="ml-7 my-0.5 border-l border-port-border/50 pl-2">
                  {child.grandChildren.map((gc) => {
                    const prefix = gc.activePathPrefix || gc.to;
                    const gcActive = location.pathname === prefix || location.pathname.startsWith(prefix + '/');
                    return (
                      <li key={`flyout-gc-${gc.to}`}>
                        <NavLink
                          to={gc.to}
                          onClick={close}
                          title={gc.title || gc.label}
                          className={`min-h-[44px] flex items-center lg:min-h-0 lg:block pointer-coarse:min-h-11 pointer-coarse:flex pointer-coarse:items-center px-2 py-1 rounded text-xs transition-colors min-w-0 break-words leading-snug ${
                            gcActive
                              ? 'text-port-accent font-medium'
                              : 'text-gray-400 hover:text-white hover:bg-port-border/30'
                          }`}
                        >
                          {gc.label}
                        </NavLink>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
