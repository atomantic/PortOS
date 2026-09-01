import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import { Outlet, NavLink, useLocation, useNavigate } from 'react-router';
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
  Gauge,
  FlaskConical,
  Braces,
  Wrench,
  ExternalLink,
  Crown,
  Play,
  ScrollText,
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
  Orbit,
  Ticket,
  Network,
  Flame,
  BarChart2,
  Monitor,
  Cigarette,
  HeartPulse,
  ClipboardList,
  ListChecks,
  Compass,
  Feather,
  Scale,
  LayoutDashboard,
  Lightbulb,
  GitBranch,
  Link2,
  ListMusic,
  Database,
  Shield,
  ShieldCheck,
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
  Clapperboard,
  PersonStanding,
  Box,
  Boxes,
  Gamepad2,
  Waypoints,
  AtSign,
  Drama,
  UserRound,
  Video
} from 'lucide-react';
// `__APP_VERSION__` is a Vite build-time define (see vite.config.js). Biome does
// not honour ESLint-style "global" block comments, so it is declared in
// biome.jsonc's `javascript.globals` instead.
import { safeReadStorage, safeWriteStorage } from '../lib/safeStorage';
import { TRUSTED_BUNDLE_STAMP, describeBuild } from '../lib/buildStamp.js';
import Logo from './Logo';
import { useErrorNotifications } from '../hooks/useErrorNotifications';
import { useNotifications } from '../hooks/useNotifications';
import { useAgentFeedbackToast } from '../hooks/useAgentFeedbackToast';
import { useOnDemandTaskToast } from '../hooks/useOnDemandTaskToast';
import { useEngagementReminderToast } from '../hooks/useEngagementReminderToast';
import { useSharingNotifications } from '../hooks/useSharingNotifications';
import UpdateBanners from './UpdateBanners';
import SetupBanner from './SetupBanner';
import { useAIStatusNotifications } from '../hooks/useAIStatusNotifications';
import { useNavWorkingSet } from '../hooks/useNavWorkingSet.js';
import { migrateLegacyNavPath } from '../utils/navWorkingSet.js';
import { useInstanceFeatures } from '../hooks/useInstanceFeatures.js';
import { filterNavByFeatures } from '../lib/navFeatures.js';
import { NAV_COMMANDS } from '../../../server/lib/navManifest.js';
import { useSidebarApps } from '../hooks/useSidebarApps.js';
import { useSidebarSeries } from '../hooks/useSidebarSeries.js';
import { useSidebarUniverses } from '../hooks/useSidebarUniverses.js';
import { useThemeContext } from './ThemeContext';
import NotificationDropdown from './NotificationDropdown';
import ThemeSwitcher from './ThemeSwitcher';
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

