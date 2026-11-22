import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { chmod, mkdir, readdir, readFile, rm, utimes, writeFile } from 'fs/promises';
import { join } from 'path';
import { errorMiddleware } from '../lib/errorHandler.js';
import { request } from '../lib/testHelper.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// Skill Curator public boundary (#17391): usage telemetry, fail-closed usage
// reads, pin/lock guards, the deterministic stale/archive pass with its grace
// floor and job protection, archive/restore, and the content-addressed ledger
// with single-entry rollback and compaction.
const DATA_PREFIX = 'portos-skills-curator-';
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot(DATA_PREFIX) }));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn().mockResolvedValue(false),
}));
const state = vi.hoisted(() => ({ settings: {}, jobs: [] }));
vi.mock('../services/settings.js', async (importOriginal) => ({
  ...await importOriginal(),
  getSettings: vi.fn(async () => state.settings),
  updateSettingsWith: vi.fn(async (mutate) => { state.settings = await mutate(state.settings); return state.settings; }),
}));
vi.mock('../services/apps.js', () => ({ getAppById: vi.fn(async () => null) }));
vi.mock('../services/autonomousJobs.js', () => ({
  getAllJobs: vi.fn(async () => state.jobs),
  getJob: vi.fn(async (id) => state.jobs.find((job) => job.id === id) || null),
}));

const { authGate, hostControlRouteGate } = await import('../services/authGate.js');
const { default: skillsRoutes } = await import('./skills.js');
const { viewSkill } = await import('../services/skills/skillService.js');
const { appendLedgerEntry, captureSkillDir, compactLedger, readLedgerEntries } = await import('../services/skills/skillLedger.js');

const app = express();
app.use(authGate);
app.use(hostControlRouteGate);
app.use(express.json());
app.use('/api/skills', skillsRoutes);
app.use(errorMiddleware);

const DAY_MS = 24 * 60 * 60 * 1000;
const skillsDir = () => join(lazyTempDataRoot(DATA_PREFIX), 'skills');
const usageFile = () => join(skillsDir(), '.usage.json');
const skillMd = (name, body = 'Follow the steps.') => `---\nname: ${name}\ndescription: ${name} procedure\n---\n\n# ${name}\n\n${body}\n`;
const daysAgo = (days) => new Date(Date.now() - days * DAY_MS).toISOString();

const agentCreate = (name, body) => request(app).post('/api/skills/manage').send({ action: 'create', name, content: skillMd(name, body) });
const userEdit = (body) => request(app).post('/api/skills/edit').send(body);
const agentManage = (body) => request(app).post('/api/skills/manage').send(body);
const lifecycle = (ref, action) => request(app).post(`/api/skills/${encodeURIComponent(ref)}/${action}`).send({});
const listed = async (id) => (await request(app).get('/api/skills')).body.skills.find((skill) => skill.id === id);
const readUsageFile = async () => JSON.parse(await readFile(usageFile(), 'utf8'));
const editUsage = async (id, patch) => {
  const doc = await readUsageFile();
  doc.skills[id] = { ...doc.skills[id], ...patch };
  await writeFile(usageFile(), JSON.stringify(doc));
};

beforeEach(async () => {
  state.settings = {};
  state.jobs = [];
  await rm(skillsDir(), { recursive: true, force: true });
});

afterAll(() => cleanupTempDataRoots());

describe('usage telemetry', () => {
  it('counts views, agent loads and patches, and records provenance', async () => {
    expect((await agentCreate('deploy')).status).toBe(200);
    expect((await listed('local:deploy')).usage).toMatchObject({ createdBy: 'agent', state: 'active', viewCount: 0, useCount: 0, patchCount: 0 });

    expect((await request(app).get('/api/skills/view?ref=deploy')).status).toBe(200);
    await viewSkill({ ref: 'deploy' }, { actor: 'agent' });
    expect((await agentManage({ action: 'patch', name: 'deploy', oldString: 'Follow', newString: 'Run' })).status).toBe(200);

    const { usage } = await listed('local:deploy');
    expect(usage).toMatchObject({ viewCount: 2, useCount: 1, patchCount: 1 });
    expect(usage.lastUsedAt).toEqual(expect.any(String));
    expect(usage.lastPatchedAt).toEqual(expect.any(String));

    expect((await userEdit({ action: 'create', name: 'mine', content: skillMd('mine') })).status).toBe(200);
    expect((await listed('local:mine')).usage.createdBy).toBe('user');
  });

  it('fails closed on a corrupt usage file without ever overwriting it', async () => {
    await agentCreate('deploy');
    await writeFile(usageFile(), '{"version":1,"skills":{"local:deploy":{"locked":tr');

    const list = await request(app).get('/api/skills');
    expect(list.body.usageUnavailable).toBe(true);
    expect(list.body.skills.find((skill) => skill.id === 'local:deploy').usage).toBeUndefined();
    // Reads still work; the count is skipped.
    expect((await request(app).get('/api/skills/view?ref=deploy')).status).toBe(200);

    const agentPatch = await agentManage({ action: 'patch', name: 'deploy', oldString: 'Follow', newString: 'Run' });
    expect(agentPatch.status).toBe(503);
    expect(agentPatch.body.code).toBe('SKILL_USAGE_UNREADABLE');
    expect((await agentCreate('another')).status).toBe(503);
    // A human edit proceeds; a delete cannot verify the pin, so it is refused.
    expect((await userEdit({ action: 'patch', name: 'deploy', oldString: 'Follow', newString: 'Run' })).status).toBe(200);
    expect((await userEdit({ action: 'delete', name: 'deploy' })).status).toBe(503);
    expect((await lifecycle('deploy', 'lock')).status).toBe(503);
    expect((await request(app).post('/api/skills/curator/run').send({})).status).toBe(503);

    expect(await readFile(usageFile(), 'utf8')).toBe('{"version":1,"skills":{"local:deploy":{"locked":tr');
  });
});

