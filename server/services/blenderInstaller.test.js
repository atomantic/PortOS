import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { __testing, startBlenderInstall } from './blenderInstaller.js';

const { createOfferReader, managedBlenderExecutable } = __testing;
const HASH = 'a'.repeat(64);
const HOMES = [];
const freshHome = () => { const home = mkdtempSync(join(tmpdir(), 'blender-home-')); HOMES.push(home); return home; };
let HOME = freshHome();
afterAll(() => HOMES.forEach((home) => rmSync(home, { recursive: true, force: true })));

describe('Blender release lookup', () => {
  const pages = {
    'https://download.blender.org/release/Blender5.2/': [
      '<a href="blender-5.2.0-macos-arm64.dmg">', '<a href="blender-5.2.3-macos-arm64.dmg">', '<a href="blender-5.2.10-macos-x64.dmg">',
      '<a href="blender-5.2.10-linux-x64.tar.xz">', '<a href="blender-5.2.3.sha256">',
    ].join('\n'),
    'https://download.blender.org/release/': '<a href="Blender5.1/">\n<a href="Blender5.2/">\n<a href="Blender5.3/">',
    'https://download.blender.org/release/Blender5.2/blender-5.2.3.sha256': `${HASH}  blender-5.2.3-macos-arm64.dmg\n${'b'.repeat(64)}  blender-5.2.3-linux-x64.tar.xz\n`,
  };
  const fetchText = vi.fn(async (url) => { if (!(url in pages)) throw new Error(`404 ${url}`); return pages[url]; });

  it('offers the newest patch of the checked series for this arch with its published checksum, and notes a newer series', async () => {
    const offer = await createOfferReader({ fetchText, arch: 'arm64' })();
    expect(offer).toEqual({
      version: '5.2.3', series: '5.2', file: 'blender-5.2.3-macos-arm64.dmg',
      url: 'https://download.blender.org/release/Blender5.2/blender-5.2.3-macos-arm64.dmg', sha256: HASH, newestSeries: '5.3',
    });
  });

  it('offers nothing when the checksum list has no entry for the DMG', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // x64's newest DMG is 5.2.10, whose .sha256 list is not published.
    expect(await createOfferReader({ fetchText, arch: 'x64' })()).toBeNull();
  });
});

describe('startBlenderInstall', () => {
  const offer = { version: '5.2.3', series: '5.2', file: 'blender-5.2.3-macos-arm64.dmg', url: 'https://example.com/b.dmg', sha256: HASH };
  const setup = ({ passes = true, previous = '/Applications/Blender.app/Contents/MacOS/Blender' } = {}) => {
    HOME = freshHome();
    const selected = [];
    const execution = {
      getCodeAnimationExecution: async () => ({ tools: { blender: { executable: previous, executionMode: 'contained', engine: 'CYCLES' } } }),
      setCodeAnimationExecutionTools: vi.fn(async (tools) => { selected.push(tools.blender.executable); }),
      probeCodeAnimationExecution: vi.fn(async () => {
        if (passes === 'throw') throw new Error('containment probe crashed');
        const ready = passes === true || selected.at(-1) === previous;
        return { lanes: { blender: ready ? { ready: true } : { ready: false, reason: 'render failed' } } };
      }),
    };
    const run = vi.fn(async (file, args) => {
      if (file.endsWith('hdiutil') && args[0] === 'attach') {
        mkdirSync(join(args[args.indexOf('-mountpoint') + 1], 'Blender.app'), { recursive: true });
      }
      if (file.endsWith('ditto')) {
        mkdirSync(join(args[1], 'Contents', 'MacOS'), { recursive: true });
        writeFileSync(join(args[1], 'Contents', 'MacOS', 'Blender'), 'new');
      }
    });
    const events = [];
    const io = { emit: (name, frame) => events.push([name, frame]) };
    const done = () => vi.waitFor(() => expect(events.some(([name]) => name === 'software:changed')).toBe(true));
    const deps = { platform: 'darwin', readOffer: async () => offer, assertIdle: vi.fn(async () => {}), execution, home: HOME, download: vi.fn(async () => {}), run };
    return { deps, io, events, selected, run, done, execution };
  };

  it('installs a versioned app, selects it and keeps it after the execution check passes', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deps, io, events, selected, run, done } = setup();
    await expect(startBlenderInstall({ io, acknowledgeBusy: true, deps })).resolves.toEqual({ started: true, version: '5.2.3' });
    await done();
    expect(deps.assertIdle).toHaveBeenCalledWith(expect.objectContaining({ acknowledgeBusy: true }));
    expect(deps.download).toHaveBeenCalledWith(offer.url, expect.stringContaining(offer.file), HASH, expect.any(Function));
    expect(selected).toEqual([managedBlenderExecutable('5.2.3', HOME)]);
    expect(existsSync(managedBlenderExecutable('5.2.3', HOME))).toBe(true);
    expect(run).toHaveBeenCalledWith('/usr/bin/hdiutil', expect.arrayContaining(['detach']));
    expect(events.find(([, frame]) => frame?.step === 'complete')).toBeTruthy();
  });

  it('restores the previous Blender and re-checks it when the new one fails the execution check', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps, io, events, selected, done, execution } = setup({ passes: false });
    await startBlenderInstall({ io, deps });
    await done();
    expect(selected).toEqual([managedBlenderExecutable('5.2.3', HOME), '/Applications/Blender.app/Contents/MacOS/Blender']);
    expect(execution.probeCodeAnimationExecution).toHaveBeenCalledTimes(2);
    expect(events.find(([, frame]) => frame?.step === 'error')[1].message).toMatch(/render failed\. Code Animation is back on the previous Blender/);
  });

  it('restores an empty selection when the check throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps, io, events, selected, done } = setup({ passes: 'throw', previous: null });
    await startBlenderInstall({ io, deps });
    await done();
    expect(selected).toEqual([managedBlenderExecutable('5.2.3', HOME), null]);
    expect(events.find(([, frame]) => frame?.step === 'error')[1].message).toMatch(/containment probe crashed\. Code Animation has no Blender selected again/);
  });

  it('reuses an existing app at the versioned path instead of replacing it', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deps, io, selected, done, run } = setup();
    const existing = managedBlenderExecutable('5.2.3', HOME);
    mkdirSync(join(existing, '..'), { recursive: true });
    writeFileSync(existing, 'mine');
    await startBlenderInstall({ io, deps });
    await done();
    expect(deps.download).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(readFileSync(existing, 'utf8')).toBe('mine');
    expect(selected).toEqual([existing]);
  });

  it('refuses off macOS, and while busy, before downloading', async () => {
    const { deps, io } = setup();
    await expect(startBlenderInstall({ io, deps: { ...deps, platform: 'linux' } })).rejects.toMatchObject({ code: 'BLENDER_INSTALL_UNSUPPORTED' });
    const busy = Object.assign(new Error('PortOS is busy'), { code: 'SYSTEM_BUSY' });
    await expect(startBlenderInstall({ io, deps: { ...deps, assertIdle: async () => { throw busy; } } })).rejects.toBe(busy);
    expect(deps.download).not.toHaveBeenCalled();
  });
});
