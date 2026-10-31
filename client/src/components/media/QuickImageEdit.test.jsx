import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const copyToClipboard = vi.hoisted(() => vi.fn());
vi.mock('../../lib/clipboard', () => ({ copyToClipboard }));
const generateImage = vi.fn();
const previewImagePrompt = vi.fn();
vi.mock('../../services/api', () => ({ generateImage: (...a) => generateImage(...a), previewImagePrompt: (...a) => previewImagePrompt(...a) }));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../imageGen/GalleryImagePicker', () => ({
  default: ({ open, onSelect }) => (open ? <button type="button" onClick={() => onSelect({ filename: 'gallery.png' })}>Pick gallery.png</button> : null),
}));

import QuickImageEdit from './QuickImageEdit';

describe('QuickImageEdit', () => {
  beforeEach(() => {
    generateImage.mockReset();
    previewImagePrompt.mockReset().mockResolvedValue({ reviewedPromptDigest: 'b'.repeat(64), sentPrompt: 'Edit the reference image: make the jacket red. Keep everything else.', promptAdditions: [{ id: 'preserve', label: 'Preserve the rest', text: 'Keep everything else.' }], reviewedReferenceDigest: 'a'.repeat(64), reviewedReferenceImage: 'data:image/png;base64,eA==' });
  });

  it('shows server additions and the exact full prompt while sending authored text on the default render', async () => {
    generateImage.mockResolvedValue({ position: 2 });
    const onDone = vi.fn();
    render(<QuickImageEdit item={{ filename: 'a.png', width: 1024, height: 768 }} onDone={onDone} />);
    fireEvent.change(screen.getByLabelText('What should change?'), { target: { value: 'make the jacket red' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /edit/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '+ Preserve the rest' }));
    expect(screen.getByText('Keep everything else.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show full prompt' }));
    expect(screen.getByText('Edit the reference image: make the jacket red. Keep everything else.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy full prompt' }));
    expect(copyToClipboard).toHaveBeenCalledWith('Edit the reference image: make the jacket red. Keep everything else.', 'Full prompt copied');
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(screen.getByRole('img', { name: 'Reference for this edit' })).toHaveAttribute('src', 'data:image/png;base64,eA==');
    const body = generateImage.mock.calls[0][0];
    expect(body).toEqual({
      prompt: 'make the jacket red',
      quickEdit: true,
      reviewedPromptDigest: 'b'.repeat(64),
      referenceImageFiles: ['a.png'],
      reviewedReferenceDigest: 'a'.repeat(64),
      width: 1024,
      height: 768,
    });
    expect(body.modelId).toBeUndefined();
  });

  it('sends picked page and gallery images as further references after the edited image', async () => {
    generateImage.mockResolvedValue({ position: 1 });
    const choices = [{ kind: 'image', filename: 'a.png' }, { kind: 'image', filename: 'rink.png' }, { kind: 'video', filename: 'clip.mp4' }];
    render(<QuickImageEdit item={{ filename: 'a.png' }} referenceChoices={choices} />);
    fireEvent.change(screen.getByLabelText('What should change?'), { target: { value: 'put her in the rink from image 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add reference' }));
    expect(screen.getAllByRole('button', { name: /^Page image/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Page image 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pick from gallery' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pick gallery.png' }));
    expect(screen.getByRole('img', { name: 'Reference image 3' })).toHaveAttribute('src', '/data/images/gallery.png');
    await waitFor(() => expect(previewImagePrompt).toHaveBeenLastCalledWith(expect.objectContaining({ referenceImageFiles: ['a.png', 'rink.png', 'gallery.png'] }), expect.anything()));
    fireEvent.click(screen.getByRole('button', { name: 'Remove reference image 3' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^edit$/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    await waitFor(() => expect(generateImage).toHaveBeenCalled());
    expect(generateImage.mock.calls[0][0].referenceImageFiles).toEqual(['a.png', 'rink.png']);
  });

  it('preserves the instruction whitespace in the sent prompt', async () => {
    generateImage.mockResolvedValue({ position: 1 });
    render(<QuickImageEdit item={{ filename: 'a.png' }} />);
    fireEvent.change(screen.getByLabelText('What should change?'), { target: { value: '  red coat  ' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /edit/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    await waitFor(() => expect(generateImage).toHaveBeenCalledWith(expect.objectContaining({
      prompt: '  red coat  ',
      quickEdit: true,
    }), { silent: true }));
  });

  it('drops a stale preview when the instruction changes and displays limit refusal without mutating it', async () => {
    render(<QuickImageEdit item={{ filename: 'a.png' }} />);
    const input = screen.getByLabelText('What should change?');
    fireEvent.change(input, { target: { value: 'red' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /^edit$/i })).toBeEnabled());
    previewImagePrompt.mockRejectedValue(new Error('Complete edit prompt is 32001/32000 characters.'));
    const authored = '  long instruction  ';
    fireEvent.change(input, { target: { value: authored } });
    expect(screen.getByRole('button', { name: /^edit$/i })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('32001/32000 characters'));
    expect(input).toHaveValue(authored);
    expect(generateImage).not.toHaveBeenCalled();
  });

  it('stays open and does not finish when the render is refused', async () => {
    generateImage.mockImplementation(() => Promise.reject(new Error('nope')));
    const onDone = vi.fn();
    render(<QuickImageEdit item={{ filename: 'a.png' }} onDone={onDone} />);
    fireEvent.change(screen.getByLabelText('What should change?'), { target: { value: 'x' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /edit/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    await waitFor(() => expect(generateImage).toHaveBeenCalled());
    expect(onDone).not.toHaveBeenCalled();
  });

  it('forwards generateParams and calls onDone with result and edit metadata', async () => {
    const result = { jobId: 'job-edit-1', status: 'queued', position: 1 };
    generateImage.mockResolvedValue(result);
    const onDone = vi.fn();
    const item = { filename: 'a.png' };
    render(
      <QuickImageEdit
        item={item}
        onDone={onDone}
        generateParams={{ catalogIngredientId: 'cat-chr-1', catalogMediaKind: 'reference' }}
      />
    );
    fireEvent.change(screen.getByLabelText('What should change?'), { target: { value: 'make the jacket red' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /edit/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(result, { instruction: 'make the jacket red', item }));
    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        catalogIngredientId: 'cat-chr-1',
        catalogMediaKind: 'reference',
        referenceImageFiles: ['a.png'],
      }),
      { silent: true }
    );
  });
});
