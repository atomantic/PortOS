import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

const disk = vi.hoisted(() => {
  const { mkdtempSync } = require('fs');
  const { tmpdir } = require('os');
  const { join } = require('path');
  return { root: mkdtempSync(join(tmpdir(), 'runtime-store-safety-')), fault: null };
});
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readFile: (...args) => {
      if (args[0] === disk.fault) return Promise.reject(Object.assign(new Error('injected read fault'), { code: 'EACCES' }));
      return actual.readFile(...args);
    }
  };
});
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: disk.root, extraOverrides: { root: disk.root } }));
vi.mock('./apps.js', () => ({ getAppById: vi.fn(), getAllApps: vi.fn(), PORTOS_APP_ID: 'self' }));
vi.mock('./git.js', () => ({ getBranch: vi.fn(), getStatus: vi.fn(), isRepo: vi.fn() }));
vi.mock('./shell.js', () => ({ listAllSessions: vi.fn(() => []) }));
vi.mock('./cosTaskStore.js', () => ({ getAllTasks: vi.fn() }));
vi.mock('./cosEvents.js', () => ({ cosEvents: { emit: vi.fn(), on: vi.fn() }, emitLog: vi.fn() }));
vi.mock('./quotaBurnInvoke.js', () => ({ getQuotaBurnTaskCatalog: vi.fn(), invokeQuotaBurnStep: vi.fn() }));
vi.mock('./quotaBurnSequence.js', () => ({ ACTIVE_TASK_STATUSES: new Set(), probeSequenceDrain: vi.fn(), sequenceStepShapeReason: vi.fn() }));
vi.mock('./promptRunner.js', () => ({ resolveProviderAndModel: vi.fn(), runPromptThroughProvider: vi.fn(), assertProvider: vi.fn() }));
vi.mock('./promptService.js', () => ({ buildPrompt: vi.fn() }));
vi.mock('./digital-twin-meta.js', () => ({ loadMeta: vi.fn() }));
vi.mock('./notifications.js', () => ({ addNotification: vi.fn(async () => ({})), NOTIFICATION_TYPES: {}, PRIORITY_LEVELS: {} }));

let timers;

const cases = [
  {
    name: 'autonomous jobs', path: 'cos/autonomous-jobs.json',
    load: () => import('./autonomousJobs/store.js'),
    read: svc => svc.loadJobs(),
    mutate: async svc => { const data = await svc.loadJobs(); data.auditMarker = true; await svc.saveJobs(data); },
    seed: { jobs: [{ id: 'keep', name: 'Custom job', enabled: false }], version: 1 },
    kept: data => data.jobs.some(job => job.id === 'keep')
  },
  {
    name: 'feature agents', path: 'cos/feature-agents.json',
    load: () => import('./featureAgents.js'),
    read: svc => svc.getAllFeatureAgents(),
    mutate: svc => svc.createFeatureAgent({ name: 'New agent' }),
    seed: { version: 1, agents: [{ id: 'keep', name: 'Existing agent' }] },
    kept: data => data.agents.some(agent => agent.id === 'keep')
  },
  {
    name: 'maintenance runs', path: 'cos/maintenance-runs.json',
    load: () => import('./maintenanceRun.js'),
    read: svc => svc.listMaintenanceRuns(),
    mutate: svc => svc.stopMaintenanceRun('stop'),
    seed: { runs: [{ id: 'keep', status: 'completed' }, { id: 'stop', status: 'running' }] },
    kept: data => data.runs.some(run => run.id === 'keep')
  },
  {
    name: 'model personality history', path: 'model-personality/results.json',
    load: () => import('./modelPersonality.js'),
    read: svc => svc.getHistory(),
    mutate: svc => svc.deleteResult('delete'),
    seed: [{ runId: 'keep' }, { runId: 'delete' }],
    kept: data => data.some(record => record.runId === 'keep')
  },
  {
    name: 'rounds', path: 'rounds.json',
    load: () => import('./rounds.js'),
    read: svc => svc.listRounds(),
    mutate: svc => svc.createRound({ title: 'New song' }),
    seed: { rounds: [{ id: 'keep', title: 'Existing song' }] },
    kept: data => data.rounds.some(round => round.id === 'keep')
  },
  {
    name: 'task schedule', path: 'cos/task-schedule.json',
    load: () => import('./taskScheduleStore.js'),
    read: svc => svc.loadSchedule(),
    mutate: svc => svc.updateSchedule(data => { data.auditMarker = true; return { changed: true }; }),
    seed: { version: 2, tasks: {}, executions: { keep: { count: 7 } } },
    kept: data => data.executions.keep.count === 7
  },
  {
    name: 'task templates', path: 'cos/task-templates.json',
    load: () => import('./taskTemplates.js'),
    read: svc => svc.getAllTemplates(),
    mutate: svc => svc.createTemplate({ name: 'New template' }),
    seed: { version: 1, userTemplates: [{ id: 'keep', name: 'Existing template' }], usage: { keep: 3 } },
    kept: data => data.userTemplates.some(template => template.id === 'keep') && data.usage.keep === 3
  },
  {
    name: 'workspace contexts', path: 'workspace-contexts.json',
    load: () => import('./workspaceContext.js'),
    read: svc => svc.getSavedContext('keep'),
    mutate: svc => svc.deleteContext('delete'),
    seed: { contexts: { keep: { branch: 'existing' }, delete: { branch: 'old' } } },
    kept: data => data.contexts.keep.branch === 'existing'
  }
];

