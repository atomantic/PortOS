import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setImmediate } from 'node:timers/promises';
import { atomicWrite } from './internal/atomicWrite.js';
import { createPromptsService } from './prompts.js';

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

vi.mock('./internal/atomicWrite.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, atomicWrite: vi.fn(actual.atomicWrite) };
});

const { atomicWrite: writeToDisk } = await vi.importActual('./internal/atomicWrite.js');

describe('AI Toolkit prompt persistence', () => {
  let dataDir;
  let configPath;
  let variablesPath;
  let service;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-prompts-'));
    configPath = join(dataDir, 'prompts', 'stage-config.json');
    variablesPath = join(dataDir, 'prompts', 'variables.json');
    service = createPromptsService({ dataDir });
  });

  afterEach(async () => {
    vi.resetAllMocks();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('shares lazy initialization and preserves concurrent edits in both files', async () => {
    await writeToDisk(configPath, { stages: { example: { model: 'old' } } });
    await writeToDisk(variablesPath, { variables: { example: { content: 'old' } } });

    await Promise.all([
      service.updateStageConfig('example', { model: 'new' }),
      service.updateStageConfig('example', { provider: 'test' }),
      service.updateVariable('example', { content: 'new' }),
      service.updateVariable('example', { name: 'Test' }),
    ]);

    expect(readFile.mock.calls).toEqual([[configPath, 'utf-8'], [variablesPath, 'utf-8']]);
    const reloaded = createPromptsService({ dataDir });
    await reloaded.init();
    expect(reloaded.getStage('example')).toEqual({ model: 'new', provider: 'test' });
    expect(reloaded.getVariable('example')).toEqual({ content: 'new', name: 'Test' });
  });

  it('serializes stage writes while allowing variables to save independently', async () => {
    await service.init();
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    atomicWrite.mockImplementationOnce(async (path, data) => {
      started.resolve();
      await release.promise;
      await writeToDisk(path, data);
    });

    const first = service.updateStageConfig('example', { model: 'new' });
    await started.promise;
    const second = service.updateStageConfig('example', { provider: 'test' });
    const variable = service.updateVariable('example', { content: 'new' });
    try {
      await setImmediate();
      expect(atomicWrite.mock.calls.map(([path]) => path)).toEqual([configPath, variablesPath]);
    } finally {
      release.resolve();
      await Promise.all([first, second, variable]);
    }

    expect(JSON.parse(await readFile(configPath, 'utf-8'))).toEqual({
      stages: { example: { model: 'new', provider: 'test' } }
    });
  });

  it('waits for an active write before explicit reload and reads changed files on the next init', async () => {
    await writeToDisk(configPath, { stages: { example: { model: 'old' } } });
    await service.init();
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    atomicWrite.mockImplementationOnce(async (path, data) => {
      started.resolve();
      await release.promise;
      await writeToDisk(path, data);
    });

    const writing = service.updateStageConfig('example', { model: 'new' });
    await started.promise;
    const duringWrite = service.getStage('example');
    const reloading = service.init();
    release.resolve();
    await Promise.all([writing, reloading]);
    expect(duringWrite).toEqual({ model: 'old' });
    expect(service.getStage('example')).toEqual({ model: 'new' });

    await writeFile(configPath, JSON.stringify({ stages: { example: { model: 'external' } } }));
    await service.init();
    expect(service.getStage('example')).toEqual({ model: 'external' });
  });

  it('keeps the previous coherent snapshot on a failed reload and can retry', async () => {
    await writeToDisk(configPath, { stages: { example: { model: 'old' } } });
    await writeToDisk(variablesPath, { variables: { example: { content: 'old' } } });
    await service.init();

    await writeToDisk(configPath, { stages: { example: { model: 'new' } } });
    await writeFile(variablesPath, '{');
    await expect(service.init()).rejects.toThrow(SyntaxError);
    expect(service.getStage('example')).toEqual({ model: 'old' });
    expect(service.getVariable('example')).toEqual({ content: 'old' });

    await writeToDisk(variablesPath, { variables: { example: { content: 'new' } } });
    await service.init();
    expect(service.getStage('example')).toEqual({ model: 'new' });
    expect(service.getVariable('example')).toEqual({ content: 'new' });
  });

  it('keeps failed variable edits out of memory and subsequent writes', async () => {
    await service.createVariable('example', { content: 'original' });
    atomicWrite.mockRejectedValueOnce(new Error('disk full'));

    const failed = service.updateVariable('example', { content: 'unsaved' });
    const succeeding = service.updateVariable('example', { name: 'Saved' });
    await expect(failed).rejects.toThrow('disk full');
    await succeeding;

    const expected = { content: 'original', name: 'Saved' };
    expect(service.getVariable('example')).toEqual(expected);
    expect(JSON.parse(await readFile(variablesPath, 'utf-8'))).toEqual({ variables: { example: expected } });
  });

  it('keeps stage configs and templates together when either write fails', async () => {
    const initial = { model: 'original' };
    await service.createStage('existing', initial, 'original prompt');
    atomicWrite.mockRejectedValueOnce(new Error('template write failed'));
    await expect(service.createStage('new', initial, 'new prompt')).rejects.toThrow('template write failed');
    expect(service.getStage('new')).toBeNull();

    atomicWrite.mockImplementationOnce(writeToDisk).mockRejectedValueOnce(new Error('config write failed'));
    await expect(service.createStage('new', initial, 'new prompt')).rejects.toThrow('config write failed');
    expect(service.getStage('new')).toBeNull();
    expect(await service.getStageTemplate('new')).toBeNull();

    atomicWrite.mockImplementationOnce(writeToDisk).mockRejectedValueOnce(new Error('config write failed'));
    await expect(service.updateStageConfig('existing', { model: 'new' }, 'new prompt')).rejects.toThrow('config write failed');
    expect(service.getStage('existing')).toEqual(initial);
    expect(await service.getStageTemplate('existing')).toBe('original prompt');

    atomicWrite.mockRejectedValueOnce(new Error('config write failed'));
    await expect(service.deleteStage('existing')).rejects.toThrow('config write failed');
    expect(service.getStage('existing')).toEqual(initial);
    expect(await service.getStageTemplate('existing')).toBe('original prompt');

    expect(JSON.parse(await readFile(configPath, 'utf-8'))).toEqual({ stages: { existing: initial } });
    await service.deleteStage('existing');
    expect(service.getStage('existing')).toBeNull();
    expect(await service.getStageTemplate('existing')).toBeNull();
  });
});
