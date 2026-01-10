import { useState, useEffect } from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import {
  Home,
  Package,
  FileText,
  Terminal,
  Bot,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  Menu,
  History,
  Code2,
  Activity,
  GitBranch,
  BarChart3,
  Cpu,
  Wrench,
  ExternalLink,
  Crown,
  Play,
  Camera
} from 'lucide-react';
import packageJson from '../../package.json';
import Logo from './Logo';
import { useErrorNotifications } from '../hooks/useErrorNotifications';
import { useNotifications } from '../hooks/useNotifications';
import NotificationDropdown from './NotificationDropdown';

const navItems = [
  { to: '/', label: 'Dashboard', icon: Home, single: true },
  {
    label: 'AI Config',
    icon: Bot,
    children: [
      { to: '/prompts', label: 'Prompts', icon: FileText },
      { to: '/ai', label: 'Providers', icon: Bot }
    ]
  },
  { to: '/apps', label: 'Apps', icon: Package, single: true },
  { to: '/media', label: 'Media', icon: Camera, single: true },
  { href: '//:5560', label: 'Autofixer', icon: Wrench, external: true, dynamicHost: true },
  { to: '/cos', label: 'Chief of Staff', icon: Crown, single: true, showBadge: true },
  {
    label: 'Dev Tools',
    icon: Terminal,
    children: [
      { to: '/devtools/agents', label: 'AI Agents', icon: Cpu },
      { to: '/devtools/runs', label: 'AI Runs', icon: Play },
      { to: '/devtools/runner', label: 'Code', icon: Code2 },
      { to: '/devtools/git', label: 'Git Status', icon: GitBranch },
      { to: '/devtools/history', label: 'History', icon: History },
      { to: '/devtools/processes', label: 'Processes', icon: Activity },
      { to: '/devtools/usage', label: 'Usage', icon: BarChart3 }
    ]
  }
];

const SIDEBAR_KEY = 'portos-sidebar-collapsed';

