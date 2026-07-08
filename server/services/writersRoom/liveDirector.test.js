import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../../lib/mockPathsDataRoot.js';

let tempRoot;

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return makePathsProxy(actual, { dataRoot: () => tempRoot });
});

// Stub the staged-LLM runner so the suggest path doesn't reach a real provider.
const runStagedLLM = vi.fn();
vi.mock('../../lib/stageRunner.js', () => ({ runStagedLLM: (...a) => runStagedLLM(...a) }));

// Mock the Creative Director store + video-model helper so the CD-bridge send
// path is a focused unit test of the orchestration (create → setTreatment →
// link → rollback) without dragging in media-collection side effects.
const createProject = vi.fn();
const setTreatment = vi.fn();
const deleteProject = vi.fn();
const updateProject = vi.fn();
vi.mock('../creativeDirector/local.js', () => ({
  createProject: (...a) => createProject(...a),
  setTreatment: (...a) => setTreatment(...a),
  deleteProject: (...a) => deleteProject(...a),
  updateProject: (...a) => updateProject(...a),
}));
const deleteCollection = vi.fn();
vi.mock('../mediaCollections.js', () => ({ deleteCollection: (...a) => deleteCollection(...a) }));
vi.mock('../videoGen/local.js', () => ({ defaultVideoModelId: () => 'ltxv-default' }));

const local = await import('./local.js');
const { createWork, updateWork, getWork } = local;
const {
  suggestContinuation, reserveRenderPreview, suggestCdBridge, sendToCreativeDirector,
  ERR_LIVE_MODE_OFF, ERR_BUDGET_EXCEEDED,
} = await import('./liveDirector.js');

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'wr-live-test-'));
  runStagedLLM.mockReset();
  createProject.mockReset();
  setTreatment.mockReset();
  deleteProject.mockReset();
  updateProject.mockReset();
  deleteCollection.mockReset();
});