afterEach(() => { disk.fault = null; timers?.__resetVoiceTimers(); });
afterAll(() => rm(disk.root, { recursive: true, force: true }));

describe('durable runtime write-back boundaries', () => {
  for (const boundary of cases) {
    it(`${boundary.name} preserves unreadable bytes, retries repaired input, and supports absent files`, async () => {
      // Load only this boundary: focused test-name runs do not instantiate
      // unrelated service graphs, whose external effects are stubbed above.
      const svc = await boundary.load();
      const path = join(disk.root, boundary.path);
      await mkdir(dirname(path), { recursive: true });
      // Each store must reject the complete read→mutation path, not only a
      // helper. Exercise both parse failures and a portable injected I/O fault.
      for (const bytes of ['{truncated', '', JSON.stringify(boundary.seed)]) {
        await writeFile(path, bytes);
        disk.fault = bytes.startsWith('{truncated') || bytes === '' ? null : path;
        await expect(boundary.mutate(svc)).rejects.toThrow(/Unreadable JSON file/);
        disk.fault = null;
        expect(await readFile(path, 'utf8')).toBe(bytes);
      }
      // No module reset: the failed jobs initialization and write tails must
      // recover when the user repairs the file, preserving unrelated records.
      await writeFile(path, JSON.stringify(boundary.seed));
      await boundary.mutate(svc);
      expect(boundary.kept(JSON.parse(await readFile(path, 'utf8')))).toBe(true);
      await rm(path);
      await expect(boundary.read(svc)).resolves.toBeDefined();
      await expect(boundary.mutate(svc)).resolves.not.toThrow();
    });
  }

  it('timer scheduling refuses a failed restore and retries without losing pending reminders', async () => {
    timers = await import('./voice/timers.js');
    const path = join(disk.root, 'voice-timers.json');
    for (const bytes of ['', '{truncated', '{"version":1,"timers":[]}']) {
      await writeFile(path, bytes);
      disk.fault = bytes.includes('version') ? path : null;
      await expect(timers.initVoiceTimers()).rejects.toThrow(/Unreadable JSON file/);
      await expect(timers.scheduleTimer({ totalMs: 60_000, label: 'New reminder' })).rejects.toThrow(/Unreadable JSON file/);
      disk.fault = null;
      expect(await readFile(path, 'utf8')).toBe(bytes);
    }
    await writeFile(path, JSON.stringify({ version: 1, timers: [{ id: 'keep', label: 'Existing reminder', fireAt: Date.now() + 120_000 }] }));
    await timers.scheduleTimer({ totalMs: 60_000, label: 'New reminder' });
    expect(JSON.parse(await readFile(path, 'utf8')).timers.map(timer => timer.label)).toEqual(['Existing reminder', 'New reminder']);
    timers.__resetVoiceTimers();
    await rm(path);
    await timers.scheduleTimer({ totalMs: 60_000, label: 'First reminder' });
    expect(JSON.parse(await readFile(path, 'utf8')).timers).toHaveLength(1);
  });
});
