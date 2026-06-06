import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import InitImagePicker from './InitImagePicker';

const EMPTY = { source: null, file: null, name: null, previewUrl: null };
const FILLED = { source: 'upload', file: null, name: 'cat.png', previewUrl: 'blob:abc' };

describe('InitImagePicker', () => {
  it('renders the upload drop-target when empty', () => {
    render(
      <InitImagePicker
        initImage={EMPTY}
        initImageStrength={0.4}
        onStrengthChange={vi.fn()}
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    expect(screen.getByText(/Upload \(PNG\/JPG\/WebP\)/i)).toBeTruthy();
    expect(screen.getByText(/image-to-image — Flux only/i)).toBeTruthy();
  });

  it('drops the "Flux only" caveat on the codex backend', () => {
    render(
      <InitImagePicker
        initImage={EMPTY}
        initImageStrength={0.4}
        onStrengthChange={vi.fn()}
        onPick={vi.fn()}
        onClear={vi.fn()}
        backend="codex"
      />,
    );
    expect(screen.getByText('(image-to-image)')).toBeTruthy();
    expect(screen.queryByText(/Flux only/i)).toBeNull();
  });

  it('renders a Browse gallery button when onBrowse is provided and fires it', () => {
    const onBrowse = vi.fn();
    render(
      <InitImagePicker
        initImage={EMPTY}
        initImageStrength={0.4}
        onStrengthChange={vi.fn()}
        onPick={vi.fn()}
        onClear={vi.fn()}
        onBrowse={onBrowse}
      />,
    );
    fireEvent.click(screen.getByText(/Browse gallery/i));
    expect(onBrowse).toHaveBeenCalledTimes(1);
  });

  it('omits the Browse gallery button when onBrowse is absent', () => {
    render(
      <InitImagePicker
        initImage={EMPTY}
        initImageStrength={0.4}
        onStrengthChange={vi.fn()}
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    expect(screen.queryByText(/Browse gallery/i)).toBeNull();
  });

  it('shows the required-source label and warning copy when editOnly', () => {
    render(
      <InitImagePicker
        initImage={EMPTY}
        initImageStrength={0.4}
        onStrengthChange={vi.fn()}
        onPick={vi.fn()}
        onClear={vi.fn()}
        editOnly
      />,
    );
    expect(screen.getByText(/Source image/i)).toBeTruthy();
    expect(screen.getByText(/required — this model edits an existing image/i)).toBeTruthy();
  });

  it('renders the thumbnail, name, strength, and fires onClear', () => {
    const onClear = vi.fn();
    render(
      <InitImagePicker
        initImage={FILLED}
        initImageStrength={0.55}
        onStrengthChange={vi.fn()}
        onPick={vi.fn()}
        onClear={onClear}
      />,
    );
    expect(screen.getByText('cat.png')).toBeTruthy();
    expect(screen.getByText(/Strength 0.55/)).toBeTruthy();
    expect(screen.getByAltText('Init')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Remove init image'));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('fires onStrengthChange with a numeric value from the slider', () => {
    const onStrengthChange = vi.fn();
    const { container } = render(
      <InitImagePicker
        initImage={FILLED}
        initImageStrength={0.4}
        onStrengthChange={onStrengthChange}
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    const slider = container.querySelector('input[type="range"]');
    fireEvent.change(slider, { target: { value: '0.7' } });
    expect(onStrengthChange).toHaveBeenCalledWith(0.7);
  });

  it('disables the clear button and slider when disabled', () => {
    const { container } = render(
      <InitImagePicker
        initImage={FILLED}
        initImageStrength={0.4}
        onStrengthChange={vi.fn()}
        onPick={vi.fn()}
        onClear={vi.fn()}
        disabled
      />,
    );
    expect(screen.getByTitle('Remove init image').disabled).toBe(true);
    expect(container.querySelector('input[type="range"]').disabled).toBe(true);
  });
});
