import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

const readFileOverride = vi.hoisted(() => ({ fn: null }));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readFile: (...args) => (
      readFileOverride.fn ? readFileOverride.fn(actual.readFile, ...args) : actual.readFile(...args)
    ),
  };
});

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-completion-data-') }),
);

import { persistRunnerCompletion } from './completion.js';

describe('cos-runner persistRunnerCompletion', () => {
  let agentsDir;

  beforeEach(async () => {
    agentsDir = await mkdtemp(join(tmpdir(), 'portos-completion-agents-'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    readFileOverride.fn = null;
    vi.restoreAllMocks();
    await rm(agentsDir, { recursive: true, force: true });
  });

  afterAll(cleanupTempDataRoots);

  it('writes output.txt and fresh metadata.json when prior metadata does not exist', async () => {
    const output = 'completed output 🚀';
    await persistRunnerCompletion(agentsDir, 'agent-fresh', output, {
      taskId: 'task-1',
      exitCode: 0,
      success: true,
    });

    const agentDir = join(agentsDir, 'agent-fresh');
    expect(await readFile(join(agentDir, 'output.txt'), 'utf-8')).toBe(output);
    expect(JSON.parse(await readFile(join(agentDir, 'metadata.json'), 'utf-8'))).toEqual({
      agentId: 'agent-fresh',
      taskId: 'task-1',
      exitCode: 0,
      success: true,
      outputSize: Buffer.byteLength(output),
    });
  });

  it('writes only output.txt when metadata is null (paused agent)', async () => {
    await persistRunnerCompletion(agentsDir, 'agent-paused', 'paused transcript\n', null);

    const agentDir = join(agentsDir, 'agent-paused');
    expect(await readFile(join(agentDir, 'output.txt'), 'utf-8')).toBe('paused transcript\n');
    expect(existsSync(join(agentDir, 'metadata.json'))).toBe(false);
  });

  it('merges existing metadata.json fields with completion metadata', async () => {
    const agentDir = join(agentsDir, 'agent-merge');
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, 'metadata.json'), JSON.stringify({ startedBy: 'scheduler', exitCode: 1 }));

    await persistRunnerCompletion(agentsDir, 'agent-merge', 'done', { exitCode: 0, success: true });

    expect(JSON.parse(await readFile(join(agentDir, 'metadata.json'), 'utf-8'))).toEqual({
      startedBy: 'scheduler',
      agentId: 'agent-merge',
      exitCode: 0,
      success: true,
      outputSize: 4,
    });
  });

  it('recovers from corrupt metadata.json (SyntaxError) by warning and rewriting from completion data', async () => {
    const agentDir = join(agentsDir, 'agent-corrupt');
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, 'metadata.json'), '{not-valid-json');

    await persistRunnerCompletion(agentsDir, 'agent-corrupt', 'recovered output', {
      taskId: 'task-corrupt',
      exitCode: 0,
      success: true,
    });

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('agent-corrupt metadata.json is corrupt'));
    expect(await readFile(join(agentDir, 'output.txt'), 'utf-8')).toBe('recovered output');
    expect(JSON.parse(await readFile(join(agentDir, 'metadata.json'), 'utf-8'))).toEqual({
      agentId: 'agent-corrupt',
      taskId: 'task-corrupt',
      exitCode: 0,
      success: true,
      outputSize: Buffer.byteLength('recovered output'),
    });
  });

  it('rethrows non-ENOENT metadata read errors and rolls back output.txt', async () => {
    const agentDir = join(agentsDir, 'agent-eacces');
    const outputPath = join(agentDir, 'output.txt');
    const metadataPath = join(agentDir, 'metadata.json');
    await mkdir(agentDir, { recursive: true });
    await writeFile(outputPath, 'prior output');
    await writeFile(metadataPath, JSON.stringify({ prior: true }));

    readFileOverride.fn = (actualReadFile, filePath, encoding, ...rest) => {
      if (filePath === metadataPath && encoding === 'utf-8') {
        return Promise.reject(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
      }
      return actualReadFile(filePath, encoding, ...rest);
    };

    await expect(
      persistRunnerCompletion(agentsDir, 'agent-eacces', 'new output', { exitCode: 0, success: true }),
    ).rejects.toThrow('permission denied');

    readFileOverride.fn = null;
    expect(await readFile(outputPath, 'utf-8')).toBe('prior output');
    expect(JSON.parse(await readFile(metadataPath, 'utf-8'))).toEqual({ prior: true });
  });
});
