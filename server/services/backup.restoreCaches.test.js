/** File restore reconciliation against the live prompt, voice timer and digital twin services. */
import { fakeProc, flush, testDataRoot } from './backup.test.fixture.js';
import { beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import { join } from 'path';
import { createPromptsService } from '../lib/aiToolkit/prompts.js';
import { setAIToolkitInstance } from '../lib/aiToolkitState.js';
import { spawn } from '../lib/childProcess.js';
import { PATHS } from '../lib/fileUtils.js';
import { restoreSnapshot } from './backup.js';
import { updateMeta } from './digital-twin-meta.js';
import { getDigitalTwinForPrompt } from './digital-twin-context.js';
import { scheduleTimer, __resetVoiceTimers } from './voice/timers.js';

describe('live file restore caches', () => {
  beforeEach(() => { spawn.mockReset(); });

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
