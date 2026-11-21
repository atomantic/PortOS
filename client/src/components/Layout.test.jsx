import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, act, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, createMemoryRouter, RouterProvider, useLocation } from 'react-router';
import { reloadOnceForStaleChunk } from '../utils/staleChunkReload';
import { PINNED_KEY, RECENT_KEY } from '../utils/navWorkingSet.js';
import socket from '../services/socket';
import { INSTANCE_FEATURES_CHANGED } from '../constants/events.js';
import { CMD_K_SEARCH_OPEN_EVENT } from '../hooks/useCmdKSearch.js';

// This suite locks the *integration* path that SingleNavRow.test.jsx can't reach:
// pinning a top-level `single: true` row (Dashboard `/`, Review Hub `/review`,
// Eidoverse `/eidoverse`, Goals `/goals/list`) must make it render in the sidebar Pinned
// section. That resolution lives in Layout itself — `navEntryByPath` indexes
// `item.single` leaves, `resolveNavEntry` maps a stored path to a row, and
// `useNavWorkingSet` feeds the Pinned-section render. We exercise the real
// nav-working-set path (seeded via localStorage) and mock everything else Layout
// pulls in (notification hooks, sockets, api fetches, theme, heavy child widgets)
// so the render is deterministic and side-effect free.

// --- Notification / status hooks: no-op, except useNotifications which feeds the
//     dropdown with a nonzero unread count. ---
vi.mock('../hooks/useErrorNotifications', () => ({ useErrorNotifications: () => {} }));
vi.mock('../hooks/useSharingNotifications', () => ({ useSharingNotifications: () => {} }));
vi.mock('../hooks/useAgentFeedbackToast', () => ({ useAgentFeedbackToast: () => {} }));
vi.mock('../hooks/useAIStatusNotifications', () => ({ useAIStatusNotifications: () => {} }));
vi.mock('./UpdateBanners', () => ({ default: () => null }));
vi.mock('./SetupBanner', () => ({ default: () => null }));
vi.mock('./MaintenanceBanner.jsx', () => ({ default: () => null }));
vi.mock('./PasswordRiskWarning.jsx', () => ({ default: () => null }));
vi.mock('../hooks/useNotifications', () => ({
  useNotifications: () => ({
    notifications: [],
    unreadCount: 6,
    markAsRead: vi.fn(),
    markAllAsRead: vi.fn(),
    removeNotification: vi.fn(),
    clearAll: vi.fn(),
  }),
}));

// --- Theme context: Layout reads `theme.mode` for the day/night toggle. ---
vi.mock('./ThemeContext', () => ({
  useThemeContext: () => ({
    theme: { mode: 'night', label: 'Test', pair: null },
    themeId: 'test',
    themeList: [{ id: 'test', label: 'Test', family: 'classic', shortLabel: 'Test', density: 'comfortable' }],
    setTheme: vi.fn(),
    toggleMode: vi.fn(),
  }),
}));

// --- Heavy child widgets: render nothing so they don't open sockets / fetch. ---
vi.mock('./Logo', () => ({ default: () => null }));
vi.mock('./NotificationDropdown', () => ({
  default: ({ position = 'above' }) => (
    <div data-testid="notification-dropdown" data-position={position} />
  ),
}));
vi.mock('./voice/VoiceToggleButton', () => ({ default: () => null }));
vi.mock('./voice/VoiceWidgetGate', () => ({ default: ({ children }) => children }));
vi.mock('./CmdKSearchGate', () => ({ default: () => <div data-testid="command-palette" /> }));
vi.mock('../utils/staleChunkReload', async (importOriginal) => ({
  ...await importOriginal(),
  reloadOnceForStaleChunk: vi.fn().mockResolvedValue(false),
}));
vi.mock('./KeyboardHelpGate', () => ({ default: () => null }));

// --- Socket: record handlers, never connect. ---
vi.mock('../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));

// --- API: every sidebar fetch resolves empty so the dynamic sections stay bare
//     and the single rows are the only top-level leaves under test. ---
// Instance features gate sidebar rows (Health / POST / DataDog / JIRA / GSD / OpenClaw). Default every
// feature ON so these tests see the full sidebar; the gating itself is covered
// by 'Layout — instance feature gating' below.
const allFeaturesOn = () => [
  { id: 'post', label: 'POST', enabled: true },
  { id: 'datadog', label: 'DataDog', enabled: true },
  { id: 'jira', label: 'JIRA', enabled: true },
  { id: 'eidoverse', label: 'Eidoverse Worlds', enabled: true },
  { id: 'gsd', label: 'GSD', enabled: true },
  { id: 'openclaw', label: 'OpenClaw', enabled: true },
  { id: 'health', label: 'Health tracking', enabled: true },
  { id: 'beeper', label: 'Beeper', enabled: true },
];
const featureMock = vi.hoisted(() => ({ features: null }));

// The sidebar hooks import their specific API modules, never the barrel (#16562).
const api = vi.hoisted(() => ({
  getApps: vi.fn(() => Promise.resolve([])),
  listPipelineSeriesNames: vi.fn(() => Promise.resolve([])),
  listUniverseNames: vi.fn(() => Promise.resolve([])),
  listMusicVideoProjectNames: vi.fn(() => Promise.resolve([])),
  getReviewQueue: vi.fn(() => new Promise(() => {})),
  getInstanceFeatures: vi.fn(() => Promise.resolve({ features: featureMock.features })),
}));
vi.mock('../services/apiApps.js', () => ({ getApps: api.getApps }));
vi.mock('../services/apiNavNames.js', () => ({
  listPipelineSeriesNames: api.listPipelineSeriesNames,
  listMusicVideoProjectNames: api.listMusicVideoProjectNames,
}));
vi.mock('../services/apiUniverseBuilder.js', () => ({ listUniverseNames: api.listUniverseNames }));
vi.mock('../services/apiReview.js', () => ({ getReviewQueue: api.getReviewQueue }));
vi.mock('../services/apiSystem.js', () => ({ getInstanceFeatures: api.getInstanceFeatures }));

import { __resetInstanceFeatureCache } from '../hooks/useInstanceFeatures.js';

import { NAV_COMMANDS } from '../../../server/lib/navManifest.js';
import Layout from './Layout';
import { PaddedMain } from './PageShell';
import { RECONNECTING_PILL_DELAY_MS } from './SocketReconnectingPill.jsx';
import {
  NAV_PRESENTATION,
  SECTIONS_BEFORE_GOALS,
  SECTIONS_AFTER_GOALS,
  SECTIONS_BELOW_MORE,
} from '../lib/navPresentation.js';

const LocationProbe = () => {
  const location = useLocation();
  return <output data-testid="current-path">{location.pathname}</output>;
};

const renderLayout = async (initialPath = '/brain/inbox') => {
  const utils = render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Layout />
      <LocationProbe />
    </MemoryRouter>,
  );
  // The sidebar's dynamic sections fire async fetches (all mocked empty here).
  // Flush their resolution inside act() so the resulting setState lands within
  // the React lifecycle instead of after the test body returns (which warns
  // "update … not wrapped in act").
  await act(async () => {});
  return utils;
};

