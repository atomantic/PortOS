import { useState, useEffect } from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import {
  Home,
  Package,
  FileText,
  Terminal,
  Bot,
  PlusCircle,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  Menu,
  History,
  Play,
  Activity,
  GitBranch,
  BarChart3,
  Cpu,
  Wrench,
  ExternalLink
} from 'lucide-react';
import packageJson from '../../package.json';
import Logo from './Logo';

const navItems = [
  { to: '/', label: 'Dashboard', icon: Home, single: true },
  { to: '/apps', label: 'Apps', icon: Package, single: true },
  { to: '/logs', label: 'Logs', icon: FileText, single: true },
  {
    label: 'Dev Tools',
    icon: Terminal,
    children: [
      { to: '/devtools/history', label: 'History', icon: History },
      { to: '/devtools/runner', label: 'Runner', icon: Play },
      { to: '/devtools/git', label: 'Git Status', icon: GitBranch },
      { to: '/devtools/usage', label: 'Usage', icon: BarChart3 },
      { to: '/devtools/processes', label: 'Processes', icon: Activity },
      { to: '/devtools/agents', label: 'AI Agents', icon: Cpu }
    ]
  },
  {
    label: 'AI Config',
    icon: Bot,
    children: [
      { to: '/ai', label: 'Providers', icon: Bot },
      { to: '/prompts', label: 'Prompts', icon: FileText }
    ]
  },
  { to: '/create', label: 'Add App', icon: PlusCircle, single: true },
  { href: '//:6000', label: 'Autofixer', icon: Wrench, external: true, dynamicHost: true }
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
            <Icon size={20} className="flex-shrink-0" />
            <span className={`whitespace-nowrap ${collapsed ? 'lg:hidden' : ''}`}>
              {item.label}
            </span>
          </div>
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
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`
          fixed lg:static inset-y-0 left-0 z-50
          flex flex-col bg-port-card border-r border-port-border
          transition-all duration-300 ease-in-out
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
          ${collapsed ? 'lg:w-16' : 'lg:w-56'}
          w-56
        `}
      >
        {/* Header with logo and collapse toggle */}
        <div className={`flex items-center justify-between p-4 border-b border-port-border`}>
          <div className={`flex items-center gap-2 ${collapsed ? 'lg:hidden' : ''}`}>
            <Logo size={24} className="text-port-accent" />
            <span className="text-port-accent font-semibold whitespace-nowrap">PortOS</span>
          </div>
          {collapsed && (
            <Logo size={24} className="hidden lg:block text-port-accent" />
          )}
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="hidden lg:flex p-1 text-gray-500 hover:text-white transition-colors"
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <ChevronLeft size={20} className={`transition-transform ${collapsed ? 'rotate-180' : ''}`} />
          </button>
          {/* Mobile close button */}
          <button
            onClick={() => setMobileOpen(false)}
            className="lg:hidden p-1 text-gray-500 hover:text-white"
          >
            ✕
          </button>
        </div>

        {/* Nav items */}
        <nav className="flex-1 py-4 overflow-y-auto">
          {navItems.map(renderNavItem)}
        </nav>

        {/* Footer with version */}
        <div className={`p-4 border-t border-port-border text-sm text-gray-500 ${collapsed ? 'lg:text-center' : ''}`}>
          {collapsed ? (
            <span className="hidden lg:block text-xs">v{packageJson.version.split('.')[0]}</span>
          ) : (
            <span>v{packageJson.version}</span>
          )}
          <span className={`lg:hidden`}>v{packageJson.version}</span>
        </div>
      </aside>

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile header */}
        <header className="lg:hidden flex items-center justify-between p-4 border-b border-port-border bg-port-card">
          <button
            onClick={() => setMobileOpen(true)}
            className="p-2 -ml-2 text-gray-400 hover:text-white"
          >
            <Menu size={24} />
          </button>
          <div className="flex items-center gap-2">
            <Logo size={24} className="text-port-accent" />
            <span className="font-bold text-port-accent">PortOS</span>
          </div>
          <div className="w-10" /> {/* Spacer for centering */}
        </header>

        {/* Main content */}
        <main className="flex-1 p-4 md:p-6 overflow-auto">
          <div className="max-w-7xl mx-auto">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
