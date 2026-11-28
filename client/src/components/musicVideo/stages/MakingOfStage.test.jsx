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

  it('offers the closing published X video link toggle and passes includeVideoLink when enabled', async () => {
    api.prepareMusicVideoMakingOfXDraft.mockResolvedValue({
      draftId: 'mvmof-2',
      projectId: 'mv-demo',
      postId: 'mop-1',
      state: 'open',
      screenshot: null,
      summary: { posts: 3, attachments: 0 },
      manualPublication: true,
    });
    const publishedProject = {
      ...baseProject,
      publishKit: { posts: { x: { url: 'https://x.com/example/status/9001' } } },
    };

    render(
      <MakingOfStage
        board={{
          project: publishedProject,
          onEditShot: vi.fn(),
          openPreview: vi.fn(),
          onCaptureMakingOf: vi.fn(),
          onMakingOfStorySaved: vi.fn(),
        }}
      />,
    );

    const toggle = screen.getByRole('checkbox', { name: /Append closing post linking to published X video/i });
    expect(toggle.checked).toBe(true);
    expect(screen.getByText(/Watch the finished "Demo Film" music video:/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Fill X draft/i }));
    await waitFor(() => expect(api.prepareMusicVideoMakingOfXDraft).toHaveBeenCalledWith(
      'mv-demo',
      'mop-1',
      { includeVideoLink: true },
      { silent: true },
    ));

    // Unchecking skips includeVideoLink on the next fill.
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Fill again/i }));
    await waitFor(() => expect(api.prepareMusicVideoMakingOfXDraft).toHaveBeenLastCalledWith(
      'mv-demo',
      'mop-1',
      {},
      { silent: true },
    ));
  });

  it('starts posted cards collapsed by default, allows manual expand/collapse, and folds a card when marked posted', () => {
    const projectWithPosted = {
      ...baseProject,
      makingOfStory: {
        ...baseProject.makingOfStory,
        posts: [
          {
            ...baseProject.makingOfStory.posts[0],
            id: 'mop-done',
            title: 'Already posted breakdown',
            status: 'posted',
            body: 'Hidden posted body text.',
            publishedUrl: 'https://x.com/example/status/77',
            publishedAt: '2026-11-26T12:00:00.000Z',
          },
          baseProject.makingOfStory.posts[0],
        ],
      },
    };

    const { rerender } = render(
      <MakingOfStage
        board={{
          project: projectWithPosted,
          onEditShot: vi.fn(),
          openPreview: vi.fn(),
          onCaptureMakingOf: vi.fn(),
          onMakingOfStorySaved: vi.fn(),
        }}
      />,
    );

    // Posted card starts collapsed (title + published link visible, body hidden); staged card starts expanded.
    const doneToggle = screen.getByRole('button', { name: 'Already posted breakdown' });
    const stagedToggle = screen.getByRole('button', { name: 'Fixing character height drift' });
    expect(doneToggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Hidden posted body text.')).toBeNull();
    expect(screen.getByRole('link', { name: /https:\/\/x\.com\/example\/status\/77/ })).toBeTruthy();
    expect(stagedToggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Part one text.')).toBeTruthy();

    // Expanding the posted card reveals its body; collapsing the staged card hides its body.
    fireEvent.click(doneToggle);
    expect(doneToggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Hidden posted body text.')).toBeTruthy();

    fireEvent.click(stagedToggle);
    expect(stagedToggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Part one text.')).toBeNull();

    // Re-expand the staged card, then mark it posted -> folds automatically.
    fireEvent.click(stagedToggle);
    expect(stagedToggle.getAttribute('aria-expanded')).toBe('true');
    rerender(
      <MakingOfStage
        board={{
          project: {
            ...projectWithPosted,
            makingOfStory: {
              ...projectWithPosted.makingOfStory,
              posts: [
                projectWithPosted.makingOfStory.posts[0],
                { ...projectWithPosted.makingOfStory.posts[1], status: 'posted', publishedUrl: 'https://x.com/example/status/88' },
              ],
            },
          },
          onEditShot: vi.fn(),
          openPreview: vi.fn(),
          onCaptureMakingOf: vi.fn(),
          onMakingOfStorySaved: vi.fn(),
        }}
      />,
    );
    expect(screen.getByRole('button', { name: 'Fixing character height drift' }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Part one text.')).toBeNull();
  });
});
