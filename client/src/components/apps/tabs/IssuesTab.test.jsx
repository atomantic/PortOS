import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const { socketHandlers, socketMock } = vi.hoisted(() => {
  const handlers = new Map();
  const mock = {
    connected: true,
    on: vi.fn((event, handler) => handlers.set(event, handler)),
    off: vi.fn((event, handler) => {
      if (handlers.get(event) === handler) handlers.delete(event);
    }),
    emit: vi.fn()
  };
  return { socketHandlers: handlers, socketMock: mock };
});

vi.mock('../../../services/socket', () => ({ default: socketMock }));

// Label chips grade their color against the ACTIVE theme mode, so the mode has
// to be steerable per test. The real provider runs a settings fetch on mount,
// which this suite has no business exercising.
const { themeMode } = vi.hoisted(() => ({ themeMode: { current: 'night' } }));
vi.mock('../../ThemeContext', () => ({
  useThemeContext: () => ({ theme: { mode: themeMode.current } }),
}));

vi.mock('../../../services/api', () => ({
  getAppIssues: vi.fn(),
  createSlashdoTask: vi.fn(),
  getProviders: vi.fn(),
}));

import * as api from '../../../services/api';
import { chipColors, parseColor } from '../../../lib/chipContrast';
import IssuesTab from './IssuesTab';

