import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Authors from './Authors';

const listAuthors = vi.fn();
const generateImage = vi.fn();

vi.mock('../services/api', () => ({
  listAuthors: (...a) => listAuthors(...a),
  createAuthor: vi.fn(),
  updateAuthor: vi.fn(),
  deleteAuthor: vi.fn(),
  uploadFile: vi.fn(),
  generateImage: (...a) => generateImage(...a),
  AUTHOR_NAME_MAX: 120,
  AUTHOR_WRITING_STYLE_MAX: 4000,
  AUTHOR_BIO_MAX: 4000,
  AUTHOR_PHYSICAL_DESCRIPTION_MAX: 2000,
  AUTHOR_HEADSHOT_STYLE_MAX: 2000,
  AUTHOR_HEADSHOT_IMAGE_URL_MAX: 1000,
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('../components/ui/Toast', () => ({
  default: { success: (...a) => toastSuccess(...a), error: (...a) => toastError(...a) },
}));

// Gallery picker and headshot progress hook are exercised elsewhere; stub them
// so this suite focuses on the generate flow.
vi.mock('../components/imageGen/GalleryImagePicker', () => ({ default: () => null }));
vi.mock('../hooks/useMediaJobProgress', () => ({
  default: () => ({ status: 'unknown', currentImage: null, step: 0, totalSteps: null, filename: null, path: null, error: null }),
}));

describe('Authors headshot generation', () => {
  beforeEach(() => {
    listAuthors.mockReset().mockResolvedValue([]);
    generateImage.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  const openCreateForm = async () => {
    render(<Authors />);
    await screen.findByText(/No authors yet/i);
    fireEvent.click(screen.getByRole('button', { name: /New Author/i }));
  };

  it('disables Generate until a description or style is provided', async () => {
    await openCreateForm();
    const genBtn = screen.getByRole('button', { name: /Generate/i });
    expect(genBtn.disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText(/silver-streaked dark hair/i), {
      target: { value: 'Woman in her 40s, warm gaze' },
    });
    expect(genBtn.disabled).toBe(false);
  });

  it('builds a prompt from description + style and lands a synchronous render', async () => {
    generateImage.mockResolvedValue({ path: '/data/images/headshot.png' });
    await openCreateForm();

    fireEvent.change(screen.getByPlaceholderText(/silver-streaked dark hair/i), {
      target: { value: 'Woman in her 40s, warm gaze' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Rembrandt lighting/i), {
      target: { value: 'Studio portrait, 85mm' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Generate/i }));

    await waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1));
    const payload = generateImage.mock.calls[0][0];
    expect(payload.prompt).toContain('Woman in her 40s, warm gaze');
    expect(payload.prompt).toContain('Studio portrait, 85mm');

    const img = await screen.findByAltText('Author headshot');
    expect(img.getAttribute('src')).toBe('/data/images/headshot.png');
  });

  it('toasts when generation fails', async () => {
    generateImage.mockRejectedValue(new Error('backend down'));
    await openCreateForm();
    fireEvent.change(screen.getByPlaceholderText(/silver-streaked dark hair/i), {
      target: { value: 'Woman in her 40s' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Generate/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('backend down'));
  });
});
