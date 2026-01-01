import { useState, useEffect } from 'react';
import { Outlet, NavLink } from 'react-router-dom';

const navItems = [
  { to: '/', label: 'Dashboard', icon: '🏠' },
  { to: '/apps', label: 'Apps', icon: '📦' },
  { to: '/logs', label: 'Logs', icon: '📋' },
  { to: '/devtools', label: 'Dev Tools', icon: '🛠️' },
  { to: '/ai', label: 'AI Providers', icon: '🤖' },
  { to: '/create', label: 'Create App', icon: '➕' }
];

const SIDEBAR_KEY = 'portos-sidebar-collapsed';

export default function Layout() {
  const [collapsed, setCollapsed] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_KEY);
    return saved === 'true';
  });
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, String(collapsed));
  }, [collapsed]);

  // Close mobile menu on route change
  useEffect(() => {
    setMobileOpen(false);
  }, []);

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
        {/* Logo */}
        <div className={`flex items-center gap-3 p-4 border-b border-port-border ${collapsed ? 'lg:justify-center' : ''}`}>
          <span className="text-2xl flex-shrink-0">🚀</span>
          <h1 className={`text-lg font-bold text-white whitespace-nowrap transition-opacity ${collapsed ? 'lg:hidden' : ''}`}>
            Port OS
          </h1>
        </div>

        {/* Nav items */}
        <nav className="flex-1 py-4 overflow-y-auto">
          {navItems.map(({ to, label, icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              onClick={() => setMobileOpen(false)}
              className={({ isActive }) =>
                `flex items-center gap-3 mx-2 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors
                ${collapsed ? 'lg:justify-center lg:px-2' : ''}
                ${isActive
                  ? 'bg-port-accent text-white'
                  : 'text-gray-400 hover:text-white hover:bg-port-border'
                }`
              }
              title={collapsed ? label : undefined}
            >
              <span className="text-lg flex-shrink-0">{icon}</span>
              <span className={`whitespace-nowrap transition-opacity ${collapsed ? 'lg:hidden' : ''}`}>
                {label}
              </span>
            </NavLink>
          ))}
        </nav>

        {/* Collapse toggle - desktop only */}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="hidden lg:flex items-center justify-center p-4 border-t border-port-border text-gray-500 hover:text-white hover:bg-port-border transition-colors"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <svg
            className={`w-5 h-5 transition-transform ${collapsed ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
          </svg>
        </button>
      </aside>

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile header */}
        <header className="lg:hidden flex items-center justify-between p-4 border-b border-port-border bg-port-card">
          <button
            onClick={() => setMobileOpen(true)}
            className="p-2 -ml-2 text-gray-400 hover:text-white"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div className="flex items-center gap-2">
            <span className="text-xl">🚀</span>
            <span className="font-bold text-white">Port OS</span>
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
