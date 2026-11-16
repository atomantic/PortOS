import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as logic from './projectsLogic.js';
import { createProjectFileStore } from '../projectFileStore.js';
import { createProjectDbStore } from '../projectDbStore.js';
import { plateCheckPrompt } from './takes.js';
import { TAKE_PROMPT_POOL_KEY, packTakePrompts, unpackTakePrompts } from './takePromptPool.js';

// A composed take prompt: the shot's own line, then the long look and bible lines every shot shares, then a per-take repair note.
const LOOK = 'Project style: analog grain, warm practicals, shallow depth of field. '.repeat(20);
const BIBLE = 'Production bible: the lead wears a grey coat; the edit room has green monitors. '.repeat(20);
const composed = (shot, i) => [`${shot} looks up from the monitor`, LOOK, BIBLE, i % 3 ? `Repair note ${i}: keep the lamp in frame` : ''].join('\n');
const TAKES = 300;

// A project as an install wrote it before #16210: every take carries its composed prompt inline.
function oldShapeProject() {
  const takesFor = (sceneId, kind) => Array.from({ length: TAKES }, (_, i) => ({
    takeId: `${sceneId}-t${i}`, kind, assetId: `${sceneId}-asset-${i}`, source: 'generated', provider: 'portos', jobId: `job-${i}`,
    prompt: composed(sceneId, i), sourceImageId: null, status: i === 0 ? 'selected' : 'candidate', createdAt: '2026-01-01T00:00:00.000Z',
  }));
  return {
    id: 'mv-take-prompts', name: 'Take prompts', updatedAt: '2026-01-01T00:00:00.000Z',
    scenes: [
      { sceneId: 's1', order: 0, startSec: 0, endSec: 4, framePrompt: 'Medium shot', referenceImageId: 's1-asset-0', takes: takesFor('s1', 'image') },
      { sceneId: 's2', order: 1, startSec: 4, endSec: 8, prompt: 'Wide shot', videoHistoryId: 's2-asset-0', takes: [
        ...takesFor('s2', 'video'),
        // Edge shapes that must survive unchanged: no recorded prompt, an empty one, and trailing/blank lines.
        { takeId: 's2-legacy', kind: 'image', assetId: 'legacy.png', source: 'legacy', prompt: null, status: 'candidate' },
        { takeId: 's2-empty', kind: 'image', assetId: 'empty.png', source: 'imported', prompt: '', status: 'candidate' },
        { takeId: 's2-blank-lines', kind: 'image', assetId: 'blank.png', source: 'generated', prompt: '\nFirst\n\nLast\n', status: 'candidate' },
      ] },
      { sceneId: 's3', order: 2, startSec: 8, endSec: 10, prompt: 'Untaken shot' },
    ],
  };
}

const bytes = value => Buffer.byteLength(JSON.stringify(value));
const takePrompts = project => project.scenes.flatMap(scene => (scene.takes || []).map(take => [take.takeId, take.prompt]));

describe('take prompts at rest (#16210)', () => {
  it('packs each distinct prompt line once and unpacks every take byte for byte, in key order', () => {
    const project = oldShapeProject();
    const packed = packTakePrompts(project);
    // Uniquely catches a pool that loses or reorders text: the whole record round-trips exactly.
    expect(JSON.stringify(unpackTakePrompts(packed))).toBe(JSON.stringify(project));
    expect(bytes(packed)).toBeLessThan(bytes(project) / 10);
    expect(JSON.stringify(packed.scenes)).not.toContain('Project style');
    // The pool holds each line once: the two shot lines, the look, the bible, the repair notes and the edge lines.
    expect(new Set(packed[TAKE_PROMPT_POOL_KEY]).size).toBe(packed[TAKE_PROMPT_POOL_KEY].length);
    expect(packed[TAKE_PROMPT_POOL_KEY].filter(line => line === LOOK)).toHaveLength(1);
    const legacy = packed.scenes[1].takes.find(t => t.takeId === 's2-legacy');
    expect(legacy).toEqual(project.scenes[1].takes.find(t => t.takeId === 's2-legacy'));
    expect(packed.scenes[2]).toBe(project.scenes[2]);
  });

  it('repacks a packed record instead of nesting refs, and drops pool lines no take uses', () => {
    const packed = packTakePrompts(oldShapeProject());
    expect(packTakePrompts(packed)).toEqual(packed);
    const unpacked = unpackTakePrompts(packed);
    const fewer = { ...unpacked, scenes: [{ ...unpacked.scenes[0], takes: unpacked.scenes[0].takes.slice(0, 1) }] };
    expect(packTakePrompts(fewer)[TAKE_PROMPT_POOL_KEY]).toEqual(['s1 looks up from the monitor', LOOK, BIBLE, '']);
  });

  it('leaves a record without prompted takes as the same object, and reads a broken ref as no recorded prompt', () => {
    const bare = { id: 'p', scenes: [{ sceneId: 's', takes: [{ takeId: 't', prompt: null }] }] };
    expect(packTakePrompts(bare)).toBe(bare);
    expect(unpackTakePrompts(bare)).toBe(bare);
    const broken = { id: 'p', scenes: [{ sceneId: 's', takes: [{ takeId: 't', promptLines: [0, 7] }] }], [TAKE_PROMPT_POOL_KEY]: ['only line'] };
    expect(unpackTakePrompts(broken)).toEqual({ id: 'p', scenes: [{ sceneId: 's', takes: [{ takeId: 't', prompt: null }] }] });
  });
});

