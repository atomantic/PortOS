import { describe, expect, it } from 'vitest';
import {
  EXECUTION_LANE,
  OUTPUT_KIND,
  IMAGE_TO_3D_TARGETS,
  IMAGE_TO_3D_TARGET_IDS,
  DEFAULT_IMAGE_TO_3D_TARGET,
  getTarget,
  unavailableReason,
  isTargetAvailable,
  resolveTarget,
  listTargets,
  detectHostCapabilities,
  renderOptionSupportFor,
} from './targets.js';

// A host that can run TRELLIS.2's local-MPS lane, and one that can't.
const APPLE_128GB = { appleSilicon: true, unifiedMemoryGb: 128, cuda: false, cudaProbe: 'absent' };
const APPLE_16GB = { appleSilicon: true, unifiedMemoryGb: 16, cuda: false, cudaProbe: 'absent' };
const INTEL_MAC = { appleSilicon: false, unifiedMemoryGb: 64, cuda: false, cudaProbe: 'absent' };
// A Linux box with a 24 GB card — the supported host for the local-CUDA lane.
const CUDA_BOX = {
  appleSilicon: false, unifiedMemoryGb: 64, linuxHost: true,
  cuda: true, cudaVramGb: 24, cudaProbe: 'available',
};

describe('image-to-3d target registry', () => {
  it('registers trellis2 as the default target with a stable descriptor shape', () => {
    expect(DEFAULT_IMAGE_TO_3D_TARGET).toBe('trellis2');
    expect(IMAGE_TO_3D_TARGET_IDS).toContain('trellis2');
    const t = getTarget('trellis2');
    expect(t).toMatchObject({
      id: 'trellis2',
      label: 'TRELLIS.2',
      executionLane: EXECUTION_LANE.LOCAL_MPS,
      outputKind: OUTPUT_KIND.GLB_MESH,
    });
    expect(t.requires).toMatchObject({ appleSilicon: true, minUnifiedMemoryGb: 24 });
    expect(t.gatedRepos).toEqual([
      {
        label: 'facebook/dinov3-vitl16-pretrain-lvd1689m',
        url: 'https://huggingface.co/facebook/dinov3-vitl16-pretrain-lvd1689m',
      },
      {
        label: 'briaai/RMBG-2.0',
        url: 'https://huggingface.co/briaai/RMBG-2.0',
      },
    ]);
  });

  it('registers trellis2Cuda on the local-cuda lane with upstream’s stated floor', () => {
    expect(IMAGE_TO_3D_TARGET_IDS).toContain('trellis2Cuda');
    const t = getTarget('trellis2Cuda');
    expect(t).toMatchObject({
      id: 'trellis2Cuda',
      executionLane: EXECUTION_LANE.LOCAL_CUDA,
      outputKind: OUTPUT_KIND.GLB_MESH,
      upstream: 'https://github.com/microsoft/TRELLIS.2',
    });
    // Upstream: "An NVIDIA GPU with at least 24GB of memory is necessary" and
    // "currently tested only on Linux".
    expect(t.requires).toMatchObject({ cuda: true, minVramGb: 24, linuxHost: true });
    // Unlike the MPS port, this lane does not pull RMBG-2.0 — only DINOv3 is gated.
    expect(t.gatedRepos.map((r) => r.label)).toEqual(['facebook/dinov3-vitl16-pretrain-lvd1689m']);
  });

  it('leaves trellis2 (MPS) as the default target', () => {
    // Adding the CUDA lane must not change which target an unqualified request gets.
    expect(DEFAULT_IMAGE_TO_3D_TARGET).toBe('trellis2');
  });

  it('freezes the registry and its descriptors so a target cannot be mutated at runtime', () => {
    expect(Object.isFrozen(IMAGE_TO_3D_TARGETS)).toBe(true);
    expect(Object.isFrozen(IMAGE_TO_3D_TARGETS.trellis2)).toBe(true);
    expect(Object.isFrozen(IMAGE_TO_3D_TARGETS.trellis2.gatedRepos)).toBe(true);
    expect(Object.isFrozen(IMAGE_TO_3D_TARGETS.trellis2.gatedRepos[0])).toBe(true);
    expect(() => {
      IMAGE_TO_3D_TARGETS.trellis2.label = 'hacked';
    }).toThrow();
    expect(getTarget('trellis2').label).toBe('TRELLIS.2');
  });

  it('returns null for an unknown target id', () => {
    expect(getTarget('does-not-exist')).toBeNull();
    expect(getTarget('')).toBeNull();
    expect(getTarget(undefined)).toBeNull();
  });
});