// `NAV_COMMANDS` owns every structural field shared with the sidebar. This map
// intentionally contains presentation only: giving a manifest path an icon is
// what opts that destination into the sidebar. External and runtime-hydrated
// rows have no manifest destination and stay explicitly local below.
export const NAV_PRESENTATION = {
  '/': { icon: Home, single: true },
  '/review': { icon: ClipboardList, single: true },
  '/eidoverse': { icon: Orbit, single: true },
  '/apps': { icon: Package, dynamic: 'apps' },
  '/brain/config': { icon: Settings },
  '/brain/daily-log': { icon: NotebookPen },
  '/brain/digest': { icon: Calendar },
  '/brain/feeds': { icon: Rss },
  '/brain/graph': { icon: Network },
  '/brain/ideas': { icon: Lightbulb },
  '/brain/import': { icon: Upload },
  '/brain/inbox': { icon: MessageSquare },
  '/brain/links': { icon: Link2 },
  '/brain/memory': { icon: Database },
  '/brain/notes': { icon: FileText },
  '/brain/spotify': { icon: Music },
  '/brain/youtube': { icon: Video },
  '/rapid-reader': { icon: Zap },
  '/songbook': { icon: ListMusic },
  '/timeline': { icon: CalendarClock },
  '/tribe': { icon: Users },
  '/brain/trust': { icon: Shield },
  '/wiki/overview': { icon: BookOpen },
  '/calendar/agenda': { icon: CalendarDays },
  '/calendar/config': { icon: Settings },
  '/calendar/day': { icon: Calendar },
  '/calendar/lifetime': { icon: Clock },
  '/calendar/month': { icon: CalendarDays },
  '/calendar/review': { icon: ClipboardList },
  '/calendar/sync': { icon: RefreshCw },
  '/calendar/week': { icon: CalendarDays },
  '/cos/agents': { icon: Cpu },
  '/cos/briefing': { icon: Newspaper },
  '/cos/config': { icon: Settings },
  '/cos/digest': { icon: Calendar },
  '/feature-agents': { icon: Wand2 },
  '/cos/gsd': { icon: Compass },
  '/cos/health': { icon: Activity },
  '/cos/learning': { icon: GraduationCap },
  '/cos/memory': { icon: Brain },
  '/cos/mind': { icon: MessageSquare },
  '/cos/run-events': { icon: ScrollText },
  '/cos/runs': { icon: Play },
  '/cos/schedule': { icon: Clock },
  '/agents': { icon: Users },
  '/cos/productivity': { icon: BarChart2 },
  '/cos/jobs': { icon: Bot },
  '/cos/tasks': { icon: FileText },
  '/cos/workflow': { icon: ChartGantt },
  '/messages/config': { icon: Settings },
  '/messages/contacts': { icon: Users },
  '/messages/drafts': { icon: FilePen },
  '/messages/imessage': { icon: MessageSquare },
  '/messages/inbox': { icon: Inbox },
  '/messages/signal': { icon: MessageSquare },
  '/stacker-news': { icon: Newspaper },
  '/messages/sync': { icon: RefreshCw },
  '/x': { icon: AtSign },
  '/3d': { icon: Boxes },
  '/authors': { icon: FilePen },
  '/catalog': { icon: Sparkles },
  '/creative-commission': { icon: CalendarClock },
  '/creative-director': { icon: Clapperboard },
  '/pipeline/editorial-checks': { icon: ListChecks },
  '/fableloom': { icon: Waypoints },
  '/game': { icon: Gamepad2 },
  '/importer': { icon: FileInput },
  '/media': { icon: Layers },
  '/mood-boards': { icon: Palette },
  '/music': { icon: Mic },
  '/music-video': { icon: Music },
  '/rounds': { icon: Music },
  '/pipeline': { icon: WorkflowIcon, dynamic: 'pipelineSeries' },
  '/sharing': { icon: Share2 },
  '/sprites': { icon: PersonStanding },
  '/start-story': { icon: Rocket },
  '/story-builder': { icon: Wand2 },
  '/media/threejs': { icon: Box },
  '/universes': { icon: Globe, dynamic: 'universes' },
  '/writers-room': { icon: NotebookPen },
  '/devtools/agents': { icon: Cpu },
  '/ambient': { icon: Sparkles },
  '/browser': { icon: Globe },
  '/capabilities': { icon: Compass },
  '/devtools/runner': { icon: Code2 },
  '/data': { icon: HardDrive },
  '/devtools/datadog': { icon: Dog },
  '/devtools/flows': { icon: WorkflowIcon },
  '/devtools/github': { icon: GitBranch },
  '/devtools/history': { icon: History },
  '/devtools/image-clean': { icon: Eraser },
  '/instances': { icon: Network },
  '/devtools/jira': { icon: Ticket },
  '/devtools/jira/reports': { icon: FileText },
  '/loops': { icon: RefreshCw },
  '/devtools/processes': { icon: Activity },
  '/devtools/quota-burn': { icon: Flame },
  '/security': { icon: Camera },
  '/shell': { icon: SquareTerminal },
  '/system-resources': { icon: Activity },
  '/uploads': { icon: Upload },
  '/devtools/usage': { icon: BarChart3 },
  '/devtools/video-download': { icon: Film },
  '/workspace-contexts': { icon: Layers },
  '/goals/list': { icon: Target, single: true },
  '/meatspace/age': { icon: Clock },
  '/meatspace/alcohol': { icon: Activity },
  '/meatspace/blood': { icon: HeartPulse },
  '/meatspace/body': { icon: Scale },
  '/meatspace/health': { icon: Heart },
  '/meatspace/export': { icon: FileText },
  '/meatspace/genome': { icon: Dna },
  '/meatspace/lifestyle': { icon: ClipboardList },
  '/meatspace/nicotine': { icon: Cigarette },
  '/meatspace/overview': { icon: Activity },
  '/meatspace/settings': { icon: Settings },
  '/models/3d': { icon: Boxes },
  '/models/embeddings': { icon: Braces },
  '/models/llms': { icon: Cpu },
  '/models/loras': { icon: Sparkles },
  '/models/media': { icon: HardDrive },
  '/models/performance': { icon: Gauge },
  '/local-llm/playground': { icon: FlaskConical },
  '/models/status': { icon: Activity },
  '/models/training': { icon: GraduationCap },
  '/settings/ai-assignments': { icon: Bot },
  '/settings/api-access': { icon: Globe },
  '/api-reference/catalog': { icon: Braces },
  '/settings/autofixer': { icon: Wrench },
  '/settings/backup': { icon: Download },
  '/settings/code-reviewers': { icon: ShieldCheck },
  '/settings/database': { icon: Database },
  '/settings/features': { icon: ListChecks },
  '/settings/general': { icon: Settings },
  '/settings/mortalloom': { icon: Activity },
  '/openclaw': { icon: MessagesSquare },
  '/prompts': { icon: FileText },
  '/ai': { icon: Bot },
  '/settings/security': { icon: Lock },
  '/settings/sharing': { icon: Share2 },
  '/settings/telegram': { icon: MessageSquare },
  '/settings/voice': { icon: Mic },
  '/digital-twin/accounts': { icon: Globe },
  '/digital-twin/appearance': { icon: Camera },
  '/ask': { icon: MessageCircle },
  '/digital-twin/autobiography': { icon: PenLine },
  '/digital-twin/avatar-bio': { icon: UserRound },
  '/character': { icon: Swords },
  '/digital-twin/documents': { icon: FileText },
  '/digital-twin/enrich': { icon: Sparkles },
  '/digital-twin/export': { icon: Download },
  '/digital-twin/goals': { icon: Target },
  '/digital-twin/identity': { icon: Fingerprint },
  '/digital-twin/import': { icon: Upload },
  '/insights/overview': { icon: Lightbulb },
  '/digital-twin/interview': { icon: MessageSquare },
  '/digital-twin/legacy': { icon: Package },
  '/digital-twin/overview': { icon: Heart },
  '/digital-twin/personality': { icon: Brain },
  '/digital-twin/personas': { icon: Drama },
  '/privacy/overview': { icon: Shield },
  '/digital-twin/taste': { icon: Palette },
  '/digital-twin/test': { icon: CheckCircle },
  '/digital-twin/time-capsule': { icon: Archive },
  '/digital-twin/voice': { icon: Mic },
  '/post/config': { icon: Settings },
  '/post/explore': { icon: Compass },
  '/post/history': { icon: History },
  '/post/launcher': { icon: Play },
  '/post/memory': { icon: Brain },
  '/post/morse': { icon: Radio },
  '/post/plan': { icon: ListChecks },
  '/post/progress': { icon: TrendingUp },
  '/post/rhetoric': { icon: Feather },
  '/post/wordplay': { icon: MessageCircle },
};

