import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import FrameStepper, { frameAt, frameTime, frameTimecode } from './FrameStepper.jsx';

const uploadGalleryImage = vi.fn(async () => ({ filename: 'upload-1234abcd.png' }));
vi.mock('../../services/apiSystem.js', () => ({ uploadGalleryImage: (...args) => uploadGalleryImage(...args) }));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('../ui/Toast', () => ({ default: { success: (...args) => toastSuccess(...args), error: (...args) => toastError(...args) } }));

afterEach(() => { uploadGalleryImage.mockClear(); toastSuccess.mockClear(); toastError.mockClear(); });

describe('frame math', () => {
  it('numbers song frames and seeks to the middle of one', () => {
    expect(frameAt(1, 24)).toBe(24);
    expect(frameAt(1.0399, 24)).toBe(24);
    expect(frameAt(frameTime(100, 24), 24)).toBe(100);
    expect(frameTimecode(24 * 61 + 5, 24)).toBe('1:01:05');
  });
});

describe('FrameStepper', () => {
  it('steps by the chosen count, jumps to a typed frame, and binds , and .', () => {
    const onSeek = vi.fn();
    render(<FrameStepper time={frameTime(100)} onSeek={onSeek} maxSec={10} keys />);
    fireEvent.click(screen.getByRole('button', { name: 'Forward 1 frame' }));
    expect(frameAt(onSeek.mock.lastCall[0])).toBe(101);
    fireEvent.change(screen.getByLabelText('Frames per step'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Back 12 frames' }));
    expect(frameAt(onSeek.mock.lastCall[0])).toBe(88);
    const frame = screen.getByLabelText('Frame');
    fireEvent.focus(frame);
    fireEvent.change(frame, { target: { value: '9999' } });
    fireEvent.keyDown(frame, { key: 'Enter' });
    expect(frameAt(onSeek.mock.lastCall[0])).toBe(239);
    fireEvent.keyDown(window, { key: '.' });
    expect(frameAt(onSeek.mock.lastCall[0])).toBe(112);
    expect(screen.getByText('0:04:04')).toBeTruthy();
  });

  it('saves the frame on screen to the gallery', async () => {
    const blob = new Blob(['png'], { type: 'image/png' });
    render(<FrameStepper time={frameTime(48)} onSeek={vi.fn()} capture={async () => blob} label="Example Song · Shot 2" />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save frame/ })); });
    expect(uploadGalleryImage).toHaveBeenCalledWith(blob, { silent: true });
    expect(toastSuccess).toHaveBeenCalledWith('Saved Example Song · Shot 2 · frame 48 to the image gallery');
  });

  it('names the frozen audio frame and reports capture or upload failures without success', async () => {
    const blob = new Blob(['png'], { type: 'image/png' });
    const capture = vi.fn(async () => ({ blob, time: 3, fps: 24, label: 'Shot 2' }));
    render(<FrameStepper time={0} onSeek={vi.fn()} capture={capture} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save frame/ })); });
    expect(toastSuccess).toHaveBeenCalledWith('Saved Shot 2 · frame 72 to the image gallery');
    toastSuccess.mockClear(); uploadGalleryImage.mockClear();
    capture.mockRejectedValueOnce(new Error('Missing layer'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save frame/ })); });
    expect(uploadGalleryImage).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith("Couldn't save frame 0: Missing layer");
    uploadGalleryImage.mockRejectedValueOnce(new Error('Upload failed'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save frame/ })); });
    expect(toastError).toHaveBeenLastCalledWith("Couldn't save Shot 2 · frame 72");
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
