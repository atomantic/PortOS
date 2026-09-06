import { describe, expect, it } from 'vitest';
import {
  captureSystemCapabilities,
  detectSystemCapabilities,
  evaluateHardwareRequirements,
  hardwareRequirementsForLocalLlm,
  hardwareRequirementsForMediaModel,
  hardwareRequirementsForProvider,
  hardwareRequirementsForProviderModel,
  normalizeHardwareRequirements,
  withProviderHardwareCompatibility,
} from './systemCapabilities.js';

const bytesForGb = (gb) => gb * 1024 ** 3;

const APPLE_32GB = {
  platform: 'darwin',
  arch: 'arm64',
  appleSilicon: true,
  totalMemoryGb: 32,
  cuda: { status: 'absent', gpus: [], maxVramGb: null, primaryComputeCap: null },
};

describe('systemCapabilities', () => {
  it('captures normalized local facts without leaking machine identity', () => {
    expect(captureSystemCapabilities({
      platform: 'darwin',
      arch: 'x64',
      appleSilicon: true,
      totalMemoryBytes: bytesForGb(64),
      cpuCount: 12,
    })).toEqual({
      version: 1,
      platform: 'darwin',
      arch: 'x64',
      appleSilicon: true,
      cpuCount: 12,
      totalMemoryGb: 64,
    });

    expect(captureSystemCapabilities({
      platform: 'win32',
      arch: 'x64',
      appleSilicon: true,
      totalMemoryBytes: bytesForGb(16),
      cpuCount: 8,
    }).appleSilicon).toBe(false);
  });

  it('normalizes custom requirement layers and ignores malformed values', () => {
    expect(normalizeHardwareRequirements({
      platforms: [' darwin ', 'darwin', 3],
      architectures: ['arm64'],
      requiresAppleSilicon: true,
      minMemoryGb: 64,
      minVramGb: 0,
      minCudaComputeCapability: 'not-a-number',
      hostname: 'should-not-cross-the-boundary',
    })).toEqual({
      platforms: ['darwin'],
      architectures: ['arm64'],
      requiresAppleSilicon: true,
      minMemoryGb: 64,
    });
  });

  it('distinguishes confirmed mismatches from an unreadable capability', () => {
    expect(evaluateHardwareRequirements({ platforms: ['win32'] }, APPLE_32GB).state).toBe('unavailable');
    expect(evaluateHardwareRequirements({ minMemoryGb: 64 }, APPLE_32GB).state).toBe('unavailable');
    expect(evaluateHardwareRequirements({ minMemoryGb: 64 }, { ...APPLE_32GB, totalMemoryGb: null }).state).toBe('unknown');
    expect(evaluateHardwareRequirements({ requiresNvidiaGpu: true }, APPLE_32GB).state).toBe('unavailable');
    expect(evaluateHardwareRequirements({ requiresNvidiaGpu: true }, {
      ...APPLE_32GB,
      cuda: { status: 'unknown' },
    }).state).toBe('unknown');
    expect(evaluateHardwareRequirements({ minCudaComputeCapability: 9 }, {
      ...APPLE_32GB,
      cuda: { status: 'available', maxVramGb: 32, primaryComputeCap: '8.6' },
    }).state).toBe('unavailable');
  });

  it('uses the injected CUDA probe for deterministic full snapshots', async () => {
    await expect(detectSystemCapabilities({
      platform: 'linux',
      arch: 'x64',
      totalMemoryBytes: bytesForGb(128),
      cpuCount: 32,
      cudaProbe: async () => ({
        status: 'available',
        gpus: [{ name: 'Example GPU', vramGb: 24, computeCap: '8.6' }],
        maxVramGb: 24,
        primaryComputeCap: '8.6',
      }),
    })).resolves.toMatchObject({
      platform: 'linux',
      totalMemoryGb: 128,
      cuda: {
        status: 'available',
        maxVramGb: 24,
        primaryComputeCap: '8.6',
      },
    });
  });

  it('merges the cached compute-capability probe into a full snapshot', async () => {
    await expect(detectSystemCapabilities({
      platform: 'linux',
      cudaProbe: async () => ({
        status: 'available',
        gpus: [{ name: 'Example GPU', vramGb: 24 }],
        maxVramGb: 24,
      }),
      cudaComputeProbe: async () => ({
        status: 'available',
        primaryComputeCap: '9.0',
        gpus: [{ name: 'Example GPU', computeCap: '9.0', vramGb: 24 }],
      }),
    })).resolves.toMatchObject({
      cuda: {
        primaryComputeCap: '9.0',
        gpus: [{ name: 'Example GPU', computeCap: '9.0' }],
      },
    });
  });

  it('derives requirements for shipped media, local LLM, and provider runtimes', () => {
    expect(hardwareRequirementsForMediaModel({ id: 'flux2-klein-9b-bf16', runner: 'flux2' })).toMatchObject({ minMemoryGb: 64 });
    expect(hardwareRequirementsForMediaModel({ id: 'qwen-image', runner: 'qwen' })).toMatchObject({ minMemoryGb: 64 });
    expect(hardwareRequirementsForMediaModel({ id: 'hidream-i1-full', runner: 'hidream' })).toMatchObject({ minMemoryGb: 48 });
    expect(hardwareRequirementsForMediaModel({ id: 'custom-image', memoryGb: 64 })).toMatchObject({ minMemoryGb: 64 });
    expect(hardwareRequirementsForMediaModel({ id: 'mlx-model', runner: 'mlx_video' }, { kind: 'video', bucket: 'mlx' })).toMatchObject({
      platforms: ['darwin'],
      requiresAppleSilicon: true,
    });
    expect(hardwareRequirementsForMediaModel({ id: 'cuda-model', memoryGb: 48 }, { kind: 'video', bucket: 'cuda' })).toMatchObject({
      platforms: ['linux', 'win32'],
      requiresNvidiaGpu: true,
      minMemoryGb: 48,
    });
    expect(hardwareRequirementsForLocalLlm({ key: 'qwen3.8-27b' })).toMatchObject({ minMemoryGb: 32 });
    expect(hardwareRequirementsForLocalLlm({ key: 'qwen3.5-122b-a10b' })).toMatchObject({ minMemoryGb: 96 });
    expect(hardwareRequirementsForProvider({ id: 'provider', vllmBacked: true })).toMatchObject({
      platforms: ['linux', 'win32'],
      requiresNvidiaGpu: true,
      minVramGb: 24,
    });
    expect(hardwareRequirementsForProvider({ id: 'provider', sglangBacked: true })).toMatchObject({
      minVramGb: 32,
      minCudaComputeCapability: 9,
    });
    expect(hardwareRequirementsForProviderModel({
      id: 'provider',
      hardwareRequirements: { minMemoryGb: 16 },
      modelHardwareRequirements: { 'large-model': { minMemoryGb: 64 } },
    }, 'large-model')).toMatchObject({ minMemoryGb: 64 });
    expect(hardwareRequirementsForProviderModel({ ollamaBacked: true }, 'qwen3.8:27b-mlx')).toMatchObject({
      platforms: ['darwin'],
      requiresAppleSilicon: true,
      minMemoryGb: 32,
    });
    expect(hardwareRequirementsForProviderModel({ endpoint: 'https://api.example.com/v1' }, 'gemma4-31b')).toEqual({});
  });

  it('decorates provider and model compatibility in one response projection', () => {
    const provider = withProviderHardwareCompatibility({
      id: 'vllm',
      vllmBacked: true,
      models: ['small', 'large'],
      modelHardwareRequirements: { large: { minMemoryGb: 256 } },
    }, {
      platform: 'linux',
      arch: 'x64',
      totalMemoryGb: 128,
      cuda: { status: 'available', maxVramGb: 24, primaryComputeCap: '8.6' },
    });

    expect(provider.hardwareCompatibility.state).toBe('available');
    expect(provider.modelHardwareCompatibility.small.state).toBe('available');
    expect(provider.modelHardwareCompatibility.large.state).toBe('unavailable');
  });

  it('keeps fleet API and TUI models selectable without applying the caller hardware', () => {
    for (const type of ['api', 'tui']) {
      const provider = {
        id: 'fleet-gpu',
        type,
        command: type === 'tui' ? 'opencode' : undefined,
        endpoint: 'http://gpu.example.com:18022/v1',
        vllmBacked: true,
        models: ['qwen3.8-27b'],
        hardwareRequirements: { platforms: ['win32'] },
        modelHardwareRequirements: { 'qwen3.8-27b': { minMemoryGb: 256 } },
      };
      const remote = withProviderHardwareCompatibility(provider, APPLE_32GB);
      expect(remote.hardwareCompatibility.state).toBe('unknown');
      expect(remote.modelHardwareCompatibility['qwen3.8-27b']).toMatchObject({
        state: 'unknown',
        requirements: { minMemoryGb: 256, platforms: ['win32'] },
      });
      for (const endpoint of ['http://localhost:18022/v1', 'http://[::1]:18022/v1', '', undefined]) {
        const local = withProviderHardwareCompatibility({ ...provider, endpoint }, APPLE_32GB);
        expect(local.hardwareCompatibility.state).toBe('unavailable');
        expect(local.modelHardwareCompatibility['qwen3.8-27b'].state).toBe('unavailable');
      }
    }
  });

  it('retains inferred local model compatibility without provider overrides', () => {
    const provider = withProviderHardwareCompatibility({
      id: 'ollama',
      ollamaBacked: true,
      models: ['qwen3.8:27b'],
    }, {
      platform: 'linux',
      arch: 'x64',
      totalMemoryGb: 16,
      cuda: { status: 'absent' },
    });

    expect(provider.modelHardwareCompatibility['qwen3.8:27b']).toMatchObject({
      state: 'unavailable',
      requirements: { minMemoryGb: 32 },
    });
  });
});