const SECTION_PRESENTATION = {
  Brain: { icon: Brain, defaultTo: '/brain/inbox' },
  Calendar: { icon: CalendarDays },
  'Chief of Staff': { icon: Crown, defaultTo: '/cos/tasks', showBadge: true },
  Comms: { icon: MessagesSquare, defaultTo: '/messages/inbox' },
  Create: { icon: Sparkles, defaultTo: '/media' },
  'Dev Tools': { icon: Terminal },
  Health: { icon: Heart, defaultTo: '/meatspace/overview' },
  Models: { icon: Cpu, defaultTo: '/models/llms' },
  Settings: { icon: Settings, defaultTo: '/settings/general' },
  Identity: { icon: Fingerprint, defaultTo: '/digital-twin/overview' },
  POST: { icon: Zap, defaultTo: '/post/launcher' },
};

const SECTION_ORDER = [
  'Brain', 'Calendar', 'Chief of Staff', 'Comms', 'Create', 'Dev Tools',
  'Health', 'Models', 'Settings', 'Identity', 'POST',
];

// These rows have no PortOS route, so a NAV_COMMANDS entry would be dishonest.
// Keep them visibly marked as local-only instead of smuggling structural route
// data back into the presentation map.
const LOCAL_SECTION_ROWS = {
  'Dev Tools': [
    { href: '//:5560', label: 'Autofixer', icon: Wrench, external: true, dynamicHost: true, localOnly: true },
  ],
};