export default function Layout() {
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_KEY);
    return saved === 'true';
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [expandedSections, setExpandedSections] = useState({});

  // Subscribe to server error notifications
  useErrorNotifications();

  // Notifications for user task alerts
  const {
    notifications,
    unreadCount,
    markAsRead,
    markAllAsRead,
    removeNotification,
    clearAll
  } = useNotifications();

  useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, String(collapsed));
  }, [collapsed]);

  // Auto-expand sections when on a child page
  useEffect(() => {
    navItems.forEach(item => {
      if (item.children) {
        const isChildActive = item.children.some(child =>
          location.pathname === child.to || location.pathname.startsWith(child.to + '/')
        );
        if (isChildActive) {
          setExpandedSections(prev => ({ ...prev, [item.label]: true }));
        }
      }
    });
  }, [location.pathname]);

  // Close mobile menu on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  const toggleSection = (label) => {
    setExpandedSections(prev => ({
      ...prev,
      [label]: !prev[label]
    }));
  };

  const isActive = (path) => {
    if (path === '/') return location.pathname === '/';
    return location.pathname === path || location.pathname.startsWith(path + '/');
  };

  const isSectionActive = (item) => {
    if (item.single && item.to) {
      return isActive(item.to);
    }
    if (item.children) {
      return item.children.some(child => isActive(child.to));
    }
    return false;
  };

  const renderNavItem = (item) => {
    const Icon = item.icon;

    // External link
    if (item.external) {
      // Build href - use current hostname for dynamic host links
      const href = item.dynamicHost
        ? `${window.location.protocol}//${window.location.hostname}${item.href.replace('//', '')}`
        : item.href;

      return (
        <a
          key={item.href}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className={`flex items-center gap-3 mx-2 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
            collapsed ? 'lg:justify-center lg:px-2' : 'justify-between'
          } text-gray-400 hover:text-white hover:bg-port-border/50`}
          title={collapsed ? item.label : undefined}
        >
          <div className="flex items-center gap-3">
            <Icon size={20} className="flex-shrink-0" />
            <span className={`whitespace-nowrap ${collapsed ? 'lg:hidden' : ''}`}>
              {item.label}
            </span>
          </div>
          {!collapsed && <ExternalLink size={14} className="text-gray-500" />}
        </a>
      );
    }

    if (item.single) {
      return (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/'}
          onClick={() => setMobileOpen(false)}
          className={`flex items-center gap-3 mx-2 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
            collapsed ? 'lg:justify-center lg:px-2' : 'justify-between'
          } ${
            isActive(item.to)
              ? 'bg-port-accent/10 text-port-accent'
              : 'text-gray-400 hover:text-white hover:bg-port-border/50'
          }`}
          title={collapsed ? item.label : undefined}
        >
          <div className="flex items-center gap-3">
            <div className="relative">
              <Icon size={20} className="flex-shrink-0" />
              {/* Badge for collapsed state */}
              {item.showBadge && unreadCount > 0 && collapsed && (
                <span className="absolute -top-1.5 -right-1.5 min-w-[14px] h-[14px] flex items-center justify-center text-[9px] font-bold rounded-full bg-yellow-500 text-black px-0.5">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </div>
            <span className={`whitespace-nowrap ${collapsed ? 'lg:hidden' : ''}`}>
              {item.label}
            </span>
          </div>
          {/* Badge for expanded state */}
          {item.showBadge && unreadCount > 0 && !collapsed && (
            <span className="min-w-[18px] h-[18px] flex items-center justify-center text-[10px] font-bold rounded-full bg-yellow-500 text-black px-1">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </NavLink>
      );
    }

    // Collapsible section
    return (
      <div key={item.label} className="mx-2">
        <button
          onClick={() => {
            if (collapsed) {
              // When collapsed, navigate to first child
              if (item.children && item.children.length > 0) {
                window.location.href = item.children[0].to;
              }
            } else {
              toggleSection(item.label);
            }
          }}
          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
            collapsed ? 'lg:justify-center lg:px-2' : 'justify-between'
          } ${
            isSectionActive(item)
              ? 'bg-port-accent/10 text-port-accent'
              : 'text-gray-400 hover:text-white hover:bg-port-border/50'
          }`}
          title={collapsed ? item.label : undefined}
        >
          <div className="flex items-center gap-3">
            <Icon size={20} className="flex-shrink-0" />
            <span className={`whitespace-nowrap ${collapsed ? 'lg:hidden' : ''}`}>
              {item.label}
            </span>
          </div>
          {!collapsed && (
            expandedSections[item.label]
              ? <ChevronDown size={16} />
              : <ChevronRight size={16} />
          )}
        </button>

        {/* Children items */}
        {expandedSections[item.label] && !collapsed && (
          <div className="ml-4 mt-1">
            {item.children.map((child) => {
              const ChildIcon = child.icon;
              return (
                <NavLink
                  key={child.to}
                  to={child.to}
                  onClick={() => setMobileOpen(false)}
                  className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                    isActive(child.to)
                      ? 'bg-port-accent/10 text-port-accent'
                      : 'text-gray-500 hover:text-white hover:bg-port-border/50'
                  }`}
                >
                  <ChildIcon size={16} />
                  <span>{child.label}</span>
                </NavLink>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-port-bg flex">
      {/* Skip to main content link for keyboard users */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-[100] focus:px-4 focus:py-2 focus:bg-port-accent focus:text-white focus:rounded-lg focus:outline-none"
      >
        Skip to main content
      </a>
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          role="button"
          tabIndex={0}
          aria-label="Close sidebar"
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setMobileOpen(false)}
          onKeyDown={(e) => e.key === 'Escape' && setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`
          fixed inset-y-0 left-0 z-50 h-screen
          flex flex-col bg-port-card border-r border-port-border
          transition-all duration-300 ease-in-out
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
          ${collapsed ? 'lg:w-16' : 'lg:w-56'}
          w-56
        `}
      >
        {/* Header with logo and collapse toggle */}
        <div className={`flex items-center p-4 border-b border-port-border ${collapsed ? 'lg:justify-center' : 'justify-between'}`}>
          {/* Expanded: logo + text */}
          <div className={`flex items-center gap-2 ${collapsed ? 'lg:hidden' : ''}`}>
            <Logo size={24} className="text-port-accent" />
            <span className="text-port-accent font-semibold whitespace-nowrap">PortOS</span>
          </div>
          {/* Collapsed: just logo, clickable to expand */}
          {collapsed && (
            <button
              onClick={() => setCollapsed(false)}
              className="hidden lg:block text-port-accent hover:text-port-accent/80 transition-colors"
              title="Expand sidebar"
              aria-label="Expand sidebar"
            >
              <Logo size={24} ariaLabel="PortOS logo - click to expand sidebar" />
            </button>
          )}
          {/* Expanded: collapse button */}
          {!collapsed && (
            <button
              onClick={() => setCollapsed(true)}
              className="hidden lg:flex p-1 text-gray-500 hover:text-white transition-colors"
              title="Collapse sidebar"
              aria-label="Collapse sidebar"
            >
              <ChevronLeft size={20} aria-hidden="true" />
            </button>
          )}
          {/* Mobile close button */}
          <button
            onClick={() => setMobileOpen(false)}
            className="lg:hidden p-1 text-gray-500 hover:text-white"
            aria-label="Close sidebar"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>

        {/* Nav items */}
        <nav className="flex-1 py-4 overflow-y-auto">
          {navItems.map(renderNavItem)}
        </nav>

        {/* Footer with version and notifications */}
        <div className={`p-4 border-t border-port-border ${collapsed ? 'lg:flex lg:justify-center' : ''}`}>
          <div className={`flex items-center ${collapsed ? 'lg:justify-center' : 'justify-between'}`}>
            <span className={`text-sm text-gray-500 ${collapsed ? 'lg:hidden' : ''}`}>
              v{packageJson.version}
            </span>
            <div className={collapsed ? '' : ''}>
              <NotificationDropdown
                notifications={notifications}
                unreadCount={unreadCount}
                onMarkAsRead={markAsRead}
                onMarkAllAsRead={markAllAsRead}
                onRemove={removeNotification}
                onClearAll={clearAll}
              />
            </div>
          </div>
        </div>
      </aside>

      {/* Main area */}
      <div className={`flex-1 flex flex-col min-w-0 transition-all duration-300 ${collapsed ? 'lg:ml-16' : 'lg:ml-56'}`}>
        {/* Mobile header */}
        <header className="lg:hidden flex items-center justify-between px-3 py-2 border-b border-port-border bg-port-card">
          <button
            onClick={() => setMobileOpen(true)}
            className="p-1.5 -ml-1 text-gray-400 hover:text-white"
            aria-label="Open navigation menu"
            aria-expanded={mobileOpen}
          >
            <Menu size={20} aria-hidden="true" />
          </button>
          <div className="flex items-center gap-1.5">
            <Logo size={18} className="text-port-accent" />
            <span className="font-bold text-sm text-port-accent">PortOS</span>
          </div>
          <NotificationDropdown
            notifications={notifications}
            unreadCount={unreadCount}
            onMarkAsRead={markAsRead}
            onMarkAllAsRead={markAllAsRead}
            onRemove={removeNotification}
            onClearAll={clearAll}
            position="top"
          />
        </header>

        {/* Main content */}
        <main id="main-content" className={`flex-1 overflow-auto ${location.pathname.startsWith('/cos') ? '' : 'p-4 md:p-6'}`}>
          {location.pathname.startsWith('/cos') ? (
            <Outlet />
          ) : (
            <div className="max-w-7xl mx-auto">
              <Outlet />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
