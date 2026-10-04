import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// A tiny in-memory emitter standing in for the shared socket so a test can
// deliver `digital-twin:test-progress` frames in any order, any number of times.
const bus = vi.hoisted(() => {
  const handlers = new Map();
  return {
    handlers,
    on: (event, fn) => { handlers.set(event, [...(handlers.get(event) || []), fn]); },
    off: (event, fn) => { handlers.set(event, (handlers.get(event) || []).filter(h => h !== fn)); },
    emit: (event, payload) => (handlers.get(event) || []).forEach(h => h(payload)),
    count: (event) => (handlers.get(event) || []).length,
  };
});

vi.mock('../../../services/socket', () => ({ default: { on: bus.on, off: bus.off } }));
vi.mock('../../../services/api', () => ({
  getDigitalTwinTests: vi.fn(),
  getProviders: vi.fn(),
  getDigitalTwinTestHistory: vi.fn(),
  getBehavioralFeedbackStats: vi.fn(),
  getDigitalTwinPersonas: vi.fn(),
  runSoulTests: vi.fn(),
  runSoulMultiTests: vi.fn(),
  submitBehavioralFeedback: vi.fn(),
  generateSoulTests: vi.fn(),
}));
vi.mock('../../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('./ValuesAlignmentPanel', () => ({ default: () => null }));
vi.mock('./AdversarialBoundaryPanel', () => ({ default: () => null }));
vi.mock('./MultiTurnPanel', () => ({ default: () => null }));

import TestTab from './TestTab';
import * as api from '../../../services/api';

const PROGRESS = 'digital-twin:test-progress';
const passed = (model) => ({ score: 1, passed: 1, total: 1, results: [{ testId: 1, result: 'passed' }], model });

let finalResponse;

beforeEach(() => {
  vi.clearAllMocks();
  bus.handlers.clear();
  api.getDigitalTwinTests.mockResolvedValue([{ testId: 1, testName: 'Honesty', prompt: 'p', expectedBehavior: 'e', failureSignals: 'f' }]);
  api.getProviders.mockResolvedValue({ providers: [{ id: 'p1', name: 'P1', enabled: true, models: ['alpha', 'beta'] }] });
  api.getDigitalTwinTestHistory.mockResolvedValue([]);
  api.getBehavioralFeedbackStats.mockResolvedValue(null);
  api.getDigitalTwinPersonas.mockResolvedValue([]);
  api.runSoulMultiTests.mockImplementation(() => new Promise((resolve) => { finalResponse = resolve; }));
});

// Start a two-model batch and return the request id the tab minted for it.
async function startBatch(user) {
  render(<TestTab onRefresh={vi.fn()} />);
  await user.click(await screen.findByRole('button', { name: 'alpha' }));
  await user.click(screen.getByRole('button', { name: 'beta' }));
  await user.click(screen.getByRole('button', { name: /Run Selected Tests/ }));
  await waitFor(() => expect(api.runSoulMultiTests).toHaveBeenCalled());
  return api.runSoulMultiTests.mock.calls[0][3];
}

const frame = (requestId, model, result) => ({ requestId, providerId: 'p1', model, result });

describe('TestTab multi-model progress (#10063)', () => {
  it('shows the first finished model with 1-of-2 status while the final response is still pending', async () => {
    const user = userEvent.setup();
    const requestId = await startBatch(user);
    expect(requestId).toEqual(expect.any(String));

    act(() => bus.emit(PROGRESS, frame(requestId, 'alpha', passed('alpha'))));

    const table = await screen.findByRole('table');
    expect(within(table).getByText('alpha')).toBeInTheDocument();
    expect(within(table).queryByText('beta')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /1 of 2 models done/ })).toBeInTheDocument();
  });

  it('ignores duplicate, other-batch, and settled-batch frames and keeps selected-model order', async () => {
    const user = userEvent.setup();
    const requestId = await startBatch(user);

    // A frame for someone else's batch arrives first and must be dropped.
    act(() => bus.emit(PROGRESS, frame('another-batch', 'alpha', { score: 0, passed: 0, total: 1, results: [] })));
    // beta finishes first, alpha second — rows must still read alpha, beta.
    act(() => bus.emit(PROGRESS, frame(requestId, 'beta', passed('beta'))));
    act(() => bus.emit(PROGRESS, frame(requestId, 'alpha', passed('alpha'))));
    // Duplicate delivery must not overwrite the accepted result.
    act(() => bus.emit(PROGRESS, frame(requestId, 'alpha', { score: 0, passed: 0, total: 1, results: [] })));

    const headers = within(await screen.findByRole('table')).getAllByRole('columnheader').map(h => h.textContent);
    expect(headers).toEqual(['Test', 'alpha', 'beta']);
    expect(screen.getAllByText('100%')).toHaveLength(2);

    // Final array reconciles to one entry per pair and settles the batch.
    await act(async () => {
      finalResponse([
        { providerId: 'p1', model: 'alpha', ...passed('alpha') },
        { providerId: 'p1', model: 'beta', ...passed('beta') },
      ]);
    });
    await waitFor(() => expect(screen.getByRole('button', { name: /Run Selected Tests/ })).toBeInTheDocument());

    // A late frame from the settled batch cannot touch the final result set.
    act(() => bus.emit(PROGRESS, frame(requestId, 'alpha', { score: 0, passed: 0, total: 1, results: [] })));
    expect(screen.getAllByText('100%')).toHaveLength(2);
  });

  it('renders a provider failure as a failure, not a completed success', async () => {
    const user = userEvent.setup();
    const requestId = await startBatch(user);

    act(() => bus.emit(PROGRESS, frame(requestId, 'alpha', { providerId: 'p1', model: 'alpha', error: 'quota exceeded' })));

    expect(await screen.findByText(/Failed: quota exceeded/)).toBeInTheDocument();
    expect(screen.queryByText('100%')).not.toBeInTheDocument();
  });

  it('releases the socket listener on unmount', async () => {
    const { unmount } = render(<TestTab onRefresh={vi.fn()} />);
    await waitFor(() => expect(bus.count(PROGRESS)).toBe(1));
    unmount();
    expect(bus.count(PROGRESS)).toBe(0);
  });

  it('leaves single-model runs on the single-provider endpoint', async () => {
    const user = userEvent.setup();
    api.runSoulTests.mockResolvedValue(passed('alpha'));
    render(<TestTab onRefresh={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'alpha' }));
    await user.click(screen.getByRole('button', { name: /Run Selected Tests/ }));
    await waitFor(() => expect(api.runSoulTests).toHaveBeenCalled());
    expect(api.runSoulMultiTests).not.toHaveBeenCalled();
  });
});
