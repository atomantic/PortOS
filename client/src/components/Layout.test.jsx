import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, act, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { PINNED_KEY } from '../utils/navWorkingSet.js';
import * as api from '../services/api';

// This suite locks the *integration* path that SingleNavRow.test.jsx can't reach:
// pinning a top-level `single: true` row (Dashboard `/`, Review Hub `/review`,
// OpenWorld `/openworld`, Goals `/goals/list`) must make it render in the sidebar Pinned
// section. That resolution lives in Layout itself — `navEntryByPath` indexes
// `item.single` leaves, `resolveNavEntry` maps a stored path to a row, and
// `useNavWorkingSet` feeds the Pinned-section render. We exercise the real
// nav-working-set path (seeded via localStorage) and mock everything else Layout
// pulls in (notification hooks, sockets, api fetches, theme, heavy child widgets)
// so the render is deterministic and side-effect free.

// --- Notification / status hooks: no-op, except useNotifications which feeds the
//     dropdown + the single-row badge count. ---
vi.mock('../hooks/useErrorNotifications', () => ({ useErrorNotifications: () => {} }));
vi.mock('../hooks/useSharingNotifications', () => ({ useSharingNotifications: () => {} }));
vi.mock('../hooks/useAgentFeedbackToast', () => ({ useAgentFeedbackToast: () => {} }));
vi.mock('../hooks/useAIStatusNotifications', () => ({ useAIStatusNotifications: () => {} }));
vi.mock('./UpdateBanners', () => ({ default: () => null }));
vi.mock('../hooks/useNotifications', () => ({
  useNotifications: () => ({
    notifications: [],
    unreadCount: 0,
    markAsRead: vi.fn(),
    markAllAsRead: vi.fn(),
    removeNotification: vi.fn(),
    clearAll: vi.fn(),
  }),
}));

// --- Theme context: Layout reads `theme.mode` for the day/night toggle. ---
vi.mock('./ThemeContext', () => ({
  useThemeContext: () => ({ theme: { mode: 'night', label: 'Test', pair: null }, toggleMode: vi.fn() }),
}));

// --- Heavy child widgets: render nothing so they don't open sockets / fetch. ---
vi.mock('./Logo', () => ({ default: () => null }));
vi.mock('./NotificationDropdown', () => ({ default: () => null }));
vi.mock('./voice/VoiceToggleButton', () => ({ default: () => null }));
vi.mock('./voice/VoiceWidget', () => ({ default: () => null }));
vi.mock('./CmdKSearch', () => ({ default: () => null }));
vi.mock('./KeyboardHelp', () => ({ default: () => null }));

