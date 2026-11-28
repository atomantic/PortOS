import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MakingOfStage from './MakingOfStage.jsx';
import * as api from '../../../services/apiMusicVideo.js';

vi.mock('../../../services/apiMusicVideo.js', () => ({
  createMusicVideoMakingOfPost: vi.fn(),
  updateMusicVideoMakingOfPost: vi.fn(),
  deleteMusicVideoMakingOfPost: vi.fn(),
  deleteMusicVideoMakingOfItem: vi.fn(),
  getMusicVideoMakingOfXDrafts: vi.fn(async () => ({ drafts: [] })),
  prepareMusicVideoMakingOfXDraft: vi.fn(),
  discardMusicVideoMakingOfXDraft: vi.fn(async () => ({ ok: true })),
  getMusicVideoMakingOfCatalog: vi.fn(async (id) => ({ project: { id, name: 'Demo', version: 1 }, snapshot: 'a'.repeat(64), assets: [] })),
  listMusicVideoProjectSummaries: vi.fn(async () => ({ items: [], nextCursor: null })),
}));

vi.mock('../../../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn() },
}));

vi.mock('../../ui/Toast.jsx', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../lib/clipboard.js', () => ({
  copyToClipboard: vi.fn(async () => true),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const baseProject = {
  id: 'mv-demo',
  name: 'Demo Film',
  scenes: [{ sceneId: 'mvs-1', order: 0, label: 'Shot 1' }],
  makingOfStory: {
    version: 1,
    items: [
      {
        id: 'moi-1',
        kind: 'image',
        assetId: 'fail-frame.png',
        sceneId: 'mvs-1',
        refId: null,
        label: 'Giant character scale bug',
        role: 'fail',
        tags: ['scale', 'ruler'],
        note: 'Character dwarfed the doorway.',
        sourceUrl: '',
        capturedAt: '2026-11-25T10:00:00.000Z',
      },
      {
        id: 'moi-2',
        kind: 'video',
        assetId: 'clip-fixed-1',
        sceneId: 'mvs-1',
        refId: null,
        label: 'Fixed final take',
        role: 'final',
        tags: ['scale'],
        note: '',
        sourceUrl: '',
        capturedAt: '2026-11-26T10:00:00.000Z',
      },
    ],
    posts: [
      {
        id: 'mop-1',
        title: 'Fixing character height drift',
        status: 'staged',
        platform: 'x',
        tags: ['scale'],
        summary: 'How a joint comparison sheet fixed giant characters.',
        body: 'Part one text.\n\n---\n\nPart two text.',
        itemIds: ['moi-1'],
        publishedUrl: '',
        publishedAt: null,
        updatedAt: '2026-11-26T10:00:00.000Z',
      },
    ],
  },
};

describe('MakingOfStage', () => {
  it('renders staged posts with thread parts, filters captured media by role/tag, and creates a new post', async () => {
    const onMakingOfStorySaved = vi.fn();
    const onCaptureMakingOf = vi.fn();
    api.createMusicVideoMakingOfPost.mockResolvedValueOnce({
      post: { id: 'mop-2', title: 'Prop continuity breakdown', status: 'draft', platform: 'x', tags: [], summary: '', body: '', itemIds: [], publishedUrl: '', publishedAt: null, updatedAt: '2026-11-27T00:00:00.000Z' },
      story: {
        ...baseProject.makingOfStory,
        posts: [
          ...baseProject.makingOfStory.posts,
          { id: 'mop-2', title: 'Prop continuity breakdown', status: 'draft', platform: 'x', tags: [], summary: '', body: '', itemIds: [], publishedUrl: '', publishedAt: null, updatedAt: '2026-11-27T00:00:00.000Z' },
        ],
      },
    });

    render(
      <MakingOfStage
        board={{
          project: baseProject,
          onEditShot: vi.fn(),
          openPreview: vi.fn(),
          onCaptureMakingOf,
          onMakingOfStorySaved,
        }}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Fixing character height drift' })).toBeTruthy();
    expect(screen.getByText('Part 1 of 2')).toBeTruthy();
    expect(screen.getByText('Part 2 of 2')).toBeTruthy();
    expect(screen.getByText('Fixed final take')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /New post/i }));
    fireEvent.change(screen.getByLabelText('Post title'), { target: { value: 'Prop continuity breakdown' } });
    fireEvent.click(screen.getByRole('button', { name: /Create post/i }));

    await waitFor(() => expect(api.createMusicVideoMakingOfPost).toHaveBeenCalledWith('mv-demo', expect.objectContaining({ title: 'Prop continuity breakdown' }), { silent: true }));
    expect(onMakingOfStorySaved).toHaveBeenCalled();
  });

  it('removes a captured item after inline confirmation', async () => {
    const onMakingOfStorySaved = vi.fn();
    api.deleteMusicVideoMakingOfItem.mockResolvedValueOnce({
      story: { version: 1, items: [baseProject.makingOfStory.items[1]], posts: [{ ...baseProject.makingOfStory.posts[0], itemIds: [] }] },
    });

    render(
      <MakingOfStage
        board={{
          project: baseProject,
          onEditShot: vi.fn(),
          openPreview: vi.fn(),
          onCaptureMakingOf: vi.fn(),
          onMakingOfStorySaved,
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove Giant character scale bug' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(api.deleteMusicVideoMakingOfItem).toHaveBeenCalledWith('mv-demo', 'moi-1', { silent: true }));
    expect(onMakingOfStorySaved).toHaveBeenCalled();
  });

  it('assigns mixed image and video media per thread part, fills an X draft for review, and records the top-level post link', async () => {
    const onMakingOfStorySaved = vi.fn();
    api.updateMusicVideoMakingOfPost.mockResolvedValue({
      post: { ...baseProject.makingOfStory.posts[0], partItemIds: [['moi-1', 'moi-2'], []] },
      story: {
        ...baseProject.makingOfStory,
        posts: [{ ...baseProject.makingOfStory.posts[0], itemIds: ['moi-1', 'moi-2'], partItemIds: [['moi-1', 'moi-2'], []] }],
      },
    });
    api.prepareMusicVideoMakingOfXDraft.mockResolvedValueOnce({
      draftId: 'mvmof-1',
      projectId: 'mv-demo',
      postId: 'mop-1',
      state: 'open',
      screenshot: 'data:image/jpeg;base64,abc',
      summary: { account: 'example', posts: 2, attachments: 2 },
      manualPublication: true,
    });

    render(
      <MakingOfStage
        board={{
          project: baseProject,
          onEditShot: vi.fn(),
          openPreview: vi.fn(),
          onCaptureMakingOf: vi.fn(),
          onMakingOfStorySaved,
        }}
      />,
    );

    // Choose an image for Part 1 via the per-part media selector.
    const part1Picker = screen.getByLabelText('Add image or video to part 1 of Fixing character height drift');
    fireEvent.change(part1Picker, { target: { value: 'moi-2' } });
    await waitFor(() => expect(api.updateMusicVideoMakingOfPost).toHaveBeenCalledWith(
      'mv-demo',
      'mop-1',
      expect.objectContaining({ itemIds: ['moi-1', 'moi-2'], partItemIds: [['moi-2'], []] }),
      { silent: true },
    ));

    // Fill the X draft and verify the review screenshot + Discard control appear.
    fireEvent.click(screen.getByRole('button', { name: /Fill X draft/i }));
    await waitFor(() => expect(api.prepareMusicVideoMakingOfXDraft).toHaveBeenCalledWith('mv-demo', 'mop-1', {}, { silent: true }));
    expect(await screen.findByAltText('X draft as filled for Fixing character height drift')).toBeTruthy();

    // Paste the top-level X post link and click Record (just like Publish).
    const urlInput = screen.getByLabelText('Link to the top-level Fixing character height drift post');
    fireEvent.change(urlInput, { target: { value: 'https://x.com/example/status/42' } });
    fireEvent.click(screen.getByRole('button', { name: /Record/i }));
    await waitFor(() => expect(api.updateMusicVideoMakingOfPost).toHaveBeenCalledWith(
      'mv-demo',
      'mop-1',
      { status: 'posted', publishedUrl: 'https://x.com/example/status/42' },
      { silent: true },
    ));
  });
});
