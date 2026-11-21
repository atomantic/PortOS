import { useState, useEffect, useMemo, useRef, useCallback, useId } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router';
import {
  Brain, CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Cpu, Crown, ExternalLink,
  Fingerprint, Heart, LayoutDashboard, MessagesSquare, Navigation, Package, Pin, PinOff,
  Search, Settings, Sparkles, Terminal, Wrench, Zap,
} from 'lucide-react';
import useFocusTrap from '../hooks/useFocusTrap.js';
import { TRUSTED_BUNDLE_STAMP, describeBuild } from '../lib/buildStamp.js';
import { useNavWorkingSet, useResolvedNavWorkingSet } from '../hooks/useNavWorkingSet.js';
import { migrateLegacyNavPath } from '../utils/navWorkingSet.js';
import { useInstanceFeatures } from '../hooks/useInstanceFeatures.js';
import { filterNavByFeatures } from '../lib/navFeatures.js';
import {
  NAV_PRESENTATION,
  SECTIONS_BEFORE_GOALS,
  SECTIONS_AFTER_GOALS,
  SECTIONS_BELOW_MORE,
} from '../lib/navPresentation.js';
import { PORTS } from '../lib/ports.js';
import { getNavCommandForPath, getSectionNavGroups, getSectionNavTabForPath, NAV_COMMANDS, SECTION_FEATURE } from '../../../server/lib/navManifest.js';
import { useSidebarApps } from '../hooks/useSidebarApps.js';
import { useSidebarMusicVideos } from '../hooks/useSidebarMusicVideos.js';
import { useSidebarSeries } from '../hooks/useSidebarSeries.js';
import { useSidebarUniverses } from '../hooks/useSidebarUniverses.js';
import { openCmdKSearch } from '../hooks/useCmdKSearch.js';
import Logo from './Logo';
import { NotificationBell } from './NotificationBell.jsx';
import SidebarFlyout from './SidebarFlyout.jsx';
import ThemeModeToggle from './ThemeModeToggle.jsx';
import ThemeSwitcher from './ThemeSwitcher';
import VoiceToggleButton from './voice/VoiceToggleButton';

const SECTION_PRESENTATION = {
  Brain: { icon: Brain, defaultTo: '/brain/inbox' },
  Calendar: { icon: CalendarDays, defaultTo: '/calendar/agenda' },
  'Chief of Staff': { icon: Crown, defaultTo: '/cos/tasks' },
  Comms: { icon: MessagesSquare, defaultTo: '/messages/inbox' },
  Create: { icon: Sparkles, defaultTo: '/create/media' },
  'Dev Tools': { icon: Terminal },
  Health: { icon: Heart, defaultTo: '/meatspace/overview' },
  Models: { icon: Cpu, defaultTo: '/models/llms' },
  Settings: { icon: Settings, defaultTo: '/settings/general' },
  Identity: { icon: Fingerprint, defaultTo: '/digital-twin/overview' },
  POST: { icon: Zap, defaultTo: '/post/launcher' },
};


const SECTION_ORDER = [...SECTIONS_BEFORE_GOALS, ...SECTIONS_AFTER_GOALS, ...SECTIONS_BELOW_MORE];

// These rows have no PortOS route, so a NAV_COMMANDS entry would be dishonest.
// Keep them visibly marked as local-only instead of smuggling structural route
// data back into the presentation map.
const LOCAL_SECTION_ROWS = {
  'Dev Tools': [
    { href: `//:${PORTS.AUTOFIXER_UI}`, label: 'Autofixer', icon: Wrench, external: true, dynamicHost: true, localOnly: true },
  ],
};

const commandByPath = new Map();
for (const command of NAV_COMMANDS) {
  if (!commandByPath.has(command.path)) commandByPath.set(command.path, command);
}

