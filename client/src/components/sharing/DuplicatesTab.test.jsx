import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../services/api', () => ({
  listUniverseDuplicates: vi.fn(),
  listSeriesDuplicates: vi.fn(),
  previewUniverseMerge: vi.fn(),
  mergeUniverses: vi.fn(),
  previewSeriesMerge: vi.fn(),
  mergeSeries: vi.fn(),
  aiResolveUniverseMerge: vi.fn(),
  aiResolveSeriesMerge: vi.fn(),
  updateUniverse: vi.fn(),
  updatePipelineSeries: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('../ui/Modal', () => ({ default: ({ open, children }) => (open ? <div role="dialog">{children}</div> : null) }));
vi.mock('../ui/InlineDiff', () => ({ default: ({ oldText, newText }) => <div data-testid="diff">{oldText}|{newText}</div> }));

import * as api from '../../services/api';
import DuplicatesTab from './DuplicatesTab';

const uniGroup = {
  normalizedName: 'clandestiny',
  records: [
    { id: 'u-new', name: 'Clandestiny', updatedAt: '2026-05-22T00:00:00Z', counts: { characters: 5, places: 2, objects: 1, categories: 4 }, linkedSeriesCount: 1, linkedCollectionItemCount: 3 },
    { id: 'u-old', name: 'Clandestiny', updatedAt: '2026-05-11T00:00:00Z', counts: { characters: 1, places: 0, objects: 0, categories: 4 }, linkedSeriesCount: 0, linkedCollectionItemCount: 0 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  api.listUniverseDuplicates.mockResolvedValue({ groups: [uniGroup] });
  api.listSeriesDuplicates.mockResolvedValue({ series: [], orphans: [], orphanCount: 0 });
});

describe('DuplicatesTab', () => {
  it('lists a universe duplicate group with both records', async () => {
    render(<DuplicatesTab />);
    await waitFor(() => expect(screen.getByText(/2 copies/)).toBeInTheDocument());
    expect(screen.getAllByText('Clandestiny').length).toBeGreaterThanOrEqual(2);
  });

  it('opens the merge modal, shows the conflict, and executes with field choices', async () => {
    api.previewUniverseMerge.mockResolvedValue({
      conflicts: [{ field: 'starterPrompt', survivorValue: 'A', loserValue: 'B' }],
      cascade: { seriesToRepoint: [{ id: 's1' }], loserCollectionItemCount: 3 },
    });
    api.mergeUniverses.mockResolvedValue({ merged: true });
    const user = userEvent.setup();
    render(<DuplicatesTab />);
    await waitFor(() => expect(screen.getByText(/2 copies/)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Merge…/ }));
    await waitFor(() => expect(api.previewUniverseMerge).toHaveBeenCalledWith({ survivorId: 'u-new', loserId: 'u-old' }, expect.anything()));
    // Conflict surfaced.
    await waitFor(() => expect(screen.getByText('starterPrompt')).toBeInTheDocument());
    expect(screen.getByText(/child series re-pointed/)).toBeInTheDocument();

    // Execute — default choice is survivor.
    await user.click(screen.getByRole('button', { name: /^Merge$/ }));
    await waitFor(() => expect(api.mergeUniverses).toHaveBeenCalledWith(
      { survivorId: 'u-new', loserId: 'u-old', fieldChoices: { starterPrompt: 'survivor' } },
      expect.anything(),
    ));
  });

  it('Merge with AI populates an editable override and ships it as fieldOverrides on submit', async () => {
    api.previewUniverseMerge.mockResolvedValue({
      conflicts: [{ field: 'starterPrompt', survivorValue: 'A', loserValue: 'B' }],
      cascade: { seriesToRepoint: [], loserCollectionItemCount: 0 },
    });
    api.aiResolveUniverseMerge.mockResolvedValue({
      merged: { starterPrompt: 'Unified A+B' }, skipped: [], llm: { provider: 'codex', model: null }, runId: 'r1',
    });
    api.mergeUniverses.mockResolvedValue({ merged: true });

    const user = userEvent.setup();
    render(<DuplicatesTab />);
    await waitFor(() => expect(screen.getByText(/2 copies/)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Merge…/ }));
    await waitFor(() => expect(screen.getByText('starterPrompt')).toBeInTheDocument());

    // Click Merge with AI — the AI-resolve API is called with the conflict field list.
    await user.click(screen.getByRole('button', { name: /Merge with AI/ }));
    await waitFor(() => expect(api.aiResolveUniverseMerge).toHaveBeenCalledWith(
      { survivorId: 'u-new', loserId: 'u-old', fields: ['starterPrompt'] },
      expect.anything(),
    ));

    // The AI-merged value is rendered in an editable textarea and the row
    // automatically switches to the "AI merged" choice.
    const ta = await screen.findByLabelText('AI-merged starterPrompt');
    expect(ta.value).toBe('Unified A+B');
    await user.clear(ta);
    await user.type(ta, 'Hand-tweaked unified');

    // Execute — survivor/loser choice is dropped (server's enum doesn't accept 'ai'),
    // override is sent as fieldOverrides.
    await user.click(screen.getByRole('button', { name: /^Merge$/ }));
    await waitFor(() => expect(api.mergeUniverses).toHaveBeenCalledWith(
      { survivorId: 'u-new', loserId: 'u-old', fieldChoices: {}, fieldOverrides: { starterPrompt: 'Hand-tweaked unified' } },
      expect.anything(),
    ));
  });

  it('renames a record inline via the update API', async () => {
    api.updateUniverse.mockResolvedValue({ id: 'u-old', name: 'Clandestiny (v2)' });
    const user = userEvent.setup();
    render(<DuplicatesTab />);
    await waitFor(() => expect(screen.getByText(/2 copies/)).toBeInTheDocument());

    const renameButtons = screen.getAllByTitle('Rename');
    await user.click(renameButtons[0]);
    const input = screen.getByDisplayValue('Clandestiny');
    await user.clear(input);
    await user.type(input, 'Clandestiny (v2)');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(api.updateUniverse).toHaveBeenCalledWith('u-new', { name: 'Clandestiny (v2)' }, expect.anything()));
  });
});
