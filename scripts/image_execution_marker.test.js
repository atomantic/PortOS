import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { describe, expect, it } from 'vitest';
import { parseImageExecutionMarker } from '../server/services/imageGen/local.js';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

describe('local image execution marker', () => {
  const emitMarker = (requestedDevice, effectiveDevice, placement) => {
    const program = [
      'import sys',
      `sys.path.insert(0, ${JSON.stringify(scriptsDir)})`,
      'from _runner_common import emit_image_execution_marker',
      `emit_image_execution_marker('diffusers-image', ${JSON.stringify(requestedDevice)}, ${JSON.stringify(effectiveDevice)}, ${JSON.stringify(placement)}, [])`,
    ].join('; ');
    const result = spawnSync('python3', ['-c', program], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    const marker = result.stderr.trim().split('\n').find((line) => line.startsWith('IMAGE_EXECUTION:'));
    expect(marker).toBeDefined();
    return marker;
  };

  it('round-trips confirmed Windows CUDA placements through the server parser', () => {
    expect(parseImageExecutionMarker(emitMarker('cuda', 'cuda', 'cuda'))).toMatchObject({
      state: 'confirmed',
      requestedDevice: 'cuda',
      effectiveDevice: 'cuda',
      placement: 'cuda',
      cpuFallback: false,
      runtime: { runtime: 'diffusers-image', versions: {} },
    });
    expect(parseImageExecutionMarker(emitMarker('cuda', 'cuda', 'cuda+offload'))).toMatchObject({
      state: 'confirmed',
      requestedDevice: 'cuda',
      effectiveDevice: 'cuda',
      placement: 'cuda+offload',
      cpuFallback: false,
      runtime: { runtime: 'diffusers-image', versions: {} },
    });
  });
  it('round-trips a Windows CPU fallback as degraded without host or prompt data', () => {
    const parsed = parseImageExecutionMarker(emitMarker('cuda', 'cpu', 'cpu'));

    expect(parsed).toMatchObject({
      state: 'degraded',
      requestedDevice: 'cuda',
      effectiveDevice: 'cpu',
      placement: 'cpu',
      cpuFallback: true,
      runtime: { runtime: 'diffusers-image', versions: {} },
    });
    expect(parsed).not.toHaveProperty('prompt');
    expect(parsed).not.toHaveProperty('path');
  });
});
