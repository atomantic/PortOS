import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import migration from './467-fold-audit-schedule-overrides.js';

it('migrates app audit overrides without replacing a customized domain or dropping a conflicting legacy row', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'portos-audit-overrides-'));
  try {
    mkdirSync(join(rootDir, 'data'));
    const path = join(rootDir, 'data', 'apps.json');
    const legacy = { enabled: true, interval: '0 8 * * 1', providerId: 'example-provider', taskMetadata: { fileIssues: true } };
    const current = { enabled: true, interval: '0 9 * * 1', model: 'example-model' };
    writeFileSync(path, JSON.stringify({ apps: {
      'app-a': { taskTypeOverrides: { 'code-simplification': { enabled: false }, simplify: legacy } },
      'app-b': { taskTypeOverrides: { 'code-simplification': current, 'better-cognitive-load': legacy } },
      'app-c': { disabledTaskTypes: ['react-lifecycle', 'ui-bugs', 'security'] },
    } }));

    await migration.up({ rootDir });
    const upgraded = readFileSync(path, 'utf8');
    expect(JSON.parse(upgraded).apps).toEqual({
      'app-a': { taskTypeOverrides: { 'code-simplification': legacy } },
      'app-b': { taskTypeOverrides: { 'code-simplification': current }, retiredAuditConfigs: { 'better-cognitive-load': legacy } },
      'app-c': { disabledTaskTypes: ['ui-runtime-bugs', 'security'] },
    });
    await migration.up({ rootDir });
    expect(readFileSync(path, 'utf8')).toBe(upgraded);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
