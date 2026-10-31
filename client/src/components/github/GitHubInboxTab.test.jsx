import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  clearFinishedGitHubNotifications: vi.fn(),
  getGitHubAccounts: vi.fn(),
  getGitHubNotifications: vi.fn(),
  syncGitHubNotifications: vi.fn(),
}));

vi.mock('../../services/api', () => api);
vi.mock('../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('./GitHubThreadDrawer', () => ({ default: () => null }));

const GitHubInboxTab = (await import('./GitHubInboxTab')).default;

const accounts = [
  { id: 'acct-a', label: 'Account A', enabled: true, mode: 'read' },
  { id: 'acct-b', label: 'Account B', enabled: true, mode: 'read' },
];
const list = { notifications: [], counts: {}, sync: {} };

const deferred = () => {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
};

describe('GitHubInboxTab sync status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getGitHubAccounts.mockResolvedValue(accounts);
    api.getGitHubNotifications.mockResolvedValue(list);
  });

  it('keeps Refresh busy until the newest account sync finishes, even if an older one resolves first', async () => {
    const syncs = { 'acct-a': deferred(), 'acct-b': deferred() };
    api.syncGitHubNotifications.mockImplementation((id) => (id ? syncs[id].promise : Promise.resolve([])));
    render(<MemoryRouter><GitHubInboxTab /></MemoryRouter>);

    const select = await screen.findByLabelText('Account');
    await screen.findByRole('button', { name: /Refresh/ });
    fireEvent.change(select, { target: { value: 'acct-a' } });
    fireEvent.change(select, { target: { value: 'acct-b' } });

    const button = await screen.findByRole('button', { name: /Checking…/ });
    await act(async () => { syncs['acct-a'].resolve([]); });
    expect(screen.getByRole('button', { name: /Checking…/ })).toBe(button);
    expect(button.disabled).toBe(true);

    await act(async () => { syncs['acct-b'].resolve([]); });
    const done = await screen.findByRole('button', { name: /Refresh/ });
    expect(done.disabled).toBe(false);
  });
});
