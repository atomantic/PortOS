import { useState, useEffect, useMemo } from 'react';
import { Outlet, NavLink, useLocation, useNavigate } from 'react-router-dom';
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
  BarChart3,
  Cpu,
  Wrench,
  ExternalLink,
  Crown,
  Play,
  Camera,
  Brain,
  Heart,
  Fingerprint,
  CheckCircle,
  Dna,
  Download,
  MessageSquare,
  Palette,
  PenLine,
  Sparkles,
  Target,
  Clock,
  Calendar,
  CalendarDays,
  GraduationCap,
  Settings,
  Users,
  Upload,
  SquareTerminal,
  Globe,
  Newspaper,
  Building2,
  Ticket,
  Network,
  Flame,
  Monitor,
  Cigarette,
  Skull,
  HeartPulse,
  ClipboardList,
  Compass,
  Scale,
  LayoutDashboard,
  Lightbulb,
  GitBranch,
  Github,
  Link2,
  Database,
  Shield,
  Wand2,
  Zap,
  Mail,
  Inbox,
  RefreshCw,
  Dog,
  FilePen,
  MessageCircle,
  Swords,
  Image as ImageIcon,
  HardDrive,
  MessagesSquare,
  BookOpen,
  Search,
  Mic,
  Clapperboard
} from 'lucide-react';
/* global __APP_VERSION__ */
import Logo from './Logo';
import { useErrorNotifications } from '../hooks/useErrorNotifications';
import { useNotifications } from '../hooks/useNotifications';
import { useAgentFeedbackToast } from '../hooks/useAgentFeedbackToast';
import { useUpdateChecker } from '../hooks/useUpdateChecker';
import NotificationDropdown from './NotificationDropdown';
import ThemeSwitcher from './ThemeSwitcher';
import CmdKSearch from './CmdKSearch';
import KeyboardHelp from './KeyboardHelp';
import VoiceWidget from './voice/VoiceWidget';
import * as api from '../services/api';
import socket from '../services/socket';

