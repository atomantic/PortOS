import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AdvancedParamsPanel from './AdvancedParamsPanel';

// Every model reaching the client carries a server-resolved `supportedModes`
// (server/lib/videoModeProfiles.js, #3737) — fixtures carry it as payloads do.
const MLX_MODES = ['text', 'image', 'fflf', 'extend'];

const baseProps = {
  mode: 'text',
  currentModel: { steps: 30, guidance: 3.0, runtime: 'mlx_video', supportedModes: MLX_MODES },
  numFrames: 121, onNumFramesChange: vi.fn(),
  chunks: 1, onChunksChange: vi.fn(), keyframesActive: false,
  chunkPrompts: [], onChunkPromptChange: vi.fn(), chainingActive: false,
  fps: 24, onFpsChange: vi.fn(),
  seed: '', onSeedChange: vi.fn(), onRandomSeed: vi.fn(),
  steps: '', onStepsChange: vi.fn(),
  guidanceScale: '', onGuidanceScaleChange: vi.fn(),
  imageStrength: '', onImageStrengthChange: vi.fn(),
  tiling: 'auto', onTilingChange: vi.fn(),
  disableAudio: false, onDisableAudioChange: vi.fn(),
  noMusic: false, onNoMusicChange: vi.fn(),
};

const renderPanel = (props = {}) => render(<AdvancedParamsPanel {...baseProps} {...props} />);
const toggle = () => screen.getByRole('button', { name: /Advanced/i });