// --- Socket: record handlers, never connect. ---
vi.mock('../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));

// --- API: every sidebar fetch resolves empty so the dynamic sections stay bare
//     and the single rows are the only top-level leaves under test. ---
// Instance features gate sidebar rows (POST / DataDog / JIRA / GSD). Default every
// feature ON so these tests see the full sidebar; the gating itself is covered
// by 'Layout — instance feature gating' below.
const allFeaturesOn = () => [
  { id: 'post', label: 'POST', enabled: true },
  { id: 'datadog', label: 'DataDog', enabled: true },
  { id: 'jira', label: 'JIRA', enabled: true },
  { id: 'gsd', label: 'GSD', enabled: true },
];
const featureMock = vi.hoisted(() => ({ features: null }));

vi.mock('../services/api', () => ({
  getApps: vi.fn(() => Promise.resolve([])),
  listPipelineSeries: vi.fn(() => Promise.resolve([])),
  listUniverses: vi.fn(() => Promise.resolve([])),
  getPaletteManifest: vi.fn(() => Promise.resolve({ nav: [] })),
  getInstanceFeatures: vi.fn(() => Promise.resolve({ features: featureMock.features })),
}));

import { __resetInstanceFeatureCache } from '../hooks/useInstanceFeatures.js';

import { NAV_COMMANDS } from '../../../server/lib/navManifest.js';
import Layout, { isFullWidthRoute, NAV_PRESENTATION } from './Layout';

const renderLayout = async (initialPath = '/brain/inbox') => {
  const utils = render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Layout />
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

describe('Layout — manifest-derived sidebar structure', () => {
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

  it('covers all sub-tabs for Settings, Digital Twin, and Messages in NAV_PRESENTATION', () => {
    const settingsPaths = [
      '/settings/general', '/settings/ai-assignments', '/settings/api-access', '/settings/autofixer',
      '/settings/backup', '/settings/code-reviewers', '/settings/database', '/settings/features',
      '/settings/security', '/settings/sharing', '/settings/signal', '/settings/spotify',
      '/settings/telegram', '/settings/voice', '/settings/youtube', '/settings/mortalloom',
      '/openclaw', '/prompts', '/ai'
    ];
    for (const p of settingsPaths) {
      expect(NAV_PRESENTATION[p], `missing NAV_PRESENTATION for settings path ${p}`).toBeDefined();
    }

    const digitalTwinTabs = [
      'overview', 'identity', 'personas', 'goals', 'taste',
      'documents', 'import', 'accounts', 'interview', 'autobiography', 'enrich',
      'test', 'personality', 'voice', 'appearance', 'avatar-bio',
      'export', 'legacy', 'time-capsule'
    ];
    for (const tab of digitalTwinTabs) {
      const p = `/digital-twin/${tab}`;
      expect(NAV_PRESENTATION[p], `missing NAV_PRESENTATION for digital twin tab ${p}`).toBeDefined();
    }

    const messageTabs = ['inbox', 'drafts', 'imessage', 'contacts', 'sync', 'config'];
    for (const tab of messageTabs) {
      const p = `/messages/${tab}`;
      expect(NAV_PRESENTATION[p], `missing NAV_PRESENTATION for message tab ${p}`).toBeDefined();
    }
  });
});

beforeEach(() => {
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
  api.listPipelineSeries.mockResolvedValue([]);
  api.listUniverses.mockResolvedValue([]);
});

describe('Layout — pinned single nav rows', () => {
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
    expect(within(pinned).getByRole('link', { name: /OpenWorld/i })).toHaveAttribute('href', '/openworld');
    expect(within(pinned).getByRole('link', { name: /Goals/i })).toHaveAttribute('href', '/goals/list');
  });

  it('omits the Pinned section entirely when nothing is pinned', async () => {
    await renderLayout();
    expect(pinnedSection()).toBeNull();
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
    expect(within(pinned).getByRole('link', { name: /OpenWorld/i })).toHaveAttribute('href', '/openworld');
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

    expect(screen.getByRole('link', { name: 'Features' })).toHaveAttribute('href', '/settings/features');
  });

  it('drops the whole POST section when POST is off', async () => {
    featureMock.features = allFeaturesOn()
      .map((f) => (f.id === 'post' ? { ...f, enabled: false } : f));

    await renderLayout('/devtools/flows');

    expect(screen.queryByRole('button', { name: 'POST' })).toBeNull();
    expect(screen.getByRole('link', { name: 'DataDog' })).toBeTruthy();
  });

  it('shows everything when the feature list cannot be read', async () => {
    api.getInstanceFeatures.mockRejectedValueOnce(new Error('offline'));

    await renderLayout('/devtools/flows');

    expect(screen.getByRole('link', { name: 'DataDog' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'POST' })).toBeTruthy();
  });
});

