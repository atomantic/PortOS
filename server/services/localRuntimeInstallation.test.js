import { describe, expect, it, vi } from 'vitest';
import { detectRuntimeInstallation } from './localRuntimeInstallation.js';

const slotstream = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('./slotstreamServerManager.js', async (importOriginal) => ({
  ...await importOriginal(),
  resolveSlotstreamBinary: slotstream.resolve,
}));

describe('detectRuntimeInstallation', () => {
  it('routes Slotstream resolution through the caller command cache', async () => {
    slotstream.resolve.mockReturnValue('/example/.slotstream/bin/slotstream');
    const findCommand = vi.fn((command, resolve) => {
      expect(command).toBe('slotstream');
      return resolve();
    });

    await expect(detectRuntimeInstallation('slotstream', { findCommand })).resolves.toBe('managed');
    expect(findCommand).toHaveBeenCalledOnce();
    expect(slotstream.resolve).toHaveBeenCalledOnce();
    slotstream.resolve.mockReset();
  });
});
