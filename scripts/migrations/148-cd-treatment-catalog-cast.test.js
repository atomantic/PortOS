import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './148-cd-treatment-catalog-cast.js';

const REL = 'data/prompts/stages/cd-treatment.md';

// Minimal pre-change template carrying both migration anchors verbatim: the
// style-spec → user-story bracket (Insertion 1) and the scene JSON example's
// imageStrength line (Insertion 2).
const PRE_TEMPLATE = [
  '## Style spec (apply to every prompt)',
  '',
  '{{#project.styleSpec}}{{project.styleSpec}}{{/project.styleSpec}}{{^project.styleSpec}}(none){{/project.styleSpec}}',
  '',
  '{{#project.userStory}}',
  '## User-supplied story',
  '',
  '{{project.userStory}}',
  '{{/project.userStory}}',
  '',
  '```',
  '{',
  '  "scenes": [',
  '    {',
  '      "sourceImageFile": {{startingImageFileLiteral}},',
  '      "imageStrength": null',
  '    },',
  '    { "sceneId": "scene-2" }',
  '  ]',
  '}',
  '```',
  '',
].join('\n');

describe('migration 148 — backfill cd-treatment catalog cast', () => {
  let rootDir;
  let templatePath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-148-'));
    templatePath = join(rootDir, REL);
    mkdirSync(join(rootDir, 'data', 'prompts', 'stages'), { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('inserts the Cast section and per-scene cast field into a pristine template', async () => {
    writeFileSync(templatePath, PRE_TEMPLATE);
    await migration.up({ rootDir });
    const out = readFileSync(templatePath, 'utf-8');

    // Insertion 1: the header-once flag + section + member iteration land
    // between the style spec and the user-story branch.
    expect(out).toContain('{{#hasCast}}');
    expect(out).toContain('## Cast & ingredients');
    expect(out).toContain('{{#project.cast}}');
    expect(out.indexOf('{{#hasCast}}')).toBeLessThan(out.indexOf('{{#project.userStory}}'));
    expect(out.indexOf('{{/project.styleSpec}}')).toBeLessThan(out.indexOf('{{#hasCast}}'));

    // Insertion 2: the gated per-scene cast field follows imageStrength.
    expect(out).toContain('"cast": [{ "ingredientId":');
    expect(out).toContain('"imageStrength": null{{#hasCast}},');
  });

  it('is idempotent — a second run makes no further changes', async () => {
    writeFileSync(templatePath, PRE_TEMPLATE);
    await migration.up({ rootDir });
    const afterFirst = readFileSync(templatePath, 'utf-8');
    await migration.up({ rootDir });
    const afterSecond = readFileSync(templatePath, 'utf-8');
    expect(afterSecond).toBe(afterFirst);
  });

  it('leaves a hand-edited template (anchors absent) untouched without throwing', async () => {
    const edited = '# Totally different template\n\nNo anchors here.\n';
    writeFileSync(templatePath, edited);
    await migration.up({ rootDir });
    expect(readFileSync(templatePath, 'utf-8')).toBe(edited);
  });

  it('skips cleanly when the template file is absent (fresh install)', async () => {
    // No file written — must not throw.
    await expect(migration.up({ rootDir })).resolves.toBeUndefined();
  });
});
