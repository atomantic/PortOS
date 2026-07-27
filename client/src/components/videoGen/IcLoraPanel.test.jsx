import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import IcLoraPanel from './IcLoraPanel';
import { icLoraSpecForMode } from '../../lib/videoGenParams';

const SPEC = icLoraSpecForMode('ic-control');

const baseProps = {
  spec: SPEC,
  referenceFile: null,
  referenceVideoId: '',
  visibleHistory: [{ id: 'v1', prompt: 'a prior render', filename: 'v1.mp4' }],
  icStrength: 1,
  icSkipStage2: false,
  // Divisible by the Control weight's factor of 2 → no resolution warning.
  width: 704,
  height: 448,
  weightStatus: { id: 'ic-control', repo: 'org/weight', cached: true, sizeBytes: 654 * 1024 * 1024 },
  hasCompatibleModel: true,
  onPickFile: vi.fn(),
  onClearFile: vi.fn(),
  onPickHistory: vi.fn(),
  onStrengthChange: vi.fn(),
  onSkipStage2Change: vi.fn(),
  onDownloadWeight: vi.fn(),
  onCancelWeightDownload: vi.fn(),
};

describe('IcLoraPanel', () => {
  it('offers both an upload and a history pick when nothing is selected', () => {
    render(<IcLoraPanel {...baseProps} />);
    expect(screen.getByText(/Upload a control clip/i)).toBeTruthy();
    expect(screen.getByLabelText(/Pick a previous render as the Control reference/i)).toBeTruthy();
    expect(screen.queryByText('Clear')).toBeNull();
  });

  it('shows the picked upload name and hides the pickers', () => {
    const file = new File(['x'.repeat(1024)], 'depth.mp4', { type: 'video/mp4' });
    render(<IcLoraPanel {...baseProps} referenceFile={file} />);
    expect(screen.getByText('depth.mp4')).toBeTruthy();
    // Only one reference shape is valid per request, so the alternate inputs go
    // away rather than letting the user set both.
    expect(screen.queryByText(/Upload a control clip/i)).toBeNull();
    expect(screen.queryByLabelText(/Pick a previous render/i)).toBeNull();
  });

  it('fires onClearFile AND onPickHistory("") from Clear', () => {
    const onClearFile = vi.fn();
    const onPickHistory = vi.fn();
    render(
      <IcLoraPanel
        {...baseProps}
        referenceVideoId="v1"
        onClearFile={onClearFile}
        onPickHistory={onPickHistory}
      />,
    );
    fireEvent.click(screen.getByText('Clear'));
    // Both shapes clear together — a half-cleared state would submit the
    // survivor unknowingly.
    expect(onClearFile).toHaveBeenCalled();
    expect(onPickHistory).toHaveBeenCalledWith('');
  });

  it('warns when the resolution is not divisible by the reference-downscale factor', () => {
    render(<IcLoraPanel {...baseProps} width={705} />);
    expect(screen.getByText(/divisible by 2/i)).toBeTruthy();
  });

  it('does not warn on a divisible resolution', () => {
    render(<IcLoraPanel {...baseProps} />);
    expect(screen.queryByText(/divisible by 2/i)).toBeNull();
  });

  it('reports the strength dial and skip-stage-2 toggle', () => {
    const onStrengthChange = vi.fn();
    const onSkipStage2Change = vi.fn();
    render(
      <IcLoraPanel {...baseProps} onStrengthChange={onStrengthChange} onSkipStage2Change={onSkipStage2Change} />,
    );
    fireEvent.change(screen.getByLabelText(/Reference strength/i), { target: { value: '0.5' } });
    expect(onStrengthChange).toHaveBeenCalledWith(0.5);
    fireEvent.click(screen.getByLabelText(/Half-res preview/i));
    expect(onSkipStage2Change).toHaveBeenCalledWith(true);
  });

  it('surfaces the no-ltx2-model warning instead of the weight badge', () => {
    render(<IcLoraPanel {...baseProps} hasCompatibleModel={false} />);
    expect(screen.getByText(/requires an ltx2-runtime model/i)).toBeTruthy();
  });

  it('names the in-flight reference when a resumed render has no re-pickable clip', () => {
    render(<IcLoraPanel {...baseProps} inFlightReferenceNames={['depth.mp4']} />);
    expect(screen.getByText(/In-flight render is conditioned on depth\.mp4/i)).toBeTruthy();
  });
});

