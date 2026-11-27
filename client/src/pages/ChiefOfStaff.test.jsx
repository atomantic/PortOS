import {
  api,
  toast,
  socketStub,
  ChiefOfStaff,
  config,
  withFakeTimers,
  renderPageAt,
  waitForPageShell,
  renderSettledAt,
  renderSettledConfigTab,
  installChiefOfStaffHooks,
} from './ChiefOfStaff.test.fixture.jsx';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router';

installChiefOfStaffHooks();

const { LAZY_AVATARS, INLINE_RENDERED_AVATAR_STYLES } = await import('../components/cos/CosAgentPanel');

const { AVATAR_STYLE_IDS } = await import('../../../server/lib/avatarStyles.js');

const renderSettledEmptyAgentsTab = async () => {
  // The shell can settle before React.lazy mounts AgentsTab. Mount its resolved
  // module inside act, then await all three independent reads and their React
  // commits rather than guessing how many empty microtask flushes they need.
  await act(async () => { await import('../components/cos/tabs/AgentsTab'); });
  let result;
  await act(async () => { result = renderPageAt('agents'); });
  await waitForPageShell();
  const mountReads = [api.getCosLearningDurations, api.getCosCompletedAgents, api.getCosPendingAgentFeedback];
  await waitFor(() => {
    for (const read of mountReads) expect(read).toHaveBeenCalled();
  });
  await act(async () => {
    await Promise.all(mountReads.flatMap(read => read.mock.results.map(result => result.value)));
  });
  expect(screen.getByText('No active agents. Start CoS and add tasks to see agents working.')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: /Completed Agents/ })).toBeNull();
  return result;
};

// #4144 — `/cos` is an `isFullWidth` route, so its `<main>` is a bare
// `relative overflow-hidden`. The old centered `h-64` BrailleSpinner reserved
// none of the loaded two-pane shell, and the whole page jumped into place on
// first paint. jsdom does no layout, so the guard pins the structure that
// reserves those dimensions: the busy region IS the two-pane grid.
describe('ChiefOfStaff loading skeleton', () => {
  it('reserves the two-pane shell instead of a centered spinner while loading', async () => {
    // Hold the first fetch open so the loading branch is what renders.
    api.getCosStatus.mockReturnValue(new Promise(() => {}));
    const { container } = renderPageAt('config');

    const busy = await screen.findByRole('status');
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(busy).toHaveAttribute('aria-label', 'Loading Chief of Staff');
    expect(busy.className).toContain('cos-wide:grid-cols-[320px_1fr]');
    expect(busy.className).toContain('h-full');
    expect(busy.lastElementChild).toHaveClass('p-3', 'lg:p-4');
    // The old spinner shell — a fixed 16rem box centering its child.
    expect(container.querySelector('.h-64')).toBeNull();
  });

  it('shows the queue before the slow ancillary reads settle', async () => {
    let insightsReleased = false;
    let resolveInsights;
    const insightsPromise = new Promise((resolve) => { resolveInsights = resolve; });
    api.getCosTasks.mockResolvedValue({
      user: { tasks: [{ id: 'task-1', description: 'Example queued task', status: 'pending', metadata: {} }] },
      cos: { tasks: [] },
    });
    api.getCosActionableInsights.mockReturnValue(insightsPromise);

    // Start the real lazy module before the page mounts. A contended worker can
    // spend the whole async assertion budget transforming TasksTab (which pulls
    // in the task editor and drag/drop stack); warming only this module keeps
    // this regression focused on core queue scheduling. The navigation tests
    // below still exercise selecting lazy tab content through the page.
    const tasksTabReady = import('../components/cos/tabs/TasksTab');
    renderPageAt('tasks');

    try {
      await waitFor(() => expect(api.getCosActionableInsights).toHaveBeenCalled());
      // The shell boundary proves queue rendering did not wait for the held
      // insights read. Await the lazy module separately before spending the
      // query budget on the component's own local task-state effect.
      await waitForPageShell();
      await act(async () => {
        await tasksTabReady;
      });
      expect(await screen.findByRole('heading', { name: 'Task queue' })).toBeInTheDocument();
      expect(await screen.findByText('Example queued task')).toBeInTheDocument();
      expect(insightsReleased).toBe(false);
    } finally {
      // Do not strand the intentionally unresolved ancillary read if a boundary
      // assertion fails; React must be able to settle before test cleanup.
      if (!insightsReleased) {
        await act(async () => {
          insightsReleased = true;
          resolveInsights({ insights: [] });
        });
      }
    }
  });
});