// The Pinned region carries a stable `data-testid` so assertions scope to it
// without depending on the heading's DOM nesting (a benign style refactor of the
// label shouldn't break these tests). Returns null when the section isn't rendered.
const pinnedSection = () => screen.queryByTestId('pinned-section');

describe('Layout — socket reconnecting pill', () => {
  // Plain fake timers: renderLayout settles on microtasks only, and auto-advance
  // would fire Layout's own timers outside act() between assertions.
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('shows "Reconnecting…" after the shared socket has been down for the delay and hides it on connect', async () => {
    // The mocked socket reports no `connected` flag, i.e. disconnected from mount.
    await renderLayout();
    expect(screen.queryByText('Reconnecting…')).toBeNull();

    act(() => { vi.advanceTimersByTime(RECONNECTING_PILL_DELAY_MS); });
    expect(screen.getByText('Reconnecting…')).toBeInTheDocument();

    // Every 'connect' handler Layout's hooks registered fires here, and some
    // of them refetch (mocked, resolving on microtasks) — settle inside act.
    await act(async () => {
      for (const [event, handler] of socket.on.mock.calls) if (event === 'connect') handler();
    });
    expect(screen.queryByText('Reconnecting…')).toBeNull();
  });
});

describe('Layout — manifest-derived sidebar structure', () => {
  it.each([false, true])('keeps global unread notifications off CoS navigation (collapsed: %s)', async (collapsed) => {
    localStorage.setItem('portos-sidebar-collapsed', String(collapsed));
    await renderLayout();

    const cos = screen.getByRole('button', { name: /^Chief of Staff/ });
    expect(cos).toHaveTextContent(/^Chief of Staff$/);
    fireEvent.click(cos);
    expect(screen.getByTestId('current-path')).toHaveTextContent('/cos/tasks');
  });


  it('loads the lean apps list after the Apps section expands', async () => {
    api.getApps.mockClear();
    await renderLayout('/apps');

    expect(api.getApps).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Expand Apps' })));
    expect(api.getApps).toHaveBeenCalledWith({ silent: true, view: 'nav' });
  });

  it('keeps NAV_PRESENTATION presentation-only and keyed to live manifest paths', () => {
    const manifestPaths = new Set(NAV_COMMANDS.map((command) => command.path));
    expect(Object.keys(NAV_PRESENTATION).filter((path) => !manifestPaths.has(path))).toEqual([]);
    for (const presentation of Object.values(NAV_PRESENTATION)) {
      expect(presentation).not.toHaveProperty('to');
      expect(presentation).not.toHaveProperty('label');
      expect(presentation).not.toHaveProperty('section');
      expect(presentation).not.toHaveProperty('feature');
      expect(presentation.icon).toBeTruthy();
    }
  });

  // Regression guard: a presentation-layer filter once hid whole groups of
  // destinations (Chief of Staff, Comms and Settings tabs) from the sidebar
  // while their routes and icons still existed. Every destination with an
  // icon must render as a sidebar link once its sections are expanded.
  it('renders a sidebar link for every destination in NAV_PRESENTATION', async () => {
    await renderLayout('/');
    let expand;
    while ((expand = screen.queryAllByRole('button', { name: /^Expand / })).length > 0) {
      expand.forEach((button) => fireEvent.click(button));
      await act(async () => {});
    }
    const hrefs = new Set(screen.getAllByRole('link').map((link) => link.getAttribute('href')));
    expect(Object.keys(NAV_PRESENTATION).filter((path) => !hrefs.has(path))).toEqual([]);
    // Hub tab pages stay in the sidebar too, even though their hub also shows
    // them as in-page tabs.
    for (const path of ['/cos/tasks', '/cos/agents', '/messages/inbox', '/settings/features', '/brain/inbox']) {
      expect(hrefs.has(path), `sidebar is missing ${path}`).toBe(true);
    }
  });

  it('covers all sub-tabs for Settings, Digital Twin, and Messages in the destination icon registry', () => {
    const settingsPaths = [
      '/settings/general', '/settings/ai-assignments', '/settings/api-access', '/settings/autofixer',
      '/settings/backup', '/settings/credentials', '/settings/database', '/settings/features',
      '/settings/security', '/settings/sharing', '/settings/software',
      '/settings/telegram', '/settings/voice', '/settings/mortalloom',
      '/openclaw', '/prompts', '/ai/presets', '/ai/harnesses', '/ai/services'
    ];
    for (const p of settingsPaths) {
      expect(NAV_PRESENTATION[p], `missing destination icon for settings path ${p}`).toBeDefined();
    }

    const digitalTwinTabs = [
      'overview', 'identity', 'personas', 'goals', 'taste',
      'documents', 'import', 'accounts', 'interview', 'autobiography', 'enrich',
      'test', 'personality', 'voice', 'appearance', 'avatar-bio',
      'export', 'legacy', 'time-capsule'
    ];
    for (const tab of digitalTwinTabs) {
      const p = `/digital-twin/${tab}`;
      expect(NAV_PRESENTATION[p], `missing destination icon for digital twin tab ${p}`).toBeDefined();
    }

    const messageTabs = ['inbox', 'drafts', 'imessage', 'signal', 'beeper', 'contacts', 'sync', 'config'];
    for (const tab of messageTabs) {
      const p = `/messages/${tab}`;
      expect(NAV_PRESENTATION[p], `missing destination icon for message tab ${p}`).toBeDefined();
    }
  });
});

