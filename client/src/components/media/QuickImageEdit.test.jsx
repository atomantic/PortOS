import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const generateImage = vi.fn();
vi.mock('../../services/api', () => ({ generateImage: (...a) => generateImage(...a) }));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import QuickImageEdit, { quickEditPrompt } from './QuickImageEdit';

describe('QuickImageEdit', () => {
  beforeEach(() => { generateImage.mockReset(); });

  it('sends the image as the reference with the wrapped instruction on the default render', async () => {
    generateImage.mockResolvedValue({ position: 2 });
    const onDone = vi.fn();
    render(<QuickImageEdit item={{ filename: 'a.png', width: 1024, height: 768 }} onDone={onDone} />);
    fireEvent.change(screen.getByLabelText('What should change?'), { target: { value: 'make the jacket red' } });
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const body = generateImage.mock.calls[0][0];
    expect(body).toEqual({
      prompt: quickEditPrompt('make the jacket red'),
      referenceImageFiles: ['a.png'],
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
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    await waitFor(() => expect(generateImage).toHaveBeenCalled());
    expect(onDone).not.toHaveBeenCalled();
  });
});
