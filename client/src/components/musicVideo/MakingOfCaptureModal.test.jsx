import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MakingOfCaptureModal from './MakingOfCaptureModal.jsx';
import * as api from '../../services/apiMusicVideo.js';

vi.mock('../../services/apiMusicVideo.js', () => ({
  captureMusicVideoMakingOfItem: vi.fn(),
  updateMusicVideoMakingOfItem: vi.fn(),
}));

vi.mock('../ui/Toast.jsx', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MakingOfCaptureModal', () => {
  it('captures a labeled, tagged asset and creates a new Making-Of post', async () => {
    const onClose = vi.fn();
    const onSaved = vi.fn();
    const storyReply = { version: 1, items: [{ id: 'moi-1', kind: 'image', assetId: 'prop-fail.png', label: 'Floating prop render', role: 'fail', tags: ['continuity', '3d-fail'], note: 'Prop hovered above ground.', sourceUrl: '', capturedAt: '2026-11-26T00:00:00.000Z' }], posts: [] };
    api.captureMusicVideoMakingOfItem.mockResolvedValueOnce({ item: storyReply.items[0], story: storyReply });

    render(
      <MakingOfCaptureModal
        open
        projectId="mv-demo"
        draft={{ kind: 'image', assetId: 'prop-fail.png', sceneId: 'mvs-12', label: 'Shot 12 frame', role: 'fail' }}
        story={{ version: 1, items: [], posts: [] }}
        onClose={onClose}
        onSaved={onSaved}
      />,
    );

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Floating prop render' } });
    fireEvent.change(screen.getByLabelText('Tags (comma-separated)'), { target: { value: 'continuity, 3d-fail' } });
    fireEvent.change(screen.getByLabelText('Story note / caption context'), { target: { value: 'Prop hovered above ground.' } });
    fireEvent.change(screen.getByLabelText('Add to Making-Of post'), { target: { value: '__new__' } });
    fireEvent.change(screen.getByLabelText('New post title'), { target: { value: 'Solving prop continuity' } });

    fireEvent.click(screen.getByRole('button', { name: /Save to Making Of/i }));

    await waitFor(() => expect(api.captureMusicVideoMakingOfItem).toHaveBeenCalledWith(
      'mv-demo',
      expect.objectContaining({
        kind: 'image',
        assetId: 'prop-fail.png',
        sceneId: 'mvs-12',
        label: 'Floating prop render',
        role: 'fail',
        tags: ['continuity', '3d-fail'],
        note: 'Prop hovered above ground.',
        newPostTitle: 'Solving prop continuity',
      }),
      { silent: true },
    ));
    expect(onSaved).toHaveBeenCalledWith(storyReply, storyReply.items[0]);
    expect(onClose).toHaveBeenCalled();
  });
});