describe('Layout — System Resources location state', () => {
  it('keeps Dev Tools expanded and System Resources active on every subtab', async () => {
    await renderLayout('/system-resources/storage');

    const link = screen.getByRole('link', { name: 'System Resources' });
    expect(link).toHaveAttribute('href', '/system-resources');
    expect(link.className).toContain('text-port-accent');
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

    const ambientLinks = screen.getAllByRole('link', { name: 'Ambient display' });
    expect(ambientLinks).toHaveLength(2);
    ambientLinks.forEach(expectAtLeast44px);

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

  it('expands section children when the mobile sidebar opens from a collapsed desktop preference', async () => {
    localStorage.setItem('portos-sidebar-collapsed', 'true');
    await renderLayout('/');

    fireEvent.click(screen.getByRole('button', { name: 'Open navigation menu' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand Create' }));

    expect(screen.getByRole('link', { name: 'Authors' })).toHaveAttribute('href', '/authors');
  });
});

describe('Layout — Game workspace scroll mode', () => {
  it('makes only the Game detail route full-bleed', async () => {
    const detail = await renderLayout('/game/example-game');
    expect(detail.container.querySelector('#main-content')?.className).toContain('overflow-hidden');
    detail.unmount();

    const index = await renderLayout('/game');
    const main = index.container.querySelector('#main-content');
    expect(main?.className).toContain('overflow-auto');
    expect(main?.className).toContain('p-4');
    index.unmount();

    const trailingSlashIndex = await renderLayout('/game/');
    const trailingSlashMain = trailingSlashIndex.container.querySelector('#main-content');
    expect(trailingSlashMain?.className).toContain('overflow-auto');
    expect(trailingSlashMain?.className).toContain('p-4');
  });
});

// Data Manager renders its own bordered title bar over a `flex-1 overflow-auto`
// body, so it needs the bare full-width main. While it was missing from the
// tables it nested that scroller inside `<main>`'s own `overflow-auto p-4
// md:p-6` — two scrollbars, doubled padding (#4145).
describe('Layout — Data Manager scroll mode', () => {
  it('gives /data the bare full-width main, and leaves /devtools/datadog padded', async () => {
    const dataManager = await renderLayout('/data');
    const dataMain = dataManager.container.querySelector('#main-content');
    expect(dataMain?.className).toContain('overflow-hidden');
    expect(dataMain?.className).not.toContain('overflow-auto');
    expect(dataMain?.className).not.toContain('p-4');
    dataManager.unmount();

    const dataDog = await renderLayout('/devtools/datadog');
    const dataDogMain = dataDog.container.querySelector('#main-content');
    expect(dataDogMain?.className).toContain('overflow-auto');
    expect(dataDogMain?.className).toContain('p-4');
  });
});

describe('Layout — dynamic third-level navigation', () => {
  it('collapses and expands the Series and Universes children', async () => {
    api.listPipelineSeries.mockResolvedValue([{ id: 'series-1', name: 'Example Series' }]);
    api.listUniverses.mockResolvedValue([{ id: 'universe-1', name: 'Example Universe' }]);

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
});

// `isFullWidthRoute` decides whether a page gets the bare full-width <main>
// (owns its own scroll) or the default padded+scrolling one. It encodes 41
// rules across three tables, and the only other coverage is the /game
// integration case above — so a dropped or retyped entry would silently
// change a page's layout with nothing failing. Every expectation below was
// verified against the pre-refactor OR-chain, so this locks behavior rather
// than merely restating the current tables.
describe('Layout — isFullWidthRoute classification', () => {
  it.each([
    // Exact matches must NOT leak to longer paths that merely share the prefix.
    ['/shell', true], ['/shell/abc', true], ['/shellx', false],
    ['/ask', true], ['/ask/1', true], ['/asking', false],
    ['/timeline', true], ['/timeline/2026-08-12', true],
    ['/tribe', true], ['/rapid-reader', true], ['/openclaw', true],
    // Index page stays padded+scrolling; only the DETAIL route is full-width.
    ['/catalog', false], ['/catalog/book/1', true],
    ['/universes', false], ['/universes/u1', true],
    ['/rounds', false], ['/rounds/guide', true],
    ['/story-builder', false], ['/story-builder/s1/step', true],
    // AI Providers: the index AND its editor sub-routes (a drawer over the same
    // page) are full-width, but a sibling path sharing the `/ai` prefix is not.
    ['/ai', true], ['/ai/new', true], ['/ai/edit/codex', true], ['/airlock', false],
    ['/pipeline', false], ['/pipeline/series/s1', true],
    ['/local-llm', false], ['/local-llm/m', true],
    // Music owns the same full-bleed title/tab/body shell as Media Gen, but
    // its similarly named Music Video route is classified independently.
    ['/music', true], ['/music/generate', true], ['/music-video', false],
    // Game: only a single-segment detail workspace.
    ['/game', false], ['/game/', false], ['/game/g1', true], ['/game/g1/x', false],
    // Apps: detail editor is full-width, but the Add App form is explicitly excluded
    // (it has no internal scroll container and would clip below the fold).
    ['/apps/create', false], ['/apps/create/', false], ['/apps/a1', true], ['/apps/a1/tab', true],
    // Data Manager owns its own bar+scroll shell, and is registered EXACT so
    // it can't leak onto the DataDog routes that share the `/data` prefix.
    ['/data', true], ['/datadog', false], ['/devtools/datadog', false],
    // Models owns the same header/tabs/scroll shell as Settings — registered as
    // a whole-section prefix, so the bare path and every tab classify alike.
    ['/models', true], ['/models/performance', true], ['/models/llms', true],
    // Whole-section prefixes, and the default for an unlisted route.
    ['/songbook', true], ['/', false],
  ])('%s -> %s', (pathname, expected) => {
    expect(isFullWidthRoute(pathname)).toBe(expected);
  });
});