afterEach(() => {
  if (tempRoot && existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
  vi.useRealTimers();
});

const OPTIONS_RESPONSE = {
  content: {
    options: [
      { kind: 'prose', label: 'Push into the storm', text: 'She stepped into the rain.', rationale: 'raises stakes' },
      { kind: 'beat', label: 'Cut to the antagonist', text: 'Reveal the watcher across the street.' },
    ],
  },
};

describe('suggestContinuation', () => {
  it('throws LIVE_MODE_OFF when the work has not opted in', async () => {
    const work = await createWork({ title: 'Off' });
    await expect(suggestContinuation(work.id, { before: 'words here' }))
      .rejects.toMatchObject({ code: ERR_LIVE_MODE_OFF, status: 409 });
    expect(runStagedLLM).not.toHaveBeenCalled();
  });

  it('runs the stage, shapes options, and bumps usage on success', async () => {
    runStagedLLM.mockResolvedValue(OPTIONS_RESPONSE);
    const work = await createWork({ title: 'On' });
    await updateWork(work.id, { liveMode: { enabled: true } });

    const res = await suggestContinuation(work.id, { before: 'The door creaked open.' });
    expect(res.options).toHaveLength(2);
    expect(res.options[0]).toMatchObject({ kind: 'prose', text: 'She stepped into the rain.' });
    expect(res.usage.count).toBe(1);
    expect(runStagedLLM).toHaveBeenCalledOnce();
  });

  it('injects the work voice guide into the continue prompt when exemplars are set, empty otherwise (#2179)', async () => {
    runStagedLLM.mockResolvedValue(OPTIONS_RESPONSE);
    const work = await createWork({ title: 'Voiced' });
    await updateWork(work.id, { liveMode: { enabled: true } });

    // No exemplars → voiceGuide is empty (the template's {{#voiceGuide}} renders nothing).
    await suggestContinuation(work.id, { before: 'The door creaked open.' });
    expect(runStagedLLM.mock.calls[0][1].voiceGuide).toBe('');

    await updateWork(work.id, {
      voiceExemplars: [{ passage: 'She counted the exits, then the lies.', note: 'terse' }],
    });
    await suggestContinuation(work.id, { before: 'The door creaked open.' });
    const vars = runStagedLLM.mock.calls[1][1];
    expect(vars.voiceGuide).toContain('MATCH this voice');
    expect(vars.voiceGuide).toContain('She counted the exits, then the lies.');
  });

  it('charges budget even when the model returns zero usable options', async () => {
    // The LLM cost is incurred regardless of whether the response parsed into
    // usable options — sparing zero-option calls would open an unbounded-call
    // hole that never reaches the 429 cap.
    runStagedLLM.mockResolvedValue({ content: { options: [] } });
    const work = await createWork({ title: 'Empty' });
    await updateWork(work.id, { liveMode: { enabled: true } });

    const res = await suggestContinuation(work.id, { before: 'Nothing comes of this.' });
    expect(res.options).toHaveLength(0);
    expect(res.usage.count).toBe(1); // call reached the LLM → budget charged
  });

  it('enforces the daily budget and rejects with BUDGET_EXCEEDED once spent', async () => {
    runStagedLLM.mockResolvedValue(OPTIONS_RESPONSE);
    const work = await createWork({ title: 'Capped' });
    await updateWork(work.id, { liveMode: { enabled: true, dailyCallBudget: 1 } });

    await suggestContinuation(work.id, { before: 'First call.' }); // count -> 1
    await expect(suggestContinuation(work.id, { before: 'Second call.' }))
      .rejects.toMatchObject({ code: ERR_BUDGET_EXCEEDED, status: 429 });
    expect(runStagedLLM).toHaveBeenCalledOnce(); // the blocked call never ran the stage
  });

  it('treats dailyCallBudget 0 as unlimited', async () => {
    runStagedLLM.mockResolvedValue(OPTIONS_RESPONSE);
    const work = await createWork({ title: 'Unlimited' });
    await updateWork(work.id, { liveMode: { enabled: true, dailyCallBudget: 0 } });

    await suggestContinuation(work.id, { before: 'a' });
    await suggestContinuation(work.id, { before: 'b' });
    const res = await suggestContinuation(work.id, { before: 'c' });
    expect(res.usage.count).toBe(3);
  });

  it('rejects an empty cursor context before spending an LLM call', async () => {
    const work = await createWork({ title: 'Blank' });
    await updateWork(work.id, { liveMode: { enabled: true } });
    await expect(suggestContinuation(work.id, { before: '   ', after: '', selection: '' }))
      .rejects.toThrow(/prose around the cursor/);
    expect(runStagedLLM).not.toHaveBeenCalled();
  });

  it('rolls the budget over on a new UTC day', async () => {
    runStagedLLM.mockResolvedValue(OPTIONS_RESPONSE);
    const work = await createWork({ title: 'Rollover' });
    await updateWork(work.id, { liveMode: { enabled: true, dailyCallBudget: 1 } });

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03T12:00:00Z'));
    await suggestContinuation(work.id, { before: 'day one' });
    await expect(suggestContinuation(work.id, { before: 'day one again' }))
      .rejects.toMatchObject({ code: ERR_BUDGET_EXCEEDED });

    vi.setSystemTime(new Date('2026-06-04T00:01:00Z'));
    const res = await suggestContinuation(work.id, { before: 'day two' });
    expect(res.usage).toMatchObject({ date: '2026-06-04', count: 1 });
  });
});

describe('reserveRenderPreview', () => {
  it('throws LIVE_MODE_OFF when the work has not opted in', async () => {
    const work = await createWork({ title: 'Off' });
    await expect(reserveRenderPreview(work.id))
      .rejects.toMatchObject({ code: ERR_LIVE_MODE_OFF, status: 409 });
  });

  it('reserves a slot and bumps the distinct render counter on success', async () => {
    const work = await createWork({ title: 'On' });
    await updateWork(work.id, { liveMode: { enabled: true } });

    const res = await reserveRenderPreview(work.id);
    expect(res.renderUsage.count).toBe(1);
    expect(res.renderBudget).toBe(20); // DEFAULT_LIVE_MODE.dailyRenderBudget

    // The render counter is independent of the text-suggest counter.
    const reloaded = await getWork(work.id);
    expect(reloaded.liveMode.usage).toMatchObject({ count: 0 });
    expect(reloaded.liveMode.renderUsage).toMatchObject({ count: 1 });
  });

  it('enforces the daily render budget separately from the suggest budget', async () => {
    runStagedLLM.mockResolvedValue(OPTIONS_RESPONSE);
    const work = await createWork({ title: 'Capped' });
    await updateWork(work.id, { liveMode: { enabled: true, dailyRenderBudget: 1, dailyCallBudget: 5 } });

    await reserveRenderPreview(work.id); // render count -> 1
    await expect(reserveRenderPreview(work.id))
      .rejects.toMatchObject({ code: ERR_BUDGET_EXCEEDED, status: 429 });

    // The suggest budget is untouched by render reservations.
    const res = await suggestContinuation(work.id, { before: 'still allowed' });
    expect(res.usage.count).toBe(1);
  });

  it('treats dailyRenderBudget 0 as unlimited', async () => {
    const work = await createWork({ title: 'Unlimited' });
    await updateWork(work.id, { liveMode: { enabled: true, dailyRenderBudget: 0 } });

    await reserveRenderPreview(work.id);
    await reserveRenderPreview(work.id);
    const res = await reserveRenderPreview(work.id);
    expect(res.renderUsage.count).toBe(3);
  });

  it('rolls the render budget over on a new UTC day', async () => {
    const work = await createWork({ title: 'Rollover' });
    await updateWork(work.id, { liveMode: { enabled: true, dailyRenderBudget: 1 } });

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03T12:00:00Z'));
    await reserveRenderPreview(work.id);
    await expect(reserveRenderPreview(work.id))
      .rejects.toMatchObject({ code: ERR_BUDGET_EXCEEDED });

    vi.setSystemTime(new Date('2026-06-04T00:01:00Z'));
    const res = await reserveRenderPreview(work.id);
    expect(res.renderUsage).toMatchObject({ date: '2026-06-04', count: 1 });
  });
});

const BRIDGE_RESPONSE = {
  content: {
    logline: 'A courier outruns the storm.',
    synopsis: 'She must cross the flooded city before the levee breaks.',
    styleSpec: 'Rain-slick neon, handheld, teal-and-amber.',
    scenes: [
      { intent: 'Establish the deluge', prompt: 'Wide shot of a drowned street, neon reflections', durationSeconds: 6 },
      { intent: 'The courier runs', prompt: 'Tracking shot, sprinting through ankle-deep water', durationSeconds: 4.4 },
    ],
  },
};

describe('suggestCdBridge', () => {
  it('throws LIVE_MODE_OFF when the work has not opted in', async () => {
    const work = await createWork({ title: 'Off' });
    await expect(suggestCdBridge(work.id, { before: 'words here' }))
      .rejects.toMatchObject({ code: ERR_LIVE_MODE_OFF, status: 409 });
    expect(runStagedLLM).not.toHaveBeenCalled();
  });

  it('shapes a proposal, clamps duration, and charges the SHARED suggest budget', async () => {
    runStagedLLM.mockResolvedValue(BRIDGE_RESPONSE);
    const work = await createWork({ title: 'On' });
    await updateWork(work.id, { liveMode: { enabled: true } });

    const res = await suggestCdBridge(work.id, { before: 'The door creaked open.' });
    expect(res.proposal.logline).toBe('A courier outruns the storm.');
    expect(res.proposal.scenes).toHaveLength(2);
    expect(res.proposal.scenes[1].durationSeconds).toBe(4); // 4.4 → rounded into 1..10
    // Draws on the same daily call budget as suggestContinuation (not a render slot).
    expect(res.usage.count).toBe(1);
    const reloaded = await getWork(work.id);
    expect(reloaded.liveMode.renderUsage).toMatchObject({ count: 0 });
  });

  it('returns a null proposal (but still charges budget) when fewer than 2 usable scenes come back', async () => {
    runStagedLLM.mockResolvedValue({ content: { logline: 'x', synopsis: 'y', styleSpec: 'z', scenes: [{ intent: 'only one', prompt: 'shot' }] } });
    const work = await createWork({ title: 'Thin' });
    await updateWork(work.id, { liveMode: { enabled: true } });

    const res = await suggestCdBridge(work.id, { before: 'something' });
    expect(res.proposal).toBeNull();
    expect(res.usage.count).toBe(1); // reached the LLM → charged
  });

  it('returns a null proposal when logline/synopsis is missing (would fail the send schema)', async () => {
    // 2 usable scenes but no headline — the send schema requires logline +
    // synopsis min(1), so a proposal missing them must not render a live Send.
    runStagedLLM.mockResolvedValue({ content: { logline: '', synopsis: '', styleSpec: 'z', scenes: [
      { intent: 'a', prompt: 'shot a' }, { intent: 'b', prompt: 'shot b' },
    ] } });
    const work = await createWork({ title: 'Headless' });
    await updateWork(work.id, { liveMode: { enabled: true } });

    const res = await suggestCdBridge(work.id, { before: 'something' });
    expect(res.proposal).toBeNull();
    expect(res.usage.count).toBe(1); // reached the LLM → charged
  });

  it('shares the daily budget with suggestContinuation (one pool, not two)', async () => {
    runStagedLLM.mockResolvedValue(BRIDGE_RESPONSE);
    const work = await createWork({ title: 'Shared' });
    await updateWork(work.id, { liveMode: { enabled: true, dailyCallBudget: 1 } });

    await suggestCdBridge(work.id, { before: 'first' }); // count -> 1
    runStagedLLM.mockResolvedValue(OPTIONS_RESPONSE);
    await expect(suggestContinuation(work.id, { before: 'second' }))
      .rejects.toMatchObject({ code: ERR_BUDGET_EXCEEDED, status: 429 });
  });

  it('rejects an empty cursor context before spending an LLM call', async () => {
    const work = await createWork({ title: 'Blank' });
    await updateWork(work.id, { liveMode: { enabled: true } });
    await expect(suggestCdBridge(work.id, { before: '  ', after: '', selection: '' }))
      .rejects.toThrow(/prose around the cursor/);
    expect(runStagedLLM).not.toHaveBeenCalled();
  });
});

describe('sendToCreativeDirector', () => {
  const PROPOSAL = {
    logline: 'A courier outruns the storm.',
    synopsis: 'Cross the flooded city before the levee breaks.',
    styleSpec: 'Rain-slick neon.',
    scenes: [
      { intent: 'Establish the deluge', prompt: 'Wide shot', durationSeconds: 6 },
      { intent: 'The courier runs', prompt: 'Tracking shot', durationSeconds: 4 },
    ],
  };

  it('creates a project, seeds the treatment, resets to draft, and records the manifest link', async () => {
    createProject.mockResolvedValue({ id: 'cd-1', collectionId: 'col-1' });
    setTreatment.mockImplementation(async (id, treatment) => ({ id, treatment, status: 'rendering' }));
    updateProject.mockImplementation(async (id, patch) => ({ id, ...patch }));
    const work = await createWork({ title: 'My Draft' });

    const res = await sendToCreativeDirector(work.id, { proposal: PROPOSAL });

    // Project created with work title + styleSpec + a resolved (non-legacy) model.
    expect(createProject).toHaveBeenCalledWith(expect.objectContaining({
      name: 'My Draft', styleSpec: 'Rain-slick neon.', modelId: 'ltxv-default',
    }));
    // Treatment scenes carry the runtime fields the schema needs.
    const [, treatment] = setTreatment.mock.calls[0];
    expect(treatment.scenes[0]).toMatchObject({ sceneId: 'sc-1', order: 0, useContinuationFromPrior: false });
    expect(treatment.scenes[1]).toMatchObject({ sceneId: 'sc-2', order: 1, useContinuationFromPrior: true });
    // setTreatment forces 'rendering' but the bridge resets to 'draft' so the
    // user can Start it deliberately — the returned project reflects the reset.
    expect(updateProject).toHaveBeenCalledWith('cd-1', { status: 'draft' });
    expect(res.project).toMatchObject({ id: 'cd-1', status: 'draft' });

    // The bridge link is persisted on the work manifest.
    const reloaded = await getWork(work.id);
    expect(reloaded.cdProjectId).toBe('cd-1');
  });

  it('rolls back the orphaned project AND its media collection when setTreatment fails', async () => {
    createProject.mockResolvedValue({ id: 'cd-orphan', collectionId: 'col-orphan' });
    setTreatment.mockRejectedValue(new Error('treatment invalid'));
    deleteProject.mockResolvedValue({ ok: true });
    deleteCollection.mockResolvedValue({ ok: true });
    const work = await createWork({ title: 'Doomed' });

    await expect(sendToCreativeDirector(work.id, { proposal: PROPOSAL }))
      .rejects.toThrow(/treatment invalid/);
    expect(deleteProject).toHaveBeenCalledWith('cd-orphan');
    expect(deleteCollection).toHaveBeenCalledWith('col-orphan');

    const reloaded = await getWork(work.id);
    expect(reloaded.cdProjectId ?? null).toBeNull();
  });
});
