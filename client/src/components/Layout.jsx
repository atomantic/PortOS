import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router';
import { Menu, Mic, Search } from 'lucide-react';
import { safeReadStorage, safeWriteStorage } from '../lib/safeStorage';
import { useErrorNotifications } from './useErrorNotifications';
import { useAgentFeedbackToast } from './useAgentFeedbackToast';
import { useOnDemandTaskToast } from './useOnDemandTaskToast';
import { useSharingNotifications } from './useSharingNotifications';
import { useAIStatusNotifications } from './useAIStatusNotifications';
import { openCmdKSearch } from '../hooks/useCmdKSearch.js';
import ActionActivityBar from './ui/ActionActivityBar';
import CmdKSearchGate from './CmdKSearchGate';
import KeyboardHelpGate from './KeyboardHelpGate';
import Logo from './Logo';
import MaintenanceBanner from './MaintenanceBanner.jsx';
import { NotificationBell, NotificationBellProvider } from './NotificationBell.jsx';
import PasswordRiskWarning from './PasswordRiskWarning.jsx';
import SetupBanner from './SetupBanner';
import SidebarContext from './SidebarContext.jsx';
import SidebarNav from './SidebarNav.jsx';
import SocketReconnectingPill from './SocketReconnectingPill.jsx';
import ThemeModeToggle from './ThemeModeToggle.jsx';
import ThemeSwitcherGate from './ThemeSwitcherGate';
import UpdateBanners from './UpdateBanners';
import VoiceWidgetGate from './voice/VoiceWidgetGate';

const SIDEBAR_KEY = 'portos-sidebar-collapsed';

export default function Layout() {
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(() => safeReadStorage(SIDEBAR_KEY) === 'true');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [desktopNav, setDesktopNav] = useState(() => window.matchMedia('(min-width: 1024px)').matches);
  const menuButtonRef = useRef(null);
  const mobileNavActive = mobileOpen && !desktopNav;
  useEffect(() => {
    const media = window.matchMedia('(min-width: 1024px)');
    const syncViewport = () => {
      setDesktopNav(media.matches);
      if (media.matches) setMobileOpen(false);
    };
    syncViewport();
    media.addEventListener('change', syncViewport);
    return () => media.removeEventListener('change', syncViewport);
  }, []);
  const closeMobileNav = useCallback(() => setMobileOpen(false), []);
  useEffect(closeMobileNav, [location.pathname, closeMobileNav]);
  useEffect(() => { safeWriteStorage(SIDEBAR_KEY, String(collapsed)); }, [collapsed]);
  const sidebarCollapsed = collapsed && !mobileOpen;
  const sidebarContext = useMemo(() => ({ collapsed: sidebarCollapsed, desktop: desktopNav }), [sidebarCollapsed, desktopNav]);

  // Subscribe to server error notifications
  useErrorNotifications();
  // Toast when an auto-merge bucket overwrites a local record
  useSharingNotifications();

  // Subscribe to agent completion feedback toasts
  useAgentFeedbackToast();

  // Toast when a user-triggered on-demand task run found no actionable work
  useOnDemandTaskToast();

  // Live AI operation status (model loads, "calling LM Studio…", etc.)
  useAIStatusNotifications();

  return (
    <SidebarContext.Provider value={sidebarContext}>
      <div className="h-dvh-screen print:h-auto print:min-h-screen w-full max-w-full overflow-x-hidden bg-port-bg flex">
        {/* Owns the voice config for the toggle buttons below and appends the
            push-to-talk widget after its children, loading that chunk only once
            voice is enabled. */}
        <VoiceWidgetGate>
          <NotificationBellProvider>
            {/* Skip to main content link for keyboard users */}
            <a
              href="#main-content"
              onClick={() => document.getElementById('main-content')?.focus()}
              className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-[100] focus:px-4 focus:py-2 focus:bg-port-accent focus:text-white focus:rounded-lg focus:outline-hidden"
            >
              Skip to main content
            </a>
            {/* Pointer-only scrim: the drawer's own button and Esc are the accessible dismissals. */}
            {mobileNavActive && (
              <div
                aria-hidden="true"
                data-testid="mobile-nav-scrim"
                className="fixed inset-0 bg-black/50 z-40 lg:hidden"
                onClick={closeMobileNav}
              />
            )}

            <SidebarNav
              collapsed={collapsed}
              setCollapsed={setCollapsed}
              mobileOpen={mobileOpen}
              closeMobileNav={closeMobileNav}
              desktopNav={desktopNav}
            />

            {/* Main area — print drops the sidebar offset so printed pages aren't shifted right */}
            <div
              inert={mobileNavActive}
              aria-hidden={mobileNavActive || undefined}
              className={`flex-1 flex flex-col min-w-0 max-w-full transition-all duration-300 print:ml-0 ${collapsed ? 'lg:ml-16' : 'lg:ml-64'}`}
            >
              {/* Mobile header */}
              <header className="port-app-topbar lg:hidden flex items-center justify-between px-2 py-1.5 border-b border-port-border bg-port-card print:hidden">
                <button
                  ref={menuButtonRef}
                  onClick={() => {
                    menuButtonRef.current?.focus();
                    setMobileOpen(true);
                  }}
                  className="inline-flex items-center justify-center min-w-[44px] min-h-[44px] -ml-1 rounded-lg text-gray-400 hover:text-white"
                  aria-label="Open navigation menu"
                  aria-expanded={mobileNavActive}
                  aria-controls="app-sidebar"
                >
                  <Menu size={20} aria-hidden="true" />
                </button>
                <div className="flex items-center gap-1.5">
                  <Logo size={22} className="shrink-0" />
                  <span className="sr-only min-[370px]:not-sr-only font-bold text-sm text-port-accent">PortOS</span>
                </div>
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={openCmdKSearch}
                    className="inline-flex items-center justify-center min-w-[44px] min-h-[44px] rounded-lg transition-colors text-gray-500 hover:text-white"
                    title="Search"
                    aria-label="Open command palette"
                  >
                    <Search size={18} />
                  </button>
                  <ThemeModeToggle />
                  <ThemeSwitcherGate position="below" />
                  <Link
                    to="/voice/call"
                    aria-label="Open Voice Call"
                    title="Voice Call"
                    className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg text-port-text-muted hover:text-port-accent"
                  >
                    <Mic size={18} aria-hidden="true" />
                  </Link>
                  <NotificationBell position="below" />
                </div>
              </header>

              {/* Update, out-of-sync, and essential-setup advisories — inline (document flow) so they
                  push the page instead of covering a bottom-anchored composer (#3786) */}
              <UpdateBanners />
              <SetupBanner />
              <PasswordRiskWarning />
              <MaintenanceBanner />

              {/* Main content — the matched route's shell (components/PageShell.jsx)
                  renders <main>, so the shell is declared where the route is. */}
              <Outlet />
            </div>
            {/* Cmd+K search overlay — thin hotkey gate loads CmdKSearch on first trigger */}
            <ActionActivityBar />
            <CmdKSearchGate />
            {/* Keyboard shortcuts help — thin hotkey gate loads KeyboardHelp on first `?` */}
            <KeyboardHelpGate />
            {/* The one shared "your live views are frozen" signal — see #12027 */}
            <SocketReconnectingPill />
          </NotificationBellProvider>
        </VoiceWidgetGate>
      </div>
    </SidebarContext.Provider>
  );
}