describe('pin and lock guards', () => {
  it('refuses every agent write on a locked skill while reads and human edits still work', async () => {
    await agentCreate('deploy');
    expect((await lifecycle('deploy', 'lock')).body.usage.locked).toBe(true);

    for (const body of [
      { action: 'patch', name: 'deploy', oldString: 'Follow', newString: 'Run' },
      { action: 'write_file', name: 'deploy', path: 'references/a.md', content: 'x' },
      { action: 'remove_file', name: 'deploy', path: 'references/a.md' },
      { action: 'delete', name: 'deploy' },
    ]) {
      const refused = await agentManage(body);
      expect(refused.status).toBe(423);
      expect(refused.body.code).toBe('SKILL_LOCKED');
    }
    expect((await request(app).get('/api/skills/view?ref=deploy')).status).toBe(200);
    expect((await userEdit({ action: 'patch', name: 'deploy', oldString: 'Follow', newString: 'Run' })).status).toBe(200);
    expect(await readFile(join(skillsDir(), 'deploy', 'SKILL.md'), 'utf8')).toContain('Run the steps.');

    await lifecycle('deploy', 'unlock');
    expect((await agentManage({ action: 'patch', name: 'deploy', oldString: 'Run', newString: 'Do' })).status).toBe(200);
  });

  it('lets an agent improve a pinned skill but refuses deleting or archiving it', async () => {
    await agentCreate('deploy');
    await lifecycle('deploy', 'pin');
    expect((await agentManage({ action: 'patch', name: 'deploy', oldString: 'Follow', newString: 'Run' })).status).toBe(200);
    expect((await agentManage({ action: 'delete', name: 'deploy' })).body.code).toBe('SKILL_PINNED');
    expect((await userEdit({ action: 'delete', name: 'deploy' })).status).toBe(409);
    expect((await lifecycle('deploy', 'archive')).body.code).toBe('SKILL_PINNED');
  });

  it('adopts only local skills and keeps their history', async () => {
    await userEdit({ action: 'create', name: 'mine', content: skillMd('mine') });
    await editUsage('local:mine', { lastUsedAt: daysAgo(3), useCount: 4 });
    const adopted = await lifecycle('mine', 'adopt');
    expect(adopted.body.usage).toMatchObject({ createdBy: 'agent', useCount: 4, lastUsedAt: expect.any(String) });
    expect(Date.parse(adopted.body.usage.lastUsedAt)).toBeLessThan(Date.now() - 2 * DAY_MS);
    expect((await lifecycle('shipped:anything', 'adopt')).status).toBe(404);
  });
});