const commandByPath = new Map();
for (const command of NAV_COMMANDS) {
  if (!commandByPath.has(command.path)) commandByPath.set(command.path, command);
}

const navRowForPath = (path) => {
  const command = commandByPath.get(path);
  if (!command) throw new Error(`Layout: NAV_PRESENTATION path has no NAV_COMMANDS entry: ${path}`);
  return {
    to: command.path,
    label: command.label,
    section: command.section,
    feature: command.feature,
    ...NAV_PRESENTATION[path],
  };
};

const presentedNavRows = Object.keys(NAV_PRESENTATION).map(navRowForPath);

const sectionNavItem = (section) => {
  const children = presentedNavRows
    .filter((row) => row.section === section && !row.single)
    .concat(LOCAL_SECTION_ROWS[section] || [])
    .sort((a, b) => a.label.localeCompare(b.label));
  const sharedFeature = children[0]?.feature
    && children.every((child) => child.feature === children[0].feature)
    ? children[0].feature
    : undefined;
  return { label: section, feature: sharedFeature, children, ...SECTION_PRESENTATION[section] };
};

const mainRows = ['/', '/review', '/eidoverse'].map(navRowForPath);
const appsCommand = navRowForPath('/apps');
const goalsRow = navRowForPath('/goals/list');
const sectionRows = Object.fromEntries(SECTION_ORDER.map((section) => [section, sectionNavItem(section)]));

