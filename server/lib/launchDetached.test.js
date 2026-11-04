import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { launchDetached } from './launchDetached.js';

describe('launchDetached', () => {
  // Catches reporting a window as open when Blender exits at once, e.g. with no display on a headless host.
  it('fails with the program\'s last words when it exits during the grace period, and lets a running one go', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'portos-launch-'));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    const noDisplay = join(dir, 'no-display.sh');
    await writeFile(noDisplay, '#!/bin/sh\necho "unable to open a display" >&2\nexit 1\n', { mode: 0o755 });
    await expect(launchDetached(noDisplay, [], { graceMs: 2000 })).rejects.toThrow(/exit 1\): unable to open a display/);

    const stays = join(dir, 'stays.sh');
    await writeFile(stays, '#!/bin/sh\nsleep 1\n', { mode: 0o755 });
    const started = Date.now();
    await expect(launchDetached(stays, [], { graceMs: 200 })).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