const navItems = [
  { to: '/', label: 'Dashboard', icon: Home, single: true },
  { to: '/review', label: 'Review Hub', icon: ClipboardList, single: true },
  { to: '/city', label: 'CyberCity', icon: Building2, single: true },
  { separator: true },
  { label: 'Apps', icon: Package, dynamic: 'apps', children: [] },
  {
    label: 'Brain',
    icon: Brain,
    children: [
      { to: '/brain/config', label: 'Config', icon: Settings },
      { to: '/brain/daily-log', label: 'Daily Log', icon: BookOpen },
      { to: '/brain/digest', label: 'Digest', icon: Calendar },
      { to: '/brain/graph', label: 'Graph', icon: Network },
      { to: '/brain/inbox', label: 'Inbox', icon: MessageSquare },
      { to: '/brain/links', label: 'Links', icon: Link2 },
      { to: '/brain/memory', label: 'Memory', icon: Database },
      { to: '/brain/notes', label: 'Notes', icon: FileText },
      { to: '/brain/trust', label: 'Trust', icon: Shield }
    ]
  },
  {
    label: 'Calendar',
    icon: CalendarDays,
    children: [
      { to: '/calendar/agenda', label: 'Agenda', icon: CalendarDays },
      { to: '/calendar/config', label: 'Config', icon: Settings },
      { to: '/calendar/day', label: 'Day', icon: Calendar },
      { to: '/calendar/lifetime', label: 'Lifetime', icon: Clock },
      { to: '/calendar/month', label: 'Month', icon: CalendarDays },
      { to: '/calendar/review', label: 'Review', icon: ClipboardList },
      { to: '/calendar/sync', label: 'Sync', icon: RefreshCw },
      { to: '/calendar/week', label: 'Week', icon: CalendarDays }
    ]
  },
  { to: '/character', label: 'Character', icon: Swords, single: true },
  {
    label: 'Chief of Staff',
    icon: Crown,
    showBadge: true,
    children: [
      { to: '/cos/agents', label: 'Agents', icon: Cpu },
      { to: '/cos/briefing', label: 'Briefing', icon: Newspaper },
      { to: '/cos/config', label: 'Config', icon: Settings },
      { to: '/cos/digest', label: 'Digest', icon: Calendar },
      { to: '/cos/gsd', label: 'GSD', icon: Compass },
      { to: '/cos/health', label: 'Health', icon: Activity },
      { to: '/cos/learning', label: 'Learning', icon: GraduationCap },
      { to: '/loops', label: 'Loops', icon: RefreshCw },
      { to: '/cos/memory', label: 'Memory', icon: Brain },
      { to: '/cos/schedule', label: 'Schedule', icon: Clock },
      { to: '/cos/scripts', label: 'Scripts', icon: Terminal },
      { to: '/cos/stage', label: 'Stage', icon: Clapperboard },
      { to: '/cos/productivity', label: 'Streaks', icon: Flame },
      { to: '/cos/jobs', label: 'System Tasks', icon: Bot },
      { to: '/cos/tasks', label: 'Tasks', icon: FileText }
    ]
  },
  {
    label: 'Dev Tools',
    icon: Terminal,
    children: [
      { to: '/devtools/agents', label: 'AI Agents', icon: Cpu },
      { to: '/devtools/runs', label: 'AI Runs', icon: Play },
      { href: '//:5560', label: 'Autofixer', icon: Wrench, external: true, dynamicHost: true },
      { to: '/browser', label: 'Browser', icon: Globe },
      { to: '/devtools/runner', label: 'Code', icon: Code2 },
      { to: '/devtools/datadog', label: 'DataDog', icon: Dog },
      { to: '/feature-agents', label: 'Feature Agents', icon: Wand2 },
      { to: '/devtools/github', label: 'GitHub', icon: Github },
      { to: '/devtools/history', label: 'History', icon: History },
      { to: '/instances', label: 'Instances', icon: Network },
      { to: '/devtools/jira', label: 'JIRA', icon: Ticket },
      { to: '/devtools/jira/reports', label: 'JIRA Reports', icon: FileText },
      { to: '/devtools/processes', label: 'Processes', icon: Activity },
      { to: '/shell', label: 'Shell', icon: SquareTerminal },
      { to: '/devtools/submodules', label: 'Submodules', icon: GitBranch },
      { to: '/devtools/usage', label: 'Usage', icon: BarChart3 }
    ]
  },
  { to: '/data', label: 'Data', icon: HardDrive, single: true },
  {
    label: 'Digital Twin',
    icon: Heart,
    children: [
      { to: '/digital-twin/accounts', label: 'Accounts', icon: Globe },
      { to: '/digital-twin/autobiography', label: 'Autobiography', icon: PenLine },
      { to: '/digital-twin/documents', label: 'Documents', icon: FileText },
      { to: '/digital-twin/enrich', label: 'Enrich', icon: Sparkles },
      { to: '/digital-twin/export', label: 'Export', icon: Download },
      { to: '/digital-twin/goals', label: 'Goals', icon: Target },
      { to: '/digital-twin/identity', label: 'Identity', icon: Fingerprint },
      { to: '/digital-twin/import', label: 'Import', icon: Upload },
      { to: '/digital-twin/interview', label: 'Interview', icon: MessageSquare },
      { to: '/digital-twin/overview', label: 'Overview', icon: Heart },
      { to: '/digital-twin/taste', label: 'Taste', icon: Palette },
      { to: '/digital-twin/test', label: 'Test', icon: CheckCircle }
    ]
  },
  { to: '/goals/list', label: 'Goals', icon: Target, single: true },
  { to: '/insights/overview', label: 'Insights', icon: Lightbulb, single: true },
  {
    label: 'MeatSpace',
    icon: Skull,
    children: [
      { to: '/meatspace/age', label: 'Age', icon: Clock },
      { to: '/meatspace/alcohol', label: 'Alcohol', icon: Activity },
      { to: '/meatspace/blood', label: 'Blood', icon: HeartPulse },
      { to: '/meatspace/body', label: 'Body', icon: Scale },
      { to: '/meatspace/genome', label: 'Genome', icon: Dna },
      { to: '/meatspace/health', label: 'Health', icon: Heart },
      { to: '/meatspace/settings', label: 'Settings', icon: Settings },
      { to: '/meatspace/lifestyle', label: 'Lifestyle', icon: ClipboardList },
      { to: '/meatspace/nicotine', label: 'Nicotine', icon: Cigarette },
      { to: '/meatspace/overview', label: 'Overview', icon: Activity },
    ]
  },
  {
    label: 'Messages',
    icon: Mail,
    children: [
      { to: '/messages/config', label: 'Config', icon: Settings },
      { to: '/messages/drafts', label: 'Drafts', icon: FilePen },
      { to: '/messages/inbox', label: 'Inbox', icon: Inbox },
      { to: '/messages/sync', label: 'Sync', icon: RefreshCw }
    ]
  },
  { to: '/openclaw', label: 'OpenClaw', icon: MessagesSquare, single: true },
  {
    label: 'POST',
    icon: Zap,
    children: [
      { to: '/post/config', label: 'Config', icon: Settings },
      { to: '/post/history', label: 'History', icon: History },
      { to: '/post/launcher', label: 'Launcher', icon: Play },
      { to: '/post/memory', label: 'Memory', icon: Brain },
      { to: '/post/wordplay', label: 'Wordplay', icon: MessageCircle },
    ]
  },
  {
    label: 'Settings',
    icon: Settings,
    children: [
      { to: '/settings/backup', label: 'Backup', icon: Download },
      { to: '/settings/database', label: 'Database', icon: Database },
      { to: '/settings/image-gen', label: 'Image Gen', icon: ImageIcon },
      { to: '/settings/voice', label: 'Voice', icon: Mic },
      { to: '/prompts', label: 'Prompts', icon: FileText },
      { to: '/ai', label: 'Providers', icon: Bot },
      { to: '/security', label: 'Security', icon: Camera },
      { to: '/settings/telegram', label: 'Telegram', icon: MessageSquare },
      { to: '/uploads', label: 'Uploads', icon: Upload }
    ]
  },
  { to: '/agents', label: 'Social Agents', icon: Users, single: true },
  {
    label: 'Wiki',
    icon: BookOpen,
    children: [
      { to: '/wiki/overview', label: 'Overview', icon: BarChart3 },
      { to: '/wiki/browse', label: 'Browse', icon: FileText },
      { to: '/wiki/graph', label: 'Graph', icon: Network },
      { to: '/wiki/log', label: 'Log', icon: Activity },
      { to: '/wiki/search', label: 'Search', icon: Search }
    ]
  }
];