describe('unavailableReason / isTargetAvailable (local-mps gating)', () => {
  it('is available on Apple Silicon with enough memory', () => {
    expect(unavailableReason('trellis2', APPLE_128GB)).toBeNull();
    expect(isTargetAvailable('trellis2', APPLE_128GB)).toBe(true);
  });

  it('is available at exactly the memory floor', () => {
    expect(isTargetAvailable('trellis2', { appleSilicon: true, unifiedMemoryGb: 24 })).toBe(true);
  });

  it('reports requires-apple-silicon on a non-Apple-Silicon host', () => {
    expect(unavailableReason('trellis2', INTEL_MAC)).toBe('requires-apple-silicon');
    expect(isTargetAvailable('trellis2', INTEL_MAC)).toBe(false);
  });

  it('reports insufficient-memory on an under-spec Apple Silicon host', () => {
    expect(unavailableReason('trellis2', APPLE_16GB)).toBe('insufficient-memory');
    expect(isTargetAvailable('trellis2', APPLE_16GB)).toBe(false);
  });

  it('reports unknown-target for an unregistered id', () => {
    expect(unavailableReason('nope', APPLE_128GB)).toBe('unknown-target');
    expect(isTargetAvailable('nope', APPLE_128GB)).toBe(false);
  });

  it('treats absent capabilities as un-runnable rather than throwing', () => {
    expect(unavailableReason('trellis2')).toBe('requires-apple-silicon');
    expect(isTargetAvailable('trellis2', {})).toBe(false);
  });
});

describe('resolveTarget', () => {
  it('resolves the requested target when available', () => {
    expect(resolveTarget('trellis2', APPLE_128GB)).toMatchObject({
      targetId: 'trellis2',
      available: true,
      reason: null,
    });
  });

  it('falls back to the default target id when none requested', () => {
    const r = resolveTarget(undefined, APPLE_128GB);
    expect(r.targetId).toBe(DEFAULT_IMAGE_TO_3D_TARGET);
    expect(r.available).toBe(true);
  });

  it('returns the target with an unavailable verdict rather than silently swapping models', () => {
    const r = resolveTarget('trellis2', APPLE_16GB);
    expect(r.targetId).toBe('trellis2');
    expect(r.target).not.toBeNull();
    expect(r.available).toBe(false);
    expect(r.reason).toBe('insufficient-memory');
  });

  it('reports unknown-target with a null descriptor for a bad id', () => {
    const r = resolveTarget('ghost', APPLE_128GB);
    expect(r).toMatchObject({ targetId: 'ghost', target: null, available: false, reason: 'unknown-target' });
  });

  it('honors a custom defaultId', () => {
    const r = resolveTarget(undefined, APPLE_128GB, { defaultId: 'trellis2' });
    expect(r.targetId).toBe('trellis2');
  });
});

