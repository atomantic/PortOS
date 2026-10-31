import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const handlers = {};
vi.mock('../../../../services/socket', () => ({
  default: { on: (e, fn) => { handlers[e] = fn; }, off: vi.fn() },
}));
const list = vi.fn();
vi.mock('../../../../services/apiMusicVideo', () => ({ listMusicVideoProjectSummaries: (...a) => list(...a) }));

const { default: Blocker } = await import('./MusicVideoAutopilotBlocker.jsx');

const renderIt = () => render(<MemoryRouter><Blocker /></MemoryRouter>);

beforeEach(() => list.mockReset());

describe('MusicVideoAutopilotBlocker (#10156)', () => {
  it('names the scheduled project the run is parked on, links to it, and clears when the run moves on', async () => {
    list.mockResolvedValue({ items: [
      { id: 'mv-1', name: 'Parked video', runStatus: 'needs-human', runOrigin: 'schedule' },
      { id: 'mv-2', name: 'Manual video', runStatus: 'needs-human', runOrigin: 'manual' },
    ] });
    renderIt();
    expect(await screen.findByText(/"Parked video" needs you/)).toBeTruthy();
    expect(screen.queryByText(/Manual video/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Open project' }).getAttribute('href')).toBe('/music-video/mv-1/setup');

    act(() => handlers['music-video:autonomous']({ project: { id: 'mv-1', name: 'Parked video', autonomousRun: { status: 'running', brief: { origin: { kind: 'schedule' } } } } }));
    await waitFor(() => expect(screen.queryByText(/Parked video/)).toBeNull());
  });

  it('says the parked-run check failed and retries it, instead of rendering nothing', async () => {
    list.mockRejectedValueOnce(new Error('Server unavailable'))
      .mockResolvedValueOnce({ items: [{ id: 'mv-1', name: 'Parked video', runStatus: 'needs-human', runOrigin: 'schedule' }] });
    renderIt();
    expect(await screen.findByText(/Could not load whether a music video run is parked — Server unavailable/)).toBeTruthy();
    act(() => { screen.getByRole('button', { name: 'Retry' }).click(); });
    expect(await screen.findByText(/"Parked video" needs you/)).toBeTruthy();
    expect(screen.queryByText(/Could not load/)).toBeNull();
  });

  it('keeps the failed-check notice while a retry is still pending', async () => {
    list.mockRejectedValueOnce(new Error('Server unavailable')).mockReturnValueOnce(new Promise(() => {}));
    renderIt();
    expect(await screen.findByText(/Could not load whether a music video run is parked/)).toBeTruthy();
    act(() => { screen.getByRole('button', { name: 'Retry' }).click(); });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/Could not load whether a music video run is parked/)).toBeTruthy();
  });

  it('renders nothing when no scheduled run is parked', async () => {
    list.mockResolvedValue({ items: [{ id: 'mv-1', name: 'Done', runStatus: 'completed', runOrigin: 'schedule' }] });
    const { container } = renderIt();
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
