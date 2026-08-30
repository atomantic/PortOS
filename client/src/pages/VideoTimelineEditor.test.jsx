import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// The editor's pure rules live in lib/videoTimelineModel.js and its blocks in
// components/media/VideoTimelineLanes.jsx, both tested there. What only exists
// here is the page's own wiring: which lanes render, what counts as a missing
// source, and the lane caps.

vi.mock('@dnd-kit/sortable', async () => {
  const actual = await vi.importActual('@dnd-kit/sortable');
  return {
    ...actual,
    useSortable: () => ({
      attributes: {}, listeners: {}, setNodeRef: () => {}, transform: null, transition: null, isDragging: false,
    }),
  };
});

const toastError = vi.hoisted(() => vi.fn());
vi.mock('../components/ui/Toast', () => ({
  default: Object.assign(vi.fn(), { error: toastError, success: vi.fn() }),
}));

vi.mock('react-router', () => ({
  useParams: () => ({ projectId: 'p1' }),
  useNavigate: () => vi.fn(),
}));

vi.mock('../hooks/useSseProgress', () => ({
  useSseProgress: () => ({ latest: null, closed: false }),
  isTerminalSseFrame: () => false,
}));

const api = vi.hoisted(() => ({
  project: null,
  history: [],
  gallery: [],
  music: { tracks: [] },
  galleryThrows: false,
}));

vi.mock('../services/api', () => ({
  getTimelineProject: async () => api.project,
  listVideoHistory: async () => api.history,
  listImageGallery: async () => {
    if (api.galleryThrows) throw new Error('network');
    return api.gallery;
  },
  listMusicLibrary: async () => api.music,
  updateTimelineProject: async () => ({ updatedAt: 'u2' }),
  renderTimelineProject: async () => ({ jobId: 'j1' }),
}));

const VideoTimelineEditor = (await import('./VideoTimelineEditor')).default;

const CLIP_A = '11111111-1111-4111-8111-111111111111';

const project = (over = {}) => ({
  id: 'p1', name: 'Example Project', updatedAt: 'u1', schemaVersion: 2,
  segments: [], overlays: [], audio: { clipVolume: 1, tracks: [] }, clips: [], ...over,
});

const clipSegment = { type: 'clip', clipId: CLIP_A, inSec: 0, outSec: 4, fadeInSec: 0, fadeOutSec: 0, volume: 1 };
const stillSegment = { type: 'still', assetKind: 'images', assetFile: 'plate.png', durationSec: 3, fadeInSec: 0, fadeOutSec: 0 };
const overlayEntry = { type: 'image', assetKind: 'images', assetFile: 'logo.png', startSec: 0, durationSec: 2, x: 0, y: 0, width: 0.25, opacity: 1, fadeInSec: 0, fadeOutSec: 0 };
const bedEntry = { assetKind: 'music', assetFile: 'bed.mp3', startSec: 0, offsetSec: 0, durationSec: 4, volume: 1, fadeInSec: 0, fadeOutSec: 0 };

beforeEach(() => {
  toastError.mockClear();
  api.project = project();
  api.history = [{ id: CLIP_A, prompt: 'A dramatic sunrise', filename: 'a.mp4', thumbnail: 'a.jpg', width: 1920, height: 1080, fps: 24, numFrames: 96 }];
  api.gallery = [{ filename: 'plate.png' }, { filename: 'logo.png' }];
  api.music = { tracks: [{ filename: 'bed.mp3', label: 'Bed' }] };
  api.galleryThrows = false;
});

const renderEditor = async () => {
  render(<VideoTimelineEditor />);
  await waitFor(() => expect(screen.queryByText('Loading project…')).not.toBeInTheDocument());
};