const navItems = [
  ...mainRows,
  { separator: true, localOnly: true },
  { ...appsCommand, dynamic: 'apps', defaultTo: appsCommand.to, children: [] },
  ...SECTION_ORDER.slice(0, 6).map((section) => sectionRows[section]),
  goalsRow,
  ...SECTION_ORDER.slice(6, 9).map((section) => sectionRows[section]),
  { moreLabel: true, localOnly: true },
  ...SECTION_ORDER.slice(9).map((section) => sectionRows[section]),
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
      className={`inline-flex min-w-[44px] min-h-[44px] items-center justify-center rounded-lg hover:bg-port-border/50 lg:min-w-0 lg:min-h-0 lg:px-2 lg:py-1.5 ${pinned ? 'text-port-accent' : 'text-gray-500 opacity-40 [@media(hover:hover)]:sm:opacity-0 [@media(hover:hover)]:sm:group-hover:opacity-100 group-focus-within:opacity-100'}`}
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
    <div className="group relative mx-2 min-w-0 min-h-[44px] lg:min-h-0">
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

// A top-level *single* nav row (Dashboard / Review Hub / Eidoverse / Goals). Unlike a
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
    <div className={`group relative min-w-0 mx-2 min-h-[44px] lg:min-h-0 ${collapsed ? 'lg:flex lg:justify-center' : ''}`}>
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
              <span className="absolute -top-1.5 -right-1.5 min-w-[14px] h-[14px] flex items-center justify-center text-[9px] font-bold rounded-full bg-port-warning text-port-on-warning px-0.5">
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
          <span className="min-w-[18px] h-[18px] flex items-center justify-center text-[10px] font-bold rounded-full bg-port-warning text-port-on-warning px-1 shrink-0 mt-0.5">
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

// Routes whose main content owns its own internal scroll region and needs the
// bare full-width `<main>` (relative overflow-hidden) instead of the default
// padded+scrolling one. Checked in order: exact path, then prefix, then
// regex — see `isFullWidthRoute` below.
const EXACT_FULL_WIDTH_PATHS = [
  '/character',
  '/eidoverse',
  '/ai',
  // Data Manager is a bordered title bar over a `flex-1 overflow-auto` body,
  // so it owns its own scroll. EXACT, not a prefix — a `/data` prefix would
  // also swallow the `/datadog` redirect route.
  '/data',
  '/devtools/flows',
  '/ask',
  // OpenClaw lives under the Settings nav group; it's a full-bleed
  // chat surface (sidebar + message pane) that owns its own internal
  // scroll, so it needs the bare full-width main like the other
  // Settings pages (/ai, /prompts, /settings/*).
  '/openclaw',
  '/prompts',
  '/review',
  '/shell',
  // Tribe is a full-bleed two-pane page that owns its own internal
  // scroll (PageHeader + a `flex-1 overflow-auto` main); keep it out
  // of the default padded+scrolling main or it double-pads and clips.
  '/tribe',
  // Rapid Reader is a full-bleed brain sub-page: full-width PageHeader
  // over an internal `flex-1 overflow-auto` scroll region.
  '/rapid-reader',
  // Timeline (/timeline and /timeline/:date) is a full-bleed brain
  // sub-page: full-width PageHeader over an internal `flex-1
  // overflow-auto` scroll region that wraps the centered max-w-4xl
  // content — keep it out of the default padded main or it double-pads.
  '/timeline',
];

const FULL_WIDTH_PATH_PREFIXES = [
  '/ask/',
  '/calendar',
  // Only the Catalog DETAIL editor (/catalog/{type}/{id}) and the
  // Ingest page (/catalog/ingest) are full-width — they own their
  // own scroll. The /catalog list/index page stays scrolling-default.
  '/catalog/',
  '/cos',
  // Both the Creative Director index and its detail editor manage
  // their own internal scroll (flex-col h-full + overflow-auto body),
  // so they need the bare full-width main — same as when they lived
  // under the /media tabs.
  '/creative-director',
  '/brain',
  '/digital-twin',
  '/feature-agents',
  '/goals',
  '/insights',
  '/meatspace',
  '/media',
  '/messages',
  '/local-llm/',
  '/pipeline/issues/',
  '/pipeline/series/',
  '/post',
  // Models mirrors Settings: PageHeader + TabPills over a `flex-1 overflow-auto`
  // body, so the page owns its own scroll. Without this it nests inside the
  // padded scrolling main and the inner `h-full` clips below the fold.
  '/models',
  '/api-reference',
  '/settings',
  // Round EDITOR (/rounds/:id) and the Learning Guide (/rounds/guide)
  // are full-width and own their own scroll; the bare /rounds index
  // (list + create form) takes the normal padded+scrolling main.
  '/rounds/',
  '/wiki',
  // Only the universe EDITOR (/universes/:id, /universes/new) is
  // full-width — it manages its own scroll. The /universes index
  // (list/table) takes the normal padded+scrolling main, mirroring
  // the Series Pipeline index (/pipeline is not full-width either).
  '/universes/',
  // Story Builder DETAIL (/story-builder/:id/:step) is a full-width
  // stepper that owns its own scroll; the bare /story-builder index
  // (list + create form) takes the normal padded+scrolling main.
  '/story-builder/',
  // FableLoom EDITOR (/fableloom/:loomId/...) is a full-width canvas that
  // owns its own scroll; the bare /fableloom index takes the normal
  // padded+scrolling main.
  '/fableloom/',
  // The AI Providers editor is a drawer over the same page (/ai/new,
  // /ai/:providerId), so its sub-routes need the bare full-width main the
  // bare /ai index gets from EXACT_FULL_WIDTH_PATHS above — without it the
  // page's own `flex-1 overflow-auto` body sits inside a padded, scrolling
  // main and double-pads.
  '/ai/',
  '/writers-room',
  '/agents',
  '/shell/',
  '/timeline/',
  // Every SongBook route — index (/songbook), import (/songbook/import),
  // and viewer (/songbook/:id) — is full-bleed and owns its own scroll
  // (flex-col h-full + an internal overflow-auto region; the viewer adds
  // its autoscroll container). They share the standard bordered
  // PageHeader bar over that scroll region.
  '/songbook',
];

const FULL_WIDTH_PATH_REGEXES = [
  // Music mirrors the Media Gen page shell: title bar + tabs over a separately
  // scrolling body. Keep this boundary-specific so `/music-video` retains its
  // own route classification.
  /^\/music(?:\/|$)/,
  // Only Game DETAIL workspaces own an internal scroll region; the
  // bare /game index stays on the normal padded page layout.
  /^\/game\/[^/]+\/?$/,
  // Only the App DETAIL editor (/apps/:id, /apps/:id/:tab) is
  // full-width and owns its own scroll; the Add App form
  // (/apps/create) is a plain scrolling page and must stay OUT of
  // full-width, or its content clips below the fold (it has no
  // internal overflow-y-auto container). The trailing (?:\/|$) +
  // create(?:\/|$) lookahead also excludes the trailing-slash URL
  // /apps/create/ (React Router treats it as the same route).
  /^\/apps\/(?!create(?:\/|$))[^/]+(?:\/|$)/,
];

// Exported for the table-driven regression test in Layout.test.jsx — the 41
// classification rules above have no other coverage, and a dropped or retyped
// entry silently changes a page's layout.
export function isFullWidthRoute(pathname) {
  return EXACT_FULL_WIDTH_PATHS.includes(pathname) ||
    FULL_WIDTH_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ||
    FULL_WIDTH_PATH_REGEXES.some((re) => re.test(pathname));
}

export default function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(() => safeReadStorage(SIDEBAR_KEY) === 'true');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [expandedSections, setExpandedSections] = useState({});
  const [expandedSubSections, setExpandedSubSections] = useState({});
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

  // Toast once per tab/day when deterministic product metrics identify a POST
  // exercise or creative commission feedback action needing attention.
  useEngagementReminderToast();

  // Live AI operation status (model loads, "calling LM Studio…", etc.)
  useAIStatusNotifications();

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
  // Optional features the user turned off in Settings > Features drop out of the
  // sidebar entirely (their routes keep working for a direct link/bookmark).
  const { isFeatureEnabled } = useInstanceFeatures();
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

  // Manifest-only paths still honour the feature gate, so a row pinned before the
  // user disabled its feature stops resolving into Pinned/Recent too.
  const manifestEntryByPath = useMemo(() => {
    const map = new Map();
    filterNavByFeatures(manifestNav, isFeatureEnabled).forEach((c) => {
      if (c?.path && !map.has(c.path)) map.set(c.path, { path: c.path, label: c.label, icon: Navigation });
    });
    return map;
  }, [manifestNav, isFeatureEnabled]);

  useEffect(() => {
    safeWriteStorage(SIDEBAR_KEY, String(collapsed));
  }, [collapsed]);

  // Build dynamic nav items with app children + pipeline series.
  // `decoratePipelineChild` is defined inside the memo so its closure over
  // `pipelineSeries` doesn't require a lint suppression, and so it isn't
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
    // Feature gate, applied before any decoration: a disabled feature drops its
    // whole section (POST) or just its tagged rows (DataDog, JIRA), and a
    // section left with no navigable child disappears with them. Sections that
    // lose nothing keep their identity so the memo below doesn't reallocate.
    const gatedItems = navItems.flatMap((item) => {
      if (!isFeatureEnabled(item.feature)) return [];
      if (!Array.isArray(item.children)) return [item];
      const children = item.children.filter((child) => isFeatureEnabled(child.feature));
      if (children.length === item.children.length) return [item];
      const navigable = item.dynamic || children.some((child) => child.to || child.href);
      return navigable ? [{ ...item, children }] : [];
    });

    return gatedItems.map((item) => {
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
  }, [sidebarApps, pipelineSeries, universes, isFeatureEnabled]);

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

  // Stored Pinned/Recent paths outlive the routes they were saved from. When a
  // page MOVES, its old path stops matching anything here and the row silently
  // renders nothing — so a miss falls back through the manifest's `previousPaths`
  // to where the page lives now, and the entry carries that CURRENT path so the
  // row navigates (and unpins) by it. Resolution is where this belongs rather
  // than a rewrite-on-read: a path that resolves to nothing is left untouched,
  // which matters because the dynamic app/series/universe rows load async and
  // "unresolvable" is a normal transient state during boot.
  const resolveNavEntry = useCallback(
    (path) => {
      const direct = navEntryByPath.get(path) || manifestEntryByPath.get(path);
      if (direct) return direct;
      const current = migrateLegacyNavPath(path, manifestNav);
      if (current === path) return null;
      return navEntryByPath.get(current) || manifestEntryByPath.get(current) || null;
    },
    [navEntryByPath, manifestEntryByPath, manifestNav],
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
        item.children.forEach(child => {
          const grandChildren = Array.isArray(child.grandChildren) ? child.grandChildren : [];
          if (grandChildren.some(grandChild => {
            const prefix = grandChild.activePathPrefix || grandChild.to;
            return location.pathname === prefix || location.pathname.startsWith(prefix + '/');
          })) {
            setExpandedSubSections(prev => ({ ...prev, [child.to]: true }));
          }
        });
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

  const toggleSubSection = (path) => {
    setExpandedSubSections(prev => ({
      ...prev,
      [path]: prev[path] === false,
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

  // The persisted collapsed preference only applies to the desktop rail. On
  // mobile, opening the sidebar always gives the user the expanded navigation
  // so section children remain directly reachable.
  const sidebarCollapsed = collapsed && !mobileOpen;

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
            sidebarCollapsed ? 'lg:justify-center lg:px-2' : 'justify-between'
          } text-gray-400 hover:text-white hover:bg-port-border/50`}
          title={item.label}
        >
          <div className="flex items-start gap-3 min-w-0">
            <Icon size={20} className="shrink-0" />
            <span className={`min-w-0 break-words leading-snug ${sidebarCollapsed ? 'lg:hidden' : ''}`}>
              {item.label}
            </span>
          </div>
          {!sidebarCollapsed && <ExternalLink size={14} className="text-gray-500 shrink-0 mt-0.5" />}
        </a>
      );
    }

    if (item.single) {
      const singlePinned = isPinned(item.to);
      return (
        <SingleNavRow
          key={item.to}
          item={item}
          collapsed={sidebarCollapsed}
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
        if (!expandedSections[item.label] && !sidebarCollapsed) {
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

    const hasChildrenForFlyout = sidebarCollapsed && Array.isArray(item.children) && item.children.length > 0;

    return (
      <div key={item.label} className="mx-2 min-w-0">
        <div
          className={`flex items-stretch min-w-0 ${sidebarCollapsed ? 'lg:justify-center' : ''}`}
          onMouseEnter={hasChildrenForFlyout ? (e) => openFlyout(e, item.label) : undefined}
          onMouseLeave={hasChildrenForFlyout ? scheduleCloseFlyout : undefined}
          onFocus={hasChildrenForFlyout ? (e) => openFlyout(e, item.label) : undefined}
          onBlur={hasChildrenForFlyout ? scheduleCloseFlyout : undefined}
        >
          <button
            type="button"
            onClick={navigateToSection}
            className={`flex-1 min-w-0 ${sectionRowClasses} ${sidebarCollapsed ? 'lg:justify-center lg:px-2' : 'justify-between'}`}
            title={sidebarCollapsed ? item.label : undefined}
            aria-haspopup={hasChildrenForFlyout ? 'menu' : undefined}
            aria-expanded={hasChildrenForFlyout ? flyoutSection === item.label : undefined}
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="relative">
                <Icon size={20} className="shrink-0" />
                {item.showBadge && unreadCount > 0 && sidebarCollapsed && (
                  <span className="absolute -top-1.5 -right-1.5 min-w-[14px] h-[14px] flex items-center justify-center text-[9px] font-bold rounded-full bg-port-warning text-port-on-warning px-0.5">
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                )}
              </div>
              <span className={`min-w-0 break-words leading-snug ${sidebarCollapsed ? 'lg:hidden' : ''}`}>
                {item.label}
              </span>
            </div>
            {!sidebarCollapsed && item.showBadge && unreadCount > 0 && (
              <span className="min-w-[18px] h-[18px] flex items-center justify-center text-[10px] font-bold rounded-full bg-port-warning text-port-on-warning px-1 shrink-0">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </button>
          {!sidebarCollapsed && (
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
        {expandedSections[item.label] && !sidebarCollapsed && (
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
              const grandChildrenExpanded = expandedSubSections[child.to] !== false;
              const childIsPinned = isPinned(child.to);
              return (
                <div key={child.to} className="min-w-0">
                  <div className="flex items-center min-w-0">
                    <div className="min-w-0 flex-1">
                      <WorkingSetRow
                        entry={{ path: child.to, label: child.label, icon: ChildIcon, end: child.end }}
                        pinned={childIsPinned}
                        onTogglePin={() => (childIsPinned ? unpin(child.to) : pin(child.to))}
                        onNavigate={() => setMobileOpen(false)}
                        isActive={childActive}
                      />
                    </div>
                    {grandChildren.length > 0 && (
                      <button
                        type="button"
                        aria-label={grandChildrenExpanded ? `Collapse ${child.label}` : `Expand ${child.label}`}
                        aria-expanded={grandChildrenExpanded}
                        onClick={() => toggleSubSection(child.to)}
                        className="px-2 py-2 text-gray-500 hover:text-white hover:bg-port-border/50 rounded-lg"
                      >
                        {grandChildrenExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                    )}
                  </div>
                  {grandChildren.length > 0 && grandChildrenExpanded && (
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
            <span
              className={`text-sm text-gray-500 ${collapsed ? 'lg:hidden' : ''}`}
              // The version is identical across every development commit (it
              // reflects the last RELEASE), so hovering it gives the one fact it
              // cannot carry: which commit is actually running (#4694). This is
              // the zero-navigation surface — the full read-out, including
              // bundle/server drift, is on /system-resources/overview.
              // TRUSTED_, not BUNDLE_: under `npm run dev` the Vite define is
              // frozen at dev-server start while HMR serves every commit since,
              // so a tooltip there would confidently report the wrong commit.
              title={TRUSTED_BUNDLE_STAMP ? `v${__APP_VERSION__} · ${describeBuild(TRUSTED_BUNDLE_STAMP) ?? 'commit unknown'}` : undefined}
            >
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
              <ThemeSwitcher className={collapsed ? 'lg:hidden' : ''} />
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
            style={{ top: flyoutPos.top, left: flyoutPos.left, position: 'fixed', '--dvh-inset': '16px' }}
            className="hidden lg:block z-[60] min-w-[220px] max-w-[min(320px,calc(100vw-5rem))] max-h-dvh-cap overflow-y-auto bg-port-card border border-port-border rounded-lg shadow-2xl py-1"
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
            <ThemeSwitcher position="below" />
            <VoiceToggleButton />
          </div>
        </header>

        {/* Update, out-of-sync, and essential-setup advisories — inline (document flow) so they
            push the page instead of covering a bottom-anchored composer (#3786) */}
        <UpdateBanners />
        <SetupBanner />

        {/* Main content */}
        {(() => {
          const isFullWidth = isFullWidthRoute(location.pathname);
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
