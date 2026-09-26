import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeckStyleSources from './DeckStyleSources';
import { getUniverse, listMoodBoardNames, synthesizeMoodBoardStyle } from '../../services/api';
import toast from '../ui/Toast';

vi.mock('../../services/api', () => ({ getUniverse: vi.fn(), listMoodBoardNames: vi.fn(), synthesizeMoodBoardStyle: vi.fn() }));
vi.mock('../../hooks/useProviderModels', () => ({ default: () => ({
  providers: [{ id: 'p1', name: 'Example provider', type: 'api', enabled: true }],
  selectedProviderId: 'p1', selectedModel: 'example-model', availableModels: ['example-model'],
  setSelectedProviderId: vi.fn(), setSelectedModel: vi.fn(), loading: false,
}) }));
vi.mock('../ui/Toast', () => ({ default: { error: vi.fn() } }));
const deck = { id: 'd1', universeId: 'u1', styleNotes: 'Old style', influences: { embrace: ['ink'], avoid: [] } };

describe('Deck style imports', () => {
  beforeEach(() => vi.clearAllMocks());

  it('re-imports fresh universe style in one patch, including intentionally empty values', async () => {
    getUniverse.mockResolvedValue({ styleNotes: '', influences: { embrace: [], avoid: ['gloss'] }, description: 'Do not import' });
    const onPatch = vi.fn().mockResolvedValue(true);
    render(<DeckStyleSources deck={deck} onPatch={onPatch} />);
    fireEvent.click(screen.getByRole('button', { name: 'Re-import universe style' }));
    await waitFor(() => expect(onPatch).toHaveBeenCalledWith({ styleNotes: '', influences: { embrace: [], avoid: ['gloss'] } }));
    expect(getUniverse).toHaveBeenCalledWith('u1', { silent: true });
  });

  it('leaves the deck untouched on failed or superseded universe loads', async () => {
    const onPatch = vi.fn();
    getUniverse.mockRejectedValueOnce(new Error('Unavailable'));
    const view = render(<DeckStyleSources deck={deck} onPatch={onPatch} />);
    fireEvent.click(screen.getByRole('button', { name: 'Re-import universe style' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Unavailable'));
    expect(onPatch).not.toHaveBeenCalled();
    let resolve;
    getUniverse.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    fireEvent.click(screen.getByRole('button', { name: 'Re-import universe style' }));
    view.unmount();
    resolve({ styleNotes: 'Stale style' });
    await waitFor(() => expect(onPatch).not.toHaveBeenCalled());
  });

  it('previews mood board synthesis and keeps adoption open when saving fails', async () => {
    listMoodBoardNames.mockResolvedValue([{ id: 'b1', name: 'Example board' }]);
    const proposed = { styleNotes: 'Watercolor', influences: { embrace: ['soft pigment'], avoid: ['gloss'] } };
    synthesizeMoodBoardStyle.mockResolvedValue({ proposed, diff: { hasChanges: true } });
    const onPatch = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<DeckStyleSources deck={{ ...deck, universeId: null }} onPatch={onPatch} />);
    expect(screen.getByRole('button', { name: 'Re-import universe style' })).toBeDisabled();
    expect(listMoodBoardNames).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply mood board style' }));
    await screen.findByRole('option', { name: 'Example board' });
    fireEvent.change(screen.getByLabelText('Mood board style source'), { target: { value: 'b1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Synthesize style' }));
    expect(synthesizeMoodBoardStyle).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Synthesize' }));
    await screen.findByText('Style guide preview');
    expect(synthesizeMoodBoardStyle).toHaveBeenCalledWith('b1', expect.objectContaining({ styleNotes: deck.styleNotes, influences: deck.influences }), { silent: true });
    expect(onPatch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Adopt style' }));
    await waitFor(() => expect(onPatch).toHaveBeenCalledWith(proposed));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Adopt style' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Adopt style' }));
    await waitFor(() => expect(screen.queryByText('Style guide preview')).not.toBeInTheDocument());
  });
});
