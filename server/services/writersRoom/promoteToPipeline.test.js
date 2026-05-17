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

const wrLocal = await import('./local.js');
const { promoteWorkToPipeline, ERR_NO_DRAFT_BODY } = await import('./promoteToPipeline.js');
const { createCharacter } = await import('./characters.js');
const { createSetting } = await import('./settings.js');
const { createObject } = await import('./objects.js');
const seriesSvc = await import('../pipeline/series.js');
const issuesSvc = await import('../pipeline/issues.js');
const universeSvc = await import('../universeBuilder.js');

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'wr-promote-test-'));
});

afterEach(() => {
  if (tempRoot && existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

async function seedWorkWithProse(prose = 'Once upon a time there was a paragraph.') {
  const work = await wrLocal.createWork({ title: 'Test Work', kind: 'short-story' });
  await wrLocal.saveDraftBody(work.id, prose);
  return work;
}

describe('promoteWorkToPipeline', () => {
  it('rejects a work whose active draft is empty', async () => {
    const work = await wrLocal.createWork({ title: 'Blank', kind: 'short-story' });
    let caught;
    try {
      await promoteWorkToPipeline(work.id);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe(ERR_NO_DRAFT_BODY);
  });

  it('creates a series + first issue and copies prose into stages.prose.output', async () => {
    const work = await seedWorkWithProse('The vault loomed in the dark.');

    const result = await promoteWorkToPipeline(work.id);

    expect(result.reused).toBe(false);
    expect(result.series.id).toMatch(/^ser-/);
    expect(result.series.name).toBe('Test Work');
    expect(result.series.writersRoomWorkId).toBe(work.id);
    expect(result.issue.seriesId).toBe(result.series.id);
    expect(result.issue.title).toBe('Test Work');
    expect(result.issue.stages.prose.output).toBe('The vault loomed in the dark.');
    expect(result.issue.stages.prose.status).toBe('edited');
    // No script analysis yet → storyboards empty
    expect(result.issue.stages.storyboards.scenes).toEqual([]);
    expect(result.issue.stages.storyboards.status).toBe('empty');
  });

  it('records the bidirectional link on both sides', async () => {
    const work = await seedWorkWithProse();
    const { series, issue } = await promoteWorkToPipeline(work.id);

    const reloadedWork = await wrLocal.getWork(work.id);
    expect(reloadedWork.pipelineSeriesId).toBe(series.id);
    expect(reloadedWork.pipelineIssueId).toBe(issue.id);

    const reloadedSeries = await seriesSvc.getSeries(series.id);
    expect(reloadedSeries.writersRoomWorkId).toBe(work.id);
  });

  it('carries over characters / settings / objects bibles into the linked universe (Phase B.4)', async () => {
    const work = await seedWorkWithProse();
    await createCharacter(work.id, { name: 'Aria', physicalDescription: 'tall, freckles' });
    await createSetting(work.id, { name: 'The Foundry', slugline: 'INT. FOUNDRY — NIGHT', description: 'molten light' });
    await createObject(work.id, { name: 'The Locket', significance: "mother's keepsake" });

    const { series } = await promoteWorkToPipeline(work.id);

    // Phase B.4: canon lives on the universe, not the series. promote
    // mints a fresh universe for the work and links the series via
    // universeId; the series itself no longer carries the canon arrays.
    expect(series.universeId).toBeTruthy();
    const universe = await universeSvc.getUniverse(series.universeId);
    expect(universe.name).toBe('Test Work');
    expect(universe.characters).toHaveLength(1);
    expect(universe.characters[0].name).toBe('Aria');
    expect(universe.characters[0].physicalDescription).toBe('tall, freckles');
    expect(universe.settings).toHaveLength(1);
    expect(universe.settings[0].slugline).toBe('INT. FOUNDRY — NIGHT');
    expect(universe.objects).toHaveLength(1);
    expect(universe.objects[0].name).toBe('The Locket');
  });

  it('is idempotent: a second promote returns the same series/issue with reused=true', async () => {
    const work = await seedWorkWithProse();
    const first = await promoteWorkToPipeline(work.id);
    const second = await promoteWorkToPipeline(work.id);

    expect(second.reused).toBe(true);
    expect(second.series.id).toBe(first.series.id);
    expect(second.issue.id).toBe(first.issue.id);

    // Side-effect check: no duplicate series in storage
    const all = await seriesSvc.listSeries();
    expect(all.filter((s) => s.writersRoomWorkId === work.id)).toHaveLength(1);
  });

  it('with force:true creates a fresh series even when the work is already linked', async () => {
    const work = await seedWorkWithProse();
    const first = await promoteWorkToPipeline(work.id);
    const second = await promoteWorkToPipeline(work.id, { force: true });

    expect(second.reused).toBe(false);
    expect(second.series.id).not.toBe(first.series.id);
    // Work's link points at the new series
    const reloaded = await wrLocal.getWork(work.id);
    expect(reloaded.pipelineSeriesId).toBe(second.series.id);
  });

  it('falls through to a fresh create if the work links to a deleted series', async () => {
    const work = await seedWorkWithProse();
    const first = await promoteWorkToPipeline(work.id);
    await seriesSvc.deleteSeries(first.series.id);

    const second = await promoteWorkToPipeline(work.id);
    expect(second.reused).toBe(false);
    expect(second.series.id).not.toBe(first.series.id);
  });

  it('falls through to a fresh create when the linked issue belongs to a different series (mismatched link)', async () => {
    const work = await seedWorkWithProse();
    const first = await promoteWorkToPipeline(work.id);
    // Simulate a corrupted link: rewrite the work manifest to point at the
    // first series but a DIFFERENT (unrelated) series' issue. Mirrors a
    // manual edit, partial delete, or migration bug.
    const strayerSeries = await seriesSvc.createSeries({ name: 'Strayer' });
    const strayerIssue = await issuesSvc.createIssue({ seriesId: strayerSeries.id, title: 'Stray' });
    await wrLocal.linkToPipeline(work.id, { seriesId: first.series.id, issueId: strayerIssue.id });

    const second = await promoteWorkToPipeline(work.id);
    expect(second.reused).toBe(false);
    // The new pair must be self-consistent (issue belongs to the new series).
    expect(second.issue.seriesId).toBe(second.series.id);
  });

  it('populates storyboards scenes from a succeeded script analysis (visualPrompt → description)', async () => {
    const work = await seedWorkWithProse();

    // Hand-write a `script` analysis snapshot on disk to mimic a completed run
    // — running the real LLM-driven evaluator would require provider stubs.
    const fs = await import('fs/promises');
    const analysisDir = join(tempRoot, 'writers-room', 'works', work.id, 'analysis');
    await fs.mkdir(analysisDir, { recursive: true });
    await fs.writeFile(join(analysisDir, 'script.json'), JSON.stringify({
      id: 'script', workId: work.id, kind: 'script', status: 'succeeded',
      result: {
        title: 'The Pilot', logline: 'A heist gone wrong.',
        scenes: [
          { id: 'scene-01', heading: 'Scene 1 — Vault', slugline: 'INT. VAULT — NIGHT',
            summary: 'They break in.', characters: ['ALICE'],
            action: 'A drill bites.', dialogue: [{ character: 'ALICE', line: 'Quiet.' }],
            visualPrompt: 'a high-tech vault, two figures in tactical gear',
            sourceSegmentIds: [] },
          { id: 'scene-02', heading: 'Scene 2 — Escape', slugline: 'EXT. ROOFTOP — DAWN',
            summary: '...', characters: [], action: '', dialogue: [],
            visualPrompt: 'a rooftop at first light', sourceSegmentIds: [] },
        ],
      },
      createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    }));

    const { issue } = await promoteWorkToPipeline(work.id);

    expect(issue.stages.storyboards.scenes).toHaveLength(2);
    expect(issue.stages.storyboards.status).toBe('ready');
    expect(issue.stages.storyboards.scenes[0].description).toBe('a high-tech vault, two figures in tactical gear');
    expect(issue.stages.storyboards.scenes[0].slugline).toBe('INT. VAULT — NIGHT');
    expect(issue.stages.storyboards.scenes[0].imageJobId).toBeNull();
    // Rich fields ride along
    expect(issue.stages.storyboards.scenes[0].heading).toBe('Scene 1 — Vault');
    expect(issue.stages.storyboards.scenes[0].dialogue[0]).toEqual({ character: 'ALICE', line: 'Quiet.' });
  });
});
