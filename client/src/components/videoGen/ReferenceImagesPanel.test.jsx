import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ReferenceImagesPanel from './ReferenceImagesPanel';

const props = () => ({ maxImages: 3, files: [], onAdd: vi.fn(), onBrowse: vi.fn(), onRemove: vi.fn() });

describe('ReferenceImagesPanel', () => {
  it('counts the input image toward the ceiling and stops adding at maxImages - 1 rows', () => {
    const { rerender } = render(<ReferenceImagesPanel {...props()} files={['a.png']} />);
    expect(screen.getByText('2/3 incl. input image')).toBeTruthy();
    expect(screen.getByRole('button', { name: /add reference image/i }).disabled).toBe(false);
    rerender(<ReferenceImagesPanel {...props()} files={['a.png', 'b.png']} />);
    expect(screen.getByRole('button', { name: /add reference image/i }).disabled).toBe(true);
  });

  it('offers clip and voice rows only up to the model ceilings and routes their handlers', () => {
    const p = { ...props(), maxVideos: 1, videoIds: [''], history: [{ id: 'v1', prompt: 'a prior render' }],
      onAddVideo: vi.fn(), onPickVideo: vi.fn(), onRemoveVideo: vi.fn(),
      maxAudios: 1, audioFiles: [], onAddAudio: vi.fn(), onRemoveAudio: vi.fn() };
    render(<ReferenceImagesPanel {...p} />);
    expect(screen.getByRole('button', { name: /add reference clip/i }).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Reference clip 1'), { target: { value: 'v1' } });
    expect(p.onPickVideo).toHaveBeenCalledWith(0, 'v1');
    const file = new File(['x'], 'voice.wav', { type: 'audio/wav' });
    fireEvent.change(document.getElementById('reference-audio-input'), { target: { files: [file] } });
    expect(p.onAddAudio).toHaveBeenCalledWith(file);
  });

  it('keeps older loaded renders visible and selectable beyond the first fifty clips', () => {
    const history = Array.from({ length: 60 }, (_, index) => ({ id: `v${index + 1}`, prompt: `Prior render ${index + 1}` }));
    const onPickVideo = vi.fn();
    render(<ReferenceImagesPanel {...props()} maxVideos={1} videoIds={['v60']} history={history} onPickVideo={onPickVideo} />);
    const select = screen.getByLabelText('Reference clip 1');
    expect(select.value).toBe('v60');
    expect(screen.getByRole('option', { name: 'Prior render 60' }).selected).toBe(true);
    fireEvent.change(select, { target: { value: 'v51' } });
    expect(onPickVideo).toHaveBeenCalledWith(0, 'v51');
  });

  it('shows a resumed clip outside the loaded history and lets the user clear it', () => {
    const onPickVideo = vi.fn();
    render(<ReferenceImagesPanel {...props()} maxVideos={1} videoIds={['older-selected-clip']} history={[{ id: 'recent', prompt: 'Recent render' }]} onPickVideo={onPickVideo} />);
    const select = screen.getByLabelText('Reference clip 1');
    expect(select.value).toBe('older-selected-clip');
    expect(screen.getByRole('option', { name: /older-selected-clip.*not in loaded history/i }).selected).toBe(true);
    expect(onPickVideo).not.toHaveBeenCalled();
    fireEvent.change(select, { target: { value: '' } });
    expect(onPickVideo).toHaveBeenCalledWith(0, '');
  });

  it('numbers rows after the input image and routes pick/remove by row index', () => {
    const p = props();
    render(<ReferenceImagesPanel {...p} files={['a.png', '']} />);
    fireEvent.click(screen.getByRole('button', { name: /Reference image 3 — pick from gallery/ }));
    expect(p.onBrowse).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByRole('button', { name: 'Remove reference image 2' }));
    expect(p.onRemove).toHaveBeenCalledWith(0);
  });
});
