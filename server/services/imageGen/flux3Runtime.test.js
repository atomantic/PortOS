import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { pinPlatform } from '../../lib/testHelper.js';

const probe = vi.hoisted(() => vi.fn());
const command = vi.hoisted(() => vi.fn());
vi.mock('../../lib/childProcess.js', () => ({ execFile: (...args) => probe(...args) }));
vi.mock('../../lib/streamingSpawn.js', () => ({ runStreamingCommand: (...args) => command(...args) }));
vi.mock('../../lib/platform.js', () => ({ isAppleSilicon: () => true }));
vi.mock('node:os', async original => ({ ...await original(), release: () => '25.0.0' }));

import { readFileSync } from 'node:fs';
import { diagnoseFlux3Runtime, flux3Python, FLUX3_LOCK_PATH, installFlux3Runtime } from './flux3Runtime.js';
let restore;
beforeEach(() => {
  restore = pinPlatform('darwin');
  vi.clearAllMocks();
  probe.mockImplementation((_bin, _args, _opts, done) => done(null, { stdout: '', stderr: '' }));
  command.mockResolvedValue({ success: true });
});
afterEach(() => restore());

describe('isolated FLUX.3 runtime lifecycle', () => {
  it('distinguishes missing/broken and healthy FLUX.3 CLIs without importing legacy packages or weights', async () => {
    probe.mockImplementationOnce((_bin, _args, _opts, done) => done(new Error('missing CLI')));
    await expect(diagnoseFlux3Runtime()).resolves.toMatchObject({ readiness: 'unavailable', remedy: { kind: 'install-flux3' } });
    await expect(diagnoseFlux3Runtime()).resolves.toEqual({ readiness: 'ready' });
    expect(probe.mock.calls[1][0]).toBe(flux3Python());
    expect(probe.mock.calls[1][1]).toEqual(['-I', '-c', expect.stringContaining('flux3_edit_generate')]);
    expect(command).not.toHaveBeenCalled();
  });

  it('installs and verifies a separate pinned venv without fetching weights or allowing overlapping installs', async () => {
    let finishVenv;
    command.mockImplementationOnce(() => new Promise(resolve => { finishVenv = resolve; }));
    const events = [];
    const install = installFlux3Runtime(event => events.push(event));
    expect(() => installFlux3Runtime(vi.fn())).toThrow('already running');
    finishVenv({ success: true });
    await install.promise;
    const argv = command.mock.calls.map(([bin, args]) => [bin, ...args].join(' ')).join('\n');
    expect(argv).toContain('venv --python 3.12 --python-preference only-managed --allow-existing');
    expect(argv).toContain(`pip sync --require-hashes --reinstall --python ${flux3Python()} ${FLUX3_LOCK_PATH}`);
    expect(argv).not.toMatch(/snapshot_download|hf download|mflux-generate|--user/);
    expect(command.mock.calls[0][3].env).toMatchObject({ PYTHONNOUSERSITE: '1', PYTHONPATH: undefined, PYTHONHOME: undefined });
    expect(events.at(-1)).toMatchObject({ type: 'complete' });
    expect(probe).toHaveBeenCalledOnce();
  });

  it('cancels before package installation and releases its in-flight guard for repair', async () => {
    let finishVenv;
    command.mockImplementationOnce(() => new Promise(resolve => { finishVenv = resolve; }));
    const emit = vi.fn();
    const install = installFlux3Runtime(emit);
    install.kill();
    expect(command.mock.calls[0][3].isCancelled()).toBe(true);
    finishVenv({ success: true });
    await expect(install.promise).rejects.toThrow('cancelled');
    expect(command).toHaveBeenCalledOnce();
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'complete' }));
    command.mockResolvedValueOnce({ success: false, error: 'uv unavailable' });
    await expect(installFlux3Runtime(vi.fn()).promise).rejects.toThrow('Install uv');
  });
});

// `uv pip sync --require-hashes` refuses the whole install when an entry lacks a
// hash, and a lock compiled from stale direct pins silently ships old packages.
describe('FLUX.3 runtime lock', () => {
  it('probes every hash-pinned package and matches the direct pins it was compiled from', async () => {
    await diagnoseFlux3Runtime();
    const probed = JSON.parse(probe.mock.calls[0][1][2].match(/^for name, version in (\[.*\]):$/m)[1]);
    const lock = readFileSync(FLUX3_LOCK_PATH, 'utf8');
    const entries = lock.split(/\n(?=[a-z0-9])/i).filter(entry => /^[a-z0-9][\w.-]*==/i.test(entry));
    expect(entries.map(entry => entry.split(/\s/)[0].split('=='))).toEqual(probed);
    for (const entry of entries) expect(entry, entry.split(' ')[0]).toMatch(/--hash=sha256:[0-9a-f]{64}/);
    const locked = Object.fromEntries(probed);
    const direct = readFileSync(FLUX3_LOCK_PATH.replace('.lock.txt', '.txt'), 'utf8')
      .split('\n').filter(line => /^[a-z0-9]/i.test(line)).map(line => line.trim().split('=='));
    expect(direct.length).toBeGreaterThan(0);
    for (const [name, version] of direct) expect(locked[name], name).toBe(version);
  });
});
