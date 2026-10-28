import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const generateImage = vi.fn();
const previewImagePrompt = vi.fn();
vi.mock('../../services/api', () => ({ generateImage: (...a) => generateImage(...a), previewImagePrompt: (...a) => previewImagePrompt(...a) }));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import QuickImageEdit, { quickEditPrompt } from './QuickImageEdit';

describe('QuickImageEdit', () => {
  beforeEach(() => {
    generateImage.mockReset();
    previewImagePrompt.mockReset().mockResolvedValue({ reviewedReferenceDigest: 'a'.repeat(64), reviewedReferenceImage: 'data:image/png;base64,eA==' });
  });

  it('sends the image as the reference with the wrapped instruction on the default render', async () => {
    generateImage.mockResolvedValue({ position: 2 });
    const onDone = vi.fn();
    render(<QuickImageEdit item={{ filename: 'a.png', width: 1024, height: 768 }} onDone={onDone} />);
    fireEvent.change(screen.getByLabelText('What should change?'), { target: { value: 'make the jacket red' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /edit/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(screen.getByRole('img', { name: 'Reference for this edit' })).toHaveAttribute('src', 'data:image/png;base64,eA==');
    const body = generateImage.mock.calls[0][0];
    expect(body).toEqual({
      prompt: quickEditPrompt('make the jacket red'),
      referenceImageFiles: ['a.png'],
      reviewedReferenceDigest: 'a'.repeat(64),
      width: 1024,
      height: 768,
    });
    expect(body.modelId).toBeUndefined();
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
