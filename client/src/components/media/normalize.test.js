import { describe, it, expect } from 'vitest';
import { getRenderConfigForItem, normalizeImage, normalizeVideo } from './normalize.js';

// These tests pin the sidecar field-name knowledge in normalize.js. If a new
// field surfaces in a render sidecar, surface it here so the requeue path in
// <PromptRefineModal> stays in lockstep with the writers.

describe('getRenderConfigForItem - image', () => {
  it('returns empty object for null/undefined', () => {
    expect(getRenderConfigForItem(null)).toEqual({});
    expect(getRenderConfigForItem(undefined)).toEqual({});
  });

  it('returns empty object for unknown kind', () => {
    expect(getRenderConfigForItem({ kind: 'audio' })).toEqual({});
  });

  it('reads camelCase sidecar fields directly', () => {
    const image = normalizeImage({
      filename: 'a.png',
      prompt: 'a cat',
      width: 512,
      height: 512,
      steps: 20,
      guidance: 7.5,
      seed: 42,
      quantize: 8,
      mode: 'local',
      modelId: 'flux',
      cfgScale: 6.5,
      loraFilenames: ['lora-x.safetensors'],
      loraScales: [0.8],
    });
    const cfg = getRenderConfigForItem(image);
    expect(cfg).toMatchObject({
      mode: 'local',
      modelId: 'flux',
      width: 512,
      height: 512,
      steps: 20,
      guidance: 7.5,
      cfgScale: 6.5,
      seed: 42,
      quantize: 8,
      loraFilenames: ['lora-x.safetensors'],
      loraScales: [0.8],
    });
  });

  it('falls back to snake_case sidecar fields when camelCase missing', () => {
    // Simulate a sidecar written by the Python pipeline (snake_case).
    const image = normalizeImage({
      filename: 'b.png',
      prompt: 'a dog',
      width: 1024,
      height: 1024,
      modelId: 'flux2',
      mode: 'local',
      cfg_scale: 5.5,
      lora_filenames: ['lora-y.safetensors'],
      lora_scales: [1.0],
    });
    const cfg = getRenderConfigForItem(image);
    expect(cfg.cfgScale).toBe(5.5);
    expect(cfg.loraFilenames).toEqual(['lora-y.safetensors']);
    expect(cfg.loraScales).toEqual([1.0]);
  });

  it('prefers camelCase over snake_case when both present', () => {
    // Drift-safety: a re-emit of an older sidecar could carry both shapes.
    // The newer convention (camelCase) wins so the most recently set value
    // doesn't get shadowed by a stale snake_case alias.
    const image = normalizeImage({
      filename: 'c.png',
      prompt: '',
      cfgScale: 7,
      cfg_scale: 9,
      loraFilenames: ['new.safetensors'],
      lora_filenames: ['old.safetensors'],
    });
    const cfg = getRenderConfigForItem(image);
    expect(cfg.cfgScale).toBe(7);
    expect(cfg.loraFilenames).toEqual(['new.safetensors']);
  });

  it('defaults mode to "local" when item.mode unset', () => {
    const image = normalizeImage({ filename: 'd.png', prompt: '' });
    const cfg = getRenderConfigForItem(image);
    expect(cfg.mode).toBe('local');
  });

  it('falls back to legacy loraPaths when loraFilenames is absent', () => {
    // Older sidecars (pre-refactor) only persisted absolute loraPaths. The
    // server image-gen route still accepts that legacy field, but the
    // requeue payload from <PromptRefineModal> uses loraFilenames. Derive
    // basenames so legacy items don't lose their LoRA configuration on
    // refine-and-resubmit.
    const image = normalizeImage({
      filename: 'e.png',
      prompt: '',
      loraPaths: ['/abs/path/to/oldLora.safetensors', '/other/dir/styleA.safetensors'],
    });
    const cfg = getRenderConfigForItem(image);
    expect(cfg.loraFilenames).toEqual(['oldLora.safetensors', 'styleA.safetensors']);
  });

  it('falls back to legacy snake-case lora_paths', () => {
    const image = normalizeImage({
      filename: 'f.png',
      prompt: '',
      lora_paths: ['C:\\loras\\winLora.safetensors'],
    });
    const cfg = getRenderConfigForItem(image);
    expect(cfg.loraFilenames).toEqual(['winLora.safetensors']);
  });
});

