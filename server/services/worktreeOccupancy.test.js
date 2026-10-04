import { describe, expect, it } from 'vitest';
import { parseLsofCwdListing, worktreeHasLiveProcess } from './worktreeOccupancy.js';

const TREE = '/data/cos/worktrees/claim-portos-issue-42';

describe('parseLsofCwdListing', () => {
  it('reads the directory of every n field and ignores process and fd fields', () => {
    expect(parseLsofCwdListing(`p101\nfcwd\nn/home/alice\np102\nfcwd\nn${TREE}/server\n`))
      .toEqual(['/home/alice', `${TREE}/server`]);
    expect(parseLsofCwdListing('')).toEqual([]);
    expect(parseLsofCwdListing(null)).toEqual([]);
  });
});

describe('worktreeHasLiveProcess', () => {
  const probe = (cwds) => worktreeHasLiveProcess(TREE, { listCwds: async () => cwds });

  it('reports a process sitting in the checkout root or below it', async () => {
    expect(await probe(['/elsewhere', TREE])).toBe(true);
    expect(await probe([`${TREE}/server/lib`])).toBe(true);
  });

  it('reports none when the listing ran and nothing is inside, including a sibling with the same prefix', async () => {
    expect(await probe(['/elsewhere', `${TREE}-other`])).toBe(false);
    expect(await probe([])).toBe(false);
  });

  it('reports unknown, never empty, when the listing could not be taken', async () => {
    expect(await probe(null)).toBeNull();
    expect(await worktreeHasLiveProcess(TREE, { listCwds: async () => { throw new Error('no lsof'); } })).toBeNull();
    expect(await worktreeHasLiveProcess('', { listCwds: async () => [] })).toBeNull();
  });
});
