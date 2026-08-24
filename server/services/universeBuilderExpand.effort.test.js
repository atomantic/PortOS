import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveProviderAndModelMock, runPromptThroughProviderMock } = vi.hoisted(() => ({
  resolveProviderAndModelMock: vi.fn(),
  runPromptThroughProviderMock: vi.fn(),
}));

vi.mock('./promptRunner.js', () => ({
  assertProvider: vi.fn(),
  resolveProviderAndModel: (...args) => resolveProviderAndModelMock(...args),
  runPromptThroughProvider: (...args) => runPromptThroughProviderMock(...args),
}));

const { expandWorldTemplate, narrativeRepairTargets } = await import('./universeBuilderExpand.js');

const provider = { id: 'codex-tui', name: 'Codex TUI', type: 'tui' };

beforeEach(() => {
  resolveProviderAndModelMock.mockReset();
  runPromptThroughProviderMock.mockReset();
  resolveProviderAndModelMock.mockResolvedValue({ provider, selectedModel: 'gpt-5.6-sol' });
  runPromptThroughProviderMock.mockResolvedValue({
    text: JSON.stringify({
      logline: 'A repaired world.',
      premise: 'Costs and limits now drive the conflict.',
      styleNotes: 'Specific and tactile.',
      influences: { embrace: [], avoid: [] },
      categories: {},
      compositeSheets: [],
      characters: [],
      places: [],
      objects: [],
    }),
    runId: 'run-world-repair',
  });
});

describe('expandWorldTemplate reasoning effort', () => {
  it('forwards a caller effort override to the provider runner', async () => {
    await expandWorldTemplate({
      starterPrompt: 'Example Universe',
      providerId: 'codex-tui',
      model: 'gpt-5.6-sol',
      effort: 'ultra',
    });

    expect(runPromptThroughProviderMock).toHaveBeenCalledWith(expect.objectContaining({
      provider,
      model: 'gpt-5.6-sol',
      effort: 'ultra',
      source: 'universe-builder-expansion',
    }));
  });

  it('uses a narrative-only contract for foundation world repairs', async () => {
    await expandWorldTemplate({
      starterPrompt: 'Example Universe',
      foundationDirective: 'Define the relay hops and their metabolic cost.',
      providerId: 'codex-tui',
      model: 'gpt-5.6-sol',
      effort: 'ultra',
      narrativeOnly: true,
    });

    const call = runPromptThroughProviderMock.mock.calls[0][0];
    expect(call).toMatchObject({
      effort: 'ultra',
      source: 'universe-builder-narrative-repair',
    });
    expect(call.prompt).toContain('exact costs');
    expect(call.prompt).toContain('Define the relay hops and their metabolic cost.');
    expect(call.prompt).toContain('Do not emit influences, categories, compositeSheets, characters, places, objects');
    expect(call.prompt).not.toContain('Generate 5-12 categories');
    expect(call.prompt).not.toContain('world_pitch_poster');
  });

  it('compresses the actual oversized narrative draft before persistence can clip it', async () => {
    runPromptThroughProviderMock
      .mockResolvedValueOnce({
        text: JSON.stringify({
          logline: 'A repaired world.',
          premise: 'x'.repeat(20_001),
          styleNotes: 'Specific and tactile.',
        }),
        runId: 'run-oversized',
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          logline: 'A repaired world.',
          premise: 'Trade, authority, and travel now end in a complete rule.',
          styleNotes: 'Specific and tactile.',
        }),
        runId: 'run-bounded',
      });

    const result = await expandWorldTemplate({
      starterPrompt: 'Example Universe',
      foundationDirective: 'Define ordinary governance.',
      providerId: 'codex-tui',
      model: 'gpt-5.6-sol',
      effort: 'ultra',
      narrativeOnly: true,
    });

    expect(runPromptThroughProviderMock).toHaveBeenCalledTimes(2);
    expect(runPromptThroughProviderMock.mock.calls[1][0].prompt).toContain('premise exceeds 20000 characters (got 20001)');
    expect(runPromptThroughProviderMock.mock.calls[1][0].prompt).toContain(`"premise": "${'x'.repeat(200)}`);
    expect(runPromptThroughProviderMock.mock.calls[1][0].prompt).toContain('premise: at most 18000 characters');
    expect(runPromptThroughProviderMock.mock.calls[1][0].prompt).toContain('Do not cut off a sentence');
    expect(runPromptThroughProviderMock.mock.calls[1][0].prompt).not.toContain('# Starter idea');
    expect(result.premise).toBe('Trade, authority, and travel now end in a complete rule.');
    expect(result.llm).toMatchObject({ provider: 'codex-tui', model: 'gpt-5.6-sol' });
  });

  it('tightens headroom while carrying the latest rejected draft into a final compression pass', async () => {
    runPromptThroughProviderMock
      .mockResolvedValueOnce({
        text: JSON.stringify({
          logline: 'A repaired world.',
          premise: 'a'.repeat(21_000),
          styleNotes: 'Specific and tactile.',
        }),
        runId: 'run-oversized',
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          logline: 'A repaired world.',
          premise: 'b'.repeat(20_200),
          styleNotes: 'Specific and tactile.',
        }),
        runId: 'run-still-oversized',
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          logline: 'A repaired world.',
          premise: 'A complete, compact operating rule.',
          styleNotes: 'Specific and tactile.',
        }),
        runId: 'run-bounded',
      });

    const result = await expandWorldTemplate({
      starterPrompt: 'Example Universe',
      foundationDirective: 'Define ordinary governance.',
      providerId: 'codex-tui',
      model: 'gpt-5.6-sol',
      effort: 'ultra',
      narrativeOnly: true,
    });

    expect(runPromptThroughProviderMock).toHaveBeenCalledTimes(3);
    expect(runPromptThroughProviderMock.mock.calls[2][0].prompt).toContain(`"premise": "${'b'.repeat(200)}`);
    expect(runPromptThroughProviderMock.mock.calls[2][0].prompt).toContain('premise: at most 16000 characters');
    expect(runPromptThroughProviderMock.mock.calls[2][0].prompt).not.toContain(`"premise": "${'a'.repeat(200)}`);
    expect(result.premise).toBe('A complete, compact operating rule.');
  });

  it('retries the source task when there is no complete draft to compress', async () => {
    runPromptThroughProviderMock
      .mockResolvedValueOnce({
        text: JSON.stringify({
          premise: 'A world without its required pitch.',
          styleNotes: 'Specific and tactile.',
        }),
        runId: 'run-missing-field',
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          logline: 'A repaired world.',
          premise: 'A complete operating rule.',
          styleNotes: 'Specific and tactile.',
        }),
        runId: 'run-complete',
      });

    await expandWorldTemplate({
      starterPrompt: 'Example Universe',
      foundationDirective: 'Define ordinary governance.',
      providerId: 'codex-tui',
      model: 'gpt-5.6-sol',
      effort: 'ultra',
      narrativeOnly: true,
    });

    expect(runPromptThroughProviderMock.mock.calls[1][0].prompt).toContain('# Starter idea');
    expect(runPromptThroughProviderMock.mock.calls[1][0].prompt).toContain('logline is missing');
    expect(runPromptThroughProviderMock.mock.calls[1][0].prompt).toContain('Return a complete replacement');
  });
});