const navRowForPath = (path) => {
  const command = commandByPath.get(path);
  if (!command) throw new Error(`SidebarNav: NAV_PRESENTATION path has no NAV_COMMANDS entry: ${path}`);
  return {
    to: command.path,
    label: command.label,
    section: command.section,
    feature: command.feature,
    ...(command.navGroup ? { navGroup: command.navGroup } : {}),
    // A dynamic row keeps its own record-list grandchildren, so it stays at
    // section level even when its manifest entry names a hub parent.
    ...(command.parentPath && !NAV_PRESENTATION[path].dynamic ? { parentPath: command.parentPath } : {}),
    ...NAV_PRESENTATION[path],
  };
};

const presentedNavRows = Object.keys(NAV_PRESENTATION).map(navRowForPath);

// A hub can own several route prefixes when its records have legacy URLs.
const activePrefixesByPath = new Map(presentedNavRows.map((row) =>
  [row.to, row.activePathPrefixes || [row.activePathPrefix || row.to]]));
const pathWithinRow = (pathname, rowPath) => (
  (activePrefixesByPath.get(rowPath) || [rowPath]).some((prefix) =>
    pathname === prefix || pathname.startsWith(prefix + '/'))
);

const sectionNavItem = (section) => {
  const children = presentedNavRows
    .filter((row) => row.section === section && !row.single && !row.parentPath)
    .concat(LOCAL_SECTION_ROWS[section] || [])
    .sort((a, b) => a.label.localeCompare(b.label));
  const childByPath = new Map(children.filter((child) => child.to).map((child) => [child.to, child]));
  const tabGroups = getSectionNavGroups(section)
    .map((group) => ({ ...group, children: group.tabs.map((tab) => childByPath.get(tab.to)).filter(Boolean) }))
    .filter((group) => group.children.length > 0);
  // A grouped section still lists its rows that belong to no group, first and
  // without a heading, so adding groups can never hide a destination.
  const groupedChildren = new Set(tabGroups.flatMap((group) => group.children));
  const ungrouped = children.filter((child) => !groupedChildren.has(child));
  const groups = tabGroups.length > 0 && ungrouped.length > 0
    ? [{ label: '', children: ungrouped }, ...tabGroups]
    : tabGroups;
  return { label: section, feature: SECTION_FEATURE.get(section), children, groups, ...SECTION_PRESENTATION[section] };
};

const mainRows = ['/', '/review', '/eidoverse'].map(navRowForPath);
const appsCommand = navRowForPath('/apps');
const goalsRow = navRowForPath('/goals/list');
const sectionRows = Object.fromEntries(SECTION_ORDER.map((section) => [section, sectionNavItem(section)]));

