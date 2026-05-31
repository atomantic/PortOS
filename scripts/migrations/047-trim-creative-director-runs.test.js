import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './047-trim-creative-director-runs.js';

const FILE = 'data/creative-director-projects.json';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 047 — trim creative-director runs[]', () => {
  let rootDir;
  let projectsPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-047-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    projectsPath = join(rootDir, FILE);
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('no-ops on a fresh install (file absent)', async () => {
    await migration.up({ rootDir });
    expect(existsSync(projectsPath)).toBe(false);
  });

  it('skips projects already under the cap', async () => {
    const projects = [
      { id: 'cd-small', runs: Array.from({ length: 20 }, (_, i) => ({ runId: `r-${i}`, status: 'completed' })) },
    ];
    writeFileSync(projectsPath, JSON.stringify(projects, null, 2));
    await migration.up({ rootDir });
    expect(readJson(projectsPath)[0].runs).toHaveLength(20);
  });

  it('trims an over-cap legacy project to MAX_PERSISTED_RUNS', async () => {
    const runs = Array.from({ length: 800 }, (_, i) => ({ runId: `r-${i}`, status: 'completed' }));
    writeFileSync(projectsPath, JSON.stringify([{ id: 'cd-huge', runs }], null, 2));
    await migration.up({ rootDir });
    const after = readJson(projectsPath)[0].runs;
    expect(after).toHaveLength(200);
    // Keeps the most-recent terminal entries.
    expect(after[0].runId).toBe('r-600');
    expect(after[199].runId).toBe('r-799');
  });

  it('preserves every in-flight run even when total is way over cap', async () => {
    const runs = [
      ...Array.from({ length: 700 }, (_, i) => ({ runId: `done-${i}`, status: 'completed' })),
      { runId: 'live-treatment', status: 'running', kind: 'treatment' },
      { runId: 'live-evaluate', status: 'queued', kind: 'evaluate', sceneId: 'scene-7' },
    ];
    writeFileSync(projectsPath, JSON.stringify([{ id: 'cd-mixed', runs }], null, 2));
    await migration.up({ rootDir });
    const after = readJson(projectsPath)[0].runs;
    expect(after).toHaveLength(200);
    expect(after.find((r) => r.runId === 'live-treatment')).toBeTruthy();
    expect(after.find((r) => r.runId === 'live-evaluate')).toBeTruthy();
  });

  it('is idempotent — running twice has no further effect', async () => {
    const runs = Array.from({ length: 400 }, (_, i) => ({ runId: `r-${i}`, status: 'completed' }));
    writeFileSync(projectsPath, JSON.stringify([{ id: 'cd-1', runs }], null, 2));
    await migration.up({ rootDir });
    const firstPass = readJson(projectsPath);
    expect(firstPass[0].runs).toHaveLength(200);
    await migration.up({ rootDir });
    const secondPass = readJson(projectsPath);
    expect(secondPass[0].runs).toHaveLength(200);
    expect(secondPass[0].runs[0].runId).toBe(firstPass[0].runs[0].runId);
  });

  it('survives invalid JSON without throwing or corrupting the file', async () => {
    writeFileSync(projectsPath, 'not json {');
    await migration.up({ rootDir });
    expect(readFileSync(projectsPath, 'utf-8')).toBe('not json {');
  });

  it('survives a non-array top-level payload without writing', async () => {
    writeFileSync(projectsPath, JSON.stringify({ projects: [] }));
    await migration.up({ rootDir });
    expect(readJson(projectsPath)).toEqual({ projects: [] });
  });
});
