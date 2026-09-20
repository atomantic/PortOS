import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../../services/api', () => ({
  getJevStatus: vi.fn(),
  getJevDecisionStats: vi.fn(),
  installJev: vi.fn(),
  cancelJevInstall: vi.fn(),
  scoreJev: vi.fn(),
  unloadJev: vi.fn(),
  getJevHeads: vi.fn(),
  trainJevHead: vi.fn(),
  adoptJevHead: vi.fn(),
  discardJevHead: vi.fn(),
}));
vi.mock('./JevIntegrations', () => ({ default: () => <div>Integration controls</div> }));
vi.mock('../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}));

import {
  adoptJevHead, cancelJevInstall, discardJevHead, getJevDecisionStats, getJevHeads,
  getJevStatus, installJev, scoreJev, trainJevHead, unloadJev,
} from '../../services/api';
import socket from '../../services/socket';
import JevPanel from './JevPanel';

const stages = (ready) => [
  { id: 'python', label: 'Host Python', description: 'A Python interpreter.', ready: true },
  { id: 'venv', label: 'Dedicated jev runtime', description: 'A private virtualenv.', ready },
  { id: 'packages', label: 'Scorer packages', description: 'Pinned scorer imports.', ready },
  { id: 'model', label: 'Pinned model snapshot', description: 'The pinned subfolder files.', ready },
];

const status = (overrides = {}) => ({
  id: 'openjev-qwen3.5-4b-nli',
  name: 'OpenJEV Qwen3.5 4B NLI',
  sourceUrl: 'https://huggingface.co/AlexWortega/openjev',
  ready: false,
  pythonAvailable: true,
  setupState: 'not-installed',
  port: 5566,
  resident: false,
  stages: stages(false),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  getJevStatus.mockResolvedValue(status());
  getJevDecisionStats.mockResolvedValue({ updatedAt: null, decisions: [] });
  installJev.mockResolvedValue({ ok: true, ready: true });
  cancelJevInstall.mockResolvedValue({ cancelled: true });
  unloadJev.mockResolvedValue({ unloaded: true });
  getJevHeads.mockResolvedValue({ heads: [], training: false });
  trainJevHead.mockResolvedValue({ ok: true });
  adoptJevHead.mockResolvedValue({ adopted: true });
  discardJevHead.mockResolvedValue({ ok: true, removed: true });
});

/** A described head as `GET /jev/heads` returns one. */
const headRow = (overrides = {}) => ({
  decisionId: 'scope-adherence',
  adopted: false,
  ok: true,
  architecture: 'linear',
  metrics: { trained: 0.71, stockZeroShot: 0.58, majorityClass: 0.52, goldSize: 40, trainSize: 120 },
  corpusHash: 'deadbeefcafe0001',
  corpusSources: ['merged-pr'],
  trainedAt: '2026-09-19T00:00:00.000Z',
  baseRevision: 'abc123',
  compatible: true,
  beatsBaselines: true,
  blocker: null,
  ...overrides,
});

const renderPanel = async () => {
  render(<JevPanel />);
  const heading = await screen.findByRole('heading', { name: 'jev decision scorer' });
  expect(heading).toBeInTheDocument();
  expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', heading.id);
};

describe('JevPanel install', () => {
  it('shows four stages and no Hugging Face token step — openjev is ungated', async () => {
    await renderPanel();
    await waitFor(() => expect(screen.getByTestId('jev-stage-model')).toBeInTheDocument());
    expect(screen.getAllByTestId(/^jev-stage-/)).toHaveLength(4);
    expect(screen.queryByTestId('jev-stage-huggingface-token')).not.toBeInTheDocument();
  });

  it('offers repair for a partial setup and blocks installation without host Python', async () => {
    getJevStatus.mockResolvedValue(status({ setupState: 'incomplete' }));
    await renderPanel();
    expect(await screen.findByRole('button', { name: 'Repair jev' })).toBeEnabled();

    getJevStatus.mockResolvedValue(status({ pythonAvailable: false }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh status' })); });
    expect(await screen.findByRole('button', { name: 'Install jev' })).toBeDisabled();
  });

  it('marks the live install stage from jev progress frames and ignores other scopes', async () => {
    let settle;
    installJev.mockReturnValue(new Promise((resolve) => { settle = resolve; }));
    await renderPanel();
    const handler = socket.on.mock.calls.find(([event]) => event === 'localLlm:progress')[1];
    fireEvent.click(await screen.findByRole('button', { name: 'Install jev' }));

    // A Prompt Guard frame must not drive this panel's checklist — both panels
    // subscribe to the same socket event and are told apart only by scope.
    act(() => handler({ scope: 'security-guard', event: 'stage', stage: 'model', message: 'Downloading Prompt Guard…' }));
    expect(screen.queryByText('Downloading Prompt Guard…')).not.toBeInTheDocument();

    act(() => handler({ scope: 'jev', event: 'stage', stage: 'packages', message: 'Installing scorer runtime packages…' }));
    expect(await screen.findByText('Installing scorer runtime packages…')).toBeInTheDocument();
    await act(async () => { settle({ ok: false }); });
  });

  it('cancels an in-flight install', async () => {
    let settle;
    installJev.mockReturnValue(new Promise((resolve) => { settle = resolve; }));
    await renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Install jev' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(cancelJevInstall).toHaveBeenCalled();
    await act(async () => { settle({ ok: false }); });
  });
});

describe('JevPanel try-it box', () => {
  const ready = () => getJevStatus.mockResolvedValue(status({ ready: true, setupState: 'ready', stages: stages(true) }));

  const fill = (premise, options) => {
    fireEvent.change(screen.getByLabelText('Premise'), { target: { value: premise } });
    fireEvent.change(screen.getByLabelText('Options (one per line)'), { target: { value: options } });
  };

  // The margin is top1 - top2, so one option has no runner-up. The UI must not
  // let an operator send a request the service will only refuse.
  it('requires at least two options before it will score', async () => {
    ready();
    await renderPanel();
    fill('Some text.', 'only one option');
    expect(screen.getByRole('button', { name: 'Score' })).toBeDisabled();
    expect(screen.getByText('Add at least two options.')).toBeInTheDocument();

    fill('Some text.', 'first\nsecond');
    expect(screen.getByRole('button', { name: 'Score' })).toBeEnabled();
  });

  it('sends trimmed, blank-stripped options and renders the chosen option', async () => {
    ready();
    scoreJev.mockResolvedValue({ ok: true, choice: 'first', confidence: 0.91, margin: 0.8, abstained: false });
    await renderPanel();
    fill('  Some text.  ', '  first  \n\n second \n');
    fireEvent.click(screen.getByRole('button', { name: 'Score' }));

    await waitFor(() => expect(scoreJev).toHaveBeenCalledWith(
      { premise: 'Some text.', hypotheses: ['first', 'second'] },
      { silent: true },
    ));
    expect(await screen.findByText('Chose: first')).toBeInTheDocument();
  });

  // Abstention is the contract: the panel must never present a near-tie as a
  // choice, because that is exactly what a caller is forbidden to do with it.
  it('renders an abstention as an abstention, never as a winner', async () => {
    ready();
    scoreJev.mockResolvedValue({ ok: true, choice: null, confidence: null, margin: 0.03, abstained: true });
    await renderPanel();
    fill('Some text.', 'first\nsecond');
    fireEvent.click(screen.getByRole('button', { name: 'Score' }));

    const box = await screen.findByTestId('jev-decision');
    expect(box).toHaveTextContent('Abstained');
    expect(box).toHaveTextContent('0.030');
    expect(box).not.toHaveTextContent('Chose:');
  });

  it('shows a failure code beside the input rather than swallowing it', async () => {
    ready();
    scoreJev.mockRejectedValue(new Error('jev-timeout'));
    await renderPanel();
    fill('Some text.', 'first\nsecond');
    fireEvent.click(screen.getByRole('button', { name: 'Score' }));
    expect(await screen.findByText('Scoring failed: jev-timeout')).toBeInTheDocument();
  });

  it('offers an immediate unload only while the model is resident', async () => {
    await renderPanel();
    expect(screen.queryByRole('button', { name: 'Unload now' })).not.toBeInTheDocument();

    getJevStatus.mockResolvedValue(status({ ready: true, setupState: 'ready', stages: stages(true), resident: true }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh status' })); });
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Unload now' })); });
    expect(unloadJev).toHaveBeenCalled();
  });
});

describe('JevPanel decision agreement', () => {
  it('reads an unmeasured decision as no data rather than as zero agreement', async () => {
    getJevDecisionStats.mockResolvedValue({ updatedAt: null, decisions: [
      { decisionId: 'issue-comment-reply', label: 'Issue comment reply gate', observed: 0, decided: 0, abstained: 0, unavailable: 0, compared: 0, agreed: 0, agreementRate: null, abstentionRate: null },
    ] });
    await renderPanel();
    const row = within(await screen.findByTestId('jev-decision-stats')).getByRole('row', { name: /Issue comment reply gate/ });
    // "0% agreement" would argue against a feature nobody has measured yet.
    expect(within(row).getAllByText('—')).toHaveLength(2);
  });

  it('shows the per-decision agreement and abstention rates once measured', async () => {
    getJevDecisionStats.mockResolvedValue({ updatedAt: '2026-09-19T00:00:00.000Z', decisions: [
      { decisionId: 'message-triage', label: 'Message triage action', observed: 1200, decided: 900, abstained: 300, unavailable: 0, compared: 900, agreed: 837, agreementRate: 0.93, abstentionRate: 0.25 },
    ] });
    await renderPanel();
    const row = within(await screen.findByTestId('jev-decision-stats')).getByRole('row', { name: /Message triage action/ });
    expect(row).toHaveTextContent('1,200');
    expect(row).toHaveTextContent('25%');
    expect(row).toHaveTextContent('93%');
  });

  it('keeps the panel usable when the counters cannot be read', async () => {
    getJevDecisionStats.mockRejectedValue(new Error('unavailable'));
    await renderPanel();
    expect(await screen.findByRole('alert')).toHaveTextContent('Decision metrics unavailable');
  });
});

describe('JevPanel project head', () => {
  it('says scope adherence answers zero-shot when no head is trained', async () => {
    await renderPanel();
    expect(await screen.findByText(/answers zero-shot/)).toBeInTheDocument();
    expect(screen.queryByTestId('jev-head-table')).not.toBeInTheDocument();
  });

  // The whole point of the feature's honesty: the operator sees the trained
  // head NEXT TO both baselines it has to beat, not a single score.
  it('shows the trained head beside both baselines', async () => {
    getJevHeads.mockResolvedValue({ heads: [headRow()], training: false });
    await renderPanel();
    const row = within(await screen.findByTestId('jev-head-table')).getByRole('row', { name: /scope-adherence/ });
    expect(row).toHaveTextContent('71%');
    expect(row).toHaveTextContent('58%');
    expect(row).toHaveTextContent('52%');
    expect(row).toHaveTextContent('40 held-out');
  });

  it('adopts a candidate that beats both baselines', async () => {
    getJevHeads.mockResolvedValue({ heads: [headRow()], training: false });
    await renderPanel();
    await screen.findByTestId('jev-head-table');
    fireEvent.click(screen.getByRole('button', { name: 'Adopt' }));
    await waitFor(() => expect(adoptJevHead).toHaveBeenCalledWith('scope-adherence', { silent: true }));
  });

  it('refuses to offer adoption for a head that lost to the stock zero-shot scorer', async () => {
    getJevHeads.mockResolvedValue({
      heads: [headRow({
        metrics: { trained: 0.55, stockZeroShot: 0.62, majorityClass: 0.40, goldSize: 40, trainSize: 120 },
        beatsBaselines: false,
        blocker: 'jev-head-below-zero-shot',
      })],
      training: false,
    });
    await renderPanel();
    await screen.findByTestId('jev-head-table');
    expect(screen.getByRole('button', { name: 'Adopt' })).toBeDisabled();
    expect(screen.getByText(/Did not beat the stock zero-shot scorer/)).toBeInTheDocument();
    // Discard stays available: a head that lost is meant to be thrown away.
    expect(screen.getByRole('button', { name: 'Discard' })).toBeEnabled();
  });

  it('refuses to offer adoption for a head that lost to the majority class', async () => {
    getJevHeads.mockResolvedValue({
      heads: [headRow({
        metrics: { trained: 0.74, stockZeroShot: 0.61, majorityClass: 0.80, goldSize: 40, trainSize: 120 },
        beatsBaselines: false,
        blocker: 'jev-head-below-majority-class',
      })],
      training: false,
    });
    await renderPanel();
    const table = await screen.findByTestId('jev-head-table');
    expect(screen.getByRole('button', { name: 'Adopt' })).toBeDisabled();
    // Scoped to the table: the section's intro prose explains the same rule, so
    // an unscoped query would pass on the explanation rather than the verdict.
    expect(within(table).getByText(/always predicting the most common answer/)).toBeInTheDocument();
  });

  // A head fit on a different encoder revision is a correct artifact for
  // another checkpoint, so it is stated rather than hidden — an absence would
  // read as "no head trained".
  it('names an incompatible head instead of hiding it', async () => {
    getJevHeads.mockResolvedValue({
      heads: [headRow({ adopted: true, compatible: false, baseRevision: 'stale' })],
      training: false,
    });
    await renderPanel();
    const row = within(await screen.findByTestId('jev-head-table')).getByRole('row', { name: /scope-adherence/ });
    expect(row).toHaveTextContent('fit on a different model revision');
  });

  it('cannot start a training run before jev is installed', async () => {
    await renderPanel();
    expect(await screen.findByRole('button', { name: /Train a project head/ })).toBeDisabled();
  });

  it('trains on an explicit click and reloads the head state without adopting', async () => {
    getJevStatus.mockResolvedValue(status({ ready: true, setupState: 'ready', stages: stages(true) }));
    await renderPanel();
    const button = await screen.findByRole('button', { name: /Train a project head/ });
    await waitFor(() => expect(button).toBeEnabled());
    await act(async () => { fireEvent.click(button); });
    expect(trainJevHead).toHaveBeenCalledWith({ architecture: 'linear' }, { silent: true });
    // Training NEVER promotes: the run's only follow-up is re-reading state.
    expect(adoptJevHead).not.toHaveBeenCalled();
  });

  it('reports a failed training run beside the scores rather than as a toast', async () => {
    getJevStatus.mockResolvedValue(status({ ready: true, setupState: 'ready', stages: stages(true) }));
    trainJevHead.mockRejectedValue(new Error('jev-corpus-too-small'));
    await renderPanel();
    const button = await screen.findByRole('button', { name: /Train a project head/ });
    await waitFor(() => expect(button).toBeEnabled());
    await act(async () => { fireEvent.click(button); });
    expect(await screen.findByRole('alert')).toHaveTextContent('jev-corpus-too-small');
  });
});

describe('JevPanel head architecture', () => {
  // `mlp1` is in the artifact contract and the trainer; a knob only a
  // hand-written request could reach is a knob nobody tunes.
  it('trains the architecture the operator picked', async () => {
    getJevStatus.mockResolvedValue(status({ ready: true, setupState: 'ready', stages: stages(true) }));
    await renderPanel();
    const button = await screen.findByRole('button', { name: /Train a project head/ });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Head'), { target: { value: 'mlp1' } });
    await act(async () => { fireEvent.click(button); });
    expect(trainJevHead).toHaveBeenCalledWith({ architecture: 'mlp1' }, { silent: true });
  });
});
