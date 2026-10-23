import { describe, expect, it } from 'vitest';
import { runCodeReviewBatches, takeCodeReviewCallBudget } from './codeReviewBatches.js';

// This state-machine edge cannot be simulated by an HTTP error: it is the
// orchestration callback itself rejecting after earlier validated findings.
describe('code review batch exceptions', () => {
  it('keeps completed findings and exact coverage when later preparation throws', async () => {
    const section = name => `diff --git a/${name} b/${name}\n+${'x'.repeat(700)}\n`;
    let calls = 0;
    const result = await runCodeReviewBatches({ diff: section('a.js') + section('b.js'), headSha: 'a'.repeat(40), budgetMs: 1000, maxBatchBytes: 1024,
      runBatch: async (_input, remainingMs, budget) => {
        takeCodeReviewCallBudget(budget, remainingMs);
        if (calls++) throw new Error('/private/preparation');
        return { ok: true, verdict: 'findings', findings: 'Serialize the persisted write.' };
      },
    });
    expect(result).toMatchObject({ ok: false, code: 'REVIEW_BATCH_FAILED', verdict: 'findings', findings: 'Serialize the persisted write.', coverage: { headSha: 'a'.repeat(40), complete: false, calls: 2, reviewedFiles: [0], remainingFiles: [1] } });
    expect(JSON.stringify(result)).not.toContain('/private/preparation');
  });
});
