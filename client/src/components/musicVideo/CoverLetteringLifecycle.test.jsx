import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getMusicVideoCoverFonts: vi.fn(),
  getMusicVideoArtistStyles: vi.fn(),
  saveMusicVideoArtistStyle: vi.fn(),
}));
vi.mock('../../services/apiMusicVideo.js', async (importOriginal) => ({
  ...(await importOriginal()),
  ...api,
}));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../imageGen/GalleryImagePicker', () => ({ default: () => null }));

import useMusicVideoCoverLettering from '../../hooks/useMusicVideoCoverLettering.js';
import CoverLetteringPanel from './CoverLetteringPanel.jsx';
import YoutubeThumbnailPanel from './YoutubeThumbnailPanel.jsx';

const font = { id: 'example-font', family: 'Example Font', addedAt: '2026-01-01T00:00:00.000Z' };
const style = { key: 'example artist', name: 'Example Artist', design: { typeface: 'font:example-font' } };
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const saveCoverDesign = vi.fn();

function Fixture({ enabled = true }) {
  const [open, setOpen] = useState(true);
  const lettering = useMusicVideoCoverLettering({ enabled });
  return <CoverLetteringPanel project={{ id: 'test' }} art={{ design: { typeface: 'font:example-font' } }} source={null}
    title="Song" tag="Example Artist" focusX={0.5} publishKit={{ saveCoverDesign }} lettering={lettering} busy={false} open={open} onToggle={setOpen} />;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getMusicVideoCoverFonts.mockReset().mockResolvedValue({ fonts: [font] });
  api.getMusicVideoArtistStyles.mockReset().mockResolvedValue({ styles: [style] });
  api.saveMusicVideoArtistStyle.mockReset();
});

describe('cover lettering asset lifecycle', () => {
  it('blocks a fallback-font save on a failed load and preserves the custom font after retry', async () => {
    const firstRead = deferred();
    api.getMusicVideoCoverFonts.mockReturnValueOnce(firstRead.promise);
    render(<Fixture />);

    expect(screen.getByText('Loading cover fonts…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set the lettering' })).not.toBeInTheDocument();
    await act(async () => { firstRead.reject(new Error('Font library unavailable')); });
    expect(await screen.findByText(/Could not load cover fonts/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set the lettering' })).not.toBeInTheDocument();
    expect(saveCoverDesign).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('Title treatment')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Title treatment'), { target: { value: 'outline' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set the lettering' }));
    expect(saveCoverDesign).toHaveBeenCalledWith(expect.objectContaining({ typeface: 'font:example-font', titleStyle: 'outline' }));
  });

  it('reports a failed artist-style read and restores the list on retry', async () => {
    api.getMusicVideoArtistStyles.mockRejectedValueOnce(new Error('Styles unavailable'));
    render(<Fixture />);
    expect(await screen.findByText(/Could not load artist styles/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save as artist style' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('option', { name: 'Example Artist' })).toBeInTheDocument();
  });

  it('does not show a fallback thumbnail preview when its custom font cannot load', async () => {
    api.getMusicVideoCoverFonts.mockRejectedValueOnce(new Error('Font library unavailable'));
    const project = { id: 'test', name: 'Song', publishKit: {
      coverArt: { design: { typeface: 'font:example-font' } },
      youtubeThumbnail: { source: { kind: 'thumbnail', filename: 'frame.jpg' } },
    } };
    render(<YoutubeThumbnailPanel project={project} publishKit={{}} />);
    expect(await screen.findByText(/Could not load cover fonts for the preview/)).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /Thumbnail preview/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect((await screen.findByRole('img', { name: /Thumbnail preview/ })).innerHTML).toContain('Example Font');
  });

  it('keeps a newly saved style when an earlier refresh completes later', async () => {
    const save = deferred();
    const refresh = deferred();
    api.saveMusicVideoArtistStyle.mockReturnValue(save.promise);
    api.getMusicVideoArtistStyles.mockResolvedValueOnce({ styles: [style] }).mockReturnValueOnce(refresh.promise);
    const view = render(<Fixture />);
    await screen.findByLabelText('Saved styles');
    fireEvent.click(screen.getByRole('button', { name: 'Save as artist style' }));
    view.rerender(<Fixture enabled={false} />);
    view.rerender(<Fixture enabled />);
    await waitFor(() => expect(api.getMusicVideoArtistStyles).toHaveBeenCalledTimes(2));
    const updated = { ...style, name: 'Updated Artist' };
    await act(async () => { save.resolve({ style: updated }); await save.promise; });
    await act(async () => { refresh.resolve({ styles: [style] }); await refresh.promise; });
    expect(screen.getByRole('option', { name: 'Updated Artist' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Example Artist' })).not.toBeInTheDocument();
  });
});