let desktopMedia;

beforeEach(() => {
  desktopMedia = Object.assign(new EventTarget(), { matches: true });
  vi.stubGlobal('matchMedia', vi.fn(() => desktopMedia));
  localStorage.clear();
  // The feature list is cached at module scope so every consumer shares one
  // fetch — drop it between tests so a case that flips a flag cannot leak.
  __resetInstanceFeatureCache();
  featureMock.features = allFeaturesOn();
  // __APP_VERSION__ is a Vite build-time define; undefined under vitest.
  vi.stubGlobal('__APP_VERSION__', 'test');
});

afterEach(() => {
  vi.unstubAllGlobals();
  api.listPipelineSeriesNames.mockResolvedValue([]);
  api.listUniverseNames.mockResolvedValue([]);
  api.listMusicVideoProjectNames.mockResolvedValue([]);
});

describe('Layout — pinned single nav rows', () => {
  it('keeps destination icons in pinned and recent rows, including nested and dynamic pages', async () => {
    const destinations = [
      ['/devtools/usage', 'Usage', 'lucide-chart-column'],
      ['/catalog/casting', 'Casting', 'lucide-drama'],
      ['/pipeline/series/example-series', 'Example Series', 'lucide-workflow'],
      ['/universes/example-universe', 'Example Universe', 'lucide-globe'],
    ];
    api.listPipelineSeriesNames.mockResolvedValue([{ id: 'example-series', name: 'Example Series' }]);
    api.listUniverseNames.mockResolvedValue([{ id: 'example-universe', name: 'Example Universe' }]);
    const savedPaths = destinations.map(([path]) => path === '/catalog/casting' ? '/casting' : path);
    localStorage.setItem(PINNED_KEY, JSON.stringify(savedPaths));
    localStorage.setItem(RECENT_KEY, JSON.stringify(savedPaths));
    await renderLayout();

    for (const [path, label, iconClass] of destinations) {
      const link = within(pinnedSection()).getByRole('link', { name: label });
      expect(link).toHaveAttribute('href', path);
      expect(link.querySelector('svg')).toHaveClass(iconClass);
      fireEvent.click(within(pinnedSection()).getByRole('button', { name: `Unpin ${label}` }));
      const recentLink = within(screen.getByTestId('recent-section')).getByRole('link', { name: label });
      expect(recentLink.querySelector('svg')).toHaveClass(iconClass);
    }
  });

  it('renders a pinned top-level single row (Dashboard) in the Pinned section', async () => {
    localStorage.setItem(PINNED_KEY, JSON.stringify(['/']));
    await renderLayout();

    const pinned = pinnedSection();
    expect(pinned).toBeTruthy();
    // The Dashboard row resolved through navEntryByPath → its label links to '/'.
    const link = within(pinned).getByRole('link', { name: /Dashboard/i });
    expect(link).toHaveAttribute('href', '/');
    // And it carries the Unpin affordance (it's pinned).
    expect(within(pinned).getByRole('button', { name: /^Unpin Dashboard$/i })).toBeTruthy();
  });

  it('resolves every top-level single row by path into the Pinned section', async () => {
    localStorage.setItem(PINNED_KEY, JSON.stringify(['/', '/review', '/openworld', '/goals/list']));
    await renderLayout();

    const pinned = pinnedSection();
    expect(within(pinned).getByRole('link', { name: /Dashboard/i })).toHaveAttribute('href', '/');
    expect(within(pinned).getByRole('link', { name: /Review Hub/i })).toHaveAttribute('href', '/review');
    expect(within(pinned).getByRole('link', { name: /Eidoverse/i })).toHaveAttribute('href', '/eidoverse');
    expect(within(pinned).getByRole('link', { name: /Goals/i })).toHaveAttribute('href', '/goals/list');
  });

  it('omits the Pinned section entirely when nothing is pinned', async () => {
    await renderLayout();
    expect(pinnedSection()).toBeNull();
  });

  it('renders a pinned manifest-only path on the first paint, with no network mock', async () => {
    // `/wiki/log` has a NAV_COMMANDS entry but no sidebar presentation, so it
    // resolves only through `manifestEntryByPath`. That map is derived from the
    // statically imported manifest, so the row must be in the DOM on the very
    // first render — assert BEFORE the act() flush renderLayout does, which is
    // what a fetch-backed manifest would have needed to land.
    localStorage.setItem(PINNED_KEY, JSON.stringify(['/wiki/log']));
    render(
      <MemoryRouter initialEntries={['/brain/inbox']}>
        <Layout />
      </MemoryRouter>,
    );

    const pinned = pinnedSection();
    expect(pinned).toBeTruthy();
    expect(within(pinned).getByRole('link', { name: /Log/i })).toHaveAttribute('href', '/wiki/log');
    await act(async () => {});
  });

  it('filters out an unknown pinned path while keeping the known one', async () => {
    // A stored path that maps to no nav leaf and no manifest entry resolves to
    // null and is dropped by resolveNavEntry; a known path beside it still renders.
    // Asserting the survivor (not just absence) proves the filter, not merely that
    // the section failed to render.
    localStorage.setItem(PINNED_KEY, JSON.stringify(['/this/path/does/not/exist', '/openworld']));
    await renderLayout();

    const pinned = pinnedSection();
    expect(pinned).toBeTruthy();
    expect(within(pinned).getByRole('link', { name: /Eidoverse/i })).toHaveAttribute('href', '/eidoverse');
    // The unknown path contributes no row.
    expect(within(pinned).getAllByRole('link')).toHaveLength(1);
  });
});

