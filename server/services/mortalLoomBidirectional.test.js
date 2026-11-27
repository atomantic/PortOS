import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { EventEmitter } from 'events';
import { _disposeMortalLoomHelperForTest, commitMortalLoomRevision, listMortalLoomSnapshots, readMortalLoomSnapshot } from './mortalLoomCommit.js';
import { overlayMortalLoomGoals } from './mortalLoomGoals.js';
import { exportMortalLoomRecoveryCopy, getStatus, mlApplyGoalChanges, mlUpsertHealthMetricByDate, restoreMortalLoomSnapshot } from './mortalLoomStore.js';

// The regular PR suite must run even in macOS sandboxes that deny IPC to
// the coordination daemon. Set PORTOS_TEST_NATIVE_MORTALLOOM=1 outside such
// a sandbox to run the same fixture against the real Foundation helper.
vi.mock('../lib/childProcess.js', async importOriginal => {
  const real = await importOriginal();
  if (process.env.PORTOS_TEST_NATIVE_MORTALLOOM === '1') return real;
  const { promisify } = await import('util');
  const execFile = Object.assign(vi.fn(), { [promisify.custom]: async (file, args) => {
    if (file === '/usr/bin/swiftc') return { stdout: '', stderr: '' };
    const [action, target, _mode, before, after] = args;
    if (action !== 'commit') throw Error('unexpected helper command');
    if (!(await readFile(target)).equals(await readFile(before))) return { stdout: 'revisionChanged' };
    await writeFile(target, await readFile(after), { mode: 0o600 });
    return { stdout: 'ok' };
  } });
  return { ...real, execFile };
});

let dir, path;
vi.mock('./settings.js', () => ({
  getSettings: async () => ({ mortalloom: { enabled: true, path } }),
  settingsEvents: new EventEmitter(),
}));

const fixture = (fields = {}) => ({
  profile: { lifestyle: { smokingStatus: 'never', dietQuality: 'good', stressLevel: 'low', exerciseMinutesPerWeek: 0, sleepHoursPerNight: 8 } },
  alcoholDrinks: [], alcoholPresets: [], nicotineEntries: [], nicotinePresets: [], bloodTests: [], eyeExams: [], epigeneticTests: [],
  ...fields,
});
const goal = (title, fields = {}) => ({ id: randomUUID(), title, createdDate: '2026-01-01', ...fields });
const read = async () => JSON.parse(await readFile(path));
const put = value => writeFile(path, JSON.stringify(value), { mode: 0o600 });
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'portos-mortalloom-contract-'));
  path = join(dir, 'MortalLoom.json');
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
afterAll(_disposeMortalLoomHelperForTest);

