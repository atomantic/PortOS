import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import StyleReferencesPanel from './StyleReferencesPanel.jsx';
import { getMoodBoard } from '../../services/apiMoodBoard.js';

vi.mock('../../services/apiMoodBoard.js', () => ({ getMoodBoard: vi.fn() }));

vi.mock('../../services/apiSystem.js', () => ({ uploadGalleryImage: vi.fn(async () => ({ filename: 'uploaded.png' })) }));
vi.mock('../../utils/fileUpload.js', () => ({ IMAGE_ACCEPT: 'image/png,image/jpeg,image/webp', readFileAsBase64: vi.fn(async () => 'encoded'), validateImageFile: vi.fn(() => null) }));
vi.mock('../ui/Toast', () => ({ default: { error: vi.fn() } }));

describe('project moodboard', () => {
  it('shows the mood board the project links to (an autonomous run’s board), not just an empty uploader', async () => {
    getMoodBoard.mockResolvedValue({ id: 'board-1', name: 'Example Board', items: [{ id: 'i1', type: 'image', imageUrl: '/data/images/pin.png' }] });
    render(<MemoryRouter><StyleReferencesPanel project={{ id: 'example', visualSpec: { moodBoardId: 'board-1' } }} onSave={vi.fn()} /></MemoryRouter>);
    const link = await screen.findByRole('link', { name: /example board/i });
    expect(link.getAttribute('href')).toBe('/mood-boards/board-1');
    expect(await screen.findByAltText('Mood board image 1')).toBeTruthy();
    expect(getMoodBoard).toHaveBeenCalledWith('board-1', { silent: true });
  });

  it('renders no linked-board block without a link, and still links when the board fails to load', async () => {
    const { unmount } = render(<MemoryRouter><StyleReferencesPanel project={{ id: 'example' }} onSave={vi.fn()} /></MemoryRouter>);
    expect(screen.queryByTestId('linked-mood-board')).toBeNull();
    unmount();
    getMoodBoard.mockRejectedValue(new Error('gone'));
    render(<MemoryRouter><StyleReferencesPanel project={{ id: 'example', visualSpec: { moodBoardId: 'board-2' } }} onSave={vi.fn()} /></MemoryRouter>);
    expect(await screen.findByRole('link', { name: /open mood board/i })).toBeTruthy();
  });

  it('uploads, captions and saves references, holding generation pending through the save', async () => {
    let finish;
    const onSave = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const pending = vi.fn();
    render(<StyleReferencesPanel project={{ id: 'example' }} onSave={onSave} onPendingChange={pending} />);
    fireEvent.change(screen.getByLabelText('Upload style images'), { target: { files: [new File(['image'], 'style.png', { type: 'image/png' })] } });
    await screen.findByAltText('Style reference 1');
    fireEvent.change(screen.getByLabelText('Style caption 1'), { target: { value: 'Fine silver grain' } });
    fireEvent.click(screen.getByText('Save moodboard'));
    expect(onSave).toHaveBeenCalledWith({ styleReferences: [{ imageId: 'uploaded.png', caption: 'Fine silver grain' }] });
    expect(pending).toHaveBeenLastCalledWith(true);
    await act(async () => finish());
    await waitFor(() => expect(pending).toHaveBeenLastCalledWith(false));
  });

  it('refreshes clean references from project updates while preserving an unsaved caption', () => {
    const { rerender } = render(<StyleReferencesPanel project={{ id: 'example', styleReferences: [] }} onSave={vi.fn()} />);
    const updated = { id: 'example', styleReferences: [{ imageId: 'style.png', caption: 'Warm grain' }] };
    rerender(<StyleReferencesPanel project={updated} onSave={vi.fn()} />);
    expect(screen.getByLabelText('Style caption 1').value).toBe('Warm grain');
    fireEvent.change(screen.getByLabelText('Style caption 1'), { target: { value: 'My draft' } });
    rerender(<StyleReferencesPanel project={{ ...updated, styleReferences: [{ imageId: 'style.png', caption: 'Remote caption' }] }} onSave={vi.fn()} />);
    expect(screen.getByLabelText('Style caption 1').value).toBe('My draft');
  });

  it('keeps a rejected save editable and permits removing a saved reference', async () => {
    const onSave = vi.fn(async () => { throw new Error('Save failed'); });
    render(<StyleReferencesPanel project={{ id: 'example', styleReferences: [{ imageId: 'style.png', caption: 'Warm grain' }] }} onSave={onSave} />);
    fireEvent.click(screen.getByLabelText('Remove style reference 1'));
    fireEvent.click(screen.getByText('Save moodboard'));
    await waitFor(() => expect(screen.getByText('Save moodboard').disabled).toBe(false));
    expect(onSave).toHaveBeenCalledWith({ styleReferences: [] });
    expect(screen.getByText('Save the moodboard before starting generation.')).toBeTruthy();
  });
});
