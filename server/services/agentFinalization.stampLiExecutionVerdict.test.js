/**
 * Tests for `stampLiExecutionVerdict` (#2779) against its REAL dynamic-import
 * dependencies (`taskLearning/metrics.js#buildLiExecutionVerdict` and
 * `layeredIntelligenceOutcomes.js#LI_EXECUTION_VERDICT_KEY`) rather than a
 * mock — every existing caller mocks this function to an identity passthrough
 * (see `agentLifecycle.test.js`, `agentCompletionRouting.test.js`,
 * `agentManagement.test.js`), so its own no-op/build behavior had no coverage
 * of its own before issue #8440.
 */
import { describe, expect, it } from 'vitest';
import { stampLiExecutionVerdict } from './agentFinalization.js';
import { LI_EXECUTION_VERDICT_KEY } from './layeredIntelligenceOutcomes.js';

const LI_PROPOSAL = { appId: 'app-example', slug: 'example-slug', scope: 'repo' };

describe('stampLiExecutionVerdict (#2779, #8440)', () => {
  it('leaves the update untouched when the task carries no liProposal', async () => {
    const taskUpdate = { status: 'completed' };
    const task = { id: 'task-1', metadata: {} };

    const result = await stampLiExecutionVerdict(taskUpdate, task, { success: true });

    expect(result).toBe(taskUpdate);
    expect(result.metadata).toBeUndefined();
  });

  it('stamps a success verdict for a hand-off task settled completed', async () => {
    const task = { id: 'task-1', metadata: { liProposal: LI_PROPOSAL } };

    const result = await stampLiExecutionVerdict({ status: 'completed' }, task, { success: true });

    expect(result.metadata[LI_EXECUTION_VERDICT_KEY]).toMatchObject({
      appId: 'app-example',
      slug: 'example-slug',
      success: true,
    });
  });

  it('stamps a failure verdict for a hand-off task settled blocked', async () => {
    const task = { id: 'task-1', metadata: { liProposal: LI_PROPOSAL } };

    const result = await stampLiExecutionVerdict({ status: 'blocked' }, task, { success: false });

    expect(result.metadata[LI_EXECUTION_VERDICT_KEY]).toMatchObject({
      appId: 'app-example',
      slug: 'example-slug',
      success: false,
    });
  });
});
