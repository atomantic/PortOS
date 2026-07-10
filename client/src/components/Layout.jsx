import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
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
  Film,
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
  CalendarClock,
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
  HeartPulse,
  ClipboardList,
  ListChecks,
  Compass,
  Scale,
  LayoutDashboard,
  Lightbulb,
  GitBranch,
  Link2,
  Database,
  Shield,
  Lock,
  Wand2,
  Rocket,
  Zap,
  Inbox,
  RefreshCw,
  Dog,
  FileInput,
  FilePen,
  MessageCircle,
  Radio,
  TrendingUp,
  Swords,
  HardDrive,
  Layers,
  MessagesSquare,
  BookOpen,
  NotebookPen,
  Mic,
  Rss,
  Archive,
  Eraser,
  Sun,
  Moon,
  Share2,
  Pin,
  PinOff,
  Navigation,
  Music,
  Workflow as WorkflowIcon,
  ChartGantt,
  Clapperboard
} from 'lucide-react';
/* global __APP_VERSION__ */
import Logo from './Logo';
import { useErrorNotifications } from '../hooks/useErrorNotifications';
import { useNotifications } from '../hooks/useNotifications';
import { useAgentFeedbackToast } from '../hooks/useAgentFeedbackToast';
import { useOnDemandTaskToast } from '../hooks/useOnDemandTaskToast';
import { useSharingNotifications } from '../hooks/useSharingNotifications';
import { useUpdateChecker } from '../hooks/useUpdateChecker';
import { useAIStatusNotifications } from '../hooks/useAIStatusNotifications';
import { useNavWorkingSet } from '../hooks/useNavWorkingSet.js';
import { useSidebarApps } from '../hooks/useSidebarApps.js';
import { useSidebarSeries } from '../hooks/useSidebarSeries.js';
import { useSidebarUniverses } from '../hooks/useSidebarUniverses.js';
import { useThemeContext } from './ThemeContext';
import NotificationDropdown from './NotificationDropdown';
import VoiceToggleButton from './voice/VoiceToggleButton';
import CmdKSearch from './CmdKSearch';
import KeyboardHelp from './KeyboardHelp';
import VoiceWidget from './voice/VoiceWidget';

function ThemeModeToggle({ className = '' }) {
  const { theme, toggleMode } = useThemeContext();
  const isDay = theme?.mode === 'day';
  const Icon = isDay ? Sun : Moon;
  const pairLabel = theme?.pair ? ` (${isDay ? 'switch to night' : 'switch to day'})` : '';
  return (
    <button
      type="button"
      onClick={toggleMode}
      title={`${theme?.label ?? 'Theme'}${pairLabel}`}
      aria-label={`Toggle day/night mode${pairLabel}`}
      className={`inline-flex items-center justify-center min-w-[44px] min-h-[44px] lg:min-w-0 lg:min-h-0 lg:p-1.5 rounded-lg text-gray-500 hover:text-port-accent transition-colors ${className}`}
    >
      <Icon size={18} aria-hidden="true" />
    </button>
  );
}
import * as api from '../services/api';

