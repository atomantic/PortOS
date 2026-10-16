import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createProviderService } from './providers.js';

describe('testProvider — real CLI process lifecycle', () => {
  let tempDir;
  let originalPath;

  afterEach(async () => {
    if (originalPath !== undefined) process.env.PATH = originalPath;
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('bounds a version probe and cleans up a descendant holding inherited pipes', async () => {
    if (process.platform === 'win32') return;

    tempDir = await mkdtemp(join(tmpdir(), 'portos-cli-probe-'));
    originalPath = process.env.PATH;
    const commandPath = join(tempDir, 'hang-cli');
    await writeFile(commandPath, `#!/usr/bin/env node
const { spawn } = require('node:child_process');
spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
setInterval(() => {}, 1000);
`);
    await chmod(commandPath, 0o755);
    process.env.PATH = `${tempDir}${process.platform === 'win32' ? ';' : ':'}${originalPath}`;

    const service = createProviderService({
      dataDir: tempDir,
      providersFile: 'providers.json',
      cliProbeTimeouts: { lookup: 1_000, version: 150 },
    });
    const provider = await service.createProvider({ name: 'Hanging CLI', type: 'cli', command: 'hang-cli' });

    const result = await service.testProvider(provider.id);

    expect(result).toMatchObject({ success: true, path: commandPath, version: 'available' });
  }, 5_000);
});
