import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import SlashDoPanel from './SlashDoPanel';

const api = vi.hoisted(() => ({
  getSlashdoCommands: vi.fn(),
  createSlashdoTask: vi.fn()
}));

vi.mock('../../services/api', () => api);
vi.mock('./SlashDoRunDrawer', () => ({
  default: ({ command }) => <div data-testid="run-drawer">{command}</div>
}));

// Shape mirrors what `GET /api/cos/slashdo-commands` serves from the shared
// server catalog (server/lib/slashdoCatalog.js) — the panel renders whatever it
// returns rather than a client-side copy (#3108).
const CATALOG = [
  { command: 'review', label: '/do:review', description: 'Deep code review of the changed files' },
  { command: 'next', label: '/do:next', description: 'Claim a work item and ship a PR', configurable: true },
  { command: 'better', label: '/do:better', description: 'DevSecOps audit', hideForSwift: true },
  { command: 'better-swift', label: '/do:better-swift', description: 'SwiftUI DevSecOps audit', swiftOnly: true }
];

const renderPanel = (props = {}) => render(
  <MemoryRouter>
    <SlashDoPanel appId="acme" appName="Acme App" appType="node" {...props} />
  </MemoryRouter>
);

describe('SlashDoPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getSlashdoCommands.mockResolvedValue({ commands: CATALOG });
    api.createSlashdoTask.mockResolvedValue({ id: 'task-1', status: 'pending' });
  });

  it('renders a button per fetched catalog command', async () => {
    renderPanel();
    // A command that exists only in the server catalog still gets a button — the
    // point of fetching instead of mirroring.
    expect(await screen.findByRole('button', { name: '/do:review' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '/do:next' })).toBeInTheDocument();
  });

  it('queues the BARE command name for a non-configurable command', async () => {
    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: '/do:review' }));

    await waitFor(() => expect(api.createSlashdoTask).toHaveBeenCalled());
    const [command, appId] = api.createSlashdoTask.mock.calls.at(-1);
    expect(command).toBe('review');
    expect(appId).toBe('acme');
  });

  it('opens the run drawer instead of queuing for a configurable command', async () => {
    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: '/do:next' }));

    expect(await screen.findByTestId('run-drawer')).toHaveTextContent('next');
    expect(api.createSlashdoTask).not.toHaveBeenCalled();
  });

  it('shows only the Swift audit on a Swift app (catalog swiftOnly/hideForSwift)', async () => {
    renderPanel({ appType: 'ios-native' });
    expect(await screen.findByRole('button', { name: '/do:better-swift' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '/do:better' })).not.toBeInTheDocument();
  });

  it('shows only the generic audit on a non-Swift app', async () => {
    renderPanel();
    expect(await screen.findByRole('button', { name: '/do:better' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '/do:better-swift' })).not.toBeInTheDocument();
  });

  it('renders no buttons when the catalog fetch fails', async () => {
    api.getSlashdoCommands.mockRejectedValue(new Error('offline'));
    renderPanel();

    // The header still renders; a failed fetch must not crash the overview tab.
    expect(await screen.findByText('Agent Operations')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /\/do:/ })).not.toBeInTheDocument();
  });
});
