import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const api = vi.hoisted(() => ({ makeMediaPrimary: vi.fn(), getMediaHolders: vi.fn() }));
vi.mock('../../services/apiMediaHolders.js', () => ({
  makeMediaPrimary: api.makeMediaPrimary,
  getMediaHolders: api.getMediaHolders,
}));
vi.mock('../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../ui/Toast');

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

    const trigger = screen.getAllByRole('button', { name: 'Make primary' })[1];
    fireEvent.click(trigger);
    const confirmation = screen.getByRole('group', { name: 'Confirm Studio Mac as primary' });
    expect(document.activeElement).toBe(confirmation);
    expect(within(confirmation).getByText('Keep the copy on Studio Mac')).toBeTruthy();
    expect(within(confirmation).getByText('Move copies to Trash on This machine.')).toBeTruthy();
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(api.makeMediaPrimary).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    fireEvent.click(within(screen.getByRole('group')).getByRole('button', { name: 'Make primary' }));
    await waitFor(() => expect(api.makeMediaPrimary).toHaveBeenCalledWith({ kind: 'video', filename: 'v1.mp4', instanceId: 'inst-a' }, { silent: true }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Primary set; copy removed from This machine'));
  });

  it('shows a host literally named "null" by its name', () => {
    render(<MediaHostsChip entry={entry([holder('inst-self', 'This machine', { self: true }), holder('inst-a', 'null')])} />);
    fireEvent.click(screen.getByRole('button', { name: /2 hosts/ }));
    expect(screen.getByText('null')).toBeTruthy();
    expect(screen.queryByText(/Unnamed host/)).toBeNull();
  });

  it('identifies an unnamed host in the list and confirmation', () => {
    render(<MediaHostsChip entry={entry([holder('inst-self', 'This machine', { self: true }), holder('inst-a', '  ')])} />);
    fireEvent.click(screen.getByRole('button', { name: /2 hosts/ }));
    expect(screen.getByText('Unnamed host (inst-a)')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Make primary' })[1]);
    expect(screen.getByRole('group', { name: 'Confirm Unnamed host (inst-a) as primary' })).toBeTruthy();
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
