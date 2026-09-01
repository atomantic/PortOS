import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import Authors from './Authors';

// Selection is URL-driven (`/authors/:authorId`, `/authors/new`), so mount the
// page inside a router exposing those routes; navigation drives the editor.
const renderAuthors = () => render(
  <MemoryRouter initialEntries={['/authors']}>
    <Routes>
      <Route path="/authors" element={<Authors />} />
      <Route path="/authors/:authorId" element={<Authors />} />
    </Routes>
  </MemoryRouter>,
);

const listAuthors = vi.fn();
const generateImage = vi.fn();

vi.mock('../services/api', () => ({
  listAuthors: (...a) => listAuthors(...a),
  createAuthor: vi.fn(),
  updateAuthor: vi.fn(),
  deleteAuthor: vi.fn(),
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

// Gallery picker internals are exercised in GalleryImagePicker.test.jsx; stub it
// here but keep the last props so this suite can assert the page hands it the
// upload duty (issue #4127) and drive its `onSelect` the way a real pick/upload does.
let pickerProps = null;
vi.mock('../components/imageGen/GalleryImagePicker', () => ({
  default: (props) => { pickerProps = props; return null; },
}));

// Drive the headshot-progress hook from a mutable module-level value so a test
// can transition an in-flight async render to 'completed' between renders. The
// real hook subscribes to sockets; here the test owns the returned snapshot.
const idleProgress = () => ({
  status: 'unknown', currentImage: null, step: 0, totalSteps: null, filename: null, path: null, error: null,
});
let hookState = idleProgress();
vi.mock('../hooks/useMediaJobProgress', () => ({ default: () => hookState }));

describe('Authors headshot generation', () => {
  beforeEach(() => {
    listAuthors.mockReset().mockResolvedValue([]);
    generateImage.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
    hookState = idleProgress();
    pickerProps = null;
  });

  const openCreateForm = async () => {
    renderAuthors();
    await screen.findByText(/No authors yet/i);
    // The empty master-detail view now exposes contextual create actions in
    // addition to the page-level action; all of them intentionally open /new.
    fireEvent.click(screen.getAllByRole('button', { name: /New Author/i })[0]);
  };

  // Re-render the component without changing generation state, so a freshly
  // mutated `hookState` is observed (mirrors a socket-driven hook update).
  const nudgeRerender = () => fireEvent.change(
    screen.getByPlaceholderText('Jane Doe'), { target: { value: `n${Math.random()}` } },
  );

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
    // The caller owns the error toast, so the API call must be silent.
    expect(generateImage.mock.calls[0][1]).toMatchObject({ silent: true });

    const img = await screen.findByAltText('Author headshot');
    expect(img.getAttribute('src')).toBe('/data/images/headshot.png');
  });

  it('tracks an async (jobId) render and lands the completed image', async () => {
    generateImage.mockResolvedValue({ jobId: 'job-1', filename: 'job-1.png', path: '/data/images/job-1.png' });
    await openCreateForm();
    fireEvent.change(screen.getByPlaceholderText(/silver-streaked dark hair/i), {
      target: { value: 'Woman in her 40s' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Generate/i }));
    await waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1));
    // Still rendering — the async job hasn't completed, so no headshot yet.
    expect(screen.queryByAltText('Author headshot')).toBeNull();

    // Job completes; the hook reports the final filename/path.
    hookState = { ...idleProgress(), status: 'completed', filename: 'final.png', path: '/data/images/final.png' };
    nudgeRerender();

    const img = await screen.findByAltText('Author headshot');
    expect(img.getAttribute('src')).toBe('/data/images/final.png');
  });

  it('disables the competing headshot controls while a render is in flight', async () => {
    generateImage.mockResolvedValue({ jobId: 'job-3', filename: 'job-3.png', path: '/data/images/job-3.png' });
    await openCreateForm();
    fireEvent.change(screen.getByPlaceholderText(/silver-streaked dark hair/i), {
      target: { value: 'Woman in her 40s' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Generate/i }));
    await waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1));

    // The async job is in flight — a manual headshot change would be clobbered
    // on completion, so the picker (which owns both pick and upload) and the URL
    // field are locked until it settles.
    expect(screen.getByRole('button', { name: 'Choose or upload' }).disabled).toBe(true);
    expect(screen.getByPlaceholderText(/https:/i).disabled).toBe(true);
  });

  it('delegates headshot uploads to the gallery picker instead of a second file input', async () => {
    await openCreateForm();

    // The bespoke upload handler is gone — no file input lives beside the picker.
    expect(document.querySelector('input[type="file"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Choose or upload' }));

    expect(pickerProps.open).toBe(true);
    expect(pickerProps.allowUpload).toBe(true);
    // The page's own product cap still applies, rather than the wider wire limit.
    expect(pickerProps.maxBytes).toBe(12 * 1024 * 1024);

    // An uploaded image comes back through the same onSelect as a gallery pick.
    act(() => pickerProps.onSelect({ filename: 'up.png', previewUrl: '/data/images/up.png' }));
    expect(screen.getByPlaceholderText(/https:/i).value).toBe('/data/images/up.png');
  });

  it('does not overwrite a different author when one is selected mid-render', async () => {
    generateImage.mockResolvedValue({ jobId: 'job-2', filename: 'job-2.png', path: '/data/images/job-2.png' });
    listAuthors.mockResolvedValue([
      { id: 'a1', name: 'Alice', headshotImageUrl: '' },
      { id: 'a2', name: 'Bob', headshotImageUrl: '' },
    ]);
    renderAuthors();

    fireEvent.click(await screen.findByRole('button', { name: 'Alice' }));
    fireEvent.change(screen.getByPlaceholderText(/silver-streaked dark hair/i), {
      target: { value: 'Alice description' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Generate/i }));
    await waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1));

    // Switch to Bob before the render finishes — this cancels the tracking.
    fireEvent.click(screen.getByRole('button', { name: 'Bob' }));

    // Alice's job now reports completion, but it must not write Bob's headshot.
    hookState = { ...idleProgress(), status: 'completed', filename: 'alice.png', path: '/data/images/alice.png' };
    nudgeRerender();

    await waitFor(() => expect(toastSuccess).not.toHaveBeenCalledWith('Headshot generated'));
    expect(screen.queryByAltText('Author headshot')).toBeNull();
  });

  it('drops a generate response that resolves after switching authors', async () => {
    // The POST is still in flight when the user switches authors — the stale
    // continuation must not write into the newly selected persona.
    let resolveGen;
    generateImage.mockReturnValue(new Promise((r) => { resolveGen = r; }));
    listAuthors.mockResolvedValue([
      { id: 'a1', name: 'Alice', headshotImageUrl: '' },
      { id: 'a2', name: 'Bob', headshotImageUrl: '' },
    ]);
    renderAuthors();

    fireEvent.click(await screen.findByRole('button', { name: 'Alice' }));
    fireEvent.change(screen.getByPlaceholderText(/silver-streaked dark hair/i), {
      target: { value: 'Alice description' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Generate/i }));
    await waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1));

    // Switch to Bob BEFORE the POST resolves, then let it resolve.
    fireEvent.click(screen.getByRole('button', { name: 'Bob' }));
    await act(async () => { resolveGen({ path: '/data/images/alice.png' }); });

    expect(screen.queryByAltText('Author headshot')).toBeNull();
    expect(toastSuccess).not.toHaveBeenCalledWith('Headshot generated');
  });

  it('toasts exactly once when generation fails', async () => {
    generateImage.mockRejectedValue(new Error('backend down'));
    await openCreateForm();
    fireEvent.change(screen.getByPlaceholderText(/silver-streaked dark hair/i), {
      target: { value: 'Woman in her 40s' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Generate/i }));
    // `silent: true` keeps the apiCore helper from adding a second toast — only
    // this component's catch fires.
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('backend down'));
    expect(toastError).toHaveBeenCalledTimes(1);
  });
});
