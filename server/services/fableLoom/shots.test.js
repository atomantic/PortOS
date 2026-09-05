import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'loom-shots-'));
vi.mock('../../lib/fileUtils.js', async (original) => {
  const actual = await original();
  return { ...actual, PATHS: { ...actual.PATHS, data: TEST_DATA_ROOT } };
});
const runStagedLLM = vi.hoisted(() => vi.fn());
vi.mock('../stageRunner.js', () => ({ runStagedLLM }));
vi.mock('../universeBuilder.js', () => ({ getUniverse: async () => ({ id: 'example-universe' }) }));
vi.mock('../pipeline/series.js', () => ({ getSeries: async () => null }));
const { createLoom, addEpisode, addNode, updateNode, getLoom } = await import('./records.js');
const { _resetFableLoomBackend } = await import('./store.js');
const { runEpisodeShotAutopilot, applyEpisodeShots } = await import('./shots.js');
beforeEach(() => { rmSync(join(TEST_DATA_ROOT, 'fableloom'), { recursive: true, force: true }); _resetFableLoomBackend(); runStagedLLM.mockReset(); });
afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));
const shot = (title, dialogue = []) => ({ title, durationSeconds: 8, action: 'A courier watches the gate.', framing: 'Medium static shot', dialogue, imagePrompt: 'Courier at the gate', videoPrompt: 'Courier waits.' });
async function setup() {
  let loom = await createLoom({ name: 'Example Story', universeId: 'example-universe' });
  loom = await addEpisode(loom.id, { title: 'Pilot' });
  const ep = loom.episodes[0].id;
  loom = await addEpisode(loom.id, { title: 'Later' });
  loom = await addNode(loom.id, ep, { title: 'Choice', playbackMode: 'decision' });
  loom = await addNode(loom.id, ep, { title: 'North', isEnding: true });
  loom = await addNode(loom.id, ep, { title: 'South', isEnding: true });
  const [choice, north, south] = loom.episodes[0].nodes;
  loom = await updateNode(loom.id, ep, choice.id, { transitions: [{ targetNodeId: north.id, intent: 'north' }, { targetNodeId: south.id, intent: 'south' }] });
  const groups = [{ sceneId: choice.id, shots: [shot('Ask', [{ speaker: 'Courier', text: 'Which gate?' }]), shot('Wait')] }, { sceneId: north.id, shots: [shot('North')] }, { sceneId: south.id, shots: [shot('South')] }];
  return { loom, ep, groups };
}
describe('timed shot autopilot', () => {
  it('applies a reviewed split with preserved choices, quiet loop and untouched later episode', async () => {
    const { loom, ep, groups } = await setup();
    groups[0].shots[0].durationSeconds = 9;
    groups[0].shots[0].dialogue = [{ speaker: 'Courier', text: 'We can open the northern gate now or take the long road around before the guards come back.' }];
    runStagedLLM.mockResolvedValueOnce({ content: { groups } }).mockResolvedValueOnce({ content: { summary: 'Clear and filmable.', risks: [] } });
    const result = await runEpisodeShotAutopilot(loom.id, ep, { apply: true });
    const saved = await getLoom(loom.id);
    expect(saved.episodes[1]).toEqual(loom.episodes[1]);
    const nodes = saved.episodes[0].nodes;
    expect(nodes).toHaveLength(4);
    expect(nodes[0].id).toBe(loom.episodes[0].nodes[0].id);
    expect(nodes[0].transitions[0].targetNodeId).toBe(nodes[1].id);
    expect(nodes[1].transitions.map(t => t.targetNodeId)).toEqual(nodes.slice(2).map(n => n.id));
    expect(nodes[1].playbackMode).toBe('decision');
    expect(nodes[0].shot.durationSeconds).toBe(10);
    expect(nodes[0].shot.dramaticSceneId).toBe(nodes[1].shot.dramaticSceneId);
    expect(result.validation.stats.ready).toBe(true);
  });
  it('rejects oversized dialogue before editorial or mutation, and rejects stale previews', async () => {
    const { loom, ep, groups } = await setup();
    const bad = structuredClone(groups);
    bad[0].shots[0].dialogue[0].text = 'too many words '.repeat(20);
    runStagedLLM.mockResolvedValueOnce({ content: { groups: bad } });
    await expect(runEpisodeShotAutopilot(loom.id, ep, { maxRounds: 1, apply: true })).rejects.toThrow('dialogue needs');
    expect(runStagedLLM).toHaveBeenCalledTimes(1);
    expect((await getLoom(loom.id)).episodes).toEqual(loom.episodes);
    runStagedLLM.mockResolvedValueOnce({ content: { groups } }).mockResolvedValueOnce({ content: { summary: 'Clear.', risks: [] } });
    const preview = await runEpisodeShotAutopilot(loom.id, ep);
    await updateNode(loom.id, ep, groups[0].sceneId, { title: 'Revised choice' });
    await expect(applyEpisodeShots(loom.id, ep, preview)).rejects.toThrow('episode changed');
    expect((await getLoom(loom.id)).episodes[0].nodes).toHaveLength(3);
  });
});
