import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';
import { request } from '../../lib/testHelper.js';
import { errorMiddleware } from '../../lib/errorHandler.js';
import { PATHS } from '../../lib/fileUtils.js';
import { getAppById, invalidateCache } from '../../services/apps.js';
import router from './crud.js';

vi.mock('../../lib/fileUtils.js', async original => makePathsProxy(await original(), {
  dataRoot: () => lazyTempDataRoot('portos-crud-ports-'),
}));
vi.mock('../../services/pm2.js', () => ({ listProcessesStrict: vi.fn(), getAppStatusStrict: vi.fn() }));
vi.mock('../../services/appQualityFederation.js', () => ({ exportPortosQuality: vi.fn() }));
vi.mock('../../services/appQuality.js', () => ({ getAppQualityHistory: vi.fn(), enrichAppsWithQuality: vi.fn() }));
vi.mock('../../services/appQualitySnapshotFile.js', () => ({ publishAppQualitySnapshot: vi.fn() }));
vi.mock('../../services/appLaneHealth.js', () => ({ getAppLaneHealth: vi.fn() }));
vi.mock('../../services/appIconDetect.js', () => ({ detectAppIcon: vi.fn(), getIconContentType: vi.fn(), isUsableSvg: vi.fn() }));
vi.mock('../../services/xcodeScripts.js', () => ({ checkScripts: vi.fn() }));

const app = express();
app.use(express.json());
app.use('/api/apps', router);
app.use(errorMiddleware);
let repoPath;
let configPath;
let registryPath;

beforeEach(async () => {
  invalidateCache();
  repoPath = join(PATHS.data, 'repo');
  configPath = join(repoPath, 'ecosystem.config.cjs');
  registryPath = join(PATHS.data, 'apps.json');
  await mkdir(repoPath, { recursive: true });
});
afterAll(() => cleanupTempDataRoots());

async function fixture(content, fields = {}) {
  await writeFile(configPath, content);
  await writeFile(registryPath, JSON.stringify({ apps: { example: {
    name: 'Example', type: 'node', repoPath, apiPort: 7000, uiPort: null, devUiPort: null,
    pm2ProcessNames: ['example-server'], ...fields,
  } } }));
  await getAppById('example'); // Finish normal registry initialization before taking snapshots.
  return { config: content, registry: await readFile(registryPath, 'utf8') };
}
const update = data => request(app).put('/api/apps/example').send(data);

async function expectRefused(before, data) {
  const result = await update(data);
  expect(result.status).toBe(422);
  expect(result.body.code).toBe('PORT_NOT_PERSISTABLE');
  expect(await readFile(configPath, 'utf8')).toBe(before.config);
  expect(await readFile(registryPath, 'utf8')).toBe(before.registry);
}