// CoS has eight primary tabs, so it is past the compact threshold on
// a phone. It collapses to TabPills' ICON ROW — the same buttons, labels kept
// for assistive tech — rather than the `<select>` #7283 briefly made universal.
// The scroll chevrons that used to be hand-rolled here now live in TabPills.
describe('ChiefOfStaff Schedule app targets', () => {
  it('blocks an app task in both the card and drawer until a retry loads a selectable target', async () => {
    let rejectApps;
    let resolveRetry;
    api.getApps
      .mockReturnValueOnce(new Promise((_, reject) => { rejectApps = reject; }))
      .mockReturnValueOnce(new Promise(resolve => { resolveRetry = resolve; }));
    api.getCosSchedule.mockResolvedValue({
      improvementEnabled: true,
      tasks: {
        review: { type: 'on-demand', enabled: true, displayName: 'Example Review' },
        'universe-bible-describe': { type: 'on-demand', enabled: true, displayName: 'Bible descriptions', programmatic: true },
      },
    });
    api.triggerCosOnDemandTask.mockResolvedValue({ success: true });

    await act(async () => { renderPageAt('schedule'); });
    await waitForPageShell();
    const loading = await screen.findByRole('button', { name: 'Loading apps…' });
    expect(loading).toBeDisabled();
    expect(loading).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(loading);
    expect(api.triggerCosOnDemandTask).not.toHaveBeenCalled();

    // The unrelated task still works while the app list is pending.
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Run Now' })));
    expect(api.triggerCosOnDemandTask).toHaveBeenCalledWith('universe-bible-describe', null, { silent: true });

    await act(async () => fireEvent.click(screen.getByText('Example Review')));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByRole('button', { name: 'Loading apps…' })).toBeDisabled();
    await act(async () => rejectApps(new Error('Example registry failure')));
    expect(within(drawer).getByRole('button', { name: 'Apps unavailable' })).toBeDisabled();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Apps unavailable' }));
    expect(api.triggerCosOnDemandTask).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /Close/i }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh' })));
    expect(await screen.findByRole('button', { name: 'Loading apps…' })).toBeDisabled();
    await act(async () => resolveRetry([{ id: 'real-app', name: 'Example Repo' }]));
    fireEvent.click(await screen.findByRole('button', { name: 'Run on App' }));
    const app = await screen.findByRole('button', { name: 'Example Repo' });
    await act(async () => fireEvent.click(app));
    expect(api.triggerCosOnDemandTask).toHaveBeenCalledTimes(2);
    expect(api.triggerCosOnDemandTask).toHaveBeenLastCalledWith('review', 'real-app', { silent: true });
  });
});

describe('ChiefOfStaff mobile tab navigation', () => {
  it('collapses to named icon links on the phone, not a select', async () => {
    await renderSettledAt('tasks');

    expect(screen.queryByRole('combobox', { name: 'Chief of Staff sections' })).toBeNull();
    const tasksTab = screen.getByRole('tab', { name: 'Tasks' });
    expect(tasksTab).toHaveAttribute('aria-selected', 'true');
    expect(tasksTab.querySelector('svg')).toBeTruthy();
    expect(tasksTab.querySelector('.max-sm\\:sr-only')).toBeTruthy();
  });

  it.each([
    ['runs', 'Runs', 'Run Events', 'events'],
    ['schedule', 'Schedule', 'Timeline', 'timeline'],
    ['briefing', 'Briefing', 'Digest', 'digest'],
  ])('shows the %s subview within its primary tab', async (parent, label, view, viewId) => {
    await renderSettledAt(`${parent}/${viewId}`);

    const tabBar = screen.getByRole('tablist', { name: 'Chief of Staff sections' });
    expect(within(tabBar).getAllByRole('tab')).toHaveLength(8);
    expect(within(tabBar).getByRole('tab', { name: label })).toHaveAttribute('aria-selected', 'true');
    const panel = screen.getByRole('tabpanel', { name: label });
    const link = within(panel).getByRole('link', { name: view });
    expect(link).toHaveAttribute('aria-current', 'page');
    expect(link).toHaveAttribute('href', `/cos/${parent}/${viewId}`);

    await act(async () => fireEvent.click(within(panel).getAllByRole('link')[0]));
    expect(link).not.toHaveAttribute('aria-current');
    expect(within(tabBar).getByRole('tab', { name: label })).toHaveAttribute('aria-selected', 'true');
  });

  it('navigates to the tab route when an icon is clicked', async () => {
    await renderSettledAt('tasks');

    fireEvent.click(screen.getByRole('tab', { name: 'Agents' }));

    const panel = await screen.findByRole('tabpanel');
    expect(panel).toHaveAttribute('id', 'tabpanel-agents');
  });
});

