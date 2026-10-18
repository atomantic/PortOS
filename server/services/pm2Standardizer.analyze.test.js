import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('./providers.js', () => ({
  getActiveProvider: vi.fn().mockResolvedValue({ id: 'p1', name: 'Test Provider', type: 'cli', enabled: true }),
  getProviderById: vi.fn(),
}));
vi.mock('./promptRunner.js', () => ({ runPromptThroughProvider: vi.fn() }));
vi.mock('./apps.js', () => ({
  getReservedPorts: vi.fn().mockResolvedValue([]),
  getAllApps: vi.fn().mockResolvedValue([]),
}));
vi.mock('../lib/platform.js', async (importOriginal) => ({
  ...await importOriginal(),
  getListeningPorts: vi.fn().mockResolvedValue([]),
}));

import { analyzeApp } from './pm2Standardizer.js';
import { runPromptThroughProvider } from './promptRunner.js';
import { parseEcosystemConfig } from './streamingDetect.js';

describe('analyzeApp port handling', () => {
  let repo;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'portos-std-'));
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'site', scripts: { start: 'node serve.js' } }));
    return () => rmSync(repo, { recursive: true, force: true });
  });

  it('moves a browser-blocked port and writes a ui label so a static server gets an Open link', async () => {
    runPromptThroughProvider.mockResolvedValue({
      text: JSON.stringify({
        processes: [{
          name: 'site', cwd: '.', script: 'serve.js', watch: false,
          ports: { ui: 6000 },
          env: { NODE_ENV: 'development', PORT: 6000 },
        }],
        strayPorts: [],
        reasoning: 'static server',
      }),
    });

    const result = await analyzeApp(repo);

    expect(result.success).toBe(true);
    expect(result.proposedChanges.portReassignments).toEqual([{ from: 6000, to: 5570 }]);
    const [proc] = parseEcosystemConfig(result.proposedChanges.ecosystemContent).processes;
    expect(proc.ports).toEqual({ ui: 5570 });
  });

  it('drops a malformed ports map instead of writing it into the ecosystem file', async () => {
    runPromptThroughProvider.mockResolvedValue({
      text: JSON.stringify({
        processes: [{
          name: 'site', cwd: '.', script: 'serve.js', watch: false,
          ports: { ui: 'sixty' },
          env: { NODE_ENV: 'development', PORT: 5580 },
        }],
        strayPorts: [],
      }),
    });

    const result = await analyzeApp(repo);

    const [proc] = parseEcosystemConfig(result.proposedChanges.ecosystemContent).processes;
    expect(proc.ports).toEqual({ api: 5580 });
  });
});
