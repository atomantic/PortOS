import { expect, it, vi } from 'vitest';

vi.mock('./domainUsage.js', async (actual) => ({
  ...await actual(),
  getDomainBudgetStatus: async () => ({
    budget: { maxActionsPerDay: 6 },
    usage: { actions: 1 },
    exceeded: null,
  }),
}));

import { resolveAutonomyBudget } from './cosTaskGenerator.js';

it('reserves daily actions for all in-flight on-demand origins while exempting user tasks (#12577)', async () => {
  const running = [
    // Older requests omit the origin; they still count as non-user work.
    ...[undefined, 'user', 'refill', 'quota-burn'].map(onDemandOrigin => ({
      metadata: { taskType: 'internal', onDemand: true, onDemandOrigin },
    })),
    { metadata: { taskType: 'user' } },
  ];

  expect(await resolveAutonomyBudget({ config: { domainAutonomy: { cos: 'execute' } } }, running))
    .toEqual({ cosAutonomyMode: 'execute', autonomousActionsRemaining: 1 });
});