describe('Layout — instance feature gating', () => {
  // Rendering an UNGATED /devtools/* route auto-expands the Dev Tools section,
  // so its children are queryable without driving the disclosure — and the
  // expansion does not itself depend on a gated row surviving the filter.
  it('shows the DataDog and JIRA rows while those features are on', async () => {
    await renderLayout('/devtools/flows');

    expect(screen.getByRole('link', { name: 'DataDog' })).toHaveAttribute('href', '/devtools/datadog');
    expect(screen.getByRole('link', { name: 'JIRA' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'JIRA Reports' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'POST' })).toBeTruthy();
  });

  it('shows API Explorer inside Dev Tools navigation', async () => {
    await renderLayout('/api-reference/catalog');

    expect(NAV_COMMANDS.find((command) => command.path === '/api-reference/catalog')?.section).toBe('Dev Tools');
    expect(screen.getByRole('link', { name: 'API Explorer' })).toHaveAttribute('href', '/api-reference/catalog');
  });

  it('drops only the rows of the features this install turned off', async () => {
    featureMock.features = allFeaturesOn()
      .map((f) => (f.id === 'post' ? f : { ...f, enabled: false }));

    await renderLayout('/devtools/flows');

    expect(screen.queryByRole('link', { name: 'DataDog' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'JIRA' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'JIRA Reports' })).toBeNull();
    // Ungated Dev Tools rows and the POST section stay put.
    expect(screen.getByRole('link', { name: 'Flows' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'POST' })).toBeTruthy();
  });

  it('shows Settings > Features in the primary navigation', async () => {
    await renderLayout('/settings/features');

    expect(screen.getByRole('button', { name: 'Settings', exact: true })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('link', { name: 'Features' })).toHaveAttribute('href', '/settings/features');
  });

  it('shows and hides Eidoverse with its instance feature flag', async () => {
    await renderLayout('/eidoverse');
    expect(screen.getByRole('link', { name: 'Eidoverse' })).toHaveAttribute('href', '/eidoverse');

    featureMock.features = allFeaturesOn()
      .map((feature) => feature.id === 'eidoverse' ? { ...feature, enabled: false } : feature);
    act(() => window.dispatchEvent(new CustomEvent(INSTANCE_FEATURES_CHANGED, {
      detail: { features: featureMock.features },
    })));
    expect(screen.queryByRole('link', { name: 'Eidoverse' })).toBeNull();
  });

  it('shows and hides a saved OpenClaw destination with its instance feature flag', async () => {
    localStorage.setItem(PINNED_KEY, JSON.stringify(['/openclaw']));
    await renderLayout('/openclaw');
    expect(within(pinnedSection()).getByRole('link', { name: 'OpenClaw' })).toHaveAttribute('href', '/openclaw');

    featureMock.features = allFeaturesOn()
      .map((feature) => feature.id === 'openclaw' ? { ...feature, enabled: false } : feature);
    act(() => window.dispatchEvent(new CustomEvent(INSTANCE_FEATURES_CHANGED, {
      detail: { features: featureMock.features },
    })));
    expect(screen.queryByRole('link', { name: 'OpenClaw' })).toBeNull();
  });

  it('drops the whole POST section when POST is off', async () => {
    featureMock.features = allFeaturesOn()
      .map((f) => (f.id === 'post' ? { ...f, enabled: false } : f));

    await renderLayout('/devtools/flows');

    expect(screen.queryByRole('button', { name: 'POST' })).toBeNull();
    expect(screen.getByRole('link', { name: 'DataDog' })).toBeTruthy();
  });

  it('drops the whole Health section when health tracking is off', async () => {
    featureMock.features = allFeaturesOn()
      .map((f) => (f.id === 'health' ? { ...f, enabled: false } : f));

    await renderLayout('/devtools/flows');

    expect(screen.queryByRole('button', { name: 'Health' })).toBeNull();
  });

  it('shows everything when the feature list cannot be read', async () => {
    api.getInstanceFeatures.mockRejectedValueOnce(new Error('offline'));

    await renderLayout('/devtools/flows');

    expect(screen.getByRole('link', { name: 'DataDog' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'POST' })).toBeTruthy();
  });
});

