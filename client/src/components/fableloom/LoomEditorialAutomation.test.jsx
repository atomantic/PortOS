import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

vi.mock('../../services/api', () => ({
  cancelLoomEditorialAutopilot: vi.fn(),
  getLoom: vi.fn(),
  getLoomEditorialAutopilotStatus: vi.fn(),
  getProviders: vi.fn(),
  remediateLoomEditorial: vi.fn(),
  reviewLoomPlaythroughs: vi.fn(),
  startLoomEditorialAutopilot: vi.fn(),
}));
vi.mock('../../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));

import * as api from '../../services/api';
import socket from '../../services/socket';
import LoomEditorialAutomation from './LoomEditorialAutomation';

const loom = {
  id: 'loom-1',
  name: 'Example Story',
  episodes: [{
    id: 'episode-1', number: 1, title: 'Pilot',
    nodes: [{ id: 'scene-1', title: 'Opening', transitions: [] }],
  }],
};

const providers = [{
  id: 'codex', name: 'Codex', type: 'cli', command: 'codex', enabled: true,
  defaultModel: 'gpt-5', models: ['gpt-5'],
}];

const renderPanel = (props = {}) => render(
  <MemoryRouter>
    <LoomEditorialAutomation
      loom={loom}
      dirty={false}
      onLoomUpdate={vi.fn()}
      {...props}
    />
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  api.getProviders.mockResolvedValue({ activeProvider: 'codex', providers });
  api.getLoomEditorialAutopilotStatus.mockResolvedValue({ run: null });
  api.remediateLoomEditorial.mockResolvedValue({
    loom,
    changed: true,
    changes: ['Added the missing beat outline.'],
    evaluation: { summary: 'The outline is now coherent.', strengths: ['Clear central choice'], findings: [] },
    after: { outlineErrors: 0, graphErrors: 0, convergenceIssues: 0 },
    diagnostics: {
      passed: true,
      playthrough: {
        stats: { variationCount: 2, visitedTransitionCount: 4, transitionCount: 4 },
      },
    },
  });
  api.reviewLoomPlaythroughs.mockResolvedValue({
    passed: true,
    deterministic: { stats: { variationCount: 2, visitedTransitionCount: 4, transitionCount: 4 } },
    review: { qualityScore: 8.7, summary: 'Every path pays off.', strengths: [], findings: [] },
  });
});