describe('lane visibility', () => {
  it('shows the empty-timeline hint only when EVERY lane is empty', async () => {
    await renderEditor();
    expect(screen.getByText(/Add clips, stills, overlays and audio/)).toBeInTheDocument();
  });

  it('renders the free lanes for a project whose video lane is empty', async () => {
    // Overlays and beds added to an empty project would otherwise be
    // unselectable and unremovable on reload.
    api.project = project({ overlays: [overlayEntry], audio: { clipVolume: 1, tracks: [bedEntry] } });
    await renderEditor();

    expect(screen.queryByText(/Add clips, stills, overlays and audio/)).not.toBeInTheDocument();
    expect(screen.getByText('Add a clip or a still from the library')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove logo.png from timeline' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove bed.mp3 from timeline' })).toBeInTheDocument();
  });

  it('summarises every lane in the header, not just the video lane', async () => {
    api.project = project({ segments: [clipSegment, stillSegment], overlays: [overlayEntry], audio: { clipVolume: 1, tracks: [bedEntry] } });
    await renderEditor();
    expect(screen.getByText(/2 segments · 1 overlays · 1 beds/)).toBeInTheDocument();
  });
});

describe('missing-source detection', () => {
  it('flags a still whose gallery file is gone', async () => {
    api.gallery = [{ filename: 'logo.png' }];
    api.project = project({ segments: [stillSegment] });
    await renderEditor();
    expect(screen.getByText('(missing)')).toBeInTheDocument();
  });

  it('says nothing when the gallery fetch FAILED — an unloaded catalogue is not evidence of absence', async () => {
    // Collapsing a failed fetch into "empty" would mark every still and
    // overlay missing even though the server can still render them.
    api.galleryThrows = true;
    api.project = project({ segments: [stillSegment], overlays: [overlayEntry] });
    await renderEditor();
    expect(screen.queryByText('(missing)')).not.toBeInTheDocument();
  });

  it('does not flag an asset kind it has no catalogue for', async () => {
    api.project = project({ audio: { clipVolume: 1, tracks: [{ ...bedEntry, assetKind: 'audio', assetFile: 'vo.wav' }] } });
    await renderEditor();
    expect(screen.queryByText('(missing)')).not.toBeInTheDocument();
  });
});

describe('header layout — mobile overflow regression (#5425)', () => {
  it('header container carries flex-wrap so it can reflow on narrow viewports', async () => {
    await renderEditor();
    // The outermost header div must have flex-wrap so the right-side buttons
    // can drop below the title row at 375 px rather than crushing the input.
    const headerDiv = screen
      .getByRole('textbox', { name: 'Project name' })
      .closest('[class*="flex-wrap"]');
    expect(headerDiv).not.toBeNull();
  });

  it('summary span is hidden on small screens (carries hidden sm:inline)', async () => {
    api.project = project({ segments: [clipSegment], overlays: [overlayEntry], audio: { clipVolume: 1, tracks: [bedEntry] } });
    await renderEditor();
    const summarySpan = screen.getByText(/1 segments · 1 overlays · 1 beds/);
    expect(summarySpan.className).toMatch(/\bhidden\b/);
    expect(summarySpan.className).toMatch(/\bsm:inline\b/);
  });
});

describe('lane caps', () => {
  it('refuses an add past the overlay cap with a message naming the lane', async () => {
    // One entry over the cap 400s every later debounced save, with nothing
    // telling the user which lane to trim.
    api.project = project({
      segments: [clipSegment],
      overlays: Array.from({ length: 50 }, (_, i) => ({ ...overlayEntry, assetFile: `logo${i}.png` })),
    });
    api.gallery = [{ filename: 'plate.png' }, ...Array.from({ length: 50 }, (_, i) => ({ filename: `logo${i}.png` }))];
    await renderEditor();

    fireEvent.click(screen.getByRole('tab', { name: /Stills/ }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Overlay' })[0]);

    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('Overlay lane limit reached (50)'));
  });

  it('allows the add when the lane is under the cap', async () => {
    api.project = project({ segments: [clipSegment] });
    await renderEditor();

    fireEvent.click(screen.getByRole('tab', { name: /Stills/ }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Overlay' })[0]);

    expect(toastError).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove plate.png from timeline' })).toBeInTheDocument());
  });
});
