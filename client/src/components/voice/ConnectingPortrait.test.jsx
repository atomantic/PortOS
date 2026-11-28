import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ConnectingPortrait, { CONNECTING_STEPS } from './ConnectingPortrait';
import SatPhoneViewfinder from './SatPhoneViewfinder';

vi.mock('./VoiceCallGenerativePortrait', () => ({ default: ({ connecting }) => <div>{connecting ? 'portrait connecting' : 'portrait'}</div> }));
vi.mock('./SatPhoneCaption', () => ({ default: () => null }));

describe('ConnectingPortrait', () => {
  let images;
  beforeEach(() => {
    vi.useFakeTimers();
    images = [];
    vi.stubGlobal('Image', vi.fn(function ImageMock() { images.push(this); }));
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: vi.fn(), imageSmoothingEnabled: false }));
    window.matchMedia = vi.fn().mockReturnValue({ matches: false });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('redraws the portrait at rising resolutions with hard pixels', () => {
    render(<ConnectingPortrait src="/portrait.webp" />);
    const canvas = screen.getByTestId('connecting-portrait');
    expect(canvas.style.imageRendering).toBe('pixelated');
    expect(images[0].src).toBe('/portrait.webp');
    images[0].onload();
    expect(canvas.width).toBe(CONNECTING_STEPS[0]);
    vi.advanceTimersByTime(420);
    expect(canvas.width).toBe(CONNECTING_STEPS[1]);
  });

  it('holds one coarse frame under reduced motion', () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true });
    render(<ConnectingPortrait src="/portrait.webp" />);
    images[0].onload();
    const { width } = screen.getByTestId('connecting-portrait');
    vi.advanceTimersByTime(2000);
    expect(screen.getByTestId('connecting-portrait').width).toBe(width);
  });
});

describe('SatPhoneViewfinder while connecting', () => {
  it('shows Connecting on the status chip and passes it to the portrait, but keeps a live stage', () => {
    const { rerender } = render(<SatPhoneViewfinder connecting stage="idle" />);
    expect(screen.getByRole('status')).toHaveTextContent('Connecting');
    expect(screen.getByText('portrait connecting')).toBeInTheDocument();
    rerender(<SatPhoneViewfinder connecting stage="speaking" />);
    expect(screen.getByRole('status')).toHaveTextContent('Speaking');
  });
});