describe('curator pass', () => {
  const run = (dryRun) => request(app).post('/api/skills/curator/run').send(dryRun === undefined ? {} : { dryRun });

  it('previews, then moves idle agent skills active → stale → archived, skipping protected ones', async () => {
    for (const name of ['idle', 'pinned', 'locked', 'jobbed', 'human', 'fresh']) await agentCreate(name);
    await userEdit({ action: 'create', name: 'human-made', content: skillMd('human-made') });
    for (const name of ['idle', 'pinned', 'locked', 'jobbed', 'human-made']) await editUsage(`local:${name}`, { createdAt: daysAgo(20) });
    await editUsage('local:pinned', { pinned: true });
    await editUsage('local:locked', { locked: true });
    // A paused job still protects the skill it names.
    state.jobs = [{ id: 'job-x', name: 'Weekly', enabled: false, promptTemplate: 'Load the `jobbed` skill first.' }];

    const preview = await run(true);
    expect(preview.status).toBe(200);
    expect(preview.body.transitions).toEqual([expect.objectContaining({ id: 'local:idle', from: 'active', to: 'stale', idleDays: 20 })]);
    expect(Object.fromEntries(preview.body.skipped.map((entry) => [entry.name, entry.reason]))).toMatchObject({
      pinned: 'pinned', locked: 'locked', jobbed: 'job-referenced', 'human-made': 'not-agent-created',
    });
    expect((await readUsageFile()).skills['local:idle'].state).toBe('active');

    expect((await run()).body.transitions).toHaveLength(1);
    expect((await listed('local:idle')).usage.state).toBe('stale');

    // Past the archive threshold the stale skill moves into .archive/.
    await editUsage('local:idle', { createdAt: daysAgo(40) });
    const archivedRun = await run();
    expect(archivedRun.body.transitions).toEqual([expect.objectContaining({ id: 'local:idle', from: 'stale', to: 'archived' })]);
    const list = (await request(app).get('/api/skills')).body;
    expect(list.skills.some((skill) => skill.id === 'local:idle')).toBe(false);
    expect(list.archived).toEqual([expect.objectContaining({ id: 'archive:idle', originalId: 'local:idle', usage: expect.objectContaining({ state: 'archived' }) })]);
    expect(await readFile(join(skillsDir(), '.archive', 'idle', 'SKILL.md'), 'utf8')).toContain('# idle');

    const status = (await request(app).get('/api/skills/curator/status')).body;
    expect(status.counts).toMatchObject({ archived: 1, pinned: 1, locked: 1 });
    expect(status.lastRun).toMatchObject({ archived: 1 });
  });

  it('reactivates a stale skill that was used again', async () => {
    await agentCreate('idle');
    await editUsage('local:idle', { createdAt: daysAgo(20) });
    await run();
    await viewSkill({ ref: 'idle' }, { actor: 'agent' });
    expect((await listed('local:idle')).usage.state).toBe('active');
  });

  it('gives a never-used skill a grace floor from adoption or first sight', async () => {
    await userEdit({ action: 'create', name: 'old', content: skillMd('old') });
    await editUsage('local:old', { createdAt: daysAgo(100) });
    await lifecycle('old', 'adopt');
    await agentCreate('unstamped');
    await editUsage('local:unstamped', { createdAt: null });

    const result = (await run()).body;
    expect(result.transitions).toEqual([]);
    expect(result.tracked).toEqual([expect.objectContaining({ id: 'local:unstamped' })]);
    expect((await readUsageFile()).skills['local:unstamped'].adoptedAt).toEqual(expect.any(String));
  });

  it('restores an archived skill, refusing when a local skill now holds its name', async () => {
    await agentCreate('idle');
    expect((await lifecycle('idle', 'archive')).body.archivePath).toBe('.archive/idle');
    await agentCreate('idle', 'A newer version.');
    expect((await lifecycle('local:idle', 'restore')).body.code).toBe('SKILL_EXISTS');

    await agentManage({ action: 'delete', name: 'idle' });
    const restored = await lifecycle('local:idle', 'restore');
    expect(restored.status).toBe(200);
    expect(restored.body.usage.state).toBe('active');
    expect(await readFile(join(skillsDir(), 'idle', 'SKILL.md'), 'utf8')).toContain('Follow the steps.');
    expect((await request(app).get('/api/skills')).body.archived).toEqual([]);
  });
});

