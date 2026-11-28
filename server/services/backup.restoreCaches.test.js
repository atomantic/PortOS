/** File restore reconciliation against live services and their cached file stores. */
import { fakeProc, flush, testDataRoot } from './backup.test.fixture.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import { dirname, join } from 'path';
import { createPromptsService } from '../lib/aiToolkit/prompts.js';
import { setAIToolkitInstance } from '../lib/aiToolkitState.js';
import { spawn } from '../lib/childProcess.js';
import { PATHS, getDateString } from '../lib/fileUtils.js';
import { restoreSnapshot } from './backup.js';
import * as apps from './apps.js';
import * as notifications from './notifications.js';
import * as feeds from './feeds.js';
import { searchSNP, saveMarker, updateMarkerNotes } from './genome.js';
import { getAccountById, updateAccount } from './socialAccounts.js';
import * as personalities from './agent/agentPersonalities.js';
import * as automation from './automationScheduler.js';
import { cancelAll, getEvent } from './eventScheduler.js';
import { updateMeta } from './digital-twin-meta.js';
import { getDigitalTwinForPrompt } from './digital-twin-context.js';
import { scheduleTimer, __resetVoiceTimers } from './voice/timers.js';
import * as decisionLog from './decisionLog.js';
import * as memoryClassifier from './memoryClassifier.js';
import * as feedbackStore from './feedbackStore.js';
import * as tasteQuestionnaire from './taste-questionnaire.js';
import * as taskLearningStore from './taskLearning/store.js';
import * as tools from './tools.js';

import * as brainStorage from './brainStorage.js';
import * as brainJournal from './brainJournal.js';
import * as brainSyncLog from './brainSyncLog.js';
import { loadBridgeMap } from './brainMemoryBridge.js';
import * as history from './history.js';
import * as jevHeads from './jevHeads.js';
import * as jevRouter from './jevRouter.js';
import { JEV_LABELS, JEV_MODEL } from '../lib/jev.js';
import { JEV_HEAD_POOLING, JEV_HEAD_SCHEMA_VERSION, jevHeadFileName } from '../lib/jevHead.js';
import { getNicotineSummary } from './meatspace/meatspaceNicotine.js';
import { mutateDailyLog } from './meatspace/meatspaceDailyLog.js';

vi.mock('../lib/jevPaths.js', async importOriginal => ({
  ...(await importOriginal()),
  jevHeadsDir: () => join(testDataRoot(), 'jev', 'heads'),
}));