describe('listTargets', () => {
  it('annotates every registered target with availability for the host', () => {
    const available = listTargets(APPLE_128GB);
    expect(available.find((t) => t.id === 'trellis2')).toMatchObject({
      available: true,
      unavailableReason: null,
      gatedRepos: IMAGE_TO_3D_TARGETS.trellis2.gatedRepos,
    });

    // A blocked-but-listed target keeps its reason for the UI to render.
    const blocked = listTargets({ ...CUDA_BOX, linuxHost: false });
    expect(blocked.find((t) => t.id === 'trellis2Cuda')).toMatchObject({
      available: false,
      unavailableReason: 'requires-linux-host',
    });
  });

  it('hides a target blocked for hardware the host simply does not have', () => {
    // A Mac has no NVIDIA GPU and never will — a permanently-red CUDA card is noise.
    expect(listTargets(APPLE_128GB).map((t) => t.id)).toEqual(['trellis2']);
  });

  it('applies that hiding symmetrically, not just to the newer lane', () => {
    // The mirror of the case above: an NVIDIA box is no more able to grow an Apple
    // Silicon chip than a Mac is to grow a GPU, so neither gets a dead card. Asserted
    // as "no MPS target" rather than an exact list, so registering another CUDA target
    // doesn't churn this test — the property under test is the hiding, not the roster.
    const ids = listTargets(CUDA_BOX).map((t) => t.id);
    expect(ids).not.toContain('trellis2');
    expect(ids).toContain('trellis2Cuda');
  });

  it('lists the CUDA targets independently, per their diverged VRAM floors', () => {
    // The two CUDA lanes no longer share a floor: TRELLIS.2 needs 24 GB, while
    // Pixal3D's low-VRAM mode renders from 12. A 16 GB card must therefore see
    // exactly one of them — the whole reason `insufficient-vram` stopped naming a
    // single GB figure.
    const small = listTargets({ ...CUDA_BOX, cudaVramGb: 16 }).map((t) => t.id);
    expect(small).toContain('pixal3dCuda');
    expect(small).not.toContain('trellis2Cuda');

    const big = listTargets({ ...CUDA_BOX, cudaVramGb: 48 }).map((t) => t.id);
    expect(big).toEqual(expect.arrayContaining(['trellis2Cuda', 'pixal3dCuda']));
  });

  it('still SHOWS a target when the blocker is one the user can fix', () => {
    // Windows + a qualifying card: the lane is reachable via WSL2, so the card must
    // appear with that actionable reason rather than vanish.
    const shown = listTargets({ ...CUDA_BOX, linuxHost: false });
    expect(shown.find((t) => t.id === 'trellis2Cuda')).toMatchObject({
      available: false,
      unavailableReason: 'requires-linux-host',
    });
  });

  it('shows a target whose GPU could not be probed rather than hiding it', () => {
    // "Couldn't tell" is worth surfacing — it only arises on a host that has a driver.
    const shown = listTargets({
      appleSilicon: false, linuxHost: true, cuda: false, cudaProbe: 'unknown',
    });
    expect(shown.find((t) => t.id === 'trellis2Cuda')?.unavailableReason).toBe('cuda-probe-failed');
  });

  it('lists the CUDA target as available on a supported Linux + 24 GB host', () => {
    expect(listTargets(CUDA_BOX).find((t) => t.id === 'trellis2Cuda')).toMatchObject({
      available: true,
      unavailableReason: null,
    });
  });
});

describe('unavailableReason (local-cuda gating)', () => {
  it('is available on a Linux host with a 24 GB card', () => {
    expect(unavailableReason('trellis2Cuda', CUDA_BOX)).toBeNull();
    expect(isTargetAvailable('trellis2Cuda', CUDA_BOX)).toBe(true);
  });

  it('is available at exactly the VRAM floor', () => {
    expect(isTargetAvailable('trellis2Cuda', { ...CUDA_BOX, cudaVramGb: 24 })).toBe(true);
  });

  it('reports requires-cuda on a host with no NVIDIA GPU', () => {
    expect(unavailableReason('trellis2Cuda', APPLE_128GB)).toBe('requires-cuda');
  });

  it('reports the missing GPU before the missing Linux host', () => {
    // A Mac needs to hear "you need an NVIDIA GPU" (final), not "you need Linux"
    // (true, but not the thing standing in the way).
    expect(unavailableReason('trellis2Cuda', { ...APPLE_128GB, linuxHost: false })).toBe('requires-cuda');
  });

  it('reports requires-linux-host on Windows WITH a qualifying card', () => {
    // Upstream builds CUDA extensions against a POSIX toolchain; WSL2 is the route.
    expect(unavailableReason('trellis2Cuda', { ...CUDA_BOX, linuxHost: false }))
      .toBe('requires-linux-host');
  });

  it('reports insufficient-vram for an under-spec card', () => {
    expect(unavailableReason('trellis2Cuda', { ...CUDA_BOX, cudaVramGb: 12 }))
      .toBe('insufficient-vram');
  });

  it('reports cuda-probe-failed — never requires-cuda — when the probe could not run', () => {
    // "We failed to look" must not be reported as "there is no GPU".
    expect(unavailableReason('trellis2Cuda', {
      appleSilicon: false, linuxHost: true, cuda: false, cudaProbe: 'unknown',
    })).toBe('cuda-probe-failed');
  });

  it('reports cuda-probe-failed — never insufficient-vram — for a card of unknown size', () => {
    // A [N/A] VRAM reading is a failed measurement, not a small card; telling the
    // user to buy a bigger GPU they may already own would be wrong.
    expect(unavailableReason('trellis2Cuda', { ...CUDA_BOX, cudaVramGb: null }))
      .toBe('cuda-probe-failed');
  });
});

