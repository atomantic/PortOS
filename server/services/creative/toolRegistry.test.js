import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

// Mock the voice registry so hydration + the hydrateFrom guard resolve without
// pulling the heavy voice/tool graph into this unit test.
vi.mock('../voice/tools.js', () => ({
  getToolMetadata: vi.fn((id) =>
    id === 'catalog_lookup'
      ? {
          id: 'catalog_lookup',
          description: 'VOICE catalog search description',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        }
      : null),
  // Resolved specs carry the spec-build-time widening (custom catalog types in
  // the `type` enum) that the static metadata above lacks — hydration reads this.
  getToolSpecs: vi.fn(() => [
    {
      type: 'function',
      function: {
        name: 'catalog_lookup',
        description: 'VOICE catalog search description',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            type: { type: 'string', enum: ['character', 'wardrobe', 'faction'] },
          },
          required: ['query'],
        },
      },
    },
  ]),
  dispatchTool: vi.fn(async () => ({ summary: 'voice catalog result', results: [] })),
}));

// Mock the autonomy config + budget/usage services so gating is deterministic.
vi.mock('../cosState.js', () => ({ loadState: vi.fn(async () => ({ config: {} })) }));
vi.mock('../domainUsage.js', () => ({
  getDomainBudgetStatus: vi.fn(async () => ({ withinBudget: true, exceeded: null })),
  recordDomainUsage: vi.fn(async () => {}),
}));

// Mock every wrapped entry point — keeps the real services (and their heavy
// import side effects) out, and makes each tool's execute an observable spy.
vi.mock('../universeBuilder.js', () => ({
  createUniverse: vi.fn(async () => ({ id: 'u1' })),
  needsEntryIdPersist: vi.fn(async () => false),
  updateUniverse: vi.fn(async () => ({})),
}));
vi.mock('../universeBuilderExpand.js', () => ({ expandWorldTemplate: vi.fn(async () => ({ logline: 'x' })) }));
vi.mock('../universeBuilderRender.js', () => ({ renderUniverseJobs: vi.fn(async () => ({ jobs: [] })) }));
vi.mock('../storyBuilder.js', () => ({
  createStorySession: vi.fn(async () => ({ id: 's1' })),
  generateStep: vi.fn(async () => ({ runId: 'r1' })),
  generateIssuesFromArc: vi.fn(async () => ({ createdIssues: [] })),
}));
vi.mock('../writersRoom/local.js', () => ({ createWork: vi.fn(async () => ({ id: 'w1' })) }));
vi.mock('../writersRoom/evaluator.js', () => ({ runAnalysis: vi.fn(async () => ({ status: 'succeeded' })) }));
vi.mock('../pipeline/series.js', () => ({ createSeries: vi.fn(async () => ({ id: 'ser1' })) }));
vi.mock('../pipeline/seriesGenerate.js', () => ({ generateSeriesConcept: vi.fn(async () => ({ name: 'C' })) }));
vi.mock('../pipeline/textStages.js', () => ({ generateStage: vi.fn(async () => ({ stage: 'st' })) }));
vi.mock('../pipeline/seriesAutopilot.js', () => ({ startSeriesAutopilot: vi.fn(async () => ({ runId: 'ap1' })) }));
vi.mock('../mediaJobQueue/index.js', () => ({ enqueueJob: vi.fn(() => ({ jobId: 'mj1' })) }));
vi.mock('../catalogDB.js', () => ({ listIngredients: vi.fn(async () => ({ items: [] })) }));
vi.mock('../creativeDirector/autoCast.js', () => ({ suggestCastForBrief: vi.fn(async () => []) }));

import { loadState } from '../cosState.js';
import { dispatchTool as dispatchVoiceTool } from '../voice/tools.js';
import { getDomainBudgetStatus, recordDomainUsage } from '../domainUsage.js';
import { createSeries } from '../pipeline/series.js';
import { generateStage } from '../pipeline/textStages.js';
import { startSeriesAutopilot } from '../pipeline/seriesAutopilot.js';
import { enqueueJob } from '../mediaJobQueue/index.js';
import {
  CREATIVE_TOOLS,
  getToolSpecs,
  getAllCreativeToolNames,
  getCreativeToolMetadata,
  filterDestructive,
  assertCreativeToolIntegrity,
  dispatchCreativeTool,
} from './toolRegistry.js';

