import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import UniverseStyleReferences from './UniverseStyleReferences';

const apiMocks = vi.hoisted(() => ({
  analyzeUniverseStyleReference: vi.fn(),
}));
vi.mock('../../services/apiUniverseBuilder.js', () => ({
  ...apiMocks,
  WORLD_STYLE_REFERENCES_MAX: 20,
}));
vi.mock('../imageGen/GalleryImagePicker', () => ({
  default: ({ open, onSelect }) => open
    ? <button onClick={() => onSelect({ filename: 'reference.png', previewUrl: 'data:image/png;base64,x' })}>Select gallery image</button>
    : null,
}));
vi.mock('../universe/VisionProviderPicker', () => ({
  default: ({ onChange }) => (
    <button onClick={() => onChange({ providerId: 'ollama', model: 'qwen-vl' })}>Select vision model</button>
  ),
}));
vi.mock('../ui/Toast');

const universe = {
  id: 'u1',
  styleNotes: 'Clean vector art',
  influences: { embrace: ['clean vectors'], avoid: ['grain'] },
  locked: {},
  styleReferences: [],
};
const analysis = {
  reference: {
    id: 'style-ref-1',
    title: 'Dust-lit ink wash',
    prompt: 'Granular ink wash with muted ochre.',
    imageRefs: ['reference.png'],
  },
  proposed: {
    styleNotes: 'Tactile ink-wash science fiction.',
    influences: { embrace: ['ink wash'], avoid: ['gloss'] },
  },
  diff: {
    hasChanges: true,
    styleNotes: { before: 'Clean vector art', after: 'Tactile ink-wash science fiction.', changed: true },
    influences: {
      embrace: { changed: true, added: ['ink wash'], removed: ['clean vectors'] },
      avoid: { changed: true, added: ['gloss'], removed: ['grain'] },
    },
  },
  rationale: 'The reference favors tactile marks.',
};

describe('UniverseStyleReferences', () => {
  it('analyzes an uploaded/gallery image, previews the diff, and adopts on explicit confirmation', async () => {
    apiMocks.analyzeUniverseStyleReference.mockResolvedValue(analysis);
    const onPersist = vi.fn().mockResolvedValue(true);
    render(<UniverseStyleReferences universe={universe} saved onPersist={onPersist} onRemove={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: /Add art reference/i }));
    fireEvent.click(screen.getByRole('button', { name: /Upload or choose image/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Select gallery image' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select vision model' }));
    fireEvent.click(screen.getByRole('button', { name: /Analyze image/i }));

    expect(await screen.findByText('Style guide preview')).toBeInTheDocument();
    expect(screen.getByText('+ ink wash')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Adopt style \+ add/i }));

    await waitFor(() => expect(onPersist).toHaveBeenCalledWith(
      expect.objectContaining({
        adopt: true,
        reference: expect.objectContaining({ title: 'Dust-lit ink wash' }),
      }),
    ));
    await waitFor(() => expect(
      screen.queryByRole('heading', { name: 'Add art style reference' }),
    ).not.toBeInTheDocument());
  });

  it('can add the analyzed reference without adopting the proposed style', async () => {
    apiMocks.analyzeUniverseStyleReference.mockResolvedValue(analysis);
    const onPersist = vi.fn().mockResolvedValue(true);
    render(<UniverseStyleReferences universe={universe} saved onPersist={onPersist} onRemove={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Add art reference/i }));
    fireEvent.click(screen.getByRole('button', { name: /Upload or choose image/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Select gallery image' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select vision model' }));
    fireEvent.click(screen.getByRole('button', { name: /Analyze image/i }));
    await screen.findByText('Style guide preview');
    fireEvent.click(screen.getByRole('button', { name: /Add reference only/i }));
    await waitFor(() => expect(onPersist).toHaveBeenCalledWith(
      expect.objectContaining({ adopt: false }),
    ));
  });
});
