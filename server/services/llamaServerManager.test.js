import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getLlamaServerStatus,
  startLlamaServer,
  stopLlamaServer,
  installLlamaServer,
  _resetLlamaServerStateForTests,
} from './llamaServerManager.js';
import * as processEnv from '../lib/processEnv.js';
import * as commandExistsModule from '../lib/commandExists.js';
import * as childProcess from '../lib/childProcess.js';
import { EventEmitter } from 'events';

describe('llamaServerManager', () => {
  beforeEach(() => {
    _resetLlamaServerStateForTests();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    _resetLlamaServerStateForTests();
    vi.restoreAllMocks();
  });

  it('reports installed: false when binary is not found on PATH', async () => {
    vi.spyOn(processEnv, 'findCommandOnPath').mockResolvedValue(null);

    const status = await getLlamaServerStatus();
    expect(status.installed).toBe(false);
    expect(status.running).toBe(false);
    expect(status.managed).toBe(false);
  });

  it('reports installed: true when binary is found on PATH', async () => {
    vi.spyOn(processEnv, 'findCommandOnPath').mockResolvedValue('/opt/homebrew/bin/llama-server');
    vi.spyOn(commandExistsModule, 'commandExists').mockResolvedValue(true);

    const status = await getLlamaServerStatus();
    expect(status.installed).toBe(true);
  });

  it('rejects start when binary is missing', async () => {
    vi.spyOn(processEnv, 'findCommandOnPath').mockResolvedValue(null);

    await expect(startLlamaServer({ model: '/path/to/model.gguf' })).rejects.toThrow(
      /llama-server binary was not found/i
    );
  });

  it('spawns llama-server with draftModel and specType arguments', async () => {
    vi.spyOn(processEnv, 'findCommandOnPath').mockResolvedValue('/usr/local/bin/llama-server');
    vi.spyOn(commandExistsModule, 'commandExists').mockResolvedValue(true);

    const fakeChild = new EventEmitter();
    fakeChild.pid = 12345;
    fakeChild.killed = false;
    fakeChild.exitCode = null;
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();

    let spawnArgs = null;
    vi.spyOn(childProcess, 'spawn').mockImplementation((cmd, args) => {
      spawnArgs = { cmd, args };
      return fakeChild;
    });

    const result = await startLlamaServer({
      model: 'models/Qwen3.8-27B.gguf',
      draftModel: 'models/Qwen3.8-DFlash2.gguf',
      specType: 'draft-dflash',
      port: 8080,
      host: '127.0.0.1',
      alias: 'dflash',
    });

    expect(result.success).toBe(true);
    expect(result.pid).toBe(12345);
    expect(spawnArgs.cmd).toBe('/usr/local/bin/llama-server');
    expect(spawnArgs.args).toEqual([
      '-m', 'models/Qwen3.8-27B.gguf',
      '--draft-model', 'models/Qwen3.8-DFlash2.gguf',
      '--spec-type', 'draft-dflash',
      '--port', '8080',
      '--host', '127.0.0.1',
      '--ctx-size', '32768',
      '-ngl', '99',
      '--alias', 'dflash',
    ]);

    const status = await getLlamaServerStatus();
    expect(status.running).toBe(true);
    expect(status.managed).toBe(true);
    expect(status.pid).toBe(12345);
  });

  it('stops managed process cleanly', async () => {
    vi.spyOn(processEnv, 'findCommandOnPath').mockResolvedValue('/usr/local/bin/llama-server');
    vi.spyOn(commandExistsModule, 'commandExists').mockResolvedValue(true);

    const fakeChild = new EventEmitter();
    fakeChild.pid = 54321;
    fakeChild.killed = false;
    fakeChild.exitCode = null;
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();
    fakeChild.kill = vi.fn();

    vi.spyOn(childProcess, 'spawn').mockReturnValue(fakeChild);

    await startLlamaServer({ model: 'models/model.gguf' });
    const stopResult = await stopLlamaServer();
    expect(stopResult.success).toBe(true);

    const status = await getLlamaServerStatus();
    expect(status.managed).toBe(false);
  });

  it('installs llama.cpp via Homebrew when brew is available', async () => {
    vi.spyOn(commandExistsModule, 'commandExists').mockImplementation(async (cmd) => true);
    vi.spyOn(processEnv, 'findCommandOnPath').mockResolvedValue('/opt/homebrew/bin/llama-server');

    const fakeChild = new EventEmitter();
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();

    vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
      setTimeout(() => fakeChild.emit('exit', 0), 10);
      return fakeChild;
    });

    const result = await installLlamaServer();
    expect(result.success).toBe(true);
  });

  it('rejects install when Homebrew is missing', async () => {
    vi.spyOn(commandExistsModule, 'commandExists').mockResolvedValue(false);

    await expect(installLlamaServer()).rejects.toThrow(/Homebrew was not found/i);
  });
});
