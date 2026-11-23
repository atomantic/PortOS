import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { retypeSettled } from '../../test/settledInput';

vi.mock('../../services/apiSyncReview.js', () => ({
  listUniverseDuplicates: vi.fn(),
  listSeriesDuplicates: vi.fn(),
  previewUniverseMerge: vi.fn(),
  mergeUniverses: vi.fn(),
  previewSeriesMerge: vi.fn(),
  mergeSeries: vi.fn(),
  aiResolveUniverseMerge: vi.fn(),
  aiResolveSeriesMerge: vi.fn(),
}));
vi.mock('../../services/apiUniverseBuilder.js', () => ({
  updateUniverse: vi.fn(),
}));
vi.mock('../../services/apiPipeline.js', () => ({
  updatePipelineSeries: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('../ui/Modal', () => ({ default: ({ open, children }) => (open ? <div role="dialog">{children}</div> : null) }));
vi.mock('../ui/InlineDiff', () => ({ default: ({ oldText, newText }) => <div data-testid="diff">{oldText}|{newText}</div> }));

import {
  listUniverseDuplicates,
  listSeriesDuplicates,
  previewUniverseMerge,
  mergeUniverses,
  aiResolveUniverseMerge,
} from '../../services/apiSyncReview.js';
import { updateUniverse } from '../../services/apiUniverseBuilder.js';
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
  listUniverseDuplicates.mockResolvedValue({ groups: [uniGroup] });
  listSeriesDuplicates.mockResolvedValue({ series: [], orphans: [], orphanCount: 0 });
});

describe('DuplicatesTab', () => {
  it('shows a section-specific retry when universe duplicate loading fails', async () => {
    listUniverseDuplicates.mockRejectedValueOnce(new Error('unavailable'));
    listSeriesDuplicates.mockResolvedValue({ series: [], orphanCount: 0 });
    const user = userEvent.setup();
    render(<DuplicatesTab />);
    expect(await screen.findByText('Could not load universe duplicates.')).toBeInTheDocument();
    expect(screen.queryByText(/No duplicates found/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/2 copies/)).toBeInTheDocument();
  });

  it('shows a section-specific retry when series duplicate loading fails', async () => {
    listUniverseDuplicates.mockResolvedValue({ groups: [] });
    listSeriesDuplicates.mockRejectedValueOnce(new Error('unavailable'));
    render(<DuplicatesTab />);
    expect(await screen.findByText('Could not load series duplicates.')).toBeInTheDocument();
    expect(screen.queryByText(/No duplicates found/)).not.toBeInTheDocument();
  });

  it('shows the existing empty copy after both requests succeed empty', async () => {
    listUniverseDuplicates.mockResolvedValue({ groups: [] });
    listSeriesDuplicates.mockResolvedValue({ series: [], orphanCount: 0 });
    render(<DuplicatesTab />);
    expect(await screen.findByText(/No duplicates found/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([
    ['universe', () => listUniverseDuplicates.mockResolvedValue({}), () => listSeriesDuplicates.mockResolvedValue({ series: [], orphanCount: 0 })],
    ['series', () => listUniverseDuplicates.mockResolvedValue({ groups: [] }), () => listSeriesDuplicates.mockResolvedValue({})],
  ])('treats a malformed successful %s payload as a section failure', async (_section, setUniverse, setSeries) => {
    setUniverse();
    setSeries();
    render(<DuplicatesTab />);
    expect(await screen.findByRole('alert')).toHaveTextContent(`Could not load ${_section} duplicates.`);
    expect(screen.queryByText(/No duplicates found/)).not.toBeInTheDocument();
  });

  it('lists a universe duplicate group with both records', async () => {
    render(<DuplicatesTab />);
    await waitFor(() => expect(screen.getByText(/2 copies/)).toBeInTheDocument());
    expect(screen.getAllByText('Clandestiny').length).toBeGreaterThanOrEqual(2);
  });

  it('opens the merge modal, shows the conflict, and executes with field choices', async () => {
    previewUniverseMerge.mockResolvedValue({
      conflicts: [{ field: 'starterPrompt', survivorValue: 'A', loserValue: 'B' }],
      cascade: { seriesToRepoint: [{ id: 's1' }], loserCollectionItemCount: 3 },
    });
    mergeUniverses.mockResolvedValue({ merged: true });
    const user = userEvent.setup();
    render(<DuplicatesTab />);
    await waitFor(() => expect(screen.getByText(/2 copies/)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Merge…/ }));
    await waitFor(() => expect(previewUniverseMerge).toHaveBeenCalledWith({ survivorId: 'u-new', loserId: 'u-old' }, expect.anything()));
    // Conflict surfaced.
    await waitFor(() => expect(screen.getByText('starterPrompt')).toBeInTheDocument());
    expect(screen.getByText(/child series re-pointed/)).toBeInTheDocument();

    // Execute — default choice is survivor.
    await user.click(screen.getByRole('button', { name: /^Merge$/ }));
    await waitFor(() => expect(mergeUniverses).toHaveBeenCalledWith(
      { survivorId: 'u-new', loserId: 'u-old', fieldChoices: { starterPrompt: 'survivor' } },
      expect.anything(),
    ));
  });

  it('exposes fieldset legends, a per-field resolution group, and aria-pressed choice state', async () => {
    previewUniverseMerge.mockResolvedValue({
      conflicts: [{ field: 'starterPrompt', survivorValue: 'A', loserValue: 'B' }],
      cascade: { seriesToRepoint: [], loserCollectionItemCount: 0 },
    });
    aiResolveUniverseMerge.mockResolvedValue({
      merged: { starterPrompt: 'Unified A+B' }, skipped: [], llm: { provider: 'codex', model: null }, runId: 'r1',
    });
    const user = userEvent.setup();
    render(<DuplicatesTab />);
    await waitFor(() => expect(screen.getByText(/2 copies/)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Merge…/ }));

    expect(await screen.findByRole('group', { name: 'Keep (survivor)' })).toBeInTheDocument();
    const group = await screen.findByRole('group', { name: 'Resolution for starterPrompt' });
    const survivorBtn = within(group).getByRole('button', { name: 'Keep survivor' });
    const foldedBtn = within(group).getByRole('button', { name: 'Use folded' });
    expect(survivorBtn).toHaveAttribute('aria-pressed', 'true');
    expect(foldedBtn).toHaveAttribute('aria-pressed', 'false');

    await user.click(foldedBtn);
    expect(foldedBtn).toHaveAttribute('aria-pressed', 'true');
    expect(survivorBtn).toHaveAttribute('aria-pressed', 'false');

    await user.click(screen.getByRole('button', { name: /Merge with AI/ }));
    const aiBtn = await within(group).findByRole('button', { name: 'AI merged' });
    expect(aiBtn).toHaveAttribute('aria-pressed', 'true');
    expect(foldedBtn).toHaveAttribute('aria-pressed', 'false');
  });

  it('Merge with AI populates an editable override and ships it as fieldOverrides on submit', async () => {
    previewUniverseMerge.mockResolvedValue({
      conflicts: [{ field: 'starterPrompt', survivorValue: 'A', loserValue: 'B' }],
      cascade: { seriesToRepoint: [], loserCollectionItemCount: 0 },
    });
    aiResolveUniverseMerge.mockResolvedValue({
      merged: { starterPrompt: 'Unified A+B' }, skipped: [], llm: { provider: 'codex', model: null }, runId: 'r1',
    });
    mergeUniverses.mockResolvedValue({ merged: true });

    const user = userEvent.setup();
    render(<DuplicatesTab />);
    await waitFor(() => expect(screen.getByText(/2 copies/)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Merge…/ }));
    await waitFor(() => expect(screen.getByText('starterPrompt')).toBeInTheDocument());

    // Click Merge with AI — the AI-resolve API is called with the conflict field list.
    await user.click(screen.getByRole('button', { name: /Merge with AI/ }));
    await waitFor(() => expect(aiResolveUniverseMerge).toHaveBeenCalledWith(
      { survivorId: 'u-new', loserId: 'u-old', fields: ['starterPrompt'] },
      expect.anything(),
    ));

    // The AI-merged value is rendered in an editable textarea and the row
    // automatically switches to the "AI merged" choice.
    const ta = await screen.findByLabelText('AI-merged starterPrompt');
    expect(ta.value).toBe('Unified A+B');
    await retypeSettled(user, ta, 'Hand-tweaked unified');

    // Execute — survivor/loser choice is dropped (server's enum doesn't accept 'ai'),
    // override is sent as fieldOverrides.
    await user.click(screen.getByRole('button', { name: /^Merge$/ }));
    await waitFor(() => expect(mergeUniverses).toHaveBeenCalledWith(
      { survivorId: 'u-new', loserId: 'u-old', fieldChoices: {}, fieldOverrides: { starterPrompt: 'Hand-tweaked unified' } },
      expect.anything(),
    ));
  });

  it('renames a record inline via the update API', async () => {
    updateUniverse.mockResolvedValue({ id: 'u-old', name: 'Clandestiny (v2)' });
    const user = userEvent.setup();
    render(<DuplicatesTab />);
    await waitFor(() => expect(screen.getByText(/2 copies/)).toBeInTheDocument());

    const renameButtons = screen.getAllByTitle('Rename');
    await user.click(renameButtons[0]);
    const input = screen.getByDisplayValue('Clandestiny');
    await retypeSettled(user, input, 'Clandestiny (v2)');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(updateUniverse).toHaveBeenCalledWith('u-new', { name: 'Clandestiny (v2)' }, expect.anything()));
  });
});