// A judge-directed repair ADDS material. Without a write budget below the hard
// cap, a bible field that earlier repairs filled to the ceiling makes the repair
// unsatisfiable: the model returns a same-size rewrite, it passes the cap check,
// the judge re-scores an unchanged world, and the autopilot foundation gate
// loops until it pauses on non-convergence.
describe('expandWorldTemplate narrative write budget — saturated bible fields', () => {
  const SATURATED_PREMISE = 'p'.repeat(19_995);

  it('leaves a field under the headroom mark on its full cap', () => {
    const targets = narrativeRepairTargets({ premise: 'p'.repeat(1_000) });
    expect(targets.premise).toMatchObject({ max: 20_000, target: 20_000, saturated: false });
  });

  it('budgets a saturated field below its cap so the repair has somewhere to land', () => {
    const targets = narrativeRepairTargets({ premise: SATURATED_PREMISE });
    expect(targets.premise).toMatchObject({ target: 17_000, saturated: true, priorLength: 19_995 });
    expect(targets.logline).toMatchObject({ target: 500, saturated: false });
  });

  it('tells the repair to consolidate rather than append when the premise is at the ceiling', async () => {
    runPromptThroughProviderMock.mockResolvedValueOnce({
      text: JSON.stringify({
        logline: 'A repaired world.',
        premise: 'p'.repeat(16_000),
        styleNotes: 'Specific and tactile.',
      }),
      runId: 'run-consolidated',
    });

    await expandWorldTemplate({
      starterPrompt: 'Example Universe',
      premise: SATURATED_PREMISE,
      foundationDirective: 'Add a resonance ruleset with inputs, range, costs, and hard impossibilities.',
      providerId: 'codex-tui',
      narrativeOnly: true,
    });

    const { prompt } = runPromptThroughProviderMock.mock.calls[0][0];
    expect(prompt).toContain('# Consolidation mandate — premise is at the storage ceiling');
    expect(prompt).toContain('max 17000 characters');
    expect(prompt).toContain('the established premise is already 19995 characters');
    expect(prompt).toContain('Never drop a causal rule, hard limit, cost, failure mode');
    // Fields with room keep their full cap and stay out of the mandate.
    expect(prompt).toContain('one sentence (max 500 characters)');
  });

  it('rejects a same-size rewrite that fits the cap but not the write budget', async () => {
    runPromptThroughProviderMock
      .mockResolvedValueOnce({
        text: JSON.stringify({
          logline: 'A repaired world.',
          premise: 'q'.repeat(19_990),
          styleNotes: 'Specific and tactile.',
        }),
        runId: 'run-no-op-rewrite',
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          logline: 'A repaired world.',
          premise: 'q'.repeat(15_000),
          styleNotes: 'Specific and tactile.',
        }),
        runId: 'run-consolidated',
      });

    const result = await expandWorldTemplate({
      starterPrompt: 'Example Universe',
      premise: SATURATED_PREMISE,
      foundationDirective: 'Add a resonance ruleset.',
      providerId: 'codex-tui',
      narrativeOnly: true,
    });

    expect(runPromptThroughProviderMock).toHaveBeenCalledTimes(2);
    const retry = runPromptThroughProviderMock.mock.calls[1][0].prompt;
    expect(retry).toContain('premise exceeds 17000 characters (got 19990)');
    // The compression target shrinks from the WRITE budget, not the hard cap —
    // 90% of 20000 would hand back a draft that fails the same contract.
    expect(retry).toContain('premise: at most 15300 characters');
    expect(result.premise).toBe('q'.repeat(15_000));
  });

  it('names the saturated field when the repair cannot be made to fit', async () => {
    runPromptThroughProviderMock.mockResolvedValue({
      text: JSON.stringify({
        logline: 'A repaired world.',
        premise: 'r'.repeat(19_500),
        styleNotes: 'Specific and tactile.',
      }),
      runId: 'run-never-fits',
    });

    await expect(expandWorldTemplate({
      starterPrompt: 'Example Universe',
      premise: SATURATED_PREMISE,
      foundationDirective: 'Add a resonance ruleset.',
      providerId: 'codex-tui',
      narrativeOnly: true,
    })).rejects.toThrow(/The stored premise already fills its budget/);
  });
});
