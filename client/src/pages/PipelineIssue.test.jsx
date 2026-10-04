import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

const progress = vi.hoisted(() => ({ latest: null, frames: [] }));
vi.mock('../hooks/usePipelineProgress', () => ({ usePipelineProgress: () => progress }));
vi.mock('../services/api', async (importOriginal) => ({
  ...(await importOriginal()),
  getPipelineConfig: vi.fn(async () => ({ arcRoles: [] })),
  getPipelineIssue: vi.fn(),
  getPipelineSeries: vi.fn(),
  updatePipelineIssue: vi.fn(),
  startPipelineAutoRunText: vi.fn(),
  cancelPipelineAutoRunText: vi.fn(async () => ({})),
  pipelineAutoRunSseUrl: () => '/sse',
}));
vi.mock('../components/ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../components/pipeline/stages/IdeaStage', () => ({ default: () => <div>Idea stage</div> }));
vi.mock('../components/pipeline/stages/ProseStage', () => ({ default: () => <div>Prose stage</div> }));
vi.mock('../components/pipeline/stages/NounsStage', () => ({ default: () => null }));
vi.mock('../components/pipeline/stages/ComicScriptStage', () => ({ default: () => null }));
vi.mock('../components/pipeline/stages/TeleplayStage', () => ({ default: () => null }));
vi.mock('../components/pipeline/stages/ComicPagesStage', () => ({ default: () => null }));
vi.mock('../components/pipeline/stages/StoryboardsStage', () => ({ default: () => <div>Storyboards stage</div> }));
vi.mock('../components/pipeline/stages/EpisodeVideoStage', () => ({ default: () => null }));
vi.mock('../components/pipeline/stages/AudioStage', () => ({ default: () => null }));
vi.mock('../components/pipeline/IssueJudgePanel', () => ({ default: () => null }));
vi.mock('../components/pipeline/SeriesLlmPicker', () => ({ default: () => null }));
vi.mock('../components/pipeline/LengthProfilePicker', () => ({ default: () => null }));
vi.mock('../components/pipeline/ArcRolePicker', () => ({ default: () => null }));
vi.mock('../components/CatalogCastPanel', () => ({ default: () => null }));
vi.mock('../components/pipeline/stages/VisualGenSettings', () => ({ VisualGenSettingsPanel: () => <div>Visual settings form</div> }));

import * as api from '../services/api';
import PipelineIssue from './PipelineIssue';

const issueWith = (stages) => ({
  id: 'issue-example', seriesId: 'series-example', number: 3, title: 'Example issue',
  stages: Object.fromEntries(Object.entries(stages).map(([id, status]) => [id, typeof status === 'string' ? { status } : status])),
});

function LocationProbe() {
  const { pathname, search } = useLocation();
  return <div data-testid="location">{pathname}{search}</div>;
}

const renderIssue = async (issue, path = '/pipeline/issues/issue-example/idea') => {
  api.getPipelineIssue.mockResolvedValue(issue);
  api.getPipelineSeries.mockResolvedValue({ id: 'series-example', name: 'Example series', targetFormat: 'video' });
  render(
    <MemoryRouter initialEntries={[path]}>
      <LocationProbe />
      <Routes><Route path="/pipeline/issues/:issueId/:stage" element={<PipelineIssue />} /></Routes>
    </MemoryRouter>,
  );
  await screen.findByRole('heading', { name: /Example issue/ });
};
const statusLine = () => screen.getByRole('status', { name: 'Record status' });

describe('PipelineIssue status line', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    progress.latest = null;
    progress.frames = [];
  });

  it('names the next waiting stage above the tabs and opens it from the next-action button', async () => {
    const user = userEvent.setup();
    await renderIssue(issueWith({ idea: 'ready', prose: 'empty' }));
    expect(statusLine()).toHaveTextContent('Next up: Prose · waiting for you to start it');
    await user.click(screen.getByRole('button', { name: 'Open Prose' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/pipeline/issues/issue-example/prose');
  });

  it('describes a running auto-run in words and cancels it from the status line', async () => {
    const user = userEvent.setup();
    api.startPipelineAutoRunText.mockResolvedValue({});
    await renderIssue(issueWith({ idea: 'ready', prose: 'empty' }));
    progress.latest = { type: 'stage:start', stage: 'prose' };
    await user.click(screen.getByRole('button', { name: /Auto-run text/ }));
    expect(statusLine()).toHaveTextContent('Auto-run in progress · Generating Prose…');
    await user.click(within(statusLine().parentElement).getByRole('button', { name: 'Cancel auto-run' }));
    expect(api.cancelPipelineAutoRunText).toHaveBeenCalledWith('issue-example', { silent: true });
  });

  it('reports a failed stage with its reason', async () => {
    await renderIssue(issueWith({ idea: 'ready', prose: { status: 'error', errorMessage: 'Provider timed out' } }));
    expect(statusLine()).toHaveTextContent('Prose failed · Provider timed out');
    expect(screen.getByRole('button', { name: 'Open Prose' })).toBeInTheDocument();
  });

  it('keeps raw progress frames inside a named debug disclosure', async () => {
    progress.frames = [{ type: 'stage:start', stage: 'prose' }];
    await renderIssue(issueWith({ idea: 'ready' }));
    const disclosure = screen.getByText(/Debug details/).closest('details');
    expect(disclosure).not.toHaveAttribute('open');
    expect(disclosure).toHaveTextContent('"type":"stage:start"');
    expect(document.body.textContent.split('"type":"stage:start"')).toHaveLength(2);
  });

  it('opens per-stage generation settings in a deep-linkable drawer', async () => {
    const user = userEvent.setup();
    await renderIssue(issueWith({ idea: 'ready', storyboards: 'ready' }), '/pipeline/issues/issue-example/storyboards');
    expect(screen.queryByText('Visual settings form')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Storyboards generation settings' }));
    expect(screen.getByTestId('location')).toHaveTextContent('?settings=1');
    expect(screen.getByText('Visual settings form')).toBeInTheDocument();
    expect(screen.getByText('Storyboards — Generation settings')).toBeInTheDocument();
  });
});