const SIDEBAR_KEY = 'portos-sidebar-collapsed';

export default function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_KEY);
    return saved === 'true';
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [expandedSections, setExpandedSections] = useState({});

  // Subscribe to server error notifications
  useErrorNotifications();

  // Subscribe to agent completion feedback toasts
  useAgentFeedbackToast();

  // Check for PortOS updates and show toast when available
  useUpdateChecker();

  // Notifications for user task alerts
  const {
    notifications,
    unreadCount,
    markAsRead,
    markAllAsRead,
    removeNotification,
    clearAll
  } = useNotifications();

  // Fetch apps for sidebar navigation
  const [sidebarApps, setSidebarApps] = useState([]);
  useEffect(() => {
    const fetchApps = () => {
      api.getApps().then(apps => {
        setSidebarApps((apps || []).filter(a => !a.archived).sort((a, b) => a.name.localeCompare(b.name)));
      }).catch(() => {});
    };
    fetchApps();
    socket.on('apps:changed', fetchApps);
    return () => socket.off('apps:changed', fetchApps);
  }, []);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, String(collapsed));
  }, [collapsed]);

  // Build dynamic nav items with app children
  const resolvedNavItems = useMemo(() => navItems.map(item => {
    if (item.dynamic !== 'apps') return item;
    return {
      ...item,
      children: [
        { to: '/apps', label: 'Dashboard', icon: LayoutDashboard, end: true },
        { separator: true },
        ...sidebarApps.map(app => ({
          to: `/apps/${app.id}`,
          label: app.name,
          icon: Package
        }))
      ]
    };
  }), [sidebarApps]);

  // Auto-expand sections when on a child page
  useEffect(() => {
    resolvedNavItems.forEach(item => {
      if (item.children) {
        const isChildActive = item.children.some(child =>
          child.to && (location.pathname === child.to || location.pathname.startsWith(child.to + '/'))
        );
        if (isChildActive) {
          setExpandedSections(prev => ({ ...prev, [item.label]: true }));
        }
      }
    });
  }, [location.pathname, resolvedNavItems]);

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
      return item.children.some(child => child.to && isActive(child.to));
    }
    return false;
  };

  const renderNavItem = (item, index) => {
    // Separator
    if (item.separator) {
      return (
        <div key={`separator-${index}`} className="mx-4 my-2 border-t border-port-border" />
      );
    }

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
            <Icon size={20} className="shrink-0" />
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
              <Icon size={20} className="shrink-0" />
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
                navigate(item.children[0].to);
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
            <div className="relative">
              <Icon size={20} className="shrink-0" />
              {/* Badge for collapsed state on collapsible sections */}
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
          {!collapsed && (
            <div className="flex items-center gap-2">
              {/* Badge for expanded state on collapsible sections */}
              {item.showBadge && unreadCount > 0 && (
                <span className="min-w-[18px] h-[18px] flex items-center justify-center text-[10px] font-bold rounded-full bg-yellow-500 text-black px-1">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
              {expandedSections[item.label]
                ? <ChevronDown size={16} />
                : <ChevronRight size={16} />
              }
            </div>
          )}
        </button>

        {/* Children items */}
        {expandedSections[item.label] && !collapsed && (
          <div className="ml-4 mt-1">
            {item.children.map((child, childIndex) => {
              if (child.separator) {
                return <div key={`child-sep-${childIndex}`} className="mx-3 my-1 border-t border-port-border" />;
              }
              const ChildIcon = child.icon;
              if (child.external) {
                const childHref = child.dynamicHost
                  ? `${window.location.protocol}//${window.location.hostname}${child.href.replace('//', '')}`
                  : child.href;
                return (
                  <a
                    key={child.href}
                    href={childHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-sm transition-colors text-gray-500 hover:text-white hover:bg-port-border/50"
                  >
                    <div className="flex items-center gap-3">
                      <ChildIcon size={16} />
                      <span>{child.label}</span>
                    </div>
                    <ExternalLink size={12} className="text-gray-500" />
                  </a>
                );
              }
              const childActive = child.end
                ? location.pathname === child.to
                : isActive(child.to);
              return (
                <NavLink
                  key={child.to}
                  to={child.to}
                  end={child.end}
                  onClick={() => setMobileOpen(false)}
                  className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                    childActive
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
    <div className="min-h-screen min-h-[100dvh] w-full max-w-full overflow-x-hidden bg-port-bg flex">
      {/* Skip to main content link for keyboard users */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-[100] focus:px-4 focus:py-2 focus:bg-port-accent focus:text-white focus:rounded-lg focus:outline-hidden"
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
          {resolvedNavItems.map(renderNavItem)}
        </nav>

        {/* Footer with version and notifications */}
        <div className={`p-4 border-t border-port-border ${collapsed ? 'lg:flex lg:justify-center' : ''}`}>
          <div className={`flex items-center ${collapsed ? 'lg:justify-center' : 'justify-between'}`}>
            <span className={`text-sm text-gray-500 ${collapsed ? 'lg:hidden' : ''}`}>
              v{__APP_VERSION__}
            </span>
            <div className="flex items-center gap-1">
              <NavLink
                to="/ambient"
                className={`p-1.5 rounded-lg transition-colors ${collapsed ? 'lg:hidden' : ''} ${
                  isActive('/ambient')
                    ? 'text-port-accent'
                    : 'text-gray-500 hover:text-white'
                }`}
                title="Ambient"
                aria-label="Ambient display"
              >
                <Monitor size={18} />
              </NavLink>
              <ThemeSwitcher className={collapsed ? 'lg:hidden' : ''} />
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
      <div className={`flex-1 flex flex-col min-w-0 max-w-full transition-all duration-300 ${collapsed ? 'lg:ml-16' : 'lg:ml-56'}`}>
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
          <div className="flex items-center gap-1">
            <NavLink
              to="/ambient"
              className={`p-1.5 rounded-lg transition-colors ${
                isActive('/ambient')
                  ? 'text-port-accent'
                  : 'text-gray-500 hover:text-white'
              }`}
              aria-label="Ambient display"
            >
              <Monitor size={16} />
            </NavLink>
            <ThemeSwitcher position="below" />
            <NotificationDropdown
              notifications={notifications}
              unreadCount={unreadCount}
              onMarkAsRead={markAsRead}
              onMarkAllAsRead={markAllAsRead}
              onRemove={removeNotification}
              onClearAll={clearAll}
              position="top"
            />
          </div>
        </header>

        {/* Main content */}
        {(() => {
          const isFullWidth = location.pathname === '/character' ||
            location.pathname.startsWith('/calendar') ||
            location.pathname.startsWith('/cos') ||
            location.pathname.startsWith('/brain') ||
            location.pathname.startsWith('/digital-twin') ||
            location.pathname.startsWith('/feature-agents') ||
            location.pathname.startsWith('/goals') ||
            location.pathname.startsWith('/insights') ||
            location.pathname.startsWith('/meatspace') ||
            location.pathname.startsWith('/messages') ||
            location.pathname.startsWith('/post') ||
            location.pathname === '/review' ||
            location.pathname.startsWith('/wiki') ||
            location.pathname.startsWith('/agents') ||
            location.pathname === '/shell' ||
            location.pathname.startsWith('/city') ||
            /^\/apps\/[^/]+/.test(location.pathname);
          return (
            <main id="main-content" className={`flex-1 ${isFullWidth ? 'overflow-hidden' : 'overflow-auto p-4 md:p-6'}`}>
              {isFullWidth ? <Outlet /> : <div className="max-w-7xl mx-auto"><Outlet /></div>}
            </main>
          );
        })()}
      </div>
      {/* Cmd+K search overlay — mounted in layout so it's available on every page */}
      <CmdKSearch />
      {/* Keyboard shortcuts help — press ? to toggle */}
      <KeyboardHelp />
      {/* Push-to-talk voice widget — self-hides when voice.enabled is false */}
      <VoiceWidget />
    </div>
  );
}
