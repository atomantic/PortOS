import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  root: { persistentMind: { toolActivation: { leases: {}, lastAgedTurnId: null } } },
  dispatch: vi.fn(),
  executeTasks: vi.fn(),
  cleanupMind: vi.fn(),
  protectMemory: vi.fn(),
  chooseName: vi.fn(),
  worldStatus: vi.fn(),
  worldProject: vi.fn(),
  worldAugment: vi.fn(),
  worldSay: vi.fn(),
  listUserActions: vi.fn(),
  fileIssue: vi.fn(),
  listIssues: vi.fn(),
  adoptFoundation: vi.fn(),
  getFoundationByRef: vi.fn(),
  listFoundations: vi.fn(),
  promoteFoundation: vi.fn(),
  recordFoundation: vi.fn(),
  listContributions: vi.fn(),
  ensureInstanceId: vi.fn(),
}));

const specs = [
  {
    type: 'function',
    function: {
      name: 'brain_search',
      description: 'Search Brain records. Longer voice-only instructions are omitted.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'brain_capture',
      description: 'Capture a Brain record.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
  },
];

vi.mock('./voice/tools.js', () => ({
  getToolSpecs: () => specs,
  getToolSpecsForIntent: () => ({ specs, activeGroups: new Set() }),
  dispatchTool: (...args) => mocks.dispatch(...args),
}));
vi.mock('./persistentMindTaskCapability.js', () => ({
  executePersistentMindTaskRequests: (...args) => mocks.executeTasks(...args),
}));
vi.mock('./persistentMindIssueCapability.js', () => ({
  filePersistentMindIssue: (...args) => mocks.fileIssue(...args),
  listPersistentMindIssues: (...args) => mocks.listIssues(...args),
}));
vi.mock('./persistentMindContext.js', () => ({ choosePersistentMindName: (...args) => mocks.chooseName(...args), protectPersistentMindMemory: (...args) => mocks.protectMemory(...args) }));
vi.mock('./persistentMindMaintenance.js', () => ({
  cleanupPersistentMind: (...args) => mocks.cleanupMind(...args),
}));
vi.mock('./eidoverseWorld.js', () => ({
  getEidoverseWorldStatus: (...args) => mocks.worldStatus(...args),
  projectEidoverseWorld: (...args) => mocks.worldProject(...args),
  augmentEidoverseWorld: (...args) => mocks.worldAugment(...args),
  sayInEidoverseWorld: (...args) => mocks.worldSay(...args),
}));
vi.mock('./eidoverseFoundationLedger.js', () => ({
  adoptEidoverseFoundation: (...args) => mocks.adoptFoundation(...args),
  getEidoverseFoundationByRef: (...args) => mocks.getFoundationByRef(...args),
  listEidoverseFoundations: (...args) => mocks.listFoundations(...args),
  promoteEidoverseFoundation: (...args) => mocks.promoteFoundation(...args),
  recordEidoverseFoundation: (...args) => mocks.recordFoundation(...args),
}));
vi.mock('./eidoverseResilienceContributions.js', () => ({
  listRegisteredContributionIds: (...args) => mocks.listContributions(...args),
}));
vi.mock('./instanceIdentity.js', () => ({
  ensureInstanceId: (...args) => mocks.ensureInstanceId(...args),
}));
vi.mock('./userActions.js', () => ({
  listUserActions: (...args) => mocks.listUserActions(...args),
}));
// Only the progressive tool-exposure lease (#7624) reaches cosState.js
// directly — every other adapter's own state access goes through a mock
// above. A bare, mutable in-memory root keeps every existing executeCosToolCall
// test hermetic instead of touching the real state file.
vi.mock('./cosState.js', () => ({
  loadState: vi.fn(async () => mocks.root),
  saveState: vi.fn(async (root) => { mocks.root = root; }),
  withStateLock: vi.fn(async (fn) => fn()),
}));

import { DEFAULT_TOOL_ACTIVATION_RETENTION_TURNS } from '../lib/persistentMindToolActivation.js';
import {
  __testing,
  buildPersistentMindToolPrompt,
  executeCosToolCall,
  formatCosToolCatalog,
  getCosToolCatalog,
} from './cosToolRegistry.js';

beforeEach(() => {
  vi.clearAllMocks();
  __testing.toolCalls.clear();
  __testing.toolCallFingerprints.clear();
  mocks.root = { persistentMind: { toolActivation: { leases: {}, lastAgedTurnId: null } } };
  mocks.dispatch.mockResolvedValue({ ok: true });
  mocks.executeTasks.mockResolvedValue([{ success: true, task: { id: 'task-1' }, duplicate: false }]);
  mocks.cleanupMind.mockResolvedValue({ ok: true, success: true, state: 'completed', historyEventsCleared: 8 });
  mocks.worldStatus.mockResolvedValue({ world: 'portos', presence: { connected: true } });
  mocks.worldProject.mockResolvedValue({ success: true, summary: { operationCount: 2 } });
  mocks.worldAugment.mockResolvedValue({ success: true, applied: 1 });
  mocks.worldSay.mockResolvedValue({ success: true, world: 'portos' });
});

describe('cosToolRegistry', () => {
  it('allows only a bounded mind-owned naming action under manageMind and deduplicates retries', async () => {
    const call = { requestId: 'name-1', name: 'mind.choose-name', arguments: { name: 'Example Star' } };
    const authority = { scope: 'mind', capabilities: { manageMind: true } };
    await expect(executeCosToolCall({ call, authority: { scope: 'mind', capabilities: { writePortos: true } } })).rejects.toMatchObject({ code: 'TOOL_CAPABILITY_DENIED' });
    await expect(executeCosToolCall({ call, authority: { ...authority, scope: 'agent' } })).rejects.toMatchObject({ code: 'TOOL_SCOPE_DENIED' });
    for (const args of [{ name: '' }, { name: 'x'.repeat(65) }, { name: 'Example', mindId: 'other' }, { name: 'Bad\nName' }]) {
      await expect(executeCosToolCall({ call: { ...call, arguments: args }, authority })).rejects.toBeDefined();
    }
    mocks.chooseName.mockResolvedValue({ ok: true, success: true, name: 'Example Star', previousName: null });
    const first = await executeCosToolCall({ call, authority });
    expect(first).toMatchObject({ state: 'completed', result: { name: 'Example Star' } });
    await executeCosToolCall({ call, authority });
    expect(mocks.chooseName).toHaveBeenCalledTimes(1);
  });

  it('keeps promoting a foundation out of reach of the world-management grant alone', async () => {
    const call = { requestId: 'promote-1', name: 'eidoverse.promote', arguments: { id: 'tide-beacon' } };
    // Building in the local world is not permission to publish out of it, so
    // the world grant on its own has to be refused.
    await expect(executeCosToolCall({ call, authority: { scope: 'mind', capabilities: { manageEidoverse: true } } }))
      .rejects.toMatchObject({ code: 'TOOL_CAPABILITY_DENIED' });
    await expect(executeCosToolCall({ call, authority: { scope: 'mind', capabilities: { promoteEidoverseFoundations: true } } }))
      .rejects.toMatchObject({ code: 'TOOL_CAPABILITY_DENIED' });
    // Promotion reaches past this install, so it is never an agent-scope tool.
    await expect(executeCosToolCall({ call, authority: { scope: 'agent', capabilities: { manageEidoverse: true, promoteEidoverseFoundations: true } } }))
      .rejects.toMatchObject({ code: 'TOOL_SCOPE_DENIED' });

    const granted = { scope: 'mind', capabilities: { manageEidoverse: true, promoteEidoverseFoundations: true } };
    mocks.promoteFoundation.mockResolvedValue({
      outcome: 'promoted', promoted: true, reasons: [], findings: [], assay: { pass: true },
      candidate: { fingerprint: 'a'.repeat(64), body: { affordance: 'example' } },
      foundation: { id: 'tide-beacon', layer: 'baseline', style: { motif: 'weathered brass' }, body: { affordance: 'example' }, updatedAt: '2026-03-04T06:00:00.000Z' },
    });
    const result = await executeCosToolCall({ call, authority: granted });

    expect(result).toMatchObject({ state: 'completed', result: { outcome: 'promoted', promoted: true } });
    expect(mocks.promoteFoundation).toHaveBeenCalledWith('tide-beacon');
    // The install's cosmetics and the packaged envelope must not ride back
    // into the prompt just because the mind asked to publish.
    expect(JSON.stringify(result.result)).not.toContain('weathered brass');
    expect(result.result.candidate).toBeNull();
  });

  it('stamps a mind-authored foundation as vernacular with authorKind "mind", never the caller\'s claim', async () => {
    const call = {
      requestId: 'record-1',
      name: 'eidoverse.record',
      arguments: {
        id: 'lantern-arcade', kind: 'district-template', title: 'Lantern Arcade', summary: 'A row of lanterns around the plaza.',
        contributionId: 'beacon-relay', body: { layoutId: 'radial-ring' }, authorKind: 'user',
      },
    };
    await expect(executeCosToolCall({ call, authority: { scope: 'mind', capabilities: { promoteEidoverseFoundations: true } } }))
      .rejects.toMatchObject({ code: 'TOOL_CAPABILITY_DENIED' });
    await expect(executeCosToolCall({ call, authority: { scope: 'agent', capabilities: { manageEidoverse: true } } }))
      .rejects.toMatchObject({ code: 'TOOL_SCOPE_DENIED' });

    mocks.ensureInstanceId.mockResolvedValue('instance-example');
    mocks.recordFoundation.mockResolvedValue({
      id: 'lantern-arcade', layer: 'vernacular', kind: 'district-template', title: 'Lantern Arcade', summary: 'A row of lanterns around the plaza.',
      contributionId: 'beacon-relay', updatedAt: '2026-03-04T06:00:00.000Z', promotedAt: null, assay: null, candidate: null,
    });
    const result = await executeCosToolCall({ call, authority: { scope: 'mind', capabilities: { manageEidoverse: true } } });

    expect(result).toMatchObject({ state: 'completed', result: { foundation: { id: 'lantern-arcade', layer: 'vernacular' } } });
    expect(mocks.recordFoundation).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'lantern-arcade', authorKind: 'mind' }),
      { originInstanceId: 'instance-example' },
    );
  });

  // The gap #7626 closed: the list projection omits every body, and before the
  // read-one tool existed there was no other way for a mind to obtain one — so
  // a peer's contribution was legible to the human in the panel and
  // structurally unobtainable by every Mind on the install that inherited it.
  it('keeps bodies out of the foundation LIST and returns one on the read-one tool', async () => {
    const authority = { scope: 'mind', capabilities: { manageEidoverse: true } };
    const inherited = {
      id: 'tide-beacon', layer: 'baseline', kind: 'controller', title: 'Tide Beacon', summary: 'Pulses between wakes.',
      body: { controller: { definitionId: 'ambient-beacon', config: { label: 'harbor' } } },
      disclosure: { requires: [], effects: ['speaks a pulse'], license: null, notes: null },
      style: { motif: 'weathered brass' },
      inheritance: { type: 'inherited-from', originInstanceId: 'instance-aaaa', foundationId: 'tide-beacon', fingerprint: 'a'.repeat(64), packagedAt: '2026-03-01T01:00:00.000Z', sourceInstanceId: 'instance-peer-one', inheritedAt: '2026-03-02T00:00:00.000Z' },
    };

    mocks.listFoundations.mockResolvedValue({ counts: { vernacular: 0, baseline: 1, candidates: 0, inherited: 1 }, foundations: [inherited] });
    const listed = await executeCosToolCall({ call: { requestId: 'list-1', name: 'eidoverse.foundations', arguments: {} }, authority });
    // Kilobytes of substance per entry, riding into every turn that asks what
    // exists here, to answer a question about ids.
    expect(listed.result.foundations[0].body).toBeUndefined();
    expect(JSON.stringify(listed.result)).not.toContain('ambient-beacon');

    mocks.getFoundationByRef.mockResolvedValue(inherited);
    const read = await executeCosToolCall({
      call: { requestId: 'read-1', name: 'eidoverse.foundation', arguments: { id: 'tide-beacon', originInstanceId: 'instance-aaaa' } },
      authority,
    });

    expect(mocks.getFoundationByRef).toHaveBeenCalledWith({ id: 'tide-beacon', originInstanceId: 'instance-aaaa' });
    expect(read.result.foundation).toMatchObject({
      id: 'tide-beacon',
      body: { controller: { definitionId: 'ambient-beacon', config: { label: 'harbor' } } },
      disclosure: { effects: ['speaks a pulse'] },
    });
    // This install's cosmetics stay local in BOTH projections.
    expect(JSON.stringify(read.result)).not.toContain('weathered brass');
  });

  it('gates adopting a peer\'s controller on the controller-install grant, not the world grant alone', async () => {
    const call = { requestId: 'adopt-1', name: 'eidoverse.adopt', arguments: { id: 'tide-beacon', originInstanceId: 'instance-aaaa' } };
    // Adopting stands a peer's contribution up as something that RUNS here, so
    // it is at least as consequential as installing a shipped controller and
    // carries the same grant on top of manageEidoverse.
    await expect(executeCosToolCall({ call, authority: { scope: 'mind', capabilities: { manageEidoverse: true } } }))
      .rejects.toMatchObject({ code: 'TOOL_CAPABILITY_DENIED' });

    const granted = { scope: 'mind', capabilities: { manageEidoverse: true, installEidoverseControllers: true } };
    mocks.adoptFoundation.mockResolvedValue({
      outcome: 'adopted', reasons: [],
      install: { id: 'tide-beacon', controllerId: 'ambient-beacon', armed: false, deliverEffects: false, state: { ticks: 0 }, derivedFrom: { type: 'derived-from', originInstanceId: 'instance-aaaa', foundationId: 'tide-beacon', fingerprint: 'a'.repeat(64), derivedAt: '2026-03-02T00:00:00.000Z' } },
    });

    const result = await executeCosToolCall({ call, authority: granted });

    expect(mocks.adoptFoundation).toHaveBeenCalledWith({ id: 'tide-beacon', originInstanceId: 'instance-aaaa' }, { installedBy: 'mind' });
    expect(result.result).toMatchObject({ outcome: 'adopted', install: { armed: false, deliverEffects: false } });
    // The edge is what makes adoption the attribution-keeping re-use path, so
    // it has to survive the prompt-shaped projection.
    expect(result.result.install.derivedFrom).toMatchObject({ originInstanceId: 'instance-aaaa' });
  });

  it('lists registered resilience-assay contributions and the creative catalog', async () => {
    mocks.listContributions.mockResolvedValue(['beacon-relay']);
    const contributions = await executeCosToolCall({
      call: { requestId: 'contrib-1', name: 'eidoverse.contributions', arguments: {} },
      authority: { scope: 'mind', capabilities: { manageEidoverse: true } },
    });
    expect(contributions.result).toEqual({ contributions: ['beacon-relay'] });

    const catalog = await executeCosToolCall({
      call: { requestId: 'catalog-1', name: 'eidoverse.creative-catalog', arguments: {} },
      authority: { scope: 'mind', capabilities: { manageEidoverse: true } },
    });
    expect(catalog.result.materials.length).toBeGreaterThan(0);
    expect(catalog.result.materials[0].colorHex).toMatch(/^#[0-9a-f]{6}$/i);
    expect(catalog.result.layouts.map((layout) => layout.id)).toContain('radial-ring');
  });

  it('computes a named layout into augment-ready operations, deterministically', async () => {
    const call = {
      requestId: 'place-1',
      name: 'eidoverse.place-layout',
      arguments: { layoutId: 'radial-ring', anchor: [1, 0, 2], propCount: 3, seed: 'plaza', assetPath: 'eidoverse/assets/models/lantern.glb', idPrefix: 'plaza' },
    };
    const first = await executeCosToolCall({ call, authority: { scope: 'mind', capabilities: { manageEidoverse: true } } });
    const second = await executeCosToolCall({ call: { ...call, requestId: 'place-2' }, authority: { scope: 'mind', capabilities: { manageEidoverse: true } } });
    expect(first.result.operations).toHaveLength(3);
    expect(first.result.operations.every((op) => op.verb === 'spawn')).toBe(true);
    // Same {layoutId, anchor, seed} must yield byte-identical operations — the
    // determinism the replay claim (#7627) rests on.
    expect(second.result).toEqual(first.result);
  });

  it('drafts an eidoverse.record-ready district-template foundation from a chosen layout, material, and motif', async () => {
    const call = {
      requestId: 'draft-1',
      name: 'eidoverse.draft-foundation',
      arguments: {
        id: 'garden-arcade', title: 'Garden Arcade', summary: 'A colonnade of lanterns around the arrival plaza.',
        contributionId: 'beacon-relay', layoutId: 'radial-ring', materialId: 'sunbaked-clay', motifId: 'lantern-row', anchor: [4, 0, -6],
      },
    };
    const result = await executeCosToolCall({ call, authority: { scope: 'mind', capabilities: { manageEidoverse: true } } });
    expect(result.result.foundation).toMatchObject({ id: 'garden-arcade', kind: 'district-template' });
    expect(result.result.foundation.body.placement.length).toBeGreaterThan(0);
    expect(result.result.foundation.style).toMatchObject({ materialId: 'sunbaked-clay', motifId: 'lantern-row' });
  });

  it('keeps local thinking authority separate and refuses raw configuration arguments', async () => {
    const call = { requestId: 'thinking-1', name: 'mind.request-thinking-preset', arguments: { presetId: 'local', reason: 'Try a focused pass' } };
    await expect(executeCosToolCall({ call, authority: { scope: 'mind', capabilities: { writePortos: true, createTasks: true } } })).rejects.toMatchObject({ code: 'TOOL_CAPABILITY_DENIED' });
    await expect(executeCosToolCall({ call: { ...call, arguments: { ...call.arguments, endpoint: 'https://example.com' } }, authority: { scope: 'mind', capabilities: { chooseThinkingPreset: true } } })).rejects.toMatchObject({ code: 'TOOL_VALIDATION_ERROR' });
    await expect(executeCosToolCall({ call, authority: { scope: 'agent', capabilities: { chooseThinkingPreset: true } } })).rejects.toMatchObject({ code: 'TOOL_SCOPE_DENIED' });
    expect(getCosToolCatalog({ scope: 'mind', capabilities: { chooseThinkingPreset: true } }).tools.filter((tool) => tool.granted).map((tool) => tool.name)).toEqual(['tools.activate', 'tools.deactivate', 'mind.thinking-presets', 'mind.request-thinking-preset']);
  });

  it('gates the forge-issue tools on their own grant and routes them to the issue adapter', async () => {
    const call = { requestId: 'issue-1', name: 'issues.file', arguments: { appId: 'demo-app', title: 'Add a retry', body: 'Why and where.', model: 'medium', effort: 'high' } };
    // Task authority is NOT issue authority: a mind granted one must not
    // inherit the other.
    await expect(executeCosToolCall({ call, authority: { scope: 'mind', capabilities: { createTasks: true, writePortos: true } } }))
      .rejects.toMatchObject({ code: 'TOOL_CAPABILITY_DENIED' });
    await expect(executeCosToolCall({ call: { ...call, requestId: 'issue-2', arguments: { ...call.arguments, model: 'enormous' } }, authority: { scope: 'mind', capabilities: { fileIssues: true } } }))
      .rejects.toMatchObject({ code: 'TOOL_VALIDATION_ERROR' });

    mocks.fileIssue.mockResolvedValue({ ok: true, number: 42, url: 'https://example.com/example/demo/issues/42' });
    const result = await executeCosToolCall({ call: { ...call, requestId: 'issue-3' }, authority: { scope: 'mind', capabilities: { fileIssues: true } } });
    expect(result).toMatchObject({ name: 'issues.file', state: 'completed', result: { number: 42 } });
    expect(mocks.fileIssue).toHaveBeenCalledWith(call.arguments);
    expect(getCosToolCatalog({ scope: 'mind', capabilities: { fileIssues: true } }).tools.filter((tool) => tool.granted).map((tool) => tool.name))
      .toEqual(['tools.activate', 'tools.deactivate', 'issues.list', 'issues.file']);
  });

  it('exports a compact canonical catalog and provider translations', () => {
    const catalog = getCosToolCatalog({ scope: 'mind', capabilities: { readPortos: true } });
    expect(catalog.tools.map((tool) => tool.name)).toEqual([
      'tools.activate', 'tools.deactivate',
      'mind.recipes.create', 'mind.recipes.list', 'mind.recipes.read', 'mind.recipes.update', 'mind.recipes.archive', 'mind.recipes.restore',
      'mind.thinking-presets',
      'mind.request-thinking-preset',
      'mind.local-context',
      'mind.adjust-local-context',
      'cos.create-task',
      'issues.list',
      'issues.file',
      'mind.cleanup',
      'mind.protect-memory',
      'mind.choose-name',
      'user-actions.query',
      'eidoverse.observe',
      'eidoverse.chat',
      'eidoverse.destinations',
      'eidoverse.visit',
      'eidoverse.visit-chat',
      'eidoverse.leave',
      'eidoverse.foundations',
      'eidoverse.foundation',
      'eidoverse.contributions',
      'eidoverse.record',
      'eidoverse.adopt',
      'eidoverse.promote',
      'eidoverse.creative-catalog',
      'eidoverse.place-layout',
      'eidoverse.draft-foundation',
      'eidoverse.controllers',
      'eidoverse.inspect-controller',
      'eidoverse.install-controller',
      'eidoverse.arm-controller',
      'eidoverse.retire-controller',
      'eidoverse.status',
      'eidoverse.project',
      'eidoverse.augment',
      'eidoverse.say',
      'brain.search',
      'brain.capture',
    ]);
    expect(catalog.tools.find((tool) => tool.name === 'brain.search').granted).toBe(true);
    expect(catalog.tools.find((tool) => tool.name === 'brain.capture').granted).toBe(false);
    const openai = formatCosToolCatalog(catalog, 'openai');
    expect(openai.tools).toEqual([
      expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'tools_activate' }) }),
      expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'tools_deactivate' }) }),
      expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'user_actions_query' }) }),
      expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'eidoverse_chat' }) }),
      expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'eidoverse_status' }) }),
      expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'brain_search' }) }),
    ]);
    const mcp = formatCosToolCatalog(catalog, 'mcp');
    expect(mcp.tools.find((tool) => tool.name === 'user_actions_query').annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  });

  it('includes only granted tools in the Persistent Mind prompt when the all-schemas escape hatch is on', async () => {
    const prompt = await buildPersistentMindToolPrompt({ readPortos: true, toolExposureAllSchemas: true });
    // Catalog entries are JSON.stringified as `"name":"<tool>"`. A granted
    // tool's input schema may list the same token as an enum (user-actions.query
    // type `brain.capture`, #5596) — that must not be mistaken for advertising
    // the ungranted write tool.
    expect(prompt).toContain('"name":"brain.search"');
    expect(prompt).not.toContain('"name":"brain.capture"');
  });

  it('exposes the operator-action ledger to mind and agent scopes only behind readPortos', async () => {
    const agentCatalog = getCosToolCatalog({ scope: 'agent', capabilities: { readPortos: true } });
    expect(agentCatalog.tools.find((tool) => tool.providerName === 'user_actions_query').granted).toBe(true);
    // scope 'agent' + granted is exactly what agentContextMcp's
    // semanticToolsForConfig re-exports over the loopback MCP surface.
    expect(formatCosToolCatalog(agentCatalog, 'mcp').tools.map((tool) => tool.name)).toContain('user_actions_query');
    const denied = getCosToolCatalog({ scope: 'agent', capabilities: { writePortos: true } });
    expect(denied.tools.find((tool) => tool.providerName === 'user_actions_query').granted).toBe(false);
    await expect(executeCosToolCall({
      call: { requestId: 'ua-denied', name: 'user-actions.query', arguments: {} },
      authority: { scope: 'mind', capabilities: { createTasks: true } },
    })).rejects.toMatchObject({ code: 'TOOL_CAPABILITY_DENIED' });
    expect(mocks.listUserActions).not.toHaveBeenCalled();
  });

  it('returns bounded ledger events with source reduced to route identity', async () => {
    mocks.listUserActions.mockResolvedValue([
      {
        id: 'evt-1', happenedAt: '2026-09-01T00:00:02.000Z', type: 'cos.schedule.trigger', actor: 'user',
        summary: "Ran scheduled task 'branch-reconcile' on demand", target: 'branch-reconcile', targetName: null,
        payload: { taskType: 'branch-reconcile', prompt: 'use sk-abcdefghijklmnopqrstuvwx for deploy' },
        source: { route: '/api/cos/schedule/trigger', method: 'POST', service: 'taskSchedule', file: '/home/alice/portos/server.js' },
      },
      {
        id: 'evt-2', happenedAt: '2026-09-01T00:00:01.000Z', type: 'settings.update', actor: 'user',
        summary: 'Updated settings with token ghp_abcdefghijklmnopqrstuv inside',
        targetName: 'uses sk-abcdefghijklmnopqrstuvwx here',
        payload: {}, source: { service: 'settings', fn: 'save' },
      },
      {
        id: 'evt-3', happenedAt: '2026-09-01T00:00:00.000Z', type: 'cos.task.create', actor: 'user',
        summary: 'Queued task', payload: {}, source: {},
      },
    ]);
    const result = await executeCosToolCall({
      call: { requestId: 'ua-read', name: 'user-actions.query', arguments: { actor: 'user', limit: 2 } },
      authority: { scope: 'mind', capabilities: { readPortos: true } },
    });
    // Fetches one extra row so a full page reports truncation honestly.
    expect(mocks.listUserActions).toHaveBeenCalledWith({ actor: 'user', limit: 3 });
    expect(result.state).toBe('completed');
    expect(result.result.truncated).toBe(true);
    expect(result.result.events).toHaveLength(2);
    expect(result.result.events[0]).toMatchObject({
      type: 'cos.schedule.trigger',
      target: 'branch-reconcile',
      source: { route: '/api/cos/schedule/trigger', method: 'POST' },
    });
    // A `{ service, fn }` source (and any filesystem path) never crosses out.
    expect(result.result.events[1].source).toEqual({});
    expect(JSON.stringify(result.result)).not.toContain('/home/alice');
    // Free-text projections get the value-side credential scrub — payload
    // string values included (record-time redaction is key-based only).
    expect(result.result.events[1].summary).toBe('Updated settings with token [REDACTED] inside');
    expect(result.result.events[1].targetName).toBe('uses [REDACTED] here');
    expect(result.result.events[0].payload.prompt).toBe('use [REDACTED] for deploy');
  });

  it('rejects an unparseable date filter with field attribution', async () => {
    mocks.listUserActions.mockResolvedValue([]);
    const result = await executeCosToolCall({
      call: { requestId: 'ua-bad-date', name: 'user-actions.query', arguments: { from: 'last tuesday-ish' } },
      authority: { scope: 'mind', capabilities: { readPortos: true } },
    });
    expect(result.state).toBe('failed');
    expect(result.error).toContain("Invalid 'from'");
    expect(mocks.listUserActions).not.toHaveBeenCalled();
  });

  it('clamps the ledger query limit to 100 and rejects unknown filters', async () => {
    mocks.listUserActions.mockResolvedValue([]);
    const result = await executeCosToolCall({
      call: { requestId: 'ua-clamp', name: 'user-actions.query', arguments: { limit: 500 } },
      authority: { scope: 'mind', capabilities: { readPortos: true } },
    });
    expect(result.state).toBe('completed');
    expect(result.result).toEqual({ events: [], truncated: false });
    expect(mocks.listUserActions).toHaveBeenCalledWith({ limit: 101 });
    await expect(executeCosToolCall({
      call: { requestId: 'ua-bad', name: 'user-actions.query', arguments: { sql: 'DROP TABLE' } },
      authority: { scope: 'mind', capabilities: { readPortos: true } },
    })).rejects.toMatchObject({ code: 'TOOL_VALIDATION_ERROR' });
  });

  it('validates arguments and executes an allowed read', async () => {
    const signal = new AbortController().signal;
    const result = await executeCosToolCall({
      call: { requestId: 'read-1', name: 'brain.search', arguments: { query: 'example' } },
      authority: { scope: 'ui', authenticated: false },
      context: { signal },
    });
    expect(result.state).toBe('completed');
    expect(mocks.dispatch).toHaveBeenCalledWith('brain_search', { query: 'example' }, { sideEffects: [], signal });
  });

  it('blocks untrusted HTTP mutations and ungranted mind tools', async () => {
    await expect(executeCosToolCall({
      call: { requestId: 'write-1', name: 'brain.capture', arguments: { text: 'example' } },
      authority: { scope: 'ui', authenticated: false },
    })).rejects.toMatchObject({ code: 'TOOL_AUTH_REQUIRED' });
    await expect(executeCosToolCall({
      call: { requestId: 'write-2', name: 'brain.capture', arguments: { text: 'example' } },
      authority: { scope: 'mind', capabilities: { writePortos: false } },
    })).rejects.toMatchObject({ code: 'TOOL_CAPABILITY_DENIED' });
  });

  it('requires a distinct peer travel grant even when local world management is allowed', async () => {
    await expect(executeCosToolCall({
      call: { requestId: 'peer-travel-denied', name: 'eidoverse.visit', arguments: { peerId: 'peer-example' } },
      authority: { scope: 'mind', capabilities: { readPortos: true, writePortos: true, manageEidoverse: true } },
    })).rejects.toMatchObject({ code: 'TOOL_CAPABILITY_DENIED' });
  });

  it('keeps private-world management separate from generic PortOS writes and propagates cancellation', async () => {
    const signal = new AbortController().signal;
    await expect(executeCosToolCall({
      call: { requestId: 'world-status-denied', name: 'eidoverse.status', arguments: {} },
      authority: { scope: 'mind', capabilities: { manageEidoverse: true } },
    })).rejects.toMatchObject({ code: 'TOOL_CAPABILITY_DENIED' });
    await expect(executeCosToolCall({
      call: { requestId: 'world-project-write-only', name: 'eidoverse.project', arguments: {} },
      authority: { scope: 'mind', capabilities: { readPortos: true, writePortos: true } },
    })).rejects.toMatchObject({ code: 'TOOL_CAPABILITY_DENIED' });

    const status = await executeCosToolCall({
      call: { requestId: 'world-status', name: 'eidoverse.status', arguments: {} },
      authority: { scope: 'mind', capabilities: { readPortos: true } },
      context: { signal },
    });
    const project = await executeCosToolCall({
      call: { requestId: 'world-project', name: 'eidoverse.project', arguments: {} },
      authority: { scope: 'mind', capabilities: { readPortos: true, manageEidoverse: true } },
      context: { signal },
    });
    const augment = await executeCosToolCall({
      call: {
        requestId: 'world-augment',
        name: 'eidoverse.augment',
        arguments: { operations: [{ verb: 'spawn', args: { id: 'example', lib: 'eidoverse/assets/example.glb' } }] },
      },
      authority: { scope: 'mind', capabilities: { manageEidoverse: true } },
      context: { signal },
    });
    const say = await executeCosToolCall({
      call: { requestId: 'world-say', name: 'eidoverse.say', arguments: { text: 'Example message' } },
      authority: { scope: 'mind', capabilities: { manageEidoverse: true } },
      context: { signal },
    });
    const agentAugment = await executeCosToolCall({
      call: {
        requestId: 'agent-world-augment',
        name: 'eidoverse.augment',
        arguments: { operations: [{ verb: 'remove', args: { id: 'example' } }] },
      },
      authority: { scope: 'agent', capabilities: { manageEidoverse: true } },
      context: { signal },
    });

    expect([status.state, project.state, augment.state, say.state, agentAugment.state])
      .toEqual(['completed', 'completed', 'completed', 'completed', 'completed']);
    expect(mocks.worldStatus).toHaveBeenCalledWith({ compact: true });
    expect(mocks.worldProject).toHaveBeenCalledWith({ signal, compact: true });
    expect(mocks.worldAugment).toHaveBeenCalledWith(
      [{ verb: 'spawn', args: { id: 'example', lib: 'eidoverse/assets/example.glb' } }],
      { signal },
    );
    expect(mocks.worldSay).toHaveBeenCalledWith('Example message', { signal });
  });

  it('requires mind maintenance authority and accepts only protective changes', async () => {
    const call = { requestId: 'protect-1', name: 'mind.protect-memory', arguments: { memoryId: 'memory-1', protection: 'core-identity' } };
    await expect(executeCosToolCall({ call, authority: { scope: 'mind', capabilities: {} } })).rejects.toMatchObject({ code: 'TOOL_CAPABILITY_DENIED' });
    await expect(executeCosToolCall({ call: { ...call, arguments: { ...call.arguments, protection: 'standard' } }, authority: { scope: 'mind', capabilities: { manageMind: true } } })).rejects.toMatchObject({ code: 'TOOL_VALIDATION_ERROR' });
    mocks.protectMemory.mockResolvedValue({ ok: true, success: true, protection: 'core-identity' });
    await executeCosToolCall({ call, authority: { scope: 'mind', capabilities: { manageMind: true } } });
    expect(mocks.protectMemory).toHaveBeenCalledWith({ memoryId: 'memory-1', protection: 'core-identity' });
  });

  it('executes cleanup only with the dedicated mind capability and preserves current provenance', async () => {
    const signal = new AbortController().signal;
    const call = { requestId: 'cleanup-1', name: 'mind.cleanup', arguments: { scopes: ['history'], reason: 'Stale failures' } };
    await expect(executeCosToolCall({
      call,
      authority: { scope: 'mind', capabilities: { manageMind: false } },
    })).rejects.toMatchObject({ code: 'TOOL_CAPABILITY_DENIED' });

    const result = await executeCosToolCall({
      call,
      authority: { scope: 'mind', capabilities: { manageMind: true } },
      context: {
        turnId: 'turn-current',
        wake: { kind: 'message', message: { id: 'message-current' } },
        signal,
      },
    });

    expect(result).toMatchObject({ state: 'completed', result: { historyEventsCleared: 8 } });
    expect(mocks.cleanupMind).toHaveBeenCalledWith({
      scopes: ['history'],
      reason: 'Stale failures',
      requestedBy: 'mind',
      preserveTurnId: 'turn-current',
      preserveMessageId: 'message-current',
    });
  });

  it('coalesces a repeated request id and rejects changed arguments', async () => {
    const first = await executeCosToolCall({
      call: { requestId: 'same-1', name: 'brain.search', arguments: { query: 'one' } },
      authority: { scope: 'ui' },
    });
    const replay = await executeCosToolCall({
      call: { requestId: 'same-1', name: 'brain.search', arguments: { query: 'one' } },
      authority: { scope: 'ui' },
    });
    expect(first.duplicate).toBe(false);
    expect(replay.duplicate).toBe(true);
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    await expect(executeCosToolCall({
      call: { requestId: 'same-1', name: 'brain.search', arguments: { query: 'two' } },
      authority: { scope: 'ui' },
    })).rejects.toMatchObject({ code: 'TOOL_IDEMPOTENCY_CONFLICT' });
  });

  it('fails closed when a retained result is evicted', async () => {
    await executeCosToolCall({
      call: { requestId: 'evicted-write', name: 'brain.capture', arguments: { text: 'example' } },
      authority: { scope: 'mind', capabilities: { writePortos: true } },
    });
    for (let index = 0; index < 500; index += 1) {
      await executeCosToolCall({
        call: { requestId: `fill-${index}`, name: 'brain.search', arguments: { query: String(index) } },
        authority: { scope: 'ui' },
      });
    }
    expect(__testing.toolCalls.has('evicted-write')).toBe(false);
    expect(__testing.toolCallFingerprints.get('evicted-write')?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(__testing.toolCallFingerprints.get('evicted-write')?.fingerprint).not.toContain('example');
    await expect(executeCosToolCall({
      call: { requestId: 'evicted-write', name: 'brain.capture', arguments: { text: 'example' } },
      authority: { scope: 'mind', capabilities: { writePortos: true } },
    })).rejects.toMatchObject({ code: 'TOOL_IDEMPOTENCY_EXPIRED' });
    expect(mocks.dispatch.mock.calls.filter(([name]) => name === 'brain_capture')).toHaveLength(1);
  });

  it('promotes adapter-declared failures to the normalized envelope', async () => {
    mocks.executeTasks.mockResolvedValueOnce([{ success: false, error: 'Queue unavailable' }]);
    const result = await executeCosToolCall({
      call: {
        requestId: 'failed-task',
        name: 'cos.create-task',
        arguments: {
          description: 'Example task', prompt: 'Do the example work.', priority: 'MEDIUM',
          appId: 'portos', providerId: 'codex', model: '', effort: '', prCompletion: 'review-then-merge',
        },
      },
      authority: { scope: 'mind', capabilities: { createTasks: true } },
    });
    expect(result).toMatchObject({
      state: 'failed',
      error: 'Queue unavailable',
      result: { ok: false, state: 'failed', error: 'Queue unavailable' },
    });
  });

  describe('progressive tool exposure (#7624)', () => {
    it('hides a family behind a one-line discoverable index until tools.activate expands it', async () => {
      const capabilities = { manageMind: true };
      const before = await buildPersistentMindToolPrompt(capabilities, [], { turnId: 'turn-1', isUserTurn: true });
      expect(before).not.toContain('"name":"mind.cleanup"');
      expect(before).toContain('mind.cleanup');
      expect(before).toContain('tools.activate');

      const activated = await executeCosToolCall({
        call: { requestId: 'activate-mind', name: 'tools.activate', arguments: { families: ['mind'] } },
        authority: { scope: 'mind', capabilities },
      });
      expect(activated).toMatchObject({ state: 'completed', result: { activated: ['mind'], retentionTurns: 3 } });

      const after = await buildPersistentMindToolPrompt(capabilities, [], { turnId: 'turn-1' });
      expect(after).toContain('"name":"mind.cleanup"');
    });

    it('never exposes an ungranted tool at full schema even with a live lease for its family (fail-closed)', async () => {
      mocks.root.persistentMind.toolActivation = { leases: { mind: 3 }, lastAgedTurnId: 'turn-1' };
      const prompt = await buildPersistentMindToolPrompt({ manageMind: false, readPortos: true }, [], { turnId: 'turn-1' });
      expect(prompt).not.toContain('mind.cleanup');
    });

    it('drops a leased tool immediately once its capability grant is revoked between turns', async () => {
      mocks.root.persistentMind.toolActivation = { leases: { mind: 3 }, lastAgedTurnId: 'turn-1' };
      const stillGranted = await buildPersistentMindToolPrompt({ manageMind: true }, [], { turnId: 'turn-1' });
      expect(stillGranted).toContain('"name":"mind.cleanup"');

      const revoked = await buildPersistentMindToolPrompt({ manageMind: false }, [], { turnId: 'turn-2', isUserTurn: true });
      expect(revoked).not.toContain('mind.cleanup');
    });

    it('does not age the lease across tool-round loops within one turn, only across a new user turn', async () => {
      mocks.root.persistentMind.toolActivation = { leases: { mind: 2 }, lastAgedTurnId: null };
      const capabilities = { manageMind: true };
      // Round 0 of turn-1 ages it (2 -> 1); rounds 1 and 2 of the SAME turn
      // must reuse that aged value rather than aging it again each call.
      await buildPersistentMindToolPrompt(capabilities, [], { turnId: 'turn-1', isUserTurn: true });
      expect(mocks.root.persistentMind.toolActivation.leases.mind).toBe(1);
      await buildPersistentMindToolPrompt(capabilities, [], { turnId: 'turn-1' });
      await buildPersistentMindToolPrompt(capabilities, [], { turnId: 'turn-1' });
      expect(mocks.root.persistentMind.toolActivation.leases.mind).toBe(1);
      // A genuinely new user turn ages it exactly once more.
      await buildPersistentMindToolPrompt(capabilities, [], { turnId: 'turn-2', isUserTurn: true });
      expect(mocks.root.persistentMind.toolActivation.leases.mind).toBe(0);
    });

    it('keeps a family exposed through every round-refresh of the turn it ages to its floor', async () => {
      mocks.root.persistentMind.toolActivation = { leases: { mind: 1 }, lastAgedTurnId: null };
      const capabilities = { manageMind: true };
      const round0 = await buildPersistentMindToolPrompt(capabilities, [], { turnId: 'turn-1', isUserTurn: true });
      expect(round0).toContain('"name":"mind.cleanup"');
      // A later round of the SAME turn re-reads persisted state (no
      // isUserTurn) and must still see the family the first round exposed.
      const round1 = await buildPersistentMindToolPrompt(capabilities, [], { turnId: 'turn-1' });
      expect(round1).toContain('"name":"mind.cleanup"');
      // The turn after that is the one that actually drops it back to the
      // discoverable index (still named, but without its full schema).
      const nextTurn = await buildPersistentMindToolPrompt(capabilities, [], { turnId: 'turn-2', isUserTurn: true });
      expect(nextTurn).not.toContain('"name":"mind.cleanup"');
      expect(nextTurn).toContain('mind.cleanup');
    });

    it('tools.deactivate clears both this turn\'s selection and the persisted lease', async () => {
      const capabilities = { manageMind: true };
      await executeCosToolCall({
        call: { requestId: 'activate-mind-2', name: 'tools.activate', arguments: { families: ['mind'] } },
        authority: { scope: 'mind', capabilities },
      });
      expect(mocks.root.persistentMind.toolActivation.leases.mind).toBe(3);

      const deactivated = await executeCosToolCall({
        call: { requestId: 'deactivate-mind', name: 'tools.deactivate', arguments: { families: ['mind'] } },
        authority: { scope: 'mind', capabilities },
      });
      expect(deactivated).toMatchObject({ state: 'completed', result: { deactivated: ['mind'] } });
      expect(mocks.root.persistentMind.toolActivation.leases.mind).toBeUndefined();

      const prompt = await buildPersistentMindToolPrompt(capabilities, [], { turnId: 'turn-3', isUserTurn: true });
      expect(prompt).not.toContain('"name":"mind.cleanup"');
    });

    it('renews only the family a successful call actually used', async () => {
      const capabilities = { manageMind: true };
      mocks.root.persistentMind.toolActivation = { leases: { mind: 1 }, lastAgedTurnId: null };
      mocks.protectMemory.mockResolvedValue({ ok: true, success: true, protection: 'core-identity' });
      await executeCosToolCall({
        call: { requestId: 'protect-renew', name: 'mind.protect-memory', arguments: { memoryId: 'memory-1', protection: 'core-identity' } },
        authority: { scope: 'mind', capabilities },
      });
      // mind.protect-memory's family is 'mind' — using it renews 'mind' back
      // to the full default retention window rather than leaving it decayed.
      expect(mocks.root.persistentMind.toolActivation.leases.mind).toBe(DEFAULT_TOOL_ACTIVATION_RETENTION_TURNS);
    });

    it('reproduces the pre-#7624 catalog exactly under the all-schemas escape hatch', async () => {
      const capabilities = { manageMind: true, toolExposureAllSchemas: true };
      // Even with no lease at all, every granted tool's full schema is sent —
      // family exposure never applies under the escape hatch.
      const prompt = await buildPersistentMindToolPrompt(capabilities, []);
      expect(prompt).toContain('"name":"mind.cleanup"');
      expect(prompt).not.toContain('Discoverable-only families');
    });

    it('reports semantic tool access as OFF exactly as before when nothing meaningful is granted', async () => {
      const prompt = await buildPersistentMindToolPrompt({}, []);
      expect(prompt).toBe(`# PortOS semantic tools
Semantic tool access is OFF. Return an empty toolCalls array. Never invent a tool name or claim that a PortOS action ran.`);
    });

    it('logs one aggregate trace line per turn with no tool name or user text', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await buildPersistentMindToolPrompt({ manageMind: true }, [], { turnId: 'turn-trace', isUserTurn: true, trace: true });
        // A mid-turn refresh must not log a second line for the same turn.
        await buildPersistentMindToolPrompt({ manageMind: true }, [], { turnId: 'turn-trace' });
        const traceLines = logSpy.mock.calls.map(([line]) => line).filter((line) => line.includes('Mind tool exposure'));
        expect(traceLines).toHaveLength(1);
        expect(traceLines[0]).toMatch(/registered=\d+ eligible=\d+ core=\d+ activated=\d+ retained=\d+ excluded\(/);
        expect(traceLines[0]).not.toContain('mind.cleanup');
        expect(traceLines[0]).not.toContain('secret text');
      } finally {
        logSpy.mockRestore();
      }
    });
  });
});
