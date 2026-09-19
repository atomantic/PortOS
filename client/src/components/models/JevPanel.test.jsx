import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../../services/api', () => ({
  getJevStatus: vi.fn(),
  getJevDecisionStats: vi.fn(),
  installJev: vi.fn(),
  cancelJevInstall: vi.fn(),
  scoreJev: vi.fn(),
  unloadJev: vi.fn(),
}));
vi.mock('../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}));

import { cancelJevInstall, getJevDecisionStats, getJevStatus, installJev, scoreJev, unloadJev } from '../../services/api';
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
});

const renderPanel = async () => {
  render(<JevPanel />);
  expect(await screen.findByRole('heading', { name: 'jev decision scorer' })).toBeInTheDocument();
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
    expect(await screen.findByText('No decisions measured yet on this machine.')).toBeInTheDocument();
  });
});