const ISSUE = {
  number: 42,
  title: 'Crash on save',
  body: 'Repro: open the editor and hit save.',
  url: 'https://github.com/acme/widget/issues/42',
  state: 'open',
  labels: [{ name: 'bug', color: '#d73a4a', description: 'Something is broken' }],
  assignees: ['alice'],
  author: 'carol',
  milestone: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

const okPayload = (issues) => ({
  forge: 'github',
  fullName: 'acme/widget',
  issues,
  reason: issues.length ? 'ok' : 'no-open-issues',
  transient: false,
  remedy: null,
});

const renderTab = async () => {
  const result = render(
    <MemoryRouter>
      <IssuesTab appId="app-1" appName="Widget" />
    </MemoryRouter>
  );
  await act(async () => {});
  return result;
};

beforeEach(() => {
  themeMode.current = 'night';
  socketHandlers.clear();
  socketMock.on.mockClear();
  socketMock.off.mockClear();
  socketMock.emit.mockClear();
  api.getAppIssues.mockResolvedValue(okPayload([ISSUE]));
  api.createSlashdoTask.mockResolvedValue({ id: 'task-1' });
  api.getProviders.mockResolvedValue({ providers: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('IssuesTab', () => {
  it('auto-queries open issues on mount and renders title, labels, and assignees', async () => {
    await renderTab();

    expect(await screen.findByText('Crash on save')).toBeInTheDocument();
    expect(api.getAppIssues).toHaveBeenCalledWith('app-1');
    expect(screen.getByText('#42')).toBeInTheDocument();
    // Scoped by the row chip's own title — the label also appears as a filter
    // toggle in the header, so a bare getByText('bug') is ambiguous.
    expect(screen.getByTitle('Something is broken')).toHaveTextContent('bug');
    expect(screen.getByText(/alice/)).toBeInTheDocument();
    expect(screen.getByText('acme/widget')).toBeInTheDocument();
  });

  // The AA guarantee itself is `lib/chipContrast.test.js`'s job. What this suite
  // owns is the wiring: the chip is styled for the ACTIVE theme mode, not a
  // hardcoded one. #fef2c0 is GitHub's default pale yellow — the color that
  // rendered as white-on-cream before chips were graded per mode.
  it.each(['day', 'night'])('styles label chips for the %s theme mode', async (mode) => {
    themeMode.current = mode;
    api.getAppIssues.mockResolvedValue(okPayload([{
      ...ISSUE,
      labels: [{ name: 'plan', color: '#fef2c0', description: 'Planned work' }],
    }]));
    await renderTab();

    const chip = await screen.findByTitle('Planned work');
    expect(chip).toHaveTextContent('plan');
    // parseColor on both sides: jsdom normalizes an inline `#rrggbb` to `rgb(…)`,
    // so comparing the raw strings would pass no matter which mode was used.
    const other = mode === 'day' ? 'night' : 'day';
    expect(parseColor(chip.style.color)).toEqual(parseColor(chipColors('#fef2c0', mode).color));
    expect(parseColor(chip.style.color)).not.toEqual(parseColor(chipColors('#fef2c0', other).color));
  });

  it('leaves a colorless label on the neutral chip instead of an inline color', async () => {
    api.getAppIssues.mockResolvedValue(okPayload([{
      ...ISSUE,
      labels: [{ name: 'feature', color: null, description: 'No forge color' }],
    }]));
    await renderTab();

    const chip = await screen.findByTitle('No forge color');
    expect(chip.style.color).toBe('');
    expect(chip.className).toContain('text-gray-300');
  });

  it('keeps the description collapsed until the user expands it', async () => {
    await renderTab();

    const title = await screen.findByText('Crash on save');
    expect(screen.queryByText(/Repro: open the editor/)).not.toBeInTheDocument();

    fireEvent.click(title);
    expect(await screen.findByText(/Repro: open the editor/)).toBeInTheDocument();

    fireEvent.click(title);
    await waitFor(() => expect(screen.queryByText(/Repro: open the editor/)).not.toBeInTheDocument());
  });

  it('claims an issue with its prefetched content pinned to the /do:next task', async () => {
    await renderTab();

    fireEvent.click(await screen.findByRole('button', { name: /Claim/ }));

    await waitFor(() => expect(api.createSlashdoTask).toHaveBeenCalledWith(
      'next', 'app-1', {
        target: '42',
        issueContext: {
          number: 42,
          title: 'Crash on save',
          body: 'Repro: open the editor and hit save.',
          url: 'https://github.com/acme/widget/issues/42'
        }
      }, { silent: true }
    ));
    expect(await screen.findByRole('link', { name: /Queued/ })).toBeInTheDocument();
  });

  it('tracks the claimed task from queued through active and completed over the CoS socket', async () => {
    await renderTab();

    fireEvent.click(await screen.findByRole('button', { name: /Claim/ }));
    expect(await screen.findByRole('link', { name: /Queued/ })).toBeInTheDocument();

    act(() => socketHandlers.get('cos:tasks:changed')({
      task: { id: 'task-1', status: 'in_progress' }
    }));
    expect(await screen.findByRole('link', { name: /Active/ })).toBeInTheDocument();

    act(() => socketHandlers.get('cos:tasks:changed')({
      task: { id: 'task-1', status: 'completed' }
    }));
    expect(await screen.findByRole('link', { name: /Completed/ })).toBeInTheDocument();
  });

  it('does not lose an active socket update that arrives before the POST response', async () => {
    let resolveClaim;
    api.createSlashdoTask.mockImplementation(() => new Promise(resolve => { resolveClaim = resolve; }));
    await renderTab();

    fireEvent.click(await screen.findByRole('button', { name: /Claim/ }));
    act(() => socketHandlers.get('cos:tasks:changed')({
      task: {
        id: 'task-1', status: 'in_progress',
        metadata: { app: 'app-1', claimTarget: '42' }
      }
    }));
    expect(await screen.findByRole('link', { name: /Active/ })).toBeInTheDocument();

    await act(async () => {
      resolveClaim({ id: 'task-1', status: 'pending' });
    });
    expect(screen.getByRole('link', { name: /Active/ })).toBeInTheDocument();
  });

  it('sends the page-level provider/model/effort pin along with a claim', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{
        id: 'claude', name: 'Claude', type: 'cli', enabled: true,
        models: ['claude-opus-5', 'claude-sonnet-5'], defaultModel: 'claude-sonnet-5',
      }],
    });
    await renderTab();

    await screen.findByText('Crash on save');
    fireEvent.change(await screen.findByLabelText('Provider'), { target: { value: 'claude' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'claude-opus-5' } });

    fireEvent.click(screen.getByRole('button', { name: /Claim/ }));

    await waitFor(() => expect(api.createSlashdoTask).toHaveBeenCalledWith(
      'next', 'app-1',
      {
        target: '42',
        issueContext: {
          number: 42,
          title: 'Crash on save',
          body: 'Repro: open the editor and hit save.',
          url: 'https://github.com/acme/widget/issues/42'
        },
        provider: 'claude',
        model: 'claude-opus-5',
        effort: undefined
      },
      { silent: true }
    ));
  });

  it('sends optional override context with the selected claim', async () => {
    await renderTab();

    await screen.findByText('Crash on save');
    fireEvent.change(screen.getByLabelText(/Override context or instructions/), {
      target: { value: 'Prefer a small, focused fix and add a regression test.' }
    });
    fireEvent.click(screen.getByRole('button', { name: /Claim/ }));

    await waitFor(() => expect(api.createSlashdoTask).toHaveBeenCalledWith(
      'next', 'app-1',
      expect.objectContaining({
        target: '42',
        overrideContext: 'Prefer a small, focused fix and add a regression test.'
      }),
      { silent: true }
    ));
  });

  it('re-enables the Claim button when queuing fails, instead of stranding it', async () => {
    api.createSlashdoTask.mockRejectedValue(new Error('CoS is not running'));
    await renderTab();

    fireEvent.click(await screen.findByRole('button', { name: /Claim/ }));

    await waitFor(() => expect(screen.getByRole('button', { name: /Claim/ })).toBeEnabled());
    expect(screen.queryByRole('link', { name: /Queued/ })).not.toBeInTheDocument();
  });

  it('filters the list by title, label, or assignee', async () => {
    api.getAppIssues.mockResolvedValue(okPayload([
      ISSUE,
      { ...ISSUE, number: 43, title: 'Add CSV export', labels: [], assignees: [] },
    ]));
    await renderTab();

    await screen.findByText('Crash on save');
    fireEvent.change(screen.getByLabelText('Filter issues'), { target: { value: 'csv' } });

    expect(screen.getByText('Add CSV export')).toBeInTheDocument();
    expect(screen.queryByText('Crash on save')).not.toBeInTheDocument();
  });

  it('filters to unassigned issues when the toggle is enabled', async () => {
    api.getAppIssues.mockResolvedValue(okPayload([
      ISSUE,
      { ...ISSUE, number: 43, title: 'Add CSV export', labels: [], assignees: [] },
    ]));
    await renderTab();

    await screen.findByText('Crash on save');
    const toggle = screen.getByRole('button', { name: 'Unassigned only' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(toggle);

    expect(await screen.findByText('Add CSV export')).toBeInTheDocument();
    expect(screen.queryByText('Crash on save')).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(toggle);
    expect(await screen.findByText('Crash on save')).toBeInTheDocument();
  });

  it('hides in-progress issues by default and lists them once the chip is toggled on', async () => {
    api.getAppIssues.mockResolvedValue(okPayload([
      ISSUE,
      {
        ...ISSUE,
        number: 43,
        title: 'Being worked right now',
        labels: [
          { name: 'bug', color: '#d73a4a', description: '' },
          { name: 'in-progress', color: '#0e8a16', description: '' },
        ],
      },
    ]));
    await renderTab();

    await screen.findByText('Crash on save');
    expect(screen.queryByText('Being worked right now')).not.toBeInTheDocument();
    expect(screen.getByText('1 of 2 open')).toBeInTheDocument();

    const chip = screen.getByRole('button', { name: /in-progress/ });
    expect(chip).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(chip);
    expect(await screen.findByText('Being worked right now')).toBeInTheDocument();
    expect(chip).toHaveAttribute('aria-pressed', 'true');
  });

  it('hides blocked issues by default and lists them once the chip is toggled on', async () => {
    api.getAppIssues.mockResolvedValue(okPayload([
      ISSUE,
      {
        ...ISSUE,
        number: 43,
        title: 'Waiting on a dependency',
        labels: [{ name: 'blocked', color: '#b60205', description: '' }],
      },
    ]));
    await renderTab();

    await screen.findByText('Crash on save');
    expect(screen.queryByText('Waiting on a dependency')).not.toBeInTheDocument();
    expect(screen.getByText('1 of 2 open')).toBeInTheDocument();

    const chip = screen.getByRole('button', { name: 'blocked (1)' });
    expect(chip).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(chip);
    expect(await screen.findByText('Waiting on a dependency')).toBeInTheDocument();
    expect(chip).toHaveAttribute('aria-pressed', 'true');
  });

  it('toggles a label chip off to hide every issue carrying that label', async () => {
    api.getAppIssues.mockResolvedValue(okPayload([
      ISSUE,
      { ...ISSUE, number: 43, title: 'Add CSV export', labels: [{ name: 'feature', color: null, description: '' }] },
    ]));
    await renderTab();

    await screen.findByText('Crash on save');
    // Facet counts come from the fetched issues, one chip per distinct label.
    const bugChip = screen.getByRole('button', { name: 'bug (1)' });
    expect(screen.getByRole('button', { name: 'feature (1)' })).toBeInTheDocument();

    fireEvent.click(bugChip);
    await waitFor(() => expect(screen.queryByText('Crash on save')).not.toBeInTheDocument());
    expect(screen.getByText('Add CSV export')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show all labels' }));
    expect(await screen.findByText('Crash on save')).toBeInTheDocument();
  });

  it('never ships a filter chip with both a graded color and the theme utilities that override it', async () => {
    // `.bg-port-bg` / `.border-port-border` / day-mode `.text-gray-300` are all
    // `!important` in index.css, and author `!important` beats an inline style —
    // so a chip carrying both renders in theme neutrals with its label color
    // silently dead. Colored chips drop the utilities; colorless ones keep them.
    api.getAppIssues.mockResolvedValue(okPayload([
      ISSUE,
      { ...ISSUE, number: 43, labels: [{ name: 'feature', color: null, description: '' }] },
    ]));
    await renderTab();

    const colored = await screen.findByRole('button', { name: 'bug (1)' });
    expect(colored.style.color).not.toBe('');
    expect(colored.className).not.toMatch(/text-gray-300|bg-port-bg|border-port-border/);

    const colorless = screen.getByRole('button', { name: 'feature (1)' });
    expect(colorless.style.color).toBe('');
    expect(colorless.className).toContain('text-gray-300');

    // Hidden chips are struck through in theme neutrals — no inline color to lose.
    fireEvent.click(colored);
    const hidden = await screen.findByRole('button', { name: 'bug (1)' });
    expect(hidden.style.color).toBe('');
    expect(hidden.className).toContain('line-through');
  });

  it('resets label and assignee filters when the app changes', async () => {
    const inProgress = {
      ...ISSUE,
      number: 43,
      title: 'Being worked right now',
      labels: [{ name: 'in-progress', color: '#0e8a16', description: '' }],
    };
    api.getAppIssues.mockResolvedValue(okPayload([ISSUE, inProgress]));
    const { rerender } = await renderTab();

    fireEvent.click(await screen.findByRole('button', { name: /in-progress/ }));
    expect(await screen.findByText('Being worked right now')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Unassigned only' }));

    rerender(
      <MemoryRouter>
        <IssuesTab appId="app-2" appName="Other" />
      </MemoryRouter>
    );
    await act(async () => {});

    await waitFor(() => expect(screen.queryByText('Being worked right now')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Unassigned only' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('ignores a stale in-flight response when the app changes mid-request', async () => {
    // Switching apps updates this component in place, so a slow first response
    // must not land on top of the newer app's list.
    let resolveFirst;
    api.getAppIssues
      .mockImplementationOnce(() => new Promise(res => { resolveFirst = res; }))
      .mockResolvedValueOnce(okPayload([{ ...ISSUE, number: 99, title: 'Second app issue' }]));

    const { rerender } = render(
      <MemoryRouter><IssuesTab appId="app-1" appName="Widget" /></MemoryRouter>
    );
    rerender(
      <MemoryRouter><IssuesTab appId="app-2" appName="Other" /></MemoryRouter>
    );
    await act(async () => {});
    expect(await screen.findByText('Second app issue')).toBeInTheDocument();

    // The first app's response arrives late — it must be discarded.
    resolveFirst(okPayload([ISSUE]));
    await waitFor(() => expect(screen.getByText('Second app issue')).toBeInTheDocument());
    expect(screen.queryByText('Crash on save')).not.toBeInTheDocument();
  });

  it('says "couldn\'t reach" for a transient failure — never "no open issues"', async () => {
    api.getAppIssues.mockResolvedValue({
      forge: 'github', fullName: 'acme/widget', issues: [],
      reason: 'gh-unauthenticated', transient: true, headline: null, remedy: 'run gh auth login',
    });
    await renderTab();

    expect(await screen.findByText(/Couldn't reach GitHub/)).toBeInTheDocument();
    expect(screen.getByText(/run gh auth login/)).toBeInTheDocument();
    expect(screen.queryByText(/No open issues on this tracker/)).not.toBeInTheDocument();
  });

  it('renders the server\'s headline verbatim instead of inferring one from the reason', async () => {
    // A glab whose JSON output flag moved answers with its human table at exit 0
    // — reachable, just unreadable. Only the server-side classifier can tell
    // those apart, so it ships the sentence; the client must not second-guess it
    // with a reason table, which is how an authenticated user got told to
    // authenticate.
    api.getAppIssues.mockResolvedValue({
      forge: 'gitlab', fullName: 'group/proj', issues: [],
      reason: 'glab-output-not-json', transient: true,
      headline: "Reached GitLab, but couldn't read its answer",
      remedy: 'update `glab` — its JSON output flag moved (check `glab issue list --help`)',
    });
    await renderTab();

    expect(await screen.findByText(/Reached GitLab, but couldn't read its answer/)).toBeInTheDocument();
    expect(screen.getByText(/its JSON output flag moved/)).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't reach GitLab/)).not.toBeInTheDocument();
    expect(screen.queryByText(/retry once the CLI is authenticated/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No open issues on this tracker/)).not.toBeInTheDocument();
  });

  it('falls back to the reachability framing when the server ships no headline', async () => {
    // Older reasons (and any the server adds without copy) still read sensibly
    // rather than rendering a blank banner.
    api.getAppIssues.mockResolvedValue({
      forge: 'gitlab', fullName: 'group/proj', issues: [],
      reason: 'some-new-reason', transient: true, headline: null, remedy: null,
    });
    await renderTab();

    expect(await screen.findByText(/Couldn't reach GitLab/)).toBeInTheDocument();
    expect(screen.getByText(/some-new-reason/)).toBeInTheDocument();
  });

  it('explains a non-forge origin instead of showing an empty list', async () => {
    api.getAppIssues.mockResolvedValue({
      forge: null, fullName: null, issues: [], reason: 'unsupported-forge', transient: false, remedy: null,
    });
    await renderTab();

    expect(await screen.findByText(/isn't GitHub or GitLab/)).toBeInTheDocument();
  });

  it('points at the Work Tracker setting when the tracker owns no forge issues', async () => {
    // The server refuses to list issues a Claim here would not actually touch.
    api.getAppIssues.mockResolvedValue({
      forge: null, tracker: 'jira', fullName: null, issues: [],
      reason: 'tracker-not-a-forge', transient: false, remedy: null,
    });
    await renderTab();

    expect(await screen.findByText(/Work Tracker isn't a forge issue tracker/)).toBeInTheDocument();
    // No issues ⇒ no Claim button that would queue a mis-routed run.
    expect(screen.queryByRole('button', { name: /Claim/ })).not.toBeInTheDocument();
  });
});

// Replan is a SECOND opinion on an already-planned issue, launched from the same
// row as Claim. The failure modes worth pinning are the ones where the two runs
// bleed into each other: the wrong slashdo command, or one run's lifecycle events
// swapping out the other's button.
describe('IssuesTab replan', () => {
  it('queues the replan command with the same pin and prefetched content a claim gets', async () => {
    await renderTab();

    fireEvent.click(await screen.findByRole('button', { name: /Replan/ }));

    await waitFor(() => expect(api.createSlashdoTask).toHaveBeenCalledWith(
      'replan', 'app-1', {
        target: '42',
        issueContext: {
          number: 42,
          title: 'Crash on save',
          body: 'Repro: open the editor and hit save.',
          url: 'https://github.com/acme/widget/issues/42'
        }
      }, { silent: true }
    ));
    expect(await screen.findByRole('link', { name: /Replan #42: Queued/ })).toBeInTheDocument();
  });

  it('leaves the Claim button live while a replan of the same issue is running', async () => {
    await renderTab();

    fireEvent.click(await screen.findByRole('button', { name: /Replan/ }));
    expect(await screen.findByRole('link', { name: /Replan #42: Queued/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Claim/ })).toBeEnabled();
  });

  // Before the POST resolves there is no task id to match on, so the socket path
  // falls back to the target the server stamped. Reading `claimTarget` there
  // would light up the Claim row from a replan's events (and vice versa).
  it('matches a pre-response socket update on replanTarget, never on claimTarget', async () => {
    let resolveReplan;
    api.createSlashdoTask.mockImplementation(() => new Promise(resolve => { resolveReplan = resolve; }));
    await renderTab();

    fireEvent.click(await screen.findByRole('button', { name: /Replan/ }));
    act(() => socketHandlers.get('cos:tasks:changed')({
      task: { id: 'task-9', status: 'in_progress', metadata: { app: 'app-1', claimTarget: '42' } }
    }));
    // A claim's event must not advance the replan row.
    expect(screen.getByRole('button', { name: /Claim/ })).toBeInTheDocument();

    act(() => socketHandlers.get('cos:tasks:changed')({
      task: { id: 'task-9', status: 'in_progress', metadata: { app: 'app-1', replanTarget: '42' } }
    }));
    expect(await screen.findByRole('link', { name: /Replan #42: Active/ })).toBeInTheDocument();

    await act(async () => { resolveReplan({ id: 'task-9', status: 'pending' }); });
    expect(screen.getByRole('link', { name: /Replan #42: Active/ })).toBeInTheDocument();
  });

  it('re-enables the Replan button when queuing fails, instead of stranding it', async () => {
    api.createSlashdoTask.mockRejectedValue(new Error('tracker is not a forge'));
    await renderTab();

    fireEvent.click(await screen.findByRole('button', { name: /Replan/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Replan/ })).toBeEnabled());
  });
});