const navItems = [
  { to: '/', label: 'Dashboard', icon: Home, single: true },
  { to: '/review', label: 'Review Hub', icon: ClipboardList, single: true },
  { to: '/city', label: 'City', icon: Building2, single: true },
  { separator: true },
  { label: 'Apps', icon: Package, dynamic: 'apps', defaultTo: '/apps', children: [] },
  {
    label: 'Brain',
    icon: Brain,
    defaultTo: '/brain/inbox',
    children: [
      { to: '/brain/config', label: 'Config', icon: Settings },
      { to: '/brain/daily-log', label: 'Daily Log', icon: NotebookPen },
      { to: '/brain/digest', label: 'Digest', icon: Calendar },
      { to: '/brain/feeds', label: 'Feeds', icon: Rss },
      { to: '/brain/graph', label: 'Graph', icon: Network },
      { to: '/brain/import', label: 'Import', icon: Upload },
      { to: '/brain/inbox', label: 'Inbox', icon: MessageSquare },
      { to: '/insights/overview', label: 'Insights', icon: Lightbulb },
      { to: '/brain/links', label: 'Links', icon: Link2 },
      { to: '/brain/memory', label: 'Memory', icon: Database },
      { to: '/brain/notes', label: 'Notes', icon: FileText },
      { to: '/openclaw', label: 'OpenClaw', icon: MessagesSquare },
      { to: '/rapid-reader', label: 'Rapid Reader', icon: Zap },
      { to: '/timeline', label: 'Timeline', icon: CalendarClock },
      { to: '/tribe', label: 'Tribe', icon: Users },
      { to: '/brain/trust', label: 'Trust', icon: Shield },
      { to: '/wiki/overview', label: 'Wiki', icon: BookOpen },
    ],
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
      { to: '/calendar/week', label: 'Week', icon: CalendarDays },
    ],
  },
  {
    label: 'Chief of Staff',
    icon: Crown,
    showBadge: true,
    defaultTo: '/cos/tasks',
    children: [
      { to: '/cos/agents', label: 'Agents', icon: Cpu },
      { to: '/cos/briefing', label: 'Briefing', icon: Newspaper },
      { to: '/cos/config', label: 'Config', icon: Settings },
      { to: '/cos/digest', label: 'Digest', icon: Calendar },
      { to: '/feature-agents', label: 'Feature Agents', icon: Wand2 },
      { to: '/cos/gsd', label: 'GSD', icon: Compass },
      { to: '/cos/health', label: 'Health', icon: Activity },
      { to: '/cos/learning', label: 'Learning', icon: GraduationCap },
      { to: '/cos/memory', label: 'Memory', icon: Brain },
      { to: '/cos/schedule', label: 'Schedule', icon: Clock },
      { to: '/agents', label: 'Social Agents', icon: Users },
      { to: '/cos/productivity', label: 'Streaks', icon: Flame },
      { to: '/cos/jobs', label: 'System Tasks', icon: Bot },
      { to: '/cos/tasks', label: 'Tasks', icon: FileText },
      { to: '/cos/workflow', label: 'Timeline', icon: ChartGantt },
    ],
  },
  {
    label: 'Comms',
    icon: MessagesSquare,
    defaultTo: '/messages/inbox',
    children: [
      { to: '/messages/config', label: 'Config', icon: Settings },
      { to: '/messages/drafts', label: 'Drafts', icon: FilePen },
      { to: '/messages/inbox', label: 'Inbox', icon: Inbox },
      { to: '/messages/sync', label: 'Sync', icon: RefreshCw },
    ],
  },
  {
    label: 'Create',
    icon: Sparkles,
    defaultTo: '/media',
    children: [
      { to: '/authors', label: 'Authors', icon: FilePen },
      { to: '/catalog', label: 'Catalog', icon: Sparkles },
      { to: '/creative-director', label: 'Creative Director', icon: Clapperboard },
      { to: '/pipeline/editorial-checks', label: 'Editorial Checks', icon: ListChecks },
      { to: '/importer', label: 'Importer', icon: FileInput },
      { to: '/media', label: 'Media Gen', icon: Layers },
      { to: '/mood-boards', label: 'Mood Boards', icon: Palette },
      { to: '/music', label: 'Music', icon: Mic },
      { to: '/media/music-video', label: 'Music Video', icon: Music },
      { to: '/rounds', label: 'Rounds', icon: Music },
      { to: '/pipeline', label: 'Series Pipeline', icon: WorkflowIcon, dynamic: 'pipelineSeries' },
      { to: '/sharing', label: 'Sharing', icon: Share2 },
      { to: '/start-story', label: 'Start a Story', icon: Rocket },
      { to: '/story-builder', label: 'Story Builder', icon: Wand2 },
      { to: '/universes', label: 'Universes', icon: Globe, dynamic: 'universes' },
      { to: '/writers-room', label: 'Writers Room', icon: NotebookPen },
    ],
  },
  {
    label: 'Dev Tools',
    icon: Terminal,
    children: [
      { to: '/devtools/agents', label: 'AI Agents', icon: Cpu },
      { to: '/devtools/runs', label: 'AI Runs', icon: Play },
      { to: '/ambient', label: 'Ambient', icon: Sparkles },
      { href: '//:5560', label: 'Autofixer', icon: Wrench, external: true, dynamicHost: true },
      { to: '/browser', label: 'Browser', icon: Globe },
      { to: '/capabilities', label: 'Capabilities', icon: Compass },
      { to: '/devtools/runner', label: 'Code', icon: Code2 },
      { to: '/data', label: 'Data', icon: HardDrive },
      { to: '/devtools/datadog', label: 'DataDog', icon: Dog },
      { to: '/devtools/flows', label: 'Flows', icon: WorkflowIcon },
      { to: '/devtools/github', label: 'GitHub', icon: GitBranch },
      { to: '/devtools/history', label: 'History', icon: History },
      { to: '/devtools/image-clean', label: 'Image Cleaner', icon: Eraser },
      { to: '/instances', label: 'Instances', icon: Network },
      { to: '/devtools/jira', label: 'JIRA', icon: Ticket },
      { to: '/devtools/jira/reports', label: 'JIRA Reports', icon: FileText },
      { to: '/loops', label: 'Loops', icon: RefreshCw },
      { to: '/devtools/processes', label: 'Processes', icon: Activity },
      { to: '/security', label: 'Security', icon: Camera },
      { to: '/shell', label: 'Shell', icon: SquareTerminal },
      { to: '/devtools/submodules', label: 'Submodules', icon: GitBranch },
      { to: '/system-health', label: 'System Health', icon: Activity },
      { to: '/uploads', label: 'Uploads', icon: Upload },
      { to: '/devtools/usage', label: 'Usage', icon: BarChart3 },
      { to: '/devtools/video-download', label: 'Video Downloader', icon: Film },
      { to: '/workspace-contexts', label: 'Workspaces', icon: Layers },
    ],
  },
  { to: '/goals/list', label: 'Goals', icon: Target, single: true },
  {
    label: 'Health',
    icon: Heart,
    defaultTo: '/meatspace/overview',
    children: [
      { to: '/meatspace/age', label: 'Age', icon: Clock },
      { to: '/meatspace/alcohol', label: 'Alcohol', icon: Activity },
      { to: '/meatspace/blood', label: 'Blood', icon: HeartPulse },
      { to: '/meatspace/body', label: 'Body', icon: Scale },
      { to: '/meatspace/health', label: 'Body Health', icon: Heart },
      { to: '/meatspace/export', label: 'Export', icon: FileText },
      { to: '/meatspace/genome', label: 'Genome', icon: Dna },
      { to: '/meatspace/lifestyle', label: 'Lifestyle', icon: ClipboardList },
      { to: '/meatspace/nicotine', label: 'Nicotine', icon: Cigarette },
      { to: '/meatspace/overview', label: 'Overview', icon: Activity },
      { to: '/meatspace/settings', label: 'Settings', icon: Settings },
    ],
  },
  {
    label: 'Settings',
    icon: Settings,
    defaultTo: '/settings/general',
    children: [
      { to: '/settings/ai-assignments', label: 'AI Assignments', icon: Bot },
      { to: '/settings/api-access', label: 'API Access', icon: Globe },
      { to: '/settings/backup', label: 'Backup', icon: Download },
      { to: '/settings/database', label: 'Database', icon: Database },
      { to: '/settings/general', label: 'General', icon: Settings },
      { to: '/settings/local-llm', label: 'Local LLMs', icon: Cpu },
      { to: '/settings/mortalloom', label: 'MortalLoom', icon: Activity },
      { to: '/prompts', label: 'Prompts', icon: FileText },
      { to: '/ai', label: 'Providers', icon: Bot },
      { to: '/settings/security', label: 'Security', icon: Lock },
      { to: '/settings/sharing', label: 'Sharing', icon: Share2 },
      { to: '/settings/telegram', label: 'Telegram', icon: MessageSquare },
      { to: '/settings/voice', label: 'Voice', icon: Mic },
    ],
  },
  { moreLabel: true },
  {
    label: 'Identity',
    icon: Fingerprint,
    defaultTo: '/digital-twin/overview',
    children: [
      { to: '/digital-twin/accounts', label: 'Accounts', icon: Globe },
      { to: '/ask', label: 'Ask Yourself', icon: MessageCircle },
      { to: '/digital-twin/autobiography', label: 'Autobiography', icon: PenLine },
      { to: '/character', label: 'Character', icon: Swords },
      { to: '/digital-twin/documents', label: 'Documents', icon: FileText },
      { to: '/digital-twin/enrich', label: 'Enrich', icon: Sparkles },
      { to: '/digital-twin/export', label: 'Export', icon: Download },
      { to: '/digital-twin/identity', label: 'Identity', icon: Fingerprint },
      { to: '/digital-twin/import', label: 'Import', icon: Upload },
      { to: '/digital-twin/interview', label: 'Interview', icon: MessageSquare },
      { to: '/digital-twin/overview', label: 'Overview', icon: Heart },
      { to: '/privacy/overview', label: 'Privacy', icon: Shield },
      { to: '/digital-twin/taste', label: 'Taste', icon: Palette },
      { to: '/digital-twin/test', label: 'Test', icon: CheckCircle },
      { to: '/digital-twin/time-capsule', label: 'Time Capsule', icon: Archive },
    ],
  },
  {
    label: 'POST',
    icon: Zap,
    defaultTo: '/post/launcher',
    children: [
      { to: '/post/config', label: 'Config', icon: Settings },
      { to: '/post/history', label: 'History', icon: History },
      { to: '/post/launcher', label: 'Launcher', icon: Play },
      { to: '/post/memory', label: 'Memory', icon: Brain },
      { to: '/post/morse', label: 'Morse', icon: Radio },
      { to: '/post/progress', label: 'Progress', icon: TrendingUp },
      { to: '/post/wordplay', label: 'Wordplay', icon: MessageCircle },
    ],
  },
];

