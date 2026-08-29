import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// pm2.js imports the `pm2` package at module load (no daemon connection until a
// call is made). Mocked to keep the import side-effect-free in CI.
vi.mock('pm2', () => ({ default: { connect: vi.fn(), list: vi.fn(), disconnect: vi.fn() } }));

// `saveProcessList` runs `pm2 save` through pm2.js's OWN `execPm2`, and an
// intra-module call reads the local binding — a `vi.spyOn(pm2Module, 'execPm2')`
// never intercepts it (that only works for the cross-module callers in
// mtplxServerManager / llamaServerManager). This test used to rely on that spy,
// so every run really launched `pm2 save` against the throwaway PM2_HOME below,
// and PM2 answered by forking a God Daemon that outlived the suite. Those
// daemons never exit: 641 of them (38 GB of RSS) had accumulated on the dev
// machine that reported this. Mocking the spawn seam — the same one
// pm2.launch.test.js uses — is what actually keeps the subprocess out.
const mockSpawn = vi.hoisted(() => vi.fn());
vi.mock('../lib/childProcess.js', async (importOriginal) => ({
  ...(await importOriginal()),
  spawn: mockSpawn,
}));

import { getSavedProcessNames, saveProcessList } from './pm2.js';

// Fake child_process.spawn result: closes with exit code 0 on the next tick.
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(() => child.emit('close', 0));
  return child;
}

/**
 * `getSavedProcessNames` reads `$PM2_HOME/dump.pm2` — the list a boot-time
 * `pm2 resurrect` replays. The LLMs page shows it as "starts at boot" per
 * PM2-managed local runtime server, so absent-vs-empty has to stay legible: an
 * unreadable dump is "unknown", never "this daemon won't come back".
 */
describe('getSavedProcessNames', () => {
  let home;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'portos-pm2-home-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('lists the app names in the saved dump', async () => {
    await writeFile(join(home, 'dump.pm2'), JSON.stringify([
      { name: 'portos-server' },
      { name: 'portos-llama-server' },
      { name: 'portos-mtplx' },
    ]));
    expect(await getSavedProcessNames(home)).toEqual(['portos-server', 'portos-llama-server', 'portos-mtplx']);
  });

  it('reports an EMPTY saved list as [] — read fine, saves nothing', async () => {
    await writeFile(join(home, 'dump.pm2'), '[]');
    expect(await getSavedProcessNames(home)).toEqual([]);
  });

  it('returns null when the dump is absent or unreadable', async () => {
    // Never `pm2 save`d on this machine.
    expect(await getSavedProcessNames(home)).toBeNull();
    // Truncated / not the array PM2 writes.
    await writeFile(join(home, 'dump.pm2'), '{"not":"an array"');
    expect(await getSavedProcessNames(home)).toBeNull();
  });

  it('skips entries with no usable name rather than emitting undefined', async () => {
    await writeFile(join(home, 'dump.pm2'), JSON.stringify([{ name: 'portos-mtplx' }, {}, { name: 42 }]));
    expect(await getSavedProcessNames(home)).toEqual(['portos-mtplx']);
  });
});


/**
 * `pm2 save` snapshots the whole running process list and has no exclusion flag,
 * so a daemon PortOS starts ON DEMAND has to be filtered out of the dump after
 * the fact. MTPLX is exactly that: the first request that needs it starts it and
 * the idle reaper stops it again, so resurrecting it at boot would pin its
 * multi-gigabyte checkpoint on a machine nobody has asked anything of yet.
 */
describe('saveProcessList exclusions', () => {
  let home;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'portos-pm2-home-'));
    // `pm2 save` is stubbed out at the spawn seam; the dump it would have
    // written is seeded per test so the filtering is what's under assertion.
    mockSpawn.mockReset();
    mockSpawn.mockImplementation(() => fakeChild());
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const seedDump = (names) =>
    writeFile(join(home, 'dump.pm2'), JSON.stringify(names.map((name) => ({ name, script: `/bin/${name}` }))));

  // Regression guard for the daemon leak described at the top of this file.
  it('runs `pm2 save` through the stubbed spawn seam, never a real subprocess', async () => {
    await seedDump(['portos-server']);

    await saveProcessList(home);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [, args, opts] = mockSpawn.mock.calls[0];
    expect(args.at(-1)).toBe('save');
    expect(opts.env.PM2_HOME).toBe(home);
  });

  it('drops an excluded app from the dump and leaves the rest', async () => {
    await seedDump(['portos-server', 'portos-llama-server', 'portos-mtplx']);

    const result = await saveProcessList(home, { exclude: ['portos-mtplx'] });

    expect(result.excluded).toEqual(['portos-mtplx']);
    expect(await getSavedProcessNames(home)).toEqual(['portos-server', 'portos-llama-server']);
  });

  // llama.cpp still runs at boot when the user saves — it has no lazy start, and
  // its own idle unload releases the memory without the process going away.
  it('leaves llama-server in the boot list', async () => {
    await seedDump(['portos-llama-server', 'portos-mtplx']);

    await saveProcessList(home, { exclude: ['portos-mtplx'] });

    expect(await getSavedProcessNames(home)).toContain('portos-llama-server');
  });

  it('is a no-op when the excluded app was not running anyway', async () => {
    await seedDump(['portos-server']);

    const result = await saveProcessList(home, { exclude: ['portos-mtplx'] });

    expect(result.excluded).toEqual([]);
    expect(await getSavedProcessNames(home)).toEqual(['portos-server']);
  });

  it('saves everything when nothing is excluded', async () => {
    await seedDump(['portos-server', 'portos-mtplx']);

    const result = await saveProcessList(home);

    expect(result).toEqual({ success: true, excluded: [] });
    expect(await getSavedProcessNames(home)).toEqual(['portos-server', 'portos-mtplx']);
  });

  // A dump PM2 wrote in a shape this doesn't understand must be left ALONE. One
  // extra resurrected process beats a rewritten dump that resurrects none.
  it('leaves an unparseable dump untouched rather than rewriting it', async () => {
    await writeFile(join(home, 'dump.pm2'), 'not json at all');

    const result = await saveProcessList(home, { exclude: ['portos-mtplx'] });

    expect(result.excluded).toEqual([]);
    expect(await getSavedProcessNames(home)).toBeNull();
  });
});
