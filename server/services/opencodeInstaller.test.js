import { describe, expect, it, vi } from 'vitest';
import {
  getOpenCodeInstallStatus,
  OPENCODE_NPM_INSTALL_ARGS,
  spawnOpenCodeInstaller,
} from './opencodeInstaller.js';

describe('OpenCode installer', () => {
  it('reports path availability as booleans without returning local paths', async () => {
    const findCommand = vi.fn(async (command) => command === 'opencode' ? '/example/opencode' : null);

    await expect(getOpenCodeInstallStatus({ findCommand })).resolves.toEqual({
      installed: true,
      npmAvailable: false,
    });
    expect(findCommand).toHaveBeenCalledWith('opencode');
    expect(findCommand).toHaveBeenCalledWith('npm');
  });

  it('spawns only the fixed npm global package install without a shell', () => {
    const spawnImpl = vi.fn(() => ({ pid: 123 }));

    spawnOpenCodeInstaller({ spawnImpl });

    expect(spawnImpl).toHaveBeenCalledWith(
      'npm',
      OPENCODE_NPM_INSTALL_ARGS,
      expect.objectContaining({
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      }),
    );
  });
});
