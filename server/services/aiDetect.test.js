import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// aiDetect used to spawn CLI providers + fetch API providers directly; it now
// delegates to runPromptThroughProvider so TUI providers (which previously
// fell through to the "Unknown provider type" branch) work the same way.
vi.mock('./providers.js', () => ({
  getActiveProvider: vi.fn(),
  getProviderById: vi.fn()
}));

vi.mock('../lib/promptRunner.js', () => ({
  runPromptThroughProvider: vi.fn()
}));

import { getActiveProvider, getProviderById } from './providers.js';
import { runPromptThroughProvider } from '../lib/promptRunner.js';
import { detectAppWithAi } from './aiDetect.js';

const VALID_DETECTION_JSON = JSON.stringify({
  name: 'Test App',
  description: 'sample',
  uiPort: 3000,
  apiPort: 3001,
  startCommands: ['npm run dev'],
  pm2ProcessNames: ['test-app'],
  hasFrontend: true,
  hasBackend: true
});

async function makeProjectDir(files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'aidetect-test-'));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, 'utf-8');
  }
  return dir;
}

async function withProjectDir(files, fn) {
  const dir = await makeProjectDir(files);
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('detectAppWithAi', () => {
  it('returns error when directory does not exist', async () => {
    const result = await detectAppWithAi('/path/that/does/not/exist');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/does not exist/i);
  });

  it('returns error when no provider is configured', async () => {
    getActiveProvider.mockResolvedValue(null);
    await withProjectDir({}, async (dir) => {
      const result = await detectAppWithAi(dir);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/no ai provider/i);
    });
  });

  it('returns error when provider is disabled', async () => {
    getActiveProvider.mockResolvedValue({ id: 'p1', type: 'api', enabled: false });
    await withProjectDir({}, async (dir) => {
      const result = await detectAppWithAi(dir);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/disabled/i);
    });
  });

  it('routes TUI providers through runPromptThroughProvider (regression: used to fail "Unknown provider type")', async () => {
    const tuiProvider = { id: 'claude-tui', name: 'Claude TUI', type: 'tui', enabled: true, timeout: 30000 };
    getProviderById.mockResolvedValue(tuiProvider);
    runPromptThroughProvider.mockResolvedValue({ text: VALID_DETECTION_JSON, runId: 'r1', model: 'm1' });

    await withProjectDir({ 'package.json': JSON.stringify({ name: 'my-app' }) }, async (dir) => {
      const result = await detectAppWithAi(dir, 'claude-tui');

      expect(result.success).toBe(true);
      expect(result.provider).toBe('Claude TUI');
      expect(runPromptThroughProvider).toHaveBeenCalledTimes(1);
      const call = runPromptThroughProvider.mock.calls[0][0];
      expect(call.provider).toBe(tuiProvider);
      expect(call.source).toBe('ai-app-detect');
      expect(call.cwd).toBe(dir);
      expect(call.timeout).toBe(30000);
    });
  });

  it('uses default 60s timeout when provider does not specify one', async () => {
    const provider = { id: 'p', name: 'P', type: 'api', enabled: true };
    getActiveProvider.mockResolvedValue(provider);
    runPromptThroughProvider.mockResolvedValue({ text: VALID_DETECTION_JSON, runId: 'r1', model: 'm1' });

    await withProjectDir({}, async (dir) => {
      await detectAppWithAi(dir);
      expect(runPromptThroughProvider.mock.calls[0][0].timeout).toBe(60000);
    });
  });

  it('parses fenced JSON responses', async () => {
    const provider = { id: 'p', name: 'P', type: 'cli', enabled: true };
    getActiveProvider.mockResolvedValue(provider);
    runPromptThroughProvider.mockResolvedValue({
      text: '```json\n' + VALID_DETECTION_JSON + '\n```',
      runId: 'r1',
      model: 'm1'
    });

    await withProjectDir({}, async (dir) => {
      const result = await detectAppWithAi(dir);
      expect(result.success).toBe(true);
      expect(result.detected.name).toBe('Test App');
    });
  });

  it('parses JSON with leading CLI banner text (TUI/Codex case)', async () => {
    const provider = { id: 'p', name: 'P', type: 'tui', enabled: true };
    getActiveProvider.mockResolvedValue(provider);
    runPromptThroughProvider.mockResolvedValue({
      text: 'Initializing...\nWorking on it...\n' + VALID_DETECTION_JSON + '\nDone.',
      runId: 'r1',
      model: 'm1'
    });

    await withProjectDir({}, async (dir) => {
      const result = await detectAppWithAi(dir);
      expect(result.success).toBe(true);
      expect(result.detected.name).toBe('Test App');
    });
  });

  it('skips an echoed package.json block when picking the detection JSON (TUI prompt-echo case)', async () => {
    const provider = { id: 'p', name: 'P', type: 'tui', enabled: true };
    getActiveProvider.mockResolvedValue(provider);
    // Prompt-echoing TUI providers replay the package.json from the prompt
    // before the real answer — the first parseable block must be skipped.
    const echoedPackageJson = JSON.stringify({ name: 'echoed-from-prompt', scripts: { dev: 'vite' } });
    runPromptThroughProvider.mockResolvedValue({
      text: 'package.json:\n' + echoedPackageJson + '\n\nMy answer:\n' + VALID_DETECTION_JSON,
      runId: 'r1',
      model: 'm1'
    });

    await withProjectDir({ 'package.json': echoedPackageJson }, async (dir) => {
      const result = await detectAppWithAi(dir);
      expect(result.success).toBe(true);
      expect(result.detected.name).toBe('Test App');
      expect(result.detected.uiPort).toBe(3000);
    });
  });
});
