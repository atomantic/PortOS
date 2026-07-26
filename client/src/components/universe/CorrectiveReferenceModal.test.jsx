import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import CorrectiveReferenceModal from './CorrectiveReferenceModal';

const apiMocks = vi.hoisted(() => ({
  correctEntityFromImage: vi.fn(),
  applyCanonImageCorrection: vi.fn(),
}));
vi.mock('../../services/apiUniverseBuilder', () => apiMocks);
vi.mock('../imageGen/GalleryImagePicker', () => ({
  default: ({ open, onSelect }) => (open
    ? <button onClick={() => onSelect({ filename: 'reference.png', previewUrl: 'data:image/png;base64,x' })}>Select gallery image</button>
    : null),
}));
vi.mock('./VisionProviderPicker', () => ({
  default: ({ onChange }) => (
    <button onClick={() => onChange({ providerId: 'ollama', model: 'qwen-vl', hasProviders: true })}>Select vision model</button>
  ),
}));
vi.mock('../ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

const baseProps = {
  open: true, kind: 'character', entryName: 'Vex', universeId: 'uni-1', entryId: 'chr-1',
  onApplied: () => {}, onClose: () => {},
};

const pickImageAndModel = () => {
  fireEvent.click(screen.getByRole('button', { name: /Upload or choose image/i }));
  fireEvent.click(screen.getByRole('button', { name: 'Select gallery image' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select vision model' }));
};

describe('CorrectiveReferenceModal', () => {
  beforeEach(() => {
    apiMocks.correctEntityFromImage.mockReset();
    apiMocks.applyCanonImageCorrection.mockReset();
  });

  it('analyzes the picked image, shows the diff, and applies the reviewed correction + pins the image', async () => {
    apiMocks.correctEntityFromImage.mockResolvedValue({
      descField: 'physicalDescription',
      currentDescription: 'a short, stocky trader',
      proposedDescription: 'a tall scavenger in patched leathers',
      llm: { provider: 'ollama', model: 'qwen-vl' },
    });
    apiMocks.applyCanonImageCorrection.mockResolvedValue({
      universe: { id: 'uni-1' },
      entry: { id: 'chr-1', physicalDescription: 'a tall scavenger in patched leathers', primaryImageRef: 'reference.png' },
    });
    const onApplied = vi.fn();
    const onClose = vi.fn();
    render(<CorrectiveReferenceModal {...baseProps} onApplied={onApplied} onClose={onClose} />);

    pickImageAndModel();
    fireEvent.click(screen.getByRole('button', { name: /Analyze image/i }));

    expect(await screen.findByText('a short, stocky trader')).toBeInTheDocument();
    const proposed = screen.getByRole('textbox', { name: /Proposed correction/i });
    expect(proposed.value).toBe('a tall scavenger in patched leathers');

    fireEvent.click(screen.getByRole('button', { name: /Apply correction \+ set as reference/i }));

    await waitFor(() => expect(apiMocks.applyCanonImageCorrection).toHaveBeenCalledWith(
      'uni-1', 'character', 'chr-1',
      expect.objectContaining({ description: 'a tall scavenger in patched leathers', imageFilename: 'reference.png' }),
      expect.anything(),
    ));
    await waitFor(() => expect(onApplied).toHaveBeenCalledWith(
      expect.objectContaining({ entry: expect.objectContaining({ primaryImageRef: 'reference.png' }) }),
    ));
    expect(onClose).toHaveBeenCalled();
  });

  it('lets the user edit the proposed text before applying', async () => {
    apiMocks.correctEntityFromImage.mockResolvedValue({
      descField: 'description', currentDescription: '', proposedDescription: 'a rusted blade', llm: {},
    });
    apiMocks.applyCanonImageCorrection.mockResolvedValue({ universe: {}, entry: {} });
    render(<CorrectiveReferenceModal {...baseProps} kind="object" />);

    pickImageAndModel();
    fireEvent.click(screen.getByRole('button', { name: /Analyze image/i }));
    const proposed = await screen.findByRole('textbox', { name: /Proposed correction/i });
    fireEvent.change(proposed, { target: { value: 'a rusted ceremonial blade' } });

    fireEvent.click(screen.getByRole('button', { name: /Apply correction \+ set as reference/i }));
    await waitFor(() => expect(apiMocks.applyCanonImageCorrection).toHaveBeenCalledWith(
      'uni-1', 'object', 'chr-1',
      expect.objectContaining({ description: 'a rusted ceremonial blade' }),
      expect.anything(),
    ));
  });

  it('surfaces the locked state and never calls apply', async () => {
    apiMocks.correctEntityFromImage.mockResolvedValue({ locked: true, entryName: 'Vex' });
    render(<CorrectiveReferenceModal {...baseProps} />);

    pickImageAndModel();
    fireEvent.click(screen.getByRole('button', { name: /Analyze image/i }));

    await waitFor(() => expect(apiMocks.correctEntityFromImage).toHaveBeenCalled());
    expect(screen.queryByRole('textbox', { name: /Proposed correction/i })).not.toBeInTheDocument();
    expect(apiMocks.applyCanonImageCorrection).not.toHaveBeenCalled();
  });
});
