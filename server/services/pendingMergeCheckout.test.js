import { expect, it, vi } from 'vitest';

vi.mock('../lib/execGit.js', () => ({ execGit: vi.fn() }));
import { execGit } from '../lib/execGit.js';
import { verifyPendingMergeCheckout } from './pendingMergeCheckout.js';

it('retains checkout ownership until every Git probe settles after one probe rejects', async () => {
  const status = Promise.withResolvers();
  execGit.mockImplementation(async args => {
    if (args[0] === 'symbolic-ref') throw new Error('detached HEAD');
    if (args[0] === 'status') return status.promise;
    return { stdout: args.includes('HEAD^{commit}') ? 'a'.repeat(40) : '/common' };
  });
  const settled = vi.fn();
  const checking = verifyPendingMergeCheckout('/repo', '/claim', 'claim/issue-1', 'a'.repeat(40));
  const observed = checking.then(settled);
  try {
    // Drain the rejected probe's promise reactions without advancing time.
    // The outstanding status probe still owns the checkout's working directory.
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).not.toHaveBeenCalled();
    status.resolve({ stdout: '' });
    await expect(checking).resolves.toBe(false);
  } finally {
    status.resolve({ stdout: '' });
    await observed;
  }
});
