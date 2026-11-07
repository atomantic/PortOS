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

// #15260: the sibling list handed to each batch reviewer stays bounded however many files the diff has.
describe('code review batch siblings', () => {
  it('bounds the sibling file list and reports the rest as omitted', async () => {
    const section = name => `diff --git a/${name} b/${name}\n+${'x'.repeat(300)}\n`;
    const diff = Array.from({ length: 150 }, (_, i) => section(`f${i}.js`)).join('');
    const seen = [];
    const result = await runCodeReviewBatches({ diff, budgetMs: 1000, maxBatchBytes: 1024, maxBatches: 64,
      runBatch: async (_input, remainingMs, budget, siblings) => {
        takeCodeReviewCallBudget(budget, remainingMs);
        seen.push(siblings);
        return { ok: true, verdict: 'clean', findings: 'No findings.' };
      },
    });
    expect(result.ok).toBe(true);
    expect(seen[0]).toMatchObject({ batchFiles: 3, totalFiles: 150, omittedFiles: 47 });
    expect(seen[0].otherFiles).toHaveLength(100);
    expect(seen[0].otherFiles).not.toContain('a/f0.js b/f0.js');
  });
});
