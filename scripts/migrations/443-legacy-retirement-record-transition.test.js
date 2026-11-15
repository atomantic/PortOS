import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import migration from './443-legacy-retirement-record-transition.js';

let root;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe('frozen retirement migration 443', () => {
  it('remains runnable and idempotent when an older install upgrades through it', async () => {
    root = await mkdtemp(join(tmpdir(), 'portos-migration-443-'));
    const path = join(root, 'data/cos/task-schedule.json');
    await mkdir(join(root, 'data/cos'), { recursive: true });
    const row = { branch: 'fix/old', path: '/fixture/old', head: 'a'.repeat(40), reason: 'retirement-review-pending' };
    await writeFile(path, JSON.stringify({ version: 2, executions: { 'task:branch-reconcile': {
      perApp: { app: { branchReconcileOutcome: { remaining: [row] } } },
    } } }));
    expect(await migration.up({ rootDir: root })).toEqual({ marked: 1 });
    const saved = JSON.parse(await readFile(path, 'utf8'));
    expect(saved.retirementPolicyVersion).toBe(2);
    expect(saved.executions['task:branch-reconcile'].perApp.app.branchReconcileOutcome).toMatchObject({ remaining: [row],
      legacyRetirementTransition: { version: 1, observations: [expect.stringMatching(/^[a-f0-9]{64}$/)], resolutions: [] } });
    expect(await migration.up({ rootDir: root })).toEqual({ marked: 0 });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(saved);
  });
});
