import { mkdtemp, readdir, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, it, expect, beforeEach } from 'vitest';

import { sweepStaleDoneSentinels, STALE_SENTINEL_MIN_AGE_MS } from './agentSentinelSweep.js';

let dir;

/** Write a file and back-date it so the sweep's age floor is satisfied. */
async function writeAged(name, ageMs) {
  const target = join(dir, name);
  await writeFile(target, 'summary');
  const when = new Date(Date.now() - ageMs);
  await utimes(target, when, when);
  return target;
}

const OLD = STALE_SENTINEL_MIN_AGE_MS * 2;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sentinel-sweep-'));
});

describe('sweepStaleDoneSentinels', () => {
  it('removes an abandoned sentinel whose agent is gone, and nothing else', async () => {
    await writeAged('.agent-done-agent-dead', OLD);
    await writeAged('README.md', OLD);
    // `.agent-doneish` has no separator, so it is not a sentinel at all —
    // unlike `.agent-done-ish`, which is exactly what agent id `ish` produces.
    await writeAged('.agent-doneish', OLD);

    expect(await sweepStaleDoneSentinels([dir], new Set())).toBe(1);
    expect((await readdir(dir)).sort()).toEqual(['.agent-doneish', 'README.md']);
  });

  it('keeps the sentinel of an agent that has not finished', async () => {
    await writeAged('.agent-done-agent-live', OLD);

    expect(await sweepStaleDoneSentinels([dir], new Set(['agent-live']))).toBe(0);
    expect(await readdir(dir)).toEqual(['.agent-done-agent-live']);
  });

  it('keeps a fresh sentinel — a run may not be registered yet', async () => {
    await writeAged('.agent-done-agent-new', 1000);

    expect(await sweepStaleDoneSentinels([dir], new Set())).toBe(0);
    expect(await readdir(dir)).toEqual(['.agent-done-agent-new']);
  });

  it('removes the bare unscoped sentinel only once it is old', async () => {
    await writeAged('.agent-done', 1000);
    expect(await sweepStaleDoneSentinels([dir], new Set())).toBe(0);

    await writeAged('.agent-done', OLD);
    expect(await sweepStaleDoneSentinels([dir], new Set())).toBe(1);
    expect(await readdir(dir)).toEqual([]);
  });

  it('removes nothing when liveness is unknown', async () => {
    await writeAged('.agent-done-agent-dead', OLD);

    expect(await sweepStaleDoneSentinels([dir], null)).toBe(0);
    expect(await readdir(dir)).toEqual(['.agent-done-agent-dead']);
  });

  it('skips unreadable or missing directories instead of throwing', async () => {
    await writeAged('.agent-done-agent-dead', OLD);

    expect(await sweepStaleDoneSentinels([join(dir, 'nope'), dir, null, ''], new Set())).toBe(1);
  });
});
