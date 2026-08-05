import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { runPromptMigrationTests, sampleBody, repoRoot, md5 } from './_testHelpers.js';
import migration, {
  applyMigration,
  ACCEPTED_OLD_MD5,
  NEW_SHIPPED_MD5,
  DRIFT_SUBDIRS,
} from './228-craft-partial-zoom-into-the-moment.js';

const FILENAME = 'craft-anti-patterns.md';

describe('migration 228 — craft "Zoom into the moment" section', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-228-',
    subdir: '_partials',
  });

  it('routes the partial to prompts/_partials, never prompts/stages', async () => {
    // The single easiest thing to get wrong: the prompt-replace family defaults
    // to `prompts/stages/`, so a missing DRIFT_SUBDIRS entry would leave every
    // install's real partial untouched while silently "succeeding".
    expect(DRIFT_SUBDIRS[FILENAME]).toBe('_partials');

    const rootDir = mkdtempSync(join(tmpdir(), 'migration-228-routing-'));
    const partialsDir = join(rootDir, 'data', 'prompts', '_partials');
    const stagesDir = join(rootDir, 'data', 'prompts', 'stages');
    const sampleDir = join(rootDir, 'data.reference', 'prompts', '_partials');
    mkdirSync(partialsDir, { recursive: true });
    mkdirSync(stagesDir, { recursive: true });
    mkdirSync(sampleDir, { recursive: true });
    writeFileSync(join(sampleDir, FILENAME), sampleBody(FILENAME, '_partials'));

    const staleBody = '# synthetic pre-228 partial\n';
    writeFileSync(join(partialsDir, FILENAME), staleBody);
    // A stage-dir decoy with the SAME name must be left alone.
    writeFileSync(join(stagesDir, FILENAME), staleBody);

    const result = await applyMigration({
      rootDir,
      accepted: { [FILENAME]: [md5(staleBody)] },
      current: { [FILENAME]: md5(sampleBody(FILENAME, '_partials')) },
    });

    expect(result).toMatchObject({ updated: 1, skipped: 0 });
    expect(readFileSync(join(partialsDir, FILENAME), 'utf-8')).toBe(sampleBody(FILENAME, '_partials'));
    expect(readFileSync(join(stagesDir, FILENAME), 'utf-8')).toBe(staleBody);
    expect(existsSync(join(rootDir, 'data', 'prompts', 'stages', FILENAME))).toBe(true);

    rmSync(rootDir, { recursive: true, force: true });
  });

  it('ships all five construction elements, after the in-scene rule and before the Stability Trap', () => {
    const body = readFileSync(join(repoRoot, 'data.reference', 'prompts', '_partials', FILENAME), 'utf-8');

    const inScene = body.indexOf('At least 70% in-scene, not summary');
    const zoom = body.indexOf('## Zoom into the moment');
    const stability = body.indexOf('## Stability Trap countermeasures');
    expect(inScene).toBeGreaterThan(-1);
    expect(zoom).toBeGreaterThan(inScene);
    expect(stability).toBeGreaterThan(zoom);

    for (const element of [
      'Location first',
      'Actions, in verbs',
      'Thoughts, raw',
      'Emotions, shown on the body',
      'Dialogue, quoted and specific',
    ]) {
      expect(body.slice(zoom, stability)).toContain(element);
    }
  });

  it('the pre-change shipped hash is a real ancestor, distinct from the new one', () => {
    expect(ACCEPTED_OLD_MD5[FILENAME]).not.toContain(NEW_SHIPPED_MD5[FILENAME]);
  });
});