const setMode = (mode) => loadState.mockResolvedValue({ config: { domainAutonomy: { cos: mode } } });

beforeEach(() => {
  vi.clearAllMocks();
  loadState.mockResolvedValue({ config: {} });
  getDomainBudgetStatus.mockResolvedValue({ withinBudget: true, exceeded: null });
});

describe('registry shape', () => {
  it('registers the six-domain tool inventory with unique names', () => {
    const names = getAllCreativeToolNames();
    expect(new Set(names).size).toBe(names.length);
    for (const prefix of ['universe_', 'storyBuilder_', 'writersRoom_', 'pipeline_', 'media_', 'catalog_']) {
      expect(names.some((n) => n.startsWith(prefix))).toBe(true);
    }
  });

  it('every tool carries schema + execute + a valid cost class', () => {
    for (const t of CREATIVE_TOOLS) {
      expect(typeof t.execute).toBe('function');
      expect(typeof t.schema.parse).toBe('function');
      expect(['free', 'llm', 'render']).toContain(t.costClass);
    }
  });

  it('every registered tool name is function-calling-safe (no dots)', () => {
    for (const name of getAllCreativeToolNames()) {
      expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
  });

  it('getToolSpecs returns OpenAI function specs suitable for a prompt', () => {
    const specs = getToolSpecs();
    expect(specs.length).toBe(CREATIVE_TOOLS.length);
    for (const s of specs) {
      expect(s.type).toBe('function');
      expect(typeof s.function.name).toBe('string');
      expect(s.function.parameters.type).toBe('object');
    }
  });

  it('hydrates catalog_searchIngredients from the voice tool\'s RESOLVED spec (custom types survive)', () => {
    const meta = getCreativeToolMetadata('catalog_searchIngredients');
    expect(meta.description).toBe('VOICE catalog search description');
    expect(meta.parameters.required).toEqual(['query']);
    // The widened enum (custom catalog types) from the resolved spec must survive,
    // not the static built-in-only metadata.
    expect(meta.parameters.properties.type.enum).toEqual(['character', 'wardrobe', 'faction']);
  });
});

describe('assertCreativeToolIntegrity', () => {
  const ok = { name: 'a_x', costClass: 'free', schema: z.object({}), execute: () => {} };

  it('accepts a valid tool set', () => {
    expect(() => assertCreativeToolIntegrity([ok])).not.toThrow();
  });
  it('throws on a duplicate name', () => {
    expect(() => assertCreativeToolIntegrity([ok, { ...ok }])).toThrow(/duplicate tool name/);
  });
  it('throws on a function-calling-unsafe (dotted) name', () => {
    expect(() => assertCreativeToolIntegrity([{ ...ok, name: 'a.x' }])).toThrow(/function-calling-safe/);
  });
  it('throws on a missing execute', () => {
    expect(() => assertCreativeToolIntegrity([{ ...ok, execute: undefined }])).toThrow(/missing execute/);
  });
  it('throws on a missing Zod schema', () => {
    expect(() => assertCreativeToolIntegrity([{ ...ok, schema: undefined }])).toThrow(/missing a Zod schema/);
  });
  it('throws on an invalid cost class', () => {
    expect(() => assertCreativeToolIntegrity([{ ...ok, costClass: 'bogus' }])).toThrow(/invalid costClass/);
  });
  it('throws when hydrateFrom names an unknown voice tool', () => {
    expect(() => assertCreativeToolIntegrity([{ ...ok, hydrateFrom: 'nope' }], () => null)).toThrow(/hydrateFrom/);
  });
});

describe('filterDestructive', () => {
  it('excludes destructive tools by default and includes them on request', () => {
    const tools = [{ name: 'a' }, { name: 'b', destructive: true }];
    expect(filterDestructive(tools, false).map((t) => t.name)).toEqual(['a']);
    expect(filterDestructive(tools, true).map((t) => t.name)).toEqual(['a', 'b']);
  });
});

describe('dispatch gating per mode', () => {
  it('off → rejects without executing or charging', async () => {
    setMode('off');
    const out = await dispatchCreativeTool('pipeline_createSeries', { name: 'S' });
    expect(out).toMatchObject({ ok: false, rejected: true, reason: 'autonomy-off', mode: 'off' });
    expect(createSeries).not.toHaveBeenCalled();
    expect(recordDomainUsage).not.toHaveBeenCalled();
  });

  it('dry-run → returns a plan frame with no side effects', async () => {
    setMode('dry-run');
    const out = await dispatchCreativeTool('pipeline_generateStage', { issueId: 'i1', stageId: 'st1' });
    expect(out).toMatchObject({ ok: true, planned: true, mode: 'dry-run', tool: 'pipeline_generateStage', costClass: 'llm' });
    expect(out.args).toMatchObject({ issueId: 'i1', stageId: 'st1' });
    expect(generateStage).not.toHaveBeenCalled();
    expect(recordDomainUsage).not.toHaveBeenCalled();
  });

  it('execute → runs the wrapped entry point and returns its result', async () => {
    setMode('execute');
    const out = await dispatchCreativeTool('pipeline_createSeries', { name: 'S' });
    expect(out).toMatchObject({ ok: true, mode: 'execute', tool: 'pipeline_createSeries' });
    expect(out.result).toEqual({ id: 'ser1' });
    expect(createSeries).toHaveBeenCalledWith({ name: 'S' });
  });

  it('creative mode mirrors cos but an explicit creative override wins', async () => {
    loadState.mockResolvedValue({ config: { domainAutonomy: { cos: 'off', creative: 'execute' } } });
    const out = await dispatchCreativeTool('pipeline_createSeries', { name: 'S' });
    expect(out.ok).toBe(true);
    expect(createSeries).toHaveBeenCalled();
  });

  it('rejects an unknown tool', async () => {
    await expect(dispatchCreativeTool('nope.doThing', {})).rejects.toThrow(/Unknown creative tool/);
  });

  it('throws on invalid args (Zod) before any gating', async () => {
    setMode('execute');
    await expect(dispatchCreativeTool('pipeline_generateStage', { issueId: 'i1' })).rejects.toBeInstanceOf(z.ZodError);
    expect(generateStage).not.toHaveBeenCalled();
  });
});

describe('budget charging', () => {
  it('charges one action for an llm tool on execute', async () => {
    setMode('execute');
    await dispatchCreativeTool('pipeline_generateStage', { issueId: 'i1', stageId: 'st1' });
    expect(recordDomainUsage).toHaveBeenCalledWith('cos', { actions: 1 });
    expect(generateStage).toHaveBeenCalled();
  });

  it('charges for a render (media) tool on execute', async () => {
    setMode('execute');
    await dispatchCreativeTool('media_enqueueImageJob', { params: { prompt: 'p' } }, { projectId: 'p1' });
    expect(recordDomainUsage).toHaveBeenCalledWith('cos', { actions: 1 });
    expect(enqueueJob).toHaveBeenCalledWith({ kind: 'image', params: { prompt: 'p' }, owner: 'creative-director:p1' });
  });

  it('does not charge a free tool', async () => {
    setMode('execute');
    await dispatchCreativeTool('pipeline_createSeries', { name: 'S' });
    expect(recordDomainUsage).not.toHaveBeenCalled();
  });

  it('catalog.searchIngredients delegates to the voice catalog_lookup tool (honors the hydrated contract)', async () => {
    setMode('execute');
    const out = await dispatchCreativeTool('catalog_searchIngredients', { query: 'noir' }, { some: 'ctx' });
    expect(dispatchVoiceTool).toHaveBeenCalledWith('catalog_lookup', { query: 'noir' }, { some: 'ctx' });
    expect(out.ok).toBe(true);
    expect(recordDomainUsage).not.toHaveBeenCalled(); // free tool
  });

  it('rejects when the budget is exhausted, without executing', async () => {
    setMode('execute');
    getDomainBudgetStatus.mockResolvedValue({ withinBudget: false, exceeded: 'actions' });
    const out = await dispatchCreativeTool('pipeline_generateStage', { issueId: 'i1', stageId: 'st1' });
    expect(out).toMatchObject({ ok: false, rejected: true, reason: 'budget', exceeded: 'actions' });
    expect(generateStage).not.toHaveBeenCalled();
    expect(recordDomainUsage).not.toHaveBeenCalled();
  });

  it('does NOT charge a self-budgeting tool (Series Autopilot charges its own steps)', async () => {
    setMode('execute');
    const out = await dispatchCreativeTool('pipeline_startSeriesAutopilot', { seriesId: 'ser1' });
    expect(out.ok).toBe(true);
    expect(startSeriesAutopilot).toHaveBeenCalled();
    expect(getDomainBudgetStatus).not.toHaveBeenCalled();
    expect(recordDomainUsage).not.toHaveBeenCalled();
  });
});

describe('wrapped-service self-rejection', () => {
  it('surfaces a tool that returns { rejected: true } as a rejected dispatch, not executed', async () => {
    setMode('execute');
    startSeriesAutopilot.mockResolvedValueOnce({ rejected: true, mode: 'off' });
    const appendLedger = vi.fn(async () => {});
    const out = await dispatchCreativeTool('pipeline_startSeriesAutopilot', { seriesId: 'ser1' }, { appendLedger });
    expect(out).toMatchObject({ ok: false, rejected: true });
    expect(out.result).toEqual({ rejected: true, mode: 'off' });
    expect(appendLedger.mock.calls[0][0].outcome).toBe('rejected');
  });
});

describe('run ledger append', () => {
  it('appends an executed entry with tool, digest, outcome and timing', async () => {
    setMode('execute');
    const appendLedger = vi.fn(async () => {});
    await dispatchCreativeTool('pipeline_createSeries', { name: 'S' }, { projectId: 'p1', appendLedger });
    expect(appendLedger).toHaveBeenCalledTimes(1);
    const entry = appendLedger.mock.calls[0][0];
    expect(entry).toMatchObject({ tool: 'pipeline_createSeries', outcome: 'executed' });
    expect(typeof entry.argsDigest).toBe('string');
    expect(typeof entry.timingMs).toBe('number');
  });

  it('records outcome=rejected when off', async () => {
    setMode('off');
    const appendLedger = vi.fn(async () => {});
    await dispatchCreativeTool('pipeline_createSeries', { name: 'S' }, { appendLedger });
    expect(appendLedger.mock.calls[0][0].outcome).toBe('rejected');
  });

  it('records outcome=planned in dry-run', async () => {
    setMode('dry-run');
    const appendLedger = vi.fn(async () => {});
    await dispatchCreativeTool('pipeline_createSeries', { name: 'S' }, { appendLedger });
    expect(appendLedger.mock.calls[0][0].outcome).toBe('planned');
  });

  it('records outcome=error and rethrows when the tool throws', async () => {
    setMode('execute');
    generateStage.mockRejectedValueOnce(new Error('boom'));
    const appendLedger = vi.fn(async () => {});
    await expect(
      dispatchCreativeTool('pipeline_generateStage', { issueId: 'i1', stageId: 'st1' }, { appendLedger }),
    ).rejects.toThrow('boom');
    expect(appendLedger.mock.calls[0][0]).toMatchObject({ outcome: 'error', error: 'boom' });
  });

  it('a ledger sink failure never breaks the dispatch', async () => {
    setMode('execute');
    const appendLedger = vi.fn(async () => { throw new Error('disk full'); });
    const out = await dispatchCreativeTool('pipeline_createSeries', { name: 'S' }, { projectId: 'p1', appendLedger });
    expect(out.ok).toBe(true);
  });
});
