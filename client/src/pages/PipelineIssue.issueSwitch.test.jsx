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
vi.mock('../hooks/usePipelineProgress', () => ({ usePipelineProgress: () => ({ latest: null, frames: [] }) }));
vi.mock('../services/api', async (importOriginal) => ({
  ...(await importOriginal()),
  getPipelineConfig: vi.fn(async () => ({ arcRoles: [] })),
  getPipelineIssue: vi.fn(),
  getPipelineSeries: vi.fn(async () => ({ id: 'series-example', name: 'Example series', targetFormat: 'video' })),
  updatePipelineIssue: vi.fn(),
  startPipelineAutoRunText: vi.fn(),
  cancelPipelineAutoRunText: vi.fn(async () => ({})),
  pipelineAutoRunSseUrl: () => '/sse',
}));
vi.mock('../components/ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../components/pipeline/stages/IdeaStage', () => ({
  default: (props) => {
    ideaProps.push(props);
    return <div data-testid="idea-stage">{props.issue.id}:{props.issue.stages?.idea?.status}</div>;
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

import * as api from '../services/api';
import PipelineIssue from './PipelineIssue';

const issue = (id, title, ideaStatus = 'ready') => ({
  id, seriesId: 'series-example', number: 1, title, stages: { idea: { status: ideaStatus } },
});
const ISSUES = { 'issue-a': issue('issue-a', 'Issue A'), 'issue-b': issue('issue-b', 'Issue B') };

async function renderAndSwitch(beforeSwitch) {
  const router = createMemoryRouter(
    [{ path: '/pipeline/issues/:issueId/:stage', element: <PipelineIssue /> }],
    { initialEntries: ['/pipeline/issues/issue-a/idea'] },
  );
  render(<RouterProvider router={router} />);
  await screen.findByRole('heading', { name: /Issue A/ });
  await beforeSwitch?.();
  await act(() => router.navigate('/pipeline/issues/issue-b/idea'));
  await screen.findByRole('heading', { name: /Issue B/ });
}

describe('PipelineIssue across an issue switch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ideaProps.length = 0;
    api.getPipelineIssue.mockImplementation(async (id) => ISSUES[id]);
  });

  it('ignores a lock PATCH for the previous issue that answers late', async () => {
    const user = userEvent.setup();
    let resolvePatch;
    api.updatePipelineIssue.mockImplementation(() => new Promise((resolve) => { resolvePatch = resolve; }));
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
});
