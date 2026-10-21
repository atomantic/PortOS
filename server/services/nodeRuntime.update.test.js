import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

// The update contract: refusals happen before anything is downloaded, nvm gets
// its arguments positionally, and PortOS is pinned to the new Node only for a
// restart that actually launches.

const TMP = mkdtempSync(join(tmpdir(), 'node-runtime-'));
const NVM_DIR = join(TMP, 'nvm');
const ENV_PATH = join(TMP, '.env');
mkdirSync(NVM_DIR, { recursive: true });
writeFileSync(join(NVM_DIR, 'nvm.sh'), '# fixture\n');

const mocks = vi.hoisted(() => ({
  activity: { idle: true, blockers: [] },
  runStreamingCommand: vi.fn(),
  startPortosSelfUpdate: vi.fn(),
  checkPortosUpdatePreflight: vi.fn(),
}));

vi.mock('../lib/streamingSpawn.js', () => ({ runStreamingCommand: mocks.runStreamingCommand }));
vi.mock('./activeProcessing.js', () => ({ getSystemActivity: async () => ({ activity: mocks.activity }) }));
vi.mock('./updatePreflight.js', () => ({ checkPortosUpdatePreflight: mocks.checkPortosUpdatePreflight }));
vi.mock('./portosSelfUpdate.js', () => ({ startPortosSelfUpdate: mocks.startPortosSelfUpdate }));
vi.mock('./pm2.js', () => ({ getDaemonIdentity: async () => ({ pm2Version: '7.0.4', nodeVersion: '26.0.0' }) }));
vi.mock('../lib/portosEnv.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readPortosEnvValue: (key) => actual.readPortosEnvValue(key, ENV_PATH),
    upsertPortosEnvLine: (key, value) => actual.upsertPortosEnvLine(key, value, ENV_PATH),
  };
});

const { __testing, startNodeUpdate } = await import('./nodeRuntime.js');

const running = process.version;
const [major, minor, patch] = running.slice(1).split('.').map(Number);
const NEXT = `v${major}.${minor}.${patch + 1}`;
const nodeBinary = join(NVM_DIR, 'versions', 'node', NEXT, 'bin', 'node');
const io = { emit: vi.fn() };

const readPin = () => readFileSync(ENV_PATH, 'utf8');

beforeEach(() => {
  process.env.NVM_DIR = NVM_DIR;
  __testing.resetNodeRuntimeCaches();
  writeFileSync(ENV_PATH, 'PGMODE=docker\n');
  mocks.activity = { idle: true, blockers: [] };
  mocks.checkPortosUpdatePreflight.mockResolvedValue({});
  mocks.startPortosSelfUpdate.mockResolvedValue({ started: true, tag: `v${major}.0.0` });
  mocks.runStreamingCommand.mockImplementation(async (cmd, args) => {
    if (cmd === 'bash' && args.includes('install')) {
      mkdirSync(dirname(nodeBinary), { recursive: true });
      writeFileSync(nodeBinary, '');
    }
    return { success: true };
  });
  vi.stubGlobal('fetch', vi.fn(async (url) => ({
    ok: true,
    json: async () => (String(url).includes('nodejs.org')
      ? [{ version: NEXT, lts: false, security: true, date: '2026-10-21' }, { version: running, lts: false, security: false }]
      : { version: '7.0.4' }),
  })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe('startNodeUpdate', () => {
  it('installs with nvm, pins PortOS to the new binary and launches the restart', async () => {
    await expect(startNodeUpdate({ version: NEXT, io })).resolves.toEqual({ started: true, restart: true });
    await vi.waitFor(() => expect(mocks.startPortosSelfUpdate).toHaveBeenCalled());

    const install = mocks.runStreamingCommand.mock.calls.find(([, args]) => args.includes('install'));
    // The script body is constant; the version only ever arrives as "$@".
    expect(install[1][1]).not.toContain(NEXT);
    expect(install[1].slice(-2)).toEqual(['install', NEXT]);
    expect(readPin()).toContain(`PORTOS_NODE_INTERPRETER=${nodeBinary}`);
    expect(mocks.startPortosSelfUpdate).toHaveBeenCalledWith(expect.objectContaining({ mode: 'refresh', preflightAlreadyRun: true }));
  });

  it('refuses a version that is not on offer before running anything', async () => {
    await expect(startNodeUpdate({ version: 'v99.0.0', io })).rejects.toMatchObject({ code: 'NODE_VERSION_NOT_OFFERED' });
    expect(mocks.runStreamingCommand).not.toHaveBeenCalled();
  });

  it('refuses while PortOS is busy, naming what it waits for', async () => {
    mocks.activity = { idle: false, blockers: [{ label: '1 video render' }] };
    await expect(startNodeUpdate({ version: NEXT, io })).rejects.toMatchObject({ code: 'SYSTEM_BUSY', message: expect.stringContaining('1 video render') });
    expect(mocks.runStreamingCommand).not.toHaveBeenCalled();
  });

  it('restores the previous pin when the restart is refused after the install', async () => {
    mocks.startPortosSelfUpdate.mockRejectedValue(Object.assign(new Error('Update already in progress'), { code: 'UPDATE_IN_PROGRESS' }));
    await startNodeUpdate({ version: NEXT, io });
    await vi.waitFor(() => expect(io.emit).toHaveBeenCalledWith('portos:update:error', expect.anything()));

    expect(readPin()).not.toContain(nodeBinary);
    expect(io.emit).toHaveBeenCalledWith('portos:update:error', expect.objectContaining({ message: 'Update already in progress' }));
  });
});
