import { describe, expect, it } from 'vitest';
import { launchDetached } from './launchDetached.js';

// Node itself stands in for the GUI program, so the fixtures run on every platform.
const node = (script) => ['-e', script];

describe('launchDetached', () => {
  // Catches reporting a window as open when the program exits at once, e.g. Blender with no display on a headless host.
  it('fails with the program\'s last words when it exits during the grace period, and lets a running one go', async () => {
    await expect(launchDetached(process.execPath, node('console.error("unable to open a display"); process.exit(1)'), { graceMs: 2000 }))
      .rejects.toThrow(/exit 1\): unable to open a display/);

    const started = Date.now();
    await expect(launchDetached(process.execPath, node('setTimeout(() => {}, 1000)'), { graceMs: 200 })).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
