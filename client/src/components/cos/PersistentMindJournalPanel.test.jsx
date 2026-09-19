import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PersistentMindJournalPanel from './PersistentMindJournalPanel';

const mocks = vi.hoisted(() => ({
  getPersistentMindJournal: vi.fn(),
  correctPersistentMindJournalEvent: vi.fn(),
}));

vi.mock('../../services/api', () => ({
  getPersistentMindJournal: (...args) => mocks.getPersistentMindJournal(...args),
  correctPersistentMindJournalEvent: (...args) => mocks.correctPersistentMindJournalEvent(...args),
}));

const entry = (overrides) => ({
  id: 'decision-1',
  kind: 'decision',
  statement: 'We ship the importer first.',
  status: 'active',
  sourceSequences: [12],
  supersedes: null,
  supersededBy: null,
  resolution: null,
  retiredBy: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  providerId: 'demo',
  model: 'demo-model',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPersistentMindJournal.mockResolvedValue({ events: [], total: 0, counts: {} });
});

describe('PersistentMindJournalPanel', () => {
  it('keeps a retired entry out of the live list but readable behind the toggle, naming what replaced it', async () => {
    // The user-visible point of supersession: the reversed statement must stop
    // being quoted as current WITHOUT disappearing, and the panel has to say
    // which statement replaced it or the history is unreadable.
    mocks.getPersistentMindJournal.mockResolvedValue({
      counts: { active: 1, superseded: 1, resolved: 0 },
      total: 2,
      events: [
        entry({ id: 'decision-0', status: 'superseded', supersededBy: 'decision-1', retiredBy: 'mind', statement: 'We ship the exporter first.' }),
        entry({ id: 'decision-1', supersedes: 'decision-0' }),
      ],
    });

    render(<PersistentMindJournalPanel />);

    expect(await screen.findByText('We ship the importer first.')).toBeTruthy();
    expect(screen.queryByText('We ship the exporter first.')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Show retired entries/ }));
    expect(screen.getByText('We ship the exporter first.')).toBeTruthy();
    expect(screen.getByText(/Replaced by: We ship the importer first\./)).toBeTruthy();
  });

  it('moves an entry the user retires out of the live list without refetching the journal', async () => {
    mocks.getPersistentMindJournal.mockResolvedValue({
      counts: { active: 1, superseded: 0, resolved: 0 },
      total: 1,
      events: [entry({})],
    });
    mocks.correctPersistentMindJournalEvent.mockResolvedValue({
      success: true,
      changed: true,
      event: entry({ status: 'superseded', retiredBy: 'user' }),
    });

    render(<PersistentMindJournalPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Retire/ }));

    await waitFor(() => expect(screen.queryByRole('button', { name: /Retire/ })).toBeNull());
    expect(mocks.correctPersistentMindJournalEvent).toHaveBeenCalledWith('decision-1', { action: 'retire' }, { silent: true });
    // One load, not two: the reactive swap uses the record the server returned.
    expect(mocks.getPersistentMindJournal).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /Show retired entries/ }));
    expect(screen.getByText(/retired .* by the user/)).toBeTruthy();
  });

  it('surfaces a load failure instead of rendering an empty journal', async () => {
    mocks.getPersistentMindJournal.mockRejectedValue(new Error('journal store is unreadable'));
    render(<PersistentMindJournalPanel />);
    expect(await screen.findByText('journal store is unreadable')).toBeTruthy();
    expect(screen.queryByText(/Nothing recorded yet/)).toBeTruthy();
  });
});
