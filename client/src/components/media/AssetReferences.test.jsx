import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import MediaCard from './MediaCard.jsx';
import { normalizeImage, normalizeVideo } from './normalize.js';
import SceneTakeStrip from '../musicVideo/SceneTakeStrip.jsx';
import { getVideoHistoryItem } from '../../services/apiImageVideo.js';

vi.mock('../../services/apiImageVideo.js', async (importOriginal) => ({
  ...await importOriginal(),
  getVideoHistoryItem: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const image = normalizeImage({ filename: 'first frame.png', prompt: 'An image' });
const video = normalizeVideo({ id: 'video-history-42', filename: 'actual-clip.mp4', prompt: 'A video' });
const absolute = (path) => new URL(path, location.origin).href;

describe('asset references on media cards', () => {
  it.each([[image, 'first frame.png', '/data/images/first%20frame.png'], [video, 'video-history-42', '/data/videos/actual-clip.mp4']])(
    'copies the exact asset ID and original file URL without opening or selecting the card', async (item, id, path) => {
      const writeText = vi.fn().mockResolvedValue();
      vi.stubGlobal('navigator', { clipboard: { writeText } });
      const onPreview = vi.fn();
      const onClick = vi.fn();
      render(<MediaCard item={item} onPreview={onPreview} onClick={onClick} showCollectionMenu={false} showMoodBoardMenu={false} />);

      fireEvent.click(screen.getByRole('button', { name: 'Copy ID' }));
      await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(id));
      expect(await screen.findByRole('status')).toHaveTextContent('ID copied');
      fireEvent.click(screen.getByRole('button', { name: 'Copy URL' }));
      await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(absolute(path)));
      expect(await screen.findByRole('status')).toHaveTextContent('URL copied');
      expect(onClick).not.toHaveBeenCalled();
      expect(onPreview).not.toHaveBeenCalled();
    },
  );

  it.each(['missing', 'denied'])('offers selectable text when clipboard access is %s', async (mode) => {
    vi.stubGlobal('navigator', mode === 'missing' ? {} : { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    render(<MediaCard item={video} showCollectionMenu={false} showMoodBoardMenu={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy URL' }));
    const input = await screen.findByRole('textbox', { name: 'URL to copy' });
    expect(input).toHaveValue(absolute('/data/videos/actual-clip.mp4'));
    expect(input).toHaveAttribute('readonly');
    expect(screen.getByRole('status')).toHaveTextContent('Select the text below');
    fireEvent.focus(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('textbox', { name: 'URL to copy' })).toBeNull();
  });

  it('does not expose signed, credentialed, or missing file URLs', () => {
    const { rerender } = render(<MediaCard item={{ ...image, downloadUrl: 'https://user:secret@example.com/image.png' }} showCollectionMenu={false} showMoodBoardMenu={false} />);
    expect(screen.getByRole('button', { name: 'Copy ID' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy URL' })).toBeNull();
    rerender(<MediaCard item={{ ...image, downloadUrl: '/data/images/first.png?token=secret' }} showCollectionMenu={false} showMoodBoardMenu={false} />);
    expect(screen.queryByRole('button', { name: 'Copy URL' })).toBeNull();
    rerender(<MediaCard item={normalizeVideo({ id: 'legacy' })} showCollectionMenu={false} showMoodBoardMenu={false} />);
    expect(screen.queryByRole('button', { name: 'Copy URL' })).toBeNull();
  });
});

describe('asset references on shot takes', () => {
  it('copies the video asset ID and resolves the actual filename before copying its URL', async () => {
    const writeText = vi.fn().mockResolvedValue();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.mocked(getVideoHistoryItem).mockResolvedValue({ id: 'history-id', filename: 'timeline elsewhere.mp4' });
    const onOpenPreview = vi.fn();
    const onSelect = vi.fn();
    const scene = { sceneId: 'scene-1', order: 0, takes: [{ takeId: 'take-id', kind: 'video', assetId: 'history-id', status: 'candidate' }] };
    render(<SceneTakeStrip scene={scene} kind="video" onOpenPreview={onOpenPreview} onSelect={onSelect} />);
    const card = within(screen.getByRole('listitem'));

    fireEvent.click(card.getByRole('button', { name: 'Copy ID' }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('history-id'));
    fireEvent.click(card.getByRole('button', { name: 'Copy URL' }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(absolute('/data/videos/timeline%20elsewhere.mp4')));
    expect(getVideoHistoryItem).toHaveBeenCalledWith('history-id', { silent: true });
    expect(onOpenPreview).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('keeps a legacy still reference copyable and reports an unavailable video URL', async () => {
    const writeText = vi.fn().mockResolvedValue();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.mocked(getVideoHistoryItem).mockRejectedValue(new Error('offline'));
    const scene = { sceneId: 'scene-1', order: 0, referenceImageId: 'legacy.png', videoHistoryId: 'missing-video' };
    const { rerender } = render(<SceneTakeStrip scene={scene} kind="image" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy URL' }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(absolute('/data/images/legacy.png')));
    rerender(<SceneTakeStrip scene={scene} kind="video" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy URL' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Could not get URL');
    expect(writeText).toHaveBeenCalledTimes(1);
  });
});