describe('AdvancedParamsPanel', () => {
  it('starts collapsed so the Generate button stays above the fold', () => {
    renderPanel();
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByLabelText('Frames')).toBeNull();
    expect(screen.queryByLabelText('FPS')).toBeNull();
    expect(screen.queryByLabelText('Seed')).toBeNull();
    expect(screen.queryByLabelText('Tiling')).toBeNull();
  });

  it('summarizes the hidden values while collapsed', () => {
    renderPanel({ numFrames: 121, fps: 24, seed: '42' });
    expect(screen.getByText(/121f @ 24fps/)).toBeTruthy();
    expect(screen.getByText(/5\.0s/)).toBeTruthy();
    expect(screen.getByText(/seed 42/)).toBeTruthy();
  });

  it('reads "random" in the summary when no seed is pinned', () => {
    renderPanel({ seed: '' });
    expect(screen.getByText(/seed random/)).toBeTruthy();
  });

  it('reveals every sampler knob when expanded', () => {
    renderPanel();
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByLabelText('Frames')).toBeTruthy();
    expect(screen.getByLabelText('Chunks')).toBeTruthy();
    expect(screen.getByLabelText('FPS')).toBeTruthy();
    expect(screen.getByLabelText('Seed')).toBeTruthy();
    expect(screen.getByLabelText(/Steps/)).toBeTruthy();
    expect(screen.getByLabelText(/CFG Scale/)).toBeTruthy();
    expect(screen.getByLabelText('Tiling')).toBeTruthy();
    expect(screen.getByText(/Disable audio/)).toBeTruthy();
    expect(screen.getByText(/No music/)).toBeTruthy();
  });

  it('collapses again on a second click', () => {
    renderPanel();
    fireEvent.click(toggle());
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByLabelText('Frames')).toBeNull();
  });

  it('propagates edits to the page handlers', () => {
    const onFpsChange = vi.fn();
    const onStepsChange = vi.fn();
    const onTilingChange = vi.fn();
    renderPanel({ onFpsChange, onStepsChange, onTilingChange });
    fireEvent.click(toggle());
    fireEvent.change(screen.getByLabelText('FPS'), { target: { value: '30' } });
    expect(onFpsChange).toHaveBeenCalledWith(30);
    fireEvent.change(screen.getByLabelText(/Steps/), { target: { value: '40' } });
    expect(onStepsChange).toHaveBeenCalledWith('40');
    fireEvent.change(screen.getByLabelText('Tiling'), { target: { value: 'none' } });
    expect(onTilingChange).toHaveBeenCalledWith('none');
  });

  it('fires onRandomSeed from the dice button', () => {
    const onRandomSeed = vi.fn();
    renderPanel({ onRandomSeed });
    fireEvent.click(toggle());
    fireEvent.click(screen.getByTitle('Randomize seed'));
    expect(onRandomSeed).toHaveBeenCalled();
  });

  it('hides chunks + the audio flags in a2v mode', () => {
    renderPanel({ mode: 'a2v' });
    fireEvent.click(toggle());
    expect(screen.queryByLabelText('Chunks')).toBeNull();
    expect(screen.queryByText(/Disable audio/)).toBeNull();
    expect(screen.queryByText(/No music/)).toBeNull();
    // The rest of the knobs still apply.
    expect(screen.getByLabelText('Frames')).toBeTruthy();
  });

  it('hides chunks for a Wan profile that cannot continue via image mode', () => {
    renderPanel({
      currentModel: { runtime: 'wan22', supportedModes: ['text'], frameStride: 4 },
    });
    fireEvent.click(toggle());
    expect(screen.queryByLabelText('Chunks')).toBeNull();
  });

  it('locks chunks to 1 while multi-keyframe mode is active', () => {
    renderPanel({ chunks: 4, keyframesActive: true });
    fireEvent.click(toggle());
    const select = screen.getByLabelText('Chunks');
    expect(select.value).toBe('1');
    expect(select.disabled).toBe(true);
  });

  it('shows image strength only where it applies', () => {
    const { unmount } = renderPanel({ mode: 'text' });
    fireEvent.click(toggle());
    expect(screen.queryByLabelText('Image Strength')).toBeNull();
    unmount();

    renderPanel({ mode: 'image' });
    fireEvent.click(toggle());
    expect(screen.getByLabelText('Image Strength')).toBeTruthy();
  });

  it('hides image strength for an ltx2 extend render', () => {
    const { unmount } = renderPanel({ mode: 'extend', currentModel: { runtime: 'ltx2', supportedModes: MLX_MODES } });
    fireEvent.click(toggle());
    expect(screen.queryByLabelText('Image Strength')).toBeNull();
    unmount();

    renderPanel({ mode: 'extend', currentModel: { runtime: 'mlx_video', supportedModes: MLX_MODES } });
    fireEvent.click(toggle());
    expect(screen.getByLabelText('Image Strength')).toBeTruthy();
  });

  it('disables the no-music flag when audio is off entirely', () => {
    renderPanel({ disableAudio: true });
    fireEvent.click(toggle());
    expect(screen.getByLabelText(/No music/).disabled).toBe(true);
  });

  it('hides LTX audio controls and Extend advice for a text-only joint-A/V model', () => {
    renderPanel({
      numFrames: 362,
      currentModel: {
        runtime: 'minimax_h3',
        supportedModes: ['text'],
        frameOptions: [124, 243, 362],
        supportsDisableAudio: false,
      },
    });
    fireEvent.click(toggle());
    expect(screen.queryByText(/Disable audio/)).toBeNull();
    expect(screen.queryByText(/No music/)).toBeNull();
    expect(screen.queryByText(/use Extend/i)).toBeNull();
  });

  it('keeps the long-render Extend guidance for models that support Extend', () => {
    renderPanel({ numFrames: 313, currentModel: { runtime: 'ltx2', supportedModes: MLX_MODES } });
    fireEvent.click(toggle());
    expect(screen.getByText(/Past 241 frames/i)).toBeInTheDocument();
  });

  describe('per-chunk prompt beats (#3695)', () => {
    it('hides the beat editor when the request does not chain', () => {
      renderPanel({ chunks: 4, chainingActive: false });
      fireEvent.click(toggle());
      expect(screen.queryByLabelText('Chunk 1')).toBeNull();
    });

    it('renders one beat row per live chunk, prefilled from the parent', () => {
      renderPanel({ chunks: 3, chainingActive: true, chunkPrompts: ['first', '', 'third'] });
      fireEvent.click(toggle());
      expect(screen.getByLabelText('Chunk 1').value).toBe('first');
      expect(screen.getByLabelText('Chunk 2').value).toBe('');
      expect(screen.getByLabelText('Chunk 3').value).toBe('third');
      expect(screen.queryByLabelText('Chunk 4')).toBeNull();
    });

    it('shows only the live chunks even when the parent holds text for more', () => {
      // The parent never truncates its array (so raising the count restores the
      // text) — the editor is what scopes the view to the current chunk count.
      renderPanel({ chunks: 2, chainingActive: true, chunkPrompts: ['a', 'b', 'c'] });
      fireEvent.click(toggle());
      expect(screen.getByLabelText('Chunk 2').value).toBe('b');
      expect(screen.queryByLabelText('Chunk 3')).toBeNull();
    });

    it('reports edits by chunk index', () => {
      const onChunkPromptChange = vi.fn();
      renderPanel({ chunks: 2, chainingActive: true, onChunkPromptChange });
      fireEvent.click(toggle());
      fireEvent.change(screen.getByLabelText('Chunk 2'), { target: { value: 'the storm breaks' } });
      expect(onChunkPromptChange).toHaveBeenCalledWith(1, 'the storm breaks');
    });
  });
});
