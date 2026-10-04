import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router';
import PipelineContinuityBible from './PipelineContinuityBible';
import { MockEventSource, lastEventSource } from '../test/mockEventSource';

const getPipelineSeries = vi.fn();
const getContinuityBible = vi.fn();
const getContinuityBibleStatus = vi.fn();
const generateContinuityBible = vi.fn();
const cancelContinuityBible = vi.fn();

vi.mock('../services/api', () => ({
  getPipelineSeries: (...a) => getPipelineSeries(...a),
  getContinuityBible: (...a) => getContinuityBible(...a),
  generateContinuityBible: (...a) => generateContinuityBible(...a),
  cancelContinuityBible: (...a) => cancelContinuityBible(...a),
  getContinuityBibleStatus: (...a) => getContinuityBibleStatus(...a),
  pipelineContinuityBibleSseUrl: (id) => `/sse/${id}`,
}));
vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

const EMPTY = { status: 'none', facts: [] };
const SAVED = {
  status: 'complete',
  categories: [{ id: 'physical', label: 'Physical traits' }],
  facts: [{ id: 'f-1', category: 'physical', source: 'prose', subject: 'Alice', statement: 'Alice has green eyes.', issueNumber: 1 }],
};

const renderPage = () => render(
  <MemoryRouter initialEntries={['/pipeline/series/ser-1/continuity-bible']}>
    <Routes>
      <Route path="/pipeline/series/:seriesId/continuity-bible" element={<PipelineContinuityBible />} />
      <Route path="/pipeline" element={<div>Pipeline index</div>} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  MockEventSource.reset();
  global.EventSource = MockEventSource;
  getPipelineSeries.mockReset().mockResolvedValue({ id: 'ser-1', name: 'Example Series' });
  getContinuityBible.mockReset().mockResolvedValue(EMPTY);
  getContinuityBibleStatus.mockReset().mockResolvedValue({ active: false });
  generateContinuityBible.mockReset().mockResolvedValue({ runId: 'run-1' });
  cancelContinuityBible.mockReset().mockResolvedValue({ canceled: true });
});

afterEach(() => {
  delete global.EventSource;
});

describe('PipelineContinuityBible stream recovery', () => {
  it('shows the saved ledger and re-enables Build when the run was evicted before the stream attached', async () => {
    getContinuityBibleStatus.mockResolvedValue({ active: true });
    renderPage();
    await screen.findByRole('button', { name: /Building/ });

    // The run finished and was pruned: the progress GET 404s, status says inactive.
    getContinuityBibleStatus.mockResolvedValue({ active: false });
    getContinuityBible.mockResolvedValue(SAVED);
    act(() => lastEventSource().fail());

    await waitFor(() => expect(screen.getByRole('button', { name: 'Rebuild ledger' })).toBeEnabled());
    expect(await screen.findByText(/Alice has green eyes/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Cancel/ })).toBeNull();
    expect(generateContinuityBible).not.toHaveBeenCalled();
  });

  it('an accepted Cancel stays visibly pending until the server settles', async () => {
    const user = userEvent.setup();
    getContinuityBibleStatus.mockResolvedValue({ active: true });
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(cancelContinuityBible).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: /Canceling/ })).toBeDisabled();
  });

  it('settles a false Cancel answer from the status read', async () => {
    const user = userEvent.setup();
    getContinuityBibleStatus.mockResolvedValue({ active: true });
    cancelContinuityBible.mockResolvedValue({ canceled: false });
    renderPage();
    const cancel = await screen.findByRole('button', { name: 'Cancel' });

    getContinuityBibleStatus.mockResolvedValue({ active: false });
    getContinuityBible.mockResolvedValue(SAVED);
    await user.click(cancel);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Rebuild ledger' })).toBeEnabled());
    expect(screen.queryByRole('button', { name: /Cancel/ })).toBeNull();
  });

  it('offers Reattach and Cancel — and never another generation — while the run is still active', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Build ledger' }));
    await screen.findByRole('button', { name: /Building/ });

    getContinuityBibleStatus.mockResolvedValue({ active: true });
    act(() => lastEventSource().fail());

    await user.click(await screen.findByRole('button', { name: 'Reattach' }));
    expect(MockEventSource.instances).toHaveLength(2);
    expect(screen.getByRole('button', { name: /Cancel/ })).toBeEnabled();
    expect(generateContinuityBible).toHaveBeenCalledTimes(1);
  });

  it('offers Retry status when the status read fails, and settles once it succeeds', async () => {
    const user = userEvent.setup();
    getContinuityBibleStatus.mockResolvedValue({ active: true });
    renderPage();
    await screen.findByRole('button', { name: /Building/ });

    getContinuityBibleStatus.mockRejectedValueOnce(new Error('offline'));
    act(() => lastEventSource().fail());
    const retry = await screen.findByRole('button', { name: 'Retry status' });
    expect(screen.getByRole('button', { name: /Building/ })).toBeDisabled();

    getContinuityBibleStatus.mockResolvedValue({ active: false });
    getContinuityBible.mockResolvedValue(SAVED);
    await user.click(retry);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rebuild ledger' })).toBeEnabled());
  });
});
