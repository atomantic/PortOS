import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './067-pipeline-audio-mode-cues.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 067 — pipeline audio mode + cues', () => {
  let rootDir;
  let typeDir;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-067-'));
    typeDir = join(rootDir, 'data', 'pipeline-issues');
    mkdirSync(typeDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  const writeIssue = (id, issue) => {
    const dir = join(typeDir, id);
    mkdirSync(dir, { recursive: true });
    writeJson(join(dir, 'index.json'), issue);
  };
  const readIssue = (id) => readJson(join(typeDir, id, 'index.json'));

  it('stamps uploaded-track when a music pointer exists', async () => {
    writeIssue('iss-a', {
      id: 'iss-a',
      stages: { audio: { status: 'ready', music: { source: 'upload', trackFilename: 'bg.mp3' } } },
    });
    await migration.up({ rootDir });
    const a = readIssue('iss-a');
    expect(a.stages.audio.audioMode).toBe('uploaded-track');
    expect(a.stages.audio.cues).toEqual([]);
  });

  it('stamps per-clip when no music pointer exists', async () => {
    writeIssue('iss-b', {
      id: 'iss-b',
      stages: { audio: { status: 'empty', music: null, lines: [] } },
    });
    await migration.up({ rootDir });
    const b = readIssue('iss-b');
    expect(b.stages.audio.audioMode).toBe('per-clip');
    expect(b.stages.audio.cues).toEqual([]);
  });

  it('is idempotent — leaves an already-stamped record untouched', async () => {
    writeIssue('iss-c', {
      id: 'iss-c',
      stages: {
        audio: {
          status: 'ready',
          audioMode: 'generated',
          music: { source: 'gen', trackFilename: 't.wav' },
          cues: [{ id: 'cue-001', prompt: 'pads' }],
        },
      },
    });
    await migration.up({ rootDir });
    const c = readIssue('iss-c');
    // existing audioMode preserved (not flipped to uploaded-track) and cues kept
    expect(c.stages.audio.audioMode).toBe('generated');
    expect(c.stages.audio.cues).toEqual([{ id: 'cue-001', prompt: 'pads' }]);
  });

  it('skips records without an audio stage and the type index', async () => {
    writeJson(join(typeDir, 'index.json'), { schemaVersion: 1, type: 'pipelineIssues' });
    writeIssue('iss-d', { id: 'iss-d', stages: { idea: { status: 'ready' } } });
    await expect(migration.up({ rootDir })).resolves.toBeUndefined();
    expect(readIssue('iss-d').stages.audio).toBeUndefined();
  });

  it('no pipeline-issues dir → no-op', async () => {
    rmSync(typeDir, { recursive: true, force: true });
    await expect(migration.up({ rootDir })).resolves.toBeUndefined();
  });
});
