import { afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { createTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';
import { request } from '../../lib/testHelper.js';

const fixtureRoot = createTempDataRoot('sprite-import-containment-');
const dataRoot = join(fixtureRoot, 'data');
vi.mock('../../lib/fileUtils.js', async (importOriginal) => (
  makePathsProxy(await importOriginal(), { dataRoot })
));

const { importFromSource } = await import('./importer.js');
const { getRecord } = await import('./records.js');
const { mountAssetRoutes } = await import('../assetMounts.js');
const app = express();
mountAssetRoutes(app);
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

const CANARY = 'INVENTED-OUTSIDE-SOURCE-CANARY';
function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
}

function link(target, path, type = 'file') {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path, type);
}

function fixture(id) {
  const sourceRoot = join(fixtureRoot, id, 'source');
  const outside = join(fixtureRoot, id, 'outside');
  const charDir = join(sourceRoot, 'art-source/sprites', id);
  const specPath = join(sourceRoot, 'art-pipeline/characters', `${id}.json`);
  const selectionPath = join(sourceRoot, 'art-pipeline/catalog/runtime-selection.json');
  write(specPath, { characterId: id, displayName: 'Example character' });
  write(join(outside, 'canary.png'), CANARY);
  return { id, sourceRoot, outside, charDir, specPath, selectionPath };
}

describe('sprite import source containment at persistence and asset-serving boundaries', () => {
  it.each([
    ['reference-directory', (f) => {
      link(f.outside, join(f.charDir, 'reference'), 'junction');
      return 'reference/canary.png';
    }],
    ['selected-asset', (f) => {
      link(join(f.outside, 'canary.png'), join(f.charDir, 'selected.png'));
      write(f.selectionPath, { characterId: f.id, selected: { path: 'selected.png' } });
      return 'selected.png';
    }],
    ['expanded-run-manifest', (f) => {
      write(join(f.charDir, 'walk/set.json'), {
        kind: 'finalized-eight-direction-walk-set', status: 'final',
        directions: { south: { status: 'approved', runPath: 'runs/run-1', runManifest: 'runs/run-1/run.json' } },
      });
      // The walk set names runs/, while the source has the legacy grok/ twin.
      write(join(f.charDir, 'grok/run-1/run.json'), { manifestPath: 'runs/run-1/packaged.json' });
      write(join(f.outside, 'packaged.json'), { secret: CANARY, asset: 'selected.png' });
      link(join(f.outside, 'packaged.json'), join(f.charDir, 'grok/run-1/packaged.json'));
      return 'runs/run-1/packaged.json';
    }],
    ['character-spec', (f) => {
      rmSync(f.specPath);
      write(join(f.outside, 'spec.json'), { characterId: f.id, displayName: CANARY });
      link(join(f.outside, 'spec.json'), f.specPath);
      return 'character-spec.json';
    }],
    ['specs-directory', (f) => {
      rmSync(dirname(f.specPath), { recursive: true });
      write(join(f.outside, `${f.id}.json`), { characterId: f.id, displayName: CANARY });
      link(f.outside, dirname(f.specPath), 'junction');
      return 'character-spec.json';
    }],
    ['selection-metadata', (f) => {
      write(join(f.outside, 'selection.json'), { characterId: f.id, selected: {}, secret: CANARY });
      link(join(f.outside, 'selection.json'), f.selectionPath);
      return 'catalog/runtime-selection.json';
    }],
    ['props-directory', (f) => {
      write(join(f.outside, f.id, 'atlas.png'), CANARY);
      rmSync(dirname(f.specPath), { recursive: true });
      link(f.outside, join(f.sourceRoot, 'game/assets/sprites'), 'junction');
      return 'atlas/atlas.png';
    }],
  ])('rejects an escaping %s before persisting or serving outside bytes', async (id, prepare) => {
    const f = fixture(id);
    const asset = prepare(f);
    await expect(importFromSource({ sourceRoot: f.sourceRoot })).rejects.toMatchObject({ code: 'SOURCE_OUTSIDE_ROOT', status: 400 });
    expect(await getRecord(id)).toBeNull();
    const response = await request(app).get(`/data/sprites/${id}/${asset}`);
    expect(response.status).toBe(404);
    expect(response.text).not.toContain(CANARY);
  });

  it('rejects a distinct sibling whose name differs only by case', async (context) => {
    const f = fixture('case-sensitive');
    const sibling = join(dirname(f.sourceRoot), 'SOURCE');
    if (existsSync(sibling)) return context.skip('The fixture volume is case-insensitive; there is no distinct sibling.');
    write(join(sibling, 'canary.png'), CANARY);
    link(sibling, join(f.charDir, 'reference'), 'junction');
    await expect(importFromSource({ sourceRoot: f.sourceRoot })).rejects.toMatchObject({ code: 'SOURCE_OUTSIDE_ROOT' });
    expect(await getRecord(f.id)).toBeNull();
    const response = await request(app).get('/data/sprites/case-sensitive/reference/canary.png');
    expect(response.status).toBe(404);
  });

  it('preserves normal imports, a selected root alias, and contained selected-file links', async () => {
    const f = fixture('contained');
    write(join(f.charDir, 'reference/main.png'), 'APPROVED-REFERENCE');
    write(join(f.sourceRoot, 'shared/selected.png'), 'APPROVED-SELECTED');
    link(join(f.sourceRoot, 'shared/selected.png'), join(f.charDir, 'selected.png'));
    write(f.selectionPath, { characterId: f.id, selected: { path: 'selected.png' } });
    write(join(f.sourceRoot, 'game/assets/sprites/props/atlas.png'), 'APPROVED-PROPS');
    const alias = join(fixtureRoot, 'selected-root-alias');
    link(f.sourceRoot, alias, 'junction');

    const { totals } = await importFromSource({ sourceRoot: alias });
    expect(totals).toMatchObject({ subjects: 2, errors: 0 });
    expect(await getRecord(f.id)).toMatchObject({ kind: 'character', name: 'Example character' });
    expect(await getRecord('props')).toMatchObject({ kind: 'props' });
    expect(readFileSync(join(dataRoot, 'sprites/contained/selected.png'), 'utf8')).toBe('APPROVED-SELECTED');
    const response = await request(app).get('/data/sprites/contained/selected.png');
    expect(response.status).toBe(200);
    expect(response.text).toBe('APPROVED-SELECTED');
  });
});
