import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BLENDER_MODEL_STAGED_PATHS } from '../../../services/blenderModels/driver.js';
import { REPO_ROOT } from '../../../../scripts/lib/guardCorpus.js';

// driver.js stages a literal list of driver-side files into Blender (a directory walk would hide its reads from the
// test memo, scripts/lib/testMemo.js). A new file under py/ must be added to that list or `import` fails in Blender.
const PY = join(REPO_ROOT, 'server', 'services', 'blenderModels', 'py');
const onDisk = (directory = '') => readdirSync(join(PY, directory), { withFileTypes: true }).flatMap((entry) => {
  if (entry.isDirectory()) return entry.name === 'starter' || entry.name === '__pycache__' ? [] : onDisk(`${directory}${entry.name}/`);
  return entry.name.endsWith('.py') ? [`${directory}${entry.name}`] : [];
});

describe('Blender model driver files staged into Blender', () => {
  it('stages every driver-side .py file under py/', () => {
    expect([...BLENDER_MODEL_STAGED_PATHS].sort()).toEqual(onDisk().sort());
  });

  it('stages only names the contained worker accepts (each segment starts with a letter or digit)', () => {
    for (const path of BLENDER_MODEL_STAGED_PATHS) {
      expect(path.split('/').every((part) => /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9_-])?$/i.test(part)), path).toBe(true);
    }
  });
});