describe('live file restore caches', () => {
  beforeEach(() => { spawn.mockReset(); });

  it('reads and edits the files installed by a full live restore', async () => {
    const original = 'before-restore';
    const restored = 'from-snapshot';
    const item = (id, pubDate) => ({ id, feedId: 'feed', pubDate, read: false });
    const originalItem = item(original, '2025-01-01');
    const older = item('older', '2025-01-02');
    const newer = item(restored, '2025-01-03');
    const stores = [
      ['apps.json', { apps: { [original]: { name: original } } }, { apps: { [restored]: { name: restored } } }],
      ['notifications.json', { notifications: [{ id: original }] }, { notifications: [{ id: restored }] }],
      ['feeds.json', { feeds: [], items: [originalItem] }, { feeds: [], items: [older, newer] }],
      ['agents/agents.json', { agents: { [original]: { name: original } } }, { agents: { [restored]: { name: restored } } }],
      ['agents/schedules.json', { schedules: { [original]: { enabled: false } } }, {
        schedules: { [restored]: { action: { type: 'example' }, enabled: false } },
      }],
    ];
    const install = (version) => Promise.all(stores.map(([path, before, after]) => (
      fs.writeFile(join(testDataRoot(), path), JSON.stringify(version === 'before' ? before : after))
    )));
    await fs.mkdir(PATHS.agentPersonalities, { recursive: true });
    await install('before');
    // Keep the TTLs warm even on slow runners.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      expect(await apps.getAppById(original)).toMatchObject({ id: original });
      expect(await notifications.getNotifications()).toMatchObject([{ id: original }]);
      expect(await feeds.getItems()).toEqual([originalItem]);
      expect(await personalities.getAgentById(original)).toMatchObject({ id: original });
      expect(await automation.getScheduleById(original)).toMatchObject({ id: original });

      const proc = fakeProc();
      spawn.mockReturnValue(proc);
      const pending = restoreSnapshot('/dest', 'snap-1', { dryRun: false });
      await flush();
      await install('after');
      proc.emit('close', 0);
      await pending;

      expect(await apps.getAppById(restored)).toMatchObject({ id: restored });
      expect(await notifications.getNotifications()).toMatchObject([{ id: restored }]);
      expect(await feeds.getItems()).toEqual([newer, older]);
      expect(await personalities.getAgentById(restored)).toMatchObject({ id: restored });
      expect(await automation.getScheduleById(restored)).toMatchObject({ id: restored });

      await Promise.all([
        apps.updateApp(restored, { name: 'edited' }),
        notifications.markAsRead(restored),
        feeds.markItemRead(restored),
        personalities.updateAgent(restored, { name: 'edited' }),
        automation.updateSchedule(restored, { runCount: 4 }),
      ]);
      const [appData, notificationData, feedData, agentData, scheduleData] = await Promise.all(stores.map(async ([path]) => (
        JSON.parse(await fs.readFile(join(testDataRoot(), path), 'utf8'))
      )));
      expect(appData.apps[restored].name).toBe('edited');
      expect(appData.apps).not.toHaveProperty(original);
      expect(notificationData.notifications).toEqual([{ id: restored, read: true }]);
      expect(feedData.items).toEqual([{ ...newer, read: true }, older]);
      expect(agentData.agents).toMatchObject({ [restored]: { name: 'edited' } });
      expect(agentData.agents).not.toHaveProperty(original);
      expect(scheduleData.schedules).toMatchObject({ [restored]: { runCount: 4 } });
      expect(scheduleData.schedules).not.toHaveProperty(original);
    } finally {
      clock.mockRestore();
    }
  });

  it('invalidates Brain, history, jev and nicotine caches before queued writes resume after a partial restore', async () => {
    const day = '2026-01-01';
    const decisionId = 'scope-adherence';
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    const write = async (name, content) => {
      const path = join(testDataRoot(), name);
      await fs.mkdir(dirname(path), { recursive: true });
      await fs.writeFile(path, typeof content === 'string' ? content : JSON.stringify(content));
    };
    const locations = name => ({ [day]: { obsidianPath: name, obsidianVaultId: 'example-vault' } });
    const historyLine = id => JSON.stringify({ id, action: id }) + '\n';
    const dailyLog = (date, amount) => ({
      entries: [{ date, nicotine: { items: [{ product: 'Example', mgPerUnit: amount, count: 1 }], totalMg: amount } }]
    });
    const today = getDateString();
    const counters = observed => ({ schemaVersion: 1, decisions: { [decisionId]: { observed } } });
    const record = description => ({ id: 'project', description, title: 'Example' });
    const head = {
      schemaVersion: JEV_HEAD_SCHEMA_VERSION, decisionId, architecture: 'linear', pooling: JEV_HEAD_POOLING,
      baseModel: { id: JEV_MODEL.id, repository: JEV_MODEL.repository, revision: JEV_MODEL.revision },
      hiddenSize: 2, labels: [...JEV_LABELS], layers: [{ weight: [[1, 0], [0, 1], [1, 1]], bias: [0, 0, 0] }],
      metrics: { trained: 0.71, stockZeroShot: 0.58, majorityClass: 0.52, goldSize: 40, trainSize: 120 },
      corpusHash: 'deadbeefcafe0001', corpusSources: ['merged-pr'], trainedAt: '2026-01-01T00:00:00.000Z',
    };
    try {
      await Promise.all([
        write(`brain/journals/${day}/index.json`, { id: day, date: day, content: 'Example' }),
        write('brain/journal-obsidian-locations.json', locations('Earlier.md')),
        write('brain/projects/project/index.json', record('earlier')),
        write('brain/memory-bridge-map.json', { 'projects:project': 'earlier-memory' }),
        write('history.jsonl', historyLine('earlier')),
        write('local-llm/jev-shadow.json', counters(1)),
        write('meatspace/daily-log.json', dailyLog(today, 1)),
      ]);
      await brainSyncLog.initSyncLog();
      await brainSyncLog.appendChange('create', 'projects', 'earlier', { title: 'Earlier' });
      expect(await brainJournal.getJournal(day)).toMatchObject({ obsidianPath: 'Earlier.md' });
      expect(await loadBridgeMap()).toEqual({ 'projects:project': 'earlier-memory' });
      expect((await history.getHistory()).entries).toMatchObject([{ id: 'earlier' }]);
      expect(await jevHeads.getAdoptedJevHeadSlug(decisionId)).toBeNull();
      expect((await jevRouter.readJevDecisionStats()).decisions).toMatchObject([{ observed: 1 }]);
      expect((await getNicotineSummary()).recentEntries).toMatchObject([{ nicotine: { totalMg: 1 } }]);

      const proc = fakeProc();
      spawn.mockReturnValue(proc);
      const restore = restoreSnapshot('/dest', 'snap-1', { dryRun: false });
      const failed = expect(restore).rejects.toThrow(/Some files may already have been overwritten/);
      await flush();
      const writes = [
        brainStorage.update('projects', 'project', { title: 'Edited' }),
        history.deleteEntry('restored'),
        jevHeads.adoptJevHead(decisionId),
        jevRouter.recordJevObservations({ decisionId, kind: 'decided' }),
        mutateDailyLog(log => log.entries[0].nicotine.totalMg),
      ];
      await Promise.all([
        write('brain/journal-obsidian-locations.json', locations('Restored.md')),
        write('brain/projects/project/index.json', record('restored')),
        write('brain/memory-bridge-map.json', { 'projects:project': 'restored-memory' }),
        write('brain/sync_log.jsonl', JSON.stringify({ seq: 40, op: 'create', type: 'ideas', id: 'restored' }) + '\n'),
        write('history.jsonl', historyLine('restored')),
        write(`jev/heads/${jevHeadFileName(decisionId, { candidate: true })}`, head),
        write('local-llm/jev-shadow.json', counters(10)),
        write('meatspace/daily-log.json', dailyLog(today, 3)),
      ]);
      proc.emit('close', 1);
      await failed;
      const [project, deletion, adoption, stats, previousTotal] = await Promise.all(writes);
      expect(project).toMatchObject({ description: 'restored', title: 'Edited' });
      expect((await brainSyncLog.getChangesSince(39)).changes).toMatchObject([
        { seq: 40, id: 'restored' }, { seq: 41, id: 'project' },
      ]);
      expect(await brainJournal.getJournal(day)).toMatchObject({ obsidianPath: 'Restored.md' });
      expect(await loadBridgeMap()).toEqual({ 'projects:project': 'restored-memory' });
      expect(deletion).toMatchObject({ deleted: true });
      expect((await history.getHistory()).entries).toEqual([]);
      expect(adoption.ok).toBe(true);
      expect(await jevHeads.getAdoptedJevHeadSlug(decisionId)).toBe(decisionId);
      expect(stats.decisions[decisionId].observed).toBe(11);
      expect(previousTotal).toBe(3);
      expect((await getNicotineSummary()).recentEntries).toMatchObject([{ nicotine: { totalMg: 3 } }]);
    } finally {
      clock.mockRestore();
    }
  });

  it.each([0, 1])('reconciles running automation timers and queued edits after transfer exit %i', async exit => {
    const path = join(PATHS.agentPersonalities, 'schedules.json');
    const interval = intervalMs => ({ enabled: true, action: { type: 'example' }, schedule: { type: 'interval', intervalMs } });
    const install = schedules => fs.writeFile(path, JSON.stringify({ schedules }));
    const event = id => getEvent(`agent-schedule-${id}`);
    const executor = vi.fn();
    automation.registerActionExecutor(executor);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      await fs.mkdir(PATHS.agentPersonalities, { recursive: true });
      await install(Object.fromEntries(['changed', 'removed', 'disabled', 'unchanged'].map(id => [id, interval(600000)])));
      automation.invalidateCache();
      await automation.init();
      const unchangedNext = event('unchanged').nextRunAt;
      clock.mockReturnValue(Date.now() + 10000);
      const now = Date.now();
      const lastRun = new Date(now - 30000).toISOString();
      const proc = fakeProc();
      spawn.mockReturnValue(proc);
      const pending = restoreSnapshot('/dest', 'snap-1', { dryRun: false, subdirFilter: 'agents/schedules.json' });
      await flush();
      const edit = automation.updateSchedule('edited', { schedule: { type: 'interval', intervalMs: 900000 } });
      await install({
        added: interval(800000),
        changed: { ...interval(700000), lastRun, runCount: 3 },
        unchanged: interval(600000),
        disabled: { ...interval(600000), enabled: false },
        edited: interval(600000),
        random: { ...interval(0), schedule: { type: 'random', randomWindow: { minMs: 500000, maxMs: 500000 } } },
      });
      proc.emit('close', exit);
      if (exit) await expect(pending).rejects.toThrow(/Some files may already have been overwritten/);
      else await pending;
      await edit;
      expect(event('added').nextRunAt).toBe(now + 800000);
      expect(event('changed').nextRunAt).toBe(Date.parse(lastRun) + 700000);
      expect(event('removed')).toBeNull();
      expect(event('disabled')).toBeNull();
      expect(event('unchanged').nextRunAt).toBe(unchangedNext);
      expect(event('random').nextRunAt).toBe(now + 500000);
      expect(event('edited').nextRunAt).toBe(now + 900000);
      const { schedules } = JSON.parse(await fs.readFile(path, 'utf8'));
      expect(schedules.random.rolledIntervalMs).toBe(500000);
      expect(schedules.changed.runCount).toBe(3);
      expect(schedules.edited.schedule.intervalMs).toBe(900000);
      expect(executor).not.toHaveBeenCalled();
    } finally {
      cancelAll();
      await install({});
      automation.invalidateCache();
      automation.registerActionExecutor(null);
      clock.mockRestore();
    }
  });

  it('releases queued notification edits onto the restored data after a scoped partial transfer', async () => {
    const path = join(testDataRoot(), 'notifications.json');
    notifications.invalidateCache();
    await fs.writeFile(path, JSON.stringify({ notifications: [{ id: 'original', read: false }] }));
    expect(await notifications.getNotifications()).toMatchObject([{ id: 'original' }]);

    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const pending = restoreSnapshot('/dest', 'snap-1', { dryRun: false, subdirFilter: './notifications.json/' });
    await flush();
    const edit = notifications.markAsRead('restored');
    await fs.writeFile(path, JSON.stringify({ notifications: [{ id: 'restored', read: false }] }));
    proc.emit('close', 1);

    await expect(pending).rejects.toThrow(/Some files may already have been overwritten/);
    await edit;
    expect(JSON.parse(await fs.readFile(path, 'utf8')).notifications).toEqual([{ id: 'restored', read: true }]);
  });

  it('invalidates the genome index and fences marker edits after a partial MeatSpace restore', async () => {
    const rawPath = join(PATHS.meatspace, 'genome-raw.txt');
    const metaPath = join(PATHS.meatspace, 'genome.json');
    const rsid = 'rs999999999';
    const install = async (genotype, id) => {
      await fs.writeFile(rawPath, `${rsid}\t1\t1\t${genotype}\n`);
      await fs.writeFile(metaPath, JSON.stringify({ uploaded: true, savedMarkers: { [id]: { rsid } } }));
    };
    await fs.mkdir(PATHS.meatspace, { recursive: true });
    await install('AA', 'original');
    await expect(searchSNP(rsid)).resolves.toMatchObject({ genotype: 'A/A' });

    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const pending = restoreSnapshot('/dest', 'snap-1', { dryRun: false, subdirFilter: 'meatspace' });
    await flush();
    const staleMarker = saveMarker({ rsid });
    const edit = updateMarkerNotes('restored', 'edited');
    await install('CC', 'restored');
    proc.emit('close', 1);

    await expect(pending).rejects.toThrow(/Some files may already have been overwritten/);
    await expect(staleMarker).resolves.toMatchObject({ error: expect.stringContaining('Genome data changed') });
    await expect(edit).resolves.toMatchObject({ id: 'restored', notes: 'edited' });
    await expect(searchSNP(rsid)).resolves.toMatchObject({ genotype: 'C/C' });
    expect(JSON.parse(await fs.readFile(metaPath, 'utf8')).savedMarkers).toEqual({ restored: { rsid, notes: 'edited' } });
  });

  it('releases queued social account edits onto a restored account file', async () => {
    const path = join(PATHS.digitalTwin, 'social-accounts.json');
    const install = id => fs.writeFile(path, JSON.stringify({ accounts: { [id]: { platform: 'github', username: id } } }));
    await fs.mkdir(PATHS.digitalTwin, { recursive: true });
    await install('original');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      await expect(getAccountById('original')).resolves.toMatchObject({ username: 'original' });
      const proc = fakeProc();
      spawn.mockReturnValue(proc);
      const pending = restoreSnapshot('/dest', 'snap-1', { dryRun: false, subdirFilter: 'digital-twin/social-accounts.json' });
      await flush();
      const edit = updateAccount('restored', { notes: 'edited' });
      await install('restored');
      proc.emit('close', 0);

      await pending;
      await expect(edit).resolves.toMatchObject({ username: 'restored', notes: 'edited' });
      await expect(getAccountById('original')).resolves.toBeNull();
      const { accounts } = JSON.parse(await fs.readFile(path, 'utf8'));
      expect(accounts).toMatchObject({ restored: { notes: 'edited' } });
      expect(accounts).not.toHaveProperty('original');
    } finally {
      clock.mockRestore();
    }
  });

  it('allows apps reads during a scoped restore without persisting baseline normalization', async () => {
    const path = join(testDataRoot(), 'apps.json');
    const original = { apps: { original: { name: 'Original app' } } };
    apps.invalidateCache();
    await fs.writeFile(path, JSON.stringify(original));

    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const pending = restoreSnapshot('/dest', 'snap-1', { dryRun: false, subdirFilter: 'apps.json' });
    await flush();
    try {
      expect(await apps.getAppById('original')).toMatchObject({ name: 'Original app' });
      expect(JSON.parse(await fs.readFile(path, 'utf8'))).toEqual(original);
      await fs.writeFile(path, JSON.stringify({ apps: { restored: { name: 'Restored app' } } }));
    } finally {
      proc.emit('close', 0);
      await pending;
    }
    expect(await apps.getAppById('restored')).toMatchObject({ name: 'Restored app' });
  });

  it('reconciles queued prompt, timer and twin edits after a partial live transfer', async () => {
    const prompts = createPromptsService({ dataDir: testDataRoot() });
    const promptDir = join(testDataRoot(), 'prompts');
    const timerPath = join(testDataRoot(), 'voice-timers.json');
    const docPath = join(PATHS.digitalTwin, 'example.md');
    const docTime = new Date('2025-01-01T00:00:00Z');
    const writePromptFiles = async (key) => {
      await fs.writeFile(join(promptDir, 'stage-config.json'), JSON.stringify({ stages: { [key]: {} } }));
      await fs.writeFile(join(promptDir, 'variables.json'), JSON.stringify({ variables: { [key]: {} } }));
    };
    setAIToolkitInstance({ services: { prompts } });
    try {
      await fs.mkdir(promptDir, { recursive: true });
      await writePromptFiles('original');
      await prompts.init();
      await scheduleTimer({ label: 'original', totalMs: 600000 });
      const originalMeta = await updateMeta({ documents: [{ filename: 'example.md', enabled: true }] });
      await fs.writeFile(docPath, 'original document');
      await fs.utimes(docPath, docTime, docTime);
      expect(await getDigitalTwinForPrompt()).toContain('original document');

      const proc = fakeProc();
      spawn.mockReturnValue(proc);
      const pending = restoreSnapshot('/dest', 'snap-1', { dryRun: false });
      await flush();
      const edits = Promise.all([
        prompts.updateStageConfig('added', {}), prompts.createVariable('added', {}),
        scheduleTimer({ label: 'added', totalMs: 600000 }), updateMeta({ personas: [] }),
      ]);
      // rsync has installed these files when another file fails to transfer.
      await writePromptFiles('restored');
      await fs.writeFile(timerPath, JSON.stringify({ timers: [{ id: 'restored', label: 'restored', fireAt: Date.now() + 300000 }] }));
      await fs.writeFile(join(PATHS.digitalTwin, 'meta.json'), JSON.stringify({ ...originalMeta, version: 'restored' }));
      await fs.writeFile(docPath, 'restored document');
      await fs.utimes(docPath, docTime, docTime);
      proc.emit('close', 1);
      await expect(pending).rejects.toThrow(/Some files may already have been overwritten/);
      await edits;

      expect(JSON.parse(await fs.readFile(join(promptDir, 'stage-config.json'), 'utf8')).stages).toEqual({ restored: {}, added: {} });
      expect(JSON.parse(await fs.readFile(join(promptDir, 'variables.json'), 'utf8')).variables).toEqual({ restored: {}, added: {} });
      expect(JSON.parse(await fs.readFile(timerPath, 'utf8')).timers.map(t => t.label)).toEqual(['restored', 'added']);
      expect(JSON.parse(await fs.readFile(join(PATHS.digitalTwin, 'meta.json'), 'utf8')).version).toBe('restored');
      expect(await getDigitalTwinForPrompt()).toContain('restored document');
    } finally {
      __resetVoiceTimers();
      setAIToolkitInstance(null);
    }
  });

  it('refreshes a nested prompt scope without reading an unrelated timer store', async () => {
    const prompts = createPromptsService({ dataDir: testDataRoot() });
    const promptDir = join(testDataRoot(), 'prompts');
    await fs.mkdir(promptDir, { recursive: true });
    await fs.writeFile(join(promptDir, 'variables.json'), JSON.stringify({ variables: { before: {} } }));
    await prompts.init();
    setAIToolkitInstance({ services: { prompts } });
    try {
      await fs.writeFile(join(testDataRoot(), 'voice-timers.json'), 'unreadable example');
      const proc = fakeProc();
      spawn.mockReturnValue(proc);
      const pending = restoreSnapshot('/dest', 'snap-1', { dryRun: false, subdirFilter: 'prompts/variables.json' });
      await flush();
      await fs.writeFile(join(promptDir, 'variables.json'), JSON.stringify({ variables: { after: {} } }));
      proc.emit('close', 0);
      await pending;
      expect(prompts.getVariables()).toEqual({ after: {} });
    } finally {
      setAIToolkitInstance(null);
      await fs.rm(join(testDataRoot(), 'voice-timers.json'), { force: true });
    }
  });

  it('reconciles decision log, classifier config, twin feedback/taste, learning and tools caches across live restore', async () => {
    const decisionPath = join(PATHS.cos, 'decisions.json');
    const learningPath = join(PATHS.cos, 'learning.json');
    const classifierPath = join(testDataRoot(), 'memory-classifier-config.json');
    const feedbackPath = join(PATHS.digitalTwin, 'feedback.json');
    const tastePath = join(PATHS.digitalTwin, 'taste-profile.json');
    const toolPath = join(PATHS.tools, 'tool-restored.json');
    const oldToolPath = join(PATHS.tools, 'tool-before.json');
    const nowIso = new Date().toISOString();

    await Promise.all([
      fs.mkdir(PATHS.cos, { recursive: true }),
      fs.mkdir(PATHS.digitalTwin, { recursive: true }),
      fs.mkdir(PATHS.tools, { recursive: true }),
    ]);

    decisionLog.invalidateCache();
    memoryClassifier.invalidateCache();
    feedbackStore.invalidateCache();
    tasteQuestionnaire.invalidateCache();
    taskLearningStore.clearLearningCache();
    tools.invalidateCache();

    await Promise.all([
      fs.writeFile(decisionPath, JSON.stringify({
        version: 1,
        decisions: [{ id: 'dec-before', type: 'idle', reason: 'before', count: 1, timestamp: nowIso }],
        stats: { totalDecisions: 1, byType: { idle: 1 } },
      })),
      fs.writeFile(learningPath, JSON.stringify({
        version: 2, lastUpdated: nowIso, byTaskType: {}, byTaskTypeExecution: {},
        byModelTier: {}, errorPatterns: {}, failureSignatures: {}, routingAccuracy: {},
        environmentalFailures: {}, correlationWindow: [],
        totals: { completed: 1, succeeded: 1, failed: 0, totalDurationMs: 100, avgDurationMs: 100 },
      })),
      fs.writeFile(classifierPath, JSON.stringify({ enabled: true, model: 'before-model', timeout: 11111 })),
      fs.writeFile(feedbackPath, JSON.stringify({
        version: '1.0.0', entries: [{ id: 'fb-before', rating: 'sounds_like_me' }],
        stats: { totalFeedback: 1, soundsLikeMe: 1, doesntSoundLikeMe: 0 },
        documentWeightAdjustments: {}, lastCalculatedAt: null,
      })),
      fs.writeFile(tastePath, JSON.stringify({
        version: '1.0.0', createdAt: nowIso, updatedAt: nowIso, profileSummary: 'before-summary',
        lastSessionAt: null, sections: {},
      })),
      fs.writeFile(oldToolPath, JSON.stringify({ id: 'tool-before', name: 'Before Tool', category: 'test', enabled: true })),
    ]);

    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      // Warm every in-memory cache with pre-restore data.
      expect((await decisionLog.getDecisionSummary()).last24Hours.total).toBe(1);
      expect((await memoryClassifier.getConfig()).model).toBe('before-model');
      expect((await feedbackStore.loadFeedback()).entries).toMatchObject([{ id: 'fb-before' }]);
      expect((await tasteQuestionnaire.getTasteProfile()).profileSummary).toBe('before-summary');
      expect((await taskLearningStore.loadLearningData()).totals.completed).toBe(1);
      expect((await tools.getTools()).map((t) => t.id)).toEqual(['tool-before']);

      const proc = fakeProc();
      spawn.mockReturnValue(proc);
      const pending = restoreSnapshot('/dest', 'snap-1', { dryRun: false });
      await flush();

      // Queue live mutations while rsync is running — they must wait for restore and apply onto restored bytes.
      const queuedDecision = decisionLog.recordDecision('task_selected', 'after-restore');
      const queuedClassifier = memoryClassifier.updateConfig({ timeout: 22222 });
      const queuedTool = tools.updateTool('tool-restored', { description: 'edited-after-restore' });

      // Simulate rsync installing the snapshot files.
      await Promise.all([
        fs.writeFile(decisionPath, JSON.stringify({
          version: 1,
          decisions: [{ id: 'dec-restored', type: 'idle', reason: 'restored', count: 5, timestamp: nowIso }],
          stats: { totalDecisions: 5, byType: { idle: 5 } },
        })),
        fs.writeFile(learningPath, JSON.stringify({
          version: 2, lastUpdated: nowIso, byTaskType: {}, byTaskTypeExecution: {},
          byModelTier: {}, errorPatterns: {}, failureSignatures: {}, routingAccuracy: {},
          environmentalFailures: {}, correlationWindow: [],
          totals: { completed: 42, succeeded: 40, failed: 2, totalDurationMs: 4200, avgDurationMs: 100 },
        })),
        fs.writeFile(classifierPath, JSON.stringify({ enabled: false, model: 'restored-model', timeout: 33333 })),
        fs.writeFile(feedbackPath, JSON.stringify({
          version: '1.0.0', entries: [{ id: 'fb-restored', rating: 'sounds_like_me' }],
          stats: { totalFeedback: 1, soundsLikeMe: 1, doesntSoundLikeMe: 0 },
          documentWeightAdjustments: {}, lastCalculatedAt: null,
        })),
        fs.writeFile(tastePath, JSON.stringify({
          version: '1.0.0', createdAt: nowIso, updatedAt: nowIso, profileSummary: 'restored-summary',
          lastSessionAt: null, sections: {},
        })),
        fs.rm(oldToolPath, { force: true }),
        fs.writeFile(toolPath, JSON.stringify({ id: 'tool-restored', name: 'Restored Tool', category: 'test', enabled: true })),
      ]);

      proc.emit('close', 0);
      await pending;
      await Promise.all([queuedDecision, queuedClassifier, queuedTool]);

      const storedDecisions = JSON.parse(await fs.readFile(decisionPath, 'utf8'));
      expect(storedDecisions.stats.totalDecisions).toBe(6);
      expect(storedDecisions.decisions.map((d) => d.reason)).toEqual(['after-restore', 'restored']);

      const storedClassifier = JSON.parse(await fs.readFile(classifierPath, 'utf8'));
      expect(storedClassifier).toMatchObject({ enabled: false, model: 'restored-model', timeout: 22222 });
      expect((await memoryClassifier.getConfig()).model).toBe('restored-model');

      expect((await feedbackStore.loadFeedback()).entries).toMatchObject([{ id: 'fb-restored' }]);
      expect((await tasteQuestionnaire.getTasteProfile()).profileSummary).toBe('restored-summary');
      expect((await taskLearningStore.loadLearningData()).totals.completed).toBe(42);
      expect(await tools.getTools()).toMatchObject([{ id: 'tool-restored', description: 'edited-after-restore' }]);
    } finally {
      clock.mockRestore();
      decisionLog.invalidateCache();
      memoryClassifier.invalidateCache();
      feedbackStore.invalidateCache();
      tasteQuestionnaire.invalidateCache();
      taskLearningStore.clearLearningCache();
      tools.invalidateCache();
    }
  });

  it('drains an in-flight taste answer write and queues a concurrent one without deadlocking live restore', async () => {
    const tastePath = join(PATHS.digitalTwin, 'taste-profile.json');
    const nowIso = new Date().toISOString();
    await fs.mkdir(PATHS.digitalTwin, { recursive: true });
    await fs.writeFile(tastePath, JSON.stringify({
      version: '1.0.0', createdAt: nowIso, updatedAt: nowIso, profileSummary: 'before-summary',
      lastSessionAt: null, sections: {},
    }));
    tasteQuestionnaire.invalidateCache();

    // Start a taste answer publication right as a live restore starts: both
    // acquire backup lease -> taste queue -> metaMutex in the same order, so
    // the in-flight answer drains cleanly before the snapshot cut closes.
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const inFlightAnswer = tasteQuestionnaire.submitAnswer('food', 'food-core-1', 'Smoky and spicy');
    const pendingRestore = restoreSnapshot('/dest', 'snap-1', { dryRun: false, subdirFilter: 'digital-twin' });

    await expect(inFlightAnswer).resolves.toMatchObject({ section: 'food', questionId: 'food-core-1' });
    await flush();

    // Queue a second answer while restore holds the snapshot cut and locks.
    const queuedAnswer = tasteQuestionnaire.submitAnswer('food', 'food-core-2', 'Improvisational cooking');
    await fs.writeFile(tastePath, JSON.stringify({
      version: '1.0.0', createdAt: nowIso, updatedAt: nowIso, profileSummary: 'restored-summary',
      lastSessionAt: null, sections: {},
    }));
    proc.emit('close', 0);

    await pendingRestore;
    await expect(queuedAnswer).resolves.toMatchObject({ section: 'food', questionId: 'food-core-2', totalResponses: 1 });
    const stored = JSON.parse(await fs.readFile(tastePath, 'utf8'));
    expect(stored.profileSummary).toBe('restored-summary');
    expect(stored.sections.food.responses.map(r => r.questionId)).toEqual(['food-core-2']);
    tasteQuestionnaire.invalidateCache();
  });
});
