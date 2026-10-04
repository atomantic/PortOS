import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router';
import PipelineReverseOutline from './PipelineReverseOutline';
import { MockEventSource, lastEventSource } from '../test/mockEventSource';

const getPipelineSeries = vi.fn();
const getReverseOutline = vi.fn();
const getReverseOutlineStatus = vi.fn();
const generateReverseOutline = vi.fn();
const cancelReverseOutline = vi.fn();

vi.mock('../services/api', () => ({
  getPipelineSeries: (...a) => getPipelineSeries(...a),
  getReverseOutline: (...a) => getReverseOutline(...a),
  generateReverseOutline: (...a) => generateReverseOutline(...a),
  cancelReverseOutline: (...a) => cancelReverseOutline(...a),
  getReverseOutlineStatus: (...a) => getReverseOutlineStatus(...a),
  pipelineReverseOutlineSseUrl: (id) => `/sse/${id}`,
}));
vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

const EMPTY = { status: 'none', plotlines: [], scenes: [] };
const SAVED = {
  status: 'complete',
  plotlines: [{ id: 'pl-1', label: 'Main thread', kind: 'main', color: '#ff0000' }],
  scenes: [{ id: 'sc-1', plotlineId: 'pl-1', heading: 'Opening scene', summary: 'The first beat.', issueNumber: 1 }],
};

const renderPage = () => render(
  <MemoryRouter initialEntries={['/pipeline/series/ser-1/reverse-outline']}>
    <Routes>
      <Route path="/pipeline/series/:seriesId/reverse-outline" element={<PipelineReverseOutline />} />
      <Route path="/pipeline" element={<div>Pipeline index</div>} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  MockEventSource.reset();
  global.EventSource = MockEventSource;
  getPipelineSeries.mockReset().mockResolvedValue({ id: 'ser-1', name: 'Example Series' });
  getReverseOutline.mockReset().mockResolvedValue(EMPTY);
  getReverseOutlineStatus.mockReset().mockResolvedValue({ active: false });
  generateReverseOutline.mockReset().mockResolvedValue({ runId: 'run-1' });
  cancelReverseOutline.mockReset().mockResolvedValue({ canceled: true });
});

afterEach(() => {
  delete global.EventSource;
});

describe('PipelineReverseOutline stream recovery', () => {
  it('shows the saved outline and re-enables Generate when the run was evicted before the stream attached', async () => {
    getReverseOutlineStatus.mockResolvedValue({ active: true });
    renderPage();
    await screen.findByRole('button', { name: /Generating/ });

    // The run finished and was pruned: the progress GET 404s, status says inactive.
    getReverseOutlineStatus.mockResolvedValue({ active: false });
    getReverseOutline.mockResolvedValue(SAVED);
    act(() => lastEventSource().fail());

    await waitFor(() => expect(screen.getByRole('button', { name: 'Regenerate' })).toBeEnabled());
    expect(screen.getByTitle('Opening scene')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Cancel/ })).toBeNull();
    expect(generateReverseOutline).not.toHaveBeenCalled();
  });

  it('an accepted Cancel stays visibly pending until the server settles', async () => {
    const user = userEvent.setup();
    getReverseOutlineStatus.mockResolvedValue({ active: true });
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(cancelReverseOutline).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: /Canceling/ })).toBeDisabled();
  });

  it('settles a false Cancel answer from the status read', async () => {
    const user = userEvent.setup();
    getReverseOutlineStatus.mockResolvedValue({ active: true });
    cancelReverseOutline.mockResolvedValue({ canceled: false });
    renderPage();
    const cancel = await screen.findByRole('button', { name: 'Cancel' });

    getReverseOutlineStatus.mockResolvedValue({ active: false });
    getReverseOutline.mockResolvedValue(SAVED);
    await user.click(cancel);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Regenerate' })).toBeEnabled());
    expect(screen.queryByRole('button', { name: /Cancel/ })).toBeNull();
  });

  it('offers Reattach and Cancel — and never another generation — while the run is still active', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Generate outline' }));
    await screen.findByRole('button', { name: /Generating/ });

    getReverseOutlineStatus.mockResolvedValue({ active: true });
    act(() => lastEventSource().fail());

    await user.click(await screen.findByRole('button', { name: 'Reattach' }));
    expect(MockEventSource.instances).toHaveLength(2);
    expect(screen.getByRole('button', { name: /Cancel/ })).toBeEnabled();
    expect(generateReverseOutline).toHaveBeenCalledTimes(1);
  });

  it('offers Retry status when the status read fails, and settles once it succeeds', async () => {
    const user = userEvent.setup();
    getReverseOutlineStatus.mockResolvedValue({ active: true });
    renderPage();
    await screen.findByRole('button', { name: /Generating/ });

    getReverseOutlineStatus.mockRejectedValueOnce(new Error('offline'));
    act(() => lastEventSource().fail());
    const retry = await screen.findByRole('button', { name: 'Retry status' });
    expect(screen.getByRole('button', { name: /Generating/ })).toBeDisabled();

    getReverseOutlineStatus.mockResolvedValue({ active: false });
    getReverseOutline.mockResolvedValue(SAVED);
    await user.click(retry);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Regenerate' })).toBeEnabled());
  });
});