describe('detectHostCapabilities', () => {
  it('rounds unified memory to whole GB and normalizes flags', async () => {
    const caps = await detectHostCapabilities({
      appleSilicon: true,
      totalMemBytes: 128 * 1024 ** 3,
      linuxHost: false,
      cuda: false,
    });
    expect(caps).toEqual({
      appleSilicon: true,
      unifiedMemoryGb: 128,
      linuxHost: false,
      cuda: false,
      cudaVramGb: null,
      cudaProbe: 'absent',
    });
  });

  it('rounds a hair-under-marketed RAM reading up to the marketed size', async () => {
    // Physical RAM on a "24 GB" Mac reads slightly under 24*1024^3.
    const caps = await detectHostCapabilities({
      appleSilicon: true,
      totalMemBytes: 24 * 1024 ** 3 - 50 * 1024 ** 2,
      cuda: false,
    });
    expect(caps.unifiedMemoryGb).toBe(24);
    expect(isTargetAvailable('trellis2', caps)).toBe(true);
  });

  it('coerces truthy non-boolean overrides to strict booleans', async () => {
    const caps = await detectHostCapabilities({
      appleSilicon: 1, totalMemBytes: 8 * 1024 ** 3, cuda: 'yes',
    });
    expect(caps.appleSilicon).toBe(true);
    expect(caps.cuda).toBe(true);
  });

  it('carries an injected CUDA card straight through to the CUDA lane gate', async () => {
    const caps = await detectHostCapabilities({
      appleSilicon: false,
      totalMemBytes: 64 * 1024 ** 3,
      linuxHost: true,
      cuda: true,
      cudaVramGb: 24,
    });
    expect(caps).toMatchObject({ cuda: true, cudaVramGb: 24, cudaProbe: 'available' });
    expect(isTargetAvailable('trellis2Cuda', caps)).toBe(true);
  });

  it('does not probe the machine when the caller states the CUDA answer', async () => {
    // An injected `cuda` must skip the nvidia-smi subprocess entirely — that is what
    // keeps this deterministic on any CI host, with or without a GPU.
    const caps = await detectHostCapabilities({ cuda: false, totalMemBytes: 8 * 1024 ** 3 });
    expect(caps.cudaProbe).toBe('absent');
    expect(caps.cudaVramGb).toBeNull();
  });
});

describe('renderOptionSupportFor', () => {
  it('reports the unsupported knobs a target declares', () => {
    // Pixal3D's runner drops `steps`; the descriptor is what tells the UI to disable
    // the control and `beginRender` to record null instead of the requested value.
    expect(renderOptionSupportFor('pixal3dCuda')).toEqual({ steps: false });
  });

  it('returns null for a target that honors every knob, and for an unknown id', () => {
    // Absent must mean "all supported", so existing targets need no descriptor entry
    // and an unknown id can't be mistaken for "supports nothing".
    expect(renderOptionSupportFor('trellis2')).toBeNull();
    expect(renderOptionSupportFor('trellis2Cuda')).toBeNull();
    expect(renderOptionSupportFor('nope')).toBeNull();
    expect(renderOptionSupportFor(undefined)).toBeNull();
  });
});
