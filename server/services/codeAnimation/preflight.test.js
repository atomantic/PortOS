import express from 'express';
import { request } from '../../lib/testHelper.js';
import { errorMiddleware } from '../../lib/errorHandler.js';
import router from '../../routes/codeAnimation.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./projectStore.js', () => ({ getProjectRecord: vi.fn() }));
vi.mock('../providers.js', () => ({ getProviderById: vi.fn(), getSelectableProviders: vi.fn() }));
vi.mock('../socket.js', () => ({ emitCodeAnimationChanged: vi.fn() }));
// Keep the real runner resolver, but trip if a data-only preview dispatches.
vi.mock('../promptRunner.js', async importOriginal => ({ ...await importOriginal(), runPromptThroughProvider: vi.fn(() => { throw new Error('Unexpected provider call'); }) }));
import { getProjectRecord } from './projectStore.js';
import { getProviderById, getSelectableProviders } from '../providers.js';
import { runPromptThroughProvider } from '../promptRunner.js';
import { preflightProductionProject, recordEffectiveRoute } from './preflight.js';

const app = express();
app.use('/api/code-animation', router);
app.use(errorMiddleware);
const projectId = '00000000-0000-4000-8000-000000000001';

const provider = { id: 'example', type: 'cli', command: 'claude', enabled: true, models: ['example-model'], defaultModel: 'example-model', args: [] };
const requested = { providerId: 'example', model: 'example-model', effort: 'high', mode: null, connectionId: null };
beforeEach(() => {
  vi.clearAllMocks();
  getProjectRecord.mockResolvedValue({ id: 'project', localSettings: requested });
  getSelectableProviders.mockResolvedValue({ providers: [provider] });
});
describe('saved production authoring preflight', () => {
  it('resolves saved settings without dispatching or claiming execution or inspection', async () => {
    const response = await request(app).get(`/api/code-animation/projects/${projectId}/preflight`);
    expect(response.status).toBe(200);
    const result = response.body;
    expect(getProjectRecord).toHaveBeenCalledWith(projectId);
    expect(result).toMatchObject({ requested, resolved: { harness: 'claude', mode: 'cli', model: 'example-model', effort: 'high' }, effective: null, executed: false, problems: [], capabilities: { authoringDispatch: false, imageInspection: false } });
    expect(runPromptThroughProvider).not.toHaveBeenCalled();
  });
  it('rejects invalid and missing projects before accessing provider configuration', async () => {
    expect((await request(app).get('/api/code-animation/projects/invalid/preflight')).status).toBe(400);
    getProjectRecord.mockResolvedValue(null);
    expect((await request(app).get(`/api/code-animation/projects/${projectId}/preflight`)).status).toBe(404);
    expect(getSelectableProviders).not.toHaveBeenCalled();
  });
  it('reports a baked model override, effort pin and stale connection instead of accepting substitutions', async () => {
    getSelectableProviders.mockResolvedValue({ providers: [{ ...provider, args: ['--model', 'different-model', '--effort', 'low'] }] });
    getProjectRecord.mockResolvedValue({ localSettings: { ...requested, connectionId: 'old-connection', mode: 'api' } });
    const { problems, resolved } = await preflightProductionProject('project');
    expect(resolved).toMatchObject({ model: 'different-model', effort: null });
    expect(problems.join(' ')).toMatch(/model would be replaced/);
    expect(problems.join(' ')).toMatch(/pin reasoning effort/);
    expect(problems.join(' ')).toMatch(/connection no longer matches/);
    expect(problems.join(' ')).toMatch(/mode no longer matches/);
    expect(runPromptThroughProvider).not.toHaveBeenCalled();
  });
  it('refuses to imply API effort support or widen the selectable catalog', async () => {
    getSelectableProviders.mockResolvedValue({ providers: [{ ...provider, type: 'api', models: ['allowed-model'] }] });
    const result = await preflightProductionProject('project');
    expect(result.problems.join(' ')).toMatch(/not in this route’s selectable catalog/);
    expect(result.problems.join(' ')).toMatch(/effort is unsupported/);
    expect(result.resolved.effort).toBeNull();
  });
  it('resolves a custom route without returning credentials or execution configuration', async () => {
    getProjectRecord.mockResolvedValue({ localSettings: { ...requested, providerId: 'claude.cli@example' } });
    getProviderById.mockResolvedValue({ ...provider, id: 'claude.cli@example', serviceId: 'example', apiKey: 'example-secret', env: { PRIVATE: 'example-secret' } });
    const result = await preflightProductionProject('project');
    expect(getProviderById).toHaveBeenCalledWith('claude.cli@example');
    expect(result.resolved.connectionId).toBe('example');
    expect(JSON.stringify(result)).not.toContain('example-secret');
  });
  it('keeps unavailable provider selections visible without falling back', async () => {
    getSelectableProviders.mockResolvedValue({ providers: [] });
    const result = await preflightProductionProject('project');
    expect(result.requested).toEqual(requested);
    expect(result.resolved).toBeNull();
    expect(result.problems).toEqual(['The selected provider is missing or disabled.']);
    expect(getProviderById).not.toHaveBeenCalled();
  });
});

describe('pinned route and substitution provenance', () => {
  const resolved = { providerId: 'example', model: 'example-model', effort: 'high' };
  it('defaults to pinned, reports route capabilities and never claims visual review', async () => {
    getSelectableProviders.mockResolvedValue({ providers: [{ ...provider, type: 'api', models: ['example-model'] }] });
    const result = await preflightProductionProject('project');
    expect(result).toMatchObject({ substitution: 'pinned', allowFallback: false, capabilities: { textPackageOutput: true, imageInputAccepted: true, imageInspection: false, visualReview: false, research: false } });
    expect(runPromptThroughProvider).not.toHaveBeenCalled();
  });
  it('refuses a silent fallback in pinned mode', () => {
    expect(() => recordEffectiveRoute(resolved, {}, { provider: { id: 'other' }, usedFallback: true })).toThrow(/substituted/);
  });
  it('records an opted-in substitution and passes an unchanged route through', () => {
    const swapped = recordEffectiveRoute(resolved, { substitution: 'allowed' }, { provider: { id: 'example' }, fallbackProvider: { id: 'other' }, model: 'm2', usedFallback: true });
    expect(swapped).toMatchObject({ substituted: true, effective: { providerId: 'other', model: 'm2' }, decision: { optedIn: true, from: 'example', to: 'other' } });
    expect(recordEffectiveRoute(resolved, {}, { provider: { id: 'example' }, model: 'example-model' })).toMatchObject({ substituted: false, decision: null });
  });
});