describe('Layout — Comms section', () => {
  it('lists every messaging tab alongside the standalone Comms destinations', async () => {
    await renderLayout('/messages/beeper');

    expect(screen.getByRole('button', { name: 'Comms', exact: true })).toHaveAttribute('aria-current', 'true');
    for (const [label, href] of [['Beeper', '/messages/beeper'], ['Signal', '/messages/signal'], ['iMessage', '/messages/imessage'], ['Inbox', '/messages/inbox']]) {
      expect(screen.getByRole('link', { name: label })).toHaveAttribute('href', href);
    }
    expect(screen.getByRole('link', { name: 'Stacker News' })).toHaveAttribute('href', '/stacker-news');
    expect(screen.getByRole('link', { name: 'X', exact: true })).toHaveAttribute('href', '/x');
  });

  it('drops only the Beeper row when the beeper feature is off, keeping the rest of Comms', async () => {
    featureMock.features = allFeaturesOn()
      .map((f) => (f.id === 'beeper' ? { ...f, enabled: false } : f));

    await renderLayout('/messages/inbox');

    expect(screen.queryByRole('link', { name: 'Beeper' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Signal' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Inbox' })).toBeTruthy();
  });
});

describe('Layout — System Resources location state', () => {
  it('keeps Dev Tools expanded and System Resources active on every subtab', async () => {
    await renderLayout('/system-resources/storage');

    const link = screen.getByRole('link', { name: 'System Resources' });
    expect(link).toHaveAttribute('href', '/system-resources/overview');
    expect(link.className).toContain('text-port-accent');
  });
});

describe('Layout — section destinations', () => {
  it('keeps a Models task route and its owning sidebar destination active', async () => {
    localStorage.setItem(PINNED_KEY, JSON.stringify(['/models/performance/results']));
    await renderLayout('/models/performance/results');

    expect(screen.getByRole('button', { name: 'Models' })).toHaveClass('text-port-accent');
    expect(screen.getByRole('link', { name: 'Performance' })).toHaveClass('text-port-accent');
    expect(within(pinnedSection()).getByRole('link', { name: 'Performance Results' })).toHaveClass('text-port-accent');
    expect(screen.getByRole('link', { name: 'Model Library' })).not.toHaveClass('text-port-accent');
  });

  it('opens LLMs when the Models section label is clicked', async () => {
    await renderLayout();

    fireEvent.click(screen.getByRole('button', { name: 'Models' }));

    expect(screen.getByTestId('current-path')).toHaveTextContent('/models/llms');
  });
});

