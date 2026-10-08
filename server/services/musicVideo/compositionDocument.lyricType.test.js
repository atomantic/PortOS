import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-mv-lyric-type-'),
}));

const { PATHS } = await import('../../lib/paths.js');
const projects = await import('./projects.js');
const { importDocumentTemplate, importDocumentDirectory, stageGeneratedDocument } = await import('./compositionDocument.js');

afterAll(() => cleanupTempDataRoots());

async function listed(document) {
  const root = join(PATHS.data, document.directory);
  const out = [];
  const walk = async (dir, prefix) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      else out.push(`${prefix}${entry.name}`);
    }
  };
  await walk(root, '');
  return { root, files: out.sort() };
}

async function uploaded(name, files) {
  const dir = join(PATHS.data, 'uploads', name);
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(join(dir, rel, '..'), { recursive: true });
    await writeFile(join(dir, rel), body);
  }
  return `uploads/${name}`;
}

describe('shared lyric-type assets in composition documents', () => {
  it('ships lyricType.js, its stylesheet and OFL faces with the layered template', async () => {
    const { id } = await projects.createProject({ name: 'Example Song' });
    const { files } = await listed((await importDocumentTemplate(id)).document);
    expect(files).toEqual(expect.arrayContaining([
      'lyricType.js', 'lyricType.css', 'fonts/archivo-variable.woff2', 'fonts/ibm-plex-mono-500.woff2',
      'fonts/LICENSE-Archivo.txt', 'fonts/LICENSE-IBM-Plex.txt', 'engine.js', 'index.html',
    ]));
    expect(files.filter((file) => file.endsWith('.test.js'))).toEqual([]);
  });

  it('adds the module and faces to an uploaded document that imports it, and keeps a document\'s own copy', async () => {
    const { id } = await projects.createProject({ name: 'Example Song' });
    const importing = await importDocumentDirectory(id, await uploaded('imports-it', {
      'index.html': '<link rel="stylesheet" href="lyricType.css"><script type="module" src="app/main.js"></script>',
      'app/main.js': "import { createLyricType } from '../lyricType.js';\ncreateLyricType(window.PORTOS_MV);\n",
    }));
    const { root, files } = await listed(importing.document);
    expect(files).toEqual(expect.arrayContaining(['lyricType.js', 'lyricType.css', 'fonts/archivo-variable.woff2', 'fonts/LICENSE-Archivo.txt']));
    expect(files.filter((file) => file.endsWith('.test.js'))).toEqual([]);
    expect(await readFile(join(root, 'lyricType.js'), 'utf8')).toContain('export function createLyricType');

    const own = await importDocumentDirectory(id, await uploaded('own-copy', {
      'index.html': '<script type="module" src="lyricType.js"></script>',
      'lyricType.js': 'export const createLyricType = () => null;\n',
      'authored.test.js': '// An intentionally uploaded document file.\n',
    }));
    const kept = await listed(own.document);
    expect(await readFile(join(kept.root, 'lyricType.js'), 'utf8')).toBe('export const createLyricType = () => null;\n');
    expect(kept.files).toContain('fonts/archivo-variable.woff2');
    expect(kept.files).toContain('authored.test.js');

    const plain = await importDocumentDirectory(id, await uploaded('no-type', { 'index.html': '<canvas></canvas>' }));
    expect((await listed(plain.document)).files).toEqual(['index.html']);
  });
  it('copies the local toon module and vendor graph for imports, preserves authored copies, and omits tests', async () => {
    const { id } = await projects.createProject({ name: 'Example Toon Song' });
    const imported = await importDocumentDirectory(id, await uploaded('toon-import', {
      'index.html': '<script type="module" src="world.js"></script>',
      'world.js': "import { shellLathe } from './toonWorld.js';",
    }));
    const { root, files } = await listed(imported.document);
    const { buildDocumentPreview } = await import('./documentPreview.js');
    const preview = await buildDocumentPreview(await projects.getProject(id));
    expect(preview.html).toContain('data:text/javascript;base64,');
    expect(files).toEqual(['index.html', 'toonWorld.js', 'vendor/LICENSE', 'vendor/three.core.js', 'vendor/three.module.js', 'world.js']);
    expect(await readFile(join(root, 'toonWorld.js'), 'utf8')).toContain('export function shellLathe');
    const own = await importDocumentDirectory(id, await uploaded('toon-own', {
      'index.html': '<script type="module" src="toonWorld.js"></script>',
      'toonWorld.js': 'export const customKit = true;',
      'vendor/three.module.js': 'export const customThree = true;',
    }));
    const kept = await listed(own.document);
    expect(await readFile(join(kept.root, 'toonWorld.js'), 'utf8')).toBe('export const customKit = true;');
    expect(await readFile(join(kept.root, 'vendor/three.module.js'), 'utf8')).toBe('export const customThree = true;');
    const layered = await listed((await importDocumentTemplate(id, 'layered')).document);
    const layeredIndex = await readFile(join(layered.root, 'index.html'), 'utf8');
    const layeredWithKit = await importDocumentDirectory(id, await uploaded('layered-toon', {
      'index.html': layeredIndex.replace('</body>', '<script type="module" src="toonWorld.js"></script></body>'),
      'engine.js': await readFile(join(layered.root, 'engine.js'), 'utf8'),
      'cameraRig.js': await readFile(join(layered.root, 'cameraRig.js'), 'utf8'),
    }));
    expect((await listed(layeredWithKit.document)).files).toContain('toonWorld.js');
    expect((await buildDocumentPreview(await projects.getProject(id))).html).toContain('data:text/javascript;base64,');
    const staged = await stageGeneratedDocument(id, [{ rel: 'generated.js', data: Buffer.from('window.PORTOS_MV_GENERATED = {};') }], { renderer: 'three' });
    const spatial = await listed(staged.document);
    expect(spatial.files).toEqual(expect.arrayContaining(['toonWorld.js', 'vendor/three.module.js', 'vendor/three.core.js']));
    expect((await buildDocumentPreview({ ...(await projects.getProject(id)), composition: { mode: 'document', document: staged.document } })).html).toContain('data:text/javascript;base64,');
  });

});
