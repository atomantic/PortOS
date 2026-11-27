/** File restore reconciliation against live services and their cached file stores. */
import { fakeProc, flush, testDataRoot } from './backup.test.fixture.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import { join } from 'path';
import { createPromptsService } from '../lib/aiToolkit/prompts.js';
import { setAIToolkitInstance } from '../lib/aiToolkitState.js';
import { spawn } from '../lib/childProcess.js';
import { PATHS } from '../lib/fileUtils.js';
import { restoreSnapshot } from './backup.js';
import * as apps from './apps.js';
import * as notifications from './notifications.js';
import * as feeds from './feeds.js';
import * as personalities from './agent/agentPersonalities.js';
import * as automation from './automationScheduler.js';
import { updateMeta } from './digital-twin-meta.js';
import { getDigitalTwinForPrompt } from './digital-twin-context.js';
import { scheduleTimer, __resetVoiceTimers } from './voice/timers.js';

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
});