describe('Layout — persistent mobile touch targets', () => {
  const expectAtLeast44px = (element) => {
    expect(element.className).toContain('min-w-[44px]');
    expect(element.className).toContain('min-h-[44px]');
  };

  it('keeps navigation and header controls 44px through the mobile layout', async () => {
    await renderLayout();

    const openMenu = screen.getByRole('button', { name: 'Open navigation menu' });
    const closeMenu = screen.getByRole('button', { name: 'Close sidebar' });
    expectAtLeast44px(openMenu);
    expectAtLeast44px(closeMenu);
    expect(openMenu.closest('header')?.className).toContain('lg:hidden');
    expect(closeMenu.className).toContain('lg:hidden');

    const searchButtons = screen.getAllByRole('button', { name: 'Open command palette' });
    expect(searchButtons).toHaveLength(2);
    searchButtons.forEach(expectAtLeast44px);
    expect(within(screen.getByRole('banner')).getByRole('button', { name: 'Open command palette' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Ambient display' })).not.toBeInTheDocument();

    const themeToggles = screen.getAllByRole('button', { name: 'Toggle day/night mode' });
    expect(themeToggles).toHaveLength(2);
    themeToggles.forEach((toggle) => {
      expectAtLeast44px(toggle);
      expect(toggle.className).toContain('lg:min-w-0');
      expect(toggle.className).toContain('lg:min-h-0');
      expect(toggle.className).not.toContain('sm:min-w-0');
      expect(toggle.className).not.toContain('sm:min-h-0');
    });
  });

  it('opens the command palette from the mobile header search button', async () => {
    await renderLayout();
    const dispatchSpy = vi.spyOn(document, 'dispatchEvent');

    fireEvent.click(within(screen.getByRole('banner')).getByRole('button', { name: 'Open command palette' }));

    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: CMD_K_SEARCH_OPEN_EVENT }));
    dispatchSpy.mockRestore();
  });

  it('renders NotificationDropdown in both mobile topbar and desktop sidebar footer with correct placement', async () => {
    await renderLayout();

    const mobileDropdown = within(screen.getByRole('banner')).getByTestId('notification-dropdown');
    expect(mobileDropdown).toBeInTheDocument();
    expect(mobileDropdown).toHaveAttribute('data-position', 'below');

    const sidebar = document.getElementById('app-sidebar');
    const desktopDropdown = within(sidebar).getByTestId('notification-dropdown');
    expect(desktopDropdown).toBeInTheDocument();
    expect(desktopDropdown).toHaveAttribute('data-position', 'above');
  });

  it('expands section children when the mobile sidebar opens from a collapsed desktop preference', async () => {
    localStorage.setItem('portos-sidebar-collapsed', 'true');
    await renderLayout('/');

    fireEvent.click(screen.getByRole('button', { name: 'Open navigation menu' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Expand Create' })));

    expect(screen.getByRole('link', { name: 'Authors' })).toHaveAttribute('href', '/authors');
  });

  it('enlarges grandchild navigation links to at least 44px on mobile viewports while staying compact on desktop', async () => {
    api.listPipelineSeriesNames.mockResolvedValue([{ id: 'example', name: 'Example Series' }]);
    api.listUniverseNames.mockResolvedValue([{ id: 'example', name: 'Example Universe' }]);
    api.listMusicVideoProjectNames.mockResolvedValue([{ id: 'example', name: 'Example Video' }]);
    await renderLayout('/');

    fireEvent.click(screen.getByRole('button', { name: 'Open navigation menu' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Expand Create' })));

    const seriesLink = screen.getByRole('link', { name: 'Example Series' });
    const universeLink = screen.getByRole('link', { name: 'Example Universe' });
    const videoLink = screen.getByRole('link', { name: 'Example Video' });

    for (const link of [seriesLink, universeLink, videoLink]) {
      expect(link.className).toContain('min-h-[44px]');
      expect(link.className).toContain('flex');
      expect(link.className).toContain('items-center');
      expect(link.className).toContain('lg:min-h-0');
      expect(link.className).toContain('lg:block');
      expect(link.className).toContain('pointer-coarse:min-h-11');
    }
  });

  it('keeps primary and working-set links plus section toggles at least 44px', async () => {
    localStorage.setItem(PINNED_KEY, JSON.stringify(['/review']));
    await renderLayout('/');
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation menu' }));

    const reviewLinks = screen.getAllByRole('link', { name: /Review Hub/ });
    const createSection = screen.getByRole('button', { name: 'Create', exact: true });
    for (const link of reviewLinks) {
      expect(link.className).toContain('min-h-[44px]');
      expect(link.className).toContain('items-center');
      expect(link.className).toContain('lg:min-h-0');
      expect(link.className).toContain('pointer-coarse:min-h-11');
    }
    expect(createSection.className).toContain('min-h-[44px]');
    expect(createSection.className).toContain('lg:min-h-0');
    expect(createSection.className).toContain('pointer-coarse:min-h-11');
  });

  it('enlarges collapsed flyout grandchild navigation links on coarse viewports while staying compact on desktop', async () => {
    localStorage.setItem('portos-sidebar-collapsed', 'true');
    api.listPipelineSeriesNames.mockResolvedValue([{ id: 'example', name: 'Example Series' }]);
    await renderLayout('/');

    const createButton = screen.getByRole('button', { name: 'Create' });
    await act(async () => fireEvent.mouseEnter(createButton.parentElement));

    const flyoutNav = screen.getByRole('navigation', { name: 'Create pages' });
    const seriesFlyoutLink = within(flyoutNav).getByRole('link', { name: 'Example Series' });

    expect(seriesFlyoutLink.className).toContain('min-h-[44px]');
    expect(seriesFlyoutLink.className).toContain('flex');
    expect(seriesFlyoutLink.className).toContain('items-center');
    expect(seriesFlyoutLink.className).toContain('lg:min-h-0');
    expect(seriesFlyoutLink.className).toContain('lg:block');
    expect(seriesFlyoutLink.className).toContain('pointer-coarse:min-h-11');
  });
});

describe('Layout — nav footer', () => {
  it('opens the command palette from the footer search button', async () => {
    await renderLayout();
    const dispatchSpy = vi.spyOn(document, 'dispatchEvent');
    const footer = screen.getByText(/^vtest$/).closest('.border-t');

    const searchButton = within(footer).getByRole('button', { name: 'Open command palette' });
    fireEvent.click(searchButton);

    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: CMD_K_SEARCH_OPEN_EVENT }));
    dispatchSpy.mockRestore();
  });

  it('renders a compact footer layout preventing controls from overflowing the sidebar', async () => {
    await renderLayout();

    const version = screen.getByText(/^vtest$/);
    expect(version.className).toContain('text-xs');
    expect(version.className).toContain('shrink-0');

    const footer = version.closest('.border-t');
    expect(footer).toBeTruthy();
    expect(footer.className).toContain('px-3');
    expect(footer.className).toContain('py-2.5');

    const row = version.parentElement;
    expect(row.className).toContain('lg:flex-row');
    expect(row.className).toContain('lg:justify-between');

    const iconsContainer = row.querySelector('.flex.items-center');
    expect(iconsContainer.className).toContain('gap-0.5');
  });
});

describe('Layout — dynamic third-level navigation', () => {
  it('collapses and expands the Series and Universes children', async () => {
    api.listPipelineSeriesNames.mockResolvedValue([{ id: 'series-1', name: 'Example Series' }]);
    api.listUniverseNames.mockResolvedValue([{ id: 'universe-1', name: 'Example Universe' }]);

    await renderLayout('/media');

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Example Series' })).toHaveAttribute('href', '/pipeline/series/series-1');
      expect(screen.getByRole('link', { name: 'Example Universe' })).toHaveAttribute('href', '/universes/universe-1');
    });

    const collapseSeries = screen.getByRole('button', { name: 'Collapse Series Pipeline' });
    const collapseUniverses = screen.getByRole('button', { name: 'Collapse Universes' });
    fireEvent.click(collapseSeries);
    fireEvent.click(collapseUniverses);
    expect(screen.queryByRole('link', { name: 'Example Series' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Example Universe' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Expand Series Pipeline' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand Universes' }));
    expect(screen.getByRole('link', { name: 'Example Series' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Example Universe' })).toBeTruthy();
  });

  it('lists music video projects under Music Video and highlights the open project', async () => {
    api.listMusicVideoProjectNames.mockResolvedValue([{ id: 'mv-1', name: 'Example Video' }, { id: 'mv-2', name: null }]);

    await renderLayout('/music-video/mv-1/shots');

    const project = await screen.findByRole('link', { name: 'Example Video' });
    expect(project).toHaveAttribute('href', '/music-video/mv-1');
    expect(project).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: '(untitled music video)' })).toHaveAttribute('href', '/music-video/mv-2');

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Music Video' }));
    expect(screen.queryByRole('link', { name: 'Example Video' })).toBeNull();
  });

  it('opens Create on a catalog record and nests hub pages under their hub', async () => {
    await renderLayout('/casting/example-cast-member');

    expect(screen.getByRole('button', { name: 'Collapse Create' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Catalog' })).toHaveClass('text-port-accent');
    expect(screen.getByRole('link', { name: 'Media Studio' })).toHaveAttribute('href', '/create/media');
    expect(screen.getByRole('link', { name: 'Story Studio' })).toHaveAttribute('href', '/create/story');
    expect(screen.getByRole('link', { name: 'Casting' })).toHaveAttribute('href', '/catalog/casting');
    expect(screen.getByRole('link', { name: 'Writers Room' })).toHaveAttribute('href', '/writers-room');

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Catalog' }));
    expect(screen.queryByRole('link', { name: 'Casting' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand Catalog' }));
    expect(screen.getByRole('link', { name: 'Casting' })).toHaveAttribute('href', '/catalog/casting');
  });

  it('updates dynamic apps navigation when apps:changed is emitted', async () => {
    let appsChangedHandler;
    socket.on.mockImplementation((event, handler) => {
      if (event === 'apps:changed') appsChangedHandler = handler;
    });
    api.getApps.mockResolvedValueOnce([]);
    await renderLayout('/apps');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Expand Apps' })));

    expect(screen.queryByRole('link', { name: 'Super New App' })).not.toBeInTheDocument();

    api.getApps.mockResolvedValueOnce([{ id: 'super-new-app', name: 'Super New App' }]);
    await act(async () => {
      appsChangedHandler?.();
    });

    expect(await screen.findByRole('link', { name: 'Super New App' })).toBeInTheDocument();
  });
});

// The sidebar's section grouping used to be three numeric slices into a single
// flat SECTION_ORDER array, so inserting a section at its alphabetical position
// silently pushed a real section (e.g. Settings) past the "More" divider with
// nothing to catch it. The groups are named lists now; this locks the two
// invariants that made the slices fragile.
describe('Layout — sidebar section grouping', () => {
  const alphabetical = (list) => [...list].sort((a, b) => a.localeCompare(b));

  // The two lists are one alphabetical run split by the standalone Goals row, so
  // splicing that row's label back in at the split point must re-form a sorted
  // list. That pins BOTH the ordering within each list and where the split sits:
  // moving a section across the Goals boundary lands it out of order here, which
  // per-list sort checks would happily accept.
  it('reads as one alphabetical run through the standalone Goals row', () => {
    const goalsLabel = NAV_COMMANDS.find((command) => command.path === '/goals/list').label;
    const run = [...SECTIONS_BEFORE_GOALS, goalsLabel, ...SECTIONS_AFTER_GOALS];
    expect(run).toEqual(alphabetical(run));
  });

  // SECTIONS_BELOW_MORE is deliberately NOT part of that run — it is the
  // below-the-fold bucket — so it is exempt from the sort check but still has to
  // be disjoint and complete.
  it('groups every presented section exactly once', () => {
    const grouped = [...SECTIONS_BEFORE_GOALS, ...SECTIONS_AFTER_GOALS, ...SECTIONS_BELOW_MORE];
    expect(new Set(grouped).size).toBe(grouped.length);

    // `Main` (Dashboard/Review/Eidoverse plus the dynamic Apps row) and `Goals`
    // render as standalone top-level rows, not as collapsible section groups.
    const UNGROUPED_SECTIONS = new Set(['Main', 'Goals']);
    const sectionByPath = new Map(NAV_COMMANDS.map((command) => [command.path, command.section]));
    const presented = new Set(
      Object.keys(NAV_PRESENTATION)
        .map((path) => sectionByPath.get(path))
        .filter((section) => section && !UNGROUPED_SECTIONS.has(section)),
    );
    expect(alphabetical([...presented])).toEqual(alphabetical(grouped));
  });
});

describe('Layout — keyboard navigation shell', () => {
  it('moves skip-link focus into main content', async () => {
    // <main> belongs to the route's shell (PageShell.jsx), not to Layout itself.
    render(
      <MemoryRouter initialEntries={['/brain/inbox']}>
        <Routes>
          <Route element={<Layout />}>
            <Route element={<PaddedMain />}>
              <Route path="*" element={<div>Page</div>} />
            </Route>
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    await act(async () => {});
    const skipLink = screen.getByRole('link', { name: 'Skip to main content' });
    skipLink.focus();
    fireEvent.click(skipLink);
    expect(screen.getByRole('main')).toHaveFocus();
    expect(screen.getByRole('main')).toHaveAttribute('tabindex', '-1');
  });

  it('hides closed mobile links, traps open navigation, and restores the menu button on dismissal', async () => {
    desktopMedia.matches = false;
    const { container } = await renderLayout();
    const sidebar = container.querySelector('#app-sidebar');
    const opener = screen.getByRole('button', { name: 'Open navigation menu' });
    expect(sidebar).toHaveAttribute('inert');
    expect(sidebar).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();

    fireEvent.click(opener);
    expect(sidebar).not.toHaveAttribute('inert');
    expect(sidebar).not.toHaveAttribute('aria-hidden');
    expect(sidebar.contains(document.activeElement)).toBe(true);
    const first = document.activeElement;
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    const last = document.activeElement;
    expect(last).not.toBe(first);
    expect(sidebar.contains(last)).toBe(true);
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: 'Escape' });
    expect(opener).toHaveFocus();
    expect(opener).toHaveAttribute('aria-expanded', 'false');
    expect(sidebar).toHaveAttribute('inert');

    fireEvent.click(opener);
    fireEvent.click(within(sidebar).getByRole('button', { name: 'Close sidebar' }));
    expect(opener).toHaveFocus();
    fireEvent.click(opener);
    fireEvent.click(screen.getAllByRole('button', { name: 'Close sidebar' }).find(el => !sidebar.contains(el)));
    expect(opener).toHaveFocus();
    expect(sidebar).toHaveAttribute('inert');
  });

  it('dismisses a portaled theme picker before closing its mobile sidebar', async () => {
    desktopMedia.matches = false;
    const { container } = await renderLayout();
    const sidebar = container.querySelector('#app-sidebar');
    const opener = screen.getByRole('button', { name: 'Open navigation menu' });
    fireEvent.click(opener);
    const themeButton = within(sidebar).getByRole('button', { name: 'Switch theme. Current theme: Test' });
    fireEvent.click(themeButton);
    const option = screen.getByRole('menuitemradio', { name: /Test/ });
    expect(option).toHaveFocus();
    fireEvent.keyDown(option, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(themeButton).toHaveFocus();
    expect(opener).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(themeButton, { key: 'Escape' });
    expect(opener).toHaveFocus();
    expect(sidebar).toHaveAttribute('inert');
  });

  it('keeps desktop navigation accessible and releases the mobile trap on a breakpoint change', async () => {
    const { container } = await renderLayout();
    const sidebar = container.querySelector('#app-sidebar');
    expect(sidebar).not.toHaveAttribute('inert');
    expect(sidebar).not.toHaveAttribute('aria-hidden');
    act(() => {
      desktopMedia.matches = false;
      desktopMedia.dispatchEvent(new Event('change'));
    });
    expect(sidebar).toHaveAttribute('inert');
    const opener = screen.getByRole('button', { name: 'Open navigation menu' });
    fireEvent.click(opener);
    act(() => {
      desktopMedia.matches = true;
      desktopMedia.dispatchEvent(new Event('change'));
    });
    expect(opener).toHaveAttribute('aria-expanded', 'false');
    expect(sidebar).not.toHaveAttribute('inert');
    expect(sidebar).not.toHaveAttribute('aria-hidden');
    const link = within(sidebar).getAllByRole('link')[0];
    link.focus();
    expect(fireEvent.keyDown(link, { key: 'Tab', shiftKey: true })).toBe(true);
    act(() => {
      desktopMedia.matches = false;
      desktopMedia.dispatchEvent(new Event('change'));
    });
    expect(sidebar).toHaveAttribute('inert');
  });
});


describe('Layout — page error containment', () => {
  const renderFailingPage = async (failure) => {
    const Page = () => {
      if (failure.error) throw failure.error;
      return <div>Recovered page</div>;
    };
    const router = createMemoryRouter([{ path: '*', element: (
        <Routes>
          <Route element={<Layout />}>
            <Route element={<PaddedMain />}>
              <Route path="broken" element={<Page />} />
              <Route index element={<div>Dashboard page</div>} />
            </Route>
          </Route>
        </Routes>
    ) }], { initialEntries: ['/broken'] });
    render(<RouterProvider router={router} />);
    await act(async () => {});
    return router;
  };

  it('keeps command-palette access usable and retries the failed page', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = { error: new Error('Malformed page record') };
    try {
      await renderFailingPage(failure);
      expect(screen.getByRole('heading', { name: 'This page hit an error' })).toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent('/broken');
      expect(screen.getByText('Malformed page record').closest('details')).not.toHaveAttribute('open');
      expect(screen.getByTestId('command-palette')).toBeInTheDocument();
      const opened = vi.fn();
      document.addEventListener(CMD_K_SEARCH_OPEN_EVENT, opened, { once: true });
      fireEvent.click(screen.getAllByRole('button', { name: 'Open command palette' })[0]);
      expect(opened).toHaveBeenCalledOnce();

      failure.error = null;
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(screen.getByText('Recovered page')).toBeInTheDocument();
    } finally {
      errorLog.mockRestore();
    }
  });

  it('resets failures on sidebar and same-path search navigation', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const failure = { error: new Error('Broken record') };
      const router = await renderFailingPage(failure);
      fireEvent.click(screen.getByRole('link', { name: 'Dashboard' }));
      expect(screen.getByText('Dashboard page')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      await act(async () => router.navigate('/broken'));
      expect(screen.getByRole('alert')).toBeInTheDocument();
      failure.error = null;
      await act(async () => router.navigate('/broken?record=fixed'));
      expect(screen.getByText('Recovered page')).toBeInTheDocument();
    } finally {
      errorLog.mockRestore();
    }
  });

  it('keeps automatic stale-chunk recovery and cache-purging retry inside the shell', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    reloadOnceForStaleChunk.mockResolvedValue(false);
    try {
      await renderFailingPage({ error: new Error('Failed to fetch dynamically imported module') });
      expect(reloadOnceForStaleChunk).toHaveBeenCalledOnce();
      expect(screen.getByTestId('command-palette')).toBeInTheDocument();
      reloadOnceForStaleChunk.mockResolvedValue(true);
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })));
      expect(reloadOnceForStaleChunk).toHaveBeenLastCalledWith({ forceCachePurge: true });
      const reload = vi.fn();
      vi.stubGlobal('location', { reload });
      reloadOnceForStaleChunk.mockResolvedValue(false);
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })));
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      errorLog.mockRestore();
    }
  });
});
