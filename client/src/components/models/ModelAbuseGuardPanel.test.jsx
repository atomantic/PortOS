import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../services/api', () => ({
  getModelAbuseGuardStatus: vi.fn(),
  getHfTokenStatus: vi.fn(),
  installModelAbuseGuard: vi.fn(),
  cancelModelAbuseGuardInstall: vi.fn(),
}));
vi.mock('../../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn() },
}));
vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}));

import {
  cancelModelAbuseGuardInstall,
  getHfTokenStatus,
  getModelAbuseGuardStatus,
  installModelAbuseGuard,
} from '../../services/api';
import socket from '../../services/socket';
import ModelAbuseGuardPanel from './ModelAbuseGuardPanel';

const STAGES = [
  { id: 'huggingface-token', label: 'Hugging Face access token', description: 'A read token plus gated-model approval.', ready: true },
  { id: 'python', label: 'Host Python', description: 'A Python interpreter for the dedicated runtime.', ready: true },
  { id: 'venv', label: 'Dedicated Prompt Guard runtime', description: 'A private virtualenv.', ready: false },
  { id: 'packages', label: 'Classifier packages', description: 'Pinned classifier imports.', ready: false },
  { id: 'model', label: 'Pinned model snapshot', description: 'The five required Prompt Guard files.', ready: false },
];

beforeEach(() => {
  vi.clearAllMocks();
  getModelAbuseGuardStatus.mockResolvedValue({
    id: 'llama-prompt-guard-2-86m',
    name: 'Llama Prompt Guard 2 86M',
    sourceUrl: 'https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M',
    ready: false,
    modelCached: false,
    runtimeReady: false,
    pythonAvailable: true,
    venvReady: false,
    stages: STAGES,
  });
  getHfTokenStatus.mockResolvedValue({ hfTokenPresent: true, source: 'stored' });
  installModelAbuseGuard.mockResolvedValue({ ok: true, ready: true });
  cancelModelAbuseGuardInstall.mockResolvedValue({ cancelled: true });
});

const renderPanel = async () => {
  render(<ModelAbuseGuardPanel />);
  expect(await screen.findByRole('heading', { name: 'Model-abuse guard' })).toBeInTheDocument();
};

describe('ModelAbuseGuardPanel', () => {
  it('tracks each install stage separately from the chat catalog', async () => {
    await renderPanel();

    expect(screen.getByText('Optional second layer · managed classifier')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Abuse guard setup stages' })).toBeInTheDocument();
    expect(screen.getByTestId('abuse-guard-stage-huggingface-token')).toHaveAttribute('data-ready', 'true');
    expect(screen.getByTestId('abuse-guard-stage-python')).toHaveAttribute('data-ready', 'true');
    expect(screen.getByTestId('abuse-guard-stage-venv')).toHaveAttribute('data-ready', 'false');
    expect(screen.getByTestId('abuse-guard-stage-packages')).toHaveAttribute('data-ready', 'false');
    expect(screen.getByTestId('abuse-guard-stage-model')).toHaveAttribute('data-ready', 'false');
    expect(screen.queryByText('Recommended for Security Scan')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install model-abuse guard' })).toBeInTheDocument();
  });

  it('marks the live install stage from security-guard progress events', async () => {
    let deferred;
    installModelAbuseGuard.mockImplementation(() => new Promise((resolve) => { deferred = resolve; }));
    await renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Install model-abuse guard' }));
    await waitFor(() => expect(installModelAbuseGuard).toHaveBeenCalled());
    await act(async () => {});

    const handler = socket.on.mock.calls.find((call) => call[0] === 'localLlm:progress')?.[1];
    expect(handler).toEqual(expect.any(Function));
    act(() => {
      handler({ scope: 'security-guard', event: 'stage', stage: 'venv', message: 'Preparing the dedicated Prompt Guard runtime…' });
    });
    expect(screen.getByTestId('abuse-guard-stage-venv').textContent).toMatch(/Installing/);
    expect(screen.getByText('Preparing the dedicated Prompt Guard runtime…')).toBeInTheDocument();

    await act(async () => { deferred({ ok: true, ready: true }); });
  });
});
