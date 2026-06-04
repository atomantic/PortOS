import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ExtendPanel from './ExtendPanel';

const HISTORY = [
  { id: 'v1', prompt: 'a cat walking' },
  { id: 'v2', filename: 'clip2.mp4' },
];

describe('ExtendPanel', () => {
  it('lists prior renders and fires onPick on selection', () => {
    const onPick = vi.fn();
    render(
      <ExtendPanel
        extendFromVideoId=""
        extendingFrame={false}
        sourceImageFile={null}
        visibleHistory={HISTORY}
        onPick={onPick}
      />,
    );
    fireEvent.change(screen.getByLabelText(/Pick a previous video to extend/i), { target: { value: 'v1' } });
    expect(onPick).toHaveBeenCalledWith('v1');
  });

  it('shows the extracting state and disables the picker', () => {
    render(
      <ExtendPanel
        extendFromVideoId="v1"
        extendingFrame
        sourceImageFile={null}
        visibleHistory={HISTORY}
        onPick={vi.fn()}
      />,
    );
    expect(screen.getByText(/Extracting last frame/i)).toBeTruthy();
    expect(screen.getByLabelText(/Pick a previous video to extend/i).disabled).toBe(true);
  });

  it('renders the source-frame preview once extracted', () => {
    render(
      <ExtendPanel
        extendFromVideoId="v1"
        extendingFrame={false}
        sourceImageFile="frame.png"
        visibleHistory={HISTORY}
        onPick={vi.fn()}
      />,
    );
    const img = screen.getByAltText('Last frame');
    expect(img.getAttribute('src')).toBe('/data/images/frame.png');
  });

  it('clears the selection via the Clear button', () => {
    const onPick = vi.fn();
    render(
      <ExtendPanel
        extendFromVideoId="v1"
        extendingFrame={false}
        sourceImageFile={null}
        visibleHistory={HISTORY}
        onPick={onPick}
      />,
    );
    fireEvent.click(screen.getByText('Clear'));
    expect(onPick).toHaveBeenCalledWith('');
  });
});
