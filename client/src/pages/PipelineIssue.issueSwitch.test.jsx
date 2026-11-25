/**
 * The issue page stays mounted when the route moves to another issue, so a
 * PATCH or stage result that answers after the switch must not repaint the
 * previous issue under the new URL (or merge its stage into the new issue).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';

const ideaProps = vi.hoisted(() => []);
const progress = vi.hoisted(() => ({ latest: null, latestUrl: null, closed: false, frames: [], enabledSeen: [] }));
vi.mock('../hooks/usePipelineProgress', () => ({
  usePipelineProgress: (_builder, ids, { enabled }) => {
    progress.enabledSeen.push({ id: ids[0], enabled });
    return progress;
  },
}));
vi.mock('../services/apiPipeline.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getPipelineConfig: vi.fn(async () => ({ arcRoles: [] })),
  getPipelineIssue: vi.fn(),
  getPipelineSeries: vi.fn(async () => ({ id: 'series-example', name: 'Example series', targetFormat: 'video' })),
  updatePipelineIssue: vi.fn(),
  startPipelineAutoRunText: vi.fn(),
  cancelPipelineAutoRunText: vi.fn(async () => ({})),
  pipelineAutoRunSseUrl: (id) => `/sse/${id}`,
}));
vi.mock('../components/ui/Toast');
vi.mock('../components/pipeline/stages/IdeaStage', () => ({
  default: (props) => {
    ideaProps.push(props);
    return <div data-testid="idea-stage">{props.issue.id}:{props.issue.stages?.idea?.status}:{props.series?.id}</div>;
  },
}));
vi.mock('../components/pipeline/stages/ProseStage', () => ({ default: () => null }));
vi.mock('../components/pipeline/stages/NounsStage', () => ({ default: () => null }));
vi.mock('../components/pipeline/stages/ComicScriptStage', () => ({ default: () => null }));
vi.mock('../components/pipeline/stages/TeleplayStage', () => ({ default: () => null }));
vi.mock('../components/pipeline/stages/ComicPagesStage', () => ({ default: () => null }));
vi.mock('../components/pipeline/stages/StoryboardsStage', () => ({ default: () => null }));
vi.mock('../components/pipeline/stages/EpisodeVideoStage', () => ({ default: () => null }));
vi.mock('../components/pipeline/stages/AudioStage', () => ({ default: () => null }));
vi.mock('../components/pipeline/IssueJudgePanel', () => ({ default: () => null }));
vi.mock('../components/pipeline/SeriesLlmPicker', () => ({ default: () => null }));
vi.mock('../components/pipeline/LengthProfilePicker', () => ({ default: () => null }));
vi.mock('../components/pipeline/ArcRolePicker', () => ({ default: () => null }));
vi.mock('../components/CatalogCastPanel', () => ({ default: () => null }));
vi.mock('../components/pipeline/stages/VisualGenSettings', () => ({ VisualGenSettingsPanel: () => null }));

import { getPipelineIssue, updatePipelineIssue, getPipelineSeries, startPipelineAutoRunText } from '../services/apiPipeline.js';
import PipelineIssue from './PipelineIssue';

const issue = (id, title, ideaStatus = 'ready') => ({
  id, seriesId: 'series-example', number: 1, title, stages: { idea: { status: ideaStatus } },
});
const ISSUES = {
  'issue-a': issue('issue-a', 'Issue A'),
  'issue-b': { ...issue('issue-b', 'Issue B'), seriesId: 'series-b' },
};

async function renderAndSwitch(beforeSwitch, afterNavigate) {
  const router = createMemoryRouter(
    [{ path: '/pipeline/issues/:issueId/:stage', element: <PipelineIssue /> }],
    { initialEntries: ['/pipeline/issues/issue-a/idea'] },
  );
  render(<RouterProvider router={router} />);
  await screen.findByRole('heading', { name: /Issue A/ });
  await beforeSwitch?.();
  await act(() => router.navigate('/pipeline/issues/issue-b/idea'));
  await afterNavigate?.();
  await screen.findByRole('heading', { name: /Issue B/ });
}

describe('PipelineIssue across an issue switch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ideaProps.length = 0;
    Object.assign(progress, { latest: null, latestUrl: null, closed: false, frames: [], enabledSeen: [] });
    getPipelineIssue.mockImplementation(async (id) => ISSUES[id]);
    getPipelineSeries.mockImplementation(async (id) => ({ id, name: 'Example series', targetFormat: 'video' }));
  });

  it('ignores a lock PATCH for the previous issue that answers late', async () => {
    const user = userEvent.setup();
    let resolvePatch;
    updatePipelineIssue.mockImplementation(() => new Promise((resolve) => { resolvePatch = resolve; }));
    await renderAndSwitch(() => user.click(screen.getByRole('button', { name: 'Lock Idea' })));

    await act(async () => { resolvePatch({ ...ISSUES['issue-a'], stages: { idea: { status: 'ready', locked: true } } }); });
    expect(screen.getByRole('heading', { name: /Issue B/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Issue A/ })).not.toBeInTheDocument();
  });

  it('does not merge a stage-only result from the previous issue into the new one', async () => {
    let lateUpdate;
    await renderAndSwitch(() => { lateUpdate = ideaProps.at(-1).onStageUpdate; });

    act(() => { lateUpdate('idea', { status: 'needs-review' }); });
    expect(screen.getByTestId('idea-stage')).toHaveTextContent('issue-b:ready');
  });

  it('keeps an issue available when its series lookup fails', async () => {
    getPipelineSeries.mockRejectedValueOnce(new Error('series offline'));

    await renderAndSwitch();

    expect(ideaProps[0].issue.id).toBe('issue-a');
    expect(ideaProps[0].series).toBeNull();
  });

  it('leaves the loading state when the requested issue no longer exists', async () => {
    getPipelineIssue.mockResolvedValueOnce(null);
    const router = createMemoryRouter(
      [
        { path: '/pipeline/issues/:issueId/:stage', element: <PipelineIssue /> },
        { path: '/pipeline', element: <div>Pipeline home</div> },
      ],
      { initialEntries: ['/pipeline/issues/missing/idea'] },
    );
    render(<RouterProvider router={router} />);

    await screen.findByText('Pipeline home');
    expect(router.state.location.pathname).toBe('/pipeline');
    expect(screen.queryByRole('status', { name: 'Loading pipeline issue' })).not.toBeInTheDocument();
  });

  it('hides the previous issue and waits for the new series before mounting its stage', async () => {
    let resolveSeries;
    getPipelineSeries.mockImplementation((id) => id === 'series-b'
      ? new Promise((resolve) => { resolveSeries = resolve; })
      : Promise.resolve({ id: 'series-a', name: 'Series A', targetFormat: 'video' }));

    await renderAndSwitch(null, async () => {
      await vi.waitFor(() => expect(getPipelineSeries).toHaveBeenCalledWith('series-b', { silent: true }));
      expect(screen.queryByRole('heading', { name: /Issue A/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: /Issue B/ })).not.toBeInTheDocument();
      expect(screen.queryByTestId('idea-stage')).not.toBeInTheDocument();

      await act(async () => {
        resolveSeries({ id: 'series-b', name: 'Series B', targetFormat: 'comic' });
      });
    });

    expect(screen.getByTestId('idea-stage')).toHaveTextContent('issue-b:ready:series-b');
  });

  describe('auto-run state', () => {
    const autoRunButton = () => screen.getByRole('button', { name: /Auto-run text/ });
    const startAutoRun = async (user) => {
      startPipelineAutoRunText.mockResolvedValue({ started: true });
      await user.click(autoRunButton());
      await vi.waitFor(() => expect(autoRunButton()).toBeDisabled());
    };

    it('re-enables controls and opens no stream for the new issue after a switch mid-run', async () => {
      const user = userEvent.setup();
      await renderAndSwitch(() => startAutoRun(user));

      expect(autoRunButton()).toBeEnabled();
      expect(progress.enabledSeen.filter((c) => c.id === 'issue-b').every((c) => c.enabled === false)).toBe(true);
    });

    it('recovers when the stream closes without a terminal frame', async () => {
      const user = userEvent.setup();
      const router = createMemoryRouter(
        [{ path: '/pipeline/issues/:issueId/:stage', element: <PipelineIssue /> }],
        { initialEntries: ['/pipeline/issues/issue-a/idea'] },
      );
      render(<RouterProvider router={router} />);
      await screen.findByRole('heading', { name: /Issue A/ });
      await startAutoRun(user);
      getPipelineIssue.mockClear();

      progress.closed = true;
      await act(() => router.navigate('/pipeline/issues/issue-a/prose'));
      await vi.waitFor(() => expect(autoRunButton()).toBeEnabled());
      await vi.waitFor(() => expect(getPipelineIssue).toHaveBeenCalledWith('issue-a'));
    });

    it('does not refetch for a stale terminal frame retained from the previous issue', async () => {
      const user = userEvent.setup();
      await renderAndSwitch(async () => {
        await startAutoRun(user);
        progress.latest = { type: 'stage:complete', stage: 'idea' };
        progress.latestUrl = '/sse/issue-a';
      });

      // Only the load effect's silent read happens for issue-b; no un-silent one.
      const unsilent = getPipelineIssue.mock.calls.filter(([id, opts]) => id === 'issue-b' && !opts);
      expect(unsilent).toHaveLength(0);
    });

    it('ignores a start request for the previous issue that resolves after the switch', async () => {
      const user = userEvent.setup();
      let resolveStart;
      startPipelineAutoRunText.mockImplementation(() => new Promise((resolve) => { resolveStart = resolve; }));
      await renderAndSwitch(() => user.click(autoRunButton()));

      await act(async () => { resolveStart({ started: true }); });
      expect(autoRunButton()).toBeEnabled();
      expect(progress.enabledSeen.filter((c) => c.id === 'issue-b').every((c) => c.enabled === false)).toBe(true);
    });
  });
});