describe('LoomEditorialAutomation', () => {
  it('runs one whole-series editor and adopts the remediated loom', async () => {
    const user = userEvent.setup();
    const onLoomUpdate = vi.fn();
    renderPanel({ onLoomUpdate });

    await user.selectOptions(await screen.findByLabelText('Editorial AI route'), 'codex');
    await user.selectOptions(screen.getByLabelText('Model'), 'gpt-5');
    await user.selectOptions(screen.getByLabelText('Thinking effort'), 'high');
    expect(screen.getByText('Runs will use Codex (gpt-5) at high effort.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Evaluate & remediate series' }));

    await waitFor(() => expect(api.remediateLoomEditorial).toHaveBeenCalledWith(
      'loom-1',
      expect.objectContaining({
        providerId: 'codex', model: 'gpt-5', effort: 'high', operationId: expect.any(String),
      }),
      { silent: true },
    ));
    expect(onLoomUpdate).toHaveBeenCalledWith(loom);
    expect(await screen.findByText('Series clears the current editorial gates')).toBeInTheDocument();
    expect(screen.getByText('Variations tested').parentElement).toHaveTextContent('2');
    expect(screen.getByText('Path coverage').parentElement).toHaveTextContent('4/4');
  });

  it('runs the narrative playthrough judge and displays its quality verdict', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: 'Run playthrough test' }));

    await waitFor(() => expect(api.reviewLoomPlaythroughs).toHaveBeenCalledWith(
      'loom-1',
      expect.objectContaining({ aiReview: true, operationId: expect.any(String) }),
      { silent: true },
    ));
    expect(await screen.findByText('Every path pays off.')).toBeInTheDocument();
    expect(screen.getByText('8.7/10')).toBeInTheDocument();
  });

  it('starts the bounded editor/reviewer loop and exposes cooperative stop', async () => {
    const user = userEvent.setup();
    api.startLoomEditorialAutopilot.mockResolvedValue({
      id: 'editorial-run-1', loomId: 'loom-1', status: 'running', round: 1, maxRounds: 3,
      stepIndex: 1, stepCount: 6,
      message: 'Step 1 of up to 6 · round 1: evaluating and remediating the complete series…', rounds: [],
      residualFindings: [],
    });
    renderPanel();

    await user.click(screen.getByRole('button', { name: 'Start editor autopilot' }));

    await waitFor(() => expect(api.startLoomEditorialAutopilot).toHaveBeenCalledWith(
      'loom-1', { maxRounds: 3 }, { silent: true },
    ));
    expect(screen.getByRole('button', { name: 'Stop editor autopilot' })).toBeInTheDocument();
    expect(screen.getAllByText(/step 1 of up to 6/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/running · step 1\/6 · round 1\/3/i)).toBeInTheDocument();
  });

  it('explains a failed automation as a retryable system outcome', async () => {
    api.getLoom.mockResolvedValue(loom);
    api.getLoomEditorialAutopilotStatus.mockResolvedValue({
      run: {
        id: 'editorial-run-1', loomId: 'loom-1', status: 'failed', round: 1, maxRounds: 3,
        stepIndex: 1, stepCount: 6, responseCorrections: 2, invalidResponses: 3,
        message: 'Editorial autopilot could not obtain a graph-safe editor patch after 3 attempts.',
        rounds: [], residualFindings: [],
      },
    });
    renderPanel();

    expect(await screen.findByText('Editorial automation needs attention')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry editor autopilot' })).toBeInTheDocument();
    expect(screen.getByText(/safely rejected 3 invalid editor responses; no invalid changes were applied/i)).toBeInTheDocument();
  });

  it('restores the active run configuration when reopening the editor', async () => {
    api.getLoomEditorialAutopilotStatus.mockResolvedValue({ run: {
      id: 'active-planning-run', loomId: 'loom-1', status: 'running', mode: 'planning', maxRounds: 2, round: 1,
      route: { providerId: 'codex', model: 'gpt-5', effort: 'low' }, selfImproveEnabled: false,
    } });
    renderPanel();
    await waitFor(() => expect(screen.getByLabelText('Autopilot stage')).toHaveValue('planning'));
    expect(screen.getByLabelText('Editorial AI route')).toHaveValue('codex');
    expect(screen.getByLabelText('Autopilot rounds')).toHaveValue('2');
    expect(screen.getByLabelText('Thinking effort')).toHaveValue('low');
    expect(screen.getByText('Runs will use Codex (gpt-5) at low effort.')).toBeInTheDocument();
  });

  it('starts an unexpanded series in planning mode without claiming production approval', async () => {
    const user = userEvent.setup();
    const planned = { ...loom, episodes: [{ ...loom.episodes[0], nodes: [] }] };
    api.getLoom.mockResolvedValue(planned);
    api.startLoomEditorialAutopilot.mockResolvedValue({
      id: 'planning-run', loomId: loom.id, mode: 'planning', status: 'completed', round: 1, maxRounds: 3,
      message: 'Outlines are ready.', rounds: [], residualFindings: [],
    });
    renderPanel({ loom: planned });
    expect(await screen.findByLabelText('Autopilot stage')).toHaveValue('planning');
    await user.click(screen.getByRole('button', { name: 'Start editor autopilot' }));
    await waitFor(() => expect(api.startLoomEditorialAutopilot).toHaveBeenCalledWith(
      loom.id, { maxRounds: 3, mode: 'planning' }, { silent: true },
    ));
    expect(await screen.findByText('Series planning is ready for scene expansion')).toBeInTheDocument();
    expect(screen.queryByText('Series clears the current editorial gates')).not.toBeInTheDocument();
  });

  it('opts a run into approval-gated FableLoom workflow diagnosis', async () => {
    const user = userEvent.setup();
    api.startLoomEditorialAutopilot.mockResolvedValue({
      id: 'editorial-run-1', loomId: 'loom-1', status: 'running', round: 0, maxRounds: 3,
      message: 'Starting FableLoom editorial autopilot…', rounds: [], residualFindings: [],
    });
    renderPanel();

    const toggle = await screen.findByLabelText(/improve fableloom itself/i);
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    expect(screen.getByText(/queues a deduplicated worktree \+ PR CoS task in the approval queue/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start editor autopilot' }));

    await waitFor(() => expect(api.startLoomEditorialAutopilot).toHaveBeenCalledWith(
      'loom-1', { maxRounds: 3, selfImprove: true }, { silent: true },
    ));
  });

  it('links a filed workflow diagnosis to its CoS approval task', async () => {
    api.getLoom.mockResolvedValue(loom);
    api.getLoomEditorialAutopilotStatus.mockResolvedValue({
      run: {
        id: 'editorial-run-1', loomId: 'loom-1', status: 'paused', round: 2, maxRounds: 3,
        pauseReason: 'plateau', message: 'Editorial autopilot paused.', rounds: [],
        residualFindings: [],
        selfImprove: {
          verdict: 'pipeline', area: 'prompt', title: 'Tighten the remediation contract',
          taskId: 'sys-example', filed: true, duplicate: false,
        },
      },
    });
    renderPanel();

    expect(await screen.findByText(/Queued a FableLoom improvement \(prompt\)/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review CoS task' })).toHaveAttribute(
      'href',
      '/cos/tasks?task=sys-example&source=internal',
    );
  });

  it('keeps the decided pause explanation visible when cancellation lands during diagnosis', async () => {
    api.getLoomEditorialAutopilotStatus.mockResolvedValue({
      run: {
        id: 'editorial-run-1', loomId: 'loom-1', status: 'canceled', round: 1, maxRounds: 1,
        pauseReason: 'round-limit',
        message: 'Editorial autopilot reached its 1-round limit with review findings still open.',
        rounds: [], residualFindings: [],
        lastReview: { summary: 'The story review still has open findings.', findings: [] },
      },
    });
    renderPanel();

    expect(await screen.findByText(/reached its 1-round limit with review findings still open/i))
      .toBeInTheDocument();
  });

  it('blocks every mutating AI action while the series plan has unsaved edits', async () => {
    renderPanel({ dirty: true });

    await waitFor(() => expect(api.getLoomEditorialAutopilotStatus).toHaveBeenCalled());

    expect(screen.getByRole('button', { name: 'Evaluate & remediate series' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Run playthrough test' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Start editor autopilot' })).toBeDisabled();
    expect(screen.getByText(/Save the current series-plan edits/)).toBeInTheDocument();
  });
});

const editorialEvent = payload => socket.on.mock.calls.filter(([name]) => name === 'fableloom:editorial:run').at(-1)[1](payload);
const reconnect = () => socket.on.mock.calls.filter(([name]) => name === 'connect').at(-1)[1]();
const editorialRun = (patch = {}) => ({
  id: 'run-1', loomId: 'loom-1', createdAt: '2026-01-01T00:00:00Z',
  revision: 1, status: 'running', round: 1, maxRounds: 3, rounds: [], residualFindings: [],
  message: 'Editor running', ...patch,
});

it('renders snapshots without timer reads and reconciles reconnect/reshow once', async () => {
  const onLoomUpdate = vi.fn();
  api.getLoom.mockResolvedValue(loom);
  api.getLoomEditorialAutopilotStatus.mockResolvedValue({ run: editorialRun() });
  renderPanel({ onLoomUpdate });
  await screen.findAllByText('Editor running');
  vi.useFakeTimers();
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  vi.useRealTimers();
  expect(api.getLoomEditorialAutopilotStatus).toHaveBeenCalledTimes(1);
  await act(async () => editorialEvent(editorialRun({ revision: 2, message: 'Reviewer running' })));
  expect(screen.getAllByText('Reviewer running')[0]).toBeInTheDocument();
  await act(async () => editorialEvent(editorialRun({ loomId: 'other', revision: 3, message: 'Wrong loom' })));
  expect(screen.queryByText('Wrong loom')).not.toBeInTheDocument();
  const completed = editorialRun({ status: 'completed', revision: 3, message: 'Review finished' });
  api.getLoomEditorialAutopilotStatus.mockResolvedValue({ run: completed });
  await act(async () => { editorialEvent(completed); editorialEvent({ ...completed, revision: 4 }); });
  expect(onLoomUpdate).toHaveBeenCalledTimes(1);
  await act(async () => reconnect());
  expect(api.getLoomEditorialAutopilotStatus).toHaveBeenCalledTimes(2);
  const original = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  if (original) Object.defineProperty(document, 'visibilityState', original);
  else delete document.visibilityState;
  expect(api.getLoomEditorialAutopilotStatus).toHaveBeenCalledTimes(3);
  expect(onLoomUpdate).toHaveBeenCalledTimes(1);
});

it('drops late initial reads, retired-run events and old-loom terminal refreshes', async () => {
  let resolveRead;
  let resolveLoom;
  api.getLoomEditorialAutopilotStatus.mockReturnValueOnce(new Promise(resolve => { resolveRead = resolve; }));
  api.getLoom.mockReturnValueOnce(new Promise(resolve => { resolveLoom = resolve; }));
  const onLoomUpdate = vi.fn();
  const panel = renderPanel({ onLoomUpdate });
  await waitFor(() => expect(resolveRead).toBeTypeOf('function'));
  await act(async () => editorialEvent(editorialRun({ revision: 2, message: 'New progress' })));
  await act(async () => resolveRead({ run: editorialRun({ message: 'Stale read' }) }));
  expect(screen.getAllByText('New progress')[0]).toBeInTheDocument();
  await act(async () => editorialEvent(editorialRun({ id: 'run-2', createdAt: '2026-01-02T00:00:00Z', message: 'New run' })));
  await act(async () => editorialEvent(editorialRun({ revision: 9, status: 'failed', message: 'Retired run' })));
  expect(screen.getAllByText('New run')[0]).toBeInTheDocument();
  await act(async () => editorialEvent(editorialRun({ id: 'run-2', createdAt: '2026-01-02T00:00:00Z', revision: 2, status: 'completed' })));
  panel.rerender(<MemoryRouter><LoomEditorialAutomation loom={{ ...loom, id: 'loom-2' }} dirty={false} onLoomUpdate={onLoomUpdate} /></MemoryRouter>);
  await act(async () => resolveLoom(loom));
  expect(onLoomUpdate).not.toHaveBeenCalled();
  expect(screen.queryByText('New run')).not.toBeInTheDocument();
});
