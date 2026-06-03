import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import KeyframePanel from './KeyframePanel';

const GALLERY = [{ filename: 'a.png' }, { filename: 'b.png' }];

const baseProps = {
  keyframesMode: false,
  keyframesActive: false,
  keyframes: [],
  numFrames: 121,
  visibleGallery: GALLERY,
  keyframesError: null,
  onToggleMode: vi.fn(),
  onAddKeyframe: vi.fn(),
  onUpdateKeyframe: vi.fn(),
  onRemoveKeyframe: vi.fn(),
};

describe('KeyframePanel', () => {
  it('shows only the toggle when keyframes are inactive', () => {
    render(<KeyframePanel {...baseProps} />);
    expect(screen.getByText(/Multi-keyframe interpolation/i)).toBeTruthy();
    expect(screen.queryByText(/Add keyframe/i)).toBeNull();
  });

  it('fires onToggleMode when the checkbox is clicked', () => {
    const onToggleMode = vi.fn();
    render(<KeyframePanel {...baseProps} onToggleMode={onToggleMode} />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onToggleMode).toHaveBeenCalled();
  });

  it('disables Remove at the 2-keyframe floor', () => {
    render(
      <KeyframePanel
        {...baseProps}
        keyframesMode
        keyframesActive
        keyframes={[{ file: 'a.png', index: 0 }, { file: 'b.png', index: 10 }]}
      />,
    );
    screen.getAllByLabelText(/Remove keyframe/i).forEach((btn) => {
      expect(btn.disabled).toBe(true);
    });
    expect(screen.getByText('2/8')).toBeTruthy();
  });

  it('disables Add at the 8-keyframe ceiling', () => {
    const keyframes = Array.from({ length: 8 }, (_, i) => ({ file: 'a.png', index: i }));
    render(
      <KeyframePanel
        {...baseProps}
        keyframesMode
        keyframesActive
        keyframes={keyframes}
      />,
    );
    expect(screen.getByText(/Add keyframe/i).closest('button').disabled).toBe(true);
    expect(screen.getByText('8/8')).toBeTruthy();
  });

  it('surfaces the validation error when present', () => {
    render(
      <KeyframePanel
        {...baseProps}
        keyframesMode
        keyframesActive
        keyframes={[{ file: '', index: 0 }, { file: '', index: 10 }]}
        keyframesError="Keyframe 1 needs a gallery image."
      />,
    );
    expect(screen.getByText('Keyframe 1 needs a gallery image.')).toBeTruthy();
  });
});