const navItems = [
  ...mainRows,
  { separator: true, localOnly: true },
  { ...appsCommand, dynamic: 'apps', defaultTo: appsCommand.to, children: [] },
  ...SECTIONS_BEFORE_GOALS.map((section) => sectionRows[section]),
  goalsRow,
  ...SECTIONS_AFTER_GOALS.map((section) => sectionRows[section]),
  { moreLabel: true, localOnly: true },
  ...SECTIONS_BELOW_MORE.map((section) => sectionRows[section]),
];

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
      className={`inline-flex min-w-[44px] min-h-[44px] items-center justify-center rounded-lg hover:bg-port-border/50 pointer-fine:lg:min-w-0 pointer-fine:lg:min-h-0 lg:px-2 lg:py-1.5 ${pinned ? 'text-port-accent' : 'text-gray-500 opacity-40 [@media(hover:hover)]:sm:opacity-0 [@media(hover:hover)]:sm:group-hover:opacity-100 group-focus-within:opacity-100'}`}
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
    <div className="group relative mx-2 min-w-0 min-h-[44px] pointer-fine:lg:min-h-0">
      <NavLink
        to={entry.path}
        end={entry.end}
        onClick={onNavigate}
        title={entry.label}
        className={`flex items-center min-h-[44px] lg:min-h-0 pointer-coarse:min-h-11 gap-3 px-3 py-2 pr-9 rounded-lg text-sm transition-colors min-w-0 ${
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
// carries the heavier top-level row weight and the collapsed-rail layout
// (icon-only, centered). When expanded it also exposes the same hover/focus
// pin/unpin affordance as WorkingSetRow so these destinations can be pinned too;
// the pin button is omitted in the collapsed rail, mirroring the Pinned/Recent
// sections which only render when the sidebar is expanded.
export function SingleNavRow({ item, collapsed, active, pinned, onTogglePin, onNavigate }) {
  const Icon = item.icon;
  return (
    <div className={`group relative min-w-0 mx-2 min-h-[44px] pointer-fine:lg:min-h-0 ${collapsed ? 'lg:flex lg:justify-center' : ''}`}>
      <NavLink
        to={item.to}
        end={item.to === '/'}
        onClick={onNavigate}
        className={`flex items-center min-h-[44px] lg:min-h-0 pointer-coarse:min-h-11 gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors min-w-0 ${
          collapsed ? 'lg:justify-center lg:px-2' : 'pr-9'
        } ${
          active
            ? 'bg-port-accent/10 text-port-accent'
            : 'text-gray-400 hover:text-white hover:bg-port-border/50'
        }`}
        title={item.label}
        aria-label={collapsed ? item.label : undefined}
      >
        <div className="flex items-start gap-3 min-w-0 flex-1">
          <Icon size={20} className="shrink-0" />
          <span className={`min-w-0 break-words leading-snug ${collapsed ? 'lg:hidden' : ''}`}>
            {item.label}
          </span>
        </div>
      </NavLink>
      {!collapsed && (
        <div className="absolute right-0 top-0 bottom-0 flex items-center">
          <PinButton label={item.label} pinned={pinned} onTogglePin={onTogglePin} />
        </div>
      )}
    </div>
  );
}

const DYNAMIC_ROWS = {
  pipelineSeries: { basePath: '/pipeline/series', untitled: '(untitled series)' },
  universes: { basePath: '/universes', untitled: '(untitled universe)' },
  musicVideos: { basePath: '/music-video', untitled: '(untitled music video)' },
};
const isRecordRoute = (path, base) => path.startsWith(base + '/');

export default function SidebarNav({ collapsed, setCollapsed, mobileOpen, closeMobileNav, desktopNav }) {
  const location = useLocation();
  const navigate = useNavigate();
  const sidebarRef = useRef(null);
  const sidebarCollapsed = collapsed && !mobileOpen;
  const mobileNavActive = mobileOpen && !desktopNav;
  useFocusTrap(mobileNavActive, sidebarRef);

  const [expandedSections, setExpandedSections] = useState({});
  const [expandedSubSections, setExpandedSubSections] = useState({});
  const [flyout, setFlyout] = useState(null);
  const flyoutCloseTimer = useRef(null);
  const cancelCloseFlyout = useCallback(() => clearTimeout(flyoutCloseTimer.current), []);
  const closeFlyout = useCallback(() => {
    cancelCloseFlyout();
    setFlyout(null);
  }, [cancelCloseFlyout]);
  const flyoutId = useId();
  const flyoutTriggerRef = useRef(null);
  // Restoring focus to the trigger fires its row's onFocus; without this latch
  // that would immediately reopen the flyout the user just dismissed.
  const suppressFlyoutOpenRef = useRef(false);
  const openFlyout = (event, label, focusFirst = false) => {
    cancelCloseFlyout();
    const row = event.currentTarget;
    const rect = row.getBoundingClientRect();
    flyoutTriggerRef.current = row.querySelector('button');
    setFlyout(prev => ({
      label,
      pathname: location.pathname,
      top: rect.top,
      left: rect.right + 4,
      focusToken: (prev?.focusToken || 0) + (focusFirst ? 1 : 0),
    }));
  };
  const dismissFlyout = useCallback(({ restoreFocus = true } = {}) => {
    closeFlyout();
    if (restoreFocus && flyoutTriggerRef.current) {
      suppressFlyoutOpenRef.current = true;
      flyoutTriggerRef.current.focus();
      suppressFlyoutOpenRef.current = false;
    }
  }, [closeFlyout]);
  const handleSectionKeyDown = (event, label) => {
    if (event.key === 'Escape') {
      closeFlyout();
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      openFlyout({ currentTarget: event.currentTarget.parentElement }, label, true);
    }
  };
  const scheduleCloseFlyout = () => {
    cancelCloseFlyout();
    flyoutCloseTimer.current = setTimeout(closeFlyout, 180);
  };
  useEffect(() => cancelCloseFlyout, [cancelCloseFlyout]);
  const railActive = desktopNav && sidebarCollapsed;
  useEffect(() => { closeFlyout(); }, [closeFlyout, location.pathname, railActive]);
  const flyoutSection = railActive && flyout?.pathname === location.pathname ? flyout.label : null;
  const { isFeatureEnabled } = useInstanceFeatures();
  const workingSet = useNavWorkingSet();
  const { pin, unpin, isPinned, pinnedPaths, recentPaths } = workingSet;
  const referencedPaths = useMemo(
    () => [...pinnedPaths, ...recentPaths.filter(path => path !== location.pathname)]
      .map(path => migrateLegacyNavPath(path, NAV_COMMANDS)),
    [pinnedPaths, recentPaths, location.pathname],
  );
  const needed = (section, base) => (flyoutSection === section)
    || (!sidebarCollapsed && (desktopNav || mobileOpen) && expandedSections[section] === true)
    || referencedPaths.some(path => isRecordRoute(path, base));

  const sidebarApps = useSidebarApps({ enabled: needed('Apps', '/apps') });
  const pipelineSeries = useSidebarSeries(needed('Create', DYNAMIC_ROWS.pipelineSeries.basePath));
  const universes = useSidebarUniverses(needed('Create', DYNAMIC_ROWS.universes.basePath));
  const musicVideos = useSidebarMusicVideos(needed('Create', DYNAMIC_ROWS.musicVideos.basePath));

  // Manifest-only paths (e.g. /wiki/log, /goals/tree) have no sidebar leaf, so
  // they resolve out of the statically imported manifest that already backs
  // `commandByPath`. Reading the bundle instead of re-fetching `/palette/manifest`
  // is what lets a Pinned/Recent row for one of those paths render on the FIRST
  // paint rather than popping in once a request lands (and keeps it rendering on
  // an install where that request fails). They still honour the feature gate, so
  // a row pinned before the user disabled its feature stops resolving too.
  const manifestEntryByPath = useMemo(() => {
    const map = new Map();
    filterNavByFeatures([...commandByPath.values()], isFeatureEnabled).forEach((c) => {
      map.set(c.path, { path: c.path, label: c.label, icon: NAV_PRESENTATION[c.path]?.icon || Navigation });
    });
    return map;
  }, [isFeatureEnabled]);

  // Build dynamic nav items with app children + record-list grandchildren
  // (Series, Universes, Music Video projects): each dynamic row lists its
  // records under `${basePath}/${id}`, highlighted while on that record or any
  // of its sub-pages. Decorators live inside the memo so their closures over the
  // lists need no lint suppression and aren't reallocated on every render.
  const resolvedNavItems = useMemo(() => {
    const records = { pipelineSeries, universes, musicVideos };
    const decorateDynamicChild = (child) => {
      const list = DYNAMIC_ROWS[child.dynamic];
      if (!list) return child;
      return {
        ...child,
        grandChildren: records[child.dynamic].map((record) => {
          const label = record.name || list.untitled;
          return {
            to: `${list.basePath}/${record.id}`,
            label,
            title: label,
            icon: child.icon,
            activePathPrefix: `${list.basePath}/${record.id}`,
          };
        }),
      };
    };
    // A manifest `parentPath` nests the row under its parent row as a
    // third-level link instead of dropping it from the sidebar.
    const decorateParentChild = (child) => {
      if (!child.to || child.grandChildren) return child;
      const nested = presentedNavRows
        .filter((row) => row.parentPath === child.to && isFeatureEnabled(row.feature))
        .sort((a, b) => a.label.localeCompare(b.label))
        .map((row) => ({ to: row.to, label: row.label, title: row.label, icon: row.icon, activePathPrefix: row.to }));
      return nested.length > 0 ? { ...child, grandChildren: nested } : child;
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
      const navigable = item.dynamic || item.defaultTo || children.some((child) => child.to || child.href);
      const groups = item.groups
        ?.map((group) => ({ ...group, children: group.children.filter((child) => isFeatureEnabled(child.feature)) }))
        .filter((group) => group.children.length > 0);
      return navigable ? [{ ...item, children, ...(groups ? { groups } : {}) }] : [];
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
        const decorate = (child) => decorateParentChild(decorateDynamicChild(child));
        return {
          ...item,
          children: item.children.map(decorate),
          ...(item.groups ? { groups: item.groups.map((group) => ({ ...group, children: group.children.map(decorate) })) } : {}),
        };
      }
      return item;
    });
  }, [sidebarApps, pipelineSeries, universes, musicVideos, isFeatureEnabled]);

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
      const current = migrateLegacyNavPath(path, NAV_COMMANDS);
      if (current === path) return null;
      return navEntryByPath.get(current) || manifestEntryByPath.get(current) || null;
    },
    [navEntryByPath, manifestEntryByPath],
  );

  const { pinned, recent } = useResolvedNavWorkingSet(workingSet, resolveNavEntry, location.pathname);

  const activeCommand = getNavCommandForPath(location.pathname);
  const owningSection = activeCommand?.section;

  // Use static paths so a record deep link can expand its section before its
  // list loads. The Apps index needs only the page, so it stays collapsed.
  useEffect(() => {
    const pathname = location.pathname;
    const sections = {};
    const subSections = {};
    for (const item of navItems) {
      if (item.dynamic === 'apps') {
        if (isRecordRoute(pathname, '/apps')) sections[item.label] = true;
        continue;
      }
      if (!item.children?.length) continue;
      if (owningSection === item.label) sections[item.label] = true;
      for (const child of item.children) {
        if (child.to && pathWithinRow(pathname, child.to)) sections[item.label] = true;
        const dynamic = DYNAMIC_ROWS[child.dynamic];
        if (dynamic && isRecordRoute(pathname, dynamic.basePath)) {
          sections[item.label] = true;
          subSections[child.to] = true;
        }
      }
    }
    if (Object.keys(sections).length) setExpandedSections(previous => ({ ...previous, ...sections }));
    if (Object.keys(subSections).length) setExpandedSubSections(previous => ({ ...previous, ...subSections }));
  }, [location.pathname, owningSection]);

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
    const declaredPath = commandByPath.has(path);
    const matchedCommand = declaredPath ? activeCommand : null;
    if (matchedCommand?.section === 'Models') {
      const owningTab = getSectionNavTabForPath('Models', location.pathname);
      return owningTab?.to === path || matchedCommand.path === path;
    }
    return pathWithinRow(location.pathname, path);
  };

  const isSectionActive = (item) => {
    if (item.single && item.to) {
      return isActive(item.to);
    }
    if (owningSection === item.label) return true;
    if (item.children) {
      return item.children.some(child =>
        (child.to && isActive(child.to)) ||
        (Array.isArray(child.grandChildren) && child.grandChildren.some(gc => {
          const prefix = gc.activePathPrefix || gc.to;
          return location.pathname === prefix || location.pathname.startsWith(prefix + '/');
        }))
      );
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
          className={`flex items-center min-h-[44px] lg:min-h-0 pointer-coarse:min-h-11 gap-3 mx-2 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors min-w-0 ${
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
          pinned={singlePinned}
          onTogglePin={() => (singlePinned ? unpin(item.to) : pin(item.to))}
          onNavigate={() => closeMobileNav()}
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
        if (item.children?.length && !expandedSections[item.label] && !sidebarCollapsed) {
          toggleSection(item.label);
        }
      } else {
        toggleSection(item.label);
      }
      closeMobileNav();
    };

    const sectionActive = isSectionActive(item);
    const sectionRowClasses = `flex items-center min-h-[44px] lg:min-h-0 pointer-coarse:min-h-11 gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
      sectionActive
        ? 'bg-port-accent/10 text-port-accent'
        : 'text-gray-400 hover:text-white hover:bg-port-border/50'
    }`;

    const hasChildrenForFlyout = railActive && Array.isArray(item.children) && item.children.length > 0;

    return (
      <div key={item.label} className="mx-2 min-w-0">
        <div
          className={`flex items-stretch min-w-0 ${sidebarCollapsed ? 'lg:justify-center' : ''}`}
          onMouseEnter={hasChildrenForFlyout ? (e) => openFlyout(e, item.label) : undefined}
          onMouseLeave={hasChildrenForFlyout ? scheduleCloseFlyout : undefined}
          onFocus={hasChildrenForFlyout ? (e) => { if (!suppressFlyoutOpenRef.current) openFlyout(e, item.label); } : undefined}
          onBlur={hasChildrenForFlyout ? scheduleCloseFlyout : undefined}
        >
          <button
            type="button"
            onClick={navigateToSection}
            className={`flex-1 min-w-0 ${sectionRowClasses} ${sidebarCollapsed ? 'lg:justify-center lg:px-2' : 'justify-between'}`}
            title={sidebarCollapsed ? item.label : undefined}
            aria-label={sidebarCollapsed ? item.label : undefined}
            aria-controls={hasChildrenForFlyout && flyoutSection === item.label ? flyoutId : undefined}
            onKeyDown={hasChildrenForFlyout ? (e) => handleSectionKeyDown(e, item.label) : undefined}
            aria-expanded={hasChildrenForFlyout ? flyoutSection === item.label : undefined}
            aria-current={sectionActive ? 'true' : undefined}
          >
            <div className="flex items-center gap-3 min-w-0">
              <Icon size={20} className="shrink-0" />
              <span className={`min-w-0 break-words leading-snug ${sidebarCollapsed ? 'lg:hidden' : ''}`}>
                {item.label}
              </span>
            </div>
          </button>
          {!sidebarCollapsed && item.children?.length > 0 && (
            <button
              type="button"
              aria-label={expandedSections[item.label] ? `Collapse ${item.label}` : `Expand ${item.label}`}
              aria-expanded={!!expandedSections[item.label]}
              onClick={() => toggleSection(item.label)}
              className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 px-2 text-gray-400 hover:text-white hover:bg-port-border/50 rounded-lg"
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
            {(item.groups?.length
              ? item.groups.flatMap((group) => [...(group.label ? [{ groupLabel: group.label }] : []), ...group.children])
              : item.children
            ).map((child, childIndex) => {
              if (child.groupLabel) {
                return (
                  <div key={`child-group-${child.groupLabel}`} className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500" role="heading" aria-level="3">
                    {child.groupLabel}
                  </div>
                );
              }
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
                    className="flex items-center min-h-[44px] lg:min-h-0 pointer-coarse:min-h-11 justify-between gap-3 px-3 py-2 rounded-lg text-sm transition-colors text-gray-500 hover:text-white hover:bg-port-border/50 min-w-0"
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
                        onNavigate={() => closeMobileNav()}
                        isActive={childActive}
                      />
                    </div>
                    {grandChildren.length > 0 && (
                      <button
                        type="button"
                        aria-label={grandChildrenExpanded ? `Collapse ${child.label}` : `Expand ${child.label}`}
                        aria-expanded={grandChildrenExpanded}
                        onClick={() => toggleSubSection(child.to)}
                        className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 px-2 py-2 text-gray-500 hover:text-white hover:bg-port-border/50 rounded-lg"
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
                            onClick={() => closeMobileNav()}
                            title={gc.title || gc.label}
                            className={`min-h-[44px] flex items-center lg:min-h-0 lg:block pointer-coarse:min-h-11 pointer-coarse:flex pointer-coarse:items-center px-2 py-1 rounded text-xs transition-colors min-w-0 break-words leading-snug ${
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

  const flyoutItem = flyoutSection && resolvedNavItems.find(item => item.label === flyoutSection);
  return (
    <>
      {/* Sidebar */}
      <aside
        ref={sidebarRef}
        id="app-sidebar"
        inert={!desktopNav && !mobileNavActive}
        aria-hidden={!desktopNav && !mobileNavActive ? true : undefined}
        onKeyDown={(event) => {
          // Portaled child popovers own their Escape dismissal.
          if (mobileNavActive && event.key === 'Escape' && !event.defaultPrevented && event.currentTarget.contains(event.target)) {
            event.stopPropagation();
            closeMobileNav();
          }
        }}
        className={`
          port-app-sidebar
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
              className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 hidden lg:block opacity-95 transition-opacity hover:opacity-80"
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
              className="min-h-[44px] min-w-[44px] items-center justify-center hidden lg:flex p-1 text-gray-500 hover:text-white transition-colors"
              title="Collapse sidebar"
              aria-label="Collapse sidebar"
            >
              <ChevronLeft size={20} aria-hidden="true" />
            </button>
          )}
          {/* Mobile close button */}
          <button
            type="button"
            onClick={() => closeMobileNav()}
            className="lg:hidden inline-flex items-center justify-center min-w-[44px] min-h-[44px] rounded-lg text-gray-500 hover:text-white"
            aria-label="Close sidebar"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>

        {/* Nav items */}
        <nav aria-label="Primary navigation" className="flex-1 py-4 overflow-y-auto overflow-x-hidden min-w-0">
          {!collapsed && (pinned.length > 0 || recent.length > 0) && (
            <div className="mb-2">
              {pinned.length > 0 && (
                <div className="mb-2" data-testid="pinned-section">
                  <div className="px-4 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">Pinned</div>
                  {pinned.map((entry) => (
                    <WorkingSetRow key={`pin-${entry.path}`} entry={entry} pinned onTogglePin={() => unpin(entry.path)} onNavigate={closeMobileNav} isActive={entry.end ? location.pathname === entry.path : isActive(entry.path)} />
                  ))}
                </div>
              )}
              {recent.length > 0 && (
                <div className="mb-2" data-testid="recent-section">
                  <div className="px-4 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">Recent</div>
                  {recent.map((entry) => (
                    <WorkingSetRow key={`recent-${entry.path}`} entry={entry} pinned={false} onTogglePin={() => pin(entry.path)} onNavigate={closeMobileNav} isActive={entry.end ? location.pathname === entry.path : isActive(entry.path)} />
                  ))}
                </div>
              )}
              <div className="mx-4 my-2 border-t border-port-border" />
            </div>
          )}
          {resolvedNavItems.map(renderNavItem)}
        </nav>

        {/* Footer with version and notifications */}
        <div className={`border-t border-port-border ${collapsed ? 'lg:flex lg:justify-center lg:p-2 px-3 py-2.5' : 'px-3 py-2.5'}`}>
          <div className={`flex flex-col items-center gap-2 ${collapsed ? 'lg:flex-col lg:justify-center lg:gap-1' : 'lg:flex-row lg:items-center lg:justify-between lg:gap-0'}`}>
            <span
              className={`text-xs text-gray-500 shrink-0 font-medium select-none ${collapsed ? 'lg:hidden' : ''}`}
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
            <div className={`flex items-center gap-0.5 ${collapsed ? 'lg:flex-col lg:gap-1' : ''}`}>
              <button
                type="button"
                onClick={openCmdKSearch}
                className={`inline-flex items-center justify-center min-w-[44px] min-h-[44px] pointer-fine:lg:min-w-0 pointer-fine:lg:min-h-0 lg:p-1.5 rounded-lg transition-colors ${collapsed ? 'lg:hidden' : ''} text-gray-500 hover:text-white`}
                title="Search"
                aria-label="Open command palette"
              >
                <Search size={18} />
              </button>
              <ThemeModeToggle />
              <ThemeSwitcher className={collapsed ? 'lg:hidden' : ''} />
              <VoiceToggleButton className={collapsed ? 'lg:hidden' : ''} />
              <NotificationBell />
            </div>
          </div>
        </div>
      </aside>

      {flyoutItem && (
        <SidebarFlyout
          item={flyoutItem}
          anchor={flyout}
          close={closeFlyout}
          id={flyoutId}
          focusToken={flyout.focusToken}
          onDismiss={dismissFlyout}
          scheduleCloseFlyout={scheduleCloseFlyout}
          cancelCloseFlyout={cancelCloseFlyout}
          isActive={isActive}
        />
      )}
    </>
  );
}
