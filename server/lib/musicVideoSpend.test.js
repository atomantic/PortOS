import { describe, expect, it } from 'vitest';
import { projectSpend, renderSpendEntry, summarizeRenderSpend } from './musicVideoSpend.js';

const job = (id, params) => ({ id, kind: 'video', params: { mode: 'fal', musicVideo: { projectId: 'mv-a' }, ...params } });
const entry = (id, usd, params = {}) => renderSpendEntry({ job: job(id, params), estimatedUsd: usd, at: `2026-11-16T00:00:0${id.length}.000Z` });

describe('projectSpend with a render ledger', () => {
  it("counts a production run's steps once, whichever of its usage and its ledger renders is larger", () => {
    const tagged = { musicVideo: { projectId: 'mv-a', productionRunId: 'run-1' } };
    const entries = [entry('a', 2, tagged), entry('b', 1, tagged), entry('c', 0.5)];
    const base = { id: 'mv-a', scenes: [] };
    const under = { ...base, productionRuns: [{ id: 'run-1', usage: { spentUsd: 2.5 } }] };
    const over = { ...base, productionRuns: [{ id: 'run-1', usage: { spentUsd: 4 } }] };
    const spentUnder = projectSpend({ ...under, renderSpend: summarizeRenderSpend(entries, under) });
    const spentOver = projectSpend({ ...over, renderSpend: summarizeRenderSpend(entries, over) });
    expect(spentUnder).toMatchObject({ autopilot: 3, manual: 0.5, spentUsd: 3.5 });
    // The run charged $1 the ledger never saw (a review call): it shows as earlier estimates.
    expect(spentOver).toMatchObject({ autopilot: 4, manual: 0.5, spentUsd: 4.5 });
    expect(spentOver.lanes.reduce((sum, row) => sum + row.totalUsd, 0)).toBe(spentOver.spentUsd);
  });

  it('leaves a project without a ledger on the take-and-run total', () => {
    const project = { scenes: [{ takes: [{ spendKind: 'autoReview', costUsd: 0.25 }] }], productionRuns: [{ usage: { spentUsd: 1 } }], automation: { budgetUsd: 10 } };
    expect(projectSpend(project)).toMatchObject({ spentUsd: 1.25, autoReview: 0.25, autopilot: 1, capUsd: 10, lanes: [] });
  });

  it('records no entry for an unmetered lane or an untagged job', () => {
    expect(renderSpendEntry({ job: job('a', { mode: 'grok' }), estimatedUsd: 1, at: 'x' })).toBeNull();
    expect(renderSpendEntry({ job: { id: 'b', kind: 'video', params: { mode: 'fal' } }, estimatedUsd: 1, at: 'x' })).toBeNull();
  });
});