describe('MortalLoom shared file contract', () => {
  it('writes only native goal fields and retains unknown data, concurrently added rows, and local aliases', async () => {
    const main = goal('Native', { futureGoalProperty: { preserve: true } });
    const milestone = { id: randomUUID(), title: 'Native milestone', completed: false };
    main.milestones = [milestone];
    const child = goal('Child');
    const parentAlias = 'goal-' + main.id;
    const local = [{ id: parentAlias, todos: [{ title: 'PortOS only' }] }];
    const previous = overlayMortalLoomGoals([main], local);
    const after = structuredClone(previous);
    after[0].description = 'Edited in PortOS';
    after[0].progress = 42;
    after[0].updatedAt = '2026-01-02T00:00:00Z';
    after[0].checkIns.push({ id: 'ci-' + randomUUID(), assessment: 'PortOS-only AI' });
    after[0].milestones[0].completedAt = '2026-01-02T00:00:00Z';
    after.push({ id: 'goal-' + child.id, parentId: parentAlias, title: child.title, createdAt: '2026-01-02T00:00:00Z', tags: ['local'] });
    const newFromPhone = goal('Concurrent native addition');
    await put(fixture({ futureTopLevel: 'keep', goals: [main, newFromPhone] }));
    await mlApplyGoalChanges(previous, after);
    const actual = await read();
    expect(actual.futureTopLevel).toBe('keep');
    expect(actual.goals[0]).toMatchObject({
      id: main.id, futureGoalProperty: main.futureGoalProperty, notes: after[0].description,
      milestones: [{ id: milestone.id, completed: true, completedDate: '2026-01-02' }],
      checkIns: [{ progressPct: 42, date: '2026-01-02' }],
    });
    expect(actual.goals[0]).not.toHaveProperty('todos');
    expect(actual.goals[1]).toEqual(newFromPhone);
    expect(actual.goals[2]).toMatchObject({ id: child.id.toUpperCase(), parentId: main.id.toUpperCase() });
    expect(actual.goals[2]).not.toHaveProperty('tags');
  });

  it('deletes a native defaulted goal without deleting an independently edited copy', async () => {
    const detached = goal('Unchanged');
    const previous = [{ ...detached, goalType: 'standard', status: 'active' }];
    await put(fixture({ goals: [{ ...detached, title: 'Edited on phone' }] }));
    await expect(mlApplyGoalChanges(previous, [])).rejects.toMatchObject({ code: 'MORTALLOOM_REVISION_CHANGED' });
    await put(fixture({ goals: [detached] }));
    await mlApplyGoalChanges(previous, []);
    expect((await read()).goals).toEqual([]);
  });

  it('rejects a competing edit to the same field without rewriting file or losing either version', async () => {
    const original = goal('Old');
    await put(fixture({ goals: [{ ...original, title: 'From iPhone' }] }));
    const raw = await readFile(path);
    await expect(mlApplyGoalChanges([original], [{ ...original, title: 'From PortOS' }]))
      .rejects.toMatchObject({ code: 'MORTALLOOM_REVISION_CHANGED' });
    expect(await readFile(path)).toEqual(raw);
    expect(await listMortalLoomSnapshots(path)).toEqual([]);
  });

  it('does not turn a PortOS-only planning change into a cloud write or even open an absent file', async () => {
    const current = [goal('One')];
    expect(await mlApplyGoalChanges(current, [{ ...current[0], tags: ['one'], todos: [] }])).toBe(false);
    expect((await getStatus()).state).toBe('missing');
  });

  it('preserves exact original bytes and requires the previewed revision to restore', async () => {
    const raw = ' ' + JSON.stringify(fixture({ goals: [goal('One')] })) + '\n';
    await writeFile(path, raw, { mode: 0o600 });
    await chmod(path, 0o600);
    await mlUpsertHealthMetricByDate('2026-01-03', { heartRate: 61 });
    const status = await getStatus();
    expect(status).toMatchObject({ state: 'ready', summary: { goals: 1 }, recoverySnapshots: [{
      valid: true, summary: { goals: 1, healthMetrics: 0 },
    }] });
    const copy = (await listMortalLoomSnapshots(path))[0];
    expect((await readMortalLoomSnapshot(path, copy.id)).toString('utf8')).toBe(raw);
    const snapshotRoot = join(dir, '.mortal-loom-audit-snapshots');
    const [snapshotFolder] = await readdir(snapshotRoot);
    expect((await stat(join(snapshotRoot, snapshotFolder, copy.name))).mode & 0o077).toBe(0);
    expect((await stat(path)).mode & 0o077).toBe(0);
    await writeFile(path, '{"truncated":');
    await expect(restoreMortalLoomSnapshot({ id: copy.id, expectedRevision: status.revision }))
      .rejects.toMatchObject({ code: 'MORTALLOOM_REVISION_CHANGED' });
    const corrupt = await getStatus();
    expect(corrupt.state).toBe('invalid');
    await restoreMortalLoomSnapshot({ id: copy.id, expectedRevision: corrupt.revision });
    expect(await read()).toMatchObject({ goals: [{ title: 'One' }], _mortalLoomSync: { parentSHA256: corrupt.revision, kind: 'replace' } });
    await rm(path);
    expect(await getStatus()).toMatchObject({ state: 'missing', revision: null, recoverySnapshots: expect.arrayContaining([{ ...status.recoverySnapshots[0] }]) });
  });

  it('pauses on a structurally valid but emptied file using a verified prior snapshot', async () => {
    await put(fixture({ goals: [goal('One'), goal('Two'), goal('Three')] }));
    await mlUpsertHealthMetricByDate('2026-01-03', { heartRate: 62 });
    await put(fixture());
    const reduced = await getStatus();
    expect(reduced.state).toBe('reduced');
    await expect(mlUpsertHealthMetricByDate('2026-01-04', { heartRate: 63 }))
      .rejects.toMatchObject({ code: 'MORTALLOOM_HISTORY_REDUCED' });
    expect(await read()).toEqual(fixture());
    const [copy] = reduced.recoverySnapshots;
    expect(JSON.parse(await exportMortalLoomRecoveryCopy(copy.id)).goals).toHaveLength(3);
    await restoreMortalLoomSnapshot({ id: copy.id, expectedRevision: reduced.revision });
    expect((await getStatus()).state).toBe('ready');
    await mlUpsertHealthMetricByDate('2026-01-04', { heartRate: 63 });
    expect(await read()).not.toHaveProperty('_mortalLoomSync');
  });

  it('rejects exact-byte mismatch at the commit boundary (even when data parses the same)', async () => {
    const expected = Buffer.from(JSON.stringify(fixture()));
    const later = Buffer.concat([expected, Buffer.from('\n')]);
    await writeFile(path, later, { mode: 0o600 });
    await expect(commitMortalLoomRevision(path, expected, Buffer.from(JSON.stringify(fixture({ goals: [goal('Later')] })))))
      .rejects.toMatchObject({ code: 'MORTALLOOM_REVISION_CHANGED' });
    expect(await readFile(path)).toEqual(later);
  });
});
