import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import LookReferencesPanel from './LookReferencesPanel.jsx';
import { getMoodBoard } from '../../services/apiMoodBoard.js';

vi.mock('../../services/apiMoodBoard.js', () => ({ getMoodBoard: vi.fn() }));
vi.mock('../../services/api', () => ({
  listMoodBoards: vi.fn(async () => []), getMoodBoard: vi.fn(), createMoodBoard: vi.fn(),
}));
vi.mock('../../services/apiUniverseBuilder.js', () => ({ getUniverse: vi.fn() }));
vi.mock('../../services/apiSystem.js', () => ({ uploadGalleryImage: vi.fn(async () => ({ filename: 'uploaded.png' })) }));
vi.mock('../../utils/fileUpload.js', () => ({ IMAGE_ACCEPT: 'image/png,image/jpeg,image/webp', readFileAsBase64: vi.fn(async () => 'encoded'), validateImageFile: vi.fn(() => null) }));
vi.mock('../ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

const mount = (project, props = {}) => render(
  <MemoryRouter>
    <LookReferencesPanel project={{ id: 'example', ...project }} onSave={vi.fn()} onSaveSpec={vi.fn()} onAddReference={vi.fn()} {...props} />
  </MemoryRouter>,
);

beforeEach(() => vi.clearAllMocks());

describe('look references', () => {
  it('lists spec references and project uploads in one list, with one condition toggle per spec reference', () => {
    const onSaveSpec = vi.fn();
    mount({
      visualSpec: { references: [{ id: 'r1', imageId: 'face.png', role: 'character', label: 'Singer', condition: false }] },
      styleReferences: [{ imageId: 'grain.png', caption: 'Fine grain' }],
    }, { onSaveSpec });
    expect(screen.getAllByRole('region', { name: 'Look references' })).toHaveLength(1);
    expect(screen.getByDisplayValue('Singer')).toBeTruthy();
    expect(screen.getByLabelText('Style caption 1').value).toBe('Fine grain');
    fireEvent.click(screen.getByLabelText('Condition frames'));
    expect(onSaveSpec).toHaveBeenCalledWith({ references: [{ id: 'r1', imageId: 'face.png', role: 'character', label: 'Singer', condition: true }] });
  });

  it('offers no condition toggle for a mood board import or a Pinterest pin', () => {
    mount({ visualSpec: { references: [
      { id: 'mvr-board-1', imageId: 'board.png', role: 'mood', condition: false },
      { id: 'r2', imageId: 'pinterest-0123456789abcdef.jpg', role: 'mood', condition: false },
    ] } });
    expect(screen.queryByLabelText('Condition frames')).toBeNull();
    expect(screen.getAllByText(/never sent to the generator/)).toHaveLength(2);
  });

  it('imports the linked mood board gallery images once, skipping text, remote pins and duplicates', async () => {
    getMoodBoard.mockResolvedValue({ id: 'b1', name: 'Example Board', items: [
      { id: 'i1', type: 'image', mediaKey: 'image:pin.png' },
      { id: 'i2', type: 'image', mediaKey: 'image:have.png' },
      { id: 'i3', type: 'image', imageUrl: 'https://example.com/remote.png' },
      { id: 'i4', type: 'text', text: 'Loose brush strokes' },
    ] });
    const onSaveSpec = vi.fn();
    mount({ visualSpec: { moodBoardId: 'b1', references: [{ id: 'r0', imageId: 'have.png', role: 'mood' }] } }, { onSaveSpec });
    fireEvent.click(screen.getByText('Import board images'));
    await waitFor(() => expect(onSaveSpec).toHaveBeenCalledTimes(1));
    const { references } = onSaveSpec.mock.calls[0][0];
    expect(references.map((r) => r.imageId)).toEqual(['have.png', 'pin.png']);
    expect(references[1]).toMatchObject({ role: 'mood', condition: false });
    expect(getMoodBoard).toHaveBeenCalledWith('b1', { silent: true });
  });

  it('uploads, captions and saves style images, holding generation pending through the save', async () => {
    let finish;
    const onSave = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const pending = vi.fn();
    mount({}, { onSave, onPendingChange: pending });
    fireEvent.change(screen.getByLabelText('Upload style images'), { target: { files: [new File(['image'], 'style.png', { type: 'image/png' })] } });
    await screen.findByAltText('Style upload 1');
    fireEvent.change(screen.getByLabelText('Style caption 1'), { target: { value: 'Fine silver grain' } });
    fireEvent.click(screen.getByText('Save style uploads'));
    expect(onSave).toHaveBeenCalledWith({ styleReferences: [{ imageId: 'uploaded.png', caption: 'Fine silver grain' }] });
    expect(pending).toHaveBeenLastCalledWith(true);
    await act(async () => finish());
    await waitFor(() => expect(pending).toHaveBeenLastCalledWith(false));
  });

  it('keeps a rejected upload save editable and preserves an unsaved caption across project refreshes', async () => {
    const onSave = vi.fn(async () => { throw new Error('Save failed'); });
    const project = { id: 'example', styleReferences: [{ imageId: 'style.png', caption: 'Warm grain' }] };
    const { rerender } = render(<MemoryRouter><LookReferencesPanel project={project} onSave={onSave} onSaveSpec={vi.fn()} /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Style caption 1'), { target: { value: 'My draft' } });
    rerender(<MemoryRouter><LookReferencesPanel project={{ ...project, styleReferences: [{ imageId: 'style.png', caption: 'Remote caption' }] }} onSave={onSave} onSaveSpec={vi.fn()} /></MemoryRouter>);
    expect(screen.getByLabelText('Style caption 1').value).toBe('My draft');
    fireEvent.click(screen.getByText('Save style uploads'));
    await waitFor(() => expect(screen.getByText('Save style uploads').disabled).toBe(false));
    expect(screen.getByText('Save the style uploads before starting generation.')).toBeTruthy();
  });
});
