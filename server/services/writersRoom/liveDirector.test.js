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

const local = await import('./local.js');
const { createWork, updateWork, getWork } = local;
const {
  suggestContinuation, reserveRenderPreview, ERR_LIVE_MODE_OFF, ERR_BUDGET_EXCEEDED,
} = await import('./liveDirector.js');

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'wr-live-test-'));
  runStagedLLM.mockReset();
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