describe('app port updates with real configuration and registry files', () => {
  // Catches value-wide rewrites of a sibling, lexical matches in strings and
  // metadata, and the 7_000 -> 7 parse/truncate bug through the actual route.
  it('changes only selected runtime spans, including numeric separators', async () => {
    const content = `module.exports = { apps: [
  { name: 'example-server', metadata: { PORT: 7000, port: 7000 }, note: 'PORT: 7000', env: { PORT: 7_000 } },
  { name: 'other-server', env: { PORT: 7000 } }
] }; // PORT: 7000\n`;
    await fixture(content);
    const result = await update({ apiPort: 7100 });
    expect(result.status).toBe(200);
    expect(result.body.apiPort).toBe(7100);
    expect(await readFile(configPath, 'utf8')).toBe(content.replace('PORT: 7_000', 'PORT: 7100'));
    expect(JSON.parse(await readFile(registryPath, 'utf8')).apps.example.apiPort).toBe(7100);
  });

  it.each([
    "module['exports'].apps[0].name = 'other-server';",
    "const alias = module.exports.apps[0]; alias.name = 'other-server';",
    "for (const alias of module.exports.apps) alias.name = 'other-server';",
    "const note = `${module.exports.apps[0].name = 'other-server'}`;",
    "const rename = require('./rename.cjs'); rename(module.exports.apps[0]);",
  ])('refuses dynamic identity changes atomically: %s', async mutation => {
    const before = await fixture(`module.exports = { apps: [{ name: 'example-server', env: { PORT: 7000 } }] };\n${mutation}`);
    await expectRefused(before, { apiPort: 7100 });
    // A rename or no-op echo remains usable even for a dynamic config.
    expect((await update({ apiPort: 7000 })).status).toBe(200);
    expect((await update({ name: 'Renamed' })).status).toBe(200);
    expect(await readFile(configPath, 'utf8')).toBe(before.config);
  });

  it.each([
    "const mutate = require('./mutate.cjs'); mutate(server);",
    "const alias = server; const mutate = require('./mutate.cjs'); mutate(alias);",
    "const wrapper = { nested: { server } }; const mutate = require('./mutate.cjs'); mutate(wrapper);",
    "const get = () => server; const mutate = require('./mutate.cjs'); mutate(get);",
    "function rename() { Object.assign(server, { name: 'other-server' }); } rename();",
  ])('refuses config objects escaping before export: %s', async mutation => {
    const before = await fixture(`const server = { name: 'example-server', env: { PORT: 7000 } };\n${mutation}\nmodule.exports = { apps: [server] };`);
    await expectRefused(before, { apiPort: 7100 });
  });

  it('refuses opaque imported spreads without executing them', async () => {
    const before = await fixture(`const extra = require('./missing-helper.cjs');
module.exports = { apps: [{ name: 'example-server', env: { PORT: 7000 }, ...extra() }] };`);
    await expectRefused(before, { apiPort: 7100 });
  });

  it.each([
    "var NAME = 'example-server'; const ALIAS = NAME; var NAME = 'other-server';",
    "var ALIAS = NAME; var NAME = 'example-server';",
  ])('refuses a name whose declaration snapshot is uncertain: %s', async declarations => {
    const before = await fixture(`${declarations}
module.exports = { apps: [{ name: ALIAS, env: { PORT: 7000 } }] };`);
    await expectRefused(before, { apiPort: 7100 });
  });

  it('does not resolve helper parameters as same-named module bindings', async () => {
    const before = await fixture(`const name = 'example-server';
function makeApp(name) { return { name, env: { PORT: 7000 } }; }
module.exports = { apps: [makeApp('other-server')] };`);
    await expectRefused(before, { apiPort: 7100 });
  });

  it('refuses the entire batch when one requested port is dynamic', async () => {
    const before = await fixture(`module.exports = { apps: [
  { name: 'example-server', ports: { api: 7000, ui: dynamicPort() } }
] };`, { uiPort: 7001 });
    await expectRefused(before, { apiPort: 7100, uiPort: 7101 });
  });

  it.each(["dynamicArgs()", "'vite --port 7001 --port 7002'", "`--port ${7001}suffix`"])(
    'refuses an uncertain runtime argument port even with a literal env: %s', async args => {
      const before = await fixture(`module.exports = { apps: [
        { name: 'example-server', env: { PORT: 7000 } },
        { name: 'example-ui', args: ${args}, env: { VITE_PORT: 7001 } }
      ] };`, { devUiPort: 7001, pm2ProcessNames: ['example-server', 'example-ui'] });
      await expectRefused(before, { apiPort: 7100, devUiPort: 7101 });
    });

  it('preserves a shared constant when only one consumer was selected', async () => {
    const before = await fixture(`const PORT = 7000; module.exports = { apps: [
  { name: 'example-server', env: { PORT } }, { name: 'other-server', env: { PORT } }
] };`);
    await expectRefused(before, { apiPort: 7100 });
  });

  it('applies a complete multi-port batch without chaining source spans', async () => {
    const content = `module.exports = { apps: [{ name: 'example-server', ports: { api: 7000, ui: 7001 } }] };`;
    await fixture(content, { uiPort: 7001 });
    const result = await update({ apiPort: 7001, uiPort: 7100 });
    expect(result.status).toBe(200);
    expect(await readFile(configPath, 'utf8')).toBe(content.replace('api: 7000, ui: 7001', 'api: 7001, ui: 7100'));
    expect(JSON.parse(await readFile(registryPath, 'utf8')).apps.example).toMatchObject({ apiPort: 7001, uiPort: 7100 });
  });

  it('keeps shipped helper calls and spreads editable without loading their imports', async () => {
    const content = await readFile(fileURLToPath(new URL('../../../ecosystem.config.cjs', import.meta.url)), 'utf8');
    await fixture(content, { apiPort: 5555, uiPort: 5555, devUiPort: 5554, pm2ProcessNames: ['portos-server', 'portos-ui'] });
    const result = await update({ apiPort: 7100, devUiPort: 7101, uiPort: 5555 });
    expect(result.status).toBe(200);
    expect(await readFile(configPath, 'utf8')).toBe(content.replace('API: 5555', 'API: 7100').replace('UI: 5554', 'UI: 7101'));
    expect(JSON.parse(await readFile(registryPath, 'utf8')).apps.example).toMatchObject({ apiPort: 7100, uiPort: 7100, devUiPort: 7101 });
  });

  it('leaves config bytes unchanged for no-op echoes and non-port edits', async () => {
    const before = await fixture(`module.exports = { apps: [{ name: 'example-server', env: { PORT: 7000 } }] };`);
    expect((await update({ apiPort: 7000 })).status).toBe(200);
    expect((await update({ name: 'Renamed' })).status).toBe(200);
    expect(await readFile(configPath, 'utf8')).toBe(before.config);
    expect((await getAppById('example')).name).toBe('Renamed');
  });
});