const SIDEBAR_KEY = 'portos-sidebar-collapsed';

// The pin/unpin toggle shared by every pinnable sidebar row (Pinned/Recent rows
// and the top-level single rows). It must not navigate, so it swallows the click
// (preventDefault + stopPropagation). A pinned row shows a filled pin in the
// accent color; an unpinned row reveals the affordance only on hover/focus of
// the enclosing `group`.
function PinButton({ label, pinned, onTogglePin }) {
  return (
    <button
      type="button"
      aria-label={pinned ? `Unpin ${label}` : `Pin ${label}`}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onTogglePin(); }}
      className={`px-2 rounded-lg hover:bg-port-border/50 ${pinned ? 'text-port-accent' : 'text-gray-500 opacity-40 sm:opacity-0 sm:group-hover:opacity-100 group-focus-within:opacity-100'}`}
    >
      {pinned ? <PinOff size={14} /> : <Pin size={14} />}
    </button>
  );
}

// One row in the sidebar's Pinned/Recent sections: a nav link plus a pin/unpin
// toggle that does not navigate (stops propagation). Pinned rows show a filled
// pin; recent rows reveal the pin affordance on hover/focus.
// Labels wrap (no truncate) so long app/series names stay readable in the
// narrow rail; the pin is absolutely positioned so it doesn't steal label width.
function WorkingSetRow({ entry, pinned, onTogglePin, onNavigate, isActive }) {
  const Icon = entry.icon;
  return (
    <div className="group relative mx-2 min-w-0">
      <NavLink
        to={entry.path}
        end={entry.end}
        onClick={onNavigate}
        title={entry.label}
        className={`flex items-start gap-3 px-3 py-2 pr-9 rounded-lg text-sm transition-colors min-w-0 ${
          isActive ? 'bg-port-accent/10 text-port-accent' : 'text-gray-400 hover:text-white hover:bg-port-border/50'
        }`}
      >
        {Icon && <Icon size={16} className="shrink-0 mt-0.5" />}
        <span className="min-w-0 break-words leading-snug">{entry.label}</span>
      </NavLink>
      <div className="absolute right-0 top-0 bottom-0 flex items-center">
        <PinButton label={entry.label} pinned={pinned} onTogglePin={onTogglePin} />
      </div>
    </div>
  );
}

