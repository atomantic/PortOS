import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ImageGenControls from './ImageGenControls';
import { IMAGE_GEN_MODE } from '../../lib/imageGenBackends';

const MODELS = [{ id: 'z-image-turbo', name: 'Z-Image-Turbo', runner: 'z_image' }];

// Minimal shared props — every consumer routes resolution through onResolutionChange.
const baseProps = (overrides = {}) => ({
  mode: IMAGE_GEN_MODE.LOCAL,
  models: MODELS,
  modelId: 'z-image-turbo',
  onResolutionChange: vi.fn(),
  ...overrides,
});

describe('ImageGenControls — custom dimensions', () => {
  it('hides the width/height inputs when the size matches a preset', () => {
    render(<ImageGenControls {...baseProps({ width: 1024, height: 1024 })} />);
    expect(screen.queryByLabelText('Width')).toBeNull();
    expect(screen.queryByLabelText('Height')).toBeNull();
  });

  it('reveals width/height inputs when "Custom…" is selected', () => {
    render(<ImageGenControls {...baseProps({ width: 1024, height: 1024 })} />);
    fireEvent.change(screen.getByLabelText('Resolution'), { target: { value: '__custom__' } });
    expect(screen.getByLabelText('Width')).toBeTruthy();
    expect(screen.getByLabelText('Height')).toBeTruthy();
  });

  it('auto-shows the inputs when the current size matches no preset (e.g. 704×1280)', () => {
    render(<ImageGenControls {...baseProps({ width: 704, height: 1280 })} />);
    expect(screen.getByLabelText('Width').value).toBe('704');
    expect(screen.getByLabelText('Height').value).toBe('1280');
  });

  it('emits the new width while preserving height', () => {
    const onResolutionChange = vi.fn();
    render(<ImageGenControls {...baseProps({ width: 704, height: 1280, onResolutionChange })} />);
    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '832' } });
    expect(onResolutionChange).toHaveBeenLastCalledWith(832, 1280);
  });

  it('clamps a below-minimum edge up to 64 on blur', () => {
    const onResolutionChange = vi.fn();
    render(<ImageGenControls {...baseProps({ width: 10, height: 1280, onResolutionChange })} />);
    fireEvent.blur(screen.getByLabelText('Width'));
    expect(onResolutionChange).toHaveBeenLastCalledWith(64, 1280);
  });

  it('warns when the total pixel count exceeds the cap', () => {
    render(<ImageGenControls {...baseProps({ width: 3840, height: 3840 })} />);
    expect(screen.getByText(/exceeds the .* px cap/i)).toBeTruthy();
  });

  // Regression: an auto-engaged (non-preset) size must stay in custom mode when a
  // field is cleared to a transient 0 mid-edit — otherwise the inputs unmount
  // mid-keystroke and the blur-snap never fires. Uses a stateful harness so the
  // cleared value actually re-renders the component.
  it('keeps the custom inputs mounted when a dimension is cleared mid-edit', () => {
    function Harness() {
      const [dims, setDims] = useState({ width: 704, height: 1280 });
      return (
        <ImageGenControls
          {...baseProps({
            width: dims.width,
            height: dims.height,
            onResolutionChange: (w, h) => setDims({ width: w, height: h }),
          })}
        />
      );
    }
    render(<Harness />);
    // Auto-engaged (704×1280 matches no preset) → inputs visible.
    expect(screen.getByLabelText('Height')).toBeTruthy();
    // Clear Height → emits 0 → re-render with height=0.
    fireEvent.change(screen.getByLabelText('Height'), { target: { value: '' } });
    // Sticky latch keeps both inputs mounted despite height=0.
    expect(screen.getByLabelText('Width')).toBeTruthy();
    expect(screen.getByLabelText('Height')).toBeTruthy();
  });
});
