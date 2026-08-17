import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { repoRoot, runPromptMigrationTests } from './_testHelpers.js';
import migration, {
  ACCEPTED_OLD_MD5,
  NEW_SHIPPED_MD5,
  applyMigration,
} from './275-pipeline-planning-economy.js';

describe('migration 275 — pipeline planning economy', () => {
  let warningRoot = null;

  afterEach(() => {
    vi.restoreAllMocks();
    if (warningRoot) rmSync(warningRoot, { recursive: true, force: true });
    warningRoot = null;
  });

  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-275-pipeline-planning-economy-',
  });

  it('publishes the episode budget and dramatic-economy checks', () => {
    const read = (name) => readFileSync(
      `${repoRoot}/data.reference/prompts/stages/${name}`,
      'utf8',
    );
    const resolver = read('pipeline-arc-resolve.md');
    const arcVerify = read('pipeline-arc-verify.md');
    const volumeVerify = read('pipeline-volume-verify.md');

    expect(resolver).toContain('episode synopsis 4,000');
    expect(resolver).toContain('replace or compact conflicting language');
    for (const prompt of [arcVerify, volumeVerify]) {
      expect(prompt).toContain('Dramatic economy');
      expect(prompt).toContain('Planning altitude and metadata fit');
      expect(prompt).toMatch(/goal, obstacle,[\s\S]*consequential choice/);
    }
    expect(arcVerify).toContain('Premise-engine continuity');
    expect(volumeVerify).toContain('Active story engines');
  });

  it('gives customized resolver owners the resolver-specific manual upgrade', async () => {
    warningRoot = mkdtempSync(join(tmpdir(), 'migration-275-customized-warning-'));
    const stagesDir = join(warningRoot, 'data', 'prompts', 'stages');
    mkdirSync(stagesDir, { recursive: true });
    for (const filename of Object.keys(NEW_SHIPPED_MD5)) {
      writeFileSync(join(stagesDir, filename), `# customized ${filename}\n`);
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await migration.up({ rootDir: warningRoot });

    const resolverWarning = warn.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.includes('pipeline-arc-resolve.md'));
    expect(resolverWarning).toContain('4,000-character');
    expect(resolverWarning).toContain('replace or compact');
    expect(resolverWarning).toContain('instead of appending');
  });
});
