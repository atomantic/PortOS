import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/gitRemote.js', () => ({ getOriginInfo: vi.fn(async () => ({ host: 'github.com', fullName: 'example/repo' })) }));
vi.mock('./prProbe.js', () => ({ probeChangeRequestState: vi.fn(async () => ({ readable: true, prState: 'MERGED' })) }));

import { probeChangeRequestState } from './prProbe.js';
import { verifyMergedReviewFollowUp } from './reviewFollowUpCompletion.js';

const PR_URL = 'https://github.com/example/repo/pull/42';
const followUp = (metadata = {}) => ({
  taskType: 'internal',
  metadata: { reviewLoopFollowUp: true, reviewLoopPRUrl: PR_URL, reviewLoopPRBranch: 'feature/fix', ...metadata },
});

beforeEach(() => vi.clearAllMocks());

describe('verifyMergedReviewFollowUp (#14482)', () => {
  it('settles a follow-up whose assigned PR the forge reports merged', async () => {
    expect(await verifyMergedReviewFollowUp(followUp(), '/repos/worktree')).toEqual({ status: 'verified', prUrl: PR_URL });
  });

  it.each([
    ['a review-loop leave-open', { reviewLoopLeaveOpen: true }],
    ['a leave-open policy', { prCompletion: 'leave-open' }],
    ['a read-only follow-up', { readOnly: 'true' }],
    ['a human-landed PR', { jiraTicketId: 'EX-1' }],
  ])('never lets a merge discharge %s', async (_label, metadata) => {
    expect(await verifyMergedReviewFollowUp(followUp(metadata), '/repos/worktree')).toBeNull();
    expect(probeChangeRequestState).not.toHaveBeenCalled();
  });
});
