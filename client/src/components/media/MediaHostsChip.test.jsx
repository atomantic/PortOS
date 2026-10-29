import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ makeMediaPrimary: vi.fn(), getMediaHolders: vi.fn() }));
vi.mock('../../services/api', () => api);
vi.mock('../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

const { default: MediaHostsChip } = await import('./MediaHostsChip');
const { default: toast } = await import('../ui/Toast');

const holder = (instanceId, name, extra = {}) => ({ instanceId, name, self: false, primary: false, releasePending: false, ...extra });
const entry = (holders) => ({ kind: 'video', filename: 'v1.mp4', cardKeys: ['video:v1'], primaryInstanceId: null, holders });

beforeEach(() => {
  api.makeMediaPrimary.mockReset();
  api.getMediaHolders.mockResolvedValue({ self: 'inst-self', items: {} });
  toast.success.mockClear();
  toast.error.mockClear();
});

describe('MediaHostsChip', () => {
  it('names the single remote host, and renders nothing for media held only here', () => {
    const { rerender } = render(<MediaHostsChip entry={entry([holder('inst-a', 'Studio Mac')])} />);
    expect(screen.getByText('Hosted on Studio Mac')).toBeTruthy();
    rerender(<MediaHostsChip entry={entry([holder('inst-self', 'This machine', { self: true })])} />);
    expect(screen.queryByText(/Hosted on/)).toBeNull();
  });

  it('lists every holder and confirms which copies Make primary deletes before calling the server', async () => {
    api.makeMediaPrimary.mockResolvedValue({ primaryInstanceId: 'inst-a', released: [{ instanceId: 'inst-self', name: 'This machine' }], pending: [], kept: [] });
    render(<MediaHostsChip entry={entry([holder('inst-self', 'This machine', { self: true }), holder('inst-a', 'Studio Mac', { releasePending: true })])} />);

    fireEvent.click(screen.getByRole('button', { name: /2 hosts/ }));
    const list = screen.getByRole('region', { name: 'Machines holding this render' });
    expect(list.textContent).toContain('This machine');
    expect(list.textContent).toContain('Studio Mac');
    expect(list.textContent).toContain('delete pending');

    fireEvent.click(screen.getAllByRole('button', { name: 'Make primary' })[1]);
    expect(screen.getByText('Keep the copy on Studio Mac? Deletes the copy on This machine.')).toBeTruthy();
    expect(api.makeMediaPrimary).not.toHaveBeenCalled();

    // The inline confirmation's button is the last one named Make primary.
    fireEvent.click(screen.getAllByRole('button', { name: 'Make primary' }).at(-1));
    await waitFor(() => expect(api.makeMediaPrimary).toHaveBeenCalledWith({ kind: 'video', filename: 'v1.mp4', instanceId: 'inst-a' }, { silent: true }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Primary set; copy removed from This machine'));
  });

  it('reports a copy its holder kept as a failure', async () => {
    api.makeMediaPrimary.mockResolvedValue({ primaryInstanceId: 'inst-self', released: [], pending: [], kept: [{ instanceId: 'inst-a', name: 'Studio Mac', reason: 'media delete is turned off there' }] });
    render(<MediaHostsChip entry={entry([holder('inst-self', 'This machine', { self: true }), holder('inst-a', 'Studio Mac')])} />);
    fireEvent.click(screen.getByRole('button', { name: /2 hosts/ }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Make primary' })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Make primary' }).at(-1));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Primary set; copy kept on Studio Mac (media delete is turned off there)'));
  });
});
