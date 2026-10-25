import { afterEach, describe, expect, it as vitestIt, vi } from 'vitest';
import { chmod, mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createProviderService } from './providers.js';
import { ownTestBodies } from '../mockPathsDataRoot.js';
import { readTestProcesses, testProcessSettlement } from '../../../scripts/lib/testOwnedProcesses.js';

import { waitForFixtureReady } from '../../../scripts/lib/vitestTempRootFixture.js';

const owned = ownTestBodies(vitestIt);
const it = owned.it;

describe('testProvider — real CLI process lifecycle', () => {
  let tempDir;
  let originalPath;

  afterEach(async () => {
    await owned.drain();
    vi.restoreAllMocks();
    if (originalPath !== undefined) process.env.PATH = originalPath;
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('bounds a version probe and cleans up a descendant holding inherited pipes', async ({ signal }) => {
    if (process.platform === 'win32') return;

    tempDir = await mkdtemp(join(tmpdir(), 'portos-cli-probe-'));
    originalPath = process.env.PATH;
    const evidencePath = join(tempDir, 'processes.json');
    const pendingEvidencePath = join(tempDir, 'processes.pending.json');
    const commandPath = join(tempDir, 'hang-cli');
    const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    // A shell publishes both owned PIDs immediately; interpreter startup must
    // not consume the 150 ms probe budget before the descendant even exists.
    // Rename complete JSON into place before the readiness watcher can see it.
    await writeFile(commandPath, `#!/bin/sh
${shellQuote(process.execPath)} -e 'setInterval(() => {}, 1000)' &
printf '[%s,%s]' "$$" "$!" > ${shellQuote(pendingEvidencePath)}
mv ${shellQuote(pendingEvidencePath)} ${shellQuote(evidencePath)}
wait
`);
    await chmod(commandPath, 0o755);
    process.env.PATH = `${tempDir}${process.platform === 'win32' ? ';' : ':'}${originalPath}`;

    const service = createProviderService({
      dataDir: tempDir,
      providersFile: 'providers.json',
      cliProbeTimeouts: { lookup: 1_000, version: 150 },
    });
    const provider = await service.createProvider({ name: 'Hanging CLI', type: 'cli', command: 'hang-cli' });

    // Control the watchdog clock, not interpreter startup latency. The mocked
    // clock contract lives in cliPathResolve; this boundary proves real group
    // ownership after both processes exist, even under full-suite contention.
    const realSetTimeout = globalThis.setTimeout;
    let expire;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
      if (delay !== 150) return realSetTimeout(callback, delay, ...args);
      expire = () => { expire = () => {}; callback(...args); };
      return { unref() { return this; } };
    });
    const probe = service.testProvider(provider.id);
    try {
      await waitForFixtureReady(evidencePath, { signal });
      // Identities only authorize observation; no PID read from disk is signalled.
      const pids = JSON.parse(await readFile(evidencePath, 'utf8'));
      const before = readTestProcesses(pids);
      expect(pids.map(pid => Boolean(before?.find(record => record.pid === pid)?.start)),
        'fixture process identities must be inspectable before timeout').toEqual([true, true]);
      expect(typeof expire).toBe('function');
      expire();
      const result = await probe;
      expect(result.success, result.error).toBe(true);
      expect(result).toMatchObject({ success: true, path: commandPath, version: 'available' });
      const after = readTestProcesses(pids);
      expect(before.map(record => testProcessSettlement(record, after)),
        'probe processes must settle before testProvider returns').toEqual(['terminated', 'terminated']);
    } finally {
      // Cancellation/readiness failures still own the real probe's cleanup.
      expire?.();
      await probe;
    }

  }, 5_000);
});
