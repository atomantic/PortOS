import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { scaffoldPortOS } from './scaffoldPortOS.js';

// The route test mocks scaffoldPortOS, so this is the only coverage of what a new app actually receives.
describe('scaffoldPortOS generated app', () => {
  let appDir;

  beforeEach(async () => {
    appDir = await mkdtemp(join(tmpdir(), 'portos-scaffold-'));
    await scaffoldPortOS({ repoPath: appDir, name: 'Example App', dirName: 'example-app', uiPort: 3100, apiPort: 3101, addStep: () => {} });
  });

  afterEach(async () => {
    await rm(appDir, { recursive: true, force: true });
  });

  it('points the generated server at the data directory the seeded providers were written to', async () => {
    const serverSource = await readFile(join(appDir, 'server', 'index.js'), 'utf8');
    const declaration = serverSource.match(/^const DATA_DIR = (.+);$/m);
    expect(declaration).not.toBeNull();
    expect(serverSource).toMatch(/dataDir: DATA_DIR,/);

    // Resolve the generated expression as if evaluated in <app>/server/index.js. A cwd-relative
    // path would resolve somewhere else for `npm run dev` (cwd server/) than for PM2 (cwd app root).
    const moduleUrl = pathToFileURL(join(appDir, 'server', 'index.js')).href;
    const resolveDataDir = new Function('join', 'dirname', 'fileURLToPath', 'moduleUrl',
      `return ${declaration[1].replaceAll('import.meta.url', 'moduleUrl')};`);
    const dataDir = resolveDataDir(join, dirname, fileURLToPath, moduleUrl);
    expect(dataDir).toBe(join(appDir, 'data'));

    const seeded = JSON.parse(await readFile(join(dataDir, 'providers.json'), 'utf8'));
    expect(seeded.activeProvider).toBe('claude-code');
    expect(seeded.providers['claude-code'].enabled).toBe(true);
  });

  it('lets the generated CI pass before the app has any tests', async () => {
    const vitestConfig = await readFile(join(appDir, 'server', 'vitest.config.js'), 'utf8');
    expect(vitestConfig).toMatch(/passWithNoTests: true/);
    const ci = await readFile(join(appDir, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).toMatch(/working-directory: \.\/server\n\s+run: npm test/);
  });
});