describe('mutation ledger', () => {
  const ledger = async () => (await request(app).get('/api/skills/ledger')).body.entries;
  const rollback = (id) => request(app).post(`/api/skills/ledger/${id}/rollback`).send({});

  it('rolls back one patch exactly, leaving other skills alone', async () => {
    await agentCreate('deploy');
    await agentCreate('other');
    await agentManage({ action: 'patch', name: 'deploy', oldString: 'Follow', newString: 'Run' });
    await agentManage({ action: 'patch', name: 'other', oldString: 'Follow', newString: 'Skip' });

    const [otherPatch, deployPatch] = await ledger();
    expect(deployPatch).toMatchObject({ actor: 'agent', action: 'patch', skill: { id: 'local:deploy' }, before: { files: 1 } });
    expect(otherPatch.skill.id).toBe('local:other');

    const result = await rollback(deployPatch.id);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ restored: ['deploy/SKILL.md'], entry: { action: 'rollback', rollbackOf: deployPatch.id } });
    expect(await readFile(join(skillsDir(), 'deploy', 'SKILL.md'), 'utf8')).toBe(skillMd('deploy'));
    expect(await readFile(join(skillsDir(), 'other', 'SKILL.md'), 'utf8')).toContain('Skip the steps.');
  });

  it('resurrects a deleted skill with its supporting files', async () => {
    await agentCreate('deploy');
    await agentManage({ action: 'write_file', name: 'deploy', path: 'references/checklist.md', content: '- one\n' });
    await agentManage({ action: 'delete', name: 'deploy' });
    const [deletion] = await ledger();
    expect(deletion).toMatchObject({ action: 'delete', after: null, before: { files: 2 } });

    expect((await rollback(deletion.id)).status).toBe(200);
    expect(await readFile(join(skillsDir(), 'deploy', 'references', 'checklist.md'), 'utf8')).toBe('- one\n');
    expect((await request(app).get('/api/skills/view?ref=deploy')).status).toBe(200);
  });

  it('rolls an archive back to the active tree', async () => {
    await agentCreate('idle');
    await lifecycle('idle', 'archive');
    const [archive] = await ledger();
    expect(archive).toMatchObject({ action: 'archive', after: { paths: ['.archive/idle/SKILL.md'] } });
    expect((await rollback(archive.id)).body.removed).toEqual(['.archive/idle/SKILL.md']);
    expect((await listed('local:idle')).usage.state).toBe('active');
  });

  it('fails closed when a needed blob is missing or the safety snapshot cannot be stored', async () => {
    await agentCreate('deploy');
    await agentManage({ action: 'patch', name: 'deploy', oldString: 'Follow', newString: 'Run' });
    const [patch] = await ledger();
    const blobDir = join(skillsDir(), '.ledger_blobs');
    const current = await readFile(join(skillsDir(), 'deploy', 'SKILL.md'), 'utf8');

    // The safety snapshot of a hand edit needs a new blob; a read-only blob store refuses it.
    await writeFile(join(skillsDir(), 'deploy', 'SKILL.md'), `${current}Hand edit.\n`);
    await chmod(blobDir, 0o500);
    let refused;
    try {
      refused = await rollback(patch.id);
    } finally {
      await chmod(blobDir, 0o700);
    }
    expect(refused.status).toBeGreaterThanOrEqual(500);
    expect(await readFile(join(skillsDir(), 'deploy', 'SKILL.md'), 'utf8')).toBe(`${current}Hand edit.\n`);
    expect((await readLedgerEntries()).some((entry) => entry.action === 'rollback')).toBe(false);

    const ledgerEntries = await readLedgerEntries();
    const beforeSha = ledgerEntries.find((entry) => entry.id === patch.id).before[0].sha256;
    await rm(join(blobDir, beforeSha));
    const missing = await rollback(patch.id);
    expect(missing.status).toBe(409);
    expect(missing.body.code).toBe('SKILL_LEDGER_BLOB_MISSING');
    expect(await readFile(join(skillsDir(), 'deploy', 'SKILL.md'), 'utf8')).toBe(`${current}Hand edit.\n`);
  });

  it('compacts no-op entries first, then the oldest, always keeping the newest, and sweeps old orphan blobs', async () => {
    await mkdir(join(skillsDir(), 'big'), { recursive: true });
    const skill = { id: 'local:big', name: 'big', path: 'big' };
    const write = async (text) => {
      await writeFile(join(skillsDir(), 'big', 'SKILL.md'), text);
      return captureSkillDir('big');
    };
    const first = await write('a'.repeat(4000));
    await appendLedgerEntry({ actor: 'agent', action: 'patch', skill, before: null, after: first });
    await appendLedgerEntry({ actor: 'agent', action: 'patch', skill, before: first, after: first });
    const second = await write('b'.repeat(4000));
    await appendLedgerEntry({ actor: 'agent', action: 'patch', skill, before: first, after: second });
    const third = await write('c'.repeat(4000));
    const newest = await appendLedgerEntry({ actor: 'agent', action: 'patch', skill, before: second, after: third });

    // Age every blob past the sweep grace window.
    const blobDir = join(skillsDir(), '.ledger_blobs');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (const name of await readdir(blobDir)) await utimes(join(blobDir, name), old, old);

    const compacted = await compactLedger({ maxBytes: 9000 });
    const remaining = await readLedgerEntries();
    expect(remaining.at(-1).id).toBe(newest.id);
    expect(remaining.some((entry) => entry.before && entry.after && entry.before[0].sha256 === entry.after[0].sha256)).toBe(false);
    expect(remaining).toHaveLength(1);
    expect(compacted).toMatchObject({ dropped: 3, swept: 1 });
    expect((await readdir(blobDir)).sort()).toEqual([second[0].sha256, third[0].sha256].sort());

    // Even a single entry over the cap is kept.
    await compactLedger({ maxBytes: 1 });
    expect((await readLedgerEntries()).map((entry) => entry.id)).toEqual([newest.id]);
  });
});