// A top-level *single* nav row (Dashboard / Review Hub / City / Goals). Unlike a
// section, it links straight to one destination — and unlike WorkingSetRow it
// carries the heavier top-level row weight plus the optional badge (Chief of
// Staff unread count) and the collapsed-rail layout (icon-only, centered, badge
// overlaid on the icon). When expanded it also exposes the same hover/focus
// pin/unpin affordance as WorkingSetRow so these destinations can be pinned too;
// the pin button is omitted in the collapsed rail, mirroring the Pinned/Recent
// sections which only render when the sidebar is expanded.
export function SingleNavRow({ item, collapsed, active, badgeCount, pinned, onTogglePin, onNavigate }) {
  const Icon = item.icon;
  const showBadge = item.showBadge && badgeCount > 0;
  const badgeText = badgeCount > 9 ? '9+' : badgeCount;
  return (
    <div className={`group relative min-w-0 mx-2 ${collapsed ? 'lg:flex lg:justify-center' : ''}`}>
      <NavLink
        to={item.to}
        end={item.to === '/'}
        onClick={onNavigate}
        className={`flex items-start gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors min-w-0 ${
          collapsed ? 'lg:justify-center lg:px-2' : 'pr-9'
        } ${
          active
            ? 'bg-port-accent/10 text-port-accent'
            : 'text-gray-400 hover:text-white hover:bg-port-border/50'
        }`}
        title={item.label}
      >
        <div className="flex items-start gap-3 min-w-0 flex-1">
          <div className="relative shrink-0">
            <Icon size={20} className="shrink-0" />
            {/* Badge for collapsed state */}
            {showBadge && collapsed && (
              <span className="absolute -top-1.5 -right-1.5 min-w-[14px] h-[14px] flex items-center justify-center text-[9px] font-bold rounded-full bg-yellow-500 text-black px-0.5">
                {badgeText}
              </span>
            )}
          </div>
          <span className={`min-w-0 break-words leading-snug ${collapsed ? 'lg:hidden' : ''}`}>
            {item.label}
          </span>
        </div>
        {/* Badge for expanded state — sits left of the absolute pin */}
        {showBadge && !collapsed && (
          <span className="min-w-[18px] h-[18px] flex items-center justify-center text-[10px] font-bold rounded-full bg-yellow-500 text-black px-1 shrink-0 mt-0.5">
            {badgeText}
          </span>
        )}
      </NavLink>
      {!collapsed && (
        <div className="absolute right-0 top-0 bottom-0 flex items-center">
          <PinButton label={item.label} pinned={pinned} onTogglePin={onTogglePin} />
        </div>
      )}
    </div>
  );
}