// #15237 — on a landscape phone the stacked agent panel consumed the whole
// viewport height, so every tab but Tasks showed no content until the chevron
// was found. A short viewport now starts collapsed, tracks rotation, and never
// overrides an explicit toggle.
describe('ChiefOfStaff agent panel on a short viewport (#15237)', () => {
  const stubViewport = (short) => {
    const listeners = new Set();
    const media = {
      get matches() { return short.value; },
      addEventListener: (_type, fn) => listeners.add(fn),
      removeEventListener: (_type, fn) => listeners.delete(fn),
    };
    vi.stubGlobal('matchMedia', vi.fn((query) => (query === '(max-height: 500px)'
      ? media
      : { matches: false, addEventListener: () => {}, removeEventListener: () => {} })));
    return () => {
      // A change fired before the page subscribes would be silently lost.
      expect(listeners.size).toBeGreaterThan(0);
      act(() => { listeners.forEach((fn) => fn()); });
    };
  };
  const panelToggle = () => document.querySelector('button[aria-controls="cos-agent-panel"]');

  afterEach(() => vi.unstubAllGlobals());

  it('starts collapsed in landscape and stays expanded in portrait', async () => {
    stubViewport({ value: true });
    const { unmount } = await renderSettledEmptyAgentsTab();
    expect(panelToggle()).toHaveAttribute('aria-expanded', 'false');
    unmount();

    stubViewport({ value: false });
    await renderSettledEmptyAgentsTab();
    expect(panelToggle()).toHaveAttribute('aria-expanded', 'true');
  });

  it('collapses on rotation until the user toggles the panel', async () => {
    const short = { value: false };
    const notify = stubViewport(short);
    await renderSettledEmptyAgentsTab();
    expect(panelToggle()).toHaveAttribute('aria-expanded', 'true');

    short.value = true;
    notify();
    expect(panelToggle()).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(panelToggle());
    expect(panelToggle()).toHaveAttribute('aria-expanded', 'true');
    short.value = false;
    notify();
    short.value = true;
    notify();
    expect(panelToggle()).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('ChiefOfStaff mind tab layout', () => {
  it('fills leftover desktop height so the chat can use the viewport', async () => {
    const { container } = await renderSettledAt('mind');
    const content = container.querySelector('.overflow-y-auto.overflow-x-hidden');
    expect(content.className).toContain('flex-col');
    const panel = document.getElementById('tabpanel-mind');
    expect(panel.className).toContain('xl:flex-1');
    expect(panel.className).toContain('min-h-0');
  });
});

describe('ChiefOfStaff config mount readiness (#11548)', () => {
  it('commits the lazy configuration controls before the settled mount returns', async () => {
    await renderSettledConfigTab();

    // Synchronous on purpose: another findBy here would hide an incomplete
    // mount by spending the control query's budget on the Suspense retry.
    expect(screen.getByRole('heading', { name: 'Chief of Staff settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Force Evaluate/i })).toBeEnabled();
  });

  it('requires a confirmed config before editing and retains it when a refresh fails', async () => {
    api.getCosStatus.mockResolvedValue({
      running: false,
      config: {
        ...config,
        domainAutonomy: { cos: 'dry-run' },
        domainBudgets: { cos: { maxActionsPerDay: 7, maxMinutesPerDay: 15 } },
        safetyKindApproval: { enabled: true, alwaysApproveKinds: ['content'] },
      },
    }).mockRejectedValueOnce(new Error('Unavailable'));

    await renderSettledConfigTab();
    const panel = within(screen.getByRole('tabpanel', { name: 'Config' }));
    const error = panel.getByRole('alert');
    expect(error).toHaveTextContent('Could not load CoS status.');
    expect(panel.queryByRole('heading', { name: 'Chief of Staff settings' })).not.toBeInTheDocument();
    expect(panel.queryByRole('checkbox', { name: /^Publish/ })).not.toBeInTheDocument();
    expect(api.updateCosConfig).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(within(error).getByRole('button', { name: 'Retry CoS status' }));
    });

    const expectConfirmedValues = () => {
      const mode = panel.getByRole('group', { name: 'CoS auto-run mode' });
      expect(within(mode).getByRole('button', { name: 'Dry-run' })).toHaveAttribute('aria-pressed', 'true');
      const domain = within(mode.closest('article'));
      expect(domain.getByRole('spinbutton', { name: 'Actions/day' })).toHaveValue(7);
      expect(domain.getByRole('spinbutton', { name: 'Minutes/day' })).toHaveValue(15);
      expect(panel.getByRole('checkbox', { name: /^Content/ })).toBeChecked();
      for (const name of [/^Publish/, /^Federation/, /^External PR/]) {
        expect(panel.getByRole('checkbox', { name })).not.toBeChecked();
      }
    };
    expect(panel.queryByRole('alert')).not.toBeInTheDocument();
    expectConfirmedValues();

    api.getCosStatus.mockRejectedValueOnce(new Error('Unavailable'));
    await act(async () => { socketStub.receive('cos:config:changed'); });
    expect(panel.getByRole('alert')).toHaveTextContent('Could not load CoS status.');
    expectConfirmedValues();
    expect(api.updateCosConfig).not.toHaveBeenCalled();
  });
});

describe('ChiefOfStaff handleForceEvaluate', () => {
  it('does not toast success or advance the status message when the evaluate fails', async () => {
    api.forceCosEvaluate.mockRejectedValue(new Error('evaluate failed'));
    await renderSettledConfigTab();

    const button = await screen.findByRole('button', { name: /Force Evaluate/i });
    fireEvent.click(button);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('evaluate failed'));
    expect(toast.success).not.toHaveBeenCalled();
    // State contract: a failed evaluate must NOT switch the status bubble to the
    // "Evaluating tasks..." (thinking) message — it stays on the idle message.
    expect(screen.queryAllByText('Evaluating tasks...')).toHaveLength(0);
    // Generic idle text renders as the avatar pill, which carries it as its title.
    expect(screen.queryAllByTitle('Idle - waiting for tasks...').length).toBeGreaterThan(0);
  });

  it('toasts success and advances the status message after the evaluate resolves', async () => {
    api.forceCosEvaluate.mockResolvedValue({ success: true });
    await renderSettledConfigTab();

    const button = await screen.findByRole('button', { name: /Force Evaluate/i });
    fireEvent.click(button);

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Evaluation triggered'));
    expect(toast.error).not.toHaveBeenCalled();
    // State contract: success advances the status bubble to the evaluating message.
    await waitFor(() => expect(screen.queryAllByText('Evaluating tasks...').length).toBeGreaterThan(0));
    // Must pass { silent: true } so the custom catch is the only error toast.
    expect(api.forceCosEvaluate).toHaveBeenCalledWith({ silent: true });
  });
});

describe('ChiefOfStaff daemon pause controls', () => {
  it('pauses new CoS scheduling through the persistent pause API', async () => {
    api.getCosStatus.mockResolvedValue({ running: true, paused: false, config, stats: {} });
    await renderSettledConfigTab();

    fireEvent.click((await screen.findAllByRole('button', { name: /pause chief of staff scheduling/i }))[0]);

    await waitFor(() => expect(api.pauseCos).toHaveBeenCalledWith(
      'Paused from Chief of Staff controls',
      { silent: true },
    ));
    expect(toast.success).toHaveBeenCalledWith('Chief of Staff paused');
  });

  it('resumes task dispatch only from an explicit Resume action', async () => {
    api.getCosStatus.mockResolvedValue({
      running: true,
      paused: true,
      pauseReason: 'Supervised maintenance',
      config,
      stats: {},
    });
    await renderSettledConfigTab();

    expect((await screen.findAllByText('Paused')).length).toBeGreaterThan(0);

    fireEvent.click((await screen.findAllByRole('button', { name: /resume chief of staff scheduling/i }))[0]);

    await waitFor(() => expect(api.resumeCos).toHaveBeenCalledWith({ silent: true }));
    expect(toast.success).toHaveBeenCalledWith('Chief of Staff resumed');
  });

  it('uses a smaller font for the resume button so it fits inside the compact card box', async () => {
    api.getCosStatus.mockResolvedValue({
      running: true,
      paused: true,
      pauseReason: 'Supervised maintenance',
      config,
      stats: {},
    });
    await renderSettledConfigTab();

    const resumeButtons = await screen.findAllByRole('button', { name: /resume chief of staff scheduling/i });
    expect(resumeButtons[0].querySelector('.text-xs')).toHaveTextContent('Resume');
    expect(resumeButtons[0].querySelector('.text-sm')).toBeNull();
  });
});

describe('Rigged avatar style', () => {
  it('renders a rigged record on the mini-character stage with its coverage', async () => {
    api.getCosStatus.mockResolvedValue({
      running: true,
      config: { ...config, avatarStyle: 'rigged-image3d-1' },
      stats: {},
    });
    api.getRiggedAvatars.mockResolvedValue({
      records: [{
        id: 'image3d-1',
        name: 'Example Dancer',
        variant: 'rigged-image3d-1',
        clip: 'Dance',
        coverage: { coveredStates: ['ideating'], missingStates: ['coding'], complete: false },
      }],
    });
    await renderSettledAt('tasks');

    const avatar = await screen.findByTestId('rigged-avatar');
    expect(avatar).toHaveAttribute('data-variant', 'rigged-image3d-1');
    expect(avatar).toHaveAttribute('data-covered', 'ideating');
  });

  it('still renders the stage when the rigged record is gone', async () => {
    api.getCosStatus.mockResolvedValue({
      running: true,
      config: { ...config, avatarStyle: 'rigged-image3d-gone' },
      stats: {},
    });
    api.getRiggedAvatars.mockResolvedValue({ records: [] });
    await renderSettledAt('tasks');

    // No coverage to hand over (null), but the variant URL still probes —
    // a deleted record shows the stage's missing-model hint, not a crash.
    const avatar = await screen.findByTestId('rigged-avatar');
    expect(avatar).toHaveAttribute('data-variant', 'rigged-image3d-gone');
    expect(avatar).toHaveAttribute('data-covered', '');
  });
});

it('compacts the mobile persona on entering Tasks until the user chooses its size', async () => {
  await renderSettledAt('agents');
  const toggle = () => document.querySelector('button[aria-controls="cos-agent-panel"]');
  expect(toggle()).toHaveAttribute('aria-expanded', 'true');
  await act(async () => { fireEvent.click(screen.getByRole('tab', { name: 'Tasks', exact: true })); });
  await waitFor(() => expect(toggle()).toHaveAttribute('aria-expanded', 'false'));
  fireEvent.click(toggle());
  await act(async () => { fireEvent.click(screen.getByRole('tab', { name: 'Agents', exact: true })); });
  await act(async () => { fireEvent.click(screen.getByRole('tab', { name: 'Tasks', exact: true })); });
  expect(toggle()).toHaveAttribute('aria-expanded', 'true');
});

it('preserves focus after a keyboard toggle and saves the persona collapse preference', async () => {
  const user = userEvent.setup();
  localStorage.setItem('cos-panel-collapsed', 'true');
  await renderSettledAt('tasks');
  const expand = screen.getByRole('button', { name: 'Expand CoS panel' });
  expect(expand).not.toHaveFocus();
  expand.focus();
  await user.keyboard('{Enter}');
  expect(localStorage.getItem('cos-panel-collapsed')).toBe('false');
  const collapse = screen.getByRole('button', { name: 'Collapse CoS panel' });
  expect(collapse).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(localStorage.getItem('cos-panel-collapsed')).toBe('true');
  expect(screen.getByRole('button', { name: 'Expand CoS panel' })).toHaveFocus();
  localStorage.removeItem('cos-panel-collapsed');
});

describe('CoS agent panel layout sizing', () => {
  it('constrains panel container width with w-full and min-w-0 for non-canvas avatar styles', async () => {
    api.getCosStatus.mockResolvedValue({
      running: true,
      config: { ...config, avatarStyle: 'svg' },
      stats: { tasksCompleted: 5 },
    });
    await renderSettledAt('tasks');

    const panel = document.getElementById('cos-agent-panel');
    expect(panel).toBeInTheDocument();
    expect(panel?.className).toContain('w-full');
    expect(panel?.className).toContain('max-w-full');
    expect(panel?.className).toContain('min-w-0');

    // Inner container holding the avatar, title, and desktop stats grid
    // must retain cos-wide:w-full and min-w-0 when hasCanvasAvatar is false,
    // preventing child content like EventLog or StatCards from expanding
    // beyond the 320px rail.
    const title = screen.getByRole('heading', { level: 2, name: 'Chief of Staff' });
    const innerContainer = title.parentElement;
    expect(innerContainer?.className).toContain('cos-wide:w-full');
    expect(innerContainer?.className).toContain('min-w-0');
  });
});

// #6253 — every avatar style in the shared registry (`lib/avatarStyles.js`)
// must render through either the lazy-load map or the inline-rendered pair,
// or a style added to the registry alone silently falls through to the
// default `CoSCharacter` render instead of failing loudly.
describe('avatar-style registry coverage', () => {
  it('has a render path for every registry id, and no extra map entries', () => {
    const lazyIds = new Set(Object.keys(LAZY_AVATARS));
    for (const id of AVATAR_STYLE_IDS) {
      expect(
        lazyIds.has(id) || INLINE_RENDERED_AVATAR_STYLES.has(id),
        `avatar style "${id}" is missing from both LAZY_AVATARS and INLINE_RENDERED_AVATAR_STYLES`
      ).toBe(true);
    }
    for (const id of lazyIds) {
      expect(AVATAR_STYLE_IDS, `LAZY_AVATARS has an entry for unknown style "${id}"`).toContain(id);
    }
    for (const id of INLINE_RENDERED_AVATAR_STYLES) {
      expect(AVATAR_STYLE_IDS, `INLINE_RENDERED_AVATAR_STYLES has an entry for unknown style "${id}"`).toContain(id);
    }
  });
});

describe('ChiefOfStaff route-scoped data', () => {
  it.each(['config', 'health', 'mind'])('does not fetch task or agent collections on %s, including refresh events', async tab => {
    withFakeTimers();
    await renderSettledAt(tab);
    await act(async () => {
      for (const event of ['apps:changed', 'cos:tasks:changed', 'cos:agent:spawned', 'cos:agent:completed']) {
        socketStub.on.mock.calls.find(([name]) => name === event)?.[1]({});
      }
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(api.getCosTasks).not.toHaveBeenCalled();
    expect(api.getCosAgents).not.toHaveBeenCalled();
    if (tab !== 'health') expect(api.getProviders).not.toHaveBeenCalled();
    expect(api.getApps).not.toHaveBeenCalled();
    expect(api.getCosActionableInsights).not.toHaveBeenCalled();
  });

  it('stays idle without polling and invalidates apps/providers independently', async () => {
    withFakeTimers();
    await renderSettledAt('agents');
    await waitFor(() => expect(api.getCosCompletedAgents).toHaveBeenCalledTimes(1));
    const reads = [api.getCosAgents, api.getProviders, api.getApps, api.getCosCompletedAgents];
    const before = reads.map(read => read.mock.calls.length);
    await act(async () => { await vi.advanceTimersByTimeAsync(65_000); });
    expect(reads.map(read => read.mock.calls.length)).toEqual(before);
    const latestHandler = name => socketStub.on.mock.calls.filter(([event]) => event === name).at(-1)[1];
    await act(async () => {
      latestHandler('apps:changed')(); latestHandler('apps:changed')();
      await vi.advanceTimersByTimeAsync(450);
    });
    expect(api.getApps).toHaveBeenCalledTimes(before[2] + 1);
    expect(api.getProviders).toHaveBeenCalledTimes(before[1]);
    expect(api.getCosAgents).toHaveBeenCalledTimes(before[0]);
    await act(async () => {
      latestHandler('providers:changed')();
      await vi.advanceTimersByTimeAsync(450);
    });
    expect(api.getProviders).toHaveBeenCalledTimes(before[1] + 1);
    await act(async () => { socketStub.receive('connect'); });
    expect(api.getCosAgents).toHaveBeenCalledTimes(before[0] + 1);
    expect(api.getCosTasks).not.toHaveBeenCalled();
  });

  it('recovers a config invalidation received during an in-flight initial read', async () => {
    let releaseStatus;
    api.getCosStatus.mockReturnValueOnce(new Promise(resolve => { releaseStatus = resolve; }));
    renderPageAt('config');
    await waitFor(() => expect(api.getCosStatus).toHaveBeenCalledTimes(1));
    api.getCosStatus.mockResolvedValue({ running: true, paused: true, config, stats: {} });
    await act(async () => {
      socketStub.on.mock.calls.find(([event]) => event === 'cos:config:changed')[1]();
      releaseStatus({ running: false, config, stats: {} });
    });
    await waitFor(() => expect(api.getCosStatus).toHaveBeenCalledTimes(2));
    expect((await screen.findAllByRole('button', { name: /Resume Chief of Staff scheduling/i })).length).toBeGreaterThan(0);
  });

  it('loads agents when navigating from another CoS tab without waiting for the poll', async () => {
    await renderSettledAt('mind');
    expect(api.getCosAgents).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('tab', { name: 'Agents' }));
    await waitFor(() => expect(api.getCosAgents).toHaveBeenCalledWith(expect.objectContaining({ active: true })));
    expect(api.getCosTasks).not.toHaveBeenCalled();
  });
});

// #18643 — the page used to key every read on the tab id, so each tab switch
// refetched status, health and learning and tore down and re-registered every
// socket listener. Shell data now loads once per visit and each slice (queue +
// insights, active agents, providers, apps) when it first becomes needed.
describe('ChiefOfStaff tab switches', () => {
  const TABS_TO_VISIT = ['briefing', 'config', 'health', 'tasks', 'agents', 'mind'];
  function NavProbe() {
    const navigate = useNavigate();
    return TABS_TO_VISIT.map(id => (
      <button key={id} type="button" onClick={() => navigate(`/cos/${id}`)}>{`go ${id}`}</button>
    ));
  }
  const getSocketHandler = (event) => socketStub.on.mock.calls.find(([evt]) => evt === event)?.[1];
  const queueReads = () => api.getCosTasks.mock.calls.filter(([args]) => args?.view === 'queue').length;
  // The page hook registers all its listeners in one effect; these two events
  // have no other client subscriber, so their counts are that effect's runs.
  const HOOK_ONLY_EVENTS = ['cos:log', 'cos:health:check'];
  const hookRegistrations = (fn) => fn.mock.calls.filter(([event]) => HOOK_ONLY_EVENTS.includes(event)).length;
  const shellReads = () => [api.getCosStatus, api.getCosHealth, api.getCosLearningSummary].map(fn => fn.mock.calls.length);
  const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
  const goTo = async (id) => {
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: `go ${id}` })); });
    await settle();
  };
  const renderWithProbe = async (tab) => {
    render(
      <MemoryRouter initialEntries={[`/cos/${tab}`]}>
        <Routes>
          <Route path="/cos/:tab" element={<><ChiefOfStaff /><NavProbe /></>} />
        </Routes>
      </MemoryRouter>,
    );
    await waitForPageShell();
    await settle();
  };

  it('reads status, health and learning once and registers listeners once across tabs that need no slice', async () => {
    await renderWithProbe('briefing');
    expect(shellReads()).toEqual([1, 1, 1]);
    const registrations = { on: hookRegistrations(socketStub.on), off: hookRegistrations(socketStub.off) };
    expect(registrations).toEqual({ on: HOOK_ONLY_EVENTS.length, off: 0 });

    await goTo('config');
    await goTo('health');

    expect(shellReads()).toEqual([1, 1, 1]);
    expect(hookRegistrations(socketStub.on)).toBe(registrations.on);
    expect(hookRegistrations(socketStub.off)).toBe(registrations.off);
    expect(api.getCosAgents).not.toHaveBeenCalled();
    expect(queueReads()).toBe(0);
  });

  it('does not refetch anything the Agents tab already holds when moving from Tasks', async () => {
    await renderWithProbe('tasks');
    const before = {
      shell: shellReads(), agents: api.getCosAgents.mock.calls.length, queue: queueReads(),
      insights: api.getCosActionableInsights.mock.calls.length, providers: api.getProviders.mock.calls.length,
      apps: api.getApps.mock.calls.length, on: hookRegistrations(socketStub.on), off: hookRegistrations(socketStub.off),
    };
    expect(before.agents).toBe(1);

    await goTo('agents');

    expect(shellReads()).toEqual(before.shell);
    expect(api.getCosAgents.mock.calls.length).toBe(before.agents);
    expect(queueReads()).toBe(before.queue);
    expect(api.getCosActionableInsights.mock.calls.length).toBe(before.insights);
    expect(api.getProviders.mock.calls.length).toBe(before.providers);
    expect(api.getApps.mock.calls.length).toBe(before.apps);
    expect(hookRegistrations(socketStub.on)).toBe(before.on);
    expect(hookRegistrations(socketStub.off)).toBe(before.off);
  });

  it('reads exactly the queue, agents and insights slices when Tasks is first opened, and no shell data', async () => {
    await renderWithProbe('briefing');
    const shell = shellReads();
    expect(api.getCosAgents).not.toHaveBeenCalled();

    await goTo('tasks');

    expect(queueReads()).toBe(1);
    expect(api.getCosAgents).toHaveBeenCalledTimes(1);
    expect(api.getCosActionableInsights).toHaveBeenCalledTimes(1);
    expect(api.getCosActionableInsights).toHaveBeenCalledWith({ cachedHealth: true, silent: true });
    expect(api.getProviders).toHaveBeenCalledTimes(1);
    expect(shellReads()).toEqual(shell);
  });

  it('retries a failed provider read on the next tab switch that still needs providers', async () => {
    api.getProviders.mockRejectedValueOnce(new Error('offline'));
    await renderWithProbe('tasks');
    expect(api.getProviders).toHaveBeenCalledTimes(1);

    await goTo('agents');
    expect(api.getProviders).toHaveBeenCalledTimes(2);

    await goTo('tasks');
    expect(api.getProviders).toHaveBeenCalledTimes(2);
  });

  it('retries a failed app read on the next tab switch between app-dependent tabs, and keeps a good snapshot', async () => {
    api.getApps.mockRejectedValueOnce(new Error('offline'));
    await renderWithProbe('tasks');
    expect(api.getApps).toHaveBeenCalledTimes(1);

    await goTo('agents');
    expect(api.getApps).toHaveBeenCalledTimes(2);

    await goTo('tasks');
    await goTo('agents');
    expect(api.getApps).toHaveBeenCalledTimes(2);
  });

  it('retries a failed provider invalidation after an earlier good load', async () => {
    withFakeTimers();
    await renderWithProbe('tasks');
    expect(api.getProviders).toHaveBeenCalledTimes(1);

    api.getProviders.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { getSocketHandler('providers:changed')(); await vi.advanceTimersByTimeAsync(450); });
    expect(api.getProviders).toHaveBeenCalledTimes(2);

    await goTo('agents');
    expect(api.getProviders).toHaveBeenCalledTimes(3);
    await goTo('tasks');
    expect(api.getProviders).toHaveBeenCalledTimes(3);
  });

  it('reads agents again when Agents is re-entered, because events were ignored while it was away', async () => {
    await renderWithProbe('agents');
    expect(api.getCosAgents).toHaveBeenCalledTimes(1);
    await goTo('mind');
    expect(api.getCosAgents).toHaveBeenCalledTimes(1);
    await goTo('agents');
    expect(api.getCosAgents).toHaveBeenCalledTimes(2);
    expect(shellReads()).toEqual([1, 1, 1]);
  });

  it('still refreshes the queue for an event received just before a tab switch', async () => {
    withFakeTimers();
    await renderWithProbe('briefing');
    const shell = shellReads();

    await act(async () => { getSocketHandler('cos:tasks:changed')({ type: 'internal', action: 'updated' }); });
    await goTo('tasks');
    expect(queueReads()).toBe(1);

    // The coalesced refresh survives the switch and reads the slices the page
    // needs when it fires: a second queue read plus the status summary, but
    // neither health nor learning.
    await act(async () => { await vi.advanceTimersByTimeAsync(450); });
    await settle();
    expect(queueReads()).toBe(2);
    expect(api.getCosStatus.mock.calls.length).toBe(shell[0] + 1);
    expect(api.getCosHealth.mock.calls.length).toBe(shell[1]);
    expect(api.getCosLearningSummary.mock.calls.length).toBe(shell[2]);
  });

  it('drops a slice read that a round trip through another tab has superseded', async () => {
    const task = (description) => ({ user: { tasks: [{ id: 'task-1', description, status: 'pending', metadata: {} }] }, cos: { tasks: [] } });
    let releaseStale;
    await renderWithProbe('briefing');
    api.getCosTasks.mockReturnValueOnce(new Promise(resolve => { releaseStale = () => resolve(task('STALE first activation')); }));
    await goTo('tasks');
    await goTo('briefing');
    api.getCosTasks.mockResolvedValue(task('FRESH second activation'));
    await goTo('tasks');
    expect(await screen.findByText('FRESH second activation')).toBeInTheDocument();

    await act(async () => { releaseStale(); await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(screen.queryByText('STALE first activation')).not.toBeInTheDocument();
    expect(screen.getByText('FRESH second activation')).toBeInTheDocument();
  });

  it('applies an agent update that arrives while a newly opened Agents tab is still reading', async () => {
    await renderWithProbe('config');
    const agent = { id: 'agent-example', taskId: 'task-example', status: 'running', startedAt: '2026-01-01T00:00:00.000Z', metadata: { taskDescription: 'Example active work' } };
    let resolveAgents;
    api.getCosAgents.mockReturnValueOnce(new Promise(resolve => { resolveAgents = resolve; }));
    await goTo('agents');
    await act(async () => {
      getSocketHandler('cos:agent:updated')({ ...agent, status: 'paused' });
      resolveAgents([agent]);
    });
    expect(await screen.findByText('Paused Agents')).toBeInTheDocument();
    expect(screen.queryByText('1 running')).toBeNull();
  });

  it('recovers everything the current tab needs on reconnect, including after a switch', async () => {
    await renderWithProbe('briefing');
    await goTo('tasks');
    const before = { shell: shellReads(), agents: api.getCosAgents.mock.calls.length, queue: queueReads() };

    await act(async () => { socketStub.receive('connect'); });
    await settle();

    expect(shellReads()).toEqual(before.shell.map(count => count + 1));
    expect(api.getCosAgents.mock.calls.length).toBe(before.agents + 1);
    expect(queueReads()).toBe(before.queue + 1);
  });

  it('refreshes the learning summary when an agent completes, without a tab switch', async () => {
    withFakeTimers();
    api.getCosLearningSummary.mockResolvedValue({ overallSuccessRate: 40, totalCompleted: 5, status: 'ok' });
    await renderWithProbe('config');
    expect(api.getCosLearningSummary).toHaveBeenCalledTimes(1);
    expect((await screen.findAllByText('40%')).length).toBeGreaterThan(0);

    api.getCosLearningSummary.mockResolvedValue({ overallSuccessRate: 75, totalCompleted: 6, status: 'ok' });
    await act(async () => {
      getSocketHandler('cos:agent:completed')({ id: 'agent-done', result: { success: true } });
      getSocketHandler('cos:agent:completed')({ id: 'agent-done-too', result: { success: true } });
      await vi.advanceTimersByTimeAsync(450);
    });
    await settle();

    expect(api.getCosLearningSummary).toHaveBeenCalledTimes(2);
    expect((await screen.findAllByText('75%')).length).toBeGreaterThan(0);
    expect(screen.queryByText('40%')).toBeNull();
  });

  it('keeps the last good learning summary when a completion refresh fails', async () => {
    withFakeTimers();
    api.getCosLearningSummary.mockResolvedValue({ overallSuccessRate: 40, totalCompleted: 5, status: 'ok' });
    await renderWithProbe('config');
    expect((await screen.findAllByText('40%')).length).toBeGreaterThan(0);

    api.getCosLearningSummary.mockRejectedValue(new Error('offline'));
    await act(async () => {
      getSocketHandler('cos:agent:completed')({ id: 'agent-done', result: { success: true } });
      await vi.advanceTimersByTimeAsync(450);
    });
    await settle();

    expect(api.getCosLearningSummary).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText('40%').length).toBeGreaterThan(0);
  });
});
