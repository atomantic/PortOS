import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ResolutionField from './ResolutionField';

const IMAGE_PRESETS = [
  { label: '1024×1024', w: 1024, h: 1024 },
  { label: '832×1216 (Flux portrait)', w: 832, h: 1216 },
];
const VIDEO_PRESETS = [
  { label: '768×512 (3:2 default)', w: 768, h: 512 },
  { label: '1024×576 (16:9)', w: 1024, h: 576 },
];

const imageBounds = { min: 64, max: 3840, step: 8, maxPixels: 8_294_400 };
const videoBounds = { min: 64, max: 2048, step: 64, snapOnBlur: true };

describe('ResolutionField — preset dropdown', () => {
  it('renders every preset plus a Custom… sentinel option', () => {
    render(<ResolutionField presets={IMAGE_PRESETS} width={1024} height={1024} onChange={vi.fn()} {...imageBounds} />);
    expect(screen.getByRole('option', { name: 'Custom…' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '1024×1024' })).toBeTruthy();
  });

  it('emits w/h when a preset is chosen', () => {
    const onChange = vi.fn();
    render(<ResolutionField presets={IMAGE_PRESETS} width={1024} height={1024} onChange={onChange} {...imageBounds} />);
    fireEvent.change(screen.getByLabelText('Resolution'), { target: { value: '832×1216 (Flux portrait)' } });
    expect(onChange).toHaveBeenCalledWith(832, 1216);
  });
});

describe('ResolutionField — custom W×H', () => {
  it('hides the inputs when the size matches a preset', () => {
    render(<ResolutionField presets={IMAGE_PRESETS} width={1024} height={1024} onChange={vi.fn()} {...imageBounds} />);
    expect(screen.queryByLabelText('Width')).toBeNull();
    expect(screen.queryByLabelText('Height')).toBeNull();
  });

  it('reveals the inputs when Custom… is selected', () => {
    render(<ResolutionField presets={IMAGE_PRESETS} width={1024} height={1024} onChange={vi.fn()} {...imageBounds} />);
    fireEvent.change(screen.getByLabelText('Resolution'), { target: { value: '__custom__' } });
    expect(screen.getByLabelText('Width')).toBeTruthy();
    expect(screen.getByLabelText('Height')).toBeTruthy();
  });

  it('auto-shows the inputs for an off-preset size', () => {
    render(<ResolutionField presets={IMAGE_PRESETS} width={704} height={1280} onChange={vi.fn()} {...imageBounds} />);
    expect(screen.getByLabelText('Width').value).toBe('704');
    expect(screen.getByLabelText('Height').value).toBe('1280');
  });

  it('emits the new width while preserving height', () => {
    const onChange = vi.fn();
    render(<ResolutionField presets={IMAGE_PRESETS} width={704} height={1280} onChange={onChange} {...imageBounds} />);
    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '832' } });
    expect(onChange).toHaveBeenLastCalledWith(832, 1280);
  });

  it('clamps a below-minimum edge up to min on blur', () => {
    const onChange = vi.fn();
    render(<ResolutionField presets={IMAGE_PRESETS} width={10} height={1280} onChange={onChange} {...imageBounds} />);
    fireEvent.blur(screen.getByLabelText('Width'));
    expect(onChange).toHaveBeenLastCalledWith(64, 1280);
  });

  it('snaps a video edge down to the step multiple on blur (snapOnBlur)', () => {
    const onChange = vi.fn();
    render(<ResolutionField presets={VIDEO_PRESETS} width={700} height={512} onChange={onChange} {...videoBounds} />);
    fireEvent.blur(screen.getByLabelText('Width'));
    // 700 → floor to nearest multiple of 64 → 640
    expect(onChange).toHaveBeenLastCalledWith(640, 512);
  });

  it('does NOT snap an image edge to the step multiple on blur (clamp only)', () => {
    const onChange = vi.fn();
    // 705 is in-bounds and not a multiple of 8; image must preserve it exactly.
    render(<ResolutionField presets={IMAGE_PRESETS} width={705} height={1024} onChange={onChange} {...imageBounds} />);
    fireEvent.blur(screen.getByLabelText('Width'));
    expect(onChange).toHaveBeenLastCalledWith(705, 1024);
  });

  it('warns when total pixels exceed the cap (image only)', () => {
    render(<ResolutionField presets={IMAGE_PRESETS} width={3840} height={3840} onChange={vi.fn()} {...imageBounds} />);
    expect(screen.getByText(/exceeds the .* px cap/i)).toBeTruthy();
  });

  it('shows no pixel-cap note when maxPixels is omitted (video)', () => {
    render(<ResolutionField presets={VIDEO_PRESETS} width={700} height={512} onChange={vi.fn()} {...videoBounds} />);
    expect(screen.queryByText(/px cap/i)).toBeNull();
    // Default bounds-derived note, no total-pixel clause.
    expect(screen.getByText(/Each edge 64–2048px\. Multiples of 64/i)).toBeTruthy();
  });

  it('renders a custom note override when provided', () => {
    render(<ResolutionField presets={VIDEO_PRESETS} width={700} height={512} onChange={vi.fn()} note="rounds down to 64" {...videoBounds} />);
    expect(screen.getByText('rounds down to 64')).toBeTruthy();
  });

  it('keeps the inputs mounted when a dimension is cleared mid-edit', () => {
    function Harness() {
      const [dims, setDims] = useState({ width: 704, height: 1280 });
      return (
        <ResolutionField
          presets={IMAGE_PRESETS}
          width={dims.width}
          height={dims.height}
          onChange={(w, h) => setDims({ width: w, height: h })}
          {...imageBounds}
        />
      );
    }
    render(<Harness />);
    expect(screen.getByLabelText('Height')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Height'), { target: { value: '' } });
    expect(screen.getByLabelText('Width')).toBeTruthy();
    expect(screen.getByLabelText('Height')).toBeTruthy();
  });
});