export default function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_KEY);
    return saved === 'true';
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [expandedSections, setExpandedSections] = useState({});
  // Collapsed-sidebar flyout: hovering or focusing a section icon opens a
  // fixed-position popover to the right listing the section's children, so the
  // user can reach siblings (e.g. Writers Room from Create) without expanding
  // the whole sidebar. Tracks which section is open and the icon's screen rect.
  const [flyoutSection, setFlyoutSection] = useState(null);
  const [flyoutPos, setFlyoutPos] = useState({ top: 0, left: 0 });
  const flyoutRef = useRef(null);
  const flyoutCloseTimer = useRef(null);
  const openFlyout = useCallback((event, label) => {
    clearTimeout(flyoutCloseTimer.current);
    const rect = event.currentTarget.getBoundingClientRect();
    setFlyoutPos({ top: rect.top, left: rect.right + 4 });
    setFlyoutSection(label);
  }, []);
  // Shift the flyout up if it would overflow the bottom of the viewport so the
  // full menu of options stays visible (sections near the bottom of a collapsed
  // sidebar otherwise clip off-screen). Measures the actual rendered height and
  // adjusts before paint (no flicker, hence useLayoutEffect on open).
  const clampFlyout = useCallback(() => {
    if (!flyoutRef.current) return;
    const MARGIN = 8;
    const height = flyoutRef.current.offsetHeight;
    const maxTop = window.innerHeight - height - MARGIN;
    setFlyoutPos((prev) => {
      const clampedTop = Math.max(MARGIN, Math.min(prev.top, maxTop));
      return clampedTop === prev.top ? prev : { ...prev, top: clampedTop };
    });
  }, []);
  useLayoutEffect(() => {
    if (!flyoutSection) return;
    clampFlyout();
    // Re-clamp on resize so a shorter viewport doesn't strand the open flyout.
    window.addEventListener('resize', clampFlyout);
    return () => window.removeEventListener('resize', clampFlyout);
  }, [flyoutSection, clampFlyout]);
  const scheduleCloseFlyout = useCallback(() => {
    clearTimeout(flyoutCloseTimer.current);
    flyoutCloseTimer.current = setTimeout(() => setFlyoutSection(null), 180);
  }, []);
  const cancelCloseFlyout = useCallback(() => clearTimeout(flyoutCloseTimer.current), []);
  useEffect(() => () => clearTimeout(flyoutCloseTimer.current), []);
  // Close any open flyout immediately on navigation so a stale popover doesn't
  // hang over the next page.
  useEffect(() => { setFlyoutSection(null); }, [location.pathname]);

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

  // Sidebar data-fetch loops (apps / pipeline series / universes) live in
  // dedicated hooks so the shared focus-debounce + signature-guard pattern is
  // testable in isolation. See client/src/hooks/useSidebar*.js.
  const sidebarApps = useSidebarApps();
  const pipelineSeries = useSidebarSeries();
  const universes = useSidebarUniverses();

  // Fetch the palette nav manifest once on mount so manifest-only paths
  // (e.g. /wiki/log, /goals/tree) can be resolved in the Pinned/Recent sections
  // even though they are not sidebar leaves.
  const [manifestNav, setManifestNav] = useState([]);
  useEffect(() => {
    api.getPaletteManifest({ silent: true })
      .then((data) => setManifestNav(Array.isArray(data?.nav) ? data.nav : []))
      .catch((err) => console.warn(`⚠️ Layout: palette manifest fetch failed: ${err?.message || err}`));
  }, []);

  const manifestEntryByPath = useMemo(() => {
    const map = new Map();
    manifestNav.forEach((c) => {
      if (c?.path && !map.has(c.path)) map.set(c.path, { path: c.path, label: c.label, icon: Navigation });
    });
    return map;
  }, [manifestNav]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, String(collapsed));
  }, [collapsed]);

  // Build dynamic nav items with app children + pipeline series.
  // `decoratePipelineChild` is defined inside the memo so its closure over
  // `pipelineSeries` doesn't require an eslint-disable, and so it isn't
  // reallocated on every render.
  const resolvedNavItems = useMemo(() => {
    const decoratePipelineChild = (child) => {
      if (child.dynamic !== 'pipelineSeries') return child;
      return {
        ...child,
        grandChildren: pipelineSeries.map((s) => ({
          to: `/pipeline/series/${s.id}`,
          label: s.name || '(untitled series)',
          title: s.name || '(untitled series)',
          // Active-detection prefix — highlight while on the series page
          // OR any issue belonging to that series. The issue page itself
          // doesn't carry seriesId in its URL, so per-issue highlighting
          // stays handled inside PipelineIssue's own breadcrumb.
          activePathPrefix: `/pipeline/series/${s.id}`,
        })),
      };
    };
    const decorateUniverseChild = (child) => {
      if (child.dynamic !== 'universes') return child;
      return {
        ...child,
        grandChildren: universes.map((u) => ({
          to: `/universes/${u.id}`,
          label: u.name || '(untitled universe)',
          title: u.name || '(untitled universe)',
          activePathPrefix: `/universes/${u.id}`,
        })),
      };
    };
    return navItems.map((item) => {
      if (item.dynamic === 'apps') {
        return {
          ...item,
          children: [
            { to: '/apps', label: 'Dashboard', icon: LayoutDashboard, end: true },
            { separator: true },
            ...sidebarApps.map((app) => ({
              to: `/apps/${app.id}`,
              label: app.name,
              icon: Package,
            })),
          ],
        };
      }
      if (Array.isArray(item.children)) {
        return { ...item, children: item.children.map((c) => decoratePipelineChild(decorateUniverseChild(c))) };
      }
      return item;
    });
  }, [sidebarApps, pipelineSeries, universes]);

  // Flat path -> { path, label, icon } lookup over every leaf nav row, so the
  // Pinned/Recent sections render a stored path with its real label + icon.
  const navEntryByPath = useMemo(() => {
    const map = new Map();
    const addLeaf = (leaf) => {
      if (leaf?.to && !map.has(leaf.to)) {
        map.set(leaf.to, { path: leaf.to, label: leaf.label, icon: leaf.icon, end: leaf.end });
      }
    };
    resolvedNavItems.forEach((item) => {
      if (item.single) addLeaf(item);
      (item.children || []).forEach((child) => {
        addLeaf(child);
        (child.grandChildren || []).forEach(addLeaf);
      });
    });
    return map;
  }, [resolvedNavItems]);

  const resolveNavEntry = useCallback(
    (path) => navEntryByPath.get(path) || manifestEntryByPath.get(path) || null,
    [navEntryByPath, manifestEntryByPath],
  );

  const { pinned, recent, pin, unpin, isPinned } = useNavWorkingSet(resolveNavEntry);

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

    // "More" section divider — visually groups the long-tail sections below it.
    if (item.moreLabel) {
      return <div key="more-label" className="mx-4 mt-3 mb-1 pt-2 border-t border-port-border text-[10px] font-semibold uppercase tracking-wide text-gray-500">More</div>;
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
          className={`flex items-start gap-3 mx-2 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors min-w-0 ${
            collapsed ? 'lg:justify-center lg:px-2' : 'justify-between'
          } text-gray-400 hover:text-white hover:bg-port-border/50`}
          title={item.label}
        >
          <div className="flex items-start gap-3 min-w-0">
            <Icon size={20} className="shrink-0" />
            <span className={`min-w-0 break-words leading-snug ${collapsed ? 'lg:hidden' : ''}`}>
              {item.label}
            </span>
          </div>
          {!collapsed && <ExternalLink size={14} className="text-gray-500 shrink-0 mt-0.5" />}
        </a>
      );
    }

    if (item.single) {
      const singlePinned = isPinned(item.to);
      return (
        <SingleNavRow
          key={item.to}
          item={item}
          collapsed={collapsed}
          active={isActive(item.to)}
          badgeCount={unreadCount}
          pinned={singlePinned}
          onTogglePin={() => (singlePinned ? unpin(item.to) : pin(item.to))}
          onNavigate={() => setMobileOpen(false)}
        />
      );
    }

    // Collapsible section
    const defaultChildPath = item.defaultTo
      || (item.children && item.children.find(c => c.to)?.to)
      || null;

    const navigateToSection = () => {
      if (defaultChildPath) {
        navigate(defaultChildPath);
        // Ensure the section is expanded so the user can see siblings
        if (!expandedSections[item.label] && !collapsed) {
          toggleSection(item.label);
        }
      } else {
        toggleSection(item.label);
      }
      setMobileOpen(false);
    };

    const sectionRowClasses = `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
      isSectionActive(item)
        ? 'bg-port-accent/10 text-port-accent'
        : 'text-gray-400 hover:text-white hover:bg-port-border/50'
    }`;

    const hasChildrenForFlyout = collapsed && Array.isArray(item.children) && item.children.length > 0;

    return (
      <div key={item.label} className="mx-2 min-w-0">
        <div
          className={`flex items-stretch min-w-0 ${collapsed ? 'lg:justify-center' : ''}`}
          onMouseEnter={hasChildrenForFlyout ? (e) => openFlyout(e, item.label) : undefined}
          onMouseLeave={hasChildrenForFlyout ? scheduleCloseFlyout : undefined}
          onFocus={hasChildrenForFlyout ? (e) => openFlyout(e, item.label) : undefined}
          onBlur={hasChildrenForFlyout ? scheduleCloseFlyout : undefined}
        >
          <button
            type="button"
            onClick={navigateToSection}
            className={`flex-1 min-w-0 ${sectionRowClasses} ${collapsed ? 'lg:justify-center lg:px-2' : 'justify-between'}`}
            title={collapsed ? item.label : undefined}
            aria-haspopup={hasChildrenForFlyout ? 'menu' : undefined}
            aria-expanded={hasChildrenForFlyout ? flyoutSection === item.label : undefined}
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="relative">
                <Icon size={20} className="shrink-0" />
                {item.showBadge && unreadCount > 0 && collapsed && (
                  <span className="absolute -top-1.5 -right-1.5 min-w-[14px] h-[14px] flex items-center justify-center text-[9px] font-bold rounded-full bg-yellow-500 text-black px-0.5">
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                )}
              </div>
              <span className={`min-w-0 break-words leading-snug ${collapsed ? 'lg:hidden' : ''}`}>
                {item.label}
              </span>
            </div>
            {!collapsed && item.showBadge && unreadCount > 0 && (
              <span className="min-w-[18px] h-[18px] flex items-center justify-center text-[10px] font-bold rounded-full bg-yellow-500 text-black px-1 shrink-0">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </button>
          {!collapsed && (
            <button
              type="button"
              aria-label={expandedSections[item.label] ? `Collapse ${item.label}` : `Expand ${item.label}`}
              onClick={() => toggleSection(item.label)}
              className="px-2 text-gray-400 hover:text-white hover:bg-port-border/50 rounded-lg"
            >
              {expandedSections[item.label]
                ? <ChevronDown size={16} />
                : <ChevronRight size={16} />
              }
            </button>
          )}
        </div>

        {/* Children items */}
        {expandedSections[item.label] && !collapsed && (
          <div className="ml-4 mt-1 min-w-0">
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
                    title={child.label}
                    className="flex items-start justify-between gap-3 px-3 py-2 rounded-lg text-sm transition-colors text-gray-500 hover:text-white hover:bg-port-border/50 min-w-0"
                  >
                    <div className="flex items-start gap-3 min-w-0">
                      <ChildIcon size={16} className="shrink-0 mt-0.5" />
                      <span className="min-w-0 break-words leading-snug">{child.label}</span>
                    </div>
                    <ExternalLink size={12} className="text-gray-500 shrink-0 mt-0.5" />
                  </a>
                );
              }
              const childActive = child.end
                ? location.pathname === child.to
                : isActive(child.to);
              const grandChildren = Array.isArray(child.grandChildren) ? child.grandChildren : [];
              const childIsPinned = isPinned(child.to);
              return (
                <div key={child.to} className="min-w-0">
                  <WorkingSetRow
                    entry={{ path: child.to, label: child.label, icon: ChildIcon, end: child.end }}
                    pinned={childIsPinned}
                    onTogglePin={() => (childIsPinned ? unpin(child.to) : pin(child.to))}
                    onNavigate={() => setMobileOpen(false)}
                    isActive={childActive}
                  />
                  {grandChildren.length > 0 && (
                    <div className="ml-6 mt-0.5 mb-1 border-l border-port-border/50 pl-2 min-w-0">
                      {grandChildren.map((gc) => {
                        // Prefer the explicit prefix (e.g. `/pipeline/issues/<id>`)
                        // so the row stays highlighted across stage tabs — the
                        // `to` link points at a specific default stage but the
                        // user may navigate to siblings.
                        const prefix = gc.activePathPrefix || gc.to;
                        const gcActive = location.pathname === prefix
                          || location.pathname.startsWith(prefix + '/');
                        return (
                          <NavLink
                            key={gc.to}
                            to={gc.to}
                            onClick={() => setMobileOpen(false)}
                            title={gc.title || gc.label}
                            className={`block px-2 py-1 rounded text-xs transition-colors min-w-0 break-words leading-snug ${
                              gcActive
                                ? 'text-port-accent'
                                : 'text-gray-600 hover:text-gray-300 hover:bg-port-border/30'
                            }`}
                          >
                            {gc.label}
                          </NavLink>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="h-dvh-screen print:h-auto print:min-h-screen w-full max-w-full overflow-x-hidden bg-port-bg flex">
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
          fixed inset-y-0 left-0 z-50 h-dvh-screen print:hidden
          flex flex-col bg-port-card border-r border-port-border
          transition-all duration-300 ease-in-out
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
          ${collapsed ? 'lg:w-16' : 'lg:w-64'}
          w-64
        `}
      >
        {/* Header with logo and collapse toggle */}
        <div className={`flex items-center p-4 border-b border-port-border ${collapsed ? 'lg:justify-center' : 'justify-between'}`}>
          {/* Expanded: logo + text */}
          <div className={`flex items-center gap-2 ${collapsed ? 'lg:hidden' : ''}`}>
            <Logo size={28} className="shrink-0" />
            <span className="text-port-accent font-semibold whitespace-nowrap">PortOS</span>
          </div>
          {/* Collapsed: just logo, clickable to expand */}
          {collapsed && (
            <button
              type="button"
              onClick={() => setCollapsed(false)}
              className="hidden lg:block opacity-95 transition-opacity hover:opacity-80"
              title="Expand sidebar"
              aria-label="Expand sidebar"
            >
              <Logo size={28} ariaLabel="PortOS logo - click to expand sidebar" />
            </button>
          )}
          {/* Expanded: collapse button */}
          {!collapsed && (
            <button
              type="button"
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
            type="button"
            onClick={() => setMobileOpen(false)}
            className="lg:hidden inline-flex items-center justify-center min-w-[44px] min-h-[44px] rounded-lg text-gray-500 hover:text-white"
            aria-label="Close sidebar"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>

        {/* Nav items */}
        <nav className="flex-1 py-4 overflow-y-auto overflow-x-hidden min-w-0">
          {!collapsed && (pinned.length > 0 || recent.length > 0) && (
            <div className="mb-2">
              {pinned.length > 0 && (
                <div className="mb-2" data-testid="pinned-section">
                  <div className="px-4 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">Pinned</div>
                  {pinned.map((entry) => (
                    <WorkingSetRow key={`pin-${entry.path}`} entry={entry} pinned onTogglePin={() => unpin(entry.path)} onNavigate={() => setMobileOpen(false)} isActive={entry.end ? location.pathname === entry.path : isActive(entry.path)} />
                  ))}
                </div>
              )}
              {recent.length > 0 && (
                <div className="mb-2">
                  <div className="px-4 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">Recent</div>
                  {recent.map((entry) => (
                    <WorkingSetRow key={`recent-${entry.path}`} entry={entry} pinned={false} onTogglePin={() => pin(entry.path)} onNavigate={() => setMobileOpen(false)} isActive={entry.end ? location.pathname === entry.path : isActive(entry.path)} />
                  ))}
                </div>
              )}
              <div className="mx-4 my-2 border-t border-port-border" />
            </div>
          )}
          {resolvedNavItems.map(renderNavItem)}
        </nav>

        {/* Footer with version and notifications */}
        <div className={`border-t border-port-border ${collapsed ? 'lg:flex lg:justify-center lg:p-2 p-4' : 'p-4'}`}>
          <div className={`flex flex-col items-center gap-2 sm:flex-row sm:gap-0 ${collapsed ? 'lg:flex-col lg:justify-center lg:gap-1' : 'sm:justify-between'}`}>
            <span className={`text-sm text-gray-500 ${collapsed ? 'lg:hidden' : ''}`}>
              v{__APP_VERSION__}
            </span>
            <div className={`flex items-center gap-1 ${collapsed ? 'lg:flex-col' : ''}`}>
              <NavLink
                to="/ambient"
                className={`inline-flex items-center justify-center min-w-[44px] min-h-[44px] lg:min-w-0 lg:min-h-0 lg:p-1.5 rounded-lg transition-colors ${collapsed ? 'lg:hidden' : ''} ${
                  isActive('/ambient')
                    ? 'text-port-accent'
                    : 'text-gray-500 hover:text-white'
                }`}
                title="Ambient"
                aria-label="Ambient display"
              >
                <Monitor size={18} />
              </NavLink>
              <ThemeModeToggle />
              <VoiceToggleButton className={collapsed ? 'lg:hidden' : ''} />
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

      {/* Collapsed-sidebar section flyout — fixed-position so it escapes the
          nav scroller's overflow clipping. Opens on hover/focus of a section
          icon when the sidebar is collapsed; lists the section's children so
          siblings (e.g. Writers Room under Create) stay reachable without
          fully expanding the sidebar. */}
      {collapsed && flyoutSection && (() => {
        const item = resolvedNavItems.find((i) => i.label === flyoutSection);
        if (!item || !item.children || item.children.length === 0) return null;
        return (
          <div
            ref={flyoutRef}
            role="menu"
            aria-label={`${item.label} pages`}
            onMouseEnter={cancelCloseFlyout}
            onMouseLeave={scheduleCloseFlyout}
            onFocus={cancelCloseFlyout}
            onBlur={scheduleCloseFlyout}
            style={{ top: flyoutPos.top, left: flyoutPos.left, position: 'fixed', maxHeight: 'calc(100vh - 16px)' }}
            className="hidden lg:block z-[60] min-w-[220px] max-w-[min(320px,calc(100vw-5rem))] overflow-y-auto bg-port-card border border-port-border rounded-lg shadow-2xl py-1"
          >
            <div className="px-3 py-1.5 text-[10px] uppercase text-gray-500 tracking-wider border-b border-port-border mb-1">
              {item.label}
            </div>
            {item.children.map((child, childIndex) => {
              if (child.separator) {
                return <div key={`flyout-sep-${childIndex}`} className="mx-3 my-1 border-t border-port-border" />;
              }
              const ChildIcon = child.icon;
              if (child.external) {
                const childHref = child.dynamicHost
                  ? `${window.location.protocol}//${window.location.hostname}${child.href.replace('//', '')}`
                  : child.href;
                return (
                  <a
                    key={`flyout-${child.href}`}
                    href={childHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    role="menuitem"
                    onClick={() => setFlyoutSection(null)}
                    title={child.label}
                    className="flex items-start justify-between gap-3 px-3 py-2 text-sm text-gray-300 hover:text-white hover:bg-port-border/50 min-w-0"
                  >
                    <div className="flex items-start gap-3 min-w-0">
                      <ChildIcon size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
                      <span className="min-w-0 break-words leading-snug">{child.label}</span>
                    </div>
                    <ExternalLink size={12} className="text-gray-500 shrink-0 mt-0.5" />
                  </a>
                );
              }
              const childActive = child.end
                ? location.pathname === child.to
                : isActive(child.to);
              return (
                <NavLink
                  key={`flyout-${child.to}`}
                  to={child.to}
                  end={child.end}
                  role="menuitem"
                  onClick={() => setFlyoutSection(null)}
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
              );
            })}
          </div>
        );
      })()}

      {/* Main area — print drops the sidebar offset so printed pages aren't shifted right */}
      <div className={`flex-1 flex flex-col min-w-0 max-w-full transition-all duration-300 print:ml-0 ${collapsed ? 'lg:ml-16' : 'lg:ml-64'}`}>
        {/* Mobile header */}
        <header className="lg:hidden flex items-center justify-between px-2 py-1.5 border-b border-port-border bg-port-card print:hidden">
          <button
            onClick={() => setMobileOpen(true)}
            className="inline-flex items-center justify-center min-w-[44px] min-h-[44px] -ml-1 rounded-lg text-gray-400 hover:text-white"
            aria-label="Open navigation menu"
            aria-expanded={mobileOpen}
          >
            <Menu size={20} aria-hidden="true" />
          </button>
          <div className="flex items-center gap-1.5">
            <Logo size={22} className="shrink-0" />
            <span className="font-bold text-sm text-port-accent">PortOS</span>
          </div>
          <div className="flex items-center gap-0.5">
            <NavLink
              to="/ambient"
              className={`inline-flex items-center justify-center min-w-[44px] min-h-[44px] rounded-lg transition-colors ${
                isActive('/ambient')
                  ? 'text-port-accent'
                  : 'text-gray-500 hover:text-white'
              }`}
              aria-label="Ambient display"
            >
              <Monitor size={18} />
            </NavLink>
            <ThemeModeToggle />
            <VoiceToggleButton />
          </div>
        </header>

        {/* Main content */}
        {(() => {
          const isFullWidth = location.pathname === '/character' ||
            location.pathname === '/ai' ||
            location.pathname === '/devtools/flows' ||
            location.pathname === '/ask' ||
            location.pathname.startsWith('/ask/') ||
            location.pathname.startsWith('/calendar') ||
            // Only the Catalog DETAIL editor (/catalog/{type}/{id}) and the
            // Ingest page (/catalog/ingest) are full-width — they own their
            // own scroll. The /catalog list/index page stays scrolling-default.
            location.pathname.startsWith('/catalog/') ||
            location.pathname.startsWith('/cos') ||
            // Both the Creative Director index and its detail editor manage
            // their own internal scroll (flex-col h-full + overflow-auto body),
            // so they need the bare full-width main — same as when they lived
            // under the /media tabs.
            location.pathname.startsWith('/creative-director') ||
            location.pathname.startsWith('/brain') ||
            location.pathname.startsWith('/digital-twin') ||
            location.pathname.startsWith('/feature-agents') ||
            location.pathname.startsWith('/goals') ||
            location.pathname.startsWith('/insights') ||
            location.pathname.startsWith('/meatspace') ||
            location.pathname.startsWith('/media') ||
            location.pathname.startsWith('/messages') ||
            location.pathname.startsWith('/local-llm/') ||
            location.pathname.startsWith('/pipeline/issues/') ||
            location.pathname.startsWith('/pipeline/series/') ||
            location.pathname.startsWith('/post') ||
            location.pathname === '/prompts' ||
            location.pathname === '/review' ||
            location.pathname.startsWith('/settings') ||
            // Round EDITOR (/rounds/:id) and the Learning Guide (/rounds/guide)
            // are full-width and own their own scroll; the bare /rounds index
            // (list + create form) takes the normal padded+scrolling main.
            location.pathname.startsWith('/rounds/') ||
            location.pathname.startsWith('/wiki') ||
            // Only the universe EDITOR (/universes/:id, /universes/new) is
            // full-width — it manages its own scroll. The /universes index
            // (list/table) takes the normal padded+scrolling main, mirroring
            // the Series Pipeline index (/pipeline is not full-width either).
            location.pathname.startsWith('/universes/') ||
            // Story Builder DETAIL (/story-builder/:id/:step) is a full-width
            // stepper that owns its own scroll; the bare /story-builder index
            // (list + create form) takes the normal padded+scrolling main.
            location.pathname.startsWith('/story-builder/') ||
            location.pathname.startsWith('/writers-room') ||
            location.pathname.startsWith('/agents') ||
            location.pathname === '/shell' ||
            location.pathname.startsWith('/shell/') ||
            location.pathname.startsWith('/city') ||
            // Tribe is a full-bleed two-pane page that owns its own internal
            // scroll (PageHeader + a `flex-1 overflow-auto` main); keep it out
            // of the default padded+scrolling main or it double-pads and clips.
            location.pathname === '/tribe' ||
            // Only the App DETAIL editor (/apps/:id, /apps/:id/:tab) is
            // full-width and owns its own scroll; the Add App form
            // (/apps/create) is a plain scrolling page and must stay OUT of
            // full-width, or its content clips below the fold (it has no
            // internal overflow-y-auto container). The trailing (?:\/|$) +
            // create(?:\/|$) lookahead also excludes the trailing-slash URL
            // /apps/create/ (React Router treats it as the same route).
            /^\/apps\/(?!create(?:\/|$))[^/]+(?:\/|$)/.test(location.pathname);
          return (
            <main id="main-content" className={`flex-1 min-h-0 print:overflow-visible print:min-h-0 ${isFullWidth ? 'relative overflow-hidden' : 'overflow-auto p-4 md:p-6'}`}>
              <Outlet />
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
