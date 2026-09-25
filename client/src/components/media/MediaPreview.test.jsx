import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMemo, useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import MediaPreview from './MediaPreview';
import usePreviewRoute from '../../hooks/usePreviewRoute';
import { updateVideoPrompt, listImageVariants, listMediaGalleryPage } from '../../services/apiImageVideo';

vi.mock('../../services/apiImageVideo', () => ({
  updateImagePrompt: vi.fn(),
  updateVideoPrompt: vi.fn(),
  listImageVariants: vi.fn(),
  listMediaGalleryPage: vi.fn(),
}));

// Keep this test focused on the wrapper's save/state contract. The lightbox has
// its own interaction coverage; this stub exposes the item it receives and
// invokes the same callback the real Save prompt button uses.
vi.mock('./MediaLightbox', () => ({
  default: ({ item, onPromptChange, variantGroup, onSelectVariant }) => item ? (
    <div data-testid="lightbox">
      <span data-testid="lightbox-prompt">{item.prompt}</span>
      <span data-testid="lightbox-filename">{item.filename}</span>
      <button type="button" onClick={() => onPromptChange(item, 'a saved prompt')}>
        Save prompt
      </button>
      {variantGroup && (
        <ul data-testid="variant-group">
          {variantGroup.group.map((entry) => (
            <li key={entry.item.filename}>
              <button type="button" onClick={() => onSelectVariant(entry.item)}>{entry.label}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  ) : null,
}));

const VIDEO = {
  kind: 'video',
  key: 'video:video-1',
  id: 'video-1',
  filename: 'video-1.mp4',
  prompt: '(no prompt)',
  raw: { id: 'video-1', filename: 'video-1.mp4' },
};

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.search}</output>;
}

function PromptSaveHarness({ syncCard = true }) {
  const [items, setItems] = useState([VIDEO]);
  const [preview, setPreview] = usePreviewRoute(items);
  const handlePromptSaved = (item, prompt) => {
    setItems((current) => current.map((candidate) => candidate.key === item.key
      ? { ...candidate, prompt }
      : candidate));
  };
  return (
    <>
      <button type="button" onClick={() => setPreview(items[0])}>Open video</button>
      <p data-testid="card-prompt">{items[0].prompt}</p>
      <MediaPreview
        preview={preview}
        setPreview={setPreview}
        items={items}
        onPromptSaved={syncCard ? handlePromptSaved : undefined}
      />
      <LocationProbe />
    </>
  );
}

describe('MediaPreview prompt saving', () => {
  beforeEach(() => {
    updateVideoPrompt.mockReset();
    updateVideoPrompt.mockResolvedValue({ id: VIDEO.id, prompt: 'a saved prompt' });
  });

  it('updates the card and modal immediately without treating the URL setter as React state', async () => {
    render(
      <MemoryRouter>
        <PromptSaveHarness />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open video' }));
    expect(screen.getByTestId('lightbox-prompt')).toHaveTextContent('(no prompt)');

    fireEvent.click(screen.getByRole('button', { name: 'Save prompt' }));

    await waitFor(() => {
      expect(updateVideoPrompt).toHaveBeenCalledWith('video-1', 'a saved prompt', { silent: true });
      expect(screen.getByTestId('card-prompt')).toHaveTextContent('a saved prompt');
      expect(screen.getByTestId('lightbox-prompt')).toHaveTextContent('a saved prompt');
    });
    expect(screen.getByTestId('location')).toHaveTextContent('preview=video%3Avideo-1');
  });

  it('keeps the saved prompt visible when the host has no card-state callback', async () => {
    render(
      <MemoryRouter>
        <PromptSaveHarness syncCard={false} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open video' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save prompt' }));

    await waitFor(() => {
      expect(screen.getByTestId('lightbox-prompt')).toHaveTextContent('a saved prompt');
    });
    expect(screen.getByTestId('lightbox')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('preview=video%3Avideo-1');
  });
});

describe('MediaPreview variant group — list-scan fallback', () => {
  // Pinned with the lookup failing, because that is when the scan is the only
  // source: a successful fetch supersedes it.
  beforeEach(() => {
    listImageVariants.mockReset();
    listImageVariants.mockRejectedValue(new Error('offline'));
    listMediaGalleryPage.mockReset();
    listMediaGalleryPage.mockResolvedValue({ items: [] });
  });

  // A host that hydrates only the OPEN item (`useHydratedPreviewRoute`) hands
  // us a `preview` carrying `cleanedFrom` while the row it came from — still in
  // `items` — does not. The variant scan reads `cleanedFrom` off the list, so
  // the preview has to stand in for its own row or the toggle never appears on
  // exactly the pages that hydrate lazily.
  const ORIGINAL = { kind: 'image', key: 'image:shot.png', filename: 'shot.png', prompt: 'a shot' };
  const CLEANED_ROW = { kind: 'image', key: 'image:shot_clean.png', filename: 'shot_clean.png', prompt: 'a shot' };
  const CLEANED_HYDRATED = { ...CLEANED_ROW, cleanedFrom: 'shot.png', cleanLevel: 'light' };

  const renderWith = (preview) => render(
    <MemoryRouter>
      <MediaPreview preview={preview} setPreview={() => {}} items={[ORIGINAL, CLEANED_ROW]} />
    </MemoryRouter>,
  );

  it('pairs a lazily hydrated cleaned image with its original', async () => {
    renderWith(CLEANED_HYDRATED);
    await waitFor(() => expect(screen.getByTestId('variant-group').textContent).toBe('OriginalCleaned (light)'));
  });

  it('renders no toggle when nothing in the set is a cleaned copy', async () => {
    renderWith(ORIGINAL);
    await waitFor(() => expect(listImageVariants).toHaveBeenCalled());
    expect(screen.queryByTestId('variant-group')).toBeNull();
  });
});

// The original-vs-cleaned toggle. Neither source of lineage is complete on its
// own: a host list can miss a copy it never held (a deck card, a scene ref, or
// a gallery page whose 60-row window no longer reaches the other variant),
// while the fetched set misses one the user just made in this session.
const FOX = { filename: 'fox.png', prompt: 'a fox' };
const FOX_CLEANED = { filename: 'fox_clean-resize-squeeze.png', prompt: 'a fox', cleanedFrom: 'fox.png', cleanLevel: 'resize-squeeze' };
const asItem = (row) => ({ ...row, kind: 'image', key: `image:${row.filename}`, previewUrl: `/data/images/${row.filename}` });

// The host lists only what it holds, exactly as a deck card or scene does.
function VariantHarness({ hostRows = [FOX], open = FOX }) {
  const items = useMemo(() => hostRows.map(asItem), [hostRows]);
  const [preview, setPreview] = usePreviewRoute(items);
  return (
    <>
      <button type="button" onClick={() => setPreview(asItem(open))}>Open image</button>
      <MediaPreview preview={preview} setPreview={setPreview} items={items} />
    </>
  );
}

describe('MediaPreview variant toggle', () => {
  beforeEach(() => {
    listImageVariants.mockReset();
    listImageVariants.mockResolvedValue({ items: [FOX, FOX_CLEANED] });
    listMediaGalleryPage.mockReset();
    listMediaGalleryPage.mockResolvedValue({ items: [] });
  });

  it.each([
    ['the original', FOX, 'Cleaned (resize-squeeze)', FOX_CLEANED.filename],
    ['a cleaned copy', FOX_CLEANED, 'Original', FOX.filename],
  ])('offers the other variant when %s is opened from a host that lists neither', async (_label, open, otherLabel, otherFilename) => {
    render(<MemoryRouter><VariantHarness hostRows={[open]} open={open} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Open image' }));

    await waitFor(() => expect(screen.getByRole('button', { name: otherLabel })).toBeInTheDocument());
    // No AbortSignal: the read is de-duped with `useHydratedPreviewRoute`
    // (mediaDetail.js's `fetchImageVariantGroup`, #8341), and aborting one
    // caller's copy would also cancel the other's share of it.
    expect(listImageVariants).toHaveBeenCalledWith(open.filename);

    // Selecting the other variant must OPEN it — the host cannot resolve that
    // filename from its own list, so usePreviewRoute's seeding carries it.
    fireEvent.click(screen.getByRole('button', { name: otherLabel }));
    await waitFor(() => expect(screen.getByTestId('lightbox-filename')).toHaveTextContent(otherFilename));
  });

  // The group is closed under the toggle, so the second click must not refetch
  // an identical set — which would also blank the toggle for the round trip.
  it('reuses the fetched group across toggle clicks', async () => {
    render(<MemoryRouter><VariantHarness /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Open image' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cleaned (resize-squeeze)' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Cleaned (resize-squeeze)' }));
    await waitFor(() => expect(screen.getByTestId('lightbox-filename')).toHaveTextContent(FOX_CLEANED.filename));
    expect(screen.getByRole('button', { name: 'Original' })).toBeInTheDocument();
    expect(listImageVariants).toHaveBeenCalledTimes(1);
  });

  // A Clean splices the new copy into the host list; the set fetched when the
  // image opened predates it. Merging is what keeps the toggle from vanishing.
  it('still offers a variant the host holds but the fetched set predates', async () => {
    listImageVariants.mockResolvedValue({ items: [FOX] });
    render(<MemoryRouter><VariantHarness hostRows={[FOX, FOX_CLEANED]} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Open image' }));

    await waitFor(() => expect(listImageVariants).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Cleaned (resize-squeeze)' })).toBeInTheDocument();
  });

  it('renders no toggle when neither source knows of another variant', async () => {
    listImageVariants.mockResolvedValue({ items: [FOX] });
    render(<MemoryRouter><VariantHarness /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Open image' }));

    await waitFor(() => expect(listImageVariants).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Original' })).not.toBeInTheDocument();
  });

  it('falls back to the host list when the lookup fails', async () => {
    listImageVariants.mockRejectedValue(new Error('offline'));
    render(<MemoryRouter><VariantHarness hostRows={[FOX, FOX_CLEANED]} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Open image' }));

    await waitFor(() => expect(listImageVariants).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Cleaned (resize-squeeze)' })).toBeInTheDocument();
  });

  // Picking a variant writes its key to the URL, and prev/next nav plus the
  // annotation lookup both match on the HOST's key — a key taken from the
  // fetched record would silently disable both on a host that keys its own way.
  it('keeps the host key for a file the host lists, while taking the fetched lineage', async () => {
    const nounKeyed = { ...asItem(FOX), key: 'noun:fox.png' };
    function NounHarness() {
      const items = useMemo(() => [nounKeyed], []);
      const [preview, setPreview] = usePreviewRoute(items);
      return (
        <>
          <button type="button" onClick={() => setPreview(nounKeyed)}>Open image</button>
          <MediaPreview preview={preview} setPreview={setPreview} items={items} />
          <LocationProbe />
        </>
      );
    }
    render(<MemoryRouter><NounHarness /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Open image' }));
    // The fetched lineage is what surfaces the toggle at all here.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cleaned (resize-squeeze)' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Original' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('preview=noun%3Afox.png'));
  });

  it('fetches nothing for a video preview', async () => {
    render(<MemoryRouter><PromptSaveHarness /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Open video' }));

    await waitFor(() => expect(screen.getByTestId('lightbox')).toBeInTheDocument());
    expect(listImageVariants).not.toHaveBeenCalled();
  });
});
