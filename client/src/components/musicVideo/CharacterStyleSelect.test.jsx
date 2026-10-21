import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../services/apiMusicVideo.js', () => ({
  listMusicVideoCharacterStyles: vi.fn(),
}));

import { listMusicVideoCharacterStyles } from '../../services/apiMusicVideo.js';
import CharacterStyleSelect from './CharacterStyleSelect.jsx';

const styles = [{ id: 'cs1', label: 'Noir Detective', characterName: 'Alice', referenceImageId: null }];

describe('CharacterStyleSelect', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists the fetched styles and describes the selected one', async () => {
    listMusicVideoCharacterStyles.mockResolvedValue(styles);
    render(<CharacterStyleSelect id="cs" value="cs1" onChange={vi.fn()} />);
    expect(await screen.findByRole('option', { name: 'Noir Detective' })).toBeTruthy();
    expect(screen.getByText(/Alice is cast as protagonist/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a load error with Retry instead of silently offering only "No character style"', async () => {
    listMusicVideoCharacterStyles.mockRejectedValueOnce(new Error('Styles unavailable'));
    render(<CharacterStyleSelect id="cs" value="" onChange={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load character styles — Styles unavailable');

    listMusicVideoCharacterStyles.mockResolvedValueOnce(styles);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('option', { name: 'Noir Detective' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