describe('file store write path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mv-take-prompts-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads an old record unchanged, packs it at its next write, and every reader still sees the exact sent prompt', async () => {
    const file = join(dir, 'music-video-projects.json');
    const old = oldShapeProject();
    writeFileSync(file, JSON.stringify([old]));
    const store = createProjectFileStore({ file, kind: 'musicVideoProject', idPrefix: 'mv', logEmoji: '🎞️', logLabel: 'Music Video', logic });
    const storedBytes = readFileSync(file).length;

    const read = await store.getProject(old.id);
    expect(takePrompts(read)).toEqual(takePrompts(old));
    expect(readFileSync(file).length).toBe(storedBytes);

    const written = await store.updateProject(old.id, { name: 'Renamed' });
    const raw = JSON.parse(readFileSync(file, 'utf8'))[0];
    // Uniquely catches a store that still writes each take's whole composed prompt (compact sizes; the store pretty-prints).
    expect(bytes(raw)).toBeLessThan(storedBytes / 10);
    expect(raw.scenes[0].takes[1]).not.toHaveProperty('prompt');
    expect(raw.scenes[0].takes).toHaveLength(TAKES);

    const reread = await store.getProject(old.id);
    // The edit itself may restamp take state (dependency staleness); the prompts are the sent ones, and a
    // reread is the written record exactly, so packing loses and reorders nothing.
    for (const project of [written, reread]) {
      expect(project).not.toHaveProperty(TAKE_PROMPT_POOL_KEY);
      expect(takePrompts(project)).toEqual(takePrompts(old));
    }
    expect(JSON.stringify(reread)).toBe(JSON.stringify(written));
    // The plate check judges exactly the prompt that was sent.
    expect(plateCheckPrompt(reread.scenes[0], reread.scenes[0].takes[5])).toBe(composed('s1', 5));
  });
});

describe('Postgres store write path', () => {
  const store = (options = {}) => createProjectDbStore({ table: 'music_video_projects', kind: 'musicVideoProject', idPrefix: 'mv', logEmoji: '🎞️', logLabel: 'Music Video', logic, ...options });
  const written = () => {
    const calls = [];
    return { calls, exec: async (_sql, params) => { calls.push(params); return { rows: [] }; } };
  };

  it('writes the packed JSONB, returns the unpacked record, and reads it back exactly', async () => {
    const { persist, rowToProject } = store();
    const { calls, exec } = written();
    const old = oldShapeProject();
    const returned = await persist(exec, old);
    const data = JSON.parse(calls[0][2]);
    expect(Buffer.byteLength(calls[0][2])).toBeLessThan(bytes(old) / 10);
    expect(data[TAKE_PROMPT_POOL_KEY]).toContain(LOOK);
    expect(JSON.stringify(returned.scenes)).toBe(JSON.stringify(old.scenes));
    expect(JSON.stringify(rowToProject({ id: old.id, data }))).toBe(JSON.stringify(old));
  });

  it('logs a large stored record on one line, once per MB it grows', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { persist } = store({ largeRecordBytes: 1024 * 1024 });
    const { exec } = written();
    const project = size => ({ id: 'mv-big', name: 'Big', notes: 'x'.repeat(size) });
    const slow = () => log.mock.calls.map(([line]) => line).filter(line => line.startsWith('🐢'));
    await persist(exec, project(512 * 1024));
    expect(slow()).toEqual([]);
    await persist(exec, project(1.2 * 1024 * 1024));
    await persist(exec, project(1.3 * 1024 * 1024));
    expect(slow()).toHaveLength(1);
    expect(slow()[0]).toMatch(/^🐢 Music Video project mv-big stored record is 1\.\d MB \(over 1 MB\)/);
    await persist(exec, project(2.1 * 1024 * 1024));
    expect(slow()).toHaveLength(2);
    log.mockRestore();
  });
});