describe('normalize loraNames - snake_case sidecar coverage', () => {
  // MediaCard chips/search read `item.loraNames`; these must surface for
  // sidecars written in any of the four supported field shapes so the UI
  // doesn't silently drop LoRA badges for legacy / Python-written records.

  it('image: surfaces snake_case lora_filenames in loraNames', () => {
    const image = normalizeImage({
      filename: 'a.png',
      prompt: '',
      lora_filenames: ['lora-snake.safetensors'],
    });
    expect(image.loraNames).toEqual(['lora-snake.safetensors']);
  });

  it('image: surfaces snake_case lora_paths in loraNames as basenames', () => {
    const image = normalizeImage({
      filename: 'b.png',
      prompt: '',
      lora_paths: ['/abs/path/oldStyle.safetensors'],
    });
    expect(image.loraNames).toEqual(['oldStyle.safetensors']);
  });

  it('video: surfaces snake_case lora_filenames in loraNames', () => {
    const video = normalizeVideo({
      id: 'v1',
      filename: 'a.mp4',
      prompt: '',
      lora_filenames: ['lora-cinematic.safetensors'],
    });
    expect(video.loraNames).toEqual(['lora-cinematic.safetensors']);
  });
});

describe('getRenderConfigForItem - video', () => {
  it('reads camelCase sidecar fields directly', () => {
    const video = normalizeVideo({
      id: 'v1',
      filename: 'a.mp4',
      prompt: 'pan',
      width: 720,
      height: 480,
      numFrames: 64,
      fps: 24,
      modelId: 'ltx',
      mode: 'text',
      steps: 30,
      guidanceScale: 3.5,
      seed: 100,
      tiling: true,
      disableAudio: false,
      loraFilenames: ['lora-cinematic.safetensors'],
      loraScales: [0.9],
    });
    const cfg = getRenderConfigForItem(video);
    expect(cfg).toMatchObject({
      mode: 'text',
      modelId: 'ltx',
      width: 720,
      height: 480,
      numFrames: 64,
      fps: 24,
      steps: 30,
      guidanceScale: 3.5,
      seed: 100,
      tiling: true,
      disableAudio: false,
      loraFilenames: ['lora-cinematic.safetensors'],
      loraScales: [0.9],
    });
  });

  it('falls back to snake_case sidecar fields when camelCase missing', () => {
    const video = normalizeVideo({
      id: 'v2',
      filename: 'b.mp4',
      prompt: '',
      modelId: 'ltx',
      mode: 'text',
      steps: 25,
      guidance_scale: 2.0,
      disable_audio: true,
      lora_filenames: ['lora-z.safetensors'],
      lora_scales: [0.5],
    });
    const cfg = getRenderConfigForItem(video);
    expect(cfg.guidanceScale).toBe(2.0);
    expect(cfg.disableAudio).toBe(true);
    expect(cfg.loraFilenames).toEqual(['lora-z.safetensors']);
    expect(cfg.loraScales).toEqual([0.5]);
  });

  it('preserves a deliberate guidanceScale of 0', () => {
    // 0 is a valid setting for some video models — must not be coerced via
    // truthy fallback.
    const video = normalizeVideo({ id: 'v3', filename: 'c.mp4', prompt: '', guidanceScale: 0 });
    const cfg = getRenderConfigForItem(video);
    expect(cfg.guidanceScale).toBe(0);
  });

  it('falls back to legacy `guidance` if neither guidanceScale variant present', () => {
    const video = normalizeVideo({ id: 'v4', filename: 'd.mp4', prompt: '', guidance: 4.2 });
    const cfg = getRenderConfigForItem(video);
    expect(cfg.guidanceScale).toBe(4.2);
  });

  it('defaults mode to "text" when item.mode unset', () => {
    const video = normalizeVideo({ id: 'v5', filename: 'e.mp4', prompt: '' });
    const cfg = getRenderConfigForItem(video);
    expect(cfg.mode).toBe('text');
  });
});