// ── Image-kind (Ingredients) surface (#3112) ───────────────────────────────
// referenceKind: 'image' swaps the single upload/history pair for a 2-8 gallery
// ROW list, modeled on KeyframePanel. Bounds are read off the spec, never
// hardcoded, so they can't disagree with what the route enforces.
describe('IcLoraPanel — image-kind references (#3112)', () => {
  const ING = icLoraSpecForMode('ic-ingredients');
  const imageProps = {
    ...baseProps,
    spec: ING,
    referenceImageFiles: ['owl.png', ''],
    visibleGallery: [
      { filename: 'owl.png' }, { filename: 'store.png' }, { filename: 'tote.png' },
    ],
    weightStatus: { id: 'ic-ingredients', repo: 'org/ingredients', cached: true, sizeBytes: 1_308_778_338 },
    onAddReferenceImage: vi.fn(),
    onUpdateReferenceImage: vi.fn(),
    onRemoveReferenceImage: vi.fn(),
  };

  it('renders one gallery row per reference, not the clip upload/history pair', () => {
    render(<IcLoraPanel {...imageProps} />);
    expect(screen.getByLabelText(/Ingredients reference 1 gallery image/i)).toBeTruthy();
    expect(screen.getByLabelText(/Ingredients reference 2 gallery image/i)).toBeTruthy();
    // The video-only inputs must be absent — offering them would let a clip ride
    // into an image-kind weight, which the route rejects.
    expect(screen.queryByText(/Upload a reference still/i)).toBeNull();
    expect(screen.queryByLabelText(/Pick a previous render/i)).toBeNull();
  });

  it('reports the picked gallery file through onUpdateReferenceImage', () => {
    const onUpdateReferenceImage = vi.fn();
    render(<IcLoraPanel {...imageProps} onUpdateReferenceImage={onUpdateReferenceImage} />);
    fireEvent.change(screen.getByLabelText(/Ingredients reference 2 gallery image/i), {
      target: { value: 'store.png' },
    });
    expect(onUpdateReferenceImage).toHaveBeenCalledWith(1, 'store.png');
  });

  it('shows the row count against the spec maximum', () => {
    render(<IcLoraPanel {...imageProps} />);
    expect(screen.getByText('2/8')).toBeTruthy();
  });

  it('disables Add at the spec maximum', () => {
    const eight = Array.from({ length: 8 }, (_, i) => `ref-${i}.png`);
    render(<IcLoraPanel {...imageProps} referenceImageFiles={eight} />);
    expect(screen.getByText(/Add reference/i).closest('button').disabled).toBe(true);
    expect(screen.getByText('8/8')).toBeTruthy();
  });

  it('disables Remove at the spec minimum so the list cannot go under 2', () => {
    render(<IcLoraPanel {...imageProps} referenceImageFiles={['a.png', 'b.png']} />);
    for (const i of [1, 2]) {
      expect(screen.getByLabelText(`Remove reference ${i}`).disabled).toBe(true);
    }
  });

  it('enables Remove above the minimum', () => {
    render(<IcLoraPanel {...imageProps} referenceImageFiles={['a.png', 'b.png', 'c.png']} />);
    expect(screen.getByLabelText('Remove reference 1').disabled).toBe(false);
  });

  it('never warns about resolution (factor 1 imposes no rule)', () => {
    // Ingredients' safetensors metadata reports reference_downscale_factor=1, so
    // an odd resolution is legal — a copied factor-2 rule would block it for
    // nothing.
    render(<IcLoraPanel {...imageProps} width={705} height={449} />);
    expect(screen.queryByText(/divisible by/i)).toBeNull();
  });

  it('explains the gated repo + automatic mirror fallback when un-cached', () => {
    render(<IcLoraPanel {...imageProps} weightStatus={{ ...imageProps.weightStatus, cached: false, gated: true }} />);
    expect(screen.getByText(/falls back to the un-gated mirror/i)).toBeTruthy();
  });

  it('omits the gated notice once the weight is cached', () => {
    render(<IcLoraPanel {...imageProps} weightStatus={{ ...imageProps.weightStatus, cached: true, gated: true }} />);
    expect(screen.queryByText(/falls back to the un-gated mirror/i)).toBeNull();
  });
});
