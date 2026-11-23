import { describe, it, expect, vi } from 'vitest';
import {
  parseFootprintBytes,
  parseProcessTable,
  processTreePids,
  readProcessTreeResidentBytes,
} from './processTreeMemory.js';

// A PM2 wrapper (100) whose child (200) holds the model, plus a grandchild and an unrelated process.
const PS_OUTPUT = [
  '    1     0   1024',
  '  100     1   2048',
  '  200   100 1048576',
  '  300   200   4096',
  '  400     1 999999',
  'garbage row',
].join('\n');

const footprintOutput = (figures) => Object.entries(figures).map(([pid, bytes]) => [
  '======================================================================',
  `proc [${pid}]: 64-bit    Footprint: ${bytes} B (16384 bytes per page)`,
  '======================================================================',
  'Auxiliary data:',
  `    phys_footprint: ${bytes} B`,
  `    phys_footprint_peak: ${bytes + 1} B`,
].join('\n')).join('\n') + '\nSummary Footprint: 1 B\n';

describe('process table parsing', () => {
  it('keeps well-formed rows and walks the whole descendant tree', () => {
    const rows = parseProcessTable(PS_OUTPUT);
    expect(rows).toHaveLength(5);
    expect(processTreePids(rows, 100).sort()).toEqual([100, 200, 300]);
    expect(processTreePids(rows, 999)).toEqual([]);
  });

  it('maps each process header to its footprint, ignoring the peak and summary lines', () => {
    expect(parseFootprintBytes(footprintOutput({ 100: 10, 200: 20 }))).toEqual(new Map([[100, 10], [200, 20]]));
  });
});

describe('readProcessTreeResidentBytes', () => {
  const runner = (footprint) => vi.fn(async (file) => {
    if (file === 'ps') return { stdout: PS_OUTPUT };
    if (footprint instanceof Error) throw footprint;
    return { stdout: footprint };
  });

  it('sums phys_footprint across the tree on macOS', async () => {
    const run = runner(footprintOutput({ 100: 1000, 200: 26 * 2 ** 30, 300: 500 }));
    const result = await readProcessTreeResidentBytes(100, { platform: 'darwin', run });
    expect(result).toEqual({ bytes: 1000 + 26 * 2 ** 30 + 500, source: 'footprint', pids: 3 });
    expect(run.mock.calls[1][1]).toEqual(['-p', '100', '-p', '200', '-p', '300', '--noCategories', '-f', 'bytes']);
  });

  it('keeps RSS for a child that exited before footprint read it', async () => {
    const result = await readProcessTreeResidentBytes(100, { platform: 'darwin', run: runner(footprintOutput({ 100: 1000, 200: 5000 })) });
    expect(result).toEqual({ bytes: 1000 + 5000 + 4096 * 1024, source: 'footprint', pids: 3 });
  });

  it('falls back to RSS when footprint fails or has no figure for the root', async () => {
    const rssBytes = (2048 + 1048576 + 4096) * 1024;
    expect(await readProcessTreeResidentBytes(100, { platform: 'darwin', run: runner(new Error('not found')) }))
      .toEqual({ bytes: rssBytes, source: 'rss', pids: 3 });
    expect(await readProcessTreeResidentBytes(100, { platform: 'darwin', run: runner(footprintOutput({ 200: 2 })) }))
      .toEqual({ bytes: rssBytes, source: 'rss', pids: 3 });
  });

  it('uses RSS directly off macOS', async () => {
    const run = runner('unused');
    expect((await readProcessTreeResidentBytes(200, { platform: 'linux', run }))?.source).toBe('rss');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('is null, never zero, when the process is gone or unreadable', async () => {
    expect(await readProcessTreeResidentBytes(999, { platform: 'darwin', run: runner('') })).toBeNull();
    expect(await readProcessTreeResidentBytes(100, { platform: 'linux', run: vi.fn(async () => { throw new Error('ps'); }) })).toBeNull();
    expect(await readProcessTreeResidentBytes(0, { platform: 'linux', run: runner('') })).toBeNull();
    expect(await readProcessTreeResidentBytes(100, { platform: 'win32', run: runner('') })).toBeNull();
  });
});
